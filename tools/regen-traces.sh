#!/usr/bin/env bash
#
# 重新生成 golden trace 数据，并**在安装之前**校验三条不变量。
#
# trace 数据是这个项目唯一的预言机：它由参考项目**真实的 BattleContext** 驱动产出，
# 不是第二份手工转写。所以生成它的过程必须自己带检查，不能靠人看一眼。
#
# 三条不变量（任一条不过就退出、**不安装**）：
#
#   ① 预言机可复现  —— 未改动 harness 时，重跑必须逐字节复现已提交的数据（整个文件）。
#                       先证明管道能复现旧数据，重生成的新数据才有理由可信。
#   ② variant 0 不被扰动 —— 改了 harness 之后，文件开头 variant 0 那一段仍须逐字节不变。
#                       traceIdx 驱动遗物/药水轮换，variant 0 的位置一动，它那几百例背书
#                       就全部失效。variant 0 之后的行是**允许被替换**的——布局策略是
#                       「variant 0 冻结 + 其后每批用当前全牌组重生成」，见 split-traces.mjs。
#   ③ 新卡真的被打出 —— 见 tools/check-coverage.mjs。
#
# 用法:
#   tools/regen-traces.sh --check            # 只做 ①：确认能复现已提交数据，不写任何文件
#   tools/regen-traces.sh --install NAME...  # 全流程：生成 → 校验 → 安装；NAME 是本批新卡的
#                                            #   参考枚举名，用于 ③
# 环境变量:
#   STS_REF   参考项目路径（默认 ~/Workspace/sts_lightspeed）
#
set -euo pipefail

REF="${STS_REF:-$HOME/Workspace/sts_lightspeed}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACES="$REPO/test/golden/traces"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MODE="${1:---check}"
shift || true

if [[ ! -d "$REF" ]]; then
  echo "✗ 找不到参考项目: $REF（用 STS_REF 指定）" >&2
  exit 2
fi
HARNESS="$REF/tools/sts-engine-harness/trace_dump.cpp"
if [[ ! -f "$HARNESS" ]]; then
  echo "✗ 找不到 harness: $HARNESS" >&2
  echo "  它在 fork 的 sts-engine-harness 分支上，先切过去。" >&2
  exit 2
fi

# 参考仓库有未提交改动时警告：预言机必须来自可追溯的源码，否则生成的数据没法复现。
if ! git -C "$REF" diff --quiet || ! git -C "$REF" diff --cached --quiet; then
  echo "⚠ 参考仓库有未提交的改动。生成的数据将无法从已提交状态复现——记得提交。" >&2
fi

echo "→ 构建 harness（参考项目全量编译，约 1 分钟）"
SRCS=$(cd "$REF" && find src -name '*.cpp' ! -name 'SaveFile.cpp' | tr '\n' ' ')
(cd "$REF" && clang++ -std=c++17 -O2 -w -Iinclude -I. \
  tools/sts-engine-harness/trace_dump.cpp $SRCS -o "$WORK/trace_dump") 2>&1 | tail -5

echo "→ 生成 trace"
(cd "$REF" && "$WORK/trace_dump") > "$WORK/traces.json"

echo "→ 拆分"
node --max-old-space-size=8192 "$REPO/tools/split-traces.mjs" "$WORK/traces.json" "$WORK/split"

