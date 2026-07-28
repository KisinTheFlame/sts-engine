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

`cards.ts` / `relics.ts` / `potions.ts` **早已齐全**，两代实现共用；缺的是把参考项目里的
精确行为转写进 `sts-combat.ts` 的登记表并用 trace 验证。

⚠ **`enemies.ts` 是例外，它的数值不可信。** 文件头自己写着「精确权重 / 连续限制 /
守卫者阈值待真机 ground truth 校准」，而且只覆盖到第一幕切片。所以铺量怪物时
**数据表本身也要跟着逐位校准**，不像卡牌那样只写登记表。

| 类别 | 已登记  | 全量              | 登记表                                      |
| ---- | ------- | ----------------- | ------------------------------------------- |
| 卡牌 | 108 + 1 | 116（可背书上限） | `CARD_RULES`                                |
| 怪物 | 10      | 65                | `MOVE_RULES`                                |
| 遗物 | 8       | 168               | `RELIC_IMMEDIATE` / `RELIC_AT_BATTLE_START` |
| 药水 | 13      | 42                | `POTION_RULES`                              |
| 编队 | 8       | 63                | `ENCOUNTER_BUILDERS` / `ENCOUNTER_SETUP`    |

「卡牌 108 + 1」里的 +1 是**状态牌黏液**（`slimed`，第十三批）。它不算在「铁甲 + 116」那条
铺量线里——状态牌不属于任何角色，也不进任何奖励池。~~⚠ 它是目前唯一一条没有 trace 背书的登记~~
**第十四批已补齐背书**：`large_slime` 里它被真的打出 **46 次**（分布在 36 条 trace 上），
费用 / 消耗 / 可打出三条属性各自的变异都红 36 例，见下方「验证方式 · 第十四批」。

「全量」按参考项目的枚举算（`MonsterIds.h` 65 项、`MonsterEncounters.h` 63 项）。
早先这张表把怪物写成 227，那是错的。

**当前预言机能背书的上限是第一幕的 20 个编队**——harness 的 `encounters` 列表就是那 20 个，
实测能走到 **25 只怪**（含分裂产生的）。第二幕往后要先给 harness 追加一遍循环
（见 WORKFLOW，不能动原列表）。

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

按登记表逐条转写参考项目的精确行为，范围先限定铁甲 + 无色（**8 张，全部永久跳过**）。

第十二批之后，红 + 无色剩下的 8 张**一张都不该登记**——它们全部没有预言机：

- `forethought` 深谋远虑 —— 参考的升级分支整段被注释掉，且多选那一整套压根不存在，
  补它是**发明而非转写**（详见下方「数据表与参考/真实游戏冲突 · 待裁定」）
- 参考**压根没实现**的 7 张：`shiv` / `smite` / `through_violence` / `insight` / `miracle` /
  `safety` / `seek`（三个 switch 里都没 case，永远不会有预言机；`seek` 还兼任
  `sts-combat-wiring.test.ts` 那条「未迁移卡牌」用例的样本，见文末）

**也就是说「铁甲 + 无色」这条铺量线到第十二批为止已经走完了**（108 / 116）。下一步的铺量
只能往别的方向去：怪物（4 / 65）、遗物（8 / 168）、药水（13 / 42）、编队（5 / 63），
或者把范围扩到别的角色（那要先补姿态 / 充能球两套机制）。

#### 怪物与编队的批次计划（第十三批起）

单位是**编队**，因为预言机按编队分文件。依赖关系已用实测的「招式 × 编队执行矩阵」定过，
不是拍脑袋排的（工具与判据见 WORKFLOW「生成并安装」）。

