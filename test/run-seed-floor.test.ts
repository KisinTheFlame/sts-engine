import { describe, it, expect } from "vitest";
import { newRun, applyAction } from "../src/engine/engine.js";
import { migrateLoadedState } from "../src/migrate.js";
import { seedStringToLong, seedLongToString } from "../src/engine/sts-rng.js";
import type { GameState } from "../src/engine/types.js";

// run 级基础设施：int64 种子 + floorNum。游戏级的 sts-map / sts-neow /
// sts-encounters / sts-combat 全都按 `Random(seed + floorNum)` 播种，这两样是
// 它们接入主流程的前置条件。

const run = (seed: number | bigint | string): GameState =>
  newRun({ runId: "r", seed, character: "ironclad" });

describe("run 级 int64 种子", () => {
  it("种子以 int64 十进制字符串保存，超过 2^53 也不丢精度", () => {
    // 这个值比 Number.MAX_SAFE_INTEGER 大，用 number 存会被四舍五入。
    const big = 2665621045298406349n;
    expect(big > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    const state = run(big);
    expect(state.seed).toBe("2665621045298406349");
    expect(BigInt(state.seed)).toBe(big);
  });

  it("接受游戏内显示的 base-35 种子串，按原版规则换算", () => {
    const state = run("1RGBGHNF7L");
    expect(state.seed).toBe(seedStringToLong("1RGBGHNF7L").toString());
    // 能换回玩家看到的那串。
    expect(seedLongToString(BigInt(state.seed))).toBe("1RGBGHNF7L");
  });

  it("number 入参仍可用，等价于同值的 bigint", () => {
    expect(run(42).seed).toBe(run(42n).seed);
    expect(run(42).seed).toBe("42");
  });

  it("同一种子串开局完全一致（可复现）", () => {
    const a = run("SLAYTHESPIRE");
    const b = run("SLAYTHESPIRE");
    expect(a.seed).toBe(b.seed);
    expect(a.map).toEqual(b.map);
    expect(a.rng).toEqual(b.rng);
  });
});

describe("run 级 floorNum", () => {
  it("开局为 0", () => {
    expect(run(1).floorNum).toBe(0);
  });

  it("每进入一个地图节点自增（Neow 选项本身不算一层）", () => {
    const state = run("1RGBGHNF7L");
    expect(state.floorNum).toBe(0);

    // 开局停在 Neow 事件屏，选祝福不进节点，故不算层。
    expect(state.screen).toBe("event");
    expect(applyAction(state, { type: "choose", optionIndex: 0 }).ok).toBe(true);
    expect(state.screen).toBe("map");
    expect(state.floorNum).toBe(0);

    // 真正踏上第一个节点才 +1（对齐 transitionToMapNode 的 ++floorNum）。
    expect(applyAction(state, { type: "choose", optionIndex: 0 }).ok).toBe(true);
    expect(state.currentNodeId).not.toBeNull();
    expect(state.floorNum).toBe(1);
  });
});

describe("老存档迁移", () => {
  it("number 种子回填为字符串，floorNum 回填为 0", () => {
    const old = { runId: "r", seed: 12345, character: "ironclad" };
    const migrated = migrateLoadedState(old) as unknown as GameState;
    expect(migrated.seed).toBe("12345");
    expect(migrated.floorNum).toBe(0);
  });

  it("已是字符串的种子不被改动", () => {
    const migrated = migrateLoadedState({
      runId: "r",
      seed: "2665621045298406349",
      floorNum: 7,
    }) as unknown as GameState;
    expect(migrated.seed).toBe("2665621045298406349");
    expect(migrated.floorNum).toBe(7);
  });
});
