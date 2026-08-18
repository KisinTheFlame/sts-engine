import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { migrateLoadedState } from "../src/migrate.js";

// ============================================================================
// 第五十九批：本次会话给 run 层加的四个字段的**存档往返**用例。
//
// 为什么单独钉它：这四个字段决定的是「这一局接下来打哪几场仗、走哪张图」，
// 而它们全都是**开局算一次、之后只读**的。这类字段有一个特有的失败模式——
// **存档往返把它丢了，引擎不会报错，只会在读档之后打一局「另一个种子的仗」**。
// 那与本项目最不接受的「静默产出错误数值」是同一族问题，只是发生在 run 层。
//
// ⚠ `migrateLoadedState` 对**缺字段**的老档会重算（各自的用例已经钉过），这里钉的是
//   **不缺字段**时它必须原样保留——回填逻辑写反了同样是静默的。
// ============================================================================

const roundTrip = (seed: string) => {
  const fresh = newRun({ runId: "r", seed, character: "ironclad", ascension: 0 });
  const loaded = migrateLoadedState(JSON.parse(JSON.stringify(fresh)) as unknown);
  return { fresh, loaded };
};

describe("run 层状态的存档往返", () => {
  it("遭遇计划 / 游标 / 涅奥选项 / 地图 原样保留", () => {
    const { fresh, loaded } = roundTrip("1RGBGHNF7L");
    expect(loaded.encounterPlan).toEqual(fresh.encounterPlan);
    expect(loaded.encounterCursor).toEqual(fresh.encounterCursor);
    expect(loaded.neowOptions).toEqual(fresh.neowOptions);
    expect(loaded.map).toEqual(fresh.map);
  });

  // ⚠ 游标推进过之后再存档——这是真实存档的形态，也是「回填把它压回 0」这种 bug
  //   唯一能被看见的地方（全新开局时游标本来就是 0，压回去看不出来）。
  it("推进过的游标不会被回填压回 0", () => {
    const fresh = newRun({ runId: "r", seed: "1RGBGHNF7L", character: "ironclad", ascension: 0 });
    fresh.encounterCursor.monsters[0] = 3;
    fresh.encounterCursor.elites[0] = 1;
    fresh.combatsEntered = 3;
    const loaded = migrateLoadedState(JSON.parse(JSON.stringify(fresh)) as unknown);
    expect(loaded.encounterCursor.monsters[0]).toBe(3);
    expect(loaded.encounterCursor.elites[0]).toBe(1);
  });

  it("严格遗物模式这个开关也原样保留（true / false / 缺席三种都是）", () => {
    for (const value of [true, false, undefined]) {
      const fresh = newRun({ runId: "r", seed: "0", character: "ironclad", ascension: 0 });
      if (value !== undefined) {
        fresh.strictRelicCoverage = value;
      }
      const loaded = migrateLoadedState(JSON.parse(JSON.stringify(fresh)) as unknown);
      expect(loaded.strictRelicCoverage).toBe(value);
    }
  });
});
