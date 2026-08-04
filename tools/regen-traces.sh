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
# 第二十五批：镀甲（带壳寄生虫）+ 困惑（史尼克）。同样是**新追加的 variant 25**
#   （variant 23/24 的 encounters 一个字没动，那六个文件逐字节不变），牌组沿用
#   `BATCH_1 + SPOT_WEAKNESS`。
#   ⚠ 文件名 `shell_parasite` **没有 ED**——它来自参考枚举 `MonsterEncounter::SHELL_PARASITE`，
#     而它建的**怪**才叫 `SHELLED_PARASITE`。本批把我们侧的编队 id 也改成了这个名字
#     （wiring 测试要求 `SUPPORTED_ENCOUNTERS` 与文件名一一对应）。
#   ⚠ `shelled_parasite_and_fungi` 顺带关掉第十六批**真菌兽出招阈值下方向**那条盲区
#     （此前只有 2 例，本批实测 137 例——这个编队的仗比 `exordium_wildlife` 长得多）。
#     ⚠ 同一批记着的「孢子云 addToTop ↔ addToBot」**没**关掉，仍是 0 例：亡语确实跑了
#     （易伤层数、isSourceMonster 各有新背书），只是那一刻队列里没有别的动作能插在中间。
# 第二十六批：友方增益（百夫长 + 秘法师）+ 三个「已登记怪的新组合」。同样是**新追加的
#   variant 26**（variant 23/24/25 的 encounters 一个字没动，那九个文件逐字节不变），
#   牌组沿用 `BATCH_1 + SPOT_WEAKNESS`。
#   ⚠ 两个文件名跟着参考枚举名走，与我们原先的近似表不同：`centurion_and_healer`
#     （不是 `centurion_mystic`）、`three_cultist`（**单数**，不是 `three_cultists`）。
#   ⚠ 本批给参考打了 `roll2` 补丁（带壳寄生虫的出招），它**确实改变**
#     `shell_parasite` 与 `shelled_parasite_and_fungi` 两个已冻结文件的内容，
#     所以那一次 `--install` 走的是 `ALLOW_CHANGED="shell_parasite shelled_parasite_and_fungi"`。
#     理由与三条判据见 TODOS「已修正（参考侧已打补丁）」。
# 第二十七批：**召唤**（地精首领）+ 两个第二幕精英编队。同样是**新追加的 variant 27**
#   （variant 23/24/25/26 的 encounters 一个字没动，那十三个文件逐字节不变），
#   牌组沿用 `BATCH_1 + SPOT_WEAKNESS`。
#   ⚠ `gremlin_leader` 是第一个**开局就留空位**的编队：参考建 1/2 号位的小鬼与 3 号位的
#     首领，`monsterCount = 4` 而 0 号位从没被构造（`MonsterGroup.cpp:248-259`）。
#     `Actions::SummonGremlins` 按 1, 2, 0 的顺序找空位往里填，用的是 **aiRng**（建怪时是
#     miscRng），并且**不重跑 preBattleAction**——召唤出来的狂暴小鬼因此没有狂怒。
#   ⚠ `slavers` 的顺序是**蓝奴隶主 / 监工 / 红奴隶主**（`MonsterGroup.cpp:366-370`），
#     监工在**中间**。它的抽打会往弃牌堆塞伤口（伤口打不出，只躺在牌堆快照里）。
# 第二十八批：突刺之书（第二幕最后一个精英）+ 青铜自动机（第二个召唤宿主）。同样是**新追加的
#   variant 28**（variant 23~27 的 encounters 一个字没动，那十五个文件逐字节不变），
#   牌组沿用 `BATCH_1 + SPOT_WEAKNESS`。
#   ⚠ 文件名是 `automaton` 而不是 `bronze_automaton`——它来自参考枚举
#     `MonsterEncounter::AUTOMATON`，而它建的**怪**才叫 `BRONZE_AUTOMATON`（同族的先例是
#     第二十五批的 `shell_parasite`）。本批把我们侧的编队 id 也改成了这个名字。
#   ⚠ `automaton` 的建怪是**第二种**「开局留空位」的写法（`MonsterGroup.cpp:173-177`）：
#     `monsterCount = 1; createMonster(BRONZE_AUTOMATON); ++monsterCount;`——自动机落在
#     **1 号位**，0 号位与 2 号位**都**是预留空位（`monsterCount = 3` / `monstersAlive = 1`）。
#     与地精首领那个（只留 0 号位、手动赋值 3 / 4）形状不同，照抄别整理。
#     填空位的 `Monster::spawnBronzeOrbs`（`MonsterSpecific.cpp:3443`）也**不是** 地精那条
#     `Actions::SummonGremlins`：同步调用、下标写死 0/2、怪种固定（不掷 aiRng）、
#     没有 `= Monster()` 重建、末尾多一句 `++monsterTurnIdx`。
#   ⚠ 青铜球带来 **STASIS**：它把玩家的一张牌从抽牌堆（空则弃牌堆）里扣住，
#     挑牌按稀有度 RARE > UNCOMMON > COMMON 加权、消耗 **一次 cardRandomRng**，
#     球死掉时把牌还进手牌。两头都在牌堆快照里逐帧可见。
# 第二十九批：**第二幕收官**（19 / 19）。冠军 + 收藏家两个 Boss，走**新追加的 variant 29**
#   （variant 23~28 的 encounters 一个字没动，那十七个文件逐字节不变），
#   牌组沿用 `BATCH_1 + SPOT_WEAKNESS`。
#   ⚠ 文件名是 `collector` 而不是 `the_collector`——它来自参考枚举
#     `MonsterEncounter::COLLECTOR`，而它建的**怪**才叫 `THE_COLLECTOR`（同族的先例是
#     第二十五批的 `shell_parasite`、第二十八批的 `automaton`）。本批把我们侧的编队 id
#     也改成了这个名字。
#   ⚠ `collector` 是**第三种**「开局留空位」的写法（MonsterGroup.cpp:198-201）：
#     `monsterCount = 2; createMonster(THE_COLLECTOR);`——0 号位与 1 号位都空、
#     收藏家在**最后一格**（2 号位），`monsterCount = 3` / `monstersAlive = 1`。
#     填空位的 `Actions::SpawnTorchHeads`（Actions.cpp:500-527）是**第三条召唤路径**，
#     与地精那条、青铜球那条**八处形状全不同**：按 `3 - monstersAlive` 决定召几只、
#     落位表 `{arr[1].isDying() ? 1 : 0, 0}`、`construct` 之后**又显式 initHp 一次**
#     （每只 2 次 monsterHpRng）、用 `setMove` 而不是 `rollMove`（召唤本身不掷 aiRng）、
#     末尾按**只数** `noOpRollMove`、没有 `++monsterTurnIdx`。
#   ⚠ `champ` 的二阶段是**血量阈值锁存**，而且**不在 `Monster::onHpLost` 里**——
#     那个 switch 压根没有 THE_CHAMP 这一格，锁存整条在 `getMoveForRoll`
#     （`miscInfo` bit 2；bit 0~1 兼作防御姿态的已用次数）。它的暴怒还带
#     `Monster::removeDebuffs()`（本项目第一次怪物侧清减益），嘲讽是第一只**同步**
#     给玩家上减益的怪。
# 第三十批：**第二幕的爬升度**（19 个编队 × asc19，一个档位）。走**新追加的 variant 30**
#   （variant 23~29 的 encounters 一个字没动，那 19 个 asc0 文件逐字节不变），
#   牌组沿用 `BATCH_1 + SPOT_WEAKNESS`、40 个种子（与第一幕 asc19 同规格）。
#   ⚠ 本批的 variant 的 `encounters` **允许**与 variant 24~29 重叠——`split-traces.mjs` 的
#     variant 指纹是「整副牌组 + 爬升度」，分组键又带 `@asc19` 后缀，所以它的行落进 19 个
#     **新**文件、不会与 asc0 那批混块。第二十四~二十九批之所以必须两两不相交，是因为它们的
#     牌组**与爬升度**全都相同（指纹撞号）；这里爬升度不同，撞不上。
#   ⚠ asc19 有两处**结构性后果**（0 例是「不可达」而不是「抄错了」）：青铜自动机的**眩晕**
#     出不来了（超射线的收尾 `asc19 ? BOOST : STUNNED`），冠军的两族阈值
#     （`getTriIdx(asc,9,19)` 与 `bossDiffIdx(4,19)`）在 19 下同解、分不开。
#   ⚠ 「阈值恰好是 N」与「三档里的中间那一档」仍是盲区，关门条件是**跨两幕的 asc7 + asc16**
#     那一批（见 TODOS），不在本批范围内。
# 第三十一批：**目标策略**这条轴（`@tgt1` = harness 打「下标最大的活怪」，与历来的
#   `firstAliveMonster` 正好相反）。走**新追加的第三个乘积** `emitProduct(tgtVariants,
#   tgtEncounters)`，里面只有 variant 31，牌组沿用 `BATCH_1 + SPOT_WEAKNESS`、40 个种子、
#   **爬升度 0**（两条轴不叠加，叠加是以后的事）。
#   ⚠⚠ **为什么必须是第三个乘积、而不是往 `variants` 里追加一个 variant**：第一幕那个乘积
#     跑在最前面，`traceIdx` 是按引用捕获的——往它里面加 variant 会平移第二幕乘积发出的
#     每一个下标，38 个第二幕文件全部作废。第二十二批当年能往 `variants` 里追加，只因为
#     那时第一幕**还是最后一个**乘积。**推论：从此往 `variants` / `act2Variants` 里追加
#     variant 都不再是免费的**，新轴一律另开乘积挂到最后。
#   ⚠ **只覆盖多怪编队**（第一幕 11 个 + 第二幕 12 个 = 23 个）。单怪编队下
#     `lastAliveMonster` 与 `firstAliveMonster` 用的是同一个谓词、同一个兜底，取到的是同一只
#     → trace 会与已提交的 asc0 那份逐字节相同，纯属白占体积。筛掉的 16 个见 TODOS。
#     ⚠ 「多怪」的判据是**「场上会不会同时有两只可选目标」**，不是「开局有几只」：
#     `large_slime` / `slime_boss`（分裂）、`automaton`（青铜球）、`collector`（火炬头）
#     开局都是一只，但它们正是这条轴要的局面，必须算进来。
#   ⚠ 这 23 个文件的 variant 指纹与已提交那些**只差 `targetPolicy` 这一维**（牌组与爬升度
#     完全相同），所以它的 `encounters` **允许**与 variant 21~30 重叠——分组键带 `@tgt1`
#     后缀，行落进 23 个**新**文件。同理，以后要是有人拿这副牌组再开一个
#     **asc0 + tgt0** 的 variant，那就会撞号。
# 第三十二批：**第三幕开张**。harness 追加了**第四个乘积**
#   `emitProduct(act3Variants, act3Encounters)`，排在目标策略那个之后。
#   ⚠⚠ **两步验证做了**：先只加空乘积（`act3Variants` 留空）跑一次 `--check`，
#     101 个已提交文件逐字节复现；之后才填 variant 32。
#   ⚠⚠ **第三幕做完之前不许再往它后面挂新乘积**：每一批第三幕都往 `act3Variants` 追加
#     一个 variant，而往「不是最后一个」的乘积里追加会平移其后所有 `traceIdx`。
#   本批装三个「形状怪」编队（走 variant 32，牌组沿用 `BATCH_1 + SPOT_WEAKNESS`、
#   40 个种子、**爬升度 0**、**目标策略 0**）。
#   ⚠ `three_shapes` / `four_shapes` 走 `MonsterGroup::createShapes`（6 项池
#     {斥力,斥力,爆破,爆破,尖刺,尖刺}、**不放回**，MonsterGroup.cpp:508-530），
#     `sphere_and_two_shapes` 走两次 `getAncientShape`（3 项表 {尖刺,斥力,爆破}、**有放回**，
#     :532-539）——两张表的项数 / 重复度 / 书写顺序全不同，照搬彼此必错。
#   ⚠ variant 32 的指纹（牌组 + 爬升度 + 目标策略）与 variant 24~29 **完全相同**，
#     所以它的 encounters 必须与那六个**互不相交**——第三幕的编队没有任何第二幕 variant
#     点名，这条自动成立。⚠ `jaw_worm_horde` 虽然也是第三幕的，但它自第一个 commit 起就在
#     第一幕的 `ENC_ALL` 里，**第三幕的 variant 绝不能点名它**。
# 第三十三批：第三幕三个**单怪**编队（走**新追加的 variant 33**，variant 32 的 encounters
#   一个字没动，那三个文件逐字节不变），牌组沿用 `BATCH_1 + SPOT_WEAKNESS`、40 个种子、
#   **爬升度 0**、**目标策略 0**。选它们是因为三只怪**全由已登记的原语拼成**：
#   ⚠ `orb_walker` 是 `hpDiscardRoll` 的**正主**（参考只在它那条注了
#     `// first call is discarded by game`，MonsterSpecific.cpp:32-35），一次建怪掷 **2 次**
#     monsterHpRng；它还是全参考项目 `GENERIC_STRENGTH_UP` 的**唯一宿主**
#     （回合末 +3 力量，Monster.cpp:103-105）。激光一招同时往**抽牌堆**与**弃牌堆**各塞
#     一张灼伤（两条不同的 Action，前者每张掷一次 cardRandomRng）。
#   ⚠ `maw` 是 `hpNoRoll` 的**第二个宿主**（第一个是第二十三批的球状守卫者），
#     **一次 monsterHpRng 都不掷**；它的吞噬是本项目第一条「段数由回合数算出来」的多段攻击
#     （`attackPlayerHelper(bc, 5, (getMonsterTurnNumber()+1)/2)`）。
#     ⚠ 文件名是 `maw` 而不是 `the_maw`——它来自参考枚举 `MonsterEncounter::MAW`，
#     而它建的**怪**才叫 `THE_MAW`（同族的先例：`shell_parasite` / `automaton` / `collector`）。
#     本批把我们侧的编队 id 也改成了这个名字。
#   ⚠ `spire_growth` 带来 **CONSTRICTED**（束缚）：玩家回合末 `addToBot(DamagePlayer(层数))`，
#     **不递减、不摘除**，所以它那一招一场仗最多出一次（出招规则的门里有
#     `!player.hasStatus<CONSTRICTED>()`）。
# 第三十六批：第三幕两个**精英**（走**新追加的 variant 36**，variant 35 的 encounters
#   一个字没动），牌组沿用 `BATCH_1 + SPOT_WEAKNESS`、40 个种子、**爬升度 0**、**目标策略 0**。
#   ⚠ `nemesis` 带来**怪物侧 INTANGIBLE**（四处协同：两条伤害入口各把伤害压成 1、
#     `calculateCardDamage` 末尾的下限、回合末无条件递减），而它三条 case 的尾部各有一句
#     `if (!hasStatus<INTANGIBLE>())` 补层——**三条的入队 / 同步形状两两不同**。
#   ⚠ `reptomancer` 带来**召唤的第四族**与**预留空位的第四种写法**（0 与 3 号位空、
#     两把匕首在 1 / 4、法师在中间的 2 号位、`monsterCount = 5`），外加全参考项目唯一的
#     `MonsterGroup::skipTurn` 写入点。它还是 `hpDiscardRoll` 四个宿主里最后一个被登记的。
#   ⚠⚠ **本批同时给参考打了萎缩的白名单补丁**（`isMoveAttack` 加一行
#     `WRITHING_MASS_WITHER`，理由见 TODOS「已修正」），它改变了**已冻结**的
#     `writhing_mass.jsonl`，所以那一次 `--install` 走的是 `ALLOW_CHANGED="writhing_mass"`。
# 第三十七批：第三幕 Boss **觉醒者**（走**新追加的 variant 37**，variant 36 的 encounters
#   一个字没动，那两个文件逐字节不变）。40 种子、**爬升度 0**、**目标策略 0**。
#   ⚠⚠ **牌组第一次不是 `BATCH_1 + SPOT_WEAKNESS`，而且理由是量出来的**：那副 22 张牌组下
#     战斗平均只有 **3.6 回合**、120 条 trace **一次都没打死过觉醒者的一阶段**，于是
#     `AWAKENED_ONE_REBIRTH` / `_DARK_ECHO` / `_SLUDGE` / `_TACKLE` 四条全是「出现 0 /
#     执行 0」——本批要装的那条假死分支**结构性没有预言机**。改成 45 张的**全升级**聚焦牌组
#     （BATCH_1 + 4×觅敌之弱 + 2×极限突破 + 4×幽灵护甲 + 4×铜头 + 2×收割 + 2×剑刃回旋 +
#     2×直觉 + 2×灵巧 + 2×钢铁闪光）之后：平均 **8.7 回合**、**45 / 120** 条走到假死、
#     六条招式全部出现且执行。这是 WORKFLOW 里「聚焦小牌组」那条逃生口，只是这次为的是
#     **怪物**覆盖。⚠ 牌组形状由策略决定：`pickAction` 严格从左往右花能量，所以**3 费牌
#     几乎打不出来**（恶魔形态 / 壁垒实测毫无作用），加的牌一律 0~2 费；`upgradeAll` 让
#     极限突破**不再消耗**，那是整套力量引擎的发动机。
#   ⚠ 牌组变了 ⇒ variant 指纹变了，所以它与 variant 24~36 的 encounters 撞不上（双保险：
#     `AWAKENED_ONE` 本来也没有别的 variant 点名）。
#   ⚠ `awakened_one` 是**三只怪**（邪教徒 ×2 + 觉醒者，觉醒者在 **2 号位**），
#     参考的 `MonsterGroup.cpp:179-184` 就是这么建的。
#   ⚠ 它带来 **`Monster::die` 的第一个分支**（假死 / 两阶段 Boss）——那是那条链上唯一
#     **排在判胜 `return` 之前**的一格，与暗影客的重生（在 `return` 之后）正好相反；
#     另有 **CURIOSITY**（参考里读点被整段注释掉的纯标记）与 **REGEN**（怪物侧、一层不掉），
#     以及第一张「抽到时有效果」的状态牌**虚无**（抽到 -1 能量）。
# 第三十八批：第三幕 Boss **时间吞噬者**（走**新追加的 variant 38**，variant 37 的 encounters
#   一个字没动，`awakened_one.jsonl` 逐字节不变）。40 种子、**爬升度 0**、**目标策略 0**。
#   ⚠⚠ 它带来 **TIME_WARP**——本项目第一条**改回合结构**的 Power。结算点在
#     `BattleContext::onAfterUseCard`（:1974-1985）那条共享出牌路径上、且在
#     `item.triggerOnUse` 那道门里面，读的是写死的 `monsters.arr[0]`：计数到 **11** 的下一张
#     （即第 12 张）归零 + 此怪 `buff<STRENGTH>(2)` + **`callEndTurnEarlySequence()`**。
#     最后那一句在**出牌中途强制结束玩家回合**：它排空出牌队列，把
#     `autoplay && !purgeOnUse` 的项转成 `Actions::TimeEaterPlayCardQueueItem`
#     （按 `triggerOnUse = false` 走一遍 `onAfterUseCard` = **牌白翻、直接进弃牌堆**），
#     其余（二连击的复制项）**直接丢弃**，然后把 endTurn 项推到队**首**。
#   ⚠ 另有 **DRAW_REDUCTION**（玩家侧：数值住在 `cardDrawPerTurn`、Power 只是 bool 标记，
#     回合开始 skipFirst 归还，且归还排在入队抽牌**之后**）。
#   ⚠⚠ **牌组第二次为「让新代码被走到」而设计**（第一次是第三十七批），而且是量出来的：
#     `BATCH_1 + SPOT_WEAKNESS`（22 张）下时间吞噬者 **120 / 120 条一次都没掉到半血**，
#     `TIME_EATER_HASTE` 出现 0 / 执行 0 —— `--install` 会直接拒绝。最终用的是 **59 张
#     全升级**牌组：第三十七批那 45 张 + 4 张飞刀式 0 费循环牌（钢铁闪光 / 灵巧各补到 6 张，
#     TIME_WARP 数的是**出牌张数**，所以 0 费轮转牌才是那个旋钮）+ **浩劫 ×4 与二连击 ×2**。
#     ⚠ 后两者是**全项目仅有的两种「`onAfterUseCard` 跑的时候出牌队列还非空」的产出者**
#     （浩劫塞 `autoplay` 项、二连击塞 `purgeOnUse && autoplay` 项），没有它们
#     `callEndTurnEarlySequence` 的排空循环整段不可达。实测四副牌组的对比表见 harness 注释。
#   ⚠ 牌组变了 ⇒ variant 指纹变了，与 variant 24~37 的 encounters 撞不上（双保险：
#     `TIME_EATER` 本来也没有别的 variant 点名）。
#   ⚠ `time_eater` 是**单怪**编队（`MonsterGroup.cpp:441-443` 一句 createMonster），
#     与觉醒者那种「邪教徒 ×2 + Boss」不同——策略从第一张牌起就在打 Boss 本人。
# 第三十九批：第三幕 Boss **迪卡与多努**，第三幕收官（16 / 16）。走**新追加的 variant 39**
#   （variant 38 的 encounters 一个字没动，`time_eater.jsonl` 逐字节不变）。
#   40 种子、**爬升度 0**、**目标策略 0**。
#   ⚠⚠ 文件名是 `donu_and_deca`（来自参考枚举 `MonsterEncounter::DONU_AND_DECA`），
#     而**建怪顺序与名字相反**：`createMonster(DECA); createMonster(DONU);`
#     （MonsterGroup.cpp:235-238）——迪卡在 0 号位、多努在 1 号位。
#     本批把我们侧的编队 id 从 `donu_deca` 改成了这个名字（同族先例：`shell_parasite` /
#     `automaton` / `collector` / `maw`）。
#   ⚠⚠ 它带来的不是新机制，而是第二十六批那三条「写死下标」原语的**反例**：百夫长的防守与
#     秘法师的治疗 / 鼓舞全都带 `monstersAlive > 1` 的门，而迪卡的守护方阵
#     （MonsterSpecific.cpp:1689-1700）与多努的能量之环（:1677-1681）**一道门都没有**
#     ——参考还在多努那句行尾自注 `// shouldn't matter if deca is dead`。
#     `buff_ally` 因此加了一位 `noAliveGate`，而且**这一位真的走到了 false 侧**
#     （策略恒打 0 号位 → 迪卡先死 56 / 120，多努照样给尸体 +3 力量）。
#   ⚠ 四条 case 的收尾**全是同步 `setMove`**：整场仗除开局那两次 rollMove 之外
#     **一次 aiRng 都不掷**（`rng.ai` 恒为 2），全参考唯一一个「全员静态循环」的编队。
#     于是四条招式的覆盖**任何牌组都满足**（第二个怪物回合就全走过了）。
#   ⚠⚠ **牌组沿用第三十八批那 59 张全升级的（逐字节相同），而这是量出来的**：
#     22 张标准牌组下 120 / 120 条**一次都没打死过迪卡**，那条「无门的友军 buff」
#     结构性没有预言机。七副候选的实测对比表见 harness 注释与 TODOS。
#     ⚠ 两者指纹（牌组内容 + 升级位 + 爬升度 + 目标策略）**完全相同**，所以 encounters
#     必须互不相交：variant 38 只点名 `TIME_EATER`、variant 39 只点名 `DONU_AND_DECA`。
#     这与第二十四~二十九批共用 `BATCH_1 + SPOT_WEAKNESS` 是同一条规矩。
ENC_V0_ACT2="spheric_guardian chosen snake_plant three_byrds two_thieves chosen_and_byrds shell_parasite shelled_parasite_and_fungi snecko centurion_and_healer three_cultist cultist_and_chosen sentry_and_sphere gremlin_leader slavers book_of_stabbing automaton champ collector"
ENC_V0_ACT3="three_shapes four_shapes sphere_and_two_shapes orb_walker spire_growth maw three_darklings transient writhing_mass giant_head nemesis reptomancer awakened_one time_eater donu_and_deca"
ENC_V0_ACT2_ASC19="spheric_guardian@asc19 chosen@asc19 snake_plant@asc19 three_byrds@asc19 two_thieves@asc19 chosen_and_byrds@asc19 shell_parasite@asc19 shelled_parasite_and_fungi@asc19 snecko@asc19 centurion_and_healer@asc19 three_cultist@asc19 cultist_and_chosen@asc19 sentry_and_sphere@asc19 gremlin_leader@asc19 slavers@asc19 book_of_stabbing@asc19 automaton@asc19 champ@asc19 collector@asc19"
ENC_V0_ASC0="small_slimes lots_of_slimes large_slime blue_slaver red_slaver looter exordium_thugs exordium_wildlife gremlin_gang gremlin_nob lagavulin three_sentries the_guardian slime_boss hexaghost $ENC_V0_ACT2"
ENC_V0_TGT1="jaw_worm_horde@tgt1 two_louse@tgt1 three_louse@tgt1 small_slimes@tgt1 lots_of_slimes@tgt1 large_slime@tgt1 gremlin_gang@tgt1 exordium_thugs@tgt1 exordium_wildlife@tgt1 three_sentries@tgt1 slime_boss@tgt1 three_byrds@tgt1 two_thieves@tgt1 chosen_and_byrds@tgt1 sentry_and_sphere@tgt1 cultist_and_chosen@tgt1 three_cultist@tgt1 shelled_parasite_and_fungi@tgt1 centurion_and_healer@tgt1 gremlin_leader@tgt1 slavers@tgt1 automaton@tgt1 collector@tgt1"
ENC_V0_ASC19="cultist@asc19 jaw_worm@asc19 jaw_worm_horde@asc19 two_louse@asc19 three_louse@asc19 small_slimes@asc19 lots_of_slimes@asc19 large_slime@asc19 blue_slaver@asc19 red_slaver@asc19 looter@asc19 exordium_thugs@asc19 exordium_wildlife@asc19 gremlin_gang@asc19 gremlin_nob@asc19 lagavulin@asc19 three_sentries@asc19 the_guardian@asc19 slime_boss@asc19 hexaghost@asc19 $ENC_V0_ACT2_ASC19"
# ⚠ 必须拼成**单行**：policy_of 用 `case " $ENC_V0 " in *" $1 "*` 做匹配，中间夹一个换行会让
#   两段接缝处的名字（hexaghost / cultist@asc19 / collector@asc19 / jaw_worm_horde@tgt1）
#   匹配不上，静默失去校验。
# ⚠ `jaw_worm_horde@tgt1` / `two_louse@tgt1` / `three_louse@tgt1` 的**基名**在 `ENC_ALL` 里，
#   但 `policy_of` 是**全名精确匹配**（带后缀的名字不在 `ENC_ALL` 里），所以它们照旧走
#   variant0 策略 = 整份冻结。这正是我们要的：这些文件里只有 variant 31 一个 variant。
# 第四十批：**遗物 / 药水**这条战线的第一批（第五个乘积）。文件名后缀是 `@relicN`——
# harness 只在 `DeckVariant.relicSet` 非 0 时输出那个字段，所以既有 116 个文件的名字与
# 内容一个字节都不动（管线改造那一步单独跑过一次 `--check` 证明了这一点）。
#
#   @relic1 = 贤者之石 + 地精之角 + 手钻，八个编队 —— 贤者之石在参考里有**八个读点**
#             （initRelics 一个 + 七处召唤/分裂/复活），这八个编队是「一个读点一个宿主」。
#   @relic2 = 暗石护符 + 手钻，蠕动血块
#   @relic3 = **@relic2 再加一颗御守**（`data = 2`），蠕动血块
#
# ⚠⚠ @relic2 与 @relic3 的牌组、种子、楼层、爬升度、目标策略**全同**，药水也**钉死**成同一
#   张，所以两份文件的输入差别**只有御守这一颗**。于是「御守那道门」的背书是一次直接的
#   逐行 diff（实测 67 / 120 条不同，全部是 maxHp 80 → 86），不需要变异测试来推。
#   ⚠ 药水必须钉死：不钉的话两个 variant 的 traceIdx 不同 → 轮换发给它们的药水就不同，
#     这份 A/B 立刻失去意义。
# ⚠ 这也是「牌组相同 → encounters 必须不相交」那条规矩的第二个例外（第一个是爬升度轴）：
#   variant 指纹里第四十批加了 `relicSet` 这一维，所以两个 variant 可以共用牌组**并且**
#   共用编队——它们的行落进 `@relic2` / `@relic3` 两份不同的文件，撞不上。
# 第四十一批：遗物战线第二批（`@relic4`，走**新追加的 variant**，排在 variant 43 之后；
#   variant 40~42 的 encounters 一个字没动，那 10 个文件逐字节不变）。
#
#   @relic4 = 硫磺 + 苦无 + 装饰扇 + 手里剑 + 开信刀，四个编队
#             （gremlin_leader / automaton / collector / reptomancer）
#
# ⚠⚠ **编队选的是「有预留空位」那四个，而且这是硫磺唯一的可观察面**：硫磺与第四十批的
#   贤者之石是**同一个 switch 里两种写法**——硫磺的循环写 `if (m.isTargetable())`，
#   贤者之石那格是裸的 `i < monsterCount`。两者只在「预留但从没构造过的格子」上分岔，
#   而全参考项目只有这四个编队有这样的格子。两条并排量正好互为背书。
# ⚠ 硫磺还有**第二个读点**：`Player::applyStartOfTurnRelics`（Player.cpp:497-505）每个
#   玩家回合重复一遍同样的函数体。`initRelics` 只覆盖第 1 回合。
# ⚠⚠ **牌组不是 `BATCH_1 + SPOT_WEAKNESS`，而且是量出来的**（第四次「先量再定」）：
#   开信刀要**一回合内打三张技能牌**，那副 22 张牌组下 480 条 trace 只触发 **59** 次
#   （56 条走到过）；加 4×灵巧 + 4×直觉 + 4×优雅（12 张 0 费、都不消耗）之后是 **1966** 次
#   （479 条走到过），代价是攻击那道门从 969 掉到 722。对比表见 harness 注释与 TODOS。
# ⚠ 牌组变了 ⇒ variant 指纹变了；`relicSet` 又是 4，撞号规则双重满足。
# 第四十二批：遗物战线第三批（`@relic5` / `@relic6`，走**新追加的两个 variant**，排在
#   variant 4 之后；variant 40~43（relicSet 1~4）的 encounters 一个字没动，那 14 个文件
#   逐字节不变）。本批**不加新遗物之外的任何内容**，两个 variant 各兑现一条已记的盲区。
#
#   @relic5 = 手钻 + 青铜鳞片，**药水钉死成格挡药水**，三个编队
#             （spheric_guardian / sentry_and_sphere / gremlin_leader）
#   @relic6 = 墨水瓶 + 橙色药丸 + 苦无 + 装饰扇 + 手里剑，三个编队
#             （slime_boss / champ / lagavulin）
#
# ⚠⚠ **@relic5 的编队是量出来的，而且那道门是两道门**：荆棘（青铜鳞片）是「挨打时反伤」，
#   跑在**怪物回合**，而 `MonsterGroup::applyPreTurnLogic` 在怪物回合**开头**把每只没有壁垒
#   的怪的格挡清成 0（Monster.cpp:19-21）。所以「荆棘打在有格挡的怪身上」本身就要壁垒、
#   或者同一个怪物回合里有更早行动的同伴给它加格挡；在那之后，3 点伤害还要**恰好**把格挡
#   打到 0（`hadBlock && block == 0`）。十个候选编队各 120 条的实测（药水钉死，
#   于是 `Monster::damage` 的唯一调用者就是荆棘）：
#     spheric_guardian 荆棘命中 535 / 有格挡 426 / **破盾 27（25 条）**
#     gremlin_leader           1373 /        94 / **破盾 27（23 条）**
#     sentry_and_sphere         973 /       797 / **破盾 21（21 条）**
#     donu_and_deca            1005 /       477 / 破盾 **0**（守护方阵给 16 点，3 点一次凑不齐）
#     centurion_and_healer / automaton：有格挡 36 / 30，破盾 0
#     champ / jaw_worm_horde / lagavulin / writhing_mass：连「有格挡」都是 0
#   **只有三个编队同时过两道门**，就是上面那三个。
# ⚠⚠ **药水必须钉死**：轮换里的火焰 / 爆炸药水**也**走 `Monster::damage`，而策略在第 1 回合
#   就把三瓶喝光——沉睡的拉加维林开局自带 8 点格挡（MonsterSpecific.cpp:288-291），
#   那一下就能点亮同一道门，与荆棘毫无关系。钉一瓶碰不到怪的药水，
#   「这三份文件里每一次 `Monster::damage` 破盾都是荆棘」才是按构造成立的。
#   ⚠ 顺带一个白拿的好处：遗物与药水都钉死之后这个 variant **不读 traceIdx**，
#   所以它的 trace 与它排在乘积里的哪个位置无关，测量数字可以逐例照搬。
# ⚠⚠ **@relic6 的牌组也是量出来的（第五次「先量再定」）**：42 张 =
#   `BATCH_1 + SPOT_WEAKNESS` + 4×灵巧 + 4×直觉 + 4×优雅 + **4×暴怒 + 4×战斗恍惚**。
#   后八张各有明确用途：暴怒是全项目**唯一 0 费的能力牌**，没有它橙色药丸的 `.all()`
#   几乎凑不齐（能力侧触发 176 → 1038）；战斗恍惚是**唯一的 NO_DRAW 产出者**，
#   而 NO_DRAW 正是「墨水瓶与橙色药丸谁先入队」唯一的可观察面（同一张牌上两颗同时触发
#   且带着 NO_DRAW：34 张牌组 0 次，42 张牌组 81 次）。
# ⚠ 编队选 `slime_boss` 是因为**黏液是策略唯一打得出去的状态牌**
#   （`CardInstance.cpp:329` 那个 `id != SLIMED` 的例外），而它是语料里唯一大量产出黏液的
#   编队——墨水瓶的**第四个** handler（`onUseStatusOrCurseCard` :1958）只有这里能被走到。
#   ⚠ 牌组在这里是**反作用**的：0 费牌越多，史莱姆王死得越快、打出的黏液越少
#   （34 张牌组 360 次 → 42 张牌组 96 次）。42 张仍然够（42 条 trace 打出过黏液）。
ENC_V0_RELIC="large_slime@relic1 slime_boss@relic1 spheric_guardian@relic1 gremlin_leader@relic1 automaton@relic1 collector@relic1 three_darklings@relic1 reptomancer@relic1 writhing_mass@relic2 writhing_mass@relic3 gremlin_leader@relic4 automaton@relic4 collector@relic4 reptomancer@relic4 spheric_guardian@relic5 sentry_and_sphere@relic5 gremlin_leader@relic5 slime_boss@relic6 champ@relic6 lagavulin@relic6"
ENC_V0="$ENC_V0_ASC0 $ENC_V0_ASC19 $ENC_V0_TGT1 $ENC_V0_ACT3 $ENC_V0_RELIC"

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
