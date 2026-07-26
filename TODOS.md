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
| `relics.ts` 的 79 个战斗内钩子    | ~340 | sts-combat 的遗物登记表（现 8 个）      |
| 断言近似战斗数值的 115 个测试文件 | ~13k | trace 逐帧对拍 + `data-tables.test.ts`  |

还没有游戏级对应物的部分**留着**：事件、商店、奖励（卡/金币/药水/遗物掉落）、篝火、
玩具 PRNG `rng.ts`。它们不是「两套里的一套」，而是唯一的一套——删了没有东西接位。
等各自的游戏级实现（`cardRng` / `relicRng` / `eventRng` / `merchantRng` / `treasureRng`）
写出来时，按同样方式删掉。

代价是明确的：引擎现在只能打已迁移的战斗，其余**直接抛错**。这是有意的，静默降级会让
「同种子复现原版」失去意义，错配 RNG 也比直接失败危险。

## 覆盖现状

数据表（`cards.ts` / `relics.ts` / `enemies.ts` / `potions.ts`）**早已齐全**，两代实现共用；
缺的是把参考项目里的精确行为转写进 `sts-combat.ts` 的登记表并用 trace 验证。

| 类别 | 已登记 | 数据表里有               | 登记表                                      |
| ---- | ------ | ------------------------ | ------------------------------------------- |
| 卡牌 | 65     | 359（铁甲 74 / 无色 41） | `CARD_RULES`                                |
| 怪物 | 4      | 227                      | `MOVE_RULES`                                |
| 遗物 | 8      | 168                      | `RELIC_IMMEDIATE` / `RELIC_AT_BATTLE_START` |
| 药水 | 13     | 42                       | `POTION_RULES`                              |
| 编队 | 5      | 63                       | `ENCOUNTER_BUILDERS` / `ENCOUNTER_SETUP`    |

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

### 二、内容铺量

按登记表逐条转写参考项目的精确行为，范围先限定铁甲 + 无色（50 张待实现）。

选牌屏那一批已做（见下方第三项）。剩下卡在这些子系统上：

- `add_random_colorless` / `add_random_cards_to_draw`（各 2 张）—— 消耗 `cardRandomRng`，
  还需要「战斗内卡池」（`CombatCardPool` / `CombatColorlessCardPool`）与凭空造牌实例
- **逐实例卡牌状态**（`costForTurn` / `freeToPlayOnce` / `specialData`）—— 未雨绸缪一类
  「本回合免费」、发现的 0 费副本、灼热之刃的层数都要它。当前 `CombatCard` 只有
  `{uid, defId, upgraded}`
- 各 1 张：`double_block`、`double_strength`、`deal_damage_all_x`（X 费）、`deal_damage_random`、
  `deal_damage_draw_pile_count`、`deal_damage_perfected`、`exhaust_non_attacks`、
  `exhaust_non_attacks_gain_block` 等

第四批点名跳过的（连同原因）：

