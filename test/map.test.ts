import { describe, expect, it } from "vitest";
import { availableNext } from "../src/engine/map/map.js";
import { newRun } from "../src/engine/engine.js";
import type { GameState } from "../src/engine/types.js";

// ============================================================================
// 第五十六批：`buildMap` 换成**游戏级地图**（`sts-map` + 翻译层）之后，这个文件的断言
// 也跟着换代了。
//
// ⚠⚠ **换掉的那五条断言是玩具地图的性质，不是原版的性质**，逐条记一下免得有人以为是回归：
//   * 「15 层」→ 真实地图是 15 层网格 **+ 一个合成的 Boss 节点** = 16 层（`graph.rows`）；
//   * 「底层入口全是战斗」→ 真实第一幕第 0 层确实全是战斗房，但那是**生成规则**的结果
//     （`sts-map` 自己的用例守着），这里只断言「入口都在第 0 层」；
//   * 「宝箱只出现在第 9 层」→ 真实地图的宝箱层是**生成器**定的，同上；
//   * 「未启用的类型不会出现（本里程碑无精英/事件/商店）」→ **直接删掉**：那是玩具地图
//     `ENABLED_MAP_TYPES` 的性质，真实地图一上来就有精英 / 事件 / 商店；
//   * 「同种子生成同地图」→ 留着，而且更强了（现在是同种子 × 同幕）。
// ============================================================================

const run = (seed: string, ascension = 0): GameState =>
  newRun({ runId: "r", seed, character: "ironclad", ascension });

describe("地图（游戏级）", () => {
  it("结构：入口都在第 0 层，Boss 节点存在且没有出边", () => {
    const state = run("1RGBGHNF7L");
    expect(state.map.startNodeIds.length).toBeGreaterThan(0);
    for (const id of state.map.startNodeIds) {
      expect(state.map.nodes[id]!.row).toBe(0);
    }
    const boss = state.map.nodes[state.map.bossNodeId]!;
    expect(boss.type).toBe("boss");
    expect(boss.next).toEqual([]);
  });

  it("每条 next 都指向真实存在的节点（翻译没有留下悬空边）", () => {
    for (const seed of ["1RGBGHNF7L", "SLAYTHESPIRE", "0"]) {
      const state = run(seed);
      for (const node of Object.values(state.map.nodes)) {
        for (const nextId of node.next) {
          expect(state.map.nodes[nextId], `${node.id} → ${nextId} 悬空`).toBeDefined();
        }
      }
    }
  });

  it("availableNext：null 返回入口、boss 返回空", () => {
    const state = run("1RGBGHNF7L");
    expect(availableNext(state.map, null)).toEqual(state.map.startNodeIds);
    expect(availableNext(state.map, state.map.bossNodeId)).toEqual([]);
  });

  it("同种子同幕生成同一张地图（确定性）", () => {
    expect(run("1RGBGHNF7L").map).toEqual(run("1RGBGHNF7L").map);
  });

  // ⚠ 这条是换代**买到**的东西，玩具地图给不了：真实地图一上来就有精英 / 事件 / 商店 /
  //   篝火 / 宝箱，而 run 层的路由早就为这五种写好了分支（此前一条都走不到）。
  it("真实地图会出现玩具地图给不了的房型（精英 / 事件 / 商店）", () => {
    const seen = new Set<string>();
    for (const seed of ["1RGBGHNF7L", "SLAYTHESPIRE", "0", "GEN7"]) {
      for (const node of Object.values(run(seed).map.nodes)) {
        seen.add(node.type);
      }
    }
    for (const type of ["combat", "elite", "event", "rest", "shop", "treasure", "boss"]) {
      expect(seen, `没有一张图出现过 ${type}`).toContain(type);
    }
  });
});