| 批       | 编队                                                     | 新怪物                          | 主要新机制                                               |
| -------- | -------------------------------------------------------- | ------------------------------- | -------------------------------------------------------- |
| ~~十三~~ | ~~`small_slimes` `lots_of_slimes`~~                      | ~~酸/尖刺史莱姆 M、S 四只~~     | **已完成**（黏液牌、脆弱、编队组合抽样、招式收尾三形态） |
| ~~十四~~ | ~~`large_slime`~~                                        | ~~酸/尖刺史莱姆 L~~             | **已完成**（分裂、掉血触发、招式收尾第四形态；黏液转绿） |
| 十五     | `blue_slaver` `red_slaver` `looter` **`exordium_thugs`** | 蓝/红奴隶主、抢劫者             | 纠缠、**逃跑**、偷金、「构造全部再选一」                 |
| 十六     | `exordium_wildlife`                                      | 真菌兽                          | 孢子云（死亡时给玩家易伤）                               |
| 十七     | `gremlin_gang`                                           | 疯/潜行/肥胖/盾牌小鬼、小鬼巫师 | 池抽 4、给友方加格挡、蓄力                               |
| 十八     | `gremlin_nob` `lagavulin` `three_sentries`               | 小鬼头目、拉加维林、哨卫        | 激怒、沉睡/金属化、**神器**、恍惚牌                      |
| 十九     | `the_guardian` `slime_boss`                              | 守卫者、史莱姆王                | 形态切换、荆棘、Boss 分裂                                |
| 二十     | `hexaghost`                                              | 六火幽魂                        | 激活、六重打击、灼伤                                     |

⚠ **第十五批把 `exordium_thugs` 和抢劫者绑在一起是必需的，不是凑批。** 实测：
`LOOTER_ESCAPE` 在 `looter.jsonl` 里出现 16 次、**执行 0 次**——单挑抢劫者的战斗永远在
第 5 回合的怪物阶段之前就结束了。它唯一有背书的地方是 `exordium_thugs`（执行 16 次）。
同类事实：真菌兽只在 `exordium_wildlife` 里出现，小鬼巫师/盾牌小鬼只在 `gremlin_gang` 里。

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
| **贤者之石**（`PHILOSOPHERS_STONE`）         | `largeSlimeSplit` 会给分裂出来的两只各 +1 力量（`MonsterSpecific.cpp:3356`），但 harness 的遗物轮换只有八个（`trace_dump.cpp:218`），里面没有它——写了没有预言机。已在 `splitMonster` 留 TODO                   |
| **史莱姆王的分裂**（`slimeBossSplit`）       | 形状与 `largeSlimeSplit` **不同**（idx1=0/idx2=2、`monsterCount=3` 预留空位、`monsterTurnIdx=3` 直接赋值、**不掷** noOpRollMove、不设 `extraRollMoveOnTurn`），第十九批                                        |
| **「分裂目标格已有怪」那一支**               | 参考往定长数组 `arr[idx2]` 写、右边有怪就顶掉，而 `monsterCount` 照样 `min(count+1,4)`。这只有史莱姆王那条链才可能出现，`large_slime` 恒是「场上只剩它自己」。`splitMonster` 里留了一道**显式抛错**而不是猜    |
| `Monster::onHpLost` 的**守卫者模式切换**分支 | 同一个 switch 里的另一支（读 `MODE_SHIFT` 层数、归零时 `setMove` + `addToBot(MonsterGainBlock(20))`），第十九批。已在 `MONSTER_ON_HP_LOST` 留 TODO                                                             |

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
  通用力量成长在后半（后半早就转写好了）。两个循环各自带 `isDying() || isEscaping()` 跳过。
  - **已实现：束缚（SHACKLED）** —— 黑暗镣铐临时拿走的力量记在它上面，回合末
    `buff<MS::STRENGTH>(getStatus<SHACKLED>())` 归还并 `removeStatus<SHACKLED>()` 清除。
    ⚠ 归还走的是 `buff` 而**不是** `addDebuff`，所以它**不过神器**——神器只在施加那一刻拦截。
  - **仍缺（都留了 TODO）**：金属化 / 镀甲（都要 `Monster::addBlock`）、易塑
    （`setStatus<MALLEABLE>(3)`，要与它的 onAttacked 成长分支配套）、**怪物侧**虚无缥缈递减、
    再生（`Monster::heal`）。当前登记的四种怪（邪教徒 / 颚虫 / 红虱 / 绿虱）一条都没有，
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
    仍缺：`ReactiveRollMove`（蠕动血块）、`monsterData` / `miscInfo` 驱动的那几只
    （红奴隶主的「用过纠缠没」、冠军的阶段位）。
