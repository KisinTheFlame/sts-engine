import { describe, expect, it } from "vitest";
import { generateMap, mapGraphFromStsMap, Room } from "../src/engine/sts-map.js";

// ============================================================================
// 第五十五批：`GameMap` → `MapGraph` 的翻译层（「一、接线」第 5 项的前一半）。
//
// ⚠ 这里钉的是**翻译**，不是地图生成本身——后者早就与原版逐位对齐、由 sts-map.test.ts 守着。
//   所以下面每一条断言都只问「翻译有没有丢东西 / 有没有编东西」。
// ============================================================================

const SEED = "1RGBGHNF7L";

describe("地图翻译层", () => {
  it("每个非空格都翻译成一个节点，空格一个都不翻译", () => {
    const map = generateMap(SEED, 0, 1);
    const graph = mapGraphFromStsMap(map);
    let occupied = 0;
    for (const row of map.nodes) {
      for (const node of row) {
        if (node.room !== Room.NONE) occupied += 1;
      }
    }
    // +1 = 合成的 Boss 节点（参考的 15 层网格里没有它）。
    expect(Object.keys(graph.nodes)).toHaveLength(occupied + 1);
  });

  it("边翻译成下一层的节点 id，顺序照抄、不排序不去重", () => {
    const map = generateMap(SEED, 0, 1);
    const graph = mapGraphFromStsMap(map);
    for (let y = 0; y < map.nodes.length - 1; y += 1) {
      for (let x = 0; x < map.nodes[y]!.length; x += 1) {
        const node = map.nodes[y]![x]!;
        if (node.room === Room.NONE) continue;
        const translated = graph.nodes[`${String(y)}-${String(x)}`]!;
        expect(translated.next).toEqual(node.edges.map((d) => `${String(y + 1)}-${String(d)}`));
      }
    }
  });

  it("入口是第 0 层的全部节点；最后一层全部指向 Boss；Boss 没有出边", () => {
    const graph = mapGraphFromStsMap(generateMap(SEED, 0, 1));
    expect(graph.startNodeIds.length).toBeGreaterThan(0);
    for (const id of graph.startNodeIds) {
      expect(graph.nodes[id]!.row).toBe(0);
    }
    const lastRow = graph.rows - 2;
    for (const node of Object.values(graph.nodes)) {
      if (node.row === lastRow) {
        expect(node.next).toEqual([graph.bossNodeId]);
      }
    }
    expect(graph.nodes[graph.bossNodeId]!.next).toEqual([]);
  });

  it("Boss 从任一入口可达（图是连通的，翻译没有割断边）", () => {
    const graph = mapGraphFromStsMap(generateMap(SEED, 0, 1));
    for (const start of graph.startNodeIds) {
      const seen = new Set<string>();
      const stack = [start];
      let reached = false;
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (id === graph.bossNodeId) {
          reached = true;
          break;
        }
        stack.push(...graph.nodes[id]!.next);
      }
      expect(reached, `${start} 走不到 Boss`).toBe(true);
    }
  });

  // ⚠ 房型翻译必须是**全射**里那六种，遇到 BOSS_TREASURE / NONE / INVALID 要抛错而不是猜
  //   ——猜错会让「第几层是哪种房间」静默偏掉，而那正是这条接线要保证的东西。
  it("三幕、多种子都翻译得动，且只产出六种房型", () => {
    const allowed = new Set(["combat", "elite", "event", "rest", "shop", "treasure", "boss"]);
    for (const seed of [SEED, "SLAYTHESPIRE", "0"]) {
      for (const act of [1, 2, 3]) {
        const graph = mapGraphFromStsMap(generateMap(seed, 0, act));
        for (const node of Object.values(graph.nodes)) {
          expect(allowed, `${seed}/act${String(act)} 出现了 ${node.type}`).toContain(node.type);
        }
      }
    }
  });

  it("同种子翻译出同一张图（确定性）", () => {
    const a = mapGraphFromStsMap(generateMap(SEED, 0, 2));
    const b = mapGraphFromStsMap(generateMap(SEED, 0, 2));
    expect(a).toEqual(b);
  });
});
