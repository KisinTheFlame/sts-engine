import type { MapGraph } from "../types.js";

// === 地图的只读工具 ===
//
// ⚠⚠ **这个模块的生成器第五十六批删掉了**（15 层固定网格、房型由调用方用
//   `ENABLED_MAP_TYPES` 挑、边随手连——它的形状与原版无关），接位的是 `sts-map` 的
//   `generateMap` + `mapGraphFromStsMap`。规矩与删近似战斗 / 近似遗物钩子 / 近似遭遇池同源：
//   **有了游戏级对应物就不留两套**。
// ⚠ 留下的 `availableNext` 只读 `MapGraph`，与这张图是谁生成的无关，所以它跨过换代不变。

export function availableNext(graph: MapGraph, currentNodeId: string | null): string[] {
  if (currentNodeId === null) {
    return graph.startNodeIds;
  }
  return graph.nodes[currentNodeId]?.next ?? [];
}
