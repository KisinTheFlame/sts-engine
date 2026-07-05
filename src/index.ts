// === @kisinwen/sts-engine 根入口 ===
//
// 便捷门面：最常用的新建对局 + 动作分发 + 全部类型。
// 完整 API 走子路径导入，例如：
//   @kisinwen/sts-engine/engine/cards/cards  (ALL_CARDS / getCardDef / costOf)
//   @kisinwen/sts-engine/engine/relics/relics
//   @kisinwen/sts-engine/sim/policy          (GreedyPolicy)
//   @kisinwen/sts-engine/migrate             (migrateLoadedState)

export { newRun, applyAction } from "./engine/engine.js";
export type { GameAction, ActionResult } from "./engine/engine.js";
export * from "./engine/types.js";
