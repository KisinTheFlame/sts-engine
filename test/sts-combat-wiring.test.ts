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
import { migrateLoadedState } from "../src/migrate.js";
import type { GameState } from "../src/engine/types.js";

// ============================================================================
// 接线（TODOS「四、接线」第 1、2 项）：run.ts / engine.ts 经 combat-bridge 用上
// sts-combat，战斗状态落在 GameState.stsCombat 上。
//
// 这里钉三件事：
//   ① 选路正确——默认仍是近似实现；开了 sts 且覆盖得到才走游戏级，覆盖不到显式回退
//   ② 接线本身不扰动战斗——桥递进去的入参必须与直接调 initCombat 逐字段一致
//   ③ 快照可往返——GameState 过一遍 JSON 后继续打，结果与不落盘完全相同
// ============================================================================

/** 起一局并越过涅奥祝福，停在可以直接开战的状态。 */
function runAtMap(combatEngine: "legacy" | "sts", seed = 1): GameState {
  const state = newRun({ runId: "wiring", seed, combatEngine });
  state.event = null;
  state.screen = "map";
  return state;
}

/**
 * sts 路径的下一步动作：能量够就打最右边那张（从右往左取，出牌不会让下标漂移），
 * 都打不动就结束回合。目标取第一只活着的怪。
 */
