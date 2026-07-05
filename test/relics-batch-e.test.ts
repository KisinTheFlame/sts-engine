import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { startCombat, endTurn, playCard } from "../src/engine/combat/combat.js";
import { grantRelic } from "../src/engine/relics/relics.js";
import { getPower, addPower } from "../src/engine/powers/powers.js";
import { applyChoose, currentOptions } from "../src/engine/run/run.js";
import { generateShop } from "../src/engine/shop/shop.js";
import type { CardInstance, CharacterId, GameState } from "../src/engine/types.js";

// 补全批次 E：选牌事件/篝火 + 姿态/球/弃牌联动遗物。

function run(character: CharacterId = "ironclad"): GameState {
  return newRun({ runId: "be", seed: 17, character });
}
function card(s: GameState, defId: string): CardInstance {
  return { uid: s.nextUid++, defId, upgraded: false };
}
function atEvent(id: string, character: CharacterId = "ironclad"): GameState {
  const s = run(character);
  s.event = { id };
  s.screen = "event";
  return s;
}

describe("图书馆：选牌加入", () => {
  it("进入选牌屏，选 1 张加入牌组", () => {
    const s = atEvent("library");
    applyChoose(s, 0);
    expect(s.screen).toBe("card_select");
    expect(s.cardSelect!.mode).toBe("add");
    expect(s.cardSelect!.choices.length).toBe(5);
    const n0 = s.deck.length;
    applyChoose(s, 0);
    expect(s.deck.length).toBe(n0 + 1);
    expect(s.screen).toBe("map");
  });
  it("可跳过", () => {
    const s = atEvent("library");
    applyChoose(s, 0);
    const n0 = s.deck.length;
    applyChoose(s, s.cardSelect!.choices.length); // 跳过
    expect(s.deck.length).toBe(n0);
    expect(s.screen).toBe("map");
  });
});

describe("复制器：复制一张牌", () => {
  it("选牌屏复制牌组一张牌 → 牌组 +1", () => {
    const s = atEvent("duplicator");
    applyChoose(s, 0);
    expect(s.cardSelect!.mode).toBe("duplicate");
    const n0 = s.deck.length;
    const targetDef = s.cardSelect!.choices[0]!.defId;
    applyChoose(s, 0);
    expect(s.deck.length).toBe(n0 + 1);
    expect(s.deck.filter((c) => c.defId === targetDef).length).toBeGreaterThanOrEqual(2);
  });
});

describe("和平烟斗：篝火抽牌", () => {
  it("篝火出现抽烟项，抽去一张牌", () => {
    const s = run();
    grantRelic(s, "peace_pipe");
    s.screen = "rest";
    const idx = currentOptions(s).findIndex((o) => o.includes("抽烟"));
    expect(idx).toBeGreaterThan(0);
    applyChoose(s, idx);
    expect(s.screen).toBe("card_select");
    expect(s.cardSelect!.mode).toBe("remove");
    const n0 = s.deck.length;
    applyChoose(s, 0);
    expect(s.deck.length).toBe(n0 - 1);
  });
});

describe("对偶手镯：攻击 +临时敏捷", () => {
  it("打攻击 +1 临时敏捷，回合结束清零", () => {
    const s = run("watcher");
    grantRelic(s, "duality");
    startCombat(s, "cultist");
    s.combat!.hand = [card(s, "strike")];
    s.combat!.energy = 3;
    playCard(s, 0, 0);
    expect(getPower(s.combat!.playerPowers, "dexterity_temp")).toBe(1);
    endTurn(s);
    expect(getPower(s.combat!.playerPowers, "dexterity_temp")).toBe(0);
  });
});

