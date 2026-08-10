# 战斗系统待办

目标：让引擎里**只有一套**实现——`src/engine/sts-combat.ts` 那套与原版逐位一致的游戏级实现。

本文件讲**方向**（还差什么、为什么这么定）。要动手做一轮铺量，看
[WORKFLOW.md](WORKFLOW.md)——开发 → 生成预言机 → 验证 → 修复的完整流程与工具。

## 已决定的方向（2026-07-26）

**近似实现全部删除，只留新实现；整套新实现完成前不发新的 npm 版本。**

「近似实现」指有游戏级对应物的那些。已删除：

| 删掉的                            | 行数 | 接位的                                  |
| --------------------------------- | ---- | --------------------------------------- |
| `combat/combat.ts`                | 3885 | `sts-combat.ts`                         |
| `powers/powers.ts`                | 109  | sts-combat 内联（float32 逐步截断那套） |
| `relics.ts` 的 79 个战斗内钩子    | ~340 | sts-combat 的遗物登记表（现 13 个）     |
| 断言近似战斗数值的 115 个测试文件 | ~13k | trace 逐帧对拍 + `data-tables.test.ts`  |

还没有游戏级对应物的部分**留着**：事件、商店、奖励（卡/金币/药水/遗物掉落）、篝火、
玩具 PRNG `rng.ts`。它们不是「两套里的一套」，而是唯一的一套——删了没有东西接位。
等各自的游戏级实现（`cardRng` / `relicRng` / `eventRng` / `merchantRng` / `treasureRng`）
写出来时，按同样方式删掉。

代价是明确的：引擎现在只能打已迁移的战斗，其余**直接抛错**。这是有意的，静默降级会让
「同种子复现原版」失去意义，错配 RNG 也比直接失败危险。

## 覆盖现状

`cards.ts` / `relics.ts` / `potions.ts` **早已齐全**，两代实现共用；缺的是把参考项目里的
精确行为转写进 `sts-combat.ts` 的登记表并用 trace 验证。

⚠ **`enemies.ts` 是例外，它的数值不可信。** 文件头自己写着「精确权重 / 连续限制 /
守卫者阈值待真机 ground truth 校准」，而且只覆盖到第一幕切片。所以铺量怪物时
**数据表本身也要跟着逐位校准**，不像卡牌那样只写登记表。

| 类别 | 已登记  | 全量              | 登记表                                                                                                                           |
| ---- | ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 卡牌 | 108 + 1 | 116（可背书上限） | `CARD_RULES`                                                                                                                     |
| 怪物 | 59      | 65                | `MOVE_RULES`                                                                                                                     |
| 遗物 | **87**  | 180               | `RELIC_IMMEDIATE` / `RELIC_AT_BATTLE_START` / `RELIC_AT_TURN_START` / `RELIC_AT_TURN_START_POST_DRAW_INIT` / `RELIC_OTHER_HOOKS` |
| 药水 | **28**  | 42                | `POTION_RULES`                                                                                                                   |
| 编队 | 54      | 63                | `ENCOUNTER_BUILDERS` / `ENCOUNTER_SETUP`                                                                                         |

⚠ **遗物那一栏的登记表第四十一批多了第三张时点表 `RELIC_AT_TURN_START`**
（对齐 `Player::applyStartOfTurnRelics`），第四十三批多了**第四个时点**
`applyStartOfTurnPostDrawRelics`（怀表，`Player.cpp:661`）。一颗遗物可以同时出现在多张表里
——硫磺就是 `RELIC_IMMEDIATE` + `RELIC_AT_TURN_START`，两处的函数体在参考里逐字重复。
⚠⚠ **第四十三批一次登记 38 颗**，把参考里「战斗内只有一个读点」的那一族一次吃完
（70 颗单读点里 11 颗此前已登记、38 颗本批登记、21 颗**有理由地排除**，逐条理由见
「验证方式 · 第四十三批」）。剩下的 110 颗中有 **40 颗是多钩子的**（每颗 2~9 个读点），
后续批次的分组建议见那一节末尾。
⚠⚠ **`isRelicSupported` 目前没有任何调用者**（`stsCombatCoverage` 只查编队 / 牌 / 药水）。
于是「玩家带着一颗未转写的遗物」不会被拦下，那颗遗物在战斗内静默地什么都不做——
这与「未登记的编队 / 卡牌显式抛错」那条总纲相违。这是**接线侧**的缺口，见「一、接线」。
✅ **第四十四批补上了它的枚举版 `SUPPORTED_RELIC_IDS` 与一条永久用例**（`data-tables.test.ts`：
凡战斗内登记的 id 必须在 `relics.ts` 里）。那条用例守的是**另一个**方向——「预言机侧可达、
产品侧不可达」，即 `bloody_idol` 那个洞；`stsCombatCoverage` 不查遗物这条仍然开着。

⚠⚠ **「全量」那一栏第四十四批从 168 变成 180**，不是新做了 12 颗，是**补齐了数据表**：
参考的 `RelicId` 有 181 项（含一个 `INVALID` 哨兵），`relics.ts` 此前只有 168 条。
逐条比对补上的 12 条全部是参考 `relicTiers[]` 里的 `RelicTier::SPECIAL`（事件 / Neow 专属），
一条都不进奖励 / 商店 / 首领池。⚠ 同一次比对还发现**反向的污染**：`circlet` / `red_circlet`
被写成了 `common`，于是两枚「奖励池掏空时的兜底遗物」真的混在宝箱掉落里，已改成 `special`。
⚠⚠ **第四十四批一次登记 29 颗**，把「多钩子」那一族吃掉大半（前置是
`RelicInstance.data` 接线，一条解锁六颗）。逐条见「验证方式 · 第四十四批」。

✅ **第三十九批把第三幕装满了（16 / 16）**，所以「怪物」那一栏剩下的 **6 只**恰好就是
第四幕与事件那批：`CORRUPT_HEART` / `SPIRE_SHIELD` / `SPIRE_SPEAR`（第四幕）、
`BEAR` / `POINTY` / `ROMEO`（`MASKED_BANDITS_EVENT`）。「编队」那一栏剩下的 **9 个**是
第四幕 2 个 + `TWO_FUNGI_BEASTS` + 六个 `*_EVENT`。完整清单与下一步见文末
「第三幕完成度小结」。
⚠ `corrupt_heart` 在 `enemies.ts` 里**已经有一条只写了血量、没有招式**的 def——那不是
「登记了一半」，它是那两条「未迁移 / 未登记」测试用例的样本，理由见
`test/sts-combat-rules.test.ts` 的注释。

⚠ **上表全部是「爬升度 0」这一维的登记数。第二十一批起还有第二维：爬升度。**
✅ **第二十二批把它铺满了第一幕**（20 / 20 编队、25 / 25 只怪），
✅ **第三十批铺满了第二幕**（19 / 19 编队、17 / 17 只怪）——两幕都是 asc0 与 asc19 两个档位。
`EnemyDef.ascCalibrated` + `constructMonster` 的 throw + 编队级的 `ASC_SUPPORTED_ENCOUNTERS`
这道闸门**留着**——第三 / 四幕那 20 只怪一只都没校准，在 `ascension > 0` 下仍然显式抛错
（第三十二批登记的三只形状怪、第三十三批的三只单怪也在其中：尖刺客的荆棘 `{3,4,7}`
三档、暗球游荡者的 `GENERIC_STRENGTH_UP` asc17 档、尖塔增生缠绕的 asc17 档、
大嘴咆哮/流涎的 asc17 档，一条都没有预言机）。
判据与「未登记的编队直接抛错」同源：静默拿 asc0 的血量区间与招式数值去打 asc19 的仗，
会产出「看着合理、其实不是原版」的数值。

⚠ **第三十一批起还有第三维：目标策略。** `@tgt1` = harness 打「下标最大的活怪」，与历来的
`firstAliveMonster` 正好相反。它**只对多怪编队有意义**（单怪编队下两种策略取到同一只，
trace 会逐字节重复），所以覆盖面是 **23 / 39 个编队**（第一幕 11 + 第二幕 12）、
**只有 asc0 这一个档位**。做法与两步验证见 WORKFLOW「目标策略这条轴」。
⚠ 三维目前是**部分笛卡尔积**：`{asc0, asc19} × 39 编队` 全满，`tgt1` 只与 asc0 配过。
`asc19 × tgt1` 那 23 个组合是**没有**的——它是「百夫长狂怒连斩 asc2 伤害档」现在唯一的
关门条件（见文末盲区表）。

⚠ 「两个档位」**不等于**「阈值已验证」：asc19 钉住的是每条 `asc >= N` 的**高侧行为**，
asc0 钉住低侧，「分界线恰好在 N」以及「三档里的中间那一档」都还是盲区。
⚠⚠ **这两条现在是跨两幕的同一个问题**，关门条件也合成了一条：**单独一批做 `asc7 + asc16`**
——asc16 一次点亮 `{2,17}` / `{7,17}` / `{3,18}` / `{4,19}` / `{9,19}` 五族的中间档，
asc7 单独钉住 `[4, 9)` 那一段（冠军身上并存的两族阈值只有落在这里才分得开）。
逐条推算见文末「第二幕完成度小结 · 四」。

✅ **第二十批之后，harness 能背书的 20 个第一幕编队 / 25 只怪全部登记完毕。**
完整的收官清单见文末「第一幕完成度小结」。

✅ **第二十三批开了第二幕**：harness 现在跑**两个** `variants × encounters` 乘积，第二个
排在第一幕那个之后（`traceIdx` 接着往下走，第一幕 40 个文件逐字节不变；加空循环时单独跑
过一次 `--check` 证明了这一点，见 WORKFLOW「第二幕起：两个乘积」）。本批装了
**3 个编队 / 3 只怪**：`spheric_guardian`（球状守卫者）、`chosen`（选民）、
`snake_plant`（食蛇草）——都是单怪、无召唤、无塞牌，先把管线跑通而不叠机制。
⚠ 它们**只有 asc0 的背书**：第二 / 三幕 40 只怪一只都没校准爬升度，`ascCalibrated` 闸门
照旧在 `ascension > 0` 时抛错。第二幕的爬升度是它自己的一批。

✅ **第二十四批**：第二幕再装 **3 个编队 / 2 只怪**——`three_byrds`（三拜鸟）、
`two_thieves`（抢劫者 + 劫匪）、`chosen_and_byrds`（拜鸟 + 选民），新怪是**拜鸟**与**劫匪**。
新机制是**飞行（FLIGHT）**（四处协同：减半来卡伤害 / 受击递减 / 归零摔落改意图 /
回合开始复位再起飞）。

⚠⚠ **本批还关掉了全项目最大的一块同质盲区的入口**：`isMonsterAttacking` 的唯一读者是
**觅敌之弱**，而第十三批之后的编队都走 `ENC_V0`（只保留 variant 0 那副 21 张 `BATCH_1`
牌组，里面没有它）。本批给 harness 的第二幕新 variant 把牌组改成 **`BATCH_1` +
一张 `SPOT_WEAKNESS`**，于是**从本批起每一批第二幕的新怪都自带这条谓词的背书**
（本批实测：觅敌之弱在三个新文件里被打出 **833** 次；谓词改成恒真全库红 **294** 例，
其中 **248** 例落在本批三个新文件上——`CHOSEN_AND_BYRDS` 97 / `THREE_BYRDS` 80 /
`TWO_THIEVES` 71，剩下 46 例正是第二十三批量到的那五个 `ENC_ALL` 编队，一例不差）。
⚠ 精确一点：本批三个新文件里出场的怪是**拜鸟 / 劫匪 / 抢劫者 / 选民**四只，
所以关掉的不止本批两只新怪——**抢劫者（第十五批）与选民（第二十三批）被顺带关掉了**。
第十三批之后原本没背书的 21 只因此降到 **19 只**。
第二十三批那三个文件**没有**补（它们那个 variant 的牌组里没有觅敌之弱，
补它要走 `ALLOW_CHANGED` 重生成整份，收益不大），所以**球状守卫者与食蛇草仍然没有背书**。

✅ **第二十五批**：第二幕再装 **3 个编队 / 2 只怪**——`shell_parasite`（带壳寄生虫，⚠ 编队
枚举名**没有 ED**）、`shelled_parasite_and_fungi`（寄生虫 + 真菌兽）、`snecko`（史尼克）。
两条新机制：**镀甲（PLATED_ARMOR）** 三处协同（开局 14 层 + 14 格挡 / 受击 -1 且排在
那条 else-if 链的**第二格** / 回合末加 = 层数的格挡），以及**困惑（CONFUSED）**——
它整条住在 `CardManager::draw`，**抽每一张牌都消耗一次 `cardRandomRng`** 并把 `cost` 与
`costForTurn` 一起**永久**改成 0~3。
另有两处首次出现的形状：`Actions::VampireAttack`（打人 + 回「真正扣掉的血」，
为它补了 `CombatPlayer.lastAttackUnblockedDamage`）与**同步的真 `rollMove`**
（眩晕那条 case 是 `setMove(FELL); rollMove(bc);`，两句都同步，与 `noOpRollMove` 不是一回事）。
⚠ 本批把 `shelled_parasite_and_fungi` 一起装了，于是**第十六批真菌兽那条盲区被关掉**
（出招阈值的下方向此前只有 2 例，现在 137 例）；但同一批记着的**孢子云 `addToTop ↔ addToBot`
仍然 0 例**——亡语真的跑了（易伤层数、`isSourceMonster` 两条各有 62 / 41 例新背书），
只是那一刻队列里没有别的动作能插在中间。逐条见「验证方式 · 第二十五批」。

✅ **第二十六批**：第二幕再装 **4 个编队 / 2 只怪**——`centurion_and_healer`（⚠ 编队枚举名是
`CENTURION_AND_HEALER`，不是 `centurion_mystic`）、`three_cultist`（⚠ **单数**）、
`cultist_and_chosen`、`sentry_and_sphere`，新怪是**百夫长**与**秘法师**。
新机制是**怪物给友方治疗与增益**，三条效果原语（`gain_block_ally_fixed` / `heal_ally` /
`buff_ally`）**全是「目标写死的下标」**，与第十七批盾牌小鬼那条 `gain_block_ally`
（随机友军、掷 aiRng、空候选退化成给自己）**不是同一族**——本批逐位对过，三处都不一样：
① 目标写死（百夫长的防守给 `arr[1]`、秘法师的治疗/鼓舞给 `arr[0]`）；② **同步**执行，不入队；
③ 空候选时**什么都不做**（不退化成给自己）。
另有两处形状首次出现：「照顾友军」的三招收尾都是**同步的真 `rollMove`**（第六形态，
与第二十五批眩晕那条同族但**只有一句**，没有前置的 `setMove`），
以及秘法师那条**唯一读生命值的出招规则**（缺血阈值 asc17 是 **21**、治疗量却是 **20**，
两个数不一样）。
⚠ 本批还把参考的 `roll2` 补丁打掉了（带壳寄生虫的出招，见「已修正（参考侧已打补丁）」），
它改变了 `shell_parasite` 与 `shelled_parasite_and_fungi` 两个**已冻结**文件——
这是第一次用 `ALLOW_CHANGED` 放行第二幕的文件，复核结果与预期一致（只有那两个 `M`）。
⚠⚠ **本批留下一条新盲区：`CENTURION_FURY`（狂怒连斩）的效果一例都没执行过。**
`check-coverage.mjs` 报的是「出现 0 / 执行 0」，但**那个 0 有一半是工具的缺口**：
这一招作为意图其实出现了 **88 次**，全部落在**一具已死的百夫长**身上（荆棘 = 青铜鳞片走
`addToTop`，插在它自己那条入队的 RollMove 之前，低血的百夫长先被打死、那次 RollMove 在
尸体上执行 → `monstersAlive == 1` → 返回狂怒连斩），而覆盖表的 `countMoves` 会跳过死怪。
于是**出招规则那一支有 8 例背书，`takeTurn` 那条效果 0 例**——两件事要分开记。
要让**活着**的百夫长出这一招得让秘法师先死，而 `CENTURION_AND_HEALER` 是全参考项目唯一带
百夫长的编队、百夫长恒在 0 号位、harness 的策略恒打 `firstAliveMonster` = 0 号位；
换牌组救不回来（单体伤害只落在百夫长身上、群伤两只平摊、秘法师每次治疗给两只各回 16 而
自己血上限更低）。**关门条件是给 harness 加一条「打最右侧」的目标策略轴**，
与爬升度轴同构；本批没做那个轴（那是第二个机制）。⚠ 真实游戏里「先秒奶妈」是标准打法，
所以这一支不是边角，只是我们量不到。逐条见「验证方式 · 第二十六批」。

✅ **第二十七批**：第二幕再装 **2 个编队 / 2 只怪**——`gremlin_leader`（地精首领）、
`slavers`（⚠ 顺序是**蓝奴隶主 / 工头 / 红奴隶主**，工头在**中间**），新怪是**地精首领**与**工头**。
新机制是**召唤**（`Actions::SummonGremlins`）：本项目第一次「凭空加怪」。它与第十四 / 十九批的
分裂**形状不同**——分裂是「一只变两只、母体退场」（写母体那一格 + 右边一格），召唤是
**往预留的空位里填**：地精首领的编队开局就建好 1/2/3 三格、`monsterCount = 4` 而
**0 号位从没被构造过**（`MonsterGroup.cpp:248-259`），`SummonGremlins` 按 **1, 2, 0** 的顺序
找血 ≤ 0 的格子、取前两个填进去，`monsterCount` 一动不动。
另有三处首次出现的形状：
① **挑种类的 rng 是形参**（建怪时 `getGremlin(miscRng)`、召唤时 `getGremlin(aiRng)`，
写死一条流会让另一条整体错位）；② **召唤不重跑 `preBattleAction`**——召唤出来的狂暴小鬼
因此**没有狂怒**（trace 逐帧可见）；③ `MINION_LEADER` 让 `Monster::die` 多一条判胜路径
（首领一死**当场判胜**，小鬼还站着也算赢，`Monster.cpp:293-297`）。
工头这边补了 `EnemyDef.hpDiscardRoll`：`Monster::initHp` 有一族 case 会**先白掷一次再掷**
（`MonsterSpecific.cpp:105-117`），一次建怪消耗 **2 次** monsterHpRng。
⚠ 它的抽打往弃牌堆塞**伤口**——伤口早就在 `cards.ts` 与 `CARD` 映射里（狂野劈砍 / 强渡带进来的），
**打不出**，所以不进 `CARD_RULES`、也不能进 `--no-upgrade` 段；它的背书是「躺在牌堆快照里」
（`slavers.jsonl` 里弃牌堆含伤口的帧 5670 个，最多同时 7 张）。
⚠ **「永远关不掉」这个结论由复核方独立核过参考源码**（这是本项目最强的一类断言，
不能只凭报告）：`Monster::die` 那一句是
`else if (monstersAlive == 0 || hasStatus<MINION_LEADER>()) { outcome = PLAYER_VICTORY; return; }`
——首领一死当场判胜并 `return`，随从不可能再行动；而读出侧
`case MMID::GENERIC_ESCAPE_MOVE: default: break;` 本身**是空的**。
两端都堵死，所以这不是「暂时没有数据」，是**任何数据都不可能有**。

⚠⚠ **本批把挂了十批的 `escapeNext` 那条盲区结了案，结论是「永远关不掉」而不是「补上」**
——逐条判据与新的关门条件见「已确认但尚未打补丁」。

✅ **第二十八批**：第二幕再装 **2 个编队 / 3 只怪**——`book_of_stabbing`（突刺之书，
第二幕最后一个精英）与 `automaton`（⚠ **编队** id 是 `automaton`，它建的**怪**才叫
`bronze_automaton`；旧近似表里编队与怪同名，本批跟着参考枚举改了）。
三只新怪是**突刺之书 / 青铜自动机 / 青铜球**——青铜球**不在 `MonsterGroup.cpp` 的任何建怪
列表里**，唯一来源是自动机的召唤。

四条新机制：

1. **召唤的第二族**（`Monster::spawnBronzeOrbs`）。它与第二十七批的 `Actions::SummonGremlins`
   **不共用任何代码，八处形状都不同**（同步 vs 入队 / 下标写死 0 与 2 vs 按 1,2,0 搜索 /
   种类固定因而不掷 aiRng vs 走 `getGremlin(aiRng)` / 没有 `= Monster()` 重建 vs 有 /
   末尾多一句 `++monsterTurnIdx`），并列表见 WORKFLOW。
   ⚠ **预留空位的写法也是第二种**：`monsterCount = 1; createMonster(...); ++monsterCount;`
   （`MonsterGroup.cpp:173-177`）——先推游标、建怪、再空一格，于是 **0 号位与 2 号位都空、
   宿主在中间的 1 号位**（地精首领那个只留 0 号位、而且是手动赋值 3 / 4）。
2. **眩晕 / 超射线的充能**：自动机整条意图链**一次 roll 都不看**（`getMoveForRoll` 恒返回召唤，
   五条 case 全是「同步 setMove + 同步 noOpRollMove」），分岔靠 `miscInfo` 当
   `lastBoostWasFlail` 用——「连枷、增益」两轮之后来一发超射线，然后 asc<19 时**自己进眩晕**
   （眩晕那回合一个效果都没有）。
3. **段数由状态决定的多段攻击**：乱刺是 `attackPlayerHelper(bc, asc3 ? 7 : 6, miscInfo)`，
   段数从 1 起步（`preBattleAction` 里 `++miscInfo`，**跑在开局那次 rollMove 之后**）、
   出招规则每发一次乱刺再 `++`，整场单调递增。数据表新增 `times: "miscInfo"`。
   ⚠ 这是 `miscInfo` 的第 6~8 种含义一次到齐（乱刺段数 / 青铜球「已用过停滞」/
   自动机「上次增益之后出的是连枷吗」）。
4. **停滞（STASIS）**：青铜球把玩家的一张牌从抽牌堆（空则弃牌堆）里扣住，
   挑牌**按稀有度加权**（RARE > UNCOMMON > COMMON，三种都没有才在整堆里平均挑）、
   筛完还要按参考的 `cardSortedIdx` **稳定排序**再取，两条路径都**恰好消耗一次
   `cardRandomRng`**；那颗球死掉时（`Monster::die` 的 else-if 链）把牌**还回手牌**。
   ⚠⚠ 它带来一条与第二十三批同型的教训：**参考用来做决策的静态表不能从我们的数据表派生**。
   `Cards.h` 的 `cardRarities` 与我们的 `CardDef.rarity` 在 118 张已映射的牌里**有 15 张
   不一致**（状态牌参考是 COMMON、我们是 `special`，另 11 张我们低一档），所以本批单开了一张
   `STASIS_CARD_INFO`（稀有度 + `cardSortedIdx`，逐条抄参考）。

另有一处**痛苦突刺**（`PAINFUL_STABS`）：读点在**玩家侧**（`Player::attacked` 的
`damage > 0` 分支），**每一次打穿格挡的攻击**往弃牌堆塞一张伤口——多段攻击**每段各判一次**，
被完全挡住的那一段一张都不塞。伤口这一路第二十七批已经打通（打不出，只躺在牌堆快照里）。

⚠ **本批新发现一处参考的死代码，裁定不打补丁**：突刺之书的 `getMoveForRoll` 里有两处
`return (SINGLE_STAB); if (asc18) { ++stabCount; }`（语句排在 `return` **之后**）。
这是「死代码」的**第三种形状**（前两种是「字段从没被赋值」与「取值被短路吃掉」），
三条判据一条都不过，逐条见「待裁定」。

✅ **第二十九批：第二幕收官（19 / 19）**。装了最后 **2 个编队 / 3 只怪**——`champ`（冠军）与
`collector`（⚠ **编队** id 是 `collector`，它建的**怪**才叫 `the_collector`；旧近似表里两者
同名，本批跟着参考枚举改了，同族先例是第二十五批的 `shell_parasite`、第二十八批的
`automaton`）。三只新怪是**冠军 / 收藏家 / 火炬头**——火炬头**不在 `MonsterGroup.cpp` 的任何
建怪列表里**，唯一来源是收藏家的召唤（与青铜球同族）。

三条新机制：

1. **召唤的第三族**（`Actions::SpawnTorchHeads`，Actions.cpp:500-527）。它与前两族
   （`Actions::SummonGremlins` / `Monster::spawnBronzeOrbs`）**一处都不共用，八处形状全不同**，
   并列表见 WORKFLOW。最要紧的四处：
   - **召几只是算出来的**：`spawnCount = 3 - monstersAlive`——这是全参考项目**唯一**按
     `monstersAlive` 决定召唤数量的地方，于是它顺带成了「预留空位不算活怪」的预言机，
     **第二十七批那条盲区在本批关门**（实测把开局 `monstersAlive` 写成数组长度红 **375 例**）。
   - **`construct` 之后又显式 `initHp` 了一次**（参考那行注着 `// bug somewhere in game`）
     → 每只火炬头消耗 **2 次** monsterHpRng、**保留第二次**的取值。⚠ 它**不是**
     `hpDiscardRoll` 那一族（那一族的白掷在 `initHp` 内部、恒用低档区间）。
   - **意图靠 `setMove` 而不是 `rollMove`**，所以召唤本身**一次 aiRng 都不掷**；
     aiRng 在**末尾按只数**统一还（`for (i < spawnCount) noOpRollMove()`）。
   - **没有 `++monsterTurnIdx`**——因为收藏家在**最后一格**（2 号位），新召的两只本回合
     本来就轮不到。
     ⚠ **「怎么预留空位」也是第三种写法**：`monsterCount = 2; createMonster(THE_COLLECTOR);`
     （MonsterGroup.cpp:198-201）——0 号位与 1 号位都空、宿主在**最后一格**，而且**没有**
     自动机那句末尾的 `++monsterCount`。三种写法两两不同，照抄邻居必错。
2. **冠军的阶段锁存**。⚠⚠ 它**不在 `Monster::onHpLost` 里**——那个 switch
   （Monster.cpp:499-535）**压根没有 `THE_CHAMP` 这一格**，只有三种大史莱姆的分裂与守卫者的
   模式切换。锁存整条住在 `getMoveForRoll`（MonsterSpecific.cpp:2900-2918）：
   `if (monsterData & 0x4) … else if (curHp < maxHp/2) { monsterData |= 0x4; return ANGER; }`。
   于是「掉到半血以下」这件事**只在下一次 rollMove 才被发现**，不像守卫者那样在挨打那一瞬间
   改意图——两者是**不同的东西**，实测给冠军补一条守卫者式的 `onHpLost` 红 **158 例**。
   ⚠ `miscInfo` 在这只怪身上**一个字段两种用途**（参考 Monster.h:73 那行注释就叫
   `champ phase2`）：bit 0~1 是防御姿态的**已用次数**（上限 2）、bit 2 是二阶段标志，
   出防御姿态时是 `++monsterData`（整数自增，不是按位或）。
3. **怪物侧清减益**（`Monster::removeDebuffs`，Monster.cpp:522-535）。冠军的暴怒是它在战斗内
   唯一的读者。⚠ 它是一张**写死的名单**、不是「清空所有 Power」：力量**只抬负值**、
   九条 `removeStatus` 逐条列举（其中易伤 / 虚弱有背书，见变异表）。
   另有**第三种「给玩家上减益」的写法**：冠军的嘲讽写的是裸的
   `bc.player.debuff<PS::WEAK>(2, true);`（连 `Actions::DebuffPlayer` 都没经过），
   与拉加维林那种 `.actFunc(bc)` 逐位等价，故同样用 `sync: true` 表达。

⚠ **本批没有给参考打任何 gameplay 补丁**（只加了 harness 的 variant 29），所以是**纯追加**、
不需要 `ALLOW_CHANGED`、也没有旧例数需要重量。逐条见「验证方式 · 第二十九批」，
第二幕的收官清单见文末「第二幕完成度小结」。

✅ **第三十批：爬升度铺到第二幕**（19 / 19 编队 × asc19，harness 的 variant 30）。
17 只怪的 `ascCalibrated` 同批置起，三族阈值逐只校准（血量普通 7 / 精英 8 / Boss 9，
数值 `getTriIdx(asc,2,17)` / `(3,18)` / `(4,19)`）。**纯追加**：19 个新文件、零个 `M`，
而且五条旧例数原地重量一例不差。

两条新原语：**`apply_power` 的 `sync` 铺到 `on:"self"`**（唯一的用户是工头 asc18 那条入队的
自身 buff，第二十七批挂的账；⚠ 省略时的含义逐 `on` 不同，这个不对称让 40 余处已登记的自身
buff 一位都不用回填）与 **`deal_damage_multi.ascTimes`**（拜鸟啄击的 `asc? :` 落在**段数**
那个实参位上）。另外补上第二十三批留的两块出招规则（选民与食蛇草的 `if (asc17) { … }`）。

⚠ 本批还**意外关掉**了第二十三批那条整族盲区：variant 30 的牌组带觅敌之弱、编队列表又包含
第二十三批那三个，于是球状守卫者「硬化」这个「带伤害却也加格挡」的白名单反例第一次有了
预言机（131 例）。逐条见「验证方式 · 第三十批」。

✅ **第三十一批：目标策略这条轴**（`@tgt1` = 打下标最大的活怪，harness 的 variant 31）。
**引擎侧 0 行实现**，纯粹是 harness 与 trace 管线的一条新维度；数据 23 个多怪编队 ×
40 种子 × 3 层 = 2760 例 / 58.6MB，**零扰动**（`git status` 只有 23 个 `??`）。

它关掉的是**全项目最大的一族同质盲区**——「同伴先死」这个局面此前在任何编队、任何牌组、
任何爬升度下都不可能出现，因为 `pickAction` 恒打 0 号位。头号受害者 `CENTURION_FURY`
（第二十六批留的账）的**效果与收尾**从 0 例变成 91 / 96 / 88 例；
✅ **装完这一批，全语料里再也没有「执行 = 0」的招式**。
顺带关掉：百夫长防守的 `monstersAlive > 1` false 侧（66 例）、`MINION_LEADER` 判胜路径
（4 → 21 例）、秘法师鼓舞的连续限制（0 → 2 例）。
❌ **孢子云的 `addToTop ↔ addToBot` 没关掉，而且这次把根因证死了**：真菌兽「有同伴时死」
从 83 / 375 涨到 **120 / 120**，插队顺序照旧不可观察——那条盲区卡的是「队列内容」
而不是「成员结构」。逐条见「验证方式 · 第三十一批」。

✅ **第三十二批：第三幕开张**（三个「形状怪」编队 / 三只新怪，harness 的 **第四个乘积**
`emitProduct(act3Variants, act3Encounters)` + variant 32）。**两步验证做了**：先只加空乘积
跑一次 `--check`，**101 个已提交文件逐字节复现**；再填 variant。数据 3 编队 × 40 种子 ×
3 层 = 360 例 / 8.4MB，**零扰动**（`git status` 只有 3 个 `??`）。

装的是 `three_shapes` / `four_shapes` / `sphere_and_two_shapes`，新怪是**爆破怪 / 斥力怪 /
尖刺客**。三个编队一起装的理由是它们走**两条不同的建怪路径**，只装一边会让另一边的转写
没有背书：`createShapes`（6 项池 {斥力,斥力,爆破,爆破,尖刺,尖刺}、**不放回**、取走后整体
左移，`MonsterGroup.cpp:508-530`）与 `getAncientShape`（3 项表 {尖刺,斥力,爆破}、**有放回**，
`:532-539`）。⚠ 两张表的项数 / 重复度 / 书写顺序全不同——所以
`sphere_and_two_shapes` 真的可能出两只同种形状怪，而 `three_shapes` 不可能出三只同种。

四条新原语：**怪物侧荆棘（THORNS）**（`attackedUnblockedHelper` else-if 链的第六格，
`addToTop(DamagePlayer(层数))`、`clearOnCombatVictory = false`）、**`suicide`**
（`Actions::SuicideAction(idx, true)` 走的是正常的 `Monster::damage(curHp)`，**里面没有
`checkCombat`**）、**`damage_player_non_attack`**（`Actions::DamagePlayer`，不吃力量与易伤、
不触发玩家荆棘/火焰屏障，但照样被格挡吸收）、**`add_card` 的 `pile: "draw"`**
（`ShuffleTempCardIntoDrawPile`，每张各掷一次 `cardRandomRng`）。

⚠⚠ **三处旧近似表的错误一并校正，其中第一处是本批最重要的一条教训**：
① **爆炸不是亡语**——参考把它建模成一条**招式**（`EXPLODER_EXPLODE`，由撞击的收尾
`lastTwoMoves(SLAM)` 在第三个怪物回合定出来），所以**被玩家打死的爆破怪一点伤害都不造成**。
`EnemyDef.deathEffects` 因此只剩零个用户，本批把字段本身删了（`Monster::die` 那条
else-if 链才是亡语的完整名单）。② 尖刺客的增生尖刺加的是 **thorns** 而不是 `sharp_hide`
（后者是守卫者的「打出攻击牌就触发」，时点完全不同）。③ 斥力洗的是**两张**恍惚、且同步。

⚠⚠ **本批发现一处「参考与真实游戏可能分歧」，照抄不打补丁**：`EXPLODER_EXPLODE` 打 30 点
却**不在** `isMoveAttack` 白名单里（参考的判据是「有没有走 `attackPlayerHelper`」，它走的是
`Actions::DamagePlayer`），而隔壁匕首的自爆**在**。真实游戏那里显示的是攻击意图。
三条判据只过了第 ① 条，详见「数据表与参考/真实游戏冲突 · 待裁定」。

✅ **第三十三批：第三幕三个单怪编队**（`orb_walker` / `spire_growth` / `maw`，
harness 的 **variant 33**，追加在 `act3Variants` 末尾）。数据 3 编队 × 40 种子 × 3 层 = 360 例
/ 7.4MB，**零扰动**（`git status -- test/golden/traces` 只有 3 个 `??`、零个 `M`，
所以 variant 32 那三个文件逐字节不变）。对拍 30106 → **30466 例**。

选这三个编队是因为三只怪**全由已登记的原语拼成**，一个新的回合结构都不带——
这正是 WORKFLOW 那句「一个机制一批」的另一面：**「零机制」的一批也应该单独排**。
带进来的只有两个新 Power 与一条新的段数来源：

- **`GENERIC_STRENGTH_UP`**（暗球游荡者，全参考项目**唯一宿主**）：开局 `preBattleAction`
  上 3 层（asc17 是 5），效果是 `Monster::applyEndOfRoundPowers` 的**最后一句**——
  每个回合末 `buff<STRENGTH>(层数)`，而它自己**一层都不掉**。
  ⚠ **与仪式（RITUAL）不是一回事**，两处差别都照抄了：仪式带 `wasJustApplied` 的 skipFirst
  且排在那个函数的**第一句**，这一条**没有** skipFirst、排在**最后一句**。
  参考自己在枚举那行注了 `// todo just merge this with orb walker strength up`
  ——它清楚两者像但**没有**合并，所以我们也不合并。实测「补上 skipFirst」红 **120 例**。
- **`CONSTRICTED`**（尖塔增生）：`Player::applyEndOfTurnPowers` 里那条 case **只有一句**
  `addToBot(Actions::DamagePlayer(层数))`（`Player.cpp:374-376`）——**既不递减也不摘除**。
  枚举值 9，是那个循环里**第一个命中的**（排在 `ENTANGLED` 之前）。
- **`times: "monsterTurnHalf"`**（大嘴的吞噬）：段数 = `(getMonsterTurnNumber() + 1) / 2`
  的 C++ 整数除法，是本项目第一条「段数由**全局回合计数**算出来」的多段攻击。
  ⚠ 与第二十八批的 `times: "miscInfo"` 不是一回事：那条读的是**怪自己的字段**。

⚠⚠ **本批最值得记的一条实测**（「先量局面再量变异」又一次奏效）：尖塔增生的缠绕理论上
「一场仗最多出一次」（出招规则里有 `!player.hasStatus<CONSTRICTED>()`），可实测
**22 / 120 条 trace 出了两次**——而那 22 条**全部**是玩家身上有神器的那些
（`Player::debuff` 的神器门排在写 `statusMap` 之前，第一次缠绕被神器吃掉 →
`hasStatus` 仍为假 → 还能再来一次）。**「理论上只能一次」的门要去数据里数一遍**，
这条局面同时给了那道门两个方向的背书（去掉「已有束缚」门红 89 例、
去掉「刚缠绕过」门红 16 例）。

⚠ 三处旧近似表的错误一并校正：① 暗球游荡者的利爪 asc0 是 **15**（旧表写的 16 是高档值），
激光要塞**两张**灼伤、去**两个不同的牌堆**（抽牌堆 + 弃牌堆）；② 尖塔增生的重砸**没有**
附带虚弱（旧表凭空多挂了一层）；③ 大嘴**有四招**，旧表整个漏掉了「流涎」
（`THE_MAW_DROOL`，同步 +3 力量）——而它是执行次数最多的那一招（326 次）。

⚠ 编队 id `the_maw` → **`maw`**（对齐 `MonsterEncounter::MAW`；建的**怪**仍叫 `the_maw`）。
同族的先例：`shell_parasite`（25）/ `automaton`（28）/ `collector`（29）。

**本批没有发现参考项目的 bug**，也没有打任何补丁。

✅ **第三十四批：第三幕的两条死亡 / 回合边界机制**（`three_darklings` / `transient`，
harness 的 **variant 34**，追加在 `act3Variants` 末尾）。数据 2 编队 × 40 种子 × 3 层 = 240 例
/ 7.4MB，**零扰动**（`git status -- test/golden/traces` 只有 2 个 `??`、零个 `M`）。
对拍 30466 → **30706 例**。

- **半死（`Monster::halfDead`）** —— `isDeadOrEscaped()` 的第三位，**第十五批做逃跑时点名
  跳过的那一位，本批结清**。它与另外两位的差别只有一处，但那一处是决定性的：
  `MonsterGroup::doMonsterTurn` 的门是 `(!m.isDeadOrEscaped() || m.isHalfDead())`
  ——**半死的怪照样行动**，这正是暗影客能在下一个怪物回合滚出「复活」的唯一路径。
  ⚠ 另外两个循环（`applyPreTurnLogic` / `BattleContext::applyEndOfRoundPowers`）的门是
  `isDying() || isEscaping()`，**没有** halfDead 这一位——但它们照样跳过半死的怪，
  因为**半死必然伴随 `curHp == 0`**（`die` 只可能从「扣血到 ≤ 0」进来）。所以那两处
  写 `!alive` 与参考同解，**不需要改**。
- **重生（`MS::REGROW`）** —— `Monster::die` 那条 else-if 链的**中间格**
  （`孢子云 → 重生 → 停滞`），第二十八批装停滞时特意留出的那个空位，链的形状现在钉死了。
  ⚠ 它排在判胜 `return` **之后**：三只暗影客一起被清光时玩家直接获胜，没有人重生。
- **变换（`MS::SHIFTING`）** —— `attackedUnblockedHelper` 那条 else-if 链的**第八格**
  （最后一格），外加 `damageUnblockedHelper` 里的一个**独立 if**。两处函数体一样、
  形状不同，**不合并**。顺带把沉睡那一格从「兜底的 `else`」改成显式 `else if`
  ——变换必须接在它后面，兜底写法占着最后一格。
- **消逝（`MS::FADING`）** —— 层数 = 「还能出手几次」，**没有任何回合末的自动递减**，
  唯一的递减点是重殴那条 case 的最后一句。层数为 1 时排的是
  `Actions::SuicideAction(idx, **false**)` —— `triggerRelics` 的**另一支**
  （`Monster::suicideAction`：把血置 0 + 自减活怪数，**整条死亡链一句都不跑**、
  不扣格挡、不走 `onHpLost`、判胜后没有 `checkCombat`）。与爆破怪那一支完全不同。

⚠⚠ **本批最值得记的一条，是「对拍红了才发现」的**：`Monster::resetAllStatusEffects()`
（`Monster.cpp:554-558）**只清 `statusBits`，不清那些具名 int 字段**——

```cpp
statusBits = 0;  setStatus<MS::STRENGTH>(0);  block = 0;
```

——所以它与「逐个 `removeStatus`」（先 `setStatus(0)` 再清 bit）**不是一回事**：
残留的层数会被下一次 `buff` / `addDebuff`（都是 `field += n` 再置 bit）**继续加上去**。
实测：暗影客重生**之前**挨过 1 层虚弱，复活之后再吃一张衣领（+2 层），参考显示 **3** 层。
我们把这个中间态建模成 `PowerInstance.cleared`（数值还在、bit 已清），所有读点改走
`findPower`；纯 bool 的 Power 没有数值字段，reset 时**整条丢掉**而不是标 cleared。
**教训：`resetAllStatusEffects` 与 `removeStatus` 在参考里是两种语义，别当同义词。**

⚠ 三处旧近似表的错误一并校正：① 暗影客的啃食 asc0 是 **8**（旧表写的 9 是高档值）、
撕咬的伤害是**出生时掷定**的 `miscInfo`（7~~11，旧表写死成 8）；② 复形怪是 **999 血 +
`hpNoRoll`**（旧表写的 88~~92 数值与掷法两处都错）；③ 复形怪**没有**「消散离场」那一招
（`MMID` 里只有 `TRANSIENT_ATTACK`，旧表那条 `escape` 是编的）。

⚠ **本批也改了两处工具**（都是为了不让工具产生假阴性，见下方变异测试小节）：
harness 的怪物快照新增 `halfDead`（**只在为真时输出**，故 107 个既有文件逐字节不变），
`check-coverage.mjs` 的「执行」栏跟着放行半死的怪。

**本批没有发现参考项目的 bug**，也没有打任何补丁。

✅ **第三十五批：把两块「半成品的共享机制」补完**（`writhing_mass` / `giant_head`，
harness 的 **variant 35**，追加在 `act3Variants` 末尾）。数据 2 编队 × 40 种子 × 3 层 = 240 例
/ 6.0MB，**零扰动**（`git status -- test/golden/traces` 只有 2 个 `??`、零个 `M`）。
对拍 30706 → **30946 例**。

- **反应（`MS::REACTIVE`）** —— 它与易塑**共用** `attackedUnblockedHelper` else-if 链的
  **第五格**（`else if (hasStatus<MALLEABLE>() || hasStatus<REACTIVE>())`，进门之后
  **两个 if 各判各的**，`Monster.cpp:369-383`）。**蠕动血块是全参考项目唯一两者都带的怪**
  ——在它登记之前，那一格写成一格还是两格观察不到差别，所以第二十三批装食蛇草时只能写
  易塑那一半并留下这笔账，**本批结清**。
  ⚠ 它排的 `Actions::ReactiveRollMove` 是本项目第一条「挨打就重滚意图」：
  层数为 0 时置 1 **并入队一条动作**，否则只 +1；那条动作**按层数连滚 N 次** `rollMove`
  再把层数置 0（`setStatus`，只写数值、不清 bit）。所以一张多段攻击牌只排**一条**动作、
  却滚 **3** 次意图——「每击各排一条」与它消耗的 aiRng 次数相同、`moveHistory`
  推进次数完全不同（实测红 83 例）。目标**写死 `arr[0]`**（参考自注
  `// writhing mass is always monster 0`）。
- **缓慢（`MS::SLOW`）** —— 本项目第一条挂在 `BattleContext::onAfterUseCard` 那条**共享
  出牌路径**上的怪物侧 Power，三处协同：玩家每打出一张牌 `buff<SLOW>(1)`（只看 0 号位、
  在 `if (item.triggerOnUse)` 里、排在 `purgeOnUse` 提前返回**之前**）/
  `calculateCardDamage` 的 `damage *= 1 + slow * 0.1f`（**排在易伤之前**）/
  `Monster::applyEndOfRoundPowers` 的**第二句** `setStatus<SLOW>(0)`（每回合末**清零**，
  不是递减、也不摘除）。
- ⚠⚠ **两只怪的开局 Power 都是第三种写法：`setHasStatus<X>(true); setStatus<X>(0);`**
  ——**位置上、层数是 0**，不是 `buff(n)`。后果有两条，都可观察：
  ① 这条 Power **平时不进快照**（层数 0 被两侧同时折叠），巨头开局那一帧身上一个 power 都没有；
  ② **所有读点必须用 `hasStatus`（条目在不在）**，写成「层数 > 0」的话这条 Power
  **一次都触发不了**（实测两条门各红 120 例 = 整个编队）。详见 WORKFLOW 新增的那条。
- **两条新的效果原语**：`set_misc_info`（植入那句 `miscInfo = true;`——参考**不建模**那张
  寄生虫诅咒，战斗内只剩这个标志位）与 `deal_damage.monsterTurnRamp`（**封顶**的回合成长
  `min(turnNo - 5, 6) * 5`）。三个参数里只有偏移有背书（`subtract` 5 → 4 红 120 例）。
  ⚠⚠ **后者按字面读第一击那一项应该是 −5（`std::min` 不夹下界），可它结构性不可达**——
  这是本批最值得记的一条判据：**出招门读的是「滚意图那一刻」的回合数，成长读的是
  「执行那一刻」的，两者差一个怪物回合**。门是 `getMonsterTurnNumber() >= 4`，
  命中时那次 rollMove 跑在第 4 个怪物回合的收尾，招式要到第 **5** 个才执行 →
  `min(5-5, 6) == 0`。实测「补一个 `max(0, …)`」红 **0 例**。`cap` 同样是盲区
  （6 → 99 红 0 例：这个编队最长 7 回合，`min` 左边最大才 3）。

⚠ **本批发现一处参考笔误**：蠕动血块的**萎缩**走
`attackPlayerHelper(bc, asc2 ? 12 : 10)` 却**不在** `isMoveAttack` 白名单里
（`MonsterMoves.h` 当时只收挥击 / 乱抽 / 重抽）。按第三十二批立下的判据
（「白名单收的就是走 `attackPlayerHelper` / `Actions::AttackPlayer` 的那些招」）它应该在，
真实游戏里萎缩显示的也是攻击 + 减益双意图。本批当时记进「待裁定」（差异已被 24 例钉住）。
✅ **第三十六批复核后打了补丁**：全表扫过之后它是**整个参考里唯一一个**「走
`attackPlayerHelper` 却不在白名单」的招式，三条判据全过。详见「已修正（参考侧已打补丁）」。

⚠ **旧近似表的错误一并校正**（本批两只怪的数据表几乎重写）：
① 蠕动血块的挥击**漏了 16 点格挡**、萎缩**漏了易伤**、**整条植入都没有**，
四条攻击的 asc2 分档也全缺；② 巨头**根本没有「数数」这一招**、凝视被写成「10 点攻击」
（参考那条**一点伤害都没有**、只上 1 层虚弱）、「时候到了」写死 35（参考是 25/30/35/…/60）。

⚠ **「未迁移编队」的测试样本本批被自己顶掉**（`giant_head`），换成 `donu_deca`（⚠ **第三十九批又被顶掉了**，现在是 `the_heart`）。
⚠⚠ 顺带把一条**长期误解**写进 WORKFLOW：编队样本**没有永久解**（与卡牌那条 `seek` 不同，
参考实现了全部编队），每隔几批就要换一次，判据是「挑最晚才会被登记的那个」。

**本批没有给参考打任何补丁**（萎缩那条当时记成待裁定，第三十六批才补）。

✅ **第三十六批：第三幕两个精英**（`nemesis` / `reptomancer`，harness 的 **variant 36**，
追加在 `act3Variants` 末尾）。数据 2 编队 × 40 种子 × 3 层 = 240 例 / 6.0MB，
对拍 30946 → **31186 例**。
⚠ 原计划的三十六（复仇魔）与三十七（蜥蜴法师）**合成了一批**，理由见「第三幕 · 未装」下方。

- **怪物侧虚无缥缈（`MS::INTANGIBLE`）** —— 四处协同，缺一处就静默偏：
  ① `Monster::attacked`（`:418-422`）与 ② `Monster::damage`（`:477-481`）的入口**各有一份
  逐字相同**的 `if (hasStatus<INTANGIBLE>()) { if (damage > 0) damage = 1; }`
  ——所以**非攻击伤害也被压成 1**（燃烧 / 荆棘 / 火焰药水都算），与蜷缩 / 镀甲那种
  「只挂在 attacked 那条 else-if 链上」正相反；位置在**狂怒之前、格挡吸收之前**。
  ③ `BattleContext::calculateCardDamage`（`:2768-2770`）末尾 `damage = std::max(damage, 1.0f)`
  ——⚠⚠ 是 **`max`（下限）不是 `min`（上限）**：那个函数只**预计算**一个数，真正的钳制在 ①。
  抄成 `min` 在最终血量上碰巧同解，实测仍红 **7 例**（玩家侧读那个预计算值的地方分岔）。
  ④ `Monster::applyEndOfTurnTriggers` 的**第四句**无条件递减（金属化 → 易塑 → 镀甲 →
  **虚无缥缈** → 再生 → 枷锁），走 `uniquePower0` 那一支 → **归零时连条目一起摘掉**。
  ⚠ 参考在枚举那行自注 `// differs from the game in that it always decrements at end of round`
  ——**它知道自己与真实游戏不同**，照抄，记进「与真实游戏的已知分歧」。
  ⚠⚠ 而复仇魔三条 case 的尾部各有一句 `if (!hasStatus<INTANGIBLE>())` 补 2 层，
  **三条的形状两两不同**：多重打击 / 巨镰是 `addToBot(BuffEnemy)` 且**排在入队的
  RollMove 之后**，灼烧诅咒却是**同步**的 `buff<>()` 且排在**同步**的 `rollMove` 之后。
  一个数据表字段（旧的 `intangibleAfterMove`）表达不了这三种时序，本批把它删了。
  ⚠ 净效果才是「隔回合无敌」：2 → 回合末 1（下个玩家回合仍无敌、怪物回合不补）→
  回合末 0（条目消失）→ 再补 2。**快照里永远只看得见 1**（2 那一刻在同一步之内）。
- **召唤的第四族**（`Monster::reptomancerSummon` + `reptoSummonHelper`）与
  **预留空位的第四种写法**。四族并列表见 WORKFLOW，**十个维度没有一个四族一致**。
  这一族独有的三处：① **召几只看爬升度**（`asc18 ? 2 : 1`，全参考唯一）；
  ② **搜索顺序写死 `{4, 1, 3, 0}`**，只扫 4 格、**跳过法师自己的 2 号位**；
  ③⚠⚠ **`bc.monsters.skipTurn.set(daggerIdx, true)`** —— 全参考项目**唯一**的写入点
  （`std::bitset<5>`，读点是 `doMonsterTurn` 的门、清点是主循环「怪物回合走完」那一句）。
  落在游标右边的新匕首**本回合不行动**；前三族靠 `++monsterTurnIdx` 或宿主位置绕开它。
  ⚠ 编队本身也是全参考唯一的 **5 格**编队，而且是唯一一个**两个空位之间还夹着活怪**的
  （0 与 3 空、匕首在 1 / 4、法师在中间的 2）。
- **匕首**是第一个**既预置又召唤**的怪（青铜球 / 火炬头都只有召唤这一个来源）。
  它的自爆走 `attackPlayerHelper(bc, 25)` → **在** `isMoveAttack` 白名单里，
  与爆破怪的自爆（`Actions::DamagePlayer(30)`、不在）**正好是同一条判据的两个方向**。
  ⚠ 它还让「召唤不重跑 `preBattleAction`」这条在本宿主身上成为**可证的空操作**
  （匕首的 `preBattleAction` 就是 `buff<MINION>()`，而召唤自己手写了同一句）——
  与火炬头那条同为**探针无效**，真正有背书的仍然只有地精首领那条。
- `hpDiscardRoll` 的**最后一个宿主**（蜥蜴法师，`hpRng.random(180,190)` 先白掷一次）。
  这一族四只怪（工头 / 青铜球 / 暗球游荡者 / 蜥蜴法师）**从此全部登记，名单封闭**。

⚠ **旧近似表的错误一并校正**：① 复仇魔的加权（35/30/35 + maxInARow）与参考的
「首回合两分 + 三档 roll + 三处极性各异的 `randomBoolean`」毫无关系；灼烧张数没有 asc 分档。
② 蜥蜴法师的毒牙是**两段** 13（旧表写的是单段）、巨口 30 的 asc3 档 34 缺失、
`hpDiscardRoll` 整条缺失。③ 匕首**根本没有「自爆」这一招**（旧表只有突刺），
而它恰恰是第三幕最疼的一击。

**本批给参考打了一个补丁**：`isMoveAttack` 白名单补上 `WRITHING_MASS_WITHER`
（第三十五批留下的待裁定，复核后三条判据全过）。影响面只有 `writhing_mass.jsonl`
一个已冻结文件、**24 / 120 条 trace**，与第三十五批量到的 24 例一字不差。

✅ **第三十七批：第三幕 Boss 觉醒者**（`awakened_one`，harness 的 **variant 37**，
追加在 `act3Variants` 末尾）。数据 1 编队 × 40 种子 × 3 层 = 120 例 / **7.4MB**，
对拍 31186 → **31306 例**（仓库 608MB / 114 个文件）。

- **两阶段 Boss / 假死** —— `Monster::die` 的**第一个分支**（`Monster.cpp:285-292`）：
  ```cpp
  if (id == MonsterId::AWAKENED_ONE && !miscInfo) {   // stage 1
      halfDead = true; removeDebuffs(); removeStatus<MS::CURIOSITY>();
      setMove(AWAKENED_ONE_REBIRTH); bc.cardQueue.clear();
  } else if (monstersAlive == 0 || hasStatus<MINION_LEADER>()) { outcome = 胜利; return; }
  ```
  ⚠⚠ **它排在判胜 `return` 之前，是那条链上唯一能跳过判胜的路径**——把最后一只怪打死
  也不算赢。与暗影客的重生（在 `return` **之后**的 else-if 链上，所以「同伴全死就是真赢」）
  是**同一个 `halfDead` 字段的两个相反的门**。实测「整条去掉」与「挪到判胜之后」**各红 46 例**
  （= 46 条走到假死的 trace 全部）。
  ⚠ 门是**怪种 id + `miscInfo == 0`**，不是状态位（参考自注 `// todo change to status`）。
  照抄 id 判断。去掉 `miscInfo == 0` 那一半红 **14 例**（二阶段死掉时会再假死一次）。
  ⚠ 清减益走的是**逐个 `removeStatus`** 的 `Monster::removeDebuffs()`，**不是**
  `resetAllStatusEffects()`——所以觉醒者身上**不会**出现暗影客那种 `cleared` 残值。
  与冠军的暴怒共用 `monsterRemoveDebuffs`（红 8 例）。
  ⚠ `bc.cardQueue.clear()` 是全参考项目怪物侧**唯一**一次清出牌队列（另一个调用点是
  `Actions::ClearCardQueue`）。**0 例**，见盲区表。
- **好奇心（CURIOSITY）** —— ⚠⚠ **参考里它的唯一读点被整段注释掉了**
  （`BattleContext.cpp:1909-1912`，「玩家打出能力牌 → 此怪 +层数 力量」，连怪物下标都写死 2）。
  所以它在参考里是个**纯标记**：照抄「什么都不做」。但它照样必须建模——它进快照，
  而且 `die` 那一格会把它摘掉（去掉它红 **120 例** = 整份文件）。
  这是「参考与真实游戏可能分歧」的候选，记进**待裁定**。
- **怪物侧再生（REGEN）** —— `Monster::applyEndOfTurnTriggers` 的**第五句**
  （金属化 → 易塑 → 镀甲 → 虚无缥缈 → **再生** → 枷锁）。⚠⚠ **一层都不掉**
  （参考那一句只有 `heal`，没有任何 `decrementStatus`）——与玩家侧那条「回血再 -1 层」
  不是一回事，两边共用同一个 `PowerId`。整条去掉红 **118 例**、补一个递减红 **120 例**。
  ✅ 装完这一条，`applyEndOfTurnTriggers` 那**六句现在全齐了**，名单封闭。
- **虚无（VOID）** —— 本项目第一张「抽到时有效果」的状态牌
  （`CardManager::draw` 里 `bc.player.energy = std::max(0, energy-1)`，`CardManager.cpp:426-429`，
  参考自注「游戏里是入队的，但我觉得直接做也行」）。它打不出、是虚无牌，
  与伤口 / 灼伤 / 恍惚同族**不进 `CARD_RULES`**，但要有 `CARD` 映射。去掉那 -1 红 **6 例**。

⚠⚠ **本批还改了一处共享路径：删掉了 `afterMonsterTurns` 末尾那句「场上没有活怪就判胜」。**
参考的 `BattleContext::afterMonsterTurns`（`BattleContext.cpp:2183-2246`）里**没有**这样一句
——它唯一与胜负有关的是 `if (isBattleOver) return;`，而 `isBattleOver` **全项目只在
`BattleContext::init` 里被赋过一次 false**（`:44`），是个死标志位。判胜的完整名单是
**怪物退场那一刻的四处**：`Monster::die` 的两条、逃跑、`Monster::suicideAction`。
那句一直是冗余的，**到觉醒者才变成错的**（一阶段假死时 `monstersAlive` 可以是 0 而参考
故意不判胜）。恢复它红 **2 例**。

⚠ **旧近似表的错误一并校正**：① 编队写的是**单怪**，而参考是 `CULTIST ×2 + AWAKENED_ONE`
（觉醒者在 **2 号位**）——那两只邪教徒每回合 +3 力量的仪式正是这场仗的时间压力来源。
② 招式表只有三条（斩击 / 灵魂打击 + 一条参考里**根本不存在**的「汲取」），
**整个二阶段（黑暗回响 40 / 污泥 18 + 虚无 / 冲撞 10×3）与重生全都缺失**。
③ 加权（45/35/20 + maxInARow）与参考的「两阶段 × 两档 roll」毫无关系。
④ `reviveHp: 300` 这个字段从来没有被任何代码读过（二阶段血量是复活那条 case 里
**另一个写死的字面量** `asc9 ? 320 : 300`），本批从数据里删掉。

⚠⚠ **本批第一次为了「让新代码被走到」换牌组**，见下方「牌组不是常量」。

**本批没有给参考打任何补丁。**

✅ **第三十八批：第三幕 Boss 时间吞噬者**（`time_eater`，harness 的 **variant 38**，
追加在 `act3Variants` 末尾）。数据 1 编队 × 40 种子 × 3 层 = 120 例 / **6.5MB**，
对拍 31306 → **31426 例**（仓库 614MB / 115 个文件）。**零扰动**（只有 1 个 `??`）。

- ⚠⚠ **时间扭曲（TIME_WARP）—— 本项目第一条「改回合结构」的 Power。** 结算点在
  `BattleContext::onAfterUseCard`（`BattleContext.cpp:1974-1985`）那条**共享出牌路径**上、
  且在 `item.triggerOnUse` 那道门里面，读的是**写死的 `monsters.arr[0]`**：
  ```cpp
  if (m.hasStatus<MS::TIME_WARP>()) {
      auto timeWarp = m.getStatus<MS::TIME_WARP>();
      if (timeWarp == 11) {
          m.setStatus<MS::TIME_WARP>(0); m.buff<MS::STRENGTH>(2); callEndTurnEarlySequence();
      } else {
          m.setStatus<MS::TIME_WARP>(timeWarp + 1);
          ++timeWarp;          // ← 局部变量自增、之后无人读
      }
  }
  ```
  ⚠ 三处照抄：① 阈值是 **`== 11`**（计数从 `buff<TIME_WARP>(0)` 起步，所以命中的是**第 12 张牌**）；
  ② `++timeWarp` 是**第 6 种死代码形状**——「局部变量自增之后无人读」，照抄 = 不写；
  ③ 归零走 `setStatus(0)` **只写数值、不碰 statusBits**，所以 Power **还在位置上**、
  计数继续涨（写成 `removeStatus` 红 **120 例**）。
  ⚠ 它是「位置上、层数 0」那一族（与蠕动血块的反应、巨头的缓慢同源），所以
  **开局那一帧快照里看不见它**，读点必须用 `hasStatus`（写成 `层数 > 0` 红 **120 例**）。
- ⚠⚠ **`callEndTurnEarlySequence()` —— 出牌中途强制结束玩家回合**
  （`BattleContext.cpp:2152-2161`，全参考**只有时间扭曲**调它）。它做三件事：
  排空出牌队列（`autoplay && !purgeOnUse` 的项转成 `Actions::TimeEaterPlayCardQueueItem`
  = 按 `triggerOnUse = false` 走一遍 `onAfterUseCard`，**牌白翻、直接进弃牌堆**；
  其余**直接丢弃**）、把 endTurn 项推到队**首**、置 `endTurnQueued`。
  与玩家点的 `endTurn()` 差三处：**推队首而不是队尾**、**没有 `energyWasted +=`**、
  **没有那句 `assert(!endTurnQueued)`**（当前三处都同解，形状照抄）。
  实测：整段排空循环去掉红 **26 例**，只丢弃不排动作红 **23 例**，
  丢回来的牌按 `triggerOnUse = true` 结算红 **23 例**。
  ⚠⚠ **它的排空循环没有牌组配合就是一段死代码**——见下方「牌组不是常量（第二次）」。
- **抽牌削减（DRAW_REDUCTION，玩家侧）** —— 头槌上的。⚠⚠ **数值不住在 Power 里**：
  `Player::debuff<DRAW_REDUCTION>` **无视 amount**、恒 `--cardDrawPerTurn` 并 `setHasStatus`
  （`Player.h:385-390`，所以 harness 恒输出 1），而归还在 `afterMonsterTurns`
  （`BattleContext.cpp:2227-2233`）里、**排在 `addToBot(DrawCards(cardDrawPerTurn))` 之后**，
  且带 skipFirst。四条各有背书：不减 `cardDrawPerTurn` 红 **113**、减 2 红 **113**、
  不置 `justApplied` 红 **113**、把归还提到抽牌之前红 **113**、整段归还去掉红 **109**。
- **一只新怪的四份工作** —— 456 血（Boss 档 `asc >= 9`，`{{456,456},{480,480}}`）、
  四条招式、**四段式出招规则**（`MonsterSpecific.cpp:3231-3270`，单次 rollMove 可以消耗
  **1 / 2 / 3** 次 aiRng：`random(50,99)` 重掷、`randomBoolean(0.66f)`、`random(74)` 单参重载）、
  以及**两种收尾形态并存**（混响 / 头槌是入队 `RollMove`，涟漪 / 加速是**同步的真 rollMove**）。
  ⚠ 加速那条 case 的顺序真的可观察：它自己置 `miscInfo`、把 `curHp` 抬到 `maxHp/2`，
  而紧接着的同步 rollMove 读的正是这两个字段——这就是「加速一场仗最多出一次」的实现。

两条新原语：**`set_hp_half_max`**（`curHp = maxHp / 2`，是**赋值**不是 `Monster::heal`）与
**`minAscension` 从 `apply_power` 铺到 `gain_block` / `add_card`**（加速 asc19 的 32 格挡、
头槌 asc19 的两张黏液，都是「case 里多出来的一整句」）。

⚠ **旧近似表的错误一并校正**：① 混响写的是 7×3 但**没有 asc4 档**、头槌 26 也没有；
② 头槌**根本没有抽牌削减以外的那两条**（asc19 的黏液缺失）、涟漪缺 asc19 的脆弱；
③ 加权（45/35/20 + maxInARow）与参考的四段式规则毫无关系；
④ `timeWarpEvery: 12` 这个字段表达的是「每 N 张」的周期，而真相是写死的 `== 11` 状态机
——**本批把字段本身删掉了**（见下一条）。

⚠ **顺带删掉两个 `EnemyDef` 字段**（判据同第十九批的 `modeShiftThreshold`、
第三十二批的 `deathEffects`、第三十六批的 `intangibleAfterMove`：**只剩一个错误的或零个
用户的字段就是第二份真相**）：

- **`reviveHp`** —— 第三十七批之后零读者零写者（觉醒者二阶段的血量是复活那条 case 里
  **另一个写死的字面量**）。那一批留了账、报进了报告，本批按批准删掉。
- **`timeWarpEvery`** —— 本批登记时间吞噬者之后同样零读者零写者。

**本批没有给参考打任何 gameplay 补丁**（只加了 harness 的 variant 38）。

✅ **第三十九批：第三幕收官（16 / 16）——迪卡与多努**（`donu_and_deca`，harness 的
**variant 39**，追加在 `act3Variants` 末尾）。数据 1 编队 × 40 种子 × 3 层 = 120 例 / **8.0MB**，
对拍 31426 → **31546 例**（仓库 622MB / 116 个文件）。**零扰动**（`git status` 只有 1 个 `??`）。

⚠⚠ **编队 id 与建怪顺序相反**：`MonsterEncounter::DONU_AND_DECA` 建的是
`createMonster(DECA); createMonster(DONU);`（`MonsterGroup.cpp:235-238`）
——**迪卡在 0 号位、多努在 1 号位**。两只怪身上写死的下标（迪卡给 `arr[1]` 加格挡、
多努给 `arr[0]` 加力量）全靠这个顺序，反了红 120 例。
我们侧的编队 id 跟着参考枚举从 `donu_deca` 改成 **`donu_and_deca`**
（同族先例：`the_guardian` 19 / `shell_parasite` 25 / `automaton` 28 / `collector` 29 / `maw` 33）。

- ⚠⚠ **本批带进来的不是新机制，而是第二十六批那三条「写死下标」原语的反例。**
  百夫长的防守（`if (getAliveCount() > 1) arr[1].addBlock(...)`）与秘法师的治疗 / 鼓舞
  （`if (monstersAlive > 1) arr[0]...`）**全都带门**；而迪卡的守护方阵
  （`MonsterSpecific.cpp:1689-1700`）与多努的能量之环（`:1677-1681`）**一道门都没有**，
  参考还在多努那句行尾自注 `// shouldn't matter if deca is dead`——它**知道**迪卡可能
  已经死了，并且**故意**不判。
  `buff_ally` 因此多了一位 `noAliveGate`（与第二十八批青铜球给 `gain_block_ally_fixed`
  加的那一位同名同形）。⚠ 但**两位的性质不同**：青铜球那位当前**可证同解**
  （球活着 ⇒ 自动机也活着），这一位**真的走到了 false 侧**——策略恒打 0 号位，
  迪卡先死 **60 / 120**，多努照样每两个怪物回合给尸体 +3 力量（实测补上那道门红 **45 例**）。
- ⚠ **守护方阵还有两处与百夫长不同**：① **自己也加 16**（百夫长一点都不加），而且排在
  给友军之前；② 两句都是**同步** `addBlock`（`Monster::addBlock` 就是 `block += amount`）。
- ⚠ **四条 case 的收尾全是同步 `setMove`**：`getMoveForRoll` 对两只各返回一个常量
  （`:3272-3278`，roll 掷出来但一个字都不读），此后再没有任何 `RollMove` / `NoOpRollMove`。
  于是整场仗的 `rng.ai` 计数器**恒是 2**（实测 120 条 trace 的取值集合就是 `{2}`），
  是全参考**唯一**一个「全员静态循环」的编队；两只的相位还是**相反**的
  （迪卡「光束 → 守护 → …」、多努「能量之环 → 光束 → …」）。
  ⚠ 一个直接后果：**四条招式的覆盖任何牌组都满足**（第二个怪物回合就全走过了），
  所以本批的牌组不是为「让招式被执行」选的，见下。
- ⚠ 迪卡的光束还往**弃牌堆**塞**两张恍惚**（`Actions::MakeTempCardInDiscard(DAZED, 2)`，
  `Actions.cpp:252-259` 循环里只有 `createTempCardInDiscard`，**一次 RNG 都不掷**
  ——与 `pile:"draw"` 那条每张掷一次 `cardRandomRng` 正相反）。
- ⚠ 两只**共用同一条 `preBattleAction`**（`MonsterSpecific.cpp:195-198`，两个 case 标签落在
  同一个函数体上）：`buff<MS::ARTIFACT>(asc19 ? 3 : 2)`。⚠ 分档是 **asc19**（Boss 那一族的
  **高**阈值），不是常见的 asc17。神器是第四 / 五个宿主（前三个：哨卫 1 / 球状守卫者 3 /
  青铜自动机 3），实测 120 条里 **104 条**看得见迪卡的神器被玩家的易伤扣掉。

⚠ **牌组沿用第三十八批那 59 张全升级的（逐字节相同），而且是量出来的**：22 张标准牌组下
120 / 120 条**一次都没打死过迪卡**，那条「无门的友军 buff」结构性没有预言机。七副候选的
对比表见「验证方式 · 第三十九批」。⚠ 两个 variant 的指纹（牌组内容 + 升级位 + 爬升度 +
目标策略）**完全相同**，所以 encounters 必须互不相交——variant 38 只点名 `TIME_EATER`、
variant 39 只点名 `DONU_AND_DECA`，与第二十四~二十九批共用 `BATCH_1 + SPOT_WEAKNESS`
是同一条规矩。

⚠ **旧近似表的错误一并校正**：① 守护方阵**只给自己加 16**（漏了「多努也加 16」这半条）；
② 光束**没有那两张恍惚**、也没有 asc4 分档；③ 能量之环写成
`apply_power + on: "all_enemies"`（参考是「写死 0 号位 + 自己」，三只以上的编队会分岔）；
④ 两只的加权表（50/50 + `maxInARow`）与参考的「开局常量 + 之后严格交替」毫无关系，整份弃用。

⚠ **「未迁移编队」的两条测试样本本批被自己顶掉**（`donu_deca`），换成 **`the_heart`**。
⚠⚠ 顺带**推翻了第三十五批否决第四幕的那条理由的一半**：两条用例的代价其实不同——
`sts-combat-wiring.test.ts` 那条只需要「一个不在 `SUPPORTED_ENCOUNTERS` 里的字符串」
（`stsCombatCoverage` 第一句就短路，根本不查 `enemies.ts`），**零新数据**；
而 `sts-combat-rules.test.ts` 那条要真的走进 `initCombat`，所以仍然需要一只
「在 `enemies.ts` 里、却不在 `MOVE_RULES` 里」的怪。本批之后 `enemies.ts` 里**一只都没有**了，
故给 `corrupt_heart` 补了**只有血量、没有招式**的一条 def（血量是 `MonsterIds.h:165` 逐字抄的
`{{750,750},{800,800}}`，第四幕那一批会直接用上）。逐条理由写在两个测试文件里。

**本批没有给参考打任何 gameplay 补丁**（只加了 harness 的 variant 39）。
第三幕的收官清单见文末「第三幕完成度小结」。

#### 第二十四批的验证（⚠ 由复核方补写，见下）

本批的 Agent 连续两次在**写文档阶段**被打断（一次 watchdog、一次 API 529），
实现与 trace 数据都已落盘且经复核，但**它自己那份变异测试表没有交付**。
下面是复核方独立量到的数字，**只有这些是有据的**；Agent 侧可能量过的其它条目一律没有记录，
不要当成「量过且非 0」。缺口如实留在这里。

复核方实测（基线 19831 例）：

| 变异                                   | 例数    | 判读                                                                                                                                                                                       |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 伤害减半的判据 `hasPower` → `层数 > 0` | **155** | 有背书。这正是代码注释里点名「最容易抄错」的那处——摔下来（层数 0）之后伤害**照样减半**，写成层数判断会让眩晕那回合的伤害翻倍                                                               |
| `isMonsterAttacking` 谓词恒真          | **294** | 见上，其中 248 例来自本批                                                                                                                                                                  |
| 摔落判据「减前恰为 1」→「减后 ≤ 0」    | **0**   | **盲区**。两者只在 0 → −1 那一击上分岔，而那时拜鸟已经是眩晕意图，`setMove` 再设一次同一个意图，差别只落在 `moveHistory[1]`——不在快照里。与第十三批「尖刺小的 `no_op_roll` vs `roll`」同源 |
| 去掉 `&& damage > 0`                   | **0**   | **不是盲区，是等价改写**：调用方已经有 `if (damage > 0)` 的门（代码注释里写明了照抄的理由）。记在这里以免下一个人把它当成盲区去追                                                          |

另外复核方逐条核过参考的 `Monster.cpp:348-396` 那条 else-if 链：
参考顺序是 无敌 → 镀甲 → 蜷缩 → **飞行** → 易塑/反应 → 荆棘 → 沉睡 → 变换，
我们侧在已登记的怪里的相对次序（蜷缩 → 飞行 → 易塑）与之一致；
无敌与镀甲对应的怪还没登记（镀甲是带壳寄生虫，第二十五批）。

「卡牌 108 + 1」里的 +1 是**状态牌黏液**（`slimed`，第十三批）。它不算在「铁甲 + 116」那条
铺量线里——状态牌不属于任何角色，也不进任何奖励池。~~⚠ 它是目前唯一一条没有 trace 背书的登记~~
**第十四批已补齐背书**：`large_slime` 里它被真的打出 **46 次**（分布在 36 条 trace 上），
费用 / 消耗 / 可打出三条属性各自的变异都红 36 例。
**第十九批把这条背书加厚了一个量级**：史莱姆王一次喷 3 张、还会分裂成两代大 / 中史莱姆，
打出次数从 46 涨到 **1511**，那三条变异的例数见下方「验证方式 · 第十九批」的重量小节。

「全量」按参考项目的枚举算（`MonsterIds.h` 65 项、`MonsterEncounters.h` 63 项）。
早先这张表把怪物写成 227，那是错的。

**预言机能背书的范围现在是「第一幕 20 个编队 + 第二幕全部 19 个」**（第二十九批收官）。
第一幕那 20 个来自 harness 冻结的 `encounters` 列表（实测走到 25 只怪，含分裂产生的）；
第二幕从第二十三批起走**第二个乘积**，`act2Encounters` 一次列全了 19 个编队、每批只追加一个
filter 到本批的新 variant（见 WORKFLOW），到第二十九批七个 variant 把 19 个装满、
走到 **17 只**新怪。第三幕照此再追加第三个乘积。

未登记的内容会**显式抛错**，不会静默错配 RNG。

## 待办

### 一、接线（决定「换代是否完成」）

1. ~~`run.ts` / `engine.ts` 改用 `sts-combat.ts`~~ **已完成**（`combat-bridge.ts`）
2. ~~状态结构对接：`GameState.combat` ↔ `BattleContext`~~ **已完成**（`exportState` / `importState`）
3. ~~删除近似战斗~~ **已完成**
4. 接 `sts-encounters`：决定「哪场仗」。一次生成三幕全部序列（`monsterRng` 单条持久流，
   act2/3 续 counter），run 开局算一次存下来后按序索引。要写 `MonsterEncounter` 枚举（63 项）
   → 我们的编队 id 的映射。**这一项直接影响战斗保真度**：战斗按 `Random(seed + floorNum)`
   播种，「哪场仗在第几层」不对，逐位精确的战斗打的也不是原版那一场。
5. 接 `sts-map`：决定楼层与房间类型。每幕 `Random(seed + offset)`，自成一体；要写
   `{x, y, edges, parents}` → 我们的 `MapGraph` 的适配。
6. 接 `sts-neow`：19 种 bonus × 6 种 drawback，其中效果要逐个实现（不是纯映射，工作量最大）。
7. 游戏级 run 层：奖励（`cardRng`）、遗物池（`relicRng`）、药水掉落（`potionRng` 的 run 级消耗）、
   事件（`eventRng`）、商店（`merchantRng`）、宝箱（`treasureRng`）。**全都还没有实现**，
   这是新写而非接线。做完这一项才能删掉玩具 `rng.ts`。
8. 战斗外喝药水：随近似实现一起删了，等第 7 项落地时重写（见 `combat-bridge.ts` 的 TODO）。
9. ⚠⚠ **`stsCombatCoverage` 不查遗物**（第四十一批发现）。它逐条查编队 / 牌 / 药水，
   却**没有** `state.relics` 那一段——而 `isRelicSupported` 是导出的、**零调用者**。
   后果：带着一颗尚未转写的遗物照样开得了战，那颗遗物在战斗内**静默无效**。
   这正是本项目最不接受的形态（「登记了却错的内容会静默产出错误数值」）。
   ⚠ 补它**不是**纯接线：现在只转写了 87 / 180 颗，一加这道门，绝大多数遗物组合都会被
   拒绝开战。所以要与「run 层遗物池」（第 7 项）一起排，或者先加成**可选的严格模式**。
10. ~~`RelicInstance.data`：`initRelics` 读、`updateRelicsOnExit` 写回~~ ✅ **第四十四批完成**。
    `BattleContext.relics` 从 `string[]` 变成 `{id, data}[]`，玩家多了一份 `relicBits`
    （对齐 `Player::relicBits0/1`——**它与遗物容器不是一回事**，四处 `setHasRelic` 只改它），
    `combat-bridge` 两头搬运 run 层的 `RelicState.counter`，`migrate.ts` 无损回填。
    ⚠ **写回那一半没有 trace 预言机**：一条 trace 就是一场战斗，写回去的值下一场才被读到。
    它的正确性由 `initRelics` 那一半（`@relic12` 发了非 0 的 `data`）与 wiring 用例一起守。
    ⚠ 参考的 `exitBattle` 里还有一条**御守 / 暗石护符**的特例（蠕动血块植入过寄生虫时扣一层
    充能，否则往牌组里塞一张寄生虫）——扣充能那一支做了，塞寄生虫那一支留 TODO
    （`parasite` 还不在 `cards.ts` 里）。

### 二、内容铺量

按登记表逐条转写参考项目的精确行为，范围先限定铁甲 + 无色（**8 张，全部永久跳过**）。

第十二批之后，红 + 无色剩下的 8 张**一张都不该登记**——它们全部没有预言机：

- `forethought` 深谋远虑 —— 参考的升级分支整段被注释掉，且多选那一整套压根不存在，
  补它是**发明而非转写**（详见下方「数据表与参考/真实游戏冲突 · 待裁定」）
- 参考**压根没实现**的 7 张：`shiv` / `smite` / `through_violence` / `insight` / `miracle` /
  `safety` / `seek`（三个 switch 里都没 case，永远不会有预言机；`seek` 还兼任
  `sts-combat-wiring.test.ts` 那条「未迁移卡牌」用例的样本，见文末）

**也就是说「铁甲 + 无色」这条铺量线到第十二批为止已经走完了**（108 / 116）。下一步的铺量
只能往别的方向去：怪物（4 / 65）、遗物（8 / 168，**第四十批起 13 / 168，第四十二批起 20 / 168，
第四十三批起 58 / 168，第四十四批起 87 / 180**——分母变了是因为那一批把 `relics.ts` 与参考的
`RelicId` 做了全表比对、补齐了缺的 12 条）、药水（13 / 42）、编队（5 / 63），
或者把范围扩到别的角色（那要先补姿态 / 充能球两套机制）。

#### 怪物与编队的批次计划（第十三批起）

单位是**编队**，因为预言机按编队分文件。依赖关系已用实测的「招式 × 编队执行矩阵」定过，
不是拍脑袋排的（工具与判据见 WORKFLOW「生成并安装」）。

| 批       | 编队                                                     | 新怪物                       | 主要新机制                                               |
| -------- | -------------------------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| ~~十三~~ | ~~`small_slimes` `lots_of_slimes`~~                      | ~~酸/尖刺史莱姆 M、S 四只~~  | **已完成**（黏液牌、脆弱、编队组合抽样、招式收尾三形态） |
| ~~十四~~ | ~~`large_slime`~~                                        | ~~酸/尖刺史莱姆 L~~          | **已完成**（分裂、掉血触发、招式收尾第四形态；黏液转绿） |
| ~~十五~~ | ~~`blue_slaver` `red_slaver` `looter` `exordium_thugs`~~ | ~~蓝/红奴隶主、抢劫者~~      | **已完成**（纠缠、逃跑、偷金、「构造全部再选一」）       |
| ~~十六~~ | ~~`exordium_wildlife`~~                                  | ~~真菌兽~~                   | **已完成**（孢子云 = 第一个死亡触发；红奴隶主缠绕补丁）  |
| ~~十七~~ | ~~`gremlin_gang`~~                                       | ~~地精五只~~                 | **已完成**（池抽 4、给友方加格挡、蓄力计数、狂怒）       |
| ~~十八~~ | ~~`gremlin_nob` `lagavulin` `three_sentries`~~           | ~~地精头目、拉加维林、哨卫~~ | **已完成**（激怒、沉睡/苏醒+金属化、**神器**、恍惚）     |
| ~~十九~~ | ~~`the_guardian` `slime_boss`~~                          | ~~守卫者、史莱姆王~~         | **已完成**（形态切换、尖锐外壳、Boss 分裂；黏液加厚）    |
| ~~二十~~ | ~~`hexaghost`~~                                          | ~~六火幽魂~~                 | **已完成**（激活锁伤、固定七招循环、灼伤+；第一幕收官）  |

| ~~二十一~~ | ~~14 个普通编队 × **爬升度 19**~~ | ~~（无新怪）19 只怪的 asc 分档~~ | **已完成**（爬升度这条轴；`hpHigh` / `ascAmount` / `minAscension`） |

✅ **第一幕的「爬升度 0」这一维铺量到此为止。** 20 个编队全部装完，`ENC_V0` 的 asc0 段里
再没有可加的名字；下一条战线（爬升度剩余 6 个编队 / 第二幕 / 遗物 / 药水）的输入见文末
「第一幕完成度小结」。

⚠ **第二十一批不加怪、不加编队，加的是一条正交的轴。** 它把 `MonsterSpecific.cpp` 里
185 处 `ascension >= N` 从死代码变成活代码——做法、两步验证、以及「一个档位为什么就够」
写在 WORKFLOW 的「爬升度这条轴」一节。**第二十二批要另开一个 variant** 装剩下 6 个
（三精英 + 三 Boss），**不要**往第二十一批那个 variant 的 `encounters` 里加，
那会平移它之后的所有 `traceIdx`。

⚠ **第二十批是单编队单怪，但六条招式的覆盖是历批最均匀的**（「执行」栏 274~1243，
最薄的地狱之火也有 274）。原因是结构性的：六火幽魂 250 血、出招序**完全固定**，
不像守卫者那样会被 `onHpLost` 顶掉意图，所以每一招都按周期稳定轮到。
⚠ 唯一要留意的分母是 `HEXAGHOST_INFLAME` 372 / `HEXAGHOST_ACTIVATE` 375——
差的 3 条是「打完 5 个回合就赢了、轮不到燃焰」。

⚠ **第十九批两个编队各自是它那只怪唯一的来源**，与第十六~~十八批同族，但覆盖厚薄**极不均匀**：
两只都是 Boss（240 / 140 血），仗长得多，十一条招式的「执行」栏从 **4** 到 **837** 横跨两个量级。
`THE_GUARDIAN_VENT_STEAM` 只有 **4** 次执行——**整条怪物线里最薄的一条**，原因是结构性的：
泄气排在重砸之后，而守卫者往往在重砸之前就被打到形态切换、意图被 `onHpLost` 顶掉。
所以本批凡是只挂在泄气上的变异都是个位数（实测 2~~4 例），**出现 0 才是盲区**。

⚠ **第十八批的三个编队各自是它那只怪唯一的来源**，与第十六/十七批同族。但这一批的覆盖
反而是历批最厚的（八条招式「执行」栏 270~1712）：三个都是**精英**，血厚、仗长，
`LAGAVULIN_ATTACK` 一条就执行了 1000 次。所以本批的个位数例数**极少**，出现 0 就真是盲区。
⚠ **恍惚（`DAZED`）不需要新登记**：它早就在 `cards.ts` 里（第五批凭空造牌那批带进来的），
也早就在 `sts-combat-trace.test.ts` 的 `CARD` 映射里。它与黏液的关键差别是
**`CardInstance.cpp:329` 的例外只放行 `SLIMED`**，所以恍惚**永远打不出**、
不进 `CARD_RULES`、也不能进 `check-coverage.mjs` 的 `--no-upgrade` 段
（那一段要求「未升级栏非 0」= 要求它被打出过，放进去就是必然失败）。
它唯一的可观察面是**躺在牌堆快照里**以及**回合末因 Ethereal 被消耗**。

⚠ **第十五批把 `exordium_thugs` 和抢劫者绑在一起是必需的，不是凑批。** 实测：
`LOOTER_ESCAPE` 在 `looter.jsonl` 里出现 16 次、**执行 0 次**——单挑抢劫者的战斗永远在
第 5 回合的怪物阶段之前就结束了。它唯一有背书的地方是 `exordium_thugs`（执行 16 次）。
同类事实：真菌兽只在 `exordium_wildlife` 里出现，小鬼巫师/盾牌小鬼只在 `gremlin_gang` 里。
⚠ **第十七批把「只在一个编队里」又推进了一层**：五只地精只出现在 `gremlin_gang`，
而且是「8 选 4」的抽样结果——护盾地精与巫师在候选表里**各只占 1/8**，于是它俩的血量变异
只有 124 / 150 例（另外三只 232~264）。更极端的是 `SHIELD_GREMLIN_SHIELD_BASH`：
它只在**护盾地精落单**时才出，全份数据里执行 **15** 次，盾击伤害那条变异因此只有 **9** 例。
⚠ **薄不等于没有，但每条变异都要单独看数字**——不能拿同一只怪别的招式的量级去推它。
⚠ **第十六批实测印证了「只在一个编队里」的代价**：`FUNGI_BEAST_BITE` 执行 32 次、
`FUNGI_BEAST_GROW` 19 次（历批最薄），于是它的出招阈值只被 2 例钉住（60→61），
`60→59` 那个方向是 **0 例**。薄不等于没有，但**每条变异都要单独看数字**，不能拿
别的怪的量级去推它。
**装完复核：四个文件的实际数字是 `looter.jsonl` 逃跑 0 条、`exordium_thugs.jsonl` 16 条，
与开跑前的预测逐条一致**，逃跑那三条变异各红 16 例（见下方「验证方式 · 第十五批」）。

选牌屏、牌生命周期、玩家事件钩子、卡牌实例级状态、随机卡池取牌、出牌队列嵌套、X 费、
四个小机制那八批已做（见下方第三项）。剩下卡在这些子系统上：

- ~~`add_random_colorless` / `add_random_cards_to_draw`~~ **第八批已完成**
  （战斗内卡池 + `cardRandomRng` 取样，见下方第三项）
- ~~`play_top_card` / `copy_hand_card` / 「下 N 张攻击牌打两次」~~ **第九批已完成**
  （出牌队列嵌套，见下方第三项）
- **`freeToPlayOnce`**（逐实例的「下次打出免能量」）—— 第七批把 `cost` / `costForTurn` /
  `specialData` 三个字段做了，唯独没做它：唯一的产出者是深谋远虑，而那张牌的参考侧
  升级分支整段被注释掉（见下表），没有预言机就不写
- ~~`deal_damage_perfected` / `deal_damage_if_hand_all_attacks` / `schedule_bomb` /
  `deal_damage_kill_gold`~~ **第十一批已完成**（打击计数 / 打出门槛 / 回合计时器 /
  战斗内金币，见下方第三项）
- 各 1 张：`double_block`、`double_strength`、`deal_damage_random`、
  `exhaust_non_attacks`、`exhaust_non_attacks_gain_block` 等（都在**别的角色**的牌上，
  当前范围外）

第四批点名跳过的（连同原因）：

| 卡                     | 为什么跳过                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seek` 搜寻            | 参考项目三个 switch 里都没有 case，等于没实现——没有预言机可背书                                                                                               |
| ~~`discovery` 发现~~   | **第八批已登记**（战斗内卡池 + 3 张候选的选牌屏 + 逐实例本回合 0 费）                                                                                         |
| `forethought` 深谋远虑 | 参考的**升级分支整段被注释掉**（`Actions.cpp:793-795`），升级态退化成未升级行为。全升级 variant 会照着错的跑，等于没有预言机。另外还需逐实例 `freeToPlayOnce` |
| `dual_wield` 双持      | 机制齐了（`createTempCardInHand` + 手牌重排），但参考自己注明「dual wield is so fucking buggy」且要新分配 uid；本批优先把选牌屏做扎实，留给下一批             |
| ~~`violence` 暴力~~    | **第十二批已登记**（参考侧那个 `return`/`break` 的凭空复制已随登记一起修）                                                                                    |

第五批（牌的生命周期）点名跳过的：

| 卡                                                         | 为什么跳过                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apparition` 幻影                                          | 以太本身已经做了，缺的只有 INTANGIBLE（把伤害压成 1）。另外参考的 `isCardEthereal` 对它是 `!upgraded`，登记时要给数据表加 `upgradedEthereal` |
| ~~`dark_shackles` 黑暗镣铐~~                               | **第十二批已登记**（参考侧两处 bug 已随登记一起修，`Monster::applyEndOfTurnTriggers` 一并做了）                                              |
| ~~`sentinel` 哨兵~~                                        | **第六批已登记**（同步回能量，见下方事件钩子一节）                                                                                           |
| `necronomicurse` 死灵诅咒                                  | 同挂在 `triggerAndMoveToExhaustPile` 上（入口已就位），但要把自己变一张回手，还缺凭空造牌之外的东西                                          |
| `corruption` 腐化 / `havoc` 混乱 / `mayhem` 暴乱           | 抽牌与进手的时点已经打通（`drawOneCard` / `moveToHandHelper` 里都留了 TODO），但三张都要逐实例 `costForTurn`                                 |
| `decay` 腐朽 / `doubt` 怀疑 / `shame` 羞耻 / `regret` 悔恨 | 回合末在手里结算的诅咒牌，`useNoTriggerCard` 已经能接（灼伤就走它），但这四张目前**没有任何入手途径**                                        |
| `void` 虚无                                                | 抽到时 -1 能量，钩子位置在 `drawOneCard` 里已标注；同样没有入手途径（要遗物 / 怪物）                                                         |

第六批（玩家的事件钩子）点名跳过的：

| 卡                  | 为什么跳过                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apparition` 幻影   | 同第五批：缺 INTANGIBLE，**而且**要给 `CardDef` 加 `upgradedEthereal`（参考的 `isCardEthereal` 对它是 `!upgraded`）。动类型定义按 WORKFLOW 第 5 步要先报告不要自己拍板，故仍跳过                                                                        |
| ~~`dark_shackles`~~ | **第十二批已登记**（参考侧两处 bug 已随登记一起修，`Monster::applyEndOfTurnTriggers` 一并做了）                                                                                                                                                         |
| `pain` 剧痛         | 挂在 `triggerOnOtherCardPlayed`（每打出一张牌失 1 血）。钩子位置已在 `useCard` 里标注，但这张诅咒牌**没有入手途径**；且参考对它的 `PlayerLoseHp(1)` 没传 selfDamage——与暴虐同一类漏传，暴虐已随第七批修掉，剧痛按「补丁跟着登记一起打」留到登记它那一批 |
| `thousand_cuts`     | 同挂 `triggerOnOtherCardPlayed`，是观者/静默的牌，当前范围外                                                                                                                                                                                            |
| `after_image`       | 挂在三个 `onUseXxxCard` 上（每打出一张牌加格挡），静默的牌，当前范围外                                                                                                                                                                                  |

第七批（卡牌实例级状态）点名跳过的：

| 卡                     | 为什么跳过                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forethought` 深谋远虑 | 参考的**升级分支整段被注释掉**（`Actions.cpp:784-806`），全升级 variant 会照错的跑。把它补上不是转写而是**发明**：参考侧只有单选的 `chooseForethoughtCard(int)`，`FORETHOUGHT` 也只在 `isValidSingleCardSelectAction` / `enumerateCardSelectActions` 的单选分支里，多选那套（`chooseForethoughtCards` + 校验 + 枚举）全都不存在。按 WORKFLOW 第 5 步留给人裁定，见本批报告 |

它也是 `freeToPlayOnce` 唯一的产出者，所以那个字段这一批一并没加。

第八批（随机卡池取牌）点名跳过的：

| 卡                       | 为什么跳过                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`transmutation` 嬗变~~ | **第十批已登记**（X 费整套，见下方第三项）                                                                                                                                 |
| `forethought` 深谋远虑   | 同第七批：参考的升级分支整段被注释掉，补它是发明而非转写。⚠ 它现在会被**多面手/发现随机造出来**躺在手牌里，但 harness 的 `isReplayableCard` 不让打，所以只是个牌堆里的名字 |

第九批（出牌队列嵌套）点名跳过的：

| 卡                                                        | 为什么跳过                                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `burst` 爆发 / `duplication`(药水) / `echo_form` 回响成型 | 与二连击同族（都在 `onUseXxxCard` 里 `queuePurgeCard`），机制这一批已经做好了。爆发挂 `onUseSkillCard`、回响成型挂三种牌型且带 `echoFormCardsDoubled` 计数器，两个钩子函数本身还没转写；回响成型还是观者的牌，当前范围外 |
| `necronomicon` 死藤（遗物）                               | 同样走 `queuePurgeCard`，但它读 `item.freeToPlay` / `isXCost()`，且属于遗物 PR                                                                                                                                           |

第十批（X 费）点名跳过的：

| 卡                                                              | 为什么跳过                                                                                                                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skewer` 劈砍 / `reinforced_body` 强化躯体 / `malaise` 病态 …   | X 费机制这一批做完了，但这些牌全是**别的角色**的（静默 / 观者 / 机器人），当前范围外。参考的 `isXCost` 名单共 10 张，铁甲 + 无色只有旋风斩与嬗变两张                                     |
| `forethought` 深谋远虑                                          | 同第七、八批：参考的升级分支整段被注释掉，补它是发明而非转写。它也是 `freeToPlayOnce` 唯一的产出者，而 X 费的 `useEnergy = !(freeToPlay \|\| freeToPlayOnce)` 里那半个条件因此仍然是死的 |
| ~~`perfected_strike` / `clash` / `the_bomb` / `hand_of_greed`~~ | **第十一批已登记**（四个小机制，见下方第三项）                                                                                                                                           |
| ~~`dark_shackles` / `violence`~~                                | **第十二批已登记**（两张的参考侧 bug 都已随登记一起修）                                                                                                                                  |

⚠ **本批在 harness 侧挖出一个从第九批就潜伏着的洞**（已修，见「已知偏离」下方那条）：
`isReplayableCard` 只管**策略从手牌里挑什么**，管不住 `playTopCardInDrawPile`——浩劫 / 混乱
把选择权交给参考，参考取抽牌堆顶那张、不看任何门。variants 7/8 里第八批的造牌卡
造出了浩劫与混乱，它们各打出了一张**未登记**的 `clash`，重放当场抛「暂未登记卡牌行为」。
这直接影响本批的**数据布局**：嬗变从无色池取牌（34 张里 9 张未登记），与混乱同处一副牌组
必然在某一刻让混乱把造出来的未登记牌打出去，所以**第十批的牌组必须拆成两对 variant**
（混乱跟旋风斩/神化走、嬗变自己一对）。下一批凡是要往聚焦牌组里放混乱的，先想清楚这一条。

第十一批（四个小机制）点名跳过的：**没有**。四张全部登记。

第十二批（怪物回合末触发 / 从抽牌堆随机检索）点名跳过的：**没有**。两张全部登记，
铁甲 + 无色这条线因此走完（108 / 116，剩下 8 张见上方「二、内容铺量」，一张都不该登记）。

⚠ 第十二批在参考侧打了**三个**补丁（详见下方「已修正」）。第三个（贪婪之手走 `attacked`）
**不是本批新卡的**，而是第十一批实测记下的那条——它会改数据，所以按「补丁跟着登记一起打」
的同一条理由留到有本批重生成时才打，我们 TS 侧的 `hand_of_greed` 同步改掉。
它的可观察面窄得很有意思：`Monster::damage` 与 `attacked` 的差别**只有** `onAttacked` 链，
而当前唯一转写了的那一条是**蜷缩**（只有虱子有）——所以重生成后 variants 15/16 里
`two_louse` 变了、`cultist` 逐字节未变。

第十三批（怪物/编队这条线的第一批）点名跳过的：

| 跳过的                                                    | 为什么跳过                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 四只怪的 **asc≥17 出招分支**                              | 酸液史莱姆 M / S 的 asc17 是**另一整块** `getMoveForRoll`（M 的阈值 40/80、第二段改用 `lastTwoMoves`；S 直接返回舔舐且**不掷** `randomBoolean`）。当前 trace 全是 asc0，写了没有预言机。已在 `MOVE_RULES` 留 TODO   |
| 四只怪的 **asc≥7 血量区间**                               | `monsterHpRange` 每只怪有两组，`enemies.ts` 只放得下一组。这是**从第一批就在的**结构性缺口（邪教徒/颚虫/虱子同样只有 asc0 那组），不是本批引入的，见下方「数据表与参考冲突 · 待裁定」                               |
| ~~**分裂**（`largeSlimeSplit`）~~                         | L 号史莱姆才有。**第十四批已完成**                                                                                                                                                                                  |
| `Monster::applyEndOfTurnTriggers` 的**易塑**（MALLEABLE） | ⚠ 这一条**当时写错了**：参考全项目只有蛇草与蠕动血块 buff MALLEABLE（`MonsterSpecific.cpp:213 / :249`），史莱姆一族**一只都没有**（L 号与史莱姆王都没有）。第十四批登记 L 号时复核发现，见下方「已修正 · 第十四批」 |

第十四批（分裂）点名跳过的：

| 跳过的                                       | 为什么跳过                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两只怪的 **asc≥17 出招分支**                 | 酸液 L 的 asc17 是**另一整块**（阈值 40/80）。⚠ 参考那块的第一段写的是 `lastTwoMoves(ACID_SLIME_M_CORROSIVE_SPIT)`——**M 号**的枚举，看着像笔误，但 trace 全是 asc0，没有预言机能判它，故整块不转写、也不报补丁 |
| 两只怪的 **asc≥7 血量区间**                  | 同第十三批，是从第一批就在的结构性缺口                                                                                                                                                                         |
| ~~**贤者之石**（`PHILOSOPHERS_STONE`）~~     | ~~`largeSlimeSplit` 会给分裂出来的两只各 +1 力量（`MonsterSpecific.cpp:3406`），但 harness 的遗物轮换只有八个，里面没有它~~ ✅ **第四十批已补**（`large_slime@relic1`），例数见「验证方式 · 第四十批」         |
| **史莱姆王的分裂**（`slimeBossSplit`）       | 形状与 `largeSlimeSplit` **不同**（idx1=0/idx2=2、`monsterCount=3` 预留空位、`monsterTurnIdx=3` 直接赋值、**不掷** noOpRollMove、不设 `extraRollMoveOnTurn`），第十九批                                        |
| **「分裂目标格已有怪」那一支**               | 参考往定长数组 `arr[idx2]` 写、右边有怪就顶掉，而 `monsterCount` 照样 `min(count+1,4)`。这只有史莱姆王那条链才可能出现，`large_slime` 恒是「场上只剩它自己」。`splitMonster` 里留了一道**显式抛错**而不是猜    |
| `Monster::onHpLost` 的**守卫者模式切换**分支 | 同一个 switch 里的另一支（读 `MODE_SHIFT` 层数、归零时 `setMove` + `addToBot(MonsterGainBlock(20))`），第十九批。已在 `MONSTER_ON_HP_LOST` 留 TODO                                                             |

第十五批（纠缠 / 逃跑 / 偷金 / 构造全部再选一）点名跳过的：

| 跳过的                                                 | 为什么跳过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三只怪的 **asc≥2 / asc≥7 / asc≥17 分档**               | 与第十三/十四批同源的结构性缺口（伤害档 `asc2 ? 13 : 12` 那一族、血量第二组、蓝/红奴隶主的 asc17 连续限制）。harness 固定 asc0，写了没有预言机。asc17 那两条**内联**在同一表达式里，故已随主体一并转写，只是永远走不到                                                                                                                                                                                                                                                                                                                      |
| **`Monster::miscInfo`**（怪物侧的通用整数字段）        | 抢劫者用它累加「偷走了多少金币」，只被战斗**之后**的 `exitBattle` 读（`g.info.stolenGold`，还钱给玩家），战斗内没有任何东西读它。属 run 层第 7 项，故不建模，`monsterEscape` 里留了 TODO                                                                                                                                                                                                                                                                                                                                                    |
| **红奴隶主的「缠绕一场只用一次」**                     | ⚠ 参考里**根本没生效**（`usedEntangle` 读的 `miscInfo` 全项目没有写入点），本批照抄参考。看着像笔误但连带要裁定第二段的阈值，按 WORKFLOW 第 5 步不自行拍板，见下方「待裁定」                                                                                                                                                                                                                                                                                                                                                                |
| **劫匪（MUGGER）**                                     | 与抢劫者同族（共用 THIEVERY 的 preBattleAction、同样有逃跑），但它是第二/三幕的怪，第一幕的 20 个编队里没有它——写了没有预言机                                                                                                                                                                                                                                                                                                                                                                                                               |
| ~~**`Monster::halfDead`**（僧侣 / 觉醒者的「假死」）~~ | ✅ **第三十四批结清**（暗影客的重生）。`isDeadOrEscaped` 的第三位现在真的被走到：`CombatMonster.halfDead` 独立建模，`doMonsterTurn` 的门改回 `(!isDeadOrEscaped() \|\| isHalfDead())`（去掉这条放行红 **113 例**）。另外两个循环（`applyPreTurnLogic` / `applyEndOfRoundPowers`）的门是 `isDying() \|\| isEscaping()`，它们照样跳过半死的怪（半死必然伴随 `curHp == 0`），故那两处仍写 `!alive`。✅ **第三十七批把最后一个写入点也装上了**：觉醒者的假死（`Monster::die` 的**第一个**分支，排在判胜 `return` **之前**）。这一位从此名单封闭 |

第十六批（孢子云 / 死亡触发）点名跳过的：

| 跳过的                                   | 为什么跳过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Monster::die` 里**其余五条死亡触发**    | ~~停滞（`STASIS`，还牌）~~ **第二十八批已补**；~~暗影客的重生（`REGROW`）~~ **第三十四批已补**（那条 else-if 链的三格现在全齐：孢子云 → 重生 → 停滞）。~~觉醒者的假死~~ **第三十七批已补**（`Monster::die` 的**第一个**分支，⚠ 它排在判胜 `return` **之前**，不在那条 else-if 链上）。~~地精之角~~ **第四十批已补**（不在轮换里那条限制随 `DeckVariant.relics` 解除）。仍缺：尸爆（`CORPSE_EXPLOSION`，静默的牌）；**活体样本永远不补**——参考给它排的 InputState 没有任何消费者，见「遗物 / 药水」一节。`monsterDie` 里留了 TODO |
| 真菌兽的 **asc≥7 血量区间**（`{24,28}`） | 与第十三~十五批同源的结构性缺口（harness 固定 asc0）。⚠ 这只怪**没有** asc 出招分档、也没有 asc 伤害档——`getMoveForRoll` 阈值恒 60、撕咬恒 6，成长的 `strengthBuff[hallwayIdx]` 那条 asc 分档已随主体转写（走不到而已）                                                                                                                                                                                                                                                                                                          |
| **`TWO_FUNGI_BEASTS`**（两只真菌兽）     | 第一幕的 20 个编队里有它，但 harness 的 `encounters` 列表**没有**它（那个列表不能动，动了所有 `traceIdx` 会平移）。它是「两只带孢子云的怪」，正是死亡触发**在同伴还活着时**最容易被观察到的编队——等给 harness 追加循环那一批                                                                                                                                                                                                                                                                                                     |
| **`Monster::miscInfo` 的其余用法**       | 本批把 `rolledDamage` 改名回 `miscInfo`（参考只有一个字段、含义逐怪种不同），但只用到虱子咬击伤害与红奴隶主 `usedEntangle` 两种。~~仍缺：地精巫师的蓄力位~~（**第十七批已补**）。仍缺：刺穿之书的连刺计数、暗影的咬击伤害、六火幽魂的分割伤害、蠕动血块的位掩码                                                                                                                                                                                                                                                                  |

第十七批（地精五只 / 池抽 4 / 给友方加格挡 / 蓄力计数 / 狂怒）点名跳过的：

| 跳过的                                                | 为什么跳过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 五只怪的 **asc≥2 / asc≥7 / asc≥17 分档**              | 与第十三~十六批同源的结构性缺口：五个招式的伤害都是 `asc2 ? x : y`、血量第二组、肥胖地精 asc17 追加的脆弱、护盾地精的 `blockAmounts[getTriIdx(asc,7,17)]`、狂暴地精 `ANGRY` 的 `asc17 ? 2 : 1`、巫师大招 asc17 **不回蓄力**。harness 固定 asc0，写了没有预言机。asc 内联在同一表达式里的（狂怒层数、大招那道门）已随主体转写，只是永远走不到                                                                                                                                                                                                                                                                         |
| **`Monster::escapeNext`**（地精逃跑）                 | 狂暴 / 鬼祟 / 肥胖三只的 case 尾部都是 `if (doesEscapeNext()) setMove(GENERIC_ESCAPE_MOVE) else …`，⚠ 而 `escapeNext` 在参考里**全项目没有任何写入点**（只有 `Monster.h:47` 的初值 false 与 `Monster.cpp:262` 的 getter）。本批只转写 else 那一支、不建模字段、也不打补丁。⚠⚠ **当时记的关门条件（「装上 `GREMLIN_LEADER` 那一批再打」）已被第二十七批证否**：那一批真的装了它，三条判据照旧一条都不过，而且查清了它是**结构性关不掉**的——首领带 `MINION_LEADER`，`Monster::die` 一命中就判胜并 `return`（实测首领死 55 次、55 次全部当场判胜、死后 0 帧），小鬼永远轮不到读它。新的关门条件见「已确认但尚未打补丁」 |
| ~~**`GREMLIN_LEADER` 与 `Actions::SummonGremlins`**~~ | ~~召唤地精那套是地精头领专属，那个编队是第二幕精英、harness 跑不到~~ **第二十七批已完成**（`summonGremlins`，逐位对齐 `Actions.cpp:459-497`，九处形状与例数见「验证方式 · 第二十七批」）                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ~~**地精之角（`GREMLIN_HORN`）**~~                    | ~~`Monster::die` 的死亡触发之一，harness 的遗物轮换八个里没有它~~ ✅ **第四十批已补**，例数见「验证方式 · 第四十批」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ~~**手钻（`HAND_DRILL`）**~~                          | ~~`Monster::attacked` 里紧挨着狂怒下方的那一支（破盾时上易伤，`Monster.cpp:433-435`）~~ ✅ **第四十批已补**，⚠ 而且是**两处**——`Monster::damage`（`:488-490`）里还有逐字相同的一份，当年这条只记了一处                                                                                                                                                                                                                                                                                                                                                                                                               |
| **怪物侧的虚无缥缈**（`Monster::attacked` 顶部）      | 位置在狂怒**之前**（`Monster.cpp:419-423`），当前没有一只登记的怪会拿到它                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

第十九批（第一幕两个 Boss / 形态切换 / 尖锐外壳 / Boss 分裂）点名跳过的：

| 跳过的                                                                | 为什么跳过                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两只 Boss 的 **asc≥4 / asc≥9 / asc≥19 分档**                          | 与第十三~十八批同源的结构性缺口，而且 Boss 的分档**用的是另一组阈值**：血量走 `asc>=9`（不是普通怪的 7 / 精英的 8）、伤害走 `asc4`、守卫者的尖锐外壳与模式切换阈值走 **`asc19`**（`asc19?4:3` / `asc19?40:asc9?35:30`）、史莱姆王的黏液走 `asc19?5:3`。全部内联在同一表达式里已随主体转写，只是永远走不到       |
| ~~**贤者之石**（`PHILOSOPHERS_STONE`）~~                              | ~~同第十四批：`slimeBossSplit` 也会给分裂出的两只各 +1 力量（`MonsterSpecific.cpp:3433-3436`），但 harness 的遗物轮换八个里没有它~~ ✅ **第四十批已补**（`slime_boss@relic1`）。⚠ 当年写的「已抽进共用的 `spawnSplitMonster`」**是错的**：参考是「两只都造完之后」才一起 buff，所以第四十批把它放回了两个调用方 |
| **`Monster::miscInfo` 的其余用法**                                    | 本批用上了第四种含义（守卫者的「下一次形态切换阈值」）。仍缺：六火幽魂的分割伤害（第二十批）、刺穿之书的连刺计数、暗影的咬击伤害、蠕动血块的位掩码                                                                                                                                                              |
| ~~**`SPHERIC_GUARDIAN_HARDEN` 那个白名单反例**~~ **第二十三批已处理** | 本批复核 `isMonsterAttacking` 时确认：守卫者的三条非攻击招式（蓄能 / 防御形态 / 泄气）与数据表 `intent` 一致，**没有分岔**。真正会分岔的球状守卫是**第二幕**的怪（加格挡 + 打人却算攻击）。**第二十三批把 `isMonsterAttacking` 换成了白名单 `MONSTER_ATTACK_MOVES`**，详见「验证方式 · 第二十三批」             |
| **`Monster::resetAllStatusEffects`**（`Monster.cpp:554`）             | `Monster::die` 里**重生（REGROW）那一支**才调它（`:304`，暗黑之种）。本批没碰到，`monsterDie` 里的 TODO 原样留着                                                                                                                                                                                                |

第二十三批（第二幕开张 / 壁垒 / 易塑 / 诅咒）点名跳过的：

| 跳过的                                                                                | 为什么跳过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三只怪的**全部 asc 分档**（血量第二组、`asc2` 伤害档、选民与食蛇草的 `asc17` 出招块） | 本批只做 asc0（第二 / 三幕 40 只怪一只都没校准），`ascCalibrated` 没置 → `constructMonster` 在 `ascension > 0` 时抛错，那些分支**走不到也没有预言机**。照第十八批对地精头目 `asc18` 出招块的先例：**留到给它们铺爬升度的那一批再转写**，不提前写没人验证的代码                                                                                                                                                                                                                                                |
| `attackedUnblockedHelper` 里剩下的四格（无敌 / 镀甲 / 飞行 / 反应 / 荆棘 / 变换）     | 本批只补了**易塑**那一格。镀甲与飞行的宿主（带壳寄生虫 / 鸟）是第二十四批，反应是蠕动血块（第三幕），无敌与变换是 Boss。链的**顺序**已经照抄，加新格时只需插进对应位置。✅ **第三十五批结清了「反应」这笔账**：它与易塑**共用第五格**（`else if (MALLEABLE \|\| REACTIVE)`，进门后两个 if 各判各的），而蠕动血块是全参考项目唯一两者都带的怪——在它登记之前那一格无论写成一格还是两格都观察不到差别。实测「反应那半格整条去掉」红 **120 例**（= 整个编队）。⚠ 链上现在只剩**无敌**（第一格，腐化之心）没有宿主 |
| `onUsePowerCard` / `onUseStatusOrCurseCard` 里除诅咒之外的一切                        | 残影 / 复制 / 回响形态 / 华彩 / 蓝色蜡烛，以及鸟面坛 / 墨水瓶 / 橙色药丸 / 木乃伊手四个遗物——全都还没有对应内容登记，写了没有预言机走到                                                                                                                                                                                                                                                                                                                                                                       |
| **困惑（CONFUSED）**                                                                  | 与诅咒在参考里走的是**同一支** `if (s == CONFUSED \|\| s == HEX)`，但它的唯一来源是史尼克（第二十五批）与蛇油药水（未登记）。本批只在 `debuffPlayer` 里为诅咒开了 bool 分支，注释里点名了困惑要走同一支                                                                                                                                                                                                                                                                                                       |
| **`Player::removeDebuffs`**（`Player.cpp:121`，会清诅咒）                             | 唯一的调用方是橙色药丸与时间吞噬者的加速，两者都没登记                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

第二十七批（召唤 / 地精首领 / 工头）点名跳过的：

| 跳过的                                                                 | 为什么跳过                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两只怪的**全部 asc 分档**                                              | 同第二十三~二十六批：第二 / 三幕 40 只怪一只都没校准，`ascCalibrated` 没置 → `constructMonster` 在 `ascension > 0` 时抛错。血量第二组（首领 `{145,155}` / 工头 `{57,64}`，阈值都是**精英的 8**）、鼓舞的力量 `{3,4,5}[eliteDiffIdx]` 与格挡 `asc3 ? 10 : 6`、伤口张数 `asc18 ? 3 : asc3 ? 2 : 1` —— 内联在同一表达式里的那些已随主体转写（走不到而已），血量第二组按惯例不填                                                                        |
| **工头 asc18 那条「多出来的一整句」**（`BuffEnemy<STRENGTH>(idx, 1)`） | 它不是「换个数」而是**多一条效果**（`MonsterSpecific.cpp:1237`），本该走 `apply_power.minAscension`。⚠ 但参考那句是 **`addToBot` 入队**的自身 buff，而我们的 `apply_power` + `on: "self"` 是**同步**执行的（既有的仪式 / 咆哮 / 成长全是同步）——照现有形状写进去会引入第二份不实的真相，而给 `on: "self"` 加 `sync` 开关又要给所有既有怪补 `sync: true`。asc18 当前不可达、也没有预言机，故按第二十三批的先例**留到给第二幕铺爬升度那一批**一并处理 |
| **`escapeNext`**（四只地精的「头领死了就逃跑」）                       | 本批把地精首领装进来了，**判据仍然三条都不过**，而且这一批查清了它是**结构性关不掉**的。逐条见「已确认但尚未打补丁」——那条记录已按本批的实测更新                                                                                                                                                                                                                                                                                                    |
| ~~**`Actions::SummonGremlins` 的贤者之石那一支**~~                     | ~~`Actions.cpp:488-491` 会给召唤出的两只各 +1 力量，遗物轮换八个里没有它~~ ✅ **第四十批已补**（`gremlin_leader@relic1`）。⚠ 这一条排在 `buff<MINION>` **之前**，与另外三条召唤相反                                                                                                                                                                                                                                                                 |
| **通用的 `summon` 效果 kind**（三个还没登记的怪在用）                  | 收藏家的火炬头（`SpawnTorchHeads`：按 `3 - monstersAlive` 决定召几只、**要调 `initHp`**、同步 `setMove`、每只一次 `noOpRollMove`）、青铜机器人的青铜球、蜥蜴法师的匕首（`skipTurn` 位）——三个各是一个专门的 Action，落位规则与 RNG 消耗全不一样。本批只做 `summon_gremlins`，那三个登记时各开一个 kind                                                                                                                                              |
| **`book_of_stabbing`（刺穿之书）**                                     | 原计划把第二幕三个精英放在同一批。本批只做两个：召唤 + `MINION_LEADER` 已经是两处共享时点的改动（`monstersAlive` 的算法、`initCombat` 的两个循环、`monsterDie` 的判胜条件），再叠 `miscInfo` 的连刺计数与 `PAINFUL_STABS` 是第三个机制。刺穿之书顺延到第二十八批                                                                                                                                                                                    |
| **`Monster::miscInfo` 的其余用法**                                     | 本批一次都没用到新含义。仍缺：刺穿之书的连刺计数、暗影的咬击伤害、蠕动血块的位掩码                                                                                                                                                                                                                                                                                                                                                                  |
| **`MINION_LEADER` 的另外四个宿主**                                     | 青铜机器人（`MonsterSpecific.cpp:218`）、蜥蜴法师（`:239`）、收藏家（`:273`）、觉醒者二阶段（`:1718`）——都是第二 / 三幕 Boss，还没登记。这条 Power 的建模本批已经做好，装它们时直接复用。✅ **青铜机器人第二十八批、蜥蜴法师第三十六批、觉醒者第三十七批都装上了**（觉醒者那个是**复活那条 case** 才上的，开局没有）                                                                                                                                |
| **`MINION` 的三个读者**                                                | `Actions.cpp:1084 / :1123 / :1174` 的「不影响随从」那一族（真实游戏里恐惧 / 献祭之类不对随从生效的牌），三张牌一张都没登记。所以 `MINION` 在战斗内**一次都不被读**，只作为快照字段存在                                                                                                                                                                                                                                                              |
| **`GENERIC_ESCAPE_MOVE` 那条 case**                                    | 参考里它是 `case GENERIC_ESCAPE_MOVE: default: break;`（`MonsterSpecific.cpp:1898-1900`）——**什么都不做**：不置 `isEscapingB`、不减 `monstersAlive`。既然没有任何东西会切到这个意图（见 `escapeNext`），我们这边连招式条目都不建                                                                                                                                                                                                                    |

第二十八批（突刺之书 / 青铜自动机 / 青铜球）点名跳过的：

| 跳过的                                                             | 为什么跳过                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 三只怪的**全部 asc 分档**                                          | 同第二十三~二十七批：`ascCalibrated` 没置 → `constructMonster` 在 `ascension > 0` 时抛错。血量第二组（突刺之书 `{168,172}` 阈值 **8**、自动机 `{320,320}` 与青铜球 `{54,60}` 阈值 **9**）按惯例**不填**；招式那些内联在同一表达式里的分档（乱刺 `asc3 ? 7 : 6`、重刺 `asc3 ? 24 : 21`、增益 `asc4 ? 4 : 3` / `asc9 ? 12 : 9`、连枷 `asc4 ? 8 : 7`、超射线 `asc4 ? 50 : 45`）已随主体转写，只是走不到   |
| **超射线的 asc19 分支**（不进眩晕、直接回增益）                    | 已按参考转写（`bc.ascension >= 19 ? "boost" : "stunned"`），但 asc0 下走不到、没有预言机。与地精巫师 asc17 那条同族                                                                                                                                                                                                                                                                                    |
| **突刺之书出招规则里那两句死代码**（`return` 之后的 `if (asc18)`） | 参考写在 `return` 后面，永远执行不到。三条判据一条都不过，**裁定不打补丁、照抄参考的实际行为**。逐条见「待裁定」                                                                                                                                                                                                                                                                                       |
| ~~**`spawnBronzeOrbs` 的贤者之石那一支**~~                         | ~~`MonsterSpecific.cpp:3454-3457` 会给召唤出的两颗各 +1 力量，遗物轮换八个里没有它~~ ✅ **第四十批已补**（`automaton@relic1`）。⚠⚠ 它顺带掀开了一处建模差异：青铜自动机是四个召唤宿主里**唯一没有 `arr[idx] = Monster()`** 的，球要继承空格里的残留力量 → 应该是 **2** 点。见「验证方式 · 第四十批」                                                                                                   |
| **通用的 `summon` 效果 kind**（剩下两个怪在用）                    | 本批做掉了青铜球那一族（`summon_bronze_orbs`）。仍缺：收藏家的火炬头（`Actions::SpawnTorchHeads`，按 `3 - monstersAlive` 决定召几只、**额外调 `initHp`**、同步 `setMove`、每只一次 `noOpRollMove`）与蜥蜴法师的匕首（`reptomancerSummon` + `skipTurn` 位）。⚠ 那两个各是一族，别复用本批这条                                                                                                           |
| **`Monster::miscInfo` 的其余用法**                                 | 本批用掉三种新含义（乱刺段数 / 青铜球「已用过停滞」/ 自动机 `lastBoostWasFlail`）。仍缺：时间吞噬者的「已用过加速」。✅ 暗影的咬击伤害（第三十四批）、蠕动血块的位掩码（第三十五批）、冠军的二阶段位（第二十九批）、**觉醒者的 `isPhase2`（第三十七批，⚠ 它同时被出招规则与 `Monster::die` 的假死门读，一个字段两个读者）** 都已登记                                                                   |
| **`MINION_LEADER` 的另外三个宿主**                                 | 蜥蜴法师（`MonsterSpecific.cpp:239`）、收藏家（`:273`）、觉醒者二阶段（`:1718`）。本批装了青铜自动机，是第二个宿主。✅ **收藏家第二十九批、蜥蜴法师第三十六批、觉醒者第三十七批依次装上，这一族五个宿主现在全部登记、名单封闭。**⚠ 觉醒者那个与另外四个形状不同：它**不在 `preBattleAction` 里上**，而在**复活那条 case**（参考在 `preBattleAction` 那行注着 `// buff minion leader only in stage 2`） |
| **`Monster::die` 的 `REGROW` 那一格**                              | 参考的 else-if 链是 孢子云 → **重生** → 停滞。本批补了第三格，中间那格（暗黑之种的重生）还没登记——登记它时要插在**中间**，不是接在末尾                                                                                                                                                                                                                                                                 |
| **玩家侧的 `PLATED_ARMOR` 递减**                                   | 参考在 `Player::attacked` 里、痛苦突刺**之前**一句（`Player.cpp:246-248`）。玩家侧镀甲来自还没登记的卡与遗物，本批只在注释里记了它的位置                                                                                                                                                                                                                                                               |

### 三、整类缺失的机制

- ~~**选牌屏**（card select screen）~~ **已完成**：`inputState` 加 `card_select`、
  `cardSelect: CardSelectInfo | null`、`selectCard` / `selectCards` 两个入口，以及
  `executeActions` 顶部的 `inputState !== "executing" → break`（开屏时**队列原样留着**，
  这是全部时序的根）。已转写 8 个 task：`armaments` / `exhaust_one` / `exhaust_many` /
  `exhume` / `headbutt` / `secret_technique` / `secret_weapon` / `warcry`。
  第八批又加了 1 个：`discovery`（候选**不在任何牌堆里**，是当场从战斗内卡池随机生成的 3 张，
  存在 `cardSelect.cards`；下标恒 0..2）。
  第九批又加了 1 个：`dual_wield`（候选是手牌里的攻击/能力牌；份数存在 `cardSelect.data0`，
  与 discovery 共用同一个字段，参考那两个访问器就是同一个 `data0`）。
  尚缺的 task：`codex` / `forethought` / `gamble` / `hologram` /
  `liquid_memories` / `meditate` / `nightmare` / `recycle` / `seek` / `setup`。
  ⚠ `forethought` 的**单选**分支参考侧是齐的（`chooseForethoughtCard`），卡在升级分支——
  见「二、内容铺量」第七批那张表。
- **消耗堆相关**：~~从消耗堆取回~~（掘尸已登记，`triggerAndMoveToExhaustPile` 是统一入口）；
  ~~消耗**触发**~~ **已完成**（黑暗拥抱抽牌 / 无痛之心加格挡，顺序与参考一致；两条都在
  `triggerAndMoveToExhaustPile` 里，压栈**之前**）；~~哨兵~~ **已完成**（第六批，**同步**
  回能量 `up?3:2`，排在两条 Power 之后）。仍缺：卡戎的骨灰 / 枯枝（遗物）、死灵诅咒
- ~~**回合末 Power**：金属化、燃烧、恶魔形态一类持续生效的能力牌~~ **已完成**：
  `callEndOfTurnActions` / `applyEndOfTurnPowers` / `applyStartOfTurnPostDrawPowers` 三个时点
  已按参考逐位转写，玩家 Power 按 `PlayerStatus` **枚举序**（而非获得顺序）遍历。
  暴虐已登记（BRUTALITY=39 排在 DEMON_FORM=44 之前）。
  ~~炸弹（需「N 回合后结算」计数器）~~ **第十一批已完成**（见下方「N 回合后结算」那条）。
  仍缺的分支：镀甲、如水般（需姿态）、爆发 / 双重施法 / 缠绕 / 平衡 / 欧米茄 / 反弹 / 再生 /
  玩家侧仪式 / 怨灵形态
- ~~**怪物的回合末触发**（`Monster::applyEndOfTurnTriggers`）~~ **第十二批已完成**（本批需要的
  那一支）。它与紧随其后的 `Monster::applyEndOfRoundPowers` 是**两个不同的时点**，参考把它们
  分别放在 `BattleContext::applyEndOfRoundPowers`（`:2148`）的玩家结算**之前**与**之后**，
  中间夹着 `player.applyAtEndOfRoundPowers()`。所以「某条属于哪一半」不能凭直觉猜，要逐条对：
  金属化 / 易塑 / 镀甲 / 虚无缥缈 / 再生 / **束缚**在前半，仪式 / 缓慢 / 锁定 / 虚弱 / 易伤 /
  通用力量成长在后半。两个循环各自带 `isDying() || isEscaping()` 跳过。
  ⚠ 后半那五条里，**通用力量成长（GENERIC_STRENGTH_UP）第三十三批才补上**（暗球游荡者是
  它全参考项目唯一的宿主）、**缓慢（SLOW）第三十五批补上**（巨头，同样是唯一宿主）
  ——在那之前「后半早就转写好了」这句话是不准确的。**现在只剩锁定（LOCK_ON）是 TODO**
  （它的产出者是机器人的牌，一张都没登记）。
  - **已实现：束缚（SHACKLED）** —— 黑暗镣铐临时拿走的力量记在它上面，回合末
    `buff<MS::STRENGTH>(getStatus<SHACKLED>())` 归还并 `removeStatus<SHACKLED>()` 清除。
    ⚠ 归还走的是 `buff` 而**不是** `addDebuff`，所以它**不过神器**——神器只在施加那一刻拦截。
  - **已实现：金属化（METALLICIZE）** —— 第十八批（拉加维林）。**排在这个函数的第一条**
    （`Monster.cpp:43-45`，在束缚归还之前），**同步** `addBlock`、不入队，所以这一层格挡
    在紧随其后的怪物回合开头就已经在了。
    ⚠ 它与「开局那 8 点格挡」是**两件事**：能力来自 `preBattleAction` 的
    `buff<METALLICIZE>(8)`，第一个玩家回合看到的那 8 点挡来自同一行下面的 `addBlock(8)`。
    去掉后者红 375 例、去掉前者红 373 例（见「验证方式 · 第十八批」）。
  - **仍缺（都留了 TODO）**：镀甲（同样要 `Monster::addBlock`）、易塑
    （`setStatus<MALLEABLE>(3)`，要与它的 onAttacked 成长分支配套）、**怪物侧**虚无缥缈递减、
    再生（`Monster::heal`）。当前登记的怪一只都没有，
    写了也没有预言机走到——等登记带它们的怪（拉加维林的金属化、**蛇草 / 蠕动血块**的易塑）时按
    上面的顺序补。⚠ **第十四批订正**：「史莱姆一族有易塑」是错的。参考全项目只有
    `SNAKE_PLANT`（`MonsterSpecific.cpp:249`）与 `WRITHING_MASS`（`:213`）buff 它，
    史莱姆 S / M / L 与史莱姆王**一只都没有**——所以这条要等第二 / 三幕，不是第十九批。
- ~~**招式的收尾：下一个意图怎么定**~~ **第十三批已完成**（`MOVE_TURN_END`），
  **第十四批补了第四形态 `none`**（case 尾部什么都没有——分裂就是这样，收尾在
  `largeSlimeSplit` **内部**）。
  在此之前 `doMonsterTurn` 一律 `addToBot(rollMove)`，那只是「绝大多数怪」的形态。
  参考把收尾写在 `Monster::takeTurn` 每条 case 的最后一句，**四种并存**，对 `aiRng` 的消耗
  各不相同（1 / 1 / 0 / 由效果自己负责），选错就是 counter 当场对不上：
  - `addToBot(Actions::RollMove(idx))` —— 掷 `aiRng.random(99)` 再走 `getMoveForRoll`
  - `addToBot(Actions::NoOpRollMove())` —— **照样掷一次** `aiRng.random(99)` 然后丢掉
    （`BattleContext::noOpRollMove`，`BattleContext.cpp:2814`），意图与 `moveHistory` 都不动。
    只有一招的怪用它（尖刺史莱姆小）
  - 同步 `setMove(下一招)` —— **不掷任何 aiRng**，当场锁定。酸液史莱姆小的舔舐 ↔ 冲撞
    严格交替就是这么实现的，于是它的 `getMoveForRoll` 一场仗**只被调用一次**
    ⚠ 另一条同族的：`Monster::rollMove` 顶部那次 `aiRng.random(99)` 是**恒定**的，但
    `getMoveForRoll` 内部可以**追加** `randomBoolean`——酸液史莱姆小甚至**完全不看 roll**、
    只用追加的那次（asc<17），所以它的 rollMove 消耗是 2 次。
  - **什么都没有** —— 第十四批新增。参考的分裂 case 只有一句 `largeSlimeSplit(...)` 然后
    `break`（`MonsterSpecific.cpp:364 / :1198`），收尾（两次 `noOpRollMove` + 游标推进）
    全在那个函数内部。表里记作 `"none"`，由效果自己负责。
  - **任意函数** —— 第十五批新增的**第五形态**。抢劫者的抢劫收尾是
    `if (回合数==1) setMove(抢劫) else setMove(aiRng.randomBoolean(0.5) ? 烟雾弹 : 猛扑)`
    （`MonsterSpecific.cpp:924-932`）：下一招与 aiRng 消耗**都取决于运行时状态**，
    四个静态形态一个都表达不了，只能写成 `(bc, m) => void`。
    配套还新增了 `MOVE_TURN_BEGIN`（case 的**开场**语句）——抢劫者在第一个怪物回合的
    抢劫开头 `aiRng.randomBoolean(0.6f)`，参考注了 `// for a dialog message in game`，
    结果被丢弃、只有「掷过一次」体现在计数器上。它不是效果，所以不放进 `enemies.ts`。
    第十七批又用它写了三条：护盾地精的保护（`if (getAliveCount() <= 1) setMove(盾击)`）、
    巫师的蓄力（`if (miscInfo == 3) setMove(大招)`）、巫师的大招
    （`if (!asc17) { miscInfo = 0; setMove(蓄力) }`）；`MOVE_TURN_BEGIN` 也多了一条
    （蓄力的 `++miscInfo`）。
    ⚠ **第十七批最值得记的一条：三只「只有一招」的地精，收尾却不一样。**
    狂暴 / 肥胖是 `addToBot(NoOpRollMove())`（`MonsterSpecific.cpp:653 / :663`），
    鬼祟**什么都没有**（`:670-672` 只有那个恒假的逃跑分支）。差别当场落在 aiRng 计数器上：
    把鬼祟改成 `no_op_roll` 红 172 例、把狂暴 / 肥胖改成 `none` 各红 222 / 192 例。
    **别因为「都只有一招」就统一。**
    ⚠ **第十八批把第五形态用成了常态**：拉加维林与哨卫的五条 case 全是
    「**同步 `setMove`** + 一次 `noOpRollMove`」的组合——四个静态形态一个都表达不了
    （`{setMove}` 不掷 aiRng、`"no_op_roll"` 不改意图）。
    ⚠ 而且 **`noOpRollMove` 的入队/同步两种写法在同一只怪身上并存**，照抄不要统一：
    重击是 `bc.addToBot(Actions::NoOpRollMove())`（`MonsterSpecific.cpp:878`），
    吸取灵魂与沉睡却是裸的 `bc.noOpRollMove()`（`:885` / `:894`），哨卫两条又都是入队
    （`:1060` / `:1066`）。两者消耗的 aiRng 次数**相同**，差别只在「这一掷发生在本回合
    排的动作之前还是之后」——实测两个方向都是 **0 例**（见第十八批盲区），
    但**次数**是被钉死的（整条去掉分别红 375 / 375 / 372 例）。
    ⚠ **第二十批把第五形态推到极致：六火幽魂的六条 case 全是它**，而且第一次出现
    「**收尾里维护一个与 `miscInfo` 不同的第二个整数字段**」——`uniquePower0`
    （对齐 `Monster::uniquePower0`，`Monster.h:66`，参考自注 `hexaghost orbCount`）。
    六条的形状是「（读/写 `uniquePower0`）+ 同步 `setMove` + 一次 noOpRollMove」，
    其中**灼烧那条是整只怪唯一的分岔点**（按自增**之前**的 `uniquePower0` 三选一）。
    ⚠ `uniquePower0` 由**五处**协同维护：六重打击 / 地狱之火**清零**，
    灼烧 / 冲撞 / 燃焰 **+1**；而且灼烧是**先读后加**、冲撞是**先 setMove 后加**。
    ⚠ 入队/同步两种 noOpRollMove 在这只怪身上同样并存（激活 / 燃焰同步，
    六重打击 / 地狱之火 / 灼烧 / 冲撞入队），照抄不要统一。
    ⚠ **不能把 `uniquePower0` 并进 `miscInfo`**：六火幽魂同时用到两个
    （`miscInfo` = 六重打击伤害、`uniquePower0` = 六焰计数）。参考里 `uniquePower0` 还兼任
    一批 Power 的存储后端（MODE_SHIFT / SPORE_CLOUD / THORNS / …），我们那些走 `powers` 数组，
    当前不会撞车；以后登记「既有此类 Power、又拿它当计数器」的怪时要回来重审。
    仍缺：`ReactiveRollMove`（蠕动血块）、`monsterData` / `miscInfo` 驱动的那几只
    （冠军的阶段位）。⚠ 红奴隶主的「用过缠绕没」原本在参考里是死的，
    **第十六批给参考打了补丁**（`miscInfo = 1`），我方的写入点在 `MOVE_TURN_BEGIN`
    （对齐参考写在 case 开头），读点在 `MOVE_RULES.red_slaver`。
- ~~**死亡触发**（`Monster::die`）~~ **第十六批已完成**（本批需要的那一支：孢子云）。
  形状与 `onHpLost` 不同，两处必须逐位照抄：
  - ⚠ **判胜那一支是 `return`**（`Monster.cpp:293-297`）：`--monstersAlive` 之后若归零就
    写 `outcome = PLAYER_VICTORY` 并**当场返回**，后面所有死亡触发一个都不跑。
    所以「秒掉场上最后一只真菌兽不会吃到易伤」是参考行为，不是我们漏了。
    ⚠ 但这道门**没有预言机**（0 例）——它与 `checkCombat` 的清扫重复了，见盲区一节。
  - ⚠ 孢子云是 **`addToTop`** 而不是 `addToBot`（`:301`），`clearOnCombatVictory` 走
    `Action` 的默认 **true**（`ActionQueue.h:22`，参考那行用的是单参构造）。
    易伤层数 **2 是 `die` 里硬写的**，不读 `SPORE_CLOUD` 的层数（参考在
    `preBattleAction` 那行自注「the value here isn't used. it is always 2」）。
  - ⚠ `DebuffPlayer` 的第二个参数 `isSourceMonster` 传的是 **`bc.turnHasEnded`**，
    不是常量 true。而且它是 C++ 的**实参**，在建动作那一刻求值并按值捕获，不是执行时再读
    ——语义是「怪物阶段里死的算怪物来源（本回合末不递减易伤），玩家回合里死的不算」。
    两个方向都有背书：恒 true 红 120 例、恒 false 红 2 例。
  - 孢子云本身是个 **Power**（`preBattleAction` 里 `buff<MS::SPORE_CLOUD>(2)`），
    会出现在 trace 的怪物快照里——所以数据表的 `deathEffects` 不能用来表达它（两份真相），
    `POWER` 映射漏了它会当场抛「未映射的 power」。
    ~~仍缺：暗黑之种的重生（`REGROW`）、停滞（`STASIS`）~~ ——**第二十八 / 三十四批已补齐**，
    那条 else-if 链的三格（孢子云 → 重生 → 停滞）现在全在。
    ✅ 觉醒者的假死（`halfDead` 的**另一个**写入点，`Monster::die` 的第一个分支）第三十七批已补。仍缺：
    尸爆（`CORPSE_EXPLOSION`）；~~地精之角~~ **第四十批已补**；**活体样本永远不补**（参考给它排的 InputState 没有消费者）。
- ~~**掉血触发**（`Monster::onHpLost`）~~ **第十四批已完成**（`MONSTER_ON_HP_LOST`），
  **第十九批补齐了这个 switch 的全部四支**。
  两条伤害路径（`attacked` → `attackedUnblockedHelper`、`damage` → `damageUnblockedHelper`）
  末尾各有一处，**只在这一击没打死它时**才跑。大史莱姆与史莱姆王的分裂挂在这里：
  `curHp <= maxHp/2`（**C++ 整除**）时**直接赋值** `moveHistory[0] = X_SPLIT`——不是 `setMove`，
  所以 `moveHistory[1]` 不前移。
  - **已实现：守卫者的形态切换** —— 第十九批（`Monster.cpp:519-529`）。**同一个 switch 里
    形状完全不同的另一支**，四处必须逐位分开记：
    ① 入口是 `hasStatus<MODE_SHIFT>()`（已经在防御形态里就整条不跑，所以防御链那三回合
    再挨多少打也不会二次切换）；② 扣的是**这一次未被格挡的伤害** `amount`，不是累计值；
    ③ 归零判据 `<= 0`，溢出的伤害**丢弃**、不带进下一轮阈值；
    ④ 归零那支用的是 **`setMove`**（前移历史）而**不是**分裂那种裸的 `moveHistory[0] = X`
    ——两种写法在同一个 switch 里并存，别统一。⚠ 但「哪一种」在数据上**分不出来**（0 例），
    见盲区：守卫者的 `getMoveForRoll` 整场只被调用一次，`moveHistory[1]` 无人读。
    ⑤ 紧跟着 `addToBot(Actions::MonsterGainBlock(idx, 20))` 是**入队**（改同步红 37 例）。
    下一轮的阈值不在这里涨，在双重猛击的收尾里（`miscInfo += 10` 再
    `addToBot(BuffEnemy<MODE_SHIFT>(idx, miscInfo))`）——**三处协同维护**
    （`preBattleAction` 置起点 30 / 双重猛击 +10 / 这里递减），与第十七批地精巫师的蓄力位同族。
- ~~**分裂**（`Monster::largeSlimeSplit`）~~ **第十四批已完成**（`splitMonster`）。
  它不是「加两只小弟」而是**顶替**：母体所在的下标被直接覆盖，第二只落在右边一格。
  五个逐位对齐点（每条都有非零变异例数，见「验证方式 · 第十四批」）：
  - **不掷 `monsterHpRng`**：`initSpawnedMonster` 只有 `curHp = maxHp = hp`，
    而且 `maxHp` 被压成分裂瞬间的**当前**血量（trace 里那两只是满血的 26/26，母体是 26/65）
  - **不继承任何状态**：`arr[idx] = Monster()` 再 init，易伤 / 虚弱 / 格挡全清零
  - 两只各自 `rollMove`（aiRng ≥2 次；中号酸液的分支还可能各追加一次 `randomBoolean`）
  - 之后**两次** `noOpRollMove`：一次在 `largeSlimeSplit` 尾部（`MonsterSpecific.cpp:3364`），
    另一次是 `extraRollMoveOnTurn.set(idx2)` 之后回到 `MonsterGroup::doMonsterTurn`
    （`MonsterGroup.cpp:583`）立刻被读掉的那次。⚠ 那个 bitset **只由分裂写、当场就被读掉**
    （中间没有任何入队动作），所以我们直接连着掷两次，没把它做成持久状态
  - **游标推进两格**：分裂自己 `++monsterTurnIdx`，`doMonsterTurn` 末尾再 `++` 一次
    → 新生的第二只**本回合不行动**
  - ⚠ **第十九批补上了「目标格已有怪」那一支**（第十四批留的是一道显式抛错）：参考往定长
    数组 `arr[idx2]` 里**写**，右边有东西就顶掉，而 `monsterCount = min(count+1, 4)` 照涨。
    史莱姆王那条链上真的会走到——王分裂出的尖刺大在 0 号格，它再分裂时 `idx2 = 1` 正是王
    留下的空位，`monsterCount` 从 3 涨到 **4**，于是快照尾部多出一个从没被构造过的空格。
    实测：改成「追加到末尾」红 **345** 例、去掉 `min(+1,4)` 那句红 **344** 例、
    把上限 4 改成 5 红 **275** 例。
- ~~**史莱姆王的分裂**（`Monster::slimeBossSplit`）~~ **第十九批已完成**（`slimeBossSplit`）。
  ⚠⚠ **它不是 `largeSlimeSplit` 的特例，是另一个函数**（`MonsterSpecific.cpp:3391`），
  五处形状不同，复用旧路径必错（实测复用红 **375** 例 = 整个文件）：
  - **落位下标写死 0 / 2**，不是「母体所在格 + 1」。1 号格被**跳过**，从头到尾没被写过
    ——harness 照样 dump 它（`"id":"INVALID = 0"`、hp 0、`alive:false`、`move:"INVALID"`），
    所以我们必须建模这个空占位（`EMPTY_MONSTER_SLOT`），并给测试的 `MONSTER` / `MOVE`
    两张映射各补一行。改成 `idx2 = 1`（不留空格）红 **375** 例。
  - **`monsterCount = 3` 是直接赋值**，不是 `min(count+1, 4)`。
  - **`monstersAlive = 2` 也是赋值**，不是 `++`。⚠ 当前场上只有王一只，数值上与 `++` 相同，
    所以这条**分不出来**（0 例，等价改写不是盲区）。
  - **`monsterTurnIdx = 3` 直接赋值**，不是 `++`。3 == monsterCount，于是两只新怪本回合都
    不行动。改成 `+= 1` 红 **375** 例。
  - **一次 `noOpRollMove` 都不掷**，也不设 `extraRollMoveOnTurn`。整个分裂只消耗 **2** 次
    aiRng（两只新怪各 rollMove），而大史莱姆那条是 2 + 2 = 4 次起步。
    追加一次红 **375**、追加两次红 **375**。
  - 相同的只有中间那段：`arr[idx] = Monster()` + `initSpawnedMonster(…, curHp)`
    （不掷血量、maxHp 压成当前血量、不继承状态、各自 rollMove），已抽成共用的
    `spawnSplitMonster`。⚠ 分裂出的是**大**史莱姆两只（尖刺在 0、酸液在 2），它们随后
    还会各自再分裂成中号——所以 `slime_boss.jsonl` 里同时出现 L 与 M 两代。
- ~~**编队成员由 miscRng 掷定**~~ **第十三批补齐了两种新形态**（`ENCOUNTER_BUILDERS`），
  第十四批又加了最简单的那种：**单只二选一**（`large_slime`，`MonsterGroup.cpp:157`，
  一次 `randomBoolean`，⚠ true 那支是**酸液**，与小史莱姆组的 true=尖刺 反过来）。
  在此之前只有虱子那种「逐只独立 `randomBoolean`」。现在还有：
  - **组合二选一**（`small_slimes`，`MonsterGroup.cpp:126`）：一次 `randomBoolean` 在两种
    **固定组合**之间选，两只的种类**与顺序**都是绑定的，不是逐只随机
  - **不放回抽样**（`lots_of_slimes`，`MonsterGroup.cpp:137`）：成员集合固定、随机的只有
    **出场顺序**。⚠ 循环是 `for (i = 4; i >= 0; --i)`、`miscRng.random(i)` 的**上界逐轮缩小**
    （5 次消耗，最后一次 `random(0)` 照样掷），取走之后把右边的元素**整体左移一格**
    而不是「与末位交换」——两种写法分布相同但**同种子下排列不同**，照抄不要等价改写
  - **「构造全部再选一个」**（`exordium_thugs`，`MonsterGroup.cpp:477` / `:497`）——
    **第十五批已完成**（`createFromConstructedPool`）。三条逐位对齐点：
    ① 三个候选**全部** `construct` 一遍（每只掷血量、虱子还要掷咬击伤害），落选的两只
    的 RNG 消耗**不退回**；② 候选表本身可能带 RNG（`getLouse` / `getSlaver` 是**实参**，
    先于那一只的血量掷）；③ 最后才 `miscRng.random(2)` 选下标（恒掷）。
    于是一场 `EXORDIUM_THUGS` 开局固定消耗 **7 次 monsterHpRng、4 次 miscRng**。
    ⚠ `getSlaver`（`:563`）是 **true = 红**。方向必须逐个回参考看：`getLouse` true=红虱、
    `small_slimes` true=尖刺、`large_slime` true=酸液——四条各写各的，照抄上一批必错。
  - **「构造全部再选一个」的第二个用户**（`exordium_wildlife`，`MonsterGroup.cpp:168-171`）
    —— **第十六批已完成**，直接复用同一个 `createFromConstructedPool`。
    ⚠ 唯一要照抄的新东西是**两段的顺序**：这里是 `createStrongWildlife` 在前、
    `createWeakWildlife` 在后，与 `exordium_thugs` **正好相反**（顺序对调红 375 例 = 整个文件）。
    `createStrongWildlife` 只有 2 个候选（真菌兽 / 颚虫，`MonsterGroup.cpp:487`），
    所以选下标那次是 `miscRng.random(1)`；参考给它们 `construct` 传的 idx 是**常量 0**
    而不是 `monsterCount`（strong 排第一，两者恰好相等，且我们用数组下标，不受影响）。
    一场 `EXORDIUM_WILDLIFE` 固定消耗 **6 次 monsterHpRng、3 次 miscRng**。
  - **不放回抽 4**（`gremlin_gang`，`MonsterGroup.cpp:100-122`）—— **第十七批已完成**。
    与 `lots_of_slimes` 同族但**不是同一段代码**，四处差别都照抄了：
    ① 候选表 8 项且**带重复**（狂暴 ×2、鬼祟 ×2、肥胖 ×2、护盾 ×1、巫师 ×1），
    所以同一种地精会出现两次，而护盾 / 巫师最多各一只；
    ② 有效区间由**独立的 `lastIdx`**（初值 7）表达，取完才 `--lastIdx`（史莱姆群是拿循环
    变量 `i` 兼作上界）；③ 循环**恰好 4 轮**，不是把池子抽干；④ 取走之后**整体左移**。
    每条都有非零变异例数（左移改交换 325、改右移 340、`lastIdx` 不递减 373、
    4→3 轮 375 = 整个文件、bound −1 372、候选表顺序 294 / 372），见「验证方式 · 第十七批」。
    ⚠ 唯一量不出来的是「先选完再建」（0 例）——那是**等价改写**不是盲区：
    `miscRng` 与 `monsterHpRng` 是**两条独立的流**，改交错顺序不影响任一条的取值序列。
    与第十五批「先选后造」（红 375 例）**不是一回事**：那条改的是 hpRng 的**次数**。
- ~~**逃跑**（`isEscapingB`）~~ **第十五批已完成**（`monsterEscape`）。
  逃跑与死亡是**两回事**：`isDeadOrEscaped() = isDying() || isHalfDead() || isEscaping()`
  （`Monster.cpp:253`），我们的 `m.alive` 建模的正是 `!isDeadOrEscaped()`（harness 的
  快照字段就是这么算的）。所以逃跑置 `alive = false` 并减 `monstersAlive`，但**血量不动**、
  `monsterDie` 那条死亡链（亡语 / 遗物击杀响应）一概不走。判胜是**直接写 `outcome`**，
  参考在这里**没有**调 `checkCombat`（动作队列不被清扫），照抄。
  ~~仍缺：`halfDead`（僧侣 / 觉醒者的假死，`isDeadOrEscaped` 的第三位）~~
  ✅ **第三十四批补上了 `halfDead`**（暗影客的重生）：它与逃跑是**并列的第三位**，
  区别是**半死的怪照样行动**（`doMonsterTurn` 的门是 `(!isDeadOrEscaped() || isHalfDead())`），
  而逃跑的不。半死必然伴随 `curHp == 0`，所以另外两个循环那道
  `isDying() || isEscaping()` 的门照样跳过它——那两处不需要改。
  仍缺：`escapeNext`、以及战斗后的 `g.info.stolenGold` 还钱（run 层第 7 项）。✅ 觉醒者那条假死第三十七批已补。
  ⚠ **`escapeNext` 在参考里是个死字段**（第十七批查实）：三只单招地精的 case 尾部都读它，
  但**全项目没有任何写入点**——与红奴隶主的 `usedEntangle` 同一类笔误。真实游戏里它由
  地精首领被打死时置上。⚠⚠ **第二十七批装上了地精首领，判据仍然三条都不过，而且结了案：
  这一条是结构性关不掉的**（`MINION_LEADER` 让首领一死就判胜并 `return`，小鬼永远轮不到
  再行动；而且 `GENERIC_ESCAPE_MOVE` 那条 case 在参考里是空的）。见「已确认但尚未打补丁」。
- ~~**纠缠**（ENTANGLED）~~ **第十五批已完成**。两处：`cardCanUse` 的 ATTACK 分支加一道门
  （`CardInstance.cpp:292`，排在冲撞那道**之前**，对 `inAutoplay` 一视同仁），
  以及 `applyEndOfTurnPowers` 里的 `addToBot(RemoveStatus<ENTANGLED>)`（`Player.cpp:382`，
  枚举序 10，排在 LOSE_STRENGTH=14 之前）。
  ⚠ 是**整条清除**不是递减——同一场里再吃到一次缠绕也只封住一个玩家回合。
  ⚠ 那道**门本身没有预言机**（重放只照着已记录的动作走，放宽一条限制永远不会让重放分岔），
  见下方盲区。有背书的是「层数落在玩家身上」与「回合末清除」（重量后各 41 例）。
  ⚠ **第十六批改变了它的出现频率**：给参考补上 `usedEntangle` 之后「一场只放一次」真的生效，
  `RED_SLAVER_ENTANGLE` 的执行次数从 **72 降到 56**，第十五批量的三个数字里有一个变了
  （35 → 34），见下方「验证方式 · 第十六批」。
- ~~**怪物 → 怪物的效果：给随机友军加格挡**~~ **第十七批已完成**
  （`gainBlockRandomEnemy`，对齐 `Actions::GainBlockRandomEnemy`，`Actions.cpp:436-458`）。
  这是本项目**第一个作用在别的怪身上**的效果，四个逐位对齐点（例数见「验证方式 · 第十七批」）：
  - **候选排除自己**（86）**也排除已死的**（83）。⚠ 参考用的是 `isDying()`（血 ≤ 0）
    而**不是** `isDeadOrEscaped()`——两者只在逃跑 / 假死时分岔，地精帮里没有这两种怪，
    所以当前用 `m.alive` 与参考等价；以后出现「逃跑的同伴还能被加格挡」的编队要拆成两个谓词
  - **候选为空时目标是自己，且那一支一次 aiRng 都不掷**（33）。护盾地精落单时理论上走它，
    但它一落单就会被收尾改成盾击，所以这一支只在「排队时还有同伴、出队时同伴已死」的窄缝出现
  - `aiRng.random(validCount - 1)` 是**闭区间上界**（bound +1 红 70、候选倒序红 69）
  - 它是 **`addToBot`**，所以选目标那次 aiRng 掷在**出队执行**那一刻，不是排队那一刻。
    ⚠ 改成同步**分不出来**（0 例），见盲区
- ~~**怪物 → 怪物的效果第二族：目标写死下标的加格挡 / 治疗 / 加力量**~~ **第二十六批已完成**
  （`gain_block_ally_fixed` / `heal_ally` / `buff_ally`，对齐 `MonsterSpecific.cpp:562-608`）。
  ⚠⚠ **它与上面那条「随机友军」是三处不同的东西，复用必错**（例数见「验证方式 · 第二十六批」）：
  - **目标写死**：百夫长的防守给 `arr[1]`（参考里那个引用就叫 `mystic`）、秘法师的治疗与鼓舞
    给 `arr[0]`（叫 `knight`）。**一次 aiRng 都不掷**；改成随机友军会当场把 `rng.ai` 错位（335）
  - **同步执行**，不是 `addToBot`（改成入队 0 例——见「同步 ↔ 入队」那条判据的更新）
  - **候选为空时什么都不做**，不像随机版那样退化成「给自己加」
  - 秘法师那两招**自己也无条件来一份**（不是二选一）：去掉 `arr[0]` 那半红 335 / 159，
    去掉「自己」那半红 344
  - 百夫长的防守**自己一点格挡都不加**（旧近似表写的是「自己 +15」，红 321）
    ⚠ 顺带带进来两条形状：**只有一句的同步真 `rollMove`** 收尾（第二十五批那条是两句），
    以及**全项目唯一读生命值的出招规则**（秘法师：自己或 `arr[0]` 缺 ≥ 16 血就强制治疗；
    ⚠ 缺血阈值 asc17 是 **21**，治疗量却是 **20**，两个数不一样）。
- ~~**`onAttacked` 族的第二条：狂怒（ANGRY）**~~ **第十七批已完成**（`monsterAttacked`）。
  与蜷缩同族但**位置不同，这是它全部的可观察面**：
  - 狂怒在 `Monster::attacked` 里、排在**格挡吸收之前**（`Monster.cpp:424-426`），
    所以**打在格挡上照样涨力量**，甚至 `damage == 0` 也涨；蜷缩在
    `attackedUnblockedHelper` 里，只有真的破了格挡才触发。把狂怒挪进
    `monsterDamageUnblocked` 红 **30** 例，这 30 例就是「打在格挡上」的场次
  - 是**同步** buff、不入队（改成 `addToBot` 红 114 例）
  - **不会被消耗掉**（触发一次即清除红 302 例），与蜷缩正相反
  - 只挂在 `attacked` 这条路上：非攻击伤害（燃烧 / 主宰 / 火焰药水走 `damage`）不触发
    开局层数由 `preBattleAction` 的 `buff<MS::ANGRY>(asc17 ? 2 : 1)` 定，会进怪物快照
    （`ANGRY: 1`），漏了当场抛「未映射的 power」。
    仍缺同族的：镀甲（PLATED_ARMOR）、反甲（THORNS）、易塑（MALLEABLE）、
    以及紧挨着狂怒下方的手钻（破盾上易伤，遗物轮换里没有）。
- ~~**`onAttacked` 族的第三条：沉睡被打断（ASLEEP）**~~ **第十八批已完成**
  （`wakeUpLagavulin`）。它与狂怒 / 蜷缩**都不同**，四处必须逐位分开记：
  - **判定点是「未被格挡的伤害」**：两处都住在 `attackedUnblockedHelper`（`Monster.cpp:388`）
    与 `damageUnblockedHelper`（`:448`）里，而调用方各有一道 `if (damage > 0)`（damage 是
    **扣掉格挡之后**的值）。所以打在开局那 8 点挡上**叫不醒它**——那正是那层挡的作用。
  - **两处的形状不同，照抄不要合并**：`attacked` 那条是 else-if 链的一格
    （无敌 → 镀甲 → 蜷缩 → 飞行 → 易塑/反应 → 荆棘 → **沉睡** → 变换），
    `damage` 那条是一个**独立的 if**。于是非攻击伤害（燃烧 / 主宰 / 荆棘 / 火焰药水）
    照样叫得醒，与蜷缩只挂 `attacked` 正相反。
  - **苏醒连带 `decrementStatus<METALLICIZE>(8)`**——减 8 而不是清零（层数恰好是 8，
    减完 `setHasStatus(0)` 整条没了），而**已经加在身上的格挡不退**。
  - ⚠ 「打醒」本身**不会**让它当回合行动：它这一回合仍然执行沉睡（无效果），
    是沉睡那条 case 的收尾读到 `!hasStatus<ASLEEP>()` 才把下一个意图改成重击。
  - ⚠ **沉睡位由「编队」给，不是由怪给**（`MonsterGroup.cpp:295`）：同一只拉加维林在
    `LAGAVULIN_EVENT`（睡魔事件版）里不睡，开局直接吸魂。`preBattleAction` 的金属化
    也以睡着为前提，所以那个编队连开局的 8 点挡都没有。
- ~~**玩家出牌 → 怪物获益的钩子**~~ **第十八批已完成**（`onUseSkillCard`，激怒）。
  这是本项目第一条挂在 `useCard` 那条**共享路径**上、却作用在**怪物**身上的触发。
  形状与第六批的玩家事件钩子同族（手写 if 链，顺序取决于源码书写顺序），但位置要点不同：
  - 参考把它写在 `BattleContext::onUseSkillCard` 的**最末**（`BattleContext.cpp:1847-1849`），
    排在残影 / 爆发 / 复制 / 回响形态 / 六芒星 / 华彩以及全部遗物之后；
  - 而 `onUseSkillCard()` 本身排在 `useSkillCard()`（卡效果**入队**）之后，
    激怒自己却是**同步** buff——于是「先加力量、再结算卡效果」。
  - **不消耗层数**（与狂怒同族、与蜷缩相反）。
  - ⚠ **参考只看 `monsters.arr[0]`**：写死下标 0、也不判死活。地精头目是单怪编队，
    当前与「遍历全体」完全等价（实测那条变异 **0 例**），所以**照抄不改**——
    真实游戏里激怒是挂在那只怪身上的 Power，第一幕没有第二只带激怒的怪能判它。

    **裁定：不打补丁。** 与第十六批缠绕那条的区别要说清，否则判据会退化成「看着不对就补」：

    |                              | 缠绕（补了）                 | 激怒（不补）                                            |
    | ---------------------------- | ---------------------------- | ------------------------------------------------------- |
    | 参考确知错                   | 是                           | 是                                                      |
    | 在**已登记的内容**里产生分歧 | **是**——单怪编队里就能反复放 | **否**——第一幕唯一带激怒的怪是单怪编队，`arr[0]` 就是它 |
    | 补丁**有预言机**             | 有                           | **无**                                                  |

    两条都成立才补。激怒两条都不成立：补了不改变任何一条现有 trace，也没有任何 trace
    能证明补对了——那就是「未验证的实现」，正是本项目最不接受的东西。
    **关门条件是具体的**：`COLOSSEUM_EVENT_NOBS` = 监工（下标 0）+ 地精头目（下标 1）,
    那里 `arr[0]` 会去 buff 没有激怒的监工、头目永远不涨——bug 当场可观测。
    它是事件编队，不在 harness 的 20 个里；哪一批把它纳进来，哪一批连补丁一起打。
    ⚠⚠ **同一个 `arr[0]` 写法的第二个用户是尖锐外壳，但它挂在另一个函数上。**
    第十八批这里原先写的是「`onUseSkillCard` 里的尖锐外壳（`BattleContext.cpp:1757`）」，
    **函数名写错了**：1757 行在 `onUseAttackCard` 里（那个函数是 `:1638-1761`，
    `onUseSkillCard` 从 `:1764` 才开始）。第十九批登记它时逐行核过，已订正——
    真实游戏的措辞也是「每当你打出一张**攻击**牌，受到 X 点伤害」。
    **判据不是「看着像」**：数据当场分辨得出（守卫者带外壳时打防御牌不掉血），
    把它扩到技能牌上也触发红 **360** 例。
- ~~**玩家出牌 → 怪物获益的第二条：尖锐外壳（SHARP_HIDE）**~~ **第十九批已完成**
  （`onUseAttackCard` 的最末，`BattleContext.cpp:1756-1759`）。与激怒同族但四处不同：
  - **挂在攻击牌上**（激怒挂技能牌）。两条的代码写法一模一样、只是住在两个函数里。
  - 走 `Actions::DamagePlayer(层数)` = `Player::damage`：**过格挡**、
    `selfDamage` 取默认 false（不触发破裂）、不触发荆棘 / 火焰屏障（那两条要攻击者下标）。
    改走 `attacked` 那条路红 **94** 例。
  - **`addToBot`**（激怒是同步 buff），且 `clearOnCombatVictory = false`（Actions.cpp:91-95）
    ——这一击打死守卫者时反伤照样落在玩家身上（改 true 红 **79** 例）。
    改成同步红 **181**、改成 `addToTop` 也红 **181**。
  - **不消耗层数**；清除点在双重猛击那条 case 的 `removeStatus<SHARP_HIDE>()`（红 **375** 例）。
  - ⚠ `arr[0]` 那条比激怒更彻底地没有预言机：全参考项目 buff `SHARP_HIDE` 的**只有守卫者**
    （`MonsterSpecific.cpp:1352` 是唯一写入点），而守卫者只出现在单怪编队里——
    连「哪一批能关掉它」都没有。**照抄不改**，实测改成遍历全体 0 例。
    仍缺同族的：只有攻击牌 / 能力牌那两条钩子里的其余东西（爆发、复制、回响形态、残影、
    六芒星的眩晕、华彩）。
    ✅ **`p.skillsPlayedThisTurn` 那条第四十一批关掉了**：它与 `attacksPlayedThisTurn` 一起
    补进了 `CombatPlayer`，读者分别是拆信刀与苦无 / 装饰扇 / 手里剑，五颗遗物各自有背书。
- ~~**`miscInfo` 的第三种用法：蓄力计数**~~ **第十七批已完成**（地精巫师）。
  它由**三处协同维护**，改一处就错（例数见「验证方式 · 第十七批」）：
  `MOVE_RULES.gremlin_wizard` 置 **1**（起点，改 0 红 77 / 改 2 红 111）、
  `MOVE_TURN_BEGIN["gremlin_wizard/charging"]` 每回合 `+1`（去掉红 77、改 +2 红 111）、
  `MOVE_TURN_END` 判 `== 3` 改出大招（改 2 红 111 / 改 4 红 77）、
  大招那条 `miscInfo = 0` 清零（去掉红 **1**，见盲区）+ `setMove(CHARGING)`（去掉红 45）。
  ⚠ **出招规则本身也能写 `miscInfo`**：参考的 `Monster::rollMove` 把它按引用传进
  `getMoveForRoll` 再写回（`Monster.cpp:629-634`），地精巫师那条 `monsterData = 1` 就是这么用的
  ——这与红奴隶主那条「读的是成员」并存，两种写法当前等价。
  ⚠ 起点 1 让开局那轮只蓄 **2** 回合、之后每轮蓄 3 回合，两段节奏不同是原样不是笔误。
- ~~**怪物往玩家牌堆塞状态牌**~~ **第十三批已完成**（`takeTurn` 的 `add_card` 效果）。
  史莱姆的攻击 `addToBot(Actions::MakeTempCardInDiscard(SLIMED))`，**排在攻击那条 addToBot
  之后**，走的是第五批就做好的 `makeTempCardInDiscard`（弃牌堆这一路不消耗 RNG）。
  第十四批补上了 L 号的**每次 2 张**（`MakeTempCardInDiscard({SLIMED}, 2)`，
  `MonsterSpecific.cpp:354 / :1189`）。
  第十八批补上了**第二张状态牌：恍惚（DAZED）**——哨卫的射钉
  `addToBot(MakeTempCardInDiscard({CardId::DAZED}, asc18 ? 3 : 2))`（`MonsterSpecific.cpp:1064`）。
  第十九批补上了**史莱姆王的 3 张**，⚠ 而且是这一族里**第一条同步写法**：
  `Actions::MakeTempCardInDiscard({SLIMED}, asc19 ? 5 : 3).actFunc(bc)`（`MonsterSpecific.cpp:1112`）
  ——与 `gain_block` / `apply_power` 那两族同形，`Effect.add_card` 因此新增了可选的 `sync`。
  ⚠ 实测「同步 ↔ 入队」在这条上是 **0 例**（那条 case 里塞牌之后只剩同步 setMove，
  中间没有第三条动作），见盲区；有背书的是**张数**（3→2 红 375 例）。
  ⚠ **进的是弃牌堆**，与黏液同一条路、一次 RNG 都不掷。
  ⚠ **别照抄黏液的处理**：黏液是**唯一**不需要医疗包就能打出的状态牌
  （`CardInstance.cpp:329` 的例外只放行 `SLIMED`），恍惚**打不出**——所以它
  **不进 `CARD_RULES`**、也不能进 `check-coverage.mjs` 的 `--no-upgrade` 段。
  它的属性（`cost: null` → 哨兵 -2、`exhausts: false`、**`ethereal: true`**）与
  `sts-combat-trace.test.ts` 的 `CARD` 映射早在第五批就齐了，本批一个字都不用加。
  可观察面只有两条：躺在牌堆快照里，以及**回合末因 Ethereal 被消耗**。
  第二十批补上了**第三张状态牌：灼伤（BURN）**，以及这一族里第一条「**造出来的牌是不是
  升级版由运行时决定**」——六火幽魂的灼烧是
  `MakeTempCardInDiscard(CardInstance(CardId::BURN, bc.turn > 8), asc19 ? 2 : 1)`
  （`MonsterSpecific.cpp:823-826`）。
  ⚠ **两个分档相互独立**：张数按 asc19（asc0 恒 1 张，那一支走不到），升不升级按
  `bc.turn > 8`（**与 asc 无关**，第 10 个怪物回合起，asc0 照样走得到）。
  `Effect.add_card` 因此新增了可选的 `upgradedAfterTurn`，且**在排队那一刻求值**
  （C++ 的 `CardInstance(...)` 是实参）。
  ⚠ 与恍惚同族：灼伤**打不出**（例外只放行 `SLIMED`），所以它不进 `CARD_RULES`、
  也不进 `--no-upgrade` 段；而且**牌堆快照只 dump 牌名、不 dump 升级位**，
  于是「塞的是灼伤+」唯一的可观察面就是**回合末 4 点而不是 2 点**。
  仍缺：`pile: "draw"` / `"hand"` 两个去向（都有原语，只是还没有怪用到；洗入抽牌堆要掷
  `cardRandomRng`）。
- ~~**状态牌 / 诅咒牌**：灼伤、伤口、眩晕等的入手与结算~~ **已完成**：
  `makeTempCardIn{Discard,Hand,DrawPile}` 三个去向（对齐 `Actions::MakeTempCardIn*` +
  `CardManager::createTempCardIn*`）。**只有洗入抽牌堆那一路消耗 RNG**——每张一次
  `cardRandomRng.random(抽牌堆张数-1)`，抽牌堆为空时改取 0 且不掷。回合末手里的灼伤走
  `useNoTriggerCard`（`triggerOnUse=false` 的**出牌队列**项，不计出牌数、不扣能量），
  伤害走 `Player::damage` 那条——**过格挡**，与放血那类 `loseHp` 不同。
  仍缺：腐朽 / 怀疑 / 羞耻 / 悔恨 / 虚无（都还没有入手途径，钩子位置已标注）
- ~~**以太**（回合末未打出则消失）~~ **已完成**：`discardAtEndOfTurn` 自己一张牌都不搬，
  只 `addToTop(helper)` 再按手牌下标**升序** `addToTop(消耗)`，于是实际执行是
  「以太按下标降序消耗 → 弃其余」。以太消耗走 `exhaustSpecificCardInHand`，因此会带出消耗链。
  仍缺：**保留**（retain / 卢恩金字塔 / 平衡）——参考在 helper 之前还有一段 limbo 搬运
- ~~**固有牌开局归位**~~ **已完成**：`initCombat` 的 cards.init 一段按参考做**稳定分区**
  （非固有在前、固有在后；数组尾即牌堆顶），并在固有多于起手数时补抽差额。
  实例级 `innate`（瓶装遗物）由 `combat-bridge` 逐实例带进来，覆盖闸门那条拒绝已撤掉
- ~~**玩家的事件钩子**：「当某件事发生时」触发的玩家 Power~~ **已完成**（第六批）。
  与回合边界那批的区别：这些不是遍历 `statusMap`，而是参考在各个钩子函数里手写的 if 链，
  所以**同一事件上多个 Power 的顺序取决于那份书写顺序，与枚举序、与获得顺序都无关**。
  五个钩子各挂在一个共享原语上：
  - 火焰屏障 → `dealDamageToPlayer`（对齐 `Player::attacked`）。反伤与荆棘都是 addToTop，
    荆棘先推、火焰屏障后推，故**执行时火焰屏障在前**；两条都不看这一击是否被挡满。
    清除在**下一个回合开始**（新增时点 `applyStartOfTurnPowers`），不是回合末
  - 烈焰吐息 → `drawOneCard`（对齐 `CardManager::draw`）。触发条件是**抽到状态牌或诅咒牌**，
    不是「打出攻击牌」（那是这张牌很早的旧版本）。状态牌那支顺序是「进化 → 烈焰吐息」，
    诅咒牌那支只有烈焰吐息
  - 怒火 → 新增时点 `onUseAttackCard`（对齐 `BattleContext::onUseAttackCard`），
    位置在卡效果**之后**、`OnAfterCardUsed` **之前**；格挡走裸 `GainBlock`（不过
    `calculateCardBlock`）；回合末**同步** `removeStatus`（RAGE=71，枚举序排在 COMBUST=41 后）
  - 主宰 → `gainBlock`（对齐 `Player::gainBlock`）。`amount <= 0` 的提前返回排在触发**之前**，
    所以加 0 点格挡不触发；伤害是 `addToBot(DamageRandomEnemy)`，**每次触发消耗一次
    `cardRandomRng`**——这让「所有加格挡的地方」都变成了 RNG 消耗点
  - 破裂 → 新增共享尾巴 `playerHpWasLost`（对齐 `Player::hpWasLost`），只在
    `selfDamage` 为真时加力量，且是**同步** buff。`playerLoseHp` /
    `damagePlayerNonAttack` 的 `selfDamage` 已改为**必填**参数，各调用点逐个对齐参考
    仍缺同族的：残影（三种牌型都触发）、千刃 / 剧痛（`triggerOnOtherCardPlayed`）、
    风采、双击 / 复制 / 回响形态 / 爆发（都要 `purgeOnUse` 那套复制打出）
- ~~**卡牌实例级状态**：`costForTurn` / `specialData`~~ **已完成**（第七批）。
  `CombatCard` 从 `{uid, defId, upgraded}` 扩成带 `cost` / `costForTurn` / `specialData`
  的实例（对齐 `CardInstance`），三个字段一起进出 `exportState` / `importState`，
  `migrate.ts` 回填老档。配套原语：`initialCardCost`（= `getEnergyCost(id, upgraded)`，
  含 **-1 = X 费 / -2 = 打不出**两个哨兵）、`setCostForTurn`（只在 `costForTurn >= 0` 时写）、
  `updateCardCost`、`upgradeBaseCost`、以及从「置一个 bool」补全成完整转写的 `upgradeCard`
  （尾部会把升级前后费用不同的牌的 cost/costForTurn 一起改掉）。
  两个新时点：`cardsOnTookDamage`（挂 `playerHpWasLost`，血债血偿降费，**不看** selfDamage）
  与 `cardsResetAttributesAtEndOfTurn`（挂 `onTurnEnding`，同步）。
  腐化是**三处**联动：落地扫四个牌堆改 `cost`（永久）、`drawOneCard` / `moveToHandHelper`
  改 `costForTurn`（每回合重压）、`useCard` 里技能牌消耗且不扣能量。
  仍缺：`freeToPlayOnce`（深谋远虑 / 液态记忆）、`retain`（保留整套）、
  困惑（抽到时掷 `cardRandomRng` 改费用）
- ~~**战斗内卡池**：从卡池随机取一张牌**定义**凭空造牌~~ **已完成**（第八批）。
  三个池逐字抄自 `include/constants/CardPools.h`，与 run 级奖励卡池（`cardPoolOf`，按
  color+rarity 派生、走 `cardRng`）**不是一回事**，取错池子或取错流会让同种子结果整个错位：
  - `CombatTypeCardPool`（攻击 28 / 技能 28 / 能力 14）—— 蜕变取技能、变形取攻击
  - `CombatCardPool`（不分牌型的 70 张铁甲牌）—— **发现**取它（`CardType::INVALID`
    在 `generateDiscoveryCards` 里就是「不分牌型、走本职业池」那一支）
  - `CombatColorlessCardPool`（34 张无色牌）—— 多面手取它
    取样一律 `cardRandomRng.random(池大小 - 1)`，**每取一张消耗一次**；发现那条是
    `generateDiscoveryCards` 的**拒绝采样**（三张互不相同，消耗次数不定）。
    ⚠ 三个池一共点名 **104 张牌**，第八批时其中 18 张 `CARD_RULES` 里没有；第九/十/十一批
    各登记掉 4 / 3 / 4 张，第十二批又登记掉 2 张，**现在只剩 5 张**（`forethought` /
    `magnetism` / `enlightenment` / `panache` / `sadistic_nature`）。它们**会真的躺在牌堆
    快照里**，所以 `sts-combat-trace.test.ts` 的 `CARD` 映射必须覆盖它们；而 harness 的
    `isReplayableCard` 门保证策略永远不去打未登记的牌（否则重放会抛「暂未登记卡牌行为」，
    trace 直接不可重放）。⚠ 每次登记一张池里的牌，都必须从那道门里摘掉，
    于是 variants 7/8（第八批）与 13/14（第十批）的内容会跟着变——第九/十/十一批都撞上了。
    ⚠ `getPoolSize(cc, …)` / `getCardAt(cc, …)` 的 `cc` 参数参考里**完全没被使用**，
    三个池都只有铁甲那一份数据；铺到别的角色时要跟着参考一起改。
    仍缺：法典 / 混沌 / 各类「发现」药水（都走同一套取样）
- ~~**出牌队列嵌套**：把某张牌**再当作一次出牌**处理~~ **已完成**（第九批）。
  `CardQueueItem` 从「手牌 uid」改成**装着牌实例本身**并补上 `autoplay`——浩劫/混乱打出的牌
  已经离开抽牌堆、二连击的复制项是一份副本，两者都不在手牌里。三条新原语：
  - `playTopCardInDrawPile`（浩劫 / 混乱共用，只差 `exhausts` 一个 bool）：抽牌堆空且弃牌堆
    非空时 `addToTop(PlayTopCard)` + `addToTop(EmptyDeckShuffle)`（故**先洗后打**）；否则
    `pop` 顶牌、以 `autoplay = freeToPlay = true`、`energyOnUse = 当前全部能量` 入**出牌队列
    队首**。⚠ 目标在**打牌/回合开始那一刻**就掷定（★ cardRandomRng），不是动作执行时。
    ⚠ 那张牌是被**拿走**的，所以 `canUse` 不通过时（顶上是眩晕/伤口）它凭空消失
  - `queuePurgeCard` / `addPurgeCardToCardQueue`（二连击）：复制项是**按值拷贝**，且入队位置
    是**第二位**而非队首（参考自注 `// not really the front but hey`）
  - `dualWieldAction` / `chooseDualWieldCard`（双持）：三条分支不可合并（0 张不开屏 /
    恰好 1 张直接复制且**不重排手牌不换 uid** / ≥2 张开屏）；走屏那条会把手牌重排成
    「其余可复制 → 其余不可复制 → 选中的那张」并给选中的那张**换一个新 uid**
    （参考注明这正是「双持仪式匕首」那个 bug 的来源）
    配套：`useCard` 尾部整段包进 `if (!purgeOnUse)`，扣能量判据回到参考原文
    `costForTurn > 0 && !autoplay && !(腐化 && 技能牌)`；`onAfterUseCard` 顶部补 `purgeOnUse`
    提前返回；`cardCanUse` 把 playCard 内联的那几道门抽成与 `CardInstance::canUse` 同形的谓词，
    两个调用点共用。⚠ **出牌队列从此在选牌屏上可能非空**（二连击+头槌、混乱叠 2 层），
    故 `StsCombatState` 新增 `pendingCardQueue`（migrate 回填 `[]`），原先那句「必空」的断言删掉。
    仍缺同族的：爆发（`onUseSkillCard`）、回响成型 / 复制药水（三种牌型 + 计数器）、死藤（遗物）
- ~~**X 费**（消耗全部能量，X = 消耗量）~~ **已完成**（第十批）。X 不在费用里，
  而是**两个字段配合**：
  - `getEnergyCost` 对 X 费牌返回 **-1**（第七批已原样照抄进 `cost` / `costForTurn`）。
    那个负值只是三道门的哨兵，一处都不是「费用」：`canUse` 的 `energy < costForTurn`
    恒不成立（0 能量也打得出）、`useCard` 尾部的 `costForTurn > 0` 恒不成立
    （**不走**扣能量那条通路）、`setCostForTurn` 的 `costForTurn >= 0` 恒不成立
    （腐化/疯狂/地狱之刃一律动不了它）。
    ⚠ 把 -1 换成 0 对拍**全绿**（∬0），三道门在 0 上表现完全相同——见下方盲区。
  - 真正的 X 记在 `CardQueueItem.energyOnUse` 上，能量由卡自己的动作一次清零
    （`player.useEnergy(player.energy)`）。三条入队路径上 X 各不相同：
    **玩家点牌** = 点牌那一刻的全部能量（`Action.cpp:433`；第十批之前我们填的是
    `card.costForTurn`，与参考不符但无人读，正是第九批记下的那条盲区）；
    **浩劫 / 混乱** = 弹出顶牌那一刻的全部能量，且 `freeToPlay = true` 让能量**不被花掉**
    （满能量的旋风斩不花一点能量）；**二连击的复制项** = 继承第一击的 X，且新增的
    `ignoreEnergyTotal = true` 挡住卡效果里那句「往下夹」（否则复制那一击 X 塌成 0）。
  - 两张 X 费牌的卡效果**不对称**，照抄：旋风斩只有「往下夹」
    （`!ignoreEnergyTotal && energy < energyOnUse`），嬗变在它之前还多一句「往上抬」
    （`energy > energyOnUse`）。参考没有注释解释，两句在当前内容下都没有预言机（见盲区）。
  - `CardQueueItem` 因此多了 `ignoreEnergyTotal`（`migrate` 按 `purgeOnUse` 回填）。
    仍缺：化学 X 遗物（`+2`）、`freeToPlayOnce`（深谋远虑 / 液态记忆）、
    剩下的 X 费牌全是别的角色的（劈砍 / 强化躯体 / 病态 / 多重施法 / 收集 / 铸刃 / 分身 / 风暴）
- ~~**升级你所有的牌**（神化）~~ **已完成**（第十批）。扫的是
  **手牌 → 抽牌堆 → 弃牌堆 → 消耗堆**四个堆（顺序即 `Actions.cpp:1005` 的书写顺序），
  逐张 `if (canUpgrade()) upgrade()`。⚠ **消耗堆也在其列**——与回合末费用复位
  （只扫手/弃/抽）和血债血偿（只扫手/抽/弃）都不同，别照那两处想当然；
  **master deck 不在其列**（只管「本场战斗剩余时间」）。神化自己不在任何堆里
  （`useCard` 已摘出手牌，进消耗堆是 `OnAfterCardUsed` 的事、排在这条动作之后）。
- ~~**虚无缥缈**（INTANGIBLE：受到的一切伤害降为 1）~~ **已完成**（第七批，随幻影登记）。
  三条钳制路径在参考里是**三段不同的代码**，逐个转写：怪物攻击走
  `Monster::calculateDamageToPlayer` 的 `min(damage, 1.0f)`（在所有倍率之后、截断之前；
  `Player::attacked` 里明写「assume intangible is already handled」）、非攻击伤害走
  `Player::damage` 顶部的 `damage > 0 && …`、主动失血走 `Player::loseHp` 顶部（**不带**
  `> 0` 判断）。回合末 `decrementStatus` **无条件**递减，所以幻影给的 1 层当回合末就掉光。
  仍缺：怪物侧的 INTANGIBLE（`Monster::attacked` / `Monster::damage` 各一处，没有已登记的
  怪有它）、缓冲（BUFFER）
- ~~**打击计数**（完美打击的伤害随「牌名含打击」的张数增长）~~ **已完成**（第十一批）。
  它**不是**打牌时扫牌堆数出来的，而是 `CardManager::strikeCount` 这个**增量计数器**，
  由两个钩子维护（`CardManager.cpp:258/264`）。语义是「在这场战斗里」，不是「在某个牌堆里」：
  - **加**（`notifyAddCardToCombat`）= 一张牌**凭空进入战斗**。参考的调用点共 8 处，我们对应
    收成两个函数：`instantiate()`（建大牌组实例 / `createTempCardIn{Hand,DrawPile,Discard}` /
    `Actions::MakeTempCardIn(s)Hand` / 双持的副本 / 发现的副本 —— 全部走它）与
    `chooseExhumeCard` 里那一句（掘尸把牌从消耗堆**带回**战斗）。
    ⚠ 牌堆之间的搬运（抽 / 弃 / 洗 / 打出 / 进消耗堆之外的任何移动）**一次都不动它**。
  - **减**（`notifyRemoveFromCombat`）**只有一处**：`moveToExhaustPile`。所以「已离开手牌、
    还没进弃牌堆」的在飞牌仍然算 —— 完美打击因此**算上自己**（参考在那行注了
    `// hack because we calculate strikeCount while non purge cards are still in hand.`）。
  - 二连击的复制项两头都不算（`queuePurgeCard` 按值拷贝、不走 notify；它结算完直接丢掉、
    也不走 `moveToExhaustPile`）。`chooseDualWieldCard` 给**原牌**换 uid 那一步同样不 notify。
  - ⚠ 顺带照抄了参考的一处边角行为：浩劫 / 混乱从抽牌堆顶拿走的牌若 `canUse` 不通过，
    它凭空消失且**不**走 `notifyRemoveFromCombat`，计数器就永久偏高一张。当前观察不到
    （能被 canUse 拒掉的只有状态/诅咒牌，没有一张是打击牌）。
  - `strikeCount` 进了 `exportState` / `importState`；**不能**在 import 里派生（它算在飞牌），
    `migrate` 对老档是真的数一遍而不是常量回填（老档牌堆里可以有变形/发现造出来的完美打击）。
- ~~**打出合法性门槛**（冲撞：手牌全是攻击牌才能打）~~ **已完成**（第十一批）。
  参考放在 `CardInstance::canUse` 的 **ATTACK 分支**里（`CardInstance.cpp:295` → `canUseClash`），
  第九批已把那几道门抽成 `cardCanUse` 谓词，所以只加了一句。两处照抄：`canUseClash` 扫整只
  手牌、**不排除冲撞自己**（它自己是攻击牌，那一格恒通过）；空手牌恒真（循环不进）。
  ⚠ 这道门对 `inAutoplay` **一视同仁**：浩劫 / 混乱翻出一张冲撞时照样要过它，不过就凭空消失。
  ~~仍缺同族的：缠绕封攻击（ENTANGLED）~~ **第十五批已完成**（同一个谓词里多加一句，
  排在冲撞那道之前）。仍缺：大结局 / 招牌动作 / 反射 / 天降神兵 / 战术家。
- ~~**N 回合后结算**（炸弹）~~ **已完成**（第十一批）。炸弹写成
  `BuffPlayer<PS::THE_BOMB>`，却**不是** statusMap 里的 Power：`Player::buff<PS::THE_BOMB>`
  （`Player.h:330`）在写 statusMap 之前就 `bomb3 += amount; return;` 了。于是
  ① 层数住在三个专用字段 `bomb1/bomb2/bomb3` 上；② `setHasStatus` 一次没调过，
  `hasStatusRuntime(THE_BOMB)` **恒为假**——参考自己的状态 dump 与 harness 的快照都
  **看不见炸弹**（只有三回合后那一下全体伤害能被看到，见下方盲区）。
  结算在 `applyEndOfTurnPowers` 里、排在遍历 statusMap 的循环**之前**（`Player.cpp:350-355`），
  四处照抄：先引爆 `bomb1`（**入队** DamageAllEnemy）再整体前移一格；前移**无条件**；
  引爆判据是 `if (bomb1)`、**不看**怪是否已全死（与紧随其后的燃烧不同）；同一回合打两张
  就是 `bomb3` 累加（一格 80/100，不是两个计时器）。
  ⚠ `executeActions` 那道「打不赢了」检查里也要算它（`BattleContext.cpp:786-788` 的
  `player.bomb1 || bomb2 || bomb3`）：手牌打空但炸弹还在倒计时时不判负。
- ~~**战斗内金币**（贪婪之手击杀奖励）~~ **已完成**（第十一批）。这是第一个进
  `BattleContext` 的**战斗外**资源。参考的形状：`BattleContext::init` 里
  `player.gold = gc.gold`（`:55`），`exitBattle` 里 `g.gold = player.gold`（`:484`）。
  我们照同一形状：`CombatPlayer.gold` + `CombatInitInput.gold`，`combat-bridge` 两头接上
  （`startCombat` 传 `state.gold`，`settleCombat` 写回 `state.gold`——与 hp 一样是
  **每个动作之后**都写，否则中途取档会与快照对不上）。
  `Player::gainGold` 里两条遗物分支留 TODO：以太（**加钱之前**整个提前返回，拿了它这一局
  再也捡不到金币）、血腥雕像（加完回 5 血）。
  ~~仍缺：盗贼 / 劫掠者偷金币~~ **第十五批补上了偷金**（`stealGoldFromPlayer`）：
  额度来自怪物的 `thievery` Power（`preBattleAction` 掷定 15 / asc17 20），
  钳制是 `min(player.gold, 额度)`——**按玩家金币的绝对值**。
  ⚠ 这一句把「战斗内金币」从「谁都不读的记账」变成了真的有语义，直接推翻了第十一批
  写下的那句「trace 重放故意不传 gold、从 0 起算，差个常数不影响任何行为」：
  从 0 起算的话 `min(0, 15) = 0`，一分钱都偷不到，而 trace 里的 `goldGained` 是负数。
  修法是让重放侧从**与参考相同的绝对值**起算（`HARNESS_GOLD_BASELINE = 99`，来自
  `GameContext.h:224` 与 `trace_dump.cpp:1327`），比对时再减掉；**没有**把钳制删掉「修绿」。
  仍缺：战斗**之后**把没逃掉的抢劫者偷走的钱还给玩家（`g.info.stolenGold`，
  累加在 `Monster::miscInfo` 上），那是 run 层第 7 项。
- **战斗内遗物**：现 **58 / 168**（第四十三批把「单读点」那一族一次吃完）。要从参考项目重新转写
  （包括开局 buff、回合触发、出牌/失血/消耗/击杀响应、跨战斗计数型如笔尖 / 幸运花 / 双节棍）
- **姿态**（观者）与**充能球**（机器人）—— 当前范围外，但迟早要做
- **精英战语义**：勇气投索 / 密封昆虫那类「精英战内」判定（`isElite` 现在没传进战斗）

## 验证方式

数据由参考项目**真实 `BattleContext`** 驱动产出（不是手工转写的第二实现），记录「动作序列 +
每步全量状态快照」，TS 重放同一份已记录动作逐帧比对。

- 数据：`test/golden/traces/<encounter>.jsonl`，每行一条 trace。文件名带后缀时是同一个编队
  的另一条轴：`@ascN`（爬升度，第二十一批起）/ `@tgtN`（目标策略，第三十一批起）/
  `@relicN`（遗物组，第四十批起）/ `@potN`（药水组 + 喝药时机，第四十五批起）。
  **后缀顺序固定为 `[@ascN][@tgtN][@relicN][@potN]`**
- 测试：
  - `test/sts-combat-trace.test.ts` —— 逐帧对拍（**39466 例**，第四十五批），外加一条**数据自身的不变量**：
    任何一帧的 `goldGained` 都不低于 `-HARNESS_GOLD_BASELINE`（第十五批加，
    金币不会为负；常数偏小时它给出比「第 N 步状态不符」直白得多的诊断）
  - `test/sts-combat-wiring.test.ts` —— 接线：入参一致性、存档往返、胜负出口、未迁移即抛错、
    选牌屏（开屏 / 存档往返 / 残留动作不丢 / 非法选择被拒 / 两个策略都不死循环 /
    第八批加的「发现」屏：候选是当场生成的 3 张、跟着存档往返、选中的牌 `costForTurn`
    归零而 `cost` 不动）；
    第十一批加的两条：**贪婪之手的金币**（入场值来自 run 层、每个动作之后写回 `state.gold`、
    两处一致）与**炸弹的三格计时器**（往返 + 第 3 个回合末引爆）。这两条不是锦上添花——
    金币在 trace 里只以「本场赚了多少」这个增量出现，炸弹在 trace 里**压根看不见**
    （见下方盲区），接线这一层只能靠这里守；
    其中一条把 `SUPPORTED_ENCOUNTERS` 与 trace 文件名双向对齐，漏加或多加都失败；
    第二十一批又加了两条**爬升度**的：`ASC_SUPPORTED_ENCOUNTERS` 与
    `*@ascN.jsonl` 双向对齐（多列 = 放行一场没有预言机的战斗），以及它必须是
    `SUPPORTED_ENCOUNTERS` 的子集
  - `test/data-tables.test.ts` —— 数据表不变量。**数据表是两代实现共用的**，它错了游戏级实现
    会照着错的数值逐位复现。首次跑就抓到了 `teardrop_locket` 重复定义（watcher 奖励池里
    双倍权重）——这类问题此前一直没有测试守着。
    ⚠ 「奖励池：不含 starter/special…」那条里，「池里的牌颜色对不对」是**恒真**的
    （`cardPoolOf` 直接按 `color` 过滤派生），真正有牙的只有「无重复」。守 `color` 的是
    第七批加的「卡表 · 颜色归属」——它拿 `sts-combat.ts` 的登记表（范围=铁甲+无色）
    当第二数据源，射程与局限写在那条注释里。
    ⚠ 第二十一批加了两条守「半填」的：`ascCalibrated` 与 `hpHigh` 必须**同进同退**
    （只填一个会让 `constructMonster` 放行一只其实没校准的怪，或反过来抛掉一只已校准的），
    以及**没校准**的怪不许带 `hpHigh`。
    ⚠ 第二十二批把第一条从「阈值写死 7」改成**逐怪期望阈值的表**：血量阈值普通 7 /
    精英 8 / Boss 9 是三个不同的数，写死 7 的话精英与 Boss 抄错档不会被任何东西发现
    （而单一 asc19 档位也**量不出来**——实测把 8 抄成 7、把 9 抄成 8 都是 0 例）。
    第二条的样本换成第二 / 三幕的六只（三精英三 Boss 本批全校准了）。
    ⚠ 第二十三批加了第三条：**只有 `Monster::initHp` 里那条不掷 RNG 的怪才带 `hpNoRoll`**
    （全表遍历，不是抽查）。反方向也守着：守卫者的 `{240,240}` **照样掷一次**，
    所以「上下界相同」不是判据，它必须不在名单里
- 生成器：不在本仓库。见 fork 的 `sts-engine-harness` 分支
  （`KisinTheFlame/sts_lightspeed`，`tools/sts-engine-harness/`）

harness 已支持选牌屏动作（`select_card` / `select_cards`），姿态 / 赌博 / 预知等屏幕尚无编码。

### 布局：variant 0 冻结，其后每批用当前全牌组重生成

每条 trace 都自带**生成它的那副牌组**，重放端按行走。所以数据布局是可选的，现在选的是：

| variant | 牌组                                        | 种子   | 升级 | 编队                  |
| ------- | ------------------------------------------- | ------ | ---- | --------------------- |
| 0       | 起始 + 首批 11 张（21 张）——**冻结**        | 全 125 | 否   | 全部 20               |
| 1       | 起始 + 第一~六批全部已登记卡牌（93 张）     | 前 40  | 否   | 全部 20               |
| 2       | 同上                                        | 前 40  | 是   | 全部 20               |
| 3       | 起始 + 第五批 + `mind_blast`（23 张，聚焦） | 前 40  | 否   | 全部 20               |
| 4       | 同上                                        | 前 40  | 是   | 全部 20               |
| 5       | 起始 + 第七批 + 8 张使能牌（24 张，聚焦）   | 前 40  | 否   | 全部 20               |
| 6       | 同上                                        | 前 40  | 是   | 全部 20               |
| 7       | 起始 + 第八批 + 3 张使能牌（18 张，聚焦）   | 前 40  | 否   | 全部 20               |
| 8       | 同上                                        | 前 40  | 是   | 全部 20               |
| 9       | 起始 + 第九批 8 张 + 4 张使能牌（22 张）    | 前 40  | 否   | **CULTIST/TWO_LOUSE** |
| 10      | 同上                                        | 前 40  | 是   | **CULTIST/TWO_LOUSE** |
| 11      | 起始 + 旋风斩/神化×2 + 11 张使能牌（24 张） | 前 40  | 否   | **CULTIST/TWO_LOUSE** |
| 12      | 同上                                        | 前 40  | 是   | **CULTIST/TWO_LOUSE** |
| 13      | 起始 + 嬗变×2 + 6 张使能牌（18 张）         | 前 40  | 否   | **CULTIST/TWO_LOUSE** |
| 14      | 同上                                        | 前 40  | 是   | **CULTIST/TWO_LOUSE** |
| 15      | 起始 + 第十一批 6 张 + 10 张使能牌（26 张） | 前 40  | 否   | **CULTIST/TWO_LOUSE** |
| 16      | 同上                                        | 前 40  | 是   | **CULTIST/TWO_LOUSE** |
| 17      | 起始 + 炸弹×2 + 8 张使能牌（20 张）         | 前 40  | 否   | **CULTIST/TWO_LOUSE** |
| 18      | 同上                                        | 前 40  | 是   | **CULTIST/TWO_LOUSE** |
| 19      | 起始 + 第十二批 6 张 + 4 张使能牌（20 张）  | 前 40  | 否   | **CULTIST/TWO_LOUSE** |
| 20      | 同上                                        | 前 40  | 是   | **CULTIST/TWO_LOUSE** |

⚠ **第十三批起有了第二套保留策略：`ENC_V0`（只留 variant 0，装完即永久冻结）。**
上面这张表描述的是**卡牌铺量用的那五个编队**（`ENC_ALL`，整份保留、每批随牌组重生成）。
怪物/编队铺量走另一套：harness **一直**在跑第一幕全部 20 个编队，我们过去只安装五个；
铺量怪物时把编队名加进 `tools/regen-traces.sh` 的 `ENC_V0`，只保留它的 variant 0
（375 行 = 125 种子 × 3 层），**此后每批都必须逐字节复现整份文件**。

| 编队                | 策略       | 装入批次 | 行数 | 大小  |
| ------------------- | ---------- | -------- | ---- | ----- |
| `small_slimes`      | `variant0` | 十三     | 375  | 3.5MB |
| `lots_of_slimes`    | `variant0` | 十三     | 375  | 5.8MB |
| `large_slime`       | `variant0` | 十四     | 375  | 5.8MB |
| `blue_slaver`       | `variant0` | 十五     | 375  | 3.2MB |
| `red_slaver`        | `variant0` | 十五     | 375  | 3.1MB |
| `looter`            | `variant0` | 十五     | 375  | 3.0MB |
| `exordium_thugs`    | `variant0` | 十五     | 375  | 5.3MB |
| `exordium_wildlife` | `variant0` | 十六     | 375  | 4.2MB |
| `gremlin_gang`      | `variant0` | 十七     | 375  | 6.4MB |
| `gremlin_nob`       | `variant0` | 十八     | 375  | 4.9MB |
| `lagavulin`         | `variant0` | 十八     | 375  | 6.5MB |
| `three_sentries`    | `variant0` | 十八     | 375  | 8.6MB |
| `the_guardian`      | `variant0` | 十九     | 375  | 12MB  |
| `slime_boss`        | `variant0` | 十九     | 375  | 18MB  |
| `hexaghost`         | `variant0` | 二十     | 375  | 12MB  |

⚠ 第三幕的文件同样走 `variant0` 策略（`ENC_V0_ACT3`），但**每份文件里只有一个 variant**，
所以「variant 0 那一段」等于整份 120 行（40 种子 × 3 层）。第三十二~三十四批装的八个：

| 编队                    | 装入批次 | 行数 | 大小      |
| ----------------------- | -------- | ---- | --------- |
| `three_shapes`          | 三十二   | 120  | 2.5MB     |
| `four_shapes`           | 三十二   | 120  | 2.9MB     |
| `sphere_and_two_shapes` | 三十二   | 120  | 3.4MB     |
| `orb_walker`            | 三十三   | 120  | 1.7MB     |
| `spire_growth`          | 三十三   | 120  | 2.4MB     |
| `maw`                   | 三十三   | 120  | 3.3MB     |
| `three_darklings`       | 三十四   | 120  | 5.2MB     |
| `transient`             | 三十四   | 120  | 2.2MB     |
| `awakened_one`          | 三十七   | 120  | **7.4MB** |
| `time_eater`            | 三十八   | 120  | 6.5MB     |

⚠ `awakened_one` 是第三幕最大的一份，而**它大的原因与 `three_darklings` 不同**：
后者是「多怪 + 会复活 = 均长 9.3 回合」，前者是**牌组换强了**（均长从 3.6 涨到 8.7 回合，
见下方「牌组不是常量」）。**体积估算要把「这一批用的是哪副牌组」也算进去**，
不能只按编队形状推。

⚠ **第二十一批起同一个编队可以有第二份文件：`<编队>@asc19`。** 它不是新编队，是**另一个
爬升度**上的同一个编队（harness 只在爬升度非 0 时输出 `"ascension"`，`split-traces.mjs`
把它拼进分组键）。策略同为 `variant0`——一份文件里只有那一个 variant，`variant0-rows.mjs`
因此返回整份长度 = 整份冻结。行数是 **120**（40 种子 × 3 层）而不是 375，理由见下。

| 编队                      | 策略       | 装入批次 | 行数 | 大小  |
| ------------------------- | ---------- | -------- | ---- | ----- |
| `cultist@asc19`           | `variant0` | 二十一   | 120  | 1.1MB |
| `jaw_worm@asc19`          | `variant0` | 二十一   | 120  | 984KB |
| `jaw_worm_horde@asc19`    | `variant0` | 二十一   | 120  | 2.1MB |
| `two_louse@asc19`         | `variant0` | 二十一   | 120  | 1.0MB |
| `three_louse@asc19`       | `variant0` | 二十一   | 120  | 1.5MB |
| `small_slimes@asc19`      | `variant0` | 二十一   | 120  | 1.1MB |
| `lots_of_slimes@asc19`    | `variant0` | 二十一   | 120  | 2.0MB |
| `large_slime@asc19`       | `variant0` | 二十一   | 120  | 2.0MB |
| `blue_slaver@asc19`       | `variant0` | 二十一   | 120  | 1.0MB |
| `red_slaver@asc19`        | `variant0` | 二十一   | 120  | 1.1MB |
| `looter@asc19`            | `variant0` | 二十一   | 120  | 980KB |
| `exordium_thugs@asc19`    | `variant0` | 二十一   | 120  | 1.8MB |
| `exordium_wildlife@asc19` | `variant0` | 二十一   | 120  | 1.4MB |
| `gremlin_gang@asc19`      | `variant0` | 二十一   | 120  | 2.3MB |

爬升度那批 variant 的三个参数各有理由，都不是随手定的：

- **牌组与 variant 0 相同（`BATCH_1` 21 张）**：唯一变量就是爬升度，任何 HP / 意图 / 伤害 /
  RNG 计数器的差异都只能归因于它。
- **40 个种子而不是 125**：体积。爬升度分支绝大多数是**常量替换**（`asc2 ? 12 : 11`）
  而不是新的控制流，种子多样性在这里的边际收益远低于 variant 0 存在的理由（意图 roll）。
  14 个编队合计约 21MB。
- **档位 19，只此一个**：这 14 个编队能走到的 asc 条件全是 `asc >= N`（N ∈ {2,3,4,7,17,19}），
  一次 19 取到每条分支的「高」侧，而既有 125 种子的 asc0 语料本来就钉着「低」侧。
  ⚠ **证不了「阈值恰好是 N」**，见「待裁定」里那条。

选 variant 0 的理由（`regen-traces.sh` 的注释里有完整版）：怪物行为几乎与牌组无关，拉开差异的
是**种子**，而 variant 0 恰恰是种子最多（125，其余 variant 只有 40）、牌组最弱（21 张，
战斗更长 = 怪物回合更多）的那个；体积上 15 个第一幕编队整份保留约 500MB，只留 variant 0 是 100MB。
⚠ 代价是**这三个文件不含任何聚焦牌组**，所以「要靠长战斗才走到的东西」在它们上面可能结构性
不可达——第十三批的黏液就是这么变成盲区的（见下方盲区一节）。
⚠ **但「换个编队」本身就是一个逃生口**，第十四批实证了这一点：同样是 variant 0 的 21 张牌组，
`large_slime`（64~70 血的单怪）打得比 `small_slimes` / `lots_of_slimes` 久得多，抽牌堆真的洗回来了
——黏液被打出 **46 次**，而那两个编队是 0。选批次时把「哪个编队能救回哪条盲区」一起排。

### 第四十六批：第三幕的爬升度（15 编队 × asc19，三幕两档全满）

**本批是纯追加，而且连补丁都没有。** `--install` 之前先跑过 `--check`，已提交的
**182 个文件全部逐字节复现**；装完 `git status` 只有 **15 个 `??`**（`<编队>@asc19.jsonl`），
`git diff --stat -- test/golden/traces` **为空**——零个 `M`。参考侧只加了 harness 的第七个
乘积（两个 commit：骨架 / 15 个 variant），gameplay 代码一行没动，**不需要 `ALLOW_CHANGED`**。
总例数 39465 → **41265**（+1800 = 15 × 120）；体积 899MB → **938MB**（+39MB）；
文件 182 → **197**。

⚠⚠ **装完这一批，「爬升度」这条轴在三幕上全满**：第一幕 20 + 第二幕 19 + 第三幕 15
（+ `jaw_worm_horde@asc19`，它在第一幕那份里）= **54 / 54 个编队 × {asc0, asc19}**。
`ascCalibrated` 现在只剩腐化之心一只没置（第四幕，本来就没有招式）。

#### 一、两步验证的实测（**第一步不能跳**，这是这条套路第七次做）

先只加乘积骨架与硬检查、`act3AscVariants` **留空**，跑 `tools/regen-traces.sh --check`：

```
拆出 182 个编队: CULTIST=2775 JAW_WORM=1335 … HEXAGHOST@pot12=120
→ 校验：已提交数据是否被扰动
  ✓ cultist.jsonl 全部 2775 行 —— 一致
  …（182 行，全部「—— 一致」，没有一行是别的）…
  ✓ hexaghost@pot12.jsonl 全部 120 行（冻结） —— 一致

✓ 管道能逐字节复现已提交数据
```

（`grep -c "—— 一致"` = **182**，`grep -v` 之后除了四行进度提示与末尾那句结论**一行都不剩**，
退出码 0。）过了这一步才填 variant。

#### 二、⚠⚠ 乘积怎么挂：这次**两个方向**都不冻结

第三十一批立的规矩是「新轴另开乘积挂到最后，且此后不许往前面的乘积追加 variant」。
第四十五批把它**升级成了硬检查**：`traceIdx` 只驱动遗物轮换与药水轮换，**两者都钉死的
variant 一次都不读它** ⇒ 它排在乘积里的什么位置完全无关。本批照抄那条检查：

```
emitProduct(variants, encounters);            // 第一幕，冻结
emitProduct(act2Variants, act2Encounters);    // 第二幕，冻结
emitProduct(tgtVariants, tgtEncounters);      // 目标策略，冻结
emitProduct(act3Variants, act3Encounters);    // 第三幕，冻结
emitProduct(relicVariants, relicEncounters);  // 遗物（还在每批追加）
emitProduct(potionVariants, potionEncounters);// 药水（还在每批追加）
emitProduct(act3AscVariants, act3AscEncounters); // 第三幕爬升度（本批，也还能追加）
```

于是**三条战线可以同时活着**：遗物、药水、爬升度各往各的乘积里追加，互不作废。
harness 里对 `act3AscVariants` 一共四道检查：牌组不超 96 张、遗物不超 8 颗、
**`ascension` 不许为 0**（否则文件名会退化成 `<编队>.jsonl`，去覆盖已冻结的 asc0 文件）、
**`relics` 与 `potions` 都必须非空**，外加一条「钉死的药水必须在**窄**白名单里」
（`potionSet` 是 0 ⇒ `isReplayablePotion` 不放宽）。

> **判据（第二次确认）：两条战线要并行往不同乘积追加，靠的不是「谁排最后」，
> 而是「后面那个乘积读不读 `traceIdx`」。**

#### 三、钉死的遗物 / 药水，以及那笔取舍

| 钉的                          | 为什么是它                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **金刚杵**（唯一一颗遗物）    | 整条实现就是 `initRelics` 里一句 `player.buff<PS::STRENGTH>(1)`，`src/combat` 里**再无第二个读点** ⇒ 这 15 个文件里没有任何现象能记到遗物头上。与第四十五批 `PLAIN` 同一颗 |
| **格挡药水 + 力量药水**       | 都是**纯玩家侧**，而且正好补回 asc19 拿走的两样：活得久（asc≥6 九成血入场 / asc≥14 铁甲 80→75 / asc≥10 多一张登顶者之殇）与打得动（每只怪血量与伤害都涨）                  |
| ⚠ 故意**不选**火焰 / 爆炸药水 | 它们走 `Monster::damage`——会在好几只第三幕怪被测的那条路径上再加一个写者                                                                                                   |
| ⚠ 故意**不选**熵酿            | 它从整个药水池补槽，与「钉死」正好相反                                                                                                                                     |

⚠ **asc≥11 药水槽是 2**（`GameContext.cpp:66`），所以这两瓶恰好各占一格，
`i % size` 那个循环一次都没重复。

⚠⚠ **取舍要说清楚：这 15 个文件与它们的 asc0 对应文件在遗物 / 药水上不可比**
（asc0 那些走的是 2 遗物 + 3 药水的轮换）。这是**有意**的——拿可比性换顺序无关性。
它之所以不亏，是因为本批要买的是**怪物侧**（血量档 / `ascAmount` / `minAscension` /
开局 Power 分档），而那些**全部是在同一份文件内部**用变异量的，不靠与 asc0 逐行对比。
（真正靠逐行 diff 的那种做法是第四十批的 `@relic2`/`@relic3` 与第四十五批的树皮 A/B，
本批一条都没有。）

#### 四、variant 是**派生**的，不是重打一遍

`act3AscVariants` 由 `act3Variants` 逐个复制而来，只改 `ascension` / `relics` / `potions`
三个字段。理由不是省事：

- **第三幕是唯一「各 variant 牌组不同」的乘积**——22 张（批 32~~36）/ 45 张全升级（批 37，
  觉醒者一阶段非它不可）/ 59 张全升级（批 38~~39，浩劫 + 二连击是 `onAfterUseCard` 里
  「出牌队列还非空」的唯一产出者）。手抄三副牌组去「保持一致」必然漂移。
- 派生之后「与 asc0 那份只差爬升度与 loadout」是**按构造成立**的，不是注释里的承诺。
- 撞号规则也白拿：variant 32~36 在 asc0 下共用指纹且编队互不相交，它们的 asc19 副本同理。

⚠ **一处指纹说明**：variant 32 的副本（`BATCH_1 + SPOT_WEAKNESS`、asc19）与 **variant 30**
（第二幕 asc19，同一副牌组）指纹**完全相同**。安全的理由只有一条——两者的编队列表不相交
（第二幕 vs 第三幕），所以没有任何一份文件同时收两者的行。

⚠⚠ **本批第一次让「浩劫」与「登顶者之殇」同处一副牌组**（59 张那副在 asc0 下没有诅咒，
asc≥10 才有）。开工前先把参考读清楚了：`playTopCardInDrawPile` 无条件把抽牌堆顶那张塞进
出牌队列，但 `BattleContext` 那句
`canUseCard = item.purgeOnUse || (item.triggerOnUse && c.canUse(...))`（`:864`）里的
`CardInstance::canUse` 对 **CURSE** 一族直接 `return false`（没有蓝烛，`CardInstance.cpp:322`）
⇒ `useCard()` 根本不会被调到。我们这边同一道门在 `sts-combat.ts` 里也有
（`def.type === "curse" && !hasRelic(bc, "blue_candle")`），所以两边同解、trace 照样可重放。
**判据：把一副带浩劫 / 混乱的牌组挪到 asc≥10 之前，先去 `canUse` 里数一遍那张诅咒能不能被打出。**

#### 五、覆盖：三个 Boss 的「难局面」在 asc19 下还剩多少（先量再定的第九次）

asc19 让怪更硬、玩家更脆，所以「要打到某个血线才出现」的分支会变薄。装完之后逐条数了一遍：

| 局面                                         |               asc0 |                                asc19 |
| -------------------------------------------- | -----------------: | -----------------------------------: |
| 觉醒者走到假死（`halfDead` 出现过的 trace）  |       **46 / 120** |                          **7 / 120** |
| `AWAKENED_ONE_REBIRTH` 执行                  |                 44 |                                **9** |
| 时间吞噬者 `TIME_EATER_HASTE` 出现 / trace   |        222 / 53 条 |                       **42 / 10 条** |
| 巨头 `GIANT_HEAD_IT_IS_TIME` 出现 / trace    |      1671 / 120 条 |                        1154 / 120 条 |
| 蜥蜴法师 `REPTOMANCER_SUMMON` 出现 / trace   |      1529 / 120 条 |                         794 / 120 条 |
| 迪卡 / 多努身上出现 `PLATED_ARMOR` 的帧      |              **0** | **4645（120 / 120 条，最高 12 层）** |
| 平均回合数（觉醒者 / 时间吞噬者 / 迪卡多努） | 8.55 / 7.18 / 6.81 |                   4.65 / 4.72 / 4.97 |

**结论：薄但都非 0**，所以「觉醒者复活的 `maxHp = asc9 ? 320 : 300`」与「加速 asc19 的
32 点格挡」这两条**有背书**（7 例 / 10 例，见下表）——它们是本批最薄的两条，
关门条件（更多种子 / 更强牌组）写在盲区表里。

#### 六、逐条 asc 分档的变异例数（本批的核心交付，73 条探针，41265 例基线）

⚠ 跑批前后各跑了一次**不带任何变异**的对拍，两次都是 **0 失败**；跑批期间没有提交任何东西，
只开了一个 runner（第四十五批那两次事故的两条硬规矩）。

**（甲）血量第二组（`hpHigh`）**

| 改坏的地方                                                                         |                                例数 |
| ---------------------------------------------------------------------------------- | ----------------------------------: |
| 第三幕 **15 处 `hpHigh` 整族失效**                                                 |                            **1548** |
| 尖刺客 44~60 → 低档                                                                |                             **271** |
| 爆破怪 30~35 → 低档                                                                |                             **270** |
| 斥力怪 31~38 → 低档                                                                |                             **248** |
| 尖塔增生 / 暗影客 / 蠕动血块 / 巨头 / 复仇魔 / 蜥蜴法师 / 时间吞噬者 / 迪卡 / 多努 |                          **120** 各 |
| 暗球游荡者 92~~102 / 觉醒者 300~~320                                               |                          **114** 各 |
| 匕首 20~25 → 低档                                                                  | **0**（两组区间逐字相同，见「七」） |

**（乙）`preBattleAction` 的分档**

| 改坏的地方                                   |                      例数 |
| -------------------------------------------- | ------------------------: |
| 尖刺客荆棘 asc17 档 7 → 4                    |                   **277** |
| 暗球游荡者 `GENERIC_STRENGTH_UP` asc17 5→3   |                   **120** |
| 复形怪消逝 asc17 6 → 5                       |                   **120** |
| 觉醒者 **asc4 那条多出来的 +2 力量**整条去掉 |                   **120** |
| 觉醒者好奇心 asc19 2 → 1                     |                   **120** |
| 觉醒者再生 asc19 15 → 10                     |                   **120** |
| 迪卡与多努神器 asc19 3 → 2                   |                   **120** |
| 尖刺客荆棘**中间档** 4 → 5                   | **0**（三档的中间那一档） |

**（丙）出招规则 / 建怪的分档**

| 改坏的地方                                               |                       例数 |
| -------------------------------------------------------- | -------------------------: |
| 尖塔增生缠绕的 `asc17 \|\| roll >= 50` 去掉 asc17 那一支 |                     **58** |
| 暗影客撕咬伤害的 `asc2 ? random(9,13) : random(7,11)`    |                    **120** |
| 暗球游荡者 / 蜥蜴法师的**白掷区间**抄成高档              | **0** 各（结构性不可观测） |
| 匕首 8→7 / 巨头 8→7 / 时间吞噬者 9→8（**阈值**抄错）     |                   **0** 各 |

**（丁）`takeTurn` 的数值分档**（把某一档改回基础值）

| 怪          | 分档                                                                                                                               |                                      例数 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------: |
| 爆破怪      | 撞击 asc2 11                                                                                                                       |                                   **242** |
| 斥力怪      | 撞击 asc2 13                                                                                                                       |                                   **106** |
| 尖刺客      | 切割 asc2 9                                                                                                                        |                                   **218** |
| 暗球游荡者  | 激光 asc2 11 / 利爪 asc2 16                                                                                                        |                             **105 / 103** |
| 尖塔增生    | 急冲 asc2 18 / 重砸 asc2 25 / 缠绕层数 asc17 12                                                                                    |                         **89 / 96 / 120** |
| 大嘴        | 咆哮虚弱 asc17 5 / 咆哮脆弱 asc17 5 / 流涎力量 asc17 5 / 重击 asc2 30                                                              |                 **120 / 120 / 120 / 105** |
| 暗影客      | 啃食 asc2 9 / 撕咬 `ascAdd` +2 / **硬化 asc17 那层力量**（整条）                                                                   |                       **108 / 120 / 120** |
| 复形怪      | 重殴基础 asc2 40                                                                                                                   |                                   **120** |
| 蠕动血块    | 强击 38 / 多重打击 9 / 连枷伤害 16 / 连枷格挡 18 / 凋零 12（都是 asc2）                                                            |                **44 / 77 / 73 / 85 / 80** |
| 巨头        | 「时候到了」asc3 40                                                                                                                |                                   **120** |
| 复仇魔      | 多重打击 asc3 7 / 灼烧张数 asc3 5                                                                                                  |                             **120 / 111** |
| 蜥蜴法师    | **召唤只数 asc18 2** / 毒牙 asc3 16 / 巨口 asc3 34                                                                                 |                         **120 / 58 / 26** |
| 觉醒者      | **复活 `maxHp = asc9 ? 320 : 300`**                                                                                                |                                 **7** ⚠薄 |
| 时间吞噬者  | 回响 asc4 8 / 头槌 asc4 32 / **头槌 asc19 两张黏液**（整条） / **涟漪 asc19 那层脆弱**（整条） / **加速 asc19 的 32 格挡**（整条） | **109 / 90 / 104 / 101 / 10** ⚠最后一条薄 |
| 迪卡 / 多努 | 光束 asc4 12                                                                                                                       |                             **113 / 118** |

**（戊）守护方阵 asc19 的镀甲——本批新原语 `buff_ally_fixed` 的背书**

| 改坏的地方                                                        |                    例数 |
| ----------------------------------------------------------------- | ----------------------: |
| 两句镀甲**整条**去掉（= 回到第三十九批那个「没转写」的状态）      |                 **120** |
| 只去掉**自己**那句（`apply_power` + `on:"self"`）                 |                 **120** |
| 只去掉**给多努**那句（`buff_ally_fixed`）                         |                 **120** |
| ⚠⚠ **`buff_ally_fixed` 的下标抄成 0 号位**（= 复用 `buff_ally`）  |                 **120** |
| 镀甲层数 3 → 2                                                    |                 **120** |
| `buff_ally_fixed` 的 `noAliveGate` 去掉（补上 `monstersAlive>1`） | **0**（盲区，见「七」） |

⚠ 第四行是这个原语存在的**唯一理由**的直接背书：`buff_ally` 写死 0 号位、这一条写死 1 号位，
而迪卡站 0 号位。复用邻居会让迪卡拿 6 层、多努拿 0 层——**120 例，整份文件**。
⚠ 反过来说，「整条去掉」与「只去掉一半」都是 120 例，说明**分不出哪一半更重要**：
两句都必须写，例数说明不了顺序（顺序是照抄的，当前不可观察）。

#### 七、0 例的八条，逐条分类

⚠ 三类分开记：**结构性不可观测**（形状本身没有可观察面，别去找逃生口）/
**盲区**（有可观察面、当前语料走不到，附关门条件）/ **等价改写**。

| 改法                                        |  例数 | 分类                                                                                                                                                                                       |
| ------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 匕首 `hpHigh` 20~25 → 低档                  | **0** | **结构性不可观测**：`MonsterIds.h:166` 两组**逐字相同** `{{20,25},{20,25}}`，任何爬升度下取值都一样。写它是为了「表就是参考的转写」这条不变量，不是为了拿例数                              |
| 匕首阈值 8 → 7（按「随从 = 普通怪」猜）     | **0** | **盲区**：asc19 下 7 与 8 都取高档。第二十二批（第一幕）与第三十批（火炬头）已经量过同一件事，这是第三次。守着它的只有 `data-tables.test.ts` 那张逐怪期望阈值表。**关门条件：asc7 + asc8** |
| 巨头阈值 8 → 7                              | **0** | 同上                                                                                                                                                                                       |
| 时间吞噬者阈值 9 → 8                        | **0** | 同上（关门条件 **asc8 + asc9**）                                                                                                                                                           |
| 暗球游荡者白掷区间 90~~96 → 92~~102         | **0** | **结构性不可观测**（第二十七批已证、第三十三批复量）：取值被丢弃，而 `Random::nextLong(n)` 的前进步数与 n 无关。**次数**有背书                                                             |
| 蜥蜴法师白掷区间 180~~190 → 190~~200        | **0** | 同上。⚠ 这两条是这一族**四个宿主**在 asc19 下的第一次复量，结论不变                                                                                                                        |
| 尖刺客荆棘**中间档** `{3,4,7}` 的 4         | **0** | **盲区**：`{0,19}` 只取得到两端。与第三十批那四条（秘法师鼓舞 / 地精首领鼓舞 / 工头伤口 / 冠军暴怒）同族，**关门条件 asc16**——这一族现在一共 **5 条**                                      |
| 守护方阵 `buff_ally_fixed` 的 `noAliveGate` | **0** | **盲区**：要「多努先死」的局面，而策略恒打 0 号位 ⇒ 迪卡先死。**关门条件 `donu_and_deca@tgt1`**——与第三十九批那条格挡的 `noAliveGate` **同一条**，本批顺手复量了那一条，asc19 下**也是 0** |

⚠ 最后一行值得单记：第三十九批把「格挡那条 `noAliveGate`」记成盲区、关门条件写的是
`@tgt1`。本批**在 asc19 语料上重量了一次，仍然 0 例**——**爬升度这条轴救不了它**，
裁定不变（那条盲区卡的是「场上局面」，不是「回合数」）。本批新加的镀甲那一半**同源**，
两条应当合并成一条记。

#### 八、第二组变异：asc18 一次召两只**关掉了第三十六批那两条盲区**

`reptomancerSummon(bc, asc18 ? 2 : 1)` 在 asc0 下恒召 **1** 只，于是「循环体跑两遍」这件事
从来没发生过。第三十六批因此记了两条盲区，关门条件写的都是 `asc >= 18`。本批兑现：

| 改坏的地方                                             |    例数 | 结论                                                                                                    |
| ------------------------------------------------------ | ------: | ------------------------------------------------------------------------------------------------------- |
| `searchOrder` **去掉第 4 项**（`{4,1,3,0}`→`{4,1,3}`） |  **58** | ✅ **关掉**（此前 0）：一次召两只才会把 4/1/3 用光、轮到 0 号位                                         |
| `noOpRollMove` **挪到循环外**（只还一次）              | **120** | ✅ **关掉**（此前 0）。⚠ 恰好等于 `reptomancer@asc19.jsonl` 整份——asc0 下循环只跑一遍，那条改动是空操作 |
| `searchOrder` 抄成升序 `{0,1,3,4}`                     | **471** | 不是新的：第三十六批就有背书，这里只是复量（跨四份 reptomancer 文件）                                   |
| `bc.skipTurn.add(daggerIdx)` 整条去掉                  | **415** | 同上，复量                                                                                              |
| `++monstersAlive` **整条去掉**                         | **416** | 复量（⚠ 这条量的是「去掉」，不是「挪位置」，别与下一行混）                                              |
| `++monstersAlive` 真的**挪到循环外**（`+= n`）         |   **0** | **等价改写**（不是盲区）：循环体里没有任何一句读 `monstersAlive`，可证同解                              |

⚠⚠ **这一组还踩到一次「假的非 0」，形状是第四种，值得单独记住：探针用 `String.replace`
取了字符串的第一处匹配，而那处不在被测函数里。** 第一版的 `noOpRollMove` 探针写的是
`src.replace("    bc.rng.aiRng.random(99); // ★ …", …)`，可那一行在 `sts-combat.ts` 里
**出现两次**：先是**收藏家**的 `SpawnTorchHeads`（`:4409`），才是蜥蜴法师的
`reptomancerSummon`（`:4478`）。于是它红了 **975 例**——比 reptomancer 全部四份文件的
480 行还多，**那才是唯一戳破它的线索**。改成「先定位函数体、只在它里面替换」之后是 120 例。

> **判据（补一条）：探针红出来的例数一旦**超过被测宿主的分母**，先别高兴，去数一遍
> 那个字符串在文件里出现了几次。** 这与第三十六批「参考侧做同样的改动会不会也变」那条互补：
> 那条问的是语义，这条问的是**探针落点**。
> ⚠ 顺带一条工程结论：**批量探针脚本不要用裸的 `String.replace`**，要么带 occurrence 下标、
> 要么先把替换范围收窄到一个 def / 一个 move / 一个函数体（本批的跑批脚本三种都用了）。

### 第四十五批：药水战线开张——「喝药时机」这条轴 + 15 瓶（13 → 28 / 42）

药水这条子线的第一批，做了两件事：

1. **甲、开「喝药时机」这条轴**（`potionSet` / `potionPolicy` 两个字段、第六个乘积、
   文件名后缀 `@potN`）。它不是为了好看：历来的 `pickAction` 把喝药排在出牌**之前**且
   从不拒绝，三瓶药一律在**第 0 回合、满血**喝光，于是**一整族行为是结构性死的**。
2. **乙、15 瓶药水的转写**，外加它们要的三块共享原语（玩家侧 REGEN / 玩家侧 RITUAL /
   DUPLICATION）。

管线怎么做、白名单为什么不能全局放宽、新乘积为什么没有冻结 `relicVariants`——
全部写在 WORKFLOW 的「药水这条轴」一节，这里只记账与测量。

#### 数据规格与体积

| 项       | 值                                                       |
| -------- | -------------------------------------------------------- |
| 新增文件 | **19** 个 `@pot1`~`@pot12`（12 个 potionSet × 各自编队） |
| 每份     | 120 行（40 种子 × 3 层），整份冻结                       |
| 对拍例数 | 37186 → **39466**（+2280）                               |
| 体积     | 816MB / 163 文件 → **899MB / 182 文件**                  |
| 既有文件 | 163 个**逐字节不变**（`--install` 复核，0 个被扰动）     |
| 指纹撞号 | 19 个新文件逐个跑过 `variant0-rows.mjs`，全部 = 整份行数 |

#### 一、甲：两步验证的实测（**第一步不能跳**）

只加 `potionSet` / `potionPolicy` 两个字段、`@potN` 后缀、指纹两维、以及**放宽后的整张
可重放药水白名单**，`potionVariants` 留空 → `tools/regen-traces.sh --check`：

```
拆出 163 个编队: CULTIST=2775 JAW_WORM=1335 … COLLECTOR@relic17=120
→ 校验：已提交数据是否被扰动
  ✓ cultist.jsonl 全部 2775 行 —— 一致
  … （163 行，一条 ✗ 都没有）
  ✓ collector@relic17.jsonl 全部 120 行（冻结） —— 一致

✓ 管道能逐字节复现已提交数据
```

#### 二、甲：策略规则，以及它造出的局面（先量再定，第八次）

`potionPolicy 1` 的规则是一句话：**`curHp * 2 <= maxHp` 才肯喝**（「半血及以下」）。
选这个谓词有三条理由，都不是审美：

1. 它是**参考自己的写法**——`Player::heal` 的 `wasBloodied`、红骷髅、血瓶用的都是这个整数式。
2. 它**在第 1 回合结构性不可能成立**：asc < 6 时 `GameContext::initPlayer` 让玩家满血入场。
   于是「至少经过一个怪物回合」是白拿的，「怪加过格挡之后再喝」也跟着白拿。
3. 铁甲 maxHp 80 ⇒ 门保证 `curHp <= 40` ⇒ 血之药水 as-built 的 32 点**永远不会被
   `min(maxHp, …)` 夹掉**，40% 与 20% 之间隔着 16 点血，一眼可辨。

实测（12 个测量 variant × 7 个候选编队 × 120 条）：

| 量                              | `potionPolicy 0`                            | `potionPolicy 1`                      |
| ------------------------------- | ------------------------------------------- | ------------------------------------- |
| 平均在第几回合喝                | **0.00**                                    | **7.27**                              |
| 喝的时候玩家血量（均值 / 区间） | **80.0 / 80~80**                            | **32.5 / 1~40**                       |
| 血之药水实际回复量              | **0**（360 / 360 次被夹平）                 | **32**（240 / 240 次，带树皮恒 16）   |
| 液态记忆看到的弃牌堆张数        | **0.0**（360 / 360 次是空的 ⇒ 当场 return） | **8.4**，开屏选牌 **1361** 次         |
| 喝的那一刻场上有怪带着格挡      | 360（**全部**是拉加维林开局自带的 8 点）    | 296（champ 223 / three_darklings 73） |
| 平均回合数                      | 7.21                                        | 8.80                                  |

三类局面因此全部造了出来：**回复量可观察**、**条件分支（弃牌堆非空）可达**、
**「怪加过格挡之后再喝」不再只有拉加维林那一种**。

⚠ **编队也要量，而且差别极大**：policy 1 下 `three_sentries` 有 **112 / 120 条一口药都
没喝**（玩家赢得太轻松，血一直在半血以上）、`gremlin_nob` 95、`lagavulin` 66，而
`champ` 与 `three_darklings` 是 **0**。**「仗长」不等于「玩家会掉血」**——安装用的
两个编队因此只取后两个。

⚠ **一个涌现出来的行为**：policy 1 下喝完血之药水会把血抬回半血以上，于是**三瓶不再一次
喝光**（`@pot1` 240 条喝了 658 次而不是 720 次）。这不是 bug，但「一个 variant 里三瓶各喝
几次」从此不相等，写测量表时别默认它们相等。

#### 三、乙：可重放性的逐条判断（42 瓶 = 13 已登记 + 15 本批 + 14 排除）

⚠ **总数是 42 不是 45**：`Potion` 枚举去掉 `INVALID` / `EMPTY_POTION_SLOT` 正好 42 项，
`drinkPotion` 的 switch 有 41 条 case（`FAIRY_POTION` 落进 `default`）。

**本批登记的 15 瓶**（逐条 id + 参考定位 + 一句话效果）：

| 药水                             | 参考定位               | 效果（非树皮 / 树皮）                                           |
| -------------------------------- | ---------------------- | --------------------------------------------------------------- |
| 灵活药水 `flex_potion`           | BattleContext.cpp:2372 | 力量 +5/+10，同时上等量 `LOSE_STRENGTH`（**过神器**）           |
| 速度药水 `speed_potion`          | :2384                  | 敏捷 +5/+10 + 等量 `LOSE_DEXTERITY`，与上一条逐字同形           |
| 铁心药水 `heart_of_iron_potion`  | :2359                  | 金属化 6/12                                                     |
| 液态青铜 `liquid_bronze`         | :2362                  | 荆棘 3/6                                                        |
| 钢铁精华 `essence_of_steel`      | :2356                  | 玩家侧镀甲 4/8                                                  |
| 罐中幽灵 `ghost_in_a_jar`        | :2392                  | 虚无缥缈 1/2（**潜行者专属**，铁甲的池里摇不出来）              |
| 集中药水 `focus_potion`          | :2378                  | 集中 2/4（参考战斗内**一次都不读**，全部可观察面就是快照）      |
| 再生药水 `regen_potion`          | :2421                  | 玩家侧再生 5/10                                                 |
| 邪教徒药水 `cultist_potion`      | :2313                  | 玩家侧仪式 1/2（**没有 skipFirst**）                            |
| 复制药水 `duplication_potion`    | :2333                  | 复制 1/2，四个 `onUseXxxCard` 各一格 + 回合末无条件 -1          |
| 熔炉祝福 `blessing_of_the_forge` | :2288                  | 升级手上每一张牌（**不过 `canUpgrade`**，也**不吃树皮**）       |
| 灵液 `elixir_potion`             | :2335                  | `ExhaustMany(10)`，与净化共用动作（**不吃树皮**，10 写死）      |
| 蛇形油 `snecko_oil`              | :2425                  | 抽 5/10 张 + `RandomizeHandCost`（洗费用那半**不吃树皮**）      |
| 混沌精华 `distilled_chaos`       | :2323                  | 排 3/6 条 `PlayTopCard`，★ **每份在入队时掷一次 cardRandomRng** |
| 液态记忆 `liquid_memories`       | :2340                  | 弃牌堆 → 手牌 1 张并压成本回合 0 费                             |

**排除的 14 瓶**，六族，其中**三族是本批新发现的判据**：

| 族                               | 例                                                 | 判据                                                                                                                                           |
| -------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 从整个牌池随机造牌               | 攻击 / 技能 / 能力 / 无色药水（`DiscoveryAction`） | 随机牌可能是**未登记**的牌 ⇒ trace 不可重放。⚠ 与「改已有牌的费用 / 升级位」**不是**一回事（第四十四批的判据），后者可以登记                   |
| 造一张参考没实现的牌             | 瓶中奇迹（MIRACLE）/ 诡计药水（SHIV）              | 与 `seek` 同族：那张牌三个 switch 里都没有 case，永远没有预言机                                                                                |
| 需要姿态                         | 神仙玉露 / 姿态药水                                | 没有姿态模型，且 `changeStance` 会连锁排动作                                                                                                   |
| ⚠⚠ **动作是默认构造的 `Action`** | 暗影精华 / 容量药水 / **毒药**                     | `Actions::X` 直接 `return sts::Action();` ⇒ 空的 `std::function`，`executeActions` 那句 `a(*this)` 抛 `bad_function_call`、harness 当场终止    |
| 参考的实现是 `// todo`           | 烟雾弹                                             | 登记它等于交付「喝了什么都不发生」，而真实游戏是逃跑——与什锦（遗物）同族，永远不能登记                                                         |
| 压根没有 case / 不是喝的         | 仙女瓶                                             | 落进 `default:` 的 `assert(false)`；`search::Action::isValidAction` 也拒绝它，它是 `Player::wouldDie` 里被动消耗的                             |
| 参数是**上一次开屏的残值**       | 赌博酿                                             | `Actions::GambleAction` 从不设 `pickCount`，GAMBLE 的合法性检查也不读它 ⇒ 弃几张由上一块屏遗留的值决定。**可重放但是参考的缺陷**，报告不打补丁 |

⚠⚠ **毒药那一条要单独记住：它的崩溃是延迟的。** `DebuffEnemy<MS::POISON>` 本身跑得好好的，
`Monster::applyStartOfTurnPowers`（`Monster.cpp:36-38`）要到**那只怪的下一个回合**才入队
`Actions::PoisonLoseHpAction()`——同样是空 Action。「试一下没崩就行」会漏掉它。
**判据：登记之前先 `grep -n 'Action Actions::<名字>' src/combat/Actions.cpp` 看函数体，
别只看 `drinkPotion` 那条 case。**

✅ **暗影精华从此是「未登记药水」的永久测试样本**（`sts-combat-rules.test.ts` 与
`sts-combat-wiring.test.ts` 各一条，原样本 `snecko_oil` 被本批登记了）。它与卡牌那边的
`seek` 同族——**结构性没有预言机**，不像编队那条样本每几批要换一次。

#### 四、12 个 variant 的分组

| 文件后缀            | 药水                           | 时机  | 遗物                  | 编队                        |
| ------------------- | ------------------------------ | ----- | --------------------- | --------------------------- |
| `@pot1`             | 血之药水 + 液态记忆 + 罐中幽灵 | **1** | 金刚杵                | champ、three_darklings      |
| `@pot2`             | 同上                           | **1** | 金刚杵 + **神圣树皮** | 同上                        |
| `@pot3` / `@pot4`   | 灵活 + 速度 + 钢铁精华         | 0     | 金刚杵 / +树皮        | champ(+three_darklings)     |
| `@pot5` / `@pot6`   | 铁心 + 液态青铜 + 集中         | 0     | 金刚杵 / +树皮        | champ(+hexaghost)           |
| `@pot7` / `@pot8`   | 再生 + 邪教徒 + 复制           | 0     | 金刚杵 / +树皮        | hexaghost + slime_boss      |
| `@pot9` / `@pot10`  | 熔炉祝福 + 灵液 + 蛇形油       | 0     | 金刚杵 / +树皮        | three_sentries + slime_boss |
| `@pot11` / `@pot12` | 混沌精华                       | 0     | 金刚杵 / +树皮        | hexaghost + slime_boss      |

三条分组理由：

1. ⚠ **槽位只有 3 个**（`bc.potionCapacity`，`variant.potions` 按 `i % size` 循环填），
   所以**一个 variant 最多同时表达 3 瓶**。15 瓶因此至少 5 个 variant——与「8 颗遗物挤一个
   variant」完全不是一个量级。
2. ⚠ **每组配一个「只多一颗神圣树皮」的 B 面**。`drinkPotion` 里 `hasBark ? A : B` 有 33 条、
   每条两个独立字面量；成对的 variant 让那 15 对分档一次拿到背书，而且 A / B 两个方向的
   变异例数天然分开（A 面文件 240，B 面 120）。
3. ⚠ **混沌精华单独关一组**：三瓶在第 0 回合白打 9 张牌，平均回合数从 ~7.2 掉到 **4.38**
   （`gremlin_nob` 只剩 0.42 回合），与第四十三批「五颗 `energyPerTurn++`」同族。
4. ⚠ **`slime_boss` 是复制药水那条**状态牌** handler 的唯一宿主**——黏液是策略唯一打得
   出去的状态牌（`CardInstance.cpp:329` 的 `id != SLIMED` 例外），与第四十二批给墨水瓶
   第四个 handler 选编队是同一条理由。

#### 四之二、⚠⚠ 神圣树皮的 A/B 是**逐行 diff**，不是靠变异推的

`@pot1` 与 `@pot2` 的输入差别**只有一颗神圣树皮**（牌组 / 种子 / 楼层 / 爬升度 / 目标策略 /
药水清单 / 喝药时机逐字相同，`relics` 从 `["vajra"]` 变成 `["vajra","sacred_bark"]`）。
实测 **120 / 120 行全部不同**（两个编队都是），血之药水的实际回复量一份恒 32、一份恒 16。
这与第四十批的御守 A/B 是同一招，六组各做了一对。

#### 四之三、⚠⚠ 一次事故：跑变异测试时**不许提交、也不许并发**

本批踩了两次，都写进 WORKFLOW 了：

1. 跑批在后台时前台 `git add -A` 提交文档，把「集中药水 2 → 3」那条探针一起提交了
   ——**对拍当场红 240 例**，另开了一个 `fix` commit 修回来。⚠ 更阴的是此后
   `git checkout -- <file>` 还原到的是**带探针的 HEAD**。
2. 「等日志写满 N 行就启动第二个脚本」的 waiter 在第一个脚本**还剩两条**时就触发了，
   两个进程同时改同一个文件 ⇒ 受影响的六条数字作废、重跑。

**重跑脚本因此在第一条探针之前先跑一次不带变异的基线**，把「还原干不干净」变成一个
打印出来的数字（`BASE 0`）而不是假设。

#### 五、⚠⚠ 血之药水 × 神圣树皮：本批把判据 ① 关掉了，③ 仍然不过

TODOS「待裁定」里那条的关门条件是「先改策略让回复量可观察」。**本批兑现了它，
而且结论是：数据现在完全分得开三种写法，但仍然不能拍板。**

| 写法                            | `@pot1`（无树皮）回复量 | `@pot2`（有树皮）回复量 |
| ------------------------------- | ----------------------- | ----------------------- |
| **as-built** `hasBark ? 20:40`  | **32**（240 / 240 次）  | **16**（240 / 240 次）  |
| `hasBark ? 80 : 40`             | 32（不变）              | 64（被 maxHp 夹）       |
| `hasBark ? 40 : 20`（真实游戏） | 16                      | 32                      |

- **① 在已登记内容里产生分歧 —— 现在成立**（此前不成立）：把 as-built 改成
  `hasBark ? 40 : 20` 红 **480 例**、改成 `hasBark ? 80 : 40` 红 **240 例**（只动 B 面）。
- ② 有预言机（重新生成即可自洽）—— 成立。
- ③ **行为唯一 —— 仍然不成立**，而且本批的数据**不可能**关掉它：数据是**参考自己**产出的，
  它永远与 as-built 一致，所以它能证明「分歧存在」却证不了「哪一个才是真实游戏」。

**裁定不变：照抄 as-built、不打补丁。** ⚠ 但**失败的那一条换了**：从「① 不成立
（当前数据里根本没有分歧）」变成「**③ 不成立（需要真机 ground truth）**」。
按 WORKFLOW 的分类，它从「覆盖面扩大后自己会解锁」那一族**转入**「拿到第二个信源之前
永远补不了」那一族——与地精头目 asc18 自锁同类。

#### 六、逐瓶的变异例数（本批的核心交付，53 条探针，39466 例基线）

上限：A 面（无树皮）文件 **240**（两个编队 × 120）或 **120**（单编队），B 面 **120**。
⚠ 跨 variant 的探针（复制 / 蛇形油之类同时落在 A、B 两面的）上限是两者之和。

**甲族：一句 `BuffPlayer`，两个方向各一条**

| 探针                        | 例数    | 探针（树皮档） | 例数    |
| --------------------------- | ------- | -------------- | ------- |
| 灵活药水 力量 5 → 4         | **240** | 树皮档 10 → 9  | **120** |
| 灵活药水 去掉 LOSE_STRENGTH | **360** | —              | —       |
| 速度药水 敏捷 5 → 4         | **240** | 树皮档 10 → 9  | **120** |
| 铁心药水 金属化 6 → 5       | **240** | 树皮档 12 → 11 | **120** |
| 液态青铜 荆棘 3 → 2         | **240** | 树皮档 6 → 5   | **120** |
| 钢铁精华 镀甲 4 → 3         | **240** | 树皮档 8 → 7   | **120** |
| 罐中幽灵 虚无缥缈 1 → 2     | **209** | 树皮档 2 → 1   | **231** |
| 集中药水 集中 2 → 3         | **240** | 树皮档 4 → 3   | **120** |
| 再生药水 再生 5 → 4         | **240** | 树皮档 10 → 9  | **120** |
| 邪教徒药水 仪式 1 → 2       | **240** | 树皮档 2 → 1   | **120** |
| 复制药水 层数 1 → 2         | **240** | 树皮档 2 → 1   | **120** |

⚠ 罐中幽灵那两个数（209 / 231）不是 240 / 120，因为它在 `@pot1` / `@pot2` 里走的是
**potionPolicy 1**——有 31 / 9 次因为玩家一直没掉到半血而压根没喝。这正是那条轴的代价，
如实记着。

**玩家侧 REGEN / RITUAL 的结算形状**

| 探针                                                | 例数    | 说明                               |
| --------------------------------------------------- | ------- | ---------------------------------- |
| 再生：改成「先递减、再按新层数回血」                | **324** | 每回合少回 1 点                    |
| 再生：去掉回合末递减（抄成怪物侧那条）              | **360** | 变成一层不掉                       |
| 再生：两条 `addToTop` 改成 `addToBot`               | **0**   | 等价改写，见「七」                 |
| 仪式（玩家侧）：**真的**补上 skipFirst              | **360** | ⚠ 第一版探针是**假的 0**，见「七」 |
| 仪式（玩家侧）：加力量改走 `debuffPlayer`（过神器） | **0**   | 盲区，见「七」                     |

**复制：四个 handler + 两个递减点**

| 探针                                      | 例数    |
| ----------------------------------------- | ------- |
| 去掉**攻击牌**那一格                      | **275** |
| 去掉**技能牌**那一格                      | **112** |
| 去掉**能力牌**那一格                      | **24**  |
| 去掉**状态 / 诅咒牌**那一格               | **0**   |
| 去掉 handler 里的递减（层数不消耗）       | **360** |
| 去掉回合末那次无条件递减                  | **0**   |
| 去掉 `!purgeOnUse` 那道门（复制的再复制） | **120** |

**乙族 + 丙族**

| 探针                                                   | 例数              |
| ------------------------------------------------------ | ----------------- |
| 熔炉祝福：整条效果去掉                                 | **163**           |
| 熔炉祝福：补上 `canUpgrade` 过滤                       | **0**             |
| 灵液：`ExhaustMany(10)` → `(3)`                        | **360**           |
| 蛇形油：抽 5 → 4 / 树皮档 10 → 9                       | **240** / **120** |
| 蛇形油：只写 `costForTurn`（不永久改 `cost`）          | **332**           |
| 蛇形油：两条动作调换（先洗费用再抽牌）                 | **360**           |
| 蛇形油：洗费用去掉 `cost >= 0` 那道门                  | **0**             |
| 混沌精华：份数 3 → 2 / 树皮档 6 → 5                    | **240** / **120** |
| 混沌精华：`exhausts` 改成 true（抄成浩劫）             | **360**           |
| 混沌精华：目标改成执行时才掷（而不是入队时）           | **0**             |
| 液态记忆：不把选中的牌压成 0 费                        | **369**           |
| 液态记忆：拿副本、不从弃牌堆移出                       | **397**           |
| 液态记忆：空弃牌堆也开屏（去掉提前返回）               | **43**            |
| 液态记忆：「弃牌堆恰好一张就直接取」那一支改成照样开屏 | **0**             |

**血之药水 × 神圣树皮（TODOS 待裁定那条）**

| 探针                                           | 例数    |
| ---------------------------------------------- | ------- |
| 改成 `hasBark ? 40 : 20`（对齐真实游戏）       | **480** |
| 改成 `hasBark ? 80 : 40`（只掰方向、保住基数） | **240** |
| 非树皮档 40 → 39                               | **240** |

#### 七、0 例的七条，逐条分类

| #   | 0 例的那条                            | 类别             | 理由 / 关门条件                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 玩家侧仪式「补上 skipFirst」第一版    | ⚠ **假的 0**     | 探针把 `justApplied` 塞进判据，而 `addPower` 从不写那个字段 ⇒ else 支恒被走到。**换成「跳过第一个回合末」之后红 360 例**（WORKFLOW 里「改了一个没人读的标志位」那一种）                                                                                                          |
| 2   | 再生的两条 `addToTop` 改成 `addToBot` | 等价改写         | 那一刻队列是空的（燃烧 / 炸弹 / 束缚都不在这两个 variant 的内容里），谁先谁后同解。关门条件：**再生药水 + 燃烧或束缚**同处一个 variant                                                                                                                                           |
| 3   | 玩家侧仪式加力量改走 `debuffPlayer`   | 盲区             | 两者只在**有神器**时分岔（`Player::debuff` 的神器门），而 `@pot7` / `@pot8` 里没有神器来源。关门条件：邪教徒药水 + 古代药水 / 三哨卫（开局各 1 层神器）                                                                                                                          |
| 4   | 复制：状态 / 诅咒牌那一格             | 盲区（**量过**） | 选 `slime_boss` 就是为了这一格，但**层数在第 0 回合的第一张牌上就用光了**：实测打出黏液 229 次 / 106 条，其中身上还有复制层数的 **0** 次。关门条件：**复制药水 ×3 槽 + potionPolicy 1 + slime_boss**——实测「半血之后打出的前 3 张牌里黏液占 **24 / 152**」，所以那样配大概率非 0 |
| 5   | 复制：回合末那次无条件递减            | 盲区（**量过**） | 同源：三个槽位是三瓶**不同**的药，复制只有 1 层（树皮 2 层），恒在同回合被牌吃掉。实测「结束回合那一帧还带着层数」**0 / 360 帧**。关门条件同上                                                                                                                                   |
| 6   | 熔炉祝福补上 `canUpgrade` 过滤        | 盲区             | 要手牌里有**不可升级**的牌（状态 / 诅咒），而 policy 0 在第 0 回合喝，那时手牌全是起始牌组。关门条件：熔炉祝福 + potionPolicy 1 + `slime_boss`                                                                                                                                   |
| 7   | 蛇形油去掉 `cost >= 0` 那道门         | 结构性盲区       | 要手牌里有**负费用**的牌（X 费 / 腐化 / `freeToPlay`），22 张牌组里一张都没有。关门条件：牌组加 X 费牌（旋风斩已登记）或腐化                                                                                                                                                     |
| 8   | 混沌精华的目标改成执行时才掷          | 等价改写         | 两个 variant 都是**单怪**编队（hexaghost / slime_boss 开局各一只），下标恒 0；而入队与执行之间没有别的 `cardRandomRng` 消费者，流也不错位。关门条件：多怪编队                                                                                                                    |
| 9   | 液态记忆「弃牌堆恰好一张」那一支      | 盲区（**量过**） | 实测 440 次饮用里弃牌堆恰好 1 张的有 **0** 次（空 43 次、≥2 张 397 次）。这一支要「刚洗完牌、只打出过一张」那种很窄的局面                                                                                                                                                        |

### 第四十四批：遗物战线第五批——`RelicInstance.data` 接线 + 多钩子那一族（29 颗）

第四十三批把「战斗内只有一个读点」的那一族一次吃完，剩下的全是**多钩子**的（每颗 2~9 个
读点，散在 `initRelics` 的三个循环、两条回合边界、三条伤害路径、`onUse*Card` 四个 handler、
`Player::heal` / `wouldDie` / `gainGold` 里）。本批做了三件事：

1. **甲、`RelicInstance.data` 接线** —— 一条解锁六颗，而且它是「多钩子」这一族的共同前置。
2. **乙、`relics.ts` 与参考 `RelicId` 的全表比对** —— 起因是 `bloody_idol` 那个洞。
3. **丙、29 颗遗物的转写**。

**装完是 87 / 180。** 剩下的战斗内多钩子遗物只有 11 颗，逐条排除理由见「四、丙」——
其中**只有两族是真的还能做的**：医疗包 / 蓝色蜡烛（要先给状态牌与诅咒牌补「打出」行为）、
扭曲漏斗（要先建中毒）。其余九颗要么没有预言机（参考里是 `// todo` 或被注释掉），
要么 trace 不可重放（整池随机造牌 / 多选屏）。

#### 数据规格与体积

| 项         | 值                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| harness    | `relicVariants` 追加**六个** variant（relicSet **12~17**），前 11 个一个字没动                                         |
| 牌组       | 22（`BATCH_1 + SPOT_WEAKNESS`）／26（+4 狂暴，`@relic13` `@relic15`）／30（+2 旋风斩 +2 贪婪之手 +4 狂暴，`@relic16`） |
| 种子 / 层  | 40 / `{1,3,7}`                                                                                                         |
| 爬升度     | **0**；目标策略 **0**                                                                                                  |
| 文件       | **13 份**，每份 120 行、整份冻结（276K~6.0MB，合计 43MB）                                                              |
| 例数       | 1560，对拍 35626 → **37186**                                                                                           |
| 体积       | **43MB**，仓库 772MB → **816MB**，文件数 150 → **163**                                                                 |
| 扰动       | `--install` 报 **0 个 ✗**、13 个 `+`；13 份文件 `variant0-rows.mjs` 逐个 = 整份 120 行                                 |
| 参考补丁   | **无**（`ALLOW_CHANGED` 一次都没用）                                                                                   |
| trace 格式 | 新增 `relicData`（只在有非 0「数值」data 时输出）；两步验证：只加字段跑 `--check`，**150 个文件逐字节复现**            |

#### 〇、29 颗清单（逐条 id + 参考定位）

| #   | 遗物                            | 参考读点                                                                         | 组          |
| --- | ------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| 1   | 快乐花 `happy_flower`           | `BattleContext.cpp:148`（`= r.data + 1`）/ `Player.cpp:521` / exit `:524`        | @relic12    |
| 2   | 熏香炉 `incense_burner`         | `:156` / `Player.cpp:535` / exit `:528`                                          | @relic12    |
| 3   | 日晷 `sundial`                  | `:218` / `onShuffle` `:2835` / exit `:559`                                       | @relic12    |
| 4   | 双节棍 `nunchaku`               | `:181` / `onUseAttackCard` `:1740` / exit `:546`                                 | @relic12    |
| 5   | 笔尖 `pen_nib`                  | `:189` / `:1686` 摘 / `:1728` 计数 / `calculateCardDamage` `:2729` / exit `:550` | @relic12    |
| 6   | 神圣树皮 `sacred_bark`          | `drinkPotion` `:2271`（33 条 case 各一个三元式）/ `Player::wouldDie` `:332`      | @relic12    |
| 7   | 蜥蜴尾 `lizard_tail`            | `:177`（`setHasRelic<X>(r.data)`）/ `Player::wouldDie` `:339` / exit `:563`      | @relic13    |
| 8   | 红骷髅 `red_skull`              | `initRelics` `:436` / `Player::heal` `:169` / `hpWasLost` `:311`                 | @relic13    |
| 9   | 钨钢棒 `tungsten_rod`           | `Player::damage` `:201` / `attacked` `:239` / `loseHp` `:266`（**三份**）        | @relic13    |
| 10  | 百年拼图 `centennial_puzzle`    | `Player::hpWasLost` `:294`（一次性 `setHasRelic(false)` + addToTop 抽 3）        | @relic13    |
| 11  | 发条纪念品 `clockwork_souvenir` | `:104` + `:403`（入队 `BuffPlayer<ARTIFACT>(1)`）                                | @relic14/15 |
| 12  | 地精面罩 `gremlin_visage`       | `:105` + `:407`（**同步** `p.debuff<WEAK>(1)`）                                  | @relic14    |
| 13  | 红面具 `red_mask`               | `:106` + `:415`（`DebuffAllEnemy<WEAK>(1)`，**默认 isSourceMonster=true**）      | @relic14    |
| 14  | 蛇之戒指 `ring_of_the_snake`    | `:107` + `:419`（`DrawCards(2)`）                                                | @relic14    |
| 15  | 蛇之指环 `ring_of_the_serpent`  | **`init` `:66`**（`cardDrawPerTurn++`）+ `:325`（**空 case**）                   | @relic14    |
| 16  | 史尼克之眼 `snecko_eye`         | **`init` `:63`**（`cardDrawPerTurn += 2`）+ `:210`（`debuff<CONFUSED>(1)`）      | @relic14    |
| 17  | 赤备 `akabeko`                  | `:122`（`buff<VIGOR>(8)`）                                                       | @relic14    |
| 18  | 水银沙漏 `mercury_hourglass`    | `initRelics` `:432` + `Player.cpp:551`（两处函数体逐字相同）                     | @relic14    |
| 19  | 痛苦印记 `mark_of_pain`         | `:112`（`energyPerTurn++`）+ `:411`（两张伤口进抽牌堆）                          | @relic15    |
| 20  | 绽放印记 `mark_of_the_bloom`    | `Player::heal` `:156` / `wouldDie` `:331`                                        | @relic15    |
| 21  | 以太 `ectoplasm`                | `:136` + `Player::gainGold` `:87`                                                | @relic16    |
| 22  | 清酒壶 `sozu`                   | `:214` + `obtainPotion` `:2249`                                                  | @relic16    |
| 23  | 天鹅绒颈圈 `velvet_choker`      | `:222` + `isCardPlayAllowed` `:726`                                              | @relic16    |
| 24  | 腕刃 `wrist_blade`              | `calculateCardDamage` `:2712`（`costForTurn == 0` 时 +4）                        | @relic16    |
| 25  | 木乃伊之手 `mummified_hand`     | `onUsePowerCard` `:1905`（技能牌那一格是空的 `// todo`）                         | @relic16    |
| 26  | 扭曲钳 `warped_tongs`           | `initRelics` `:450` + `Player.cpp:669`（`UpgradeRandomCardAction`）              | @relic16    |
| 27  | 死灵之书 `necronomicon`         | `onUseAttackCard` `:1722` + `Player.cpp:555`                                     | @relic16    |
| 28  | 化学 X `chemical_x`             | `Actions.cpp:1267`（旋风斩）+ `:593`（嬗变，**无预言机**）                       | @relic16    |
| 29  | 尼奥的挽歌 `neows_lament`       | `:293`（`if (r.data > 0)` 全场怪 1 血）+ exit `:540`                             | @relic17    |

**顺带补上两处此前没有产出者、所以看不出来的共享原语**：

- ⚠⚠ **干劲（VIGOR）在 `onUseAttackCard` 里的摘除**（`BattleContext.cpp:1678-1680`）。
  在赤备之前**干劲没有任何来源**，`getPower(…, "vigor")` 恒是 0，摘不摘都一样。赤备一登记
  它就承重了：少了这一句，那 8 点会加在整场**每一张**攻击牌上。
- `initRelics` 的**第三个循环**（`atTurnStartPostDraw`，`:440-453`）与它前面那两条**裸的
  `if`**（水银沙漏 `:432` / 红骷髅 `:436`）——后两条读的是 `gc`（**容器**）而不是玩家那份位，
  **位置是写死的**（排在全部 `atBattleStart` 之后、`atTurnStartPostDraw` 之前），与玩家的
  遗物顺序无关。

#### 一、甲：`RelicInstance.data`，以及它为什么不是「加个字段」

参考的 `RelicInstance` 是 `{RelicId id; int data;}`，战斗前后各走一遍。⚠⚠ 那个 `data`
**有两种含义，别按一种抄**：

| 含义     | 遗物                                                                  | 形状                                                              |
| -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **数值** | 快乐花 / 熏香炉 / 墨水瓶 / 插入器 / 双节棍 / 笔尖 / 日晷 / 尼奥的挽歌 | `initRelics` 搬进 `Player` 的计数器，`updateRelicsOnExit` 写回    |
| **真假** | 御守 / 蜥蜴尾                                                         | `p.setHasRelic<X>(r.data)` —— **data 0 = 这颗遗物在战斗内不存在** |

⚠⚠ **六颗「数值」遗物的写法两两都不同，照抄邻居必错**：

```cpp
快乐花   player.happyFlowerCounter = r.data + 1;  然后 if (counter == 3)   // 先加 1，再判
熏香炉   p.incenseBurnerCounter = r.data;         然后 if (++counter == 6) // 先赋值，再自增判
墨水瓶   p.inkBottleCounter = r.data;                                      // 光搬，不判
双节棍   p.nunchakuCounter  = r.data;                                      // 光搬，不判
日晷     p.sundialCounter   = r.data;                                      // 光搬，不判
笔尖     if (r.data == 9) { buff<PEN_NIB>(1); penNibCounter = -1; } else penNibCounter = r.data;
```

快乐花与熏香炉的**数值终态相同**（都等于 `data + 1`），写法却不同。⚠ 快乐花那个 `+1` 是
非直觉的：卡面写「每 3 回合 1 点能量」，而开局那一下算「第 1 回合」——写成 `= r.data`
会让整场的能量全部晚一个回合（实测红 240 例）。

⚠⚠ **同一颗遗物在两个时点上的写法也不同**，也照抄：

| 遗物   | `initRelics`                       | `Player::applyStartOfTurnRelics`                 |
| ------ | ---------------------------------- | ------------------------------------------------ |
| 快乐花 | `= data + 1` 再判；能量**同步**加  | `if (++counter == 3)`；能量 **`addToBot`**       |
| 熏香炉 | `= data` 再 `++` 判；**同步** buff | `if (++counter == 6)`；**`addToBot`** BuffPlayer |

**引擎侧的形状**（不是纯加字段，这一步最容易做浅）：

- `BattleContext.relics` 从 `string[]` 变成 `CombatRelic[] = {id, data}[]`；
- ⚠⚠ 新增 **`player.relicBits`**（对齐 `Player::relicBits0/1`）——**它与遗物容器不是一回事**。
  `initRelics` 的第一句是把容器的位拷一份，此后有**四处只改这一份**：
  御守 / 蜥蜴尾的 `setHasRelic<X>(r.data)`（data 0 = 清位）、蜥蜴尾复活用掉、
  百年拼图触发过一次。`hasRelic()` 因此必须读它——用容器判会让这四处**静默失效**
  （百年拼图会变成「每次掉血都抽 3 张」）；
- `updateRelicsOnExit()` 八格逐条照抄，其中两格非直觉：
  - **笔尖把 -1 写回成 9**（参考自注 `// possible bug`）——下一场开局又直接带一层笔尖；
  - **尼奥的挽歌不读任何计数器，而是把自己的 data 减 1**（参考在 `initRelics` 那一格的行尾
    自注 `// remember to decrement somewhere else`）；
- ⚠ **写回那一半没有 trace 预言机**：一条 trace 就是一场战斗，写回去的值下一场才被读到。

⚠ **插入器（INSERTER）因此被排除**：它的 `inserterCounter` 在战斗内的唯一用途是每 2 回合
`player.increaseOrbSlots(1)`，而参考的那个函数体就是一句 `// todo`（Player.cpp:109-111）
——整条是空操作。这是排除族里的**新一族**：「参考的实现是个空函数」，
与「实现被注释掉」（什锦）同源，判据都是「没有可观察面 ⇒ 拿不到变异非 0」。

#### 二、trace 格式：`relicData` 只带「数值」那一半，理由是可验证性

harness 加了一个与 `relics` 等长的 `relicData` 数组，**只在某颗遗物带非 0 的「数值」data
时输出**。两步验证做了：**先只加字段、不加任何 variant，`--check` 报 150 个文件逐字节复现**。

⚠⚠ **「真假」那两颗故意不走这个通道**，而这不是洁癖：`writhing_mass@relic3` 从第四十批起
就带着 `{OMAMORI, data 2}`，把它也算进那个数组，那 120 行的头部就会变，
「150 个逐字节复现」当场不成立。做法是把不变量挪到 harness 里——
**加一道检查：御守 / 蜥蜴尾不许以 data 0 发出**（那等于白发一颗），
于是「出现在 `relics` 清单里 ⟺ data 非 0」按构造成立，重放侧回填 1。

#### 五、六个 variant 的分组，以及「先量再定」第七次

| 文件后缀   | 遗物                                                                                | 编队                                   | 牌组 / 药水                                        |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `@relic12` | 快乐花(1) / 熏香炉(3) / 日晷(1) / 双节棍(5) / 笔尖(9) / 神圣树皮                    | champ、three_darklings                 | 22；药水 **火焰 + 格挡 + 迅捷**                    |
| `@relic13` | 蜥蜴尾(1) / 红骷髅 / 钨钢棒 / 百年拼图 / 鸟面坛                                     | champ、hexaghost                       | 22 + 4×狂暴                                        |
| `@relic14` | 发条纪念品 / 地精面罩 / 红面具 / 蛇之戒指 / 蛇之指环 / 史尼克之眼 / 赤备 / 水银沙漏 | three_sentries、champ                  | 22                                                 |
| `@relic15` | 发条纪念品 / 姜 / 芜菁 / 冠军腰带 / 绽放印记 / 痛苦印记 / 鸟面坛                    | champ、three_sentries                  | 22 + 4×狂暴                                        |
| `@relic16` | 以太 / 清酒壶 / 天鹅绒颈圈 / 腕刃 / 木乃伊之手 / 扭曲钳 / 死灵之书 / 化学 X         | three_sentries、champ、three_darklings | 30（+2 旋风斩 +2 贪婪之手 +4 狂暴）；药水 **熵酿** |
| `@relic17` | 尼奥的挽歌(1) **单独**                                                              | automaton、collector                   | 22；药水 火焰 + 格挡 + 迅捷                        |

括号里是 `RelicInstance::data`。**除御守/蜥蜴尾之外的 data 值全部经 `relicData` 传给重放侧**。

**装完之后的实测（120 条 / 文件）：**

| 文件                      | 平均回合 | 平均步数 |
| ------------------------- | -------- | -------- |
| `champ@relic12`           | 10.67    | 55.3     |
| `three_darklings@relic12` | 8.18     | 45.2     |
| `champ@relic13`           | 9.98     | 67.7     |
| `hexaghost@relic13`       | 5.72     | 39.5     |
| `champ@relic14`           | 10.44    | 54.4     |
| `three_sentries@relic14`  | 3.70     | 22.2     |
| `champ@relic15`           | 9.78     | 61.1     |
| `three_sentries@relic15`  | 4.35     | 30.1     |
| `champ@relic16`           | 5.10     | 34.4     |
| `three_darklings@relic16` | 1.44     | 14.1     |
| `three_sentries@relic16`  | 1.16     | 12.5     |
| `automaton@relic17`       | **0.00** | **1.0**  |
| `collector@relic17`       | **0.00** | **1.0**  |

**四条真的改变了分组的读数：**

1. ⚠⚠ **尼奥的挽歌让全场怪 1 血 ⇒ 平均 0.00 回合、每条 trace 只有 1 步。**
   任何需要回合的遗物与它同组都会**饿死**。神圣树皮原本排在这一组，实测之后挪到了 `@relic12`
   ——1 血的怪身上「火焰药水 40 还是 20」杀不杀得死是一样的，那个常数当场变成不可观测。
2. **以太的门是「贪婪之手打死一只怪」**（战斗内唯一的 `Player::gainGold` 调用点）：
   实测 three_sentries **46 次 / 41 条**、champ 只有 **9 / 9**。所以 `@relic16` 必须带
   three_sentries，哪怕它只有 1.16 回合——以太是在**击杀**那一刻触发，不按回合。
3. ⚠ **三颗 `energyPerTurn++` 把仗压得比预想更短**：three_sentries 掉到 **1.16 回合**、
   three_darklings 从（22 张牌组的）10.0 掉到 **1.44**。第四十三批量到「五颗 → 2.5 回合」，
   三颗并没有好多少——**旋风斩 + 6 点能量是另一个乘数**。`@relic16` 因此挂了三个编队，
   靠 champ（5.10 回合）扛「要回合数」的那几颗（扭曲钳 / 死灵之书的每回合复位）。
4. ⚠⚠ **姜与地精面罩不能同组**：面罩的全部可观察面就是玩家身上那 **1 层虚弱**，而姜是
   虚弱免疫——放一起面罩会拿到**干净的 0 例**。所以发条纪念品在 `@relic14` 与 `@relic15`
   里**各带一份**（遗物可以跨 variant 重复，只有 `relicSet` 必须互不相同）。

⚠ **`@relic15` 是专门为关掉第四十三批那三条盲区开的**：姜 / 芜菁 / 冠军腰带**与神器的相对
顺序**。第四十三批写下的关门条件就是「一个同时带神器来源的 variant」，本批登记的发条纪念品
（`atBattleStart` 给玩家 1 层神器）正是那个来源；怪物侧的神器由 three_sentries 提供
（每只 ARTIFACT 1，实测 5976 帧 / 120 条）。

#### 四、丙：排除的 11 颗，以及**可重放性**的逐条判断

⚠ 本批**只判「战斗内有读点、且尚未登记」的那些**。判据分两层：先问「有没有预言机」，
再问「trace 可不可重放」——后者是硬约束，不可重放的登记了会让整条 trace 坏掉而不是「未验证」。

| 遗物                              | 判据                                                                                                                           | 族               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 插入器 `inserter`                 | `Player::increaseOrbSlots` 的函数体是一句 `// todo`（Player.cpp:109-111）⇒ **整条空操作**                                      | ⚠ **新族**       |
| 情绪芯片 `emotion_chip`           | 两个读点都是 `// todo`（`Player.cpp:517` / `hpWasLost` `:299`）                                                                | 同上             |
| 扭曲漏斗 `twisted_funnel`         | 排 `DebuffAllEnemy<MS::POISON>(4)`，而**中毒整套机制没有建模**（结算在 `Monster::applyEndOfRoundPowers`）                      | **机制缺口**     |
| 达摩鲁 `damaru`                   | `BuffPlayer<MANTRA>` ⇒ 姿态                                                                                                    | 需要姿态         |
| 死藤 `dead_branch`                | `getTrulyRandomCardInCombat` ⇒ 随机牌可能未登记 ⇒ **trace 不可重放**                                                           | 整池随机造牌     |
| 秘典 `enchiridion`                | 同上（`initRelics` 里造一张随机能力牌）                                                                                        | 同上             |
| 尼尔的法典 `nilrys_codex`         | 同上，且开 `CARD_SELECT` 屏                                                                                                    | 同上             |
| 赌博筹码 `gambling_chip`          | `Actions::GambleAction` 开 `CardSelectTask::GAMBLE` 多选屏——trace 格式表达不了，harness 的 `pickCardSelectAction` 也没有这一支 | 多选屏           |
| 医疗包 `medical_kit`              | 让**状态牌可打出** ⇒ `isReplayableCard` 与 `CARD_RULES` 都要跟着补（伤口 / 灼伤 / 恍惚 / 虚无一张都没登记「打出」行为）        | **下一批的机制** |
| 蓝色蜡烛 `blue_candle`            | 同上，诅咒牌                                                                                                                   | 同上             |
| 圣水 / 忍者卷轴 / 纯净水 / 工具箱 | **永不登记**：前三个造 `MIRACLE` / `SHIV`，两张牌在参考三个 switch 里都没有 case；工具箱是整池随机 + 多选屏                    | 与 `SEEK` 同理   |

⚠⚠ **反过来，这四颗看着像「随机 ⇒ 不可重放」，实际都可重放，本批登记了**：

| 遗物       | 为什么可重放                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 史尼克之眼 | 它**不造牌**：改的是「抽到的牌本回合费用」，而困惑（CONFUSED）第二十五批就登记了，随机数走 `cardRandomRng`、逐位可复现 |
| 木乃伊之手 | 不造牌，只把**一张已有手牌**压成 0 费（★ 一次 `cardRandomRng`）                                                        |
| 扭曲钳     | 不造牌，**就地升级一张已有手牌**（★ 一次 `shuffleRng`，Java 式洗牌取首位——**不是** `random(n)`）                       |
| 死灵之书   | 复制的是**刚打出的那一张**，与二连击同一条 `queuePurgeCard`                                                            |

> **判据：「消耗 RNG」不等于「不可重放」。分水岭是「结果是不是一张从池里现造的牌」**
> ——现造的可能是未登记的牌，改已有牌的费用 / 升级位则永远落在牌组内部。

#### 三、乙：全表比对的结果

| 项                   | 数量                  |
| -------------------- | --------------------- |
| 参考 `RelicId`       | 181（含 `INVALID`）   |
| `relics.ts` 原有     | 168                   |
| **参考有、我们没有** | **13**（12 条真遗物） |
| 我们有、参考没有     | **0**                 |

补的 12 条：`bloody_idol` / `golden_idol` / `mark_of_the_bloom` / `face_of_cleric` /
`ssserpent_head` / `nloths_gift` / `nloths_hungry_face` / `neows_lament` / `necronomicon` /
`enchiridion` / `nilrys_codex` / `warped_tongs`。

⚠ **稀有度不会污染奖励池**：12 条**全部**是参考 `relicTiers[]`（`Relics.h:228`，181 项逐位
对得上）里的 `RelicTier::SPECIAL`，也就是事件 / Neow 专属。我们的三个池
（`REWARD_RELIC_POOL` / `SHOP_RELIC_POOL` / `bossRelicPool`）都按**具体档位列举**，
新开一档 `special` 不会自动渗进去。
⚠⚠ **同一次比对还发现反向的污染**：`circlet` / `red_circlet` 被写成了 `common`，
于是两枚「奖励池掏空时的兜底遗物」真的混在宝箱 / 精英掉落池里。参考给它们的同样是 SPECIAL，
已改。

⚠⚠ **这次比对顺手捞出一颗此前完全看不见的遗物**：**死灵之书（NECRONOMICON）**。
它有两个战斗内读点，却**不在第四十三批那张「40 颗多钩子」的清单里**——因为那张清单是拿
`relics.ts` 的 id 去数的，而 `relics.ts` 根本没有它。
**教训：拿产品数据表去枚举预言机侧的工作量，会漏掉「两侧都缺」的那些。**

永久用例（`test/data-tables.test.ts`）：**凡 `SUPPORTED_RELIC_IDS` 里的 id 必须在
`relics.ts` 里**。⚠ 它是**枚举**而不是谓词——`isRelicSupported` 挡不住 `bloody_idol` 那种洞，
因为要问它，你得先知道要问哪个 id。

#### 六、逐颗遗物的变异例数（本批的核心交付，79 条探针）

⚠ **29 / 29 颗每颗至少有一条非 0**——没有一颗是「只有转写、没有背书」。
分母：`@relic12` / `@relic13` / `@relic14` / `@relic15` / `@relic17` 各 **240**（两个文件），
`@relic16` **360**（三个文件）；跨 variant 的探针分母是全库 **37186**。

**`@relic12`（跨战斗计数器 + 神圣树皮，2 文件 = 240）**

| 变异                                      | 失败例数 |
| ----------------------------------------- | -------- |
| 快乐花 `initRelics` 去掉那个 `+1`         | **240**  |
| 快乐花 `initRelics` 丢掉 `r.data`         | **240**  |
| 快乐花 回合开始那份整条去掉               | **240**  |
| 快乐花 回合开始那份改同步加能量（不入队） | **240**  |
| 熏香炉 `initRelics` 丢掉 `r.data`         | **240**  |
| 熏香炉 回合开始那份整条去掉               | **240**  |
| 日晷 丢掉 `r.data`                        | **219**  |
| 日晷 改成「先增后判」（阈值不变）         | **239**  |
| 日晷 `onShuffle` 整条去掉                 | **219**  |
| 双节棍 丢掉 `r.data`                      | **240**  |
| 双节棍 `onUseAttackCard` 整条去掉         | **240**  |
| 笔尖 `data == 9` 那一支改成走 else        | **240**  |
| 笔尖 命中时写 0 而不是 **-1**             | **212**  |
| 笔尖 伤害 ×2 去掉                         | **237**  |
| 笔尖 摘除整条去掉                         | **240**  |
| 笔尖 摘除改成同步（不入队）               | **100**  |
| 神圣树皮 火焰药水不翻倍（40 → 20）        | **240**  |
| 神圣树皮 格挡药水不翻倍（24 → 12）        | **240**  |
| 神圣树皮 迅捷药水不翻倍（6 → 3 张）       | **240**  |

⚠ **「丢掉 `r.data`」这一族全部非 0，正是本批接线的直接背书**：在 `data` 之前它们退化成
「从 0 起算」，那种实现在这一族的每一颗上都会红。

**`@relic13`（玩家掉血 / 濒死，2 文件 = 240）**

| 变异                                         | 失败例数 |
| -------------------------------------------- | -------- |
| 蜥蜴尾 `wouldDie` 那份整条去掉               | **80**   |
| 蜥蜴尾 复活后不摘（可反复复活）              | **5**    |
| 蜥蜴尾 `initRelics` 改成恒 true（不读 data） | **0** ⚠  |
| 红骷髅 `hpWasLost` 那份去掉                  | **228**  |
| 红骷髅 `Player::heal` 那份去掉               | **11**   |
| 红骷髅 `initRelics` 那份去掉                 | **0** ⚠  |
| 钨钢棒 `Player::attacked` 那份去掉           | **240**  |
| 钨钢棒 `Player::damage` 那份去掉             | **14**   |
| 钨钢棒 `Player::loseHp` 那份去掉             | **0** ⚠  |
| 百年拼图 整条去掉                            | **240**  |
| 百年拼图 不摘自己（每次掉血都抽 3）          | **240**  |
| 百年拼图 `addToTop` 改 `addToBot`            | **0** ⚠  |

⚠ **蜥蜴尾只有 8 条 trace 真的复活过**（champ 里玩家被打到 0 血的次数被钨钢棒 / 鸟面坛 /
狂暴的能量拖低了），所以「整条去掉」是 **80 例**而不是 240；「复活后不摘」更薄（**5 例**：
复活之后又死了一次的只有 5 条）。**薄不等于没有**，但这两条要一起看。

**`@relic14`（开局可见，2 文件 = 240）**

| 变异                                            | 失败例数            |
| ----------------------------------------------- | ------------------- |
| 发条纪念品 整条去掉                             | **480** ⚠（跨两组） |
| 发条纪念品 改同步（神器抢在地精面罩之前）       | **240**             |
| 地精面罩 整条去掉                               | **240**             |
| 地精面罩 改入队（神器就吃得到它）               | **240**             |
| 红面具 整条去掉                                 | **240**             |
| 红面具 `isSourceMonster` 抄成 `false`           | **120**             |
| 蛇之戒指 整条去掉                               | **240**             |
| 蛇之指环 +1 抽牌去掉                            | **240**             |
| 史尼克之眼 +2 抽牌去掉                          | **240**             |
| 史尼克之眼 困惑去掉                             | **240**             |
| 赤备 整条去掉                                   | **240**             |
| **干劲的摘除去掉**（赤备那 8 点每张攻击牌都吃） | **240**             |
| 水银沙漏 `initRelics` 那份去掉                  | **240**             |
| 水银沙漏 回合开始那份去掉                       | **240**             |

⚠ 发条纪念品那条是 **480** 而不是 240，因为它同时在 `@relic14` 与 `@relic15` 里
（两组各 240）——遗物可以跨 variant 重复，只有 `relicSet` 必须互不相同。

**`@relic15`（神器 × 免疫，2 文件 = 240）**

| 变异                               | 失败例数 |
| ---------------------------------- | -------- |
| **姜 挪到神器那道门之后**          | **422**  |
| **芜菁 挪到神器那道门之后**        | **431**  |
| **冠军腰带 整条去掉**              | **509**  |
| 绽放印记 `Player::heal` 那份去掉   | **219**  |
| 绽放印记 `wouldDie` 那道外层门去掉 | **0** ⚠  |
| 痛苦印记 `energyPerTurn` 那半去掉  | **240**  |
| 痛苦印记 两张伤口那半去掉          | **240**  |

⚠⚠ **前三条就是第四十三批那三条盲区的关门结果**（当时都是 0 / 探针无效）。
数字超过 240 是因为姜 / 芜菁 / 冠军腰带**同时**出现在 `@relic11`（第四十三批）里，
两批的文件一起红。

**`@relic16`（能量 / 费用 / 出牌，3 文件 = 360）**

| 变异                                                  | 失败例数 |
| ----------------------------------------------------- | -------- |
| 以太 整条去掉（金币照常入账）                         | **80**   |
| 清酒壶 `obtainPotion` 那道门去掉                      | **360**  |
| 清酒壶 `energyPerTurn` 那半去掉                       | **360**  |
| 天鹅绒颈圈 门从 `>= 6` 抄成 `>= 3`                    | **302**  |
| 天鹅绒颈圈 门从 `>= 6` 抄成 `>= 9`（单侧探针）        | **0** ⚠  |
| 天鹅绒颈圈 `energyPerTurn` 那半去掉                   | **360**  |
| 腕刃 整条去掉                                         | **241**  |
| 腕刃 判 `cost` 而不是 `costForTurn`                   | **216**  |
| 木乃伊之手 整条去掉                                   | **285**  |
| 木乃伊之手 去掉「已在出牌队列里」那道筛               | **0** ⚠  |
| 木乃伊之手 候选为空时照样掷                           | **0** ⚠  |
| 木乃伊之手 判据只看 `costForTurn`（X 费牌进候选）     | **0** ⚠  |
| ⚠⚠ **扣能量读函数末尾的 `costForTurn`（不快照副本）** | **73**   |
| 扭曲钳 `initRelics` 那份去掉                          | **360**  |
| 扭曲钳 回合开始那份去掉                               | **285**  |
| 扭曲钳 洗牌取首位 改成 `random(n)` 直接掷             | **360**  |
| 扭曲钳 候选为空时照样掷 `shuffleRng`                  | **0** ⚠  |
| 死灵之书 整条去掉                                     | **312**  |
| 死灵之书 去掉「每回合一次」                           | **137**  |
| 死灵之书 门从 `>= 2` 抄成 `>= 1`                      | **302**  |
| 死灵之书 回合开始的复位去掉                           | **192**  |
| 化学 X 整条去掉（旋风斩那份）                         | **189**  |

**`@relic17`（尼奥的挽歌，2 文件 = 240）**

| 变异                                     | 失败例数 |
| ---------------------------------------- | -------- |
| 整条去掉                                 | **240**  |
| 循环加上「活着才写」的过滤（空位不置 1） | **240**  |
| 不刷新 `alive` 投影                      | **240**  |

⚠ 第二条就是「循环没有过滤」那件事的直接背书：加上过滤之后，自动机的 0 / 2 号位与
收藏家的 0 / 1 号位就不再是 1 血，开局那一帧当场分岔。

#### 七、0 例的九条，逐条分类

⚠ 九条里 **三条是探针无效**（其中两条是本批自己设计失误）、**四条是结构性盲区**、
**两条是等价改写**。按 WORKFLOW 第 4 节「例数有两种假的」如实分类：

| #   | 探针                                        | 分类                       | 说明                                                                                                                                    |
| --- | ------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | 日晷 改成「先增后判」                       | ⚠ **探针无效（设计失误）** | 我把阈值一起从 2 改成了 3，两者**恒等**。改回「阈值不变」重跑 → **239 例**（表里那条）。**改顺序的探针不许同时改阈值。**                |
| 41  | 史尼克之眼 抽牌那两句挪到 `cards.init` 之后 | ⚠ **探针无效（设计失误）** | 我写的是一句 `void hasInContainer;`，**根本没挪**。真正要测的顺序（`cardDrawPerTurn` 被 `cards.init` 的「固有牌补抽」读）仍未被探针覆盖 |
| 21  | 蜥蜴尾 `initRelics` 改成恒 true             | **等价改写**               | 这个 variant 发的 `data` 恒是 1，两种写法同解。它的真身（`data = 0` ⇒ 战斗内没有这颗遗物）由 `sts-combat-wiring.test.ts` 的往返用例守   |
| 24  | 红骷髅 `initRelics` 那份去掉                | **结构性盲区**             | asc0 满血入场、asc≥6 也只是 90% ⇒ **全语料没有一场是「带伤入场」**。关门条件：harness 加一个「入场血量」旋钮                            |
| 27  | 钨钢棒 `Player::loseHp` 那份去掉            | **盲区（牌组）**           | `@relic13` 的 26 张牌里**一张自伤牌都没有**（放血 / 献祭 / 燃烧都在 BATCH_2/3/4）。关门条件：往那一组的牌组里加 2 张献祭                |
| 30  | 百年拼图 `addToTop` 改 `addToBot`           | **盲区（队列内容）**       | 它一场只触发一次、而那一刻队列里没有别的动作能插在中间。与第四十三批卡戎的骨灰 / 山铜那两条同族                                         |
| 50  | 绽放印记 `wouldDie` 那道外层门去掉          | **盲区（组队）**           | `@relic15` 里既没有仙女瓶也没有蜥蜴尾。⚠ **本批是故意分开的**——放一起蜥蜴尾会拿到干净的 0。关门条件：一个同时带两者的小 variant         |
| 57  | 天鹅绒颈圈 `>= 6` 抄成 `>= 9`               | **单侧探针（预期 0）**     | 策略从来没打到过第 7 张牌（那正是这道门的作用）。**反方向 302 例**已经钉住了阈值的一侧                                                  |
| 62  | 木乃伊之手 去掉「已在出牌队列里」那道筛     | **盲区（队列内容）**       | 它跑在 `onUsePowerCard` 里，那一刻出牌队列是空的（当前项已经出队）。要它非 0 得有「能力牌 + 二连击 / 混乱」同场                         |
| 63  | 木乃伊之手 候选为空时照样掷                 | **盲区**                   | 打出能力牌那一刻手里**总有**至少一张非 0 费牌。分母为 0，不是抄错                                                                       |
| 64  | 木乃伊之手 判据只看 `costForTurn`           | **等价改写**               | X 费牌的 `cost` 是 -1、`costForTurn` 也是 -1（`setCostForTurn` 不动负数），所以 `cost > 0` 在当前语料里是冗余的                         |
| 69  | 扭曲钳 候选为空时照样掷 `shuffleRng`        | **盲区**                   | 手牌里总有可升级的牌（起始牌组全未升级）。同上，分母为 0                                                                                |

#### 八、本批新增的盲区（都带关门条件）

| 盲区                                                      | 关门条件                                                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **红骷髅的 `initRelics` 那一份**（入场血 ≤ 半血 +3 力量） | ⚠⚠ **结构性不可达**：asc0 满血入场、asc≥6 也只是 90%，全语料没有一场战斗是「带伤入场」。要关得给 harness 一个「入场血量」旋钮（与 `ascension` 同套路的默认值不变字段）     |
| **神圣树皮 × 血之药水的那两个常数**                       | 同上一族：`pickAction` 把喝药水排在出牌之前 ⇒ 三瓶药一律在第 1 回合、**满血**时喝掉，40% 与 20% 一起被 `min(maxHp, …)` 夹平。要关得改 harness 的**策略**（先打一回合再喝） |
| **绽放印记的 `wouldDie` 那一半**（挡掉仙女瓶 / 蜥蜴尾）   | 一个**同时带绽放印记与蜥蜴尾（或仙女瓶）**的 variant。本批故意把它们分在 `@relic13` / `@relic15`——放一起蜥蜴尾会拿到干净的 0                                               |
| **化学 X 的嬗变那一半**                                   | 嬗变从**整个无色池**造牌 ⇒ trace 不可重放。**没有关门条件**，记成结构性盲区（与「圣水」那一族同理，只是这一颗的另一半有背书）                                              |
| **插入器 / 情绪芯片**                                     | 参考里是空函数 / `// todo` ⇒ **永远没有预言机**。不是盲区，是「不该登记」                                                                                                  |
| **钨钢棒的 `Player::loseHp` 那一份**                      | `@relic13` 的牌组里一张自伤牌都没有。**最便宜的关门条件：往那一组的牌组里加 2 张献祭**（0 费、消耗、掉 6 血）——第四十三批为卡戎的骨灰加过同样的两张                        |
| **百年拼图 / 木乃伊之手的队列位置（两条）**               | 都要「触发那一刻队列里还压着别的动作」。与第四十三批卡戎的骨灰 / 山铜那两条同族，关门条件也一样                                                                            |
| **`updateRelicsOnExit` 整条**                             | ⚠ 一条 trace 就是一场战斗 ⇒ **永远没有 trace 预言机**。已由 `sts-combat-wiring.test.ts` 的三条往返用例接手（这不是「以后再说」，是**分工**）                               |
| **御守在 `exitBattle` 里的递减**                          | 同上（run 层）。另一支（没有御守时往牌组塞一张寄生虫）还缺 `parasite` 的 `cards.ts` 条目                                                                                   |

#### 九、三条给下一个人的结论

1. ⚠⚠ **拿产品数据表去枚举「预言机侧还剩多少活」，会漏掉「两侧都缺」的那些。**
   第四十三批那张「40 颗多钩子」的清单是拿 `relics.ts` 的 id 数出来的，于是
   **死灵之书整颗没进清单**——因为 `relics.ts` 根本没有它。全表比对之后它才浮出来。
   **判据：枚举工作量时用参考的枚举（`RelicId` / `CardId` / `MonsterId`）当分母，
   不要用我们自己的数据表。**
2. ⚠⚠ **「一个字段两种语义」时，先决定它们该不该走同一条通道，再动 trace 格式。**
   `RelicInstance::data` 的「数值」半与「真假」半如果一起塞进新字段，
   `writhing_mass@relic3`（第四十批就带着 `{OMAMORI, 2}`）的头部当场就变，
   「150 个文件逐字节复现」这条两步验证直接不成立。把「真假」那半换成一条 **harness 侧的
   不变量检查**（不许以 data 0 发出），新字段就对既有语料是真正的空操作。
3. ⚠ **「照抄邻居」这条老教训这一批出现在一个新位置：被省略掉的默认实参。**
   红面具与大理石袋在同一个 switch 里上下相邻，都是 `DebuffAllEnemy<...>(1)`，
   差别只有大理石袋多写了一个 `false`——而那个形参的默认值是 `true`。
   **抄 `Actions::X(...)` 之前先去 `Actions.h` 看一眼它有没有默认实参。**

### 第四十三批：遗物战线第四批——「单读点」那一族一次吃完（38 颗）

**这一批的规模是前三批的七倍多**（5 / 5 / 5 → 38），而做得到的唯一原因是**先筛**：
按「战斗内有几个读点」把 168 颗遗物分成两族，本批只吃「只有一个读点」的那一族。

#### 一、筛选结果：候选 59 → 登记 38 → 排除 21

```bash
grep -rn "\b<RELIC_NAME>\b" src/combat include/combat | wc -l     # 逐颗数读点
```

⚠ **两处必须照办，否则会得到危险的假象**：① 用**裸名字**（`Monster.cpp` 写 `RelicId::X`、
`BattleContext.cpp` 写 `R::X`，只搜一个别名 = 零命中）；② **必须带 `include/combat`**
——姜 / 芜菁 / 冠军腰带三颗的唯一读点在 `Player.h` / `BattleContext.h` 的模板函数里，
只搜 `src/` 会整族漏掉。

|                                              | 数量                     |
| -------------------------------------------- | ------------------------ |
| `RelicId` 全量                               | 181                      |
| 战斗目录下有引用                             | **119**                  |
| 其中**只有一个读点**                         | **70**                   |
| ├ 此前已登记（第 40~42 批 + 更早的轮换八颗） | 11                       |
| ├ **本批登记**                               | **38**                   |
| └ 有理由排除                                 | **21**                   |
| 多钩子（2~9 个读点），**不在本批范围**       | 49（其中 40 颗尚未登记） |

**排除的 21 颗，七个族**（以后遇到同族的直接照这个判）：

| 族                              | 遗物                                                 | 判据                                                                            |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| 需要充能球                      | 破裂核心 / 核电池 / 共生病毒 / 如尼电容 / 冰核       | 没有充能球模型，harness 快照里也没有                                            |
| 需要姿态                        | 泪滴挂坠                                             | 同上，且 `changeStance` 会连锁排动作                                            |
| 读 `r.data` 而 data 恒 0        | 杜乌娃娃 / 基里亚                                    | `buff<STRENGTH>(r.data)` 整条是**空操作**，拿不到变异非 0                       |
| 读 `gc.curRoom` / `gc.lastRoom` | 缩放仪 / 昆虫标本 / 奴隶主颈圈 / 勇气投索 / 古董茶具 | harness 从没设过这两个字段（恒 `Room::INVALID`）⇒ **结构性盲区**                |
| 从整个牌池随机造牌              | 手册 / 枯枝 / 尼尔的法典                             | 随机牌可能是**未登记**的牌 ⇒ trace 不可重放                                     |
| 参考的实现被注释掉了            | 什锦                                                 | `// addToBot(SetState(SCRY, 3))`，没有预言机，与 `SEEK` 那族卡同理              |
| run 层 / 会卡死                 | 黑血 / 燃血 / 骨头上的肉 / 活体样本                  | 前三个在战斗后的回血 switch（trace 不覆盖）；活体样本排的 InputState 没有消费者 |

⚠⚠ **第四族是唯一带明确关门条件的，而且很便宜**：给 `DeckVariant` 加一个 `Room room`
（沿用 `ascension` 那个「默认值保持逐字节不变」的老套路）+ trace 头部加一个 `room` 字段，
**一次开五颗**。本项目至今没有把 `room` 送进战斗，所以这是一条真正的**接线缺口**，不是盲区。

#### 二、五个 variant 的分组，以及为什么必须分成五个

⚠ **8 颗是硬上限**（`initRelics` 的 `atBattleStart` 是 `fixed_list<RelicId, 8>`，harness 有
一道粗检查兜底），所以 38 颗**至少**要 5 个 variant。但真正难的不是这条，是**覆盖密度**：

| 文件后缀   | 遗物                                                                                    | 编队                                        | 牌组                                  |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| `@relic7`  | 破损王冠 / 咖啡滤压壶 / 诅咒钥匙 / 融合锤 / 如尼圆顶 / 诱变强化剂 / 石化螺旋 / 数据磁盘 | the_guardian、champ                         | 22                                    |
| `@relic8`  | 战争艺术 / 船长之轮 / 号角 / 斗篷夹扣 / 卡钳 / 算盘 / 冰淇淋 / 怀表                     | three_sentries、time_eater、three_darklings | 22                                    |
| `@relic9`  | 打击假人 / 纸蛙 / 纸鹤 / 奇特蘑菇 / 靴子 / 鸟居 / 冠军腰带 / 不休陀螺                   | champ、three_byrds、collector               | 22                                    |
| `@relic10` | 鸟面坛 / 魔力之花 / 二元性 / 卡戎的骨灰 / 奇异汤匙 / 如尼金字塔 / 血腥雕像 / 山铜       | slime_boss、three_sentries、champ           | **30**（+4 暴怒 +2 献祭 +2 贪婪之手） |
| `@relic11` | 如尼方块 / 自成型黏土 / 芜菁 / 姜 / 线与针 / 石历                                       | champ、maw、slime_boss                      | 22                                    |

五个 variant 的**遗物与药水都钉死**（药水恒 `BLOCK_POTION`），所以它们一次 `traceIdx` 都不读
——测量数字可以逐例照搬到安装后的数据，重排乘积也动不了这 14 个文件（第四十二批那条结论的
第二次应用）。

**三条分组原则，每一条都有一个具体的反例撑着**：

1. **效果不互相遮蔽**。如尼金字塔（回合末不弃手牌）与不休陀螺（手牌空了补一张）放同一个
   variant，后者**结构性不可达**——所以它们分别在 `@relic10` 与 `@relic9`。同理山铜的门是
   「回合末格挡为 0」，与四颗加格挡的遗物（`@relic8`）分开。
2. **仗长要保住**。五颗 `energyPerTurn++` 让平均回合数从 ~6 掉到 **2.5**（比第四十一批硫磺
   那次 9.54 → 7.17 猛得多）。⚠ 做法不是「摊开」而是**单独关进 `@relic7`**：那一组的效果
   全部在开局第一帧就可见，短仗反而无所谓；摊开的话会把另外四组的分母一起压垮。
3. **编队要能看见那一组的效果**——这条必须量，见下一节。

#### 三、「先量再定」第六次，而这次量的是**四十个门**

前五次都是「拿 2~3 个候选跑一遍、比一张表」。四十个门没法这么干，本批的做法是：

**给参考源码打一层临时的计数器补丁**（`extern long long g_m[64]` + 每个门一行 `++g_m[N]`），
harness 里加一段 per-(variant × encounter) 的 stderr 汇总，跑完 `git checkout -- .` 还原。
⚠⚠ **关键是计数器加在「门的条件」上而不是「遗物的分支」里**——这样**一次不带遗物的 run
就能量出全部四十个门的分母**，用来挑编队；之后再拿真正的分组跑第二次，确认叠起来之后
每个门仍然非 0。

**第一次 run**（22 个候选编队 × 120 条，22 张牌组，只带一颗光滑石，药水钉死）：

| 编队                       | 平均回合 | oddMushroom | ginger | turnip | iceCream | unceasingTop | stoneCalendar | charonsAshes | spoon | theBoot | torii | paperKrane | paperPhrog |
| -------------------------- | -------- | ----------- | ------ | ------ | -------- | ------------ | ------------- | ------------ | ----- | ------- | ----- | ---------- | ---------- |
| jaw_worm_horde             | 5.2      | 0           | 0      | 0      | 3        | 3            | 25            | 0            | 0     | 511     | 102   | 51         | 191        |
| lots_of_slimes             | 3.2      | 0           | 211    | 0      | 1        | 0            | 0             | 0            | 0     | 269     | 282   | 7          | 68         |
| three_sentries             | 6.0      | 0           | 0      | 0      | 54       | 0            | 38            | 360          | 0     | 155     | 188   | 11         | 50         |
| lagavulin                  | 5.8      | 0           | 0      | 0      | 1        | 6            | 34            | 0            | 0     | 172     | 35    | 74         | 246        |
| the_guardian               | 8.4      | 14          | 14     | 0      | 6        | 19           | 117           | 0            | 0     | 146     | 532   | 132        | 398        |
| hexaghost                  | 9.3      | 0           | 0      | 0      | 20       | 11           | 120           | 0            | 0     | 121     | 1019  | 170        | 427        |
| slime_boss                 | 10.2     | 0           | 229    | 333    | 5        | 21           | 118           | 506          | 506   | 275     | 136   | 32         | 281        |
| three_byrds                | 7.0      | 0           | 0      | 0      | 5        | 11           | 81            | 0            | 0     | 1628    | 2051  | 46         | 255        |
| shelled_parasite_and_fungi | 6.1      | 18          | 0      | 95     | 2        | 10           | 55            | 0            | 0     | 355     | 246   | 124        | 270        |
| gremlin_leader             | 7.0      | 0           | 175    | 0      | 2        | 15           | 86            | 0            | 0     | 433     | 186   | 31         | 189        |
| book_of_stabbing           | 5.5      | 0           | 0      | 0      | 23       | 3            | 43            | 0            | 0     | 69      | 261   | 128        | 234        |
| champ                      | 9.8      | 503         | 254    | 292    | 9        | 46           | 120           | 0            | 0     | 426     | 28    | 137        | 482        |
| collector                  | 5.0      | 316         | 120    | 120    | 1        | 4            | 29            | 0            | 0     | 197     | 217   | 61         | 166        |
| three_darklings            | 10.0     | 0           | 0      | 0      | 8        | 34           | 117           | 0            | 0     | 268     | 438   | 90         | 379        |
| spire_growth               | 4.8      | 0           | 0      | 0      | 1        | 4            | 18            | 0            | 0     | 71      | 9     | 91         | 216        |
| maw                        | 7.1      | 0           | 120    | 120    | 2        | 14           | 118           | 0            | 0     | 341     | 194   | 99         | 353        |
| writhing_mass              | 6.5      | 366         | 237    | 0      | 3        | 11           | 86            | 0            | 0     | 539     | 230   | 143        | 304        |
| giant_head                 | 6.1      | 0           | 238    | 0      | 3        | 9            | 118           | 0            | 0     | 175     | 38    | 115        | 287        |
| nemesis                    | 6.0      | 0           | 0      | 0      | 14       | 4            | 76            | 0            | 0     | 897     | 190   | 100        | 283        |
| awakened_one               | 3.5      | 0           | 0      | 0      | 1        | 0            | 1             | 0            | 0     | 132     | 104   | 51         | 136        |
| time_eater                 | 5.1      | 160         | 160    | 0      | 69       | 22           | 40            | 0            | 0     | 66      | 163   | 87         | 217        |
| donu_and_deca              | 4.0      | 0           | 0      | 0      | 1        | 0            | 0             | 98           | 0     | 136     | 86    | 5          | 5          |

三条**真的改变了决策**的读数：

1. ⚠⚠ **奇特蘑菇要「玩家自己易伤」，而四个看起来最像的编队里有两个是干净的 0**：
   champ 503 / collector 316 / writhing_mass 366 / time_eater 160，而
   **hexaghost 0、three_byrds 0、lagavulin 0、jaw_worm_horde 0**。
   「怪很凶」不等于「怪会给玩家上易伤」。
2. **冰淇淋要「回合末还有剩能量」**，而 22 张牌组下这几乎不发生：time_eater **69 次 / 66 条**
   是最肥的一格，其余 21 个编队全在 1~54（大多是个位数）。
3. ⚠⚠ **卡戎的骨灰 / 奇异汤匙的门在 22 张牌组下几乎处处是 0**：那副牌里**一张会消耗的牌
   都没有**，所以「有牌进消耗堆」只发生在怪物往牌堆里塞状态牌的三个编队
   （slime_boss 506 / three_sentries 360 / donu_and_deca 98），其余 19 个编队全 0。
   ⚠ 而且这两颗的门**还不一样**：奇异汤匙判的是 `item.exhaustOnUse`（**打出去**的牌会消耗），
   骨灰判的是「任何一张牌进消耗堆」——所以 three_sentries 的 360 全是**回合末以太牌**
   （眩晕），汤匙在那里是 **0**。

> **判据：一颗遗物的门是 0，先问「这是编队的问题还是牌组的问题」。** 前者换编队；后者往牌组里
> 加一张**专门为这道门服务**的 0 费牌，并在 harness 注释里写清「这张牌是为谁加的」。

`@relic10` 的牌组因此是量出来的，三张添加各有明确职责：

| 添加        | 为谁                               | 效果                                                                                                                                                                |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4× 暴怒     | 鸟面坛 / 魔力之花                  | 全项目**唯一 0 费的能力牌**。22 张牌里只有 1 张能力牌（燃烧），鸟面坛只触发 ~~80 次；加上之后 448~~600 次，魔力之花跟着从 0 → 345~441                               |
| 2× 献祭     | 卡戎的骨灰 / 奇异汤匙 / 所有回血类 | 0 费、**消耗**、掉 6 血。一次解决三件事：给两颗遗物喂门（汤匙从 0 → 184~325）、把玩家打到满血以下（不然回血根本看不见）                                             |
| 2× 贪婪之手 | 血腥雕像                           | 战斗内**唯一**的 `Player::gainGold` 调用点，而且要**打死**一只怪（`Actions.cpp:1123-1131`）。实测 three_sentries 85 / slime_boss 82 / champ 9 / **donu_and_deca 0** |

**第二次 run**（五个分组各自的编队 × 120 条，遗物与药水与安装后完全相同）：

`@relic7`：

| 编队                          | 平均回合 |
| ----------------------------- | -------- |
| three_sentries _(量了但没装)_ | 2.5      |
| the_guardian                  | 4.8      |
| hexaghost _(量了但没装)_      | 4.5      |
| champ                         | 8.1      |

`@relic8`：

| 编队                     | 平均回合 | artOfWar | captainsWheel | hornCleat | cloakClasp | calipers | abacus | iceCream | pocketwatch |
| ------------------------ | -------- | -------- | ------------- | --------- | ---------- | -------- | ------ | -------- | ----------- |
| three_sentries           | 5.3      | 23       | 120           | 120       | 637        | 615      | 147    | 20       | 462         |
| hexaghost _(量了但没装)_ | 9.1      | 20       | 120           | 120       | 1087       | 797      | 315    | 16       | 664         |
| three_darklings          | 10.3     | 21       | 120           | 120       | 1197       | 791      | 357    | 22       | 661         |
| time_eater               | 7.8      | 34       | 120           | 120       | 1037       | 497      | 263    | 99       | 636         |

`@relic9`：

| 编队                     | 平均回合 | strikeDummy | paperPhrog | paperKrane | oddMushroom | theBoot | torii | champBelt | unceasingTop |
| ------------------------ | -------- | ----------- | ---------- | ---------- | ----------- | ------- | ----- | --------- | ------------ |
| hexaghost _(量了但没装)_ | 9.0      | 1090        | 405        | 350        | 0           | 118     | 1070  | 260       | 10           |
| three_byrds              | 5.6      | 723         | 177        | 187        | 0           | 984     | 1441  | 279       | 4            |
| champ                    | 11.4     | 1417        | 614        | 334        | 577         | 428     | 84    | 362       | 81           |
| collector                | 6.5      | 848         | 202        | 266        | 378         | 196     | 307   | 335       | 12           |

`@relic10`：

| 编队                         | 平均回合 | birdUrn | magicFlower | duality | charonsAshes | spoon | runicPyramid | bloodyIdol | orichalcum |
| ---------------------------- | -------- | ------- | ----------- | ------- | ------------ | ----- | ------------ | ---------- | ---------- |
| three_sentries               | 3.1      | 448     | 345         | 1417    | 111          | 184   | 343          | 85         | 71         |
| slime_boss                   | 4.7      | 578     | 418         | 2214    | 188          | 325   | 525          | 82         | 111        |
| champ                        | 7.5      | 600     | 441         | 3905    | 188          | 319   | 787          | 9          | 164        |
| donu_and_deca _(量了但没装)_ | 3.0      | 510     | 362         | 1571    | 117          | 195   | 442          | 0          | 103        |

`@relic11`：

| 编队                     | 平均回合 | runicCube/clay | turnip | ginger | threadNeedle | stoneCalendar |
| ------------------------ | -------- | -------------- | ------ | ------ | ------------ | ------------- |
| slime_boss               | 7.2      | 294            | 101    | 78     | 287          | 119           |
| champ                    | 10.3     | 704            | 294    | 224    | 480          | 120           |
| collector _(量了但没装)_ | 6.4      | 802            | 120    | 120    | 480          | 85            |
| maw                      | 7.7      | 864            | 120    | 120    | 480          | 120           |

⚠ `@relic7` 那一格只有「平均回合数」一列，因为它的八颗遗物**全部在 `initRelics` 里无条件触发**
——没有门可量。它真正要量的是**副作用**：五颗 `energyPerTurn++` 叠起来让 three_sentries 的
平均回合数掉到 **2.5**（其余四组是 3.1~11.4），这正是把它们隔离出来的理由。

#### 四、逐颗遗物的变异例数（本批的核心交付，61 条探针）

⚠ **每一颗登记的遗物都至少有一条非 0 的变异**——38 / 38，没有一颗是「只有转写、没有背书」。
下面按 variant 分组，例数后的分母是那一组文件的总例数。

**`@relic7`（开局一次性属性，2 个文件 = 240 例）**

| 变异                                       | 失败例数 |
| ------------------------------------------ | -------- |
| 破损王冠 去掉 energyPerTurn++              | **240**  |
| 咖啡滤压壶 去掉 energyPerTurn++            | **240**  |
| 诅咒钥匙 去掉 energyPerTurn++              | **240**  |
| 融合锤 去掉 energyPerTurn++                | **240**  |
| 如尼圆顶 去掉 energyPerTurn++              | **240**  |
| 诱变强化剂 整条去掉                        | **240**  |
| 诱变强化剂 只去掉还债那半（LOSE_STRENGTH） | **240**  |
| 诱变强化剂 还债改走 buff（不过神器）       | **0** ⚠  |
| 石化螺旋 去掉 BUFFER                       | **240**  |
| 数据磁盘 去掉 FOCUS                        | **240**  |

**`@relic8`（回合边界的格挡与能量，3 个文件 = 360 例）**

| 变异                                         | 失败例数 |
| -------------------------------------------- | -------- |
| 战争艺术 整条去掉                            | **73**   |
| 战争艺术 去掉「上回合没打攻击牌」那道门      | **360**  |
| 船长之轮 整条去掉                            | **360**  |
| 船长之轮 turn===2 抄成 >=2                   | **360**  |
| 号角 整条去掉                                | **360**  |
| 斗篷夹扣 整条去掉                            | **360**  |
| 斗篷夹扣 手牌数改成执行时取                  | **0** ⚠  |
| 卡钳 整条去掉（回合开始照常清零）            | **355**  |
| 算盘 整条去掉                                | **360**  |
| 冰淇淋 累加改成覆盖                          | **112**  |
| 怀表 整条去掉                                | **360**  |
| 计数器清零挪回抽牌之前（怀表读到本回合的 0） | **350**  |

**`@relic9`（伤害修正，3 个文件 = 360 例）**

| 变异                        | 失败例数 |
| --------------------------- | -------- |
| 打击假人 去掉 +3            | **343**  |
| 纸蛙 1.75 抄成 1.5          | **250**  |
| 纸鹤 0.6 抄成 0.75          | **221**  |
| 奇特蘑菇 1.25 抄成 1.5      | **225**  |
| 靴子 整条去掉               | **313**  |
| 靴子 上界 <5 抄成 <=5       | **0** ⚠  |
| 鸟居 整条去掉               | **269**  |
| 鸟居 上界 <=5 抄成 <5       | **69**   |
| 冠军腰带 整条去掉           | **339**  |
| 冠军腰带 挪到神器那道门之前 | **339**  |
| 不休陀螺 整条去掉           | **64**   |

**`@relic10`（牌 / 消耗 / 回血钩子，3 个文件 = 360 例）**

| 变异                                         | 失败例数 |
| -------------------------------------------- | -------- |
| 鸟面坛 整条去掉                              | **343**  |
| 魔力之花 去掉 ×3/2                           | **351**  |
| 魔力之花 整数除改成四舍五入                  | **88**   |
| 二元性 整条去掉                              | **360**  |
| 二元性 只去掉还债那半（LOSE_DEXTERITY）      | **360**  |
| 卡戎的骨灰 整条去掉                          | **307**  |
| 卡戎的骨灰 addToTop 抄成 addToBot            | **0** ⚠  |
| 奇异汤匙 整条去掉（照常消耗、不掷随机数）    | **352**  |
| 奇异汤匙 无条件掷（不判 exhaustOnUse）       | **360**  |
| 如尼金字塔 整条去掉（照常弃手牌）            | **352**  |
| 血腥雕像 整条去掉                            | **136**  |
| 山铜 整条去掉                                | **154**  |
| 山铜 addToTop 抄成 addToBot                  | **0** ⚠  |
| 斗篷夹扣改同步（山铜的门读到夹扣加完的格挡） | **0** ⚠  |

**`@relic11`（掉血钩子 / 减益免疫 / 长仗，3 个文件 = 360 例）**

| 变异                                              | 失败例数 |
| ------------------------------------------------- | -------- |
| 如尼方块 整条去掉                                 | **360**  |
| 如尼方块 addToTop 抄成 addToBot                   | **104**  |
| 自成型黏土 整条去掉                               | **360**  |
| 下回合格挡 改成递减而不是整条摘掉                 | **360**  |
| 芜菁 整条去掉                                     | **313**  |
| 姜 整条去掉                                       | **302**  |
| 姜 挪到神器那道门之后（挡掉的那次也白吃一层神器） | **0** ⚠  |
| 线与针 去掉开局 4 层镀甲                          | **360**  |
| 玩家侧镀甲 去掉回合末加格挡                       | **360**  |
| 玩家侧镀甲 去掉挨打递减                           | **360**  |
| 石历 整条去掉                                     | **359**  |
| 石历 turn===6 抄成 >=6                            | **272**  |

**跨组的共享形状**

| 变异                                    | 失败例数 |
| --------------------------------------- | -------- |
| 缓冲（Player::attacked 那一份）整条去掉 | **129**  |
| 缓冲（Player::damage 那一份）整条去掉   | **111**  |

#### 五、0 例的六条，逐条分类

⚠ **六条里有三条是「探针无效」，其中两条是本批自己设计失误** ——按 WORKFLOW 第 4 节
「例数有两种假的」如实分类：

| #       | 探针                                           | 分类                                | 说明                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7       | 诱变强化剂的还债改走 `buff`（不过神器）        | **结构性盲区**                      | 要玩家身上有**神器**，而全语料里玩家的神器只来自古代药水（本批五个 variant 把药水钉死成格挡药水）与发条纪念品（未登记）。实测 `grep '"ARTIFACT"'` 在这三个文件里**一次都没有**                                                  |
| 16      | 斗篷夹扣的手牌数改成执行时取                   | **等价改写**                        | 入队与出队之间没有任何东西改手牌数（弃手牌在 `onTurnEnding`，更晚）                                                                                                                                                             |
| 27      | 靴子的上界 `< 5` 抄成 `<= 5`                   | **探针无效（等价改写）**            | 两者只在 `damage == 5` 时分岔，而那一支执行的是 `damage = 5`——**赋值本身是空操作**。⚠ 对照组：鸟居的同款上界改动红 **69 例**，因为它把伤害置成 **1** 而不是 5。**同一个形状的两颗遗物，一颗可测一颗不可测，原因在赋的那个值上** |
| 31      | 冠军腰带挪到神器那道门之前                     | ⚠⚠ **探针无效（假的非 0，339 例）** | 探针写错了：新串把腰带那一段**插到**神器之前却没有删掉原来那一段，于是它每次易伤触发**两次**——339 例量的是「触发两次」，不是「顺序」。真正的顺序问题仍然是**结构性盲区**（同 #7：三个编队里没有任何一只带神器的怪）             |
| 39 / 45 | 卡戎的骨灰 / 山铜的 `addToTop` 抄成 `addToBot` | **盲区**                            | 两者入队的那一刻队列里没有别的动作能插在中间。⚠ 但**同族的第三条不是 0**：如尼方块的 `addToTop` 改 `addToBot` 红 **104 例**——因为它挂在**多段攻击的每一段**上，抽到的牌下一段就能读到                                           |
| 46      | 斗篷夹扣改同步（让山铜的门读到夹扣加完的格挡） | ⚠ **探针无效（结构性）**            | **两颗遗物根本不在同一个 variant 里**——把它们分开正是本批的分组原则之一（山铜的门是「回合末格挡为 0」）。这条探针是本批自己设计失误：它测的那个交互按构造不存在                                                                 |

**三条新盲区进总清单**（都带关门条件）：

| 盲区                                                 | 关门条件                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~姜 / 芜菁 / 冠军腰带**与神器的相对顺序**（三条）~~ | ✅ **第四十四批关掉**（`@relic15` = 发条纪念品 + 姜 + 芜菁 + 冠军腰带，编队 champ / three_sentries）。关门条件与当初写下的一字不差：登记**发条纪念品**（`atBattleStart` 给玩家 1 层神器）+ 怪物侧的 three_sentries（每只 ARTIFACT 1）。例数见「第四十四批 · 变异」 |
| 卡戎的骨灰 / 山铜的 `addToTop`                       | 需要「入队那一刻队列里还有别的动作」——骨灰要**一张牌同时排消耗与别的动作**（军备 / 焚誓那种），山铜要回合末那一组里还有第二条入队动作                                                                                                                              |
| 山铜的门读的是「夹扣之前」的格挡                     | 一个**同时带斗篷夹扣与山铜**的 variant。⚠ 本批故意把它们分开（不分开山铜的分母会被压垮），所以这条要么单开一个小 variant、要么接受它一直开着                                                                                                                       |

⚠⚠ **本批没有给参考项目打任何补丁**。逐颗对过之后，38 颗的参考实现与真实游戏的卡面语义
都对得上（回合数的 off-by-one 也对：号角 `turn == 1` = 玩家第 2 个回合、船长之轮 `turn == 2`
= 第 3 个回合、石历 `turn == 6` = 第 7 个回合末，与卡面一致）。三处**看起来像笔误、实际不是**
的记在这里，免得下一个人再查一遍：

- **如尼圆顶**只实现了 `energyPerTurn++`，卡面的「看不到敌人意图」参考里一行都没有
  ——那是渲染层的事，`R::RUNIC_DOME` 全项目只有那一处。
- **数据磁盘**给的聚焦在战斗内**一次都不被读**（唯一读者偏移没有产出者）。它不是死代码，
  是「只进快照」的标记，与孢子云那 2 层同族。
- **鸟居**只挂在 `Player::attacked` 上（非攻击伤害不吃它），而**钨钢棒**三条伤害路径各一份。
  真实游戏的措辞正是「未被格挡的**攻击**伤害」，不是笔误。

#### 六、剩下的 110 颗怎么排：多钩子那 40 颗的分组建议

> ✅ **第四十四批按这张表做掉了 A~F 六族里的 29 颗**（外加一颗这张表**漏掉**的死灵之书——
> 这张清单是拿 `relics.ts` 的 id 数出来的，而那颗遗物当时根本不在数据表里）。
> 剩下的 11 颗与逐条排除理由见「第四十四批 · 四、丙」。

装完本批是 **58 / 168**。剩下 110 颗里，**战斗内有读点的只有 40 颗**（其余 70 颗只在
地图 / 商店 / 事件 / 奖励层，不归这条线），而这 40 颗全是**多钩子**的。按「共同前置」分族，
建议的批次顺序如下（先做前置，再吃它解锁的那一族）：

| 建议批次          | 族                     | 遗物（读点数）                                                                                                                                                   | 共同前置 / 关键坑                                                                                                                                                                                                              |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A（先做接线）** | 跨战斗计数器           | 快乐花(3) / 熏香炉(3) / 日晷(3) / 双截棍(4) / 笔尖(9) / 插入器(4) / 蜥蜴尾(6)                                                                                    | ⚠⚠ **共同前置是「`bc.relics` 带 `data` + `settleCombat` 写回」**（`updateRelicsOnExit`）。在那之前它们全部退化成「从 0 起算」，`initRelics` 那半可以先写，但**卡面语义没有背书**。笔尖 9 个读点、蜥蜴尾 6 个，是全表最贵的两颗 |
| **B**             | `atBattleStart` 第二遍 | 发条纪念品(2) / 地精面罩(2) / 红面具(2) / 蛇之戒(2) / 扭曲漏斗(2) / 痛苦印记(2) / 尼奥的挽歌(2)                                                                  | ⚠ 全在 `fixed_list<RelicId, 8>` 里，**要与已登记的两个 bag_of\_\* 一起算容量**。发条纪念品给玩家**神器**——它顺带是「姜 / 芜菁 / 冠军腰带与神器的相对顺序」那三条盲区的**关门条件**                                             |
| **C**             | 能量 / 费用            | 以太(2) / 清酒(2) / 天鹅绒颈圈(2) / 化学 X(2) / 医疗包(2) / 蓝色蜡烛(2)                                                                                          | 六颗的第一处都是 `initRelics` 的 `energyPerTurn++` 或一个 `canUse` 谓词，第二处才是各自的代价。⚠ 医疗包 / 蓝色蜡烛会让**状态牌与诅咒牌可打出** ⇒ `isReplayableCard` 与 `CARD_RULES` 要跟着补                                   |
| **D**             | 伤害 / 减伤            | 钨钢棒(3) / 腕刃(2) / 赤备(2) / 红骷髅(3) / 绽放印记(2) / 神圣树皮(2)                                                                                            | 钨钢棒三处逐字相同（三条伤害路径各一份），腕刃与打击假人并排（本批已装后者，位置现成）。红骷髅 / 绽放印记挂在 `Player::heal` / `wouldDie` 上，本批已经把那两个函数的形状摆对了                                                 |
| **E**             | 回合钩子               | 水银沙漏(2) / 达摩鲁(2) / 死藤(2) / 百年拼图(2) / 赌博筹码(2) / 扭曲钳(3)                                                                                        | 前四颗直接插进本批开的两张表（`RELIC_AT_TURN_START` / `applyStartOfTurnPostDrawRelics`）。⚠ 赌博筹码与扭曲钳走 `CARD_SELECT` / `shuffleRng` + 就地升级手牌，各自是一个小机制                                                   |
| **F**             | 抽牌 / 牌堆            | 蛇之指环(2) / 史尼克之眼(2) / 木乃伊手(2)                                                                                                                        | 三颗都改 `cards.init` 或抽牌数，**会平移开局手牌** ⇒ 它们的 variant 要单独一组，别与别的族混                                                                                                                                   |
| **永不登记**      | —                      | 情绪芯片（参考是空的 `// todo`）、圣水 / 忍者卷轴 / 纯净水（造 `MIRACLE` / `SHIV`，两张牌参考**三个 switch 里都没有 case**）、工具箱（`CARD_SELECT` + 整池随机） | 与 `SEEK` 那族卡同理：**没有预言机**。⚠ 圣水那三颗尤其要写清楚——它们不是「以后再说」，是永远不能登记                                                                                                                           |

⚠ **建议先做 A 的前置那一条接线**（`RelicInstance.data`），它一条解锁 7 颗，而且顺带把本批
留下的两条 `TODO(接线)`（墨水瓶 / 御守）一起兑现。

### 第四十二批：遗物战线第三批——兑现两条已记的盲区（墨水瓶 / 橙色药丸 / 手钻的第二条路）

**这一批不铺新内容，只兑现盲区**：把第四十批与第四十一批记在盲区表里的两条各开一个
variant 去关。结论先写在最前面：

| 盲区                                                     | 原批次 | 原例数        | 本批结果                                                                                    |
| -------------------------------------------------------- | ------ | ------------- | ------------------------------------------------------------------------------------------- |
| **手钻在 `Monster::damage` 那条路上的那一份**            | 四十   | 0（分母为 0） | ✅ **关掉了，64 例**（`@relic5` 三份文件 25 / 23 / 16）                                     |
| **三颗攻击计数遗物的相对顺序**（苦无 / 装饰扇 / 手里剑） | 四十一 | 0（等价改写） | ❌ **没关掉，仍是 0 例**。第四十一批那条「登记墨水瓶 / 橙色药丸就自动关掉」的预测**是错的** |
| ⁂ **墨水瓶 vs 橙色药丸的相对顺序**（此前没人记过）       | —      | 从未量过      | ✅ **51 例**（能力牌 31 + 攻击牌 20；技能牌那条 0）                                         |

#### 数据规格与体积

| 项        | 值                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| harness   | `relicVariants` 追加**两个** variant（relicSet **5** / **6**），前四个（relicSet 1~4）一个字没动                          |
| 牌组      | `@relic5` = `BATCH_1 + SPOT_WEAKNESS`（22，历批标准）；`@relic6` = **42 张**（见下，量出来的）                            |
| 种子 / 层 | 40 / `{1,3,7}`                                                                                                            |
| 爬升度    | **0**；目标策略 **0**                                                                                                     |
| 编队      | `@relic5` = `spheric_guardian` / `sentry_and_sphere` / `gremlin_leader`；`@relic6` = `slime_boss` / `champ` / `lagavulin` |
| 文件      | **6 份**，每份 120 行、整份冻结（2.0 / 3.1 / 4.9 / 6.8 / 8.7 / 3.9 MB）                                                   |
| 例数      | 720，对拍 33226 → **33946**                                                                                               |
| 体积      | **30MB**，仓库 684MB → **714MB**，文件数 130 → **136**                                                                    |
| 扰动      | `git status -- test/golden/traces` 恰好 **6 个 `??`、零个 `M`**；六份文件 `variant0-rows.mjs` 均 = 整份 120 行            |
| 参考补丁  | **无**（`ALLOW_CHANGED` 一次都没用）                                                                                      |

两个 variant 的配置：

| 文件后缀  | 遗物                                               | 药水                    | 牌组  |
| --------- | -------------------------------------------------- | ----------------------- | ----- |
| `@relic5` | 手钻 + **青铜鳞片**                                | **钉死**（格挡药水 ×3） | 22 张 |
| `@relic6` | **墨水瓶** + **橙色药丸** + 苦无 + 装饰扇 + 手里剑 | 走旧轮换                | 42 张 |

#### ①⚠⚠ 手钻那条路的门是**两道门**，而且第二道比想的窄得多

第四十批的记法是「`@relic1` 里没有任何非攻击伤害来源」。补上来源（青铜鳞片的荆棘走
`Actions::DamageEnemy` → `Monster::damage`）**只解决了第一道门**。真正的形状是：

1. **荆棘跑在怪物回合**（它是「挨打时反伤」），而 `MonsterGroup::applyPreTurnLogic` 在
   怪物回合**开头**把每只没有壁垒的怪的格挡清成 0（`Monster.cpp:19-21`）。所以「荆棘打在
   一只**有格挡**的怪身上」本身就要求：这只怪带**壁垒**，或者同一个怪物回合里有**更早
   行动的同伴**给它加了格挡。
2. 在那之后，**3 点伤害还要恰好把格挡打到 0**（`hadBlock && block == 0`），也就是
   命中那一刻格挡在 1~3 之间（多段攻击每段各触发一次荆棘，所以窗口按 3 的倍数往上叠）。

十个候选编队各 120 条的实测（药水钉死，于是 `Monster::damage` 的唯一调用者就是荆棘）：

| 编队                   | 荆棘命中 | 门①「有格挡」 | 门②「破盾」 | 走到的 trace |
| ---------------------- | -------- | ------------- | ----------- | ------------ |
| `spheric_guardian`     | 535      | 426           | **27**      | **25**       |
| `gremlin_leader`       | 1373     | 94            | **27**      | **23**       |
| `sentry_and_sphere`    | 973      | 797           | **21**      | **21**       |
| `donu_and_deca`        | 1005     | **477**       | **0**       | 0            |
| `centurion_and_healer` | 629      | 36            | 0           | 0            |
| `automaton`            | 899      | 30            | 0           | 0            |
| `champ`                | 585      | **0**         | 0           | 0            |
| `jaw_worm_horde`       | 802      | **0**         | 0           | 0            |
| `lagavulin`            | 331      | **0**         | 0           | 0            |
| `writhing_mass`        | 1010     | **0**         | 0           | 0            |

⚠⚠ **`donu_and_deca` 是这张表的核心教训**：它的门①最厚（477 次，迪卡的守护方阵给多努
16 点格挡、多努紧接着行动），门②却是**干净的 0**——3 点一次，一个怪物回合里凑不满 16。
**「怪会加格挡」不等于「荆棘破得掉」，两道门要各量一条分母。**（第三十八批那条教训的
第三次应用。）
⚠ 另外四个编队连门①都是 0，理由都是同一条：它们的格挡是在**自己回合的攻击之后**加的
（颚虫的重击 `attackPlayerHelper` 在前、`MonsterGainBlock` 在后）或**加完就轮到玩家**，
到下一个怪物回合开头就被清掉了。

**安装后的最终数字**（与测量 run 一例不差，理由见下）：荆棘命中 **2881** 次、门① **1317** 次、
门② **75** 次、走到的 trace **69** 条。

#### ①⚠⚠ 药水必须钉死，否则这条背书量的不是荆棘

轮换里的火焰 / 爆炸药水**也**走 `Monster::damage`，而 `pickAction` 在第 1 回合就把三瓶
喝光。第四十批据此写下「别指望用药水覆盖非攻击伤害路径——那时怪还没加过格挡」，
**但那句话有一个反例**：沉睡的拉加维林**开局就自带 8 点格挡**
（`MonsterSpecific.cpp:288-291`：`buff<METALLICIZE>(8); addBlock(8);`）。实测
`lagavulin@relic6`（没有手钻、只是把门数出来）**门②命中 59 次 / 59 条**，全部是第 1 回合
那三瓶药干的。

所以 `@relic5` 把药水钉成**格挡药水**（碰不到怪），于是
「这三份文件里每一次 `Monster::damage` 破盾都是荆棘」**按构造成立**。
⚠ 白拿的第二个好处：遗物与药水都钉死之后，这个 variant **不读 `traceIdx`**——它的 trace 与
它排在乘积里的什么位置无关，所以**测量 run 的数字可以逐例照搬**，不像第四十一批那样
「候选删掉之后数字会飘几例」。**这个套路值得复用。**

#### ②⚠⚠ 登记墨水瓶 / 橙色药丸**没有**关掉「三颗计数遗物的相对顺序」——预测错在哪

第四十一批写的是「真正会让它可观察的是夹在中间那两颗（墨水瓶 :1698 抽牌 /
橙色药丸 :1707 清减益）——登记它们时这条自动关掉」。装上之后**重量，仍然 0 例**。
两条理由，都是量出来的：

1. **墨水瓶根本不「夹在中间」**：参考的书写顺序是 墨水瓶 :1694 → 苦无 :1702 →
   **橙色药丸 :1706** → 装饰扇 :1714 → 手里剑 :1718。墨水瓶在**三颗之前**，把三颗互相
   调换永远不会跨过它。**只有橙色药丸真的夹在中间。**
2. 橙色药丸那条 `RemovePlayerDebuffs` 里，**唯一**会与「+1 敏捷 / 裸 GainBlock / +1 力量」
   互相干扰的是 `if (力量 < 0) 归零` / `if (敏捷 < 0) 归零` 那两句（脆弱与「无法格挡」
   都只拦**牌**产生的格挡，裸 `GainBlock` 不读它们）。于是需要两道门同时成立：

   | 门                                                                         | 实测                                                             |
   | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
   | 橙色药丸的 `.all()` 与 `attacksPlayedThisTurn % 3 == 0` 落在**同一张牌**上 | **6 / 360 条**（最终数据）；候选测量里最好的一副也只有 11 / 1440 |
   | 且那一刻玩家的**力量或敏捷为负**                                           | **0**（全部候选、全部编队）                                      |

   第一道门为什么这么窄：`.all()` 要求「上次清空以来攻击 + 技能 + 能力各打过一张」，
   所以命中在攻击牌上时，那张牌之前必须已经打过技能与能力**且攻击位是空的**——只有
   「本回合早些时候已经触发过一次并清空」才可能，于是至少要 3 攻 + 3 技 + 3 能。
   第二道门为什么是 0：全部已登记内容里，玩家力量/敏捷变负**只有拉加维林的吸取灵魂**
   （`MonsterSpecific.cpp:882-883`，各 −1），而它之后**第一次**橙色药丸触发就把两者钳回 0。

**结论：这条盲区留着，关门条件改写成「一个带负力量/敏捷来源、且能在一回合内打出
3 攻 + 3 技 + 3 能的 variant」——比原来那句难得多。** 参考侧看，真正便宜的关门条件是
**尖塔护盾**（`SPIRE_SHIELD_BASH` 每次 −1 力量，可以累积很负），但它属于第四幕、
连 `enemies.ts` 的条目都没有。

#### ②⁂ 顺带关掉一条**从没被记下来过**的：墨水瓶 vs 橙色药丸的相对顺序

两颗遗物在攻击 / 技能 / 能力三个 handler 里都是并排的（墨水瓶在前），而

- 墨水瓶排的是 `Actions::DrawCards(1)`；
- 橙色药丸排的是 `Actions::RemovePlayerDebuffs`，而 `Player::removeDebuffs` 里有
  `removeStatus<PS::NO_DRAW>()`。

于是玩家身上有**无法抽牌**（战斗恍惚）时，as-built 是「先抽（被 NO_DRAW 挡住、一张没抽）、
后清减益」，对调就变成真的抽到一张。实测：**能力牌那条 31 例、攻击牌那条 20 例、
技能牌那条 0 例**（技能侧那个组合在这三个编队上没出现）。
⚠ 这条完全靠**牌组**才拿到：战斗恍惚是全部已登记内容里**唯一的 NO_DRAW 产出者**。

#### 牌组：先量再定（第五次），而这一次三个目标互相打架

`@relic6` 要同时喂三样东西，而它们对牌组的要求方向不同：

| 目标                       | 想要什么                                |
| -------------------------- | --------------------------------------- |
| 橙色药丸的 `.all()`        | **0 费能力牌**（全项目只有暴怒）        |
| 墨水瓶 vs 橙色药丸的顺序   | **NO_DRAW**（全项目只有战斗恍惚）       |
| 墨水瓶的**第四个** handler | 打得出去的**状态牌** = 黏液，要仗打得久 |

三副候选，五颗遗物相同、五个编队相同、各 600 条：

| 候选牌组                             | 墨水瓶（攻/技/能/**状态**） | 橙色药丸（攻/技/能） | 两颗同一张牌 | 且带 NO_DRAW |
| ------------------------------------ | --------------------------- | -------------------- | ------------ | ------------ |
| 34 张（第四十一批那副）              | 823 / 1473 / 55 / **55**    | 136 / 99 / 176       | 50           | **0**        |
| 38 张 = + 4×暴怒                     | 856 / 938 / 190 / 10        | 533 / 382 / 822      | 149          | **0**        |
| ✅ **42 张 = + 4×暴怒 + 4×战斗恍惚** | 812 / 1215 / 224 / 18       | 592 / 304 / 1038     | 153          | **81**       |

三条结论：

1. **暴怒是全项目唯一 0 费的能力牌**，没有它橙色药丸的能力侧从 1038 掉到 176——
   `.all()` 几乎凑不齐。⚠ 顺带它给玩家上易伤，正好给清减益一个可清的东西。
2. **战斗恍惚是唯一的 NO_DRAW 产出者**，它把第三列从 0 变成 81。
3. ⚠⚠ **牌组在第三个目标上是反作用的**：0 费牌越多，史莱姆王死得越快、打出的黏液越少
   （34 张那副 360 次 → 42 张那副 96 次）。**「加牌总是更好」不成立**，这是「先量再定」
   第一次量出三个目标互相打架。42 张仍然够用（最终 92 次 / 51 条）。

⚠ **编队里必须有 `slime_boss`**：黏液是策略唯一打得出去的状态牌
（`CardInstance.cpp:329` 那个 `id != SLIMED` 的例外），而实测里只有史莱姆王大量产出它
（`large_slime` 0~9 次、`lots_of_slimes` / `small_slimes` 0）。**墨水瓶的第四个 handler
只有这一个宿主。**

**安装后的最终数字**（三个编队合计 360 条）：墨水瓶 攻 564 / 技 778 / 能 145 / **状态 10**
（10 条 trace），打出的状态牌 **92 次 / 51 条**；橙色药丸 攻 383 / 技 183 / 能 656；
两条门同时命中 **6** 次、其中带负力量或敏捷的 **0** 次。
⚠ 与测量 run 的差异是**预期的**：`@relic6` 的药水走轮换，候选被删掉之后 `traceIdx` 变了。

#### 变异测试（33946 例基线，括号内为失败例数；`@relic5` 上限 **360**、`@relic6` 上限 **360**）

**手钻的两条伤害路（本批的主角）**

| 变异                           | 例数     | 说明                                                                             |
| ------------------------------ | -------- | -------------------------------------------------------------------------------- |
| `Monster::damage` 那一份去掉   | **64**   | ✅ **第四十批那条 0 例关掉了**。逐文件：守卫者 25 / 地精首领 23 / 哨卫+守卫者 16 |
| `Monster::attacked` 那一份去掉 | **1048** | 第四十批是 723，本批 +325                                                        |
| 青铜鳞片的荆棘 3 → 4           | **8246** | 只是旁证（青铜鳞片本来就在八个轮换里）                                           |

⚠ 门② 命中 75 次 / 69 条，而变异只红 **64** 条：差的 5 条是**球状守卫者的神器 3 层**把那两层
易伤吃掉了（`Monster::addDebuff` 的神器门），或者那一击同时打死了它。**「触发次数」与
「可观察例数」不是一回事**，报告两者都写。

**墨水瓶（四个 handler + 计数器）**

| 变异                             | 例数    | 说明                                                                      |
| -------------------------------- | ------- | ------------------------------------------------------------------------- |
| 攻击 handler 那一份去掉          | **352** |                                                                           |
| 技能 handler 那一份去掉          | **347** |                                                                           |
| 能力 handler 那一份去掉          | **351** |                                                                           |
| **状态/诅咒 handler 那一份去掉** | **25**  | ✅ 全部落在 `slime_boss@relic6` —— **「每 10 张牌」真的把状态牌也数进去** |
| 阈值 `== 10` 改成 `>= 10`        | **0**   | **等价改写**（命中即归零，永远不会超过 10）                               |
| 阈值 10 → 9                      | **353** |                                                                           |
| 自增挪到读点**之后**             | **347** |                                                                           |
| 命中时**不**把计数器归零         | **300** |                                                                           |
| 抽牌改成**同步**（不入队）       | **100** |                                                                           |

**橙色药丸（三个 handler + 回合复位 + 清减益）**

| 变异                                     | 例数    | 说明                                             |
| ---------------------------------------- | ------- | ------------------------------------------------ |
| 攻击 / 技能 / 能力 handler 各去掉一份    | **355** | 三条数字相同——任何一处漏抄，位掩码从此永远凑不齐 |
| **回合开始的复位**（Player.cpp:559）去掉 | **271** | 钉住「同一**回合**内」那四个字                   |
| 命中时**不**清空位掩码                   | **328** |                                                  |
| 清减益改成**同步**（不入队）             | **325** |                                                  |
| 给**状态/诅咒** handler 也加一份         | **0**   | **盲区（探针弱）**，见下                         |

**`Player::removeDebuffs` 的内部**

| 变异                                  | 例数    | 说明                                                                |
| ------------------------------------- | ------- | ------------------------------------------------------------------- |
| 不摘**易伤**                          | **355** |                                                                     |
| 不摘**无法抽牌**（NO_DRAW）           | **306** |                                                                     |
| 不摘**脆弱**                          | **110** |                                                                     |
| 不摘**虚弱**                          | **105** |                                                                     |
| 力量/敏捷的 `< 0` 归零**整段去掉**    | **0**   | **盲区**：这三个编队里玩家的力量/敏捷从没变负过（见上）             |
| 把 `< 0` 那道门**去掉**（正数也归零） | **357** | ⚠ 反方向非 0——**「只在为负时归零」这一半是有背书的**，缺的是另一半  |
| 抽牌削减那句 `++cardDrawPerTurn` 去掉 | **0**   | **盲区**：DRAW_REDUCTION 只有时间吞噬者一个产出者，不在这三个编队里 |

**顺序探针**

| 变异                                             | 例数    | 说明                                                   |
| ------------------------------------------------ | ------- | ------------------------------------------------------ |
| ⁂ 墨水瓶挪到橙色药丸**之后**（能力牌）           | **31**  | ✅ 新关掉的一条，机理是 NO_DRAW                        |
| ⁂ 同上（攻击牌）                                 | **20**  | ✅                                                     |
| ⁂ 同上（技能牌）                                 | **0**   | 这三个编队上那个组合没出现；上面两条已经把这条规则钉住 |
| **三颗计数遗物顺序倒过来**（手里剑→装饰扇→苦无） | **0**   | ❌ **盲区仍在**，理由与两道门的例数见上                |
| 苦无改成给**力量**（对照，只改一颗）             | **762** | 第四十一批是 423，本批 +339——单颗的效果照旧钉死        |
| 回合开始表里橙色药丸排到硫磺**之前**             | **0**   | **等价改写**：两者不互相读                             |
| 状态/诅咒 handler 里墨水瓶挪到诅咒(HEX)**之前**  | **0**   | **盲区**：这三个编队里没有选民，HEX 一次都没出现       |

#### 本批新增 / 变动的盲区

| 盲区                                                     | 例数 | 分类与关门条件                                                                                                                                                                                                              |
| -------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **三颗攻击计数遗物的相对顺序**（第四十一批记，本批重量） | 0    | **盲区（两道门都很窄）**：需要「橙色药丸与 `%3==0` 落在同一张牌上」（6 / 360）**且**「那一刻力量或敏捷为负」（0）。⚠ 关门条件从第四十一批写的那句改成：**带尖塔护盾那种可累积负力量的怪** + 能一回合打 3 攻 3 技 3 能的牌组 |
| `Player::removeDebuffs` 的**负力量/敏捷归零**那两句      | 0    | **盲区（分母为 0）**：同上，玩家力量/敏捷变负只有拉加维林吸取灵魂一处、且触发一次就被钳回。⚠ 反方向（去掉 `< 0` 这道门）红 357，所以这一格**半边有背书**                                                                    |
| `removeDebuffs` 里抽牌削减的 `++cardDrawPerTurn`         | 0    | **盲区（分母为 0）**：DRAW_REDUCTION 的唯一产出者是时间吞噬者。⚠ 关门条件很便宜：给带橙色药丸的 variant 配 `time_eater`                                                                                                     |
| **给状态/诅咒 handler 也加一份橙色药丸**                 | 0    | **探针弱**：参考那里没有它是因为 `bitset<3>` 装不下 `CardType::CURSE`(3) / `STATUS`(4)，越界而不是「设计上不算」。我们的探针只能写 `set(bit 0)`，而那一位几乎总是已经置上了。记成「形状照抄、无法用变异证明」               |
| **墨水瓶的 `data`（跨战斗计数器）**                      | —    | **不在战斗内**：`initRelics` 读 `r.data`、`updateRelicsOnExit` 写回，是 run 层的一对读写。我们的 `bc.relics` 只有 id（与御守 `setHasRelic<OMAMORI>(r.data)` 同一个缺口）。等 run 层                                         |
| **墨水瓶在状态/诅咒 handler 里的位置**                   | 0    | **探针无效**：它的邻居是诅咒（选民）与蓝色蜡烛 / 医疗包（都未登记），而这三个编队里 HEX 出现 0 次。⚠ 关门条件：给带墨水瓶的 variant 配 `chosen`                                                                             |
| **`RELIC_AT_TURN_START` 的表内顺序**                     | 0    | **等价改写**：表里只有硫磺与橙色药丸，两者不互相读。⚠ 本批已经把这张表从 Record 改成**有序数组**（参考那里是并列的 `if`，顺序由源码定），关门条件是登记战争艺术 / 船长之轮                                                  |

#### 三条给下一个人的结论

1. ⚠⚠ **「补上缺的那个来源」只解决第一道门。** 第四十批把手钻那条 0 例的根因记成「没有
   非攻击伤害来源」，补上青铜鳞片之后**十个候选编队里有六个仍然是 0**——四个连「怪身上
   有格挡」都做不到，`donu_and_deca` 门①最厚（477）门②照样 0。**记盲区时把「关门条件」
   写成一串门而不是一句话**，否则下一个人会照着那句话选编队然后白跑一轮。
2. ⚠⚠ **前一批写下的「关门条件」是猜测，不是结论——兑现时要先验证它。** 第四十一批那句
   「登记墨水瓶 / 橙色药丸时这条自动关掉」在源码上就站不住（墨水瓶根本不在三颗中间），
   而真正夹在中间的橙色药丸需要两道极窄的门。**顺带的收获是另一条从没被记过的盲区
   （墨水瓶 vs 橙色药丸，51 例）——去兑现一条旧盲区时，顺手把邻居也量一遍。**
3. **「遗物 + 药水都钉死」的 variant 不读 `traceIdx`，测量数字可以逐例照搬。** 第四十一批
   吃过「候选删掉之后数字会飘」的亏；`@relic5` 把药水钉死之后，测量 run 与安装后的
   2881 / 1317 / 75 / 69 一个数都没变。**要做精确对照时优先选这个形状。**

### 第四十一批：遗物战线第二批——硫磺 + 回合内计数族（苦无 / 装饰扇 / 手里剑 / 开信刀）

#### 数据规格与体积

| 项        | 值                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| harness   | 第五个乘积 `relicVariants` 追加**一个** variant（relicSet **4**），前三个一个字没动                            |
| 牌组      | **34 张、未升级**：`BATCH_1 + SPOT_WEAKNESS`（22）+ 4×灵巧 + 4×直觉 + 4×优雅。⚠ 量出来的，见下                 |
| 种子 / 层 | 40 / `{1,3,7}`                                                                                                 |
| 爬升度    | **0**；目标策略 **0**                                                                                          |
| 编队      | `gremlin_leader` / `automaton` / `collector` / `reptomancer`——**全参考仅有的四个「留空位」编队**               |
| 文件      | `@relic4` **4 份**，每份 120 行、**整份冻结**                                                                  |
| 例数      | 480，对拍 32746 → **33226**                                                                                    |
| 体积      | **24MB**，仓库 660MB → **684MB**，文件数 126 → **130**                                                         |
| 扰动      | `git status -- test/golden/traces` 恰好 **4 个 `??`、零个 `M`**；四份文件 `variant0-rows.mjs` 均 = 整份 120 行 |
| 参考补丁  | **无**（`ALLOW_CHANGED` 一次都没用）                                                                           |

#### ⚠⚠ 硫磺有**两个**读点，而 TODOS 的候选表只记了一个

候选表（上一批写的）只写了 `initRelics` 那一格。实际 grep 下来是**两处**：

| 读点                                                     | 覆盖            | 形状                                      |
| -------------------------------------------------------- | --------------- | ----------------------------------------- |
| `BattleContext::initRelics`（BattleContext.cpp:126-134） | **第 1 回合**   | 玩家 +2 力量；每只**可指向**的怪 +1，同步 |
| `Player::applyStartOfTurnRelics`（Player.cpp:497-505）   | **第 2 回合起** | **函数体逐字相同**                        |

两处的函数体一模一样，所以只抄一处**不会报错，只会每回合少一次**。实测两处**各红 480 例**
（= 本批全部），缺一不可。

⚠ 真实游戏的卡面写的是「每个玩家回合开始……」，**参考用两处拼出这一句**——`init` 不走
`afterMonsterTurns`，所以第 1 回合那一份必须由 `initRelics` 给。
**判据：登记一颗遗物之前 `grep -rn 'R::<名字>' src include`，别信候选表里的单个行号。**

这一批因此开了本项目**第三个遗物时点** `RELIC_AT_TURN_START`（前两个是 `initRelics`
的两遍）。参考在这个函数里还并排放着战争艺术 / 船长之轮 / 达摩鲁 / 情绪芯片，登记它们时
有两条已经看清的时序写在 `applyStartOfTurnRelics` 的注释里。

#### 硫磺 vs 贤者之石：四个方向的对照表（本批的核心）

两颗遗物在**同一个 `switch`** 里、循环形状一模一样，只有过滤器不同。第四十批钉住了
「无过滤」那一侧，本批钉住「有过滤」那一侧，四个方向全部非 0：

| 方向 | 遗物                          | 写法                    | as-built? | 变异例数                  |
| ---- | ----------------------------- | ----------------------- | --------- | ------------------------- |
| ①    | 硫磺 `initRelics`             | `if (m.isTargetable())` | ✅ 是     | 去掉过滤 → **480**        |
| ②    | 硫磺 `applyStartOfTurnRelics` | `if (m.isTargetable())` | ✅ 是     | 去掉过滤 → **480**        |
| ③    | 贤者之石 `initRelics`         | 裸的 `i < monsterCount` | ✅ 是     | 加 `alive` 过滤 → **480** |
| ④    | 两者互换写法                  | —                       | ❌        | 即 ①②③ 的合取，同上       |

**③ 那个 480 是第四十批的数字，本批重量一遍，一例不差**——它的数据（`@relic1`）本批没动，
数字不变本身就是「本批没扰动已冻结数据」的一条旁证。

⚠⚠ **两颗的可观察面并不同宽，别以为对称**：

- 贤者之石只在 `initRelics` 跑一次，那时**没有怪是死的**，所以「有没有过滤」的差别
  **只来自预留空位**——第四十批那 480 例正是四个「留空位」编队各 120。
- 硫磺**每回合**再跑一遍，于是它的过滤器还挡着**尸体**（`isTargetable()` = `!isDeadOrEscaped()`，
  死怪也不给）。所以 ② 的 480 例是「空位 + 尸体」两件事之和，比 ① 宽。
  ① 那 480 例才是纯粹的「空位」信号（初始化那一刻没有尸体）。

⚠ **`isTargetable()` 与 `isAlive()` 在本批分辨不了**：前者还排除**半死**与**逃跑**，
而这四个编队一只半死 / 逃跑的怪都没有。记成盲区，关门条件见下表。

#### 牌组：先量再定（第四次，而这次量的是「门」）

第三十七 / 三十八 / 三十九批量的是「新怪的招式执行得到吗」「这一批要背书的局面出现吗」。
本批量的是**第三种东西**：**一颗遗物自己的触发门**。开信刀要**一回合内三张技能牌**，
那与「一回合内三张攻击牌」是**两条独立的门**，必须各量一条分母（第三十八批的教训）。

三副候选，五颗遗物相同、四个编队相同、各 480 条 trace：

| 候选牌组                                       | 张数 | 平均回合 | **攻击门**触发 / 走到的 trace | **技能门**触发 / 走到的 trace |
| ---------------------------------------------- | ---- | -------- | ----------------------------- | ----------------------------- |
| `BATCH_1 + SPOT_WEAKNESS`（历批标准）          | 22   | 6.64     | 969 / 449                     | **59 / 56**                   |
| ✅ **+ 4×灵巧 + 4×直觉 + 4×优雅**（本批选的）  | 34   | 7.17     | 722 / 418                     | **1966 / 479**                |
| 同上但**不带硫磺**（只为解释回合数，不是候选） | 34   | 9.54     | 1075 / 440                    | 2628 / 479                    |

三条结论：

1. **22 张那副不是 0，但薄得不该用**：480 条里只有 56 条走到过技能门。
   ⚠ 这正是「先量再定」的价值——只看「非 0」会让人以为够用。
2. **加 12 张 0 费技能牌把技能门抬了 33 倍**，代价是攻击门掉 25%（722 仍然很厚）。
   ⚠ 加的牌**全是 0 费且都不消耗**：`pickAction` 严格从左往右花能量，1 费技能牌会与攻击牌
   抢那 3 点；消耗牌则每轮洗牌只来一次。
3. ⚠⚠ **硫磺让仗变**短**，不是变长**（9.54 → 7.17 回合）。它给玩家每回合 +2 力量，
   玩家杀得更快。**「把遗物叠进同一个 variant」不是免费的**——叠的那颗会改变分母。
   本批仍然叠了，因为叠完之后两条门的例数都还够厚（722 / 1966）。

**最终安装的四份文件实测**：攻击门 **730 次 / 427 条**、技能门 **1933 次 / 477 条**、
硫磺的回合开始那一份跑了 **2682** 次（+ 480 次 `initRelics`）。
⚠ 与测量run的数字有几例出入是**预期的**：候选被删掉之后本 variant 的 `traceIdx` 变了 →
轮换发的药水跟着变。**结论不变，但报告里要写最终那一组数。**

#### 变异测试（33226 例基线，括号内为失败例数；本 variant 上限 **480**）

**硫磺**

| 变异                                             | 例数    | 说明                                 |
| ------------------------------------------------ | ------- | ------------------------------------ |
| `initRelics` 那一格整条去掉                      | **480** |                                      |
| **回合开始**那一份整条去掉                       | **480** | 两个读点各自独立有背书               |
| `initRelics` 那处**去掉 `alive` 过滤**           | **480** | 纯「预留空位」信号（那一刻没有尸体） |
| **回合开始**那处**去掉 `alive` 过滤**            | **480** | 「空位 + 尸体」之和                  |
| 玩家那 +2 力量去掉（两处）                       | **480** |                                      |
| 怪物那 +1 那半去掉（两处）                       | **480** |                                      |
| 玩家 buff 挪到怪物循环**之后**（两处）           | **0**   | **等价改写**：两边都是同步写快照字段 |
| `applyStartOfTurnRelics` 挪到 `…Powers` **之后** | **0**   | **等价改写**，见下方盲区表           |

**贤者之石（对照，重量）**

| 变异                | 例数    | 说明                                             |
| ------------------- | ------- | ------------------------------------------------ |
| 循环加 `alive` 过滤 | **480** | 与第四十批**一例不差**（`@relic1` 本批未被扰动） |

**苦无 / 装饰扇 / 手里剑（共用 `attacksPlayedThisTurn`，触发位置各不相同）**

| 变异                                                  | 例数    | 说明                                                                    |
| ----------------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| 苦无整条去掉                                          | **423** |                                                                         |
| 装饰扇整条去掉                                        | **427** |                                                                         |
| 手里剑整条去掉                                        | **423** |                                                                         |
| 苦无改成给**力量**（手里剑不动）                      | **423** | 单颗的效果是钉住的                                                      |
| ⚠ 苦无 ↔ 手里剑**对调**（两颗都改）                   | **0**   | **盲区**，见下表——两颗同时触发、都是加法，总量不变                      |
| 三条**顺序倒过来**（手里剑 → 装饰扇 → 苦无）          | **0**   | **等价改写**：三条都只写玩家自己的字段，裸 `GainBlock` 也不读敏捷       |
| 装饰扇 `clearOnCombatVictory` **false → true**        | **37**  | 薄但非 0：触发那一击打死最后一只怪时，格挡该留下                        |
| 苦无 + 手里剑 `clearOnCombatVictory` **true → false** | **37**  | 反方向同样非 0——**两颗的这一位与装饰扇相反，逐条照抄**                  |
| 三条各**补上 `>= 3` 前置条件**                        | **0**   | **等价改写**（自增在前 ⇒ `% 3 == 0` 蕴含 `>= 3`），与开信刀那条互为镜像 |
| ⚠⚠ **自增挪到三颗遗物之后**                           | **480** | **「0 也满足 `% 3 == 0`」这个陷阱的直接背书**                           |

**开信刀**

| 变异                    | 例数    | 说明                                     |
| ----------------------- | ------- | ---------------------------------------- |
| 整条去掉                | **477** |                                          |
| 伤害 5 → 4              | **477** |                                          |
| 挪到**攻击牌**那条路    | **477** | 钉住「只有技能牌触发」                   |
| `addToBot` → `addToTop` | **7**   | 薄：要这张技能牌自己还排了别的动作       |
| 改成**同步**（不入队）  | **7**   | 同上，两个方向都非 0                     |
| ⚠ 去掉 `>= 3` 那一半    | **0**   | **等价改写**（不是笔误、不报补丁），见下 |
| **自增挪到读点之后**    | **477** |                                          |

**两个计数器本身**

| 变异                       | 例数    |
| -------------------------- | ------- |
| 两个计数器**回合末不清零** | **480** |

#### ⚠ 开信刀的 `>= 3` 是「作者的防备」，不是笔误

参考在开信刀写的是 `if (p.skillsPlayedThisTurn >= 3 && p.skillsPlayedThisTurn % 3 == 0)`，
而攻击那三颗**只写了 `% 3 == 0`**。既然自增排在函数第一句，到读点时计数至少是 1，
`x >= 1 && x % 3 == 0` 蕴含 `x >= 3`——所以那一半是**死条件**。

实测两个方向都是 **0 例**：开信刀去掉它 0 例、给攻击那三颗补上它也 0 例。
**这是「等价改写」，照抄、不报补丁**（判据 ①「在已登记内容里产生分歧」就不成立）。
它记录的是作者对「0 也满足 `% 3 == 0`」的防备，而那份防备只写了一处——
**如果哪天有人把自增挪到读点之后，攻击那三颗会当场错、开信刀不会。**

#### 本批新增的盲区

| 盲区                                           | 例数 | 分类与关门条件                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 硫磺过滤器是 `isTargetable()` 还是 `isAlive()` | —    | **分母为 0**：两者只在**半死 / 逃跑**的怪身上分岔，本批四个编队一只都没有。⚠ 关门条件很便宜：把硫磺发给带 `awakened_one`（半死）或 `looter` / `two_thieves`（逃跑）的 variant                                                                                                       |
| 苦无 ↔ 手里剑「哪颗给哪个属性」                | 0    | **盲区（探针可观察但当前语料同解）**：两颗**同时**触发、效果都是加法，对调之后玩家的敏捷 / 力量总量一模一样。⚠ 关门条件：一个**只带其中一颗**的 variant（哪怕只有一个编队）                                                                                                         |
| 三颗攻击计数遗物的**相对顺序**                 | 0    | ⚠⚠ **这一格的关门条件写错了，第四十二批实测证伪**：墨水瓶排在三颗**之前**（:1694，不是「夹在中间」），真正夹在中间的只有橙色药丸，而它需要两道极窄的门（同一张牌上两条同时命中 6 / 360，且那一刻力量或敏捷为负 0 / 360）。**登记这两颗之后仍是 0 例**，新的关门条件见第四十二批那节 |
| 开信刀在 `onUseSkillCard` 里的**位置**         | —    | **探针无效**：它的邻居是诅咒（选民）与激怒（地精头目），而本批四份文件里 `ENRAGE` / `HEX` 各出现 **0** 次（grep 过）。⚠ 关门条件：给带开信刀的 variant 配 `gremlin_nob` 或 `chosen`                                                                                                 |
| `applyStartOfTurnRelics` 相对 `…Powers` 的位置 | 0    | **等价改写**：这张表里当前只有硫磺，而它只同步写力量；`applyStartOfTurnPowers` 里没有同步读力量的东西。⚠ 关门条件：登记战争艺术（它入队 `GainEnergy`）或船长之轮（入队 `GainBlock`）                                                                                                |
| 战争艺术读的是**上一回合**的攻击张数           | —    | **未登记**：三个计数器的清零排在 `applyStartOfTurnRelics` **之后**（BattleContext.cpp:2240-2242，参考自注 `// this has to be here because some relics check this info.`）。登记它时专门核这处                                                                                       |

#### 三条给下一个人的结论

1. **登记一颗遗物之前先 `grep -rn 'R::<名字>'`，别信候选表里的单个行号。** 硫磺的候选表条目
   只写了 `initRelics`，实际是两处；只抄一处**不会报错**，只会每回合少一次。
   同族的风险面是「参考把一句话拆到两个时点去实现」——`initRelics` 覆盖第 1 回合、
   `applyStartOfTurnRelics` 覆盖其后。
2. **「先量再定」第四次，而这次量的是「门」。** 前三次量的是招式 / 局面，这次量的是
   **遗物自己的触发条件**，而且**一颗遗物可能有多条门**（攻击门与技能门是两条，
   必须各量一条分母）。⚠ 顺带量出来的第二件事：**叠进同一个 variant 的遗物会改变分母**
   ——硫磺让平均回合数从 9.54 掉到 7.17。
3. **顺序即语义的地方要专门写一条变异。** `% 3 == 0` 这一族的全部风险都在「自增在读点
   之前还是之后」这一句上（0 也满足 `% 3 == 0`），而**对拍全绿分辨不了它**——
   两个方向的探针（挪自增 480 / 477、补 `>= 3` 0）合起来才把这件事讲完整。

### 第四十批：遗物战线开张——贤者之石 / 地精之角 / 手钻 / 暗石护符 / 御守

#### 数据规格与体积

| 项        | 值                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| harness   | **第五个乘积** `relicVariants × relicEncounters`（挂在 `act3Variants` 之后），三个 variant：40 / 41 / 42                      |
| 牌组      | **`BATCH_1 + SPOT_WEAKNESS`（22 张，未升级），三个 variant 逐字节相同**——本批要量的是「参考对遗物有没有反应」，不是打不打得动 |
| 种子 / 层 | 40 / `{1,3,7}`                                                                                                                |
| 爬升度    | **0**；目标策略 **0**                                                                                                         |
| 文件      | `@relic1` 8 份 + `@relic2` / `@relic3` 各 1 份 = **10 份**，每份 120 行、**整份冻结**                                         |
| 例数      | 1200，对拍 31546 → **32746**                                                                                                  |
| 体积      | **38MB**，仓库 622MB → **660MB**，文件数 116 → **126**                                                                        |
| 扰动      | `git status -- test/golden/traces` 恰好 **10 个 `??`、零个 `M`**；装完再跑一次 `--check`，**126 个文件逐字节复现**            |
| 参考补丁  | **无**（本批没给参考打任何补丁，`ALLOW_CHANGED` 一次都没用）                                                                  |

三个 variant 的遗物：

| 文件后缀  | 遗物                                     | 药水                    | 编队                                                                                                                   |
| --------- | ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@relic1` | 贤者之石 + 地精之角 + 手钻               | 走旧轮换                | `large_slime` `slime_boss` `spheric_guardian` `gremlin_leader` `automaton` `collector` `three_darklings` `reptomancer` |
| `@relic2` | 暗石护符 + 手钻                          | **钉死**（格挡药水 ×3） | `writhing_mass`                                                                                                        |
| `@relic3` | **`@relic2` 再加一颗御守（`data = 2`）** | 同上                    | `writhing_mass`                                                                                                        |

#### ⚠⚠ `@relic2` / `@relic3` 是一对**只差一颗遗物**的 A/B，背书是逐行 diff 而不是变异

两者的牌组、种子、楼层、爬升度、目标策略**全同**，药水也钉死成同一张（不钉的话两个
variant 的 `traceIdx` 不同 → 轮换发给它们的药水不同，A/B 立刻失去意义）。于是：

- 剥掉 `relics` / `relicSet` 两个头部字段之后，两份文件**逐行比对：67 / 120 条不同**；
- 那 67 条**全部**是 `player.maxHp` 在某一帧从 80 变成 **86**（`@relic3` 里 0 条出现过 86）；
- 两份文件的「植入」意图帧**都是 245**——所以差别不在「植入出没出」，只在「植入之后发生了什么」。

**这是这个仓库里第一份「A/B 只差一个输入」的语料**，比变异测试更直接：它证明的不是
「我们的代码被数据看着」，而是「参考在这一颗遗物上真的分岔了」。

#### 八个编队 = 贤者之石的八个读点，一个读点一个宿主

| 读点                                             | 宿主编队          |
| ------------------------------------------------ | ----------------- |
| `initRelics`（全场 +1 力量 + `energyPerTurn++`） | 全部八个          |
| `largeSlimeSplit`（`MonsterSpecific.cpp:3406`）  | `large_slime`     |
| `slimeBossSplit`（`:3433`）                      | `slime_boss`      |
| `Actions::SummonGremlins`（`Actions.cpp:488`）   | `gremlin_leader`  |
| `Monster::spawnBronzeOrbs`（`:3454`）            | `automaton`       |
| `Actions::SpawnTorchHeads`（`Actions.cpp:517`）  | `collector`       |
| `Monster::reptomancerSummon`（`:3601`）          | `reptomancer`     |
| `DARKLING_REINCARNATE`（`:1494`）                | `three_darklings` |

⚠ **相对 `buff<MINION>` 的先后逐处不同**（地精是**之前**、青铜球 / 火炬头 / 匕首是**之后**），
照抄。当前不可观察（快照按 `MonsterStatus` 枚举序输出，不是获得顺序），如实记成等价改写。

#### ⚠⚠ 顺带掀开一处此前不可观察的建模差异：青铜球没有 `arr[idx] = Monster()`

`Monster::construct`（`Monster.cpp:109-135`）只写 `id` / `idx` / `initHp` / 虱子与暗影客的
`miscInfo`——**状态位、力量、格挡、意图历史一个都不碰**。而四个召唤宿主里
**只有青铜自动机没有 `arr[idx] = Monster()`**（那张 13 维表的倒数第五行早就写着，
只是没人能观察到）。

在贤者之石之前，自动机的 0 / 2 号位是**从没被写过的空格**，「保留」与「清空」同解。
贤者之石的 `initRelics` 那一格给**包括空格在内**的每一格 +1 力量，于是青铜球出生时应该
带 **2** 点力量（残留 1 + 召唤 1）而不是 1 点——**`automaton@relic1` 的 120 条全红**。
本批新增 `constructMonsterInPlace` 表达这一支，探针（就地 construct 时补一句
`slot.powers = []`，等于补上那个 `arr[idx] = Monster()`）红 **120 例**。

⚠⚠ **这一条的第一版探针是坏的，值得单记（「假的非 0」第三种形状）**：最初写的探针是
「把两句就地 construct 换回 `bc.monsters[0] = constructMonster(...)`」，红 **735 例**
（= 四个 automaton 文件的全部）。数字看着更漂亮，其实是**探针本身写错了**——换掉之后
下面那几句 `addPower(orb1.powers, "minion", 1)` / `rollMove(bc, orb1)` 里的 `orb1`
仍然指着**被顶掉的旧对象**，于是它顺带删掉了 MINION 与两次 rollMove，红的是那些。
**判据：探针换掉一个对象时，先数一遍还有谁持有旧引用。**

**判据：装一个「给全场加东西」的遗物时，先问「参考这个循环有没有过滤」，
再问「有没有哪个格子会被后来的怪覆盖、而覆盖时不清空」。**
⚠ 隔壁 `R::BRIMSTONE` 的同型循环写的是 `if (m.isTargetable())`，贤者之石那格是裸的
`i < monsterCount`——**同一个 switch 里两种写法并存**，逐条看清。

#### 变异测试

**贤者之石**

| 变异                                                  | 例数    | 说明                                                                                                                            |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `initRelics` 那一格整条去掉                           | **960** | = 八个 `@relic1` 文件的全部                                                                                                     |
| 循环加 `alive` 过滤（**跳过预留的空格**）             | **480** | ⚠ 这一条单独钉住「循环没有任何过滤」——四个有空格的编队各 120                                                                    |
| 只给力量、**不加 `energyPerTurn`**                    | **960** |                                                                                                                                 |
| `energyPerTurn += 1` 改成 `energy += 1`（只加一回合） | **955** | ⚠ 与上一条只差 5 例——两种写法在 5 条 trace 上同解（仗短到那点能量此后没被用上）。**差值小不等于这一位没背书**，955 才是它的数字 |
| `largeSlimeSplit` 那两句去掉                          | **221** | ⚠ 跨两个文件：`large_slime@relic1` 与 `slime_boss@relic1`（王分裂出的大史莱姆会**再走一次** `largeSlimeSplit`）                 |
| `slimeBossSplit` 那两句去掉                           | **120** |                                                                                                                                 |
| `SummonGremlins` 那一句去掉                           | **120** |                                                                                                                                 |
| `spawnBronzeOrbs` 那两句去掉                          | **120** |                                                                                                                                 |
| `SpawnTorchHeads` 那一句去掉                          | **120** |                                                                                                                                 |
| `reptomancerSummon` 那一句去掉                        | **120** |                                                                                                                                 |
| **暗影客复活**那一句去掉                              | **114** | 120 条里 114 条走到过复活，其余 6 条三只一起死掉了（`die` 的判胜 `return`）                                                     |

**地精之角**

| 变异                                 | 例数    | 说明                                                                             |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------- |
| 整条去掉                             | **828** | 八个文件里除 `spheric_guardian`（单怪，永远轮不到）与 `writhing_mass` 之外的全部 |
| 只回能量、不抽牌                     | **828** |                                                                                  |
| 改成**同步**（不入队）               | **113** | ⚠ 薄但非 0，是这一族「入队 ↔ 同步」少有的干净非 0                                |
| `addToBot` → `addToTop`              | **104** | 与「改成同步」是两个方向，都非 0                                                 |
| **两条动作顺序对调**（先抽后回能量） | **0**   | **盲区（分母为 0）**，见下                                                       |

**手钻**

| 变异                                     | 例数     | 说明                                   |
| ---------------------------------------- | -------- | -------------------------------------- |
| `Monster::attacked` 那一份去掉           | **723**  |                                        |
| `Monster::damage` 那一份去掉             | **0**    | **盲区（分母为 0）**，见下             |
| 去掉 `hadBlock` 那一半（没格挡也上易伤） | **1160** | 最厚的一条——它把「这道门是合取」钉死了 |
| 改成**同步**（不入队）                   | **111**  |                                        |
| `isSourceMonster` `false` → `true`       | **463**  | 钉住「玩家来源、本回合末就递减」       |
| 层数 `2` → `1`                           | **615**  |                                        |
| `addToBot` → `addToTop`                  | **18**   | 薄，但把「入队到队尾」也钉住了         |

**暗石护符 / 御守**（四条都恰好 **67 例** = 那 67 条真的植入过、且玩家没死在那之前）

| 变异                             | 例数   | 方向                                 |
| -------------------------------- | ------ | ------------------------------------ |
| 去掉**御守**那道门               | **67** | `@relic3` 全红（该拦的没拦住）       |
| 去掉**暗石护符**那道门           | **67** | `@relic3` 全红（不该给的给了）       |
| `increaseMaxHp` 只加上限、不回血 | **67** | 钉住 `maxHp += n; heal(n);` 两句都要 |
| 整条 `obtain_curse` 去掉         | **67** | `@relic2` 全红                       |

**顺带关掉的两条旧账**

| 旧盲区                                              | 原批次 | 原例数        | 现在                                                                                                                                                              |
| --------------------------------------------------- | ------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **匕首自爆的 `triggerRelics` 这一位**               | 三十六 | 0（探针无效） | **116 例**。当年的理由是「匕首没有亡语、从不获得格挡，八个轮换里也没有地精角 / 活体样本」——**地精之角登进 `@relic1` 之后，`Monster::die` 那条链本身就是可观察面** |
| **青铜自动机「没有 `arr[idx] = Monster()`」这一维** | 二十八 | 从未量过      | **120 例**（见上）。它此前甚至没被记成盲区，因为没人想得到怎么观察它                                                                                              |

#### 第四十批新记的盲区

| 盲区                                            | 例数 | 分类                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **手钻在 `Monster::damage` 那条路上的那一份**   | 0    | ✅ **第四十二批关掉，64 例**（`@relic5` = 手钻 + 青铜鳞片）。⚠ 但当年写的关门条件只对了一半：补上非攻击伤害来源只过了第一道门，第二道门是「荆棘要**恰好**把格挡打到 0」，十个候选编队里六个仍然是 0（`writhing_mass` 连「怪身上有格挡」都做不到，`donu_and_deca` 门①最厚 477、门②照样 0）。逐条见第四十二批那节 |
| **地精之角两条动作的先后**                      | 0    | **盲区（分母为 0）**：`GainEnergy` 与 `DrawCards` 只在「抽到的牌自己会改能量」时不可交换，而唯一这样的牌是**虚无**（抽到 `energy = max(0, energy-1)`），它只来自觉醒者。⚠ 关门条件 = 「地精之角 + 觉醒者同场，且回合中途能量已花光」——与第三十七批那条「虚无的 `max(0,…)` 下限」是**同一个局面**                |
| **贤者之石相对 `buff<MINION>` 的先后**          | 0    | **等价改写**：harness 的 `monsterStatuses` 按 `MonsterStatus` **枚举序**逐个下标输出，不是获得顺序；我们这边也按 id 归一。任何语料都分辨不了                                                                                                                                                                    |
| **御守的 `data` 递减**（`Deck::obtain` 那一半） | —    | **不在战斗内**：`BattleContext.cpp:463` 那条 `--getRelicValueRef(OMAMORI)` 属于 run 层的「获得诅咒」路径，与战斗内这一处只读的用法是同一个遗物的两处不同写法。等 run 层                                                                                                                                         |

### 第三十九批：第三幕收官——迪卡与多努（「无门的友军增益」）

#### 数据规格与体积

| 项        | 值                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| harness   | 第四个乘积 `act3Variants` 里追加的 **variant 39**（variant 38 的 encounters 一个字没动）                      |
| 牌组      | **第三十八批那 59 张全升级的，逐字节复用**（⚠ 指纹因此与 variant 38 相同，靠 encounters 不相交保住唯一性）    |
| 种子 / 层 | 40 / `{1,3,7}`                                                                                                |
| 爬升度    | **0**；目标策略 **0**                                                                                         |
| 编队      | `donu_and_deca`（⚠ **迪卡在 0 号位、多努在 1 号位**，与编队名的顺序相反）                                     |
| 例数      | 120，对拍 31426 → **31546**                                                                                   |
| 体积      | **8.0MB**，仓库 614MB → **622MB**，文件数 115 → **116**                                                       |
| 扰动      | `git status -- test/golden/traces` 恰好 **1 个 `??`、零个 `M`**；装完再跑一次 `--check`，116 个文件逐字节复现 |

覆盖表（四条新招式**出现 / 执行**都非 0，而且这一批**任何牌组都能满足**——见下）：

| 怪   | 招式                        | 出现 | 执行 |
| ---- | --------------------------- | ---- | ---- |
| DECA | `DECA_BEAM`                 | 非 0 | 非 0 |
| DECA | `DECA_SQUARE_OF_PROTECTION` | 非 0 | 非 0 |
| DONU | `DONU_BEAM`                 | 非 0 | 非 0 |
| DONU | `DONU_CIRCLE_OF_POWER`      | 非 0 | 非 0 |

#### ⚠⚠ 牌组不是常量（第三次）：但这一次要量的不是「招式执行没有」

第三十七 / 三十八批换牌组是因为**招式结构性执行不到**。这一批不是：两只怪的
`getMoveForRoll` 各返回一个**常量**，四条 case 的收尾又全是**同步 `setMove`**，
所以**第二个怪物回合四条招式就全走过了**——22 张标准牌组下四条的意图帧是
1637 / 1041 / 973 / 1705，`--install` 根本不会拒绝。

**真正要量的是「迪卡会不会先死」**——那是「无门的友军增益」唯一的可观察面。
七副候选，同样 40 种子 × 3 层 = 120 条：

| 牌组                                    | 均回合   | 胜     | 迪卡死过     | 死迪卡的力量又涨了的帧 |
| --------------------------------------- | -------- | ------ | ------------ | ---------------------- |
| `BATCH_1 + SPOT_WEAKNESS`（22，未升级） | 4.67     | 0      | **0 / 120**  | **0**                  |
| 第三十七批那副（45，全升级）            | 6.88     | 9      | 22 / 120     | 20                     |
| **第三十八批那副（59，全升级）← 选它**  | **7.44** | **32** | **56 / 120** | **58**                 |
| 单体伤害向自制（53，全升级）            | 7.17     | 7      | 43 / 120     | 35                     |
| 第三十八批 + 4 重刃 + 2 铜头（65）      | 7.52     | 23     | 44 / 120     | 53                     |
| 第三十八批 − 浩劫/二连击 + 4 重刃（57） | 6.87     | 14     | 35 / 120     | 28                     |
| 第三十八批 + 4 幽灵护甲 + 4 铜头（67）  | 8.83     | 13     | 37 / 120     | 34                     |

⚠ 两条结论：① 22 张标准牌组在这里**不是薄，是零**——500 血的一对 Boss 每两回合各加 16 格挡、
还互相 +3 力量，那副牌组一次都打不死迪卡；② **往第三十八批那副里加牌只会更差**：每多一张
就稀释一次抽牌，两副「更耐打」的候选是拿迪卡的死换回合数。所以**逐字节复用**它。

⚠ 安装之后在**已提交的那份文件**上重量（这才是权威数字）：均 **7.53** 回合、
胜 **33** / 负 **87**、迪卡死过 **60 / 120**、多努死过 **33 / 120**（**全部**发生在迪卡已死之后）、
「多努死而迪卡还活着」**0 / 120**、死迪卡的力量又涨了 **52 帧**、
`rng.ai` 计数器取值集合 = **{2}**、神器被消耗 **104 / 120**、恍惚躺在弃牌堆的帧 **4367**、
一场仗见过的最大力量 **18**。

#### 变异测试（31546 例基线，括号内为失败例数；本编队上限 **120**）

⚠ 标「[本编队]」的那几条走的是 `-t DONU_AND_DECA` 的**增量**口径：它们改的是**共享原语**
（`buff_ally` / `gain_block_ally_fixed` 的实现），全库口径会把第二十六 / 二十八批那些宿主
一起算进来，那不是本批的增量证据。两个数都列出来。

| 变异                                              | 例数                     | 判读                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **多努的能量之环补上 `monstersAlive > 1` 那道门** | **45**                   | ⚠⚠ **本批最要紧的一条**。参考侧做同样的改动一定会变（它那句就是没有门，还自注了原因），我们这边也没有多写任何东西 → 是真背书。走到它的局面：迪卡死了 60 次，其中 45 次之后多努还活着并至少再放过一次能量之环 |
| 迪卡的守护方阵补上那道门                          | **0**                    | **盲区（分母为 0）**，见下方盲区表。「多努死而迪卡还活着」**0 / 120**——策略恒打 0 号位                                                                                                                       |
| 守护方阵去掉「自己也加 16」                       | **120**                  | = 整份文件                                                                                                                                                                                                   |
| 守护方阵去掉「给多努也加 16」                     | **120**                  | 旧近似表漏的正是这半条                                                                                                                                                                                       |
| 守护方阵格挡 16 → 15                              | **120**                  |                                                                                                                                                                                                              |
| 守护方阵的自身格挡 `sync` 去掉（改成入队）        | **0**                    | **等价改写**（第二十六批那条判据）：这条 case **一个队列动作都没排**，入队之后队列里就它一条、立刻出队                                                                                                       |
| 守护方阵两句顺序对调（先给多努再给自己）          | **0**                    | **等价改写**：两句写的是**两个不同对象**的 `block +=`，互不相干                                                                                                                                              |
| 迪卡光束去掉那两张恍惚                            | **120**                  |                                                                                                                                                                                                              |
| 恍惚 2 张 → 1 张                                  | **120**                  |                                                                                                                                                                                                              |
| 恍惚去弃牌堆 → 抽牌堆                             | **120**                  | 后者每张多掷一次 `cardRandomRng`，`rng.cardRandom` 当场对不上                                                                                                                                                |
| 恍惚那条排到伤害之前                              | **41**                   | ⚠ 例数只有三分之一：只有「这一击把玩家的牌堆/血量状态改了」的那些帧才分岔                                                                                                                                    |
| 光束每击 10 → 12（asc4 那档的值）                 | **118**                  |                                                                                                                                                                                                              |
| 光束段数 2 → 1                                    | **118**                  |                                                                                                                                                                                                              |
| 光束的 asc 阈值 4 → 0（让 asc0 也走高档）         | **118**                  | 低侧钉死                                                                                                                                                                                                     |
| 光束**去掉** asc4 分档                            | **0**                    | **结构性盲区**：本批只做 asc0                                                                                                                                                                                |
| 多努的能量之环力量 3 → 2                          | **120**                  |                                                                                                                                                                                                              |
| 能量之环去掉「自己也 +3」                         | 120[本编队] / 513[全库]  | 全库那 393 例是秘法师的鼓舞，第二十六批已量过                                                                                                                                                                |
| 能量之环的友军下标 0 → 1（等于给自己两份）        | 120[本编队] / 407[全库]  |                                                                                                                                                                                                              |
| 守护方阵的友军下标 1 → 0（等于给自己两份）        | 120[本编队] / 1192[全库] | 全库那 1072 例是百夫长的防守与青铜球的支援光束                                                                                                                                                               |
| **出招规则：迪卡开局出守护而不是光束**            | **120**                  | 两只返回的是**不同的常量**，抄成同一个第一个怪物回合就错                                                                                                                                                     |
| **出招规则：多努开局出光束而不是能量之环**        | **120**                  |                                                                                                                                                                                                              |
| 收尾：迪卡光束改成 `no_op_roll`                   | **120**                  | 多掷一次 aiRng，`rng.ai` 从恒 2 变成逐回合涨                                                                                                                                                                 |
| 收尾：迪卡光束改成默认的入队 `RollMove`           | **120**                  |                                                                                                                                                                                                              |
| 收尾：多努能量之环改成 `no_op_roll`               | **120**                  |                                                                                                                                                                                                              |
| preBattle：神器 2 → 3（asc19 那档）               | **120**                  |                                                                                                                                                                                                              |
| preBattle：只有迪卡有神器                         | **120**                  | 「两个 case 标签共用一个函数体」这件事有背书                                                                                                                                                                 |
| 血量 250 → 265（asc9 那档）                       | **120**                  |                                                                                                                                                                                                              |
| **建怪顺序反过来（先多努后迪卡）**                | **120**                  | ⚠ 这是本批最容易照着编队名写反的一处                                                                                                                                                                         |

`isMoveAttack` 白名单，**两个增量方向逐条拆开**（口径同上，`-t DONU_AND_DECA`）：

| 变异                             | 例数    |
| -------------------------------- | ------- |
| 漏掉 `DECA_BEAM`                 | **100** |
| 漏掉 `DONU_BEAM`                 | **20**  |
| 两条一起漏掉                     | **100** |
| 多收 `DECA_SQUARE_OF_PROTECTION` | **82**  |
| 多收 `DONU_CIRCLE_OF_POWER`      | **14**  |

⚠ 合计（100）比逐条之和小，因为同一条 trace 会被两条同时命中——**这正是「别只给合计」那条
教训的又一个实例**。⚠ 两条光束的例数差 5 倍（100 vs 20）也值得记：觅敌之弱打的是
`firstAliveMonster` = 0 号位的**迪卡**，只有迪卡死了之后那道谓词才会去问多努。
恒真那个方向是全库数字：**2929 例**（第三十八批是 2838，增量 91）。

### 第三十八批：第三幕 Boss 时间吞噬者（TIME_WARP / 出牌中途结束回合）

#### 数据规格与体积

| 项        | 值                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| harness   | 第四个乘积 `act3Variants` 里追加的 **variant 38**（variant 37 的 encounters 一个字没动）                          |
| 牌组      | ⚠⚠ **第二次为「让新代码被走到」而设计**：59 张、**全升级**，见下方对比表                                          |
| 种子 / 层 | 40 / `{1,3,7}`                                                                                                    |
| 爬升度    | **0**；目标策略 **0**                                                                                             |
| 编队      | `time_eater`（⚠ **单怪**，`MonsterGroup.cpp:441-443` 一句 `createMonster`）                                       |
| 例数      | 120，对拍 31306 → **31426**                                                                                       |
| 体积      | **6.5MB**，仓库 608MB → **614MB**，文件数 114 → **115**                                                           |
| 扰动      | `git status -- test/golden/traces` 恰好 **1 个 `??`、零个 `M`**——没有任何已冻结文件变，`ALLOW_CHANGED` 一次都没用 |

覆盖表（四条新招式**出现 / 执行**都非 0）：

| 招式                     | 出现 | 执行 | 招式                   | 出现 | 执行 |
| ------------------------ | ---: | ---: | ---------------------- | ---: | ---: |
| `TIME_EATER_REVERBERATE` | 2323 |  287 | `TIME_EATER_HEAD_SLAM` | 1515 |  180 |
| `TIME_EATER_RIPPLE`      | 1058 |  135 | `TIME_EATER_HASTE`     |  222 |   31 |

#### ⚠⚠ 牌组不是常量（第二次）：先量再定

第三十七批第一次为覆盖换牌组，本批第二次——而且这一次**两个方向都要量**：TIME_WARP 数的是
**出牌张数**（与伤害无关），HASTE 的门却是**血量掉到一半**（纯伤害）。同样 40 种子 × 3 层
= 120 条：

| 牌组                               | 平均回合 | TIME_WARP 触发 | 掉到半血  | HASTE 出现 / 执行 |
| ---------------------------------- | -------- | -------------- | --------- | ----------------- |
| `BATCH_1 + SPOT_WEAKNESS`（22 张） | 4.89     | **122**        | **1/120** | **0 / 0**         |
| 第三十七批那副（45 张·全升级）     | 7.70     | 240            | 66/120    | 154 / 25          |
| + 4 钢铁闪光 + 4 灵巧（53 张）     | 7.82     | 312            | 71/120    | 242 / 35          |
| **本批（59 张·全升级）**           | 7.28     | **333**        | 70/120    | **196 / 24**      |

⚠⚠ **22 张那一行是「假的非 0」的镜像：TIME_WARP 明明触发了 122 次，HASTE 却结构性没有预言机。**
如果只看「新机制被走到没有」就会以为够用——真正卡住整批的是那条**血量阈值**的招式。
**判据：一只怪有几条互相独立的门（出牌数 / 血量 / 回合数），就要各量一条。**

⚠ 牌组形状的两条约束沿用第三十七批（都是策略决定的，不是凭强度挑的）：
① `pickAction` 严格从左往右花能量 ⇒ 加的牌一律 0~2 费；② `upgradeAll` 是最便宜的强化。
本批在此之上加了两类**专为新代码**的牌：

1. **0 费轮转牌**（钢铁闪光 / 灵巧各补到 6 张）。TIME_WARP 数的是出牌张数，所以
   「每回合能打几张」才是那个旋钮，而这两张都**打完再抽一张**。触发数 240 → 330 上下，
   「出牌中途结束的回合」从 201 涨到 **284**。
2. ⚠⚠ **浩劫 ×4 与二连击 ×2**。它们是**全项目仅有的两种「`onAfterUseCard` 跑的时候出牌
   队列还非空」的产出者**：浩劫塞 `autoplay` 项（`playTopCardInDrawPile`，`:2555-2559`）、
   二连击塞 `purgeOnUse && autoplay` 项（`queuePurgeCard`，`:2792-2801`）。
   **没有它们，`callEndTurnEarlySequence` 的整段排空循环不可达**（实测：本批语料里
   「第 12 张牌恰好是浩劫」发生 **41 次 / 23 条 trace**）。

#### 先量局面，再量变异

| 事实                             | 数值                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| 结局                             | 胜 **24** / 负 **96**（战斗均长 **7.18 回合**）                                    |
| TIME_WARP 触发总数               | **329**（按每场终局的 `STRENGTH / 2` 数），逐场分布 1×2 / 2×48 / 3×52 / 4×15 / 5×3 |
| **出牌中途被强制结束的玩家回合** | **284** 次（= 打牌那一步之后 `turn` 涨了）——这是 `callEndTurnEarlySequence` 的分母 |
| 其中「那第 12 张牌恰好是浩劫」   | **41** 次（分布在 **23 条** trace 上）——这是排空循环 `autoplay` 那一半的分母       |
| 时间吞噬者掉到半血（= 加速的门） | **68 / 120**                                                                       |
| 玩家身上挂着抽牌削减的帧         | 1009 帧 / **113 条** trace                                                         |

#### 变异测试（括号内为失败例数；本编队上限 **120**）

**① 时间扭曲的结算（`onAfterUseCard`，共享出牌路径）**

| 改坏的地方                                          |    例数 | 说明                                                              |
| --------------------------------------------------- | ------: | ----------------------------------------------------------------- |
| 阈值 `== 11` → `== 10`（第 11 张就触发）            | **120** |                                                                   |
| 阈值 `== 11` → `== 12`                              | **120** |                                                                   |
| 阈值 `== 11` → `>= 11`                              |   **0** | ⚠ **结构性等价**，不是盲区：计数只由这段代码自己写，永远越不过 11 |
| 归零改成整条摘掉（`setStatus(0)` → `removeStatus`） | **120** | ⚠ 这是「`setStatus` 只写数值、不碰 bit」的直接背书                |
| 计数不自增（else 分支空）                           | **120** |                                                                   |
| 照抄那句死代码 `++timeWarp`（自增两次）             | **120** | ⚠ 这是「那一句是死代码」的直接背书                                |
| 不加那 2 点力量 / 力量 2 → 3                        | **120** |                                                                   |
| 不调 `callEndTurnEarlySequence`                     | **120** |                                                                   |
| 门写成「层数 > 0」而不是 `hasStatus`                | **120** | ⚠ 与巨头缓慢那条同族（开局层数就是 0）                            |
| 这道门无视 `triggerOnUse`                           |  **23** | ⚠ 被丢回来的牌**不再**推进计数器——分母正是「浩劫」那 23 条        |
| 读 `arr[0]` 改成读「第一只活怪」                    |   **0** | **探针无效（结构性）**：单怪编队                                  |
| 时间扭曲块与缓慢块对调                              |   **0** | **探针无效（结构性）**：没有一只怪同时带两者                      |

**② `callEndTurnEarlySequence`**

| 改坏的地方                                        |    例数 | 说明                                                                    |
| ------------------------------------------------- | ------: | ----------------------------------------------------------------------- |
| 整段排空循环去掉（出牌队列原样留着）              |  **26** | = 浩劫那 23 条 + 二连击复制项那 3 条                                    |
| 过滤收紧：`autoplay` 项也直接丢弃（不排那条动作） |  **23** | 那张牌会凭空消失而不是进弃牌堆                                          |
| 丢回来的牌按 `triggerOnUse = true` 结算           |  **23** | 与①最后那条同源                                                         |
| 过滤放宽：**复制项**也走那条动作                  |   **0** | ⚠⚠ **参考侧同解**（见下方「一处假的非 0」），记成**等价改写**而不是盲区 |
| 过滤放宽：**非 autoplay** 的项也走那条动作        |   **0** | **盲区（分母为 0）**：那一刻队列里不可能有非 autoplay 的项              |
| endTurn 项推**队尾**而不是队首                    |   **0** | **结构性等价**：上面那个 `while` 刚把队列抽空了                         |
| 不置 `endTurnQueued`                              | **120** |                                                                         |
| 丢回来的动作 `clearOnCombatVictory` 改成 true     |   **0** | 盲区（分母为 0）                                                        |
| `exhaustOnUse` 不再或上「当前那张牌 doesExhaust」 |   **0** | ⚠ **被短路吃掉**（见盲区表），与带壳寄生虫 `roll2` 同族                 |
| `exhaustOnUse` 读**自己**那张牌而不是前一张       |   **0** | 同上                                                                    |

**③ 抽牌削减（DRAW_REDUCTION）**

| 改坏的地方                               |    例数 | 说明                                           |
| ---------------------------------------- | ------: | ---------------------------------------------- |
| 不减 `cardDrawPerTurn`（只留 bool 标记） | **113** | ⚠ 这是「数值住在 `cardDrawPerTurn`」的直接背书 |
| 减 2 而不是 1                            | **113** | ⚠ 这是「参考忽略 amount 实参」那一位的背书     |
| 不置 `justApplied`（当回合就归还）       | **113** |                                                |
| 归还提到「入队抽牌」**之前**             | **113** | ⚠ 位置的直接背书：那样削减一次都生效不了       |
| 整段 skipFirst 归还去掉（永久削减）      | **109** |                                                |
| 归还时不摘条目（只加回抽牌数）           | **109** |                                                |
| 抽牌张数改成**执行时**取                 | **109** | ⚠ 与「入队时取」那条老规矩同源                 |

**④ 出招规则（`getMoveForRoll`，四段）**

| 改坏的地方                               |    例数 | 说明                                          |
| ---------------------------------------- | ------: | --------------------------------------------- |
| 加速门去掉 `!usedHaste`（可反复加速）    |  **34** |                                               |
| 加速门整条去掉                           |  **53** |                                               |
| 加速门挪到出招链**最后**                 |  **53** | 位置的直接背书                                |
| 半血判定 `<` → `<=`                      |   **1** | ⚠ **薄到极点但非 0**：要 `curHp` 恰好等于 228 |
| 半血判定用浮点除（不截断）               |   **0** | **结构性等价**：456 是偶数                    |
| 第一段分界 45 → 50                       |  **36** |                                               |
| 第一段谓词 `lastTwoMoves` → `lastMove`   |  **92** |                                               |
| 重掷区间 `random(50,99)` → `random(99)`  |  **12** |                                               |
| 重掷那一次干脆不掷                       |  **38** | `rng.ai` 计数器当场对不上                     |
| 第二段分界 80 → 75 / → 85                | 52 / 47 |                                               |
| 第二段谓词 `lastMove` → `lastTwoMoves`   |  **58** | ⚠ 同一只怪身上两种谓词并存（与觉醒者同族）    |
| `randomBoolean(0.66f)` 两支对调          |  **58** | ⚠ true 那一支是**混响**                       |
| `randomBoolean` 概率 0.66 → 0.5          |   **9** |                                               |
| 第三段 `random(74)` → `random(99)`       |  **12** | ⚠ 单参重载 = 闭区间 `[0,74]`                  |
| 第三段 `random(74)` → `random(50,99)`    |  **19** |                                               |
| 第三段分界 45 → 50                       |   **2** | 薄                                            |
| 第三段两个返回值对调                     |  **27** |                                               |
| 第三段 `lastMove(涟漪)` 门去掉（恒重掷） | **106** |                                               |

**⑤ 招式效果与收尾**

| 改坏的地方                                      |    例数 | 说明                                                              |
| ----------------------------------------------- | ------: | ----------------------------------------------------------------- |
| 混响每击 7 → 8（抄成 asc4 档）                  | **118** |                                                                   |
| 混响段数 3 → 2                                  | **118** |                                                                   |
| 头槌 26 → 32（抄成 asc4 档）                    | **103** |                                                                   |
| 头槌不上抽牌削减                                | **114** |                                                                   |
| 头槌的抽牌削减改成**同步**                      |  **27** | ⚠ 入队那条在「这一击打死玩家」时永远轮不到——与工头抽打那 5 例同族 |
| 涟漪格挡 20 → 15                                | **109** |                                                                   |
| 涟漪格挡 / 两条减益改成**入队**                 |   **0** | **等价改写**（这条 case 一个队列动作都没排，判据见第二十六批）    |
| 加速不置 `miscInfo`                             |  **34** |                                                                   |
| 加速不抬血                                      |  **50** |                                                                   |
| 加速抬血改成**满血**                            |  **50** |                                                                   |
| 加速抬血改成 `heal` 语义（加 `maxHp/2` 点）     |  **50** | ⚠ 「赋值不是 heal」这一位的背书                                   |
| 加速不清减益                                    |  **11** |                                                                   |
| 加速四条效果的顺序（清减益提到抬血之前）        |   **0** | 等价改写（`removeDebuffs` 不碰血量）                              |
| 涟漪收尾：同步真 rollMove → 入队 `RollMove`     |   **0** | **等价改写**（同上）                                              |
| 涟漪收尾：同步真 rollMove → 同步 `noOpRollMove` | **109** | ⚠ 「第六形态是**真** rollMove」的背书                             |
| 加速收尾：同步真 rollMove → 入队 `RollMove`     |   **0** | 等价改写                                                          |
| 加速收尾：同步真 rollMove → 同步 `noOpRollMove` |  **50** |                                                                   |
| 混响 / 头槌的收尾改成**同步**真 rollMove        |  **96** | ⚠ 反方向：那两条 case **排了队列动作**，所以不是等价改写          |
| asc19 那条 32 格挡去掉 `minAscension`           |  **50** | ⚠ `minAscension` 铺到 `gain_block` 的背书                         |
| 头槌 asc19 两张黏液去掉 `minAscension`          | **114** | ⚠ `minAscension` 铺到 `add_card` 的背书                           |

**⑥ 建怪与开局**

| 改坏的地方                     |    例数 | 说明                      |
| ------------------------------ | ------: | ------------------------- |
| 开局不上 TIME_WARP             | **120** | ⚠ 快照 + 行为**两者之和** |
| 开局 TIME_WARP 层数 0 → 1      | **120** |                           |
| 血量上界 456 → 480（抄成高档） | **115** |                           |
| 写成 `hpNoRoll`（不掷血量）    | **120** |                           |

**⑦ `isMonsterAttacking` 白名单（两个增量方向，逐条拆开）**

| 改坏的地方            |    例数 |     | 改坏的地方            |     例数 |
| --------------------- | ------: | --- | --------------------- | -------: |
| 漏掉 `混响`           |  **80** |     | 漏掉 `头槌`           |   **59** |
| 两条一起漏掉          | **108** |     | 多收 `涟漪`（非攻击） |   **49** |
| 多收 `加速`（非攻击） |   **7** |     | 谓词恒真（**全库**）  | **2838** |

⚠ 「两条一起漏掉」的 108 小于逐条之和（139），同一条 trace 会被多条同时命中——
**合计数永远不能代替逐条**（第三十五~三十七批的教训，本批照办）。

#### 三条给下一个人的结论

1. ⚠⚠ **本批撞上「假的非 0」的第三种形状：变异改的是我们自己多写的一个常量。**
   第一版把排空循环里那条动作的 `purgeOnUse` **写死成 `false`**（as-built 等价，因为过滤
   已经把复制项挡在外面）。于是「把过滤放宽、让复制项也走那条动作」量出 **3 例**——
   看着像「`!item.purgeOnUse` 那一半有背书」，其实不是：参考那条动作对复制项是
   **严格空操作**（`TimeEaterPlayCardQueueItem` 整项拷贝 → `purgeOnUse` 仍为真 →
   `onAfterUseCard` 顶部 `if (item.purgeOnUse) return;` 当场返回）。
   **改成原样透传之后重量：0 例**，同时「写死 false ↔ 透传」本身也是 **0 例**（as-built 等价）。
   ⚠ **判据（补一条）：变异之前先问「我这一处比参考多写了什么」**——多写的常量会把
   「参考的空操作」变成「我们的可观察行为」，而那 3 例量的正是后者。
2. ⚠⚠ **一只怪的几道门要各量一条分母，别拿「新机制被走到了」当整批的通行证。**
   22 张牌组下 TIME_WARP 已经触发了 122 次（机制本身有背书），可 HASTE 的门是**血量**、
   120 条一次都没到过半血 —— `--install` 直接拒绝。**先把每条门的分母列出来再挑牌组。**
3. ⚠ **「参考的过滤条件冗余」不是 bug，别报补丁。** `item.autoplay && !item.purgeOnUse`
   里的后一半与 `onAfterUseCard` 顶部那句 `if (item.purgeOnUse) return;` 重复，去掉它
   两边同解（0 例）。这与第三十六批 `skipTurn` 那个「被外层条件挤死的内层 if」同族：
   **矛盾看得见、但与 as-built 严格同解 → 照抄，不报补丁、记成等价改写。**

### 第三十七批：第三幕 Boss 觉醒者（两阶段假死 / 好奇心 / 怪物侧再生）

#### 数据规格与体积

| 项        | 值                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| harness   | 第四个乘积 `act3Variants` 里追加的 **variant 37**（variant 36 的 encounters 一个字没动）                                                                                  |
| 牌组      | ⚠⚠ **第一次不是 `BATCH_1 + SPOT_WEAKNESS`**：45 张、**全升级**的聚焦牌组，理由见「牌组不是常量」                                                                          |
| 种子 / 层 | 40 / `{1,3,7}`                                                                                                                                                            |
| 爬升度    | **0**；目标策略 **0**                                                                                                                                                     |
| 编队      | `awakened_one`（⚠ 三只怪：邪教徒 ×2 + 觉醒者，觉醒者在 **2 号位**）                                                                                                       |
| 例数      | 120，对拍 31186 → **31306**                                                                                                                                               |
| 体积      | **7.4MB**，仓库 600MB → **608MB**，文件数 113 → **114**                                                                                                                   |
| 扰动      | `git status` 恰好是 **1 个 `??`（`awakened_one.jsonl`）+ 4 个源码 `M` + 1 个 `tools/regen-traces.sh` `M`**——**没有任何已冻结的 trace 文件变**，`ALLOW_CHANGED` 一次都没用 |

覆盖表（六条新招式**出现 / 执行**都非 0）：

| 招式                   | 出现 | 执行 | 招式                       | 出现 | 执行 |
| ---------------------- | ---: | ---: | -------------------------- | ---: | ---: |
| `AWAKENED_ONE_SLASH`   | 3738 |  685 | `AWAKENED_ONE_SOUL_STRIKE` | 1556 |  330 |
| `AWAKENED_ONE_REBIRTH` |   86 |   46 | `AWAKENED_ONE_DARK_ECHO`   |  242 |   43 |
| `AWAKENED_ONE_SLUDGE`  |   90 |   16 | `AWAKENED_ONE_TACKLE`      |  102 |   12 |

#### 先量局面，再量变异

| 事实                         | 数值                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 结局                         | 胜 **14** / 负 **106**（战斗均长 **8.7 回合**）                                                                                                   |
| **一阶段被打死（进入假死）** | **46 / 120** —— 这就是本批全部「46 例」变异的分母                                                                                                 |
| ⚠⚠ 假死是被什么打进去的      | **44 条是玩家出牌那一步、2 条是 `end_turn` 那一步**。后者两条都带**青铜鳞片**——荆棘（`addToTop`）插在觉醒者自己那条入队的 `RollMove` 之前把它打死 |
| 「二阶段活过黑暗回响」的步数 | 43 条执行了黑暗回响，其后只剩 **28 步**（污泥 16 + 冲撞 12）——`SLUDGE` / `TACKLE` 的分母薄就薄在这里                                              |
| 胜利时场上还有活怪的次数     | **0 / 14** —— `MINION_LEADER` 那条判胜路径在这个编队上一次都没走到（见盲区表）                                                                    |

#### 变异测试（括号内为失败例数；对拍基线 31306）

**① `Monster::die` 的第一个分支（假死）**

| 改坏的地方                                |   例数 | 说明                                                                                           |
| ----------------------------------------- | -----: | ---------------------------------------------------------------------------------------------- |
| 整条去掉（不假死，直接走判胜链）          | **46** | = 全部走到假死的 trace                                                                         |
| **挪到判胜 `monstersAlive == 0` 之后**    | **46** | ⚠ 这是「位置」的探针。数字与上一条相同说明 46 条里**每一条**都是「觉醒者死时场上已无别的活怪」 |
| 去掉 `miscInfo == 0` 那一半门             | **14** | 二阶段死掉时会**再假死一次**                                                                   |
| 去掉 `halfDead = true`                    | **46** |                                                                                                |
| 去掉 `removeDebuffs()`                    |  **8** | 薄——要玩家在假死之前恰好挂着虚弱 / 易伤                                                        |
| 去掉 `removeStatus<CURIOSITY>()`          | **46** |                                                                                                |
| `setMove` → `overwriteMove`（不前移历史） |  **0** | ⚠ **结构性等价**，见盲区表                                                                     |
| 去掉 `bc.cardQueue.clear()`               |  **0** | 盲区（分母为 0），见盲区表                                                                     |

**② 复活那条 case（`awakened_rebirth`）**

| 改坏的地方                                |   例数 | 说明                                                         |
| ----------------------------------------- | -----: | ------------------------------------------------------------ |
| `curHp = maxHp` → `maxHp / 2`（抄暗影客） | **46** |                                                              |
| `asc9 ? 320 : 300` 抄反（asc0 取 320）    | **46** | ⚠ 只钉住**低侧**；高侧（asc9 的 320）是盲区                  |
| 去掉 `miscInfo = true`                    | **24** | 二阶段会走一阶段的出招规则、而且第二次死还会再假死           |
| 去掉 `strength = max(0, strength)`        |  **0** | 盲区，见盲区表                                               |
| 去掉 `++monstersAlive`                    |  **9** | 薄但非 0                                                     |
| 去掉 `buff<MINION_LEADER>()`              | **46** | ⚠⚠ 量的是**快照里的 power 条目**，不是判胜路径——两件事分开记 |
| 不置 `alive = true`                       | **46** |                                                              |

**③ 重生的收尾（`MOVE_TURN_END`）**

| 改坏的地方                   |   例数 | 说明                                     |
| ---------------------------- | -----: | ---------------------------------------- |
| 去掉 `setMove(DARK_ECHO)`    | **46** |                                          |
| 去掉那次 `noOpRollMove` 掷骰 | **46** | `rng.ai` 计数器当场对不上                |
| 改成**真** `rollMove`        | **46** |                                          |
| 两句顺序调换                 |  **0** | 等价改写（noOp 不读意图）                |
| noOp 改成**入队**            |  **0** | 等价改写（这条 case 一个队列动作都没排） |

**④ 出招规则（`getMoveForRoll`）**

| 改坏的地方                                          |    例数 | 说明                                                                                    |
| --------------------------------------------------- | ------: | --------------------------------------------------------------------------------------- |
| ⚠⚠ 去掉 `if (halfDead) return REBIRTH`              |   **2** | **原以为是死代码，实测不是**——那 2 条正是「死在怪物阶段」的青铜鳞片局面（见上方局面表） |
| 一阶段 `roll < 25` 那档 `lastMove` → `lastTwoMoves` |  **55** |                                                                                         |
| 一阶段第二档 `lastTwoMoves` → `lastMove`            | **120** | = 整份文件                                                                              |
| 一阶段分界 25 → 50                                  |  **75** |                                                                                         |
| 去掉 `firstTurn()` 那一支                           |  **32** |                                                                                         |
| `phase2` 恒 false                                   |  **21** |                                                                                         |
| 二阶段分界 50 → 25                                  |  **10** |                                                                                         |
| 二阶段两档**互换**                                  |  **21** |                                                                                         |
| 二阶段污泥档 `lastTwoMoves` → `lastMove`            |   **3** | 薄                                                                                      |
| 二阶段冲撞档 `lastTwoMoves` → `lastMove`            |   **5** | 薄                                                                                      |

**⑤ 两个新 Power 与共享路径**

| 改坏的地方                                       |    例数 | 说明                                                                  |
| ------------------------------------------------ | ------: | --------------------------------------------------------------------- |
| `preBattleAction` 去掉 CURIOSITY                 | **120** |                                                                       |
| `preBattleAction` 的 REGEN 10 ↔ 15 抄反          | **120** |                                                                       |
| 开局 +2 力量的 `asc >= 4` 门去掉（无条件加）     | **120** |                                                                       |
| 回合末**整条**去掉再生结算                       | **118** |                                                                       |
| 给再生**补一个递减**（照抄玩家侧那条）           | **120** | ⚠ 这是「怪物侧再生一层不掉」的直接背书                                |
| 再生挪到枷锁**之后**                             |   **0** | 等价改写（没有一只怪同时带两者）                                      |
| `monsterHeal` 去掉 `min(maxHp, …)` 封顶          | **748** | ⚠ 这是**共享原语**（吸血 / 秘法师治疗也走它），所以数字远大于本批文件 |
| ⚠⚠ 恢复 `afterMonsterTurns` 里那句「怪全灭判胜」 |   **2** | 参考里没有这一句，见上方说明                                          |

**⑥ 虚无（VOID）**

| 改坏的地方                      |   例数 | 说明                                 |
| ------------------------------- | -----: | ------------------------------------ |
| 去掉「抽到虚无 -1 能量」        |  **6** |                                      |
| 去掉那句 `max(0, …)` 下限       |  **0** | 盲区（分母为 0）                     |
| 那句改成**入队**                |  **0** | 盲区（分母不够），⚠ **不是等价改写** |
| 污泥塞牌去向 `draw` → `discard` | **11** |                                      |
| 污泥整条不塞牌                  | **11** |                                      |
| 塞牌与伤害的**顺序**调换        |  **4** | 薄但非 0                             |

**⑦ `isMonsterAttacking` 白名单（两个增量方向，逐条拆开）**

| 改坏的地方                   |   例数 |     | 改坏的地方         |   例数 |
| ---------------------------- | -----: | --- | ------------------ | -----: |
| 漏掉 `aw_slash`              | **66** |     | 漏掉 `soul_strike` | **48** |
| 漏掉 `dark_echo`             | **16** |     | 漏掉 `sludge`      |  **8** |
| 漏掉 `aw_tackle`             |  **4** |     | 五条一起漏掉       | **90** |
| **多收 `rebirth`**（非攻击） |  **0** |     | —                  |      — |

⚠ 「五条一起漏掉」的 90 小于逐条之和（142），因为同一条 trace 会被多条同时命中——
**合计数永远不能代替逐条**（第三十五 / 三十六批的教训，本批照办）。
⚠ 「多收 `rebirth`」那个 **0** 是**探针无效**而不是盲区：意图为重生的觉醒者 `alive` 恒为假，
而觅敌之弱打的是 `firstAliveMonster`（全死时兜底回 0 号位）——那道谓词**永远不会拿重生去问**。

#### 三条给下一个人的结论

1. ⚠⚠ **「参考里没有别的调用点」不能推出「这一支是死代码」。** 出招规则里
   `if (halfDead) return REBIRTH` 那一支，按静态阅读怎么看都用不上（`die` 已经 `setMove` 过、
   收尾又是 `noOpRollMove`），我在注释里写了「死代码但照抄」——**变异测试当场打脸，2 例**。
   走到它的是「觉醒者死在怪物阶段」：它自己攻击排的 `addToBot(RollMove)` 排在伤害之后，
   而青铜鳞片的荆棘是 `addToTop` 的。**机理与第二十六批的 `CENTURION_FURY` 一模一样**，
   而我在写注释时没有想起那一条。**判据：凡是「怪物自己排的 RollMove」，都要先问一句
   「这只怪会不会在它出队之前死掉」——遗物轮换里有青铜鳞片，答案往往是会。**
2. ⚠⚠ **`--install` 报「出现 0 / 执行 0」时，第一件事是量战斗长度，不是找逃生口。**
   本批一开始按惯例用 `BATCH_1 + SPOT_WEAKNESS`，四条招式全 0；量出来「平均 3.6 回合、
   120 条一次都没打死过一阶段」之后，方向就很清楚了。**先量再改**，否则很容易去动
   编队 / 目标策略这些其实不相干的轴。
3. ⚠ **「去掉某个 Power 红了很多例」不等于「那个 Power 的每一处语义都有背书」。**
   去掉觉醒者复活时的 `buff<MINION_LEADER>()` 红 46 例——但那 46 例**全部**来自快照里
   多/少一个 power 条目；它真正的语义（首领一死当场判胜）在这个编队上**一次都没走到**
   （14 次胜利全是「场上一只活怪都不剩」）。**两件事必须分开记**，与第二十七批
   `MINION_LEADER` 那条 4 例的教训同源。

### 第三十六批：第三幕两个精英（复仇魔 / 蜥蜴法师 + 匕首）

#### 数据规格与体积

| 项        | 值                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| harness   | 第四个乘积 `act3Variants` 里追加的 **variant 36**（variant 35 的 encounters 一个字没动）                                                                                                                                                                                           |
| 牌组      | `BATCH_1 + SPOT_WEAKNESS`（与 variant 24~35 逐字节相同）                                                                                                                                                                                                                           |
| 种子 / 层 | 40 / `{1,3,7}`                                                                                                                                                                                                                                                                     |
| 爬升度    | **0**；目标策略 **0**                                                                                                                                                                                                                                                              |
| 编队      | `nemesis` / `reptomancer`                                                                                                                                                                                                                                                          |
| 例数      | 240（2 × 120），对拍 30946 → **31186**                                                                                                                                                                                                                                             |
| 体积      | **6.0MB**（3.0 + 3.1MB），仓库 595MB → **600MB**，文件数 111 → **113**                                                                                                                                                                                                             |
| 扰动      | ⚠ **1 个 `M`（`writhing_mass.jsonl`）+ 2 个 `??`**——那个 `M` 是本批给参考打的萎缩白名单补丁引起的，走 `ALLOW_CHANGED="writhing_mass"` 放行；`git diff --stat` 是 **24 insertions / 24 deletions**（一行 = 一条 trace），与第三十五批量到的 **24 例**一字不差。**没有别的文件变。** |

覆盖表（八条新招式**出现 / 执行**都非 0）：

| 招式                       | 出现 | 执行 | 招式                   | 出现 | 执行 |
| -------------------------- | ---: | ---: | ---------------------- | ---: | ---: |
| `NEMESIS_ATTACK`           | 1812 |  390 | `NEMESIS_DEBUFF`       | 1331 |  274 |
| `NEMESIS_SCYTHE`           |  888 |  196 | `REPTOMANCER_SUMMON`   | 1529 |  265 |
| `REPTOMANCER_SNAKE_STRIKE` |  602 |  138 | `REPTOMANCER_BIG_BITE` |  509 |  115 |
| `DAGGER_STAB`              | 3205 |  331 | `DAGGER_EXPLODE`       | 2525 |  204 |

#### 先量局面，再量变异

| 事实                                        | 数值                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 复仇魔的结局                                | 胜 **4** / 负 **116**（战斗 3~11 回合，均值 6.2；4031 帧）                                                                                                            |
| `INTANGIBLE` 出现的帧数 / **峰值**          | **1668 帧 / 峰值 1**                                                                                                                                                  |
| ⚠⚠ 峰值只有 1 是**正常的**                  | 补的是 2 层，但补层与回合末递减**在同一步之内**（都发生在「结束回合」那一步里），所以快照永远只看得见递减之后的 1。别据此以为补层写成了 1                             |
| 复仇魔掉血的步数：**虚无缥缈生效 / 未生效** | **919 / 1138** —— 钳制那两处的分母                                                                                                                                    |
| 蜥蜴法师的结局                              | **负 120 / 120**（战斗 1~8 回合，均值 3.3；2640 帧）——匕首每回合两把一起打，22 张牌组扛不住                                                                           |
| 召唤发生的次数 / 落位分布                   | **258 次**；1 号位 **138** / 4 号位 **77** / 3 号位 **43** / ⚠ **0 号位 0 次**                                                                                        |
| ⚠⚠ **0 号位结构性不可达**（asc0）           | `searchOrder` 的第 4 项要 4/1/3 三格全占着才轮得到，那意味着 `monstersAlive == 4`，与出招门 `monstersAlive < 4` 直接冲突；而首回合恒召唤时 3 号位是空的。见下方盲区表 |
| **落在游标右边（下标 > 2）的召唤**          | **120 次** —— 这就是 `skipTurn` 的分母，够厚                                                                                                                          |
| 同时存活的匕首峰值 / 场上活怪数分布         | **3**；1 只 ×343 帧 / 2 只 ×1024 / 3 只 ×1238 / 4 只 ×35                                                                                                              |
| 法师被打死的次数                            | **0 / 120** —— 所以 `MINION_LEADER` 那条判胜路径在这个编队上**一次都没走到**（它的背书全部来自地精首领，见第二十七 / 三十一批）                                       |

#### 变异测试（31186 例基线，括号内为失败例数）

**复仇魔 · 数值：**

| 变异                            |    例数 | 判读                                              |
| ------------------------------- | ------: | ------------------------------------------------- |
| 血量 185 → 200（asc8 档当基础） | **120** | = 这个编队的**全部**                              |
| 多重打击每击 6 → 7（asc3 档）   | **120** |                                                   |
| 多重打击段数 3 → 2              | **120** | 段数是第二个实参、恒定                            |
| 巨镰 45 → 40                    | **116** | ⚠ 参考这里**没有 asc 分档**，45 是写死的          |
| 灼烧张数 3 → 5（asc3 档）       | **118** |                                                   |
| 灼烧塞进抽牌堆而不是弃牌堆      | **118** | 两条不同的 Action，抽牌堆那条还要掷 cardRandomRng |
| 灼烧去掉 `sync`（改入队）       |   **0** | **等价改写**，见下方 0 例表                       |

**复仇魔 · 虚无缥缈（本批头号机制之一，四处协同）：**

| 变异                                           |    例数 | 判读                                                                |
| ---------------------------------------------- | ------: | ------------------------------------------------------------------- |
| 三条 case 都不补层                             | **120** | 基线                                                                |
| 补层 2 → 1                                     | **120** |                                                                     |
| 去掉 `!hasStatus` 那道门（每次都补、层数累加） | **120** | ⚠ 门写错的话层数会滚雪球                                            |
| **补层那两条从入队改成同步**                   |  **74** | ⚠ 非 0：同步会赶在本回合排的伤害 / RollMove **之前**生效            |
| `Monster::attacked` 那处钳制去掉               | **120** | 攻击路                                                              |
| `Monster::damage` 那处钳制去掉（非攻击路）     |  **29** | ⚠⚠ **两条路各有一份**，非攻击伤害（荆棘 / 燃烧 / 自杀）照样被压成 1 |
| `calculateCardDamage` 的下限整条去掉           |   **7** | ⚠ 薄但非 0——真正的钳制在 `attacked` 里，这一处只改**预计算值**      |
| `calculateCardDamage` 的 `max` **抄成 `min`**  |   **7** | ⚠⚠ 同一个薄分母：最终血量碰巧同解，分岔在玩家侧读那个预计算值的地方 |
| 回合末不递减                                   | **120** |                                                                     |
| 回合末递减但**不摘条目**（留 0 层）            | **120** | ⚠⚠ 承重：条目留着 `hasStatus` 恒真 → 复仇魔**再也补不上第二次**     |
| 回合末递减**补上 skipFirst**（施加当回合不掉） | **108** | ⚠ 这正是参考自注「与真实游戏不同」的那一处，见「待裁定」            |
| 补层排在 RollMove **之前**                     |   **0** | **等价改写**，见下方 0 例表                                         |
| 钳制挪到**格挡吸收之后**                       |   **0** | **盲区（分母为 0）**，见下方 0 例表                                 |
| 钳制去掉内层 `damage > 0`                      |   **0** | **结构性等价**，见下方 0 例表                                       |
| `calculateCardDamage` 的下限挪到**飞行之前**   |   **0** | **探针无效**，见下方 0 例表                                         |
| 灼烧那条收尾 同步 `rollMove` → 入队 `"roll"`   |   **0** | **等价改写**，见下方 0 例表                                         |
| 灼烧那条补层 同步 → 入队                       |   **0** | **等价改写**，见下方 0 例表                                         |

**复仇魔 · 出招规则（三档 roll + 三处极性各异的 `randomBoolean`）：**

| 变异                                            |    例数 | 判读                                                         |
| ----------------------------------------------- | ------: | ------------------------------------------------------------ |
| 首回合两侧对调（低位出灼烧）                    | **120** |                                                              |
| 首回合特判整条去掉                              |  **57** |                                                              |
| 首回合分界 50 → 40                              |   **8** | 薄                                                           |
| roll 分界 30 → 33                               |  **25** |                                                              |
| roll 分界 65 → 66                               |  **12** |                                                              |
| **巨镰的 `eitherLastTwo` → `lastTwoMoves`**     |  **67** | ⚠⚠ 这两个谓词第一次在本项目里分家                            |
| **多重打击的 `lastTwoMoves` → `eitherLastTwo`** |  **96** | ⚠ 同一只怪身上两种并存，反方向                               |
| 第一档 `randomBoolean` 极性反转                 |  **53** |                                                              |
| 第二档 `!randomBoolean()` → `randomBoolean()`   |  **22** |                                                              |
| 第三档 `randomBoolean() &&` 极性反转            |  **49** |                                                              |
| **第三档 `&&` 两侧对调（短路顺序）**            |  **22** | ⚠ 非 0：`randomBoolean` 在左边，**无条件掷**；换到右边就少掷 |
| 第三档去掉 `!lastMove(DEBUFF)` 那道门           |  **95** |                                                              |
| 第二档 `\|\|` 两侧对调（短路顺序）              |   **0** | **结构性盲区**，见下方 0 例表——那个析取项在这条路上恒假      |

**蜥蜴法师 / 匕首 · 数值：**

| 变异                                 |        例数 | 判读                                   |
| ------------------------------------ | ----------: | -------------------------------------- |
| 毒牙每击 13 → 16（asc3 档）          |      **84** |                                        |
| 毒牙段数 2 → 1                       |      **98** | ⚠ 旧近似表写的就是单段                 |
| 毒牙去掉虚弱                         |      **86** |                                        |
| 毒牙虚弱改同步                       |      **43** | ⚠ 非 0：同步会赶在两段伤害之前         |
| 毒牙虚弱排在伤害之前（顺序对调）     |      **43** | 同上，同一个可观察面                   |
| 巨口 30 → 34（asc3 档）              |      **63** |                                        |
| 召唤只数 1 → 2（asc18 档当基础）     |     **120** | ⚠ 全参考唯一一个**看爬升度**的召唤数量 |
| 匕首血量 20~~25 → 20~~20             |     **120** | ⚠ 「两组区间相同」不等于「上下界相同」 |
| 匕首突刺 9 → 10                      |     **107** |                                        |
| 匕首突刺不塞伤口                     |     **120** |                                        |
| 匕首突刺塞伤口改同步                 |      **11** | 薄但非 0                               |
| 匕首自爆 25 → 30（爆破怪那个数）     |     **116** |                                        |
| 匕首自爆去掉 `suicide`               |     **113** |                                        |
| ~~匕首自爆 `triggerRelics` → false~~ | **0 → 116** | ✅ **第四十批关掉**（地精之角）        |

**收尾（本批四种形态齐了）：**

| 变异                                            |    例数 | 判读                                                                   |
| ----------------------------------------------- | ------: | ---------------------------------------------------------------------- |
| 匕首突刺收尾 去掉 `setMove`（意图不变）         | **120** | 那条 `setMove` 是自爆唯一的来源                                        |
| 匕首突刺收尾 去掉 `noOpRollMove`（少掷 aiRng）  | **120** |                                                                        |
| **匕首自爆收尾 同步 noOp → 入队 noOp**          |  **24** | ⚠⚠ **「效果入队 + 收尾同步」那一族**：自爆打死玩家时入队那次永远轮不到 |
| 匕首自爆收尾 整条去掉（不掷 aiRng）             | **116** |                                                                        |
| 法师召唤收尾 真 `rollMove` → `noOpRollMove`     | **120** | 意图不变 = 下回合还召唤                                                |
| 匕首突刺收尾 两句顺序对调（先 noOp 再 setMove） |   **0** | **等价改写**，见下方 0 例表                                            |
| 法师召唤收尾 同步 `rollMove` → 入队 `"roll"`    |   **0** | **等价改写**，见下方 0 例表                                            |

**召唤的第四族（本批头号机制之二）：**

| 变异                                                 |    例数 | 判读                                                       |
| ---------------------------------------------------- | ------: | ---------------------------------------------------------- |
| 搜索顺序 `{4,1,3,0}` → `{0,1,3,4}`（正序）           | **120** |                                                            |
| 搜索顺序 → `{3,0,4,1}`                               | **107** |                                                            |
| 搜索顺序 → `{1,3,0,4}`                               |  **73** |                                                            |
| 门 `hp <= 0` → 「只填从没构造过的空格」              | **107** | ⚠ 死掉的匕首那一格也算空                                   |
| 不整只重建（保留意图历史 / Power / 格挡）            | **107** |                                                            |
| `setMove` → `rollMove`（多掷一次 aiRng）             | **120** |                                                            |
| 不 `buff<MINION>()`                                  | **120** | 它进快照                                                   |
| **`skipTurn` 整条去掉**（新匕首当回合就行动）        |  **95** | ⚠⚠ 全参考唯一那个 bitset 的直接背书                        |
| **`doMonsterTurn` 的门里去掉 `!skipTurn`**           |  **95** | 同一件事的另一面，数字一致                                 |
| **`skipTurn` 换成 `++monsterTurnIdx`（青铜球那套）** |  **73** | ⚠ 推游标只能跳一格，匕首可能落在 3 或 4                    |
| **`skipTurn` 回合末不清空**                          | **111** | ⚠ 生命周期不跨回合，这一位是主循环那句 `reset()` 的背书    |
| 召唤改成入队（`addToBot`）                           |  **97** | ⚠ 参考是**裸的同步调用**                                   |
| `++monstersAlive` 挪到循环末尾                       |   **0** | **探针无效（asc0 只召 1 只）**，见下方 0 例表              |
| 补跑一次 `preBattleAction`                           | **120** | ⚠⚠ **探针无效**，但理由与预期的不同——见下方 0 例表下面那段 |

**蜥蜴法师 · 出招规则：**

| 变异                                         |   例数 | 判读                                  |
| -------------------------------------------- | -----: | ------------------------------------- |
| 首回合恒召唤那条去掉                         | **81** |                                       |
| `canSpawn` `< 4` → `< 3`                     | **65** |                                       |
| `canSpawn` `< 4` → `< 5`                     |  **7** | 薄——要三把匕首同时活着才分得开        |
| 第二段 `!lastTwoMoves(SUMMON)` → `!lastMove` | **56** |                                       |
| 第一段 `!lastMove(SNAKE)` → `!lastTwoMoves`  | **33** |                                       |
| 末尾重掷区间 `(0,65)` → `(0,99)`             | **13** | ⚠ 参考真的写的是 65 不是 99           |
| 第一段重掷区间 `(33,99)` → `(0,99)`          | **10** |                                       |
| `canSpawn` 改成循环内实时读                  |  **0** | **等价改写（结构性）**，见下方 0 例表 |
| 第一段重掷后 `continue`（而不是往下判）      |  **0** | **等价改写（结构性）**，见下方 0 例表 |

**编队建法：**

| 变异                                             |    例数 | 判读                                                      |
| ------------------------------------------------ | ------: | --------------------------------------------------------- |
| 去掉两个空格（三只紧凑排 0/1/2）                 | **120** |                                                           |
| 空格改成 0/1（收藏家那套：法师在 2、匕首在 3/4） | **120** |                                                           |
| 建怪顺序改成「法师先、两把匕首后」               | **120** |                                                           |
| **`monstersAlive` 写成数组长度**                 | **699** | ⚠ **跨编队**（地精首领 / 自动机 / 收藏家 / 法师四个都红） |

**`isMonsterAttacking` 三个方向（第二十四批立的规矩，照办）：**

| 变异                                               |     例数 | 判读                                                                                                            |
| -------------------------------------------------- | -------: | --------------------------------------------------------------------------------------------------------------- |
| 谓词恒真（**全库**）                               | **2732** | 全语料数字（第三十五批是 2703），只能用来判「不是 0」                                                           |
| **白名单漏掉本批 6 条攻击招**                      |  **123** | ⚠ 本批的增量背书之一。拆开：多重打击 **46** / 巨镰 **22** / 毒牙 **9** / 巨口 **12** / 突刺 **32** / **自爆 9** |
| **白名单多收本批 2 条非攻击**                      |          | 灼烧诅咒 **36** / 召唤匕首 **17**（分开量）                                                                     |
| **回退萎缩补丁**（去掉 `writhing_mass/wm_wither`） |   **24** | ⚠⚠ 与第三十五批「多收萎缩」量到的 24 例**一字不差**——同一个数的两面                                             |

**可达性探针（第二十七批立的规矩：0 例之后要写专门的探针，只动真侧）：**

| 探针                                             |       例数 | 结论                                                |
| ------------------------------------------------ | ---------: | --------------------------------------------------- |
| 复仇魔第二档 `eitherLastTwo(SCYTHE)` **恒真**    |     **14** | 那条 case 会走到                                    |
| 复仇魔第二档 `eitherLastTwo(SCYTHE)` **恒假**    |      **0** | ⚠⚠ **那个析取项本身恒假**（结构性死条件，详见下方） |
| 复仇魔第一档 `lastTwoMoves(ATTACK)` **恒假**     |      **0** | ⚠⚠ 同上，第二处结构性死条件                         |
| 复仇魔第一档 `!lastMove(DEBUFF)` **恒真**        |     **10** | 可达                                                |
| 复仇魔第三档 `!eitherLastTwo(SCYTHE)` **恒真**   |     **11** | 可达（与第一 / 二档正相反）                         |
| 法师 `canSpawn` 恒真 / 恒假                      | **7 / 90** | 两侧都可达                                          |
| 法师 `searchOrder` 第 4 项（0 号位）改成 99      |      **0** | ⚠⚠ **asc0 下结构性不可达**（详见盲区表）            |
| 召唤的 `noOpRollMove` 挪到循环之外（收藏家那套） |      **0** | **探针无效**：asc0 只召 1 只，循环内外同解          |

**0 例的（逐条分四类）：**

| 变异                                                | 例数        | 分类与理由                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ⚠⚠ 复仇魔第二档的 `eitherLastTwo(SCYTHE)`           | **0**       | **结构性盲区（被前一句挤死）**：走到那里的前提是 `lastTwoMoves(ATTACK)` 为真，即 `moveHistory[0] == [1] == ATTACK`——那么它们都不可能是 SCYTHE。形状本身没有矛盾（只是被同一条 case 里前一句的条件挤死），与第二十七批地精首领的两个 `lastMove(RALLY)` **同族：照抄、不报补丁**。⚠ 那次「`\|\|` 两侧对调」红 0 例正是这条的另一种表现 |
| ⚠⚠ 复仇魔第一档的 `lastTwoMoves(ATTACK)`            | **0**       | **同上，第二处**：走到那里的前提是 `eitherLastTwo(SCYTHE)` 为真（最近两格里有 SCYTHE），那么两格不可能都是 ATTACK。于是 `? "nem_debuff" :` 那一支是死代码。**照抄、不报补丁**                                                                                                                                                        |
| ⚠⚠ 法师 `searchOrder` 的第 4 项（`0` 号位）         | **0**       | **结构性盲区（asc0）**：轮到它要 4 / 1 / 3 三格都占着，即 `monstersAlive == 4`，而出招门是 `monstersAlive < 4`——**直接冲突**；首回合恒召唤那条路上 3 号位又是空的。关门条件是 **asc >= 18**（那时一次召 2 只）                                                                                                                       |
| 法师 `hpDiscardRoll` 的**区间**（180~190 抄成高档） | **0**       | ⚠ **不是盲区，是结构性不可观测**（第二十七批已证）：取值被丢弃，`Random::nextLong(n)` 的前进步数与 n 无关。**次数**有背书（120 例）                                                                                                                                                                                                  |
| 虚无缥缈钳制挪到**格挡吸收之后**                    | **0**       | **盲区（分母为 0）**：复仇魔整只怪**没有任何加格挡的招式**，所以「压成 1 之后再让格挡吃」与「先让格挡吃再压成 1」取不到不同值。关门条件是「一只同时带虚无缥缈与格挡的怪」——参考里没有                                                                                                                                                |
| 虚无缥缈钳制去掉内层 `damage > 0`                   | **0**       | **结构性等价**：调用方 `attackEnemy` 传进来的伤害已经过 `calculateCardDamage`，而那个函数对虚无缥缈的目标返回**至少 1**，所以 `damage == 0` 在这条路上取不到                                                                                                                                                                         |
| 虚无缥缈补层排在 RollMove **之前**                  | **0**       | **等价改写（当前语料）**：`getMoveForRoll` 不读虚无缥缈。关门条件是「出招规则读自己 Power 的怪」                                                                                                                                                                                                                                     |
| `calculateCardDamage` 的下限挪到**飞行之前**        | **0**       | **探针无效**：没有一只怪同时带飞行与虚无缥缈，两个 if 的门互斥                                                                                                                                                                                                                                                                       |
| 灼烧诅咒去掉 `sync` / 收尾改入队 / 补层改入队       | **0**       | **等价改写**，第二十六批那条判据的直接应用：**这条 case 一条队列动作都没排**，最后几句改成入队后队列里就它们，立刻出队                                                                                                                                                                                                               |
| 法师召唤收尾 同步 `rollMove` → 入队 `"roll"`        | **0**       | **等价改写**，同上（召唤本身也是同步的，早就跑完了）                                                                                                                                                                                                                                                                                 |
| 匕首突刺收尾两句顺序对调                            | **0**       | **等价改写**：`noOpRollMove` 掷完就丢、不读意图，`setMove` 也不读 aiRng。⚠ 参考里球状守卫者是「先 setMove 再 noOp」、拜鸟是反过来，两种写法并存——照抄                                                                                                                                                                                |
| 法师 `canSpawn` 改成循环内实时读                    | **0**       | **等价改写（结构性）**：循环体内没有任何地方改 `monstersAlive`，`const` 与实时读必然同值。参考写的是 `const`，照抄                                                                                                                                                                                                                   |
| 法师第一段重掷后 `continue`                         | **0**       | **等价改写（结构性）**：重掷的下界 `random(33, 99)` 恰好等于下一段的下界，所以「回到循环顶再判一次 `< 33`」必然为假、与直接落到下一段同解。⚠ 与第三十五批蠕动血块那三处**同一个坑**                                                                                                                                                  |
| ~~匕首自爆 `triggerRelics` → false~~                | **0 → 116** | ✅ **第四十批关掉**：地精之角进了 `@relic1`，`Monster::die` 那条链本身就成了可观察面（`reptomancer@relic1` 红 **116 例**）。当年那句「两支的差别只在死亡链与扣格挡」是对的，缺的只是一颗遗物                                                                                                                                         |
| 召唤 `++monstersAlive` 挪到循环末尾                 | **0**       | **探针无效（asc0 只召 1 只）**：循环只跑一次，「循环内」与「循环末」是同一个位置。关门条件是 asc >= 18                                                                                                                                                                                                                               |
| 召唤 `noOpRollMove` 挪到循环之外                    | **0**       | **同上**，同一个理由                                                                                                                                                                                                                                                                                                                 |
| 召唤补跑一次 `preBattleAction`                      | (120)       | ⚠⚠ **探针无效，而且理由与预期的不同**——见下                                                                                                                                                                                                                                                                                          |

⚠⚠ **「召唤补跑 `preBattleAction`」这条要单独说清，它是本批唯一一条「非 0 却不算背书」的**：
在**参考里**重跑一遍是严格的空操作（匕首的 `preBattleAction` 就是 `buff<MS::MINION>()`，
而 `Monster::buff` 对纯 bool 只 `setHasStatus(true)`、不带层数，召唤自己也手写了同一句）。
可**我们这边** `addPower` 一律累加，重跑会把 `MINION` 变成 **2** 层 → 快照当场不符 → 红 120 例。
**那 120 例量的是我们自己的建模差异，不是参考的语义**，所以它记成「探针无效」。
⚠ 这处差异当前**不可达**（没有任何代码路径对同一只怪 `buff` 两次纯 bool Power，
暗影客的 `REGROW` 中间隔着 `resetAllStatusEffects` 的整条丢弃），已在
`PRE_BATTLE_ACTION.dagger` 的注释里写明；下一个「召唤 + 同种怪预置」的宿主要先回来看这一条。
⚠ 真正有背书的「不重跑 `preBattleAction`」仍然只有地精首领那条（红 300 例）。

⚠ **本批 15 条 0 例的分类：6 条等价改写、1 条结构性等价、1 条盲区（分母为 0）、
4 条探针无效、3 条结构性盲区**（外加 1 条「结构性不可观测」的白掷区间与 1 条「非 0 却无效」的探针）。

#### 本批新增的盲区

| 盲区                                                                                                                | 例数        | 分类                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三只怪的全部 asc 分档（多重打击 7 / 灼烧 5 张 / 毒牙 16 / 巨口 34 / 召唤 2 只）与第二组血量区间（`hpHigh`）         | 0           | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错。**本批同样没写 `hpHigh`**（`data-tables.test.ts` 有一条用例守着）                                      |
| **`searchOrder` 的第 4 项（0 号位）**                                                                               | 0           | **结构性盲区（asc0）**：要 `monstersAlive == 4` 才轮得到，与出招门 `< 4` 直接冲突。⚠ 关门条件是 **asc >= 18**（一次召 2 只），与上一行同批                                  |
| 召唤的 `++monstersAlive` / `noOpRollMove` **在循环内还是循环外**                                                    | 0           | **探针无效（asc0 只召 1 只）**：循环只跑一次。同样等 asc >= 18                                                                                                              |
| **复仇魔出招规则里两处「被前一句挤死」的条件**（第一档的 `lastTwoMoves(ATTACK)`、第二档的 `eitherLastTwo(SCYTHE)`） | 0           | **结构性盲区（不是笔误）**：形状本身没有矛盾，只是被同一条 case 里前一句的条件挤死。与第二十七批地精首领的两个 `lastMove(RALLY)` 同族——**照抄、不报补丁**，任何编队都关不掉 |
| 虚无缥缈钳制**相对于格挡吸收 / 狂怒的位置**                                                                         | 0           | **盲区（分母为 0）**：复仇魔没有任何加格挡的招式，也不带狂怒。关门条件是「一只同时带虚无缥缈与格挡（或狂怒）的怪」——参考里没有                                              |
| ~~匕首自爆的 `triggerRelics` 这一位~~                                                                               | 0 → **116** | ✅ **第四十批关掉**（地精之角 + `reptomancer@relic1`）                                                                                                                      |
| `MINION_LEADER` 在蜥蜴法师身上的判胜路径                                                                            | 0           | **盲区（分母为 0）**：法师 180~190 血，这副 22 张牌组 120 / 120 都打不死它。它的背书全部来自地精首领（第二十七批 4 例、第三十一批 `@tgt1` 21 例）                           |
| ~~贤者之石给召唤出来的匕首 +1 力量~~                                                                                | 0           | ✅ **第四十批关掉**（`reptomancer@relic1`），例数见「验证方式 · 第四十批」                                                                                                  |

#### 三条给下一个人的结论

1. **⚠⚠ 「asc0 下这条召唤最多召几只」要在写变异表**之前**算一遍。** 蜥蜴法师是全参考项目
   唯一一个召唤数量看爬升度的宿主（`asc18 ? 2 : 1`），于是 asc0 下**循环只跑一次**——
   「`++monstersAlive` 在循环内还是循环外」「`noOpRollMove` 在循环内还是循环外」这两个维度
   （恰恰是它与收藏家的区别所在）**全部退化成探针无效**，而且 `searchOrder` 的第 4 项也
   跟着结构性不可达。**这不是「量出来是 0」，是「本来就不可能不是 0」。**
2. **⚠⚠ 「非 0」也可能不是背书。** 「召唤补跑一次 `preBattleAction`」红 120 例，可那 120 例
   量的是**我们自己的建模差异**（`addPower` 累加 vs 参考的 `buff` 对纯 bool 只置位），
   不是参考的语义——在参考里重跑是严格的空操作。**判据要比「diff 非空 + 例数非 0」再强一层：
   问一句「红掉的这些例，是因为参考在这里真的会不一样吗」。**
3. **同一个函数里，同一族谓词可以既是活的又是死的。** 复仇魔的 `eitherLastTwo(SCYTHE)`
   在第三档是活的（恒假探针红 11 例），在第二档是**结构性死条件**（恒假探针 0 例）——
   因为走到第二档的前提 `lastTwoMoves(ATTACK)` 已经把两格都钉成 ATTACK 了。
   **判据：写可达性探针时按「走到这一句的前提是什么」逐段推，别按「这个谓词在别处是活的」推。**

### 第三十五批：把两块「半成品的共享机制」补完（蠕动血块 / 巨头）

#### 数据规格与体积

| 项        | 值                                                                                       |
| --------- | ---------------------------------------------------------------------------------------- |
| harness   | 第四个乘积 `act3Variants` 里追加的 **variant 35**（variant 34 的 encounters 一个字没动） |
| 牌组      | `BATCH_1 + SPOT_WEAKNESS`（与 variant 24~34 逐字节相同）                                 |
| 种子 / 层 | 40 / `{1,3,7}`                                                                           |
| 爬升度    | **0**；目标策略 **0**                                                                    |
| 编队      | `writhing_mass` / `giant_head`                                                           |
| 例数      | 240（2 × 120），对拍 30706 → **30946**                                                   |
| 体积      | **6.0MB**（3.0 + 3.0MB），仓库 589MB → **595MB**，文件数 109 → **111**                   |
| 扰动      | `git status -- test/golden/traces` **只有 2 个 `??`、零个 `M`**                          |

覆盖表（八条新招式**出现 / 执行**都非 0）：

| 招式                          | 出现 | 执行 | 招式                         | 出现 | 执行 |
| ----------------------------- | ---: | ---: | ---------------------------- | ---: | ---: |
| `WRITHING_MASS_STRONG_STRIKE` |  451 |   99 | `WRITHING_MASS_MULTI_STRIKE` | 1068 |  214 |
| `WRITHING_MASS_FLAIL`         |  988 |  186 | `WRITHING_MASS_WITHER`       | 1140 |  241 |
| `WRITHING_MASS_IMPLANT`       |  285 |   66 | `GIANT_HEAD_COUNT`           | 1190 |  242 |
| `GIANT_HEAD_GLARE`            | 1179 |  238 | `GIANT_HEAD_IT_IS_TIME`      | 1671 |  370 |

#### 先量局面，再量变异

| 事实                                       | 数值                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 蠕动血块的结局                             | 胜 **28** / 负 **92**（战斗 3~10 回合，均值 5.9）                                                                                         |
| 植入出现过的 trace                         | **110 / 120**（285 帧）——它一场仗最多出一次，所以这个数就是「有多少局真的植入了」                                                         |
| 怪物掉血（未被格挡）的步数                 | **1814**                                                                                                                                  |
| ⚠⚠ **玩家回合内意图被改写的步数**          | **1534** —— 这就是 `ReactiveRollMove` 真的在跑的**直接**证据（怪物回合的意图变化伴随 `turn` 递增，这 1534 步全在玩家回合里）              |
| `REACTIVE > 0` 的帧 / 峰值                 | **27 帧** / **2**                                                                                                                         |
| ⚠ 那 27 帧**全部**是「怪已死、层数停在 1」 | 27 / 27。机理：那条动作 `clearOnCombatVictory` 默认 true，打死它的那一击排下的动作被 `checkCombat` 清掉 → 层数再也没人清零                |
| `MALLEABLE` 峰值                           | **8**（开局 3，每挨一击 +1，回合末拉回 3）                                                                                                |
| 巨头的结局                                 | **负 120 / 120**（战斗 5~7 回合，均值 6.1）——它 500 血，22 张牌组打不动                                                                   |
| `SLOW > 0` 的帧 / 峰值                     | **2812 帧** / **7**（层数分布 1×850 / 2×864 / 3×756 / 4×288 / 5×44 / 6×8 / 7×2）                                                          |
| 「时候到了」出现过的 trace                 | **120 / 120**，出现回合分布 turn4×485 / turn5×512 / turn6×599 / turn7×75                                                                  |
| ⚠⚠ 它**执行**时的 `getMonsterTurnNumber()` | **最小 5**（不是 4）—— 意图在第 4 个怪物回合的收尾滚出来、第 5 个才执行。这一格决定了 `min(turnNo-5, 6)` 那一项**永远取不到负数**，见下表 |

#### 变异测试（30946 例基线，括号内为失败例数）

**蠕动血块 · 数值与建怪：**

| 变异                                   |    例数 | 判读                                                     |
| -------------------------------------- | ------: | -------------------------------------------------------- |
| 血量 160 → 175（asc7 档当基础）        | **120** | = 这个编队的**全部**                                     |
| 重抽 32 → 38（asc2 档当基础）          |  **57** |                                                          |
| 乱抽每击 7 → 9                         |  **94** |                                                          |
| 乱抽段数 3 → 2                         |  **97** | 段数是第二个实参、恒定                                   |
| 挥击伤害 15 → 16                       |  **88** | ⚠ 与格挡是**两个独立的分档**（15/16 与 16/18）           |
| 挥击格挡 16 → 18                       |  **92** |                                                          |
| **挥击整条格挡去掉（旧近似表的形态）** |  **92** | 旧表只有伤害 15、漏了格挡                                |
| 挥击格挡 `sync: true`（改同步）        |  **40** | ⚠ 非 0：它排在本次攻击之后，同步会让这一击自己挡下一部分 |
| 萎缩伤害 10 → 12（asc2 档当基础）      |  **94** |                                                          |
| **萎缩去掉易伤（旧近似表的形态）**     | **103** | 旧表只有虚弱                                             |
| 萎缩两条减益改成同步                   |  **11** | 薄但非 0                                                 |
| 萎缩两条减益顺序对调（先易伤后虚弱）   |  **26** | 顺序照抄                                                 |

**蠕动血块 · 反应（本批头号机制之一）：**

| 变异                                                   |    例数 | 判读                                                                           |
| ------------------------------------------------------ | ------: | ------------------------------------------------------------------------------ |
| 开局不上反应                                           | **120** | 基线                                                                           |
| 开局不上易塑                                           | **120** | 基线（同一格的另一半）                                                         |
| **反应初值 0 → 1（写成 `buff(1)`）**                   | **120** | ⚠⚠ `setHasStatus(true); setStatus(0)` 与 `buff(1)` **不是一回事**              |
| 反应那半格整条去掉                                     | **120** |                                                                                |
| ⚠⚠ **两个内层 if 改成 else-if（易塑在场时反应让位）**  | **120** | **这一格「装两条 Power」的形状由它钉死**                                       |
| 反应那一格的门改成「层数 > 0」                         | **120** | ⚠ 层数平时就是 0，写成 `> 0` 它一次都触发不了                                  |
| **反应「每次都入队」（不攒层数）**                     |  **83** | ⚠ aiRng 次数相同、`moveHistory` 推进次数不同                                   |
| **攒层数那一支不涨（恒 1，只滚一次）**                 |  **83** | 反方向，同一个 83                                                              |
| `ReactiveRollMove` 只滚一次（不按层数循环）            |  **81** |                                                                                |
| `ReactiveRollMove` 里的 `rollMove` 换成 `noOpRollMove` | **120** | 掷同样多次 aiRng、但不改意图                                                   |
| `ReactiveRollMove` 不清零层数                          | **120** |                                                                                |
| 清零改成整条摘掉（`removeStatus`）                     | **120** | ⚠ 参考写的是 `setStatus`（只写数值、不清 bit），摘掉的话第二次挨打就再也不触发 |
| 入队改 `addToTop`                                      |   **2** | ⚠ 薄但非 0：只有「同一回合里它前面还排着别的动作」时才分岔                     |
| 那条动作 `clearOnCombatVictory` 改成 false             |  **27** | = 那 27 条「打死它的那一击」的 trace                                           |
| 两个内层 if 对调（反应排在易塑之前）                   |   **0** | 见下方 0 例表                                                                  |
| 目标从写死 `arr[0]` 改成读最后一只怪                   |   **0** | **探针无效**，见下方 0 例表                                                    |

**蠕动血块 · 出招规则（全参考项目最复杂的一个）：**

| 变异                                               |    例数 | 判读                                                           |
| -------------------------------------------------- | ------: | -------------------------------------------------------------- |
| 首回合三分 33/66 → 50 两分（去掉萎缩那支）         |  **58** |                                                                |
| 首回合分界 33 → 50                                 |  **15** | 薄但非 0（首回合只有一帧）                                     |
| 首回合乱抽 / 挥击两支对调                          |  **77** |                                                                |
| `<10` 段重掷改成钳制（少掷 aiRng）                 |  **26** | ⚠ 那是**一次真的重掷**，不是把 roll 钳到 10                    |
| `<10` 段重掷区间 (10,99) → (0,99)                  |  **20** | 区间本身也被钉住                                               |
| ⚠ **`<10` 段：重掷后直接落到兜底（模拟 else-if）** |  **18** | **「并列 if、重掷后落到下一段」这个形状由它钉死**              |
| `<20` 段去掉 `!lastMove(植入)`                     |  **11** |                                                                |
| `<20` 段去掉 `!haveUsedImplant`（植入可反复出）    |  **40** |                                                                |
| `<20` 段 `randomBoolean(0.1)` → 0.3                |  **14** |                                                                |
| `<20` 段那次 `randomBoolean` 整条去掉              |  **55** | 次数被钉住                                                     |
| ⚠ **`<20` 段：重掷后直接落到兜底**                 |  **39** | 同上                                                           |
| `<40` 段 `randomBoolean(0.4)` → 0.6                |  **24** |                                                                |
| `<40` 段内层 `random(0,19)` → `random(0,39)`       |   **9** | 薄但非 0                                                       |
| `<40` 段内层分界 `myRoll < 10` → `< 20`            |  **23** | ⚠ 内层判的是 **10**（不是 20），照抄                           |
| `<40` 段内层第二次 `randomBoolean(0.1)` → 0.3      |   **4** | ⚠ **最薄的一条**，但两处 0.1 是两个独立字面量                  |
| `<40` 段内层 `continue` 改成 `return` 萎缩         |   **8** | ⚠ 这个 `continue` 真的回到 `<10` 重头判                        |
| `<40` 段末尾重掷 (40,99) → (0,99)                  |  **37** |                                                                |
| ⚠ **`<40` 段：重掷后直接落到兜底**                 |  **39** |                                                                |
| `<70` 段 `randomBoolean(0.3)` → 0.5                |  **38** |                                                                |
| `<70` 段 `continue` 改成落到兜底                   |  **85** | ⚠ 这个 `continue` 的重掷是 `random(0, 39)`，真的会回到前面几段 |
| `<70` 段重掷区间 (0,39) → (0,99)                   |  **77** |                                                                |
| 兜底去掉 `!lastMove(挥击)`（恒挥击）               | **100** |                                                                |
| 重抽那道 `lastMove` → `lastTwoMoves`               |  **26** | ⚠ 三道门全是 `lastMove`，别按邻居补成 `lastTwoMoves`           |
| 萎缩那道 `lastMove` → `lastTwoMoves`               |  **83** | 同上，第二个方向                                               |
| `haveUsedImplant` 改成循环内实时读                 |   **0** | 见下方 0 例表                                                  |

**蠕动血块 · 植入：**

| 变异                                       |   例数 | 判读                                                 |
| ------------------------------------------ | -----: | ---------------------------------------------------- |
| 不置 `miscInfo`（标志位失效）              | **42** | 出招规则的 `haveUsedImplant` 因此恒假                |
| 收尾 同步 `rollMove` → 同步 `noOpRollMove` | **66** | = 植入的执行次数：意图不再改变，它会一直「植入」下去 |
| 收尾 同步 `rollMove` → 入队 `"roll"`       |  **0** | **等价改写**，见下方 0 例表                          |

**巨头 · 数值与出招：**

| 变异                                   |    例数 | 判读                                                                        |
| -------------------------------------- | ------: | --------------------------------------------------------------------------- |
| 血量 500 → 520（asc8 档当基础）        | **120** | ⚠ 它是**精英**，血量阈值是 asc8（不是普通怪的 7）                           |
| 数数 13 → 12                           | **120** |                                                                             |
| 凝视虚弱 1 → 2                         | **120** |                                                                             |
| **凝视去掉 `sync`（改入队）**          | **120** | ⚠ 那条 case 里 `player.debuff` 是裸调用，紧随其后的同步 `rollMove` 之前生效 |
| 「时候到了」起点 30 → 40（asc3 档）    | **120** |                                                                             |
| 「时候到了」整条成长去掉（恒 30）      | **118** |                                                                             |
| `monsterTurnRamp.subtract` 5 → 4       | **120** |                                                                             |
| `monsterTurnRamp.scale` 5 → 10         | **116** |                                                                             |
| 出招门 `>= 4` → `>= 5`                 | **120** |                                                                             |
| 出招门整条去掉（时候到了永不出场）     | **120** |                                                                             |
| 凝视那道 `lastTwoMoves` → `lastMove`   |  **64** | ⚠ 两道门都是 `lastTwoMoves`                                                 |
| 数数那道 `lastTwoMoves` → `lastMove`   |  **69** | 第二个方向                                                                  |
| roll 分界 50 → 40                      |  **23** |                                                                             |
| roll 两侧对调（低位出数数）            | **120** |                                                                             |
| 「时候到了」收尾 同步 noOp → 入队 roll | **120** | 意图会被重滚，`moveHistory` 也跟着推进                                      |
| 「时候到了」收尾 同步 noOp → 入队 noOp | **120** | ⚠ **「效果入队 + 收尾同步」那一族**：这个编队 120/120 都是玩家阵亡收场      |
| 「时候到了」收尾整条去掉（不掷 aiRng） | **120** |                                                                             |
| 凝视收尾 同步 `rollMove` → 入队 roll   |   **0** | **等价改写**，见下方 0 例表                                                 |
| `monsterTurnRamp.cap` 6 → 99 / 6 → 2   |   **0** | **盲区（分母不够）**，见下方 0 例表                                         |
| `min` 补一个 `max(0, …)`               |   **0** | **结构性盲区**，见下方 0 例表——本批最值得记的一条                           |

**缓慢（本批头号机制之二）：**

| 变异                                             |    例数 | 判读                                                                       |
| ------------------------------------------------ | ------: | -------------------------------------------------------------------------- |
| 开局不上（`preBattleAction` 整条去掉）           | **120** | 基线                                                                       |
| **开局初值 0 → 1（写成 `buff(1)`）**             | **120** | ⚠⚠ 与反应同一条教训                                                        |
| 出牌不 +1（`onAfterUseCard` 那句去掉）           | **120** |                                                                            |
| **出牌 +1 的门改成「层数 > 0」**                 | **120** | ⚠ 开局层数就是 0，这条门写错缓慢永远涨不起来                               |
| 出牌 +1 改成 `setPower(1)`（不累加）             | **120** |                                                                            |
| **+1 挪到 `useCard` 开头（当前这张牌就吃加成）** | **120** | ⚠ 位置是可观察的：伤害在 `CARD_RULES` 里就算好了，`OnAfterCardUsed` 在其后 |
| 伤害倍率整条去掉                                 | **120** |                                                                            |
| 倍率步长 0.1 → 0.2                               | **120** |                                                                            |
| 回合末不清零                                     | **120** |                                                                            |
| 回合末清零改成整条摘掉（`removeStatus`）         | **120** | ⚠ 摘掉的话下个回合 `hasStatus` 为假、缓慢永久失效                          |
| 回合末清零改成递减 1                             | **120** |                                                                            |
| 倍率挪到易伤之后 / 挪到飞行之后                  |   **0** | **等价改写（当前语料）**，见下方 0 例表                                    |
| `triggerOnUse` 那道门去掉（恒执行）              |   **0** | **结构性等价**，见下方 0 例表                                              |
| +1 挪到 `purgeOnUse` 提前返回之后                |   **0** | **盲区（分母为 0）**，见下方 0 例表                                        |
| 读 `monsters[0]` 改成遍历所有怪                  |   **0** | **探针无效**，见下方 0 例表                                                |

**`isMonsterAttacking` 三个方向（第二十四批立的规矩，照办）：**

| 变异                          |     例数 | 判读                                                                                                                 |
| ----------------------------- | -------: | -------------------------------------------------------------------------------------------------------------------- |
| 谓词恒真（**全库**）          | **2703** | 全语料数字（第三十四批是 2637），只能用来判「不是 0」                                                                |
| **白名单漏掉本批 5 条攻击招** |  **131** | ⚠ **本批的增量背书在这个方向上**                                                                                     |
| **白名单多收本批 3 条非攻击** |   **66** | 拆开是 凝视 **30** / 植入 **12** / 萎缩 **24**                                                                       |
| ⚠⚠ 其中「萎缩」那 **24** 例   |          | **它是参考的笔误**（走了 `attackPlayerHelper` 却不在表里）。⚠ **第三十六批已打补丁**，见「已修正（参考侧已打补丁）」 |

**0 例的（逐条分四类）：**

| 变异                                       | 例数  | 分类与理由                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⚠⚠ `min(turnNo-5, 6)` 补一个 `max(0, …)`   | **0** | **结构性盲区，而且差点被写成「有背书」。** 按字面读 `turnNo == 4` 时那一项是 −5，可**出招门读的是「滚意图那一刻」的回合数、成长读的是「执行那一刻」的，两者差一个怪物回合**：门 `>= 4` 命中时那次 rollMove 跑在第 4 个怪物回合的收尾，招式要到第 **5** 个才执行 → `min(0, 6) == 0`。**判据：推这类边界时先把「意图早一个怪物回合定下来」算进去。** |
| `monsterTurnRamp.cap` 6 → 99（也试了 → 2） | **0** | **盲区（分母不够）**：这个编队最长 7 个玩家回合，`min` 左边最大才 **2**——连把 cap 抄成 2 都测不出来。关门条件是「更耐打的编队」，与第三十二批尖刺客封顶那条同族                                                                                                                                                                                    |
| 缓慢倍率挪到易伤之后 / 挪到飞行之后        | **0** | **等价改写（当前语料）**：三者都是乘法，而巨头身上没有飞行 / 虚无缥缈，float 乘法在这个语料的取值上恰好可交换。关门条件是「一只同时带缓慢与飞行的怪」——参考里没有                                                                                                                                                                                  |
| `triggerOnUse` 那道门去掉（恒执行）        | **0** | **结构性等价**：`CardQueueItem::triggerOnUse` 默认 true，而 `playCardQueueItem` 只在 `purgeOnUse \|\| (triggerOnUse && …)` 时才调 `useCard`，`purgeOnUse` 那一族不改这一位。唯一的假值来源是 `Actions::TimeEaterPlayCardQueueItem`（第三十九批）。照抄那道门                                                                                       |
| 缓慢 +1 挪到 `purgeOnUse` 之后             | **0** | **盲区（分母为 0）**：这副 22 张牌组里没有二连击，`purgeOnUse` 一次都没发生。关门条件是「带二连击的牌组」                                                                                                                                                                                                                                          |
| 缓慢读 `monsters[0]` 改成遍历所有怪        | **0** | **探针无效**：`giant_head` 是单怪编队，两种写法取到同一个对象。与激怒 / 尖锐外壳那条 `arr[0]` 同族，且更彻底——全参考项目只有巨头带缓慢，而它只出现在单怪编队里                                                                                                                                                                                     |
| 反应目标从写死 `arr[0]` 改成读最后一只怪   | **0** | **探针无效**：同上，`writhing_mass` 也是单怪编队。参考自注 `// writhing mass is always monster 0`                                                                                                                                                                                                                                                  |
| 反应与易塑两个内层 if 对调                 | **0** | **等价改写**：两条都是 `addToBot`，而加格挡不读意图、`ReactiveRollMove` 不读格挡。⚠ 与上面那条「改成 else-if」（红 120）不是一回事，那条改的是**能不能同时触发**                                                                                                                                                                                   |
| 植入收尾 同步 `rollMove` → 入队 `"roll"`   | **0** | **等价改写**，第二十六批那条判据的直接应用：**这条 case 一条队列动作都没排**，最后一句改成入队后队列里就它一条，立刻出队                                                                                                                                                                                                                           |
| 凝视收尾 同步 `rollMove` → 入队 `"roll"`   | **0** | **等价改写**，同上（凝视的减益是 `sync: true`，那条 case 同样没排任何队列动作）                                                                                                                                                                                                                                                                    |
| `haveUsedImplant` 改成循环内实时读         | **0** | **等价改写（结构性）**：循环体内没有任何地方改 `miscInfo`，`const` 与实时读必然同值。参考写的是 `const`，照抄                                                                                                                                                                                                                                      |

⚠ **本批 11 条 0 例的分类：4 条等价改写、1 条结构性等价、2 条盲区（分母不够 / 为 0）、
3 条探针无效、1 条结构性盲区。**
⚠⚠ **另有 4 条「第一版写成了无效探针、重写之后拿到非 0」，值得单记**（复核方这两批栽过两次的
同一个坑，本批主动复查了每一条 0 例）：

| 第一版探针                                        | 为什么无效                                                                                        | 重写之后                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 「易塑/反应拆成两个 else-if」写成把外层门改窄     | 蠕动血块**恒有易塑**，外层门照样为真、内层的反应 if 照跑——**改动落在了一个恒真的条件上**          | 改成两个**内层** if 变 else-if → 120  |
| 「并列 if 改成 else-if」写成在重掷后加 `continue` | 三处重掷的下界恰好等于下一段的下界（`random(10,99)` ≥ 10…），所以 `continue` 与落到下一段**同解** | 改成重掷后直接跳到兜底 → 18 / 39 / 39 |
| 「缓慢倍率挪到飞行之后」漏写了「挪过去」那一半    | 实际效果等于「整条删掉」，与另一条变异重复                                                        | 补上之后 → 0（真的是等价改写）        |
| 「多收三条非攻击」只给了合计                      | 合计 66 例看不出是哪一条贡献的，而其中一条正是待裁定的候选                                        | 拆成三次 → 30 / 12 / **24**           |

#### 本批新增的盲区

| 盲区                                                                                                       | 例数 | 分类                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 两只怪的全部 asc 分档（重抽 38 / 乱抽 9 / 挥击 16+18 / 萎缩 12 / 时候到了 40）与第二组血量区间（`hpHigh`） | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错。**本批同样没写 `hpHigh`**（`data-tables.test.ts` 有一条用例守着） |
| `monsterTurnRamp` 的 **`cap`**                                                                             | 0    | **盲区（分母不够）**：这个编队最长 7 回合，`min` 左边最大才 2。关门条件是更耐打的编队                                                  |
| `monsterTurnRamp` 的**负数分支**                                                                           | 0    | **结构性盲区**：意图早一个怪物回合定下来，执行时那一项恒 ≥ 0。任何编队都关不掉（这是那道门的形状决定的）                               |
| 缓慢倍率在乘法链上的**位置**                                                                               | 0    | **等价改写（当前语料）**：巨头身上没有飞行 / 虚无缥缈。关门条件是「一只同时带缓慢与飞行的怪」——参考里没有                              |
| 缓慢 +1 与 `purgeOnUse` 提前返回的**相对位置**                                                             | 0    | **盲区（分母为 0）**：牌组里没有二连击。关门条件是「带二连击的牌组」                                                                   |
| 反应 / 缓慢读 `arr[0]` 这件事                                                                              | 0    | **探针无效（结构性）**：两个宿主都只出现在**单怪**编队里，与激怒 / 尖锐外壳那两条同族且更彻底                                          |
| ~~植入那条 `if (!hasRelic<OMAMORI>()) { if (hasRelic<DARKSTONE_PERIAPT>()) increaseMaxHp(6); }`~~          | 0    | ✅ **第四十批关掉**（`writhing_mass@relic2` / `@relic3` 那对只差一颗御守的 A/B，逐行 diff 67 / 120 条不同）                            |

#### 三条给下一个人的结论

1. **⚠⚠ 量出 0 例之后，先问一句「我改的那一行真的会被读到吗」——本批有四条第一版探针是无效的。**
   最隐蔽的一条是「把外层门 `malleable || reactive` 改窄成 `malleable`」：蠕动血块**恒有易塑**，
   所以外层门照样为真、内层的反应分支照跑，改动**落在了一个恒真的条件上**。
   `git diff --stat` 非空、代码也确实被执行了，可那一处**在这个宿主身上没有判别力**。
   判据比「diff 非空」强一层：**改完先问「这个条件在本批的宿主身上会不会取到另一个值」**。
2. **「意图早一个怪物回合定下来」这一格要算进边界推理里。** 巨头的「时候到了」按字面读
   第一击应该是 25（`min(4-5, 6) * 5 == -5`），可**出招门读的是滚意图那一刻的回合数、
   伤害成长读的是执行那一刻的**，差一个怪物回合 → 实际最小是 30。
   任何「门与效果读同一个计数器」的地方都要重走一遍这个推理。
3. **`setHasStatus(true) + setStatus(0)` 是开局 Power 的第三种写法，两条后果都致命。**
   ① 这条 Power 平时**不进快照**（层数 0 被两侧折叠），所以「开局那一帧看不见它」是**正常的**，
   不要据此以为没上上去；② **所有读点必须用 `hasStatus`**，写成「层数 > 0」它一次都触发不了
   （实测两条门各红 120 例）。参考在别处一律写 `buff<X>(n)`，只有这两只怪是这个形状。

### 第三十四批：第三幕的两条死亡 / 回合边界机制（暗影客 / 复形怪）

#### 数据规格与体积

| 项        | 值                                                                                       |
| --------- | ---------------------------------------------------------------------------------------- |
| harness   | 第四个乘积 `act3Variants` 里追加的 **variant 34**（variant 33 的 encounters 一个字没动） |
| 牌组      | `BATCH_1 + SPOT_WEAKNESS`（与 variant 24~33 逐字节相同）                                 |
| 种子 / 层 | 40 / `{1,3,7}`                                                                           |
| 爬升度    | **0**；目标策略 **0**                                                                    |
| 编队      | `three_darklings` / `transient`                                                          |
| 例数      | 240（2 × 120），对拍 30466 → **30706**                                                   |
| 体积      | **7.4MB**（5.2 + 2.2MB），仓库 581MB → **589MB**，文件数 107 → **109**                   |
| 扰动      | `git status -- test/golden/traces` **只有 2 个 `??`、零个 `M`**                          |

⚠ **本批动了 harness 的快照格式**（怪物侧新增 `halfDead`，**只在为真时输出**），
所以「零个 `M`」这一行比往常更重要：它就是「107 个既有文件逐字节不变」的凭证。

覆盖表（六条新招式**出现 / 执行**都非 0）：

| 招式                   | 出现 | 执行 | 招式               | 出现 | 执行 |
| ---------------------- | ---: | ---: | ------------------ | ---: | ---: |
| `DARKLING_NIP`         | 6214 | 1122 | `DARKLING_CHOMP`   | 2230 |  415 |
| `DARKLING_HARDEN`      | 4659 |  801 | `DARKLING_REGROW`  | 1297 |  625 |
| `DARKLING_REINCARNATE` | 2634 |  508 | `TRANSIENT_ATTACK` | 2931 |  586 |

⚠⚠ **后两条差点被工具误判成「执行 0」**：`check-coverage.mjs` 的「执行」栏只放行
`m.alive`，而重生 / 复活**只可能出现在半死的怪身上**（`alive` 为假）。修法不是把它们从
`--moves` 里拿掉，而是让 harness 多输出一个 `halfDead`、把那道门改成与
`MonsterGroup::doMonsterTurn` 同形。这是那个工具的**第三个**已知缺口，见 WORKFLOW。

#### 先量局面，再量变异

| 事实                                       | 数值                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 出现过半死的 trace                         | **120 / 120**                                                                                                                                                              |
| 复活总次数 / 单条最多                      | **508 次** / **12 次**（= `DARKLING_REINCARNATE` 的执行数，两个来源对得上）                                                                                                |
| 单条 trace 的复活次数分布                  | 1×8 / 2×19 / 3×21 / 4×23 / 5×17 / 6×16 / 7×9 / 8×4 / 9×1 / 10×1 / 12×1                                                                                                     |
| 进入半死那一刻场上的活怪数                 | 0 只 ×4 / 1 只 ×347 / 2 只 ×356                                                                                                                                            |
| 三暗影客的结局                             | 胜 **84** / 负 **36**                                                                                                                                                      |
| ⚠⚠ 获胜时场上**仍有半死的暗影客**          | **84 / 84** —— 判胜那条 `return` 抢在重生之前的**直接证据**                                                                                                                |
| 「中间那只」（1 号位）出过啃食             | **0 次**（0 号位 261 / 2 号位 346）—— `idx != 1` 那道门的直接证据                                                                                                          |
| 三暗影客的战斗长度                         | 4~~18 回合，均值 **9.3**（第三十三批那三个单怪编队是 3~~7）                                                                                                                |
| 复形怪的消逝层数序列                       | `5,4,3,2,1,—` ×106 / `5,4,3,2,1` ×14                                                                                                                                       |
| 复形怪的结局                               | 负 **82** / 胜 **38**                                                                                                                                                      |
| ⚠⚠ 消逝归零 **106** 条，判胜只有 **38** 条 | 差的 **68** 条是「第 5 击打死了玩家 → 主循环跳出 → **入队**的自杀永远轮不到」，而**同步**的收尾（掷 aiRng、减消逝）已经跑完 —— 「效果入队 + 收尾同步」这一族最厚的一次背书 |
| 复形怪的力量为负的帧 / 最低值              | **1829 帧** / **−90**（枷锁峰值同为 90）                                                                                                                                   |
| 玩家把 999 血的复形怪打死                  | **0 次**（38 场胜利全部来自消逝归零自杀）                                                                                                                                  |

#### 变异测试（30706 例基线，括号内为失败例数）

**暗影客 · 数值与建怪：**

| 变异                                            |    例数 | 判读                                                             |
| ----------------------------------------------- | ------: | ---------------------------------------------------------------- |
| `construct` 的 `miscInfo` 掷骰整条去掉          | **120** | = 这个编队的**全部**。它是 `Monster::construct` 里第二个怪种特例 |
| `miscInfo` 区间 7~~11 → 9~~13（asc2 档当基础）  | **120** | asc0 那一档的区间                                                |
| `miscInfo` 区间抄成**虱子那组**（5~7）          | **119** | ⚠ 两只怪的区间不同，照搬邻居必错                                 |
| 撕咬改成字面量 8（不读 `miscInfo`）             | **118** | 伤害真的来自出生时那一掷                                         |
| 啃食 8 → 9（旧近似表那个数）                    | **117** | 旧表写的就是 9（高档值）                                         |
| 硬化格挡 12 → 13                                | **120** |                                                                  |
| 硬化格挡的 `sync` 去掉（改入队）                |   **0** |                                                                  |
| 硬化的 asc17 力量条改成无条件（`minAscension`） | **120** | 「多出来的一整条效果」这一族                                     |

**暗影客 · 出招规则：**

| 变异                                        |    例数 | 判读                                                                          |
| ------------------------------------------- | ------: | ----------------------------------------------------------------------------- |
| **去掉 `idx != 1`（三只一样）**             | **116** | ⚠⚠ 全参考项目唯一一条「读自己下标」的出招门。实测 1 号位啃食 **0** 次         |
| `idx != 1` 抄成 `idx != 0`                  | **119** | 反方向也量了                                                                  |
| 首回合分界 50 → 40                          |  **23** | ⚠ 薄但非 0：首回合只有一帧，分母天然小                                        |
| 首回合两支对调                              | **120** |                                                                               |
| `random(40, 99)` 重掷改成钳制（少掷 aiRng） | **118** | ⚠ 那是**一次真的重掷**，不是「把 roll 钳到 40」                               |
| 重掷区间 40~~99 → 0~~99                     | **101** | 区间本身也被钉住（与 `hpDiscardRoll` 那种「白掷」不同，这一掷的**取值被用**） |
| 分界 `myRoll < 70` → `< 60`                 | **109** |                                                                               |
| 硬化门 `lastMove` → `lastTwoMoves`          | **108** | ⚠ 三道门**两种谓词并存**，别统一                                              |
| 撕咬门 `lastTwoMoves` → `lastMove`          | **116** | 同上，反方向                                                                  |
| **递归那一支改成直接出撕咬**（少掷 aiRng）  |  **72** | ⚠ 全参考项目唯一一条**递归**的 `getMoveForRoll`                               |
| 递归改成「只掷一次就当硬化」（保留掷骰）    |  **51** | ⚠ 两个方向各量一次：次数与「真的重跑整条规则」是两件事                        |
| **去掉 `halfDead` 那道门**（永不复活）      | **120** |                                                                               |

**半死 / 重生（本批的头号机制）：**

| 变异                                            |    例数 | 判读                                                                   |
| ----------------------------------------------- | ------: | ---------------------------------------------------------------------- |
| `die` 的 REGROW 分支整条去掉（当真死）          | **120** | 基线                                                                   |
| REGROW 分支不 `resetAllStatusEffects`           | **120** | 力量 / 格挡 / 减益都得清                                               |
| ⚠⚠ **reset 改成「整条清空」（不留残留数值）**   |  **53** | **这才是「`resetAllStatusEffects` 只清 bit」的证据**，见「待裁定」那条 |
| reset 不清格挡                                  |   **0** |                                                                        |
| reset 时纯 bool 的 Power 也标 cleared（不丢掉） | **120** | 复活那次 `buff<REGROW>()` 会变成「残留 +1」                            |
| reset 时力量也留成 cleared 残留                 |   **0** | 参考对力量是 `setStatus<STRENGTH>(0)`（**真的归零**）                  |
| `doMonsterTurn` 不放行半死的怪                  | **120** | ⚠⚠ `isDeadOrEscaped` 第三位**唯一**与另外两位分岔的地方                |
| 复活血量 `maxHp / 2` → `maxHp`                  | **120** |                                                                        |
| 复活不 `++monstersAlive`                        | **114** |                                                                        |
| 复活不重新 `buff<REGROW>`（第二次死亡变真死）   | **120** | ⚠ `resetAllStatusEffects` 把 REGROW 自己也清掉了，必须补回来           |
| 复活不置回 `halfDead = false`                   | **120** |                                                                        |
| 重生收尾 同步 `rollMove` → 入队 `no_op_roll`    | **120** | noOp 不 setMove，于是「复活」永远滚不出来                              |

**复形怪：**

| 变异                                          |    例数 | 判读                                                                                            |
| --------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------- |
| `hpNoRoll` 去掉（当普通怪掷一次）             | **120** | 与球状守卫者 / 大嘴同理：多掷一次 → 此后 `monsterHpRng` 整体错位                                |
| 消逝层数 5 → 6（把 asc17 档当基础）           | **120** | asc0 档                                                                                         |
| 开局不上 SHIFTING                             | **120** | 基线                                                                                            |
| `attacked` 那条链上的变换整条去掉             | **120** | 基线                                                                                            |
| 变换只减力量、不加枷锁（回合末不归还）        | **120** | 两句缺一不可                                                                                    |
| 变换只加枷锁、不减力量                        | **120** | 反方向                                                                                          |
| ⚠ **`damage` 那条路上的独立 `if` 去掉**       |  **60** | **非攻击伤害照样触发变换**（青铜鳞片的荆棘反伤走 `Monster::damage`）——与蜷缩 / 镀甲那族正相反   |
| 伤害成长步长 10 → 0（伤害恒 30）              | **120** |                                                                                                 |
| 成长公式漏掉 `-1`（30 + 10×回合数）           | **120** |                                                                                                 |
| 起点 30 → 40（把 asc2 档当基础）              | **120** | asc0 档                                                                                         |
| 自杀门 `equals 1` → `0`                       |  **38** | = 那 38 场胜利。层数为 0 时条目已被摘除，门永不成立                                             |
| 自杀门整条去掉（每次出手都自杀）              | **120** |                                                                                                 |
| 自杀 `triggerRelics` false → true（走死亡链） |  **38** |                                                                                                 |
| 收尾的 `noOpRollMove` 去掉（少掷 aiRng）      | **120** |                                                                                                 |
| ⚠⚠ **收尾的 `noOpRollMove` 改成入队**         |  **82** | **「效果入队 + 收尾同步」这一族最厚的一次背书**（工头 5 例 / 爆破怪 20 例 / 冠军 375 例的同族） |
| 收尾的消逝递减去掉                            | **120** |                                                                                                 |
| 消逝归零后不摘除条目                          |   **0** |                                                                                                 |
| 「打不赢了」判负门的复形怪例外去掉            |   **0** |                                                                                                 |
| 出招改成同步真 `rollMove`（每回合重滚意图）   |   **0** |                                                                                                 |

**`isMonsterAttacking` 两个方向（第二十四批立的规矩，照办）：**

| 变异                         |     例数 | 判读                                                     |
| ---------------------------- | -------: | -------------------------------------------------------- |
| 谓词恒真（**全库**）         | **2637** | 全语料数字（第三十三批是 2594），只能用来判「不是 0」    |
| **白名单漏掉本批三条攻击招** |  **159** | ⚠ **本批的增量背书在这个方向上**                         |
| **白名单多收本批三条非攻击** |   **43** | ⚠ 反方向也量了：硬化 / 重生 / 复活**确实不该在**白名单里 |

**0 例的（逐条分三类）：**

| 变异                                        | 例数  | 分类与理由                                                                                                                                                                                                      |
| ------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 变换在 else-if 链上的**位置**（挪到第一格） | **0** | **结构性盲区**：全参考项目只有复形怪带 SHIFTING，而它身上**没有链上前七位中的任何一位**（无敌 / 镀甲 / 蜷缩 / 飞行 / 易塑+反应 / 荆棘 / 沉睡）——没有任何编队能分辨。与第三十二批荆棘那一格同族                  |
| 「打不赢了」判负门的复形怪例外去掉          | **0** | **盲区（分母为 0）**：复形怪的仗只有 **3~4 回合**，22 张牌根本打不空三个牌堆，那道门一次都没被走到。关门条件是「一副能自己把牌打光的牌组」（净化 / 恶魔烈焰那一族）                                             |
| 硬化格挡的 `sync` 去掉（改入队）            | **0** | **等价改写**，第二十六批那条判据的直接应用：**这条 case 的效果全是同步的**，最后一句改成入队后队列里就它一条，立刻出队；而收尾的 `getMoveForRoll` 不读格挡                                                      |
| 复活收尾 同步 `rollMove` → 入队 `"roll"`    | **0** | **等价改写**，同上（复活那条 case 五句全同步）。⚠ 注意它与「改成 `{setMove}`」不同——那样会少掷一次 aiRng                                                                                                        |
| `halfDead` 门挪到 `firstTurn` 之前          | **0** | **等价改写（结构性）**：`firstTurn()` 只在 `MonsterGroup::init` 那一次 rollMove 为真，而那一刻不可能有半死的怪                                                                                                  |
| REGROW 分支 `setMove` → `overwriteMove`     | **0** | **等价改写（结构性）**：差别只在 `moveHistory[1]`（不在快照里），而紧接着那次 `rollMove` 走的是 `halfDead` 那道门（**不读历史**），它的 `setMove` 又立刻把 `[1]` 写回重生——两种写法在任何谓词读到之前就重新收敛 |
| `resetAllStatusEffects` 不清格挡            | **0** | **等价改写（结构性）**：能进 `die` 就说明这一击已经打穿了格挡，`block` 那时**必然已经是 0**                                                                                                                     |
| reset 时力量也留成 cleared 残留             | **0** | **等价改写（当前语料）**：asc0 的暗影客力量**恒为 0**（+2 那条是 asc17 档，它也不带枷锁 / 变换）。asc17 或「暗黑镣铐 + 重生」的组合下这一条就会分岔                                                             |
| 消逝归零后不摘除条目（`statusBits` 不清）   | **0** | **等价改写**：层数 0 的条目两边都被过滤掉（harness 的 `getStatusInternal` 返回 0、我们的 `powersOf` 滤 `amount !== 0`），而消逝唯一的读者是 `== 1` 那道门                                                       |
| 收尾两句顺序对调（先减消逝、后掷 aiRng）    | **0** | **等价改写**：`noOpRollMove` 不读消逝。⚠ 照抄参考的顺序（先掷后减）                                                                                                                                             |
| 复形怪出招改成同步真 `rollMove`             | **0** | **等价改写（结构性）**：它只有一招，重滚出来还是同一个意图、aiRng 次数也相同；差别只在 `moveHistory` 前移，而**没有任何东西读它**                                                                               |

⚠ **本批 11 条 0 例里没有「探针无效」那一类**：9 条等价改写、1 条结构性盲区、1 条分母为 0 的盲区。
每一条的 `git diff --stat` 都非空（跑批脚本每次都打印），所以「改动没落在被测路径上」这种
第三十二 / 三十三批复核方踩过的坑本批没有重演。

#### 本批新增的盲区

| 盲区                                                                       | 例数 | 分类                                                                       |
| -------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| 暗影客硬化的 asc17 力量条（+2）/ 撕咬的 asc2 加成（+2）/ 啃食 asc2 档（9） | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错        |
| 暗影客的 `miscInfo` asc2 区间（9~13）/ 第二组血量区间（`hpHigh`）          | 0    | 同上——**本批同样没写** `hpHigh`（`data-tables.test.ts` 有一条用例守着）    |
| 复形怪消逝的 asc17 档（6）/ 重殴起点的 asc2 档（40）                       | 0    | 同上                                                                       |
| 变换在 `attackedUnblockedHelper` else-if 链上的**位置**                    | 0    | **结构性盲区**，见上表：全参考项目只有一个宿主，且它不带链上其余任何一位   |
| 「打不赢了」判负门的复形怪例外                                             | 0    | **盲区（分母为 0）**：关门条件是「一副能把三个牌堆打光的牌组」             |
| ~~贤者之石给复活的暗影客 +1 力量（`MonsterSpecific.cpp:1494-1496`）~~      | 0    | ✅ **第四十批关掉**（`three_darklings@relic1`，120 条里 114 条走到过复活） |

#### 三条给下一个人的结论

1. **`resetAllStatusEffects` 与 `removeStatus` 在参考里是两种语义，别当同义词。**
   前者**只清 `statusBits`**，那些具名 int 字段原样留着，下一次 `buff` / `addDebuff`
   会从残留值继续加（实测 53 例）。这一条不是「多一层虚弱」的小事——它是本批**第一条红掉的
   trace**，而且靠肉眼读代码很难发现：两句话看起来都是「把状态清掉」。
   **判据：看那一处写的是哪个函数，别看「Power 消失了」这个现象。**
2. **覆盖工具报 0 时，先问「这个招式的宿主在快照里长什么样」。** `DARKLING_REGROW` /
   `DARKLING_REINCARNATE` 被报成「执行 0」，根因是「执行」栏只放行 `m.alive`，而这两条
   **只可能出现在半死的怪身上**。修法是让 harness 多输出一个 `halfDead`
   （只在为真时输出 → 既有文件逐字节不变），而不是把它们从 `--moves` 里拿掉。
   这是那个工具的**第三个**已知缺口，前两个是「死怪的意图」（第二十六批）与
   「状态牌没有升级形态」（第十三批）。
3. **「多怪 + 会复活」的编队体积是单怪的两倍。** `three_darklings` 一份 5.2MB、
   战斗均长 9.3 回合（第三十三批那三个单怪是 3~~7 回合）。排后面的批次时按 3~~5MB 估，
   别再照搬「2.5MB 一个编队」。

### 第三十三批：第三幕三个单怪编队（暗球游荡者 / 尖塔增生 / 大嘴）

#### 数据规格与体积

| 项        | 值                                                                                       |
| --------- | ---------------------------------------------------------------------------------------- |
| harness   | 第四个乘积 `act3Variants` 里追加的 **variant 33**（variant 32 的 encounters 一个字没动） |
| 牌组      | `BATCH_1 + SPOT_WEAKNESS`（与 variant 24~32 逐字节相同）                                 |
| 种子 / 层 | 40 / `{1,3,7}`                                                                           |
| 爬升度    | **0**；目标策略 **0**                                                                    |
| 编队      | `orb_walker` / `spire_growth` / `maw`                                                    |
| 例数      | 360（3 × 120），对拍 30106 → **30466**                                                   |
| 体积      | **7.4MB**（1.7 + 2.4 + 3.3MB），仓库 574MB → **581MB**，文件数 104 → **107**             |
| 扰动      | `git status -- test/golden/traces` **只有 3 个 `??`、零个 `M`**                          |

覆盖表（九条新招式**出现 / 执行**都非 0）：

| 招式                        | 出现 | 执行 | 招式                 | 出现 | 执行 |
| --------------------------- | ---: | ---: | -------------------- | ---: | ---: |
| `ORB_WALKER_LASER`          | 1248 |  204 | `ORB_WALKER_CLAW`    | 1033 |  166 |
| `SPIRE_GROWTH_QUICK_TACKLE` | 1590 |  308 | `SPIRE_GROWTH_SMASH` |  983 |  220 |
| `SPIRE_GROWTH_CONSTRICT`    |  796 |  137 | `THE_MAW_ROAR`       |  947 |  120 |
| `THE_MAW_DROOL`             | 1435 |  326 | `THE_MAW_NOM`        | 1354 |  323 |
| `THE_MAW_SLAM`              |  938 |  219 |                      |      |      |

#### 先量局面，再量变异

| 事实                        | 数值                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------- |
| 缠绕在一条 trace 里执行几次 | 0 次 **5** 条 / 1 次 **93** 条 / **2 次 22 条**                                    |
| 「两次缠绕」与神器的关系    | **22 / 22 全部有神器**（无神器却两次的：**0** 条）                                 |
| 玩家吃到束缚的 trace        | 110 / 120；束缚层数峰值 **10**（不叠、不掉）                                       |
| 吞噬执行时的段数分布        | 1 段 54 / 2 段 77 / 3 段 80 / 4 段 83 / 5 段 28 / **6 段 1**                       |
| 大嘴的结局                  | 胜 **6** / 负 **114**（120 条）——所以它是「玩家死得多」那一族                      |
| 大嘴力量峰值                | **12**（流涎每次 +3）                                                              |
| 暗球游荡者的力量序列        | 3, 6, 9, 12, 15, 18, **21** —— 每个回合末 +3、一层不掉，`GENERIC_STRENGTH_UP` 恒 3 |
| 灼伤真的被抽进过手牌        | **95 / 120** 条 trace、**520 帧**（所以「洗进抽牌堆」这一路不只是牌堆快照）        |
| 暗球游荡者的结局            | 玩家阵亡 **1 / 120**                                                               |

⚠⚠ **第一、二行是本批最值得记的一条**：出招规则里那道 `!player.hasStatus<CONSTRICTED>()`
按字面读是「一场仗最多缠一次」，可实测有 **22 条 trace 缠了两次**——`Player::debuff` 的
**神器门排在写 `statusMap` 之前**（`Player.h:371-374`），第一次缠绕被神器整个吃掉，
`hasStatus` 于是仍然为假。**「理论上只能一次」的门要去数据里数一遍**；正是这个局面让那道门
的两个方向都拿到了背书（去掉它红 89 例、去掉「刚缠绕过」红 16 例）。

#### 变异测试（30466 例基线，括号内为失败例数）

**暗球游荡者：**

| 变异                                              |    例数 | 判读                                                                                                                                                          |
| ------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hpDiscardRoll` 整条去掉（少掷一次 monsterHpRng） | **120** | = 这个编队的**全部**。次数是钉死的                                                                                                                            |
| 开局 `GENERIC_STRENGTH_UP` 整条去掉               | **120** | 全参考项目唯一的宿主，基线                                                                                                                                    |
| 层数 3 → 5（把 asc17 档当基础）                   | **120** | asc0 那一档的数值                                                                                                                                             |
| 回合末 GSU 结算整条去掉                           | **120** | `applyEndOfRoundPowers` 最后那句真的跑                                                                                                                        |
| **给 GSU 补上仪式那种 skipFirst**                 | **120** | ⚠⚠ **这才是「它不是仪式」的证据**：参考那行注着 `// todo just merge this with orb walker strength up`，两者只差 skipFirst 与位置，而 skipFirst 是**可观察**的 |
| 激光两张灼伤都塞弃牌堆（少掷 cardRandomRng）      | **112** | 「两张去两个不同的牌堆」                                                                                                                                      |
| 激光伤害 10 → 11                                  |  **93** | asc0 档                                                                                                                                                       |
| 利爪伤害 15 → 16（旧近似表那个错）                | **103** | 旧表写的就是 16                                                                                                                                               |
| 出招 `lastTwoMoves` → `lastMove`                  |  **97** | 两招各自都能连出两次                                                                                                                                          |
| 出招分界 `roll < 40` → `< 50`                     |  **24** | ⚠ 薄但非 0：40 不是直觉上的 50                                                                                                                                |

**尖塔增生与束缚：**

| 变异                                   |    例数 | 判读                                                                         |
| -------------------------------------- | ------: | ---------------------------------------------------------------------------- |
| 束缚回合末伤害整条去掉                 | **104** | 基线                                                                         |
| **束缚回合末递减一层**                 | **104** | ⚠ 「不递减」这件事是可观察的（参考那条 case 只有伤害一句）                   |
| 束缚伤害改成不过格挡（`playerLoseHp`） |  **27** | `Actions::DamagePlayer` 走 `Player::damage`，格挡照吃                        |
| 缠绕层数 10 → 12（把 asc17 档当基础）  | **110** | asc0 档                                                                      |
| 出招去掉「玩家已有束缚」那道门         |  **89** | ⚠ 它的可观察性靠的是**神器**那 22 条，见上                                   |
| 出招去掉「刚缠绕过」那道门             |  **16** | ⚠ 薄。两道门当前几乎同解，**必须各量一次**（同族先例：`MINION_LEADER` 4 例） |
| 出招 `roll >= 50` → `roll < 50`        | **120** | 全灭                                                                         |
| 出招 `lastTwoMoves` → `lastMove`       | **105** | 后两道门的谓词                                                               |
| 出招兜底 急冲 → 重砸                   |  **17** | 薄但非 0                                                                     |
| 急冲 16 → 18 / 重砸 22 → 25            | 119/116 | asc0 档                                                                      |
| **重砸加回旧近似表那层虚弱**           | **116** | ⚠ 旧表凭空多出来的那条效果真的会被看见                                       |

**大嘴：**

| 变异                                        |    例数 | 判读                                                            |
| ------------------------------------------- | ------: | --------------------------------------------------------------- |
| `hpNoRoll` 去掉（当普通怪掷一次）           | **120** | 与球状守卫者那次同理：多掷一次 monsterHpRng → 此后整体错位      |
| 吞噬段数写死 3（旧近似表那个数）            | **106** | 段数真的随回合涨                                                |
| 吞噬段数公式漏掉 `+1`                       |  **67** | ⚠ `(t+1)/2` 与 `t/2` 只在**奇数回合**分岔，所以是 67 而不是 106 |
| 吞噬收尾抄成 `no_op_roll`（丢掉 `setMove`） | **119** | 流涎唯一的强制来源                                              |
| 吞噬收尾抄成纯 `setMove`（少掷一次 aiRng）  | **119** | 「setMove + noOpRollMove」这一族的两个方向各量一次              |
| 流涎收尾 同步真 `rollMove` → `no_op_roll`   | **120** | 「真滚一个新意图」                                              |
| 咆哮收尾 同步真 `rollMove` → `no_op_roll`   | **120** | 同上                                                            |
| 咆哮的虚弱与脆弱**顺序对调**                |  **28** | ⚠ 薄但非 0——两条都被神器拦时，先上哪个决定了哪个被吃掉          |
| 流涎力量 3 → 5（把 asc17 档当基础）         | **120** | asc0 档                                                         |
| 重击 25 → 30                                | **112** | asc0 档                                                         |
| 出招 `lastMove` → `lastTwoMoves`            |  **67** | ⚠ 大嘴三道门**全是 `lastMove`**，与隔壁两只怪不同               |

**`isMonsterAttacking` 两个方向（第二十四批立的规矩，照办）：**

| 变异                         |     例数 | 判读                                                                                                    |
| ---------------------------- | -------: | ------------------------------------------------------------------------------------------------------- |
| 谓词恒真（**全库**）         | **2594** | 全语料数字（第三十二批是 2513），只能用来判「不是 0」                                                   |
| **白名单漏掉本批五条**       |  **193** | ⚠ **本批的增量背书在这个方向上**                                                                        |
| **白名单多收本批三条非攻击** |   **81** | ⚠ 反方向也量了：缠绕 / 咆哮 / 流涎**确实不该在**白名单里，与「走没走 `attackPlayerHelper`」这条判据一致 |

**0 例的（逐条分三类）：**

| 变异                                      | 例数  | 分类与理由                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hpDiscardRoll` 的**区间**抄成高档        | **0** | **结构性不可观测**（第二十七批已证）：取值被丢弃，而 `Random::nextLong(n)` 的前进步数与 n 无关。**次数**有背书（120 例），区间没有、也不可能有。别当盲区去找逃生口                                                                                                       |
| 激光两张灼伤的**顺序**对调                | **0** | **等价改写**：洗抽牌堆那条读 `drawPile.size()`、塞弃牌堆那条只 append 到弃牌堆，两条互不影响，`cardRandomRng` 的取值一模一样                                                                                                                                             |
| GSU 结算挪到 `applyEndOfRoundPowers` 最前 | **0** | **等价改写（当前语料）**：当前没有一只怪同时带仪式与它，中间隔着的虚弱 / 易伤递减也不读力量。⚠ 位置照抄（参考写在最后一句）                                                                                                                                              |
| 束缚结算挪到玩家 Power 枚举序**最末**     | **0** | **等价改写（当前牌组）**：`applyEndOfTurnPowers` 那个循环里，这副 22 张牌组能命中的**只有束缚一条**（没有缠绕 / 灵活 / 燃烧 / 二连击 / 暴怒），根本没有东西可以与它换序                                                                                                  |
| 缠绕的 `sync: true` 去掉（改入队）        | **0** | **等价改写**：这条 case 的收尾是 `addToBot(RollMove)`，把 debuff 也入队之后队列是 `[debuff, RollMove]`——debuff 照旧排在前面，而出招规则正是在 RollMove 里读它的                                                                                                          |
| 咆哮收尾 同步 `rollMove` → 入队 `"roll"`  | **0** | **等价改写**，正是第二十六批那条判据的教科书例子：这条 case 的效果**全是同步的**，最后一句改成入队后队列里就它一条，立刻出队                                                                                                                                             |
| 咆哮两个减益的 `sync` 去掉（改入队）      | **0** | **等价改写（当前语料）**，但**理由与上一行不同**：这样改会让同步的 `rollMove` 抢在减益之前跑，而**大嘴的出招规则不读玩家状态**。⚠ 同一处改动在尖塔增生身上不成立（它的规则读束缚）                                                                                       |
| 流涎的自身 buff 同步 → 入队               | **0** | **等价改写**，与第三十批「自身 buff 的同步 ↔ 入队当前全是等价改写」一致                                                                                                                                                                                                  |
| 出招给重击补上 `!lastMove(NOM)`           | **0** | **等价改写，而且参考自己注明了理由**：`// dont include not last move nom condition, because it can't be, we handle in the move logic`——吞噬的收尾 `setMove(DROOL)` 让「上一招是吞噬」这个局面在这里结构上不可能出现。⚠ **本项目第一次遇到「参考的注释直接解释了 0 例」** |

⚠ **本批九条 0 例里没有「探针无效」那一类**：一条是结构性不可观测、八条是等价改写。
⚠ **也没有「分母太薄」的 0 例**——薄的几条（出招分界 24 / 兜底 17 / 「刚缠绕过」16 /
咆哮换序 28）都落在了非 0 上。

#### 本批新增的盲区（都是「只做 asc0」这一维）

| 盲区                                                                      | 例数 | 分类                                                                    |
| ------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------- |
| `GENERIC_STRENGTH_UP` 的 asc17 档（5）                                    | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错     |
| 缠绕层数的 asc17 档（12）/ 咆哮的 asc17 档（5）/ 流涎的 asc17 档（5）     | 0    | 同上                                                                    |
| 三只怪的 `asc2` 伤害档（激光 11 / 利爪 16 / 急冲 18 / 重砸 25 / 重击 30） | 0    | 同上                                                                    |
| 尖塔增生出招规则的 `asc17 \|\|` 那一半（高层数不看 roll）                 | 0    | 同上                                                                    |
| 三只怪的第二组血量区间（`hpHigh`）                                        | 0    | 同上——**本批同样没写** `hpHigh`（`data-tables.test.ts` 有一条用例守着） |
| `hpDiscardRoll` 的**区间**（不是次数）                                    | 0    | **结构性不可观测**，见上表，不是盲区                                    |

#### 三条给下一个人的结论

1. **「理论上只能触发一次」的门，去数据里数一遍。** 尖塔增生的缠绕本该一场一次，实测
   22 / 120 条出了两次——全部是**神器把第一次吃掉**的那些。这个局面顺手给那道门的两个方向
   都补上了背书；没有它，「去掉这道门」很可能就是又一条薄到 0 的探针。
2. **「同步 ↔ 入队」0 例的理由可以逐条不同，别只写「等价改写」四个字。** 本批三条 0 例
   分别是：队列顺序恰好保住了相对次序（缠绕）、这条 case 全同步（咆哮收尾）、
   **读的人不读那个字段**（咆哮的减益）。第三种在隔壁那只怪身上就不成立。
3. **参考的注释有时直接给出 0 例的答案。** 大嘴出招规则里那句
   `// dont include not last move nom condition, because it can't be` 就是作者在说
   「这个分支结构上不可达」——量出 0 例之后先回去看一眼有没有这种注释，
   比自己推一遍快得多，也不会误判成盲区。

### 第三十二批：第三幕开张（三个「形状怪」编队 / 三只新怪）

#### 两步验证的实测（**第一步不能跳**）

- **第一步（只加空乘积、`act3Variants` 留空）**：`tools/regen-traces.sh --check` →
  **101 个文件逐字节复现**，一条 `✗` 都没有。与基线那次的输出**逐行相同**，唯一的差别是
  参考仓库有未提交改动时的那句 `⚠` 警告。这就是「第四个乘积对既有语料是空操作」的凭证。
- **第二步（加 variant 32）**：
  `--install --moves EXPLODER_SLAM EXPLODER_EXPLODE REPULSOR_BASH REPULSOR_REPULSE SPIKER_CUT SPIKER_SPIKE`
  通过；装完 `git status -- test/golden/traces` 只有 **3 个 `??`**、**零个 `M`**。

#### 数据规格与体积

| 项        | 值                                                                          |
| --------- | --------------------------------------------------------------------------- |
| harness   | 第四个乘积 `emitProduct(act3Variants, act3Encounters)`，里面只有 variant 32 |
| 牌组      | `BATCH_1 + SPOT_WEAKNESS`（与 variant 24~31 逐字节相同）                    |
| 种子 / 层 | 40 / `{1,3,7}`                                                              |
| 爬升度    | **0**；目标策略 **0**（两条轴都不叠加）                                     |
| 编队      | `three_shapes` / `four_shapes` / `sphere_and_two_shapes`                    |
| 例数      | 360（3 × 120），对拍从 29746 涨到 **30106**                                 |
| 体积      | **8.4MB**（三个文件 2.49 + 2.94 + 3.40MB），仓库总量 566MB → **574MB**      |

覆盖表（六条新招式**出现 / 执行**都非 0）：

| 招式            | 出现 | 执行 | 招式               | 出现 | 执行 |
| --------------- | ---: | ---: | ------------------ | ---: | ---: |
| `EXPLODER_SLAM` | 6621 |  534 | `EXPLODER_EXPLODE` | 2409 |  158 |
| `REPULSOR_BASH` | 1736 |  157 | `REPULSOR_REPULSE` | 6527 |  741 |
| `SPIKER_CUT`    | 3365 |  378 | `SPIKER_SPIKE`     | 5031 |  621 |

#### 先量局面，再量变异（这一批真的用上了）

| 事实                                     | 数值                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `three_shapes` 出现过「三只同种」        | **0 / 120**（池子每种只有两份，`createShapes` 不放回 → 结构上不可能）                      |
| `sphere_and_two_shapes` 出现「两只同种」 | **42 / 120**（爆破 ×2 22、尖刺 ×2 13、斥力 ×2 7）—— `getAncientShape` **有放回**的直接证据 |
| 爆破怪真的自爆身亡                       | **199 次**（200 条 trace 里出现过自爆意图）                                                |
| 荆棘层数达到封顶 15（= 放满 6 次尖刺）   | **1 / 360 条 trace**                                                                       |
| 荆棘层数上限分布                         | 0:83 / 3:33 / 5:69 / 7:86 / 9:68 / 11:18 / 13:2 / **15:1**                                 |

⚠ **最后两行直接解释了三条「1 例」与一条「0 例」**：尖刺客的封顶逻辑（`miscInfo > 5`）
在整个语料里只被走到**一次**。这不是抄错，是仗不够长——关门条件是「更耐打的编队」这一维
（第三幕后面的精英 / Boss，或者给这三个编队单开一对聚焦 variant）。

#### 变异测试（30106 例基线，括号内为失败例数）

**爆破怪：**

| 变异                                                |    例数 | 判读                                                                                                                                                   |
| --------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 撞击收尾的判据 `lastTwoMoves` → `lastMove`          | **239** | 意图链的核心。抄成 `lastMove` 会提前一整回合自爆                                                                                                       |
| 自爆收尾整条去掉（少掷一次 aiRng）                  | **142** | 同步的 `bc.noOpRollMove()` 真的掷                                                                                                                      |
| 自爆收尾 同步 → 入队 `no_op_roll`                   |  **20** | ⚠ **「效果入队 + 收尾同步」那一族的第三个非 0**（前两个是第二十七批工头 5 例、第二十九批冠军 375 例）：30 点打死玩家 → 主循环跳出 → 入队那次永远轮不到 |
| 自爆两条效果换序（先自杀后打人）                    |  **20** | 顺序钉死。⚠ 与上一行同样是 20 例，机理也相同（打死玩家那一刻）                                                                                         |
| 自爆伤害 `damage_player_non_attack` → `deal_damage` |   **1** | ⚠ **极薄但非 0**：两者只在「玩家带易伤 / 怪有力量 / 玩家带荆棘或火焰屏障」时分岔                                                                       |
| 自杀 入队 → 同步                                    |  **38** | `addToBot(SuicideAction)` 的位置                                                                                                                       |
| 爆破怪血量区间读成 `30~35`（两组当一组）            | **270** | 「先数大括号有几层」那条老教训的又一次背书                                                                                                             |
| **白名单多收 `exploder/exp_explode`**               |  **11** | ⚠⚠ **这是「参考 vs 真实游戏」那处分歧的探针**，见「待裁定」。分歧**真的产生**，不是理论风险                                                            |

**斥力怪：**

| 变异                                           |    例数 | 判读                                |
| ---------------------------------------------- | ------: | ----------------------------------- |
| 出招去掉 `!lastMove(rep_bash)` 那道门          |  **26** | 撞击不许连出                        |
| 斥力洗 2 张 → 1 张                             | **229** | 张数与 `cardRandomRng` 次数一起钉住 |
| 斥力塞去向 `draw` → `discard`（不掷 RNG）      | **229** | 同上，两个方向各量一次              |
| 斥力收尾 同步真 `rollMove` → 入队 `no_op_roll` | **129** | 「真 rollMove」与「掷完丢掉」的差别 |
| 斥力怪血量区间读成 `29~38`（两组当一组）       | **242** | 同爆破怪                            |

**尖刺客与怪物侧荆棘：**

| 变异                                     |    例数 | 判读                                                                 |
| ---------------------------------------- | ------: | -------------------------------------------------------------------- |
| 开局荆棘 3 → 4（asc0 那一档抄成中间档）  | **277** | `PRE_BATTLE_ACTION.spiker` 的基础值                                  |
| 增生尖刺 +2 → +3                         | **244** | 与上一条是**两个独立的字面量**，各量一次                             |
| 荆棘层数读成固定 3（不随尖刺涨）         | **244** | 触发点读的是**当下层数**                                             |
| 整条荆棘触发删掉                         | **277** | 基线：这条 else-if 分支真的被走到                                    |
| 荆棘 `addToTop` → `addToBot`             |  **43** | ⚠ 插队位置真的可观察（多段攻击 / 同回合其它动作）                    |
| 荆棘 `clearOnCombatVictory` false → true |  **68** | ⚠ 打死尖刺客的那一击，反伤**照样落在玩家身上**                       |
| 荆棘伤害改成不过格挡（`playerLoseHp`）   | **234** | `Actions::DamagePlayer` 走 `Player::damage`，格挡照吃                |
| 出招去掉 `miscInfo > 5` 那一半           |   **1** | ⚠ 极薄，见上方「先量局面」：整个语料只有 **1 条** trace 攒满六次尖刺 |
| 封顶阈值 `> 5` → `> 4`                   |   **1** | 同上                                                                 |
| `++miscInfo` 从开场挪到收尾之后          |   **1** | 同上。⚠ 三条都是同一个薄分母，**别把它们当成三份独立背书**           |
| 尖刺客血量区间读成 `42~60`（两组当一组） | **271** | 同爆破怪                                                             |

**建怪（两条抽样路径）：**

| 变异                                                  |    例数 | 判读                                                                    |
| ----------------------------------------------------- | ------: | ----------------------------------------------------------------------- |
| `createShapes` 的整体左移 → 与末位交换                | **158** | 与第十三批史莱姆群那条同族（分布相同、同种子下排列不同）                |
| `createShapes` 的池子顺序改成 3 项表的顺序            | **240** | 池子的**书写顺序**就是下标 → 怪种的映射                                 |
| `getAncientShape` 的 3 项表顺序抄成 `createShapes` 的 | **120** | ⚠ 恰好是 `sphere_and_two_shapes` 的**全部** 120 条                      |
| `sphere_and_two_shapes` 改用 `createShapes`（不放回） | **107** | ⚠⚠ **「照搬邻居」的那个典型错误真的红**——这就是三个编队必须一起装的理由 |
| `sphere_and_two_shapes` 球状守卫者放在最前            | **120** | 位置有语义（它是 `hpNoRoll`，顺序一换 monsterHpRng 整体错位）           |
| `four_shapes` 抽 4 只 → 3 只                          | **120** | 只数                                                                    |

**`isMonsterAttacking` 两个方向（第二十四批立的规矩，照办）：**

| 变异                 |     例数 | 判读                                                                                                                               |
| -------------------- | -------: | ---------------------------------------------------------------------------------------------------------------------------------- |
| 谓词恒真（**全库**） | **2513** | ⚠ 这是全语料的数字，**没有**逐批分解过（历史上量到的 294 / 776 是当时的全库值，语料一直在长），所以它只能用来判「不是 0」          |
| 白名单漏掉本批三条   |   **86** | ⚠ **这一条才是本批的增量背书**，与第二十五批带壳寄生虫、第二十七批奴隶主那两次的教训一致：**两个方向都要量，本批的证据在反方向上** |

**0 例的（逐条分三类）：**

| 变异                                                    | 例数  | 分类与理由                                                                                                                                                                                       |
| ------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 撞击收尾的 `noOpRollMove` 同步 → 入队                   | **0** | **结构性盲区（分母太薄）**，⚠ **不是等价改写**：机理与自爆那条（20 例）完全相同，只是撞击才 9 点、几乎不会恰好打死玩家。同一只怪的另一条 case 已经证明这一位可观察                               |
| 自杀改走 `damageEnemyNonAttack`（多一次 `checkCombat`） | **0** | **等价改写（当前语料）**：`SuicideAction` 是这条 case 最后一条排队动作，判胜那一刻队列里已经没有别的东西可清。关门条件是「自杀终结战斗时队列里还压着动作」——与孢子云那条同一族的「队列内容」盲区 |
| 斥力的塞牌 同步 → 入队                                  | **0** | **等价改写**：这条 case 的效果**只有它一条**（收尾是同步 rollMove），入队即刻出队；而 `cardRandomRng` 与 `aiRng` 是两条独立的流，交错顺序不影响任一条。判据即第二十六批那条                      |
| 斥力收尾 同步真 `rollMove` → 入队 `"roll"`              | **0** | **等价改写**，同上（对比：改成 `no_op_roll` 红 129 例——被钉住的是「真滚一个新意图」而不是「同步还是入队」）                                                                                      |
| 增生尖刺的 buff 同步 → 入队                             | **0** | **等价改写**，与第三十批实测「自身 buff 的同步 ↔ 入队当前全是等价改写」一致                                                                                                                      |
| 增生尖刺收尾 同步真 `rollMove` → 入队 `"roll"`          | **0** | **等价改写**，同斥力那条                                                                                                                                                                         |
| 出招的括号写错（`\|\|` 与 `&&` 的优先级）               | **0** | **结构性盲区**：两者只在「`miscInfo > 5` **且**上一招是切割」时分岔，而整个语料只有 1 条 trace 走到 `miscInfo > 5`，那一刻上一招恰好不是切割                                                     |
| 荆棘挪到 else-if 链的**第一格**                         | **0** | **结构性盲区**：全参考项目只有尖刺客带 THORNS，而它身上没有无敌 / 镀甲 / 蜷缩 / 飞行 / 易塑中的任何一位——链上的相对位置**没有任何编队能分辨**。⚠ 蠕动血块（易塑 + 反应）也不带荆棘               |

⚠ **本批没有「探针无效」那一类**：八条 0 例里，六条是真的等价改写、两条是分母问题。

#### 三条给下一个人的结论

1. **「亡语」只对应 `Monster::die` 那条链**。爆破怪的爆炸是一条**招式**，被玩家打死的爆破怪
   一点伤害都不造成——旧近似表把它写成 `deathEffects` 是两处都错（时机与触发条件）。
   `EnemyDef.deathEffects` 因此在本批被删掉了。
2. **`isMoveAttack` 收的是「走 `attackPlayerHelper` 的那些招」**。这比第二十三批那条
   「不能从 intent 推」更可操作，而且它当场给出了本项目第一处**可量到的**「参考 vs 真实游戏」
   分歧（爆破怪的自爆，11 例）。抄白名单时按这个反查一遍。
3. **同一族的两条抽样路径必须一起装**。`createShapes`（不放回）与 `getAncientShape`（有放回）
   只装一边，另一边的转写就没有背书——实测「照搬邻居」红 107 例。

### 第三十一批：目标策略这条轴（23 个多怪编队 × `@tgt1`）

**引擎侧一行实现都没有。** 这一批全部的改动在 harness（`DeckVariant.targetPolicy` +
`lastAliveMonster` + 头部字段）、`tools/{split-traces,variant0-rows,regen-traces}` 与两个
测试文件的分组键上。做法与两步验证写在 WORKFLOW「目标策略这条轴」，这里只记数字。

#### 两步验证的实测

- **第一步（只加管线、不加 variant）**：`tools/regen-traces.sh --check` → **78 个文件
  逐字节复现**，一条 `✗` 都没有。这就是「新维度对既有语料是空操作」的凭证，
  跳过它就没有任何东西能证明加轴没把旧数据改坏。
- **第二步（加 variant 31）**：`--install --moves CENTURION_FURY` 通过；
  装完 `git status -- test/golden/traces` 只有 **23 个 `??`**、**零个 `M`**。

#### 数据规格与体积

| 项        | 值                                                                        |
| --------- | ------------------------------------------------------------------------- |
| harness   | 第三个乘积 `emitProduct(tgtVariants, tgtEncounters)`，里面只有 variant 31 |
| 牌组      | `BATCH_1 + SPOT_WEAKNESS`（与 variant 24~30 逐字节相同）                  |
| 种子 / 层 | 40 / `{1,3,7}`                                                            |
| 爬升度    | **0**（两条轴不叠加）                                                     |
| 编队      | **23 个多怪编队**：第一幕 11 + 第二幕 12                                  |
| 例数      | 2760（23 × 120），对拍从 26986 涨到 **29746**                             |
| 体积      | **估算 62.1MB → 实测 58.6MB**（偏差 −5.6%），仓库总量 507MB → **566MB**   |

估算方法：每个编队取已提交的 `variant 0` 前 375 行的字节数 × 40/125。**偏小 5.6% 的方向是
可解释的**——`gremlin_leader` / `collector` 在 tgt1 下直接打首领，`MINION_LEADER` 当场判胜
让仗变短（`gremlin_leader` 估 5.13MB → 实测 3.09MB，是最大的一笔）。

#### 筛掉的 16 个单怪编队（以及为什么）

`lastAliveMonster` 与 `firstAliveMonster` 用**同一个谓词**（`isDeadOrEscaped`）、
**同一个兜底**（`return 0`），所以场上只有一只怪时取到的是同一只——那些 trace 会与已提交的
asc0 那份**逐字节相同**，跑了只是白占体积。

- 第一幕 9 个：`cultist` / `jaw_worm` / `blue_slaver` / `red_slaver` / `looter` /
  `gremlin_nob` / `lagavulin` / `the_guardian` / `hexaghost`
- 第二幕 7 个：`spheric_guardian` / `chosen` / `shell_parasite` / `snecko` / `snake_plant` /
  `book_of_stabbing` / `champ`

⚠⚠ **判据是「场上会不会同时有两只可选目标」，不是「开局有几只」。** 有四个编队开局只有一只
却**必须**算进来，而且它们恰恰是这条轴最想要的局面：`large_slime` / `slime_boss`（分裂，
`largeSlimeSplit` 写母体那格 + 右边一格 / `slimeBossSplit` 写 0 与 2 号位）、
`automaton`（青铜球填 0/2）、`collector`（火炬头填 1/0）。按「开局几只」筛会把它们漏掉。

#### 死亡顺序真的反过来了吗（先量局面，再量变异）

| 编队                         | 局面                     | tgt0          | tgt1               |
| ---------------------------- | ------------------------ | ------------- | ------------------ |
| `centurion_and_healer`       | 秘法师先死               | **0 / 375**   | **119 / 120**      |
| `gremlin_leader`             | 胜利时场上还有活怪       | 4 / 55 次胜利 | **17 / 19** 次胜利 |
| `shelled_parasite_and_fungi` | 真菌兽在同伴还活着时死亡 | 83 / 375      | **120 / 120**      |

⚠ 这三行是**先于变异测试**量的，用途是「变异 0 例时能分清是没走到还是等价改写」。
第三行就派上了用场：孢子云的触发次数涨了一大截，插队顺序**照旧 0 例**——所以那条盲区
卡的不是「同伴先死」。

#### 变异测试（29746 例基线，括号内为失败例数）

**已关掉的（此前 0 例）**：

| 变异                                      |   例数 | 说明                                                                                                       |
| ----------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------- |
| 狂怒连斩每击伤害 6 → 7                    | **91** | 第二十六批以来的头号盲区，本批关门。执行 **127 帧 / 97 条 trace**                                          |
| 狂怒连斩段数 3 → 2                        | **96** | 同上，`deal_damage_multi` 的两个字段各量一次                                                               |
| 狂怒连斩收尾 `roll` → `none`              | **88** | `addToBot(Actions::RollMove(idx))` 那一句                                                                  |
| 攻击白名单去掉 `centurion/cent_fury`      | **23** | 觅敌之弱此前只能看到**尸体**上的这个意图，看不到活百夫长的                                                 |
| 百夫长防守的 `monstersAlive > 1` 门恒真   | **66** | ⚠ 机理比想的细一层：意图是秘法师**还活着**时滚出来的，执行时它已经死了——要的是「滚意图与执行之间同伴死掉」 |
| 秘法师鼓舞的连续限制 `!lastTwoMoves` 去掉 |  **2** | 薄，但关了（tgt0 下 352 次鼓舞里连续两次的有 0 次；tgt1 下 71 次里有 4 次）                                |

**变厚的**：

| 变异                                 |    例数 | 此前                    |
| ------------------------------------ | ------: | ----------------------- |
| 百夫长出招规则 `mysticAlive` 恒真    | **128** | 8                       |
| 去掉 `MINION_LEADER` 那条判胜路径    |  **21** | 4                       |
| 秘法师鼓舞的连续限制抄成 `!lastMove` |  **38** | —（反方向，本批首次量） |

**仍然 0 例的（逐条分类）**：

| 变异                           | 例数  | 分类与理由                                                                                                                                                            |
| ------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 孢子云 `addToTop` → `addToBot` | **0** | **结构性盲区，但根因换了**：亡语触发从 83 / 375 涨到 120 / 120 还是 0——卡的是「那一刻队列里没有别的动作」，**不是**「同伴先死」。第二十五批的裁定成立，这条轴救不了它 |
| 狂怒连斩的 asc2 伤害档 7 → 8   | **0** | **结构性盲区，但关门条件从死结变活**：本批只做 asc0。以前的说法是「这一招的效果在任何档位下都没有预言机」，现在只差 `asc19 × tgt1` 那个组合                           |
| 激怒（地精头目）改成遍历全体   | **0** | 重量第十八批那条，**照旧关不掉**：根是「带激怒的怪不在 0 号位的编队」（`COLOSSEUM_EVENT_NOBS`），与打谁无关——地精头目是单怪编队                                       |
| 尖锐外壳（守卫者）改成遍历全体 | **0** | 重量第十九批那条，同上，而且更彻底：全参考只有守卫者带它、守卫者只出现在单怪编队里                                                                                    |

⚠ **本批没有「探针无效」那一类**：四条 0 例都确实执行到了被改的那段代码。

#### 一条给下一个人的结论

**换轴之前先判一条盲区卡在哪一维上**：回合数（换更耐打的编队）/ 场上局面（换目标策略）/
队列内容（都救不了）。这条轴一次关掉了「场上局面」那一整族，对另外两族一例都没动。

### 第三十批：爬升度铺到第二幕（19 编队 × asc19，第二幕两档全满）

**本批是纯追加，而且连补丁都没有。** `--install` 之前先跑过 `--check`，已提交的
**59 个文件全部逐字节复现**；装完 `git status` 只有 **19 个 `??`**（`<编队>@asc19.jsonl`），
`git diff --stat -- test/golden/traces` **为空**——零个 `M`。参考侧只加了 harness 的
variant 30（commit `93bfa27`），gameplay 代码一行没动，因此**不需要 `ALLOW_CHANGED`**。
总例数 24706 → **26986**（+2280 = 19 × 120）；体积 456MB → **507MB**（+50.6MB）；
文件 59 → **78**。

⚠⚠ **「纯追加」这次有了硬凭证，不只是 `git diff` 为空**：本批把此前五条已量过的变异
**原地重量了一遍，五个数一例不差**——冠军防御姿态阈值 15→30 **224**（第二十九批 224）、
火炬头血量抄成高档组 **375**（375）、秘法师缺血阈值 16→20 **103**（103）、
秘法师法击连续限制 **31**（31）、食蛇草 asc<17 高位那支的谓词 **147**（147）。
既然它们在语料涨了 2280 例之后仍然分毫不动，就说明新增的行**没有触碰**任何旧编队的判定。
（唯一"变了"的是 `isMonsterAttacking` 谓词恒真那条：294 → 776 → **1789**。它不是重量不符，
而是这条变异的分母就是"带觅敌之弱的文件数"，每加一批第二幕文件它都会涨。）

#### 档位为什么只选 19（以及本批**没有**做什么）

这 17 只怪读的爬升度条件全是 `asc >= N`，N ∈ {2,3,4,7,8,9,17,18,19}。一个 19 就取到
每一条的**高侧**，而已提交的 125 种子 asc0 语料本来就钉着低侧——与第二十一 / 二十二批
对第一幕的做法逐字同构，成本可预测（+50MB）。

⚠⚠ **两件事本批明确不做，而且它们要的是「中间的档位」而不是第二个高档位**：

1. **「分界恰好在 N」**——一个档位只能钉住一条分界的一侧。
2. **「三档里的中间那一档」**——`{a,b,c}[getTriIdx(...)]` 在 `{0,19}` 下必然取到 a 或 c。

第二十九批建议过「asc9 单档或 asc19 + asc7」，其中**「asc9 能分开冠军那两族阈值」是错的**，
本批按算法更正：冠军的防御姿态用 `getTriIdx(asc, 9, 19)`、同一只怪的暴怒 / 自夸用
`bossDiffIdx = getTriIdx(asc, 4, 19)`，而

| 档位  | `getTriIdx(asc,9,19)` | `getTriIdx(asc,4,19)` | 分得开吗       |
| ----- | --------------------- | --------------------- | -------------- |
| 0     | 0                     | 0                     | ✗              |
| **7** | 0                     | **1**                 | ✅             |
| **9** | **1**                 | **1**                 | ✗ （都是中间） |
| 16    | 1                     | 1                     | ✗              |
| 19    | 2                     | 2                     | ✗              |

——要分辨阈值是 9 还是 4，档位必须落在 **`[4, 9)`**（asc7 可以）。asc9 两边都返回中间档，
分不开。本批实测印证了这一点：把那一族抄成 `bossDiffIdx`（4/19）**0 例**，
抄成 `hallwayIdx`（2/17）**也 0 例**——在 `{0,19}` 下**三族两两都不可分辨**。

而「中间档」这件事**第一幕也欠着**（第二十二批记了 7 条），第二十二批算过 **asc16** 能一次
点亮 `{2,17}` / `{7,17}` / `{9,19}` / `{4,19}` 四族的中间档（本批又给它加上第五族：
秘法师鼓舞的 `{2,3,4}`、地精首领鼓舞的 `{3,4,5}`、工头伤口张数的 `{1,2,3}`、
冠军暴怒的 `{6,9,12}`）。**所以「阈值分辨 + 中间档」是跨两幕的同一个问题，应该单独一批用
`asc7 + asc16` 覆盖两幕**，而不是塞进本批。分工写在文末「下一步」。

#### 本批新补的 asc 分档（逐条）

⚠⚠ **三族阈值不是同一组数，逐只回参考数**（`MonsterSpecific.cpp:337-348` 并排声明三个索引，
`:26-128` 并排声明三组血量 case）：

| 族   | 血量（`Monster::initHp`） | 数值（`takeTurn` 顶部） | 本批的怪                                                        |
| ---- | ------------------------- | ----------------------- | --------------------------------------------------------------- |
| 普通 | `asc>=7`（:37-74）        | `getTriIdx(asc, 2, 17)` | 选民 / 食蛇草 / 拜鸟 / 劫匪 / 寄生虫 / 史尼克 / 百夫长 / 秘法师 |
| 精英 | `asc>=8`（:91-102）       | `getTriIdx(asc, 3, 18)` | 地精首领 / 工头 / 突刺之书                                      |
| Boss | `asc>=9`（:76-89）        | `getTriIdx(asc, 4, 19)` | 自动机 / 青铜球 / 收藏家 / **火炬头** / 冠军                    |

⚠ 四处「照抄邻居必错」的：

- **火炬头是 Boss 档**（`:76-89` 那组 case 里真的有 `TORCH_HEAD`），尽管它是随从。
- **秘法师读的是 `hallwayIdx`（2/17）**，尽管它只出现在精英编队 `CENTURION_AND_HEALER` 里
  ——族看的是 `takeTurn` 里读了哪个索引，不是「它在哪种编队里」。
- **球状守卫者走 `hpNoRoll`**，那条 case 压根不看 ascension（两组区间都是 `{20,20}`）→
  它是唯一「标了 `ascCalibrated` 却没有 `hpHigh`」的怪，`data-tables.test.ts` 的
  `ASC_CALIBRATED` 因此多了一个 `null` 档（此前那张表隐含「校准 ⇒ 有 hpHigh」，
  与 `hpNoRoll` 那条用例会互相打架）。
- **青铜球同时带 `hpDiscardRoll`**：白掷恒用低档 `(52,58)`、正式那次在 asc>=9 用 `{54,60}`
  ——asc19 是这两组第一次真的不同。（工头两组恰好相同，看不出来。）

| 位置                                                  | 分档                                                         | 参考                                 |
| ----------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| 17 只怪的血量第二组                                   | 普通 7 / 精英 8 / Boss 9                                     | `MonsterSpecific.cpp:26-128`         |
| 球状守卫者 激活格挡 / 三招伤害                        | asc17 → 35；asc2 → 11 各                                     | `:1166 / :1172 / :1179 / :1186`      |
| 选民 戳刺 / 电击 / 削弱                               | asc2 → 6 / 21 / 12                                           | `:614 / :631 / :636`                 |
| **选民 asc17 的整块出招规则**                         | 首招改诅咒、**少一整段**                                     | `:2252-2271`                         |
| 食蛇草 撕咬                                           | asc2 → 8（每击，段数恒 3）                                   | `:1131`                              |
| **食蛇草 asc17 的整块出招规则**                       | 高位那支的谓词**方向也反**                                   | `:2765-2782`                         |
| 拜鸟 **啄击段数** / 俯冲 / 起飞层数 / 开局飞行        | **asc2 → 6 段**；asc2 → 14；asc17 → 4 各                     | `:548 / :557 / :537 / :228`          |
| 劫匪 抢劫 / 猛扑 / 烟雾弹 / 偷金额度                  | asc2 → 11 / 18；asc17 → 17 / 20                              | `:964 / :956 / :984 / :233`          |
| 带壳寄生虫 双重打击 / 吸取 / 重击 / **首回合出招**    | asc2 → 7 / 12 / 21；asc17 恒重击                             | `:1072 / :1088 / :1077 / :2700`      |
| 史尼克 撕咬 / 尾击 / **asc17 多一层虚弱**             | asc2 → 18 / 10；`minAscension: 17`                           | `:1145 / :1155 / :1158`              |
| 百夫长 斩击 / 狂怒连斩 / 防守（给秘法师的格挡）       | asc2 → 14 / 7；asc17 → 20                                    | `:576 / :571 / :562`                 |
| 秘法师 治疗量 / 鼓舞 / 法击 / **缺血阈值 / 连续限制** | asc17 → 20；`{2,3,4}`；asc2 → 9；asc17 → 21 与 `lastMove`    | `:600 / :588 / :581 / :2224 / :2231` |
| 地精首领 鼓舞力量 / 鼓舞格挡                          | `{3,4,5}[eliteIdx]`；asc3 → 10                               | `:710-723`                           |
| **工头 asc18 的入队自身 buff** / 伤口张数             | `sync: false` + `minAscension: 18`；`asc18?3:asc3?2:1`       | `:1234-1247`                         |
| 突刺之书 乱刺每击 / 重刺                              | asc3 → 7 / 24                                                | `:457 / :462`                        |
| 自动机 连枷 / 增益力量 / 增益格挡 / 超射线 / **收尾** | asc4 → 8；asc4 → 4；asc9 → 12；asc4 → 50；**asc19 不进眩晕** | `:486 / :471 / :492`                 |
| 青铜球（三招一个分档都没有，只有血量在变）            | —                                                            | `:513-527`                           |
| 收藏家 火球 / 增幅力量 / 增幅格挡                     | asc4 → 21；`{3,4,5}`；`{15,18,23}`                           | `:1327 / :1310-1325`                 |
| 火炬头（一招无分档，只有血量在变）                    | —                                                            | `:1388`                              |
| 冠军 七招 + 防御姿态阈值                              | 见第二十九批那张表；asc19 → 30                               | `:1251-1307 / :2925`                 |

⚠ **没有分档的地方也逐条确认过并写进注释**（免得下一个人以为是漏了）：球状守卫者的 15 点
硬化格挡与 5 层脆弱、青铜球三招、火炬头的冲撞、地精首领的突刺、拜鸟的头槌与啼鸣、
突刺之书的开局两句、镀甲的 14 层 / 14 格挡、各处 2 层脆弱 / 易伤 / 3 层虚弱。

#### 本批新增的共享原语

| 原语                                     | 位置                  | 为什么必须加                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply_power` 的 `sync` 铺到 `on:"self"` | `takeTurn` + `Effect` | 唯一的用户是工头 asc18 那条 `addToBot(Actions::BuffEnemy<MS::STRENGTH>(idx, 1))`（`:1237`）——参考里**唯一一条入队的自身 buff**。⚠⚠ **省略时的含义逐 `on` 不同，而这个不对称是故意的**：`on:"target"` 省略 = 入队、`on:"self"` 省略 = 同步，于是已登记的 40 余处自身 buff **一位都不用回填**。TODOS 原先的计划是「统一成省略 = 入队 + 给既有怪补 `sync: true`」，那要改 40 余处、漏一处就是静默改坏一只已冻结的怪 |
| `deal_damage_multi.ascTimes`             | `takeTurn` + `Effect` | 拜鸟的啄击是 `attackPlayerHelper(bc, 1, asc2 ? 6 : 5)`（`:548`）——`asc? :` 落在**第三个**实参位上，每击伤害恒是 1。`ascAmount` 覆盖的是每击伤害，表达不了它。全参考项目只有三处这么写，另两处（`SPIRE_SPEAR_SKEWER` / `CORRUPT_HEART_BLOOD_SHOTS`）在第三 / 四幕。判据只有一条：**看参考把 `asc? :` 写在哪个实参位上**                                                                                           |

#### 变异测试 ⁍（26986 例基线，括号内为失败例数）

**结构性 / 整族**：

| 改坏的地方                                              |          例数 |
| ------------------------------------------------------- | ------------: |
| `hpHigh` 整族失效（41 处，两幕全部回落低档）            |      **4512** |
| `ascValue` 整体失效（全部数值分档回落基础值）           |      **4208** |
| 普通怪血量档整组失效（8 只 `atLeast` 7→999）            |      **3219** |
| 所有 `atLeast=2` 的数值档失效（43 处）                  |      **2744** |
| `isMonsterAttacking` 谓词恒真                           |      **1789** |
| 所有 `atLeast=17` 的数值档失效（15 处）                 |      **1638** |
| 精英血量档整组失效（3 只 8→999）                        |       **801** |
| 所有 `atLeast=18` 的数值档失效                          |       **699** |
| Boss 血量档整组失效（5 只 9→999）                       |       **720** |
| 所有 `atLeast=4` 的数值档失效（16 处）                  |       **668** |
| 所有 `atLeast=3` 的数值档失效（9 处）                   |       **646** |
| 所有 `atLeast=19` 的数值档失效（11 处）                 |       **533** |
| **转写参考那两句死代码**（突刺之书 asc18 加段数）       |       **495** |
| 火炬头**保留第一次** initHp 的取值（本该第二次）        |       **462** |
| 只补第二支死代码 / 只补第一支                           | **432 / 263** |
| 选民 asc17 出招块：整块失效 / 首招改戳刺 / 补回那一整段 |    **360** 各 |
| 带壳寄生虫 asc17 首回合恒重击 → 退回掷 randomBoolean    |       **240** |
| 拜鸟开局飞行 asc17（4→3）/ 回合开始复位 asc17           | **240 / 225** |
| `ascTimes` 整体失效 / 段数 6→7                          | **171 / 170** |
| 食蛇草 asc17 出招块整块失效 / 高位那支的谓词            |     **49** 各 |
| **工头 asc18 那条入队自身 buff：整条去掉 / 改成同步**   |  **120 / 48** |
| 史尼克 asc17 那条多出来的虚弱去掉                       |       **114** |
| 秘法师 asc17 缺血阈值 21→16 / 连续限制不收紧            |   **55 / 20** |
| 冠军 asc19 防御姿态阈值 30→15                           |        **68** |
| 自动机 asc19 超射线收尾改回眩晕                         |       **120** |

**逐条数值分档**（把某一档改回基础值 / 邻档）：
球状守卫者 激活格挡 asc17 **239**、猛击 asc2 **234**、攻击削弱 asc2 **220**、硬化 asc2 **205**；
选民 戳刺 asc2 **270**、削弱 asc2 **302**、电击 asc2 **212**；食蛇草 撕咬 asc2 **120**；
拜鸟 俯冲 asc2 **111**、起飞层数 asc17 **13**；
劫匪 抢劫 asc2 **120**、猛扑 asc2 **58**、烟雾弹 asc17 **94**、偷金额度 asc17 **120**；
带壳寄生虫 重击 asc2 **228**、双重打击 asc2 **213**、吸取 asc2 **195**；
史尼克 撕咬 asc2 **117**、尾击 asc2 **106**；
百夫长 斩击 asc2 **117**、防守格挡 asc17 **110**；
秘法师 治疗量 asc17 **114**、鼓舞 asc17（4→2 / 4→3）**95** 各、法击 asc2 **104**；
地精首领 鼓舞力量 asc18 **120**、鼓舞格挡 asc3 **116**；
工头 伤口张数 asc18 **120**；突刺之书 乱刺 asc3 **120**、重刺 asc3 **120**；
自动机 连枷 asc4 **120**、增益力量 asc4 **120**、增益格挡 asc9 **120**；
收藏家 火球 asc4 **120**、增幅力量 asc19 **61**、增幅格挡 asc19（23→18 / 23→20）**67** 各；
冠军 重斩 asc4 **117**、扇脸 asc4 **117**、防御姿态格挡/金属化 asc19 **105** 各、
自夸 asc19 **40**、暴怒 asc19 **3**。
**34 条里 29 条非 0**，5 条为 0 的见下方盲区。

#### ⁍ 本批**关掉**的旧盲区（此前 0 例）

| 盲区                                                                | 此前 |         本批 | 怎么关的                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ---: | -----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **突刺之书 asc18 那两句死代码**（第二十八批「结构性不可达」）       |    0 |      **495** | 有了 asc19 语料，「as-built 的行为（**不**自增）」从此有背书。两支还能分开量（263 / 432）。⚠ **但「参考本该自增吗」仍然没有答案**——有语料只证明「我们与参考一致」，证不了「参考与真实游戏一致」。那条待裁定**保持原状**，只更新背书状态 |
| **`isMoveAttack` 白名单：球状守卫者的硬化**（第二十三批那个反例）   |    0 |      **131** | ⚠⚠ **本批意外关掉的一族**：variant 30 的牌组是 `BATCH_1 + SPOT_WEAKNESS`，而它的编队列表**包含**第二十三批那三个（当时那个 variant 的 21 张牌组里没有觅敌之弱）。于是「带伤害却也加格挡、白名单却算它攻击」这个反例第一次有了预言机     |
| 同族：白名单多加 `chosen/drain` / `snake_plant/sp_spores`           |    0 | **147 / 30** | 同上。第二十三批那三条「整表退回读 `intent`」式的 0 例因此不再是整族盲区                                                                                                                                                                |
| **工头 asc18 的入队自身 buff**（第二十七批跳过、记在待裁定）        |  n/a | **120 / 48** | 本批实现并量到：整条去掉 120 例、**「入队 ↔ 同步」48 例**。⚠ 48 例是「同步 ↔ 入队」这一族至今最厚的一次干净非 0（此前是灼烧 34、工头收尾 5、冠军 375——最后那个是整族而不是单条语句）                                                    |
| **「两次完整 initHp、保留第二次」**（第二十九批只量到「去掉一次」） |  n/a |      **462** | 保留**第一次**的取值红 462 例。asc>=9 时两次都用高档区间这件事也跟着有了背书（火炬头血量档单只失效 120 例）                                                                                                                             |

#### ⁍ 本批仍然为 0 的（逐条分类）

⚠ 三类分开记：**结构性盲区**（数据这一维救不了）/ **等价改写**（语义不同、当前取值恒等，
不是盲区）/ **探针无效**（那个变异测不到任何东西）。

| 改法                                           |  例数 | 分类                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 冠军防御姿态的分档族抄成 `bossDiffIdx`（4/19） | **0** | **盲区**：`getTriIdx(9,19)` 与 `getTriIdx(4,19)` 只在 `4 <= asc < 9` 分岔。**关门条件：一个落在 `[4, 9)` 的档位**（asc7）。⚠ asc9 分不开（两边都返回中间档）                                                                                                                                                                   |
| 同一族抄成 `hallwayIdx`（2/17）                | **0** | **盲区，同一个根**：在 `{0, 19}` 这对档位下**三族两两都不可分辨**。这条比上一条更强，一起记                                                                                                                                                                                                                                    |
| 秘法师鼓舞 `{2,3,4}` 的 asc2 档                | **0** | **盲区**：三档的中间那一档，asc0 取 2、asc19 取 4。关门条件 asc16                                                                                                                                                                                                                                                              |
| 地精首领鼓舞力量 `{3,4,5}` 的 asc3 档          | **0** | 同上（精英族的中间档）                                                                                                                                                                                                                                                                                                         |
| 工头伤口张数 `{1,2,3}` 的 asc3 档              | **0** | 同上                                                                                                                                                                                                                                                                                                                           |
| 冠军暴怒力量 `{6,9,12}` 的 asc4 档             | **0** | 同上（Boss 族的中间档）                                                                                                                                                                                                                                                                                                        |
| 火炬头血量阈值 9 抄成 7（按「随从=普通怪」猜） | **0** | **盲区**：asc19 下两种写法都取高档。这是第二十二批那条「单一档位证不了阈值」在第二幕的具体化。守着它的只有 `data-tables.test.ts` 里那张逐怪期望阈值表（本批把 17 只加进去了）                                                                                                                                                  |
| 青铜球 / 工头 的**白掷区间**                   | **0** | **结构性不可观测**（不是盲区，别去找逃生口）：取值被丢弃，而 `Random::nextLong(n)` 的实际前进步数与 n 无关。**次数**有背书。第二十七 / 二十八批已裁定过，asc19 下**仍然**如此                                                                                                                                                  |
| 自动机超射线的 asc4 档（50→45）                | **0** | **盲区，原因是过量杀伤**：asc19 下这一击（+8 力量后 53 或 58）恒把玩家打死，HP 钳到 0 → 快照相同。两个探针证实了这个解释：改成 **80 也是 0 例**，而把基础值砍到 5 红 **471 例**（所以这一招真的落地、不是没执行）。关门条件：一副能扛住超射线的牌组                                                                            |
| 百夫长狂怒连斩的 asc2 档                       | **0** | **盲区，继承第二十六批那条**：根是 `pickAction` 恒打 0 号位、百夫长恒在 0 号位 → 这一招的**效果**在任何档位下都没有预言机。关门条件仍是「目标策略」轴。✅ **第三十一批开了那条轴**，效果与收尾都关掉了（91 / 96 / 88 例），**但这一格照旧 0**——`@tgt1` 只做了 asc0。关门条件因此收窄成 **`asc19 × tgt1` 那个组合**，不再是死结 |
| 诅咒 / 困惑的 bool 语义（改成累加）            | **0** | **结构性盲区**：参考里没有任何内容会施加第二次（asc17 的选民把诅咒挪到首回合，依然只有一次）。第二十三 / 二十五批的结论**在 asc19 下不变**                                                                                                                                                                                     |
| `apply_power on:"self"` 的 `sync` 默认值倒过来 | **0** | **等价改写**：把 40 余处自身 buff 全部改成入队，对拍仍全绿——判据同第二十六批（那些 case 的其余效果要么全同步、要么没有别的东西读那个 Power）。⚠ **这不代表"回填"方案安全**：0 例是**事后**才知道的，而选默认值是**事前**的决定                                                                                                 |
| 工头 asc18 的力量与伤口**顺序**对调            | **0** | **等价改写**：伤口进弃牌堆、力量在怪身上，两者互不读                                                                                                                                                                                                                                                                           |

### 第二十九批：召唤的第三族（收藏家 / 火炬头）与冠军的阶段锁存（第二幕收官）

**本批是纯追加**：`--install` 之前先跑过 `--check`，已提交的 **57 个文件全部逐字节一致**；
装完 `git status` 只有两个 `??`（`champ.jsonl` / `collector.jsonl`），**零个 `M`**。
没有动参考项目的任何 gameplay 代码（只加了 harness 的 variant 29，参考侧 commit `d220ee8`），
因此**不需要 `ALLOW_CHANGED`，也没有旧例数需要重量**。
总例数 23956 → **24706**（+750 = 2 × 375）；体积 432MB → **456MB**；文件 57 → **59**。

两个新文件的形状（选批次时的参考）：**两个都是 375 条全负**——420 血与 282 血的 Boss 对
22 张起始牌组没有悬念。`champ` 回合数 5~~18（均 **9.3**，是第二幕最长的仗）、
`collector` 4~~9（均 5.5，每一条都出现过火炬头、同时存活最多 3 只）。
⚠ 「全负」不是缺陷而是本批的**覆盖来源**：冠军的仗长，所以七招全部出场
（最薄的暴怒也执行了 158 次）；而「玩家被打死」正是「效果入队 + 收尾同步」那一族
唯一的可观察面（见下方 E16 的 375 例）。

关键分布（写进来是给下一批当分母用的）：

- 冠军**进二阶段**（出现过暴怒意图）的 trace **158 / 375**；处决意图同样 158 条里出现，
  嘲讽 **375 / 375**；防御姿态的出现次数分布是 `0 次 120 条 / 1 次 135 条 / 2 次 120 条`
  ——所以「上限 2」那道门**真的被顶到过**（120 条）。
- 收藏家的召唤意图出现次数分布 `1 次 190 条 / 2 次 182 条 / 3 次 3 条`，
  **184 条**里火炬头被补位过（说明 `spawnCount == 1` 那一支有背书）；
  增幅意图出现 276 条、巨型削弱 **375 / 375**。

#### 本批的四份工作 × 三只怪

| 怪     | 数据表（`enemies.ts`）                                                                                                                                                                                         | `MOVE_RULES`                                                                                                                                                 | `takeTurn` 效果                                                                                                     | 收尾（`MOVE_TURN_END`）                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 冠军   | **420 血固定**（Boss 阈值 asc>=9，照样掷一次 monsterHpRng）；**七招**（重斩 16 / 扇脸 12+脆弱2+易伤2 / 防御姿态 格挡15+金属化5 / 处决 10×2 / 自夸 力量3 / 暴怒 清减益+力量6 / **嘲讽** 虚弱2+易伤2，全部同步） | 三段：二阶段块（`miscInfo & 0x4` → 处决）/ 一阶段块（半血锁存 → 暴怒；`(n+1)%4` → 嘲讽）/ 公共块（防御姿态 → 自夸 → 扇脸 → 重斩 → 兜底扇脸）。**规则写状态** | `remove_debuffs`（新）+ 同步 `gain_block` + 同步 `apply_power on:self` + **同步** `apply_power on:target`（新写法） | **两族**：处决 / 扇脸 / 重斩是入队 `roll`；暴怒 / 防御姿态 / 自夸 / 嘲讽是**同步的真 rollMove** |
| 收藏家 | **282 血固定**（Boss 阈值 asc>=9）；四招（召唤 / 火球 18 / 增幅 前两格力量3+自己力量3+自己格挡15 / 巨型削弱 虚弱3+易伤3+脆弱3）；开局 `MINION_LEADER`                                                          | 首回合恒召唤 → 第 3 个怪物回合恒巨型削弱 → `roll<=25 && monstersAlive<3 && !lastMove(召唤)` → `roll<=70 && !lastTwoMoves(火球)` → 兜底二选一                 | `summon_torch_heads`（新，**入队**）+ `buff_torch_heads`（新，同步）+ 三条入队 `DebuffPlayer`                       | 四条**全是**入队 `roll`（默认值）                                                               |
| 火炬头 | 38~40 血（⚠ **Boss 阈值 asc>=9**，随从却走 Boss 档）；一招（冲撞 7，无 asc 分档）；`MINION` 由召唤函数加                                                                                                       | ⚠ **永远不该被调用**（参考落在 `default` 返回 `INVALID`）→ 抛错                                                                                              | 只有 `deal_damage 7`                                                                                                | **`"none"`**（第四形态，case 里一句收尾都没有）                                                 |

⚠ **旧近似数据表在这三只身上又错了一轮**（与第二十三 / 二十五 / 二十六 / 二十七 / 二十八批
同一个结论），而且这次多了一种新错法：**把两组血量区间当成一个区间**
（冠军 `420~440`、收藏家 `282~300`，实际低档是 `{420,420}` / `{282,282}`）。
另有：扇脸的「虚弱」实为**易伤**且顺序是「脆弱 → 易伤」、**整整少一招嘲讽**、
增幅少一整段（给前两格加力量）且顺序反了、三只的 `intentRule` 权重表全是编的、
编队 id `the_collector` 要改名成 `collector`。逐条见「已修正（第二十九批）」。

#### 本批新增的共享原语

| 原语                                                  | 位置                           | 为什么必须动                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`summon_torch_heads`**（召唤的第三族）              | `takeTurn` + `Effect` + 新函数 | 与前两族**八处形状全不同**（只数按 `3 - monstersAlive` / 落位表 `{arr[1].isDying()?1:0, 0}` / 有 `= Monster()` 重建 / **第二次 `initHp`** / `setMove` 而不是 `rollMove` / aiRng 在末尾按只数还 / `++monstersAlive` 在循环内 / 没有 `++monsterTurnIdx`）。逐条都有背书 |
| **`ENCOUNTER_BUILDERS.collector`**                    | 编队构建器                     | 「预留空位」的**第三种写法**：`monsterCount = 2; createMonster(...)`——0/1 号位空、宿主在**最后一格**，而且**没有**自动机那句末尾的 `++monsterCount`。改成「宿主在 0 号位」红 375 例、「只留一个空位」红 375 例                                                        |
| **`initMonsterHp`**（从 `constructMonster` 拆出）     | `sts-combat.ts`                | 参考的 `Monster::initHp` 有**第二个调用点**（`SpawnTorchHeads` 里那句「bug somewhere in game」）。不拆就没法表达「同一只怪掷两遍完整的 initHp」，而拿 `hpDiscardRoll` 顶替在 asc>=9 时区间会不同                                                                      |
| **`buff_torch_heads`**                                | `takeTurn` + `Effect`          | 与地精首领的 `buff_minions` **两处不同**：范围是 0..**1**（不是 0..2）、**不给随从加格挡**。两处各有背书（266 / 215 例）                                                                                                                                              |
| **`remove_debuffs`**                                  | `takeTurn` + `Effect` + 新函数 | 本项目第一条**怪物侧清减益**。⚠ 它是写死名单而不是「清空所有 Power」，且力量**只抬负值**——无条件清力量红 116 例                                                                                                                                                       |
| **`apply_power on:"target"` 的 `sync`**（第三个用户） | 数据表                         | 冠军的嘲讽写的是裸的 `bc.player.debuff<PS::WEAK>(2, true)`——连 `Actions::DebuffPlayer` 都没经过。与拉加维林的 `.actFunc(bc)` 逐位等价，故复用同一个开关                                                                                                               |
| **`lastMoveBefore`** 谓词                             | `sts-combat.ts`                | 冠军二阶段的门是 `!lastMove(EXECUTE) && !lastMoveBefore(EXECUTE)`——**不是** `!lastTwoMoves`。抄成 `lastTwoMoves` 红 9 例、只留 `lastMove` 红 4 例                                                                                                                     |

#### 变异测试（例数 = 对拍失败的 trace 条数，总 24706）

⚠ 分母提醒：本批两个文件各 375 条，三只新怪各只有一个出处，所以**单文件的上限是 375**；
唯一会跨文件的是共享原语（`initMonsterHp` 与 `isMonsterAttacking`）。
⚠ 本批 **74 条**变异全部单独跑、每条跑完 `git checkout --` 还原，末尾复跑一次全量测试
确认回到全绿（24706 passed）。

**召唤的第三族（`summonTorchHeads`）**

| 改坏的                                              |         例数 | 判读                                                                                                                                                                           |
| --------------------------------------------------- | -----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **开局 `monstersAlive` 写成数组长度**（3 而不是 1） |      **375** | ⚠⚠ **第二十七批那条盲区在这里关门。** `spawnCount = 3 - monstersAlive` 于是变成 0，一只火炬头都不召                                                                            |
| `spawnCount` 写死 2（不读 `monstersAlive`）         |           49 | 「只死了一只火炬头」的那些回合会多召一只。⚠ 只有 49 例，因为多数补位发生在两只都死的时候——**但它非 0，所以「按只数」这件事有背书**                                             |
| 落位表两格顺序调换（先 0 后 1）                     |          285 | 参考是**先 1 号位再 0 号位**                                                                                                                                                   |
| 落位表的门改看 0 号位                               |          375 | `arr[1].isDying()` 抄成 `arr[0]`                                                                                                                                               |
| **去掉第二次 `initHp`**（只掷一次 monsterHpRng）    |      **375** | 那句「bug somewhere in game」是真的可观察的                                                                                                                                    |
| 掷两次但**保留第一次**的取值                        |          345 | 次数对了、取值取错。两条一起才钉死「掷两次且用第二次」                                                                                                                         |
| 末尾 `noOpRollMove` 改成固定 2 次                   |           49 | 与「`spawnCount` 写死 2」同源：aiRng 的次数与召几只**绑定**                                                                                                                    |
| 末尾 `noOpRollMove` 整条去掉                        |          375 | 那几次 aiRng 是钉死的                                                                                                                                                          |
| 火炬头不上 `MINION`                                 |          375 | 进怪物快照                                                                                                                                                                     |
| 火炬头的 `MINION` 抄成 `MINION_LEADER`              |          375 | 两者不是一回事：后者让「打死一只火炬头」当场判胜                                                                                                                               |
| 召唤时**额外掷一次 aiRng**（模拟用 `rollMove`）     |          375 | 「召唤本身不掷 aiRng」有背书                                                                                                                                                   |
| 加上 `++monsterTurnIdx`（照搬青铜球）               |        **0** | **盲区（永久）**：收藏家恒在最后一格。见（甲）表                                                                                                                               |
| 召唤改成同步（不入队）                              |        **0** | **等价改写**（这条 case 的两条动作紧挨着入队）                                                                                                                                 |
| `setMove` 改成 `overwriteMove`                      |        **0** | **盲区（永久）**：新怪历史为空 + `rollMove` 永不被调用                                                                                                                         |
| `monstersAlive += 1` 移到循环外                     |        **0** | **等价改写**（循环体不读它）                                                                                                                                                   |
| 落位表第二格改成「算出来的另一格」                  |        **0** | **等价改写**（`spawnCount == 2` 蕴含「1 号位空」）                                                                                                                             |
| 召唤后重跑 `preBattleAction`                        | **探针无效** | ⚠ 火炬头在 `Monster::preBattleAction` 的 switch 里**压根没有 case**，我们这边也没有条目——这条变异是**空操作**，测不到任何东西。**不能记成 0 例**（判据同第二十八批青铜球那条） |

**预留空位的第三种写法（`ENCOUNTER_BUILDERS.collector`）**

| 改坏的                          |    例数 | 判读                       |
| ------------------------------- | ------: | -------------------------- |
| 收藏家放 0 号位、后两格空       | **375** | 「宿主在最后一格」是钉死的 |
| 只留一个空位（收藏家在 1 号位） | **375** | 「留两格」也是钉死的       |

**冠军的阶段锁存（`MOVE_RULES.champ`）**

| 改坏的                                                     |    例数 | 判读                                                                                                                                                              |
| ---------------------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **给冠军补一条守卫者式的 `MONSTER_ON_HP_LOST`**            | **213** | ⚠⚠ **本批最重要的一条**：它证明「阈值锁存在 `getMoveForRoll` 里、而不是掉血那一刻」真的可观察。`Monster::onHpLost` 的 switch 里**没有 `THE_CHAMP`**，照抄「没有」 |
| 二阶段标志**不锁存**（每次过半血都暴怒）                   |     158 | 恰好等于「进过二阶段的 trace 数」                                                                                                                                 |
| 二阶段标志改用 bit 3（与次数掩码错位）                     |     158 | 同上，`0x4` 这个位置是钉死的                                                                                                                                      |
| 半血判据 `<` 改成 `<=`                                     |       6 | 薄但非 0——只有「血量恰好等于 210」那一击才分岔                                                                                                                    |
| 一阶段两支顺序调换（先嘲讽后暴怒）                         |      36 | 「过半血优先于四回合周期」有背书                                                                                                                                  |
| 嘲讽周期 `(n+1)%4` 改成 `n%4`                              |     375 | 375 条里每一条都出过嘲讽                                                                                                                                          |
| 处决门 `!lastMove && !lastMoveBefore` 改成 `!lastTwoMoves` |       9 | 抄成 `lastTwoMoves` 会让处决连出                                                                                                                                  |
| 处决门只留 `!lastMove`（去掉 `lastMoveBefore`）            |       4 | 最薄的一条，但两条一起钉死了「最近两格里都没有处决」                                                                                                              |
| 二阶段块改成**无条件**返回处决                             |       9 | 与上面同源                                                                                                                                                        |
| **探针：二阶段不能处决时强制重斩**（穿透那条路可达吗）     |   **6** | **可达**——穿透到公共块真的发生过 6 次。⚠ 这条探针是必需的：互换类变异同时改了 false 侧，证不了可达性（判据同第二十七批地精首领那条）                              |
| 防御姿态次数上限 2 改成 3                                  |      31 | 「上限 2」被顶到过（120 条 trace 出过两次防御姿态）                                                                                                               |
| 已用次数 `++` 改成按位或 `0x1`                             |      31 | 同上，`++` 这个写法是钉死的                                                                                                                                       |
| 防御姿态去掉 `!lastMove` 连续限制                          |      30 |                                                                                                                                                                   |
| 自夸的门去掉 `!lastMove(防御姿态)`                         |      71 | ⚠ 那个门里有**两个** `lastMove`，少一个就红                                                                                                                       |
| 兜底 `face_slap` 改成 `champ_slash`                        |     227 |                                                                                                                                                                   |
| 重斩那支的连续限制去掉                                     |     227 |                                                                                                                                                                   |
| `roll <= 30` 改成 `roll < 30`                              |      29 | 边界                                                                                                                                                              |
| `roll <= 55` 改成 `roll < 55`                              |      16 | 边界                                                                                                                                                              |
| 防御姿态阈值 15 改成 30（asc19 那一档）                    |     224 |                                                                                                                                                                   |
| **探针：嘲讽那一支恒不触发**                               |     375 | 可达（每条都出）                                                                                                                                                  |
| **探针：防御姿态那一支恒不触发**                           |     255 | 可达                                                                                                                                                              |
| 次数掩码 `& 0x3` 去掉                                      |   **0** | **盲区**：二阶段太短。见（甲）表                                                                                                                                  |
| `maxHp / 2` 改成不整除                                     |   **0** | **盲区（永久）**：420 与 440 都是偶数                                                                                                                             |

**冠军的效果与收尾**

| 改坏的                                               |    例数 | 判读                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扇脸的易伤抄成**虚弱**（旧近似表的错）               |     374 |                                                                                                                                                                                                                           |
| 扇脸的「脆弱 → 易伤」顺序对调                        |      80 | 玩家带**神器**时被吃掉的是排在前面的那条（与第十九批守卫者泄气同源）                                                                                                                                                      |
| 嘲讽两条减益顺序对调                                 |       9 | 同上，薄但非 0                                                                                                                                                                                                            |
| 处决段数 2 改成 1                                    |      70 |                                                                                                                                                                                                                           |
| 暴怒**去掉 `remove_debuffs`**                        |      38 | 怪物侧清减益有背书（易伤来自邪能爆裂 / 雷鸣、虚弱来自晾衣绳与虚弱药水）                                                                                                                                                   |
| `removeDebuffs` 改成**无条件**清力量                 |     116 | ⚠ 「只抬负值」是钉死的——无条件清会把冠军自己积累的力量抹掉                                                                                                                                                                |
| `removeDebuffs` 名单去掉易伤                         |      21 |                                                                                                                                                                                                                           |
| `removeDebuffs` 名单去掉虚弱                         |      18 |                                                                                                                                                                                                                           |
| **三条入队的 `RollMove` 改成同步**（处决/扇脸/重斩） | **375** | ⚠⚠ **「效果入队 + 收尾入队」这一族第三次拿到干净非 0，而且是历批最大的一次。** 机理与第二十七批工头那 5 例相同：攻击打死玩家 → 主循环跳出 → 入队那次 RollMove 永远轮不到；而 375 条**全部**以玩家阵亡收场，所以每一条都红 |
| 四条**同步**真 rollMove 改成入队 `"roll"`            |   **0** | **等价改写**（那四条 case 的效果全是同步的）                                                                                                                                                                              |
| 只把防御姿态的收尾改成入队                           |   **0** | 同上                                                                                                                                                                                                                      |
| 防御姿态的格挡 `sync` 去掉                           |   **0** | **等价改写**                                                                                                                                                                                                              |
| 嘲讽两条减益的 `sync` 去掉                           |   **0** | **等价改写**                                                                                                                                                                                                              |
| 暴怒的「清减益 → 加力量」顺序对调                    |   **0** | **盲区**：没有负力量来源。见（甲）表                                                                                                                                                                                      |
| `removeDebuffs` 顺手清格挡                           |   **0** | **盲区**：出招那一刻格挡恒为 0。见（甲）表                                                                                                                                                                                |
| 防御姿态的分档族改成 `bossDiffIdx`（4/19）           |   **0** | **盲区**：只在 `4 <= asc < 9` 分岔。见（甲）(丙) 表                                                                                                                                                                       |

**收藏家的出招与效果**

| 改坏的                                         |  例数 | 判读                                                                                                    |
| ---------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------- |
| 去掉「首回合恒召唤」                           |   276 |                                                                                                         |
| 巨型削弱的回合数 3 改成 4                      |   375 | ⚠ 参考的注释写的是「turn 4」、代码写的是 `== 3`（`getMonsterTurnNumber()` 是 `turn + 1`）。**照抄代码** |
| `canUseSpawn` 读数组长度而不是 `monstersAlive` |   185 | 与 `SpawnTorchHeads` 那条同源，是「预留空位不算活怪」的第二个读点                                       |
| `canUseSpawn` 只保留 `!lastMove`（去掉数量门） |   114 |                                                                                                         |
| `roll <= 25` 改成 `roll < 25`                  |     6 | 边界                                                                                                    |
| 火球的 `lastTwoMoves` 改成 `lastMove`          |   238 |                                                                                                         |
| 兜底二选一反过来                               |   276 |                                                                                                         |
| **探针：非首回合的召唤那一支恒不触发**         |   185 | 可达                                                                                                    |
| **探针：兜底「刚增幅过就火球」恒不触发**       |    77 | 可达                                                                                                    |
| 增幅范围 0..1 改成 0..2（含收藏家自己）        |   266 | ⚠ 与地精首领的 `buff_minions`（0..2）差的那一格有背书                                                   |
| 增幅顺手给随从加格挡（照搬 `buff_minions`）    |   215 | ⚠ 另一处差别也有背书                                                                                    |
| 增幅去掉 `!isDying()` 门                       |   172 | 空格与刚死的火炬头都会被误加                                                                            |
| 巨型削弱三条顺序（虚弱与脆弱对调）             |    90 | 神器同源                                                                                                |
| 收藏家去掉 `MINION_LEADER`                     |   375 | 第三个宿主，一死当场判胜                                                                                |
| 收藏家顺手加 `ARTIFACT 3`（照搬自动机）        |   375 | ⚠ 「收藏家没有神器」也是钉死的                                                                          |
| `canUseSpawn` 去掉 `!lastMove(召唤)`           | **0** | **盲区**：被邻居时序挤死。见（甲）表                                                                    |
| 增幅三句顺序 / 格挡 `sync`                     | **0** | **等价改写**（见上方等价改写表）                                                                        |

**火炬头**

| 改坏的                                   |    例数 | 判读                                                          |
| ---------------------------------------- | ------: | ------------------------------------------------------------- |
| 收尾 `"none"` 改成 `"no_op_roll"`        | **375** | 每个火炬头每回合都会多掷一次 aiRng                            |
| 血量抄成高档那组 `40~45`                 |     375 | ⚠ 它走的是 **Boss 档 asc>=9**，`{{38,40},{40,45}}` 两组别抄串 |
| 冲撞 7 → 8                               |     375 |                                                               |
| 收尾 `"none"` 改成同步 `setMove("冲撞")` |   **0** | **等价改写 / 盲区**（不掷 aiRng，而历史对它没有读者）         |

**数据表校准（本批修掉的旧近似表错值）**

| 改坏的（= 退回旧表的值） | 例数 |
| ------------------------ | ---: |
| 冠军血量退回 `420~440`   |  355 |
| 收藏家血量退回 `282~300` |  349 |
| 冠军重斩 16 → 18         |  369 |
| 收藏家火球 18 → 21       |  375 |
| 增幅格挡 15 → 23         |  266 |

**`isMonsterAttacking`（觅敌之弱这条背书，两个方向都量）**

| 改坏的                           |     例数 | 判读                                                                                                                  |
| -------------------------------- | -------: | --------------------------------------------------------------------------------------------------------------------- |
| 谓词恒真                         | **1343** | ⚠ 第二十八批量到的是 **1077**，本批两个新文件因此贡献 **266** 例（旧文件逐字节未变，所以那 1077 一例不差）            |
| 白名单**漏掉本批五条**           |  **205** | 反方向。⚠ 两个方向都必须量（WORKFLOW 那条）：本批的 205 与恒真的 266 都非 0，所以五条新招式的攻击分类**两侧都有背书** |
| 白名单**多收冠军的四条非攻击招** |  **185** | 第三个方向：防御姿态 / 嘲讽 / 自夸 / 暴怒**不该在**白名单里，加进去就红                                               |

### 第二十八批：召唤的第二族（青铜自动机）、眩晕充能、多段突刺与停滞

**本批是纯追加**：`--install` 之前先跑过 `--check`，已提交的 **55 个文件全部逐字节一致**；
装完 `git status` 只有两个 `??`（`book_of_stabbing.jsonl` / `automaton.jsonl`），**零个 `M`**。
没有动参考项目的任何 gameplay 代码（只加了 harness 的 variant 28，参考侧 commit `a11e802`），
因此**不需要 `ALLOW_CHANGED`，也没有旧例数需要重量**。
总例数 23206 → **23956**（+750 = 2 × 375）；体积 410MB → **432MB**。

两个新文件的形状（选批次时的参考）：`book_of_stabbing` 375 条里玩家胜 **237** / 负 138、
回合数 2~~7（均 4.9）；`automaton` **375 条全负**（300 血 Boss 对 22 张起始牌组），
回合数 5~~8（均 5.2），**每一条都出现过青铜球**、同时存活最多 3 只。

#### 本批的四份工作 × 三只怪

| 怪         | 数据表（`enemies.ts`）                                                                                                               | `MOVE_RULES`                                                                               | `takeTurn` 效果                                                    | 收尾（`MOVE_TURN_END`）                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 突刺之书   | 160~**164** 血（精英阈值 asc>=8）；两招（乱刺 `6 × miscInfo` / 重刺 21，各带 asc3 档 7 / 24）                                        | 唯一阈值 `roll < 15` + `lastTwoMoves(乱刺)`，**规则自己 `++miscInfo`**（只在发乱刺的两支） | 多段攻击（`times: "miscInfo"`，入队）                              | 两条都是默认的入队 `roll`                                                                 |
| 青铜自动机 | 300 血固定（Boss 阈值 asc>=9，**照样掷一次** monsterHpRng）；五招（召唤 / 连枷 7×2 / 增益 力量3+格挡9 / 超射线 45 / 眩晕**无效果**） | 无条件返回召唤（**第二次被调用就抛错**）                                                   | `summon_bronze_orbs`（**同步**）/ 多段 / 力量同步 + 格挡 `sync`    | 五条**逐字同形**：同步 `setMove` + 同步 `noOpRollMove`；增益那条按 `miscInfo` 翻转分岔    |
| 青铜球     | 52~58 血 + **`hpDiscardRoll (52,58)`**（共 2 次 monsterHpRng）；三招（光束 8 / 支援光束 给 **1 号位** 12 格挡 / 停滞）               | 三段：`!已用过停滞 && roll>=25` / `roll>=70 && !连两次支援` / `!连两次光束` / 兜底又是支援 | `deal_damage` / `gain_block_ally_fixed`（`noAliveGate`）/ `stasis` | 光束是默认入队 `roll`；停滞是 `miscInfo = 1` + **同步真 rollMove**；支援是同步真 rollMove |

⚠ **旧近似数据表在这三只身上又错了一轮**（与第二十三 / 二十五 / 二十六 / 二十七批同一个结论）：
突刺之书的血量上界写成 162（实为 164）、乱刺写成固定 3 段（实为 `miscInfo`）、
自动机的增益顺序写反且格挡写成入队、青铜球的支援写成「自己获得 6 点格挡」
（实为**给 1 号位 12 点**）、血量写成 52 固定（实为 52~58 且要白掷一次）、
三只的 `intentRule` 权重表全是编的；**编队 id `bronze_automaton` 也要改名成 `automaton`**。

#### 本批新增的共享原语

| 原语                                            | 位置                               | 为什么必须动                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`summon_bronze_orbs`**（召唤的第二族）        | `takeTurn` + `Effect` + 新函数     | 与 `summon_gremlins` **八处形状都不同**（同步 / 下标写死 0 与 2 / 种类固定不掷 aiRng / 无 `= Monster()` / 末尾 `++monsterTurnIdx`）。并列表见 WORKFLOW     |
| **`ENCOUNTER_BUILDERS.automaton`**              | 编队构建器                         | 「预留空位」的**第二种写法**：`monsterCount = 1; createMonster(...); ++monsterCount;`——宿主落**中间的 1 号位**，两侧都空                                   |
| **`deal_damage_multi.times: "miscInfo"`**       | 数据表 + `takeTurn`                | 第一条「段数由状态决定」的多段攻击。⚠ 与 `deal_damage_rolled` 读**同一个字段当伤害**是两回事                                                               |
| **`stasis`**（+ `stasisHelper` / 还牌）         | `takeTurn` + `Effect` + 三个新函数 | 第一个「怪物把玩家的牌扣住」的机制。牵着 `BattleContext.stasisCards`（定长 2）、`StsCombatState` 新字段与 migrate 回填                                     |
| **`STASIS_CARD_INFO`**（参考的稀有度 + 排序键） | `sts-combat.ts` 的一张表           | ⚠⚠ **不能从 `CardDef.rarity` 派生**：118 张已映射的牌里 **15 张不一致**（状态牌参考是 COMMON、我们是 `special`）。判据同第二十三批的 `isMoveAttack` 白名单 |
| **`gain_block_ally_fixed.noAliveGate`**         | `Effect` + `takeTurn`              | 青铜球的支援光束**连 `monstersAlive > 1` 那道门都没有**（百夫长那条有）。当前可证同解，但形状照抄                                                          |
| **`painful_stabs`**（读点在玩家侧）             | `dealDamageToPlayer`               | 排在 `if (damage > 0)` **里面**、`hpWasLost` **之前**。⚠ **每段各判一次**：乱刺 3 段最多塞 3 张伤口，被挡住的那段一张不塞                                  |
| **`stasis` PowerId + `monsterDie` 的第三格**    | `types.ts` + `monsterDie`          | 参考的 else-if 链是 孢子云 → **重生（未登记）** → 停滞。登记暗黑之种那一批要插在**中间**                                                                   |

#### 变异测试（例数 = 对拍失败的 trace 条数，总 23956）

⚠ 分母提醒：本批两个文件各 375 条，三只新怪各只有一个出处，所以**单文件的上限是 375**；
唯一的例外是共享原语被改坏时（`gain_block_ally_fixed` 会连带 `centurion_and_healer`）。
⚠ 本批 **77 条**变异全部单独跑、每条跑完 `git checkout --` 还原，末尾复跑一次全量测试确认
回到全绿。⚠ 其中一条（「伤口塞在 `hpWasLost` 之后」）第一次写坏了大括号导致整份编译不过
（报 `失败 None`），在第二组里以 `K13` 重跑——**没有把它当成 0 例**。

**召唤青铜球（`spawnBronzeOrbs`）**

| 改坏的                                           |    例数 | 判读                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两颗球的落位互换（0 ↔ 2）                        | **348** | 「哪次血量落哪一格」有背书（两颗球血量不同 → 快照当场不同）                                                                                                                                                                                                                                                 |
| **`hpDiscardRoll` 整条去掉**（每颗少一次 hpRng） | **375** | 「每颗掷两次」有厚背书                                                                                                                                                                                                                                                                                      |
| **照地精那条为「挑种类」多掷一次 aiRng**         | **375** | ⚠⚠ 本批最该量的一条：青铜球的种类是**写死的**，参考一次 aiRng 都不为它掷。照搬 `SummonGremlins` 必错                                                                                                                                                                                                        |
| 去掉末尾的 `++monsterTurnIdx`                    | **375** | 「2 号位那颗球本回合不行动」有厚背书                                                                                                                                                                                                                                                                        |
| 两次 `rollMove` 改成 `noOpRollMove`              |     375 | 初始意图空 + 意图历史不动                                                                                                                                                                                                                                                                                   |
| 只 `rollMove` 第一颗（少一次 aiRng）             |     375 |                                                                                                                                                                                                                                                                                                             |
| 不给两颗球上 `MINION`                            |     375 | 快照里那两颗缺一个 power                                                                                                                                                                                                                                                                                    |
| **整条改成入队**（照地精那条的写法）             | **203** | ⚠⚠ **与第二十七批 `SummonGremlins` 的 0 例形成对照**：那条 case 的后两句（`setMove` + `noOpRollMove`）都是同步的，召唤一入队就排到它们**之后**，于是 aiRng 的消耗顺序整体改变（noOp 先掷、两颗球的 rollMove 后掷）。**判据仍是第二十六批那条**：这条 case 里同步语句不止一句，所以「同步 ↔ 入队」有可观察面 |
| `monstersAlive += 2` 提到两次 `rollMove` 之前    |   **0** | **等价改写**：青铜球的出招规则不读 `monstersAlive`（只读 `miscInfo` 与意图历史）                                                                                                                                                                                                                            |
| 召唤后重跑 `preBattleAction`                     |   **0** | ⚠ **不是背书也不是盲区，是「这个宿主身上没有可观察面」**：青铜球在参考的 `preBattleAction` switch 里**压根没有 case**，所以「重跑」是空操作。这一位的背书只有第二十七批那 300 例（召唤出来的狂暴小鬼没有狂怒）                                                                                              |

**预留空位的建怪写法（`monsterCount = 1; …; ++monsterCount`）**

| 改坏的                                             |    例数 | 判读                                              |
| -------------------------------------------------- | ------: | ------------------------------------------------- |
| 去掉末尾那句 `++monsterCount`（2 号位不预留）      | **375** | 「留两个空位」有厚背书（快照里少一格 + 召唤越界） |
| 去掉开头那句 `monsterCount = 1`（自动机落 0 号位） | **375** | 「宿主在中间」有厚背书                            |

**眩晕与超射线的充能（`miscInfo` 当 `lastBoostWasFlail`）**

| 改坏的                                       |    例数 | 判读                                                                                                                                              |
| -------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 超射线之后直接回连枷（**跳过眩晕**）         | **375** | 「进眩晕」有厚背书（眩晕意图在 **375 条里全部出现过**）                                                                                           |
| 增益的 `miscInfo` 翻转**判反**               | **375** | 充能节奏整条错位                                                                                                                                  |
| 增益**不翻转** `miscInfo`（恒出连枷）        |     375 | 超射线再也不出                                                                                                                                    |
| 连枷段数 2 → 1                               |     375 |                                                                                                                                                   |
| **超射线收尾的同步 `noOpRollMove` 改成入队** | **292** | ⚠⚠ 「同步 ↔ 入队」这一族本批第二次拿到大例数：超射线的伤害是**入队**的，所以轮到收尾时队列非空——45 点打死玩家 → 主循环跳出 → 入队那次 noOp 轮不到 |
| **眩晕之后改出增益**（而不是连枷）           |  **48** | ⚠ 只有 48 例：眩晕意图 375 条全有，但只**执行**了 48 次——超射线常常直接打死玩家，眩晕那回合永远不到                                               |
| 眩晕那条收尾去掉 `noOpRollMove`              |      48 | 同一个分母                                                                                                                                        |

**多段突刺的段数（`miscInfo`）**

| 改坏的                                       |    例数 | 判读                                                                                                                                 |
| -------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| **段数写死 3（不读 `miscInfo`）**            | **372** | 「段数是状态」有厚背书                                                                                                               |
| `preBattleAction` 去掉 `++miscInfo`          | **375** | 段数的**起点**有厚背书                                                                                                               |
| **`preBattleAction` 的 `+= 1` 抄成 `= 1`**   | **315** | ⚠ 这一条钉住的是「`preBattleAction` 跑在开局那次 `rollMove` **之后**」：那次 rollMove 可能已经把 `miscInfo` 加到 1，`= 1` 会把它吃掉 |
| 出招规则兜底那支不加段数                     |     375 |                                                                                                                                      |
| 出招规则「刚重刺过」那支不加段数             |  **59** | 那一支要求 `roll < 15` **且**上一招是重刺，分母薄                                                                                    |
| 连续限制 `lastTwoMoves` → `lastMove`         |     373 |                                                                                                                                      |
| 阈值 `roll < 15` → `< 16`                    |  **13** |                                                                                                                                      |
| **转写参考那两句死代码**（asc18 时也加段数） |   **0** | ⚠ **结构性不可达**（asc>0 开不了战）。裁定不打补丁，逐条判据见「待裁定」                                                             |

**痛苦突刺（每段打穿各塞一张伤口）**

| 改坏的                              |    例数 | 判读                                                                                                                                                                   |
| ----------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整条不触发                          | **375** | 「塞伤口」有厚背书（`book_of_stabbing.jsonl` 里弃牌堆含伤口的帧 **5071** 个，最多同时 **16** 张、375 条全覆盖）                                                        |
| 每次打穿塞两张                      |     375 |                                                                                                                                                                        |
| 伤口走 `addToTop` 而不是 `addToBot` |  **98** | ⚠ 位置有背书：`addToTop` 会插到多段攻击的后续段之前                                                                                                                    |
| 不上 `PAINFUL_STABS`（快照 + 效果） | **375** | 快照缺一位 + 连带不塞伤口                                                                                                                                              |
| 伤口塞在 `hpWasLost` **之后**       |   **0** | **盲区**：这副 22 张牌组里没有任何「失血触发」（破裂 / 燃烧 / 血债血偿都不在），所以两个位置在这里同解。⚠ 它**不是**可证的等价改写——`hpWasLost` 在参考里真的会入队东西 |

**停滞（挑牌 / 存槽 / 还牌）**

| 改坏的                                            |    例数 | 判读                                                                                                                                                |
| ------------------------------------------------- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **优先从弃牌堆取**（而不是抽牌堆）                | **375** | 「抽牌堆优先」有厚背书（抽牌堆空的帧 **377** 个，所以从弃牌堆取那一支**真的走到了**）                                                               |
| 不上 `STASIS` power                               | **375** | 快照缺一位 + 连带不还牌（带 STASIS 的帧 **6800** 个，两颗球同时带的帧 5811，375 条全覆盖）                                                          |
| **稀有度排序方向反转（降序）**                    | **317** | 按 `cardSortedIdx` **升序**取有背书                                                                                                                 |
| **两颗球共用 0 号停滞槽**                         | **284** | `min(1, idx)` 的两格分开有背书                                                                                                                      |
| **稀有度优先级去掉 UNCOMMON 一档**                | **269** | 这副牌组里 UNCOMMON 只有灵活 / 觅敌之弱两张，够了                                                                                                   |
| 去掉按 `cardSortedIdx` 的排序                     | **243** | 「排序换掉了取样的坐标系」有背书                                                                                                                    |
| 筛完不再挑（取第一张、RNG 照掷）                  |     241 |                                                                                                                                                     |
| `miscInfo = 1` 放到收尾的 `rollMove` **之后**     | **351** | ⚠ 顺序真的可观察：晚一句会让紧接着的 `getMoveForRoll` 有 75% 概率再出一次停滞                                                                       |
| **球死掉不还牌**                                  | **350** | ⚠ 与独立数出来的数字**一模一样**：带 STASIS 的球在相邻帧里 `alive` 从 true 翻 false 的次数正是 **350**                                              |
| 整条效果改成入队                                  |   **0** | **等价改写**：这条 case **没有排任何队列动作**，而收尾的 `rollMove` 不读牌堆、`stasisAction` 只消耗 `cardRandomRng`（两条独立流）——判据同第二十六批 |
| 「已用过停滞」读 `STASIS` power 而不是 `miscInfo` |   **0** | **等价改写**，而且**可证**：两者只在「两堆都空、`stasisAction` 提前 return」时分岔，而那一支在本语料里 **0 次**（见下）                             |
| **两堆都空时也掷一次 `cardRandomRng`**            |   **0** | **盲区**：`automaton.jsonl` 里「抽牌堆与弃牌堆同时为空」的帧是 **0 个**（22 张牌组打不空两堆）。见下方盲区表                                        |
| 去掉 `notifyRemoveFromCombat`（`strikeCount`）    |   **0** | **盲区**：`strikeCount` 的唯一读者是**完美打击**的伤害，而这副 22 张牌组里没有它，`strikeCount` 也不进快照                                          |
| 还牌绕过 `moveToHandHelper`（忽略 10 张上限）     |   **0** | **盲区**：还牌那一刻手牌恰好满 10 张的情形没出现（手牌达到 10 张的帧有 **47** 个，但都不在还牌那一帧）                                              |

**支援光束（`gain_block_ally_fixed` + `noAliveGate`）**

| 改坏的                                  |    例数 | 判读                                                                                                                                                                  |
| --------------------------------------- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **目标改成自己**（而不是写死的 1 号位） | **672** | ⚠ 超过 375 是因为它是**共享原语**：`centurion_and_healer` 的防守也走同一条路径，两个编队一起红                                                                        |
| 数值 12 → 6（旧近似表的值）             | **351** | 这是本批修掉的一处**数据表错误**                                                                                                                                      |
| **补上 `monstersAlive > 1` 那道门**     |   **0** | **等价改写，而且可证**：出这一招要求这颗球活着，而自动机一死战斗当场结束（`MINION_LEADER`）→「球活着」蕴含「自动机也活着」→ `monstersAlive >= 2` 恒成立。**不是盲区** |

**青铜球的出招规则与三种收尾**

| 改坏的                                  |    例数 | 判读                                                                                                                                                                 |
| --------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **支援光束收尾改成入队 `noOpRollMove`** | **319** | 「同步的真 rollMove」有厚背书（意图当场就换、且真的滚新意图）                                                                                                        |
| 兜底改成光束（而不是支援光束）          | **193** | 「兜底又是支援」有背书                                                                                                                                               |
| **光束收尾从入队 `RollMove` 改成同步**  |  **46** | ⚠⚠ 「同步 ↔ 入队」这一族本批**第三处非 0**：光束的伤害是入队的，同步 rollMove 会抢在它之前；若反伤打死了这颗球，入队那次 RollMove 会被 `clearPostCombatActions` 清掉 |
| 支援阈值 `roll >= 70` → `>= 71`         |  **21** |                                                                                                                                                                      |
| 停滞阈值 `roll >= 25` → `>= 26`         |   **7** | ⚠ 只有 7 例：要 roll 恰好落在 25                                                                                                                                     |

**自动机的开局 Power 与增益的两句**

| 改坏的                                         |    例数 | 判读                                                                                      |
| ---------------------------------------------- | ------: | ----------------------------------------------------------------------------------------- |
| 去掉 `ARTIFACT 3`                              | **375** | 快照缺一位（`ARTIFACT 3` 的第二个宿主）                                                   |
| 去掉 `MINION_LEADER`                           | **375** | 同上，而且这场仗会一直打到把两颗球也清完                                                  |
| 增益的格挡改成入队（去掉 `sync`）              |   **0** | **等价改写**：这条 case 的另一句（力量 buff）也是同步的，且收尾的 `noOpRollMove` 不读格挡 |
| 增益里力量与格挡的顺序交换                     |   **0** | **等价改写**：两句都是同步的、互不读对方                                                  |
| 出招规则「第二次被调用就抛错」改成静默返回召唤 |   **0** | **等价改写**：那道 assert 从没被触发（说明五条收尾都抄对了）。它是**自检**而不是行为      |

**`isMoveAttack` 白名单（第二十四批起有预言机）**

| 改坏的                                   |     例数 | 判读                                                                                                     |
| ---------------------------------------- | -------: | -------------------------------------------------------------------------------------------------------- |
| 谓词恒真                                 | **1077** | ⚠ 第二十七批量到的是 **949**，本批两个新文件因此贡献 **128** 例（旧文件逐字节未变，所以那 949 一例不差） |
| 白名单**漏掉**突刺之书那两条             |  **259** | 全在 `book_of_stabbing`                                                                                  |
| 白名单**多收**自动机的增益 / 召唤 / 眩晕 |   **80** | 全在 `automaton`                                                                                         |
| 白名单**漏掉**自动机两条 + 青铜球那一条  |   **64** | 全在 `automaton`                                                                                         |
| 白名单**多收**青铜球的停滞与支援光束     |   **59** | 全在 `automaton`                                                                                         |

⚠ **两个方向都量了**（WORKFLOW 那条警告）：`automaton` 在「恒真」方向的分母来自
增益 / 召唤 / 眩晕 / 停滞 / 支援光束五个非攻击意图，所以两个方向都不薄。

**数值（三只怪的血量与招式数字）**

| 改坏的                                      |    例数 | 判读                                                                                                                                                           |
| ------------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **自动机血量改成 `hpNoRoll`**（一次都不掷） | **375** | ⚠⚠ 钉住 WORKFLOW 那条：`{300,300}` **照样掷一次** `monsterHpRng`（`Random::random(300,300)` 无条件 `++counter`），「上下界相同」不是 `hpNoRoll` 的判据         |
| 乱刺每击 6 → 5                              |     375 |                                                                                                                                                                |
| 增益力量 3 → 2                              |     375 |                                                                                                                                                                |
| 增益格挡 9 → 8                              |     375 |                                                                                                                                                                |
| 光束 8 → 7                                  |     373 |                                                                                                                                                                |
| 青铜球血量区间 `(52,58)` → `(52,57)`        |     373 | ⚠ 与「白掷那次的区间」形成对照：**正式那次**的上下界是有背书的（取值被用），白掷那次没有（见下）                                                               |
| **突刺之书血量上界 164 → 162**（旧近似表）  | **319** | 这是本批修掉的一处**数据表错误**                                                                                                                               |
| 重刺 21 → 20                                |     272 |                                                                                                                                                                |
| **超射线 45 → 44**                          |  **55** | ⚠ 只有 55 例：45 点几乎必然打死玩家，44 也一样——只有血量恰好在 45 与 44 之间的那几条会分岔                                                                     |
| **`hpDiscardRoll` 区间抄成高档 `(54,60)`**  |   **0** | ⚠ **结构性不可观测**（第二十七批已证）：那次掷骰的取值被丢弃，而 `Random::nextLong(n)` 的实际前进步数与 n 无关。**次数**有背书（375 例），区间没有、也不可能有 |

**`STASIS_CARD_INFO` 那张表（稀有度 + 排序键）**

| 改坏的                                       |    例数 | 判读                                                                       |
| -------------------------------------------- | ------: | -------------------------------------------------------------------------- |
| 按堆内下标排序（而不是 `cardSortedIdx`）     | **243** | 排序键有背书（与「去掉排序」同为 243，因为筛出来的牌本来就按堆内顺序排着） |
| **稀有度那一列改成从 `CardDef.rarity` 派生** |   **0** | ⚠⚠ **盲区，而且是本批最该记清楚的一条**——见下                              |

⚠⚠ **「不能从 `CardDef.rarity` 派生」这条论断目前没有背书。**
两者在 118 张已映射的牌里有 15 张不一致，但**那 15 张一张都进不了这个编队的牌堆**：
variant 28 的牌组是 `BATCH_1 + SPOT_WEAKNESS`（15 种牌，三档稀有度两边全都一致），
而青铜自动机与青铜球**都不往玩家牌堆塞牌**，所以状态牌也进不来。
于是「派生」与「照抄」在这 375 条上逐位相同。

**仍然照抄参考、单开一张表**，理由是**判据 ③**（形状唯一）而不是「量到了」：
参考读的是 `Cards.h` 的 `cardRarities`，我们的 `rarity` 是 run 层的奖励池语义，
两者**必然**在别的牌组上分岔——把它写成派生就是埋一个只在换牌组时才炸的静默错。
⚠ 这一条**如实记成盲区**（下方盲区表也有），**关门条件很便宜**：给将来某个带青铜自动机的
新 variant 的牌组加**一张**分歧牌（例如 `IMPATIENCE`：参考 UNCOMMON、我们 `common`），
或者让一只会塞伤口的怪与自动机同场。⚠ 不能改 variant 28 本身（它已冻结）。

### 第二十七批：召唤（地精首领）与工头

**本批是纯追加**：`--install` 之前先跑过 `--check`，已提交的 53 个文件全部逐字节一致；
装完 `git status` 只有两个 `??`（`gremlin_leader.jsonl` / `slavers.jsonl`），**零个 `M`**。
没有动参考项目的任何 gameplay 代码（只加了 harness 的 variant 27），因此
**不需要 `ALLOW_CHANGED`，也没有旧例数需要重量**。
总例数 22456 → **23206**（+750 = 2 × 375）。

#### 本批的四份工作 × 两只怪

| 怪       | 数据表（`enemies.ts`）                                                                                                  | `MOVE_RULES`                                                                                                               | `takeTurn` 效果                                             | 收尾（`MOVE_TURN_END`）                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| 地精首领 | 140~148 血（精英阈值 asc>=8）；三招（集结 = 召唤两只 / 鼓舞 = 前三格各 +3 力量 +6 格挡、自己只 +3 力量 / 突刺 **6×3**） | 按**活着的小鬼数**分**三整块**（阈值 75 / 50+80 / 66），「1 只」那块有**两处** `roll2`（`random(50,99)` / `random(0,80)`） | `summon_gremlins`（入队）+ `buff_minions`（同步）+ 多段攻击 | 三条都是默认的入队 `roll`；鼓舞在效果**之前**白掷一次 `random(0,2)` |
| 工头     | 54~60 血 + **`hpDiscardRoll`**（先白掷一次 `(54,60)` 再掷血，共 2 次 monsterHpRng）；一招（抽打 7 + 一张伤口进弃牌堆）  | 恒返回抽打，roll 照掷被丢弃                                                                                                | 攻击（入队）+ `add_card`（入队）                            | **同步**的 `noOpRollMove`（第五形态，不是这张表的 `"no_op_roll"`）  |

⚠ **旧近似数据表在这两只身上又错了一轮**（与第二十三 / 二十五 / 二十六批同一个结论）：
首领的集结被写成「固定召唤狂暴 + 鬼祟」（实为 8 项候选表逐只掷）、鼓舞被写成
`on: "all_enemies"` 且**没有格挡**（实为「前三格 + 自己」且给格挡）、突刺被写成**单段 6 点**
（实为 6×3 = 18）、两只的 `intentRule` 权重表全是编的；
**`ENCOUNTERS.slavers` 的成员顺序也是错的**（工头被写在首位，参考是**中间**）。

#### 本批新增的共享原语

| 原语                                          | 位置                           | 为什么必须动                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`summon_gremlins`**（召唤）                 | `takeTurn` + `Effect` + 新函数 | 第一次「凭空加怪」。九处形状见 `summonGremlins` 的注释；与分裂**不共用任何代码**（分裂写「母体那格 + 右边一格」并动 `monsterCount`，召唤填**预留空位**且 `monsterCount` 不动）             |
| **`getGremlin(rng)`**（种类候选表）           | 新函数                         | ⚠ **rng 是形参**：建怪走 `miscRng`、召唤走 `aiRng`。参考正是为此把它写成 `static MonsterId getGremlin(Random &rng)`                                                                        |
| **`buff_minions`**（鼓舞）                    | `takeTurn` + `Effect`          | 与第二十六批那三条「写死单个下标」的原语不同族：这条**遍历 0/1/2 三格**（参考真的写了 for 循环），门是 `!isDying()`，自己那份在循环**外面**且**没有格挡**。两个 asc 分档是**两个独立的数** |
| **`EnemyDef.hpDiscardRoll`**（先白掷一次）    | 数据表 + `constructMonster`    | `Monster::initHp` 的第四种形态。⚠ 区间必须单独写：工头两组恰好相同，青铜球是 `(52,58)` 对 `{50,56}`——`Random::random(a,b)` 的**取值**依赖上下界                                            |
| **`monstersAlive` 不再等于数组长度**          | `initCombat`                   | 地精首领那条 case 手动写 `monstersAlive = 3; monsterCount = 4;`。改成「数组里非空位的个数」                                                                                                |
| **`initCombat` 的两个循环跳过空位**           | `initCombat`                   | 参考的门是 `if (arr[i].idx != -1)`（`MonsterGroup.cpp:78 / :84`）——从没被构造过的那一格既不 rollMove 也不 preBattleAction                                                                  |
| **`monsterDie` 的第二条判胜路径**             | `monsterDie`                   | `monstersAlive == 0 \|\| hasStatus<MINION_LEADER>()`。⚠ 这不是「加个字段」：首领一死当场判胜且**当场 return**，小鬼还站着也算赢                                                            |
| **`minion` / `minion_leader` 两个 `PowerId`** | `types.ts` + `POWER` 映射      | 都是纯 bool（harness 输出 1）。`MINION` 战斗内**一次都不被读**（三个读者都在没登记的卡牌里），但它进快照，漏了当场抛「未映射的 power」                                                     |

#### 变异测试（例数 = 对拍失败的 trace 条数，总 23206）

⚠ 分母提醒：本批两个文件各 375 条，两只新怪各只有一个出处，所以**每条的上限是 375**。
⚠ 本批 55 条变异全部单独跑、跑完 `git checkout --` 还原，末尾复跑一次对拍确认回到全绿
（`failed=0 passed=23206`）。

**召唤（`summonGremlins`，九处形状）**

| 改坏的                                                         |    例数 | 判读                                                                                                                    |
| -------------------------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------- |
| 找空位顺序 1,2,0 → 0,1,2                                       | **375** | 整份全红。⚠ 顺序决定**哪只新怪落哪一格**——实测 0 号位被填了 **118** 次，那正是两种顺序分岔的地方                        |
| 往数组尾 push 而不是覆盖那一格                                 |     375 | `monsterCount` 会变长，快照当场多一格                                                                                   |
| 挑种类走 `miscRng` 而不是 `aiRng`                              |     375 | ⚠ 这是「同一个函数、两个调用方用不同流」那条，抄错整条 aiRng 错位                                                       |
| 两只新怪不 `rollMove`                                          |     375 | 少 2 次 aiRng + 意图空                                                                                                  |
| 不给新怪上 `MINION`                                            |     375 | 快照里那两只缺一个 power                                                                                                |
| **补上 `preBattleAction`**                                     | **300** | ⚠⚠ 本批最反直觉的一条：参考**真的没调**，所以召唤出来的狂暴小鬼**没有狂怒**。补上就红 300 例                            |
| `monstersAlive += 2` → `+= 1`                                  |     346 |                                                                                                                         |
| 整条改成**同步**（不入队）                                     |   **0** | **等价改写**：怪物回合开始时队列是空的，`SummonGremlins` 与紧随其后入队的 RollMove 相对顺序不变（判据同第二十六批那条） |
| 空位判据 `hp <= 0` → `!alive`                                  |   **0** | **等价改写**：小鬼不逃跑、不假死，两者同解。以后有「会逃跑的随从」时会分岔                                              |
| 去掉 0 号位那道 `openIdxCount < 2` 门（但仍按 1,2,0 取前两个） |   **0** | **等价改写**：那道门的作用就是「取够两个就不看 0 号位」                                                                 |
| `rollMove` 提到 buff `MINION` 之前                             |   **0** | **等价改写**：五种小鬼的出招规则一条都不读 powers                                                                       |
| 两只交错建（ai,ai,hp,hp 而不是 ai,hp,ai,hp）                   |   **0** | **等价改写**：`aiRng` 与 `monsterHpRng` 是两条独立流，交错顺序不影响任一条的取值序列（同第十七批池抽 4 那条）           |

**开局建怪（`ENCOUNTER_BUILDERS.gremlin_leader`）与 `slavers` 的顺序**

| 改坏的                                                |    例数 | 判读                                                        |
| ----------------------------------------------------- | ------: | ----------------------------------------------------------- |
| `slavers` 顺序改回「工头在首位」（旧近似表）          | **375** | 整份全红。这是本批修掉的一处**数据表错误**                  |
| `slavers` 蓝红对调（工头仍在中间）                    |     375 |                                                             |
| `gremlin_leader` **不留 0 号空位**（首领落 2 号位）   |     375 | 「开局就留空位」这件事有厚背书                              |
| 空位挪到 3 号位（首领落 2 号位）                      |     375 |                                                             |
| 两只小鬼的种类走 `aiRng` 而不是 `miscRng`             |     375 | 与召唤那条方向相反，两边各自钉住                            |
| 不给开局两只小鬼上 `MINION`                           |     375 |                                                             |
| `rollMove` 循环**不**跳过空位（空位也 rollMove）      |     375 | 空位没有数据表条目 → 直接抛错；即使不抛也会多掷 aiRng       |
| `getGremlin` 候选表去掉重复（8 → 5 项）               |     375 | 候选表**带重复**（狂暴/鬼祟/肥胖各 ×2）有背书               |
| `getGremlin` 掷 `random(8)` 而不是 `random(7)`        |     374 |                                                             |
| 先掷两次种类再建两只（misc,misc,hp,hp）               |   **0** | **等价改写**，同上（两条独立流）                            |
| **开局 `monstersAlive` 把空位算进去**（= 数组长度 4） |   **0** | **盲区**，见下方盲区表——这个编队里没有任何东西能分辨 3 与 4 |

**`MINION_LEADER`（首领一死当场判胜）**

| 改坏的                                      |    例数 | 判读                                                                                                                                                                                |
| ------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不上 `MINION_LEADER`                        | **375** | 快照缺一个 power（整份全红）                                                                                                                                                        |
| **去掉判胜条件里 `MINION_LEADER` 那一半**   |   **4** | ⚠ 只有 **4 例**，但**不是 0**。实测：首领在 375 条里死了 **55** 次、**55 次都当场判胜**，其中只有 **4** 次身边还有活着的小鬼——其余 51 次 `monstersAlive` 本来也归零了，两个条件同解 |
| 判胜时**不 `return`**（后面的亡语链继续跑） |   **0** | **盲区**：与第十六批那条「最后一只就 return」同一个根（`checkCombat` 的清扫机制重复），且首领没有亡语                                                                               |

**鼓舞（`buff_minions`）**

| 改坏的                                       |    例数 | 判读                                                             |
| -------------------------------------------- | ------: | ---------------------------------------------------------------- |
| 范围 0..2 → **场上全体**（首领被算两次）     | **375** | 「只加前三格」有厚背书                                           |
| 去掉「没死才加」那道门                       |     375 | 死掉的小鬼身上会多出力量/格挡                                    |
| **自己也加格挡**                             |     375 | ⚠ 循环外那句只有 `buff<STRENGTH>`，**没有** `addBlock`           |
| 自己不加力量                                 |     375 |                                                                  |
| 力量 3 → 2                                   |     375 |                                                                  |
| 格挡 6 → 5                                   |     362 |                                                                  |
| **开场那次白掷 `aiRng.random(0,2)` 去掉**    | **375** | 「对白掷骰」的**次数**有厚背书（取值本身不可验证，同族见盲区表） |
| 门用 `alive` 而不是 `hp > 0`                 |   **0** | **等价改写**：小鬼不逃跑、不假死                                 |
| 整条效果改成入队（收尾的 RollMove 会先出队） |   **0** | **等价改写**：首领的出招规则读的是**小鬼的血量**，不读力量/格挡  |

**突刺（6×3 多段）**

| 改坏的        |    例数 |
| ------------- | ------: |
| 6×3 → 6×2     | **372** |
| 每击 6 → 5    |     371 |
| 6×3 → 单段 18 |     369 |

**首领的出招规则（三整块 + 两处 `roll2`）**

| 改坏的                                               |    例数 | 判读                                                                    |
| ---------------------------------------------------- | ------: | ----------------------------------------------------------------------- |
| `aliveGremlins` 数全体 4 格（含首领自己）            | **354** | 「只数 0/1/2」有厚背书                                                  |
| 「0 只」块 `lastMove(rally)` 那一支互换              |     297 | ⚠ 这条**不能**用来判「rally 侧可达」——它同时改了 false 侧，见下面的探针 |
| 「>1 只」块去掉 `lastMove(encourage)` 的连续限制     |     156 |                                                                         |
| 「0 只」块 `roll >= 75` 那一支的 `lastMove(gl_stab)` |      66 |                                                                         |
| 「1 只」块 `roll >= 80` 那一支的 `lastMove(gl_stab)` |      60 |                                                                         |
| 「>1 只」块去掉 `lastMove(gl_stab)` 那一支           |      47 |                                                                         |
| **`roll2` 区间 `(0,80)` → `(0,79)`**                 |  **27** | ⚠ **闭区间上界 80 有背书**（这次 `roll2` 的取值真的被用）               |
| 「1 只」块的阈值 50 → 49                             |      13 |                                                                         |
| 「>1 只」块的阈值 66 → 65                            |      13 |                                                                         |
| 「1 只」块的阈值 80 → 79                             |       5 |                                                                         |
| 「0 只」块的阈值 75 → 74                             |       3 | ⚠ 只有 3 例：要 `aliveGremlins == 0` 且 roll 恰好落在 74                |
| `aliveGremlins` 用 `alive` 而不是 `hp > 0`           |   **0** | **等价改写**                                                            |
| **`roll2` 区间 `(50,99)` → `(0,99)`**                |   **0** | **盲区**，见下                                                          |
| **那次 `random(50,99)` 整条去掉、直接用 `roll`**     |   **0** | **盲区**，见下                                                          |

⚠⚠ **两处 `roll2` 里只有一处有背书，另一处结构性不可达——本批新发现的一条盲区。**
两条 0 例指向同一件事，用两个专门的**可达性探针**确认了：

| 探针                                            |  例数 | 结论                                    |
| ----------------------------------------------- | ----: | --------------------------------------- |
| 「0 只」块的 `lastMove(rally)` 恒假             | **0** | `lastMove(RALLY)` **永远为假**          |
| 「1 只」块的 `lastMove(rally)` 恒假（整支砍掉） | **0** | 同上，所以 `random(50,99)` 整支都走不到 |

**根在参考自己的形状里，与牌组 / 种子无关**：集结那条 case 是
`addToBot(SummonGremlins()); addToBot(RollMove(idx));` —— 两条动作**紧挨着**，中间插不进任何
东西。于是首领的下一次 `getMoveForRoll` 一定跑在「刚好填满两格」之后，`getAliveGremlinCount()`
必然 **≥ 2**，直接落进「>1 只」那块——而那块**根本不读 `lastMove(RALLY)`**。
所以两个 `lastMove(RALLY)` 分支（以及嵌在其中的 `aiRng.random(50, 99)` 与它的两个返回值）
在参考的整个内容集合里是**死代码**。这与第二十二批地精头目 asc18 那条自锁、以及第十四批
酸液 L 那条恒假条件是**同一个家族**，但这条**不是笔误**（形状本身没矛盾，只是被邻居的时序挤死了），
所以**不报补丁**、照抄。

**工头的抽打与 `hpDiscardRoll`**

| 改坏的                                                |    例数 | 判读                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 塞的牌 伤口 → 灼伤                                    | **375** | 「塞的是伤口」有厚背书（弃牌堆快照里含伤口的帧 **5670** 个，最多同时 **7** 张）                                                                                                                                                            |
| 伤口张数 1 → 2                                        |     375 |                                                                                                                                                                                                                                            |
| 抽打伤害 7 → 6                                        |     375 |                                                                                                                                                                                                                                            |
| **`hpDiscardRoll` 整条去掉**（少一次 hpRng）          | **375** | 「掷两次」有厚背书                                                                                                                                                                                                                         |
| **收尾整条去掉**（少一次 aiRng）                      | **375** |                                                                                                                                                                                                                                            |
| **收尾的同步 `noOpRollMove` → 入队的 `"no_op_roll"`** |   **5** | ⚠⚠ **不是 0**——这一族里第二次拿到非 0（第一次是第二十批灼烧的 34 例）。判据是第二十六批那条**反过来用**：这条 case 的效果**全是入队的**，所以轮到收尾时队列非空；抽打打死玩家 → 主循环跳出 → 入队那次 noOp 永远轮不到，同步那次已经掷过    |
| 塞伤口改成**同步**（排到攻击之前）                    |   **5** | 同一个根，同一批 trace                                                                                                                                                                                                                     |
| 收尾改成入队的真 `rollMove`                           |   **5** | 同上。⚠ 「真 rollMove ↔ noOp」在它身上是**等价改写**（只有一招，`moveHistory` 不进快照），非 0 的那 5 例全来自「同步 ↔ 入队」                                                                                                              |
| **`hpDiscardRoll` 区间 `(54,60)` → `(54,59)`**        |   **0** | ⚠ **结构性不可观测，不是盲区也不必找逃生口**：那次掷骰的取值被丢弃，而 `Random::nextLong(n)` 的实际前进步数**与 n 无关**（rejection 循环几乎必然只转一次），所以上下界写什么都逐位等价。**次数**有背书（375 例），**区间**没有、也不可能有 |

**`isMoveAttack` 白名单（第二十四批起有预言机）**

| 改坏的                                    |    例数 | 分布                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 谓词恒真                                  | **949** | `CENTURION_AND_HEALER` 186 / **`GREMLIN_LEADER` 167** / `CULTIST_AND_CHOSEN` 108 / `CHOSEN_AND_BYRDS` 97 / `THREE_BYRDS` 80 / `TWO_THIEVES` 71 / `SENTRY_AND_SPHERE` 67 / `THREE_CULTIST` 58 / `SNECKO` 55 / `JAW_WORM_HORDE` 24 / `CULTIST` 8 / `SHELLED_PARASITE_AND_FUNGI` 8 / `THREE_LOUSE` 7 / **`SLAVERS` 6** / `JAW_WORM` 4 / `TWO_LOUSE` 3 |
| 白名单**漏掉** `GREMLIN_LEADER_STAB`      |  **19** | 全在 `GREMLIN_LEADER`                                                                                                                                                                                                                                                                                                                              |
| 白名单**漏掉** `TASKMASTER_SCOURING_WHIP` | **144** | 全在 `SLAVERS`                                                                                                                                                                                                                                                                                                                                     |
| 白名单**多收**集结与鼓舞                  | **100** | 全在 `GREMLIN_LEADER`                                                                                                                                                                                                                                                                                                                              |

⚠ 「谓词恒真」那 949 例里本批两个文件占 **173**（167 + 6），其余 776 例与第二十六批量到的
776 **一例不差**，再次印证「本批是纯追加」。
⚠ **两个方向都量了**（WORKFLOW 那条警告）：`SLAVERS` 在恒真方向只有 **6 例**——它三只怪的招式
里只有红奴隶主的缠绕不是攻击，分母很薄；反方向（漏掉工头那条）**144 例**才是它真正的背书。
这与第二十五批 `SHELL_PARASITE` 那个例子同族，**只量恒真会把它误判成几乎没背书**。

### 第二十六批：友方治疗与增益（百夫长 + 秘法师）与三个「已登记怪的新组合」

⚠ **本批不是纯追加**：`shell_parasite` 与 `shelled_parasite_and_fungi` 两个已冻结文件
因为参考侧的 `roll2` 补丁被重新生成（走 `ALLOW_CHANGED`），所以**第二十五批在这两个文件上
量到的例数必须重量**（见下方「roll2 补丁」小节，两个数一个字没变）。其余 47 个文件逐字节未动。
总例数 20956 → **22456**（+1500 = 4 × 375）。

#### 本批的四份工作 × 两只怪

| 怪     | 数据表（`enemies.ts`）                                                    | `MOVE_RULES`                                                                                    | `takeTurn` 效果                             | 收尾（`MOVE_TURN_END`）                              |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| 百夫长 | 76~80 血；三招（斩击 12 / 狂怒连斩 6×3 / **防守 = 给 `arr[1]` 15 格挡**） | 65 那道阈值 + 两条 `lastTwoMoves`，且「秘法师还活着吗」决定防守 / 狂怒。**不追加 aiRng**        | 两条攻击 + 一条 `gain_block_ally_fixed`     | 防守是**同步的真 rollMove**，其余默认 `roll`         |
| 秘法师 | 48~56 血；三招（治疗 16 / 鼓舞 +2 力量 / 法击 8 + 脆弱 2）                | **全项目唯一读生命值的出招规则**（自己或 `arr[0]` 缺 ≥16 血就强制治疗）→ 40 那道阈值 → 连续限制 | `heal_ally` / `buff_ally` / 攻击 + 入队脆弱 | 治疗与鼓舞都是**同步的真 rollMove**，法击默认 `roll` |

⚠ **旧近似数据表在这两只身上又错了一轮**（与第二十三 / 二十五批同一个结论）：百夫长的防守被写成
「自己 +15 格挡」（实为**给 1 号位的秘法师**、自己一点不加）、秘法师的鼓舞被写成
`on: "all_enemies"`（实为「`arr[0]` + 自己」）、秘法师的法击**整个漏掉了脆弱**、
三只怪的 `intentRule` 权重表全是编的。另外三个编队里 `sentry_and_sphere` 被写成**三只**
（哨卫 / 球卫 / 哨卫），参考只有两只——多一只会让 `monsterHpRng` 多掷一次、整条流错位。

#### 本批新增的共享原语

| 原语                                            | 位置                           | 为什么必须动                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`gain_block_ally_fixed`**（百夫长的防守）     | `takeTurn` + `Effect`          | 与第十七批盾牌小鬼那条 `gain_block_ally` 三处都不同：目标**写死 1 号位**（不掷 aiRng）、**同步**执行、空候选时**什么都不做**（不退化成给自己）。复用那条必错               |
| **`heal_ally`**（秘法师的治疗）                 | 同上                           | `if (monstersAlive > 1) arr[0].heal(n); heal(n);` ——**两只都回**、目标写死、都是同步。类型里原先那句「治一名受伤的友军，没有就治自己」是错的注释，本批改掉                 |
| **`buff_ally`**（秘法师的鼓舞）                 | 同上                           | 与 `heal_ally` 逐字同形。⚠ 与 `apply_power on: "all_enemies"` 语义不同（「0 号位与自己」vs「场上每一只」），两怪编队下同解、三怪以上分岔                                   |
| **「只有一句的同步真 `rollMove`」这个收尾形态** | `MOVE_TURN_END` 三条           | 第二十五批那条是 `setMove(FELL); rollMove(bc);` **两句**，这三条只有 `rollMove(bc)` 一句。别照搬邻居                                                                       |
| **编队 id 对齐参考枚举名**（两处）              | `enemies.ts` 编队表 + 第二幕池 | `centurion_mystic` → `centurion_and_healer`、`three_cultists` → `three_cultist`（**单数**）。trace 文件名由枚举名小写而来，wiring 测试要求它与 `SUPPORTED_ENCOUNTERS` 一致 |

#### 变异测试（例数 = 对拍失败的 trace 条数，总 22456）

⚠ 分母提醒：本批四个文件各 375 条，`centurion_and_healer` 那一个是百夫长 / 秘法师唯一的出处，
所以**它的上限是 375**。

**秘法师的治疗（`heal_ally`）**

| 改坏的                                             |    例数 | 判读                                                                  |
| -------------------------------------------------- | ------: | --------------------------------------------------------------------- |
| 去掉生命上限钳制                                   | **382** | `min(maxHp, …)` 有背书（秘法师血少、经常被治到满）                    |
| 去掉 `monstersAlive > 1` 那道门（同伴死了也治）    | **375** | 整份全红：百夫长死后秘法师还打很久，治一具尸体会当场改快照            |
| 治疗量 16 → 15                                     |     358 |                                                                       |
| 只治 `arr[0]`（去掉「自己也回」那句）              |     344 |                                                                       |
| 只治自己（去掉 `arr[0]` 那半）                     |     335 |                                                                       |
| 目标 `arr[0]` → **随机友军**（盾牌小鬼那条的写法） |     335 | ⚠ 这正是「别照搬邻居」那条：随机版还会掷一次 aiRng，`rng.ai` 当场错位 |
| **治疗改成入队、收尾仍同步 rollMove**              |  **79** | ⚠⚠ 见下：被钉住的是**相对顺序**，不是「同步 vs 入队」                 |
| 两句顺序调换（先治自己再治 `arr[0]`）              |   **0** | **等价改写**：两笔互不影响，各自独立钳制                              |

**秘法师的鼓舞（`buff_ally`）与法击**

| 改坏的                                   |    例数 | 判读                                                           |
| ---------------------------------------- | ------: | -------------------------------------------------------------- |
| 法击的脆弱 2 → 1 层                      | **287** |                                                                |
| 法击 8 → 9                               |     277 |                                                                |
| 鼓舞的力量 2 → 3                         |     248 |                                                                |
| 只 buff 自己（去掉 `arr[0]` 那半）       |     159 |                                                                |
| 法击的脆弱改成同步（`sync: true`）       |   **2** | ⚠ 只有 2 例，但**不是 0**——「同步 ↔ 入队」一族里罕见的有背书者 |
| 鼓舞改成 `on: "all_enemies"`（旧近似表） |   **0** | **等价改写**：只有两只怪，「0 号位 + 自己」= 「场上每一只」    |
| 鼓舞改成入队、收尾仍同步 rollMove        |   **0** | **等价改写**：秘法师的出招规则只读**血量**，不读力量           |

**「同步的真 rollMove」这个收尾形态（三条）**

| 改坏的                                      |    例数 | 判读                         |
| ------------------------------------------- | ------: | ---------------------------- |
| 秘法师治疗的收尾 → `no_op_roll`（掷完丢掉） | **374** | 「真的滚一个新意图」有背书   |
| 百夫长防守的收尾 → `no_op_roll`             | **305** | 同上                         |
| 三条收尾一起 → 入队的 `"roll"`              |   **0** | **等价改写**，不是盲区，见下 |
| 百夫长防守的加格挡：同步 → 入队             |   **0** | 同上                         |

⚠⚠ **「同步 ↔ 入队」这一族的判据本批终于说清了。** 怪物回合是「队列排空了才开始」的
（`executeActions` 里 `doMonsterTurn` 的前提就是队列已空），所以**一条 case 里全部效果都是
同步的**时候，把最后一句从同步改成入队是**严格等价**——入队之后队列里就它一条，立刻出队。
本批那四条 0 例全属于这一类，应记成「等价改写」而不是盲区。
⚠⚠ **真正被钉住的是「效果排在 rollMove 之前」这个相对顺序**：把治疗改成入队、收尾仍同步，
红 **79 例**——那样 rollMove 会读到治疗**之前**的血量，刚治完还会再强制治疗一次。
所以照抄参考的形状仍然重要，只是可观察面在**相对顺序**上，不在「同步 vs 入队」这个标签上。

**秘法师的出招规则（全项目唯一读生命值的那条）**

| 改坏的                                     |    例数 | 判读                                                          |
| ------------------------------------------ | ------: | ------------------------------------------------------------- |
| 去掉 `knight` 那半（只看自己缺血）         | **373** | 「也看 0 号位」有厚背书                                       |
| 去掉自己那半（只看 `knight` 缺血）         |     345 |                                                               |
| 缺血阈值 16 → 20（错误地对齐治疗量）       |     103 | ⚠ asc0 下阈值 16、治疗量 16 相等，asc17 是 **21 vs 20**       |
| 法击阈值 40 → 50                           |      81 |                                                               |
| 法击的连续限制 `lastTwoMoves` → `lastMove` |      31 | ⚠ 那正是 asc17 那一支的写法，所以这条同时守住了「低档用哪个」 |
| `>= healNeedAmt` 改成 `>`                  |  **15** | 「恰好缺 16 血就治」这条边界有背书                            |
| 去掉鼓舞的连续限制 `!lastTwoMoves(BUFF)`   |   **0** | **盲区**：实测 352 次鼓舞里连续两次的有 **0** 次，见盲区表    |

**百夫长的防守（`gain_block_ally_fixed`）与斩击**

| 改坏的                               |    例数 | 判读                                                           |
| ------------------------------------ | ------: | -------------------------------------------------------------- |
| 斩击 12 → 11                         | **344** |                                                                |
| 格挡给自己（旧近似表的写法）         |     321 | ⚠ 本批最重要的一条数值：「护住奶妈」是这一招的全部意义         |
| 目标 `arr[1]` → `arr[0]`             |     321 |                                                                |
| 除了给 `arr[1]` 之外**也给自己**一份 |     321 |                                                                |
| 格挡 15 → 14                         |     321 |                                                                |
| 去掉 `monstersAlive > 1` 那道门      |   **0** | **盲区（结构性）**：秘法师死后出招规则就不再返回防守，见盲区表 |

**百夫长的出招规则**

| 改坏的                               |    例数 | 判读                                                                       |
| ------------------------------------ | ------: | -------------------------------------------------------------------------- |
| `mysticAlive` 恒假（改出狂怒连斩）   | **358** |                                                                            |
| 去掉第二支的 `!lastTwoMoves(SLASH)`  |     190 |                                                                            |
| 阈值 65 → 60                         |      69 |                                                                            |
| 去掉第一支的 `!lastTwoMoves(DEFEND)` |      66 |                                                                            |
| **`mysticAlive` 恒真**               |   **8** | ⚠⚠ **不是 0**，机制见下——狂怒连斩的**选择**其实有背书                      |
| `mysticAlive` 改成「1 号位那只活着」 |   **8** | 与上一条**同例数**，正是同一批 trace：两种写错在同一处分岔                 |
| 去掉第一支的 `!lastTwoMoves(FURY)`   |   **0** | **等价改写**：狂怒连斩从不连续出两次（下面那 88 次全是「死后才滚出来的」） |

⚠⚠ **`CENTURION_FURY` 的「选择」有 8 例背书，「效果」一例都没有——两件事要分开记。**
实测：狂怒连斩在 375 条 trace 里作为意图出现 **88 次，全部落在一具已死的百夫长身上**，
所以 `check-coverage.mjs` 报的是 **0 / 0**（那个工具的 `countMoves` 会跳过 `!alive` 的怪）。
机制是**荆棘**：遗物轮换里有青铜鳞片，百夫长的斩击打到玩家身上触发的荆棘走 `addToTop`、
插在它自己那条**入队的 RollMove 之前**——于是低血的百夫长先被荆棘打死，紧接着那次 RollMove
在一具尸体上执行，此时 `monstersAlive == 1`，`mysticAlive` 为假 → 返回狂怒连斩。
死怪的意图**在快照里**（harness 连死怪一起 dump），所以这条分支被钉住了 8 例；
但死怪永远不会 `takeTurn`，所以：

| 改坏的（狂怒连斩的**效果**侧） |  例数 | 判读                                                                                   |
| ------------------------------ | ----: | -------------------------------------------------------------------------------------- |
| 三段 6 → 单段 18               | **0** | **盲区**：它的效果一次都没执行过。✅ **第三十一批关掉**（每击伤害 91 例 / 段数 96 例） |
| 收尾从默认 `roll` 改成 `none`  | **0** | 同上。✅ **第三十一批 88 例**                                                          |

**这也是 `check-coverage.mjs` 的一个已知缺口**：它按「活怪的当前意图」统计，
所以「只在死怪身上出现过的意图」会被报成 0，看起来像完全没背书。判据是**两头都查**——
覆盖表报 0 时，再去数据里 grep 一遍死怪的意图。

**建怪顺序与下标（本批最关键的一处）**

| 改坏的                                 |    例数 | 判读                                          |
| -------------------------------------- | ------: | --------------------------------------------- |
| `centurion_and_healer` 换成秘法师在前  | **375** | 整份全红。写死的 `arr[0]` / `arr[1]` 全部打空 |
| `sentry_and_sphere` 换成球状守卫者在前 | **375** | 同上（哨卫的首招按 `idx % 2` 定）             |
| `cultist_and_chosen` 换成选民在前      | **375** | 同上                                          |
| `three_cultist` 只建两只               | **375** | 同上                                          |

**哨卫首招 `idx % 2 == 0 ? BOLT : BEAM`（第十八批登记，本批第一次在「哨卫不与哨卫同场」的编队上量）**

| 改坏的    |    例数 | 分布                                                                                               |
| --------- | ------: | -------------------------------------------------------------------------------------------------- |
| 恒 `beam` | **870** | `three_sentries` 375 + `sentry_and_sphere` 375 + `@asc19` 120                                      |
| 恒 `bolt` | **495** | `three_sentries` 375 + `@asc19` 120（`sentry_and_sphere` 里哨卫在 0 号位，恒 bolt 与真值一致 → 0） |

**roll2 补丁（参考侧 `b34ae60`）——第二十五批那两个数的重量**

| 改坏的                                                           |   例数 | 分布                                                  | 与第二十五批对比                                             |
| ---------------------------------------------------------------- | -----: | ----------------------------------------------------- | ------------------------------------------------------------ |
| 回退成参考原样（`roll2 = 100` 且判 `roll < 60 \|\| roll2 < 60`） | **41** | `SHELLED_PARASITE_AND_FUNGI` 23 / `SHELL_PARASITE` 18 | 一模一样（那时是「候选补丁」方向，现在是「回退」方向，对称） |
| 去掉那次 `aiRng.random(20, 99)`（掷骰**次数**）                  | **80** | `SHELLED_PARASITE_AND_FUNGI` 44 / `SHELL_PARASITE` 36 | 一模一样——补丁**没动**那次掷骰，这正是执行要求 ②             |

**`isMoveAttack` 白名单（第二十四批起有预言机）**

| 改坏的                             |    例数 | 分布                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 谓词恒真                           | **776** | `CENTURION_AND_HEALER` 186 / `CULTIST_AND_CHOSEN` 108 / `CHOSEN_AND_BYRDS` 97 / `THREE_BYRDS` 80 / `TWO_THIEVES` 71 / `SENTRY_AND_SPHERE` 67 / `THREE_CULTIST` 58 / `SNECKO` 55 / `JAW_WORM_HORDE` 24 / `CULTIST` 8 / `SHELLED_PARASITE_AND_FUNGI` 8 / `THREE_LOUSE` 7 / `JAW_WORM` 4 / `TWO_LOUSE` 3 |
| 白名单**多收**了秘法师的治疗与鼓舞 |     100 |                                                                                                                                                                                                                                                                                                       |
| 白名单**多收**了百夫长的防守       |     110 |                                                                                                                                                                                                                                                                                                       |
| 白名单**漏掉**本批三条             |     176 | 全部在 `CENTURION_AND_HEALER`（那是本批唯一有新招式的编队）                                                                                                                                                                                                                                           |

⚠ 「谓词恒真」那 776 例里本批四个文件占 **419**（186 / 108 / 67 / 58），
其余 357 例与第二十五批量到的 357 **一例不差**（97 / 80 / 71 / 55 / 24 / 8 / 8 / 7 / 4 / 3），
再次印证「本批是在既有语料之后追加」这件事。
⚠ 本批**两个方向都量了**（WORKFLOW 里那条「只量恒真会漏掉单怪编队」的警告）：
四个编队在两个方向上都非 0，没有第二十五批 `SHELL_PARASITE` 那种只靠反方向盖住的情形。

### 第二十五批：镀甲（带壳寄生虫）与困惑（史尼克）

⚠ **本批是纯追加**。`git status`：3 个未跟踪的新文件、**一个 `M` 都没有**，`git diff --stat` 为空
——第二幕的乘积排在第一幕那个之后，新 variant 又追加在 variant 23/24 之后，`traceIdx` 只往后长。
所以此前所有批次量到的例数**一条都没失效**，只会因为总例数从 19831 涨到 **20956**
（+1125 = 3 × 375）而略微偏大。

#### 本批的四份工作 × 两只怪

| 怪         | 数据表（`enemies.ts`）                                                                      | `MOVE_RULES`                                                                                                    | `takeTurn` 效果 | 收尾（`MOVE_TURN_END`）                                  |
| ---------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------- |
| 带壳寄生虫 | 68~72 血；四招（双重打击 6×2 / 重击 18 + 脆弱 2 / **吸取 = 吸血攻击 10** / 眩晕**无效果**） | 首回合 `randomBoolean()` 50/50（asc17 直接重击）；之后 20 / 60 两道阈值，外加一次**掷了但被短路吃掉**的 `roll2` | 三条 + 一条空   | 眩晕是**同步的真 rollMove**（第六形态），其余默认 `roll` |
| 史尼克     | 114~120 血；三招（惑目 = 施加**困惑** / 撕咬 15 / 尾击 8 + **易伤** 2）                     | 首回合恒惑目；之后 `roll < 40 \|\| lastTwoMoves(撕咬)` → 尾击，否则撕咬。**不追加 aiRng**                       | 三条            | 三条全是默认的 `addToBot(RollMove)`，表里不写            |

⚠ **旧近似数据表在这两只身上错得很彻底**（与第二十三批那三只同一个结论）：吸取被写成
「10 点伤害 + 固定回 10 血」（实为**吸血**：回的是这一击**真正扣掉的血**）、尾击上的减益被写成
虚弱（实为**易伤**）、史尼克**整个缺了惑目那一招**、眩晕那一招也不存在。
顺带删掉了当年为吸取虚构的 `heal_self` 效果原语——留着就是关于这只怪的第二份、且是错的真相。

#### 本批新增的共享原语

| 原语                                              | 位置                                                                                                            | 为什么必须动                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **镀甲（PLATED_ARMOR）**                          | `PRE_BATTLE_ACTION` / `monsterDamageUnblocked` 的 else-if 链**第二格** / `applyMonsterEndOfTurnTriggers` 第三条 | 三处协同，两个 14 是两处独立字面量。⚠ 与飞行**相反**：`decrementStatus` 走「枚举 <= WEAK」那一支，归零时**清 statusBits**，所以整条摘掉                     |
| **困惑（CONFUSED）**                              | `drawOneCard` 顶部 + `debuffPlayer` 的 bool 分支                                                                | 整条住在 `CardManager::draw`：抽每一张牌都掷一次 `cardRandomRng.random(3)`（**在 `if (cost != newCost)` 外面**），`cost` 与 `costForTurn` 一起改            |
| **吸血攻击（`Actions::VampireAttack`）**          | 新 `Effect.vampire_attack` + `vampireAttack` / `monsterHeal`                                                    | 打人与回血是**同一条动作**，回血量 = `min(伤害, 这一击真正扣掉的血)`；目标写死 `arr[0]`；`clearOnCombatVictory` 取**默认 true**（普通攻击是 false）         |
| **`CombatPlayer.lastAttackUnblockedDamage`**      | `dealDamageToPlayer` 末段（`Player::attacked` 的 243-257 行）                                                   | 吸血攻击唯一的读者。参考是**跨调用的字段**而不是返回值，照抄；migrate 回填 0（无损）                                                                        |
| **「同步的真 `rollMove`」这个收尾形态**           | `MOVE_TURN_END["shelled_parasite/stunned"]`                                                                     | 与 `no_op_roll`（掷完丢掉）和同步 `setMove`（不掷）都不是一回事：两句各推一格历史，而 `setMove(重击)` 先跑正是为了让紧接着的 `getMoveForRoll` 读到它        |
| **编队 id `shelled_parasite` → `shell_parasite`** | `enemies.ts` 的编队表 + 两个第二幕池                                                                            | 参考的枚举不对称（`ME::SHELL_PARASITE` 建 `MonsterId::SHELLED_PARASITE`），而 trace 文件名由枚举名小写而来、wiring 测试要求它与 `SUPPORTED_ENCOUNTERS` 一致 |

#### 变异测试（例数 = 对拍失败的 trace 条数，总 20956）

⚠ 分母提醒：`shell_parasite` / `shelled_parasite_and_fungi` / `snecko` 各 375 条，
所以「750」= 两个寄生虫编队**整份全红**，是这一批的上限。

**镀甲（三处协同，逐处量）**

| 改坏的                                     |    例数 | 判读                                                                               |
| ------------------------------------------ | ------: | ---------------------------------------------------------------------------------- |
| 开局 14 层写成 13                          | **750** |                                                                                    |
| 开局那 14 点格挡漏掉（只上 Power）         | **750** | 两个 14 是独立字面量，各自都有背书                                                 |
| 受击不再递减（整条失效）                   | **750** |                                                                                    |
| 回合末不加格挡（整条删掉）                 | **750** |                                                                                    |
| 回合末加的是初始 14 而不是当前层数         | **750** | 「加当前层数」这件事本身有背书                                                     |
| **归零不摘除条目**（照抄成飞行那种写法）   |  **13** | ⚠ 本批最关键的一条：它区分 `decrementStatus`（清 bit）与裸 `setStatus`（不清 bit） |
| 归零改意图的怪种门**写错怪**（那支不触发） |  **20** | 「壳破就眩晕」有背书                                                               |
| 归零改意图的怪种门**去掉**                 |   **0** | **等价改写**：当前只有带壳寄生虫带镀甲，去掉门不改变任何行为（不是盲区）           |
| 在链上往后挪一格（到蜷缩之后）             |   **0** | **盲区**（结构性，见下）                                                           |
| 挪到链尾（易塑之后）                       |   **0** | 同上                                                                               |
| 那一格从 else-if 链里独立出来（并列 if）   |   **0** | 同上                                                                               |
| 回合末加格挡与金属化**交换顺序**           |   **0** | **等价改写**：两笔都是同步 `block +=`，加法可交换；而且没有怪同时带这两个 Power    |

⚠⚠ **「归零不摘除条目」只有 13 例，但它是本批最不能抄错的一处。** 例数小是因为要走到它得
先把 14 层壳全打光、之后**还要再挨一次未被格挡的攻击**（21 张的弱牌组下很少见）。
它和飞行那条**方向相反**，抄串了两边都会静默错：
镀甲走 `decrementStatus`（`setHasStatus(newAmount)` 会清 bit），飞行走裸的 `setStatus`（不清）。

⚠ **「链上位置」那三条 0 例是结构性盲区，不是等价改写**：我们侧的链是
镀甲 → 蜷缩 → 飞行 → 易塑 → 沉睡，而**没有一只已登记的怪同时带镀甲与其中任何一个**。
关门条件：一只同时带镀甲与蜷缩/飞行/易塑/荆棘的怪。⚠ 参考里 buff 镀甲的只有两处
——带壳寄生虫，以及第三幕 Boss **DECA / DONU**（`MonsterSpecific.cpp:1695-1696` 各 3 层），
而那两只也不带链上别的 Power。所以这条**很可能永远关不掉**，除非补无敌（DECA/DONU 都没有）。
⚠ 「往前挪一格」在我们这边**不可表达**：链的第一格本该是无敌（INVINCIBLE），而它还没登记，
所以镀甲已经在最前面。

**眩晕那条「同步的真 rollMove」**（分母只有 6 次执行，例数天然是个位数）

| 改坏的                                        | 例数 | 判读                                                                           |
| --------------------------------------------- | ---: | ------------------------------------------------------------------------------ |
| 改成 `no_op_roll`（掷完丢掉、意图不变）       |    6 | 「真的滚一个新意图」有背书                                                     |
| 改成同步 `setMove(重击)`（一次 aiRng 都不掷） |    6 | 「照样掷一次」有背书                                                           |
| **顺序调换**（先 rollMove 再 setMove(重击)）  |    6 | ⚠ 这一格的顺序**真的可观察**，与球状守卫者那种不可观察的「setMove + noOp」不同 |
| 去掉 `setMove(重击)`、只 rollMove             |    1 | 只影响那一跳读到的 `lastMove`，所以更薄                                        |

⚠ **6 例就是这一格的全部背书**（`SHELLED_PARASITE_STUNNED` 全库执行 6 次、出现 16 次）。
换布局 / 换编队时要重量一遍——这是本批最薄的一条，与守卫者泄气那条（4 例）同族。

**带壳寄生虫的出招规则**

| 改坏的                                         |    例数 |
| ---------------------------------------------- | ------: |
| 首回合 `randomBoolean()` 的两支互换            | **750** |
| 首回合那次 randomBoolean 不掷（恒双重打击）    | **750** |
| 双重打击的连续限制 `lastTwoMoves` → `lastMove` |     384 |
| 阈值 20 写成 25                                |     151 |
| 阈值 60 写成 65                                |     109 |
| **`roll2` 那次 aiRng 不掷**                    |      80 |
| 重击的连续限制 `lastMove` → `lastTwoMoves`     |      80 |
| **【候选补丁】让 `roll2` 真的参与判定**        |  **41** |

⚠ 最后两条要一起读，它们是参考那处疑似笔误的两面（详见「已确认但尚未打补丁」）：
**那次掷骰的「次数」有 80 例背书**（不掷就红），而**它的「取值」在参考里恒被短路吃掉**——
把它改成真的参与判定会红 41 例。所以补丁一定有预言机，卡住的只是「修法唯一」那一条。

**史尼克的出招规则与困惑**

| 改坏的                                           |    例数 | 判读                                                                   |
| ------------------------------------------------ | ------: | ---------------------------------------------------------------------- |
| 首回合不锁惑目（走 roll）                        | **375** | `snecko.jsonl` 整份全红                                                |
| 困惑整条不生效（不改费用、不掷 RNG）             |     285 |                                                                        |
| **只改 `cost` 不改 `costForTurn`**               |     285 | `costForTurn` 才是打牌读的那个                                         |
| `random(3)` 写成 `random(2)`（0~~2 而不是 0~~3） |     285 | 取值范围有背书                                                         |
| 阈值 40 写成 50                                  |     107 |                                                                        |
| 去掉「撕咬连两次就逼换尾击」那一支               |     105 |                                                                        |
| **只改 `costForTurn` 不改 `cost`**               |   **0** | ⚠ **盲区**，见下                                                       |
| 把 `random(3)` 挪进 `if (cost != newCost)` 里    |   **0** | ⚠ **等价改写**（挪不进去），见下                                       |
| 去掉 `cost >= 0` 那道门                          |   **0** | **盲区**：本批牌组里既没有 X 费牌（-1）也没有打不出的状态/诅咒牌（-2） |
| 改成累加而不是置 1（bool 语义）                  |   **0** | 已知盲区（惑目一场只施加一次，与选民的诅咒同根）                       |
| 位置挪到「技能/状态/诅咒」那条链之后             |   **0** | **等价改写**：那条链（腐化/进化/烈焰吐息）在本批牌组里一个都不触发     |
| 惑目改成同步施加（`sync: true`）                 |   **0** | 已知的「同步 ↔ 入队」一族                                              |

⚠⚠ **「`cost` 与 `costForTurn` 都改」这件事只有一半有背书，另一半是结构性盲区。**
「只改 `cost`」红 285 例（本回合就打不出原本能打的牌），但**「只改 `costForTurn`」红 0 例**。
原因链条是闭合的：回合末 `resetAttributesAtEndOfTurn` 把 `costForTurn` 拉回 `cost`，
而那一刻手牌已经被弃掉；等这张牌下次被抽上来，困惑**又会重掷一次**并覆盖两个字段。
于是「`cost` 是永久的」这件事在**任何**只由「抽 → 打/弃 → 洗回 → 再抽」构成的局面里都观察不到。
**关门条件**：让一张牌在困惑下**跨回合留在手里**（保留 / `well_laid_plans`），
或让一张没被重抽过的牌被打出（浩劫 / 混乱从牌堆顶打，但那两条走的是免费打出）。
⚠ 记成盲区而不是「照抄多余」：真实游戏里蛇眼的费用**是永久的**，抄成本回合是真的错。

⚠ **「把 `random(3)` 挪进 if 里面」这条变异其实做不出来，0 例是等价改写而不是盲区。**
要判 `cost != newCost` 就必须先求出 `newCost`——所以在 C++ 与 TS 里 RNG 都无法「挪进 if」。
真正要守的性质是**「每抽一张牌都无条件消耗一次」**，能破坏它的只有「对某些牌跳过」，
另外量了两条真探针（见下方第二组）。

**吸血攻击**

| 改坏的                                            |    例数 | 判读                                                                                                                 |
| ------------------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------- |
| 退化成普通攻击（完全不回血）                      | **563** |                                                                                                                      |
| 回血量用「入队时算的伤害」而不是真正扣掉的血      | **595** | ⚠ 这正是旧近似表的写法（固定回血），本批最重要的一条数值                                                             |
| 被全挡住时 `lastAttackUnblockedDamage` 不置 0     |     173 | 参考那个 `else` 分支不是省略                                                                                         |
| 去掉 `min`（直接用 `lastAttackUnblockedDamage`）  |   **0** | **等价改写**：未被格挡的部分恒 ≤ 传入的伤害                                                                          |
| 去掉 `m.hp > 0` 判活                              |   **0** | **盲区**（结构性）：吸取打的是玩家，荆棘/火焰屏障的反弹走 `addToTop`、在回血**之后**才执行，所以那一刻寄生虫必然活着 |
| `clearOnCombatVictory` 改成 false（照搬普通攻击） |   **0** | **盲区**（结构性）：这条动作是寄生虫那一回合排的第一条，它前面没有能判胜的东西                                       |

**数据表校准（旧近似值 vs 参考）**

| 改坏的（= 写回旧近似值）         |    例数 |
| -------------------------------- | ------: |
| 吸取写成「10 点伤害」（无吸血）  | **563** |
| 尾击的易伤写回虚弱               | **477** |
| 双重打击写成单段 12 而不是两段 6 | **392** |
| 重击的脆弱 2 层写成 1 层         |     285 |

**`isMoveAttack` 白名单（第二十四批起有预言机，本批第一次给两只新怪上背书）**

| 改坏的                                 |    例数 | 分布                                                                                                                                                                                                    |
| -------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 白名单里**漏掉本批全部五条**           | **662** | 见下                                                                                                                                                                                                    |
| 谓词恒真                               |     357 | `CHOSEN_AND_BYRDS` 97 / `THREE_BYRDS` 80 / `TWO_THIEVES` 71 / **`SNECKO` 55** / `JAW_WORM_HORDE` 24 / **`SHELLED_PARASITE_AND_FUNGI` 8** / `CULTIST` 8 / `THREE_LOUSE` 7 / `JAW_WORM` 4 / `TWO_LOUSE` 3 |
| 白名单**多收**了眩晕与惑目（本该不在） |      56 |                                                                                                                                                                                                         |

⚠ 「谓词恒真」那 357 例里第二十四批那三个文件占 248 例，**与那一批复核时量到的 248 完全一致**
（97 / 80 / 71 一个不差），另外 46 例是五个 `ENC_ALL` 编队——也与第二十三批量到的 46 相同。
本批新增的是 `SNECKO` 55 + `SHELLED_PARASITE_AND_FUNGI` 8。
⚠⚠ **`SHELL_PARASITE`（单怪）在这个方向上是 0 例**：把谓词改成恒真只在「有非攻击意图被误判」
时才分岔，而寄生虫**四招里只有眩晕不是攻击**，而眩晕全库只出现 16 帧、还要恰好赶上玩家打出
觅敌之弱。反方向（**白名单漏掉那三条，662 例：`SHELLED_PARASITE_AND_FUNGI` 245 /
`SHELL_PARASITE` 243 / `SNECKO` 174**）把它盖住了——所以两个方向都要量，
只量恒真那一个会把 `SHELL_PARASITE` 误判成有背书。
⚠ 「多收眩晕与惑目」那 56 例几乎全在 `SNECKO`（55 例，惑目每场都出）；眩晕只贡献 1 例，
与它 16 帧的分母一致。

#### 第二组变异：困惑「无条件消耗 RNG」的真探针，以及旧盲区重量

⚠ 第一组那条「把 `random(3)` 挪进 if 里面」**其实是等价改写**（要判 `cost != newCost`
就必须先求出 `newCost`，C++ 与 TS 都一样挪不进去）。真正要守的性质是
**「每抽一张牌都无条件消耗一次」**，能破坏它的只有「对某些牌跳过」。三条真探针：

| 改坏的                                      |    例数 |
| ------------------------------------------- | ------: |
| 每次 `drawCards` 只掷一次（不是每张牌一次） | **285** |
| 只对「手牌还没满 4 张」的牌掷               | **285** |
| 费用已经是 0 的牌跳过（看着像等价的优化）   | **229** |

**旧批次盲区，用本批的 `shelled_parasite_and_fungi` 重量**（真菌兽在这里恒有同伴、仗更长）：

| 改坏的                                                   |    例数 | 分布                                                                   | 判读                                                        |
| -------------------------------------------------------- | ------: | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| 真菌兽出招阈值 60 → **50（下方向）**                     | **137** | `SHELLED_PARASITE_AND_FUNGI` 110 / `EXORDIUM_WILDLIFE` 21 / `@asc19` 6 | ✅ **第十六批那条盲区关掉了**（此前只有 2 例）              |
| 真菌兽出招阈值 60 → 70（上方向）                         |     123 | 同族 104 / 15 / 4                                                      | 加厚                                                        |
| 真菌兽低位那支 `lastTwoMoves` → `lastMove`               |     348 | 320 / 20 / 8                                                           | 加厚                                                        |
| 真菌兽高位那支 `lastMove` → `lastTwoMoves`               |     210 | 201 / 5 / 4                                                            | 加厚                                                        |
| 孢子云易伤 2 → 3                                         |     266 | `EXORDIUM_WILDLIFE` 150 / **本批 62** / `@asc19` 54                    | 亡语在本批**真的跑了**                                      |
| 孢子云 `isSourceMonster` 传常量 true 而非 `turnHasEnded` |     209 | 120 / 48 / **本批 41**                                                 | 同上                                                        |
| **孢子云 `addToTop` → `addToBot`**                       |   **0** | —                                                                      | ❌ **没关掉**，见盲区表：那一刻队列里没有别的动作能插在中间 |
| **`monsterDie` 的「最后一只就 return」去掉**             |   **0** | —                                                                      | ❌ 与第十六批的判读一致：`checkCombat` 的清扫与它机制重复   |

⚠ **教训与第十四批同族**：「换一个更耐打的编队」这条逃生口是真的有效（真菌兽的阈值分档
从 2 例涨到 137 例），但它**只能救「需要更多回合」的盲区**——救不了「需要特定队列局面」的
（孢子云的 `addToTop`）。选批次时要分清一条盲区卡在哪一维上。

### 第二十三批：第二幕开张（球状守卫者 / 选民 / 食蛇草）

⚠ **本批是纯追加**。`git status`：3 个未跟踪的新文件，**一个 `M` 都没有**（`test/golden/traces`
下）——第二幕的乘积排在第一幕那个之后，`traceIdx` 只往后长。所以此前所有批次量到的例数
**一条都没失效**，只会因为总例数从 17581 涨到 **18706**（+1125 = 3 × 375）而略微偏大。

⚠⚠ **两步验证的第一步是本批最重要的产出，完整输出贴在报告里**：
先只加 `emitProduct` 这个 lambda 与第二个调用、`act2Variants` 留空，跑
`tools/regen-traces.sh --check` —— **40 个文件全部逐字节复现**
（`cultist` 2775 行、五个 `all` 编队整份比对，其余 15 + 20 个 `variant0` 编队整份冻结）。
这就证明了「把内联双重循环提成 lambda + 追加第二个乘积」对既有语料是空操作。
之后才填 variant 23，再跑 `--install`。

#### 本批的四份工作 × 三只怪

| 怪         | 数据表（`enemies.ts`）                                                                                     | `MOVE_RULES`                                                        | `takeTurn` 效果 | 收尾（`MOVE_TURN_END`）                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------- | -------------------------------------------------------- |
| 球状守卫者 | 20 血、**`hpNoRoll`**；四招（激活 25 同步格挡 / 猛击 10×2 / 硬化 15 入队格挡 + 10 / 攻击削弱 10 + 脆弱 5） | 恒返回激活，**整场只调用一次**                                      | 四条            | 四条**同步 `setMove` + 同步 `noOpRollMove`**（第五形态） |
| 选民       | 95~99 血；五招（戳刺 5×2 / 电击 18 / 削弱 10 + 易伤 2 / 汲取 虚弱 3 + 自身力量 3 / 诅咒）                  | 首招戳刺 → **第二招恒诅咒**（`lastMoveBefore(INVALID)`）→ roll      | 五条            | 五条全是默认的 `addToBot(RollMove)`，**表里不写**        |
| 食蛇草     | 75~79 血；两招（撕咬 7×3 / 孢子 脆弱 2 + 虚弱 2，**先脆弱后虚弱**）                                        | **没有 `firstTurn` 特例**；低位判 `lastTwoMoves`、高位判 `lastMove` | 两条            | 同上，默认 `roll`                                        |

⚠ **旧近似数据表在这三只身上错得很彻底**，不是「差一点」：戳刺被写成单段 6（实为 5×2）、
撕咬被写成单段 7（实为 7×3）、球状守卫者的硬化被写成「只加格挡」（实为加格挡 **+ 打人**）、
食蛇草孢子的两条减益顺序写反、选民的诅咒与球状守卫者的攻击削弱**整招不存在**。
教训与第十三批那条一样：**`enemies.ts` 的数值不可信，登记一只怪就要把它整条重写**。

#### 本批新增的共享原语

| 原语                       | 位置                                                                                                    | 为什么必须动                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **壁垒（怪物侧）**         | `applyPreTurnLogic`                                                                                     | 参考是 `if (!hasStatus<BARRICADE>()) block = 0;`（`Monster.cpp:19-22`）——**整句跳过**，不是「先清再补」 |
| **易塑（MALLEABLE）**      | `PRE_BATTLE_ACTION` / `monsterDamageUnblocked` 的 else-if 链 / `applyMonsterEndOfTurnTriggers`          | 三处协同，常数是三个独立字面量。链上的位置在**蜷缩之后、沉睡之前**                                      |
| **诅咒（HEX）**            | `debuffPlayer` 的 bool 分支 + `onUseSkillCard` / **新增的** `onUsePowerCard` / `onUseStatusOrCurseCard` | 「非攻击牌才触发」在参考里**没有任何判定**，就是「那三个函数里有、攻击那个里没有」                      |
| **`EnemyDef.hpNoRoll`**    | `constructMonster`                                                                                      | `Monster::initHp` 的第三种形态：一次 `monsterHpRng` 都不掷（`MonsterSpecific.cpp:119-124`）             |
| **`MONSTER_ATTACK_MOVES`** | 取代 `isMonsterAttacking` 里读 `intent` 的那两行                                                        | 见下                                                                                                    |

#### ⚠⚠ `isMoveAttack` 白名单：WORKFLOW 挂了十批的那条警告，本批兑现

逐条核对的结果（表在 `sts-combat.ts` 的 `MONSTER_ATTACK_MOVES` 注释里，报告里也有一份）：

| 参考招式                               | 在白名单？ | 数据表 intent |
| -------------------------------------- | ---------- | ------------- |
| `SPHERIC_GUARDIAN_SLAM`                | 是         | attack        |
| **`SPHERIC_GUARDIAN_HARDEN`**          | **是**     | attack        |
| `SPHERIC_GUARDIAN_ATTACK_DEBUFF`       | 是         | attack        |
| `SPHERIC_GUARDIAN_ACTIVATE`            | 否         | defend        |
| `CHOSEN_POKE` / `_ZAP` / `_DEBILITATE` | 是         | attack        |
| `CHOSEN_DRAIN` / `_HEX`                | 否         | buff / debuff |
| `SNAKE_PLANT_CHOMP`                    | 是         | attack        |
| `SNAKE_PLANT_ENFEEBLING_SPORES`        | 否         | debuff        |

**逐条对下来两边其实还是同解**——因为「硬化的 intent 该写什么」是我们自己定的，写
`attack` 就一致。⚠ **但那正是问题所在**：硬化在真实游戏里显示的是**攻击 + 防御双意图**，
而 `EnemyIntentKind` 五个值互斥；把它标成 `attack` 是为了迁就 `isMonsterAttacking`，
而不是因为它是正确的渲染分类。**所以本批还是把谓词换成了白名单**：`intent` 从此只管渲染，
`isAttacking` 只认参考的白名单，两件事不再互相绑架。以后再遇到「防御 + 攻击」的招式
（第二幕的百夫长、第三幕的尖塔护盾都有），数据表可以照真实游戏标而不会弄坏谓词。

⚠⚠ **这条「整族没有背书」的说法是错的，第二十三批复核时纠正。**

原先记的是：`isMonsterAttacking` 唯一的读者是觅敌之弱，而它从没与怪物编队同场，
所以整族 17 条都没背书。**实测不是这样**：

- 把谓词改成**恒真**，对拍红 **46 例**。
- `SPOT_WEAKNESS` 在已提交数据里被打出 **65（未升级）+ 54（已升级）= 119 次**。
- 那 46 例的分布：`JAW_WORM_HORDE` 24 / `CULTIST` 8 / `THREE_LOUSE` 7 /
  `JAW_WORM` 4 / `TWO_LOUSE` 3 —— **正好是五个 `ENC_ALL` 编队**，
  因为只有它们保留了含觅敌之弱的 93 张全牌组 variant（失败用例名里写着 `[93张]`）。

所以准确的说法是：

- **谓词本身有背书**（46 例），且**邪教徒 / 颚虫 / 红虱 / 绿虱四只怪的攻击分类是被钉住的**。
- **没有背书的是第十三批之后登记的那 21 只怪的分类**——它们的编队走 `ENC_V0`，
  只保留 variant 0 那副 21 张 `BATCH_1` 牌组，里面没有觅敌之弱。
- 「整表退回读 `intent`」量出 0 例是**正确且预期**的：第十三批就核过，
  已登记的怪两种实现同解。0 例证明的是「两种写法等价」，不是「谓词没人看着」。

**关门条件因此比原先记的便宜得多，不需要任何新机制**：
第二幕的编队走的是 harness 第二个循环、只有 `act2Variants` 会打到它们，
所以**只要往 `act2Variants` 的牌组里放一张 `SPOT_WEAKNESS`**，
之后每一批的新怪都自带这条谓词的背书。第二十四批起照此办理。
（第二十三批这三只仍无背书——它们那个 variant 的牌组里没有；
要补就得重生成那三个已冻结文件，走 `ALLOW_CHANGED`，收益不大，留作可选项。）

#### 变异测试（例数 = 对拍失败的 trace 条数，总 18706）

**壁垒 / 血量 / 神器**

| 改坏的                                           |    例数 |
| ------------------------------------------------ | ------: |
| 壁垒失效（怪物回合开始照常清空格挡）             |     349 |
| `hpNoRoll` 失效（球状守卫者照常掷 monsterHpRng） | **375** |
| 球状守卫者开局格挡 40 → 30                       |     375 |
| 球状守卫者神器 3 → 1                             |     375 |

⚠ 神器那条**不只是快照对不上**：variant 0 的牌组里有痛击 / 晾衣绳 / 雷云击三张减益牌，
所以那 3 层是真的被逐层吃掉的——这是怪物侧神器**多层递减**第一次有预言机
（哨卫只有 1 层）。

**易塑（三处协同，逐处量）**

| 改坏的                          |     例数 |
| ------------------------------- | -------: |
| 开局层数 3 → 2                  |      375 |
| 整条 `preBattleAction` 去掉     |      375 |
| 受击不加格挡（只涨层数）        |      375 |
| 层数不 +1（不成长）             |      375 |
| 回合末不复位回 3                |      375 |
| 回合末复位成 4                  |      375 |
| 加格挡由**入队**改成同步        |      357 |
| 在 else-if 链里挪到蜷缩**之前** | **4558** |

⚠ 最后一条红了 4558 例是因为它同时破坏了**所有带蜷缩的编队**（虱子系）——它量的是
「链的顺序」而不是「易塑本身」，与第十七批把狂怒挪到蜷缩位置那条同族。

**球状守卫者的意图链与 `noOpRollMove`**

| 改坏的                                       |  例数 |
| -------------------------------------------- | ----: |
| `getMoveForRoll` 返回猛击而不是激活          |   375 |
| 激活的收尾改成猛击（而不是攻击削弱）         |   370 |
| 猛击的收尾改成攻击削弱（而不是硬化）         |   322 |
| 硬化的收尾改成攻击削弱（而不是猛击）         |   187 |
| 猛击的 `noOpRollMove` 去掉（少掷一次 aiRng） |   322 |
| 猛击 2 段 → 1 段                             |   322 |
| 攻击削弱的脆弱 5 → 2                         |   279 |
| 硬化的加格挡挪到攻击**之后**                 |    36 |
| 激活的 `noOpRollMove` 同步 → 入队            | **0** |
| 激活的加格挡 同步 → 入队                     | **0** |
| 硬化的加格挡 入队 → 同步                     | **0** |

⚠ 三条 0 例全属于已知的**「同步 ↔ 入队」一族**（盲区表里那条）：激活那一回合队列里只有
它自己一条动作，硬化那一回合的两条动作之间没有任何会读格挡的东西。
反过来「**换个顺序**」是能量出来的（36 例）——所以这一族里「先后」有背书、「同步与否」没有。

**选民**

| 改坏的                                           | 例数 |
| ------------------------------------------------ | ---: |
| 第二招不出诅咒（去掉 `lastMoveBefore(INVALID)`） |  375 |
| 那支误抄成 `firstTurn`                           |  375 |
| 血量区间 95~~99 → 95~~100                        |  328 |
| 戳刺 2 段 5 → 单段 6（旧近似表的写法）           |  236 |
| 连续限制只看削弱、不看汲取                       |  160 |
| 汲取的自身力量 3 → 2                             |  160 |
| 电击 18 → 21                                     |   98 |
| 削弱/汲取阈值 `roll<50` → `roll<60`              |   50 |
| 电击阈值 `roll<40` → `roll<50`                   |   31 |

**诅咒（HEX）**

| 改坏的                                   |  例数 |
| ---------------------------------------- | ----: |
| 扩到攻击牌也触发（方向 B）               |   261 |
| 塞 2 张而不是 1 张                       |   224 |
| 塞进弃牌堆而不是洗入抽牌堆               |   224 |
| 洗入位置改成置顶（不掷 `cardRandomRng`） |   220 |
| 技能牌不触发（方向 A）                   |   211 |
| 能力牌不触发                             |    75 |
| 由入队改成同步                           |    71 |
| **bool 语义丢掉（层数累加）**            | **0** |

⚠ 最后一条 0 例是**结构性**的：选民的诅咒只在「第二个怪物回合」出，一场仗最多施加一次，
而「累加」与「置 1」在第一次施加时结果相同。参考里**没有任何内容会施加第二次诅咒**
（asc17 的选民把诅咒挪到首回合，依然只有一次），困惑那一支也一样（史尼克的惑目只在首回合）。
归入「结构性不可达」，除非以后出现第二个来源。

**食蛇草**

| 改坏的                                                         | 例数 |
| -------------------------------------------------------------- | ---: |
| 撕咬每击 7 → 8                                                 |  369 |
| 撕咬 3 段 → 2 段                                               |  366 |
| 血量区间 75~~79 → 75~~80                                       |  328 |
| 低位那支 `lastTwoMoves` → `lastMove`                           |  318 |
| **高位那支 `lastMove` → `lastTwoMoves`（asc17 块的唯一差别）** |  147 |
| 孢子的脆弱/虚弱顺序调换（旧表的写法）                          |   87 |
| 出招阈值 `roll<65` → `roll<55`                                 |   81 |

⚠ 「高位那支」那条值得单记：它正是参考 asc17 出招块与 asc<17 块**唯一的差别**。
147 例说明这两块在 asc0 下**真的分得开**，所以将来给食蛇草铺爬升度时，
asc17 那块不是「抄了也看不见」的死代码。

**`isMoveAttack` 白名单（两个方向都量了）**

| 改坏的                                        |  例数 |
| --------------------------------------------- | ----: |
| 去掉 `spheric_guardian/sg_harden`（那个反例） | **0** |
| 多加 `chosen/drain`（不该算攻击的）           | **0** |
| 整表退回读数据表 `intent`（本批之前的实现）   | **0** |

见上，这是整族盲区，不是本批引入的。

### 第二十二批：爬升度铺到三精英 + 三 Boss（第一幕 20 编队全覆盖）

⚠ **本批是「追加 + 一个已冻结文件被补丁改写」**，与第十六批同形而影响面小一个量级。
`git status`：6 个未跟踪的新文件 + **只有** `large_slime@asc19.jsonl` 一个 `M`；
`git diff --numstat -- test/golden/traces` = `1 1 large_slime@asc19.jsonl`
——整份 120 行**只改了第 21 行**（`GEN11 @floor 7`），
与「打补丁前跑对拍红 1 例、失败的正是这一条」严丝合缝。
所以标 ⁋ / ⸾ / ⸙ / ⸸ / ⁝ / ⁜ / ⁑ / ⁂ 及更早的旧例数**一条都没失效**（唯一的例外是
「把参考那处 M/L 笔误『修好』红 1 例」那条，本批打了补丁、方向反过来了，见下），
只会因为总例数从 16861 涨到 **17581**（+720）而略微偏大。
装完之后又跑了一次 `--check`：**40 个文件全部逐字节复现**，即已提交的两个参考侧 commit
（补丁 `167edd7` + harness `f767649`）确实产出这份数据。

⚠ **另开 variant 22，没有动 variant 21 的 `encounters`。** `traceIdx` 按
「variants × encounters 的声明序」编号并驱动遗物/药水轮换，扩 variant 21 的列表会平移
其后所有下标、让 14 个已提交的 `@asc19` 文件全部作废。这与顶层那个冻结的 `encounters`
列表是同一条规矩，只是作用在第二层循环上。

#### 本批新补的 asc 分档（逐条）

⚠⚠ **精英与 Boss 的阈值与走廊小怪不是同一组数**，三族在参考里是并排写着的三套，
照抄邻居必错：

| 族   | 血量（`Monster::initHp`） | 数值（`takeTurn` 顶部）     |
| ---- | ------------------------- | --------------------------- |
| 普通 | `asc>=7`（:37-74）        | `getTriIdx(asc, 2, 17)`     |
| 精英 | `asc>=8`（:91-102）       | `getTriIdx(asc, **3**, 18)` |
| Boss | `asc>=9`（:76-89）        | `getTriIdx(asc, **4**, 19)` |

| 位置                                    | 分档                         | 参考                                 |
| --------------------------------------- | ---------------------------- | ------------------------------------ |
| 哨卫 / 地精头目 / 拉加维林 的血量第二组 | `asc>=8`                     | `MonsterSpecific.cpp:91-102`         |
| 守卫者 / 史莱姆王 / 六火 的血量第二组   | `asc>=9`                     | `MonsterSpecific.cpp:76-89`          |
| 哨卫 光束 / 射钉张数                    | asc3 → 10；asc18 → 3 张      | `MonsterSpecific.cpp:1058/1064`      |
| 地精头目 咆哮激怒 / 猛冲 / 碎颅击       | asc18 → 3；asc3 → 16 / 8     | `MonsterSpecific.cpp:757/762/767`    |
| **地精头目 asc18 的整块出招规则**       | 完全不看 roll（见下方裁定）  | `MonsterSpecific.cpp:2434-2447`      |
| 拉加维林 重击 / 吸魂敏捷 · 力量         | asc3 → 20；asc18 → **-2** 各 | `MonsterSpecific.cpp:871/882-883`    |
| 守卫者 尖锐外壳 / 重砸 / 滚压           | asc19 → 4；asc4 → 36 / 10    | `MonsterSpecific.cpp:1352/1357/1362` |
| 守卫者 模式切换阈值                     | asc19 → 40 / asc9 → 35       | `MonsterSpecific.cpp:316-330`        |
| 史莱姆王 黏液喷射张数 / 猛砸            | asc19 → 5 张；asc4 → 38      | `MonsterSpecific.cpp:1112/1121`      |
| 六火 灼烧灼伤张数 / 燃焰力量            | asc19 → 2 张 / 3             | `MonsterSpecific.cpp:825/816`        |
| 六火 冲撞 / 地狱之火                    | asc4 → 6 / 3（每击）         | `MonsterSpecific.cpp:841/808`        |

⚠ **`ascAmount` 本批多了两个宿主**：`deal_damage_multi`（覆盖**每一击**的伤害，段数恒定）
与 `add_card`（覆盖 **`count`**，与 `upgradedAfterTurn` 正交）。此前没有一只已登记的怪
用到这两种形状。

⚠ **没有分档的地方也逐条确认过**（写进注释，免得下一个人以为是漏了）：碎颅击的易伤 2 层、
灼烧的 6 点伤害、燃焰的 12 点格挡、守卫者的蓄能 9 / 旋风 5×4 / 双重猛击 8×2 / 泄气两层减益。

#### 变异测试 ⁌（17581 例基线，括号内为失败例数）

| 改坏的地方                                   | 例数    |
| -------------------------------------------- | ------- |
| Boss `hpHigh` 整组失效（三只 atLeast 9→999） | **360** |
| `add_card` 的 `ascAmount` 整体失效           | **360** |
| 精英 `hpHigh` 整组失效（三只 atLeast 8→999） | **352** |
| 守卫者 模式切换阈值 asc19 档（40→35）        | **120** |
| **地精头目 asc18 出招块整块失效**            | **104** |
| 补丁复活的那条分支（改回 M 号枚举）          | **16**  |

⚠ 最后一条那个 **16** 与「补丁只改了 1 行数据」不矛盾，两个数字问的是不同的问题：
补丁**改动**了 1 条已冻结 trace（`large_slime@asc19` 的第 21 行），而补丁**后**的形状被
16 条 trace 看着——本批新装的 `slime_boss@asc19` 里分裂出来的那只酸液大史莱姆走同一条
出招规则。第二十一批只量到 1 例，是因为那时 `slime_boss@asc19` 还不存在。
⚠ 复活的那个 `randomBoolean(0.6F)` **仍然没有背书**（本项目自己就是预言机）。

**逐条数值分档**（把某一档改回基础值）：
地精头目 咆哮激怒 asc18 **120**、猛冲 asc3 **113**、**碎颅击 asc3 0（见盲区）**；
拉加维林 重击 asc3 **120**、吸魂敏捷 asc18 **93**、吸魂力量 asc18 **108**；
哨卫 光束 asc3 **120**、射钉张数 asc18 **120**；
守卫者 尖锐外壳 asc19 **120**、滚压 asc4 **119**、重砸 asc4 **71**；
史莱姆王 黏液喷射张数 asc19 **120**、猛砸 asc4 **73**；
六火 灼烧灼伤张数 asc19 **120**、燃焰力量 asc19 **120**、冲撞 asc4 **113**、
地狱之火 asc4 **34**。
**17 条里 16 条非 0**，唯一的 0 是碎颅击那条，原因见下。

#### ⁌ 本批新发现的盲区（0 例）

- ⚠⚠ **地精头目的碎颅击在 asc>=18 结构性不可达，于是它的 asc3 伤害档没有背书**（0 例）。
  根因是参考那块 asc18 出招规则本身（`!lastTwoMoves(SKULL_BASH)` 恒真 → 恒返回猛冲），
  详见「已确认但尚未打补丁」里那条。**关门条件**：给参考打补丁（需要真实游戏 ground truth），
  或者加**任何一个 `asc < 18` 的档位**——碎颅击就会重新出场，而 asc>=3 那一档仍取高侧
  （所以 asc16 一举两得，见文末「四、下一步」）。
  ⚠ 别把这条记成「碎颅击没实现」：它在 **asc0 的 375 条**里执行了 270 次，
  缺的只是 asc>=3 那一档的数值背书。
- ⚠ **血量阈值本身量不出来**：把精英的 8 抄成 7、把 Boss 的 9 抄成 8 各 **0 例**
  ——asc19 在两种写法下都取高档。这是第二十一批那条「单一档位证不了阈值」的**具体化**，
  而且现在有了更强的形态：三族阈值是 7/8/9 三个不同的数，`{0,19}` 这对档位一个都钉不住。
  **关门条件**：要**成对**档位，一个档位只能钉住一条分界的一侧——
  asc7 钉住普通那条 7（普通高 / 精英低 / Boss 低）、asc8 钉住精英那条 8、asc9 钉住 Boss 那条 9。
  在那之前守着它的只有 `data-tables.test.ts` 里那张**逐怪期望阈值**的表。
- 守卫者 模式切换阈值 **asc9 档（35）→ 0 例**：`{30, 35, 40}` 的中间那一档，
  asc0 取 30、asc19 取 40。与下方第二十一批那条「三档的中间档」同根，但**关门条件更窄**：
  它的分界是 9 与 19，所以要 `9 <= asc <= 18` 的档位——**asc7 关不掉它**，asc16 可以。
  这正是文末推荐 asc16 而不是 asc7 的原因。

#### ⁌ 第二十一批记着「仍然 0」的四类，本批重量

| 类别                                      | 第二十一批 | 本批                                               |
| ----------------------------------------- | ---------- | -------------------------------------------------- |
| （甲）三档里的中间那一档                  | 0          | **仍然 0**（邪教徒仪式 asc2 / 虱子蜷缩 asc7 各 0） |
| （乙）奴隶主的 asc17 内联条件（逻辑冗余） | 0          | **仍然 0**（红 / 蓝各 0，永远关不掉）              |
| （丙）`ascValue` 取第一条命中（等价改写） | 0          | **仍然 0**（等价改写，不是盲区）                   |
| （丁）守卫者形态阈值 asc19 / asc9         | 0          | **asc19 档 120 例**、asc9 档仍 0                   |

（丁）那条的关门条件就是本批，**asc19 那半关掉了**（120 例）；asc9 那半掉进（甲）那一类。
⚠ 但它把（甲）那一类的关门条件**收窄了**：此前只说「加一个中间档位」，
现在必须落在 `9 <= asc <= 18` 才能同时覆盖守卫者那条，见上方盲区一节与文末「四、下一步」。

### 第二十一批：爬升度这条轴（14 个普通编队 × asc19）

⚠ **本批是纯追加，而且连补丁都没有。** `git status` 只多出 14 个未跟踪文件
（`*@asc19.jsonl`），`git diff --stat -- test/golden/traces` **为空**——20 个已提交文件
逐字节未变。所以标 ⸾ / ⸙ / ⸸ / ⁝ / ⁜ / ⁑ / ⁂ 及更早的旧例数**一条都没失效**，
只会因为总例数从 15181 涨到 **16861**（+1680）而略微偏大。

⚠⚠ **「管线是空操作」是分两步证明的，这一步不能省。**
第一步**只改管线、不加任何 variant**（harness 的 `ascension` 字段 + split 的分组键 +
重放侧从 trace 读），跑 `tools/regen-traces.sh --check`：**20 个文件全部逐字节复现**。
第二步才加 variant 跑 `--install`。做法与「加 `isReplayableCard` 那道门时先只加门跑一次
`--check`」同源，写在 WORKFLOW 的「爬升度这条轴」一节。

#### 本批新补的 asc 分档（逐条）

| 位置                              | 分档                                               | 参考                                              |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| 全部 19 只怪的血量第二组          | `asc>=7`（普通怪）                                 | `MonsterSpecific.cpp:26-128` + `MonsterIds.h:150` |
| 虱子蜷缩层数                      | asc17 → 9~12（**此前漏了这一档**）                 | `MonsterSpecific.cpp:290-306`                     |
| 酸液史莱姆 S 的出招               | asc17 → 恒舔舐，**少掷一次 aiRng**                 | `MonsterSpecific.cpp:1912`                        |
| 酸液史莱姆 M 的出招（整块）       | asc17 → 阈值 40/80、连续限制换向                   | `MonsterSpecific.cpp:1928-1963`                   |
| 酸液史莱姆 L 的出招（整块）       | asc17 → 阈值 40/70、概率 0.6f                      | `MonsterSpecific.cpp:2002-2033`                   |
| 邪教徒仪式层数                    | `{3,4,5}[getTriIdx(asc,2,17)]`                     | `MonsterSpecific.cpp:681`                         |
| 颚虫撕咬 / 咆哮力量 / 咆哮格挡    | asc2 12; `{3,4,5}`; asc17 9                        | `MonsterSpecific.cpp:850-865`                     |
| 红虱强化力量                      | asc17 → 4                                          | `MonsterSpecific.cpp:1011`                        |
| 虱子咬击伤害区间                  | asc2 → `random(6,8)`（建怪时掷）                   | `Monster.cpp:116-121`                             |
| 酸液 M 腐蚀 / 冲撞                | asc2 → 8 / 12                                      | `MonsterSpecific.cpp:373/386`                     |
| 酸液 S 冲撞                       | asc2 → 4                                           | `MonsterSpecific.cpp:398`                         |
| 酸液 L 腐蚀 / 冲撞                | asc2 → 12 / 18                                     | `MonsterSpecific.cpp:353/368`                     |
| 尖刺 M 扑击 / S 冲撞 / L 火焰冲撞 | asc2 → 10 / 6 / 18                                 | `MonsterSpecific.cpp:1178/1204/1187`              |
| 尖刺 L 舔舐脆弱                   | asc17 → 3                                          | `MonsterSpecific.cpp:1193`                        |
| 蓝奴隶主刺击 / 耙击 / 耙击虚弱    | asc2 → 13 / 8；asc17 虚弱 → 2                      | `MonsterSpecific.cpp:443-450`                     |
| 红奴隶主刺击 / 刮擦 / 刮擦易伤    | asc2 → 14 / 9；asc17 易伤 → 2                      | `MonsterSpecific.cpp:1023-1029`                   |
| 抢劫者抢劫 / 猛扑 / 偷窃额度      | asc2 → 11 / 14；asc17 额度 → 20                    | `MonsterSpecific.cpp:918/911/233`                 |
| 真菌兽成长力量                    | `{3,4,5}[getTriIdx(asc,2,17)]`                     | `MonsterSpecific.cpp:696`                         |
| 狂暴地精抓挠 / 怒气层数           | asc2 → 5；asc17 怒气 → 2                           | `MonsterSpecific.cpp:659/156`                     |
| 鬼祟地精穿刺 / 肥胖地精猛击       | asc2 → 10 / 5                                      | `MonsterSpecific.cpp:669/643`                     |
| **肥胖地精 asc17 多一层脆弱**     | `minAscension: 17`（整条效果）                     | `MonsterSpecific.cpp:646-648`                     |
| 护盾地精保护格挡 / 盾击           | `{7,8,11}[getTriIdx(asc,**7**,17)]`；盾击 asc2 → 8 | `MonsterSpecific.cpp:1095/1105`                   |
| 地精巫师大招伤害 / **收尾**       | asc2 → 30；asc17 起**不回蓄力**                    | `MonsterSpecific.cpp:782-788`                     |
| 颚虫军团开局力量 / 格挡           | `{3,4,5}` / `{5,6,9}`                              | `MonsterGroup.cpp:278-279`                        |

⚠ **`getTriIdx(asc, 7, 17)` 只在护盾地精那一处出现**，其余走廊小怪全是 `getTriIdx(asc, 2, 17)`。
两者长得几乎一样，照抄时别顺手写成 2。

#### 变异测试 ⁋（16861 例基线，括号内为失败例数）

**结构性分支**（改坏一处 → 跑对拍 → `git checkout --` 还原）：

| 改坏的地方                                                | 例数       |
| --------------------------------------------------------- | ---------- |
| `hpHigh` 整条失效（全部怪回到低档血量区间）               | **1679**   |
| 蜷缩改成掷两次 `monsterHpRng`（次数错）                   | **4685**   |
| `ascValue` 整体失效（全部数值分档回落基础值）             | **1210**   |
| 所有 `atLeast=2` 的数值档失效                             | **959**    |
| 所有 `atLeast=17` 的数值档失效                            | **582**    |
| 蜷缩 asc17 档 9~~12 → 4~~8                                | **311**    |
| 酸液史莱姆 S 的 asc17 恒舔舐（退回掷 randomBoolean）      | **188**    |
| 抢劫者偷窃额度 asc17（20→15）                             | **155**    |
| 虱子咬击伤害区间 asc2（6~~8 → 5~~7）                      | **169**    |
| 尖刺史莱姆中 asc17 内联条件失效                           | **126**    |
| 颚虫军团力量 asc17 档 / 格挡 asc17 档                     | **120** 各 |
| 酸液史莱姆中 asc17 出招整块失效                           | **113**    |
| 狂暴地精怒气 asc17（2→1）                                 | **96**     |
| 肥胖地精 `minAscension`（asc17 那层脆弱不再上）           | **83**     |
| 绿虱 asc17 内联条件失效 / 尖刺史莱姆大 asc17              | **28** 各  |
| 地精巫师大招 asc17 收尾（本该停在大招上）                 | **20**     |
| 红虱 asc17 内联条件失效 / 酸液史莱姆大 asc17 整块         | **17** 各  |
| 酸液中 asc17 第二段的显式 `0.5f` 换成无参 `randomBoolean` | **3**      |
| **把参考那处 M/L 笔误「修好」**                           | **1**      |

**逐条数值分档**（把某一档改回基础值）：邪教徒仪式 asc17 **153**、颚虫撕咬 asc2 **207**、
颚虫咆哮力量/格挡 asc17 **159** 各、红虱强化 asc17 **55**、酸液 M 腐蚀/冲撞 asc2 **84/85**、
酸液 S 冲撞 asc2 **52**、酸液 L 腐蚀/冲撞 asc2 **11** 各、尖刺 M 扑击 asc2 **136**、
尖刺 S 冲撞 asc2 **96**、尖刺 L 火焰冲撞 asc2 **18**、尖刺 L 舔舐脆弱 asc17 **33**、
蓝奴隶主刺击/耙击 asc2 **67/48**、耙击虚弱 asc17 **70**、
红奴隶主刺击/刮擦 asc2 **100/60**、刮擦易伤 asc17 **68**、
抢劫者抢劫/猛扑 asc2 **112/12**、真菌兽成长 asc17 **10**、
狂暴地精抓挠 asc2 **71**、鬼祟地精穿刺 asc2 **62**、肥胖地精猛击 asc2 **74**、
护盾地精保护 asc17 **36**、盾击 asc2 **3**、地精巫师大招 asc2 **20**。
**33 条里 29 条非 0**，4 条为 0 的见下方盲区。

#### ⁋ 本批新发现的盲区（0 例）

- ⚠⚠ **三档以上的效果，中间那一档在 `{0, 19}` 这对档位下必然不可达。**
  `{3,4,5}[getTriIdx(asc,2,17)]`：asc0 取 3、asc19 取 5，**4 那一档永远走不到**。
  实测各 0 例：邪教徒仪式 asc2、颚虫咆哮力量 asc2、真菌兽成长 asc2、颚虫军团力量 asc2、
  护盾地精保护 asc7、虱子蜷缩 asc7。
  **关门条件**：再加一个中间档位的 variant。~~asc7 能同时点亮「7~16」那一段，
  是性价比最高的一个~~ ⚠ **第二十二批把这句改窄了**：守卫者的形态阈值也是三档
  （`{30,35,40}`，分界 9 与 19），asc7 取不到它的中间档。要一次覆盖全部 7 条，
  档位必须落在 `9 <= asc <= 18`——**asc16** 是首选，逐条推算见文末「四、下一步」。
  ⚠ 照抄那一档，但别在报告里说它「有背书」。
- ⚠⚠ **蓝 / 红奴隶主的 asc17 内联条件是逻辑冗余，任何档位都关不掉。**
  参考写的是 `!lastTwoMoves(RAKE) || (asc17 && !lastMove(RAKE))`，而
  `lastTwoMoves(X)` 就是 `moveHistory[0]==X && moveHistory[1]==X`（`Monster.cpp:621`），
  **蕴含** `lastMove(X)`。于是 `!lastTwoMoves` 为假时 `!lastMove` 必为假，第二个析取项
  **永远不贡献任何东西**。实测两条各 **0 例**。
  ⚠ 这**不是参考的 bug**：真实游戏的 `SlaverBlue` / `SlaverRed` 就是这么写的，
  是原作自己的一处冗余。**照抄，别「化简」掉**，也别去找不存在的逃生口。
  ⚠ 对照组：尖刺史莱姆那条形状相反（`lastTwoMoves(LICK) || (asc17 && lastMove(LICK))`，
  第二项**更宽**），所以它是可观察的（126 / 28 例）。判据是**蕴含方向**，不是「长得像」。
- `ascValue` 取「数组里第一条命中」而不是「`atLeast` 最大」→ **0 例**。这是**等价改写**
  而不是盲区：数据表里所有 tier 都按降序书写，两种取法恒等。写成「取最大」只是让顺序
  不再是隐含前提。
- 守卫者的形态阈值 asc19/asc9 → **0 例**（守卫者不在本批 14 个编队里，等第二十二批）。
  **第二十二批已重量**：asc19 档 **120 例**（关掉了），asc9 档**仍然 0**（中间档，
  归进上面那一条）。

⚠ **本批唯一动到共享路径的是重放侧的入场血量**（`playerHp`），见下方「我们自己的转写错误」。
它不改任何 asc0 行为——20 个已提交文件逐字节未变、旧例数不受影响。

⚠ **第二十批同样是纯追加，而且连补丁都没有。** `git status` 只多出一个未跟踪文件
（`hexaghost.jsonl`），`git diff --stat -- test/golden/traces` **为空**——十九个已提交文件
逐字节未变。`trace_dump.cpp` 一个字没动，参考仓库仍停在第十八批那个 commit（`dd05409`）
且工作区干净。开跑前的 `--check` 整份比过十九个文件、全部一致。
所以标 ⸾ / ⸙ / ⸸ / ⁝ / ⁜ / ⁑ / ⁂ 及更早的旧例数**一条都没失效**，只会因为总例数从 14806
涨到 15181（+375）而略微偏大。
⚠ **本批唯一动到共享路径的是两处「我们自己的转写错误」**（`deal_damage_rolled` 的 `times`、
灼伤那条 `clearOnCombatVictory`），两条都在装数据**之前**跑过一次全量对拍确认
「14806 例仍然全绿」——所以它们没有改变任何既有编队的行为，旧例数同样不受影响。

⚠ **第十九批是纯追加，而且连补丁都没有。** `git status` 只多出两个未跟踪文件
（`the_guardian` / `slime_boss`），`git diff --stat -- test/golden/traces` **为空**——
十七个已提交文件逐字节未变。`trace_dump.cpp` 一个字没动，参考仓库停在第十八批那个
commit（`dd05409`）、工作区干净。开跑前的 `--check` 整份比过十七个文件、全部一致。
所以标 ⸙ / ⸸ / ⁝ / ⁜ / ⁑ / ⁂ 及更早的旧例数**一条都没失效**，只会因为总例数从 14056
涨到 14806（+750 = 两个新编队各 375）而略微偏大。
⚠ 两个新文件是 `ENC_V0` 里**最大的两个**（12MB / 18MB）：Boss 血厚、仗长，一条 trace 的
步数是精英的两三倍。整个 `test/golden/traces` 现在 236MB。

⚠ **第十八批是纯追加，但它有一个补丁、只是那个补丁碰不到已冻结数据。**
`git status` 只多出三个未跟踪文件（`gremlin_nob` / `lagavulin` / `three_sentries`），
`git diff --stat -- test/golden/traces` **为空**——十四个已提交文件逐字节未变。
本批**没有改 harness**（`trace_dump.cpp` 一个字没动），但**给参考打了一个补丁**：
`monsterStatusEnumStrings` 的 `REACTIVE` 位置错位（见「已修正 · 参考侧」最后一条）。
它只改「怪物状态的名字」，而错位的那一段（32–38 号：无敌 / 反应 / 尖刺皮 / 沉睡 / 壁垒 /
随从 / 随从首领 / 痛击）在此前十四个文件的**怪物**快照里一次都没出现过，所以
**不需要 `ALLOW_CHANGED`**——这与第十六批那次「补丁真的改了两个已冻结文件」正好相反，
两种形态都要会分辨。开跑前的 `--check` 整份比过十四个文件、全部一致。
所以标 ⸸ / ⁝ / ⁜ / ⁂ / ⁑ 及更早的旧例数**一条都没失效**，只会因为总例数从 12931 涨到
14056 而略微偏大。
⚠ 顺带：本批把 `sts-combat-wiring.test.ts` 与 `sts-combat-rules.test.ts` 里那个
「未迁移编队」的样本从 `gremlin_nob` / `three_sentries` 换成了 **`giant_head`**（第三幕精英）。
判据与 `seek` 同源：**它不在 harness 的 20 个第一幕编队里**，而那个列表按 WORKFLOW 不许增删。
别换成 `the_guardian` / `hexaghost` / `slime_boss`——第十九/二十批就要登记它们。

⚠ **第十七批是纯追加：现有十三个文件逐字节未变**（`git status` 只多出一个未跟踪的
`gremlin_gang.jsonl`）。本批**没有改 harness**、参考仓库也**没有新补丁**，只是把一个
**本来就在生成、只是没安装**的编队装进来。开跑前的 `--check` 整份比过十三个文件、全部一致，
装完 `--install` 的冻结校验也全绿。所以标 ⁝ / ⁜ / ⁑ / ⁂ 及更早的旧例数**一条都没失效**
——它们只会因为总例数从 12556 涨到 12931 而略微偏大。

⚠ **第十六批是「追加 + 两个已冻结文件被补丁改写」，这是 `ENC_V0` 头一次不是纯追加。**
本批给参考打了 `usedEntangle` 补丁（见「已修正 · 参考侧」第 12 条），它**只**改红奴隶主的
出招，所以 `ALLOW_CHANGED="red_slaver exordium_thugs"` 放行了这两个文件重新生成。
**复核证据（这一步不能省）**：`git status` 只有这两个 `M`、外加一个未跟踪的
`exordium_wildlife.jsonl`；`git diff --stat` 显示两文件各只有 21 / 20 行变化，
其余**十个**已提交文件逐字节未变。开跑前的 `--check` 也整份比过十二个文件、全部一致。
装完之后又跑了一次 `--check`：**十三个文件全部逐字节复现**，即已提交的参考侧补丁
（`7c7ecbf`）确实产出这份数据——补丁与数据是一对，重新克隆参考项目时必须一起恢复。
⚠ 因此**标 ⁜（第十五批）里凡是在 `red_slaver` / `exordium_thugs` 上量的例数全部作废**，
本批逐条重量了，见下方「验证方式 · 第十六批」的「重量」小节——十三条里变了六条。
其余编队上量的旧例数不受影响（那些文件没动），只会因总例数 12180 → 12556 而略微偏大。

⚠ **第十五批也是纯追加：现有八个文件逐字节未变**（`git status` 只多出四个未跟踪文件）。
本批**没有改 harness**、参考仓库也**没有新补丁**，只是把四个**本来就在生成、只是没安装**的
编队装进来。开跑前的 `--check` 整份比过八个文件、全部一致。所以标 ⁂ / ※ / ∬ / ∮ / ¶ / § /
★ / ‡ / † / ⁑ 的旧例数**一条都没失效**——它们只会因为总例数从 10680 涨到 12180 而略微偏大。
⚠ 唯一的例外是**测试侧**改了一处：trace 重放的入场金币从 0 改成 99（见下方 ⁜ 那节）。
它只影响「本场金币变化量」这一个字段，且当前所有旧数据的该字段要么缺省、要么来自贪婪之手
的加钱（与起点无关），所以旧例数同样不受影响——重生成后 12459 例全绿即是证据。

当前 **285MB / 17581 例**（第二十二批 +720 例 = 6 个 `@asc19` 编队 × 120 行，新文件合计
17.7MB）。上一批是 268MB / 16861 例。体积与例数的完整历史见文末「三、数据体积与例数」。
**最大单个文件仍是 `jaw_worm_horde.jsonl`，48,581,931 字节（46.3MB）**
——第十二批新加的 variants 19/20 带编队过滤、不跑三颚虫，所以它只因 variants 7/8 的内容变化
涨了 112KB（48,469,656 → 48,581,931）。GitHub 单文件硬上限 100MB，还有一倍余量。
另外三个：`cultist.jsonl` 38,182,826、`two_louse.jsonl` 31,852,062、
`three_louse.jsonl` 19,660,818、`jaw_worm.jsonl` 15,656,942。
⚠ `cultist` / `two_louse` 是唯一两个会被新聚焦 variant 撑大的文件（每对约 +5～6MB），
`jaw_worm_horde` 只会跟着 variants 1-8 的内容变化微调。真要担心 100MB 的话，
先担心的是 `cultist`。

⚠ **第十四批同样是纯追加：现有七个文件逐字节未变**（`git status` 只多出
`large_slime.jsonl` 一个未跟踪文件，其余七个 `--install` 覆写后无 diff）。本批**没有改 harness**、
参考仓库也**没有新补丁**，只是把 `large_slime` 这个**本来就在生成、只是没安装**的编队装进来。
开跑前的 `--check` 整份比过七个文件、全部一致。所以标 ⁂ / ※ / ∬ / ∮ / ¶ / § / ★ / ‡ / † / ⁑
的旧例数**一条都没失效**——它们只会因为总例数从 10305 涨到 10680 而略微偏大。

⚠ **第十三批是纯追加：现有五个文件逐字节未变。** 那一批**没有改 harness**（`trace_dump.cpp`
一个字没动，参考仓库也没有新补丁），只是把 `small_slimes` / `lots_of_slimes` 这两个
**本来就在生成、只是没安装**的编队装进来。`--install` 对五个老文件报的是「全部 N 行 —— 一致」
（policy=all 的编队在 `--install` 下只比 variant 0，但本批开跑前的 `--check` 已经整份比过），
所以标 ⁂ / ※ / ∬ / ∮ / ¶ / § / ★ / ‡ / † 的旧例数**一条都没失效**——它们只会因为总例数从
9555 涨到 10305 而略微偏大。

⚠ **第十二批变了三处，而且第三处的形状值得记下来**（`--install` 复验过 variant 0
那 375 行/编队一致；随后逐段 md5 比对过每个 variant）：

| variant | 变没变                                        | 为什么                                                                                                      |
| ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0-6     | **逐字节未变**                                | 牌组里没有这两张，也没有造牌卡                                                                              |
| 7/8     | 变了                                          | 多面手从无色池造出 `dark_shackles` / `violence`，此前被 `isReplayableCard` 挡着，登记后会真的打出去         |
| 9-12    | **逐字节未变**                                | 牌组全是已登记牌且不含造牌卡                                                                                |
| 13/14   | 变了                                          | 同 7/8（嬗变取无色池），再加贪婪之手那个补丁                                                                |
| 15/16   | **只有 `two_louse` 变，`cultist` 逐字节未变** | 贪婪之手 `damage` → `attacked` 的差别**只有** `onAttacked` 链，而当前唯一转写的一条是**蜷缩**（只有虱子有） |
| 17/18   | **逐字节未变**                                | 没有贪婪之手，也没有造牌卡                                                                                  |

所以标 ★ / ‡ / † / § 的旧例数仍成立，标 ∮ 的（variants 9/10）仍成立；
标 ¶ 的（第八批，量在 7/8 上）与标 ∬ 的**嬗变那半**（13/14）**可能有出入**，
标 ※ 的里**完美打击/冲撞/贪婪之手那半**（15/16）在 `two_louse` 上可能有出入、
**炸弹那半**（17/18）仍成立。抽查了四个最薄的数据点，一条都没退化：
`isStrikeCard` 漏掉 `twin_strike` ※1 → **⁂1**、漏掉 `pommel_strike` ※3 → **⁂3**、
「离场即减」※6 → **⁂6**、嬗变 0 费只管本回合 ∬6 → **⁂5**。

⚠ **第十一批 variants 7/8 与 13/14 的内容变了**（variants 0-6 与 9-12 逐字节未变，
`--install` 复验过 variant 0 那 375 行/编队一致）。原因与第九/十批同源：四张新卡从
`isReplayableCard` 摘掉了，而第八批的发现 / 多面手 / 蜕变 / 变形会从铁甲的 70 张池与攻击池里
造出 `clash` / `perfected_strike`，第十批的嬗变会从无色池里造出 `hand_of_greed` / `the_bomb`
——此前被门挡着不让打，现在会真的打出去。所以标 ★ / ‡ / † / § / ∮ 的旧例数仍成立，
标 ¶ 的（第八批，量在 variants 7/8 上）**可能有出入**，标 ∬ 的（第十批）里**嬗变那半
（variants 13/14）可能有出入**、旋风斩/神化那半（variants 11/12）仍成立。

⚠ **第十一批也是「一批开两对 variant」，但这次逼着拆的是「伤害」而不是可重放性**：
炸弹只在打出后**第三个玩家回合末**引爆，它的预言机需要仗打那么久；而完美打击算上五张起始
打击就已经是铁甲池里最能打的一张（6 + 5×2 = 16 起）。同处一副牌组，邪教徒（48~54）第二三
回合就死，`if (bomb1)` 一次都不触发。于是炸弹单独配一副**故意打不动人**的牌组
（variants 17/18：只有 5 张起始打击 + 痛击是伤害来源，其余 8 张全是吃能量的格挡 / 消耗牌，
其中净化会把手牌里最左边的 3(5) 张——正是那些打击——整个清出战斗）。

⚠ **第十批是第一次「一批开两对 variant」，而且拆分是被迫的、不是为了覆盖密度**：
嬗变从无色池取牌（34 张里 9 张未登记），混乱（MAYHEM）每回合把抽牌堆顶那张打出去、
且没有任何策略侧的门能拦它——两者同处一副牌组，必然在某一刻让混乱把造出来的未登记牌
打出去，整条 trace 不可重放。于是混乱跟旋风斩/神化走（variants 11/12，牌组**不含任何造牌卡**），
嬗变自己一对（variants 13/14，**不带混乱**）。浩劫两边都能带：它是一次性的，
harness 能在打出前检查它将要读的那两个牌堆。

⚠ **第十二批的 variants 19/20 也是「故意打不动人」，但目的与第十一批不同**：不是为了让计时器
走完，而是为了让**抽牌堆里的攻击牌数**在一场仗里反复经过 0 / 1 / 2 这些小值。暴力每打一次就从
抽牌堆里**抓走** 3(4) 张攻击牌，所以三张暴力接连打出就会把攻击牌数一路踩下去——那正是
`break` 那条补丁唯一的到达方式。牌组：10 张起始（只有 5 打击 + 痛击是伤害来源）+ 黑暗镣铐×3

- 暴力×3 + 坚不可摧×2 + 幽灵护甲×2 = 20 张，四张使能牌全是吃能量的纯格挡/自消耗牌。
  **量出来的结果**（1309 次暴力打出）：抽牌堆攻击牌 0 张 → 470 次（`attackIdxList.empty()`
  提前返回）、1~2 张 → 227 次、恰好 3 张（升级态）→ 43 次，即 **`break` 那条真的走到 270 次**，
  搬满 count 张的是 569 次。三张暴力这个数量是承重的：只有一张的话，光起始牌组里的 6 张攻击牌
  就让「攻击牌 ≥ 3」几乎恒成立，两条提前退出都会结构性不可达。

⚠ **第九批起「新开一对 variant」不再跑全部 20 个编队**。`DeckVariant` 加了 `encounters`
字段（空 = 全部），variants 9/10 只跑 `CULTIST` 与 `TWO_LOUSE`。理由是体积：
`jaw_worm_horde.jsonl` 已经 48MB，三只颚虫的仗最长、快照最肥，而聚焦 variant 要走的是
**卡牌分支**，与面前是哪只怪基本无关——留一个单怪（邪教徒）+ 一个多怪（双虱）就够覆盖
真正与怪相关的那几条（`getRandomMonsterIdx`、全体伤害、出牌途中怪物死亡）。
代价是这一对只加了 4MB（240 行 × 2 个文件），而不是过去每批的 ~9MB。

⚠ **第十批 variants 7/8 的数据又变了**（原因同第九批那条，再加一条）。两个原因：
三张新卡从 `isReplayableCard` 摘掉了，而第八批的发现 / 多面手 / 蜕变 / 变形本来就会从卡池里
把它们造出来；以及 harness 新加的**浩劫 / 混乱自动打出门**（见「已知偏离」那条）在那两个
variant 上真的生效（那里有造牌卡）。实测首处差异落在第 1097~1103 行，都在 variant 7 段内：
**variants 0-6 逐字节未变**（★ / ‡ / † / § 全部仍成立），**variants 9/10 也逐字节未变**
（∮ 仍成立，只因总例数从 7155 涨到 8115 而偏大），只有 **¶（第八批，量在 variants 7/8 上）
可能有出入**，用到时按需重量。

⚠ **第九批 variants 7/8 的数据变了**（第一次出现「新开一对却不是纯追加」）。原因不是布局，
是 harness 的 `isReplayableCard` 门：那道门列着「已进战斗但未登记」的牌，四张新卡登记之后
必须从门里摘掉，而第八批的发现 / 多面手 / 地狱之刃 / 蜕变**本来就会从卡池里把它们造出来**
——此前被门挡着不让打，现在会真的打出去。实测五个文件的首处差异分别落在第
1099 / 1106 / 1110 / 1136 / 1161 行，都在 variant 7 段内，即 **variants 0-6 逐字节未变**，
所以标 ★ / ‡ / † / § 的旧例数一条都没失效；标 ¶（第八批，量在 variants 7/8 上）的那些
**可能有出入**，用到时按需重量。这不是退化而是覆盖增加：四张新卡在 variants 7/8 的
全部 5 个编队里也被打出了。

⚠ **第八批同样是「新开一对聚焦 variant」**（variants 7/8，18 张）：全牌组 93 + 5 = 98 > 96，
还是装不下。variants 0-6 原样未动，重生成后 variant 0 的 375 行/编队逐字节未变，
所以标 § / ★ / ‡ / † 的旧例数一条都没失效。
牌组特意做小（18 张）不只是为了装得下：蜕变/变形每打一次就往抽牌堆注入 3(5) 张，
牌组一大既埋掉本批自己的牌、又让每帧快照爆炸；18 张下抽牌堆每两三回合就转一圈，
这正是让**回合末费用复位**变得可观察的前提（本回合被压成 0 费的牌得转回来才看得出复位）。

⚠ **「variant 1/2 = 当前全牌组」这个策略从第七批起走不下去了**：全牌组已经 93 张，
`Deck::MAX_SIZE` 是 96，93 + 6 = 99 装不下（而 `fixed_list` 没有越界检查，第 97 张是静默的
内存破坏）。砍到 96 要删掉那三张刻意加的副本、且下一批照样装不下。第七批因此改成
**给本批单开一对聚焦 variant**，variants 0-4 原样不动——实测重生成后前 855 行/编队逐字节
未变，于是它们那些已量过的变异例数一条都没失效。下一批要么继续这么做（每批 +~19MB，
再几批就过 100MB），要么把全牌组拆成两副、并接受重量一遍所有 ★ 例数的代价。

⚠ **variant 指纹已从「张数 + 是否升级」改成整副牌组的内容**（`split-traces.mjs` /
`variant0-rows.mjs`）。旧指纹是个哑弹：两个 variant 张数相同就会被认成一个、行被静默排到
一起、`variant0-rows` 数出来的段长也跟着错，而且不报任何错。第七批本来正好也是 23 张、
与 variant 3/4 撞号，是差点踩上才发现的。换指纹在已提交的 5475 行上验证过：分组划分完全一致。

variant 1/2 里 `FIRE_BREATHING` 有**两张**。这个副本是量出来的、结论也和预期相反，值得记下来：
1 张时（92 张牌组）它被打出 47/29 次，删掉「抽到状态牌就触发」那条钩子只红 7 例；
2 张时（93 张牌组）打出次数翻到 101/69，同一个变异**仍然只红 5 例**。原因是层数上去之后
烈焰吐息的伤害把仗打得更快结束，后面那些「本来会抽到状态牌」的回合根本没发生。
副本留着是因为这张卡自身的覆盖翻倍了（把它错写成旧版本「打出攻击牌时触发」的变异从
61 涨到 128 例），但那条钩子仍然薄，见下方盲区一节。**不要靠再加第三张去救**——
限制因素是战斗长度，不是牌组里有几张。

**variant 3/4 是第五批新开的「聚焦小牌组」**，用掉了本文件此前预留的那个逃生口
（「哪天覆盖表里真的出现 0，再考虑给那一批单开一对更聚焦的牌组——理由要写覆盖密度」）。
用它的理由是全牌组下有**两条分支结构性不可达**，两条的根都是「85 张的抽牌堆一场仗里根本轮不完」：

- **灼伤的回合末自伤**。献焰把灼伤塞**弃牌堆**，它只能靠洗牌回到抽牌堆再被抽到。
  85 张数据上量过：灼伤在弃牌堆出现 296 帧、抽牌堆 44 帧、**手牌 0 帧**——
  `useNoTriggerCard` 整条路零背书。23 张牌组下每几回合就洗一次，手牌 45 帧 / 回合末命中 5 次。
- **`mind_blast` 心灵冲击**。伤害等于抽牌堆张数，而它是**固有牌**（每条 trace 起手必有、
  必被打出）。85 张牌组下开局抽牌堆约 80 → 第一回合一击 80 点，邪教徒(48~~54) 与颚虫(40~~44)
  当场暴毙，cultist / jaw_worm 两个编队的 1230 条 trace 会从 ~40 步塌成 1 步。
  23 张牌组下约 18 点，合乎原版手感。

variant 3/4 与 1/2 一样**每批重新生成**（它小，代价可忽略），不像 variant 0 那样冻结。
代价是数据从 57MB 涨到 66MB。

三条不变量（改 harness 后必须复验，`tools/regen-traces.sh` 会自动查前两条）：

- ⚠ **牌组不得超过 96 张**（`Deck::MAX_SIZE`）。卡住牌组的是**主牌组**：`Deck::cards` 是
  `fixed_list<Card, 96>`（`Deck.h:26-28`），而 `fixed_list` **完全没有越界检查**
  （`push_back` 就是 `arr[list_size++] = t`，`resize` 就是 `list_size = size`），
  第 97 张是静默的内存破坏、不是 assert。`CardManager::init` 的
  `fixed_list<int, Deck::MAX_SIZE> idxs` 与 `isInnateMemo[Deck::MAX_SIZE]` 同源。
  ⚠ **上限不是 64**：三个牌堆（抽/弃/消耗）声明成 `fixed_list<CardInstance, 64>` 的那个分支
  在 `#ifdef sts_card_manager_use_fixed_list` 里（`CardManager.h:34`），而
  `include/sts_common.h:12` 把那个 `#define` 注释掉了、我们的构建命令也不带任何 `-D`
  ——实际编译的是 `std::vector<CardInstance>`，没有上限。
  真正会被 64 卡住的是 `ViolenceAction` 的 `attackIdxList`（`Actions.cpp:616`
  `fixed_list<int, CardManager::MAX_GROUP_SIZE>`），按**抽牌堆里的攻击牌数**算。
  ⚠ 第十二批登记 `violence` 时数过了：最大的那副牌组（variants 1/2，93 张）里攻击牌 40 出头，
  暴力自己那副（variants 19/20，20 张）只有 6 张，都远不到 64——**安全**。
  以后新加牌组时按「抽牌堆里的攻击牌数」而不是牌组张数来数。`UpgradeRandomCardAction` 的
  `upgradeableHandIdxs`（`:942`）是 `fixed_list<int,10>`，手牌上限本就是 10，安全。
- **variant 0 必须排在最前且不变**：`traceIdx` 驱动遗物/药水轮换，位置一动它那 375 行/编队
  就不再逐字节可复现。它之后的行**允许被替换**（那正是「每批重生成」），
  `regen-traces.sh` 认这一点：行数一变就只比 variant 0 那一段
  （段长由 `tools/variant0-rows.mjs` 从新数据里数出来，不写死）
- **`deckUpgraded` 只在确有升级牌时输出**，故未升级的行与该字段存在之前提交的数据完全一致

排序（`tools/split-traces.mjs`）按 **variant 在 harness 输出里的首次出现顺序**，
不按「牌组张数升序」。张数排序其实是在**推断** harness 的声明顺序，多一层不必要的假设：
哪一批的牌组比上一批小，它就会被插到 variant 0 中间去，把既有背书全部错位。
（这个坑是真踩到了才发现的——第一次 `--install` 就红在第 376 行。）首次出现顺序与牌组
大小无关，是 harness 真正的输出顺序，所以更稳。

variant 2（全升级）补的是一个真实漏洞：在它之前，所有 trace 的牌组都未升级，每条卡牌规则
`up ? x : y` 的**一半从来没有预言机看过**。变异验证：把 `playCard` 退回忽略 `upgradedCost`
的写法，230 例失败且全部落在升级变体上；这批数据之前，同样的 bug 是零失败。

**登记了不等于有背书。** 策略只打手牌最左侧的可打出牌，一张卡可以躺在牌组里一次没被打出。
每次重生成后要统计各卡的实际打出次数，0 次就是「有规则、没预言机」，属于本项目不接受的状态。

**「对拍全绿」也不等于新代码被验证了，要用变异测试确认。** 删掉一段逻辑后对拍仍全绿，
说明那段逻辑没有预言机看着。已确认覆盖到的（括号内为变异后的失败例数）：

⚠ **例数是随数据变的**，换 variant 就得重量。下面标 ⸾ 的是在**当前布局（14806 例 =
14056 + 第十九批两个 Boss 编队各 375）**上量的；标 ⸙ 的是第十八批那版布局（14056 例 =
12931 + 三个精英编队各 375）；标 ⸸ 的是第十七批那版布局（12931 例 =
12556 + `gremlin_gang` 的 375）；标 ⁝ 的是第十六批那版布局（12556 例 =
12180 + `exordium_wildlife` 的 375）；标 ⁜ 的是第十五批那版布局（12180 例 =
10680 + 那批四个 `ENC_V0` 编队各 375）；标 ⁑ 的是第十三批那版布局（10305 例 =
9555 + 两个 `ENC_V0` 编队各 375）；标 ⁂ 的是第十二批那版布局（9555 例，
variants 19/20 为第十二批的聚焦牌组）——第十三批是**纯追加**（既没动 harness 也没动参考，
五个老文件逐字节未变），所以 ⁂ 及更早的例数一条都没失效，只会因为分母涨到 10305 而略偏大；
标 ※ 的是第十一批那版布局（9075 例，
variants 15-18 为第十一批的两对聚焦牌组）；标 ∬ 的是第十批那版布局（8115 例，
variants 11-14 为第十批的两对聚焦牌组）；标 ∮ 的是第九批那版布局（7155 例，
variant 9/10 为第九批的 22 张聚焦牌组、只跑 CULTIST/TWO_LOUSE）；
标 ¶ 的是第八批那版布局（6675 例，
variant 7/8 为第八批的 18 张聚焦牌组）；标 § 的是第七批那版布局（5475 例，
variant 5/6 为 24 张聚焦牌组）；标 ★ 的是第六批那版布局（4275 例，
variant 1/2 为 93 张）；标 ‡ 的是第五批那版（同为 4275 例，但 variant 1/2 是 85 张）；
标 † 的是 3075 例那版；没标的更早（3675 例）。绝对值会有出入，但都远离 0、定性结论
（有背书）不受影响。第六批抽查了几个旧数据点，量级都还在：
`inputState` 门 ★489（‡511）、以太回合末消耗 ★369（‡355）、固有分区本身 ★2395（‡2400）、
回合末灼伤那一族 ★5/4/1（与 ‡ 完全一致）。
⚠ 第七批只**追加**了 variant 5/6，variants 0-4 逐字节未变，所以 ★ / ‡ / † 那些例数
仍然成立（只会因为多了 1200 条 trace 而偏大，不会变小）。第八批同理只追加了 variant 7/8，
variants 0-6 逐字节未变，所以 § 那些例数也仍然成立。
⚠ 第九批**不是纯追加**：variants 7/8 的内容变了（见上方布局一节的 `isReplayableCard` 说明），
variants 0-6 逐字节未变。所以 ★ / ‡ / † / § 仍成立，**¶ 那批可能有出入**。
⚠ 第十批同理：variants 7/8 又变了一次，**variants 0-6 与 9/10 都逐字节未变**，
所以 ★ / ‡ / † / § / ∮ 全部仍成立（只因总例数涨到 8115 而偏大），仍然只有 **¶ 可能有出入**。
⚠ 第十一批**改了两处**：variants 7/8 与 13/14 的内容都变了（四张新卡从 `isReplayableCard`
摘掉，而那四个 variant 的造牌卡会从池里把它们造出来；见上方布局一节）。
**variants 0-6 与 9-12 逐字节未变**，所以 ★ / ‡ / † / § / ∮ 仍成立；**¶ 与 ∬ 里嬗变那半
（量在 variants 13/14 上）可能有出入**，用到时按需重量。抽查了三个 ∬ 数据点，量级都还在：
旋风斩基础伤害 ∬43 → **※43**、`playCard` 的 `energyOnUse` ∬177 → **※172**、
神化只扫手牌 ∬171 → **※168**。
⚠ 第十二批**改了三处**（逐 variant md5 比对过，明细见上方布局一节那张表）：variants 7/8 与
13/14 又变了一次（两张新卡从 `isReplayableCard` 摘掉），15/16 **只有 `two_louse` 变了**
（贪婪之手补丁，差别只在蜷缩）。**variants 0-6、9-12、17/18 逐字节未变**，所以
★ / ‡ / † / § / ∮ 与 ※ 里炸弹那半仍成立；**¶、∬ 的嬗变那半、以及 ※ 里完美打击/冲撞/
贪婪之手那半在 `two_louse` 上可能有出入**。抽查的四个最薄数据点没有一个退化（见上方那节）。
⚠ 第十三批**一处都没改**：`trace_dump.cpp` 一个字没动、参考仓库没有新补丁，只是把两个
**本来就在生成、只是没安装**的编队装了进来。所以 ⁂ 及更早的全部例数照旧成立。
⚠ 第十五批**一处都没改**（同第十三/十四批）：`trace_dump.cpp` 一个字没动、参考仓库没有
新补丁，只是把四个**本来就在生成、只是没安装**的编队装了进来。所以 ⁂ / ⁑ 及更早的
全部例数照旧成立。
⚠ 第十七批**一处都没改**（同第十三/十四/十五批）：`trace_dump.cpp` 一个字没动、参考仓库
没有新补丁，只是把 `gremlin_gang` 这个**本来就在生成、只是没安装**的编队装了进来。
所以 ⁝ / ⁜ / ⁑ / ⁂ 及更早的全部例数照旧成立。
⚠ 第十九批**一处都没改**（同第十三/十四/十五/十七批）：`trace_dump.cpp` 一个字没动、
参考仓库停在第十八批那个 commit（`dd05409`）且工作区干净，只是把 `the_guardian` /
`slime_boss` 两个**本来就在生成、只是没安装**的编队装了进来。所以 ⸙ / ⸸ / ⁝ / ⁜ / ⁑ / ⁂
及更早的全部例数照旧成立，只会因总例数涨到 14806 而略偏大。
⚠ 第十六批**改了一处，而且是 `ENC_V0` 头一次改**：参考侧的 `usedEntangle` 补丁改写了
`red_slaver.jsonl` / `exordium_thugs.jsonl`（各 21 / 20 行）。`trace_dump.cpp` 仍然一个字没动，
其余**十个**已提交文件逐字节未变。所以 ⁂ / ⁑ 及更早的例数照旧成立，**⁜ 里凡是在那两个
文件上量的一律作废**——已逐条重量，见「第十六批」那节的重量小节（十五条里变了六条）。
⚠ **⁑ / ⁜ / ⁝ / ⸸ / ⸙ / ⸾ 这几批的分母与别的不同**：`ENC_V0` 编队各只有 375 例（只留 variant 0），
所以**一只怪的可观测面最多就是它出现的那几个编队 × 375**（史莱姆那几只 750、
蓝/红奴隶主 750、抢劫者 750，⚠ **真菌兽只有 375 的一半左右**——它在唯一那个编队里
还是二选一的一半）。这几批的个位数（如 roll 阈值那几条）**不代表薄得像盲区**，
它就是这个分母下的正常量级——不要拿它与卡牌那些四位数直接比。
⚠ **第十九批把这条又推进了一层：同一只怪的不同招式之间也能差两个量级。**
守卫者的防御形态执行 837 次、泄气只有 **4** 次——因为泄气排在重砸之后，而守卫者往往
在重砸之前就被打到形态切换、意图被 `onHpLost` 顶掉。所以「按同一只怪别的招式的量级去推」
这条捷径**在一只怪内部就已经不成立了**，每条变异都要单独看数字。

- 前三批：`upgradedCost`（230）、回合末弃牌顺序（‡1975，旧 1866）、燃烧失血量取 `combustHpLoss`
  而非层数（130）、玩家 Power 的**枚举序**遍历（‡42，†6，旧 4）、
  灵活还债走 `DebuffPlayer` 因而被神器吃掉（†10，旧 3）、
  `drawCards` 顶部的 NO_DRAW 提前返回（‡57）
- 第四批（选牌屏）：`executeActions` 顶部的 `inputState` 门（‡511，†799，旧 479）、
  `chooseWarcryCard` 放牌堆顶而非底（382）、`chooseDrawToHandCard` 要从抽牌堆移除（324）、
  秘密技巧/武器的牌型（242）、`chooseExhaustOneCard` 进消耗堆而非弃牌堆（236）、
  净化多选**降序**消耗（212）、焚誓「先开屏后抽牌」的顺序（204）、坚毅两分支不可互换（170）、
  未雨绸缪抽牌数恒为 2（141）、`chooseHeadbuttCard` 放牌堆顶（127）、军备格挡恒为 5（110）、
  `chooseArmamentsCard` 的手牌重排（89，顺序反过来同样 89）、
  `DrawToHandAction` 扫描循环里的 `cardRandomRng` 消耗（368）、
  `WarcryAction` 手牌恰好 1 张时白吃的那次 `cardRandomRng`（†4，旧 5）、
  掘尸候选排除掘尸自己（†16，旧 52）、净化上限 `up ? 5 : 3`（†51，旧 40）、
  军备+ 的 `upgradeAllCardsInHand`（†10，旧 26）、
  各开屏动作「候选恰好 1 个就不开屏」的捷径（†军备 12 / †焚誓 7 / †头槌 43；
  **秘密技巧那一条已退化成盲区，见下**）
- 第五批（牌的生命周期），全部 ‡：
  - **消耗触发**：黑暗拥抱抽牌（149）、无痛之心加格挡（171）、无痛之心**不过**
    `calculateCardBlock`（82）、无痛之心的 `GainBlock` 是 `clearOnCombatVictory=false`（5）、
    黑暗拥抱层数恒为 1（114）、无痛之心层数 `up?4:3`（114）
  - **状态牌生成**：灼伤进弃牌堆而非抽牌堆（141）、眩晕**洗入**抽牌堆而非弃牌堆（480）、
    伤口洗入抽牌堆而非手牌（211）、洗入时那次 `cardRandomRng`（535）、
    洗入位置 bound 是 `random(张数-1)` 而不是 `random(张数)`（525）、
    抽牌堆为空时**不掷** RNG（13）、伤口塞手牌而非弃牌堆（312）、伤口张数恒为 2（312）、
    灼伤张数恒为 1（141）、献焰伤害 `up?28:21`（73）、鲁莽冲锋 `up?10:7`（177）、
    狂野劈砍 `up?17:12`（75）、强行突破格挡 `up?20:15`（115）
  - **回合末手里的灼伤**：整条 noTrigger 结算（5）、伤害 2 点（4）、伤害**过格挡**
    而非走 `loseHp`（1）、结算完进弃牌堆（5）、noTrigger 项不走 `useCard`（5）、
    扫描整个手牌而不只第一张（4）。⚠ 这一族只有 5 例，是**当前最薄的一处**，
    且完全依赖 variant 3/4 那副 23 张牌组（85 张下是 0 例，见上方布局一节）
  - **以太**：回合末消耗以太牌（355）、进消耗堆而非弃牌堆（355）、
    helper 必须**先** addToTop（否则弃牌先于消耗，355）、扫描顺序不能反（109）、
    以太判定读 `ethereal` 而非别的位（535）、杀戮 `up?28:20`（26）、幽灵护甲 `up?13:10`（121）
  - **固有归位**：分区本身（2400）、固有必须在牌堆**顶**而非底（2400）、
    分区必须**稳定**（4275，即全红）、升级态固有（暴虐+，1200）、
    戏剧性登场伤害 `up?12:8`（1001）、心灵冲击伤害取**抽牌堆**张数（949）、
    暴虐层数恒为 1（982）、暴虐的回合开始结算（616）、暴虐失血走 `loseHp` 不过格挡（24）
- 第六批（玩家的事件钩子），全部 ★：
  - **主宰**：触发本身（47）、伤害**入队**而非同步（8）、层数 `up?7:5`（65）、
    伤害**不过** `calculateCardDamage`（30）、`amount <= 0` 的提前返回排在触发**之前**
    （即加 0 格挡不触发，3——靠「无法格挡下打防御牌」这条路走到）
  - **怒火**：触发本身（82）、格挡走裸 `GainBlock` 而非 `calculateCardBlock`（63）、
    `GainBlock` 的 `clearOnCombatVictory=false`（24）、只有**攻击牌**触发（74）、
    触发点在卡效果**之后**（82）、回合末清除（102）、层数 `up?5:3`（124）、
    清除是**同步**而非入队（2，薄）
  - **火焰屏障**：反伤触发本身（50）、反伤**不看**这一击是否被挡满（42）、
    反伤是 `addToTop` 而非 `addToBot`（31）、清除在**下回合开始**而非回合末（63）、
    层数 `up?6:4`（93）、格挡 `up?16:12`（86）
  - **烈焰吐息**：错写成旧版本「打出攻击牌时触发」（128）、层数 `up?10:6`（165）、
    走 `DamageAllEnemy` 而非 `AttackAllEnemy`（4）、
    状态牌那支的触发本身（**5**，最薄）、伤害**入队**而非同步（**1**，最薄）
  - **破裂**：触发本身（39 → **补丁后 49**）、**只认** `selfDamage`（受击也加力量 →
    41 → **补丁后 35**）、加力量是**同步**而非入队（4）、层数 `up?2:1`（80）；
    各失血来源的 `selfDamage` 实参逐个验证过：燃烧（6）、血液动力（9）、放血（24）、
    杰克斯（8）、献祭（17）、受击传 false（改 true → 35）、
    **暴虐传 true**（改回 false → **23**）。最后这条第七批才成立：第六批测到的是「暴虐传
    false，改 true 红 23 例」，即数据当时明确记着参考的漏传；补丁 + 重生成之后同样是 23 例，
    只是方向反过来了（见下方「已修正」的暴虐条）
  - **哨兵**：消耗回能量的触发本身（7）、回能量 `up?3:2`（2）、
    触发排在黑暗拥抱/无痛之心**之后**（7）、格挡 `up?8:5`（58）
  - **应急按钮 / NO_BLOCK**：`calculateCardBlock` 顶部那道门（50）、
    它**只**拦牌产生的格挡、不拦裸 `GainBlock`（18）、回合末**无条件**递减（73）、
    层数恒为 2（91）、走 `DebuffPlayer` 因而被神器吃掉（20）、格挡 `up?40:30`（111）
  - **回合开始抽牌必须入队**（`addToBot(DrawCards)` 而非同步抽）——这条第六批才变得可观察，
    而且是靠对拍**红了一例**才发现的（不是变异测试）：烈焰吐息在抽牌途中 `addToBot` 伤害，
    同步抽牌会让它排到暴虐的「失血 + 抽 1」**之前**，它打死最后一只怪时
    `clearPostCombatActions` 就把暴虐那次抽牌清掉，少抽一张。改成入队后 4275 例全绿
  - **进化**：抽到状态牌才触发（266）、触发本身（132）、层数 `up?2:1`（133）、
    补抽是入队而非同步（50）
- 第七批（卡牌实例级状态），全部 §：
  - **框架**：`playCard` 读实例级 `costForTurn` 而非从数据表现算（767）、
    `upgradeCard` 尾部「升级前后费用不同就同步 cost/costForTurn」（6）、
    `useCard` 扣能量的 `!(腐化 && 技能牌)` 子句（**2**，最薄；全靠 ENTRENCH 那条链，
    见下方布局说明）
  - **暴走**：伤害读 `specialData`（46）、成长量 `up?8:5`（14）、
    成长排在算伤害**之后**（412——把它提到前面就等于本次也吃成长）
  - **灼热之刃**：伤害公式 `n(n+7)/2+12` 里的 n（115）、
    `getUpgradeCount` 对它读 `specialData` 而非 `upgraded`（8）、
    `upgradeCard` 里 `specialData += 1`（10）
  - **血债血偿**：`cardsOnTookDamage` 整条（326）、它**不看** `selfDamage`（227）、
    扫手牌/抽牌堆/弃牌堆三个堆（只扫手牌 268、去掉弃牌堆 60、去掉抽牌堆 218）、
    伤害 `up?22:18`（83）
  - **疯狂**：整条效果（591）、拒绝采样（改成一次命中 62）、
    命中后 `cost` 与 `costForTurn` **都**置 0（只置后者 53）、
    「无有效牌就提前返回」（19）
  - **腐化**：`onBuffCorruption` 落地扫场（309）、它只压**技能牌**（去掉类型判断 510）、
    它扫四个牌堆（只扫手牌 18）、`useCard` 里技能牌 `exhaustOnUse=true`（471）、
    改成对所有牌型都消耗（516）、**重复获得不叠层**（175）
  - **幻影 / 虚无缥缈**：幻影整条效果（768）、升级后不再虚无（84）、
    怪物攻击那条钳制（390）、`Player::loseHp` 那条（174）、
    `Player::damage` 那条（**1**，最薄）、回合末递减（696）、
    「一回合只递减一层」（多加一次递减 76）

这一批还**消掉了两个旧盲区**（状态牌真的进了手牌之后自然可达）：
`canUpgradeCard` 的诅咒/状态排除（‡2）、`moveToHandHelper` 的「手牌满改进弃牌堆」（‡2）。

- 第八批（随机卡池取牌），全部 ¶：
  - **卡池与取样**：按牌型取牌的 bound `池大小-1`（1061）、70 张池的 bound（640）、
    无色池的 bound（1048）、攻击池顺序（前两张对调 248）、技能池顺序（156）、
    无色池顺序（114）、70 张池顺序（**19**，最薄——发现每场只开一两次屏）、
    发现候选的**拒绝采样**（去掉去重 27）、候选恒 3 张（改 2 张 644）
  - **蜕变 / 变形**：两个循环必须分开（合并成交替 802）、
    0 费落在 **`cost` 与 `costForTurn` 两个字段**（只压 costForTurn → 546）、
    张数 `up?5:3`（264）、蜕变取技能池而非攻击池（528）、
    抽牌堆为空时**不掷** RNG（38）、造出来的牌恒未升级（跟着牌组升级 → 496）
  - **地狱之刃**：置 0 费本身（788）、0 费**只管本回合**（连 `cost` 一起压 → 93）、
    取攻击池（改技能池 926）
  - **多面手**：张数 `up?2:1`（525）、两张都是 `addToTop` 故**后抽到的先进手牌**
    （改 addToBot 508）、**不改费用**（也置 0 费 → 721）、造出来的牌恒未升级（519）
  - **发现**：候选池是铁甲的 70 张而非无色池（644）、份数恒 1（改 2 → 644）、
    选中的牌置本回合 0 费（424）、0 费**只管本回合**（连 `cost` 一起压 → 16）、
    `selectCard` 取的是 `cardSelect.cards[idx]`（取错一张 644）
  - **消掉的三个旧盲区**（都是第七批记下的「`cost` 与 `costForTurn` 不分岔」那一族，
    本批正是让它们分岔的那一批）：
    - `playCard` 读 `costForTurn` 而不是 `cost`：§0 → **¶914**
    - `cardsResetAttributesAtEndOfTurn` 整条：§0 → **¶101**（不扫抽牌堆 6）
    - `moveToHandHelper` 的腐化钩子：§0 → **¶24**（多面手把带费用的无色技能塞进手牌）
  - **顺带重量的旧点**：`onBuffCorruption` 落地扫场（§309 → ¶568）、
    它扫四个牌堆（只扫手牌 §18 → ¶18）
- 第九批（出牌队列嵌套），全部 ∮：
  - **从牌堆打出**：浩劫 `exhausts=true`（改 false 302）、混乱 `exhausts=false`（改 true 214）、
    浩劫的目标掷 `getRandomMonsterIdx`（改成恒取 0 号怪、不掷 341）、
    混乱挂在**抽牌之前**（挪到 `applyStartOfTurnPostDrawPowers` 222）、
    混乱层数恒 1 与升级无关（改 `up?2:1` 135）、混乱多层各打一张（只打一张 46）、
    入的是**出牌队列队首**（改队尾 39）、
    空抽牌堆那支两条 `addToTop` 的顺序（对调成「先打后洗」9）、
    `EmptyDeckShuffle` 消耗一次 `shuffleRng`（去掉 9）、
    `canUse` 那道门（去掉、于是眩晕也被打出 12）
  - **二连击**：整条触发（去掉 221）、`!purgeOnUse`（复制的那一击又触发一次 71）、
    `onAfterUseCard` 顶部的 `purgeOnUse` 提前返回（去掉、副本也进弃牌堆 161）、
    层数 `up?2:1`（改恒 1 133）、触发时**递减一层**而非整层清空（改 remove 102）、
    回合末清除（去掉 157）、复制项继承原目标（改成恒 0 号怪 37）
  - **双持**：份数 `up?2:1`（改恒 1 111）、`chooseDualWieldCard` 的手牌重排
    （改成军备那种 valid→选中→invalid 185）、能力牌也能被复制（只留攻击牌 119）、
    「恰好一张就直接复制」的捷径（去掉、一律开屏 86）、
    「没有可复制的牌就返回」（去掉、改开屏 35）、
    副本是**整份实例拷贝**而非按定义重造原型（**2**，最薄）、
    手牌满时副本进弃牌堆（改成丢掉 **2**，最薄）
  - **框架**：`useCard` 扣能量的 `!item.autoplay` 子句（去掉、浩劫打出的牌也扣能量 375）、
    `playCardQueueItem` 里那道**单独的**目标门（去掉 9——它对 `purgeOnUse` 是唯一生效的
    一道，见下方「已修正」；这一条是本批靠**读源码**而不是靠对拍发现的）
- 第十批（X 费），全部 ∬：
  - **X 的三条来路**：`playCard` 的 `energyOnUse` 退回填 `card.costForTurn`（177）、
    `playTopCardInDrawPile` 的 `energyOnUse` 改成 0（20）、
    `queuePurgeCard` 的 `ignoreEnergyTotal` 改 false（11）
  - **旋风斩**：基础伤害 `up?8:5`（43）、`useEnergy` 恒 true 即无视 `freeToPlay`（20）、
    `whirlwindAction` 里那次能量清零（177）、去掉 `effectAmount > 0` 门（119）、
    伤害**不过** `calculateCardDamage`（67）、走 `Monster::damage` 而非 `attacked`（41）、
    递归续轮 `addToTop` 改 `addToBot`（8——改了之后本卡会先进弃牌堆再打后几轮）
  - **嬗变**：`useEnergy` 恒 true（30）、造出来的牌**带升级态**（改成恒未升级 134）、
    0 费只管**本回合**（连 `cost` 一起压成「本场战斗」→ 6）、去掉 0 费（114）、
    取**无色池**而非技能池（382）、张数取 X（改成恒 1 张 → 342）、
    进手牌走 `moveToHandHelper`（改成直接 push → 33）
  - **神化**：只扫手牌（171）、不扫抽牌堆（168）、不扫弃牌堆（13）、
    改成**同步**而非入队（116）；连带把两条旧点加厚了——
    `upgradeCard` 尾部「升级前后费用不同就同步 cost/costForTurn」（§6 → **∬93**）、
    灼热之刃的 `specialData` 累加（改成置 1 → 11，即神化对它的重复升级有背书）
  - **消掉的两个旧盲区**（都是第九批记下的、当时明说「等 X 费登记后会变得可观察」）：
    - `useCard` 扣能量读 `card.costForTurn` 还是 `item.energyOnUse`：∮0 → **∬7666**
      （X 费牌的 `costForTurn` 是 -1 而 `energyOnUse` 是满能量，两者天差地别）
    - `playTopCardInDrawPile` 把 `energyOnUse` 设成「当前全部能量」：∮0 → **∬20**
- 第十一批（四个小机制），全部 ※：
  - **完美打击 / 打击计数**：伤害公式改成「现扫手牌」而不是读计数器（127）、
    基础伤害 `6`（88）、`isStrikeCard` 漏掉 `strike`（107）/ 漏掉 `perfected_strike` 自己（74）/
    漏掉 `wild_strike`（45）/ 漏掉 `swift_strike`（38）/ 漏掉 `pommel_strike`（3）/
    漏掉 `twin_strike`（**1**，最薄——它不在本批牌组里，只靠 variants 7/8/13/14 造出来）、
    「**算上自己**」（`strikeCount - 1` → 69）、加成量 `up?3:2`（升级那半 18 / 未升级那半 53）
  - **计数器的两个钩子**：`instantiate` 里的 `notifyAddCardToCombat` 整个去掉（171）、
    双持的副本不递增（4）、双持捷径分支的副本不递增（**1**）、
    双持给**原牌**换 uid 时也 notify（多算一次，3）
  - **「离场即减」**：`triggerAndMoveToExhaustPile` 里的 `notifyRemoveFromCombat` 去掉
    （**6**，本批最薄的一处；连带「改成现扫手/抽/弃三堆」只有 3 例——两者同一个根，
    见下方盲区里对它的量测说明）
  - **冲撞**：整道门去掉（14）、判据从 `every` 改成 `some`（14）、
    门只在玩家点牌时生效即自动打出豁免（14——**浩劫翻出冲撞**那条路有背书）、
    伤害 `up?18:14`（升级那半 16 / 未升级那半 38）
  - **炸弹**：整段去掉（216）、只去掉引爆保留前移（216）、先前移后引爆即提前一回合炸（273）、
    落在 `bomb1` 当回合末就炸（338）、落在 `bomb2` 少等一回合（273）、
    伤害走 `attackAllEnemies` 而非 `DamageAllEnemy`（49）、引爆改成同步而非入队（29）、
    伤害 `up?50:40`（升级那半 **3** / 未升级那半 9——都薄，见盲区）、
    两张不叠加改成赋值（**1**）、`bomb3` 不清零即无限连炸（**3**）
  - **贪婪之手**：去掉金币（153）、金币不看击杀即无条件给（61）、
    伤害走 `monsterAttacked` 而非 `Monster::damage`（59）、
    伤害 `up?25:20`（升级那半 29）、金币 `up?25:20`（升级那半 70 / 未升级那半 83）
  - **顺带修掉一个从第一批就潜伏的转写错误**（`drawCards`，见下方「我们自己的转写错误」）。
    修正之后这几处才有了背书：空弃牌堆时**照样要洗**（3）、
    「抽牌堆 + 弃牌堆都空」提前返回（3——去掉它就白吃一次 shuffleRng）、
    「抽干剩余抽牌堆」那步同步递归（1275）。
    ⚠ 「补抽与洗牌两条 `addToTop` 的顺序」**量不出数字**：对调之后 `drawCards` 会对着空抽牌堆
    无限自我入队，`executeActions` 的 LOOP_GUARD 熔断，跑不完。这本身就是「顺序是承重的」
    的证据，但没有可比的例数。
- 第十二批（怪物回合末触发 / 从抽牌堆随机检索），全部 ⁂：
  - **三个参考侧补丁各自的背书**（这一批的补丁是随登记一起打的，所以下面每一条都是
    「把我们的实现退回参考原文」量出来的，方向与「补丁修对了没有」一致）：
    - **黑暗镣铐的符号**：`-amount` 退回参考原文的正数（即把削弱写成增强）→ **552**
    - **黑暗镣铐的神器条件**：`!hasArtifact` 退回参考原文的 `hasArtifact`（即永不上
      SHACKLED）→ **552**
    - **暴力的 `break`**：退回参考原文的 `return`（即抽牌堆里攻击牌不足时凭空复制）→ **260**。
      ⚠ 这一条**不是**碰巧走到的：量过分布，1309 次暴力打出里有 **270 次**抽牌堆攻击牌
      少于 count（1 张 127 / 2 张 100 / 恰好 3 张而 count=4 的 43），见上方布局一节
    - **贪婪之手走 `attacked`**：退回参考原文的 `Monster::damage` → **59**
      （与第十一批实测的 59 例完全一致——那时数据里记的是参考的错值，方向反过来而已）
  - **黑暗镣铐**：层数 `up?15:9` 改成恒 9（238）
  - **怪物回合末触发（束缚）**：整条去掉即力量永不归还（504）、归还但不清 SHACKLED
    即每回合白送一次（504）、清 SHACKLED 但不归还力量（504）、
    去掉 `!alive` 跳过即死怪也归还（**52**——玩家回合内打死一只带 SHACKLED 的怪，
    参考跳过它，尸体的快照里力量就一直是负的）
  - **暴力**：扫描循环里那次 `cardRandomRng` 去掉（490）、
    掷了但**不用**结果（插入位置恒 0，313——与秘密技巧那两条「白吃的 RNG」不同族，
    这一次结果是真的被读的）、每轮那次 `shuffleRng` 去掉（513）、
    只洗 `[i, end)` 尾段而不是整个列表（466）、取 `list[i]` 而不是 `list[0]`（482）、
    张数 `up?4:3` 改成恒 3（181）、移除前**必须排序**（不排 450）、
    移除必须**从大到小**（改升序 490）、**手牌满 10 张改进弃牌堆**那一支（**21**）
- 第十三批（史莱姆四只 + 两个编队），全部 ⁑（10305 例；两个新编队各 375 例，
  即每只怪的可观测面**最多 750 例**——下面的数字要按这个分母读，不能与卡牌那些
  「全部 20 个编队 × 21 个 variant」的数字直接比大小）：
  - **`getMoveForRoll` 的 roll 阈值**（各改 ±1）：酸液 M 的 `<30` → 29 / 31（**5** / **2**）、
    `<70` → 69 / 71（**2** / **7**）；尖刺 M 的 `<30` → 29 / 31（8 / 8）。
    ⚠ 全部个位数，是本批**最薄的一族**——史莱姆的仗只有 3~5 回合，一场里 rollMove 撑死几次。
  - **连续限制（`lastMove` vs `lastTwoMoves`）**：酸液 M 第一段 `lastTwoMoves` → `lastMove`（17）、
    **第二段 `lastMove` → `lastTwoMoves`（29）**、第三段 `lastTwoMoves` → `lastMove`（22）；
    尖刺 M 的 `lastTwoMoves(扑击)` → `lastMove`（14）、`lastTwoMoves(舔舐)` → `lastMove`（84）。
    ⚠ 第二段那 29 例值钱：参考在 asc<17 下**第一段用 lastTwoMoves、第二段却用 lastMove**，
    看着像笔误（asc17 那份两段都是 lastTwoMoves），数据证明它不是——照抄是对的。
  - **`getMoveForRoll` 内追加的 `aiRng`**：酸液 M 第一段 `randomBoolean()` 改成 `(0.4)`（**1**）、
    整个不掷（**1**）、第二段 `(0.4)` 改成 `()`（11）、第二段 true/false 互换（29）。
    ⚠ 前两条各只有 1 例——要「连续两回合腐蚀喷吐」才走得到，短仗里几乎撞不上。
  - **酸液史莱姆小的两处特殊形态**：完全不掷追加的 `randomBoolean`（**565**）、
    `randomBoolean` 取反（**565**）。这只怪 `getMoveForRoll` 不看 roll、只看追加那一次，
    所以两条都是全场级别的影响。
  - **招式收尾三形态**：酸液小的同步 `setMove` 改成 `roll`（252）、改成 `no_op_roll`（252）、
    两条 setMove 目标改成自己即不再交替（252）；尖刺小的 `no_op_roll` 改成同步 `setMove`
    即少掷一次 aiRng（**289**）。
  - **编队构建（miscRng）**：小史莱姆组 `randomBoolean` 取反（**375**，即整个文件）、
    组内两只出场顺序对调（375）、干脆不掷（375）；
    史莱姆群循环方向反过来（373）、**左移改成「与末位交换」（253）**、
    `random(i)` 的 bound 固定成 4（352）、最后一次 `random(0)` 不掷（375）。
    ⚠ 那 253 例正是「不要等价改写抽样」的证据：两种写法分布相同，同种子下排列不同。
  - **血量区间**（上下界各 ±1）：酸液 M 156/156、尖刺 M 146/153、酸液 S 499/519、
    尖刺 S 527/528。小号史莱姆的数字高一个量级，因为 `lots_of_slimes` 五只全是小号。
  - **招式数值**：腐蚀喷吐 7→8（29）、扑击 8→10（30）、酸液 M 冲撞 10→12（42）、
    尖刺 S 冲撞 5→6（233）、酸液 S 冲撞 3→4（140）、尖刺 M 舔舐 frail→weak（92）。
  - **黏液塞牌**：`addToBot` 改同步（**7**）、去向 discard→hand（116）、张数 1→2（60）。
  - **脆弱**（本批第一次真的被施加）：不进 `justApplied` 集合（92）、
    不削格挡（49）、回合末不递减（28）。

- 第十四批（大史莱姆两只 + 分裂），全部 ⁂⁑（10680 例；新编队 375 例，其中**发生过分裂的
  只有 367 条**——另外 8 条是玩家在它分裂之前就把它打死 / 自己先输了。下面凡是 367 的数字
  都等于「所有会分裂的 trace 全红」，是这一批的天花板）：
  - **分裂的触发（`onHpLost`）**：`attacked` 路径整条去掉即永不分裂（**367**）；
    `damage` 路径去掉（**3**——非攻击伤害（燃烧 / 主宰 / 火焰药水）把它压到半血的场次，
    少但真的存在）；阈值 `<= maxHp/2` 改成 `<`（16）、改成 `<= maxHp/2 + 1`（25）。
  - **分裂的血量继承**：`maxHp` 改成继承母体上限（**367**）、改成重掷 `monsterHpRng`（**367**）。
  - **分裂不继承状态**：新怪继承母体 powers（192）。
  - **分裂的 aiRng 消耗**：新怪不 `rollMove`（**367**）、两只 `rollMove` 顺序对调（196）、
    去掉 `largeSlimeSplit` 尾部那次 `noOpRollMove`（**367**）、去掉 `extraRollMoveOnTurn`
    那次（**367**）、把后一次换成真的 `rollMove`（288）。
  - **游标推进**：分裂里的 `++monsterTurnIdx` 去掉即新生的第二只本回合就行动（**367**）。
  - **存活计数**：`monstersAlive` 不 +1（359——差的 8 条正是没分裂的那些）。
  - **招式收尾第四形态**：`"none"` 改成 `"roll"`（**367**）、改成 `"no_op_roll"`（**367**）。
  - **编队构建（miscRng）**：`large_slime` 的 `randomBoolean` 取反（**375**，即整个文件）、
    干脆不掷（**375**）。
  - **`getMoveForRoll` 的 roll 阈值**（各改 ±1）：酸液 L 的 `<30` → 29 / 31（7 / **1**）、
    `<70` → 69 / 71（3 / 4）；尖刺 L 的 `<30` → 29 / 31（5 / 5）。
    ⚠ 比第十三批还薄——L 号很早就分裂了，一场仗里它自己只出手几次。
  - **连续限制**：酸液 L 第一段 `lastTwoMoves` → `lastMove`（6）、第二段 `lastMove` →
    `lastTwoMoves`（12）、第三段 `lastTwoMoves` → `lastMove`（14）；
    尖刺 L 的 `lastTwoMoves(扑击)` → `lastMove`（6）、`lastTwoMoves(舔舐)` → `lastMove`（37）。
    ⚠ 第二段那 12 例与第十三批 M 号那 29 例同源：参考在 asc<17 下**第一段用 lastTwoMoves、
    第二段却用 lastMove**，数据再次证明照抄是对的。
  - **`getMoveForRoll` 内追加的 `aiRng`**：酸液 L 第二段 true/false 互换（12）。
  - **血量区间**（上下界各 ±1）：酸液 L 153/159、尖刺 L 169/155。
  - **招式数值**：腐蚀喷吐 11→12（17）、冲撞 16→18（23）、舔舐虚弱 2→1（18）、
    扑击 16→18（22）、舔舐脆弱 2→3（39）、L 号黏液张数 2→1（31）。
  - **黏液三项（第十三批的零背书盲区，本批的验收项）**——全部**从 0 变成 36**：
    `cost` 1→5（**36**）、整条删掉 `CARD_RULES.slimed`（**36**）、
    `exhausts` true→false（**36**）。顺手多量了一条：去掉 `cardCanUse` 里
    `id != SLIMED` 那个例外（即让它打不出）也是 **36**。
    36 = 有黏液被打出的 trace 条数，46 = 打出次数，与第十三批预测的 46 一致。
    **这条盲区已关闭。**

- 第十六批（真菌兽 + 荒野二人组 + 孢子云 + 红奴隶主补丁），全部 ⁝（12556 例。
  ⚠ 分母要按编队读：真菌兽**只**出现在 `exordium_wildlife`，而且是「二选一」的一半——
  375 条里只有一半左右有它，实测 `FUNGI_BEAST_BITE` 执行 **32** 次、`FUNGI_BEAST_GROW`
  **19** 次，**历批最薄**。所以下面个位数的例数是正常的，**0 才是盲区**）：
  - **孢子云（本批的验收项，死亡触发第一条）**——每一条都非 0，这一族有真背书：
    - 整条不生效（`hasStatus` 那道门恒假，**181**）
    - 易伤层数 2→3（**150**）
    - 开局不上 `SPORE_CLOUD`（**188**，比上面两条大：它还改怪物 powers 快照，
      连「没死过」的帧也红）、`SPORE_CLOUD` 层数 2→1（**188**，同理）
    - `isSourceMonster` 由 `bc.turnHasEnded` 改成恒 true（**120**）／恒 false（**2**）。
      ⚠ 两个方向都非 0 是这条最值钱的地方：120 = 真菌兽在**玩家回合**里死掉（多数），
      2 = 在**怪物阶段**里死掉（荆棘 / 火焰屏障那类反伤打死的），参考那个「用 turnHasEnded
      而不是常量」的写法被两侧各自钉住了。
  - **真菌兽的出招表**：`roll < 60` → 61（**2**）、第一段 `lastTwoMoves(咬)` → `lastMove`
    （**20**）、第二段 `lastMove(成长)` → `lastTwoMoves`（**5**）。
  - **真菌兽的收尾**：撕咬的 `roll` 改成 `no_op_roll`（**12**）——它俩消耗的 aiRng 相同，
    区别只在「改不改意图」，这次因为真菌兽有两招而真的可观测（对比第十三批尖刺史莱姆小
    那条 0 例：那只怪只有一招）。
  - **招式数值 / 血量**：撕咬 6→7（**11**）、成长 +3→+4（**19**）、
    血量下界 22→23（**168**）、上界 28→27（**155**）。
    ⚠ 血量那两条大得多是因为它错开 `monsterHpRng`，整条 trace 从第一帧就分岔。
  - **`createStrongWildlife` / 编队构造**：两段顺序对调（先 weak 后 strong，**375** =
    整个文件）、strong 的两个候选对调（**375**）。两条都是「错开 RNG 计数器」那一族。
  - **同步 buff 改成入队**（`apply_power on self` 整条改走 `addToBot`，**2350**）——
    这是顺手量的共享路径，说明「怪物给自己 buff 是同步」这件事有海量背书。
  - **重量：第十五批在 `red_slaver` / `exordium_thugs` 上量过的十三条**（补丁改了这两个
    文件的数据，旧数字一律作废）。⚠ **变了六条**，方向都是「缠绕少放了 → 相关帧变少」：
    | 变异                                                                  | 旧（⁜） | 新（⁝）     |
    | --------------------------------------------------------------------- | ------- | ----------- |
    | 缠绕层数 1→2                                                          | 41      | **41**      |
    | 缠绕回合末不清除                                                      | 41      | **41**      |
    | 缠绕封锁扩到所有牌型                                                  | 35      | **34**      |
    | `RED_SLAVER_ENTANGLE` **执行次数**                                    | 72      | **56**      |
    | 红奴隶主 `roll>=75` → 74                                              | 5       | **3**       |
    | 红奴隶主 `roll>=75` → 76                                              | 8       | **7**       |
    | 刮擦连续限制 `lastTwoMoves`→`lastMove`                                | 129     | **110**     |
    | 去掉「首回合必刺击」                                                  | 440     | **440**     |
    | 血量下界 46→47 / 上界 50→49                                           | 344/381 | **344/363** |
    | 刺击 13→14                                                            | 215     | **224**     |
    | 刮擦 8→9                                                              | 97      | **90**      |
    | 刮擦易伤 1→2                                                          | 127     | **118**     |
    | 强人形前两个候选对调                                                  | 265     | **265**     |
    | `getSlaver` true/false 互换                                           | 129     | **129**     |
    | 候选取样 bound −1→−2                                                  | 339     | **640**     |
    | ⚠ 最后一条涨到 640 不是补丁的效果，是**本批多了一个用同一函数的编队** |
    | （`exordium_wildlife` 的两段也走 `createFromConstructedPool`）。      |
  - **`usedEntangle` 补丁本身（本批的第二个验收项）**：
    - 去掉 `MOVE_TURN_BEGIN` 里那句 `miscInfo = 1`（即回到打补丁前的行为）→ **41 例**。
      **补丁被数据看着**，不是拍脑袋改的。
    - 去掉复活的 `roll >= 50 && usedEntangle && !lastTwoMoves(STAB)` 整段 → **37 例**。
      那一段从死代码变成了**有 37 例背书的活代码**。
    - 阈值 `50` → 51（**1**）／→ 49（**0**）。⚠ 这就是「打补丁把一个未验证的阈值变成活的」
      的代价的实测大小：它现在**只被 1 例钉住**，而且只钉住一个方向。见下方盲区。

- 第十五批（奴隶主两只 + 抢劫者 + 四个编队），全部 ⁜（12180 例。⚠ 分母要按编队读：
  蓝奴隶主出现在 `blue_slaver` + `exordium_thugs`，红奴隶主同理，抢劫者出现在
  `looter` + `exordium_thugs`，各最多 750 例；而**逃跑只在 `exordium_thugs` 的 16 条
  trace 上发生过**，16 就是那一族的天花板）：
  - **逃跑**：不减 `monstersAlive`（也就不判胜，**16**）、置 `alive = false` 改成
    保持 `true`（**16**）、逃跑时把血量归零即「当成死亡」（**16**）。
    ⚠ 三条都是 16 = 全部逃跑场次全红，这一族**满覆盖**。
  - **抢劫者的招式链**：猛扑之后改成直接逃跑（42）、烟雾弹之后改成再抢劫（42）、
    烟雾弹的收尾从同步 `setMove` 改成 `roll`（42）。
  - **抢劫的收尾（第五形态：任意函数）**：去掉首回合那次白掷的 aiRng（对白，**391**）、
    把它改成每回合都掷（208）、`randomBoolean(0.5)` 的 true/false 互换
    （即烟雾弹↔猛扑，208）、去掉首回合的「再抢一次」分支（**391**）、
    `getMonsterTurnNumber` 去掉 `+1`（**391**）。
  - **偷金**：整条不生效（391）、偷窃额度 15→16（**485**）、开局不上 THIEVERY（**485**）。
    ⚠ 485 > 391 是因为 THIEVERY 那两条还会改**怪物 powers 快照**，连没偷到钱的帧也红。
  - **纠缠**：层数 1→2（41）、回合末不清除（41）、把封锁从「只封攻击牌」扩到封所有牌型（35）。
    ⚠ 41 = 玩家真的带上缠绕的 trace 条数（`red_slaver` 18 + `exordium_thugs` 23）。
  - **「构造全部再选一」**：改成「先选后造」（**375**，即整个文件）、
    两段（弱野生 / 强人形）顺序对调（**375**）、候选取样 bound 2→1（339）、
    强人形的前两个候选对调（265）、`getSlaver` 的 true/false 互换（129）。
    ⚠ 前两条各 375 = `exordium_thugs` 全文件红，因为它们直接错开 `monsterHpRng` 的计数器。
  - **`getMoveForRoll` 的 roll 阈值**（各改 ±1）：蓝奴隶主 `>=40` → 39 / 41（12 / **11**）、
    红奴隶主 `>=75` → 74 / 76（**5** / **8**）。⚠ 与第十三/十四批同量级，是 750 例分母下
    的正常值。
  - **连续限制**：蓝奴隶主 `lastTwoMoves(刺击)` → `lastMove`（162）、
    `lastTwoMoves(耙击)` → `lastMove`（87）；红奴隶主 `lastTwoMoves(刮擦)` → `lastMove`（129）。
  - **首回合特例的有无**：红奴隶主去掉「首回合必刺击」（**440**）、
    蓝奴隶主**凭空加**一个首回合特例（181）。⚠ 这两条成对：参考只有红的有、蓝的没有，
    两个方向都被数据钉住了。
  - **抢劫者的 `getMoveForRoll`**：首招改成猛扑（**485**，即全部有抢劫者的 trace）。
  - **血量区间**（上下界各 ±1）：蓝奴隶主 348 / 378、红奴隶主 344 / 381、抢劫者 384 / 415。
  - **招式数值**：蓝刺击 12→13（153）、蓝耙击 7→8（115）、蓝耙击的虚弱 1→2（169）、
    红刺击 13→14（215）、红刮擦 8→9（97）、红刮擦的易伤 1→2（127）、
    抢劫 10→11（265）、猛扑 12→13（**27**）、烟雾弹格挡 6→7（42）。

- 第十七批（地精五只 + 地精帮 + 四条新机制），全部 ⸸（12931 例。
  ⚠ 分母要按编队读：五只地精**只**出现在 `gremlin_gang` 的 375 条里，而且是「8 选 4」的
  抽样结果——护盾地精与巫师在候选表里各只占 1/8，所以它俩的例数天然比另外三只小一半以上。
  实测执行次数：抓挠 532、穿刺 382、猛击 461、保护 215、蓄力 207、大招 46、**盾击 15**）：
  - **池抽 4（本批第一个验收项）**：左移改成「与末位交换」（**325**）、左移改成右移（**340**）、
    `lastIdx` 不递减（**373**）、循环 4→3 轮（**375** = 整个文件）、
    bound `random(lastIdx)`→`random(lastIdx-1)`（**372**）、
    候选表护盾与巫师对调（**294**）、候选表狂暴两项与鬼祟两项对调（**372**）。
    ⚠ 那 325 例再次印证「不要等价改写抽样」——与第十三批史莱姆群那 253 例同源。
  - **给友方加格挡（第二个验收项，本项目第一个怪物→怪物效果）**：不排除自己（**86**）、
    不排除已死的（**83**）、候选为空时照样掷一次 aiRng（**33**）、
    bound `random(n-1)`→`random(n)`（**70**）、目标恒为自己（**105**）、
    候选倒序（**69**）、格挡 7→8（**109**）。
    ⚠ 那 33 例值钱：它证明「没有同伴就给自己、且**不掷** aiRng」这一支真的被走到了。
  - **蓄力计数（第三个验收项，`miscInfo` 的第三种用法）**：阈值 3→2（**111**）／3→4（**77**）、
    起点 1→0（**77**）／1→2（**111**）、`+1` 整条去掉（**77**）／改成 `+2`（**111**）、
    大招之后不回蓄力（**45**）、出招规则不写 `miscInfo`（**77**）、首招改成大招（**172**）。
    ⚠ **大招那句 `miscInfo = 0` 只被 1 例钉住**，见盲区——去掉它之后巫师第一次大招之后
    就永远蓄力，而 375 条里只有 1 条仗长到能看见第二轮大招。
  - **狂怒（第四个验收项，`onAttacked` 族第二条）**：整条不触发（**302**）、
    开局不上 `ANGRY`（**308**，比上面大：它还改怪物 powers 快照）、层数 1→2（**308**）、
    挪进 `monsterDamageUnblocked` 即「只在破了格挡时才涨」（**30**）、
    触发一次即清除（**302**）、改成 `addToBot`（**114**）。
    ⚠ 那 30 例是这一族最值钱的：它钉住了「打在格挡上照样涨力量」——狂怒与蜷缩位置不同的
    全部可观察面就是这 30 帧。
  - **招式收尾**：狂暴 `no_op_roll`→`none`（**222**）、肥胖 `no_op_roll`→`none`（**192**）、
    鬼祟 `none`→`no_op_roll`（**172**）／→`roll`（**172**）、盾击 `none`→`no_op_roll`（**12**）、
    保护改成 `no_op_roll`（**109**）、巫师蓄力改成 `no_op_roll`（**111**）。
    ⚠ 前三条成对：三只怪都只有一招，收尾却分两种，两个方向都被数据钉住了。
  - **护盾地精的落单判定**：`<= 1` → `< 1`（永不改盾击，**33**）、→ `<= 2`（**69**）、
    首招直接改成盾击（**189**）。
  - **血量区间**（上下界各 ±1）：狂暴 264/262、鬼祟下界 232、肥胖上界 248、
    护盾下界 **124**、巫师上界 **150**。⚠ 后两只低一半，正是「候选表里各只占 1/8」的体现。
  - **招式数值**：抓挠 4→5（**176**）、穿刺 9→10（**146**）、猛击 4→5（**151**）、
    猛击的虚弱 1→2（**169**）／整条去掉（**192**）、盾击 6→7（**9**）、
    终极爆发 25→26（**45**）。⚠ 盾击那 9 例是本批最薄的数字（它只在护盾地精落单时才出）。

- 第二十批（第一幕最后一个 Boss：六火幽魂），全部 ⸿（15181 例。
  ⚠ **本批的分母是历批最均匀的**：六条招式的「执行」栏 274~1243，最薄的地狱之火也有 274。
  原因是结构性的——六火幽魂 250 血、出招序**完全固定**，不会像守卫者那样被 `onHpLost`
  顶掉意图，每一招都按周期稳定轮到。所以**个位数与 0 在本批都是异常信号**，
  下面凡是 0 的都单独给了结构性理由）：
  - **六重打击伤害的公式（第一个验收项）**：整条不算（`miscInfo` 恒 0）红 **375**、
    除数 12→11 红 **288**、加数 1→0 红 **375**、整除改四舍五入红 **288**、
    段数 6→5 红 **375**。
    ⚠ **两条 0 例，而且都是「时点」那一维**（见盲区）：改成读 `maxHp`、以及
    「推迟到六重打击落下时才算」都是 0。所以**公式**钉死了，**「在激活那一刻算定」
    这件事没有预言机**。
  - **固定七招循环（第二个验收项）**——十六条变异里只有一条 0：
    - 首招改成六重打击红 **375**；收尾整体失效（六条键全改名）红 **375**。
    - 五条无条件转移：激活→六重打击（**375**）、六重打击→灼烧（**375**）、
      冲撞→灼烧（**375**）、燃焰→冲撞（**372**）、地狱之火→灼烧（**274**）。
    - 灼烧那条唯一的三分岔：`==0` 支改地狱之火（**375**）、`==2` 支改冲撞（**375**）、
      `else` 支改燃焰（**328**）；阈值 `==0`→`==1`（**375**）、`==2`→`==3`（**375**）。
    - `uniquePower0` 的五个写入点：六重打击的清零改 +1（**375**）、地狱之火的清零改 +1
      （**148**）、灼烧的 `++` 去掉（**375**）、冲撞的 `++` 去掉（**375**）、
      灼烧改成**先加后读**（**375**）。
    - ⚠ **一条 0 例：燃焰的 `++uniquePower0` 去掉**（见盲区）。根因很具体：
      去掉它之后计数从 3→4→5 变成 3→3→4，而灼烧的三分岔只认 `0` 与 `2`，
      两条路都落进同一个 `else`。**五个写入点里唯独这一个可以少加一次而序列不变。**
  - **收尾的 aiRng 次数**——「掷不掷」全部有背书，「同步还是入队」几乎全没有：
    - 整条去掉：激活（**375**）、燃焰（**372**）、灼烧（**375**）、六重打击（**375**）、
      冲撞（**375**）、地狱之火（**206**）。
    - ⚠ **入队↔同步只有一条非 0：灼烧的 34 例**（入队改同步）。它是本批**唯一**一条能
      分辨这个时点的——因为灼烧那条 case 里 noOpRollMove 之前**还排着两条动作**
      （攻击 + 塞灼伤），别的 case 都只有同步语句。
      激活 / 燃焰的「同步改入队」是 **0**（与第十八批吸魂那条同族，见盲区）。
  - **灼烧塞灼伤（第三个验收项）**：
    - 张数 1→2 红 **375**、整条不塞牌红 **375**。
    - 塞牌改成同步红 **34**、塞牌排到伤害**之前**红 **34**——⚠ 这两条值钱：
      它们是**这一族（`add_card` 的 sync / 顺序）第一次拿到非 0 背书**
      （第十九批史莱姆王那条是 0）。同样是因为灼烧那条 case 里塞牌之后还有一条动作。
    - ⚠ **升级那一支（`bc.turn > 8`）零背书**：去掉 `upgradedAfterTurn`（永不升级）**0**、
      阈值 8→7 **0**、8→9 **0**；但**恒升级**（阈值 → -1）红 **307**。
      见盲区——「灼伤+ 会不会被造出来」有背书（307），「从第 10 个怪物回合起才造」没有。
    - 「升级位在排队那一刻求值 vs 执行时求值」**0 例**（等价改写：同一个怪物回合内
      `bc.turn` 不会变），方向照抄。
  - **灼伤的回合末伤害（第四个验收项，也是第五批那条 5 例盲区的重量）**：
    未升级 2→3 红 **331**。⚠ 第五批在 variant 3/4 那副 23 张聚焦牌组上量到的是 **4~5 例**，
    本批一口气涨到 **331**——`hexaghost.jsonl` 是灼伤这条登记**目前最厚的背书**。
    ⚠ 但灼伤**+** 那一半仍是 0（4→5 **0**、恒 2 **0**），根因同上。
    ⚠ 三条 0 例见盲区：`selfDamage`（破裂不在 variant 0 的牌组里，第六批就记着）、
    `clearOnCombatVictory`（本批修的转写错，结构性不可观察）、`addToTop`→`addToBot`。
  - **血量与六条招式数值**：血量 250→251（**375**）、六重打击段数 6→5（**375**）、
    灼烧 6→7（**357**）、冲撞 5→6（**371**）/ 段数 2→1（**373**）、
    燃焰格挡 12→13（**372**）/ 力量 2→3（**372**）、
    地狱之火 2→3（**173**）/ 段数 6→5（**242**）。
    ⚠ 燃焰那两条的 **372** 就是「执行过燃焰的 trace 条数」的天花板（另外 3 条五回合就赢了）。
  - **两条共享原语（本批修的转写错）**：
    `deal_damage_rolled` 的 `times` 不读（即六重打击只打一段）——**这条不是变异测出来的，
    是新数据当场红 375 例抓出来的**，见「我们自己的转写错误」。
    灼伤那条 `clearOnCombatVictory` 改回 `true` 是 **0 例**，见盲区。
  - ⚠ **三条 `intent` 变异全 0**（激活 unknown→attack、燃焰 buff→attack、灼烧 attack→debuff），
    与第十四~十九批同族：`isMonsterAttacking` 唯一的读者是觅敌之弱，而 variant 0 那副
    21 张牌组里没有它。白名单已逐条复核（`MonsterMoves.h:463-466` 四条攻击招在里面，
    `HEXAGHOST_ACTIVATE` / `_INFLAME` 不在）。
  - ⚠ **两条「顺序 / 同步」0 例**：燃焰的加格挡同步改入队、燃焰两句（加格挡 / 加力量）
    对调——与第十五批烟雾弹、第十九批蓄能同族（case 里效果之后只剩同步语句）。
  - ⚠ **多段攻击「伤害只算一次」仍是 0 例**（第十九批就记着）。六重打击 6 段也没能救它：
    段与段之间没有任何东西能改玩家的易伤 / 虚弱或怪物的力量。

- 第二十批新增的盲区，全部 ⸿：
  - ⚠⚠ **「六重打击的伤害在激活那一刻算定」这件事本身零背书（0 例）。**
    两个方向都量了：改成读 `player.maxHp`（**0**）、改成「六重打击落下时才按当前生命算」
    （**0**）。根因是结构性的、而且很干脆：**激活是第一个怪物回合、它一点伤害都不造成**，
    而六火幽魂是**单怪编队**，所以从「开局满血」到「六重打击落下」之间玩家一滴血都没掉过
    ——`hp == maxHp` 且两个时点的 `hp` 相同，三种写法取值完全一致。
    ⚠ **公式本身是钉死的**（整条不算红 375、除数红 288、加数红 375、整除红 288），
    没背书的只有「读哪个字段 / 在哪一刻读」。
    **关门条件**：让玩家在第 1~2 个怪物回合就掉血——需要一副带自伤牌（放血 / 燃烧 /
    血债血偿）的牌组与六火幽魂同场，而 `ENC_V0` 只留 variant 0 那副 21 张起始牌组，
    聚焦 variant 的行按定义会被裁掉。等 harness 追加循环那一批。
    ⚠ 顺带：「激活那句改成 `addToBot`」也是 **0**（同一个根）。
  - ⚠ **灼伤+（`bc.turn > 8` 那一支）零背书（0 例）。** 永不升级 **0**、阈值 8→7 **0**、
    8→9 **0**，而恒升级红 **307**——所以「造得出灼伤+」这件事有背书，「什么时候开始造」没有。
    **根因是量出来的**：375 条里战斗最长的一条也只到 `turn 12`，
    `maxTurn ≥ 10` 的只有 **119** 条（分布：turn 5/6/7/8/9/10/11/12 = 3/8/37/121/87/77/34/8）。
    第 10 个怪物回合那张灼伤+ 进的是**弃牌堆**，要洗回抽牌堆再被抽到手、还要活到回合末
    ——仗在那之前就结束了。与第五批「85 张牌组下灼伤 0 次进手牌」同源，只是这次卡的是
    **战斗剩余长度**而不是牌组大小。
    **关门条件**：一场能打到 15+ 回合的六火幽魂战斗，即一副**打不动人**的牌组
    （第十一批炸弹那种）——同样被 `ENC_V0` 只留 variant 0 挡住。
  - **燃焰的 `++uniquePower0` 去掉分不出来（0 例）。** 五个写入点里唯独这一个可以少加一次
    而招式序列不变：去掉它之后计数从 3→4→5 变成 3→3→4，而灼烧的三分岔只认 `0` 与 `2`，
    两条路都落进同一个 `else`（→ 地狱之火）。
    ⚠ **方向仍然照抄**（`MonsterSpecific.cpp:817` 就是 `++uniquePower0`）。
    关门条件：一个会读到 `uniquePower0` 具体值的第四分支——参考里不存在，**永远关不掉**。
  - **激活 / 燃焰的 noOpRollMove「同步 ↔ 入队」分不出来（各 0 例）。** 与第十八批吸魂、
    第十九批蓄能同族：这两条 case 里 noOpRollMove 之前**没有任何入队动作**
    （激活压根没有效果，燃焰的加格挡与加力量都是同步的），所以「掷在动作之前还是之后」
    落到同一个位置。⚠ **对照组是灼烧那条：34 例**——它之前排着攻击 + 塞灼伤两条动作。
    所以这一族不是「永远量不出来」，只是要 case 里真的有排队动作。
  - **燃焰的加格挡「同步 ↔ 入队」、以及两句顺序对调，分不出来（各 0 例）。**
    与第十五批烟雾弹、第十九批蓄能同族（case 里效果之后只剩同步 `setMove`）。
    有背书的是**数值**（格挡 12→13 红 372、力量 2→3 红 372）。
  - **灼伤那条 `DamagePlayer` 的 `clearOnCombatVictory` 分不出来（0 例），而且是结构性的。**
    改回 `true` 对拍全绿：它走 `addToTop`、下一步就出队，中间插不进任何东西；
    灼伤又只打玩家，而清扫**只在胜利时**发生。同族的 `addToTop`→`addToBot` 也是 **0**。
    详见「我们自己的转写错误」里那一条（本批仍然把它改对了，理由写在那儿）。
    ⚠ 同一族里**第六批那条「灼伤的自伤会不会触发破裂」仍是 0**：破裂只在 variant 1/2 的
    全牌组里，而 `ENC_V0` 只留 variant 0。本批把灼伤的**伤害**背书从 5 例做到 331 例，
    但没能救回 `selfDamage` 那一位。
  - **三条 `intent` 变异（激活 / 燃焰 / 灼烧）各 0 例**，与第十四~十九批同族——
    `isMonsterAttacking` 唯一的读者是觅敌之弱，variant 0 那副 21 张牌组里没有它。
    白名单已逐条复核。⚠ 这一族现在覆盖了 **7 批**，是全项目最大的一块同质盲区，
    关门条件只有一个：**让觅敌之弱与怪物同场**（需要 harness 追加循环或换 `ENC_V0` 策略）。
  - **多段攻击「伤害只算一次」仍是 0 例**（第十九批已记）。六重打击 6 段没能救它，
    根因不变：段间没有东西能改倍率。

- 第十九批（第一幕两个 Boss + 形态切换 / 尖锐外壳 / Boss 分裂），全部 ⸾（14806 例。
  ⚠ **本批的分母极不均匀，必须逐招读**：两只 Boss 各只出现在自己那一个编队的 375 条里，
  但十一条招式的「执行」栏从 **4**（泄气）到 **837**（防御形态）横跨两个量级。
  凡是只挂在泄气上的变异都是**个位数**，那是正常的；**0 才是盲区**）：
  - **形态切换（本批第一个验收项）**——每一条都非 0 只有一个例外（见盲区）：
    - 阈值起点 30 → 31 / 29（各 **375**）、`preBattleAction` 不上 `MODE_SHIFT`
      （即永不切换，**375**）、**不写 `miscInfo`**（即第二轮阈值从 10 起算，**375**）。
      ⚠ 后两条证明「同一个数要写进两个地方」不是冗余：漏掉任一个都红整个文件。
    - `onHpLost` 里扣的是**这一次未被格挡的伤害**——改成恒扣 1 红 **375**；
      入口那道 `hasStatus<MODE_SHIFT>()` 去掉（即防御形态里还会二次切换）红 **375**；
      归零判据 `<= 0` 改成 `< 0` 红 **100**。
    - 进防御形态那 20 点挡：整条去掉红 **375**、改成同步红 **37**、数值 20→21 红 **375**。
      ⚠ 那 **37** 例就是「意图当场变、格挡要等动作出队」这个时点差的全部可观察面。
    - 双重猛击的收尾三句：`miscInfo += 10` 去掉红 **375**、改成 +20 红 **375**、
      不重挂 `MODE_SHIFT` 红 **375**、重挂改成同步红 **149**。
  - **尖锐外壳（第二个验收项）**：
    - 整条不触发（**375**）、层数 3→4（**375**）、双重猛击不清除它（**375**）。
    - **挂在攻击牌上**：扩到技能牌也触发红 **360**——这一条同时证伪了本文件第十八批那句
      「`onUseSkillCard` 里的尖锐外壳」（函数名写错了，见「已修正 · 第十九批」）。
    - **走 `Player::damage` 而不是 `attacked`**：改走 attacked（于是触发荆棘 / 火焰屏障）
      红 **94**。
    - **`addToBot` + `clearOnCombatVictory = false`**：改同步红 **181**、改 `addToTop`
      红 **181**、`clearOnVictory` 改 true 红 **79**。
      ⚠ 那 79 例值钱：它就是「这一击打死守卫者、反伤照样落在玩家身上」的场次。
    - ⚠ 两条 0 例见盲区：`selfDamage` 与「只看 `arr[0]`」。
  - **Boss 分裂（第三个验收项）**——每一处与大史莱姆的差别都有非零例数：
    - **复用 `largeSlimeSplit` 那条路径**红 **375** = 整个文件。这就是「不要复用」的实测代价。
    - 落位下标：`idx2` 2→1（不留空格）红 **375**、两只落位顺序对调红 **247**、
      `splitInto` 两只种类对调红 **375**。
    - `monsterTurnIdx = 3` 改成 `+= 1`（新生的两只当回合就行动）红 **375**。
    - **一次 noOpRollMove 都不掷**：追加一次红 **375**、追加两次（照抄大史莱姆）红 **375**。
    - 共用的那段：新怪不 `rollMove` 红 **742**、`maxHp` 不压成当前血量红 **742**
      （⚠ 742 > 375，因为这两条也改**大史莱姆**的分裂，跨了两个文件）。
    - 触发：`onHpLost` 阈值 `<=` 改 `<` 红 **46**；收尾 `"none"` 改 `"roll"` / `"no_op_roll"`
      各红 **375**。
    - ⚠ 两条 0 例：`monstersAlive = 2` 改成 `+= 1`（**等价改写**，当前场上只有王一只）、
      `overwriteMove` 改 `setMove`（盲区，见下）。
  - **大史莱姆分裂新走到的那一支**（「目标格已有怪」，第十四批留的显式抛错）：
    改成「追加到末尾」红 **345**、去掉 `monsterCount = min(count+1,4)` 的补占位红 **344**、
    上限 4 改 5 红 **275**。⚠ 三条都非 0 说明那个 `INVALID = 0` 空格是真的被看着的。
  - **共享原语**：`Actions::AttackPlayer` 的 `clearOnCombatVictory` 由 false 改回 true
    红 **7**——**我们自己的转写错误，本批修掉**（见「我们自己的转写错误」那节）。
    ⚠ 多段攻击「伤害只算一次」改成逐段重算是 **0 例**，见盲区。
  - **招式数值 / 血量**：守卫者血量 240→241（**375**）、史莱姆王 140→141（**375**）、
    蓄能格挡 9→10（**234**）、重砸 32→33（**67**）、滚压 9→10（**368**）、
    旋风 5→6（**362**）/ 段数 4→3（**360**）、双重猛击 8→9（**319**）/ 段数 2→1（**375**）、
    猛砸 35→36（**144**）、黏液喷射 3→2 张（**370**）；
    泄气：**两条减益顺序对调（2）**、易伤 2→3（**2**）、虚弱 2→3（**4**）。
    ⚠ 泄气那三个个位数就是「执行 4 次」的天花板，**全部非 0**——顺序那 2 例正是本批
    订正 `enemies.ts` 的依据（见「已修正 · 第十九批」）。
  - **出招表（十一条 case 全是同步 setMove，一次 aiRng 都不掷）**：
    - 守卫者进攻链：蓄能→重砸 改成 →泄气（**234**）、重砸→泄气 改成 →旋风（**95**）、
      泄气→旋风 改成 →蓄能（**4**）、旋风→蓄能 改成 →重砸（**357**）。
    - 守卫者防御链：防御形态→滚压 改成 →双重猛击（**375**）、
      滚压→双重猛击 改成 →旋风（**375**）、双重猛击→旋风 改成 →蓄能（**375**）。
    - 守卫者首招改成重砸（**375**）；蓄能那条收尾改成 `"roll"`（多掷一次 aiRng，**234**）。
    - 史莱姆王：黏液→蓄力 改成 →猛砸（**370**）、蓄力→猛砸 改成 →黏液（**291**）、
      猛砸→黏液 改成 →蓄力（**138**）、猛砸收尾改成 `"no_op_roll"`（**144**）、
      首招改成猛砸（**375**）。
  - **重量：黏液那四条（第十四批在 `large_slime` 上量的 36 例）**——打出次数从 46 涨到
    **1511**，四条全部从 36 涨到 **408**：`cost` 1→5（**408**）、
    删掉 `CARD_RULES.slimed`（**408**）、`exhausts` true→false（**408**）、
    去掉 `cardCanUse` 里 `id != SLIMED` 那个例外（**408**）。
    ⚠ 408 是「有黏液被打出的 trace 条数」，不是打出次数。这条登记现在是全项目背书最厚的
    状态牌之一。

- 第十九批新增的盲区，全部 ⸾：
  - **守卫者的形态切换用 `setMove` 还是裸的 `moveHistory[0] = X` 分不出来（0 例）。**
    参考在同一个 `onHpLost` 的 switch 里两种写法并存（分裂用裸赋值、守卫者用 `setMove`），
    差别只有「`moveHistory[1]` 前不前移」。而守卫者的 `getMoveForRoll` **整场只被调用一次**、
    七条 case 的收尾全是同步 `setMove`，**没有任何东西读 `lastMove` / `lastTwoMoves`**
    ——于是 `moveHistory[1]` 全程无人读。方向照抄。
    ⚠ 同族的还有**史莱姆王的分裂**（`overwriteMove` 改 `setMove`，0 例），根因相同。
    关门条件：一只**既读 `lastTwoMoves`、又会被 `onHpLost` 改写意图**的怪。参考里
    `onHpLost` 只有四支（三条分裂 + 守卫者），四只都不读历史——**这条永远关不掉**。
  - **尖锐外壳的 `selfDamage` 分不出来（0 例）。** 改成 true（于是触发破裂）对拍全绿，
    因为 variant 0 那副 21 张牌组里没有破裂，而 `ENC_V0` 只留 variant 0。
    与第六批那一族（各失血来源的 `selfDamage` 实参）同源，只是这次没有牌能守着它。
  - **尖锐外壳只看 `monsters.arr[0]` 分不出来（0 例）。** 与第十八批激怒那条同族，
    但**更彻底**：全参考项目 buff `SHARP_HIDE` 的只有守卫者（`MonsterSpecific.cpp:1352`
    是唯一写入点），而守卫者只出现在单怪编队里——激怒那条至少还有
    `COLOSSEUM_EVENT_NOBS` 当关门条件，这条**连关门条件都不存在**。照抄不改，不打补丁。
  - **多段攻击「伤害只算一次」分不出来（0 例）。** 改成逐段重算
    （`attackPlayerHelper` 那个循环里每次都 `calculateDamageToPlayer`）对拍全绿：
    四段旋风之间没有任何东西能改玩家的易伤 / 虚弱或怪物的力量——荆棘反伤不碰这些字段。
    要区分得让「多段攻击」与「段间会改倍率的效果」共存（例如带**易伤递减**的回合边界，
    或第二幕会在自己回合内给自己加力量的怪）。方向照抄。
  - **蓄能的加格挡「同步 ↔ 入队」分不出来（0 例）**，**黏液喷射的塞牌同样（0 例）**。
    与第十五批烟雾弹、第十七批给友方加格挡、第十八批吸魂那三条**同源**：
    这两条 case 里效果之后只剩一句同步 `setMove`，中间没有第三条动作，而两只 Boss 都是
    **单怪编队**、后面没有别的怪接着行动。
    ⚠ 有背书的是**数值**（格挡 9→10 红 234、张数 3→2 红 370），没背书的只是时点。
  - ⚠ **一条等价改写（不是盲区）**：`slimeBossSplit` 的 `monstersAlive = 2` 改成 `+= 1`
    对拍全绿——分裂发生时场上恒只有王一只，`1 + 1 == 2`。语义不同（赋值 vs 自增）但当前
    取值相同，与第十七批「池抽 4 先选后建」同族，记成盲区会误导下一个人。

- 第十八批（第一幕三个精英 + 激怒 / 沉睡+金属化 / 神器 / 恍惚），全部 ⸙（14056 例。
  ⚠ 分母：三只怪各自只出现在自己那一个编队的 375 条里，但它们都是**精英**——血厚、仗长，
  八条招式的「执行」栏是 270~1712，是历批最厚的一次。所以下面的个位数是真的薄，
  **0 就是盲区**）：
  - **激怒（本批第一个验收项，第一条「玩家出牌 → 怪物获益」的钩子）**：
    整条不触发（**303**）、触发一次即清除层数（**303**）、扩到技能以外的牌型（**133**）、
    咆哮给的层数 2→3（**375**）。
    ⚠ 三条 0 例见盲区：同步改 `addToBot`、位置提到卡效果之前、以及「只看 `monsters[0]`」。
  - **沉睡 / 苏醒（第二个验收项）**：
    - 编队不上 `ASLEEP`（**375** = 整个文件）、首招规则反过来（**375**）。
    - 苏醒：`attacked` 那条路不叫醒（**199**）、`damage` 那条路不叫醒（**176**）。
      ⚠ **两条都非 0 是这一族最值钱的地方**：它证明「非攻击伤害也叫得醒」真的被走到了
      （176 例来自燃烧 / 主宰 / 荆棘那类走 `Monster::damage` 的伤害），
      所以「两处形状不同、不能合并」不是纸上谈兵。
    - 苏醒挪到**格挡吸收之前**（即打在格挡上也醒）红 **75**——这 75 例就是
      「开局那 8 点挡替它挡住的那些攻击」，与第十七批狂怒那 30 例同族。
    - 苏醒时不递减金属化（**375**）。
    - 沉睡收尾去掉「被打醒也转重击」那一支（**373**）。
    - 计时器 `bc.turn === 2` → `=== 1` 只红 **2**，→ `=== 3` 红 **0**（见盲区）。
  - **金属化**：开局的 `addBlock(8)` 去掉（**375**）、开局不上 `METALLICIZE`（**375**）、
    层数 8→9（**375**）、**回合末不加格挡（只有 9）**。
    ⚠ 那 9 例值得单记：开局那层挡与「回合末 +8」是两件事，前者红整个文件、后者只有 9 例
    ——因为绝大多数场次里拉加维林在第一个回合末之前就被打醒了，`METALLICIZE` 已经没了。
  - **神器（第三个验收项）**：`debuffEnemy` 去掉整条拦截（**362**）、拦截但不消耗层数
    （**362**）、吃掉减益后不 `return`（**362**）、开局不给哨卫上 `ARTIFACT`（**375**）、
    层数 1→2（**375**）。⚠ 后两条更大是因为它们还改**怪物 powers 快照**。
    **这一族第一次有了真背书**，见下方「盲区 · 第十二批」那条的关闭说明。
  - **恍惚**：射钉塞的张数 2→1（**375**）／2→3（**375**）／整条不塞（**375**）。
    `ethereal: true` → false 红 **477**——⚠ 这个数**大于**单个文件，因为恍惚在本批之前
    就能进场（第五批的 `reckless_charge` 会把它塞进抽牌堆），那 102 例来自别的编队。
    塞牌位置（弃牌堆 `push` 改 `unshift`）红 **1245**（共享原语，黏液也走它）。
    把塞牌从入队改成同步红 **13**。
    ⚠ 两条 0 例见盲区：`exhausts` 与 `cost` 哨兵——恍惚**打不出**，那两个属性只在打出时才被读。
  - **招式收尾（五条「同步 setMove + noOpRollMove」）**：
    重击的 aiRng 整条不掷（**375**）、吸魂的（**285**）、沉睡的（**375**）、
    光束的（**375**）、射钉的（**375**）。
    ⚠ 「入队 ↔ 同步」这一维**几乎量不出来**：重击那条改同步只红 **11**、哨卫那条只红 **8**，
    吸魂那条改入队红 **0**。这三个数正好说明「次数」是被钉死的、「时点」几乎不是。
  - **出招表**：
    - 拉加维林的重击连击判定 `lastTwoMoves` → `lastMove`（**375**）。
    - 哨卫首招的奇偶反过来（**375**）、三只统一不看下标（**375**）、交替失效（**375**）。
    - 地精头目：去掉首招必咆哮（**375**）、`roll < 33` → 32 / 34（**9** / **15**）、
      猛冲的连续限制 `lastTwoMoves` → `lastMove`（**204**）、
      给碎颅击也加连续限制（`||` 改成 `&& !lastTwoMoves(碎颅)`，**95**）、
      猛冲的收尾改 `no_op_roll`（**221**）、咆哮的收尾改 `no_op_roll`（**375**）。
      ⚠ 阈值那两个个位数是本批最薄的：地精头目一场仗只出手十来次，roll 落在 32/33 这两个
      具体值上的概率约 1%。**两个方向都非 0**，比第十六批真菌兽那条（一个方向 0）好。
  - **招式数值 / 血量**：猛冲 14→15（**274**）、碎颅击 6→7（**162**）、碎颅击易伤 2→3
    （**169**）、重击 18→19（**375**）、吸魂 -1→-2（**213**）、吸魂的敏捷/力量顺序对调
    （**86**）、光束 9→10（**371**）；血量上下界各 ±1：地精头目 297 / 315、
    拉加维林 245 / 262、哨卫 371 / 370。
    ⚠ 吸魂那 86 例值钱：两条减益都是 `-1`、落在不同字段上，**唯一**能分辨顺序的是
    玩家身上有神器时它吃掉的是哪一条（古代药水在轮换里）。参考的顺序是**敏捷在前**。
  - **顺手量的共享路径**：怪物给玩家上减益的 `isSourceMonster` 由 true 改 false
    （即不跳过首次递减）红 **2123**——「怪物来源的虚弱/易伤当回合不递减」有海量背书。

- 第十八批新增的盲区，全部 ⸙：
  - **激怒的「同步 buff 改成 `addToBot`」分不出来（0 例）。** 与第十五批烟雾弹加格挡、
    第十七批给友方加格挡同族：从入队到执行之间没有东西读怪物力量——技能牌排的动作都不打人，
    而伤害是**怪物回合开始**才算的。同理「把 `onUseSkillCard` 提到卡效果 `rule()` 之前」
    也是 0（技能牌的效果全是入队的，同步语句读不到差别）。
  - **激怒只看 `monsters.arr[0]` 分不出来（0 例）。** 改成遍历全体对拍全绿——地精头目是
    **单怪编队**，下标 0 就是它自己。⚠ 这条是**参考的简化**（真实游戏里激怒是那只怪身上的
    Power，谁有谁涨），方向照抄；关门条件是一个「带激怒的怪不在 0 号位」的编队，
    而第一幕只有地精头目有激怒，所以这条在 `ENC_V0` 这条路上**永远关不掉**。
  - ⚠ **「拉加维林睡满 3 回合都没被打醒」在这份数据里没发生过（0 例）。**
    `bc.turn === 2` 改成 `=== 3` 对拍全绿，改成 `>= 2` 也全绿；只有改成 `=== 1` 红 **2 例**。
    根因：那条判断是 `bc.turn == 2 || !hasStatus<ASLEEP>()`，而 375 条里**每一条**在第 3 个
    怪物回合之前就把它打醒了（21 张牌组也总能戳穿 8 点挡）。于是「睡满三回合自然醒」
    这一支零背书，被打醒那一支拿走了全部 373 例。
    关门条件：一副**打不动人**的牌组（第十一批炸弹那种）+ 拉加维林——但 `ENC_V0` 只留
    variant 0，聚焦 variant 的行按定义会被裁掉。所以这条要等 harness 追加循环那一批。
  - **`preBattleAction` 的「睡着才上金属化」那道前提分不出来（0 例）。** 去掉它
    （改成无条件上）对拍全绿——`LAGAVULIN` 这个编队**恒**在 `createMonsters` 里置沉睡位，
    唯一能分辨的是 `LAGAVULIN_EVENT`（睡魔事件版，不置沉睡位），而它不在 harness 的 20 个里。
  - **苏醒那条从 else-if 链里拆成独立 if 分不出来（0 例）**，**挪到扣血之后也是（0 例）**。
    前者要一只**同时带蜷缩与沉睡**的怪（参考里不存在），后者要在扣血与苏醒之间插进
    读沉睡位的东西。方向仍然照抄。
  - **吸取灵魂的两条减益「同步 ↔ 入队」分不出来（0 例）。** 参考写的是 `.actFunc(bc)`
    （全项目唯一一处「怪物给玩家上减益却不入队」），改成 `addToBot` 全绿。
    根因是结构性的：这条 case 里减益之后只剩 `setMove` + `noOpRollMove` 两句同步语句，
    中间没有第三条动作，而拉加维林是**单怪编队**、后面没有别的怪接着行动。
    同族的还有「吸魂的 `noOpRollMove` 由同步改入队」（0 例）。
  - **恍惚的 `exhausts` 与 `cost` 两个属性零背书（各 0 例）。** `exhausts: false` → true
    全绿、`cost: null`（哨兵 -2）→ 1 也全绿。根因很干脆：**恍惚永远打不出**
    （`CardInstance.cpp:329` 的例外只放行 `SLIMED`），而这两个属性只在**打出**那一刻被读
    ——`exhausts` 在 `useCard` 里、`cost` 在 `cardCanUse` 的能量门与 `setCostForTurn` 里。
    ⚠ 与第十批「X 费的 -1 换成 0 全绿」同族：哨兵值只有在有人去动它时才可观察。
    关门条件：一副带**腐化 / 疯狂**（会改 `costForTurn`）或**医疗包**（让状态牌可打出）的
    牌组与哨卫同场——同样被 `ENC_V0` 只留 variant 0 挡住。
    ⚠ **有背书的是 `ethereal`**（红 477 例），所以「恍惚回合末会消失」这条是钉死的。

- 第十七批新增的盲区，全部 ⸸：
  - **给友方加格挡「入队改同步」分不出来（0 例）。** 参考是
    `addToBot(Actions::GainBlockRandomEnemy(...))`，改成当场执行对拍全绿。
    与第十五批「烟雾弹的加格挡同步 ↔ 入队」同源：保护那条 case 里加格挡之后只剩一句
    条件 `setMove`，中间没有第三条动作，而选目标那次 aiRng 无论排队还是同步都只掷一次。
    ⚠ 但**语义差别是真的**：同一回合里排在它前面的攻击若打死了某只怪，入队写法在选目标时
    会把那只排除掉。要区分得让「保护」与「一条会杀死同伴的排队动作」在同一批里共存
    ——地精帮里玩家的伤害是自己那一侧排的，跨不到怪物阶段。
  - **狂暴 / 肥胖地精的 `no_op_roll` → `roll` 分不出来（各 0 例）。** 与第十三批尖刺史莱姆小
    那条**同源**：两者都掷一次 `aiRng.random(99)`，而这两只怪的 `getMoveForRoll` 恒返回
    同一招，唯一的差别是 `moveHistory` 会不会推进——而它俩没有第二招可比。
    ⚠ 反方向（改成 `none`）**有背书**（222 / 192 例），所以「要掷一次」验证到了，
    没验证到的只是「掷完不写历史」。这条永远关不掉，除非给它们加第二招（不可能）。
  - **保护 / 蓄力的 `intent` 算不算攻击分不出来（各 0 例）。** 与第十四/十五/十六批同族：
    `isMonsterAttacking` 当前**唯一的读者是觅敌之弱**，而 variant 0 那副 21 张牌组里没有它。
    白名单已逐条复核（`MonsterMoves.h:454/462/472/493/496` 五条攻击招在里面，
    `SHIELD_GREMLIN_PROTECT` / `GREMLIN_WIZARD_CHARGING` 不在），只是没人守着。
    ⚠ 这两条比前几批的同族更值得记：它们是**第一次**出现「完全不带伤害的招式」，
    而白名单里恰恰有 `SPHERIC_GUARDIAN_HARDEN` 那种带伤害却算攻击的反例——
    「按带不带伤害推 intent」这条捷径在这里看着能用，其实只是碰巧。
  - ⚠ **巫师大招的 `miscInfo = 0` 只被 1 例钉住。** 不是没背书而是背书极薄：去掉它之后
    巫师第一次大招之后就永远蓄力（计数停在 3、`+1` 之后恒 ≥4），而 375 条里只有 1 条
    仗长到能看见第二轮大招。关门条件是**更长的仗**——地精帮四只小怪血量都很低，
    玩家往往三四回合就清场。等第二幕的地精编队（`GREMLIN_LEADER` / `GREMLIN_GANG` 变体）
    或给 harness 追加循环那一批。
  - ⚠ 两条**等价改写**（不是盲区，是量不出数字的那类）：
    ① 池抽 4 改成「先选完再建」（0 例）——`miscRng` 与 `monsterHpRng` 是**两条独立的流**，
    改交错顺序不影响任一条的取值序列。⚠ 与第十五批「先选后造」（红 375 例）不是一回事：
    那条改的是 hpRng 的**次数**；
    ② 蓄力阈值 `=== 3` 改成 `>= 3`（0 例）——因为大招那条会清零，计数永远不会超过 3。
    ③ 狂怒挪到格挡吸收**之后**（仍在 `attacked` 里，0 例）——中间那两句不读力量。
    真正有观察面的是「挪进 `damageUnblocked`」那条（30 例）。

- 第十六批新增的盲区，全部 ⁝：
  - **孢子云的 `addToTop` 改成 `addToBot` 分不出来（0 例）。** 参考写的是 `addToTop`
    （`Monster.cpp:301`），改成 `addToBot` 对拍全绿。原因是结构性的：死亡发生在
    `attackEnemy` / `damageEnemy` 里，那一刻队列里**通常什么都没有**（多段攻击是每段一条
    动作、上一条已经出队），所以「插队首」与「插队尾」落到同一个位置。
    要区分得让「怪物死掉」与「别的排队动作」同时存在——例如荆棘的 `addToTop` 反伤、
    或者一次 `DamageAllEnemy` 打死中间那只（`AttackAllEnemy` 是**一条**动作，
    循环在动作内部，仍分不出来）。等有「亡语 + 多条排队动作」的怪那一批。
  - **`Monster::die` 里「最后一只怪就 return」那道门分不出来（0 例）。** 去掉 `return`
    （即尸横遍野时也放孢子云）对拍全绿。原因很具体：那一刻 `outcome` 已经是
    `player_victory`，紧随其后的 `checkCombat` 会 `clearOnCombatVictory()` 把刚 `addToTop`
    的易伤动作清掉——**两处机制重复了**。要区分得有一个 `clearOnCombatVictory = false` 的
    死亡触发（参考里没有），或者一条不经过 `checkCombat` 的击杀路径。
    ⚠ **方向仍然照抄**：真实游戏里「打死最后一只真菌兽不吃易伤」是玩家能感知的行为，
    只是我们这套数据看不见它。
  - **真菌兽出招阈值的下方向（`60 → 59`）0 例。** 上方向（`60 → 61`）红 2 例，
    所以阈值本身不是完全没背书，但**只有一个方向、且只有 2 例**。
    根因是覆盖太薄：整份数据里真菌兽只执行了 51 次招式，`getMoveForRoll` 被调用的次数
    与之同量级，落在 roll=59 这一个具体值上的概率约 1%。
    ⚠ 关门条件很明确：装 `TWO_FUNGI_BEASTS`（两只真菌兽的编队，第一幕就有，但 harness 的
    `encounters` 列表里没有它）——那会让它的出招次数至少翻倍，同时还能救上面两条盲区。
  - **真菌兽成长的 `intent` 算不算攻击分不出来（0 例）。** 把 `fungi_grow` 的 intent 改成
    `attack` 全绿——与第十四/十五批同源：`isMonsterAttacking` 当前**唯一的读者是觅敌之弱**，
    而 variant 0 那副 21 张牌组里没有它。白名单已逐条复核（`MonsterMoves.h:455` 只有
    `FUNGI_BEAST_BITE`），只是没人守着。
  - ⚠ **复活的 `roll >= 50` 阈值只被 1 例钉住（50→51 红 1、50→49 红 0）。**
    这不是「没有背书」而是「背书极薄」，但要记清楚它薄到什么程度：本批的补丁把这一段从
    死代码变成活代码，代价就是这个数字。⚠ 而且**这 1 例只证明我们与参考一致，不证明与
    真实游戏一致**——参考写 50、真实游戏疑似 55，判定它需要的是真机 ground truth，
    不是更多 trace。已在参考侧的补丁注释里显式标注「UNVERIFIED」。

- 第十五批新增的盲区，全部 ⁜：
  - **缠绕的「封攻击牌」那道门本身零背书（0 例）。** 把 `cardCanUse` 里那一句整条去掉，
    对拍**全绿**。原因是结构性的、值得单独记住：**重放只照着已记录的动作走，所以
    「放宽一条限制」永远不会让重放分岔**——harness 从来不会在带缠绕时打攻击牌，
    我们不拦它也没人来打。同族的还有「选牌屏没关不受理」那三道门（第四批记的）。
    **反方向是有背书的**：把门放宽成「封住所有牌型」红 35 例，所以「只封攻击牌」
    这个**范围**验证到了，没验证到的只是「有这道门」。
  - **逃跑的收尾（`"looter/flee": "none"`）分不出来（0 例）。** 改成 `"roll"` 或
    `"no_op_roll"` 都全绿。实测原因很具体：16 次逃跑**全部**发生在场上只剩抢劫者一只的时候
    （harness 的策略专打最左侧的活怪，同伴总是先死），于是逃跑当场判胜、
    `doMonsterTurn` 那句「结局已定就直接返回」抢在收尾之前。要区分得让抢劫者在
    **同伴还活着**的时候逃跑——`exordium_thugs` 结构性做不到，等第二幕的
    `masked_bandits` / `two_thieves`（两只劫匪 + 抢劫者）那批。
  - **逃跑改成 `addToBot` 分不出来（0 例）。** 与第十四批「分裂改成 addToBot」同源：
    逃跑之后 `MOVE_TURN_END` 是 `"none"`（不再排任何动作），两种写法的终态相同、
    中间又没有快照点。
  - **偷金的 `min(玩家金币, 额度)` 钳制分不出来（0 例）。** 去掉整个 `Math.min` 全绿。
    实测原因：抢劫者的招式链最多让它偷 3 次（抢劫 ×2 + 抢劫/猛扑），
    **全部 375 条 `exordium_thugs` 里偷得最狠的一场也才 -45**，离 99 的地板还有一倍余量。
    ⚠ 连带的后果是 **`HARNESS_GOLD_BASELINE` 只能防「偏小」不能防「偏大」**：常数比真值小
    会让钳制提前生效、当场红（`sts-combat-trace.test.ts` 里还有一条更直白的断言守着），
    比真值大则数据里根本没有能发现它的信息。要闭掉这条得等一只能把玩家偷穷的怪
    （劫匪 15/场 ×N、或第三幕的 `Transient`）。
  - **偷金改成入队、以及「偷金排在攻击之前」分不出来（各 0 例）。** 参考是裸调用且排在
    `attackPlayerHelper` 之前，但同一条 case 里没有任何东西**读**金币，
    两种写法与两种顺序的终态都相同。同族的是第十三批那条「怪物给玩家上减益是
    `addToBot` 还是同步」。
  - **缠绕的清除改成同步（不入队）分不出来（0 例）。** 与暴怒那条同族：
    `applyEndOfTurnPowers` 之后到下一个快照点之间没有东西读缠绕。
  - **对白那次 `randomBoolean` 的概率 0.6 分不出来（0 例）。** 结果被完全丢弃，
    只有「掷了一次」影响计数器（那一条红 391 例）。与第四批那两条「白吃的 RNG 的 bound」
    同族——次数可验证、bound 只能靠肉眼对齐参考。
  - **烟雾弹的加格挡从同步 `addBlock` 改成 `addToBot` 分不出来（0 例）。** 参考在怪物侧
    两种写法并存（同步 20 余处、入队 6 处），我们照抄成 `sync: true`；但这条 case 里
    加格挡之后只剩一句 `setMove`，中间没有第三条动作。要区分得让「加格挡」与
    「读格挡的东西」之间插进别的（例如荆棘的 `addToTop` 反伤）。
  - **烟雾弹 / 逃跑的 `intent` 算不算攻击分不出来（0 例）。** 把烟雾弹的 `intent` 改成
    `attack` 全绿——与第十四批分裂那条同源：`isMonsterAttacking` 当前**唯一的读者是
    觅敌之弱**，而 variant 0 那副 21 张牌组里没有它。白名单已逐条复核过
    （`MonsterMoves.h:428/470/484`，三条非攻击招式都不在里面），只是没人守着。

- 第十四批新增的盲区，全部 ⁂⁑：
  - **`overwriteMove` 与 `setMove` 分不出来（0 例）。** 参考在 `onHpLost` 里写的是裸的
    `moveHistory[0] = X_SPLIT`（不前移历史），换成 `setMove` 对拍**全绿**——因为母体在
    下一个怪物阶段就被两只新怪顶替，它的 `moveHistory[1]` 再也没人读。
    **方向仍然照抄**（参考就是这么写的），等守卫者（第十九批，同一个 switch 里用的却是
    `setMove`）或别的「改写意图之后还要继续出招」的怪登记时才可能可观察。
  - **分裂改成 `addToBot` 分不出来（0 例）。** 参考的 case 是裸调用、不是入队；改成入队
    对拍全绿。原因：分裂之后 `MOVE_TURN_END` 是 `"none"`（不再排任何动作），主循环下一轮
    先抽动作队列、再判怪物回合，两种写法的**终态完全相同**，中间又没有任何快照点。
    要区分得让分裂与「读怪数 / 读游标的东西」之间插进第三条动作。
  - **分裂多推进一格游标分不出来（0 例）。** `monsterTurnIdx += 2` 也全绿——`large_slime`
    场上只有母体一只，推进 2 格与 3 格都同样越界。等史莱姆王那批（场上有 3 格）才可观察。
  - **新怪继承母体格挡分不出来（0 例）。** 母体在分裂那一刻格挡恒为 0：怪物阶段开头
    `applyPreTurnLogic` 已经清过，而两只 L 都没有加格挡的招式。
  - **分裂意图算不算攻击分不出来（0 例）。** 把 `split` 的 `intent` 改成 `attack` 全绿——
    `isMonsterAttacking` 当前**唯一的读者是觅敌之弱**，而 variant 0 那副 21 张牌组里没有它。
    白名单已逐条复核过（`MonsterMoves.h:416`，两条 SPLIT 都不在），只是没人守着。
  - **`onHpLost` 的「被打死就不跑」那道门分不出来（0 例）。** 把它挪到 `die` 之前（即尸体
    也会被改成分裂意图）全绿。实测原因很具体：375 条里 L 号真的死了的只有 **8** 条，
    而**这 8 条里它的意图已经全是 SPLIT**——要杀死 L 就得先把它打到半血，那一击已经把
    意图改成分裂了。所以这道门在 `large_slime` 上结构性不可达。
  - ⚠ 两条**等价改写**（不是盲区，是量不出数字的那类）：阈值 `Math.trunc(maxHp/2)` 去掉取整
    （整数 hp 下 `hp <= 32.5` ⟺ `hp <= 32`）、以及「已经是 split 就不再改写」
    （`overwriteMove` 本身幂等）。两条都全绿，但它们改的是写法不是语义。

- 第十三批新增的盲区，全部 ⁑：
  - ~~**黏液（`slimed`）整条登记零背书。**~~ **第十四批已关闭**（`large_slime` 打出 46 次，
    三个变异各红 36 例，见上）。下面是当初的记录，留作「换编队救盲区」的判例。
    实测：`small_slimes` 里它在**弃牌堆**出现 426 帧、
    **手牌 0 帧**、消耗堆 0 帧；`lots_of_slimes` 里压根不出现（那五只小号史莱姆都不塞牌）。
    于是 `CARD_RULES.slimed` 与 `cost: 1` 都没有任何 trace 走到：把 `cost` 改成 5 → **0 例**，
    把 `CARD_RULES.slimed` 整条删掉 → **0 例**。
    - 为什么进不了手牌：史莱姆的仗只有 3~5 回合（`small_slimes` 最长 3、`lots_of_slimes`
      最长 5），21 张牌组的抽牌堆一次都没洗回来过——与第五批灼伤那条**同源**
      （灼伤当时也是「弃牌堆 296 帧 / 手牌 0 帧」）。
    - **但这一次没有逃生口**：灼伤靠新开 variant 3/4 救回来了，而这两个编队走的是
      `ENC_V0`（只留 variant 0），新 variant 的行按定义会被裁掉。
      ⚠ **事后订正：逃生口是有的，只是不在 variant 那一维——换个编队就行。**
      第十四批的 `large_slime` 用的还是同一副 21 张牌组、同样只留 variant 0，
      仗打得久就把黏液送进手牌了。以后遇到同类盲区，先想「哪个还没装的编队能救它」。
    - **仍然登记它的理由**：harness 的 `isReplayableCard` 默认放行任何牌，而黏液是唯一
      不需要医疗包就能打出的状态牌，所以任何一场**够长**的史莱姆战斗都会让策略打出它。
      第十四批（`large_slime`，64~70 血）与第十九批（`slime_boss`，140 血 + 分裂）必然更长，
      **那两批必须重量这三个数字**；在此之前，黏液的三条属性只有参考源码的直读依据：
      费用 `getEnergyCost` 的 `default: return 1`、消耗 `Cards.h:613`、
      可打出 `CardInstance.cpp:329` 的 `id != SLIMED`。
    - **「以后会有背书」不是推测，已经量过了。** 在全部 20 个编队的 variant 0 数据上数
      黏液**被打出**的次数：`slime_boss` **1456** 次、`large_slime` **46** 次、
      `exordium_wildlife` 6 次、`exordium_thugs` 3 次，而 `small_slimes` / `lots_of_slimes`
      是 **0**。所以留着这条登记是对的——第十四批装 `large_slime` 时它就有背书了，
      不必先删再加。**第十四批的验收项里必须有「黏液那三个变异重量一遍」。**
    - ⚠ 它一度进不了 `check-coverage.mjs` 的必需卡列表：那个检查同时要求「未升级」与
      「已升级」两栏非 0，而状态牌 `canUpgrade` 恒假。**工具缺口已补**：新增
      `--no-upgrade` 参数段，只要求未升级那栏。现在
      `check-coverage.mjs <dir> --no-upgrade SLIMED` 会如实以退出码 1 报「零覆盖」，
      第十四批装完 `large_slime` 之后它应该转绿——**这就是这条盲区的关门条件**。
      **已转绿**：第十四批的 `--install` 覆盖表里 `SLIMED 46 / 0`，`零覆盖（无升级形态的卡）: 无`。
  - **尖刺史莱姆小的 `no_op_roll` 与 `roll` 分不出来（0 例）。** 把 `NoOpRollMove` 换成
    普通 `RollMove` 对拍**全绿**——两者都掷一次 `aiRng.random(99)`，而这只怪的
    `getMoveForRoll` 恒返回同一招，唯一的差别是 `moveHistory` 会不会推进，而
    `moveHistory` 不在快照里。**方向仍然是有背书的**：换成同步 `setMove`（少掷一次 aiRng）
    红 289 例，所以「要消耗一次 aiRng」这件事验证到了，没验证到的只是「不写 moveHistory」。
    等某只用 `NoOpRollMove` 且**招式不止一个**的怪登记时会自然可观察
    （球状守卫的 `SPHERIC_GUARDIAN_ATTACK_DEBUFF` 就是）。
  - **怪物给玩家上减益是 `addToBot` 还是同步，分不出来（0 例）。** 这是**从第一批就在**的
    转写点（绿虱吐丝、酸液史莱姆舔舐、尖刺史莱姆舔舐都走它），本批第一次量它——
    改成同步对拍全绿。原因：怪物出招排的那几条动作之间没有任何东西会读减益层数，
    而下一只怪的伤害是在**它自己的 takeTurn** 里算的、那时队列已经抽干。
    要区分得让「减益」与「读减益的东西」之间插进第三条动作（例如荆棘的 `addToTop` 反伤，
    或同一招里先攻击后减益）。同族的**加格挡**那条是有背书的（颚虫的乱抓）。
    ⚠ 参考确实是 `addToBot(Actions::DebuffPlayer<...>)`，照抄没错，只是没人守着。

- **`drawToHandAction` 的「候选恰好 1 张就不开屏」捷径**（`count === 1`，‡0 例）。
  旧布局里第四批那副 32 张牌组能走到（20 例）；73/85 张牌组的抽牌堆几乎永远有 ≥2 张技能/攻击，
  于是 `count === 1` 不可达。第五批新加的 23 张聚焦牌组**也没救回它**——那副牌组里
  秘密技巧/武器压根不在。同族的军备 / 焚誓 / 头槌三条捷径仍有背书（12 / 7 / 43）。
- `applyEndOfTurnPowers` 里燃烧的 `bc.monstersAlive > 0` 门槛（‡0 例）。
  原因大概是怪在玩家回合内被打光就直接判胜、走不到回合末结算，这个分支近乎不可达。
  照参考写着是对的，但没有东西守着它。
- **`exhumeAction` 的「手牌满就整个跳过」**（‡0 例）。要在掘尸结算那一刻正好 10 张手牌。
  （同族的 `moveToHandHelper` 那条这一批已经被覆盖到了。）
- `upgradedExhausts` / `upgradedTargeted` 的升级覆盖分支（去掉后 0 例失败）——
  目前没有已登记卡牌会因此改变可观测状态，靠 `data-tables.test.ts` 的单测守着
  （变异后分别红 2 例和 1 例）。等 `limit_break` 之外更多带升级态差异的牌登记后会自然覆盖。
- **那两次「白吃的 RNG」的 bound 本质上不可验证**：`WarcryAction` 的 `random(1)` 与
  `DrawToHandAction` 的 `random(count - 1)` 结果都被丢掉，只有**调用次数**影响 counter。
  把 bound 改成任何别的数都是 0 例失败。次数已经验证到了（368 / 5 例），bound 只能靠肉眼对齐参考。
- **`canUpgradeCard` 的灼热之刃例外**（0 例）。结构上不可达：灼热之刃还没登记。
- **`playCard` / `endTurn` / `drinkPotion` 的「选牌屏没关不受理」三道门**（各 0 例）——
  harness 永远不会在屏开着时打牌，所以 trace 看不到它们。改由
  `sts-combat-wiring.test.ts` 的「屏没关之前都被拒」守着。
- **`playCard` 的「状态牌/诅咒牌打不出来」两道门**（‡0 例）——同理，harness 只走
  `isValidAction` 挑出来的合法动作，永远不会去打一张伤口。改由
  `sts-combat-rules.test.ts` 的「状态牌打不出来」守着。
- **固有归位里几处顺序/时点**（‡各 0 例），照参考写着是对的但无人守：
  - `innateCount > cardDrawPerTurn` 的补抽差额——trace 牌组只有 2~3 张固有牌。
    改由 `sts-combat-rules.test.ts` 的「固有牌多于起手数时补抽差额」守着。
  - 实例级 `innate`（瓶装遗物）——harness 不会瓶装任何牌。改由
    `sts-combat-wiring.test.ts` 的「固有牌开局归位」守着。
  - 心灵冲击的张数在**打牌时**取而非动作执行时取——两者之间抽牌堆不会变。
- **几处「顺序其实无关」的照抄点**（‡各 0 例）。它们在当前内容下**语义等价**，
  不是抄错了没被发现，而是这一版内容里观察不到差别；等相关内容登记后会自然变得可观察：
  - 黑暗拥抱与无痛之心两条消耗触发对调（抽牌与加格挡互不影响；除非将来有第三条触发插进去）
  - 消耗触发排在「压入消耗堆」之后（压栈不影响读到的层数）
  - 强行突破「先塞伤口后加格挡」对调（★仍 0 例。主宰登记之后**理论上**可观察了——加格挡
    会掷 `cardRandomRng` 选目标——但要求同一回合同时有主宰在场且伤口进弃牌堆改变后续，
    当前数据里没撞上）
  - 暴虐排到恶魔形态之后（★仍 0 例。力量不影响抽到哪张牌）。
    ⚠ 同族的**暴虐「先失血后抽牌」对调已经不再是盲区**：第七批的暴虐补丁让它从 0 例变成
    **2 例**——失血现在会加力量，于是「先抽后失血」与「先失血后抽」在少数 trace 上分岔。
    很薄，但有背书了
  - **应急按钮「先加格挡后上 NO_BLOCK」对调**（★0 例）——格挡在**打牌时**就过
    `calculateCardBlock` 算好了，两条动作的先后不影响它
  - **火焰屏障「先加格挡后上 Power」对调**（★0 例）——同理
  - 进化的补抽改 `addToTop`
  - 灼伤伤害的 `addToTop` 改 `addToBot`、多张灼伤入队改 `pushFront`（trace 里没出现过
    同一回合手里两张灼伤）
- **`discardAtEndOfTurnHelper` 的「结局已定就跳过」**（‡0 例）。要让以太牌的消耗刚好
  打死最后一只怪（消耗本身不造成伤害，得靠卡戎的骨灰那类遗物），现有内容做不到。
- **三牌堆全空判负**（`executeActions` 的 can't-win check，0 例）。要把抽/弃/手三堆全清空，
  现有牌组做不到（状态牌只会让它更难命中）。照参考写着是对的（`BattleContext.cpp:767`），
  但没有东西守着它。
- **`chooseExhaustCards` 的空选择提前返回**——那是等价的死代码（空数组的循环本就什么都不做），
  不算盲区。
- 第六批（玩家事件钩子）新增的盲区，全部 ★：
  - **哨兵的回能量是「同步」还是「入队」（0 例）。** 这一条格外要留意：参考自己在那行注了
    `// the game adds to bot here`，即**真实游戏是入队的**，参考图省事写了同步。我们照参考
    写了同步，而数据分不出两者——把它改成 `addToBot` 对拍照样全绿。要区分得让「消耗哨兵
    与紧随其后的某个读能量的动作」之间夹进别的东西，当前内容做不到。
    第五批那版布局上这条还有 2 例，93 张牌组下退化成 0。
  - **灼伤的自伤会不会触发破裂（0 例）。** 参考写的是 `DamagePlayer(2, **true**)`，我们照抄；
    但灼伤只在 variant 3/4 那副 23 张聚焦牌组里真正进过手牌，而破裂只在 variant 1/2 的
    全牌组里——两者结构上碰不到面。其余 6 个失血来源的 `selfDamage` 都验证到了（6~35 例）。
  - **烈焰吐息的诅咒牌分支（0 例）**：任何 variant 的牌组里都没有诅咒牌，结构上不可达。
    状态牌分支有背书（5 例）。
  - **烈焰吐息与进化在状态牌分支上的先后（0 例）**：一个入队抽牌、一个入队全体伤害，
    当前内容下互不影响。
  - **火焰屏障与荆棘两条反伤的推入顺序（0 例）**：要同时有青铜鳞片（荆棘）和火焰屏障，
    还要那两下伤害之间的顺序改变结果（比如先打死怪）。当前遗物轮换撞不上。
  - **主宰 / 火焰屏障的伤害走 `Monster::damage` 而非 `attacked`（各 0 例）**：区别只在
    蜷缩那条 `onAttacked` 链，而蜷缩只有虱子有、且一场只触发一次，实际总是已经用掉了。
  - **主宰的 `DamageRandomEnemy` 是 `clearOnCombatVictory=true`（0 例）**：要让主宰的伤害
    自己成为「胜利之后还排着的动作」，现有内容撞不上。
  - **主宰 `damageRandomEnemy` 顶部的 `monstersAlive === 0` 提前返回（0 例，且本质不可验证）**：
    去掉它之后 `getRandomMonsterIdx` 在无怪时返回 0 且**同样不掷 RNG**，`monsterDamage`
    对死怪又是提前返回——两条路径可观察行为完全相同。留着是为了与参考的 `-1` 分支形状一致。
- 第七批（卡牌实例级状态）新增的盲区，全部 §：
  - ~~**`cardsResetAttributesAtEndOfTurn` 整条**~~ **第八批已消除**（¶101）。当时的判断
    「等『本回合免费』登记后会自然可观察」是对的：地狱之刃 / 发现给的牌 `costForTurn=0`
    而 `cost>0`，回合末复位就有活干了。
  - ~~**`playCard` 读 `costForTurn` 而不是 `cost`**~~ **第八批已消除**（¶914），同一个根。
  - **`updateCardCost` 的 `max(0, …)` 下限与「值没变就整个不动」的 if（各 0 例）。**
    血债血偿的 `cost` 掉到 0 之后再降，去掉这两道也只让 `cost` 变成负数，而
    `costForTurn` 仍被另一个 `max(0, …)` 夹住——可观察行为完全相同。
  - **`setCostForTurn` 的 `costForTurn >= 0` 门（§0，¶仍 0，∬仍 0）。** 只有 X 费牌（-1）与
    打不出的状态/诅咒牌（-2）会命中它。第十批把 X 费牌登记了、还让它与腐化同场
    （variants 13/14），**仍然 0 例**——原因见下方第十批那一节：-1 与 0 在后续五道门上
    表现完全相同。
    同源的 **`initialCardCost` 的 -2 哨兵改成 0 也是 0 例**：状态牌既不是技能牌
    （腐化不碰）、又在 `playCard` 里先被牌型挡掉，费用数值无人读。
  - **腐化的 `moveToHandHelper` 进牌钩子** —— **第八批已消除**（§0 → ¶24）。当时写的
    「真实游戏里它是给腐化之后凭空造出来的技能牌准备的」正是多面手：它把无色池里
    `cost >= 1` 的技能（复苏 / 炸弹 / 蜕变 / 变形 / 发现 …）原价塞进手牌。
    **`drawOneCard` 那条仍是 0 例**：被钩住的牌 `costForTurn` 一进手就成了 0、于是当回合
    就被策略打掉，几乎不会活到进弃牌堆再被抽回来。
    传的 **-9 这个具体数值本质不可验证**（`setCostForTurn` 会夹成 0，改成 0 是 0 例）。
  - **`onBuffCorruption` 扫消耗堆那一支（0 例）。** 要求腐化落地时消耗堆里正好有一张
    `cost > 0` 的技能牌，**而且**它后来还能回到手上（掘尸）才看得出来。
    同理 **`cardsOnTookDamage` 不扫消耗堆（0 例）**：血债血偿基本进不了消耗堆。
  - **疯狂的 `haveNonZeroTurnCost` / `haveNonZeroCost` 两个判据分支（各 0 例）**，
    包括预扫描里那个 `break`、以及两条判断的先后。根还是「两个字段不分岔」：
    要走到 `cost > 0` 那一支，得让**整只手牌**的 `costForTurn` 都是 0 而其中一张的
    `cost > 0`——只有「腐化在场 + 事后升级过的技能」能造出这种牌，太窄。
  - **虚无缥缈的钳制是 `min(damage, 1)` 而不是无条件置 1（0 例）。**
    要求怪物那一击算出来不足 1 点（虚弱把 1 压成 0.75 那种），当前编队的招式伤害都够大。
  - **虚无缥缈的递减放在回合末还是下回合开始（0 例，本质等价）。**
    两处都在 `afterMonsterTurns` 里、中间没有任何东西读它，把整条从
    `applyEndOfRoundPowers` 挪到 `applyStartOfTurnPowers` 对拍全绿。
    「必须递减且一回合只递减一层」是有背书的（删掉 696、多加一次 76）。
  - **`useCard` 扣能量的 `!(腐化 && 技能牌)` 子句仍然只有 2 例。** 第八批没能加厚它：
    要走到那一支，得让一张技能牌在腐化在场时 `costForTurn > 0`，唯一造法是「腐化之后
    在战斗内升级一张升级前后费用不同的技能」——那需要军备 + 坚毅同场，而第八批的
    18 张牌组里两张都没有（加进去会把牌组撑大、稀释本批自己的覆盖）。仍靠 variant 5/6。
  - **血债血偿升级时的 `upgradeBaseCost` 分支（0 例，且是参考自己写死的死代码）。**
    `CardInstance::upgrade` 里先按当前费用 -1，紧接着尾部又无条件把
    `cost = costForTurn = getEnergyCost(BFB, true) = 3` 盖掉（未升级是 4，两者必不相等）。
    参考自己在那行标了 `// TODO(dmz) is this logic right?`。我们照抄了，含它无效这件事。
  - **`specialData` 是逐实例而非逐定义（trace 0 例）。** variant 5/6 里暴走与灼热之刃各只有
    一张，trace 分不出「记在实例上」和「记在定义上」。改由
    `sts-combat-wiring.test.ts` 的「卡牌实例级状态跟着存档往返」守着（10 张暴走的牌组，
    断言每张打出过的暴走各自是 +5 而不是累加）。
- 第八批（随机卡池取牌）新增的盲区，全部 ¶：
  - **`chooseDiscoveryCard` 的「手牌满就改进弃牌堆」那一支（0 例，且结构上不可达）。**
    发现自己是从手牌里打出去的，`useCard` 在动作入队**之前**就把它移出了手牌，所以
    `DiscoveryAction` 执行时手牌最多 9 张，`9 + 1 <= 10` 恒成立。真正能命中它的是
    带 2 份的「发现」类药水（攻击/技能/能力药水 + 圣桦皮），三者都未登记。
  - **`chooseDiscoveryCard` 里的腐化子句（0 例，且是等价死代码）。** 上一行刚
    `setCostForTurn(c, 0)`，腐化那句 `setCostForTurn(c, -9)` 落地同样是 0
    （`max(0, -9)`）；X 费牌两条都被 `costForTurn >= 0` 门挡掉。语义上完全等价，
    照抄是为了与参考同形。同理**把 `createTempCardInHand` 换成 `moveToHandHelper` 也是 0 例**
    ——两者的差别只有那条腐化子句和手牌满判断，而两者在这条路径上都不可观察。
  - **地狱之刃的 `addToTop`（改 `addToBot` 0 例）。** 它与 `OnAfterCardUsed` 之间没有任何
    东西读手牌，而地狱之刃自己在 `useCard` 里就已经离开手牌了，两种顺序结果相同。
    要区分得让「造牌」与「本卡进消耗堆」之间夹进别的读手牌的动作。
    同理 **`makeTempCardInstanceInHand` 走不走 `moveToHandHelper`（0 例）**：
    要手牌正好 10 张才看得出差别。
  - **`cardInstanceProto` 把 uid 推迟到 `MakeTempCardInHand` 才取（0 例，trace 看不到 uid）。**
    多面手升级后两条 `addToTop` 是后推的先执行，于是**第二张抽到的牌 uid 反而更小**；
    trace 的快照只记牌名，分不出来。照参考的时点写着是对的，但没有东西守着它。
- 第九批（出牌队列嵌套）新增的盲区，全部 ∮：
  - **浩劫 / 混乱的目标在「打牌时」还是「动作执行时」掷（各 0 例）。** 参考在打牌那一刻就
    `getRandomMonsterIdx(cardRandomRng)`、把结果捕进 `Actions::PlayTopCard`；推迟到动作里掷
    对拍照样全绿。**次数**两边一样，只有它与别的 `cardRandomRng` 消耗点的**相对顺序**会变，
    而这一对 variant 的牌组里没有别的消耗点排在中间（主宰/枯枝那类都不在）。
    与「白吃的 RNG bound」不同族：那个是结果被丢弃，这个是顺序碰不到。
  - **`queuePurgeCard` 的「按值拷贝」（0 例）。** 二连击复制项里那张牌的改写不该落到原牌上，
    而唯一能观察到差别的是「同一张实例被二连击之后**再打一次**」——量过了：本批数据里
    暴走被二连击 **25 次**，其中**同一条 trace 里之后再打一次暴走的有 0 次**。根还是战斗长度
    （被二连击的暴走那两下伤害往往直接结束战斗），与第六批烈焰吐息那条同源。
    ⚠ 别指望靠「多加几张暴走」救——限制因素是一张实例能不能转回来，不是牌组里有几张。
  - **`addPurgeCardToCardQueue` 的 `size > 0` 分支（0 例，且结构上不可达）。** 它要求
    「一张攻击牌 useCard 的那一刻出牌队列还非空」。唯一能同时放两项进出牌队列的是混乱
    叠到 2 层（本批数据里 MAYHEM≥2 出现了 **223 帧**，所以那一半是达成的），但二连击的层数
    在**回合末被清空**，于是回合开始那两张牌打出时 DOUBLE_TAP 恒为 0。要命中得让混乱叠到
    **3** 层、且队列里第一张恰好是二连击、第二张恰好是攻击牌。留着与参考同形。
  - **`useCard` 尾部 `if (purgeOnUse) return` 的两个后果各自不可观察（0 例）。**
    复制项的 uid 与原牌相同、而原牌早已离开手牌，所以「摘手牌」是空操作；扣能量那条又被
    同一项里的 `autoplay = true` 挡住。两条合起来与参考等价，但去掉这道提前返回对拍全绿。
  - ~~**扣能量读 `card.costForTurn` 还是 `item.energyOnUse`（0 例）**~~ **第十批已消除**
    （∬7666）。当时的判断「等 X 费牌登记后会变得可观察」是对的，只是当时 `playCard` 填的
    `energyOnUse` 本身就是抄错的（填了 `costForTurn`，参考填的是 `player.energy`），
    第十批一并订正。
  - ~~**`playTopCardInDrawPile` 把 `energyOnUse` 设成「当前全部能量」（0 例）**~~
    **第十批已消除**（∬20）：浩劫 / 混乱打出的旋风斩按满能量打。
  - **`chooseDualWieldCard` 给选中的牌换新 uid（0 例，且 trace 结构上看不到）。**
    快照只记牌名，而 uid 除了推进计数器之外不影响任何可观测状态。参考自注这正是
    「双持仪式匕首」那个 bug 的来源，照抄，但没有东西守着它。
  - **二连击的回合末清除是「入队」还是「同步」（0 例）**，以及**它与怒火在
    `onUseAttackCard` 里的先后（0 例）**。前者中间没有任何东西读 DOUBLE_TAP；
    后者的两条一个进出牌队列、一个进动作队列，互不影响，而且这一对 variant 里没有怒火。
- 第十批（X 费）新增的盲区，全部 ∬：
  - **旋风斩 / 嬗变把 `energyOnUse` 往下夹的那句（各 0 例）。** 要求「入队之后、结算之前」
    能量**变少**。普通打牌时出牌队列与动作队列都是空的，两者之间什么都插不进去；
    浩劫 / 混乱打出的牌带 `autoplay`，`useCard` 那条扣能量的路本就不走；二连击的复制项
    自己带 `ignoreEnergyTotal` 绕过这句。结构上不可达。
    ⚠ 反过来「去掉 `ignoreEnergyTotal` 这个标志」**有** 11 例背书——即「夹这一下会不会
    发生」有预言机，「夹的结果对不对」没有。
  - **嬗变多出来的那句「往上抬」（`player.energy > item.energyOnUse`，0 例），
    以及「旋风斩没有这一句」（给它补上同样 0 例）。** 这一条的根是**布局被迫的**：
    要让能量在「入队之后、结算之前」变多，唯一的造法是混乱叠到 2 层
    （同一回合排两条 PlayTopCard），第一条弹出的牌**后**执行、第二条弹出的牌**先**执行，
    而先执行的那张恰好是放血（+2 能量）。variants 11/12 里 MAYHEM≥2 出现了 **262 帧**
    （其中 114 帧抽牌堆里还有放血），所以「叠到 2 层」这一半是达成的，但那个精确的
    弹出顺序没撞上。而**嬗变自己压根不能与混乱同处一副牌组**（见上方布局一节：
    混乱会把嬗变造出来的未登记牌打出去，trace 不可重放），所以嬗变那句在**结构上**
    没有预言机，不只是没撞上。等无色池那 9 张未登记的牌补齐之后才能真正量它。
  - **X 费的 -1 哨兵改成 0 也是 0 例。** 与第七批记下的 -2 哨兵同族：`canUse` 的
    `energy < costForTurn`、`useCard` 的 `costForTurn > 0`、`setCostForTurn` 的
    `costForTurn >= 0`、`onBuffCorruption` / 疯狂的 `cost > 0` —— 五道门在 -1 与 0 上
    表现完全相同。照参考写着是对的（那是 `getEnergyCost` 的原文），但没有东西守着它。
    同源的 **`setCostForTurn` 的 `costForTurn >= 0` 门仍是 0 例**（§0 → ¶0 → ∬0）：
    本批终于让 X 费牌真的躺在手里、还与腐化同场（variants 13/14 有腐化），
    但腐化那句落地是 `max(0, -9) = 0`、回合末复位落地是 `max(0, -1) = 0`，
    两者与「维持 -1」在后续五道门上依然分不出来。
  - **伤害矩阵「算一次、X 轮共用」而不是每轮重算（0 例）。** 两者要分岔得让力量或易伤
    在两轮之间变化，而旋风斩的几轮之间没有任何东西改它们。同族的
    **递归改成一次性 `for` 循环也是 0 例**（`addToTop` 与同步在没有 onAttacked 链的情况下
    等价；蜷缩那类还没转写）。而**续轮 `addToTop` 改 `addToBot` 有 8 例**——
    区别不在攻击之间，而在于本卡的 `OnAfterCardUsed` 会插到中间去。
  - **`uint16` 上限 `min(65535, dmg)`（0 例，本质不可验证）。** 当前内容打不到 65535。
  - **伤害矩阵里那句 `m.alive ? … : 0`（0 例，等价死代码）。** `attackAllEnemiesWithMatrix`
    自己也判一次 alive，所以死怪那格是 0 还是别的值都读不到。
  - **嬗变的 `effectAmount === 0` 提前返回（0 例，等价死代码）。** X 为 0 时循环体不跑、
    `MakeTempCardsInHand([])` 是空操作，而 `useEnergy` 那句把已经是 0 的能量再清一次零。
    ⚠ 它的等价性**依赖那句「往上抬」存在**：有了它，`effectAmount === 0` 就蕴含
    「结算时能量确实是 0」。
  - **嬗变的 `MakeTempCardsInHand` 是 `addToBot` 还是同步（0 例）。** 它与 `useEnergy`
    之间没有任何东西读手牌或能量。
  - **神化扫消耗堆那一支（0 例）。** trace 的快照只记牌名、不记升级位，所以「消耗堆里的牌
    被升级了」除非它回到场上（掘尸 / 卡戎的骨灰）否则观察不到。
    同理**神化里那道 `canUpgrade` 判断（0 例）**：去掉它之后被多升的只有诅咒/状态牌，
    而它们升级前后的费用（-2）、虚无位、牌名全都不变。
    ⚠ `canUpgradeCard` 这个谓词**本身**是有背书的（第七批的军备那条 ‡2），
    只是神化这个调用点没有。
  - **神化不改 master deck（0 例）。** 战斗内的 trace 看不到 run 级牌组。
    照参考写着是对的（`ApotheosisAction` 只碰四个战斗牌堆）。
- 第十一批（四个小机制）新增的盲区，全部 ※：
  - **掘尸把牌带回战斗时那次 `notifyAddCardToCombat`（0 例）。** 这条是本批**唯一一个真 0**，
    而且是量出来的、不是猜的：variants 15/16 的 480 条 trace 里掘尸打出 78 次、真的从消耗堆
    捞回 38 张（其中 16 张是打击牌：`STRIKE_RED` 6 / `PERFECTED_STRIKE` 5 / `SWIFT_STRIKE` 4 /
    `WILD_STRIKE` 1），但「捞回一张打击牌**之后**又打出完美打击」只发生了 **1 次**，
    而那一次的伤害差没有改变可观测状态。根是两者**反相关**：掘尸要等消耗堆攒起来才不会走
    「消耗堆空就整个跳过」那条提前返回，而那时仗也快打完了。
    ⚠ 别指望靠「多加几张掘尸」救——限制因素是战斗长度，与第六批烈焰吐息、第九批
    `queuePurgeCard` 按值拷贝那两条同源。真要覆盖它，得有一副**又长又带完美打击**的牌组，
    而那与本批「炸弹要打不动人 / 完美打击要能打」的矛盾正好撞上（见布局一节）。
  - **「离场即减」只有 6 例，是本批最薄的一处**（不是 0，但记在这里因为它是本机制的核心）。
    量过两轮：第一版用恶魔之火当唯一的打击消耗源，只有 **2** 例——恶魔之火消耗**整只手牌**，
    把本该观察到计数下降的那张完美打击一起带走了（实测「完美打击在某张打击牌离场之后被打出」
    125 次里只有 15 次）。第二版换成坚毅（1 费、只消耗**一张**）后升到 6 例 / 17 次。
    连带 **「改成现扫手/抽/弃三堆」也只有 3 例**——那个变异同时抹掉了「在飞牌算在内」和
    「消耗掉的不算」两件事，能观察到的窗口与上面同一个。
  - **炸弹伤害 `up ? 50 : 40` 两边都薄（升级 3 例 / 未升级 9 例）。** 要观察到 40 与 50 的差别，
    炸弹得落在一只**两种数值都杀不死、或恰好一种能杀死**的怪身上；而它引爆时邪教徒往往
    已经被打得够低，两个值都是「一击必杀」。第一版只有 1 例，加了净化（把手牌里最左边的
    3(5) 张——正是那些起始打击——整个清出战斗）之后升到 3。
  - **两张炸弹叠加成一格（`bomb3 += amount`，1 例）与 `bomb3 = 0` 清零（3 例）。**
    两者都要求「同一回合打出两张炸弹」或「第一次引爆之后仗还没结束」，而第一次引爆
    （40/50 点全体）通常就是终局。
  - **`executeActions` 的「打不赢了」检查里那三格判断（0 例）。** 与它同族的
    「三牌堆全空判负」本来就是 0 例（见上方更早的条目）：净化 + 坚毅 + 自消耗的坚不可摧/
    幽灵护甲最多让 20 张里的 12 张离场，仍然没能让三堆同时归零。照参考写着是对的
    （`BattleContext.cpp:786-788`），但没有东西守着它。
  - **炸弹那段挪到燃烧之后（0 例，结构上不可达）。** 参考把它放在遍历 `statusMap` 的循环
    **之前**，而 variants 17/18 的牌组里压根没有任何一个会在回合末结算的 Power
    （没有灵活 / 战斗恍惚 / 二连击 / 燃烧 / 暴怒），所以没有东西可以与它错位。
  - **炸弹的 `if (bomb1)` 不带 `monstersAlive > 0`（0 例）。** 加上那道门（照燃烧那条写）
    对拍全绿——要区分得让「怪在玩家回合内被打光」与「回合末还有炸弹要炸」同时成立，
    而怪一死就直接判胜、走不到回合末结算。与第五批记下的燃烧 `monstersAlive > 0` 门同源。
  - **炸弹的 `BuffPlayer` 入队与同步不可区分（0 例）。** `addToBot(bomb3 += amount)` 改成
    当场加，对拍全绿：从入队到执行之间没有任何东西读这三格。
  - **贪婪之手的三处（各 0 例）**：顶部那道 `isDeadOrEscaped` 提前返回（去掉之后
    `monsterDamage` 自己也判一次死活，可观察行为相同）、尾部那次 `checkCombat`
    （它的作用是胜利时清扫队列，而这张牌之后没有别的排队动作要被清）、
    以及「伤害在**打牌时**算好而不是动作执行时算」（两者之间没有东西改力量/易伤）。
  - **`isStrikeCard` 里 `strike_blue` / `strike_green` / `strike_purple` 三项（结构上 0 例）。**
    我们的数据表里压根没有这三张牌（四个角色的起始打击共用一张 `strike`，见「待裁定」）。
    列着是为了将来真的拆成四份时这个谓词自动跟上。
  - **`canUseClash` 排不排除冲撞自己（0 例，等价变异，不算盲区）。** 冲撞自己就是攻击牌，
    加一句 `c.defId === "clash" ||` 与不加完全同义。参考扫的是整只手牌、不排除自己，照抄。
- 第十二批（怪物回合末触发 / 从抽牌堆随机检索）新增的盲区，全部 ⁂：
  - **凡是与「怪物身上的神器」有关的分支，一条都没有背书（各 0 例），而且是结构性的**：
    当前登记的四种怪（邪教徒 / 颚虫 / 红虱 / 绿虱）**没有一只有神器**，也没有任何已登记内容
    能给怪加神器（古代药水只给玩家）。
    ⚠⚠ **第十八批把这条盲区拆成了两半：前提没了，但那三条具体分支仍然是 0。**
    哨卫开局自带 `ARTIFACT: 1`（`preBattleAction`），于是**通用**的那一支
    ——`BattleContext::debuffEnemy` 的神器拦截——第一次有了真背书：
    去掉整条拦截红 **362**、拦截但不消耗层数红 **362**、吃掉减益后不 `return`（照样施加）
    红 **362**、开局不给神器红 **375**、层数 1→2 红 **375**。
    **所以「怪物神器结构性不可达」这句话本身已经不成立了**，本批之后它是可达的。
    ⚠ **但下面这三条仍然是 0 例**（第十八批实测复量过），原因换成了另一条：它们全都要
    **黑暗镣铐（或束缚）与带神器的怪同场**，而黑暗镣铐是第十二批的牌、只在 variants 1/2
    与 19/20 的牌组里，哨卫走的是 `ENC_V0`（**只留 variant 0 那副 21 张起始牌组**）。
    两者结构性碰不到面：
    - **黑暗镣铐那道 `if (!hasArtifact)` 整个去掉**（即无条件上 SHACKLED）→ **仍 0 例**。
      ⚠ 注意与上面那条 552 例的区别：把它**反过来**写（参考的 bug）是有背书的，因为那会
      从「永远上」翻成「永远不上」；而「永远上」与「没神器才上」在当前内容下仍然同义。
    - **黑暗镣铐的减力量走 `DebuffEnemy`（过神器）而不是 `BuffEnemy`（不过）** → **仍 0 例**。
    - **回合末归还力量走 `buff`（不过神器）而不是 `addDebuff`（过）** → **仍 0 例**。
    - ⚠ **新的关门条件（与旧的不同，写清楚免得下一个人白等）**：不再是「等一只带神器的怪」
      ——已经有了。要的是**让带神器的编队用上含黑暗镣铐的牌组**，而 `ENC_V0` 按定义裁掉
      variant 0 之后的行，聚焦 variant 这条逃生口在这里无效。可行的两条路：
      ① 把 `three_sentries` 的策略从 `variant0` 改成 `all`（整份保留，牌组含黑暗镣铐），
      代价约 +30MB 且它不再是「装完即冻结」；② 等 harness 追加循环、装上第二幕带神器的怪
      （书虫 / 时间守卫）时顺带换策略。**在此之前这三条继续记作盲区。**
  - **怪物回合末触发那个循环的位置（0 例，两个方向都是）。** 参考把它放在
    `BattleContext::applyEndOfRoundPowers` 的**第一个**怪物循环里，即玩家减益递减**之前**、
    仪式/虚弱/易伤那个循环**之前**。把它整个挪到玩家递减之后 → 0 例；挪到整个函数最末
    （仪式之后）→ 也 0 例。根是**加法可交换**：束缚归还 +9 与仪式 +3 落在同一个 `strength`
    字段上，先后不影响结果；而中间夹着的玩家减益递减压根不读怪物的力量。
    「这条触发**存在**」是有背书的（504 例），「它排在哪儿」没有。
    要区分得有一条在**同一个回合末**既读又写怪物力量的东西（比如怪物侧的
    `GENERIC_STRENGTH_UP` 与某个按力量算格挡的分支同场），当前内容做不到。
  - **黑暗镣铐两条动作的先后（0 例）**，以及 **SHACKLED 那条是入队还是同步（0 例）**。
    两条动作一条改 `strength`、一条改 `shackled`，互不相干；而从入队到执行之间没有任何东西
    读这两个字段（怪物出招的伤害是在**怪物回合开始**才算的，那时两条都已经落地）。
  - **`attackIdxList.empty()` 那条提前返回（0 例，但这是等价死代码、不算盲区）。**
    ⚠ 值得记下来的是**它是被那个 `break` 补丁变成死代码的**：列表为空时取牌循环第一轮的
    `attackIdxList.length - 0 <= 0` 立刻成立，`break` 出来之后 `moved` 是 0、移除循环不进，
    与直接 return 完全同义。补丁**之前**它不是死代码（那时那一支是 `return`，与提前返回
    的区别在于会不会跳过移除段）。照参考写着是对的，形状也该留着。
  - **暴力走 `cards.moveToHand` 而不是 `moveToHandHelper`（0 例，等价变异）。**
    两者的差别只有腐化那条「进手就压成 0 费」的钩子和手牌满判断，而**暴力只搬攻击牌**、
    腐化那句只碰技能牌，手牌满的判断两边又同义（`=== 10` vs `< 10` 取反）。
    改成走 `moveToHandHelper` 对拍全绿（含 variants 13/14 那副有腐化的牌组）。

**每批用当前全牌组替换 variant 1/2**（曾短暂改成「每批新开一对」，理由是错的，已改回）：
之前以为牌组卡在 64 张，于是第四批只能另开一对；实际上限是 96（见上），85 张的全牌组装得下。
选替换而不是追加的理由是**体积**：一对全牌组 variant 约 12MB，几批下来仓库就过 100MB。

替换的真实代价是**覆盖密度**——牌组越大，单张卡出现在某一手牌里的概率越低。这不是推断，
`--install` 打印的覆盖表就是量尺，第五批量过：63 张卡的两个分支全部非 0，最薄的
`BLUDGEON` 43/19、`SEVER_SOUL` 25/19、`UPPERCUT` 42/32，离 0 还很远。

代价确实存在，且已经**两次**表现成「某个边角分支不可达」而不是「某张卡没被打出」：
`drawToHandAction` 的「候选恰好 1 张」捷径（20 → 0 例），以及第五批的灼伤回合末自伤
（85 张下灼伤 0 次进手牌）。第一次选择了记为盲区；第二次用掉了这一节留的逃生口——
给第五批单开了一对 23 张的聚焦牌组（variant 3/4，见上方布局表），理由写的正是覆盖密度。
下次遇到同类情况：**先量**（覆盖表 + 该分支的变异例数），确认是全牌组导致的结构性不可达，
再考虑加聚焦变体；不要一上来就加，也不要写成内存上限。

### 我们自己的转写错误（各批修掉的）

参考项目的 bug 记在下面「已知偏离参考项目之处」；这里记**我们抄错**的地方——两者性质不同，
前者要打补丁再重生成，后者是我们改代码。

- **`drawCards` 的 reshuffle 少判了一次 shuffleRng**（第十一批修，`sts-combat.ts`）。
  原先写的是「弃牌堆非空才洗」，于是**「抽牌堆还剩几张、但弃牌堆是空的」这种局面白省了一次
  `shuffleRng`**。参考的 `Actions::EmptyDeckShuffle`（`Actions.cpp:181`）是
  `java::Random(bc.shuffleRng.randomLong())` 先取好再洗，**空弃牌堆同样消耗一次**；
  能免掉它的只有 `BattleContext::drawCards` 顶部那条「抽牌堆 + 弃牌堆都空」提前返回。
  顺手把整个函数按参考重写了一遍：抽不够时**不是**同步「抽干 → 洗回 → 补抽」，而是
  ① `addToTop(DrawCards(缺的))` ② `onShuffle()` ③ `addToTop(EmptyDeckShuffle())`
  ④ 抽牌堆非空时**同步**递归抽干它——①③ 都是 addToTop 且 ③ 后推，故执行顺序是「先洗后抽」。
  ⚠ 这个错从第一批就在，一直没被发现，因为它要求「抽牌堆非空、弃牌堆空、还想多抽」，
  而在此之前每副牌组都有足够的牌在循环。第十一批炸弹那副牌组（净化 + 坚毅把牌大量消耗掉）
  第一次走到它，对拍**红了 3 例**——是新数据抓出来的，不是变异测试。
  修完的背书见上方 ※ 那一节的最后一条。
- **`deal_damage_rolled` 的 `times` 字段从没被读过**（第二十批修，`sts-combat.ts`）。
  `takeTurn` 的伤害分支写的是 `const times = eff.kind === "deal_damage_multi" ? eff.times : 1;`
  ——`deal_damage_rolled` 也带 `times`，但只有 `deal_damage_multi` 那一支去读它。
  ⚠ **这个错从第一批就在，一直看不见**，原因同样是结构性的：在此之前唯一用
  `deal_damage_rolled` 的是**虱子的咬击**，而它是单段攻击、数据表里根本没写 `times`，
  于是「省略即 1」恰好等于正确行为。六火幽魂的六重打击（`attackPlayerHelper(bc, miscInfo, 6)`）
  是第一个带 `times` 的，一装数据当场红 **375 例**（整个文件）——**是新数据抓出来的，
  不是变异测试**，与第十一批 `drawCards` 那条同一类。修法是把判据改成
  「只有 `deal_damage` 恒 1，其余读 `eff.times ?? 1`」。
- **`playCard` 的 `energyOnUse` 填了 `card.costForTurn` 而非 `player.energy`**（第十批修）。
  详见上方「X 费」那一节。同样是「在此之前无人读它」，所以潜伏了两批。
- **怪物攻击的 `clearOnCombatVictory` 抄成了默认的 `true`，参考是 `false`**（第十九批修）。
  `Actions::AttackPlayer` 那行是 `return {[=](BattleContext &bc){...}, false};`
  （`Actions.cpp:85-88`，第二个参数就是这一位），我们此前走的是 `addToBot` 的默认值。
  ⚠ **这个错从第一批就在，一直看不见**，原因是结构性的：单段攻击排的那一条 AttackPlayer
  **恒是它自己那组动作里的第一个**，永远轮不到「胜利之后被清扫」。
  第十九批的守卫者第一次带来多段攻击（旋风 4 段、双重猛击 2 段），第一段触发荆棘 /
  火焰屏障、反伤打死了怪 → `checkCombat` 清扫队列 → 剩下几段该不该落在玩家身上，
  这一位当场可观察。**实测红 7 例**（本批的新数据抓出来的，改回 true 就红）。
  ⚠ 同族那一处（灼伤的 `addToTop(DamagePlayer(2, true))`）**第二十批一并修掉了**，见下条。

- **灼伤的 `DamagePlayer` 的 `clearOnCombatVictory` 同样抄成了默认的 `true`，参考是 `false`**
  （第二十批修）。`Actions::DamagePlayer` 那行与 `AttackPlayer` **逐字同形**
  （`Actions.cpp:91-95`：`return {[=](BattleContext &bc){...}, false};`）。
  第十九批把它记成「尚未修、留到有数据能分辨它的那一批」，第二十批正是登记「六火幽魂造灼伤」
  的那一批，于是回去把这条判断做完了——**结论是「该修，但它永远不会有预言机」**：
  - **实测 0 例**（改回 `true` 对拍全绿），而且是**结构性**的：这条动作走 `addToTop`、
    下一步就出队，队首与它之间不可能插进任何东西；灼伤又只打玩家，
    而 `clearPostCombatActions` **只在胜利时**跑（`BattleContext::checkCombat`，`:668-672`）。
    `AttackPlayer` 那一位之所以能被看见，靠的是「多段攻击 + 荆棘反伤打死怪」这个结构，
    灼伤没有它。
  - **仍然改**，理由与「补丁跟着登记一起打」不冲突：那条规矩管的是**参考侧补丁**
    （会在重新克隆时丢失、且没有 trace 能验证改得对不对）；这一条是**我们自己的转写错误**，
    住在本仓库、不会丢，而且参考源码那一行就是个字面常量 `false`，不存在解读空间。
    留一个已知错值比留一个已验证不可观察的正确值更糟。
  - ⚠ 关门条件：一条**不经过 `addToTop` 队首**的失血路径，或一个
    `clearOnCombatVictory = false` 的回合末触发能在胜利之后接着排队。当前内容集合里没有，
    大概率**永远关不掉**——记进盲区清单。

- **重放侧把「init 之后」的血量当成了「init 之前」的入参**（第二十一批修，
  `test/sts-combat-trace.test.ts` + harness 新增 `playerHp` 头部字段）。
  trace 的 `initial` 快照取在 `BattleContext::init` **之后**，而 `init` 里已经跑过
  `initRelics`（`BattleContext.cpp:73`），**血瓶的 `p.heal(2)` 就在其中**
  （`BattleContext.cpp:236`）。重放侧一直写的是 `playerHp: t.initial.player.hp`，
  于是又回了一次血。
  ⚠ **这个错从第一批就在，一直看不见**，原因照例是结构性的：
  `GameContext::initPlayer` 末尾是 `curHp = ascension < 6 ? maxHp : round(maxHp * 0.9f)`
  （`GameContext.cpp:522`）——asc<6 满血入场，那 2 点被上限吃掉，前后恒等。
  第二十一批开爬升度这条轴，asc19 是 68/75，一装数据当场红 **420 例**
  （14 编队 × 30 条 = 遗物轮换里带血瓶的那 1/4）——**又是新数据抓出来的，不是变异测试**。
  修法是给 harness 加 `playerHp` 头部字段（**只在 `curHp != maxHp` 时输出**，
  故 asc0 的行逐字节不变），重放侧 `t.playerHp ?? t.initial.player.hp`。

⚠⚠ **上面五条连成一条规律，值得单独记住：本项目至今每一次「共享路径上的转写错」
都是被新数据抓出来的，没有一次是变异测试抓的。**
（回合开始抽牌的入队形态 / `energyOnUse` / `drawCards` 的洗牌条件 /
怪物攻击的 `clearOnCombatVictory` / `deal_damage_rolled` 的 `times`，加上本批的入场血量。）
原因也一样：它们全都**在此之前不可观察**——要么那个字段没人读，要么正确值与错值恰好相等。
变异测试只能证明「现有数据看不看得见这段代码」，看不见的东西它也量不出来。
**推论：每次换布局 / 开新轴，都要把「第一次红」当成信号而不是噪音**——
先假设是我们抄错，而不是数据坏了。

### 参考侧补丁的打法：跟着登记一起打

参考项目的缺陷**在登记对应卡牌的那一批里才修**，不要提前批量修。理由是提前打的补丁没有任何
trace 走到它，既无法验证是否真的修对，又会在重新克隆参考项目时静默丢失。铁浪那条就是随
`iron_wave` 登记一起修的，重生成的数据当场验证了补丁。

## 发版

**整套新实现完成前不发版。** `package.json` 的版本停在 0.16.0（已发布），
release workflow 见到 tag 已存在就整体跳过，所以合并到 master 不会误发。
全部完成时一次性 bump（大概是 1.0.0）。

## 已知偏离参考项目之处

**北极星：真实游戏是目标，参考项目是目前最好的预言机、但不是目标本身。**

- 架构与代码组织 → 照抄（正是它让每次修正都是局部改动）
- 非直觉但正确的算法（重刃力量算 3 次、float32 逐步截断顺序、药水拒绝采样）→ 必须照抄
- 参考自身的 bug → 修正，并留可追溯记录

### 已修正（参考侧已打补丁）

⚠ 重新克隆参考项目时这些补丁会丢失，需重新应用，否则重生成的数据会退回错值。

- **铁浪 `IRON_WAVE` 双重 `calculateCardBlock`**（敏捷算两次）。已向上游提 PR
  （gamerpuppy/sts_lightspeed#9），fork 的 `master` 已含修复。
- **`Player::cc` 全项目无人赋值且无初始值**（UB，影响熵酿的药水池）。harness 里显式赋值规避。
- **4 处卡牌属性与真实游戏不符**，随第三批登记一起修（fork 的 `sts-engine-harness` 分支
  `4c3893a`）。修完复验过：这四张牌当时都不在任何 trace 牌组里，已提交数据逐字节未变。

  | 卡                | 参考的错                                                                                         | 真实游戏               | 性质     |
  | ----------------- | ------------------------------------------------------------------------------------------------ | ---------------------- | -------- |
  | `DISARM` 缴械     | `BattleContext.cpp:1281` 只有 `DebuffEnemy<MS::STRENGTH>(t, -2, false)`，**完全不读 `up`**       | -2 / 升级 -3           | 笔误     |
  | `IMPATIENCE` 急躁 | `:1341` 循环里找到攻击牌后写 `hasAttack = false;`（应为 `true`），于是恒假、退化成**无条件抽牌** | 「手里没有攻击牌才抽」 | 笔误     |
  | `TRIP` 绊摔       | `Cards.h getEnergyCost` 把 TRIP 归入费用 **1** 组                                                | **0** 费               | 数据遗漏 |
  | `SEEING_RED` 见红 | `Cards.h doesCardExhaust` 名单里**没有** SEEING_RED                                              | 消耗牌                 | 数据遗漏 |

- **`RAGE` 暴怒的费用没被列举**，随第六批登记一起修（fork 的 `sts-engine-harness` 分支
  `ae2b492`）。`Cards.h getEnergyCost` 压根没有 `case CardId::RAGE`，于是它落进
  `default: return 1`——真实游戏是 **0 费**，我们的数据表也是 0，不修就会一直红在能量上。
  与 `TRIP` 那条的区别：`TRIP` 是被**显式列进了错误的费用组**，`RAGE` 是根本没列（同一个
  兜底还兜着 `SHIV` / `SEEK` / `THROUGH_VIOLENCE`，那三张参考压根没实现，故未一并处理）。
  复验过：修完重新生成，variant 0 那 375 行/编队逐字节未变。
- **`clearPostCombatActions` 不修 `actionQueue.back`，胜利后的动作队列被写坏**
  （`BattleContext.cpp:674`），随第五批的黑暗拥抱 / 无痛之心一起修。
  压缩循环把存活动作搬到 `[front, placeIdx)` 并正确改了 `size`，但**从不更新 `back`**——
  它还指着压缩前的旧尾。于是下一次 `pushBack` 写在那个旧位置，而 `popFront` 仍从 `front`
  往上走，取到的是 `placeIdx` 那格**已经跑过或已被清掉的残留动作**，刚 push 的那条永远轮不到。
  复现：恶魔之火 + 黑暗拥抱，且中途某一击打死最后一只怪——`clearPostCombatActions` 只留下
  `OnAfterCardUsed`（`clearOnCombatVictory=false`），它把恶魔之火自己送进消耗堆、
  于是 `addToBot(DrawCards(1))`；旧 `back` 让这次抽牌凭空消失，取而代之跑了一条死掉的
  `AttackEnemy`。修法是循环末尾加一句 `actionQueue.back = placeIdx;`
  （`pushBack` 自己会规范化 `placeIdx == capacity`）。
  ⚠ 差异只出现在**胜负已定之后**的状态（真实游戏那时已经把战斗状态丢掉了），
  但 trace dumper 会把它快照下来，所以队列必须是队列。
  复验过：重新生成后 variant 0 那 375 行/编队**逐字节未变**，即已有背书一条都没受影响。
- **`BRUTALITY` 暴虐的失血没标 `selfDamage`，于是不触发破裂**，随第七批修
  （fork 的 `sts-engine-harness` 分支 `d5b27bf`）。`Player.cpp:683` 原文是
  `bc.addToBot(Actions::PlayerLoseHp(pair.second));`，而第二参数
  `bool selfDamage` **有默认值 false**（`Actions.h:64`），`Player::hpWasLost`
  （`:283`）只在 `selfDamage` 为真时给破裂加力量。参考里**所有卡牌调用点**都显式传了 true
  （`BattleContext.cpp` 的 952 / 1080 / 1268 / 1388 / 1409 / 1933，以及同文件 `:369` 的燃烧），
  只有暴虐漏了。真实游戏里暴虐走 `LoseHPAction(owner, owner, …)`，来源是玩家自己，
  `onLoseHp` 因此会跑到，破裂**会**触发——暴虐 + 破裂是铁甲广为人知的组合。
  补丁按「跟着登记一起打」在 `brutality`（第五批）与 `rupture`（第六批）**都已登记**之后才打。
  ⚠ 这个补丁**会改数据**：重生成后 4275 例里有 23 例的内容变了（第六批测到的正是这 23 例），
  variant 0 的 375 行/编队**逐字节未变**（暴虐与破裂都不在那副 21 张牌组里），
  variant 3/4 也未变（没有破裂 → `selfDamage` 观察不到）。
  重生成后 4275 例全绿，改回 false 红 23 例。
- **harness 的牌组构造漏掉了灼热之刃的升级次数**，随第七批登记一起修（fork 的
  `sts-engine-harness` 分支 `ed72833`）。原先写的是 `gc.deck.obtain(gc, Card(cid, up ? 1 : 0))`，
  而 `Card(CardId, int)` 只置 `upgraded` 位、**不动 `misc`**；灼热之刃的升级**次数**恰恰记在
  `misc` 上，只有 `Card::upgrade()` 会自增它（`Card.cpp:9`）。于是
  `CardInstance(const Card&)` 读到 `specialData = getUpgraded() = 0`，「已升级」的灼热之刃
  会按未升级的 12 点打。改成 `Card c(cid); if (up) c.upgrade();`——对其余每一张牌都等价。
  ⚠ 这是 harness 自己的坑，不是参考项目的 bug（`Card(CardId,int)` 只是个容易误用的构造）。
  复验过：variant 0 全未升级，已提交数据逐字节未变。
- **`setHasStatus` 从不写 `statusMap`，dump 纯 bool 状态会抛异常**（harness 侧规避）。
  `Player.h:233` 只翻转 `statusBits`，于是 `getStatusRuntime` 的 default 分支对着不存在的 key
  做 `statusMap.at(s)` → `std::out_of_range`。壁垒一上场整个生成就崩。harness 的
  `playerStatusValue` 改为「`statusMap` 里没有就按 1 输出」，与我们把 bool 状态记为 1 层一致。
  同类隐患还有 `CORRUPTION` / `CONFUSED` / `PEN_NIB` / `SURROUNDED` / `BLASPHEMER` /
  `ELECTRO` / `MASTER_REALITY` / `WRATH_NEXT_TURN`，铺到它们时不必再改 harness。
- **harness 的 `isReplayableCard` 门管不住「自动打出别的牌」的卡**，随第十批修（fork 的
  `sts-engine-harness` 分支 `08b68a5`）。那道门只筛**策略从手牌里挑什么**，而浩劫 / 混乱
  把选择权交给了 `BattleContext::playTopCardInDrawPile`——参考取抽牌堆顶那张、不看任何门。
  第十批实测撞上：variants 7/8 里蜕变/变形造出来的浩劫、多面手造出来的混乱，
  各打出了一张**未登记**的 `clash`，重放当场抛「暂未登记卡牌行为」，整条 trace 不可重放
  （不是「未验证」，是直接坏掉）。这个洞从第九批登记浩劫/混乱起就在了，
  只是新批次换了 RNG 流才浮出来。
  修法是新增 `mayPlayHandCard`，两张牌判据不同：
  - **浩劫**是一次性的，只读抽牌堆（空则先洗弃牌堆再读），所以「此刻这两堆里没有未登记的牌」
    就够——打出与动作执行之间没有任何造牌发生。**故意不**顺带要求抽牌堆非空：
    `playTopCardInDrawPile` 的空抽牌堆分支正是 variants 9/10 要覆盖的东西。
  - **混乱**是能力，余下每回合都要打，于是「此刻干净」不够：要求全场**既没有未登记的牌、
    也没有能从卡池造牌的牌**（蜕变/变形/发现/多面手/地狱之刃/嬗变）。理由是混乱自己
    就可能把一张造牌卡从牌堆顶打出去，那是策略侧拦不住的。
    ⚠ 这条判据直接决定了第十批的数据布局：嬗变是造牌卡，所以**它不能与混乱同处一副牌组**，
    第十批因此拆成两对 variant（见上方布局一节）。
    ⚠ 这是 harness 自己的坑，不是参考项目的 bug——真实游戏里那张 `clash` 当然该被打出来，
    只是我们还没登记它。
    复验过：对 variants 0-6（没有这两张）与 9/10（牌组全是已登记牌、且不含造牌卡）是空操作，
    重生成后两段逐字节未变；variants 7/8 变了（那里有造牌卡）。
    ⚠ **第十一批登记 `clash` 之后这个例子本身失效了**（它现在是已登记牌），但那道门仍然必需：
    池里还剩 7 张未登记（见上方战斗内卡池一节）。本批 variants 15/16 里放了浩劫，走的正是
    「只读那两堆、此刻干净就行」这条判据——那副牌组不含任何造牌卡，所以恒通过。
    ⚠ 第十二批登记 `dark_shackles` / `violence` 之后又摘掉两张，池里**只剩 5 张**未登记。
- **`DARK_SHACKLES` 黑暗镣铐的符号与神器条件两处错**（`BattleContext.cpp:1281`），
  随第十二批登记一起修（fork 的 `sts-engine-harness` 分支 `8170665`）。
  1. **符号错**：原文是 `DebuffEnemy<MS::STRENGTH>(t, up ? 15 : 9)`，而
     `Monster::addDebuff<MS::STRENGTH>`（`Monster.h:354`）是 `strength += amount`、**不取反**
     ——同项目其余减力量的调用点（`:1300` 缴械、`Monster.cpp:394` / `:454`）都传负数。
     所以原文是 **+9 力量**，把「失去 9 点力量」写成了「获得 9 点力量」。
  2. **神器条件反了**：原文是「目标**有**神器时才上 `SHACKLED`」。真实游戏里神器直接吃掉
     减力量，所以那条「回合末归还」的记账只有在**没有**神器时才该排——否则神器吃掉削弱、
     `SHACKLED` 反而白送力量。
     ⚠ 这个判定是在**打牌那一刻**同步读的，排在那条 `addToBot` 的减力量**执行之前**，
     所以它读到的是还没被这次削弱消耗掉的神器层数。这是参考自己的形状，**照抄不改**。

  修成 `DebuffEnemy<STRENGTH>(t, -(up?15:9))` + `if (!hasStatus<ARTIFACT>())
BuffEnemy<SHACKLED>(t, up?15:9)`。两处各有 552 例背书（见上方 ⁂ 那节）。
  ⚠ 神器**在场**时的行为仍然没有预言机（没有一只已登记的怪有神器），见盲区一节。

- **`VIOLENCE` 暴力会把牌复制出来**（`Actions.cpp:638` `ViolenceAction`），
  随第十二批登记一起修（同一个 commit `8170665`）。取牌循环里那句提前退出写的是 `return`
  而不是 `break`，于是尾部整段「从抽牌堆移除」被跳过：

  ```cpp
  for (; i < count; ++i) {
      if (attackIdxList.size()-i <= 0) {
          break;                        // ← 原文是 return，跳过了下面整段
      }
      ...
      bc.cards.moveToHand(c);           // 已经进手牌了
  }
  std::sort(removeIdxs, removeIdxs+i);  // ← i 就是「实际搬了几张」，本来就按它收尾
  for (int x = i-1; x >= 0; --x) {
      bc.cards.removeFromDrawPileAtIdx(removeIdxs[x]);
  }
  ```

  抽牌堆里的攻击牌**少于 `count`（3，升级 4）张**时命中：已经搬进手牌的那几张仍留在抽牌堆里，
  凭空多出副本。**260 例背书**，而且那条路径是**量过**的（1309 次暴力打出里 270 次走到它，
  见上方布局一节），不是碰巧撞上的。

- **`HandOfGreedAction` 走 `Monster::damage` 应为 `Monster::attacked`**
  （`Actions.cpp:1115`），随第十二批一起修（同一个 commit `8170665`）。
  ⚠ 这一条**不是**第十二批新卡的补丁——它是第十一批登记贪婪之手时就实测记下的
  （当时量到「改成 `attacked` 红 59 例」），按「补丁跟着登记一起打」的同一条理由
  （提前打没有重生成、验证不了）留到本批有重生成时才打，我们 TS 侧同步改掉。
  依据：它与同文件的 `FeedAction`（`:1070`）**结构完全同形**（`isDeadOrEscaped` 在 +3、
  伤害调用在 +6、奖励在 +14），只有这一处不同，是 copy-paste 笔误；而 `Monster::damage`
  跳过整条 `onAttacked` 链（蜷缩 / 反甲 / 荆棘 / …），真实游戏里贪婪之手是攻击牌、走
  `DamageAction`，蜷缩**应该**触发（`ReaperAction` 也用 `attacked`）。
  ⚠ **这个补丁会改数据**，而且改的面窄得很有说明性：重生成后 variants 15/16 里
  `two_louse` 变了、`cultist` **逐字节未变**——两者的唯一差别就是虱子有蜷缩。
  59 例背书（方向与第十一批那次相反，数字一致）。

- **红色奴隶主的 `usedEntangle` 从来没被写过，「缠绕一场只放一次」完全失效**
  （`MonsterSpecific.cpp:1017` 那条 case），随第十六批登记一起修（fork 的
  `sts-engine-harness` 分支 `7c7ecbf`）。
  `getMoveForRoll` 的 RED_SLAVER 分支开头是 `const bool usedEntangle = miscInfo;`（`:2777`），
  两条分支都读它，可是**全项目没有任何地方给红色奴隶主写过 `miscInfo`**。后果两条：
  ① `roll >= 75 && !usedEntangle` 退化成 `roll >= 75`，缠绕可以反复放（第十五批实测：
  375 条 variant 0 里有一条同一场放了 8 次，`ENTANGLE` 共执行 **72** 次）；
  ② `roll >= 50 && usedEntangle && !lastTwoMoves(STAB)` 整段是死代码。
  与 `IMPATIENCE` / `DISARM` / `TRIP` 同族：变量声明了、读了，就是没写。补的是一句
  `miscInfo = 1;`（case 的第一句，对齐真实游戏 `SlaverRed` 的书写位置）。
  **裁定过程见下方「待裁定」里那条的原文**（结论：打补丁严格减少期望分歧）。
  ⚠ **这个补丁会改数据**，影响面正好是预测的两个文件：`red_slaver.jsonl`（21 行）与
  `exordium_thugs.jsonl`（20 行），走 `ALLOW_CHANGED` 放行；其余十个已提交文件逐字节未变。
  `RED_SLAVER_ENTANGLE` 的执行次数从 72 降到 **56**。
  背书：去掉那句 `miscInfo = 1` 红 **41 例**，去掉复活的 `roll >= 50` 那段红 **37 例**。
  ⚠ **未验证的部分要说清楚**：复活的那个阈值 50 我们没有预言机能判（真实游戏疑似 55），
  补丁的源码注释里显式标了 `UNVERIFIED`；我们这边只量到它被 **1 例**钉住（50→51 红 1、
  50→49 红 0），见盲区一节。

- **`monsterStatusEnumStrings` 里 `REACTIVE` 的位置错了，32–38 号整体错位**
  （`include/constants/MonsterStatusEffects.h:117`），随第十八批登记一起修（fork 的
  `sts-engine-harness` 分支 `dd05409`）。
  那个数组是**按枚举值下标取用**的（`SimHelpers.cpp:17` 与 harness 的
  `trace_dump.cpp:105` 都写 `monsterStatusEnumStrings[i]`），所以每一项都必须落在自己那个
  枚举的下标上。枚举声明的是 `INVINCIBLE, REACTIVE, SHARP_HIDE`（31–33）后接
  `ASLEEP, BARRICADE, MINION, MINION_LEADER, PAINFUL_STABS, REGROW, SHIFTING, STASIS`，
  而字符串表把 `"REACTIVE"` 写在了 `PAINFUL_STABS` 与 `REGROW` 之间——于是 32–38 号整体
  上移一格：**`ASLEEP`(34) 打印成 `"BARRICADE"`**、`SHARP_HIDE`(33) 打印成 `"ASLEEP"`、
  `REACTIVE`(32) 打印成 `"SHARP_HIDE"`。0–31 与 39–42 恰好又对回去了。
  ⚠ **判据不是「看着不对」，是紧挨着上面的姊妹表 `enemyStatusStrings` 顺序是对的**
  （同样的 43 项，`Invincible / Reactive / Sharp Hide` 一个不差）——同一个枚举的两张表
  只有一张错，那就是笔误。
  ⚠ **不修就没法登记拉加维林**：`ASLEEP` 会被 dump 成 `"BARRICADE"`，而 `BARRICADE`
  在 `sts-combat-trace.test.ts` 的 `POWER` 表里**已经**映射给玩家的壁垒了（两张表共用一个
  字典），一个键不可能同时映射成 `barricade` 与 `asleep`。实测：不打补丁时
  `lagavulin.jsonl` 375 条**全红**，报的正是 `barricade: 1` vs `asleep: 1`。
  ⚠ **这个补丁不改任何已冻结数据**：它只改「怪物状态的名字」，而 32–38 号这一段
  （无敌 / 反应 / 尖刺皮 / 沉睡 / 壁垒 / 随从 / 随从首领 / 痛击）在此前 14 个文件的
  **怪物**快照里一次都没出现过（那些文件里的 `"BARRICADE"` 全是**玩家**侧的，
  走的是另一张表 `playerStatusEnumStrings`）。复验：装完之后 `git diff --stat` 对
  `test/golden/traces` 为空。

- **酸液史莱姆（大）的 asc17 出招读的是 _M 号_ 的腐蚀喷吐枚举**
  （`MonsterSpecific.cpp:2006`），随第二十二批（三精英三 Boss × asc19）一起修
  （fork 的 `sts-engine-harness` 分支 `167edd7`）。
  `ACID_SLIME_L` 那条 case 的 asc17 块第一段写的是
  `lastTwoMoves(MMID::ACID_SLIME_M_CORROSIVE_SPIT)`——L 的 `moveHistory` 里只可能有
  `ACID_SLIME_L_*`，所以条件恒假：`roll < 40` 恒返回腐蚀喷吐，紧跟着的
  `randomBoolean(0.6F)` 与它的两个返回值整支是死代码。修法是**一个词**。
  ⚠ **判它是复制粘贴笔误的证据链**：同一块 asc17 的另外两段（`roll < 70` →
  `lastTwoMoves(L_TACKLE)`、else → `lastMove(L_LICK)`）读的都是 **L 号自己的**枚举，
  只有第一段是 M。
  ⚠ **这条最能说明「判据不是静态的」**：同一个笔误第十四批就发现了，那时**正确地没有打**
  ——当时 trace 全是 asc0，整块 asc17 是死代码，「补丁有预言机」这条判据不成立。
  第二十一批开了爬升度这条轴之后它才成立。**每条「已确认但未打补丁」的记录都要在
  覆盖面扩大时重新过一遍判据。**
  ⚠ **未验证的部分**：补丁复活的 `randomBoolean(0.6F)` 我们没有预言机能判（与缠绕补丁
  复活的阈值 50 同一档），参考侧的注释里显式标了 `UNVERIFIED PROBABILITY`。
  ⚠ **这个补丁会改数据，而且影响面窄到可以逐行核对**：走
  `ALLOW_CHANGED="large_slime@asc19"`，装完 `git status` 只有那一个 `M`（外加本批 6 个
  未跟踪的新文件），`git diff --numstat` 是 `1 1`——整份 120 行**只改了第 21 行**，
  正是 `GEN11 @floor 7` 那条，与「打补丁前跑对拍红 1 例、失败的就是这一条」严丝合缝。
  ⚠ **背书的数字要分两段说，别混起来**：
  ① **对已冻结数据的影响是 1 例**（补丁前后 `large_slime@asc19` 只差这一条 trace）；
  ② **补丁后这条分支的背书是 16 例**——本批新装的 `slime_boss@asc19` 里，史莱姆王分裂出来的
  就有一只**酸液大史莱姆**，于是它也走这条出招规则。实测把 TS 侧改回 M 号枚举红 **16 例**。
  两个数字不冲突：前者是「补丁改了多少已有数据」，后者是「补丁后的形状被多少数据看着」。
  ⚠ 复活的那个 `0.6F` 概率仍然**没有背书**（本项目就是预言机），与缠绕的阈值 50 同族。

- ⚠⚠ **带壳寄生虫出招里的 `roll2` 是「掷了但取值一定被短路吃掉」的死变量**，
  **第二十六批已打补丁**（参考 `b34ae60`，`MonsterSpecific.cpp:2712-2724`）。
  第二十五批登记它时确认，第二十六批执行。参考原样是

  ```cpp
  int roll2 = 100;
  if (roll < 20) {
      if (!lastMove(FELL)) { return FELL; }
      roll2 = bc.aiRng.random(20,99);
  }
  if (roll < 60 || roll2 < 60) {      // ← roll < 20 蕴含 roll < 60，右边永远不求值
  ```

  `roll2` 只在 `roll < 20` 的支里被赋值，而 `roll < 20` 蕴含 `roll < 60`，所以那句 `||`
  的左边**恒真**、右边**永远不求值**。于是这次 `aiRng.random(20,99)` 只影响计数器，
  一点也不影响出招——「重击刚出过、这次重掷一个 [20,99] 来决定」这件事整段失效。

  **补丁的形状**（执行要求逐条兑现）：`int roll2 = roll;` + 后面**只判 `roll2`**
  ——最接近真实游戏 `num = AbstractDungeon.aiRng.random(20, 99);` 的覆盖语义，
  不引入三元表达式。⚠ **那次掷骰的位置与次数一个字没动**（它已有 80 例背书）；
  补丁只改**取值怎么被用**。我们侧 `MOVE_RULES.shelled_parasite` 同步改成同一形状。

  **证据链三条**（与 `usedEntangle` / `escapeNext` / 酸液 L 同族的「死代码」判据）：
  ① 一个初始化成哨兵 100、随后被赋一次真随机值、却在任何路径下都不被读的变量，
  本身就说明它本该被读；② **同一个函数里另有两处 `roll2`，写法都是对的**——地精首领的
  `MonsterSpecific.cpp:2394` 与 `:2412` 把 `roll2` 声明在分支**内部**、并且**只判 roll2**
  （`if (roll2 < 80)` / `if (roll2 < 50)`），没有和原 `roll` 做 `||`；
  ③ 作者之所以要引入第二个变量，是因为 `getMoveForRoll` 的形参是 `const int roll` 改不了。

  **判据 ③ 的措辞在这一条上收紧为「行为唯一确定」**（不是「文本唯一」）：两种写法
  （`roll2` 初值取 `roll` 后只判 `roll2`、或者三元）**行为逐位相同**，
  文本上有几种等价拼法不构成障碍，否则任何补丁都能被「还能换个写法」拖住。
  与地精头目 asc18 那条的差别正在这里——那条的两个候选**产生不同的出招序列**，是真的行为二义。

  **影响面与复核**：只有 `shell_parasite`（375 条）与 `shelled_parasite_and_fungi`（375 条）
  两个已冻结文件会变，第二十六批走 `ALLOW_CHANGED` 放行并复核过——`git status` 只有这两个
  `M` 加上本批四个 `??`，`git diff --stat` 是 **36 / 46 行**，与「补丁只改带壳寄生虫的出招」
  对得上。⚠ `SHELLED_PARASITE_FELL` 的出现次数从 1966 变成 **1971**（补丁确实改了出招序列）。
  第二十五批那两个例数在补丁后**重量**过，见「验证方式 · 第二十六批」。

- **`isMoveAttack` 白名单漏了 `WRITHING_MASS_WITHER`**（第三十五批发现、第三十六批打补丁，
  fork 的 `sts-engine-harness` 分支 `8107731`）。

  萎缩的伤害走 `attackPlayerHelper(bc, asc2 ? 12 : 10)`（`MonsterSpecific.cpp:1560-1565`），
  按第三十二批立下的判据（**`isMoveAttack` 收的就是走 `attackPlayerHelper` /
  `Actions::AttackPlayer` 的那些招**）它应该在表里，可参考的 `MonsterMoves.h` 只列了
  挥击 / 乱抽 / 重抽三条。

  **证据链两条**：
  ① 全表扫过之后——**它是整个参考里唯一一个「伤害走 `attackPlayerHelper` 却不在白名单」的
  招式**。反方向看着像例外的两类都自洽：爆破怪的自爆走 `Actions::DamagePlayer`
  （非攻击伤害路，参考在自己的规则下**是对的**），带壳寄生虫的吸取走 `Actions::VampireAttack`。
  ② 旁证同向：同族的「攻击 + 减益」四招 `CHOSEN_DEBILITATE` /
  `SPHERIC_GUARDIAN_ATTACK_DEBUFF` / `MYSTIC_ATTACK_DEBUFF` / `SNECKO_TAIL_WHIP`
  **全在表里**，只有它例外；真实游戏里萎缩显示的也是**攻击 + 减益**双意图。

  ⚠ **与爆破怪那条的差别正是判据的分水岭**：爆破怪是**参考在自己的规则下自洽**
  （非攻击伤害路 → 不在表里）；萎缩是**参考跟自己不自洽**（攻击路 → 却不在表里，
  且是全表唯一）。「隔壁那个是这样」不是证据，**「全表只有它一个例外」才是**。

  **三条判据都成立**：① 分歧真实（**24 例**钉着）；② 有预言机（打完重新生成即可重放，
  与缠绕 / `REACTIVE` 错位 / 酸液 M-L / `roll2` 四次同源）；③ 修法唯一（表里加一行）。

  **补丁的形状**：`isMoveAttack` 的 switch 里加一格 `case MMID::WRITHING_MASS_WITHER:`
  （按枚举序排在 `FLAIL` 与 `MULTI_STRIKE` 之间），**别的一个字没动**。

  **影响面与复核（第三十六批实测）**：只有 `writhing_mass.jsonl` 一个已冻结文件会变，
  走 `ALLOW_CHANGED="writhing_mass"` 放行并复核过——`git status -- test/golden/traces`
  只有那**一个 `M`** 加上本批两个 `??`，`git diff --stat` 是 **24 insertions / 24 deletions**
  （一行 = 一条 trace），与第三十五批量到的 **24 例**一字不差。
  ⚠ 补丁后重量：「白名单里多收萎缩」这个方向从 **24** 变成 **0**（它现在本来就在表里），
  反方向「把萎缩从白名单里去掉」= 回退补丁，红 **24 例**——同一个数的两面。

### 已确认但尚未打补丁

⚠ **登记对应卡牌之前必须先在参考侧修掉**，否则重新生成的 trace 会带着错值，
而我们的数据表是对的 —— 对拍会红在「我们错」的位置上，实际是预言机错。

- ⚠⚠ **`Monster::escapeNext` 是个死字段。第二十七批装上了地精首领，逐条重过三条判据之后
  裁定：仍然不打补丁，而且这一条已经从「等下一批数据」升级成「结构性关不掉」。**

  **事实（第二十七批复查，全项目 grep 一个字没变）**：
  `Monster.h:47` 声明并初始化成 `false`、`Monster.cpp:262` 是 getter 的函数体、
  `MonsterSpecific.cpp:650 / :660 / :670` 三处读 `doesEscapeNext()`
  （**狂暴 / 鬼祟 / 肥胖三只**，护盾地精那条 case 压根没有这个读点），
  **全项目仍然没有任何写入点**。与红奴隶主的 `usedEntangle`、`IMPATIENCE` / `DISARM` /
  `TRIP` 同族：变量声明了、读了，就是从没被赋值。
  真实游戏里这一位由**地精首领**被打死时给场上其余地精置上。

  **判据 ① 在已登记内容里真的产生分歧？——不成立。**
  这一批把首领与它的三种随从全部装进来了，读点确实活了；但要产生分歧得让 `escapeNext`
  为真，而唯一合理的写入时机是首领的死亡，**那一刻战斗已经结束**：
  `Monster::die` 的第二个条件就是 `hasStatus<MS::MINION_LEADER>()`，命中即
  `outcome = PLAYER_VICTORY` 并**当场 `return`**（`Monster.cpp:293-297`）。
  实测（`gremlin_leader.jsonl` 375 条）：首领死了 **55** 次，**55 次全部当场判胜**，
  其中 4 次身边还有活着的小鬼；**首领死后再没有任何一帧**（0 帧）——小鬼一次都没能再行动。
  参考用「首领死 = 判胜」这条短路**代替**了整个「随从逃跑」的过程。

  **判据 ② 补丁有预言机？——不成立，而且是同一个根。**
  即使把赋值补进 `die` 的第一句（`--monstersAlive` 之前），紧接着那条 `return` 也会让
  战斗结束，小鬼永远轮不到读它。**换牌组、换种子、换爬升度都救不回来**——它不依赖任何
  可调的量。要让它可观察，得连 `Monster::die` 里 `MINION_LEADER` 那一支一起重写，
  那已经不是「补一个漏掉的赋值」，而是**重写参考对这只精英的整个建模**。

  **判据 ③ 行为唯一确定？——不成立，而且卡在两处（不是一处）。**
  ⚠ 判据 ③ 已收紧为「**行为**唯一确定」，文本上有几种等价拼法不算障碍——但这里读不出来的
  是行为本身：
  - **写入侧**：给哪些格置位（0/1/2 三格？只给活着的？护盾地精要不要——参考里它**没有**
    这个读点，真实游戏里有）、置在 `die` 的哪一句（`--monstersAlive` 之前还是之后、
    `MINION_LEADER` 那道 `return` 之前还是之后）。参考自己一个都答不了。
  - **读出侧**：`GENERIC_ESCAPE_MOVE` 那条 case 在参考里是
    `case GENERIC_ESCAPE_MOVE: default: break;`（`MonsterSpecific.cpp:1898-1900`）
    ——**什么都不做**：不置 `isEscapingB`、不减 `monstersAlive`、不判胜。
    所以就算切到了那个意图，小鬼也只会站着不动，**仍然不是真实游戏的行为**。
    要让它真的逃走还得再补一整条 case（抄抢劫者的 `LOOTER_ESCAPE`？那条还带别的语句）。
    这是「补一个赋值」变成「补两处发明」的地方。

  **裁定：不打补丁，照抄参考（只转写三只地精 else 那一支，不建模 `escapeNext` 字段）。**
  与第十九批「尖锐外壳只看 `arr[0]`」同一档——**连关门条件都不在数据这一维上**。
  ⚠ 别再把它写成「等装上地精首领那一批再打」：那已经发生了（第二十七批），判据照旧不过。

  **新的关门条件（两条都要，缺一条就是发明）**：
  ① 真实游戏 `GremlinLeader.java` 的 ground truth——首领死时具体给哪些随从置位、
  置在死亡流程的哪一步；② 真实游戏里随从「逃跑」这一步的 ground truth（参考的
  `GENERIC_ESCAPE_MOVE` 是空 case，没有任何东西可抄）。
  ⚠ **拿到这两条之后仍然没有预言机**——参考的 `MINION_LEADER → 判胜 + return` 会抢在前面。
  所以那时候要么连带重写 `Monster::die` 那一支（改动面远超「笔误修正」），
  要么如实承认：**这条差异在本项目的预言机体系里永远无法被验证**。
  ⚠ 影响面**不是理论上的**：真实游戏里「秒掉首领、小鬼逃跑」是这场精英战的标准打法，
  而我们与参考一致地把它简化成「秒掉首领即胜」。两者「战斗此刻结束」这一点同解，
  差别在战后的奖励与随从的去向（属 run 层）。

  ⚠ 顺带一提：`GREMLIN_LEADER` 的召唤（`Actions::SummonGremlins`，`Actions.cpp:459`）
  在参考里是实现了的，**第二十七批已按它逐位转写并拿到背书**，缺的只有 `escapeNext` 这一位。

- **尖锐外壳只看 `monsters.arr[0]`**（`BattleContext.cpp:1757`，与激怒 `:1846` 同一个写法）。
  第十九批登记守卫者时确认。**裁定：不打补丁，而且这一条比激怒更彻底地关不掉。**
  判据仍是那两条（① 在**已登记内容**里真的产生分歧 ② 补丁**有预言机**，两条都成立才补）：
  全参考项目 buff `SHARP_HIDE` 的**只有守卫者**（`MonsterSpecific.cpp:1352` 是唯一写入点），
  而守卫者只出现在单怪编队里——所以 `arr[0]` 恒等于「带外壳的那只」，
  **在参考的整个内容集合里都不可能产生分歧**。激怒那条至少还有
  `COLOSSEUM_EVENT_NOBS`（监工在 0 号位、头目在 1 号位）当关门条件，这条连关门条件都没有。
  实测改成遍历全体对拍全绿（0 例），见盲区一节。

- **六火幽魂的地狱之火（INFERNO）不升级牌堆里已有的灼伤**（`MonsterSpecific.cpp:807-812`）。
  第二十批登记它时确认：那条 case **只有伤害**（`attackPlayerHelper(bc, asc4 ? 3 : 2, 6)`），
  而真实游戏里地狱之火还会把玩家抽 / 弃 / 手三堆里所有的灼伤升级成灼伤+。
  证据是**全项目 grep**：`BURN` 只出现在「生成灼伤」的六处
  （`MonsterSpecific.cpp:825 / :997 / :998 / :1594 / :1800 / :1802 / :1871`）与
  「灼伤怎么结算」的两处（`BattleContext.cpp:939 / :2118`），**没有任何一处升级它**。
  参考里压根不存在「批量升级某个牌堆里的某种牌」这样一个动作。

  **裁定：本批不打补丁，写进报告等裁定。** 两条判据里第 ② 条是过的
  （六火幽魂就在已装编队里、灼伤已登记，补丁一定有 trace 走到），
  卡住的是**「这是转写还是发明」**：参考侧没有任何东西可抄——张数？不改。**哪几个牌堆**？
  **排在六段伤害之前还是之后**？**同步还是 `addToBot`**？**要不要连正在出牌队列里的那张也算**？
  四个问题参考一个都答不了，只能凭对真实游戏的印象猜，与
  `Monster::escapeNext` 那条「还得凭印象猜头领死时具体给谁置」同类。
  按 WORKFLOW 第 5 步「参考项目看着像 bug → 不要自己拍板」，本批照抄参考、如实记在这里。
  ⚠ 影响面是**真实的、不是理论上的**：`HEXAGHOST_INFERNO` 在 375 条里执行了 **274 次**，
  每一次之后玩家牌堆里那些灼伤都本该变成 4 点。所以这条不是「无所谓的边角」。
  **关门条件**：拿到真实游戏的 ground truth（`Hexaghost.java` 的第 6 号 case 具体怎么写），
  再照着补一个动作原语。在那之前我们与参考一致、与真实游戏不一致。

- **`PAIN` 剧痛的失血没标 `selfDamage`，于是不触发破裂**
  （`BattleContext.cpp:2678` 的 `Actions::PlayerLoseHp(1)`，第二参数缺省即 `false`）。
  与暴虐那条**同一类漏传**（暴虐已随第七批修掉，见上方「已修正」），修法也一样：
  改成 `PlayerLoseHp(1, true)`。
  **但现在不要改**——`pain` 这张诅咒牌在本引擎里**没有任何入手途径**、也未登记，
  按「补丁跟着登记一起打」提前打没有 trace 走到它，既验证不了又会在重新克隆时静默丢失。
  登记 `pain` 的那一批一并处理。

- ~~**酸液史莱姆（大）的 asc17 出招读的是 _M 号_ 的腐蚀喷吐枚举**~~
  **第二十二批已打补丁**（参考 `167edd7`），条目移到上方「已修正 · 参考侧」。
  这条的裁定过程值得回头看一眼：同一个笔误第十四批就发现了，那时**正确地没有打**
  （当时 trace 全是 asc0，整块 asc17 是死代码，「补丁有预言机」不成立），
  第二十一批开了爬升度这条轴之后判据才成立。**判据不是静态的。**

- ⚠⚠ **地精头目在 asc>=18 时碎颅击结构性不可达，出招退化成「咆哮之后永远猛冲」**
  （`MonsterSpecific.cpp:2434-2447`）。第二十二批转写它的 asc18 块时确认。
  参考写的是

  ```cpp
  if (asc18) {
      if (!lastTwoMoves(MMID::GREMLIN_NOB_SKULL_BASH)) { return RUSH; }
      if (lastTwoMoves(MMID::GREMLIN_NOB_RUSH)) { return SKULL_BASH; } else { return RUSH; }
  }
  ```

  碎颅击只在第二段被返回，而要走到第二段必须 `lastTwoMoves(SKULL_BASH)` 为真，
  也就是必须**它此前已经连出过两次**——于是首招咆哮之后恒为猛冲，第二段两个返回值
  整支是死代码。与酸液 L 那条**同一个家族**（一处条件恒假 → 一整支死代码）。
  实测：整块 asc18 失效红 **104 例**（所以我们确实照抄对了），
  而「碎颅击 asc3 伤害档」在 asc19 下 **0 例**——因为它在那个档位压根不出场
  （asc0 的 375 条里它执行了 270 次，缺的只是 asc>=3 那一档的数值背书）。

  **裁定：本批不打补丁，写进报告等裁定。** 两条判据里第 ② 条是过的
  （`gremlin_nob@asc19` 就在已装编队里，补丁一定有 trace 走到），卡住的是第 ①/③ 条那句
  「修法是转写还是发明」：正确形状**没法从参考读出来**。第一段该返回碎颅击？
  那第二段的 `lastTwoMoves(RUSH)` 又该配什么？参考自己答不了，只能凭对真实游戏的印象猜，
  与 `Monster::escapeNext` 那条「还得凭印象猜头领死时给谁置」同类。
  酸液 L 之所以能打，是因为那是**一个词的还原**且有证据链（同一块里另外两段都读自己的枚举）。
  **关门条件**：拿到真实游戏 `GremlinNob.java` 的 ground truth。
  在那之前我们与参考一致、与真实游戏很可能不一致，而且影响面**不是边角**——
  `gremlin_nob@asc19` 的 120 条 trace 里碎颅击一次都没出现。

另有 3 处性质不同，单独记：**`Cards.h getEnergyCost` 以 `default: return 1` 收尾**，
所以它对未列举的牌一律返回 1 费。`SHIV` 飞刀、`SEEK` 搜寻、`THROUGH_VIOLENCE` 以暴制暴
都落进这个兜底，实际都是 0 费。（第四张 `RAGE` 暴怒已随第六批登记一起修，见上方「已修正」。）

⚠ 第九批的 `DUAL_WIELD` 双持**也落在这个兜底里**（`getEnergyCost` 没有列举它），
但兜底值 1 恰好等于真实游戏的费用、也等于我们数据表里的值，所以**不需要补丁**。
记在这里是为了下一个人别把「没被列举」误当成「被验证过」——它只是碰巧对。

与已修的 `TRIP` 那条的区别在于：`TRIP` 是**显式写错**（真的被列进了费用 1 组），这几张是
**根本没被列举**。后者顺带说明一件事——`getEnergyCost` 不能当作全表的费用预言机，
只有它显式列举的牌才算权威；而 `isCardInnate` / `doesCardExhaust` / `doesCardSelfRetain`
都是「完整名单 + `default: return false`」，那三个是可以全表信任的。

`SHIV` / `SEEK` / `THROUGH_VIOLENCE` 这三张参考项目三个 switch 里都没有 case，
等于压根没实现，铺量到它们时只能以真实游戏为准。
⚠ 正因为 `SEEK` **永远不会有预言机**，第十批把 `sts-combat-wiring.test.ts` 的
「未迁移卡牌」样本换成了它（原先是 `whirlwind`，本批登记了）。别再换成会被下一批登记的牌。

⚠ **「未迁移编队」的样本同理，第十八批换成了 `giant_head`（第三幕精英）。**
判据不是「参考没实现」而是「**不在 harness 的 20 个第一幕编队里**」——那个列表按 WORKFLOW
不许增删（`traceIdx` 一移，遗物/药水轮换整体错位、已提交数据全线作废），要覆盖第二/三幕
得在现有双重循环**之后**再追加一遍循环。原先用的是 `gremlin_nob`（wiring）与
`three_sentries`（rules），第十八批把它俩都登记了。⚠ 别换成 `the_guardian` / `hexaghost` /
`slime_boss`——它们就在那 20 个里，第十九/二十批就要登记。

## 数据表与参考/真实游戏冲突

数据表是两代实现共用的，它错了游戏级实现会照着错的数值逐位复现。

### 已修正（第七批）

- **`sentinel` 哨兵的 `color` 从 `"blue"` 改为 `"red"`**。哨兵是铁甲牌——参考的
  `CardPools.h` 把 `CardId::SENTINEL` 列在 ironclad 的 `uncommonCards` / `skills` /
  `cardBlob` 各池里。⚠ 这一改**改变了 run 级的奖励卡池成员**（红池 +1、蓝池 -1），
  于是同种子 run 的卡牌奖励会变——这是修正而非破坏，数据本来就错了。
  改动不影响战斗对拍（`sts-combat.ts` 不读 `color`）。
- **`sentinel` 的 `upgradedDescription` 从「获得 2 点能量」改为 3 点**。参考
  `BattleContext.cpp:2857` 与 `CardInstance.cpp:209` 都是 `up ? 3 : 2`；
  `sts-combat.ts` 早已按 3 实现并有 trace 背书（变异 2 例）。
  `onExhaust: [gain_energy 2]` **保持不动**——它与 `effects` 一样只记未升级态，见下。
- 同时**补上了一条此前完全缺失的不变量**（`data-tables.test.ts` 的「卡表 · 颜色归属」）：
  已在 `sts-combat.ts` 登记行为的牌，`color` 只能是 `red` / `colorless`
  （迁移范围就是铁甲 + 无色），且必须真的落在自己颜色的奖励池里。
  哨兵那个错法在这条下当场失败（实测：把 `color` 改回 `"blue"` → 该条红）。
  ⚠ 射程有限，别高估：**挡不住尚未登记的 275 张牌**，也挡不住 red ↔ colorless 记错、
  或 common/uncommon/rare 三档之间记错。登记表越长它覆盖越广。

### 已修正（第七批 · 续）

- **`CardDef` 补了 `upgradedEthereal` 与 `upgradedOnExhaust`**（已裁定）。
  前者对齐 `Cards.h:466 isCardEthereal` 对 APPARITION / ECHO_FORM / DEVA_FORM 的
  `!upgraded`，幻影填 `false`——没有它就登记不了幻影；顺带订正了幻影的升级卡面
  （原先照抄了未升级那句、还留着「虚无。」）。后者让哨兵+ 的「回 3 点能量」终于在数据表里
  有地方写，与同族的 `upgradedOnDiscard` 一个模式。
  两个字段运行期都只被 `sts-combat.ts` 的 `etherealOf` 读（`onExhaust` 仍是纯数据）。
  `data-tables.test.ts` 两处枚举 upgradedXxx 的不变量已同步，并新增
  「『虚无』文案与 ethereal 一致（含升级后不再虚无）」——幻影那处漏改的卡面正是被它挡住的。

### 已修正（第十批）

- **`transmutation` 嬗变的卡面两处错**，随登记一起改（只动 `description` /
  `upgradedDescription`，运行期没有代码读它们）：
  1. 「本场它们的费用为 0」→「**本回合**」。参考 `Actions::TransmutationAction` 走的是
     `c.setCostForTurn(0)`——只压本回合、`cost` 不动，回合末 `resetAttributesAtEndOfTurn`
     会把它复位。写成「本场」是把它错当成了蜕变/变形那种连 `cost` 一起压的写法
     （那两张才是「本场战斗 0 费」）。真实游戏卡面同样是「本回合」。
     ⚠ 这个区别**有 trace 背书**：把 0 费改成连 `cost` 一起压，对拍红 6 例。
  2. 升级卡面原先与未升级**逐字相同**，漏了升级效果。参考是
     `CardInstance c(cid, upgraded)`——造出来的牌**带升级态**，不是「多造一张」。
     已补成「…本回合它们的费用为 0。它们是升级过的。消耗。」
     ⚠ 这个区别也有背书：造出来的牌改成恒未升级，对拍红 134 例。

### 已修正（第十三批）

- **`slimed` 黏液的 `cost` 从 `null`（=打不出）改为 `1`**，随登记一起改。
  黏液是**唯一不需要医疗包就能打出的状态牌**：参考 `CardInstance::canUse` 的 STATUS 分支写的是
  `if (!hasRelic<MEDICAL_KIT>() && id != CardId::SLIMED) return false;`（`CardInstance.cpp:329`），
  真实游戏也是「1 费打出，消耗，无效果」。费用来源是 `Cards.h getEnergyCost` 的
  `default: return 1`——**没有被显式列举**，所以按本文件的判据它**不是权威、只是碰巧对**
  （与 `DUAL_WIELD` 同一情形，见上方「已确认但尚未打补丁」那节的说明）。真实游戏的 1 费才是依据。
  ⚠ `cost: null` 会让 `initialCardCost` 返回 -2 哨兵，于是黏液既过不了能量检查、打出也不扣能量。
  ⚠ 顺带订正了卡面（原先写「状态牌，无法打出」，与两边都不符）。
  ~~⚠ **这一改没有 trace 背书**（黏液在本批数据里一次都没进过手牌）~~
  **第十四批已补齐**：`large_slime` 里黏液被打出 46 次，`cost` 改 5 → 红 36 例、
  `exhausts` 改 false → 红 36 例、去掉 `canUse` 的例外 → 红 36 例。三条属性现在都有预言机。
- **`data-tables.test.ts` 的「卡表 · 颜色归属」按 `type` 排除了状态/诅咒牌。**
  第十三批起登记表里出现了不属于任何角色的牌（黏液，`color: "status"`）。**没有**把
  `"status"` / `"curse"` 直接并进允许集合——那会让一张真的记错颜色的**角色牌**从此蒙混过关；
  改成先按 `type` 分流，状态/诅咒牌只要求 `color` 与 `type` 自洽。

### 已修正（第十四批）

- **本文件自己的一处记错：「史莱姆一族有易塑（MALLEABLE）」。** 第十二/十三批两处都写着
  「只有 L 号与史莱姆王有」，登记 L 号时逐条复核发现参考里**根本没有**：
  全项目 buff 它的只有 `SNAKE_PLANT`（`MonsterSpecific.cpp:249`）与 `WRITHING_MASS`（`:213`），
  史莱姆 S / M / L 与史莱姆王一只都没有。已在「三、整类缺失的机制」那条订正。
  影响：`Monster::applyEndOfTurnTriggers` 的易塑分支要等**第二 / 三幕**才有预言机，
  不是第十九批。（`enemies.ts` 也没有给史莱姆写过易塑，所以只是文档错，没有代码错。）
- **`enemies.ts` 的两只 L 号史莱姆：五条已有招式与两段血量区间逐字比对参考，一条都没有出入。**
  本批只**新增**了分裂那一招（`intent: "unknown"`，白名单复核过不算攻击），并补上了
  `MonsterSpecific.cpp` / `MonsterIds.h` 的逐条行号引用。数值本身没改——但现在有了
  变异背书（血量区间 153~~169 例、五条招式数值 17~~39 例），此前那句「L 精确权重待校准」
  只对 `intentRule`（旧近似战斗的遗留数据）成立。
- **`Effect` 联合体新增 `{ kind: "split" }`**（纯追加，只有敌人用）。分裂成什么读
  `EnemyDef.splitInto`（早就有），时点与 RNG 消耗全在 `sts-combat.ts` 的 `splitMonster`。
  没有动 `CardDef`，也没有任何穷举 switch 需要跟着改。

### 已修正（第十五批）

- **`enemies.ts` 的三只怪：血量区间与七条招式数值逐字比对参考，一条都没有出入。**
  本批只补上了 `MonsterIds.h` / `MonsterSpecific.cpp` 的逐条行号引用，数值本身没改——
  但现在有了变异背书（血量区间 344~~415 例、七条招式数值 27~~265 例），
  此前那句「精确权重待校准」只对 `intentRule`（旧近似战斗的遗留数据）成立。
- **`Effect` 的两处形状改动**（都只影响敌人，没有动 `CardDef`，也没有穷举 switch 要跟着改）：
  - `steal_gold` **去掉 `amount`**。参考的
    `stealGoldFromPlayer(bc, getStatus<MS::THIEVERY>())`（`MonsterSpecific.cpp:918/912`）
    从怪物的 THIEVERY Power 取额度，而那是 `preBattleAction` 掷定的（`:233`，15 / asc17 20）。
    把数值也写在招式里就是两份真相，且 THIEVERY 本来就会出现在 trace 的怪物快照里
    （所以 `POWER` 映射必须有它，漏了当场抛「未映射的 power」）。
  - `gain_block` 新增可选的 `sync`。参考的怪物加格挡**两种写法并存**：同步 `addBlock(n)`
    20 余处（抢劫者的烟雾弹 `:937`）、`addToBot(MonsterGainBlock)` 6 处（颚虫 `:858/:865`）。
    省略即入队（既有的怪都是这一种）。⚠ 当前这个区分没有预言机，见盲区一节。
- **`PowerId` 新增 `thievery`**；顺手订正 `entangled` 的注释——它**不是**「回合末 -1」而是
  整条清除（`Player.cpp:382` 用的是 `RemoveStatus` 不是 `decrementStatus`）。

### 已修正（第十六批）

- **`fungi_beast` 的 `deathEffects` 删掉了。** 参考把孢子云建模成一个 **Power**
  （`preBattleAction` 里 `buff<MS::SPORE_CLOUD>(2)`，`MonsterSpecific.cpp:182`；
  `Monster::die` 读 `hasStatus<SPORE_CLOUD>()`，`Monster.cpp:299`），那个 Power
  **会出现在 trace 的怪物快照里**，不建模就对不上；而易伤的层数 2 与 `isSourceMonster`
  都是 `die` 里硬写的，写进数据表就成了第二份真相。与第十五批 `steal_gold` 去掉 `amount`
  同一条理由。`deathEffects` 字段本身留着（爆破怪还在用，那是第三幕、尚未登记）。
- **`CombatMonster.rolledDamage` 改名为 `miscInfo`。** 参考只有**一个**
  `Monster::miscInfo`（`Monster.h:83`），含义逐怪种不同；我们早先只用到虱子那一种
  （整场固定的咬击伤害）就按用途起了名。第十六批的补丁让红奴隶主用它记 `usedEntangle`，
  一个字段两种含义，名字必须回到参考的形状——否则每登记一只用 `miscInfo` 的怪
  （刺穿之书 / 地精巫师 / 暗影 / 六火幽魂 / 蠕动血块）就要再加一个字段。
  `migrate` 无损回填（老档里它只可能是虱子的咬击伤害）。
- **`enemies.ts` 的真菌兽：血量区间 22~28 与两条招式数值逐字比对参考，一条都没有出入。**
  本批只补上了 `MonsterIds.h:172` / `MonsterSpecific.cpp:691/696` 的逐条行号引用，
  数值本身没改——但现在有了变异背书（血量区间 155~168 例、撕咬 11 例、成长 19 例）。
  ⚠ 它的 `intentRule`（旧近似战斗的遗留权重 60/40）已清空成 `{ scripted: [], weighted: [] }`，
  与第十五批那三只一致：出招规则的唯一真相是 `MOVE_RULES`。
- **`PowerId.spore_cloud` 的注释订正**（原文写「显示用；实际死亡效果在 deathEffects」，
  现在它是真的被读的标记）；`store_hp_scaled_damage` 那条注释里的 `rolledDamage` 跟着改名。

### 已修正（第十九批）

- **⚠ `enemies.ts` 的守卫者：泄气那两条减益的顺序反了。** 数据表写的是「虚弱 → 易伤」，
  参考是 `addToBot(DebuffPlayer<VULNERABLE>(2,true)); addToBot(DebuffPlayer<WEAK>(2,true));`
  （`MonsterSpecific.cpp:1375-1376`）——**易伤在前**。这是本条铺量线上第一次真的抓到
  `enemies.ts` 的数值错（此前几批逐字比对都是「一条都没有出入」）。
  方向是可观察的：玩家带**神器**（古代药水在遗物/药水轮换里）时，被吃掉的是排在前面的那条。
  实测顺序对调红 **2** 例——薄，但非 0，与第十八批吸魂那 86 例同源。
  其余数值（血量 240 / 140、蓄能 9、重砸 32、滚压 9、旋风 5×4、双重猛击 8×2、猛砸 35、
  黏液 3 张、尖锐外壳 3、模式切换 30、防御格挡 20）逐字比对参考，**没有别的出入**。
- **删掉 `EnemyDef.modeShiftThreshold` 与 `EnemyDef.stanceMoves`。** 两个「守卫者专用」的
  旧近似战斗遗留字段。模式切换阈值的真相在 `PRE_BATTLE_ACTION`（同时写 `miscInfo` 与
  `MODE_SHIFT`）与 `MONSTER_ON_HP_LOST` 里，姿态链的真相在 `MOVE_TURN_END` 的七条同步
  `setMove` 里——留着就是第二份真相，与第十五批 `steal_gold` 去掉 `amount`、第十六批删掉
  真菌兽 `deathEffects` 同一条理由。⚠ 与那两条不同的是**字段本身也删了**：它们只可能有
  守卫者一个用户，留下就是纯死代码。
- **`Effect` 的两处形状改动**（都只影响敌人，没有动 `CardDef`，也没有穷举 switch 要跟着改）：
  - 新增 `{ kind: "split_boss" }`。参考的 `slimeBossSplit` 与 `largeSlimeSplit` 是**两个函数**、
    形状差五处，用同一个 `kind` 再在函数里按 `defId` 分叉必然出错。
  - `add_card` 新增可选的 `sync`（与 `gain_block` / `apply_power` 同族）。史莱姆王的
    黏液喷射写的是 `.actFunc(bc)`，是这一族第一条同步写法。
- **新增 `EMPTY_MONSTER_SLOT` 空占位怪。** 参考的 `MonsterGroup::arr` 是定长 5 的数组、
  `monsterCount` 只是「dump 到第几格」，所以「场上的怪数」与「数组用掉几格」不是一回事：
  史莱姆王分裂后 1 号格从没被写过，harness 照样 dump 成 `INVALID = 0`。我们用
  `bc.monsters.length` 当 `monsterCount`，于是那种空格必须有实体。它 `!alive`，
  所有循环都会跳过它；`defId` 故意取一个数据表里没有的名字，谁真去 `getEnemyDef` 它会当场抛错
  （唯一放行的读点是 `isMonsterAttacking`，参考对它是 `isMoveAttack(INVALID)` = false）。
  测试侧配套两行映射：`MONSTER["INVALID = 0"]` 与 `MOVE["INVALID"]`。
- **编队 id `guardian` → `the_guardian`。** 编队 id 必须与参考的 `MonsterEncounter` 枚举名
  同名——trace 文件名就是它，而 `SUPPORTED_ENCOUNTERS` 与 `test/golden/traces/*.jsonl`
  是双向对齐的（`sts-combat-wiring.test.ts`）。同时改了 Act1 Boss 池那一行。
- **订正本文件自己的一处记错：「尖锐外壳挂在 `onUseSkillCard` 上」。** 第十八批激怒那条裁定
  里写的是「同一个 `arr[0]` 写法还有第二个用户：`onUseSkillCard` 里的尖锐外壳
  （`BattleContext.cpp:1757`）」——**函数名错了**。1757 行在 `onUseAttackCard` 里
  （`:1638-1761`），`onUseSkillCard` 从 `:1764` 才开始。真实游戏也是「打出**攻击**牌」。
  ⚠ 这一条有数据背书：扩到技能牌也触发红 **360** 例。

### 已修正（第二十九批）

- **⚠ 两只 Boss 的血量都把「两组区间」当成了一个区间。** `monsterHpRange[THE_CHAMP] =
{{420,420},{440,440}}`、`[THE_COLLECTOR] = {{282,282},{300,300}}`（`MonsterIds.h:209-210`），
  而旧近似表写的是 `420~440` 与 `282~300`——**上界取的是高档那一组的值**。
  ⚠ 这不是「差一点」：`Random::random(a,b)` 的取值依赖上下界，抄错会让此后每一次
  `monsterHpRng` 整体错位。实测各红 **375 例**（两个文件全红）。
  ⚠ 同一处错法在第二十八批的青铜自动机（`{{300,300},{320,320}}`）上已经出现过一次，
  那一批改对了。**判据：`monsterHpRange` 永远是两组，抄的时候先看清有几层大括号。**
  火炬头的 `38~40` 恰好是对的（旧表照抄了低档那一组）。
- **⚠ 冠军的扇脸：「虚弱」是错的，参考给的是易伤，而且顺序是「脆弱 → 易伤」。**
  参考是 `attackPlayerHelper(...); addToBot(DebuffPlayer<FRAIL>(2,true));
addToBot(DebuffPlayer<VULNERABLE>(2,true));`（`MonsterSpecific.cpp:1280-1286`）。
  旧表写的是「虚弱 2 + 脆弱 2」。实测把易伤抄回虚弱红 **374 例**、把两条顺序对调红 **80 例**
  （顺序可观察的原因与第十九批守卫者的泄气同源：玩家带**神器**时被吃掉的是排在前面的那条）。
- **⚠ 冠军少了整整一招：嘲讽（`THE_CHAMP_TAUNT`）。** 旧表只有六招，参考有七招
  （`MonsterMoves.h:178-184`）。它每四个怪物回合固定出一次（`(getMonsterTurnNumber()+1) % 4 == 0`），
  在 375 条 trace 里**每一条都出现过**——不是边角。
- **⚠ 冠军的防御姿态用的是另一族爬升度阈值。** `getTriIdx(bc.ascension, 9, 19)`
  （`MonsterSpecific.cpp:1262`），而同一只怪的暴怒 / 自夸用的是 takeTurn 顶部那个
  `bossDiffIdx = getTriIdx(asc, 4, 19)`。**同一只怪身上两族阈值并存**，照抄邻居必错。
  ⚠ 当前 asc0 分辨不了两者（实测 0 例），所以它是「照抄但没有背书」——记进盲区，
  关门条件是第二幕的爬升度那一批（`asc4 <= n < 9` 才分得开，例如 asc7）。
- **⚠ 收藏家的增幅是三句、旧表只有两句而且顺序反了。** 参考是
  「给**前两格**（火炬头位）加力量 → 自己加力量 → 自己加格挡」（`MonsterSpecific.cpp:1310-1325`），
  旧表写的是「先格挡后力量」且**完全没有给随从那一段**。格挡的第三档是 **23**（不是 20），
  别按等差补。实测三句顺序里「把格挡提到最前」红例数见变异表。
- **编队 id `the_collector` → `collector`。** 与第十九批 `guardian`→`the_guardian`、
  第二十五批 `shell_parasite`、第二十八批 `automaton` 同一条规矩：编队 id 必须与参考的
  `MonsterEncounter` 枚举名同名（trace 文件名就是它，`SUPPORTED_ENCOUNTERS` 与
  `test/golden/traces/*.jsonl` 双向对齐）。**怪**的 id 仍然是 `the_collector`
  （对齐 `MonsterId::THE_COLLECTOR`）。同时改了 Act2 Boss 池那一行。
- **三只怪的 `intentRule` 权重表全部弃用**（与第二十三 / 二十五 / 二十六 / 二十七 / 二十八批同一结论）：
  冠军旧表写的是「重斩 30 / 扇脸 20 / 防御 20 / 处决 15 / 自夸 15」、收藏家是
  「首招召唤 + 火球 40 / 增幅 25 / 巨型削弱 35」、火炬头是「冲撞 权重 1」——参考的出招规则
  一条都不长这样。真相在 `MOVE_RULES.champ` / `.the_collector` / `.torch_head` 里。
- **删掉了 `Effect` 的 `summon` kind 的一个用户。** 那条通用形状是旧近似战斗的遗留，
  现在只剩蜥蜴法师的匕首还在用它。⚠ 注释同步更新：三个已登记的召唤宿主**没有任何两个能共用
  代码**，登记第四个时同样要单开一个 kind。

### 待裁定

- ⚠⚠ **血之药水 × 神圣树皮的两个常数看着是反的。裁定不变（不打补丁），但第四十五批把
  判据 ① 关掉了，现在失败的是 ③。**

  参考是 `hasBark ? 20 : 40`，而同一个 switch 里另外 **32 条全部是 A = 2B**（树皮翻倍）。
  真实游戏是 20% 基数、树皮翻成 40% —— 参考的**基数与方向都对不上**。

  第四十四批报「判据 ③ 不过」，随后复核改成「**先失败的是 ①**」，并写下关门条件：
  「改 harness 的策略让它在受伤时才喝药水」。**第四十五批兑现了那条关门条件**
  （`potionPolicy 1` = 半血及以下才喝），结果如下：

  | 写法                                | `@pot1`（无树皮）回复量 | `@pot2`（有树皮）回复量 |
  | ----------------------------------- | ----------------------- | ----------------------- |
  | **as-built** `hasBark ? 20 : 40`    | **32**（240 / 240 次）  | **16**（240 / 240 次）  |
  | `hasBark ? 80 : 40`                 | 32（不变）              | 64（被 maxHp 夹）       |
  | `hasBark ? 40 : 20`（对齐真实游戏） | 16                      | 32                      |
  - **① 在已登记内容里产生分歧 —— 现在成立**：改成 `40 : 20` 红 **480 例**、
    改成 `80 : 40` 红 **240 例**（只动带树皮那一面）。此前是 0（满血喝、`min(maxHp, …)`
    把两个数夹成同一个）。
  - ② 有预言机（重新生成即可自洽）—— 成立。
  - ③ **行为唯一 —— 仍然不成立，而且本项目的数据永远关不掉它**：数据是**参考自己**产出的，
    它恒与 as-built 一致，所以它能证明「分歧存在」，证不了「哪一个是真实游戏」。

  **所以这一条从「覆盖面扩大后自己会解锁」那一族转入「拿到真机 ground truth 之前
  永远补不了」那一族**（与地精头目 asc18 自锁同类）。裁定仍是**照抄 as-built、不打补丁**。
  ⚠ 记清楚是哪一条失败仍然重要，只是这次的答案变了。

- ⚠⚠ **血之药水的神圣树皮分档看着是反的，而且它是全表唯一的例外。裁定：照抄 as-built、
  不打补丁。**（第四十四批记，⚠ **第四十五批推翻了「结构性不可观测」这半句**——见上面那条：
  `potionPolicy 1` 之后回复量完全可观察，两个方向各红 480 / 240 例。）

  ```cpp
  // BattleContext::drinkPotion，BattleContext.cpp:2299-2302
  case Potion::BLOOD_POTION: {
      int healAmt = static_cast<int>((static_cast<float>(player.maxHp * (hasBark ? 20 : 40)) / 100.0f));
      addToBot(Actions::HealPlayer(healAmt));
      break;
  }
  ```

  同一个 switch 里的 `hasBark ? A : B` 一共 **33 条**，另外 **32 条全部满足 A = 2B**
  （翻倍）；只有这一条是 **A = B / 2**——带着神圣树皮反而回得更少。
  真实游戏里血之药水回 **20%** 上限、树皮翻成 **40%**，所以参考的两个数**都**对不上：
  基数多了一倍、方向还反了。

  **三条判据：③ 不成立 —— 所以不补。**

  - ① 有可观察的分歧 —— ⚠ **第四十五批起成立**（此前这里写的是「语料里观察不到」）。
  - ② 有预言机（重新生成即可自洽）。
  - ③ **行为不唯一**：「补上」有两种互不相同的写法——`hasBark ? 80 : 40`（保住既有
    37186 例背书的基数、只把方向掰正）与 `hasBark ? 40 : 20`（对齐真实游戏）。
    参考自己答不了是哪一种，而改基数会推翻**全部已冻结数据**（血之药水在轮换的 13 瓶里）。

  ⚠⚠ ~~**顺带一条结构性的观察：这个分歧在本项目里根本观察不到。**~~ —— **第四十五批做掉了**。
  当时的判断是对的（`pickAction` 把喝药排在出牌之前 ⇒ 恒在满血时喝 ⇒ `min(maxHp, …)`
  把 40% 与 20% 夹成同一个值），但结论「它是死的」错在把 **harness 的策略**当成了常量。
  策略是我们自己的东西，改它不需要第二个信源——`potionPolicy 1` 一加，回复量当场可观察。
  **教训：判「结构性不可观测」之前先分清那个约束是在参考里，还是在我们自己的 harness 里。**

- ⚠⚠ **好奇心（`MS::CURIOSITY`）在参考里什么都不做——它唯一的读点被整段注释掉了。
  裁定：照抄参考（不实现效果），不打补丁。**（第三十七批）

  ```cpp
  // BattleContext::onUsePowerCard 的最末（BattleContext.cpp:1909-1912）
  //    auto &m = monsters.optionMap[2];
  //    if (m.hasStatusInternal<MS::CURIOSITY>()) {
  //        m.buff<MS::STRENGTH>(m.getStatus<MS::CURIOSITY>());
  //    }
  ```

  真实游戏的语义是「玩家每打出一张**能力牌**，觉醒者 +层数（asc0 是 1）力量」。
  参考把整段注释掉了，但**保留了施加与摘除**：`preBattleAction` 里
  `buff<MS::CURIOSITY>(asc19 ? 2 : 1)`、`Monster::die` 的觉醒者分支里
  `removeStatus<MS::CURIOSITY>()`。所以它在 trace 里**看得见**（开局 `CURIOSITY: 1`、
  假死后消失），只是没有任何行为。

  **三条判据：① 不成立 —— 所以不补。**

  - ① **没有可观察的分歧**：预言机就是参考本身。补上那段之后，觉醒者的力量会随玩家打出的
    能力牌增长，而**没有任何数据能说这是对的还是错的**——重新生成 trace 只会把我们自己的
    发明固化成「预言机」。这与「爆破怪的自爆不在攻击白名单」那条同族（第二个信源缺位）。
  - ② 有预言机（重新生成即可自洽）但见 ①。
  - ③ 行为其实是唯一的（真实游戏的规则很清楚），**但那不足以推翻 ①**。

  ⚠ 那两行注释掉的代码还有一处硬伤，值得单记：**下标写死 `optionMap[2]`**。
  觉醒者恰好在 2 号位，所以它「碰巧对」——与激怒 / 尖锐外壳 / 反应 / 缓慢那族
  写死 `arr[0]` 是同一个毛病的另一面。真要补，这一处也得一起裁定。

  **关门条件**：真实游戏 `Awakened One` 的 ground truth（每张能力牌到底加几层力量、
  层数怎么读）。拿到之前照抄参考，这条差异记在这里，不会被误当成「已验证」。

- ⚠ **`Monster::resetAllStatusEffects()` 只清一半，留下一个「不自洽」的状态。裁定：不打补丁。**

  ```cpp
  void Monster::resetAllStatusEffects() {   // Monster.cpp:554-558
      statusBits = 0;                        // 所有「有没有」的位，清
      setStatus<MS::STRENGTH>(0);            // 力量的**数值**，显式清
      block = 0;
  }
  ```

  它只在一处被调：`Monster::die` 的 `REGROW` 那一格（`:303-306`，暗影客变半死时）。
  问题是 `buff` / `addDebuff` 都是 `字段 += n`，而**除力量外的数值字段一个都没清**。
  于是「清过的」虚弱再被施加时，从残值继续加——实测暗影客重生前挨 1 层虚弱、
  复活后吃一张衣领（+2），参考显示 **3**。

  作者显式清了力量与格挡，说明他**知道**光清位不够；只是漏了其余的。
  这是「参考自己跟自己不一致」那一族的证据。

  **三条判据：①② 成立，③ 不成立 —— 所以不补。**

  - ① 分歧真实：**53 例**钉着。
  - ② 有预言机：打补丁后重新生成即可重放验证，影响面只有 `three_darklings.jsonl`。
  - ③ **行为不唯一** —— 这是关键，而且要说清为什么：

    as-built 留下的状态是**不自洽**的（位说「没有」、数值说「1」），这一点在**任何**
    解释下都是错的。但把它改成自洽有**两个**候选，而它们行为不同：

    | 候选         | 那条 trace 会显示                        | 说明                             |
    | ------------ | ---------------------------------------- | -------------------------------- |
    | **全清**     | 虚弱 **2**                               | `resetAllStatusEffects` 名副其实 |
    | **完全不清** | 虚弱 **3**，且中间那几帧虚弱**一直可见** | 复活保留 buff/debuff             |
    | as-built     | 虚弱 **3**，但中间那几帧虚弱**消失了**   | 隐藏残值                         |

    ⚠ **as-built 与「完全不清」的最终数值相同**，唯一的差别是中间几帧 dump 里
    虚弱可不可见。所以 trace 能告诉我们「参考做了什么」，**告诉不了我们「游戏该怎样」**。
    而参考作者自己在复活那条 case 上注着 `// todo does it keep its buffs and debuffs?`
    ——**他也不知道**。选「全清」还是「完全不清」就是发明。

  **关门条件**：真实游戏 `Darkling` 的 ground truth（它复活时到底保不保留 Power）。
  拿到之前照抄参考，这条差异记在这里，不会被误当成「已验证」。

- ⚠ **爆破怪的自爆打 30 点却不在 `isMoveAttack` 白名单里。裁定：不打补丁，参考是对的。**

  第三十二批把它记成「疑似笔误」，理由是隔壁匕首的自爆在白名单里。**复核方查了两边的
  伤害路径，结论相反——参考在这里是内部自洽的**：

  | 招式               | 伤害走哪条路                          | 在 `isMoveAttack` 白名单？     |
  | ------------------ | ------------------------------------- | ------------------------------ |
  | `DAGGER_EXPLODE`   | `attackPlayerHelper(bc, 25)`          | **在**（`MonsterMoves.h:448`） |
  | `EXPLODER_EXPLODE` | `addToBot(Actions::DamagePlayer(30))` | **不在**                       |

  白名单的判据是「**伤害走不走攻击路**（`Player::attacked`）」，而爆破怪的自爆刻意走的是
  非攻击伤害路（`Actions::DamagePlayer`）。所以它的缺席**符合参考自己的规则**，不是漏写。

  ⚠ **措辞修正（第三十五批复核时）**：这条先前写的是「走没走 `attackPlayerHelper`」，
  那太窄了——`SHELLED_PARASITE_SUCK` 走的是 `Actions::VampireAttack`，同样在白名单里。
  判据是**攻击路**这个语义，`attackPlayerHelper` 只是它最常见的一种实现。
  爆破怪这条裁定本身不受影响（它两种实现都不走）。

  ⚠ **这条要和「兄弟表不一致」那一族的证据严格区分开**（`monsterStatusEnumStrings` 的
  `REACTIVE` 错位、酸液史莱姆大的 M/L 枚举）——那两条是**参考自己跟自己矛盾**，
  所以是笔误；这条是**两个东西本来就该不同**，只是长得像。
  「隔壁那个在、这个不在」本身**不是证据**，要先问「判据是什么、两者在判据下同不同类」。

  **那么真实游戏里爆破怪显示攻击意图这件事怎么办？** 不冲突——第二十三批就把两件事拆开了：
  `isMonsterAttacking`（觅敌之弱的谓词）抄参考的白名单，`EnemyDef.intent`（渲染分类）
  按真实游戏标。爆破怪可以**渲染成攻击、而觅敌之弱不吃它**，参考正是这么做的。
  这条裁定反过来印证了那次拆分是对的。

- ⚠⚠ **爆破怪的自爆打 30 点，却不在 `isMoveAttack` 白名单里。裁定：照抄参考，不打补丁。**
  （第三十二批发现，**这是这张表迄今分歧最明显的一格**）

  参考的两条 case（`MonsterSpecific.cpp`）：

  ```cpp
  case MMID::EXPLODER_EXPLODE:            // :1394-1398   —— 白名单里**没有**它
      bc.addToBot( Actions::DamagePlayer(30) );
      bc.addToBot( Actions::SuicideAction(idx, true) );
      bc.noOpRollMove();
      break;

  case MMID::DAGGER_EXPLODE:              // :1632-1636   —— 白名单里**有**它（:445）
      attackPlayerHelper(bc, 25);
      bc.addToBot( Actions::SuicideAction(idx, true) );
      bc.noOpRollMove();
      break;
  ```

  两条形状几乎一样（打人 + `SuicideAction` + 同步 `noOpRollMove`），一条在白名单一条不在。
  **参考自己是自洽的**：`isMoveAttack` 收的就是「走 `attackPlayerHelper` /
  `Actions::AttackPlayer` 的那些招」，而自爆走的是 `Actions::DamagePlayer`
  ——非攻击伤害，不吃力量与易伤，这与真实游戏里 Exploder 的爆炸用 `DamageType.THORNS`
  （同样不吃力量）是对得上的。
  **但意图不是伤害类型**：真实游戏里 Exploder 的爆炸显示的是**攻击意图**，
  所以觅敌之弱对着一只准备自爆的爆破怪应该给力量。

  **三条判据：**
  - **① 在已登记内容里真的产生分歧？——成立，而且实测过。** 觅敌之弱在本批的牌组里，
    把 `exploder/exp_explode` 加进白名单红 **11 例**（`sphere_and_two_shapes` /
    `three_shapes` / `four_shapes` 三个文件都有）。这不是理论风险。
  - **② 补丁有预言机？——不成立。** 预言机就是参考本身，改了参考等于把断言写进被测物；
    要判它得有**第二个信源**（真实游戏的 `Exploder.java` 的 `setMove(..., Intent.ATTACK, ...)`），
    而这一批没有。与地精头目 asc18 自锁、突刺之书死代码那两条同族。
  - **③ 行为唯一确定？——看起来成立，但依赖 ② 那个断言。** 只有一种改法（把
    `EXPLODER_EXPLODE` 加进 `isMoveAttack`），不像地精头目那条有两个候选。
    ⚠ 可是「唯一」这件事本身是从「真实游戏显示攻击意图」推出来的，而那正是 ② 缺的信源。

  **关门条件**：真实游戏 `Exploder.java` 的 ground truth（第二个信源），不是更多 trace。
  ⚠ 在那之前我们这边**照抄参考**（`MONSTER_ATTACK_MOVES` 不收 `exploder/exp_explode`），
  并且**这条差异已经被 11 例数据钉住**——谁要是「顺手修好」会当场红，不会静默飘走。
  ⚠ 顺带一条给下一个人的判据：**`isMoveAttack` 收的是「走 `attackPlayerHelper` 的那些招」**，
  这比第二十三批那条「不能从数据表的 intent 推」更可操作——抄白名单时按这个反查一遍，
  对不上的地方就是这一类候选分歧。

- ⚠⚠ **怪物侧的虚无缥缈「总是在回合末递减」，参考自己知道这与真实游戏不同。
  裁定：照抄参考，不打补丁，等真机。**（第三十六批）

  参考在枚举那一行**直接写了注释**：

  ```cpp
  INTANGIBLE, // differs from the game in that it always decrements at end of round
  ```

  （`MonsterStatusEffects.h:35`；实现在 `Monster::applyEndOfTurnTriggers` 的第四句，
  `Monster.cpp:55-57`，是裸的 `decrementStatus<MS::INTANGIBLE>()`，**没有** `wasJustApplied`
  那一套 skipFirst。）

  真实游戏里 `IntangiblePower` 是 `atStartOfTurn` 才减一层、且**施加当回合不减**
  （玩家侧的 `IntangiblePlayerPower` 同理），而参考把两件事都压进了回合末的无条件递减。

  **三条判据：① 成立，② 不成立，③ 成立 —— 所以不补。**
  - **① 分歧真实？——成立。** 实测「给它补上 skipFirst（施加当回合不掉）」红 **108 例**。
  - **② 补丁有预言机？——不成立。** 预言机就是参考本身。
  - **③ 行为唯一确定？——成立**（把递减挪到 `applyStartOfTurnPowers` 并加 skipFirst）。

  ⚠ **但要注意「净效果」这件事**：复仇魔三条 case 的补层都在 `if (!hasStatus<INTANGIBLE>())`
  后面，所以 as-built 的观感仍然是「隔回合无敌」（2 → 1 → 消失 → 2），
  **只是相位与真实游戏差一个回合**。别因为「看着对」就以为没有分歧。
  **关门条件**：真实游戏 `Nemesis` 的 ground truth（第二个信源），不是更多 trace。

- ✅ **蠕动血块的「萎缩」走 `attackPlayerHelper` 却不在 `isMoveAttack` 白名单里。
  第三十五批记在这里，第三十六批复核后**打了补丁**——已移出「待裁定」，
  详见「已知偏离参考项目之处 · 已修正（参考侧已打补丁）」那一条。**

  ⚠ 它与爆破怪那条（上一条，**不打补丁**）是同一条判据的两个方向，值得并排记住：
  爆破怪走 `Actions::DamagePlayer`，**参考在自己的规则下自洽**，分歧只在「参考 vs 真实游戏」，
  第二个信源缺位 → 判据 ② 不过；萎缩走 `attackPlayerHelper`，**参考跟自己不自洽**，
  而且是全表唯一的例外 → 三条判据全过。
  **「隔壁那个是这样」不是证据，「全表只有它一个例外」才是。**

- **⚠⚠ `Monster::resetAllStatusEffects()` 只清 `statusBits`、不清那些具名 int 字段，
  于是「清空过的 Power」再被施加时会从残留值继续加。裁定：照抄参考，不打补丁，等真机。**
  参考（`Monster.cpp:554-558`）：

  ```cpp
  void Monster::resetAllStatusEffects() {
      statusBits = 0;              // ← 只清 bit
      setStatus<MS::STRENGTH>(0);  // ← 力量单独归零（它没有 bit）
      block = 0;
  }
  ```

  而 `buff` / `addDebuff` 一律是 `field += amount; setHasStatus(true);`
  ——所以 `weak` / `vulnerable` / `artifact` / … 这些字段里的旧值**从没被清掉**，
  下一次施加会叠在上面。全参考项目**只有一个调用点**：`Monster::die` 的 REGROW 分支
  （暗影客的重生），所以只有「死过又复活的怪」会踩到。
  ⚠ **它是可观察的，而且第三十四批当场撞上**：某只暗影客重生前挨过 1 层虚弱，
  复活之后再吃一张衣领（+2 层），参考显示 **3** 层。那是本批第一条红掉的 trace，
  也是「`cleared` 这个中间态必须建模」的由来（实测「整条清空」红 **53 例**）。
  ⚠ **真实游戏几乎肯定不是这样**：Java 版的 `powers` 是一个对象列表，清空 = 把
  `WeakPower` 整个删掉，再施加就是全新的一个、层数从 0 起。所以这很可能是参考的
  实现细节泄漏（「字段只在 bit 为真时有意义」这条不变量被 `buff` 的 `+=` 破坏了）。
  ⚠ **三条判据只过了第 ② 条**：① 补丁**没有预言机**（预言机就是参考本身，改了它
  等于改了标准答案）；② 形状读得出来（`removeStatus` 的写法就在隔壁，先 `setStatus(0)`
  再清 bit）；③ 真实游戏的行为**没有第二个来源可以确认**（我们没有真机 ground truth）。
  与「爆破怪的自爆不算攻击」同一类：**照抄参考、记在这里，等真机再裁**。
  ⚠ 参考自己在复活那条 case 上注着 `// todo does it heep its buffs and debuffs?`
  ——作者对这一块本来就没把握。那是**疑问不是结论**，本批照抄它实际做的。
  ⚠ 在那之前我们这边照抄参考，而且**这条差异已经被 53 例数据钉住**——
  谁要是「顺手改成整条清空」会当场红，不会静默飘走。

- **秘法师的 asc17 缺血阈值是 21，治疗量却是 20——两个数差 1。裁定：本批不动，等真机。**
  参考（`MonsterSpecific.cpp:2223` 与 `:600`）：

  ```cpp
  const auto healNeedAmt = asc17 ? 21 : 16;   // getMoveForRoll：缺这么多血就强制治疗
  const auto healAmt     = asc17 ? 20 : 16;   // takeTurn：真正回这么多
  ```

  asc0 那一档两个数都是 16、严丝合缝；asc17 那一档**阈值比治疗量大 1**。看着像笔误
  （某一处该是 20 或 21），但也可能是原作故意的：阈值 21 保证「触发治疗时至少回满」。
  ⚠ **判据三条一条都不过**：① 当前不产生分歧（第二幕的怪一只都没校准爬升度，
  `ascCalibrated` 闸门在 `ascension > 0` 时抛错，整块 asc17 是死代码）；② 因此补丁**没有
  预言机**；③ 正确形状读不出来（改哪一处？改成 20 还是 21？参考自己答不了）。
  与第十四批当时**正确地没打**酸液 L 那个补丁同形——**判据不是静态的**，
  等「第二幕的爬升度」那一批开出 asc 轴之后再回来看。
  ⚠ 在那之前照抄参考的两个数，代码注释里已经写明「它们不是同一个数，别对齐成一个常量」。
  一并记下的两处**不是 bug、只是形状不统一**（照抄即可）：百夫长的防守判
  `getAliveCount() > 1`、秘法师的两招判 `monsters.monstersAlive > 1`（同值、两个访问器）；
  秘法师读同伴用的是 `knight.isAlive()`（血 > 0）而**不是** `!isDeadOrEscaped()`
  ——当前没有「会逃跑的百夫长同伴」，两者同解，以后有了要拆成两个谓词。

- **地精头目的 asc18 出招块自锁：碎颅击永远出不来。裁定：不打补丁。**
  参考（`MonsterSpecific.cpp:2453-2466`）：

  ```cpp
  if (asc18) {
      if (!lastTwoMoves(SKULL_BASH)) return RUSH;   // ← 恒真
      if (lastTwoMoves(RUSH))        return SKULL_BASH;  // ← 死代码
      else                           return RUSH;        // ← 死代码
  }
  ```

  自锁很干净：只有「上两回合都是碎颅击」才可能返回碎颅击，而碎颅击永远返回不了，
  于是第一个条件恒真、后面两支恒不可达。实测 `gremlin_nob@asc19` 的 120 条里
  碎颅击**一次没出现**，连带 `asc3 → 8` 那个伤害档也零背书。

  **为什么这次不补——判据要补上第三条。** 前两条判据（① 在已登记内容里真的产生分歧
  ② 补丁有预言机）这里表面上都过得去，但它们隐含了第三条，之前一直没被单独触发：

  > **③ 修法唯一（是转写，不是发明）。**

  酸液史莱姆那条满足③：同一块 asc17 的第二、三段都用 L 号自己的枚举，只有第一段是 M，
  **修法就是一个词，读得出来**。这里读不出来——候选至少两个（把第一个条件的
  `SKULL_BASH` 换成 `RUSH`，或者把 `!` 去掉），两种改法产生**不同的出招序列**，
  而参考本身无法在它们之间裁定。选一个就是发明，正是 `forethought` 当初被拒的理由。

  **关门条件**：真实游戏 `GremlinNob` 的 ground truth（第二个信源），不是更多 trace。
  ⚠ 在那之前，我们这边**照抄自锁形态**——它与参考逐位一致，只是与真实游戏可能不一致，
  这条差异已经记在这里，不会被误当成「已验证」。

- ⚠⚠ **突刺之书的出招规则里有两句排在 `return` 之后的死代码。裁定：不打补丁，照抄参考的
  实际行为（= 不加）。**（第二十八批发现）

  参考原样（`MonsterSpecific.cpp:2295-2319`）：

  ```cpp
  auto &stabCount = monsterData;
  if (roll < 15) {
      if (lastMove(SINGLE_STAB)) { ++stabCount; return MULTI_STAB; }
      else {
          return (MMID::BOOK_OF_STABBING_SINGLE_STAB);
          if (asc18) { ++stabCount; }        // ← 死代码（:2305-2307）
      }
  } else if (lastTwoMoves(MULTI_STAB)) {
      return (MMID::BOOK_OF_STABBING_SINGLE_STAB);
      if (asc18) { ++stabCount; }            // ← 死代码（:2311-2313）
  } else {
      ++stabCount; return MULTI_STAB;
  }
  ```

  **它是「死代码」的第三种形状。** 前两种是「字段从没被赋值」（`usedEntangle` / `escapeNext`）
  与「取值被短路吃掉」（`roll2`）；这一种是**语句排在 `return` 之后**。
  ⚠ 它最容易被眼睛跳过，因为**编译得过**：clang 只在 `-Wunreachable-code` 下提示，
  而 `regen-traces.sh` 的构建命令带的是 `-w`。发现它的唯一办法是**照着 case 从上到下读**
  （WORKFLOW 那句老话），而不是相信「看起来有 asc18 分档」。

  **三条判据逐条不过：**
  - **① 在已登记内容里真的产生分歧？——不成立。** 突刺之书的 `ascCalibrated` 没置，
    `constructMonster` 在 `ascension > 0` 时直接抛错，整个 asc18 分支不可达。
  - **② 补丁有预言机？——第三十批部分成立，但方向不对。** 第二十八批时同一个根：没有 asc>0
    的第二幕语料，把这两句转写进来在 23956 例上红 **0 例**。**第三十批铺了 asc19，同一个
    变异现在红 495 例**（两支还能分开量：只补第一支 263、只补第二支 432）。
    ⚠⚠ **但这不是「② 成立」**：语料背书的是「我们与参考一致」，而这一条要问的是
    「参考与真实游戏一致吗」——预言机换不了信源。所以判据 ② 在**这一条的语境下**仍然不成立。
    ✅ 唯一改变的是**背书状态**：as-built 的行为（不自增）从此有 495 例看着，
    以后谁把它「顺手修好」会当场红一大片，不会静默飘走。
  - **③ 行为唯一确定？——不成立。** 真实游戏的 `BookOfStabbing.getMove` 里**没有**任何与
    ascension 相关的 `stabCount` 自增（A18 的突刺之书靠更高的血量与伤害档变强，不靠段数），
    所以「把它挪到 `return` 之前」与「整段删掉」是**两种不同的行为**，参考自己答不了。
    与地精头目 asc18 自锁那条同族：候选两个、产生不同的段数序列，选一个就是发明。
    ⚠ 与 `roll2` 那条的差别正在这里——那条的两个候选**行为逐位相同**（判据 ③ 已收紧为
    「行为唯一确定」），这条不是。

  **关门条件**：~~① 真实游戏 `BookOfStabbing.java` 的 ground truth；② 第二幕的爬升度语料~~
  ✅ ② 由第三十批交付。**剩下的只有 ①：真实游戏 `BookOfStabbing.java` 的 ground truth。**
  ⚠ 这条记录**保持挂着**，不要因为「现在有 495 例背书」就当它结案了——
  495 例背的是 as-built，不是「参考本该怎样」。

~~- **`enemies.ts` 装不下 asc≥7 的第二组血量区间。**~~
~~- **要不要给 harness 开「爬升度」这条轴。**~~
**两条都由第二十一批做掉了**（本批被明确授权改 `EnemyDef` 类型）：

- `EnemyDef` 新增 `hpHigh = { atLeast, hpMin, hpMax }`。⚠ **阈值跟着区间一起写在数据表里**，
  没有做成「按精英/Boss 猜」——`Monster::initHp`（`MonsterSpecific.cpp:26-128`）的阈值
  是普通 7 / 精英 8 / Boss 9，还有 `ORB_WALKER` / `REPTOMANCER` 那种「先白掷一次再取」
  的特例，猜不出来。
- 招式数值走 `Effect.ascAmount`，多出来的整条效果走 `apply_power.minAscension`。
- **没校准的怪显式抛错**（`EnemyDef.ascCalibrated` + `constructMonster` 的 throw +
  编队级的 `ASC_SUPPORTED_ENCOUNTERS`），所以「只在 asc0~6 下正确」这个静默错误状态
  已经不存在了：现在要么正确，要么开不了战。
- 现状：**14 / 20 个编队、19 / 25 只怪**已校准（asc19 背书）。三个精英 + 三个 Boss
  留给第二十二批——它们的血量阈值是 8 / 9 而不是 7，招式还另有 asc18/19 分档。

**新留下的一条，同族但更细：**

- ⚠ **爬升度的「阈值本身」仍未验证——只验证了阈值两侧的行为。**
  asc19 这一个档位取到每条 `asc >= N` 的「高」侧、asc0 取「低」侧，所以**分档的两个方向
  都有背书**；但「分界线恰好在 N 而不是 N±1」**一个档位证不了**。
  举例：把虱子蜷缩的 asc17 改成 asc16 或 asc18，对拍照样全绿。
  **关门条件**：加**成对**档位的 variant。性价比排序：
  ① **asc7**（一次同时点亮「7~16」那一整段中间档——它现在是 0 例盲区，见「第二十一批」
  那节的盲区小结——并把 asc7 血量阈值、蜷缩 asc7 档、护盾地精 asc7 档一起钉住）；
  ② asc16 / asc18（钉住 17 这条最密集的分界线的两侧）；
  ③ asc1 / asc3（钉住 2 和 4）。
  ⚠ 每加一个档位就多一份 21MB 量级的数据，**不必每个编队都加**——阈值是全局共享的常量，
  挑一两个招式最密集的编队（`jaw_worm_horde` / `gremlin_gang`）就够。
- **`forethought` 深谋远虑要不要在参考侧补升级分支。** 参考的 `Actions::ForethoughtAction`
  把升级那一支整段注释掉了（`Actions.cpp:784-806`），于是升级态退化成未升级行为，
  全升级 variant 会照错的跑。补它**不是转写而是发明**：参考侧只有单选的
  `chooseForethoughtCard(int)`，`FORETHOUGHT` 也只出现在
  `isValidSingleCardSelectAction` / `enumerateCardSelectActions` 的单选分支里，
  多选那一整套（`chooseForethoughtCards` + 多选校验 + 多选枚举）都不存在。
  真实游戏是「把**任意张**手牌置于抽牌堆底，它们在被打出前费用为 0」。
  第七批因此仍然跳过它，连带没有加 `freeToPlayOnce` 字段。
- **四个角色的起始牌组共用同一张 `strike` / `defend`（`color: "red"`）**，而参考区分
  `STRIKE_RED` / `STRIKE_GREEN` / `STRIKE_BLUE` / `STRIKE_PURPLE`。目前无害
  （`rarity: "starter"` 不进任何奖励池，且只有铁甲能打），但这让「起始牌组的牌颜色必须与
  角色一致」这条本来更强的不变量无法成立——上面那条颜色不变量只能退而依赖登记表。
  拆成四份是数据表结构改动，未自行处理。

## 第一幕完成度小结（第二十二批收官：asc0 与 asc19 两档全满）

这一节是**下一条战线的输入**（成对档位 / 第二幕 / 遗物 / 药水）。它回答三个问题：
哪些东西有背书、哪些盲区还是 0、这份数据现在有多大。

### 一、背书覆盖：20 个编队 / 25 只怪，**在 asc0 与 asc19 两个档位上**全部有 trace 背书

harness 的 `encounters` 列表（`trace_dump.cpp`，从第一个 commit 起一个字没改过）就是
**第一幕的 20 个编队**。第十三~~二十批把它们在 asc0 上装完，第二十一~~二十二批又在
asc19 上装了一遍，**没有一个例外**：

| 编队                                                            | asc0 装入 | asc19 装入 | 保留策略           |
| --------------------------------------------------------------- | --------- | ---------- | ------------------ |
| `cultist` `jaw_worm` `jaw_worm_horde` `two_louse` `three_louse` | 一~十二   | 二十一     | `all` / `variant0` |
| `small_slimes` `lots_of_slimes`                                 | 十三      | 二十一     | `variant0`         |
| `large_slime`                                                   | 十四      | 二十一     | `variant0`         |
| `blue_slaver` `red_slaver` `looter` `exordium_thugs`            | 十五      | 二十一     | `variant0`         |
| `exordium_wildlife`                                             | 十六      | 二十一     | `variant0`         |
| `gremlin_gang`                                                  | 十七      | 二十一     | `variant0`         |
| `gremlin_nob` `lagavulin` `three_sentries`                      | 十八      | **二十二** | `variant0`         |
| `the_guardian` `slime_boss`                                     | 十九      | **二十二** | `variant0`         |
| `hexaghost`                                                     | 二十      | **二十二** | `variant0`         |

⚠ 五个 `all` 编队的 asc19 那一份走的是 `variant0` 策略（一份文件里只有一个 variant，
整份冻结）——两条轴的保留策略互不相干。

**25 只怪**（含分裂产生的、以及变体编队里随机抽到的），逐只都在 trace 的怪物快照里出现过：
邪教徒 / 颚虫 / 红虱 / 绿虱 / 酸液史莱姆 S·M·L / 尖刺史莱姆 S·M·L / 蓝奴隶主 / 红奴隶主 /
抢劫者 / 真菌兽 / 狂暴地精 / 鬼祟地精 / 肥胖地精 / 护盾地精 / 地精巫师 / 地精头目 /
拉加维林 / 哨卫 / 守卫者 / 史莱姆王 / 六火幽魂。**25 只的 `ascCalibrated` 现在全是 true。**

**没有背书的怪一只都不剩**——`MonsterIds.h` 剩下的 40 只全部在第二 / 三幕，
按 WORKFLOW 不许动 `encounters` 列表，所以它们要等 harness **追加一遍循环**。
那 40 只在 `ascension > 0` 下仍然**显式抛错**（`ascCalibrated` 闸门留着）。

⚠ 有两处「登记了但覆盖极薄」，不是盲区但值得单列：
`THE_GUARDIAN_VENT_STEAM` 只执行 **4** 次（整条怪物线最薄）、
`SHIELD_GREMLIN_SHIELD_BASH` 只执行 **15** 次。挂在它们身上的变异例数都是个位数，
换布局 / 加编队时要**重量一遍**。

### 二、仍然为 0 的盲区总清单

按「关不掉的原因」分成两类。**每条都附关门条件**——没有关门条件的那些要写明「永远关不掉」，
免得下一个人去找不存在的逃生口。⚠ 「等价改写」（语义不同但当前取值恒等）**不在此列**，
它们在各批自己那一节里单独标着。

#### （甲）结构性不可达——在「第一幕 20 编队 + `ENC_V0`」这条路上永远关不掉

| 盲区                                                                                                        | 批次          | 为什么关不掉                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 尖锐外壳只看 `monsters.arr[0]`                                                                              | 十九          | 全项目只有守卫者 buff `SHARP_HIDE`，而它只出现在单怪编队里——**连关门条件都不存在**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 守卫者形态切换用 `setMove` 还是裸 `moveHistory[0] =`                                                        | 十九          | `onHpLost` 的四支怪一只都不读 `lastMove` / `lastTwoMoves`——**永远关不掉**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 史莱姆王分裂的 `overwriteMove` ↔ `setMove`                                                                  | 十九          | 同上，同一个根                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 燃焰的 `++uniquePower0` 去掉                                                                                | 二十          | 灼烧的三分岔只认 0 与 2，少加一次仍落进同一个 `else`——**永远关不掉**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 灼伤 `DamagePlayer` 的 `clearOnCombatVictory`                                                               | 二十          | `addToTop` 下一步就出队，中间插不进任何能判胜的东西；清扫又只在胜利时跑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 狂暴 / 肥胖 / 尖刺史莱姆小的 `no_op_roll` → `roll`                                                          | 十三/十七     | 它们只有一招，`moveHistory` 推不推进无从观察（反方向 `none` 有 172~289 例背书）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Monster::die` 的「最后一只就 `return`」                                                                    | 十六          | 与 `checkCombat` 的清扫**机制重复**；要一个 `clearOnCombatVictory = false` 的死亡触发，参考里没有                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 缠绕「只封攻击牌」那道门本身                                                                                | 十五          | **重放只走已记录的动作，放宽限制永远不分岔**（反方向「封住所有牌型」红 35 例）。同族：选牌屏三道门、状态牌打不出两道门                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 两次「白吃 RNG」的 bound、抢劫者对白的 `randomBoolean(0.6)`                                                 | 四/十五       | 结果被丢弃，只有**次数**影响计数器（次数已验证）——本质不可验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 三牌堆全空判负、燃烧的 `monstersAlive > 0` 门、炸弹同族的门                                                 | 五/十一       | 怪一死就判胜、走不到回合末结算                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `discardAtEndOfTurnHelper` 的「结局已定就跳过」                                                             | 五            | 要让以太牌的消耗刚好打死最后一只怪，现有内容做不到                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `canUpgradeCard` 的灼热之刃例外、`isStrikeCard` 的三张异色打击                                              | 十一          | 对应内容压根没登记 / 数据表里不存在                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `uint16` 伤害上限 `min(65535, dmg)`                                                                         | 十            | 当前内容打不到 65535                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 嬗变那句「往上抬 `energyOnUse`」                                                                            | 十            | 嬗变**不能与混乱同处一副牌组**（会打出未登记的牌，trace 不可重放）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 一批 uid / master deck / 消耗堆升级位相关的点                                                               | 八~十         | **trace 快照只记牌名**，不记 uid、不记升级位                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 诅咒 / 困惑的 **bool 语义**（置 1 还是累加）                                                                | 二十三/二十五 | 参考里**没有任何内容会施加第二次**：选民的诅咒只在第二个怪物回合出（asc17 是首回合），史尼克的惑目只在首回合（`firstTurn()` 那一支是它唯一的出处）。第一次施加时两种写法结果相同。第二十五批装了史尼克之后**实测确认**仍是 0 例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 困惑那道 `cost >= 0` 门（排除 X 费 -1 与打不出 -2）                                                         | 二十五        | 要么给某个含困惑的 variant 塞一张 X 费牌（旋风斩 / 穿刺 / 强化机体），要么让「会塞状态牌的怪」与史尼克同场。⚠ 本批的 `BATCH_1 + SPOT_WEAKNESS` 里既没有 X 费牌、也没有任何东西塞状态牌，所以这道门当前**结构性不可达**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **镀甲在 `attackedUnblockedHelper` else-if 链上的位置**                                                     | 二十五        | 要一只**同时带镀甲与链上另一个 Power**（蜷缩 / 飞行 / 易塑 / 荆棘 / 沉睡）的怪。⚠ 参考里 buff 镀甲的只有两处——带壳寄生虫与第三幕 Boss **DECA / DONU**（各 3 层），而那两只也不带链上别的 Power。**很可能永远关不掉**。三条探针（往后挪一格 / 挪到链尾 / 改成并列 if）各 0 例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **困惑「改的是 `cost` 而不只是 `costForTurn`」（永久性）**                                                  | 二十五        | 让一张牌在困惑下**跨回合留在手里**（保留 / 深谋远虑），或让一张没被重抽过的牌被打出。⚠ 现在观察不到的原因是闭合的：回合末 `resetAttributesAtEndOfTurn` 把 `costForTurn` 拉回 `cost`（那时手牌已弃），而这张牌下次被抽上来时困惑**又重掷一次**覆盖两个字段。反方向「只改 cost」有 285 例背书                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 吸血攻击的 `m.isAlive()` 判活 / `clearOnCombatVictory = true`                                               | 二十五        | 判活：要让寄生虫在**自己那条吸血动作执行的瞬间**已经死了——荆棘/火焰屏障的反弹走 `addToTop`、排在回血**之后**，做不到。`clearOnCombatVictory`：要让它前面还有一条能判胜的动作，而它是寄生虫那一回合排的第一条。两条都**结构性不可达**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **`CENTURION_FURY` 的效果与收尾**（意图**选择**另有 8 例背书）                                              | 二十六        | ⚠⚠ **本批最大的一条新盲区，而且不是边角。两件事必须分开记**：① 这一招作为**意图**在 375 条里出现 **88 次**，但**全部落在一具已死的百夫长身上**（荆棘 = 青铜鳞片走 `addToTop`，插在它自己那条入队的 RollMove 之前，低血的百夫长先被打死、那次 RollMove 在尸体上执行 → `monstersAlive == 1` → 返回狂怒连斩）。死怪的意图在快照里，所以 `getMoveForRoll` 的 `!mysticAlive` 那一支**有背书**（`mysticAlive` 恒真红 8 例）。② 但死怪永远不会 `takeTurn`，所以它的**效果**（6×3）与**收尾**各 **0 例**。要让活着的百夫长出这一招得让秘法师**先死**，而 `CENTURION_AND_HEALER` 是全参考项目唯一带百夫长的编队（`MonsterGroup.cpp:193-196` 是 `MonsterId::CENTURION` 的唯一出处）、百夫长恒在 0 号位、harness 的策略恒打 `firstAliveMonster` = 0 号位；换牌组救不回来（单体伤害只落在百夫长身上、群伤两只平摊、秘法师每次治疗给两只各回 16 而自己血上限更低）。**关门条件是 harness 的一条新轴：目标策略**（`DeckVariant` 加个默认 0 的字段 → `pickAction` 改用「最右侧的活怪」，文件名加 `@tgt1` 后缀，与爬升度轴同构）。⚠ 真实游戏里「先秒奶妈」是标准打法，这一支在真机上很常见 |
| 百夫长防守的 `monstersAlive > 1` 那道门（false 侧）                                                         | 二十六        | 同一个根：`getMoveForRoll` 在秘法师死后就不再返回防守，所以「只剩自己还出防守」在参考的内容集合里**压根不存在**（与第十九批尖锐外壳的 `arr[0]` 同类，不只是量不到）。实测「只剩百夫长且意图是防守」的帧数 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ~~秘法师鼓舞的连续限制 `!lastTwoMoves(MYSTIC_BUFF)`~~                                                       | 二十六        | 要连着两个怪物回合都「没人缺 16 血」**且**两次都掷到 `roll < 40`。实测 352 次鼓舞里**连续两次的有 0 次**——百夫长 76~80 血、又是唯一挨打的，几乎每回合都缺 ≥16 血，于是强制治疗压倒一切。当时写的关门条件是「一副打不动百夫长的牌组」。✅ **第三十一批用另一条路关掉了（2 例）**：`@tgt1` 把挨打的那只换成秘法师，百夫长因此常年满血，71 次鼓舞里有 4 次连续两次。⚠ 例数很薄，反方向（抄成 `!lastMove`）另有 38 例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **地精首领出招规则里 `lastMove(RALLY)` 的两个分支**（含嵌在其中的 `aiRng.random(50, 99)` 与它的两个返回值） | 二十七        | ⚠⚠ **根在参考自己的形状里，与牌组 / 种子 / 爬升度都无关。** 集结那条 case 是 `addToBot(SummonGremlins()); addToBot(RollMove(idx));`——两条动作**紧挨着入队**，中间插不进任何东西。于是首领的下一次 `getMoveForRoll` 一定跑在「刚填满两格」之后，`getAliveGremlinCount()` 必然 **≥ 2**，直接落进「>1 只」那块，而那块**根本不读 `lastMove(RALLY)`**。两个专门的可达性探针（把两处 `lastMove(rally)` 分别恒假）各 **0 例**，改那次掷骰的区间、乃至整支砍掉也各 **0 例**。⚠ 与第二十二批地精头目 asc18 自锁、第十四批酸液 L 恒假条件同族，但**不是笔误**（形状本身没矛盾，只是被邻居的时序挤死了），故**不报补丁**、照抄。**连关门条件都不在数据这一维上**                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **`Monster::escapeNext`**（四只地精的「首领死了就逃跑」）                                                   | 十七/二十七   | ⚠⚠ **第二十七批装上地精首领之后结的案：从「等下一批数据」升级为「结构性关不掉」。** 首领带 `MINION_LEADER`，`Monster::die` 一命中就判胜并**当场 `return`**（实测首领死 **55** 次、**55 次全部当场判胜**、死后 **0 帧**），小鬼永远轮不到读那一位；而且 `GENERIC_ESCAPE_MOVE` 那条 case 在参考里**是空的**（不置 `isEscapingB`、不减 `monstersAlive`）。逐条判据与两条新的关门条件见「已确认但尚未打补丁」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **开局 `monstersAlive` 把「预留空位」算进去**（3 vs 4）                                                     | 二十七        | 地精首领是唯一一个开局就留空位的编队，而在它身上 `monstersAlive` 的读者全都分辨不了 3 与 4：`=== 0` 判胜走不到（首领带 `MINION_LEADER`，它一死就判胜）、`monstersAlive <= 1`（护盾小鬼的盾击门）要先让首领死、三条「照顾友军」的门这两只怪都没有、`getRandomMonsterIdx` 与燃烧在这副牌组里不出现。实测把它写成数组长度 **0 例**。~~**关门条件**：第二十九批的**收藏家**~~ ✅ **第二十九批关掉了**——`SpawnTorchHeads` 按 `3 - monstersAlive` 决定召几只，`collector` 编队开局是 `monstersAlive = 1 / monsterCount = 3`，把它写成数组长度（3）就一只火炬头都不召，红 **375 例**。⚠ 关掉的是**语义**（「预留空位不算活怪」），地精首领那个编队上的 3 vs 4 仍然分辨不了——但那已经不是独立的盲区了，同一段代码在收藏家身上有背书                                                                                                                                                                                                                                                                                                                                                |
| **工头那次「白掷」的区间**（`hpDiscardRoll` 的上下界）                                                      | 二十七        | ⚠ **结构性不可观测，连「盲区」都算不上**：取值被丢弃，而 `Random::nextLong(n)` 的实际前进步数**与 n 无关**（rejection 循环几乎必然只转一次），所以上下界写什么都逐位等价。**次数**有背书（去掉整条红 375 例），区间没有、也不可能有。与第四 / 十五批那两处「白吃 RNG 的 bound」同族。⚠ 第二十八批在**青铜球**身上重量了一次（抄成高档 `(54,60)`），同样 **0 例**——同一个根                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **停滞的「抽牌堆与弃牌堆都空 → 直接 return」那一支**                                                        | 二十八        | 那一支一次 RNG 都不掷、也不上 `STASIS`。实测 `automaton.jsonl` 里「两堆同时为空」的帧是 **0 个**（22 张牌组打不空两堆；单独「抽牌堆空」的帧有 377 个，所以从**弃牌堆**取那一支是有背书的）。⚠ 顺带**证明了另一条 0 例是等价改写**：出招规则里「已用过停滞」读 `miscInfo` 还是读 `STASIS` power，两者只在这一支上分岔                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **`stasisAction` 里 `notifyRemoveFromCombat`（`strikeCount`）**                                             | 二十八        | `strikeCount` 的唯一读者是**完美打击**的伤害，而 variant 28 的 22 张牌组里没有它；`strikeCount` 本身也不进快照。**关门条件**：让完美打击与青铜自动机同处一副牌组（要新开 variant）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **还牌时「手牌满 10 张改进弃牌堆」那一支**                                                                  | 二十八        | 要求那颗球死掉的**那一帧**手牌恰好 10 张。实测手牌达到 10 张的帧有 47 个，但都不在还牌那一帧。**关门条件**：一副抽牌更凶的牌组                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **伤口塞在 `hpWasLost` 之前还是之后**                                                                       | 二十八        | 这副 22 张牌组里没有任何「失血触发」（破裂 / 燃烧 / 血债血偿都不在），两个位置在这里同解。⚠ 它**不是**可证的等价改写——`hpWasLost` 在参考里真的会入队东西。**关门条件**：一副带破裂或燃烧的牌组与突刺之书同场                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **`STASIS_CARD_INFO` 的稀有度列「不能从 `CardDef.rarity` 派生」**                                           | 二十八        | ⚠⚠ **本批最该记清楚的一条**：两张表在 118 张已映射的牌里有 **15 张不一致**，但那 15 张一张都进不了 `automaton` 的牌堆（variant 28 的牌组三档稀有度两边全一致，而自动机与青铜球都不塞牌），所以「派生」实测 **0 例**。仍然照抄参考、单开一张表，理由是**判据 ③**（形状唯一）而非「量到了」。**关门条件很便宜**：将来某个带青铜自动机的新 variant 的牌组里加**一张**分歧牌（例如 `IMPATIENCE`），或让一只会塞伤口的怪与自动机同场。⚠ 不能改 variant 28 本身（已冻结）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

#### （乙）等下一批数据——有明确的关门条件

| 盲区                                                                                                                                                          | 批次          | 关门条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`isMonsterAttacking` 一族**（17 条，覆盖八批；第二十三批起谓词换成了白名单 `MONSTER_ATTACK_MOVES`，**盲区本身没变**）                                       | 十四~二十三   | 让**觅敌之弱 / 瞄准眼睛**与怪物编队同场。⚠ **全项目最大的一块同质盲区**，一次能关掉十几条。第二十三批实测三个方向各 0 例，见下                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 六重打击「在激活那一刻算定」（读哪个字段 / 在哪一刻读）                                                                                                       | 二十          | 让玩家在第 1~2 个怪物回合就掉血 = 一副带自伤牌的牌组与六火幽魂同场                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 灼伤+（`bc.turn > 8` 那一支）                                                                                                                                 | 二十          | 一场能打到 15+ 回合的六火幽魂战斗 = 一副**打不动人**的牌组                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 灼伤自伤触发破裂（`selfDamage`）                                                                                                                              | 六            | 破裂与灼伤同场（破裂只在 variant 1/2，灼伤的厚背书在 `ENC_V0`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 拉加维林「睡满 3 回合自然醒」                                                                                                                                 | 十八          | 一副打不动人的牌组 + 拉加维林                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 恍惚的 `exhausts` / `cost`                                                                                                                                    | 十八          | 腐化 / 疯狂 / 医疗包与哨卫同场                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 「睡着才上金属化」那道前提                                                                                                                                    | 十八          | `LAGAVULIN_EVENT`（事件版，不置沉睡位）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 怪物神器 × 黑暗镣铐的三条分支                                                                                                                                 | 十二/十八     | 让带神器的编队用上含黑暗镣铐的牌组（改策略为 `all`，或等第二幕带神器的怪）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 孢子云的 `addToTop` ↔ `addToBot`                                                                                                                              | 十六          | 「亡语 + 多条排队动作」并存                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ~~真菌兽出招阈值的下方向（只有上方向 2 例）~~                                                                                                                 | ✅ 二十五     | **已关**：`shelled_parasite_and_fungi` 里真菌兽的仗长得多（这个编队占 110 / 137 例）。实测下方向 **137** 例、上方向 **123** 例，另外两条连续限制 348 / 210 例。不需要 `TWO_FUNGI_BEASTS`                                                                                                                                                                                                                                                                                                                                                                                              |
| 抢劫者逃跑的收尾 `"none"`                                                                                                                                     | 十五          | 让它在**同伴还活着**时逃跑 = `masked_bandits` / `two_thieves`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 偷金的 `min(玩家金币, 额度)` 钳制                                                                                                                             | 十五          | 一只能把玩家偷穷的怪（劫匪 / 第三幕 Transient）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **「同步 ↔ 入队」一族**（烟雾弹加格挡、给友方加格挡、吸魂减益、蓄能加格挡、黏液喷射塞牌、怪物给玩家上减益、激怒 buff、激活/燃焰的 noOpRollMove、燃焰加格挡…） | 十三~二十     | 让那条 case 里效果之后**真的有一条排队动作**。⚠ 第二十批第一次拿到非 0（灼烧的 34 例），所以这一族**不是不可验证**，只是要挑对 case。⚠⚠ **第二十六批把这一族的判据说清了**：`addToBot` 与同步的差别**只在队列非空时**存在，而怪物回合是「队列空了才开始」的（`executeActions` 里 `doMonsterTurn` 的前提就是队列已排空），所以**一条 case 里全部效果都是同步的**时候，把最后一句从同步改成入队是**严格等价**、不是盲区。本批三条 0 例（百夫长防守的加格挡改入队、防守/治疗/鼓舞的收尾 rollMove 改入队）全属于这一类，应记成「等价改写」；真正的盲区只是那些**本身排了队列动作**的 case |
| 多段攻击「伤害只算一次」                                                                                                                                      | 十九          | 「多段攻击」与「段间会改倍率的效果」共存（第二幕自加力量的怪）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `drawToHandAction` 的「候选恰好 1 张就不开屏」                                                                                                                | ‡             | 一副小牌组（旧布局有 20 例，73/85 张下退化成 0）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `exhumeAction` 的「手牌满就整个跳过」                                                                                                                         | ‡             | 掘尸结算那一刻正好 10 张手牌                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 烈焰吐息的诅咒牌分支                                                                                                                                          | 六            | 任何 variant 的牌组里加一张诅咒牌                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 哨兵回能量的「同步 ↔ 入队」                                                                                                                                   | 六            | 让「消耗哨兵」与「读能量的动作」之间夹进第三条动作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 一批「顺序其实无关」的照抄点（第五/六/十一批各若干）                                                                                                          | 五~十一       | 等相关内容登记后自然可观察（各条已在自己那一节写明）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **三档里的中间那一档**（邪教徒仪式 asc2、颚虫咆哮力量 asc2、真菌兽成长 asc2、颚虫军团力量 asc2、护盾地精保护 asc7、虱子蜷缩 asc7、守卫者形态阈值 asc9）       | 二十一/二十二 | **加一个 `9 <= asc <= 16` 的 variant。asc16 一次关掉全部 7 条**（算过，见下方「四、下一步」第 1 条）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **爬升度阈值本身**（分界线恰好是 N 而不是 N±1；血量的 7/8/9 三族尤其）                                                                                        | 二十一/二十二 | **成对档位**。血量三族要 asc7 + asc8（+ asc9 才能钉死 Boss 那条）；招式档要 asc1/2/3/4 与 asc16/17/18/19 各一对                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 地精头目碎颅击的 asc3 伤害档                                                                                                                                  | 二十二        | 参考的 asc18 出招块让碎颅击在 asc>=18 不可达。任何 `asc < 18` 的档位都能让它重新出场（asc16 顺带做掉），或等真实游戏 ground truth 打补丁                                                                                                                                                                                                                                                                                                                                                                                                                                              |

#### （丙）~~**最大的一块结构性盲区不在上表里：爬升度**~~ —— 第二十一/二十二批做掉了主体

~~每只怪都有 asc2 / asc3 / asc4 的伤害档、asc7 的血量档、asc17~19 的出招与数值档，
全部是死代码——harness 固定 `ascension = 0`。~~

**第二十一批开了这条轴**（14 个普通编队 × asc19），**第二十二批铺满了第一幕**
（三精英 + 三 Boss × asc19，做法见 WORKFLOW「爬升度这条轴」）。现状与剩余：

| 状态                                       | 内容                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ 有背书                                  | **20 / 20 个编队、25 / 25 只怪**的 asc 分档（两个方向都有）                                                                                                                                                                     |
| ❌ 仍是盲区：**阈值本身**                  | asc19 钉住的是分档的**两侧行为**，不是「分界线在 N」。血量的 7/8/9 三族实测各 0 例                                                                                                                                              |
| ❌ 仍是盲区：**三档里的中间那档**          | `{a,b,c}` 的 b 在 `{0,19}` 下永远走不到（实测 7 条 0 例，含守卫者形态阈值 asc9）                                                                                                                                                |
| ⚠ **上面两条现在与第二幕合并成同一批**     | 第三十批把第二幕也铺到 asc19，于是第二幕新欠 5 条中间档 + 冠军那两族阈值。关门条件合成一条：**`asc7 + asc16`，跨两幕的一批**（asc16 一次点亮五族中间档、asc7 单独钉住 `[4, 9)`）。逐条推算见「第二幕完成度小结 · 四、下一步 ①」 |
| ❌ 仍是盲区：**碎颅击的 asc3 伤害档**      | 参考的 asc18 出招块让它在 asc>=18 不可达（见「已确认但尚未打补丁」）                                                                                                                                                            |
| ❌ 永远关不掉：**奴隶主的 asc17 内联条件** | 逻辑冗余（`lastTwoMoves ⊆ lastMove`），原作就这么写的（红/蓝各 0，本批重量过）                                                                                                                                                  |

详情与关门条件见「验证方式 · 第二十一/二十二批」与「待裁定」。
⚠ **`EnemyDef` 只装得下一组血量区间**那条已经不成立了——第二十一批加了 `hpHigh`，
并且未校准的怪现在**直接抛错**而不是静默用低档值。那道闸门现在只挡第二 / 三幕的 40 只怪。

### 三、数据体积与例数

| 指标                      | 第二十一批               | 第二十二批               | 第二十三批           | 第二十四批 | 第二十五批         | 第二十六批         | 第二十七批             |
| ------------------------- | ------------------------ | ------------------------ | -------------------- | ---------- | ------------------ | ------------------ | ---------------------- |
| `test/golden/traces` 总量 | 268MB                    | 285MB                    | 302MB                | 302MB†     | 348MB              | 388MB              | **413MB**              |
| 对拍例数                  | 16861                    | 17581                    | 18706                | 19831      | 20956              | 22456              | **23206**              |
| 编队文件数                | 34（20 asc0 + 14 asc19） | 40（20 asc0 + 20 asc19） | 43（+3 第二幕 asc0） | 46         | 49                 | 53                 | **55**                 |
| `variant0` 冻结文件       | 15×375 + 14×120 行       | 15×375 + 20×120 行       | 18×375 + 20×120 行   | 21×375+…   | 24×375 + 20×120 行 | 28×375 + 20×120 行 | **30×375 + 20×120 行** |

† 第二十四批的收尾文档没写完（见「覆盖现状」那一节），那一格的 302MB 是复核时的取整值。
逐文件实测：第二十四批 `chosen_and_byrds` 9.2MB / `three_byrds` 8.9MB / `two_thieves` 6.1MB，
第二十五批 `shelled_parasite_and_fungi` 8.4MB / `shell_parasite` 6.8MB / `snecko` 6.2MB。
⚠ **第二幕的边际成本比第二十三批那三只单怪（各 ~6MB）贵**：带壳寄生虫 14 层镀甲 +
每回合末补格挡，仗长得多；多怪编队更贵。
**第二十六批实测把这条估价改了**：四个**多怪**编队合计 **40MB**——`centurion_and_healer`
11.4MB / `three_cultist` 9.8MB / `cultist_and_chosen` 9.6MB / `sentry_and_sphere` 9.4MB，
即 **~10MB / 多怪编队**，比单怪的 6MB 贵 2/3（怪多 = 每帧快照更大 + 仗更长）。
按 10MB 算，剩下 6 个第二幕编队（三精英 + 三 Boss，成员更多、血更厚）大致 **70~100MB**，
装满第二幕之后总量约 **460~490MB**，再加第二幕爬升度那一批（40 种子，便宜一个量级）。
**第二十七批实测把这条估价又抬了一档**：两个编队合计 **25.5MB**——`gremlin_leader` **16.0MB**、
`slavers` 9.5MB。⚠ 首领那个是**目前第二幕最贵的单个文件**，原因是结构性的：140~148 血的精英
带 3 个随从位、还会**不断把死掉的随从补回来**，仗因此长得多、每帧快照也有 4 格怪。
按「精英 ~13MB / Boss 更贵」重新估，剩下 4 个（刺穿之书 + 三 Boss）大致 **60~90MB**。

- 第二十一批新增的 14 个 `@asc19` 文件合计约 **21MB**，第二十二批的 6 个合计
  **17.7MB**（每个 120 行 = 40 种子 × 3 层）。最大的是 `slime_boss@asc19` 3.8MB、
  `hexaghost@asc19` 3.4MB——**仍比对应的 asc0 文件小一个量级**（`slime_boss.jsonl` 18.3MB），
  因为种子只有 40 个。
- 第二十三批新增的 3 个第二幕文件合计约 **17.3MB**（各 375 行 = 125 种子 × 3 层）：
  `spheric_guardian` 6.0MB、`snake_plant` 5.8MB、`chosen` 5.5MB。
  ⚠ **第二幕单怪的边际成本 ≈ 6MB / 编队**，比第一幕的 Boss（12~~18MB）便宜得多，
  但比 `@asc19` 那种 40 种子的文件（1~~4MB）贵一个量级——种子数是主因。
  按这个单价，剩下 16 个第二幕编队大致 **100~150MB**（多怪编队更贵），
  装满第二幕之后总量约 420~450MB。
- ⚠ **「再加一个中间档位」的边际成本因此是可估的：整份第一幕（20 编队）× 一个档位 ≈ 39MB。**
  加 asc16 之后总量约 324MB，一次关掉「中间档」那 7 条，外加让地精头目的碎颅击
  重新出场。下一批的首选就是它，理由与逐条推算见「四、下一步」。
- 最大的单个文件仍是 `jaw_worm_horde.jsonl`（**48,581,931** 字节 / 46.3MB），
  离 GitHub 的 100MB 硬上限还有一倍余量；其次 `cultist` 38.2MB、`two_louse` 31.9MB。
  ⚠ 会被新聚焦 variant 撑大的只有 `cultist` / `two_louse`（每对约 +5~6MB），
  真要担心 100MB 先担心 `cultist`。
- `ENC_V0` 的 15 个 asc0 文件合计约 **116MB**，每个 375 行。最大的三个是
  `slime_boss` 18.3MB、`hexaghost` 12.2MB、`the_guardian` 11.8MB——都是 Boss，血厚仗长。
- ⚠ **第十三~二十七批只有三次不是纯追加**：第十六批的 `usedEntangle` 补丁改写了
  `red_slaver` / `exordium_thugs`，第二十二批的酸液 L 补丁改写了 `large_slime@asc19`
  的**一行**，第二十六批的 `roll2` 补丁改写了 `shell_parasite` /
  `shelled_parasite_and_fungi`（36 / 46 行）。其余文件在 git 里各只有一份 blob。
  第二十三批与**第二十七批**都是纯追加（`git status` 只有新文件的 `??`、零个 `M`）。

### 四、下一步的三个候选（按「解锁量 / 爆炸半径」排）

1. ~~**爬升度这条轴**~~ ~~**精英与 Boss 的 asc 分档**~~ **第二十一/二十二批已做完**。
   剩下的那一半是 **② 中间档位与成对档位**，而且已经能给出确切的下一步。

   **首选：加 asc16 这一个档位**（第一幕 20 编队 × 40 种子 ≈ 39MB，做法与第二十二批同构：
   **再追加一个 variant 23**，`ascension = 16`，别动 variant 21/22 的 `encounters`）。
   逐条算过，它**一次关掉全部 7 条「中间那一档」**，外加一条本批新发现的：

   | 分档形状                                         | asc0 | asc16       | asc19  |
   | ------------------------------------------------ | ---- | ----------- | ------ |
   | `{a,b,c}[getTriIdx(asc, 2, 17)]`（4 条 asc2 档） | a    | **b** ✅    | c      |
   | `{a,b,c}[getTriIdx(asc, 7, 17)]`（2 条 asc7 档） | a    | **b** ✅    | c      |
   | 守卫者形态阈值 `asc19?40 : asc9?35 : 30`         | 30   | **35** ✅   | 40     |
   | 地精头目的碎颅击（asc>=18 结构性不可达）         | 出场 | **出场** ✅ | 不出场 |

   ⚠ **为什么不是 asc7**：asc7 取不到守卫者那条的中间档（它的分界是 9），
   而 asc16 把 `{2,17}` / `{7,17}` / `{9,19}` 三种分界的中间段一网打尽。
   代价是 asc16 在血量那一维与 asc19 同侧（三族全取高档），一条阈值都钉不住。

   **次选（阈值本身，要成对档位）**：血量三族的分界是 7 / 8 / 9 三个数，
   `{0, 16, 19}` 这三点全都分不开它们（asc0 全低、asc16/19 全高）。要钉死得靠
   **asc7 + asc8**：asc7 = 普通高 / 精英低 / Boss 低（钉住普通那条 7），
   asc8 = 普通高 / 精英高 / Boss 低（钉住精英那条 8）；Boss 那条 9 还要 asc9。
   ⚠ 招式数值档同理，asc1/2/3/4 与 asc16/17/18/19 各要一对——**这是一条很长的路**，
   优先级明显低于「中间档」那一条，因为阈值抄错的概率远低于数值抄错。

   ⚠⚠ **第三十批把这一节的范围改了：这两件事现在跨两幕、要一起做，而且 `asc7` 从「次选」
   升成了「与 asc16 同批」。** 理由是第二幕的冠军身上并存两族阈值
   （防御姿态 `getTriIdx(asc, 9, 19)` vs 暴怒/自夸 `getTriIdx(asc, 4, 19)`），
   **只有落在 `[4, 9)` 的档位分得开**——asc7 顺带就把血量那条「普通=7」也钉住了。
   所以下一批是 **`asc7 + asc16` × 39 个编队（两幕）**，逐条推算与成本见
   「第二幕完成度小结 · 四、下一步 ①」。

2. ~~**给 harness 追加一遍第二幕循环**~~ **第二十三批已做完**（结构 + 头三个编队），
   见下方「第二幕：进度与批次计划」。
3. **遗物（8 / 168）与药水（13 / 42）**——它们与编队正交，`traceIdx` 驱动的轮换已经在跑，
   扩的是轮换表而不是循环结构。

## 第二幕：进度与批次计划

harness 的第二个乘积（`act2Variants × act2Encounters`）从第二十三批起在跑。
`act2Encounters` **已经一次列全了 19 个**第二幕编队，所以后续批次只做两件事：
**追加一个新 variant（filter 到本批编队）** + 把编队名加进 `ENC_V0`。
⚠ 永远不要回头扩某个已有 variant 的 `encounters`——那会平移它之后的一切。

### 已装（**19 / 19**，第二十九批收官）

| 批次       | 编队                                                                                  | 新怪                                | 本批带进来的机制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **二十三** | `spheric_guardian` / `chosen` / `snake_plant`                                         | 3（三只单怪）                       | 壁垒（怪物侧）/ 易塑 / 诅咒 HEX / `hpNoRoll` / `isMoveAttack` 白名单                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **二十四** | `three_byrds` / `two_thieves` / `chosen_and_byrds`                                    | 2（拜鸟 / 劫匪）                    | **飞行**（四处协同）；牌组起加 `SPOT_WEAKNESS` → `isMonsterAttacking` 从此有背书                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **二十五** | `shell_parasite` / `shelled_parasite_and_fungi` / `snecko`                            | 2（带壳寄生虫 / 史尼克）            | **镀甲**（三处协同）/ **困惑**（`CardManager::draw`）/ **吸血攻击** / 同步的真 rollMove                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **二十六** | `centurion_and_healer` / `three_cultist` / `cultist_and_chosen` / `sentry_and_sphere` | 2（百夫长 / 秘法师）                | **友方治疗与增益**（三条「目标写死下标」的原语）/ 只有一句的同步真 rollMove / 唯一读生命值的出招规则；顺带打掉参考的 `roll2` 补丁                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **二十七** | `gremlin_leader` / `slavers`                                                          | 2（地精首领 / 工头）                | **召唤**（往预留空位里填，`monsterCount` 不动）/ `MINION` + `MINION_LEADER`（首领一死当场判胜）/ `hpDiscardRoll`（先白掷一次再掷血）/ 怪物往牌堆塞**伤口**                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **二十八** | `book_of_stabbing` / `automaton`                                                      | 3（突刺之书 / 青铜自动机 / 青铜球） | **召唤的第二族**（`spawnBronzeOrbs`：同步、下标写死 0/2、种类固定、`++monsterTurnIdx`）+ **预留空位的第二种写法**（`monsterCount = 1; …; ++monsterCount`）/ **眩晕与超射线的充能**（`miscInfo` 当 `lastBoostWasFlail`）/ **段数由状态决定的多段攻击**（`times: "miscInfo"`）/ **停滞**（按稀有度加权挑一张牌扣住，球死了还回手牌）/ `PAINFUL_STABS`（每段打穿各塞一张伤口）                                                                                                                                                                                                    |
| **二十九** | `champ` / `collector`                                                                 | 3（冠军 / 收藏家 / 火炬头）         | **召唤的第三族**（`SpawnTorchHeads`：按 `3 - monstersAlive` 决定只数、落位表 `{arr[1].isDying()?1:0, 0}`、`construct` 之后**又显式 `initHp` 一次**、`setMove` 而不是 `rollMove`、末尾按只数 `noOpRollMove`、没有 `++monsterTurnIdx`）+ **预留空位的第三种写法**（`monsterCount = 2; createMonster(...)`，宿主在最后一格）/ **冠军的阶段锁存**（`miscInfo` bit 2，**不在 `Monster::onHpLost` 里**；bit 0~1 兼作防御姿态已用次数）/ **怪物侧 `removeDebuffs`**（写死名单，力量只抬负值）/ **第三种「给玩家上减益」的写法**（裸的 `player.debuff`）/ `MINION_LEADER` 的第三个宿主 |

⚠ 计划表里原先把带壳寄生虫排在第二十四批、`shelled_parasite_and_fungi` 排在第二十六批，
实际是第二十四批做了拜鸟 + 劫匪、第二十五批做了寄生虫 + 史尼克 + 那个组合编队。
把组合编队提前到本批是有理由的：它同时是**孢子云亡语**那条盲区的关门条件
（真菌兽在这里恒有同伴），并且让吸血攻击那个写死的 `arr[0]` 在「有同伴」的局面下也被走到。

⚠ 第二十六批把原计划的「二十六（三个组合编队）+ 二十七（百夫长与秘法师）」**合成了一批**。
理由：那三个组合编队一只新怪都不用写，而 `CENTURION_AND_HEALER` 恰恰需要「多怪局面」这件事
被同一批的其它编队一起量（建怪顺序与写死下标是本批最关键的一处），拆两批反而多一次
全量重生成。四个编队合起来是**一个** variant，代价与三个编队几乎相同。
⚠ 原计划表里那句「秘法师给友军加格挡并治疗，无受伤友军则治自己」是**错的**（照抄了当年
`enemies.ts` 里那份近似注释）：加格挡是**百夫长**干的、给的是秘法师；秘法师的治疗与鼓舞
写死给 `arr[0]` 且**自己也无条件来一份**，不看谁受伤。逐位对齐结果见「验证方式 · 第二十六批」。

### 未装（**0 / 19**）——第二幕的两条维度（asc0 与 asc19）都铺完了

✅ **第三十批把爬升度这一维也铺满了**（variant 30 = 19 编队 × asc19 × 40 种子）。
所以这一节从「编队还剩几个」变成了「档位还缺哪几个」，答案是**中间的档位**：
`asc7 + asc16` 一批，跨第一 / 二幕（见文末「四、下一步」）。

⚠ 第二十八批把原计划的「二十八（只做突刺之书）」与「二十九（三个 Boss）」**重排了**：
那一批做了 `book_of_stabbing` + `automaton` 两个编队。理由是青铜自动机与突刺之书的机制**不重叠**
（一个是召唤 + 充能链、一个是多段 + 塞牌），而三个 Boss 挤在一批的话会同时叠上
「召唤的第三族（火炬头，要额外 `initHp`）」「冠军的二阶段」「收藏家的群体减益」，
体积与机制都太厚。剩下的 `champ` / `collector` 因此各自轻了，第二十九批一批装完。
⚠ 计划表原先把 `STASIS` 记在第二十九批（收藏家那批），实际它跟着青铜球在**第二十八批**到场
——`SummonOrbs` 这个名字在参考里也不存在，青铜球的召唤是 `Monster::spawnBronzeOrbs`。
⚠ 原计划表里「收藏家的群体减益」被当成一条新机制，实际它只是三条普通的
`addToBot(DebuffPlayer)`（虚弱 / 易伤 / 脆弱各 3 层），**一行新代码都不用**；
第二十九批真正的三条新机制是召唤的第三族、冠军的阶段锁存、怪物侧 `removeDebuffs`。

**下一步不在这张表里了**，见文末「第二幕完成度小结 · 四、下一步」。原计划表里的
「三十 = 第二幕的爬升度」仍然是首选候选，它现在的前置条件（第二幕的怪全部装完）已经满足。

| 建议批次    | 编队                                                     | 新怪                   | 为什么这么排                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **二十八**  | `book_of_stabbing`（第二幕最后一个精英）                 | 刺穿之书               | `miscInfo` 的**连刺计数**（`preBattleAction` 里 `++miscInfo` 起步、乱刺按它决定段数）+ `PAINFUL_STABS`（每段塞一张伤口进弃牌堆）。单怪编队、机制只有一族，是最便宜的一批。⚠ 伤口这一路第二十七批已经打通                                                                                                                                                                                                                                                        |
| **二十九**  | `champ` / `collector`（第二幕剩下两个 Boss）             | 冠军 / 收藏家 / 火炬头 | **召唤的第三族**（`Actions::SpawnTorchHeads`，`Actions.cpp:500-527`）：按 `3 - monstersAlive` 决定召几只、**额外单独调 `initHp`**（参考在那行注了 `// bug somewhere in game`）、用 `setMove(TORCH_HEAD_TACKLE)` 而不是 `rollMove`、末尾按只数补 `noOpRollMove`。⚠ 它是全参考项目唯一**直接读 `monstersAlive`** 的地方，所以第二十七批那条「开局 `monstersAlive` 把预留空位算进去」的盲区在这一批关门。另有 `MINION_LEADER` 的第三个宿主（收藏家）与冠军的二阶段 |
| **三十** ✅ | 第二幕的**爬升度**（另开一个 variant，`ascension = 19`） | 0                      | ✅ **已完成**。与第二十一/二十二批同构。⚠ 第二十七批留在这里的那笔账（工头 asc18 那条**多出来的入队自身 buff**）本批兑现了：给 `apply_power on:"self"` 加了 `sync` 位（省略仍是同步，故既有怪零回填），实测「整条去掉 120 例 / 入队↔同步 48 例」。⚠ 本批**没有**做「阈值分辨 + 中间档」——那要中间的档位，见文末                                                                                                                                                 |

⚠ **第二幕能关掉的（乙）类盲区**，选批次时按这个排：

| 盲区                                              | 关门的那一批                      | 怎么关                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 抢劫者逃跑的收尾 `"none"`                         | ✅ 二十四                         | `two_thieves` 里劫匪有同伴，逃跑不会当场判胜（那批的变异表丢了，例数无据）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 偷金的 `min(玩家金币, 额度)` 钳制                 | ✅ 二十四                         | 两只贼各 15，够把玩家偷穷（同上，例数无据）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 孢子云的 `addToTop` ↔ `addToBot`                  | ❌ 仍未关                         | ⚠ **第二十五批试过了、没关掉**：`shelled_parasite_and_fungi` 里真菌兽恒有同伴、亡语真的跑了（易伤层数改 2→3 红 62 例、`isSourceMonster` 改常量红 41 例），但 `addToTop ↔ addToBot` **仍是 0 例**——真菌兽被打死那一刻队列里没有别的动作可以插在中间。关门条件要更具体：**亡语触发时队列里至少还有一条待执行动作**（例如一击同时打死两只带亡语的怪，或亡语与多段攻击的后续段共存）。⚠⚠ **第三十一批把这条根因证死了**：`@tgt1` 让真菌兽「有同伴时死」从 **83 / 375** 涨到 **120 / 120**，触发频率翻了几倍，`addToTop ↔ addToBot` **照旧 0 例**。所以它卡的是「队列内容」这一维，**目标策略轴永远救不了它** |
| 怪物神器 × 黑暗镣铐的三条分支                     | 待定                              | ⚠ **第二十三批没关掉**：球状守卫者走 `ENC_V0`，那副 21 张牌组里没有黑暗镣铐。要么把某个带神器的第二幕编队改成 `ENC_ALL`，要么给它单开一对聚焦 variant                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 真菌兽出招阈值的下方向                            | 待定                              | 仍需 `TWO_FUNGI_BEASTS`——那是**第一幕**的编队，不在 harness 冻结的 20 个里，得再追加一个「第一幕补遗」乘积                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **第二幕 17 只怪的爬升度分档**                    | ✅ **三十**                       | variant 30（19 编队 × asc19 × 40 种子）。逐条例数见「验证方式 · 第三十批」；一批里 34 条数值分档 29 条非 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **`isMoveAttack` 白名单在第二十三批那三个编队上** | ✅ **三十**                       | ⚠ 意外收获：variant 30 的牌组是 `BATCH_1 + SPOT_WEAKNESS`，而它的编队列表**包含** `spheric_guardian` / `chosen` / `snake_plant`（第二十三批那个 variant 的 21 张牌组里没有觅敌之弱）。球状守卫者「硬化」那个反例 **131 例**、多加 `chosen/drain` **147 例**、多加 `snake_plant/sp_spores` **30 例**                                                                                                                                                                                                                                                                                                      |
| **突刺之书 asc18 那两句死代码的 as-built 背书**   | ✅ **三十**                       | 有了 asc19 语料，「不自增」这个行为红 **495 例**（两支还能分开：263 / 432）。⚠ 只证明「我们与参考一致」，**不**证明「参考与真实游戏一致」——那条待裁定保持原状                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **工头 asc18 的入队自身 buff**                    | ✅ **三十**                       | 第二十七批跳过的那条。整条去掉 **120 例**、「入队 ↔ 同步」**48 例**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **「阈值恰好是 N」与「三档的中间那一档」**        | ❌ 仍未关（**跨两幕的同一批**）   | ⚠⚠ 需要**中间的档位**，不是第二个高档位：**asc16** 一次点亮五族的中间档，**asc7** 单独钉住 `[4, 9)`（冠军身上并存的两族阈值只有落在这里才分得开；**asc9 分不开**，两边都返回中间档）。第二十九批那条「asc9 单档」的建议因此更正，逐条推算见文末「四、下一步 ①」                                                                                                                                                                                                                                                                                                                                          |
| **`Monster::escapeNext`**                         | ❌ **永远关不掉**（二十七批结案） | ⚠⚠ **第二十七批装上 `gremlin_leader` 试过了，结论是从此不再等数据**：首领带 `MINION_LEADER`，`Monster::die` 一命中就判胜并当场 `return`（实测死 55 次 / 55 次判胜 / 死后 0 帧），小鬼永远轮不到读那一位；而 `GENERIC_ESCAPE_MOVE` 那条 case 在参考里是空的。**别再把它排进任何批次的计划里**，逐条判据见「已确认但尚未打补丁」                                                                                                                                                                                                                                                                           |
| **开局 `monstersAlive` 把预留空位算进去**         | ✅ **二十九（收藏家）**           | 第二十七批新发现，第二十九批关掉：`SpawnTorchHeads` 按 `3 - monstersAlive` 决定召几只（全参考项目唯一直接读这个数的地方），把它写成数组长度红 **375 例**                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **「同步 ↔ 入队」一族**                           | ✅ 二十七（又一处）               | 第二十批灼烧 34 例之后第二次拿到非 0：工头收尾那次同步 `noOpRollMove` 改成入队红 **5 例**。判据是第二十六批那条**反过来用**——这条 case 的效果**全是入队的**，所以轮到收尾时队列非空。**挑 case 的规则由此确定**：先问「这条 case 自己排了队列动作吗」，排了才可能有背书                                                                                                                                                                                                                                                                                                                                  |

## 第二幕完成度小结（第三十批收官：19 / 19 编队全装，**asc0 与 asc19 两档全满**）

与「第一幕完成度小结」同构。它回答三个问题：哪些东西有背书、哪些盲区还是 0、这份数据现在有多大。
✅ **第三十批把爬升度这一维铺满了**，所以第一幕与第二幕现在**形状完全一致**：
两幕、39 个编队、42 只怪，都在 `{asc0, asc19}` 这一对档位上有 trace 背书。
⚠ 闸门仍然留着（`EnemyDef.ascCalibrated` + `constructMonster` 的 throw +
`ASC_SUPPORTED_ENCOUNTERS`）——第三 / 四幕那 23 只怪一只都没校准，`ascension > 0` 时照旧抛错。

⚠⚠ **「两档全满」不等于「爬升度这条轴做完了」。** 缺的是**中间的档位**，而且它现在是
跨两幕的同一个问题（第一幕欠 7 条、第二幕欠 5 条 + 冠军那两族阈值）：
**`asc7 + asc16` 一批**，见「四、下一步 ①」。

### 一、背书覆盖：19 / 19 个编队、17 只新怪，在 asc0 与 asc19 两个档位上都有 trace 背书

`act2Encounters`（`trace_dump.cpp`）一次列全了 `MonsterEncounterPool` 的第二幕 19 个编队
（5 weak + 8 strong + 3 elite + 3 boss，`MonsterEncounters.h:159-181`）。第二十三~二十九批
七个 variant 把它们装满，**没有一个例外**：

| 批次       | variant | 编队                                                                                  | 新怪                           | 保留策略   |
| ---------- | ------- | ------------------------------------------------------------------------------------- | ------------------------------ | ---------- |
| **二十三** | 23      | `spheric_guardian` / `chosen` / `snake_plant`                                         | 球状守卫者 / 选民 / 食蛇草     | `variant0` |
| **二十四** | 24      | `three_byrds` / `two_thieves` / `chosen_and_byrds`                                    | 拜鸟 / 劫匪                    | `variant0` |
| **二十五** | 25      | `shell_parasite` / `shelled_parasite_and_fungi` / `snecko`                            | 带壳寄生虫 / 史尼克            | `variant0` |
| **二十六** | 26      | `centurion_and_healer` / `three_cultist` / `cultist_and_chosen` / `sentry_and_sphere` | 百夫长 / 秘法师                | `variant0` |
| **二十七** | 27      | `gremlin_leader` / `slavers`                                                          | 地精首领 / 工头                | `variant0` |
| **二十八** | 28      | `book_of_stabbing` / `automaton`                                                      | 突刺之书 / 青铜自动机 / 青铜球 | `variant0` |
| **二十九** | 29      | `champ` / `collector`                                                                 | 冠军 / 收藏家 / 火炬头         | `variant0` |
| **三十**   | 30      | **全部 19 个**（`ascension = 19`，40 种子）                                           | 0（17 只怪的 asc 分档）        | `variant0` |

⚠ variant 23 的牌组是 `BATCH_1`（21 张），**24~30 全都是 `BATCH_1 + SPOT_WEAKNESS`（22 张）**
——多的那一张是唯一读 `isMonsterAttacking` 的牌。七个 variant 牌组逐字节相同，24~~29 靠
「六份 `encounters` 两两不相交」保住 `split-traces.mjs` 的指纹唯一性（见 WORKFLOW）。
⚠⚠ **variant 30 是唯一允许与它们重叠的**（它列全了 19 个）：指纹是「整副牌组 **+ 爬升度**」、
分组键又带 `@asc19` 后缀，所以它的行落进 19 个**新**文件。24~~29 之所以必须两两不相交，
是因为它们的牌组**与爬升度**全都相同。
✅ **于是「球状守卫者与食蛇草的攻击分类没有背书」这条在第三十批关掉了**——variant 30 的
牌组带觅敌之弱，编队列表又包含第二十三批那三个（实测 131 / 147 / 30 例，见「验证方式 ·
第三十批」）。不用走 `ALLOW_CHANGED`，也没有重生成任何已冻结的文件。

**17 只新怪**逐只都在 trace 的怪物快照里出现过：球状守卫者 / 选民 / 食蛇草 / 拜鸟 / 劫匪 /
带壳寄生虫 / 史尼克 / 百夫长 / 秘法师 / 地精首领 / 工头 / 突刺之书 / 青铜自动机 / 青铜球 /
冠军 / 收藏家 / 火炬头。加上第一幕的 25 只，`MOVE_RULES` 现在有 **42 / 65** 只。
⚠ 其中**青铜球与火炬头不在 `MonsterGroup.cpp` 的任何建怪列表里**——唯一来源是召唤。

⚠ **「19 个编队全装」不等于「第二幕的怪全装」**：`MonsterIds.h` 剩下的 23 只里，
除了第三 / 四幕那批，还有**三只挂在事件上**（`MASKED_BANDITS_EVENT` 的 BEAR / POINTY / ROMEO），
以及 `COLOSSEUM_EVENT_*` / `LAGAVULIN_EVENT` / `MUSHROOMS_EVENT` / `MYSTERIOUS_SPHERE_EVENT`
这五个**事件编队**——它们不在任何 `MonsterEncounterPool` 里，要装得再追加一遍乘积
（与「第一幕补遗」的 `TWO_FUNGI_BEASTS` 同一条路）。

### 二、仍然为 0 的盲区总清单（第二幕部分）

按「关不掉的原因」分三类，每条附关门条件。⚠ **「等价改写」不在此列**——语义不同但当前取值
恒等的那些单独标在各批自己那一节里，写成盲区会误导下一个人去找不存在的逃生口。

#### （甲）结构性不可达 —— 在「19 个第二幕编队 + `ENC_V0` + asc0 + `pickAction` 恒打 0 号位」这条路上永远关不掉

| 盲区                                                 | 批次            | 为什么关不掉（详情见各批自己那一节 / 「第一幕完成度小结 · 二」的同名行）                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 诅咒 / 困惑的 **bool 语义**（置 1 还是累加）         | 二十三/二十五   | 参考里没有任何内容会施加第二次。⚠ 第三十批在 asc19 下重量**仍然 0**：asc17 的选民把诅咒挪到**首回合**，依然只有一次                                                                                                                                                                                                                                |
| 困惑那道 `cost >= 0` 门                              | 二十五          | 这副 22 张牌组里既没有 X 费牌、也没有任何东西塞状态牌                                                                                                                                                                                                                                                                                              |
| 镀甲在 `attackedUnblockedHelper` else-if 链上的位置  | 二十五          | 要一只同时带镀甲与链上另一个 Power 的怪，参考里不存在（DECA / DONU 也不带）。**很可能永远关不掉**                                                                                                                                                                                                                                                  |
| 困惑「改的是 `cost`」的永久性                        | 二十五          | 原因是闭合的（回合末复位 + 下次抽牌又重掷）                                                                                                                                                                                                                                                                                                        |
| 吸血攻击的 `isAlive()` 判活 / `clearOnCombatVictory` | 二十五          | 两条都要求「它自己那条动作执行的瞬间它已经死了」，队列形状做不到                                                                                                                                                                                                                                                                                   |
| ~~**`CENTURION_FURY` 的效果与收尾**~~                | 二十六          | ✅ **第三十一批关掉**（目标策略轴，`centurion_and_healer@tgt1` 里 119/120 条秘法师先死，执行 127 帧）：每击伤害 **91** 例 / 段数 **96** 例 / 收尾 **88** 例，出招规则那一支从 8 例涨到 **128** 例，攻击白名单那条另有 **23** 例。⚠ **只剩它的 asc2 伤害档还是 0**（本批只做 asc0），关门条件是 `asc19 × tgt1`，见（乙）                            |
| ~~百夫长防守的 `monstersAlive > 1` false 侧~~        | 二十六          | ✅ **第三十一批关掉（66 例）**。⚠ 机理比「同一个根」细一层：意图是在秘法师**还活着**时滚出来的，执行时它已经死了——这道门要的是「**滚意图与执行之间**同伴死掉」，不只是「同伴先死」                                                                                                                                                                 |
| 秘法师鼓舞的连续限制 `!lastTwoMoves`                 | 二十六          | 352 次鼓舞里连续两次的有 0 次（百夫长几乎每回合都缺 ≥16 血）。关门条件：一副打不动百夫长的牌组                                                                                                                                                                                                                                                     |
| 地精首领出招规则里 `lastMove(RALLY)` 的两个分支      | 二十七          | ⚠ 被同一条 case 里另一句的时序挤死，**连关门条件都不在数据这一维上**                                                                                                                                                                                                                                                                               |
| **`Monster::escapeNext`**                            | 十七/二十七     | ⚠⚠ 两端都堵死，**任何数据都不可能有**（第二十七批结案）                                                                                                                                                                                                                                                                                            |
| 「白掷」那次 `hpDiscardRoll` 的**区间**              | 二十七/二十八   | ⚠ 结构性**不可观测**（取值被丢弃、`nextLong(n)` 的步数与 n 无关）。**次数**有背书。⚠ 第三十批本以为 asc19 能救它（青铜球白掷用低档 `(52,58)`、正式那次用高档 `{54,60}`，两组第一次真的不同）——两只宿主各测一次，**仍然 0 例**。裁定不变                                                                                                            |
| 停滞的「两堆都空 → 直接 return」                     | 二十八          | 22 张牌组打不空两堆（实测 0 帧）                                                                                                                                                                                                                                                                                                                   |
| `stasisAction` 的 `notifyRemoveFromCombat`           | 二十八          | `strikeCount` 的唯一读者是完美打击，不在这副牌组里                                                                                                                                                                                                                                                                                                 |
| 还牌时「手牌满 10 张改进弃牌堆」                     | 二十八          | 要求还牌那一帧手牌恰好 10 张                                                                                                                                                                                                                                                                                                                       |
| 伤口塞在 `hpWasLost` 之前还是之后                    | 二十八          | 这副牌组里没有任何「失血触发」                                                                                                                                                                                                                                                                                                                     |
| **`SpawnTorchHeads` 缺席的 `++monsterTurnIdx`**      | **二十九**      | 收藏家恒在**最后一格**（2 号位），召唤动作出队时游标已经越过 `monsterCount`，加不加都一样。实测加上去 **0 例**。⚠ 这正是参考不需要写它的原因——**照抄「没有」，不要按青铜球那条补**。**永远关不掉**（编队结构写死）                                                                                                                                 |
| **召唤时 `setMove` ↔ `overwriteMove`**               | **二十九**      | 火炬头是全新实体（历史为空，两者同解），而且它的 `rollMove` **永远不会被调用**（参考返回 `INVALID`）→ `moveHistory[1]` 永远没有读者。实测 **0 例**。与第十三批「尖刺小的 `no_op_roll` vs `roll`」同源                                                                                                                                              |
| **`canUseSpawn` 里 `!lastMove(SPAWN)` 的独立作用**   | **二十九**      | 召唤那条 case 是 `addToBot(SpawnTorchHeads()); addToBot(RollMove(idx));` 紧挨着入队 → 下一次 `getMoveForRoll` 必然看到刚填满的 `monstersAlive == 3`，`< 3` 那一半已经恒假。实测去掉它 **0 例**。⚠ 与地精首领的 `lastMove(RALLY)` **同一族**（被邻居时序挤死，不是笔误、不报补丁）；差别是「召唤本身」并非死代码（火炬头被打死后 `< 3` 会再次为真） |
| **防御姿态次数掩码 `miscInfo & 0x3` 在二阶段的作用** | **二十九**      | 二阶段把 bit 2 置上之后，不掩码就等于「次数 >= 4」→ 再也不出防御姿态。实测去掉掩码 **0 例**：158 条进二阶段的 trace 里，要么次数已经到 2、要么二阶段太短没再掷到 `roll <= 15`。**关门条件**：一副能把二阶段拖长的牌组（当前 375 条全负）                                                                                                           |
| **`curHp < maxHp / 2` 的 C++ 整除**                  | **二十九**      | 冠军的 `maxHp` 恒是 **420**（偶数），`420/2` 整除与不整除同解。实测改成 `Math.ceil` **0 例**。⚠ 与第十四批大史莱姆那条不同（那边 65 血是奇数、真的分岔）。**关门条件**：asc>=9 的 440 血也是偶数，所以**永远关不掉**                                                                                                                               |
| **`removeDebuffs` 不碰格挡**                         | **二十九**      | 怪物回合**开始**就清过格挡（`applyStartOfTurnPowers`），暴怒又不加格挡，所以出招那一刻冠军的格挡恒为 0。实测「顺手清格挡」**0 例**                                                                                                                                                                                                                 |
| **暴怒的「清减益 → 加力量」顺序**                    | **二十九**      | 两句只在「力量为负」时分岔（`removeDebuffs` 会把负力量抬回 0），而这副牌组里没有任何东西给怪物负力量（黑暗镣铐 / 卸货都不在）。实测顺序对调 **0 例**。**关门条件**：让黑暗镣铐与冠军同场                                                                                                                                                           |
| **冠军防御姿态的 `getTriIdx(asc, 9, 19)` 分档族**    | 二十九/**三十** | ⚠⚠ 第三十批在 asc19 下重量**仍然 0**，而且把结论加强了：抄成 `bossDiffIdx`（4/19）0 例、抄成 `hallwayIdx`（2/17）**也 0 例**——在 `{0, 19}` 这对档位下**三族两两都不可分辨**。**关门条件：一个落在 `[4, 9)` 的档位**（asc7）。⚠ 第二十九批建议的 **asc9 分不开**（`getTriIdx(9,9,19)` 与 `getTriIdx(9,4,19)` 都返回中间档 1），那条建议已更正       |

⚠ **本批另有一条要标成「探针无效」而不是「0 例」**（判据同第二十八批青铜球那条）：
「召唤之后重跑 `preBattleAction`」实测 0 例，但那是因为**火炬头在
`Monster::preBattleAction` 的 switch 里压根没有 case**，我们这边 `PRE_BATTLE_ACTION.torch_head`
也不存在——`?.()` 是个空操作。它**测不到任何东西**，不能当成「不重跑 preBattleAction 有背书」。
真正有背书的是第二十七批地精首领那条（召唤出来的狂暴小鬼没有狂怒，补上红 300 例）。

⚠ **本批的「等价改写」清单**（0 例但**不是盲区**，别去找逃生口）：

| 改法                                               | 为什么等价                                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 落位表第二格从「恒 0」改成「另一格」               | `spawnCount == 2` 蕴含「1 号位空」（否则 `monstersAlive >= 2`），于是第二格算出来必然是 0。参考写死 0 与算一遍同解，**可证**                                         |
| 召唤从入队改成同步                                 | 这条 case 排的两条动作紧挨着（`SpawnTorchHeads` + `RollMove`），中间插不进任何东西；轮到它时队列本来就空。判据同第二十六批那条                                       |
| `monstersAlive += 1` 从循环内移到循环外            | 循环体里没有任何东西读 `monstersAlive`（`spawnCount` 与 `spawnIdxs` 都在循环前算好）                                                                                 |
| 冠军四条**同步**真 rollMove 改成入队 `"roll"`      | 那四条 case 的效果**全是同步的**（加格挡 / 加力量 / 清减益 / 上减益都不入队），所以轮到收尾时队列已空。⚠ 反方向**不等价**：把入队的三条改成同步红 **375 例**（见下） |
| 火炬头的 `"none"` 改成同步 `setMove("冲撞")`       | 不掷 aiRng，而 `moveHistory` 对它没有读者                                                                                                                            |
| 增幅三句的顺序（把自己的格挡提到最前）             | 三句互不影响（前两格加力量 / 自己加力量 / 自己加格挡），全部同步                                                                                                     |
| 增幅的格挡 `sync` 去掉                             | 同上，这条 case 没有别的入队动作排在它和收尾之间                                                                                                                     |
| 嘲讽两条减益的 `sync` 去掉                         | 同上                                                                                                                                                                 |
| **自动机超射线的 asc4 伤害档**（45 → 50）          | **三十**                                                                                                                                                             | ⚠ **过量杀伤**：asc19 下这一击（+8 力量后 53 或 58）恒把玩家打死，HP 钳到 0 → 快照相同。两个探针证实了这个解释：改成 **80 也是 0 例**，而把基础值砍到 5 红 **471 例**（所以这一招真的落地，不是「没执行」）。**关门条件**：一副能扛住超射线的牌组                  |
| **火炬头血量阈值 9 抄成 7**（按「随从=普通怪」猜） | **三十**                                                                                                                                                             | ⚠ asc19 下两种写法都取高档 → **0 例**。这是第二十二批「单一档位证不了阈值」在第二幕的具体化。守着它的只有 `data-tables.test.ts` 里那张**逐怪期望阈值**表（第三十批把 17 只加进去了）。**关门条件**：`asc7`（那时普通怪取高档、精英与 Boss 取低档，三族第一次分开） |

#### （乙）等下一轮数据 —— 有明确的关门条件

| 盲区                                                  | 批次            | 关门条件                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~**第二幕全部 17 只怪的爬升度分档**~~                | 二十三~二十九   | ✅ **第三十批关掉**（variant 30 = 19 编队 × asc19 × 40 种子）。34 条数值分档里 29 条非 0，逐条见「验证方式 · 第三十批」                                                                                                                                                                                                                                                                                                                                  |
| ~~**`isMoveAttack` 白名单在第二十三批那三个编队上**~~ | 二十三          | ✅ **第三十批关掉**（131 / 147 / 30 例）。variant 30 的牌组带觅敌之弱、编队列表又包含那三个                                                                                                                                                                                                                                                                                                                                                              |
| ~~**工头 asc18 的入队自身 buff**~~                    | 二十七          | ✅ **第三十批关掉**（整条 120 例 / 「入队 ↔ 同步」48 例）。给 `apply_power on:"self"` 加了 `sync` 位，省略仍是同步 → 既有怪零回填                                                                                                                                                                                                                                                                                                                        |
| **「阈值恰好是 N」与「三档的中间那一档」**            | 二十一~**三十** | ⚠⚠ **跨两幕的同一条**，而且要的是**中间的档位**而不是第二个高档位：**asc16** 一次点亮 `{2,17}` / `{7,17}` / `{3,18}` / `{4,19}` / `{9,19}` 五族的中间档，**asc7** 单独钉住 `[4, 9)`（冠军身上并存的两族阈值只有落在这里才分得开；**asc9 分不开**）。第二幕这边新欠 5 条中间档（秘法师鼓舞 `{2,3,4}` / 地精首领鼓舞 `{3,4,5}` / 工头伤口张数 `{1,2,3}` / 冠军暴怒 `{6,9,12}` / 冠军防御姿态 `{15,18,20}` 与 `{5,6,7}`）+ 血量三族阈值。见「四、下一步 ①」 |
| 孢子云的 `addToTop` ↔ `addToBot`                      | 十六/二十五     | 「亡语触发时队列里至少还有一条待执行动作」——第二十五批试过没关掉                                                                                                                                                                                                                                                                                                                                                                                         |
| 怪物神器 × 黑暗镣铐的三条分支                         | 二十三          | 要么把某个带神器的第二幕编队改成 `ENC_ALL`，要么给它单开一对聚焦 variant。⚠ 本批新增两个神器宿主的邻居（收藏家**没有**神器，冠军也没有），所以宿主仍是球状守卫者 / 自动机 / 尖塔盾矛                                                                                                                                                                                                                                                                     |
| 停滞的 `strikeCount`（完美打击）                      | 二十八          | 让完美打击与青铜自动机同处一副牌组（要新开 variant）                                                                                                                                                                                                                                                                                                                                                                                                     |
| 还牌时「手牌满 10 张」/ 伤口 × 失血触发               | 二十八          | 一副抽牌更凶 / 带破裂或燃烧的牌组                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **冠军二阶段里的防御姿态**（次数掩码的作用）          | **二十九**      | 一副能把二阶段拖长的牌组（当前 375 条全负、二阶段只有几个回合）                                                                                                                                                                                                                                                                                                                                                                                          |
| **暴怒抬负力量那一支**                                | **二十九**      | 让黑暗镣铐（或任何给怪物负力量的牌）与冠军同场                                                                                                                                                                                                                                                                                                                                                                                                           |
| **真菌兽出招阈值下方向**（第一幕补遗）                | 十六            | ~~已关~~（第二十五批 137 例）。剩下的第一幕补遗是 `TWO_FUNGI_BEASTS` 这个编队本身                                                                                                                                                                                                                                                                                                                                                                        |

#### （丙）等真机 ground truth —— 不是数据问题，需要第二个信源

| 条目                                                     | 批次            | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 秘法师 asc17 的缺血阈值 21 vs 治疗量 20                  | 二十六          | 三条判据不全过，照抄参考、记待裁定                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 突刺之书 `getMoveForRoll` 里排在 `return` 之后的死代码   | 二十八/**三十** | 死代码的第三种形状，三条判据一条都不过，照抄参考的实际行为（不加）。⚠ **第三十批只改变了「背书状态」，没有改变裁定**：as-built 的行为（不自增）现在红 **495 例**（两支分开量 263 / 432），但那只证明「我们与参考一致」，**证不了「参考与真实游戏一致」**。判据 ③ 仍然不过，**待裁定保持挂着**                                                                                                                                                                                  |
| ~~工头 asc18 那条「多出来的入队自身 buff」~~             | 二十七          | ✅ **第三十批兑现**（不再是待裁定）：给 `apply_power on:"self"` 加了 `sync` 位（**省略仍是同步**，既有 40 余处零回填），照抄参考的 `addToBot`。实测整条 120 例 / 「入队 ↔ 同步」**48 例**                                                                                                                                                                                                                                                                                      |
| **冠军防御姿态用 `getTriIdx(asc, 9, 19)` 而不是 4 / 19** | 二十九/**三十** | 同一只怪身上两族阈值并存，看着像笔误但**判据 ③（修法唯一）不过**——「改成 4/19」与「照抄 9/19」是两种行为，参考自己答不了。**照抄，不报补丁**。⚠ **第三十批的进展与界限**：asc19 给了这两个数值档**行为上的背书**（格挡 / 金属化的 asc19 档各 105 例），但**阈值仍未分辨**——抄成 4/19 与抄成 2/17 都是 0 例。**关门条件写清楚了：一个落在 `[4, 9)` 的档位**（asc7）。⚠ 即便分辨出来了，「参考本该用哪一族」仍要真机 ground truth 才能裁定，所以这一条**留在（丙）**而不是（乙） |

### 三、数据体积与例数

| 指标                      | 第二十三批 | 第二十四批 | 第二十五批 | 第二十六批 | 第二十七批 | 第二十八批 | 第二十九批 | 第三十批 | **第三十一批** |
| ------------------------- | ---------- | ---------- | ---------- | ---------- | ---------- | ---------- | ---------- | -------- | -------------- |
| `test/golden/traces` 总量 | 302MB      | 302MB†     | 348MB      | 388MB      | 410MB      | 432MB      | 456MB      | 507MB    | **566MB**      |
| 对拍例数                  | 18706      | 19831      | 20956      | 22456      | 23206      | 23956      | 24706      | 26986    | **29746**      |
| 编队文件数                | 43         | 46         | 49         | 53         | 55         | 57         | 59         | 78       | **101**        |

- **第二幕 19 个文件合计 172MB**，每个 375 行（125 种子 × 3 层）。逐个：
  `gremlin_leader` **16MB**（最贵）/ `champ` 13MB / `centurion_and_healer` 11MB /
  `automaton` 11MB / `collector` 11MB / `three_cultist` 9.8MB / `cultist_and_chosen` 9.6MB /
  `slavers` 9.5MB / `sentry_and_sphere` 9.4MB / `chosen_and_byrds` 9.3MB / `three_byrds` 9.0MB /
  `shelled_parasite_and_fungi` 8.5MB / `book_of_stabbing` 7.8MB / `shell_parasite` 6.8MB /
  `snecko` 6.2MB / `two_thieves` 6.1MB / `spheric_guardian` 6.0MB / `snake_plant` 5.8MB /
  `chosen` 5.5MB。
- **单价规律（三批实测校准过三次）**：单怪 ~6MB、多怪 ~10MB、精英 ~13MB、**Boss 11~16MB**。
  拉开差距的是**仗的长度 × 每帧快照里的怪数**，不是血量本身——`champ` 是单怪却 13MB
  （420 血把仗拖到均 9.3 回合），`collector` 三格怪却只有 11MB（均 5.5 回合）。
- 最大的单个文件仍是第一幕的 `jaw_worm_horde.jsonl`（46.3MB），离 GitHub 的 100MB 硬上限
  还有一倍余量；第二幕最大的 `gremlin_leader` 只有 16MB。
- ⚠ **第二幕八批里只有一次不是纯追加**：第二十六批的 `roll2` 补丁改写了 `shell_parasite` /
  `shelled_parasite_and_fungi`（36 / 46 行，走 `ALLOW_CHANGED`）。其余七批（含第三十批）
  `git status` 都只有新文件的 `??`、**零个 `M`**。
- **第三十批的 19 个 `@asc19` 文件合计 50.6MB**，每个 120 行（40 种子 × 3 层）。
  逐个（MB）：`centurion_and_healer` 3.9 / `champ` 3.5 / `gremlin_leader` 3.5 /
  `automaton` 3.2 / `cultist_and_chosen` 3.0 / `sentry_and_sphere` 3.0 / `collector` 2.9 /
  `chosen_and_byrds` 2.8 / `three_cultist` 2.7 / `three_byrds` 2.7 /
  `shelled_parasite_and_fungi` 2.4 / `shell_parasite` 2.3 / `slavers` 2.2 / `snecko` 2.2 /
  `book_of_stabbing` 2.1 / `spheric_guardian` 2.1 / `chosen` 2.0 / `two_thieves` 2.0 /
  `snake_plant` 1.9。
- **第三十一批的 23 个 `@tgt1` 文件合计 58.6MB**，每个 120 行（40 种子 × 3 层）。
  **估算 62.1MB、实测 58.6MB，偏差 −5.6%**，估法是「各编队 variant 0 的前 375 行 × 40/125」。
  ⚠ 偏小的方向是可解释的：`gremlin_leader`（估 5.13 → 实测 3.09）与 `collector`
  （3.58 → 2.90）在 tgt1 下被直接打首领，`MINION_LEADER` 当场判胜让仗大幅变短。
  逐个（MB）：`slime_boss` 5.2 / `automaton` 3.5 / `shelled_parasite_and_fungi` 3.3 /
  `slavers` 3.2 / `centurion_and_healer` 3.1 / `three_cultist` 3.1 / `gremlin_leader` 3.1 /
  `jaw_worm_horde` 3.1 / `collector` 2.9 / `sentry_and_sphere` 2.8 / `three_byrds` 2.8 /
  `three_sentries` 2.8 / `cultist_and_chosen` 2.8 / `chosen_and_byrds` 2.7 /
  `gremlin_gang` 2.1 / `two_thieves` 2.0 / `large_slime` 1.9 / `lots_of_slimes` 1.9 /
  `exordium_thugs` 1.6 / `exordium_wildlife` 1.5 / `three_louse` 1.4 / `small_slimes` 1.1 /
  `two_louse` 0.9。
- **单价校准（第三十一批）**：`≈2.5MB / 多怪编队 / 档位`（40 种子），略低于第三十批按
  asc19 量到的 2.7MB——因为这一批全是 asc0（怪血更少、仗更短）。
  ⚠ **一个第二幕档位的实价：50.6MB**（估的是 55~70MB，偏保守了）。折算下来
  **≈ 2.7MB / 编队 / 档位**，正好是同一个编队 asc0 文件（125 种子）的 **32%**
  ——40/125 = 32%，说明**体积几乎线性于种子数**、与爬升度本身无关。
  这条比例可以直接用来估下一批：`asc7 + asc16` 两档 × 两幕（39 编队）≈ **180~200MB**。

### 四、下一步的候选清单（按「解锁量 / 爆炸半径」排，附成本估算）

#### ① ~~第二幕的爬升度~~ ✅ 已完成（第三十批） → 换成「**中间档位** `asc7 + asc16`，跨两幕」

第三十批已经把第二幕铺到 asc19（variant 30 = 19 编队 × 40 种子）。**实际成本 50.6MB**
（原估 55~70MB），三条挂着的账里两条兑现、一条只兑现了一半：

| 挂着的账                        | 结果                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| 工头 asc18 的入队自身 buff      | ✅ 实现并量到（整条 120 例 / 「入队 ↔ 同步」**48 例**）                     |
| 突刺之书 asc18 的段数（死代码） | ✅ as-built 的行为有背书了（**495 例**）；⚠ **裁定不变**，见（丙）          |
| 冠军防御姿态的 9/19 分档族      | ⚠ **只兑现一半**：数值档有背书（各 105 例），**阈值仍未分辨**（0 例）——见下 |

**所以爬升度这条轴剩下的是「中间的档位」，而它是跨两幕的同一个问题。** 下一批：
**追加两个 variant（`asc7` 与 `asc16`），各覆盖第一幕 20 + 第二幕 19 = 39 个编队。**

- **为什么必须是「中间」而不是第三个高档位。** 参考的爬升度条件全是 `asc >= N`，
  所以 `{0, 19}` 这对档位取到的永远是每条分支的两个**端点**。两类东西因此结构性看不见：
  ① **三档效果的中间那一档**（`{a,b,c}[getTriIdx(...)]` 在 0 取 a、在 19 取 c）；
  ② **分界线的位置**（同一族的两种阈值写法在两个端点上同解）。
- **`asc16` 一次点亮五族的中间档**（逐族验算 `getTriIdx(16, ·, ·)` 都返回 1）：

  | 族       | 出处                                       | 宿主举例                                                   |
  | -------- | ------------------------------------------ | ---------------------------------------------------------- |
  | `{2,17}` | `hallwayIdx`                               | 邪教徒仪式、颚虫咆哮、真菌兽成长、颚虫军团力量、秘法师鼓舞 |
  | `{7,17}` | 只有一处                                   | 护盾地精的保护格挡                                         |
  | `{3,18}` | `eliteDiffIdx`                             | 地精首领的鼓舞力量、工头的伤口张数                         |
  | `{4,19}` | `bossDiffIdx`                              | 冠军的暴怒 / 自夸、收藏家的增幅（力量与格挡）              |
  | `{9,19}` | 守卫者的形态阈值、冠军的防御姿态（两个数） | ——                                                         |

  ⚠ 第二十二批算过的「asc16 是首选」现在多了第五族的宿主（冠军防御姿态），
  但结论不变：**`9 <= asc <= 16` 这一段能同时覆盖全部五族**，取 16 是为了顺带把
  「地精头目 asc18 那块出招规则让碎颅击不可达」这条也绕开（asc16 < 18，碎颅击重新出场，
  于是它的 asc3 伤害档第一次有背书）。

- **`asc7` 干的是另一件事：钉住 `[4, 9)` 那一段。** 它是**唯一**能分开冠军身上那两族阈值的
  区间（下表逐档验算）：

  | 档位  | `getTriIdx(asc,9,19)` | `getTriIdx(asc,4,19)` | 分得开吗       |
  | ----- | --------------------- | --------------------- | -------------- |
  | 0     | 0                     | 0                     | ✗              |
  | **7** | 0                     | **1**                 | ✅             |
  | 9     | 1                     | 1                     | ✗ （都是中间） |
  | 16    | 1                     | 1                     | ✗              |
  | 19    | 2                     | 2                     | ✗              |

  ⚠⚠ **第二十九批建议的 asc9 分不开**（两边都返回中间档 1），那条建议已在本节更正。
  asc7 顺带还钉住**血量三族阈值里的第一条**：asc7 下普通怪取高档、精英与 Boss 取低档，
  于是「精英 / Boss 的阈值不是 7」第一次证死（火炬头那条「按随从猜成普通档」的 0 例因此关掉）。
  ⚠ 剩下「精英恰好是 8 而不是 9」还需要 **asc8**，不在这一批范围内——如实记着。

- **爆炸半径：零。** 管线第二十一批就装好了，数据表也已经带着全部三档的数值
  （中间档的数**已经写在 `ascAmount` 里**，只是走不到）。这一批**一行实现都不用改**，
  纯粹是「再生成两个 variant 的数据」。
  ⚠ 仍然要走两步：先跑一次 `--check` 确认 78 个文件逐字节复现，再 `--install`。
- **成本：一批，约 180~200MB。** 按第三十批实测的 **≈2.7MB / 编队 / 档位**
  （第一幕的编队普遍更轻，约 1.5~2MB）估：39 编队 × 2 档 ≈ 180MB，总量会到 **~690MB**。
  ⚠ 如果嫌大，可以只做 `asc16`（一次关掉全部 12 条中间档，≈90MB），把 `asc7` 单独排一批
  ——但那样「冠军两族阈值」还得再等一轮。**两档一起做的理由是它们共用同一次全量重生成。**

#### ~~② 「目标策略」轴~~ ✅ **第三十一批已交付**

第二十六批提出、第三十一批做掉。`DeckVariant` 加一个默认 0 的 `targetPolicy` → `pickAction`
按它选 `firstAliveMonster` / `lastAliveMonster` → trace 头部只在非 0 时输出 →
`split-traces.mjs` 的分组键加 `@tgtN` 后缀 → `ENC_V0` 里加名字。两步验证照做了
（第一步 78 个文件逐字节复现）。实测：**23 个多怪编队 / 2760 例 / 58.6MB**（估 62.1MB），
引擎侧 0 行实现。逐条见「验证方式 · 第三十一批」。

事后回看，当初这一节的三条估计有两条要修正：

- **「解锁量」估对了一半。** `CENTURION_FURY` 的效果与收尾（91/96/88 例）与百夫长防守的
  `monstersAlive > 1` false 侧（66 例）如期关掉，还额外关掉了两条没预料到的
  （`MINION_LEADER` 判胜 4 → 21 例、秘法师鼓舞的连续限制 0 → 2 例）。
  ❌ 但**「一批亡语触发时队列里还有动作」猜错了**：孢子云那条**没关掉**，而且这次证死了根因
  ——触发频率从 83/375 涨到 120/120 仍是 0 例，它卡的是「队列内容」而不是「成员结构」。
- **「成本：半批 / 10~~30MB」低估了。** 只开 `centurion_and_healer` 一个确实够验收，但那样
  就浪费了同一次全量重生成——23 个多怪编队一起开只多花 ~47MB，换来另外三条盲区。
  ⚠ 但「别一次给 19 个编队都开」这句是**对的**：单怪编队跑出来的 trace 与已提交的逐字节相同。
- **⚠⚠ 当初没写、实际最险的一处：新轴必须挂成新的乘积。** 往第一幕那个 `variants` 里追加
  variant 会平移第二幕乘积的全部 `traceIdx`，38 个文件当场作废。详见 WORKFLOW。
  **推论：从此往 `variants` / `act2Variants` 里追加 variant 都不再免费。**

#### ③ 第三幕（编队更多、机制更重）

`MonsterEncounterPool` 第三幕是 3 weak + 8 strong + 3 elite + 3 boss，去重后 **16 个编队**
（其中 `jaw_worm_horde` 已经在第一幕的 `ENC_ALL` 里，所以新文件 15 个）。做法与第二十三批
开第二幕一样：`emitProduct(act3Variants, act3Encounters)` **追加第三个乘积**，
⚠ 必须排在第二幕那个之后，且**先加空循环跑一次 `--check`**。

- **解锁量：剩下的 23 只怪。** 含四类此前完全没有的机制：**形状怪三只 + 尖塔守卫**
  （`SuicideAction` / `EXPLODER_EXPLODE` 的自杀、`SHIFTING` / `FADING`）、
  ~~**蜥蜴法师的召唤（第四族）**~~（第三十六批）、~~**觉醒者的假死与重生**~~（第三十七批）（`isHalfDead`，`Monster::die` 的
  第一个分支，至今零背书）、**时间吞噬者的 `TIME_WARP`**（第一个改回合结构的 Power）。
- **爆炸半径：大。** 假死 / 重生要动 `Monster::die` 的主链与 `alive` 的语义
  （`isDeadOrEscaped` 的三位至今只用到两位）；`TIME_WARP` 要动 `executeActions` 的回合边界。
  ⚠ 这两条都是「共享路径」级别的改动，按 WORKFLOW 的规矩要**一个机制一批**。
- **成本：估 5~8 批**，体积按 Boss ~13MB / 多怪 ~10MB 估约 **150~200MB**。

#### ④ 遗物（8 / 168）与药水（13 / 42） ⚠ 这两个数是第二幕收官时的快照，当前是 87 / 180 与 28 / 42

与编队正交，`traceIdx` 驱动的轮换已经在跑，扩的是**轮换表**而不是循环结构。

- **解锁量：不关任何现有盲区**（唯一的例外是「怪物神器 × 黑暗镣铐」那条——它要的是**卡牌**
  黑暗镣铐而不是遗物）。⚠ 但它会**改写已冻结的数据**：`RELIC_ROTATION` / `POTION_ROTATION`
  的长度一变，`traceIdx % size` 就整体错位，**59 个文件全部作废**。
- **爆炸半径：看着小、实际是全库重生成。** 唯一安全的做法是**往末尾追加**并让轮换按
  「原长度取模」保持不变，或者给新遗物 / 新药水单开一个乘积。**做之前先设计好这一点。**
- **成本：设计 0.5 批 + 每批若干个遗物。** 优先级低于 ①②，因为它不关盲区。

#### ⑤ `asc19 × tgt1`（新出现的一格，很小）

第三十一批把「百夫长狂怒连斩的 asc2 伤害档」从**死结**变成了**可做**：它现在只差
`asc19 × tgt1` 这一个组合。做法是再追加一个 variant 到第三个乘积里
（牌组与 variant 31 相同、`ascension = 19`、`targetPolicy = 1`），文件名会是
`centurion_and_healer@asc19@tgt1`——分组键的后缀顺序早就定死了，不用改任何工具。

- **解锁量：目前只有这一条**（外加把 23 个多怪编队的 asc19 分档在「反过来的死亡顺序」下
  再走一遍，可能顺手掉出几条）。**先只开 `centurion_and_healer` 一个编队**（~1MB），
  量完再决定要不要铺开。
- **爆炸半径：零。** 管线两条轴都装好了，纯数据。

**结论：① → ③ → ④，⑤ 可以顺手夹在任何一批里。** ② 已交付。
⚠ ① 现在的形态是「补两个**中间**档位」（`asc7 + asc16`，跨两幕），实现侧零改动、纯数据，
成本约 180~200MB，关掉 12 条中间档 + 两条阈值。
⚠⚠ **仍然不要在同一批里加两条轴**——两条轴同时加会让「哪一条把数据改坏了」无法定位。
第三十一批就是照这条走的（只动目标策略、爬升度一律 0）。

## 第三幕：进度与批次计划（第三十二批开张）

harness 的**第四个乘积**（`act3Variants × act3Encounters`）从第三十二批起在跑，
挂在目标策略那个乘积之后。`act3Encounters` **已经一次列全了 15 个**第三幕编队
（`JAW_WORM_HORDE` 除外——它是第三幕的，但自第一个 commit 起就在第一幕的冻结列表里，
**第三幕的 variant 绝不能点名它**，否则与第一幕那些 variant 指纹撞号）。
所以后续批次只做两件事：**追加一个新 variant（filter 到本批编队）** + 把编队名加进
`ENC_V0_ACT3`。

~~⚠⚠ **第三幕做完之前，不许在这个乘积后面再挂任何新乘积。**~~
✅ **第三十九批装满第三幕之后这条约束解除了。** 它当年成立的理由是「每一批第三幕都要往
`act3Variants` 里追加一个 variant，而往『不是最后一个』的乘积里追加会平移其后所有
`traceIdx`」——现在 `act3Variants` 不再增长，**第五个乘积可以挂在它后面**。
⚠ 于是当年被它挡住的两个候选（`asc19 × tgt1` 那一格、`asc7 + asc16` 中间档）现在**都能做了**，
连同遗物 / 药水那条战线一起，逐条见文末「第三幕完成度小结 · 四」。
⚠ **规矩本身没变**：新东西一律挂到**最后一个**乘积之后，永远不要往前面的乘积里追加 variant。

⚠⚠ **变通办法（如果真的等不及）**：把新轴的 variant 挂进 **`act3Variants` 自己**
（它是最后一个乘积，往它里面追加是合法的），文件名靠 `@ascN` / `@tgtN` 后缀区分。
代价是那条轴与第三幕共用一个乘积、语义上不整齐，但 `traceIdx` 是安全的。
**没做过，写在这里备查**。

### 已装（**16 / 16**，第三十二~三十九批 ✅ 第三幕收官）

| 批次       | 编队                                                     | 新怪                              | 本批带进来的机制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **三十二** | `three_shapes` / `four_shapes` / `sphere_and_two_shapes` | 3（爆破怪 / 斥力怪 / 尖刺客）     | **怪物侧荆棘 THORNS**（else-if 链第六格、`addToTop`、`clearOnVictory = false`）/ **`suicide`**（`SuicideAction` 走正常伤害路径、**里面没有 `checkCombat`**）/ **`damage_player_non_attack`** / **`add_card` 的 `pile:"draw"`**（每张一次 `cardRandomRng`）/ **两条不同的形状怪抽样路径**（`createShapes` 不放回 vs `getAncientShape` 有放回）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **三十三** | `orb_walker` / `spire_growth` / `maw`                    | 3（暗球游荡者 / 尖塔增生 / 大嘴） | **全是已有原语的新宿主**，一个新的回合结构都没带：`hpDiscardRoll` 的正主（暗球游荡者）/ `hpNoRoll` 的第二个宿主（大嘴）/ 两个新 Power——`GENERIC_STRENGTH_UP`（怪物侧，回合末 +层数 力量，**没有 skipFirst**）与 `CONSTRICTED`（玩家侧，回合末非攻击伤害，**不递减不摘除**）/ 一条新的段数来源 `times: "monsterTurnHalf"`（大嘴的吞噬）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **三十四** | `three_darklings` / `transient`                          | 2（暗影客 / 复形怪）              | **半死（`halfDead`）**——`isDeadOrEscaped` 的第三位，第十五批做逃跑时点名跳过的那一位，本批结清 / **重生（REGROW）**——`Monster::die` else-if 链的**中间格**（第二十八批装停滞时留出的那个空位，链的形状现在钉死了）/ **变换（SHIFTING）**——`attackedUnblockedHelper` 链的**第八格**，外加 `damageUnblockedHelper` 里的独立 if / **消逝（FADING）**——层数 = 还能出手几次，归零那一次排 `SuicideAction(idx, **false**)`（`triggerRelics` 的另一支，**不走死亡链**）。⚠⚠ 顺带挖出 `resetAllStatusEffects` **只清 statusBits、不清数值字段**，残留层数会被下一次 buff 继续加（`PowerInstance.cleared`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **三十五** | `writhing_mass` / `giant_head`                           | 2（蠕动血块 / 巨头）              | **反应（REACTIVE）**——`attackedUnblockedHelper` else-if 链**第五格的另一半**（`hasStatus<MALLEABLE> \|\| hasStatus<REACTIVE>`，进门后两个 if 各判各的；蠕动血块是全项目唯一两者都带的怪，第二十三批留下的账本批结清），外加 `Actions::ReactiveRollMove`（**按层数连滚 N 次意图**、目标写死 `arr[0]`） / **缓慢（SLOW）**——第一条挂在 `onAfterUseCard` 那条共享出牌路径上的怪物侧 Power，三处协同（出牌 +1 / 伤害 ×(1+0.1N)、排在易伤**之前** / 回合末 `setStatus(0)` 清零） / ⚠⚠ **开局 Power 的第三种写法** `setHasStatus(true); setStatus(0);`（**位置上、层数 0**，于是它平时不进快照、所有读点必须用 `hasStatus`） / 两条新原语：`set_misc_info`（植入的标志位）与 `deal_damage.monsterTurnRamp`（**封顶**回合成长，⚠ **首击那一项是负的**）                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **三十六** | `nemesis` / `reptomancer`                                | 3（复仇魔 / 蜥蜴法师 / 匕首）     | 第三幕两个**精英**，原计划的三十六 + 三十七合成一批（理由见下）。**怪物侧 `INTANGIBLE`**——四处协同：`Monster::attacked` 与 `Monster::damage` 的入口各把伤害压成 1（**排在狂怒之前、格挡吸收之前**）、`calculateCardDamage` 末尾 `std::max(damage, 1.0f)`（是**下限**不是上限，位置在飞行之后）、`applyEndOfTurnTriggers` 的**第四句**无条件递减（参考自注「differs from the game in that it always decrements at end of round」）；三条 case 的尾部各有一句 `if (!hasStatus<INTANGIBLE>())` 补层，而**入队 / 同步形状两两不同** / **召唤的第四族**（`Monster::reptomancerSummon`）+ **预留空位的第四种写法**（两个 `++monsterCount` 夹着三次 `createMonster` → 0 与 3 号位空、匕首在 1 / 4、法师在**中间的 2 号位**、`monsterCount = 5`，全参考唯一一个 5 格编队、也是唯一一个「两个空位之间还夹着活怪」的）+ ⚠⚠ **`MonsterGroup::skipTurn`**（全参考项目唯一的写入点：落在游标右边的新匕首本回合不行动）/ `hpDiscardRoll` 的**最后一个宿主**（180~190 先白掷一次），这一族四只怪从此全部登记 / **匕首**是第一个**既预置又召唤**的怪，它的自爆走 `attackPlayerHelper` → **在** `isMoveAttack` 白名单里，与爆破怪的自爆正好是同一条判据的两个方向。⚠ 顺带打掉参考的**萎缩白名单**补丁（第三十五批留下的待裁定） |

| **三十七** | `awakened_one` | 1（觉醒者） | 第三幕第一个 Boss。**两阶段 / 假死**——`Monster::die` 的**第一个分支**（`Monster.cpp:285-292`），那条链上**唯一排在判胜 `return` 之前**的一格，与暗影客的重生（在 `return` 之后）正好是同一个 `halfDead` 字段的两个相反的门；门是**怪种 id + `miscInfo == 0`** 而不是状态位（参考自注 `// todo change to status`），另带全参考怪物侧唯一一次 `bc.cardQueue.clear()` / **CURIOSITY**（⚠⚠ 参考里唯一的读点被**整段注释掉**，是个纯标记，照抄「什么都不做」）/ **怪物侧 REGEN**（`applyEndOfTurnTriggers` 第五句，**一层都不掉**，装完这六句名单封闭）/ **虚无（VOID）** 是第一张「抽到时有效果」的状态牌。⚠⚠ **本批第一次换牌组**：`BATCH_1 + SPOT_WEAKNESS` 下 120 条 trace 一次都没打死过一阶段，四条招式全是「出现 0 / 执行 0」，改成 45 张全升级聚焦牌组才有预言机（见「牌组不是常量」）。⚠ 顺带删掉 `afterMonsterTurns` 末尾那句参考里没有的「怪全灭判胜」 |

| **三十八** | `time_eater` | 1（时间吞噬者） | 第三幕第二个 Boss，本项目第一条**改回合结构**的 Power。**TIME_WARP**——结算点在 `BattleContext::onAfterUseCard`（`:1974-1985`）那条**共享出牌路径**上、且在 `item.triggerOnUse` 那道门里面，读写死的 `arr[0]`：计数到 **11** 的下一张（第 12 张）归零 + `buff<STRENGTH>(2)` + **`callEndTurnEarlySequence()`**（`:2152-2161`，全参考唯一的调用点）。⚠ 三处照抄：阈值是 `== 11` 不是 `>=`；`++timeWarp` 是「局部变量自增之后无人读」的**第 6 种死代码形状**；归零走 `setStatus(0)`（Power 还在位置上）。⚠⚠ `callEndTurnEarlySequence` **在出牌中途结束玩家回合**：排空出牌队列（`autoplay && !purgeOnUse` 的项转成 `TimeEaterPlayCardQueueItem` = 按 `triggerOnUse = false` 走一遍 `onAfterUseCard`，**牌白翻**；其余丢弃）、endTurn 项推**队首**、置 `endTurnQueued`。另有 **DRAW_REDUCTION**（玩家侧：数值住在 `cardDrawPerTurn`、Power 只是 bool 标记、skipFirst 归还排在入队抽牌**之后**）与两条新原语 `set_hp_half_max` / `minAscension` 铺到 `gain_block` + `add_card`。⚠⚠ **牌组第二次为覆盖而设计**，而且**两个方向都要量**（TIME_WARP 数出牌张数、HASTE 看血量）——22 张牌组下 TIME_WARP 触发 122 次却 **120/120 都到不了半血**，HASTE 出现 0 / 执行 0 |

| **三十九** | `donu_and_deca` | 2（迪卡 / 多努） | 第三幕**收官**（16 / 16）。⚠⚠ **编队名与建怪顺序相反**：`createMonster(DECA); createMonster(DONU);`（`MonsterGroup.cpp:235-238`）——迪卡在 **0 号位**、多努在 **1 号位**（我们侧的编队 id 也跟着从 `donu_deca` 改成 `donu_and_deca`）。本批**没有新机制**，带进来的是第二十六批那三条「写死下标」原语的**反例**：百夫长的防守与秘法师的治疗 / 鼓舞全都带 `monstersAlive > 1` 的门，而迪卡的守护方阵（`:1689-1700`）与多努的能量之环（`:1677-1681`）**一道门都没有**，参考还在多努那句行尾自注 `// shouldn't matter if deca is dead`。`buff_ally` 因此加了一位 `noAliveGate` —— ⚠ 与第二十八批青铜球那位**性质不同**：那位当前可证同解，这位**真的走到 false 侧**（迪卡先死 60 / 120，多努照样给尸体 +3 力量，补上门红 **45 例**）。⚠ 守护方阵还有两处与百夫长不同：**自己也加 16**（百夫长一点不加）、两句都是**同步** `addBlock`。⚠ 四条 case 的收尾**全是同步 `setMove`**，`getMoveForRoll` 各返回一个常量 → 整场仗 `rng.ai` **恒是 2**，全参考唯一一个「全员静态循环」的编队；两只**相位相反**。⚠ 迪卡的光束还往**弃牌堆**塞两张恍惚（`MakeTempCardInDiscard`，**不掷 RNG**）。两只**共用同一条 `preBattleAction`**：`buff<ARTIFACT>(asc19 ? 3 : 2)`（⚠ 分档是 **asc19** 不是 asc17）。⚠⚠ **牌组第三次要量**，但量的东西变了：招式覆盖任何牌组都满足，要量的是「迪卡会不会先死」——22 张标准牌组下 **0 / 120**，故逐字节复用第三十八批那 59 张 |

### 未装：**没有了**（第三十九批收官）

原计划表的最后一行（第三十九批 `donu_and_deca`）已交付，逐条见上表与
「验证方式 · 第三十九批」。**下一步不在这张表里了**，见文末「第三幕完成度小结 · 四」。

⚠ 那一行当年写的是「机制上全是已有原语的新宿主（力量 / 神器 / **群体伤害**）」——**「群体
伤害」那半句是错的**：多努的能量之环不是 `apply_power + all_enemies`，而是「写死 0 号位 +
自己、**一道门都没有**」，它是第二十六批那三条**带门**原语的反例。
**教训：排批次时对机制的预判，到真装的时候仍然要回参考逐位重读。**

⚠ **原计划的三十六（`nemesis`）与三十七（`reptomancer`）第三十六批合成了一批。**
理由与第二十六批合并那次同族：两只怪的机制**没有一处重叠**（虚无缥缈住在两条伤害入口 +
`calculateCardDamage` + 回合末触发；召唤第四族住在 `createMonsters` / 一条 takeTurn case /
怪物回合循环），红 diff 仍然指向唯一一只怪；而它们都是**单 variant 就能装下的精英**，
拆两批要多跑一次全量重生成。⚠ 顺带一条：`reptomancer` 那一批本来就要把匕首（`dagger`）
一起写完，而匕首的自爆是爆破怪那条判据的镜像——与复仇魔身上的 `isMoveAttack` 三条
（两条在、灼烧诅咒不在）合起来量，一次把这条谓词的两个方向都补厚了。

⚠ **体积估算**：第三十二批实测 **8.4MB / 3 编队**、第三十三批 **7.4MB / 3 编队**、
第三十四批 **7.4MB / 2 编队**（⚠ 三暗影客一份就 **5.2MB**——**多怪 + 会复活 = 仗长得多**）、
第三十五批 **6.0MB / 2 编队**（两个单怪编队各 3.0MB）、第三十六批 **6.0MB / 2 编队**
（复仇魔 3.0 + 蜥蜴法师 3.1MB）、第三十七批 **7.4MB / 1 编队**、第三十八批 **6.5MB / 1 编队**
、第三十九批 **8.0MB / 1 编队**
（⚠ 三个 Boss 都是「一个编队顶别人两个」——强牌组把仗从 3.6 拉到 7~~9 回合，
而迪卡与多努是**三个里最贵的一个**：500 血的一对 + 每两回合 32 点格挡，均 7.53 回合、
120 条里 87 条打到玩家阵亡）。
✅ **上一批的估算是准的**：给最后这个编队估的是「6~~8MB，总量 ~622MB」，实测 **8.0MB / 622MB**。
第三幕 15 个文件合计 **56MB**，仓库最终 **622MB / 116 个文件 / 31545 条 trace**。
⚠ 第三幕的爬升度是**另一批**（`ascCalibrated` 一只都没置），成本按第三十批实测的
2.7MB / 编队 / 档位算，16 编队一档约 43MB。

### ⚠⚠ 牌组不是常量：第三十七 / 三十八批两次为「让新代码被走到」换牌组

第二十四~三十六批的第二 / 三幕 variant 全部沿用 `BATCH_1 + SPOT_WEAKNESS`（22 张、未升级），
到觉醒者第一次**不够用**——而且不是「薄」，是**结构性没有预言机**。实测（同样 40 种子 × 3 层）：

| 牌组                               | 平均回合 | 一阶段被打死 | `REBIRTH` 执行 |
| ---------------------------------- | -------- | ------------ | -------------- |
| `BATCH_1 + SPOT_WEAKNESS`（22 张） | 3.6      | **0 / 120**  | **0**          |
| 再加 6 张强牌、仍未升级（28 张）   | 3.6      | **0 / 120**  | **0**          |
| 本批的 45 张**全升级**聚焦牌组     | **8.7**  | **46 / 120** | **46**         |

两只邪教徒每回合 +3 力量，加上 Boss 每回合 20~~24，玩家 80 血在第 3~~4 回合就死了——
而一阶段有 300 血 + 每回合 10 点再生。`REBIRTH` / `DARK_ECHO` / `SLUDGE` / `TACKLE`
四条招式因此全是「出现 0 / 执行 0」，`--install` 直接拒绝装。

⚠⚠ **牌组形状由 harness 的策略决定，不是凭强度挑的**，两条都是量出来的：

1. **`pickAction` 严格从左往右花能量**（play hand[0] → 重新从 0 扫），所以一张 **3 费牌只有
   在回合开始时恰好是 hand[0] 才打得出来**。第二次尝试加的恶魔形态 / 壁垒**一点作用都没有**
   （平均回合数一位没变）。⇒ 加的牌一律 **0~2 费**。
2. **`upgradeAll = true`**。升级是最便宜的强化，而且有一张**质变**：极限突破+ **不消耗**，
   于是「翻倍力量」每个循环都能再来一次。配上 4 张觅敌之弱（每张 +4 力量、同样不消耗）
   就是整套伤害引擎。
   ⚠ 铜头+ 恰好 40 格挡、而黑暗回响恰好 40 伤害——第三、四张铜头进去之后
   `SLUDGE` / `TACKLE` 的执行数从 4/4 涨到 18/17。

最终牌组 = `BATCH_1` + 4×觅敌之弱 + 2×极限突破 + 4×幽灵护甲 + 4×铜头 + 2×收割 +
2×剑刃回旋 + 2×直觉 + 2×灵巧 + 2×钢铁闪光（35 张 extra + 10 张起始 = 45 张），全升级。

⚠ **副作用是正面的**：觅敌之弱从 1 张变 4 张，`isMonsterAttacking` 的覆盖**涨**了；
牌组指纹（内容 + 升级位）与其它 variant 全都不同，`split-traces.mjs` 的撞号规则双重满足。

⚠⚠ **第三十八批第二次换牌组，而且带来一条更强的判据：一只怪有几道互相独立的门，
就要各量一条分母。** 时间吞噬者身上有两道：TIME_WARP 数的是**出牌张数**（与伤害无关），
HASTE 的门却是**血量掉到一半**。22 张牌组下 TIME_WARP 已经触发 **122** 次——只看「新机制
被走到没有」会以为够用——可 **120 / 120 条一次都没到过半血**，`TIME_EATER_HASTE`
出现 0 / 执行 0，`--install` 直接拒绝。四副牌组的实测对比见「验证方式 · 第三十八批」。
⚠ 本批还第一次**为一段具体的代码**加牌：`callEndTurnEarlySequence` 的排空循环要求
「`onAfterUseCard` 跑的时候出牌队列非空」，而全项目只有**浩劫**（塞 `autoplay` 项）与
**二连击**（塞 `purgeOnUse && autoplay` 项）能造出这个局面——没有它们那段循环整段不可达。
实测「第 12 张牌恰好是浩劫」发生 41 次 / 23 条 trace，整段循环去掉红 26 例。

⚠ **给下一批的判据**：`--install` 报「出现 0 / 执行 0」时，**先量一眼战斗长度**
（`平均回合` 与「该怪掉到多少血」），再决定是换编队、换牌组还是记盲区。
第三十七批之前所有的「0 例」都靠换编队解决，这是第一次靠换牌组。

### 第三幕的盲区（第三十九批新记的）

| 盲区                                                                                                    | 例数 | 分类                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **迪卡守护方阵的 `noAliveGate`**（给一只**已死的多努**加 16 格挡）                                      | 0    | **盲区（分母为 0）**：实测「多努死而迪卡还活着」**0 / 120**——`pickAction` 恒打 `firstAliveMonster` = 0 号位的迪卡，多努只可能后死。⚠⚠ **关门条件非常具体：`donu_and_deca@tgt1`**（打下标最大的活怪 = 多努）。第三十一批那条轴现成，做起来只是一个新 variant + 一个新文件（~8MB）。⚠ 它的**镜像**（多努的那一位）本批**有背书**（45 例） |
| 两只怪的全部 asc 分档（神器 3 层 / 光束 12 点 / 守护方阵那两句 asc19 镀甲）与第二组血量区间（`hpHigh`） | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错。**本批同样没写 `hpHigh`**。⚠ 反方向都有背书（把 asc 阈值改成 0、让 asc0 也走高档：光束 118 例、神器 120 例、血量 120 例），所以「低侧」是钉死的，缺的只有高侧                                                                                                      |
| **守护方阵 asc19 那两句镀甲本批根本没转写**                                                             | —    | ⚠ **不是盲区，是显式的欠账**（判据同第二十七批工头 asc18 那条）。它是「case 里多出来的一整条语句」，而**给「写死 1 号位的友军」加 Power 目前没有原语**（`buff_ally` 写死的是 0 号位）。半写会引入第二份不实的真相，所以整条留给第三幕铺爬升度的那一批，届时要同时加那条原语                                                             |
| 守护方阵自身格挡的「同步 ↔ 入队」/ 两句的先后                                                           | 0    | **等价改写**（第二十六批那条判据）：这条 case **一个队列动作都没排**；两句写的又是**两个不同对象**的 `block +=`                                                                                                                                                                                                                         |
| 「一次 aiRng 都不掷」这件事本身                                                                         | —    | ⚠ **不需要探针**：`rng.ai` 计数器逐帧进对拍，实测 120 条 trace 的取值集合就是 `{2}`。任何一条收尾抄成 `no_op_roll` / `RollMove` 都当场红 120 例（两个方向都量过）                                                                                                                                                                       |

### 第三幕的盲区（第三十八批新记的）

| 盲区                                                                                                                     | 例数 | 分类                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 时间吞噬者的全部 asc 分档（混响 8 / 头槌 32 / 涟漪的脆弱 / 加速的 32 格挡 / 头槌的两张黏液）与第二组血量区间（`hpHigh`） | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错。**本批同样没写 `hpHigh`**。⚠ 反方向（把这几条的 `minAscension` / `ascAmount` 去掉，让 asc0 也走高档）**都有背书**：32 格挡 50 例、两张黏液 114 例、混响 118 例、头槌 103 例——所以「低侧」是钉死的，缺的只有高侧                                                                                                              |
| `callEndTurnEarlySequence` 里 `exhaustOnUse \|= 当前那张牌 doesExhaust()`                                                | 0    | ⚠ **被短路吃掉，不是盲区也不是笔误**（与带壳寄生虫的 `roll2` 同族）：能走到那一行的项**只可能来自浩劫**，而浩劫排的是 `PlayTopCard(target, **true**)`（`BattleContext.cpp:1369`）→ `item.exhaustOnUse` 恒真，`\|\|` 的右半永远不参与。⚠ **关门条件很具体**：混乱（MAYHEM）排的是 `exhausts = false`（`:2328`），所以「牌组里有 **2 张以上混乱**」时第二项才会带着 `exhaustOnUse = false` 进这一行 |
| 过滤条件里 `!item.purgeOnUse` 那一半                                                                                     | 0    | **等价改写**：参考那条动作对复制项是严格空操作（整项拷贝 → `onAfterUseCard` 顶部 `if (item.purgeOnUse) return;`）。⚠ 它与「整段排空循环去掉」（红 26 例，其中 3 例正是复制项）**不是一回事**——循环有背书，只有这道**冗余的过滤**没有                                                                                                                                                              |
| 过滤条件里「非 autoplay 的项」那一支                                                                                     | 0    | **盲区（分母为 0）**：`onAfterUseCard` 跑的那一刻，出牌队列里只可能有浩劫 / 混乱的 `autoplay` 项与二连击的复制项。关门条件是「一种会往队列里塞非 autoplay 项的内容」——参考里目前没有                                                                                                                                                                                                              |
| endTurn 项推**队首**而不是队尾                                                                                           | 0    | **结构性等价**：上面那个 `while` 刚把队列抽空了，两者同解。任何牌组都分辨不了                                                                                                                                                                                                                                                                                                                     |
| 丢回来那条动作的 `clearOnCombatVictory`（false）                                                                         | 0    | **盲区（分母为 0）**：它是排空循环排出的最后几条动作之一，中间插不进任何能判胜的东西。与灼伤那条同族                                                                                                                                                                                                                                                                                              |
| 时间扭曲读 `arr[0]` / 与缓慢的先后                                                                                       | 0    | **探针无效（结构性）**：时间吞噬者只出现在**单怪**编队里，而全参考没有一只怪同时带时间扭曲与缓慢。与激怒 / 尖锐外壳那两条同族                                                                                                                                                                                                                                                                     |
| 加速门的 `<` vs `<=`                                                                                                     | 1    | **分母极薄**（整个语料只有 1 条 trace 让 `curHp` 恰好落在 228）。⚠ 非 0，所以不是盲区——但**别拿它当「阈值已验证」**，关门条件是更多种子                                                                                                                                                                                                                                                           |
| 加速门里 `maxHp / 2` 的**整数除法**                                                                                      | 0    | **结构性等价**：456 是偶数，`hpHigh` 的 480 也是。任何爬升度都分辨不了                                                                                                                                                                                                                                                                                                                            |
| 涟漪 / 加速那两条 case 的「同步 ↔ 入队」                                                                                 | 0    | **等价改写**（第二十六批那条判据）：两条 case **一个队列动作都没排**。⚠ 反方向有背书：混响 / 头槌的收尾改成同步红 96 例                                                                                                                                                                                                                                                                           |
| 加速四条效果之间的顺序                                                                                                   | 0    | **等价改写**：`removeDebuffs` 不碰血量、`set_misc_info` 不碰血量，三句两两无关。⚠ 真正有背书的是**收尾相对于效果**的顺序（把 rollMove 提到效果之前 = 「加速门挪到最后」那条，红 53 例）                                                                                                                                                                                                           |

⚠ **本批 `isMoveAttack` 两个方向的增量证据（逐条拆开，别只看合计）**：
白名单**漏掉**混响 **80** / 头槌 **59**，两条一起漏掉是 **108**（合计小于逐条之和是因为
同一条 trace 会被多条同时命中）；反方向**多收**涟漪 **49** / 加速 **7**。
✅ 这是第三幕**第一次两个增量方向都非 0**（觉醒者那批的反方向是 0——重生那一招的宿主
`alive` 恒为假）。恒真那个方向是全库数字：**2838 例**（第三十七批是 2784 上下）。

### 第三幕的盲区（第三十七批新记的）

| 盲区                                                                                                          | 例数 | 分类                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 觉醒者的全部 asc 分档（开局 +2 力量 asc4 / 好奇心 2 层 / 再生 15 / 复活血量 320）与第二组血量区间（`hpHigh`） | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错。**本批同样没写 `hpHigh`**。⚠ 复活那条 `asc9 ? 320 : 300` 是与数据表**并列的第二个字面量**，asc0 下两者都是 300 —— 把它写成 `asc9 ? 300 : 320`（即 asc0 取 320）红 46 例，所以**低侧有背书、高侧没有**                      |
| `bc.cardQueue.clear()`（假死时清出牌队列）                                                                    | 0    | **盲区（分母为 0）**：出牌队列只有在「一张牌排了后续出牌项」时才非空（浩劫 / 混乱 / 二连击 / 双持 / 复制），而本批那副 45 张牌组里一张都没有。⚠ 关门条件是「一副带这些牌、又能打死一阶段觉醒者的牌组」——两者兼得不容易，但**不是结构性不可能**                                                  |
| `strength = std::max(0, strength)`（复活那句）                                                                | 0    | **结构性盲区（当前语料）**：觉醒者身上唯一的力量来源是 asc4 那条 +2（asc0 走不到），而 `die` 里的 `removeDebuffs()` 已经把负力量抬回过 0；这副牌组里也没有黑暗镣铐 / 缴械那种降力量的手段。关门条件是「牌组里有降力量的牌 + 在假死与复活之间用掉」                                              |
| `MINION_LEADER` **在觉醒者身上的判胜路径**                                                                    | 0    | **盲区（分母为 0）**：14 次胜利**全部**是「场上一只活怪都不剩」，一次都没出现「二阶段觉醒者死了但邪教徒还站着」。⚠ 去掉这条 buff 红 46 例，但那 46 例量的是**快照里的 power 条目**，不是判胜路径——两件事必须分开记。与蜥蜴法师那条同族（第三十六批），关门条件是 `@tgt1`（先打 2 号位的觉醒者） |
| 好奇心的**效果**（玩家打能力牌 → +力量）                                                                      | —    | ⚠ **不是盲区，是参考自己注释掉的**（`BattleContext.cpp:1909-1912`）。照抄参考的实际行为（什么都不做），记进**待裁定**。补上它没有预言机——预言机就是参考本身                                                                                                                                     |
| 虚无那句 `std::max(0, energy-1)` 的**下限**                                                                   | 0    | **盲区（分母为 0）**：抽到虚无的那一刻能量从来没有恰好是 0。⚠ 抽牌发生在回合开始（能量刚满）或牌效果里，很难落在能量 0 上。关门条件是「回合中途抽牌 + 能量已花光」                                                                                                                              |
| 虚无那句「同步 ↔ 入队」                                                                                       | 0    | **盲区（分母不够）**，⚠ **不是等价改写**：`drawOneCard` 那条路上**真的会排队列动作**（进化的抽牌、烈焰吐息的伤害），只是本批那副牌组里两张都没有。参考在那行自注「游戏里是入队的，但我觉得直接做也行」——照抄参考的**同步**版本。关门条件是「带进化 / 烈焰吐息的牌组」                           |
| 再生在 `applyEndOfTurnTriggers` 里的**位置**（虚无缥缈之后、枷锁之前）                                        | 0    | **等价改写（当前语料）**：没有一只怪同时带再生与镀甲 / 枷锁 / 虚无缥缈。与第三十三批「GSU 的位置」同族                                                                                                                                                                                          |
| `setMove` ↔ `overwriteMove`（假死那句改意图）                                                                 | 0    | ⚠ **结构性等价，不是盲区**：紧接着的 `MOVE_TURN_END` 里那句 `setMove(dark_echo)` 会把 `moveHistory[1]` 重新写成「重生」，两种写法之后的历史**逐位相同**。任何编队都分辨不了                                                                                                                     |
| 重生收尾两句的**顺序**（`setMove` 在 `noOpRollMove` 之前）                                                    | 0    | **等价改写**：`noOpRollMove` 掷完就丢、不读意图                                                                                                                                                                                                                                                 |
| 重生收尾 `noOpRollMove` 的「同步 ↔ 入队」                                                                     | 0    | **等价改写**（第二十六批那条判据）：这条 case **一个队列动作都没排**，入队之后队列里就它一条、立刻出队                                                                                                                                                                                          |
| `isMoveAttack` 白名单**多收 `AWAKENED_ONE_REBIRTH`**                                                          | 0    | **探针无效（结构性）**：意图为「重生」的觉醒者 `alive` 恒为假，而觅敌之弱打的是 `firstAliveMonster`（全死时兜底回 0 号位）——**那道谓词永远不会拿重生去问**。反方向（漏掉五条攻击招）逐条都有背书，见下                                                                                          |

⚠ **本批 `isMoveAttack` 两个方向的增量证据（逐条拆开，别只看合计）**：
白名单**漏掉**斩击 **66** / 灵魂打击 **48** / 黑暗回响 **16** / 污泥 **8** / 冲撞 **4**，
五条一起去掉是 **90**（合计小于逐条之和是因为同一条 trace 会被多条同时命中）；
反方向（多收重生）**0 例**，理由见上表。

### 第三幕的盲区（第三十二批记的）

| 盲区                                           | 例数  | 分类                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 尖刺客开局荆棘的 `{3,4,7}` 三档                | 0 / 0 | **结构性盲区**：本批只做 asc0，中间档与高档都走不到（`ascCalibrated` 未置，asc>0 直接抛错）。关门条件与两幕的中间档同批                                                                                                                                                   |
| 爆破怪 / 斥力怪 / 尖刺客的 `asc2` 伤害档       | 0     | 同上                                                                                                                                                                                                                                                                      |
| 三只形状怪的第二组血量区间（`hpHigh`）         | 0     | 同上——**本批干脆没写** `hpHigh`（`data-tables.test.ts` 有一条用例守着「没标 `ascCalibrated` 就不许带 `hpHigh`」）                                                                                                                                                         |
| 尖刺客的封顶逻辑（`miscInfo > 5`）             | 1     | **分母太薄**：整个语料只有 **1 / 360** 条 trace 攒满六次尖刺（荆棘到 15 层）。三条相关变异（去掉那一半 / 阈值 ±1 / `++miscInfo` 挪位置）各红 1 例，**是同一个薄分母，不是三份独立背书**；括号优先级那条因此干脆 0 例。关门条件是「更耐打的编队」——第三幕后面的精英 / Boss |
| 撞击收尾的「同步 ↔ 入队」                      | 0     | **分母太薄，不是等价改写**：机理与自爆那条（红 20 例）相同，只是撞击才 9 点、几乎打不死玩家                                                                                                                                                                               |
| 荆棘在 else-if 链上的**位置**                  | 0     | **结构性盲区**：全参考项目只有尖刺客带 THORNS，它身上没有链上前五位中的任何一位——**没有任何编队能分辨**。蠕动血块（易塑 + 反应）也不带荆棘                                                                                                                                |
| 自杀的 `checkCombat`（`SuicideAction` 里没有） | 0     | **等价改写（当前语料）**：它是那条 case 最后一条排队动作。关门条件与孢子云那条同族——「队列内容」这一维                                                                                                                                                                    |

### 第三幕的盲区（第三十四批新记的）

| 盲区                                                                       | 例数 | 分类                                                                                                                                                  |
| -------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 暗影客硬化的 asc17 力量（+2）/ 撕咬的 asc2 加成（+2）/ 啃食的 asc2 档（9） | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错                                                                                   |
| 暗影客 `miscInfo` 的 asc2 区间（9~13）                                     | 0    | 同上。⚠ 与 `hpDiscardRoll` 的「白掷区间」不同——**这一掷的取值真的被用**（当撕咬伤害），所以只要开了 asc 轴它立刻就有背书                              |
| 复形怪消逝的 asc17 档（6）/ 重殴起点的 asc2 档（40）                       | 0    | 同上                                                                                                                                                  |
| 两只怪的第二组血量区间（`hpHigh`）                                         | 0    | 同上——本批同样没写 `hpHigh`（⚠ 复形怪压根不该有：它是 `hpNoRoll`，`data-tables.test.ts` 那条用例反过来守着）                                          |
| **变换在 `attackedUnblockedHelper` else-if 链上的位置**                    | 0    | **结构性盲区**：全参考项目只有复形怪带 SHIFTING，而它身上没有链上前七位中的任何一位——**没有任何编队能分辨**。与第三十二批「荆棘在链上的位置」完全同族 |
| **「打不赢了」判负门的复形怪例外**（`arr[0].id != TRANSIENT`）             | 0    | **盲区（分母为 0）**：复形怪的仗只有 3~4 回合，22 张牌打不空三个牌堆。关门条件是「一副能自己把牌打光的牌组」（净化 / 恶魔烈焰那一族）                 |
| ~~贤者之石给复活的暗影客 +1 力量~~                                         | 0    | ✅ **第四十批关掉**（`three_darklings@relic1`）                                                                                                       |

### 第三幕的盲区（第三十六批新记的）

| 盲区                                                                                                             | 例数        | 分类                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三只怪的全部 asc 分档（多重打击 7 / 灼烧 5 张 / 毒牙 16 / 巨口 34 / **召唤 2 只**）与第二组血量区间（`hpHigh`）  | 0           | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错。**本批同样没写 `hpHigh`**                                                                      |
| **`reptoSummonHelper` 的 `searchOrder` 第 4 项（`0` 号位）**                                                     | 0           | **结构性盲区（asc0）**：轮到它要 4 / 1 / 3 三格都占着（`monstersAlive == 4`），与出招门 `monstersAlive < 4` **直接冲突**。⚠ 关门条件是 **asc >= 18**（一次召 2 只） |
| 召唤的 `++monstersAlive` / `noOpRollMove` **在循环内还是循环外**                                                 | 0           | **探针无效（asc0 只召 1 只）**：循环只跑一次，两个位置同解。⚠ 这恰恰是第四族与收藏家的区别所在，**要等 asc >= 18 那一批才有背书**                                   |
| 复仇魔出招规则里**两处「被前一句挤死」的条件**（第一档 `lastTwoMoves(ATTACK)` / 第二档 `eitherLastTwo(SCYTHE)`） | 0           | **结构性盲区（不是笔误）**：走到那里的前提已经把 `moveHistory` 钉死。与第二十七批地精首领的两个 `lastMove(RALLY)` 同族——**照抄、不报补丁**，任何编队都关不掉        |
| 虚无缥缈钳制**相对于格挡吸收 / 狂怒的位置**                                                                      | 0           | **盲区（分母为 0）**：复仇魔没有任何加格挡的招式，也不带狂怒。关门条件是「一只同时带虚无缥缈与格挡（或狂怒）的怪」——参考里没有                                      |
| 虚无缥缈钳制的内层 `damage > 0`                                                                                  | 0           | **结构性等价**：`calculateCardDamage` 对虚无缥缈的目标返回至少 1，这条路上取不到 0                                                                                  |
| `calculateCardDamage` 里虚无缥缈**相对于飞行的位置**                                                             | 0           | **探针无效**：没有一只怪同时带飞行与虚无缥缈                                                                                                                        |
| ~~匕首自爆的 `triggerRelics` 这一位~~                                                                            | 0 → **116** | ✅ **第四十批关掉**（地精之角 + `reptomancer@relic1`）                                                                                                              |
| `MINION_LEADER` 在蜥蜴法师身上的判胜路径                                                                         | 0           | **盲区（分母为 0）**：法师 180~190 血，这副 22 张牌组 120 / 120 都打不死它                                                                                          |
| ~~贤者之石给召唤出来的匕首 +1 力量~~                                                                             | 0           | ✅ **第四十批关掉**（`reptomancer@relic1`）                                                                                                                         |
| 法师 `hpDiscardRoll` 的**区间**                                                                                  | 0           | ⚠ **不是盲区，是结构性不可观测**（第二十七批已证）。**次数**有背书（120 例）                                                                                        |

### 第三幕的盲区（第三十五批新记的）

| 盲区                                                                                                   | 例数 | 分类                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两只怪的 asc 分档（重抽 38 / 乱抽 9 / 挥击 16+18 / 萎缩 12 / 时候到了 40）与第二组血量区间（`hpHigh`） | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错。**本批同样没写 `hpHigh`**                                                                                                                  |
| `monsterTurnRamp` 的 **`cap`**（6）                                                                    | 0    | **盲区（分母不够）**：巨头这个编队最长 7 个玩家回合，`min` 左边最大才 **2**——连把 cap 抄成 2 都测不出来。关门条件是更耐打的编队，与第三十二批尖刺客封顶那条同族                                                 |
| `monsterTurnRamp` 的**负数分支**（`std::min` 不夹下界）                                                | 0    | ⚠⚠ **结构性盲区，任何编队都关不掉**：出招门读的是「滚意图那一刻」的回合数、成长读的是「执行那一刻」的，两者差一个怪物回合，所以执行时那一项恒 ≥ 0。**这条差点被写成「有背书」，判据见「三条给下一个人的结论」** |
| 缓慢倍率在乘法链上的**位置**（易伤之前）                                                               | 0    | **等价改写（当前语料）**：巨头身上没有飞行 / 虚无缥缈。关门条件是「一只同时带缓慢与飞行的怪」——参考里没有                                                                                                       |
| 缓慢 +1 与 `purgeOnUse` 提前返回的**相对位置**                                                         | 0    | **盲区（分母为 0）**：这副 22 张牌组里没有二连击。关门条件是「带二连击的牌组」                                                                                                                                  |
| 反应 / 缓慢都只读 `monsters.arr[0]`                                                                    | 0    | **探针无效（结构性）**：两个宿主都只出现在**单怪**编队里，与激怒 / 尖锐外壳那两条同族且更彻底                                                                                                                   |
| ~~植入那条遗物分支（御守 / 暗石护符 → `increaseMaxHp(6)`）~~                                           | 0    | ✅ **第四十批关掉**（`writhing_mass@relic2` / `@relic3`）                                                                                                                                                       |
| ~~**萎缩不在 `isMoveAttack` 白名单里**~~                                                               | 24   | ✅ **第三十六批已打补丁关掉**（三条判据全过）。回退补丁仍红 24 例，见「已修正（参考侧已打补丁）」                                                                                                               |

### 第三幕的盲区（第三十三批新记的）

| 盲区                                                                      | 例数 | 分类                                                                                                                                            |
| ------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 暗球游荡者 `GENERIC_STRENGTH_UP` 的 asc17 档（5）                         | 0    | **结构性盲区**：本批只做 asc0，`ascCalibrated` 未置、asc>0 直接抛错。关门条件与两幕的中间档同批                                                 |
| 尖塔增生缠绕 / 大嘴咆哮 / 大嘴流涎的 asc17 档                             | 0    | 同上                                                                                                                                            |
| 三只怪的 `asc2` 伤害档（激光 11 / 利爪 16 / 急冲 18 / 重砸 25 / 重击 30） | 0    | 同上                                                                                                                                            |
| 尖塔增生出招规则里 `asc17 \|\| roll >= 50` 的**左半**                     | 0    | 同上——asc17 时缠绕不看 roll，asc0 走不到                                                                                                        |
| 三只怪的第二组血量区间（`hpHigh`）                                        | 0    | 同上——**本批同样没写** `hpHigh`                                                                                                                 |
| `hpDiscardRoll` 的**区间**（90~~96 抄成 92~~102）                         | 0    | ⚠ **不是盲区，是结构性不可观测**（第二十七批已证）：取值被丢弃，`Random::nextLong(n)` 的前进步数与 n 无关。**次数**有背书（120 例）             |
| GSU 结算在 `applyEndOfRoundPowers` 里的**位置**                           | 0    | **等价改写（当前语料）**：没有一只怪同时带仪式与它。⚠ 与第三十二批「荆棘在 else-if 链上的位置」同族，但那条是**结构性**的（全项目只有一个宿主） |
| 束缚结算在玩家 Power 枚举序里的**位置**                                   | 0    | **等价改写（当前牌组）**：`applyEndOfTurnPowers` 的循环里这副 22 张牌组只能命中束缚一条。关门条件是「一副同时带缠绕 / 灵活 / 燃烧的牌组」       |

## 第三幕完成度小结（第三十九批收官：16 / 16 编队全装，**只有 asc0 这一档**）

与「第一幕 / 第二幕完成度小结」同构。它回答四个问题：哪些东西有背书、哪些盲区还是 0、
这份数据有多大、下一条战线怎么开。

⚠⚠ **与前两幕的形状差一维，这是本幕最重要的一句话**：第一幕（第二十二批）与第二幕
（第三十批）都在 `{asc0, asc19}` **两个档位**上有背书，而**第三幕只有 asc0**。
`EnemyDef.ascCalibrated` 的闸门在第三幕 17 只怪身上**一只都没置**，
`constructMonster` 在 `ascension > 0` 时照旧抛错。补它是独立的一批（见「四、下一步 ②/③」）。

### 一、背书覆盖：16 / 16 个编队、17 只新怪，在 asc0 这一个档位上有 trace 背书

`act3Encounters`（`trace_dump.cpp`）一次列全了 **15** 个——第 16 个是 `JAW_WORM_HORDE`：
它按 `MonsterEncounterPool` 是第三幕的，但**自第一个 commit 起就在第一幕那份冻结的
`encounters` 列表里**，所以第三幕的 variant **绝不能点名它**（会与第一幕那些 variant 指纹撞号）。
第三十二~三十九批八个 variant 把 15 个装满，**没有一个例外**：

| 批次       | variant | 编队                                                     | 新怪                              | 牌组                         |
| ---------- | ------- | -------------------------------------------------------- | --------------------------------- | ---------------------------- |
| **三十二** | 32      | `three_shapes` / `four_shapes` / `sphere_and_two_shapes` | 3（爆破怪 / 斥力怪 / 尖刺客）     | `BATCH_1 + SPOT_WEAKNESS`    |
| **三十三** | 33      | `orb_walker` / `spire_growth` / `maw`                    | 3（暗球游荡者 / 尖塔增生 / 大嘴） | 同上                         |
| **三十四** | 34      | `three_darklings` / `transient`                          | 2（暗影客 / 复形怪）              | 同上                         |
| **三十五** | 35      | `writhing_mass` / `giant_head`                           | 2（蠕动血块 / 巨头）              | 同上                         |
| **三十六** | 36      | `nemesis` / `reptomancer`                                | 3（复仇魔 / 蜥蜴法师 / 匕首）     | 同上                         |
| **三十七** | 37      | `awakened_one`                                           | 1（觉醒者）                       | ⚠ **45 张全升级**（换了）    |
| **三十八** | 38      | `time_eater`                                             | 1（时间吞噬者）                   | ⚠ **59 张全升级**（又换了）  |
| **三十九** | 39      | `donu_and_deca`                                          | 2（迪卡 / 多努）                  | ⚠ **复用第三十八批那 59 张** |

**17 只新怪**逐只都在 trace 的怪物快照里出现过：爆破怪 / 斥力怪 / 尖刺客 / 暗球游荡者 /
尖塔增生 / 大嘴 / 暗影客 / 复形怪 / 蠕动血块 / 巨头 / 复仇魔 / 蜥蜴法师 / 匕首 / 觉醒者 /
时间吞噬者 / 迪卡 / 多努。加上第一幕 25 只、第二幕 17 只，`MOVE_RULES` 现在有 **59 / 65** 只。
⚠ 匕首是第一个**既预置又召唤**的怪（青铜球 / 火炬头只有召唤这一个来源）。

**三幕合计**（这是这份语料现在的全部）：

| 维度             | 第一幕    | 第二幕    | 第三幕                  | 合计                        |
| ---------------- | --------- | --------- | ----------------------- | --------------------------- |
| 编队             | 20        | 19        | **16**（15 + 颚虫军团） | **54 / 63** 已登记          |
| 新怪             | 25        | 17        | **17**                  | **59 / 65** 已登记          |
| 爬升度档位       | asc0 + 19 | asc0 + 19 | **只有 asc0**           | 部分笛卡尔积                |
| 目标策略 `@tgt1` | 11 个多怪 | 12 个多怪 | **0 个**                | 23 / 39（第三幕一个都没有） |

⚠ **「16 个编队全装」不等于「第三幕的怪全装」，也不等于这份语料完备**。三条缺口：
① **爬升度**（本幕 17 只怪一只都没校准）；② **目标策略**（第三幕一个 `@tgt1` 文件都没有，
而它恰恰是本幕好几条盲区的关门条件）；③ 剩下的 **6 只怪 / 9 个编队**在第四幕与事件里。

### 二、仍然为 0 的盲区总清单（第三幕部分）

按「关不掉的原因」分三类，每条附**关门条件**。
⚠ **「等价改写」与「探针无效」不在此列**——它们单独标在各批自己那一节里，写成盲区会误导
下一个人去找不存在的逃生口。三种的判据分别是：
**盲区** = 形状有可观察面、只是当前语料走不到；
**等价改写** = 两种写法在**任何**语料下同解（要能给出证明）；
**探针无效** = 那次变异根本没落在被测路径上（第三十六批的匕首 `preBattleAction` 是典型）。

#### （甲）结构性不可达（永久）—— 在「参考的内容集合 + 这条管线」下**任何数据都关不掉**

| 盲区                                             | 批次                 | 为什么永远关不掉                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **荆棘在 `attackedUnblockedHelper` 链上的位置**  | 三十二               | 全参考只有尖刺客带 THORNS，而它身上没有链上前五位中的任何一位。蠕动血块（易塑 + 反应）也不带荆棘 → **没有任何编队能分辨**                                                                                                                                                |
| **变换（SHIFTING）在同一条链上的位置**           | 三十四               | 同族：全参考只有复形怪带它，而它身上没有前七位中的任何一位                                                                                                                                                                                                               |
| **`GENERIC_STRENGTH_UP` 在回合末结算里的位置**   | 三十三               | 全参考只有暗球游荡者带它，没有一只怪同时带仪式与它                                                                                                                                                                                                                       |
| **怪物侧再生在 `applyEndOfTurnTriggers` 的位置** | 三十七               | 没有一只怪同时带再生与镀甲 / 枷锁 / 虚无缥缈                                                                                                                                                                                                                             |
| **缓慢倍率在乘法链上的位置（易伤之前）**         | 三十五               | 巨头身上没有飞行 / 虚无缥缈；参考里也没有一只怪同时带缓慢与它们                                                                                                                                                                                                          |
| **反应 / 缓慢 / 时间扭曲只读 `arr[0]`**          | 三十五/三十八        | 三个宿主都只出现在**单怪**编队里。与第十八批激怒、第十九批尖锐外壳同族                                                                                                                                                                                                   |
| **虚无缥缈钳制相对于格挡吸收 / 狂怒的位置**      | 三十六               | 复仇魔没有任何加格挡的招式，也不带狂怒；参考里没有第二只带虚无缥缈的怪                                                                                                                                                                                                   |
| **复仇魔出招规则里两处「被前一句挤死」的条件**   | 三十六               | 走到那里的前提已经把 `moveHistory` 钉死。与第二十七批地精首领的 `lastMove(RALLY)` 同族——**照抄、不报补丁**                                                                                                                                                               |
| **`hpDiscardRoll` 白掷那次的区间**               | 三十三/三十六        | ⚠ **不是盲区，是结构性不可观测**（第二十七批已证）：取值被丢弃，而 `Random::nextLong(n)` 的前进步数与 n 无关。**次数**有背书                                                                                                                                             |
| **`monsterTurnRamp` 的负数分支**                 | 三十五               | ⚠⚠ 出招门读的是「滚意图那一刻」的回合数、成长读的是「执行那一刻」的，**两者差一个怪物回合**，所以执行时那一项恒 ≥ 0。任何编队都关不掉                                                                                                                                    |
| **加速门里 `maxHp / 2` 的整数除法**              | 三十八               | 456 是偶数，`hpHigh` 的 480 也是。**任何爬升度都分辨不了**                                                                                                                                                                                                               |
| **`callEndTurnEarlySequence` 把 endTurn 推队首** | 三十八               | 上面那个 `while` 刚把队列抽空，推队首与推队尾同解                                                                                                                                                                                                                        |
| ~~**贤者之石 / 御守 / 暗石护符那几支**~~         | 三十四/三十五/三十六 | ✅ **第四十批全部关掉**：variant 现在能点名遗物，不必再靠那八个轮换。例数见「验证方式 · 第四十批」。⚠ **这一行原本还该收着活体样本，但它不是同一类问题**——参考给它排了一个没有任何消费者的 InputState，属于「参考没实现完」，永久没有预言机，单独记在「遗物 / 药水」一节 |

#### （乙）等下一轮数据 —— 有明确的关门条件

| 盲区                                                   | 批次          | 关门条件                                                                                                                                                    |
| ------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **第三幕全部 17 只怪的爬升度分档 + 第二组血量区间**    | 三十二~三十九 | **一整批 `asc19 × 15 个第三幕编队`**（≈ 43MB）。这是本幕**最大的一块**，也是最便宜的一块——做法与第三十批逐字同构                                            |
| **迪卡守护方阵的 `noAliveGate`**（给已死的多努加格挡） | 三十九        | **`donu_and_deca@tgt1`**（打下标最大的活怪 = 多努）。⚠ 它的镜像（多努那一位）本批已有 45 例背书，缺的只有这一半                                             |
| **`MINION_LEADER` 在蜥蜴法师 / 觉醒者身上的判胜路径**  | 三十六/三十七 | `@tgt1`（先打法师 / 觉醒者本人）。⚠ 觉醒者那条尤其要注意：「去掉这个 buff 红 46 例」量的是**快照里少了一个 power 条目**，不是判胜路径                       |
| **`reptoSummonHelper` 的 `searchOrder` 第 4 项**       | 三十六        | **`asc >= 18`**（一次召 2 只）。同一批还能关掉「`++monstersAlive` / `noOpRollMove` 在循环内还是循环外」                                                     |
| **尖刺客的封顶逻辑（`miscInfo > 5`）**                 | 三十二        | 分母只有 **1 / 360**。关门条件是「更耐打的编队」或更多种子                                                                                                  |
| **加速门的 `<` vs `<=`**                               | 三十八        | 分母 **1 / 120**。⚠ 非 0 所以不是盲区，但**别当成「阈值已验证」**——关门条件是更多种子                                                                       |
| **`bc.cardQueue.clear()`（觉醒者假死时清出牌队列）**   | 三十七        | 「一副既带浩劫 / 混乱 / 二连击、又能打死一阶段觉醒者的牌组」。⚠ 第三十八批那副 59 张**同时满足两个条件**，所以这条现在**只差把它换到觉醒者那个 variant 上** |
| **`exhaustOnUse \|= doesExhaust()`**                   | 三十八        | 「牌组里有 **2 张以上混乱**」（混乱排的是 `exhausts = false`，浩劫排的恒是 true）                                                                           |
| **虚无那句「同步 ↔ 入队」**                            | 三十七        | 「带进化 / 烈焰吐息的牌组」（那条路上真的会排队列动作）                                                                                                     |
| **`strength = std::max(0, strength)`（觉醒者复活）**   | 三十七        | 「牌组里有降力量的牌（黑暗镣铐 / 缴械）+ 在假死与复活之间用掉」                                                                                             |
| **虚无那句 `std::max(0, energy-1)` 的下限**            | 三十七        | 「回合中途抽牌 + 能量已花光」                                                                                                                               |
| **「打不赢了」判负门的复形怪例外**                     | 三十四        | 「一副能自己把三个牌堆打光的牌组」（净化 / 恶魔烈焰那一族）                                                                                                 |
| **停滞 / 束缚 / 困惑那几条「牌组维」的盲区**           | 三十三 等     | 各自点名了需要哪种牌同场，逐条见各批的盲区表                                                                                                                |

#### （丙）等真机 ground truth —— 参考自己给不出答案，**补丁没有预言机**

| 分歧                                                          | 批次   | 现状                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **爆破怪的自爆打 30 点却不在 `isMoveAttack` 白名单里**        | 三十二 | 参考在**自己的规则下自洽**（走 `Actions::DamagePlayer` 而不是 `attackPlayerHelper`），分歧在「参考 vs 真实游戏」（真实游戏显示攻击意图）。三条判据只过第 ①，**照抄、记待裁定**。探针红 11 例，分歧真的产生 |
| **怪物侧虚无缥缈在回合末无条件递减**                          | 三十六 | ⚠ **参考自注** `// differs from the game in that it always decrements at end of round`——它知道自己与真实游戏不同。照抄，补 skipFirst 红 108 例                                                             |
| **好奇心的效果（玩家打能力牌 → 此怪 +力量）被参考整段注释掉** | 三十七 | 唯一读点是注释掉的 `BattleContext.cpp:1909-1912`（连怪物下标都写死 2）。照抄「什么都不做」。**补上它没有预言机——预言机就是参考本身**                                                                       |
| **第三幕 17 只怪的第二组血量区间「阈值恰好是 7 / 8 / 9」**    | 全幕   | 单一档位证不了阈值（第二十二批已证）。守着它的只有 `data-tables.test.ts` 那张**逐怪期望阈值**表，所以那张表**不许写死成一个常数**                                                                          |

### 三、数据规格的最终数字

| 项                      | 值                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| 第三幕文件数            | **15**（`ENC_V0_ACT3`，每份 120 行 = 40 种子 × 3 层，**整份冻结**）                           |
| 第三幕体积              | **56MB**                                                                                      |
| 第三幕例数              | **1800**                                                                                      |
| 最大 / 最小的第三幕文件 | `donu_and_deca` **8.0MB** / `orb_walker` **1.7MB**（差 4.7 倍，长度由 Boss 决定）             |
| **仓库总计**            | **130 个文件 / 684MB / 33225 条 trace**（第四十一批：+4 个 `@relic4` 文件 / +24MB）           |
| **对拍例数**            | **33226**（33225 条 + 1 条「trace 数据自身的不变量」）                                        |
| 文件构成                | 第一幕 asc0 20 + asc19 20；第二幕 asc0 19 + asc19 19；`@tgt1` 23；第三幕 15；**`@relicN` 14** |

⚠ **第三幕的「一个编队一份文件」是历批最贵的**：前两幕一个 asc0 文件平均 2.5MB（125 种子），
第三幕平均 **3.7MB**（只有 40 种子）——因为三个 Boss 用的是强牌组，仗从 3.6 回合拉到 7~9 回合。
估下一批体积时**按「回合数 × 种子数」而不是「种子数」**推。

### 四、下一步候选清单 + 成本估算

⚠⚠ **第三幕装满解锁了一件大事：`act3Variants` 不再需要「必须是最后一个乘积」。**
从第三十二批起这是一条持续约束（每一批第三幕都要往它里面追加 variant，而往「不是最后一个」
的乘积里追加会平移其后所有 `traceIdx`）。现在它不再增长了，**可以在它后面挂第五个乘积**。
下面 ③④⑤ 全都依赖这一点。

| #     | 候选                                           | 解锁量                                                            | 成本                                                                  | 爆炸半径                                                                                                               |
| ----- | ---------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ①     | **第三幕的爬升度**（`asc19 × 15`）             | 本幕最大的一块盲区：17 只怪的全部数值分档 + 第二组血量区间        | 数据 ≈ **43MB**；实现是逐只填 `hpHigh` / `ascAmount` / `minAscension` | 中：要给每只怪填数据表，漏一处静默错                                                                                   |
| ②     | **`asc7 + asc16`**（跨三幕）                   | 关掉「三档里的中间那一档」12 条 + 冠军那两族阈值 + 血量阈值 7/8/9 | 数据 ≈ **180~200MB**（两档 × 三幕）                                   | **零**：实现侧一行不改，纯数据                                                                                         |
| ③     | **第四幕**（`shield_and_spear` / `the_heart`） | 2 个编队 / 3 只新怪（尖塔护盾 / 尖塔长矛 / 腐化之心）             | ⚠ 要新怪四份工作 + 新数据；体积按 Boss 估 **8~16MB**                  | 大：腐化之心是全游戏最复杂的一只怪                                                                                     |
| ④     | **事件编队**（6 个 `*_EVENT`）                 | 6 个编队 / 3 只新怪（熊 / 尖头怪 / 罗密欧）+ `TWO_FUNGI_BEASTS`   | 体积小（都是短仗），≈ **15MB**                                        | 小：`MonsterGroup::createMonsters` 里已有 case                                                                         |
| ~~⑤~~ | ~~**遗物 / 药水**~~                            | 遗物 8 → 168、药水 13 → 42，是**两条最大的空白战线**              | ⚠⚠ **先解决下面那个设计问题**                                         | ✅ **进行中**：第四十批开张（管线 + 5 颗 + 10 份 / 38MB），第四十一批 +5 颗 / +4 份 / +24MB。见文末「遗物 / 药水」一节 |

**推荐顺序：① → ⑤ → ② → ④ → ③。**
① 最便宜且关掉的最多；⑤ 的设计问题必须**在开工之前**解决，越晚越贵（每多一批数据，
「作废全部文件」的代价就更高一分）；③ 放最后，因为它要新怪、新机制、还要重新审
`ENCOUNTER_BUILDERS`。⚠ **仍然不要在同一批里加两条轴**（第三十一批的教训）。

⚠⚠ **第四十批先做了 ⑤ 而不是 ①，理由记一下**：⑤ 的**设计**代价随数据量单调上涨
（那一刻是 116 个文件 / 622MB，做 ① 会先变成 159 个 / 665MB），而 ① 的代价与做不做 ⑤ 无关。
「越晚越贵的先做」这条排序理由本身就写在上一句里，只是当时把它排在了 ① 后面。
✅ 做完之后 `relicVariants` 成了**最后一个乘积**，① / ② / ④ 都要挂到**它**后面。

#### ⚠⚠ ⑤ 的硬约束：遗物 / 药水轮换表的**长度**进了 `traceIdx` 的计算

这是下一条战线开工前**必须先解决的设计问题**，先把事实摆清楚（`trace_dump.cpp:2695-2748`）：

```cpp
for (int k = 0; k < 2; ++k) {
    const auto &rs = RELIC_ROTATION[(traceIdx * 2 + k) % RELIC_ROTATION.size()];   // 8 项
    gc.relics.add({rs.id, 0});
}
for (int i = 0; i < bc.potionCapacity; ++i) {
    bc.potions[i] = POTION_ROTATION[(traceIdx * 3 + i) % POTION_ROTATION.size()];  // 13 项
}
```

**两张表的长度就是模数**，而 `traceIdx` 是全语料共享的单调计数器。所以：

- ❌ **往末尾追加不安全**，而且这不是推理，是**量出来的**：给 `RELIC_ROTATION` 追加一个
  第 9 项之后跑 `tools/regen-traces.sh --check`，**116 / 116 个文件全红**，
  第一个文件的**第一行**就已经不同（`% 8` → `% 9`，从 `traceIdx = 4` 起每一条的遗物对都变）。
  ⚠ **「追加到末尾」这个直觉在这里是错的**——它对**编队列表**成立（variant 没点名的编队在
  种子循环之前 `continue`、不消耗 `traceIdx`），对**轮换表**不成立。两者别混。
- ❌ **原地替换某一项**同样不安全：模数没变，但那一格轮到的 trace 全都换了遗物。
- ❌ **把模数写死成字面量 `% 8` 再追加**：那样追加的项永远选不中，等于没加。

**三条可行的路，按推荐度排：**

1. ✅✅ **给 `DeckVariant` 加一个「显式遗物 / 药水清单」，空 = 走旧轮换。**
   这是与 `ascension` / `targetPolicy` / `playerHp` / `deckUpgraded` / `halfDead` **完全同一个套路**
   （「只在非默认时才改变行为 / 才输出」），已经在这个仓库里成功过五次：
   已有的 39 个 variant 一个字不改 → 旧数据逐字节复现，而新 variant 可以**点名**它要测的遗物。
   ⚠ 这比「扩轮换」还更**合用**：一个遗物批次本来就想要「这个 variant 恰好带反曲刀 + 手里剑」，
   而不是碰运气让轮换分给它。药水同理（`isReplayablePotion` 那道门也跟着走 variant）。
   ⚠ 顺带一提，它还能一次关掉（甲）表最后那一行的**四条老盲区**
   （贤者之石 / 地精之角 / 手钻 / 御守 / 暗石护符 —— 全都只是「不在那八个轮换里」）。
   ⚠ **活体样本不在这一族里**（第四十批查清）：它卡的不是轮换，是参考给它排了一个没有任何
   消费者的 InputState，见文末「遗物 / 药水」一节。
2. ✅ **新开第五个乘积，自带自己的轮换表。** 与 1 不冲突，其实是 1 的一个特例；
   好处是遗物 / 药水这条战线的 variant 全都聚在一个乘积里，坏处是覆盖面靠轮换而不是点名。
   ⚠ **无论选 1 还是 2，新东西都必须挂在最后一个乘积上**——现在挂得下，正是因为第三幕装满了。
3. ⚠ **另开一份轮换表 + 一个 variant 级的开关**（`relicSet: 0 | 1`）。能work，但它把
   「哪张表」与「表里第几项」两件事绑在一起，比 1 更难点名，没有理由选它。

**还有两处配套，漏一处就白做：**

- ⚠⚠ **variant 指纹里没有遗物这一维。** `split-traces.mjs` / `variant0-rows.mjs` 的指纹是
  **「整副牌组内容 + 升级位 + 爬升度 + 目标策略」**。两个**牌组相同、遗物不同**的 variant
  会**指纹撞号** → 它们的行落进同一个文件、被当成一整块，`variant0-rows.mjs` 数出来的
  「冻结前缀」**静默变长**——这正是 WORKFLOW 里反复警告的那个失败模式。两条出路：
  ① 给分组键加第三个后缀（`<编队>[@ascN][@tgtN][@relicN]`，⚠ **顺序固定、三处必须一致**：
  `split-traces.mjs` / `sts-combat-trace.test.ts` 的 describe / `sts-combat-wiring.test.ts`
  剥后缀时**从右往左**）；② 或者让遗物 variant 用一副**不同的牌组**（指纹自然不同）。
  **① 更稳**，因为它让文件名自己说明身份。
- ⚠ **两步验证照旧不能跳**：先只加管线（`DeckVariant` 多一个字段、留空）、**不加任何新
  variant**，跑一次 `tools/regen-traces.sh --check`，116 个文件必须逐字节复现；过了再填 variant。
  这条在爬升度轴、目标策略轴、第三幕开张时各做过一次，一次都没白做。

**结论：⑤ 不需要「作废全部文件」，但它需要先做那个 `DeckVariant` 字段 + 分组键后缀，
而不是去动 `RELIC_ROTATION` / `POTION_ROTATION` 这两张表。** 那两张表从今往后**当成冻结的**
（与第一幕那份 `encounters` 列表、与 variant 0 同级）。

---

## 遗物 / 药水（第四十批开张，第四十一批起逐批推进）

✅ **第四十批按上面那份设计执行完毕，选的是路 1（`DeckVariant` 上的显式清单）+ 路 2
（新开第五个乘积）的组合。** 管线怎么做、两张轮换表为什么冻结、`relicSet` 为什么必须
进指纹——全部写在 WORKFLOW 的「遗物 / 药水这条轴」一节，这里只记方向与账。

### 已登记（20 / 168）

| 遗物                                            | 钩子位置                                                                                                | 批次           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------- |
| 金刚杵 / 船锚 / 青铜鳞片 / 光滑石 / 血瓶 / 灯笼 | `initRelics` 第一遍（立即改属性）                                                                       | 第一批（轮换） |
| 弹珠袋 / preparation 袋                         | `initRelics` 第二遍（`atBattleStart`，落在开局抽牌之后）                                                | 第一批（轮换） |
| **贤者之石**                                    | `initRelics`（**全场 +1 力量、无过滤** + `energyPerTurn++`）**外加七处**「新上场的怪 +1」               | **第四十批**   |
| **地精之角**                                    | `Monster::die` 末尾两条独立 `addToBot`（回 1 能量、抽 1 张）                                            | **第四十批**   |
| **手钻**                                        | `Monster::attacked` :433 与 `Monster::damage` :488，**各一份**                                          | **第四十批**   |
| **暗石护符**                                    | `WRITHING_MASS_IMPLANT` :1543，`increaseMaxHp(6)`                                                       | **第四十批**   |
| **御守**                                        | 同上 :1541，拦住暗石护符那一支（⚠ 需要 `data >= 1`）                                                    | **第四十批**   |
| **硫磺**                                        | ⚠ **两处**：`initRelics` :126（第 1 回合）+ `applyStartOfTurnRelics` Player.cpp:497（其后）             | **第四十一批** |
| **苦无**                                        | `onUseAttackCard` :1702，`attacksPlayedThisTurn % 3 == 0` → 入队 +1 敏捷                                | **第四十一批** |
| **装饰扇**                                      | 同上 :1714 → 入队 +4 格挡（⚠ `clearOnCombatVictory = false`，与邻居相反）                               | **第四十一批** |
| **手里剑**                                      | 同上 :1718 → 入队 +1 力量                                                                               | **第四十一批** |
| **开信刀**                                      | `onUseSkillCard` :1828，`skillsPlayedThisTurn` 每 3 张 → 入队全体 5 点非攻击伤害                        | **第四十一批** |
| **墨水瓶**                                      | ⚠ **五处**：`initRelics` :164（搬 `r.data`）+ **四个** handler :1694 / :1811 / :1889 / :1958            | **第四十二批** |
| **橙色药丸**                                    | ⚠ **四处**：**三个** handler :1706 / :1819 / :1897 + `applyStartOfTurnRelics` 的回合复位 Player.cpp:559 | **第四十二批** |

### ⚠⚠ 活体样本（`THE_SPECIMEN`）**不登记**，理由与「不在轮换里」无关

`Monster::die` 末尾那一句是
`addToBot(Actions::SetState(InputState::SELECT_ENEMY_THE_SPECIMEN_APPLY_POISON))`
（`Monster.cpp:322-324`），而那个 InputState 在**整个参考项目里只出现两次**：这一处写入，
与 `InputState.h:48` 的枚举声明。没有任何 `isValidAction` / `Action::execute` / 枚举器能
应答它，而 `BattleContext::executeActions` 的主循环第一句就是
`if (inputState != InputState::EXECUTING_ACTIONS) break;`（`BattleContext.cpp:756-758`）
——**第一只怪一死，整场战斗永久卡住**。

它属于「参考压根没实现完」那一族，与卡牌那边的 `seek` / `shiv` / `miracle` 同类：
**没有预言机，永远不该登记**。给某个 variant 发这颗遗物只会让那一批 trace 在第一次
怪物死亡处截断。⚠ 这一条要与「不在八个轮换里」那一族**分开记**——后者第四十批已经解决，
前者是永久的。

### 下一批的输入（第四十二批起）

按「一个 variant 能同时关掉几条」组批，遗物可以叠（`RelicContainer::add` 没有上限）。
⚠⚠ **但叠不是免费的（第四十一批实测）**：叠进来的那颗会改变**分母**——硫磺给玩家每回合
+2 力量，把平均回合数从 9.54 压到 7.17，另外四颗的触发次数跟着掉。**排批次时先想一遍
「这颗会不会让仗变短 / 变长」，再决定要不要塞进同一个 variant。**

⚠⚠ **登记之前先 `grep -rn 'R::<名字>' src include`。** 下表的「钩子」一栏是索引不是清单：
硫磺那一行上一批只写了 `initRelics`，实际是**两处**（另一处在 `applyStartOfTurnRelics`），
少抄一处不会报错、只会每回合少一次。

现成的候选，按「有没有现成宿主」排：

| 候选遗物                                                                | 钩子                                                     | 需要什么                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **赤备**（`AKABEKO`）                                                   | `initRelics`：`p.buff<PS::VIGOR>(8)`                     | 任何编队；⚠ 要先登记玩家侧 **VIGOR**（`onUseAttackCard` 里那句 `removeStatus<VIGOR>`） |
| **靴子**（`THE_BOOT`）**/ 拳套**（`WRIST_BLADE`）                       | `attackedUnblockedHelper` 顶部 / `calculateCardDamage`   | 已登记的攻击牌足够                                                                     |
| **战争艺术 / 船长之轮 / 达摩鲁 / 情绪芯片**                             | `applyStartOfTurnRelics`（第四十一批已开的时点，现成的） | ⚠ 战争艺术顺带关掉「三个计数器的清零排在这个函数**之后**」那条盲区                     |
| **能量核心族**（`ECTOPLASM` / `SOZU` / `RUNIC_DOME` / `VELVET_CHOKER`） | 全是 `energyPerTurn++`，与贤者之石同一句                 | 任何编队；一次能带好几颗                                                               |
| ~~**墨水瓶 / 橙色药丸**~~ ✅ 第四十二批已登记                           | —                                                        | —                                                                                      |
| **枯枝 / 卡戎的骨灰**                                                   | 消耗触发（TODOS「消耗」那一节点名过）                    | 带消耗牌的牌组                                                                         |
| **死藤**（`NECRONOMICON`）                                              | `queuePurgeCard`，读 `freeToPlay` / `isXCost()`          | 与爆发 / 回响成型同族的机制先做                                                        |

⚠ **便宜的「补背书」，不需要新遗物、只要新 variant，可以一批做完**：

1. **只带苦无、或只带手里剑**的 variant（一个编队就够）→ 关掉「哪颗给哪个属性」那条盲区。
2. **硫磺 + `awakened_one`（半死）或 `looter` / `two_thieves`（逃跑）** → 关掉
   「过滤器是 `isTargetable()` 还是 `isAlive()`」那条。
3. **开信刀 / 墨水瓶 + `gremlin_nob`（激怒）或 `chosen`（诅咒）** → 一次关掉两条
   「它在 `onUseSkillCard` / `onUseStatusOrCurseCard` 里的位置」那种探针无效。
4. **橙色药丸 + `time_eater`** → 关掉 `removeDebuffs` 里抽牌削减那句 `++cardDrawPerTurn`
   （第四十二批新记的盲区，时间吞噬者是 DRAW_REDUCTION 的唯一产出者）。

⚠⚠ **第四十二批实测「三颗攻击计数遗物的相对顺序」并没有因为登记墨水瓶 / 橙色药丸而关掉**
（上一批那条预测是错的，理由见第四十二批那节）。它现在的关门条件是
「可累积负力量/敏捷的怪（参考里只有第四幕的尖塔护盾）+ 一回合能打 3 攻 3 技 3 能的牌组」，
**比原来写的贵得多**。别再照着旧那句话排批次。

✅ **药水那半第四十五批开张了（13 → 28 / 42）**，做法见 WORKFLOW 的「药水这条轴」与
上面的「第四十五批」一节。⚠⚠ 上一批写在这里的那句「想让某瓶药水在特定局面生效是做不到的，
得换别的路子」**是错的**：那条约束住在**我们自己的 harness 策略**里，不在参考里。
第四十五批加的 `potionPolicy` 就是那条「别的路子」，一个字段解决。

**剩下 14 瓶，逐条都有排除理由**（六族，见「第四十五批 · 三」），其中**只有两族还有戏**：

| 还能做的                        | 需要什么                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| 赌博酿 `gamblers_brew`          | 先裁定参考那个「`pickCount` 从不设置、读上一块屏的残值」算不算要打的补丁 |
| 四瓶「发现」类（攻/技/能/无色） | 要么给 `isReplayableCard` 那套黑名单扩到「发现」的候选池，要么放弃       |

其余十瓶是**永久排除**：姿态（2）、造未实现的牌（2）、空 `Action`（3，含毒药）、
`// todo` 空实现（1）、`default: assert(false)`（1）、被动消耗（仙女瓶）。

⚠ **下一批药水要注意的两条**：

1. **一个 variant 最多 3 瓶**（`potionCapacity`），别按遗物那边「8 颗挤一个」排。
2. **发新登记的药水必须开 `@potN` variant**——白名单挂在 `potionSet != 0` 上，
   往 `@relicN` 里塞是做不到的（理由见 WORKFLOW）。

⚠ **别再动那两张轮换表**（`RELIC_ROTATION` / `POTION_ROTATION`）。它们已冻结，理由见
上一节与 WORKFLOW。
