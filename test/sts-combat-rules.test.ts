import { describe, it, expect } from "vitest";
import { initCombat, playCard, drinkPotion, probe } from "../src/engine/sts-combat.js";
import { IRONCLAD_STARTER_DECK } from "../src/engine/cards/cards.js";

// trace 重放只会走合法动作（策略从参考的 isValidAction 里挑），所以**拒绝路径**
// 永远不会出现在 trace 里。这里单独钉住它们：非法输入必须被明确拒绝，且状态不动。

const battle = (potions: (string | null)[] = [null, null, null]) =>
  initCombat({
    seedLong: 138414915365391n,
    floorNum: 1,
    ascension: 0,
    encounterId: "cultist",
    deckCardIds: [...IRONCLAD_STARTER_DECK],
    playerHp: 80,
    playerMaxHp: 80,
    character: "ironclad",
    potions,
  });

describe("sts-combat 非法动作的拒绝路径", () => {
  it("能量不足时拒绝出牌，且状态完全不变", () => {
    const bc = battle();
    bc.player.energy = 0;
    const before = probe(bc);
    const r = playCard(bc, 0, 0);
    expect(r.ok).toBe(false);
    expect(probe(bc)).toEqual(before);
  });

  it("手牌下标越界被拒绝", () => {
    const bc = battle();
    expect(playCard(bc, 99, 0).ok).toBe(false);
  });

  it("指向性牌打向无效目标被拒绝", () => {
    const bc = battle();
    bc.monsters[0]!.alive = false;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    expect(playCard(bc, idx, 0).ok).toBe(false);
  });

  it("空药水槽被拒绝", () => {
    const bc = battle();
    expect(drinkPotion(bc, 0)).toEqual({ ok: false, reason: "药水槽 0 为空" });
  });

  it("未登记的药水被明确拒绝，而不是静默跳过", () => {
    // 静默跳过会让 potionRng 与战斗状态悄悄错位，比直接失败危险得多。
    const bc = battle([null, "snecko_oil", null]);
    const r = drinkPotion(bc, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("暂未登记药水");
    }
    expect(probe(bc).potions).toEqual([null, "snecko_oil", null]);
  });

  it("战斗结束后拒绝一切动作", () => {
    const bc = battle(["block_potion", null, null]);
    bc.monsters[0]!.hp = 1;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    playCard(bc, idx, 0);
    expect(probe(bc).outcome).toBe("player_victory");
    expect(playCard(bc, 0, 0).ok).toBe(false);
    expect(drinkPotion(bc, 0).ok).toBe(false);
  });

  it("未登记的怪物会显式抛错，不会静默错配 RNG", () => {
    expect(() =>
      initCombat({
        seedLong: 1n,
        floorNum: 1,
        ascension: 0,
        encounterId: "three_sentries",
        deckCardIds: [...IRONCLAD_STARTER_DECK],
        playerHp: 80,
        playerMaxHp: 80,
      }),
    ).toThrow(/未登记怪物 rollMove/);
  });
});
