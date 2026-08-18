import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { migrateLoadedState } from "../src/migrate.js";
import { generateNeowOptions, NeowBonus, NeowDrawback } from "../src/engine/sts-neow.js";

// ============================================================================
// 第五十七批：涅奥的四个选项接进 run 层（「一、接线」第 6 项的**第一片**）。
//
// ⚠⚠ **本批只把选项算出来存下，事件屏还在用近似的四个**。19 × 6 的效果转写是整个待办里
//   最大的一块，塞进这一批只会得到「看着接上了、其实一半效果是编的」。
//   与地图那条（第五十五 / 五十六批）同一个套路：先做能单独验证的一半。
// ============================================================================

const SEED = "1RGBGHNF7L";
const run = (seed: string) => newRun({ runId: "r", seed, character: "ironclad", ascension: 0 });

describe("涅奥选项", () => {
  it("newRun 存下来的就是 generateNeowOptions 的结果", () => {
    expect(run(SEED).neowOptions).toEqual(generateNeowOptions(SEED));
  });

  // ⚠ 这条钉的是**参考的形状规则**（`sts-neow.ts` 里那四个初值就写着）：
  //   前两个选项没有代价，后两个必须各带一个真实代价。它不是我们的约定，是原版的结构。
  it("四个选项：前两个无代价、后两个必有代价，且都不是哨兵", () => {
    for (const seed of [SEED, "SLAYTHESPIRE", "0", "GEN3"]) {
      const options = run(seed).neowOptions;
      expect(options).toHaveLength(4);
      for (const o of options) {
        expect(o.bonus, `${seed}: 祝福是哨兵`).not.toBe(NeowBonus.INVALID);
        expect(o.drawback, `${seed}: 代价是哨兵`).not.toBe(NeowDrawback.INVALID);
      }
      expect(options[0]!.drawback).toBe(NeowDrawback.NONE);
      expect(options[1]!.drawback).toBe(NeowDrawback.NONE);
      expect(options[2]!.drawback).not.toBe(NeowDrawback.NONE);
      expect(options[3]!.drawback).not.toBe(NeowDrawback.NONE);
    }
  });

  it("同种子同选项（确定性）", () => {
    expect(run(SEED).neowOptions).toEqual(run(SEED).neowOptions);
  });

  it("老存档回填：按 seed 重算，与新开局一致", () => {
    const fresh = run(SEED);
    const old = JSON.parse(JSON.stringify(fresh)) as Record<string, unknown>;
    delete old["neowOptions"];
    expect(migrateLoadedState(old).neowOptions).toEqual(fresh.neowOptions);
  });
});
