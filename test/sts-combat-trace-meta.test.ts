import { describe, it, expect } from "vitest";
import { forEachTrace, HARNESS_GOLD_BASELINE } from "./helpers/trace-replay.js";
import { listTraceFiles, SLICES, SLICE_COUNT } from "./helpers/trace-slices.js";

// ============================================================================
// 对拍**这套装置自身**的测试：切片完备性 + 语料的全局不变量。
//
// ⚠ 这个文件里的用例**不重放任何 trace**（那是 16 个切片文件的活），它守的是
//   「切片这件事没有把谁弄丢」以及「重放侧的入场常数与 harness 对得上」。
// ============================================================================

describe("对拍切片的完备性", () => {
  // ⚠⚠ **这是拆分对拍时唯一真正危险的地方，也是这条用例存在的全部理由。**
  //
  // 拆之前，对拍是「读整个目录」——新增一个 jsonl 自动就被跑到。拆之后，一个文件要被跑到，
  // 得有某一片认领它。于是出现了一种**静默**的失败模式：某一批新增的 trace 文件谁都不匹配，
  // 它一声不响地不被测试，而 CI 全绿。那比「对拍太吃内存」严重得多——对拍的全部价值就是
  // 「同种子逐位复现原版」，少测一个编队等于那个编队的背书凭空消失。
  //
  // 所以这里用**目录的实际内容**逐个文件去问每一片「你要不要」，要求答案恰好是一个。
  // ⚠ **不要**改成拿写死的名单去核对：写死的名单只会证明「名单与切片一致」，
  //   而漏掉的文件同时不在名单里、也不在任何切片里，正好两边都看不见。
  // ⚠ **不要**加「兜底切片」（谓词恒真、收容所有没人要的文件）：那样这条断言永远不会红，
  //   等于没有断言。宁可让某个文件暂时无人认领而当场翻红，也不要让它被默默收走。
  it("golden/traces 下每个 .jsonl 都恰好被一个切片认领", () => {
    const files = listTraceFiles();
    expect(files.length, "语料目录空了？那多半是路径写错，而不是真的没有 trace").toBeGreaterThan(0);
    expect(SLICES.length, "SLICES 的长度必须与 SLICE_COUNT 一致").toBe(SLICE_COUNT);

    const orphans: string[] = [];
    const shared: string[] = [];
    const perSlice = new Map<string, number>(SLICES.map((s) => [s.id, 0]));
    for (const f of files) {
      const owners = SLICES.filter((s) => s.matches(f));
      if (owners.length === 0) {
        orphans.push(f);
      } else if (owners.length > 1) {
        shared.push(`${f} → ${owners.map((o) => o.id).join(", ")}`);
      } else {
        perSlice.set(owners[0]!.id, perSlice.get(owners[0]!.id)! + 1);
      }
    }

    expect(
      orphans,
      `这些 trace 文件**不属于任何切片**，也就是说它们一条用例都没跑：\n  ${orphans.join("\n  ")}\n` +
        `每个 .jsonl 必须恰好被一片认领——修 test/helpers/trace-slices.ts 的 sliceIndexOf / SLICES。`,
    ).toEqual([]);
    expect(
      shared,
      `这些 trace 文件被**多片**同时认领，会被重复跑（用例数因此虚高，变异例数不再可比）：\n  ${shared.join("\n  ")}`,
    ).toEqual([]);

    // 每一片都得有东西可跑：空切片说明分配函数塌了（例如 SLICE_COUNT 被调到比文件数还大），
    // 那不会丢覆盖，但会让「片数」这个旋钮悄悄失效，早点说出来比较好。
    const empty = [...perSlice].filter(([, n]) => n === 0).map(([id]) => id);
    expect(empty, `这些切片一个文件都没分到：${empty.join(", ")}`).toEqual([]);
  });
});

describe("trace 数据自身的不变量", () => {
  // HARNESS_GOLD_BASELINE 偏小时给一条比「第 N 步状态不符」直白得多的诊断：
  // 参考的金币不会为负（`stealGoldFromPlayer` 按 `min(gold, 额度)` 钳制、`gainGold` 只加），
  // 所以任何一条 `goldGained` 都不可能比入场值还负。
  // ⚠ 反方向（常数偏大）**测不出来**，数据里没有那份信息，见 HARNESS_GOLD_BASELINE 的注释。
  // ⚠ 这条必须扫**全库**，所以它用 `forEachTrace` 流式遍历（一次只留一个文件），
  //   而不是像切片那样把语料读成数组——它要是也持有全量，这次拆分就白拆了。
  it(`每条快照的 goldGained 都不低于 -${HARNESS_GOLD_BASELINE}（金币不会为负）`, () => {
    let worst = 0;
    let where = "";
    forEachTrace((t) => {
      for (const s of [t.initial, ...t.steps.map((step) => step.after)]) {
        const d = s.goldGained ?? 0;
        if (d < worst) {
          worst = d;
          where = `${t.encounter} seed ${t.seed} @floor ${t.floor}`;
        }
      }
    });
    expect(
      worst,
      `最深的一次金币变化是 ${worst}（${where}）。它比 -HARNESS_GOLD_BASELINE 还低，` +
        `说明重放侧的入场金币常数比 harness 的小——偷金的钳制会提前生效，见 HARNESS_GOLD_BASELINE。`,
    ).toBeGreaterThanOrEqual(-HARNESS_GOLD_BASELINE);
  });
});
