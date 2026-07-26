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
    deck: IRONCLAD_STARTER_DECK.map((defId) => ({ defId, upgraded: false })),
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

  it("状态牌打不出来——但报的是「打不出来」而不是「暂未登记」", () => {
    // 第五批之后灼伤 / 伤口 / 眩晕真的会躺在手里。它们在 CARD_RULES 里**没有**条目
    // （参考的 canUse 就不让打），所以少了这道门会一路走到「暂未登记卡牌行为」并抛错——
    // 那个错会把「登记了但打不出来」误报成「没登记」，指错方向。
    const bc = battle();
    bc.hand.push({ uid: 900, defId: "wound", upgraded: false });
    const before = probe(bc);
    const r = playCard(bc, bc.hand.length - 1, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("状态牌");
    }
    expect(probe(bc)).toEqual(before);
  });

  it("固有牌多于起手数时补抽差额（trace 牌组够不到这一支）", () => {
    // 对齐 CardManager::init 末尾的 `if (innateCount > cardDrawPerTurn) DrawCards(差额)`。
    // trace 牌组只有 2~3 张固有牌，永远走不到，所以这条分支只能在这里守。
    const bc = initCombat({
      seedLong: 138414915365391n,
      floorNum: 1,
      ascension: 0,
      encounterId: "cultist",
      // 8 张固有 + 2 张非固有：起手应该是 8 张（5 + 差额 3），且全是固有牌。
      deck: [...new Array<string>(8).fill("dramatic_entrance"), "strike", "defend"].map(
        (defId) => ({ defId, upgraded: false }),
      ),
      playerHp: 80,
      playerMaxHp: 80,
    });
    expect(bc.hand.map((c) => c.defId)).toEqual(new Array<string>(8).fill("dramatic_entrance"));
    expect(bc.drawPile).toHaveLength(2);
  });

  it("未登记的怪物会显式抛错，不会静默错配 RNG", () => {
    expect(() =>
      initCombat({
        seedLong: 1n,
        floorNum: 1,
        ascension: 0,
        encounterId: "three_sentries",
        deck: IRONCLAD_STARTER_DECK.map((defId) => ({ defId, upgraded: false })),
        playerHp: 80,
        playerMaxHp: 80,
      }),
    ).toThrow(/未登记怪物 rollMove/);
  });
});