- ~~**掉血触发**（`Monster::onHpLost`）~~ **第十四批已完成**（`MONSTER_ON_HP_LOST`）。
  两条伤害路径（`attacked` → `attackedUnblockedHelper`、`damage` → `damageUnblockedHelper`）
  末尾各有一处，**只在这一击没打死它时**才跑。大史莱姆的分裂就挂在这里：
  `curHp <= maxHp/2`（**C++ 整除**）时**直接赋值** `moveHistory[0] = X_SPLIT`——不是 `setMove`，
  所以 `moveHistory[1]` 不前移。仍缺：史莱姆王（第十九批，同样的半血判定）、
  守卫者的模式切换（同一 switch 的另一支，用的却是 `setMove` + `addToBot(MonsterGainBlock)`）。
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
    仍缺：`gremlin_gang` 的 8 选 4（同一套左移抽样，但 `lastIdx` 从 7 起）、
    `createWeakWildlife` / `createStrongHumanoid` / `createStrongWildlife` 的
    「**构造全部再选一个**」（候选全部 construct 一遍、每只都掷血量，然后才
    `miscRng.random(n)` 选一个，其余直接丢弃）。
- ~~**怪物往玩家牌堆塞状态牌**~~ **第十三批已完成**（`takeTurn` 的 `add_card` 效果）。
  史莱姆的攻击 `addToBot(Actions::MakeTempCardInDiscard(SLIMED))`，**排在攻击那条 addToBot
  之后**，走的是第五批就做好的 `makeTempCardInDiscard`（弃牌堆这一路不消耗 RNG）。
  第十四批补上了 L 号的**每次 2 张**（`MakeTempCardInDiscard({SLIMED}, 2)`，
  `MonsterSpecific.cpp:354 / :1189`）。
  仍缺：`pile: "draw"` / `"hand"` 两个去向（都有原语，只是还没有怪用到；洗入抽牌堆要掷
  `cardRandomRng`），以及史莱姆王的 3 张（张数不同、机制相同）。
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
  仍缺同族的：缠绕封攻击（ENTANGLED）、大结局 / 招牌动作 / 反射 / 天降神兵 / 战术家。
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
  仍缺：盗贼 / 劫掠者偷金币（`Monster::stealGoldFromPlayer`，两只怪都没登记）、
  以及战斗**之后**的金币奖励（那是 run 层第 7 项）。
- **战斗内遗物**：现只 8 个。79 个钩子随近似实现删掉了，要从参考项目重新转写
  （包括开局 buff、回合触发、出牌/失血/消耗/击杀响应、跨战斗计数型如笔尖 / 幸运花 / 双节棍）
- **姿态**（观者）与**充能球**（机器人）—— 当前范围外，但迟早要做
- **精英战语义**：勇气投索 / 密封昆虫那类「精英战内」判定（`isElite` 现在没传进战斗）

## 验证方式

数据由参考项目**真实 `BattleContext`** 驱动产出（不是手工转写的第二实现），记录「动作序列 +
每步全量状态快照」，TS 重放同一份已记录动作逐帧比对。

