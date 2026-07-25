import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  initCombat,
  endTurn,
  playCard,
  probe,
  type BattleContext,
} from "../src/engine/sts-combat.js";
import { IRONCLAD_STARTER_DECK, getCardDef } from "../src/engine/cards/cards.js";
import { StsRandom } from "../src/engine/sts-rng.js";

type Counters = {
  aiRng: number;
  monsterHpRng: number;
  miscRng: number;
  shuffleRng: number;
  cardRandomRng?: number;
};
type GoldenTurn = {
  turn: number;
  played: number[];
  monsterHps: number[];
  monsterBlocks: number[];
  monsterStrengths: number[];
  playerHp: number;
  playerBlock: number;
  playerWeak: number;
  alive: number;
  aiRng: number;
  outcome: number;
};
type GoldenCase = {
  seed: string;
  seedLong: string;
  floor: number;
  species: number[];
  initHps: number[];
  rolledDamage: number[];
  curlUp: number[];
  initIntents: string[];
  initCounters: Counters;
  turns: GoldenTurn[];
  final: { turn: number; playerHp: number; outcome: number; counters: Counters };
};

const goldenPath = fileURLToPath(new URL("./golden/combat_louse.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { cases: GoldenCase[] };

const CARD_CODE: Record<string, number> = { strike: 0, defend: 1, bash: 2 };
const encode = (ids: string[]): number[] => ids.map((id) => CARD_CODE[id]!);

// golden 用 RED=0 / GREEN=1 编码种族，0/1/2 编码未决/胜/负。
const SPECIES_CODE: Record<string, number> = { louse: 0, green_louse: 1 };
const OUTCOME_CODE = { undecided: 0, player_victory: 1, player_loss: 2 } as const;

const powersOf = (bc: BattleContext, id: string): number[] =>
  bc.monsters.map((m) => m.powers.find((p) => p.id === id)?.amount ?? 0);
const playerPower = (bc: BattleContext, id: string): number =>
  bc.player.powers.find((p) => p.id === id)?.amount ?? 0;

/** 贪心：反复打出第一张打得起的牌，攻击指向下标最小的存活怪。与 C++ dumper 一致。 */
function playGreedy(bc: BattleContext): string[] {
  const played: string[] = [];
  if (probe(bc).outcome !== "undecided") {
    return played;
  }
  for (;;) {
    let pick = -1;
    for (let i = 0; i < bc.hand.length; i += 1) {
      const cost = getCardDef(bc.hand[i]!.defId).cost ?? 0;
      if (cost <= bc.player.energy) {
        pick = i;
        break;
      }
    }
    if (pick < 0) {
      break;
    }
    const target = bc.monsters.findIndex((m) => m.alive);
    played.push(bc.hand[pick]!.defId);
    const r = playCard(bc, pick, target < 0 ? 0 : target);
    if (!r.ok) {
      throw new Error(`playCard 失败: ${r.reason}`);
    }
    if (probe(bc).outcome !== "undecided") {
      break;
    }
  }
  return played;
}

const newBattle = (g: GoldenCase): BattleContext =>
  initCombat({
    seedLong: BigInt(g.seedLong),
    floorNum: g.floor,
    ascension: 0,
    encounterId: "three_louse",
    deckCardIds: [...IRONCLAD_STARTER_DECK],
    playerHp: 80,
    playerMaxHp: 80,
  });

describe("sts-combat 变体编队（miscRng 选怪）对拍 C++ 黄金向量（三虱）", () => {
  for (const g of golden.cases) {
    it(`seed "${g.seed}" @floor ${g.floor}：选型/HP/咬击/蜷缩的交错序列逐位一致`, () => {
      const bc = newBattle(g);

      // 编队成员由 miscRng 掷定，且与 monsterHpRng 交错：misc,hp,hp × 3。
      expect(bc.monsters.map((m) => SPECIES_CODE[m.defId]!)).toEqual(g.species);
      expect(probe(bc).monsterHps).toEqual(g.initHps);
      expect(bc.monsters.map((m) => m.rolledDamage)).toEqual(g.rolledDamage);
      // 蜷缩排在所有 HP roll 与所有 rollMove 之后，再各消耗一次 monsterHpRng。
      expect(powersOf(bc, "curl_up")).toEqual(g.curlUp);
      expect(probe(bc).monsterIntents).toEqual(g.initIntents);
      expect(bc.rng.aiRng.counter).toBe(g.initCounters.aiRng);
      expect(bc.rng.monsterHpRng.counter).toBe(g.initCounters.monsterHpRng);
      expect(bc.rng.miscRng.counter).toBe(g.initCounters.miscRng);
      expect(bc.rng.shuffleRng.counter).toBe(g.initCounters.shuffleRng);

      for (const gt of g.turns) {
        const played = playGreedy(bc);
        const p = probe(bc);

        expect(p.turn).toBe(gt.turn);
        expect(encode(played)).toEqual(gt.played);
        expect(bc.monsters.map((m) => (m.alive ? m.hp : 0))).toEqual(gt.monsterHps);
        expect(bc.monsters.map((m) => m.block)).toEqual(gt.monsterBlocks);
        expect(powersOf(bc, "strength")).toEqual(gt.monsterStrengths);
        expect(p.playerHp).toBe(gt.playerHp);
        expect(p.playerBlock).toBe(gt.playerBlock);
        expect(playerPower(bc, "weak")).toBe(gt.playerWeak);
        expect(bc.monstersAlive).toBe(gt.alive);
        expect(bc.rng.aiRng.counter).toBe(gt.aiRng);
        expect(OUTCOME_CODE[p.outcome]).toBe(gt.outcome);

        endTurn(bc);
      }

      const p = probe(bc);
      expect(p.turn).toBe(g.final.turn);
      expect(p.playerHp).toBe(g.final.playerHp);
      expect(OUTCOME_CODE[p.outcome]).toBe(g.final.outcome);
      expect(bc.rng.aiRng.counter).toBe(g.final.counters.aiRng);
      expect(bc.rng.monsterHpRng.counter).toBe(g.final.counters.monsterHpRng);
      expect(bc.rng.miscRng.counter).toBe(g.final.counters.miscRng);
      expect(bc.rng.shuffleRng.counter).toBe(g.final.counters.shuffleRng);
    });
  }

  it("miscRng 与 monsterHpRng 交错：三虱共消耗 3 次 miscRng、9 次 monsterHpRng", () => {
    // 每只：选型(misc) → HP(hp) → 咬击伤害(hp)；三只之后再各一次蜷缩(hp)。
    const g = golden.cases[0]!;
    const bc = newBattle(g);
    expect(bc.rng.miscRng.counter).toBe(3);
    expect(bc.rng.monsterHpRng.counter).toBe(3 * 2 + 3);
  });

  it("传入已消耗过的 miscRng 会改变编队（证明选型确实取自该流）", () => {
    const g = golden.cases[0]!;
    const base = BigInt(g.seedLong) + BigInt(g.floor);
    const advanced = new StsRandom(base);
    advanced.randomBoolean(); // 先消耗一次，模拟本层战斗前进过事件房
    const bc = initCombat({
      seedLong: BigInt(g.seedLong),
      floorNum: g.floor,
      ascension: 0,
      encounterId: "three_louse",
      deckCardIds: [...IRONCLAD_STARTER_DECK],
      playerHp: 80,
      playerMaxHp: 80,
      miscRng: advanced,
    });
    // 选型序列整体前移一位：新的前两只应等于默认序列的后两只。
    expect(bc.monsters.slice(0, 2).map((m) => SPECIES_CODE[m.defId]!)).toEqual(g.species.slice(1));
  });

  it("蜷缩：首次受到未格挡攻击时加格挡并消失，且不减免触发那一击", () => {
    const g = golden.cases[0]!;
    const bc = newBattle(g);
    const m = bc.monsters[0]!;
    const curl = m.powers.find((p) => p.id === "curl_up")?.amount ?? 0;
    expect(curl).toBeGreaterThan(0);
    const hpBefore = m.hp;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    if (idx >= 0) {
      playCard(bc, idx, 0);
      if (m.alive) {
        expect(m.hp).toBe(hpBefore - 6); // 触发那一击全额生效
        expect(m.block).toBe(curl); // 之后才获得格挡
        expect(m.powers.some((p) => p.id === "curl_up")).toBe(false); // 一次性
      }
    }
  });
});