function nextAction(state: GameState): GameAction {
  const combat = state.stsCombat!;
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

/** legacy 路径的驱动：那边的费用规则复杂得多，直接试着打，被拒就换下一张。 */
function fightLegacyToEnd(state: GameState, maxSteps = 200): void {
  for (let step = 0; step < maxSteps && state.screen === "combat"; step += 1) {
    let played = false;
    for (let i = (state.combat?.hand.length ?? 0) - 1; i >= 0; i -= 1) {
      if (applyAction(state, { type: "play_card", handIndex: i, targetIndex: 0 }).ok) {
        played = true;
        break;
      }
    }
    if (!played) {
      applyAction(state, { type: "end_turn" });
    }
  }
}

describe("接线：默认仍是近似战斗", () => {
  it("newRun 不传 combatEngine 时走 legacy，stsCombat 恒为 null", () => {
    const state = runAtMap("legacy");
    startCombat(state, "cultist");
    expect(state.combatEngine).toBe("legacy");
    expect(state.combat).not.toBeNull();
    expect(state.stsCombat).toBeNull();
  });

  it("老存档回填后按 legacy 续玩", () => {
    const raw = JSON.parse(JSON.stringify(runAtMap("sts"))) as Record<string, unknown>;
    delete raw["combatEngine"];
    delete raw["stsCombat"];
    delete raw["stsPotionRng"];
    const migrated = migrateLoadedState(raw);
    expect(migrated.combatEngine).toBe("legacy");
    expect(migrated.stsCombat).toBeNull();
    expect(migrated.stsPotionRng).toBeNull();
  });
});

describe("接线：combatEngine=sts 走游戏级战斗", () => {
  it("覆盖得到的编队进 stsCombat，且 combat 保持为 null", () => {
    const state = runAtMap("sts");
    startCombat(state, "cultist");
    expect(state.screen).toBe("combat");
    expect(state.combat).toBeNull();
    expect(state.stsCombat).not.toBeNull();
    expect(state.stsCombat!.encounterId).toBe("cultist");
    expect(state.stsCombat!.monsters.map((m) => m.defId)).toEqual(["cultist"]);
    // 起手 5 张、能量 3——由 sts-combat 的 init 决定，不是桥自己造的。
    expect(state.stsCombat!.hand).toHaveLength(5);
    expect(state.stsCombat!.player.energy).toBe(3);
  });

  it("桥递进去的入参与直接调 initCombat 逐字段一致（接线不扰动 RNG）", () => {
    const state = runAtMap("sts", 42);
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
    expect(state.stsCombat).toEqual(exportState(direct));
  });

  it("玩家血量与药水槽写回 GameState", () => {
    const state = runAtMap("sts");
    state.potions = ["block_potion", null, null];
    startCombat(state, "cultist");
    expect(usePotion(state, 0, null)).toEqual({ ok: true });
    expect(state.potions).toEqual([null, null, null]);
    expect(state.stsCombat!.player.block).toBe(12);
    expect(state.log.join("")).toContain("你使用了");

    // 挨几刀，血量要跟着掉（战斗内的血是 run 级资源）。
    applyAction(state, { type: "end_turn" });
    applyAction(state, { type: "end_turn" });
    expect(state.hp).toBeLessThan(state.maxHp);
    expect(state.hp).toBe(state.stsCombat!.player.hp);
  });

  it("打赢后清空 stsCombat、发奖励，并结算燃烧之血", () => {
    const state = runAtMap("sts");
    startCombat(state, "cultist");
    let hpInCombat = state.stsCombat!.player.hp;
    let lastAction: GameAction = { type: "end_turn" };
    for (let step = 0; step < 200 && state.stsCombat !== null; step += 1) {
      hpInCombat = state.stsCombat.player.hp;
      lastAction = nextAction(state);
      applyAction(state, lastAction);
    }
    expect(state.stsCombat).toBeNull();
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
    const state = runAtMap("sts");
    startCombat(state, "cultist");
    state.stsCombat!.player.hp = 1;
    for (let step = 0; step < 20 && state.screen === "combat"; step += 1) {
      applyAction(state, { type: "end_turn" });
    }
    expect(state.screen).toBe("gameover");
    expect(state.stsCombat).toBeNull();
    expect(state.hp).toBe(0);
    expect(applyAction(state, { type: "end_turn" }).ok).toBe(false);
  });
});

describe("接线：GameState 快照可 JSON 往返", () => {
  it("往返后逐字段不变", () => {
    const state = runAtMap("sts");
    startCombat(state, "cultist");
    applyAction(state, { type: "play_card", handIndex: 0, targetIndex: 0 });
    const roundTripped = JSON.parse(JSON.stringify(state)) as GameState;
    expect(roundTripped).toEqual(state);
    // importState→exportState 也必须是恒等（RNG 走 fromState，不重放 counter）。
    expect(exportState(importState(state.stsCombat!))).toEqual(state.stsCombat);
  });

  // 一路打到分出胜负：邪教徒那局赢（顺带过一遍奖励结算），
  // 残血进三虱那局输（过一遍阵亡分支）。
  const cases = [
    { seed: 1, encounter: "cultist", startHp: 80, ending: "reward" },
    { seed: 777, encounter: "three_louse", startHp: 6, ending: "gameover" },
  ] as const;

  for (const { seed, encounter, startHp, ending } of cases) {
    it(`每步存盘读盘一次，结果与不落盘完全相同（${encounter} → ${ending}）`, () => {
      const live = runAtMap("sts", seed);
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

describe("接线：覆盖不到时显式回退", () => {
  const fallbackReason = (state: GameState, encounterId: string): string => {
    const coverage = stsCombatCoverage(state, encounterId);
    expect(coverage.supported).toBe(false);
    return coverage.supported ? "" : coverage.reason;
  };

  it("未迁移的编队回退 legacy，并在 log 里写明原因", () => {
    const state = runAtMap("sts");
    startCombat(state, "gremlin_nob");
    expect(state.combat).not.toBeNull();
    expect(state.stsCombat).toBeNull();
    expect(state.log.join("")).toContain("本场走近似战斗");
    expect(state.log.join("")).toContain("gremlin_nob");
  });

  it("回退后动作照旧走 legacy（一场战斗中途不换实现）", () => {
    const state = runAtMap("sts");
    startCombat(state, "gremlin_nob");
    fightLegacyToEnd(state);
    expect(state.screen).not.toBe("combat");
  });

  it("牌组里有未迁移的牌 → 回退", () => {
    const state = runAtMap("sts");
    state.deck.push({ uid: 999, defId: "whirlwind", upgraded: false });
    expect(fallbackReason(state, "cultist")).toContain("尚未迁移");
  });

  it("固有牌（含瓶装遗物封入的实例）→ 回退", () => {
    const state = runAtMap("sts");
    state.deck[0].innate = true;
    expect(fallbackReason(state, "cultist")).toContain("固有牌");
  });

  it("未迁移的药水 → 回退", () => {
    const state = runAtMap("sts");
    state.potions = ["snecko_oil", null, null];
    expect(fallbackReason(state, "cultist")).toContain("snecko_oil");
  });

  it("有战斗内行为但未迁移的遗物 → 回退", () => {
    const state = runAtMap("sts");
    state.relics.push({ id: "akabeko", counter: 0 }); // onCombatStart：+8 活力
    expect(fallbackReason(state, "cultist")).toContain("遗物");
  });

  it("只有 onCombatEnd 的遗物不妨碍走 sts（燃烧之血）", () => {
    const state = runAtMap("sts");
    expect(state.relics.map((r) => r.id)).toContain("burning_blood");
    expect(stsCombatCoverage(state, "cultist")).toEqual({ supported: true });
  });

  it("战斗内行为已在 sts-combat 登记的遗物不回退（金刚杵）", () => {
    const state = runAtMap("sts");
    state.relics.push({ id: "vajra", counter: 0 });
    expect(stsCombatCoverage(state, "cultist")).toEqual({ supported: true });
    startCombat(state, "cultist");
    expect(state.stsCombat!.player.powers).toEqual([{ id: "strength", amount: 1 }]);
  });

  it("非铁甲角色 → 回退（姿态与充能球整类未迁移）", () => {
    const state = newRun({ runId: "w", seed: 1, character: "silent", combatEngine: "sts" });
    expect(fallbackReason(state, "cultist")).toContain("铁甲");
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
