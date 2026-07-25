import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  initCombat,
  drinkPotion,
  playCard,
  probe,
  type BattleContext,
} from "../src/engine/sts-combat.js";
import { IRONCLAD_STARTER_DECK } from "../src/engine/cards/cards.js";
import { StsRandom } from "../src/engine/sts-rng.js";

type GoldenCase = {
  seed: string;
  seedLong: string;
  floor: number;
  brewFilled: string[];
  potionRngAfterEach: number[];
  potionRngFinal: number;
};

const goldenPath = fileURLToPath(new URL("./golden/combat_potion.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { cases: GoldenCase[] };

const newBattle = (g: GoldenCase, potions: (string | null)[]): BattleContext =>
  initCombat({
    seedLong: BigInt(g.seedLong),
    floorNum: g.floor,
    ascension: 0,
    encounterId: "cultist",
    deckCardIds: [...IRONCLAD_STARTER_DECK],
    playerHp: 80,
    playerMaxHp: 80,
    character: "ironclad",
    potions,
  });

describe("sts-combat 熵酿对拍 C++ 黄金向量（potionRng 拒绝采样）", () => {
  for (const g of golden.cases) {
    it(`seed "${g.seed}" @floor ${g.floor}：填满三槽的药水与 potionRng counter 一致`, () => {
      const bc = newBattle(g, [null, null, "entropic_brew"]);
      const r = drinkPotion(bc, 2);
      expect(r.ok).toBe(true);

      // 先清槽再结算，故三次抽取依次落入槽 0/1/2。
      expect(probe(bc).potions).toEqual(g.brewFilled);
      // 每瓶消耗的次数不定（稀有度重掷 + limited 排除果汁），只有逐位对齐才对得上。
      expect(bc.rng.potionRng.counter).toBe(g.potionRngFinal);
    });
  }

  it("槽位已满时仍会照常抽取：多余的药水被丢弃，但 potionRng 一次不少", () => {
    // 对齐 drinkPotion 的循环——returnRandomPotion 在 obtainPotion **之前**调用，
    // 所以即便没有空位，capacity 次抽取照样发生。
    const g = golden.cases[0]!;
    const bc = newBattle(g, ["block_potion", "fire_potion", "entropic_brew"]);
    expect(drinkPotion(bc, 2).ok).toBe(true);

    // 只有第一瓶落进腾出来的那格，其余两瓶因满槽被丢弃。
    expect(probe(bc).potions).toEqual(["block_potion", "fire_potion", g.brewFilled[0]]);
    // 但 counter 与三槽全空时完全相同。
    expect(bc.rng.potionRng.counter).toBe(g.potionRngFinal);
  });

  it("熵酿绝不产出果汁（limited 模式的 spamCheck 会把它重掷掉）", () => {
    for (const g of golden.cases) {
      expect(g.brewFilled).not.toContain("fruit_juice");
    }
  });

  it("potionRng 是 run 级持久流：战斗用的就是传入的那个实例，counter 接着累加", () => {
    // 与 miscRng 不同，potionRng 不逐层重播种，跨房间必须由调用方续算。
    // 注意不能断言「结果必然不同」——拒绝采样会丢弃大量抽取，偏移一步后落到
    // 同样的三瓶是完全可能的。真正要证的是同一实例被续用、counter 不回退。
    const g = golden.cases[0]!;
    const carried = new StsRandom(BigInt(g.seedLong) + BigInt(g.floor));
    carried.random(0, 99); // 模拟本场之前已在别处消耗过一次
    expect(carried.counter).toBe(1);
    const bc = initCombat({
      seedLong: BigInt(g.seedLong),
      floorNum: g.floor,
      ascension: 0,
      encounterId: "cultist",
      deckCardIds: [...IRONCLAD_STARTER_DECK],
      playerHp: 80,
      playerMaxHp: 80,
      character: "ironclad",
      potions: [null, null, "entropic_brew"],
      potionRng: carried,
    });
    expect(drinkPotion(bc, 2).ok).toBe(true);
    // 就是同一个实例，且 counter 从 1 接着往上走、没有回到 0 重来。
    expect(bc.rng.potionRng).toBe(carried);
    expect(carried.counter).toBeGreaterThan(1);
    expect(probe(bc).potions.every((p) => p !== null)).toBe(true);
  });
});

describe("sts-combat 战斗内药水效果", () => {
  const g = golden.cases[0]!;

  it("格挡药水给 12 点格挡并清空槽位", () => {
    const bc = newBattle(g, ["block_potion", null, null]);
    expect(drinkPotion(bc, 0).ok).toBe(true);
    expect(probe(bc).playerBlock).toBe(12);
    expect(probe(bc).potions).toEqual([null, null, null]);
  });

  it("火焰药水造成 20 点非攻击伤害", () => {
    const bc = newBattle(g, ["fire_potion", null, null]);
    const hpBefore = bc.monsters[0]!.hp;
    expect(drinkPotion(bc, 0, 0).ok).toBe(true);
    expect(bc.monsters[0]!.hp).toBe(Math.max(0, hpBefore - 20));
  });

  it("力量药水 +2 力量，随后打击伤害由 6 变 8", () => {
    const bc = newBattle(g, ["strength_potion", null, null]);
    expect(drinkPotion(bc, 0).ok).toBe(true);
    const hpBefore = bc.monsters[0]!.hp;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    expect(idx).toBeGreaterThanOrEqual(0);
    playCard(bc, idx, 0);
    expect(bc.monsters[0]!.hp).toBe(hpBefore - 8);
  });

  it("恐惧药水给敌人 3 层易伤，随后打击 6 → 9", () => {
    const bc = newBattle(g, ["fear_potion", null, null]);
    expect(drinkPotion(bc, 0, 0).ok).toBe(true);
    expect(bc.monsters[0]!.powers.find((p) => p.id === "vulnerable")?.amount).toBe(3);
    const hpBefore = bc.monsters[0]!.hp;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    expect(idx).toBeGreaterThanOrEqual(0);
    playCard(bc, idx, 0);
    expect(bc.monsters[0]!.hp).toBe(hpBefore - 9);
  });

  it("敏捷药水 +2 敏捷，随后防御格挡由 5 变 7", () => {
    const bc = newBattle(g, ["dexterity_potion", null, null]);
    expect(drinkPotion(bc, 0).ok).toBe(true);
    const idx = bc.hand.findIndex((c) => c.defId === "defend");
    if (idx >= 0) {
      playCard(bc, idx, 0);
      expect(probe(bc).playerBlock).toBe(7);
    }
  });

  it("敏捷药水的效果不会追溯到已入队算好的格挡", () => {
    // 伤害/格挡在入队时结算，这是 sts-combat 的一贯语义。
    const bc = newBattle(g, ["dexterity_potion", null, null]);
    const idx = bc.hand.findIndex((c) => c.defId === "defend");
    if (idx >= 0) {
      playCard(bc, idx, 0); // 先打防御：此时无敏捷，5 点
      expect(probe(bc).playerBlock).toBe(5);
      expect(drinkPotion(bc, 0).ok).toBe(true);
      expect(probe(bc).playerBlock).toBe(5); // 喝药水不会回头改已获得的格挡
    }
  });

  it("空槽 / 未登记药水 / 战斗已结束时拒绝饮用", () => {
    const bc = newBattle(g, [null, "snecko_oil", null]);
    expect(drinkPotion(bc, 0)).toEqual({ ok: false, reason: "药水槽 0 为空" });
    const r = drinkPotion(bc, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("暂未登记药水");
    }
    // 被拒绝时槽位不应被清空。
    expect(probe(bc).potions).toEqual([null, "snecko_oil", null]);
  });
});
