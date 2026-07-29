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
#   ③ 新内容真的出现过 —— 卡牌看打出次数、怪物招式看掷出/执行次数，见 tools/check-coverage.mjs。
#
# 用法:
#   tools/regen-traces.sh --check            # 只做 ①：确认能复现已提交数据，不写任何文件
#   tools/regen-traces.sh --install ARGS...  # 全流程：生成 → 校验 → 安装
#                                            #   ARGS 原样转给 check-coverage.mjs：
#                                            #   本批新卡的参考枚举名，以及 `--moves` 之后
#                                            #   本批新怪物招式的参考枚举名
# 环境变量:
#   STS_REF         参考项目路径（默认 ~/Workspace/sts_lightspeed）
#   ALLOW_CHANGED   空格分隔的编队名，允许它们**已冻结**的数据这一批被替换。
#                   只有一种正当理由：本批给参考项目打了补丁，它改变了这些编队的行为。
#                   写进报告与 TODOS，不要拿它绕过意外的扰动。
#
set -euo pipefail

REF="${STS_REF:-$HOME/Workspace/sts_lightspeed}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACES="$REPO/test/golden/traces"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MODE="${1:---check}"
shift || true

# —— 编队保留策略 ——
#
# harness **一直**就在跑第一幕全部 20 个编队（`encounters` 列表从第一个 commit 起没变过），
# 只是我们过去只安装其中五个。所以铺量怪物/编队**不需要改 harness**：改了反而危险，
# 往那个列表里增删任何一项都会平移其后所有 trace 的 `traceIdx`，把遗物/药水轮换整体错位。
#
#   all       整份保留。variant 0 冻结、其后的行每批随当前全牌组重新生成。
#             卡牌铺量用的这五个编队。
#   variant0  只保留开头 variant 0 那一段（当前 375 行 = 125 种子 × 3 层）。
#             **装完即永久冻结**，此后每批都必须逐字节复现整份文件。
#
# 为什么怪物/编队走 variant0：
#   * 怪物行为几乎与牌组无关，真正拉开差异的是**种子**（血量、意图 roll、编队组合），
#     而 variant 0 恰恰是种子最多的那个——125 个，其余 variant 只有 40 个。
#   * variant 0 的牌组最弱（21 张），战斗更长 = 怪物回合更多，正是我们要的。
#   * 体积是实测的：15 个第一幕编队整份保留合计约 500MB，只留 variant 0 是 100MB。
#     （单个文件最大 slime_boss 17.4MB，离 GitHub 的 100MB 硬上限还很远。）
#   * 附带好处：这些文件从此不再重写，git 里只有一份 blob，也不会逐批产生大 diff。
ENC_ALL="cultist jaw_worm jaw_worm_horde three_louse two_louse"
# 每批新增的编队加到这里（用小写文件名）。第十三批：史莱姆两个编队；第十四批：大史莱姆；
# 第十五批：奴隶主两个 + 抢劫者 + 恶棍二人组（后者是抢劫者逃跑唯一有背书的地方）；
# 第十六批：荒野二人组（真菌兽在第一幕**只**出现在这里）；
# 第十七批：地精帮（五只地精在第一幕**只**出现在这里，护盾地精与巫师在整个第一幕独此一家）；
# 第十八批：第一幕三个精英（地精头目 / 拉加维林 / 三哨卫），三只怪各自只出现在自己的编队里；
# 第十九批：第一幕两个 Boss（守卫者 / 史莱姆王），同样各自是自己那只怪唯一的来源；
# 第二十批：六火幽魂——第一幕最后一个编队，装完这 20 个就把 harness 的 encounters 列表
#   跑满了，再往下铺量必须给 harness **追加一遍第二幕循环**（不能动原列表，见 WORKFLOW）。
# 第二十一批：爬升度这条轴。文件名是 `<编队>@asc19`——harness 只在爬升度非 0 时输出
#   `"ascension"` 字段，`split-traces.mjs` 把它拼进分组键，于是 asc0 的 20 个文件名一个字不改
#   （管线改造那一步单独跑过一次 `--check` 证明这是空操作）。
#   这些文件同样走 `variant0` 策略：一份文件里只有那一个 asc19 variant，
#   `variant0-rows.mjs` 因此返回整份长度 = 整份冻结，正是我们要的。
#   ⚠ 只有 14 个**普通**编队。精英与 Boss 的血量阈值是 asc>=8 / >=9 而不是 7，
#     招式还另有 asc3/4/18/19 分档，留给第二十二批——那一批要**另开一个 variant**，
#     不能往本批这个 variant 的 encounters 里加（会平移其后所有 traceIdx）。
# 第二十二批：三精英 + 三 Boss × asc19（harness 的 variant 22，独立追加在 variant 21 之后，
#   variant 21 的 encounters 一个字没动，所以那 14 个文件逐字节不变）。装完这 6 个，
#   第一幕 20 个编队在 asc0 与 asc19 两个档位上都满了。
# 第二十三批：**第二幕开张**。harness 的编队循环从此有两个：原来那个（第一幕 20 个，
#   一个字不许动）跑完之后，再跑一遍 `act2Encounters × act2Variants`。traceIdx 接着往下走，
#   所以第一幕那 40 个文件逐字节不变（加空循环时单独跑过一次 `--check` 证明了这一点）。
#   本批只装三个**单怪、无召唤、无塞牌**的编队，把第二幕的管线跑通而不叠机制。
#   ⚠ 全是 asc0：第二 / 三幕 40 只怪一只都没校准爬升度，`ascCalibrated` 闸门照旧抛错。
# 第二十四批：飞行（拜鸟）+ 劫匪。三个编队走的是**新追加的 variant 24**（variant 23 的
#   encounters 一个字没动，所以它那三个文件逐字节不变）。
#   ⚠ variant 24 的牌组是 `BATCH_1 + SPOT_WEAKNESS`——多的那一张是故意的：`isMonsterAttacking`
#     的唯一读者就是觅敌之弱，而 `ENC_V0` 只留 variant 0 那副 21 张牌组，里面没有它，
#     于是第十三批之后登记的怪的「攻击分类」一直没有预言机。从本批起，第二幕的新怪自带背书。
ENC_V0_ACT2="spheric_guardian chosen snake_plant three_byrds two_thieves chosen_and_byrds"
ENC_V0_ASC0="small_slimes lots_of_slimes large_slime blue_slaver red_slaver looter exordium_thugs exordium_wildlife gremlin_gang gremlin_nob lagavulin three_sentries the_guardian slime_boss hexaghost $ENC_V0_ACT2"
ENC_V0_ASC19="cultist@asc19 jaw_worm@asc19 jaw_worm_horde@asc19 two_louse@asc19 three_louse@asc19 small_slimes@asc19 lots_of_slimes@asc19 large_slime@asc19 blue_slaver@asc19 red_slaver@asc19 looter@asc19 exordium_thugs@asc19 exordium_wildlife@asc19 gremlin_gang@asc19 gremlin_nob@asc19 lagavulin@asc19 three_sentries@asc19 the_guardian@asc19 slime_boss@asc19 hexaghost@asc19"
# ⚠ 必须拼成**单行**：policy_of 用 `case " $ENC_V0 " in *" $1 "*` 做匹配，中间夹一个换行会让
#   两段接缝处的名字（hexaghost / cultist@asc19）匹配不上，静默失去校验。
ENC_V0="$ENC_V0_ASC0 $ENC_V0_ASC19"