| 卡                     | 为什么跳过                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seek` 搜寻            | 参考项目三个 switch 里都没有 case，等于没实现——没有预言机可背书                                                                                               |
| `discovery` 发现       | 需要 `CombatCardPool`（战斗内可获得卡池，按角色）+ 凭空造牌 + 逐实例 0 费                                                                                     |
| `forethought` 深谋远虑 | 参考的**升级分支整段被注释掉**（`Actions.cpp:793-795`），升级态退化成未升级行为。全升级 variant 会照着错的跑，等于没有预言机。另外还需逐实例 `freeToPlayOnce` |
| `dual_wield` 双持      | 机制齐了（`createTempCardInHand` + 手牌重排），但参考自己注明「dual wield is so fucking buggy」且要新分配 uid；本批优先把选牌屏做扎实，留给下一批             |
| `violence` 暴力        | 不需要选牌屏（是随机检索），但**参考有 bug**：见下方「已确认但尚未打补丁」                                                                                    |

### 三、整类缺失的机制

- ~~**选牌屏**（card select screen）~~ **已完成**：`inputState` 加 `card_select`、
  `cardSelect: CardSelectInfo | null`、`selectCard` / `selectCards` 两个入口，以及
  `executeActions` 顶部的 `inputState !== "executing" → break`（开屏时**队列原样留着**，
  这是全部时序的根）。已转写 8 个 task：`armaments` / `exhaust_one` / `exhaust_many` /
  `exhume` / `headbutt` / `secret_technique` / `secret_weapon` / `warcry`。
  尚缺的 task：`codex` / `discovery` / `dual_wield` / `forethought` / `gamble` / `hologram` /
  `liquid_memories` / `meditate` / `nightmare` / `recycle` / `seek` / `setup`。
- **消耗堆相关**：~~从消耗堆取回~~（掘尸已登记，`triggerAndMoveToExhaustPile` 是统一入口）；
  仍缺消耗**触发**（无痛之心 / 黑暗拥抱 / 卡戎的骨灰 / 枯枝 / 死灵诅咒 / 哨兵）
- ~~**回合末 Power**：金属化、燃烧、恶魔形态一类持续生效的能力牌~~ **已完成**：
  `callEndOfTurnActions` / `applyEndOfTurnPowers` / `applyStartOfTurnPostDrawPowers` 三个时点
  已按参考逐位转写，玩家 Power 按 `PlayerStatus` **枚举序**（而非获得顺序）遍历。
  仍缺的分支：镀甲、如水般（需姿态）、爆发 / 双重施法 / 缠绕 / 平衡 / 欧米茄 / 反弹 / 再生 /
  玩家侧仪式 / 怨灵形态、炸弹（需「N 回合后结算」计数器）、暴虐（卡牌本体升级后是固有牌）
- **状态牌 / 诅咒牌**：灼伤、伤口、眩晕等的入手与结算
- **战斗内遗物**：现只 8 个。79 个钩子随近似实现删掉了，要从参考项目重新转写
  （包括开局 buff、回合触发、出牌/失血/消耗/击杀响应、跨战斗计数型如笔尖 / 幸运花 / 双节棍）
- **姿态**（观者）与**充能球**（机器人）—— 当前范围外，但迟早要做
- **精英战语义**：勇气投索 / 密封昆虫那类「精英战内」判定（`isElite` 现在没传进战斗）

## 验证方式

数据由参考项目**真实 `BattleContext`** 驱动产出（不是手工转写的第二实现），记录「动作序列 +
每步全量状态快照」，TS 重放同一份已记录动作逐帧比对。

- 数据：`test/golden/traces/<encounter>.jsonl`，每行一条 trace
- 测试：
  - `test/sts-combat-trace.test.ts` —— 逐帧对拍（3075 例）
  - `test/sts-combat-wiring.test.ts` —— 接线：入参一致性、存档往返、胜负出口、未迁移即抛错、
    选牌屏（开屏 / 存档往返 / 残留动作不丢 / 非法选择被拒 / 两个策略都不死循环）；
    其中一条把 `SUPPORTED_ENCOUNTERS` 与 trace 文件名双向对齐，漏加或多加都失败
  - `test/data-tables.test.ts` —— 数据表不变量。**数据表是两代实现共用的**，它错了游戏级实现
    会照着错的数值逐位复现。首次跑就抓到了 `teardrop_locket` 重复定义（watcher 奖励池里
    双倍权重）——这类问题此前一直没有测试守着
- 生成器：不在本仓库。见 fork 的 `sts-engine-harness` 分支
  （`KisinTheFlame/sts_lightspeed`，`tools/sts-engine-harness/`）

harness 已支持选牌屏动作（`select_card` / `select_cards`），姿态 / 赌博 / 预知等屏幕尚无编码。

### 布局：variant 0 冻结，其后每批用当前全牌组重生成

每条 trace 都自带**生成它的那副牌组**，重放端按行走。所以数据布局是可选的，现在选的是：

| variant | 牌组                                    | 种子   | 升级 |
| ------- | --------------------------------------- | ------ | ---- |
| 0       | 起始 + 首批 11 张（21 张）——**冻结**    | 全 125 | 否   |
| 1       | 起始 + 第一~四批全部已登记卡牌（73 张） | 前 40  | 否   |
| 2       | 同上                                    | 前 40  | 是   |

当前 57MB / 3075 例。

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
  `fixed_list<int, CardManager::MAX_GROUP_SIZE>`），按**抽牌堆里的攻击牌数**算：73 张牌组的
  攻击牌远不到 64，安全；登记 `violence` 时要重新数。`UpgradeRandomCardAction` 的
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

⚠ **例数是随数据变的**，换 variant 就得重量。下面标 †（3075 例数据，即当前布局）的是
换成 73 张全牌组之后**重新量过**的；没标的还是旧布局（3675 例）上的数字，绝对值会有出入，
但都远离 0、定性结论（有背书）不受影响。

- 前三批：`upgradedCost`（230）、回合末弃牌顺序（1866）、燃烧失血量取 `combustHpLoss`
  而非层数（130）、玩家 Power 的**枚举序**遍历（†6，旧 4）、
  灵活还债走 `DebuffPlayer` 因而被神器吃掉（†10，旧 3）
- 第四批（选牌屏）：`executeActions` 顶部的 `inputState` 门（†799，旧 479）、
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

已确认**没有**覆盖到的，改动它们时对拍不会报警：

- **`drawToHandAction` 的「候选恰好 1 张就不开屏」捷径**（`count === 1`，0 例）。
  ⚠ 这一条是**换到 73 张全牌组之后新退化出来的盲区**：旧布局里第四批那副 32 张牌组的抽牌堆
  常常只剩 1 张技能/攻击，那条捷径能被走到（20 例）；73 张牌组的抽牌堆几乎永远有 ≥2 张，
  于是 `count === 1` 变得不可达。同族的军备 / 焚誓 / 头槌三条捷径仍有背书（12 / 7 / 43）。
  这是「用全牌组替换」在覆盖密度上付出的**唯一一处可测代价**，值得知道但没有立刻消除
  ——要消除就得为它单开一副更小的牌组，那又把体积换回去了。
- `applyEndOfTurnPowers` 里燃烧的 `bc.monstersAlive > 0` 门槛（去掉后 0 例失败）。
  原因大概是怪在玩家回合内被打光就直接判胜、走不到回合末结算，这个分支近乎不可达。
  照参考写着是对的，但没有东西守着它。
- `upgradedExhausts` / `upgradedTargeted` 的升级覆盖分支（去掉后 0 例失败）——
  目前没有已登记卡牌会因此改变可观测状态，靠 `data-tables.test.ts` 的单测守着
  （变异后分别红 2 例和 1 例）。等 `limit_break` 之外更多带升级态差异的牌登记后会自然覆盖。
- **那两次「白吃的 RNG」的 bound 本质上不可验证**：`WarcryAction` 的 `random(1)` 与
  `DrawToHandAction` 的 `random(count - 1)` 结果都被丢掉，只有**调用次数**影响 counter。
  把 bound 改成任何别的数都是 0 例失败。次数已经验证到了（368 / 5 例），bound 只能靠肉眼对齐参考。
- **手牌满 10 张的两条分支**：`exhumeAction` 的「手牌满就整个跳过」与 `moveToHandHelper` 的
  「满了改进弃牌堆」（各 0 例）。要在检索类效果结算的那一刻正好 10 张手牌，现有牌组够不到。
- **`canUpgradeCard` 的诅咒/状态排除与灼热之刃例外**（各 0 例）。结构上不可达：覆盖面检查会
  拒绝含未登记牌的牌组，而诅咒/状态牌与灼热之刃都还没登记。
- **`playCard` / `endTurn` / `drinkPotion` 的「选牌屏没关不受理」三道门**（各 0 例）——
  harness 永远不会在屏开着时打牌，所以 trace 看不到它们。改由
  `sts-combat-wiring.test.ts` 的「屏没关之前都被拒」守着。
- **三牌堆全空判负**（`executeActions` 的 can't-win check，0 例）。要把抽/弃/手三堆全清空，
  现有牌组做不到。照参考写着是对的（`BattleContext.cpp:767`），但没有东西守着它。
- **`chooseExhaustCards` 的空选择提前返回**——那是等价的死代码（空数组的循环本就什么都不做），
  不算盲区。

**每批用当前全牌组替换 variant 1/2**（曾短暂改成「每批新开一对」，理由是错的，已改回）：
之前以为牌组卡在 64 张，于是第四批只能另开一对；实际上限是 96（见上），73 张的全牌组装得下。
选替换而不是追加的理由是**体积**：一对 variant 约 12MB，几批下来仓库就过 100MB。

替换的真实代价是**覆盖密度**——牌组越大，单张卡出现在某一手牌里的概率越低。这不是推断，
`--install` 打印的覆盖表就是量尺，换完之后量过：51 张卡的两个分支全部非 0，最薄的
`BLUDGEON` 41/41 次、`UPPERCUT` 58/48、`DEMON_FORM` 59/54、`BARRICADE` 59/65，离 0 还很远
（换之前 `DEMON_FORM` 反而只有 42/31，两种布局各有薄的地方，不是单向变差）。
代价确实存在但只落在一处，且不是「某张卡没被打出」而是「某个**边角分支**变得不可达」：
`drawToHandAction` 的「候选恰好 1 张」捷径从 20 例退化成 0 例（见上方盲区清单）。
哪天覆盖表里真的出现 0，再给那一批单开一对更聚焦的牌组——理由要写覆盖密度，
不要写成内存上限。

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

- **`setHasStatus` 从不写 `statusMap`，dump 纯 bool 状态会抛异常**（harness 侧规避）。
  `Player.h:233` 只翻转 `statusBits`，于是 `getStatusRuntime` 的 default 分支对着不存在的 key
  做 `statusMap.at(s)` → `std::out_of_range`。壁垒一上场整个生成就崩。harness 的
  `playerStatusValue` 改为「`statusMap` 里没有就按 1 输出」，与我们把 bool 状态记为 1 层一致。
  同类隐患还有 `CORRUPTION` / `CONFUSED` / `PEN_NIB` / `SURROUNDED` / `BLASPHEMER` /
  `ELECTRO` / `MASTER_REALITY` / `WRATH_NEXT_TURN`，铺到它们时不必再改 harness。

### 已确认但尚未打补丁

⚠ **登记对应卡牌之前必须先在参考侧修掉**，否则重新生成的 trace 会带着错值，
而我们的数据表是对的 —— 对拍会红在「我们错」的位置上，实际是预言机错。

- **`DARK_SHACKLES` 黑暗镣铐有两处错**（`BattleContext.cpp:1265-1270`），故第三批跳过了它：
  1. **符号错**：写的是 `DebuffEnemy<MS::STRENGTH>(t, up ? 15 : 9)`，而
     `Monster::addDebuff<MS::STRENGTH>`（`Monster.h:337`）是 `strength += amount` 不做取反
     ——同项目 `Monster.cpp:394` / `:454` 的同款写法都传负数。所以这里是 **+9 力量**，
     把削弱写成了增强。
  2. **条件反了**：写成「目标**有**神器时才上 `SHACKLED`」，真实游戏是**没有**神器时才上。

  真实游戏 = `DebuffEnemy<STRENGTH>(t, -(up?15:9))` 再
  `if (!hasStatus<ARTIFACT>()) BuffEnemy<SHACKLED>(t, up?15:9)`。
  另外这张牌还依赖 `Monster::applyEndOfTurnTriggers`（`Monster.cpp:63-66`：SHACKLED 归还力量
  并清除），我们尚未实现（见 `applyEndOfRoundPowers` 里的 TODO）。

- **`VIOLENCE` 暴力会把牌复制出来**（`Actions.cpp:614` `ViolenceAction`），故第四批跳过了它。
  取牌的循环里那句提前退出写的是 `return` 而不是 `break`：

  ```cpp
  for (; i < count; ++i) {
      if (attackIdxList.size()-i <= 0) {
          return;                       // ← 跳过了下面「从抽牌堆移除」的整段
      }
      ...
      bc.cards.moveToHand(c);           // 已经进手牌了
  }
  std::sort(removeIdxs, removeIdxs+i);
  for (int x = i-1; x >= 0; --x) {
      bc.cards.removeFromDrawPileAtIdx(removeIdxs[x]);
  }
  ```

  抽牌堆里的攻击牌**少于 `count`（3，升级 4）张**时就会命中：已经搬进手牌的那几张仍然留在
  抽牌堆里，凭空多出副本。真实游戏当然不会。牌组里攻击牌不足 3 张很常见（尤其打到后期
  抽牌堆快空的时候），所以这不是边角情形。
  修法：把那个 `return` 改成 `break`（`i` 已经是「实际搬了几张」，后面的移除段本来就按 `i` 收尾）。

  ⚠ 登记 `violence` 之前必须先在参考侧改掉，否则重生成的 trace 会带着「牌被复制」的错值。

另有 4 处性质不同，单独记：**`Cards.h:703 getEnergyCost` 以 `default: return 1` 收尾**，
所以它对未列举的牌一律返回 1 费。`RAGE` 暴怒（红）、`SHIV` 飞刀、`SEEK` 搜寻、
`THROUGH_VIOLENCE` 以暴制暴都落进这个兜底，实际都是 0 费。四张全在铁甲 + 无色的铺量范围内。

与已修的 `TRIP` 那条的区别在于：`TRIP` 是**显式写错**（真的被列进了费用 1 组），这 4 张是
**根本没被列举**。后者顺带说明一件事——`getEnergyCost` 不能当作全表的费用预言机，
只有它显式列举的牌才算权威；而 `isCardInnate` / `doesCardExhaust` / `doesCardSelfRetain`
都是「完整名单 + `default: return false`」，那三个是可以全表信任的。

`SHIV` / `SEEK` / `THROUGH_VIOLENCE` 这三张参考项目三个 switch 里都没有 case，
等于压根没实现，铺量到它们时只能以真实游戏为准。
