import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// 对拍语料的**切片登记表**。
//
// 为什么要切片：`test/golden/traces` 现在是 208 个 jsonl / 约 1.0GB，解析出来是 2.1GB 堆。
// 全部塞进一个测试文件 ⇒ 一个 V8 isolate 要独自扛下整份语料（实测峰值 RSS 2.7GB），
// 而这份数据的目标是**整个游戏**，还在往上长。vitest 的并行与内存单位都是**文件**，
// 所以把语料按文件切成 SLICE_COUNT 份、每份一个 `*.test.ts`，每个 isolate 只读自己那份。
//
// ⚠⚠ **切的是文件，不是用例。** 一条 trace 仍然对应一个 `it()`——TODOS 里上千个变异例数
// 的单位都是「失败用例数」= 失败 trace 数，粒度一变那份表全部失去可比性。
//
// ⚠⚠ **这张表最大的风险不是不均衡，是「静默漏掉」**：将来某一批新增的 trace 文件如果
// 谁都不匹配，它会**不被任何测试跑到**，而且一声不响。所以
//
//   ① 分配函数是**全函数**：任何一个 `.jsonl` 都由 `sliceIndexOf` 算出唯一一个下标，
//      不存在「不匹配」这种取值——新增文件天然落进某一片，不需要有人来登记；
//   ② `test/sts-combat-trace-meta.test.ts` 里有一条**完备性断言**，用目录的**实际内容**
//      （而不是写死的名单）验证「每个 .jsonl 恰好被一个切片认领」。谁把下面任何一条
//      谓词改窄，那条断言当场红。
// ============================================================================

export const TRACE_DIR = fileURLToPath(new URL("../golden/traces", import.meta.url));

/** 目录里全部 `.jsonl`，**按名字排序**（顺序必须确定，否则切片分配会随文件系统漂移）。 */
export function listTraceFiles(): string[] {
  return readdirSync(TRACE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
}

/**
 * 切片数。
 *
 * 取值理由（都是实测，见 WORKFLOW「对拍是多文件」那节）：单片约 65MB 语料 ⇒ 单个 isolate
 * 的堆从 2.1GB 降到 ~140MB，`maxWorkers` 个切片同时活着也远低于原先一个文件的峰值。
 * 数据继续长的时候，**先把这个数字调大**（切片文件的增删见下面 SLICES 的注释），
 * 不要去抬 `--max-old-space-size`。
 */
export const SLICE_COUNT = 16;

/**
 * 文件 → 切片下标。**全函数**：值域恒是 `0 .. SLICE_COUNT-1`，没有「不属于任何切片」。
 *
 * 分配方式是「按体积从大到小，逐个塞进当前最小的那一片」（LPT 贪心）。
 * ⚠ 不用「排序后下标取模」是因为语料的体积**极不均衡**：cultist / two_louse /
 *   jaw_worm_horde / three_louse / jaw_worm 五个文件就占了 154MB，取模会把它们随机撞在
 *   一起。实测 16 片：取模最大 127MB、贪心最大 65MB——而决定单个 isolate 堆上限的正是
 *   **最大**的那一片。
 * ⚠ 分配只依赖「目录里有哪些文件 + 各自多大」，所以每个切片文件各自算一遍都得到同一个结果，
 *   不需要把分配结果写进任何清单（写死的清单正是这件事最怕的东西）。
 * ⚠ 新增 / 重生成 trace 文件会让分配重排，也就是说某条 trace 可能换一个测试文件跑。
 *   那没有任何影响：用例名、用例数、断言全都不变，变的只是它挂在哪个文件下。
 */
export function sliceIndexOf(file: string): number {
  return assignment()[file] ?? -1;
}

let cached: Record<string, number> | undefined;
function assignment(): Record<string, number> {
  if (cached !== undefined) {
    return cached;
  }
  const files = listTraceFiles();
  const size = new Map(files.map((f) => [f, statSync(join(TRACE_DIR, f)).size]));
  const load = Array.from({ length: SLICE_COUNT }, () => 0);
  const out: Record<string, number> = {};
  // 大的先放，平手时按名字——两条都是为了让结果与 readdir 的顺序无关。
  const byDesc = [...files].sort((a, b) => size.get(b)! - size.get(a)! || a.localeCompare(b));
  for (const f of byDesc) {
    let best = 0;
    for (let i = 1; i < SLICE_COUNT; i++) {
      if (load[i]! < load[best]!) {
        best = i;
      }
    }
    load[best] += size.get(f)!;
    out[f] = best;
  }
  cached = out;
  return out;
}

/**
 * 一个切片：一个 id + 一个「这个文件归不归我」的谓词。
 *
 * ⚠ 谓词写成**独立**的一条条，而不是「一个总分配函数 + 一个兜底」，正是为了让完备性断言
 * 有东西可断言：兜底切片会把任何漏掉的文件默默收走，断言就永远不会红，那等于没有断言。
 */
export type TraceSlice = {
  /** 与 `test/sts-combat-trace-<id>.test.ts` 的文件名对应。 */
  id: string;
  matches: (file: string) => boolean;
};

/**
 * 全部切片。**每加一片就要同时新建一个 `test/sts-combat-trace-<id>.test.ts`**，
 * 内容是两行（import + `defineTraceSuite(SLICES[i]!)`）。
 *
 * ⚠ 只改 `SLICE_COUNT` 而不建对应的测试文件 = 那一片的 trace 谁都不跑。
 *   完备性断言会红，这是它存在的第一条理由。
 */
export const SLICES: TraceSlice[] = Array.from({ length: SLICE_COUNT }, (_, i) => ({
  id: String(i).padStart(2, "0"),
  matches: (file: string) => sliceIndexOf(file) === i,
}));
