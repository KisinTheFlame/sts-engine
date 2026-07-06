import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { startCombat, playCard } from "../src/engine/combat/combat.js";
import { grantRelic } from "../src/engine/relics/relics.js";
import { getPower, addPower } from "../src/engine/powers/powers.js";
import { generateReward } from "../src/engine/run/run.js";
import { getCardDef } from "../src/engine/cards/cards.js";
import type { CardInstance, CharacterId, GameState } from "../src/engine/types.js";

// 补全批次 D：瓶装固有 / 样本瓶传毒 / 棱镜碎片 / 钢笔尖 / 唤魔铃。

function run(character: CharacterId = "ironclad"): GameState {
  return newRun({ runId: "bd", seed: 15, character });
}
function card(s: GameState, defId: string): CardInstance {
  return { uid: s.nextUid++, defId, upgraded: false };
}

describe("瓶装遗物：封入的牌开局固有", () => {
  it("火焰之瓶：一张攻击牌被封瓶，战斗开局在手", () => {
    const s = run();
    grantRelic(s, "bottled_flame");
    expect(s.deck.some((c) => c.innate && getCardDef(c.defId).type === "attack")).toBe(true);
    startCombat(s, "cultist");
    expect(s.combat!.hand.some((c) => c.innate)).toBe(true);
  });
  it("旋风之瓶：牌组有能力牌时封入", () => {
    const s = run();
    s.deck.push(card(s, "inflame")); // 烈焰灌注：能力牌
    grantRelic(s, "bottled_tornado");
    expect(s.deck.some((c) => c.innate && getCardDef(c.defId).type === "power")).toBe(true);
  });
});

describe("样本瓶：敌人死亡传毒", () => {
  it("有毒敌人死亡 → 毒转移给另一敌人", () => {
    const s = run();
    grantRelic(s, "the_specimen");
    startCombat(s, "two_louse");
    const [a, b] = s.combat!.enemies;
    addPower(a!.powers, "poison", 5);
    a!.hp = 1;
    a!.block = 0;
    a!.curlUpConsumed = true; // 关掉虱子的蜷缩，保证一击致死
    s.combat!.hand = [card(s, "strike")];
    s.combat!.energy = 3;
    playCard(s, 0, 0); // 打死 a
    expect(a!.hp).toBe(0);
    expect(getPower(b!.powers, "poison")).toBe(5);
  });
});

describe("棱镜碎片：奖励含无色牌", () => {
  it("多次奖励中出现无色牌", () => {
    let sawColorless = false;
    for (let seed = 0; seed < 40 && !sawColorless; seed += 1) {
      const s = newRun({ runId: `ps${seed}`, seed, character: "ironclad" });
      grantRelic(s, "prismatic_shard");
      s.screen = "combat";
      generateReward(s);
      if (s.reward!.cardChoices.some((c) => getCardDef(c.defId).color === "colorless")) {
        sawColorless = true;
      }
    }
    expect(sawColorless).toBe(true);
  });
});

describe("钢笔尖：第 10 张攻击双倍", () => {
  it("counter=9 时下一张攻击伤害翻倍", () => {
    // 基准伤害
    const base = run();
    startCombat(base, "cultist");
    base.combat!.enemies[0]!.block = 0;
    base.combat!.hand = [card(base, "strike")];
    base.combat!.energy = 3;
    const bhp = base.combat!.enemies[0]!.hp;
    playCard(base, 0, 0);
    const normal = bhp - base.combat!.enemies[0]!.hp;

    const s = run();
    grantRelic(s, "pen_nib");
    s.relics.find((r) => r.id === "pen_nib")!.counter = 9;
    startCombat(s, "cultist");
    s.combat!.enemies[0]!.block = 0;
    s.combat!.hand = [card(s, "strike")];
    s.combat!.energy = 3;
    const hp0 = s.combat!.enemies[0]!.hp;
    playCard(s, 0, 0);
    expect(hp0 - s.combat!.enemies[0]!.hp).toBe(normal * 2);
  });
});

describe("唤魔铃：3 遗物 + 1 诅咒", () => {
  it("获得后遗物 +≥3，牌组多一张诅咒", () => {
    const s = run();
    const relics0 = s.relics.length;
    const curses0 = s.deck.filter((c) => getCardDef(c.defId).type === "curse").length;
    grantRelic(s, "calling_bell");
    // 唤魔铃本体 + 3 个遗物
    expect(s.relics.length).toBeGreaterThanOrEqual(relics0 + 4);
    expect(s.deck.filter((c) => getCardDef(c.defId).type === "curse").length).toBe(curses0 + 1);
  });
});