- 数据：`test/golden/traces/<encounter>.jsonl`，每行一条 trace
- 测试：
  - `test/sts-combat-trace.test.ts` —— 逐帧对拍（9555 例）
  - `test/sts-combat-wiring.test.ts` —— 接线：入参一致性、存档往返、胜负出口、未迁移即抛错、
    选牌屏（开屏 / 存档往返 / 残留动作不丢 / 非法选择被拒 / 两个策略都不死循环 /
    第八批加的「发现」屏：候选是当场生成的 3 张、跟着存档往返、选中的牌 `costForTurn`
    归零而 `cost` 不动）；
    第十一批加的两条：**贪婪之手的金币**（入场值来自 run 层、每个动作之后写回 `state.gold`、
    两处一致）与**炸弹的三格计时器**（往返 + 第 3 个回合末引爆）。这两条不是锦上添花——
    金币在 trace 里只以「本场赚了多少」这个增量出现，炸弹在 trace 里**压根看不见**
    （见下方盲区），接线这一层只能靠这里守；
    其中一条把 `SUPPORTED_ENCOUNTERS` 与 trace 文件名双向对齐，漏加或多加都失败
  - `test/data-tables.test.ts` —— 数据表不变量。**数据表是两代实现共用的**，它错了游戏级实现
    会照着错的数值逐位复现。首次跑就抓到了 `teardrop_locket` 重复定义（watcher 奖励池里
    双倍权重）——这类问题此前一直没有测试守着。
    ⚠ 「奖励池：不含 starter/special…」那条里，「池里的牌颜色对不对」是**恒真**的
    （`cardPoolOf` 直接按 `color` 过滤派生），真正有牙的只有「无重复」。守 `color` 的是
    第七批加的「卡表 · 颜色归属」——它拿 `sts-combat.ts` 的登记表（范围=铁甲+无色）
    当第二数据源，射程与局限写在那条注释里
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

| 编队             | 策略       | 装入批次 | 行数 | 大小  |
| ---------------- | ---------- | -------- | ---- | ----- |
| `small_slimes`   | `variant0` | 十三     | 375  | 3.5MB |
| `lots_of_slimes` | `variant0` | 十三     | 375  | 5.8MB |
| `large_slime`    | `variant0` | 十四     | 375  | 5.8MB |

选 variant 0 的理由（`regen-traces.sh` 的注释里有完整版）：怪物行为几乎与牌组无关，拉开差异的
是**种子**，而 variant 0 恰恰是种子最多（125，其余 variant 只有 40）、牌组最弱（21 张，
战斗更长 = 怪物回合更多）的那个；体积上 15 个第一幕编队整份保留约 500MB，只留 variant 0 是 100MB。
⚠ 代价是**这三个文件不含任何聚焦牌组**，所以「要靠长战斗才走到的东西」在它们上面可能结构性
不可达——第十三批的黏液就是这么变成盲区的（见下方盲区一节）。
⚠ **但「换个编队」本身就是一个逃生口**，第十四批实证了这一点：同样是 variant 0 的 21 张牌组，
`large_slime`（64~70 血的单怪）打得比 `small_slimes` / `lots_of_slimes` 久得多，抽牌堆真的洗回来了
——黏液被打出 **46 次**，而那两个编队是 0。选批次时把「哪个编队能救回哪条盲区」一起排。

当前 162MB / 10680 例（第十四批 +375 例 = 1 个编队 × 375）。
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

⚠ **例数是随数据变的**，换 variant 就得重量。下面标 ⁑ 的是在**当前布局（10305 例 =
9555 + 第十三批两个 `ENC_V0` 编队各 375）**上量的；标 ⁂ 的是第十二批那版布局（9555 例，
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
⚠ **⁑ 那批的分母与别的不同**：史莱姆两个编队各只有 375 例（`ENC_V0` 只留 variant 0），
所以一只怪的可观测面最多 750 例。⁑ 的个位数（如 roll 阈值那几条）**不代表薄得像盲区**，
它就是这个分母下的正常量级——不要拿它与卡牌那些四位数直接比。

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
    能给怪加神器（古代药水只给玩家）。具体三条：
    - **黑暗镣铐那道 `if (!hasArtifact)` 整个去掉**（即无条件上 SHACKLED）→ 0 例。
      ⚠ 注意与上面那条 552 例的区别：把它**反过来**写（参考的 bug）是有背书的，因为那会
      从「永远上」翻成「永远不上」；而「永远上」与「没神器才上」在当前内容下完全同义。
    - **黑暗镣铐的减力量走 `DebuffEnemy`（过神器）而不是 `BuffEnemy`（不过）** → 0 例。
    - **回合末归还力量走 `buff`（不过神器）而不是 `addDebuff`（过）** → 0 例。
      这三条照参考写着是对的，但要等登记一只带神器的怪（如书虫 / 时间守卫）才能真的量。
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
- **`playCard` 的 `energyOnUse` 填了 `card.costForTurn` 而非 `player.energy`**（第十批修）。
  详见上方「X 费」那一节。同样是「在此之前无人读它」，所以潜伏了两批。

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

