import type { MapGraph, MapNode, MapNodeType, RngState } from "../types.js";
import { nextFloat, nextInt } from "../rng.js";

// === 分支地图（StS 式节点图）===
//
// 一幕 = ROWS 层常规节点 + 顶上一个 Boss 节点。从底层若干入口向上走，节点间连边形成 DAG，
// 玩家每次从当前节点的出边里选一条往上爬。节点类型按 StS 规则分配（底层全战斗、第 9 层宝箱、
// Boss 前一层全休息）。功能性规则，非版权表达。
//
// 节点类型的**内容**随里程碑逐步启用：本模块用 enabledTypes 控制生成器会放哪些类型，
// 精英/事件/商店在其内容里程碑加入（M2/M4）。当前启用：combat / treasure / rest（+强制 boss）。

const ROWS = 15;
const COLS = 7;
const PATHS = 6;
const TREASURE_ROW = 8; // 第 9 层固定宝箱
const REST_ROW = ROWS - 1; // Boss 前一层固定休息

function nodeId(row: number, col: number): string {
  return `${row}-${col}`;
}

/** 沿列做一次向上随机游走：每层从 {col-1,col,col+1} 里选一个夹紧到 [0,COLS-1]。 */
function walkColumn(rng: RngState, col: number): number {
  const delta = nextInt(rng, 3) - 1; // -1 / 0 / +1
  return Math.max(0, Math.min(COLS - 1, col + delta));
}

// ⚠⚠ **玩具地图生成器第五十六批删掉了**，接位的是 `sts-map` 的 `generateMap` + 翻译层
//   `mapGraphFromStsMap`（run 层的 `buildMap` 现在走那条）。规矩与删近似战斗 / 近似遗物钩子
//   / 近似遭遇池同源：**有了游戏级对应物就不留两套**。
//   ⚠ 它当年的形状本来就与原版无关（15 层固定网格、房型由调用方用 `ENABLED_MAP_TYPES`
//     挑、边随手连），留着只会让「同种子复现原版」失真。
// ⚠ `availableNext` **留着**：它只读 `MapGraph`，与这张图是谁生成的无关。

export function availableNext(graph: MapGraph, currentNodeId: string | null): string[] {
  if (currentNodeId === null) {
    return graph.startNodeIds;
  }
  return graph.nodes[currentNodeId]?.next ?? [];
}
