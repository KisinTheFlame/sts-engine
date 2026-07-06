// === 游戏级 RNG：逐位复刻《杀戮尖塔》本体的随机源（issue #1）===
//
// 本体是 Java+libgdx。两套 PRNG：
//   - StsRandom = libgdx RandomXS128（xoroshiro128+，64-bit）——游戏主随机源。
//   - JavaRandom = java.util.Random（48-bit LCG）——只用于洗牌（Collections.shuffle）。
// 逐位对齐参考实现 sts_lightspeed/include/game/Random.h。
//
// 64-bit 用 BigInt（seed0/seed1）；counter 语义是硬要求：只有 random*/randomBoolean/
// randomLong 这些公开包装自增 counter，底层 nextLong/nextFloat 不自增。counter 决定
// 序列化复原，错一步全盘皆错。

const U64 = (1n << 64n) - 1n;
const mask64 = (x: bigint): bigint => x & U64;
/** uint64 位型 → 有符号 int64（用于游戏里的 (int64) 重解释）。 */
const asI64 = (x: bigint): bigint => BigInt.asIntN(64, x);

// murmurHash3 fmix64（常量即 C++ 里的两个负 long 的 uint64 位型）。
function murmurHash3(x0: bigint): bigint {
  let x = mask64(x0);
  x ^= x >> 33n;
  x = mask64(x * 0xff51afd7ed558ccdn);
  x ^= x >> 33n;
  x = mask64(x * 0xc4ceb9fe1a85ec53n);
  x ^= x >> 33n;
  return mask64(x);
}

const NORM_FLOAT = 5.9604644775390625e-8;
const NORM_DOUBLE = 1.1102230246251565e-16;
const ONE_IN_MOST_SIGNIFICANT = 1n << 63n;

/** StsRandom 的可序列化状态（uint64 存十进制字符串，counter 存 number）。 */
export type RandomState = { counter: number; seed0: string; seed1: string };

/** libgdx RandomXS128（xoroshiro128+）。counter 与 seed0/seed1 完整可序列化。 */
export class StsRandom {
  counter: number;
  private seed0: bigint;
  private seed1: bigint;

  /**
   * @param seed int64 种子（bigint）。
   * @param targetCounter 若给出，构造后跑 targetCounter 次 random(999) 复原到该 counter。
   */
  constructor(seed: bigint, targetCounter?: number) {
    this.counter = 0;
    this.seed0 = murmurHash3(seed === 0n ? ONE_IN_MOST_SIGNIFICANT : mask64(seed));
    this.seed1 = murmurHash3(this.seed0);
    if (targetCounter !== undefined) {
      for (let i = 0; i < targetCounter; i += 1) {
        this.random(999);
      }
    }
  }

  // --- 底层：不自增 counter ---

  /** xorshift128+ 核心，返回 uint64（bigint）。 */
  private nextLong(): bigint {
    let s1 = this.seed0;
    const s0 = this.seed1;
    this.seed0 = s0;
    s1 ^= mask64(s1 << 23n);
    this.seed1 = mask64(s1 ^ s0 ^ (s1 >> 17n) ^ (s0 >> 26n));
    return mask64(this.seed1 + s0);
  }

  /** [0, n) 的 uint64，拒绝采样去偏（n>0）。 */
  private nextLongBounded(n: bigint): bigint {
    let bits: bigint;
    let value: bigint;
    do {
      bits = this.nextLong() >> 1n;
      value = bits % n;
    } while (asI64(mask64(bits - value + n - 1n)) < 0n);
    return value;
  }

  /** [0, n) 的 int32 等价（n 较小，安全落在 number）。 */
  private nextIntBounded(n: number): number {
    return Number(this.nextLongBounded(BigInt(n)));
  }

  private nextFloat(): number {
    const x = this.nextLong() >> 40n;
    return Math.fround(Number(x) * NORM_FLOAT);
  }

  private nextDouble(): number {
    const x = this.nextLong() >> 11n;
    return Number(x) * NORM_DOUBLE;
  }

  private nextBoolean(): boolean {
    return (this.nextLong() & 1n) === 1n;
  }

  // --- 公开：自增 counter（对齐游戏 random() 家族）---

  /**
   * 整数域（含端）：`random(range)`→[0,range]；`random(start,end)`→[start,end]。
   * 对齐 C++ `random(int)` / `random(int,int)`。**浮点区间请用 randomFloatRange /
   * randomFloatBetween**——本方法只接整数，传浮点会经 BigInt 抛错。
   */
  random(range: number): number;
  random(start: number, end: number): number;
  random(a: number, b?: number): number {
    this.counter += 1;
    if (b === undefined) {
      return this.nextIntBounded(a + 1);
    }
    return a + this.nextIntBounded(b - a + 1);
  }

  /** [0, 1) float32。 */
  randomFloat(): number {
    this.counter += 1;
    return this.nextFloat();
  }