describe("橙色药丸：攻击+技能+能力清除减益", () => {
  it("集齐三类牌 → 移除虚弱/易伤", () => {
    const s = run();
    grantRelic(s, "orange_pellets");
    startCombat(s, "cultist");
    addPower(s.combat!.playerPowers, "weak", 3);
    addPower(s.combat!.playerPowers, "vulnerable", 3);
    s.combat!.energy = 5;
    s.combat!.hand = [card(s, "strike"), card(s, "defend"), card(s, "inflame")];
    playCard(s, 0, 0); // 攻击
    playCard(s, 0, null); // 技能（defend）
    expect(getPower(s.combat!.playerPowers, "weak")).toBe(3); // 未集齐
    playCard(s, 0, null); // 能力（inflame）→ 集齐清除
    expect(getPower(s.combat!.playerPowers, "weak")).toBe(0);
    expect(getPower(s.combat!.playerPowers, "vulnerable")).toBe(0);
  });
});

describe("情绪芯片：上回合掉血 → 回合开始触发球被动", () => {
  it("带闪电球时敌人在回合开始额外挨一次", () => {
    function play(withChip: boolean): number {
      const s = run("defect");
      if (withChip) {
        grantRelic(s, "emotion_chip");
      }
      startCombat(s, "cultist");
      s.combat!.enemies[0]!.hp = 200;
      s.combat!.enemies[0]!.maxHp = 200;
      s.combat!.orbs = [{ type: "lightning" }];
      s.hp = 1; // 制造「上回合掉血」
      endTurn(s);
      return 200 - s.combat!.enemies[0]!.hp;
    }
    const withChip = play(true);
    const without = play(false);
    expect(withChip).toBeGreaterThan(without);
  });
});

describe("镀金电缆：最右侧球回合末额外触发", () => {
  it("单闪电球回合末触发 2 次", () => {
    function play(withCable: boolean): number {
      const s = run("defect");
      if (withCable) {
        grantRelic(s, "gold_plated_cables");
      }
      startCombat(s, "cultist");
      s.combat!.enemies[0]!.hp = 200;
      s.combat!.enemies[0]!.maxHp = 200;
      s.combat!.orbs = [{ type: "lightning" }];
      endTurn(s);
      return 200 - s.combat!.enemies[0]!.hp;
    }
    expect(play(true)).toBeGreaterThan(play(false));
  });
});

describe("奇怪的勺子：消耗牌 50% 改弃牌", () => {
  it("多次打出消耗牌，出现进弃牌堆的情况", () => {
    let sawDiscard = false;
    let sawExhaust = false;
    for (let seed = 0; seed < 30; seed += 1) {
      const s = newRun({ runId: `sp${seed}`, seed, character: "ironclad" });
      grantRelic(s, "strange_spoon");
      startCombat(s, "cultist");
      const c = card(s, "intimidate"); // 0 费、自带消耗
      s.combat!.hand = [c];
      s.combat!.energy = 3;
      playCard(s, 0, null);
      if (s.combat!.discardPile.some((x) => x.uid === c.uid)) sawDiscard = true;
      if (s.combat!.exhaustPile.some((x) => x.uid === c.uid)) sawExhaust = true;
    }
    expect(sawDiscard).toBe(true);
    expect(sawExhaust).toBe(true);
  });
});

describe("浑天仪：+5 张牌", () => {
  it("获得时牌组 +5", () => {
    const s = run();
    const n0 = s.deck.length;
    grantRelic(s, "orrery");
    expect(s.deck.length).toBe(n0 + 5);
  });
});

describe("信使：商店多进货", () => {
  it("带信使时商店牌/药水各多 1", () => {
    const base = run();
    generateShop(base);
    const baseCards = base.shop!.items.filter((i) => i.kind === "card").length;
    const basePotions = base.shop!.items.filter((i) => i.kind === "potion").length;

    const s = run();
    grantRelic(s, "the_courier");
    generateShop(s);
    expect(s.shop!.items.filter((i) => i.kind === "card").length).toBe(baseCards + 1);
    expect(s.shop!.items.filter((i) => i.kind === "potion").length).toBe(basePotions + 1);
  });
});
