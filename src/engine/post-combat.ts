import type { GameState } from "./types.js";
import { nextInt, nextRange } from "./rng.js";
import { bossRelicPool, getRelicDef, grantRelic, hasRelic } from "./relics/relics.js";

// === 战斗胜利后的 run 级结算 ===
//
// 两套战斗实现（近似的 combat.ts 与游戏级的 sts-combat.ts）共用这里，免得各写一份
// 之后悄悄跑偏。放在独立叶子模块是为了不产生循环依赖：run.ts → combat 实现 → 本文件。
//
// 非 Boss 的卡/金币/药水奖励不在这里——那是 run.ts 的 generateReward，由 engine.ts 的
// settleAfterCombat 在战斗清空后调用。

const BOSS_GOLD_MIN = 95; // 击败首领掉金币区间（对齐 StS）。
const BOSS_GOLD_MAX = 105;

/**
 * 击败首领的战利品：金币 + 一件未持有的首领遗物，并切到 victory 屏。
 * 之后是否进入下一幕由 engine.ts 的 settleAfterCombat 决定。
 */
export function grantBossVictory(state: GameState): void {
  const gold = nextRange(state.rng, BOSS_GOLD_MIN, BOSS_GOLD_MAX);
  state.gold += gold;
  state.log.push(`击败首领，获得 ${gold} 金币。`);
  const bossRelics = bossRelicPool(state.character).filter((id) => !hasRelic(state, id));
  if (bossRelics.length > 0) {
    const id = bossRelics[nextInt(state.rng, bossRelics.length)];
    grantRelic(state, id);
    state.log.push(`首领倒下，你获得了遗物「${getRelicDef(id).name}」。`);
  }
  state.screen = "victory";
}