  /** [0, range) float32（对齐 C++ `float random(float range)`，逐步 float32 收窄）。 */
  randomFloatRange(range: number): number {
    this.counter += 1;
    return Math.fround(this.nextFloat() * Math.fround(range));
  }

  /**
   * [start, end) float32（对齐 C++ `float random(float start, float end)`）。
   * clang -O2 把 `start + nextFloat()*(end-start)` 契约成 FMA（乘加单次舍入），
   * 故在 double 里算 `nf*(end-start)+start` 再单次 fround，而非逐步舍入。
   */
  randomFloatBetween(start: number, end: number): number {
    this.counter += 1;
    const s = Math.fround(start);
    const span = Math.fround(Math.fround(end) - s);
    return Math.fround(this.nextFloat() * span + s);
  }

  /** 有符号 int64（对齐 C++ `int64_t randomLong()`）。位型与无符号一致。 */
  randomLong(): bigint {
    this.counter += 1;
    return asI64(this.nextLong());
  }

  /**
   * 原始 [0, n) 整数（对齐 C++ `sts::Random::nextInt(int)`）——**不自增 counter**。
   * 游戏地图洗牌用的就是这个（非 random() 家族）。
   */
  nextInt(n: number): number {
    return this.nextIntBounded(n);
  }

  randomBoolean(): boolean;
  randomBoolean(chance: number): boolean;
  randomBoolean(chance?: number): boolean {
    this.counter += 1;
    if (chance === undefined) {
      return this.nextBoolean();
    }
    return this.nextFloat() < chance;
  }

  /** 跑 randomBoolean 把 counter 追平到 target（游戏 setCounter）。 */
  setCounter(target: number): void {
    while (this.counter < target) {
      this.randomBoolean();
    }
  }

  toState(): RandomState {
    return { counter: this.counter, seed0: this.seed0.toString(), seed1: this.seed1.toString() };
  }

  /** 从序列化状态直接复原（不重放，O(1)）。 */
  static fromState(s: RandomState): StsRandom {
    const r = new StsRandom(0n);
    r.counter = s.counter;
    r.seed0 = BigInt(s.seed0);
    r.seed1 = BigInt(s.seed1);
    return r;
  }
}

// === java.util.Random（48-bit LCG），纯算法移植，仅供洗牌 ===

const JAVA_MULT = 0x5deece66dn;
const JAVA_ADD = 0xbn;
const JAVA_MASK = (1n << 48n) - 1n;

export class JavaRandom {
  private seed: bigint;

  constructor(seed: bigint) {
    this.seed = (mask64(seed) ^ JAVA_MULT) & JAVA_MASK;
  }

  private next(bits: number): number {
    this.seed = (this.seed * JAVA_MULT + JAVA_ADD) & JAVA_MASK;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }

  nextInt(bound: number): number {
    let r = this.next(31);
    const m = bound - 1;
    if ((bound & m) === 0) {
      // bound 是 2 的幂
      return Number((BigInt(bound) * BigInt(r)) >> 31n);
    }
    // Java 的拒绝采样靠 `u - r + m` 的 int32 有符号溢出触发；用 `| 0` 精确模拟
    // 32-bit 回绕，否则 JS 双精度永远为正、永不重 roll，大 bound 洗牌会与游戏分叉。
    for (let u = r; ((u - (r = u % bound) + m) | 0) < 0; u = this.next(31));
    return r;
  }
}

/** java.util.Collections.shuffle：for i=size..2: swap(a[i-1], a[rnd.nextInt(i)])。原地。 */
export function javaShuffle<T>(array: T[], rnd: JavaRandom): void {
  for (let i = array.length; i > 1; i -= 1) {
    const j = rnd.nextInt(i);
    const tmp = array[i - 1];
    array[i - 1] = array[j]!;
    array[j] = tmp;
  }
}

// === base-35 种子字符串 ↔ int64（对齐 SeedHelper）===

const SEED_BASE = 35n;
const SEED_CHARS = "0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ"; // 35 个，跳过字母 O

function digitValue(c: string): number {
  const code = c.charCodeAt(0);
  if (code < 65) {
    return code - 48; // '0'-'9'
  }
  if (code < 79) {
    return code - 65 + 10; // 'A'-'N'
  }
  return code - 65 + 9; // 'P'-'Z'（'O' 落此，与 N 同值；合法种子不含 O）
}

/** base-35 种子串 → int64（bigint）。大端。 */
export function seedStringToLong(seed: string): bigint {
  let ret = 0n;
  for (const ch of seed.toUpperCase()) {
    ret = mask64(ret * SEED_BASE + BigInt(digitValue(ch)));
  }
  return ret;
}

/** int64（bigint）→ base-35 种子串。 */
export function seedLongToString(seed: bigint): string {
  let u = mask64(seed);
  let s = "";
  do {
    s += SEED_CHARS[Number(u % SEED_BASE)];
    u /= SEED_BASE;
  } while (u !== 0n);
  return [...s].reverse().join("");
}
