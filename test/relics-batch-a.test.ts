import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { startCombat, endTurn, playCard } from "../src/engine/combat/combat.js";
import { grantRelic, getRelicDef } from "../src/engine/relics/relics.js";
import { getPower } from "../src/engine/powers/powers.js";
import type { CardInstance, CharacterId, Effect, GameState } from "../src/engine/types.js";

// 补全批次 A：战斗时点遗物（onCombatStart / onTurn* / onDiscard / 预知 / 姿态 / 精英）。

function run(character: CharacterId = "ironclad"): GameState {
  return newRun({ runId: "ba", seed: 5, character });
}
function card(s: GameState, defId: string, upgraded = false): CardInstance {
  return { uid: s.nextUid++, defId, upgraded };
}

describe("黑血：战斗结束回 12 生命", () => {
  it("胜利后回血", () => {
    const s = run();
    // 黑血在 StS 替换燃烧之血；此处移除起始遗物，只留黑血单独验证。
    s.relics = s.relics.filter((r) => r.id !== "burning_blood");
    grantRelic(s, "black_blood");
    startCombat(s, "cultist");
    s.hp = 10;
    s.maxHp = 100;
    // 敌人剩 1 血，打出打击击杀 → 战斗结束 → 黑血回 12。
    s.combat!.enemies[0]!.hp = 1;
    s.combat!.energy = 3;
    s.combat!.hand = [card(s, "strike")];
    playCard(s, 0, 0);
    expect(s.hp).toBe(22);
  });
});

describe("硫磺石：回合开始 +2 力量，敌人 +1 力量", () => {
  it("玩家与敌人力量各增", () => {
    const s = run();
    grantRelic(s, "brimstone");
    startCombat(s, "cultist");
    // startCombat 已跑第一回合的 onTurnStart
    expect(getPower(s.combat!.playerPowers, "strength")).toBe(2);
    expect(getPower(s.combat!.enemies[0]!.powers, "strength")).toBe(1);
  });
});

describe("手鼓：回合开始 +1 法力", () => {
  it("观者获得法力", () => {
    const s = run("watcher");
    grantRelic(s, "damaru");
    startCombat(s, "cultist");
    expect(s.combat!.mantra).toBe(1);
  });
});

describe("发条纪念品：战斗开始 +1 神器", () => {
  it("获得神器层", () => {
    const s = run();
    grantRelic(s, "clockwork_souvenir");
    startCombat(s, "cultist");
    expect(getPower(s.combat!.playerPowers, "artifact")).toBe(1);
  });
});

describe("泪滴坠饰：战斗以平静姿态开始", () => {
  it("开局平静", () => {
    const s = run("watcher");
    grantRelic(s, "teardrop_locket");
    startCombat(s, "cultist");
    expect(s.combat!.playerStance).toBe("calm");
  });
});

describe("核电池 / 共生病毒：战斗开始充能球", () => {
  it("核电池充能等离子", () => {
    const s = run("defect");
    grantRelic(s, "nuclear_battery");
    startCombat(s, "cultist");
    expect(s.combat!.orbs.some((o) => o.type === "plasma")).toBe(true);
  });
  it("共生病毒充能暗球", () => {
    const s = run("defect");
    grantRelic(s, "symbiotic_virus");
    startCombat(s, "cultist");
    expect(s.combat!.orbs.some((o) => o.type === "dark")).toBe(true);
  });
});

describe("斗篷别扣：回合结束每张手牌 +1 格挡", () => {
  it("onTurnEnd 按手牌数加格挡（直接触发钩子）", () => {
    const s = run("watcher");
    grantRelic(s, "cloak_clasp");
    startCombat(s, "cultist");
    s.combat!.hand = [card(s, "strike"), card(s, "defend"), card(s, "strike")];
    const before = s.combat!.playerBlock;
    getRelicDef("cloak_clasp").hooks.onTurnEnd?.(s, { id: "cloak_clasp", counter: 0 }, () => {});
    expect(s.combat!.playerBlock).toBe(before + 3);
  });
});

describe("香料混合：洗牌时预知 3", () => {
  it("onShuffle 发射预知 3", () => {
    const s = run("watcher");
    const out: Effect[] = [];
    getRelicDef("melange").hooks.onShuffle?.(s, { id: "melange", counter: 0 }, (e) => out.push(e));
    expect(out).toEqual([{ kind: "scry", amount: 3 }]);
  });
});

describe("金色之眼：预知额外 +2", () => {
  it("第三只眼预知 3 → 实际预知 5（顶 5 张状态牌全弃）", () => {
    const s = run("watcher");
    grantRelic(s, "golden_eye");
    startCombat(s, "cultist");
    // drawPile 末端为「顶」。顶部 5 张状态牌，scry 3 若放大到 5 则全被弃。
    s.combat!.drawPile = [
      card(s, "strike"),
      card(s, "dazed"),
      card(s, "dazed"),
      card(s, "dazed"),
      card(s, "dazed"),
      card(s, "dazed"),
    ];
    s.combat!.discardPile = [];
    s.combat!.hand = [card(s, "third_eye")];
    s.combat!.energy = 3;
    playCard(s, 0, null);
    expect(s.combat!.discardPile.filter((c) => c.defId === "dazed").length).toBe(5);
  });
  it("无金色之眼时预知 3 只弃 3", () => {
    const s = run("watcher");
    startCombat(s, "cultist");
    s.combat!.drawPile = [
      card(s, "strike"),
      card(s, "dazed"),
      card(s, "dazed"),
      card(s, "dazed"),
      card(s, "dazed"),
      card(s, "dazed"),
    ];
    s.combat!.discardPile = [];
    s.combat!.hand = [card(s, "third_eye")];
    s.combat!.energy = 3;
    playCard(s, 0, null);
    expect(s.combat!.discardPile.filter((c) => c.defId === "dazed").length).toBe(3);
  });
});