policy_of() {
  case " $ENC_ALL " in *" $1 "*) echo all; return;; esac
  case " $ENC_V0 " in *" $1 "*) echo variant0; return;; esac
  echo ""
}

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

# 已提交但不在策略表里的文件 = 谁改小了策略表，静默少校验。先拦下来。
for committed in "$TRACES"/*.jsonl; do
  enc="$(basename "$committed" .jsonl)"
  if [[ -z "$(policy_of "$enc")" ]]; then
    echo "  ✗ $enc.jsonl 已提交，却不在 ENC_ALL / ENC_V0 里——策略表被改小了，它会静默失去校验"
    fail=1
  fi
done

for enc in $ENC_ALL $ENC_V0; do
  name="$enc.jsonl"
  policy="$(policy_of "$enc")"
  committed="$TRACES/$name"
  fresh="$WORK/split/$name"
  if [[ ! -f "$fresh" ]]; then
    echo "  ✗ $name 这次没有生成——harness 的 encounters 列表里没有它？"
    fail=1
    continue
  fi
  m="$(wc -l < "$fresh" | tr -d ' ')"
  # variant 0 的行数由新生成的文件自己报，不写死——variant 0 的种子数一改，
  # 写死的数字就会悄悄少校验。
  v0="$(node "$REPO/tools/variant0-rows.mjs" "$fresh")"
  if [[ "$policy" == "all" ]]; then
    keep="$m"
  else
    keep="$v0"
  fi
  echo "$keep" > "$WORK/keep-$enc"

  if [[ ! -f "$committed" ]]; then
    if [[ "$MODE" == "--check" ]]; then
      echo "  ✗ $name 尚未提交——--check 只校验已提交数据，新编队请用 --install"
      fail=1
    else
      echo "  + $name 新编队，本批首次安装（$keep 行，策略 $policy）"
    fi
    continue
  fi

  n="$(wc -l < "$committed" | tr -d ' ')"
  # 比较范围：
  #   policy=variant0  整份都是冻结的 variant 0 → 永远比整份，两种模式一样。
  #   policy=all + --check   前提是「还没动 harness」→ 整份都该复现。
  #   policy=all + --install 前提是「本批故意改了 harness」→ variant 0 之后的行本就该被
  #                          重新生成，只能要求 variant 0 那一段不动。
  #
  # ⚠ 早先这里用「行数是否相同」来推断 harness 有没有改过。那个启发式是错的：trace 条数是
  # 种子数 × 楼层数 × variant 数，**与牌组大小无关**。在「每批替换 variant 1/2」的策略下
  # 行数逐批恒定，于是它每次都走「整文件比」这一支，把合法的 variant 1/2 重生成判成失败，
  # 还报成「variant 0 被扰动」——而 diff 实际落在 variant 1 的第一行。已用一次模拟第 5 批的
  # 实验复现过：下一批会被直接卡死，且诊断指向错误的原因。
  if [[ "$policy" == "variant0" ]]; then
    if [[ "$n" -ne "$v0" ]]; then
      echo "  ✗ $name 已提交 $n 行，但 variant 0 是 $v0 行——它当初不是按 variant0 策略装的"
      fail=1
      continue
    fi
    cmpn="$n"
    label="全部 $cmpn 行（冻结）"
  elif [[ "$MODE" == "--check" ]]; then
    if [[ "$n" -ne "$m" ]]; then
      echo "  ✗ $name 行数变了（$n → $m）——harness 已被改动，--check 的前提不成立，请用 --install"
      fail=1
      continue
    fi
    cmpn="$n"
    label="全部 $cmpn 行"
  else
    cmpn="$v0"
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
    case " ${ALLOW_CHANGED:-} " in
      *" $enc "*)
        echo "  ! $name $label —— 已变，但 ALLOW_CHANGED 显式放行：$first_diff"
        ;;
      *)
        echo "  ✗ $name $label —— **被扰动**：$first_diff"
        fail=1
        ;;
    esac
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
  echo "✗ 已冻结的数据被扰动了，拒绝安装。"
  echo "  policy=all 的编队：几乎总是新 variant 排到了 variant 0 之前，或 variant 0 的牌组/种子被改了。"
  echo "  policy=variant0 的编队：整份都是冻结的。本批给参考打了补丁而它确实该变的话，"
  echo "  用 ALLOW_CHANGED=\"编队名...\" 显式放行，并把理由写进报告与 TODOS。"
  exit 1
fi

# —— 不变量 ③ ——
# 先按各自的保留策略裁好，再统计——覆盖表必须反映**真正会被提交的那些行**，
# 拿完整的生成结果去统计会把 variant0 编队里根本不会安装的行也算进去，覆盖数虚高。
echo "→ 校验：本批新内容是否真的出现过"
mkdir -p "$WORK/shipped"
for enc in $ENC_ALL $ENC_V0; do
  head -n "$(cat "$WORK/keep-$enc")" "$WORK/split/$enc.jsonl" > "$WORK/shipped/$enc.jsonl"
done
node --max-old-space-size=8192 "$REPO/tools/check-coverage.mjs" "$WORK/shipped" "$@"

echo "→ 安装到 test/golden/traces"
for enc in $ENC_ALL $ENC_V0; do
  cp "$WORK/shipped/$enc.jsonl" "$TRACES/$enc.jsonl"
done
du -shc "$TRACES"/*.jsonl | tail -1

echo ""
echo "✓ 已安装。接下来："
echo "    1. 补 test/sts-combat-trace.test.ts 的 CARD / POWER / ENCOUNTER / MONSTER / MOVE 映射"
echo "    2. pnpm test"
echo "    3. 变异测试——见 WORKFLOW.md，「对拍全绿」不等于新代码被验证了"
echo "    4. 参考仓库的改动也要提交，否则这份数据不可复现"
