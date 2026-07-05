import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { startCombat, playCard } from "../src/engine/combat/combat.js";
import { grantRelic } from "../src/engine/relics/relics.js";
import { getPower } from "../src/engine/powers/powers.js";
import { generateShop } from "../src/engine/shop/shop.js";
import { getCardDef } from "../src/engine/cards/cards.js";
import type { CardInstance, CharacterId, GameState } from "../src/engine/types.js";

// 补全批次 C：商店定价 / 状态牌·诅咒牌可打 / X 费 / 破甲 / 中毒。

function run(character: CharacterId = "ironclad"): GameState {
  return newRun({ runId: "bc", seed: 9, character });
}
function card(s: GameState, defId: string): CardInstance {
  return { uid: s.nextUid++, defId, upgraded: false };
}

describe("会员卡：商店 5 折", () => {
  it("所有商品与去牌半价", () => {
    const s = run();
    grantRelic(s, "membership_card");
    generateShop(s);
    expect(s.shop!.purgeCost).toBe(37); // floor(75*0.5)
    // 折后没有任何商品超过 95（遗物原价 140~180，折后 ≤90）。
    expect(s.shop!.items.every((i) => i.cost <= 95)).toBe(true);
  });
  it("不带会员卡时遗物价格高于 100", () => {
    const s = run();
    generateShop(s);
    expect(s.shop!.items.some((i) => i.kind === "relic" && i.cost >= 100)).toBe(true);
  });
});

describe("微笑面具：去牌固定 50", () => {
  it("purgeCost=50", () => {
    const s = run();
    grantRelic(s, "smiling_mask");
    generateShop(s);
    expect(s.shop!.purgeCost).toBe(50);
  });
});

describe("医疗包：可打状态牌", () => {
  it("状态牌 0 费打出并消耗", () => {
    const s = run();
    grantRelic(s, "medical_kit");
    startCombat(s, "cultist");
    const c = card(s, "wound");
    s.combat!.hand = [c];
    const e0 = s.combat!.energy;
    expect(playCard(s, 0, null).ok).toBe(true);
    expect(s.combat!.energy).toBe(e0); // 0 费
    expect(s.combat!.exhaustPile.some((x) => x.uid === c.uid)).toBe(true);
  });
  it("无医疗包时状态牌打不出", () => {
    const s = run();
    startCombat(s, "cultist");
    s.combat!.hand = [card(s, "wound")];
    expect(playCard(s, 0, null).ok).toBe(false);
  });
});

describe("蓝烛：可打诅咒牌，失 1 血并消耗", () => {
  it("诅咒牌打出失 1 血", () => {
    const s = run();
    grantRelic(s, "blue_candle");
    startCombat(s, "cultist");
    s.hp = 50;
    const c = card(s, "clumsy");
    s.combat!.hand = [c];
    expect(playCard(s, 0, null).ok).toBe(true);
    expect(s.hp).toBe(49);
    expect(s.combat!.exhaustPile.some((x) => x.uid === c.uid)).toBe(true);
  });
});

describe("化学 X：X 费牌 X+2", () => {
  it("旋风斩 3 能量打出 → 命中 5 次（5×5=25）", () => {
    const s = run();
    grantRelic(s, "chemical_x");
    startCombat(s, "cultist");
    s.combat!.enemies[0]!.block = 0;
    s.combat!.hand = [card(s, "whirlwind")];
    s.combat!.energy = 3;
    const hp0 = s.combat!.enemies[0]!.hp;
    playCard(s, 0, null);
    expect(hp0 - s.combat!.enemies[0]!.hp).toBe(25);
  });
  it("无化学 X 时 3 次（5×3=15）", () => {
    const s = run();
    startCombat(s, "cultist");
    s.combat!.enemies[0]!.block = 0;
    s.combat!.hand = [card(s, "whirlwind")];
    s.combat!.energy = 3;
    const hp0 = s.combat!.enemies[0]!.hp;
    playCard(s, 0, null);
    expect(hp0 - s.combat!.enemies[0]!.hp).toBe(15);
  });
});

describe("蛇之眼：多抽 2 + 费用随机", () => {
  it("第一回合手牌 7 张，抽到牌费用随机 0~3", () => {
    const s = run();
    grantRelic(s, "snecko_eye");
    startCombat(s, "cultist");
    expect(s.combat!.hand.length).toBe(7);
    for (const c of s.combat!.hand) {
      const def = getCardDef(c.defId);
      if (def.cost !== null && !def.xCost) {
        expect(c.randomCost).toBeGreaterThanOrEqual(0);
        expect(c.randomCost).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("手钻：破甲施加易伤", () => {
  it("打破敌人格挡 → +2 易伤", () => {
    const s = run();
    grantRelic(s, "hand_drill");
    startCombat(s, "cultist");
    const e = s.combat!.enemies[0]!;
    e.block = 3;
    s.combat!.hand = [card(s, "strike")]; // 打击 6 伤害 > 3 格挡
    s.combat!.energy = 3;
    playCard(s, 0, 0);
    expect(getPower(e.powers, "vulnerable")).toBe(2);
  });
});

describe("打桩人偶：「打击」牌 +3 伤害", () => {
  it("打击伤害 +3", () => {
    const s = run();
    startCombat(s, "cultist");
    s.combat!.enemies[0]!.block = 0;
    s.combat!.hand = [card(s, "strike")];
    s.combat!.energy = 3;
    const hp0 = s.combat!.enemies[0]!.hp;
    playCard(s, 0, 0);
    const base = hp0 - s.combat!.enemies[0]!.hp;

    const s2 = run();
    grantRelic(s2, "strike_dummy");
    startCombat(s2, "cultist");
    s2.combat!.enemies[0]!.block = 0;
    s2.combat!.hand = [card(s2, "strike")];
    s2.combat!.energy = 3;
    const hp1 = s2.combat!.enemies[0]!.hp;
    playCard(s2, 0, 0);
    expect(hp1 - s2.combat!.enemies[0]!.hp).toBe(base + 3);
  });
});

describe("腕刃：0 费攻击 +4 伤害", () => {
  it("飞刀（0 费攻击）伤害 +4", () => {
    const s = run("silent");
    startCombat(s, "cultist");
    s.combat!.enemies[0]!.block = 0;
    s.combat!.hand = [card(s, "shiv")];
    s.combat!.energy = 3;
    const hp0 = s.combat!.enemies[0]!.hp;
    playCard(s, 0, 0);
    const base = hp0 - s.combat!.enemies[0]!.hp;

    const s2 = run("silent");
    grantRelic(s2, "wrist_blade");
    startCombat(s2, "cultist");
    s2.combat!.enemies[0]!.block = 0;
    s2.combat!.hand = [card(s2, "shiv")];
    s2.combat!.energy = 3;
    const hp1 = s2.combat!.enemies[0]!.hp;
    playCard(s2, 0, 0);
    expect(hp1 - s2.combat!.enemies[0]!.hp).toBe(base + 4);
  });
});

describe("蛇之头骨：中毒 +1", () => {
  it("致命剧毒施加 5 → 6 层", () => {
    const s = run("silent");
    grantRelic(s, "snecko_skull");
    startCombat(s, "cultist");
    s.combat!.hand = [card(s, "deadly_poison")];
    s.combat!.energy = 3;
    playCard(s, 0, 0);
    expect(getPower(s.combat!.enemies[0]!.powers, "poison")).toBe(6);
  });
});