describe("勇气投索：精英战开始 +2 力量", () => {
  it("精英战加力量，普通战不加", () => {
    const s = run();
    grantRelic(s, "sling_of_courage");
    startCombat(s, "gremlin_nob", true);
    expect(getPower(s.combat!.playerPowers, "strength")).toBe(2);
    const s2 = run();
    grantRelic(s2, "sling_of_courage");
    startCombat(s2, "cultist", false);
    expect(getPower(s2.combat!.playerPowers, "strength")).toBe(0);
  });
});

describe("密封昆虫：精英敌人 75% 生命开局", () => {
  it("精英敌人减血", () => {
    const s = run();
    grantRelic(s, "preserved_insect");
    startCombat(s, "gremlin_nob", true);
    const e = s.combat!.enemies[0]!;
    expect(e.hp).toBe(Math.floor(e.maxHp * 0.75));
  });
});

describe("冰冻核心：回合结束空槽充能冰霜", () => {
  it("有空槽 → 充能冰霜", () => {
    const s = run("defect");
    grantRelic(s, "frozen_core");
    startCombat(s, "cultist");
    s.combat!.orbs = [];
    endTurn(s);
    expect(s.combat!.orbs.some((o) => o.type === "frost")).toBe(true);
  });
});

describe("插入器：每 2 回合 +1 球槽", () => {
  it("第 2 回合增槽", () => {
    const s = run("defect");
    grantRelic(s, "inserter");
    startCombat(s, "cultist");
    const slots1 = s.combat!.orbSlots;
    endTurn(s); // 进入第 2 回合的 onTurnStart
    expect(s.combat!.orbSlots).toBe(slots1 + 1);
  });
});

describe("符文电容：战斗开始 +3 球槽", () => {
  it("球槽增加 3", () => {
    const s = run("defect");
    grantRelic(s, "runic_capacitor");
    startCombat(s, "cultist");
    expect(s.combat!.orbSlots).toBe(6);
  });
});

describe("紫莲：离开平静额外 +1 能量", () => {
  it("从平静进入愤怒 → +3 能量（2+1）", () => {
    const s = run("watcher");
    grantRelic(s, "violet_lotus");
    startCombat(s, "cultist");
    s.combat!.playerStance = "calm";
    s.combat!.energy = 2;
    // eruption：费 2、造成伤害并进入愤怒（离开平静）。离开平静 +2+1 能量 → 2-2+3=3。
    s.combat!.hand = [card(s, "eruption")];
    playCard(s, 0, 0);
    expect(s.combat!.energy).toBe(3);
  });
});

describe("坚韧绷带 / 叮沙 / 悬浮风筝：弃牌触发", () => {
  it("坚韧绷带：弃 1 张 +3 格挡", () => {
    const s = run("silent");
    grantRelic(s, "tough_bandages");
    startCombat(s, "cultist");
    s.combat!.hand = [card(s, "strike"), card(s, "survivor")];
    // survivor：获得格挡并弃一张牌
    const before = s.combat!.playerBlock;
    // 直接用一张弃牌牌：撒旦之种/防御姿态——用 acrobatics 抽3弃1？改用直接效果
    // 找一张「弃牌」牌：用 "prepared" 抽1弃1
    s.combat!.hand = [card(s, "prepared"), card(s, "strike")];
    playCard(s, 0, null);
    expect(s.combat!.playerBlock).toBeGreaterThanOrEqual(before + 3);
  });
  it("叮沙：弃 1 张对敌人造成 3 伤害", () => {
    const s = run("silent");
    grantRelic(s, "tingsha");
    startCombat(s, "cultist");
    const hp0 = s.combat!.enemies[0]!.hp;
    s.combat!.hand = [card(s, "prepared"), card(s, "strike")];
    playCard(s, 0, null);
    expect(s.combat!.enemies[0]!.hp).toBeLessThan(hp0);
  });
  it("悬浮风筝：本回合首次弃牌 +1 能量，二次不给", () => {
    const s = run("silent");
    grantRelic(s, "hovering_kite");
    startCombat(s, "cultist");
    // drawPile 清空 → prepared 抽 1 无效；discard_random 优先弃状态牌（dazed）保证确定性。
    s.combat!.drawPile = [];
    s.combat!.discardPile = [];
    s.combat!.hand = [card(s, "prepared"), card(s, "prepared"), card(s, "dazed"), card(s, "dazed")];
    const e0 = s.combat!.energy;
    playCard(s, 0, null); // 首弃 +1
    const e1 = s.combat!.energy;
    playCard(s, 0, null); // 二弃不给
    expect(e1).toBe(e0 + 1); // prepared 0 费，净 +1
    expect(s.combat!.energy).toBe(e1);
  });
});

describe("不停转陀螺：手牌打空抽 1", () => {
  it("打出最后一张后手牌非空（补抽）", () => {
    const s = run();
    grantRelic(s, "unceasing_top");
    startCombat(s, "cultist");
    s.combat!.hand = [card(s, "strike")];
    s.combat!.drawPile = [card(s, "defend"), card(s, "defend")];
    s.combat!.energy = 3;
    playCard(s, 0, 0);
    expect(s.combat!.hand.length).toBe(1);
  });
});
