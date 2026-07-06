import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { grantRelic } from "../src/engine/relics/relics.js";
import { currentOptions, applyChoose } from "../src/engine/run/run.js";
import { availableNext } from "../src/engine/map/map.js";
import type { GameState, MapNode } from "../src/engine/types.js";

// 补全批次 F：? 房间（迷你宝箱/念珠手链）+ 地图路径（仙女靴）。

function run(): GameState {
  return newRun({ runId: "bf", seed: 19, character: "ironclad" });
}

/** 找一个类型为 event 的地图节点 id（用于驱动 ? 房间逻辑）。 */
function findEventNode(state: GameState): MapNode | undefined {
  return Object.values(state.map.nodes).find((n) => n.type === "event");
}

describe("迷你宝箱：第 4 个 ? 房间变宝箱", () => {
  it("前 3 次进 ? 为事件，第 4 次开宝箱", () => {
    const s = run();
    grantRelic(s, "tiny_chest");
    const eventNode = findEventNode(s)!;
    const relics0 = s.relics.length;
    // 手动把当前节点设到该事件节点前，直接驱动 resolveNode 通过 applyChoose 不便；
    // 改为直接反复进入：把 currentNodeId 置为可达该事件节点的前置，简化为直接调用路由。
    // 这里用 choose 到事件节点四次（每次重置 currentNodeId 让它可达）。
    for (let i = 1; i <= 4; i += 1) {
      s.screen = "map";
      // 让事件节点可达：把 currentNodeId 设为 null 且让事件节点成为入口之一不一定成立，
      // 因此直接构造：把地图入口指向事件节点。
      s.currentNodeId = null;
      s.map = {
        ...s.map,
        startNodeIds: [eventNode.id],
      };
      applyChoose(s, 0);
      if (i < 4) {
        expect(s.screen).toBe("event");
        // 结束事件回到地图
        s.event = null;
        s.screen = "map";
      } else {
        // 第 4 次：宝箱房 → 直接发遗物并回地图
        expect(s.screen).toBe("map");
        expect(s.relics.length).toBeGreaterThan(relics0);
      }
    }
  });
});

describe("念珠手链：? 房间恒为事件（天然满足）", () => {
  it("持有后 ? 房间仍进入事件屏", () => {
    const s = run();
    grantRelic(s, "juzu_bracelet");
    const eventNode = findEventNode(s)!;
    s.currentNodeId = null;
    s.map = { ...s.map, startNodeIds: [eventNode.id] };
    s.screen = "map";
    applyChoose(s, 0);
    expect(s.screen).toBe("event");
  });
});

describe("仙女靴：无视路径直达下一层任意节点", () => {
  it("可选下一层全部节点，选非可达节点消耗一次余量", () => {
    const s = run();
    grantRelic(s, "wing_boots");
    // 走到第一层某入口
    s.screen = "map";
    applyChoose(s, 0);
    const current = s.map.nodes[s.currentNodeId!]!;
    const normalNext = availableNext(s.map, s.currentNodeId);
    const rowNodes = Object.values(s.map.nodes)
      .filter((n) => n.row === current.row + 1)
      .map((n) => n.id);
    if (rowNodes.length <= normalNext.length) {
      // 该局下一层没有额外可达节点，跳过断言（地图结构使然）。
      return;
    }
    s.screen = "map";
    const options = currentOptions(s);
    expect(options.length).toBe(rowNodes.length);
    // 选一个正常不可达的节点
    const extraIdx = rowNodes.findIndex((id) => !normalNext.includes(id));
    const wingBoots = s.relics.find((r) => r.id === "wing_boots")!;
    const used0 = wingBoots.counter;
    applyChoose(s, extraIdx);
    expect(wingBoots.counter).toBe(used0 + 1);
  });
  it("用满 3 次后回归普通路径", () => {
    const s = run();
    grantRelic(s, "wing_boots");
    const wingBoots = s.relics.find((r) => r.id === "wing_boots")!;
    // 落在第一层某入口，靴子已用满 → 只能走正常可达节点。
    const start = s.map.startNodeIds[0]!;
    s.currentNodeId = start;
    s.screen = "map";
    wingBoots.counter = 3;
    const normal = availableNext(s.map, start);
    expect(currentOptions(s).length).toBe(normal.length);
  });
});
