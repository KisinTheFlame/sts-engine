import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { startCombat, usePotion, playCard } from "../src/engine/combat/combat.js";
import { getCardDef } from "../src/engine/cards/cards.js";
import { getPower } from "../src/engine/powers/powers.js";
import type { CardInstance, CharacterId, GameState } from "../src/engine/types.js";

// 补全批次：硬机制药水（蛇油 / 蒸馏混沌 / 复制药水）。

function run(character: CharacterId = "ironclad"): GameState {
  return newRun({ runId: "ph", seed: 11, character });
}
function card(s: GameState, defId: string): CardInstance {
  return { uid: s.nextUid++, defId, upgraded: false };
}

describe("蛇油：抽 5 + 手牌费用随机", () => {
  it("抽 5 张，手牌费用变 0~3", () => {
    const s = run();
    startCombat(s, "cultist");
    s.combat!.hand = [];
    s.combat!.drawPile = Array.from({ length: 6 }, () => card(s, "strike"));
    s.potions[0] = "snecko_oil";
    expect(usePotion(s, 0, null).ok).toBe(true);
    expect(s.combat!.hand.length).toBe(5);
    for (const c of s.combat!.hand) {
      expect(c.randomCost).toBeGreaterThanOrEqual(0);
      expect(c.randomCost).toBeLessThanOrEqual(3);
    }
  });
});

describe("蒸馏混沌：打出顶 3 张", () => {
  it("顶 3 张打击各命中敌人", () => {
    const s = run();
    startCombat(s, "cultist");
    s.combat!.enemies[0]!.block = 0;
    s.combat!.hand = [];
    s.combat!.drawPile = [card(s, "strike"), card(s, "strike"), card(s, "strike")];
    const hp0 = s.combat!.enemies[0]!.hp;
    s.potions[0] = "distilled_chaos";
    expect(usePotion(s, 0, null).ok).toBe(true);
    // 3 张打击各 6 伤害 = 18
    expect(hp0 - s.combat!.enemies[0]!.hp).toBe(18);
    // 打出后进弃牌堆
    expect(s.combat!.discardPile.length).toBe(3);
  });
});

describe("复制药水：下一张牌结算两次", () => {
  it("使用后打出打击 → 伤害翻倍", () => {
    const s = run();
    startCombat(s, "cultist");
    s.combat!.enemies[0]!.block = 0;
    s.potions[0] = "duplication_potion";
    expect(usePotion(s, 0, null).ok).toBe(true);
    expect(getPower(s.combat!.playerPowers, "duplication")).toBe(1);
    s.combat!.hand = [card(s, "strike")];
    s.combat!.energy = 3;
    const hp0 = s.combat!.enemies[0]!.hp;
    playCard(s, 0, 0);
    // 打击 6 伤害 ×2 = 12
    expect(hp0 - s.combat!.enemies[0]!.hp).toBe(12);
    expect(getPower(s.combat!.playerPowers, "duplication")).toBe(0);
  });
  it("仅作用于一张，第二张恢复正常", () => {
    const s = run();
    startCombat(s, "cultist");
    s.combat!.enemies[0]!.block = 0;
    s.potions[0] = "duplication_potion";
    usePotion(s, 0, null);
    s.combat!.hand = [card(s, "strike"), card(s, "strike")];
    s.combat!.energy = 3;
    playCard(s, 0, 0); // 双结算
    const hp1 = s.combat!.enemies[0]!.hp;
    playCard(s, 0, 0); // 正常
    void getCardDef; // 保留引用
    expect(hp1 - s.combat!.enemies[0]!.hp).toBe(6);
  });
});
