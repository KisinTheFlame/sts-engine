import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  StsRandom,
  JavaRandom,
  javaShuffle,
  seedStringToLong,
  seedLongToString,
} from "../src/engine/sts-rng.js";

type PrimEntry = {
  seedLong: string;
  roundtrip: string;
  random99: number[];
  counterAfter: number;
  randomLong: string[];
  nextFloatBits: number[];
  random0to5: number[];
  randBool33: number[];
  replayMatch: boolean;
  javaShuffle20FromFirstLong: number[];
  javaSeedLong: string;
};

const goldenPath = fileURLToPath(new URL("./golden/primitives.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
  primitives: Record<string, PrimEntry>;
};

/** float → uint32 位型，用于逐位比对 nextFloat。 */
function floatToBits(f: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = f;
  return new Uint32Array(buf)[0]!;
}

describe("sts-rng 原语对拍 C++ 黄金向量", () => {
  const seeds = Object.keys(golden.primitives);

  for (const seedStr of seeds) {
    const g = golden.primitives[seedStr]!;

    describe(`seed "${seedStr}"`, () => {
      it("base-35 种子串 ↔ int64 双向", () => {
        const long = seedStringToLong(seedStr);
        expect(long.toString()).toBe(g.seedLong);
        expect(seedLongToString(long)).toBe(g.roundtrip);
      });

      it("random(99) x100 + counter", () => {
        const r = new StsRandom(BigInt(g.seedLong));
        const out = Array.from({ length: 100 }, () => r.random(99));
        expect(out).toEqual(g.random99);
        expect(r.counter).toBe(g.counterAfter);
      });

      it("randomLong() x100（uint64 十进制）", () => {
        const r = new StsRandom(BigInt(g.seedLong));
        const out = Array.from({ length: 100 }, () => (r.randomLong() & ((1n << 64n) - 1n)).toString());
        expect(out).toEqual(g.randomLong);
      });

      it("randomFloat() x100 逐位相等", () => {
        const r = new StsRandom(BigInt(g.seedLong));
        const out = Array.from({ length: 100 }, () => floatToBits(r.randomFloat()));
        expect(out).toEqual(g.nextFloatBits);
      });

      it("random(0,5) x50（含端）", () => {
        const r = new StsRandom(BigInt(g.seedLong));
        const out = Array.from({ length: 50 }, () => r.random(0, 5));
        expect(out).toEqual(g.random0to5);
      });

      it("randomBoolean(0.33) x50", () => {
        const r = new StsRandom(BigInt(g.seedLong));
        const out = Array.from({ length: 50 }, () => (r.randomBoolean(0.33) ? 1 : 0));
        expect(out).toEqual(g.randBool33);
      });

      it("Random(seed, counter) 重放复原 == 序列消耗", () => {
        const a = new StsRandom(BigInt(g.seedLong));
        for (let i = 0; i < 37; i += 1) a.random(99);
        const b = new StsRandom(BigInt(g.seedLong), 37);
        expect(b.toState()).toEqual(a.toState());
      });

      it("toState/fromState 往返（O(1) 复原）", () => {
        const a = new StsRandom(BigInt(g.seedLong));
        for (let i = 0; i < 23; i += 1) a.random(99);
        const restored = StsRandom.fromState(a.toState());
        // 复原后继续消耗，与原始继续消耗应一致
        const contA = Array.from({ length: 10 }, () => a.random(99));
        const contB = Array.from({ length: 10 }, () => restored.random(99));
        expect(contB).toEqual(contA);
      });

      it("java.Random 洗牌 0..19（种子取自首个 randomLong）", () => {
        const r = new StsRandom(BigInt(g.seedLong));
        const jsLong = r.randomLong() & ((1n << 64n) - 1n);
        expect(jsLong.toString()).toBe(g.javaSeedLong);
        const arr = Array.from({ length: 20 }, (_v, i) => i);
        javaShuffle(arr, new JavaRandom(jsLong));
        expect(arr).toEqual(g.javaShuffle20FromFirstLong);
      });
    });
  }
});
