import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { applyChoose } from "../src/engine/run/run.js";
import { EVENT_POOL } from "../src/engine/events/events.js";
import type { CharacterId, GameState } from "../src/engine/types.js";

// 补全批次：战斗事件（event→combat）+ 随机结果事件。

function atEvent(id: string, character: CharacterId = "ironclad"): GameState {
  const s = newRun({ runId: "ec", seed: 13, character });
  s.event = { id };
  s.screen = "event";
  return s;
}

describe("事件池收录新事件", () => {
  it("6 个新事件都在 ? 节点池里", () => {
    for (const id of [
      "colosseum",
      "masked_bandits",
      "dead_adventurer",
      "mushrooms",
      "mysterious_sphere",
      "wheel_of_fortune",
    ]) {
      expect(EVENT_POOL).toContain(id);
    }
  });
});

describe("斗兽场：event→combat", () => {
  it("入场触发精英战，胜利后发遗物", () => {
    const s = atEvent("colosseum");
    expect(applyChoose(s, 0).ok).toBe(true);
    expect(s.screen).toBe("combat");
    expect(s.combat!.encounterId).toBe("colosseum");
    expect(s.combat!.isElite).toBe(true);
    expect(s.pendingRelicReward).toBe(true);
    expect(s.event).toBeNull();
  });
  it("溜走则不进战斗", () => {
    const s = atEvent("colosseum");
    expect(applyChoose(s, 1).ok).toBe(true);
    expect(s.screen).toBe("map");
    expect(s.combat).toBeNull();
  });
});

describe("蒙面强盗：战斗或交钱", () => {
  it("拔刀 → 进战斗", () => {
    const s = atEvent("masked_bandits");
    applyChoose(s, 0);
    expect(s.combat!.encounterId).toBe("masked_bandits");
    expect(s.combat!.isElite).toBe(false);
  });
  it("交钱 → 金币清空、不进战斗", () => {
    const s = atEvent("masked_bandits");
    s.gold = 200;
    applyChoose(s, 1);
    expect(s.gold).toBe(0);
    expect(s.screen).toBe("map");
  });
});

describe("亡者：搜刮触发埋伏", () => {
  it("搜刮 → +30 金 + 精英战", () => {
    const s = atEvent("dead_adventurer");
    s.gold = 0;
    applyChoose(s, 0);
    expect(s.gold).toBe(30);
    expect(s.screen).toBe("combat");
    expect(s.combat!.isElite).toBe(true);
  });
});

describe("蘑菇：食用得最大生命 + 寄生虫", () => {
  it("吃 → 最大生命 +7、牌组添寄生虫", () => {
    const s = atEvent("mushrooms");
    const maxHp0 = s.maxHp;
    applyChoose(s, 1);
    expect(s.maxHp).toBe(maxHp0 + 7);
    expect(s.deck.some((c) => c.defId === "parasite")).toBe(true);
  });
  it("踩碎 → 进真菌战", () => {
    const s = atEvent("mushrooms");
    applyChoose(s, 0);
    expect(s.combat!.encounterId).toBe("two_fungi_beasts");
  });
});

describe("神秘球：撬开触发战斗", () => {
  it("撬开 → 精英战", () => {
    const s = atEvent("mysterious_sphere");
    applyChoose(s, 0);
    expect(s.combat!.encounterId).toBe("mysterious_sphere");
    expect(s.pendingRelicReward).toBe(true);
  });
});

describe("命运之轮：随机结果", () => {
  it("转动后必产生一种可观测变化，且回到地图", () => {
    const s = atEvent("wheel_of_fortune");
    const before = {
      gold: s.gold,
      maxHp: s.maxHp,
      hp: s.hp,
      relics: s.relics.length,
      deck: s.deck.length,
      potions: s.potions.filter((p) => p !== null).length,
      upgraded: s.deck.filter((c) => c.upgraded).length,
    };
    applyChoose(s, 0);
    expect(s.screen).toBe("map");
    const changed =
      s.gold !== before.gold ||
      s.maxHp !== before.maxHp ||
      s.hp !== before.hp ||
      s.relics.length !== before.relics ||
      s.deck.length !== before.deck ||
      s.potions.filter((p) => p !== null).length !== before.potions ||
      s.deck.filter((c) => c.upgraded).length !== before.upgraded;
    expect(changed).toBe(true);
  });
});
