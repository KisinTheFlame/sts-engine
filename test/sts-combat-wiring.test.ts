import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyAction, newRun } from "../src/engine/engine.js";
import type { GameAction } from "../src/engine/engine.js";
import { costOf, getCardDef } from "../src/engine/cards/cards.js";
import { startCombat, stsCombatCoverage, usePotion } from "../src/engine/combat-bridge.js";
import {
  SUPPORTED_ENCOUNTERS,
  exportState,
  importState,
  initCombat,
} from "../src/engine/sts-combat.js";
import { StsRandom } from "../src/engine/sts-rng.js";
import type { GameState } from "../src/engine/types.js";

// ============================================================================
// 接线：run.ts / engine.ts 经 combat-bridge 用 sts-combat 打所有战斗，
// 战斗状态落在 GameState.combat（BattleContext 的纯数据投影）上。
//
// 这里钉三件事：
//   ① 接线本身不扰动战斗——桥递进去的入参必须与直接调 initCombat 逐字段一致
//   ② 快照可往返——GameState 过一遍 JSON 后继续打，结果与不落盘完全相同
//   ③ 尚未迁移的内容显式抛错——没有近似实现可退，静默降级比失败危险
// ============================================================================

/** 起一局并越过涅奥祝福，停在可以直接开战的状态。 */
function runAtMap(seed = 1): GameState {
  const state = newRun({ runId: "wiring", seed });
  state.event = null;
  state.screen = "map";
  return state;
}

/**
 * sts 路径的下一步动作：能量够就打最右边那张（从右往左取，出牌不会让下标漂移），
 * 都打不动就结束回合。目标取第一只活着的怪。
 */
function nextAction(state: GameState): GameAction {
  const combat = state.combat!;
  const targetIndex = combat.monsters.findIndex((m) => m.alive);
  for (let i = combat.hand.length - 1; i >= 0; i -= 1) {
    const card = combat.hand[i];
    const cost = costOf(getCardDef(card.defId), card.upgraded) ?? 0;
    if (cost <= combat.player.energy) {
      return { type: "play_card", handIndex: i, targetIndex };
    }
  }
  return { type: "end_turn" };
}

describe("接线：战斗由 sts-combat 承担", () => {
  it("开战后战斗快照落在 GameState.combat 上", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    expect(state.screen).toBe("combat");
    expect(state.combat).not.toBeNull();
    expect(state.combat!.encounterId).toBe("cultist");
    expect(state.combat!.monsters.map((m) => m.defId)).toEqual(["cultist"]);
    // 起手 5 张、能量 3——由 sts-combat 的 init 决定，不是桥自己造的。
    expect(state.combat!.hand).toHaveLength(5);
    expect(state.combat!.player.energy).toBe(3);
  });

  it("桥递进去的入参与直接调 initCombat 逐字段一致（接线不扰动 RNG）", () => {
    const state = runAtMap(42);
    state.floorNum = 7; // 战斗流按 Random(seed + floorNum) 播种，换层必须换结果
    startCombat(state, "two_louse");
    const direct = initCombat({
      seedLong: BigInt(state.seed),
      floorNum: 7,
      ascension: 0,
      encounterId: "two_louse",
      deck: state.deck.map((card) => ({ defId: card.defId, upgraded: card.upgraded })),
      playerHp: state.hp,
      playerMaxHp: state.maxHp,
      character: "ironclad",
      relics: state.relics.map((relic) => relic.id),
      potions: [...state.potions],
      potionCapacity: state.potions.length,
      potionRng: new StsRandom(BigInt(state.seed)),
    });
    expect(state.combat).toEqual(exportState(direct));
  });

  it("玩家血量与药水槽写回 GameState", () => {
    const state = runAtMap();
    state.potions = ["block_potion", null, null];
    startCombat(state, "cultist");
    expect(usePotion(state, 0, null)).toEqual({ ok: true });
    expect(state.potions).toEqual([null, null, null]);
    expect(state.combat!.player.block).toBe(12);
    expect(state.log.join("")).toContain("你使用了");

    // 挨几刀，血量要跟着掉（战斗内的血是 run 级资源）。
    applyAction(state, { type: "end_turn" });
    applyAction(state, { type: "end_turn" });
    expect(state.hp).toBeLessThan(state.maxHp);
    expect(state.hp).toBe(state.combat!.player.hp);
  });

  it("打赢后清空 combat、发奖励，并结算燃烧之血", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    let hpInCombat = state.combat!.player.hp;
    let lastAction: GameAction = { type: "end_turn" };
    for (let step = 0; step < 200 && state.combat !== null; step += 1) {
      hpInCombat = state.combat.player.hp;
      lastAction = nextAction(state);
      applyAction(state, lastAction);
    }
    expect(state.combat).toBeNull();
    // 收尾那一下是出牌（不是敌人回合），故 hpInCombat 就是结算前的血量。
    expect(lastAction.type).toBe("play_card");
    expect(state.screen).toBe("reward");
    expect(state.reward!.cardChoices.length).toBeGreaterThan(0);
    expect(state.gold).toBeGreaterThan(0);
    expect(state.log.join("")).toContain("战斗胜利！");
    // 燃烧之血（铁甲起始遗物）：战斗结束回 6 血。它只有 onCombatEnd 钩子，
    // 属战斗之后的 run 级结算，由桥补上。
    expect(state.hp).toBe(Math.min(state.maxHp, hpInCombat + 6));
  });

  it("玩家阵亡切 gameover 并清空战斗", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    state.combat!.player.hp = 1;
    for (let step = 0; step < 20 && state.screen === "combat"; step += 1) {
      applyAction(state, { type: "end_turn" });
    }
    expect(state.screen).toBe("gameover");
    expect(state.combat).toBeNull();
    expect(state.hp).toBe(0);
    expect(applyAction(state, { type: "end_turn" }).ok).toBe(false);
  });
});