### 已确认但尚未打补丁

⚠ **登记对应卡牌之前必须先在参考侧修掉**，否则重新生成的 trace 会带着错值，
而我们的数据表是对的 —— 对拍会红在「我们错」的位置上，实际是预言机错。

- **`PAIN` 剧痛的失血没标 `selfDamage`，于是不触发破裂**
  （`BattleContext.cpp:2678` 的 `Actions::PlayerLoseHp(1)`，第二参数缺省即 `false`）。
  与暴虐那条**同一类漏传**（暴虐已随第七批修掉，见上方「已修正」），修法也一样：
  改成 `PlayerLoseHp(1, true)`。
  **但现在不要改**——`pain` 这张诅咒牌在本引擎里**没有任何入手途径**、也未登记，
  按「补丁跟着登记一起打」提前打没有 trace 走到它，既验证不了又会在重新克隆时静默丢失。
  登记 `pain` 的那一批一并处理。

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

### 待裁定

- **`enemies.ts` 装不下 asc≥7 的第二组血量区间。** 参考的
  `monsterHpRange[id][higherHp]`（`MonsterIds.h:150`）每只怪有**两组**，由
  `initHp` 按 `ascension >= 7`（精英 8 / Boss 9）选，而 `EnemyDef` 只有 `hpMin` / `hpMax`
  一组，`createMonster` 也不看 ascension。所以**当前引擎只在 asc0~6 下血量正确**。
  这不是第十三批引入的——邪教徒 / 颚虫 / 虱子从第一批起就只有第一组。
  修法要动 `EnemyDef` 类型（加 `hpMinHigh` / `hpMaxHigh` 之类），按 WORKFLOW 第 5 步
  不自行拍板。同源的还有：`getMoveForRoll` 的 asc17 分支、`takeTurn` 的 asc2/3/4 伤害档、
  `preBattleAction` 的 asc 分档——它们在 `sts-combat.ts` 里都能写（有 `bc.ascension`），
  但一律没有预言机（harness 固定 asc0）。
- **要不要给 harness 开「爬升度」这条轴。** 上一条不是一只怪的问题，是**一整条轴**：
  每只怪都有 asc2 伤害档、asc7 血量档、asc17 出招档，全部是死代码。怪物铺完之后
  这会是项目里最大的单块盲区——**它随每批线性增长**，越晚做重量的成本越高。
  做法上不难：`GameContext gc(IRONCLAD, seed, 0)` 的第三个参数就是爬升度，给
  `DeckVariant` 加一个默认 0 的 `ascension` 字段、新 variant **追加在列表末尾**，
  老 `traceIdx` 就原样保留（与每批加聚焦 variant 同一个道理，零扰动）。
  代价：想覆盖 asc17 全部第一幕编队，按 variant 0 的密度约再 **+100MB**；
  只覆盖有 asc 分支的那几个编队会便宜得多。
  ⚠ 爬升度还会改玩家侧（起始血量、asc10 起多一张 `ascenders_bane` 诅咒），
  所以这不只是「怪物变强」，要连玩家侧一起对拍。**这是方向决策，等裁定。**
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
