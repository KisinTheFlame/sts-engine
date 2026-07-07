import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateNeowOptions, neowBonusText, NeowBonus } from "../src/engine/sts-neow.js";

type GoldenNeow = {
  seed: string;
  seedLong: string;
  options: { bonus: number; drawback: number }[];
  counterAfter: number;
};

const goldenPath = fileURLToPath(new URL("./golden/neow.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { neow: GoldenNeow[] };

describe("sts-neow 选项对拍 C++ 黄金向量", () => {
  for (const g of golden.neow) {
    it(`seed "${g.seed}"`, () => {
      const opts = generateNeowOptions(g.seed);
      expect(
        opts.map((o) => ({ bonus: o.bonus as number, drawback: o.drawback as number })),
      ).toEqual(g.options);
    });
  }

  it("第 4 选项恒为 BOSS_RELIC + LOSE_STARTER_RELIC", () => {
    for (const g of golden.neow) {
      const opts = generateNeowOptions(g.seed);
      expect(opts[3]!.bonus).toBe(NeowBonus.BOSS_RELIC);
    }
  });

  it("string 与 bigint 入参一致", () => {
    const g = golden.neow[0]!;
    expect(generateNeowOptions(BigInt(g.seedLong))).toEqual(generateNeowOptions(g.seed));
  });

  it("bonus 文案映射可用", () => {
    expect(neowBonusText(NeowBonus.HUNDRED_GOLD)).toBe("Obtain 100 gold.");
  });
});