describe("接线：GameState 快照可 JSON 往返", () => {
  it("往返后逐字段不变", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    applyAction(state, { type: "play_card", handIndex: 0, targetIndex: 0 });
    const roundTripped = JSON.parse(JSON.stringify(state)) as GameState;
    expect(roundTripped).toEqual(state);
    // importState→exportState 也必须是恒等（RNG 走 fromState，不重放 counter）。
    expect(exportState(importState(state.combat!))).toEqual(state.combat);
  });

  // 一路打到分出胜负：邪教徒那局赢（顺带过一遍奖励结算），
  // 残血进三虱那局输（过一遍阵亡分支）。
  const cases = [
    { seed: 1, encounter: "cultist", startHp: 80, ending: "reward" },
    { seed: 777, encounter: "three_louse", startHp: 6, ending: "gameover" },
  ] as const;

  for (const { seed, encounter, startHp, ending } of cases) {
    it(`每步存盘读盘一次，结果与不落盘完全相同（${encounter} → ${ending}）`, () => {
      const live = runAtMap(seed);
      live.hp = startHp;
      startCombat(live, encounter);
      let saved = JSON.parse(JSON.stringify(live)) as GameState;

      for (let step = 0; step < 200 && live.screen === "combat"; step += 1) {
        // 动作按 live 的手牌挑；两份状态每步都断言相等，所以对 saved 同样合法。
        const action = nextAction(live);
        const liveResult = applyAction(live, action);
        expect(applyAction(saved, action)).toEqual(liveResult);
        // 模拟 HTTP 层的真实节奏：每个动作之后落盘、读回。
        saved = JSON.parse(JSON.stringify(saved)) as GameState;
        expect(saved).toEqual(live);
      }
      expect(live.screen).toBe(ending);
    });
  }
});

describe("接线：尚未迁移的内容显式抛错", () => {
  // 近似实现已删除，没有回退路径。静默降级会让「同种子复现原版」失去意义，
  // 错配 RNG 也比直接失败危险，所以这里要的就是抛错。
  const reason = (state: GameState, encounterId: string): string => {
    const coverage = stsCombatCoverage(state, encounterId);
    expect(coverage.supported).toBe(false);
    return coverage.supported ? "" : coverage.reason;
  };

  it("未迁移的编队：startCombat 抛错，且不留半个战斗状态", () => {
    const state = runAtMap();
    expect(() => startCombat(state, "gremlin_nob")).toThrow(/gremlin_nob/);
    expect(state.combat).toBeNull();
    expect(reason(state, "gremlin_nob")).toContain("尚未迁移");
  });

  it("牌组里有未迁移的牌 → 抛错", () => {
    const state = runAtMap();
    state.deck.push({ uid: 999, defId: "whirlwind", upgraded: false });
    expect(reason(state, "cultist")).toContain("尚未迁移");
    expect(() => startCombat(state, "cultist")).toThrow();
  });

  it("固有牌（含瓶装遗物封入的实例）→ 抛错", () => {
    const state = runAtMap();
    state.deck[0].innate = true;
    expect(reason(state, "cultist")).toContain("固有牌");
  });

  it("未迁移的药水 → 抛错", () => {
    const state = runAtMap();
    state.potions = ["snecko_oil", null, null];
    expect(reason(state, "cultist")).toContain("snecko_oil");
  });

  it("非铁甲角色：起始牌组就有未迁移的牌，因此照样挡住", () => {
    const state = newRun({ runId: "w", seed: 1, character: "silent" });
    expect(reason(state, "cultist")).toContain("尚未迁移");
  });

  it("遗物不参与前置检查——已登记的照常生效（金刚杵 +1 力量）", () => {
    const state = runAtMap();
    state.relics.push({ id: "vajra", counter: 0 });
    expect(stsCombatCoverage(state, "cultist")).toEqual({ supported: true });
    startCombat(state, "cultist");
    expect(state.combat!.player.powers).toEqual([{ id: "strength", amount: 1 }]);
  });

  it("遗物不参与前置检查——未登记的不挡路，只是暂时没有战斗内效果", () => {
    // 赤备（战斗开局 +8 活力）的战斗内行为还没迁移：它不该让整场战斗打不起来，
    // 只是这一场没有它的效果。等它登记进 sts-combat 时再补。
    const state = runAtMap();
    state.relics.push({ id: "akabeko", counter: 0 });
    expect(stsCombatCoverage(state, "cultist")).toEqual({ supported: true });
    startCombat(state, "cultist");
    expect(state.combat!.player.powers).toEqual([]);
  });
});

describe("接线：覆盖面登记与 trace 数据双向对齐", () => {
  it("SUPPORTED_ENCOUNTERS 与 test/golden/traces 一一对应", () => {
    const traceDir = fileURLToPath(new URL("./golden/traces", import.meta.url));
    const withTrace = readdirSync(traceDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort();
    // 多列（登记了却没 trace 背书）与漏列（有 trace 却不启用）都会在这里失败。
    expect([...SUPPORTED_ENCOUNTERS].sort()).toEqual(withTrace);
  });
});