# —— 不变量 ①/② ——
#
# 校验范围由**模式**决定，不能靠行数猜。
#
#   --check   ：前提是「还没动 harness」，所以**整个文件**都该逐字节复现（不变量 ①）。
#   --install ：前提是「本批故意改了 harness」，variant 0 之后的行本就该被重新生成，
#               只能要求 variant 0 那一段不动（不变量 ②）。
#
# ⚠ 早先这里用「行数是否相同」来推断 harness 有没有改过。那个启发式是错的：trace 条数是
# 种子数 × 楼层数 × variant 数，**与牌组大小无关**。在「每批替换 variant 1/2」的策略下
# 行数逐批恒定，于是它每次都走「整文件比」这一支，把合法的 variant 1/2 重生成判成失败，
# 还报成「variant 0 被扰动」——而 diff 实际落在 variant 1 的第一行。已用一次模拟第 5 批的
# 实验复现过：下一批会被直接卡死，且诊断指向错误的原因。
echo "→ 校验：已提交数据是否被扰动"
fail=0
for committed in "$TRACES"/*.jsonl; do
  name="$(basename "$committed")"
  fresh="$WORK/split/$name"
  if [[ ! -f "$fresh" ]]; then
    echo "  ✗ $name 这次没有生成——harness 的 encounters 列表被改小了？"
    fail=1
    continue
  fi
  n="$(wc -l < "$committed" | tr -d ' ')"
  m="$(wc -l < "$fresh" | tr -d ' ')"
  if [[ "$MODE" == "--check" ]]; then
    if [[ "$n" -ne "$m" ]]; then
      echo "  ✗ $name 行数变了（$n → $m）——harness 已被改动，--check 的前提不成立，请用 --install"
      fail=1
      continue
    fi
    cmpn="$n"
    label="全部 $cmpn 行"
  else
    # variant 0 的行数由新生成的文件自己报，不写死——variant 0 的种子数一改，
    # 写死的数字就会悄悄少校验。
    cmpn="$(node "$REPO/tools/variant0-rows.mjs" "$fresh")"
    label="variant 0 的 $cmpn 行（其后 $((n - cmpn)) 行 → $((m - cmpn)) 行，本批重新生成）"
    if [[ "$n" -lt "$cmpn" ]]; then
      echo "  ✗ $name 已提交只有 $n 行，少于新生成的 variant 0（$cmpn 行）——variant 0 被改大了？"
      fail=1
      continue
    fi
  fi
  head -n "$cmpn" "$committed" > "$WORK/a"
  head -n "$cmpn" "$fresh"     > "$WORK/b"
  if cmp -s "$WORK/a" "$WORK/b"; then
    echo "  ✓ $name $label —— 一致"
  else
    # `|| true` 是必需的：cmp 报不同就返回非 0，在 set -e + pipefail 下会让脚本当场退出，
    # 于是这条最关键的诊断信息永远打不出来。（这个 bug 是靠故意篡改数据、跑失败路径才发现的。）
    first_diff=$(cmp "$WORK/a" "$WORK/b" 2>&1 | head -1 || true)
    echo "  ✗ $name $label —— **被扰动**：$first_diff"
    fail=1
  fi
done

if [[ "$MODE" == "--check" ]]; then
  if [[ $fail -ne 0 ]]; then
    echo ""
    echo "✗ 预言机不可复现。改 harness 前先弄清为什么——这说明已提交的背书数据失效了。"
    exit 1
  fi
  echo ""
  echo "✓ 管道能逐字节复现已提交数据"
  exit 0
fi

if [[ "$MODE" != "--install" ]]; then
  echo "✗ 未知模式: $MODE（只支持 --check / --install）" >&2
  exit 2
fi

if [[ $fail -ne 0 ]]; then
  echo ""
  echo "✗ variant 0 被扰动了，拒绝安装。"
  echo "  几乎总是这个原因：新 variant 排到了 variant 0 之前，或 variant 0 的牌组/种子被改了。"
  exit 1
fi

# —— 不变量 ③ ——
echo "→ 校验：本批新卡是否真的被打出过"
mkdir -p "$WORK/shipped"
for committed in "$TRACES"/*.jsonl; do
  cp "$WORK/split/$(basename "$committed")" "$WORK/shipped/"
done
node --max-old-space-size=8192 "$REPO/tools/check-coverage.mjs" "$WORK/shipped" "$@"

echo "→ 安装到 test/golden/traces"
for committed in "$TRACES"/*.jsonl; do
  cp "$WORK/shipped/$(basename "$committed")" "$committed"
done
du -shc "$TRACES"/*.jsonl | tail -1

echo ""
echo "✓ 已安装。接下来："
echo "    1. 补 test/sts-combat-trace.test.ts 的 CARD / POWER 映射（漏了会抛错，不会静默）"
echo "    2. pnpm test"
echo "    3. 变异测试——见 WORKFLOW.md，「对拍全绿」不等于新代码被验证了"
echo "    4. 参考仓库的改动也要提交，否则这份数据不可复现"
