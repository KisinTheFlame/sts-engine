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
| 卡牌 | 90     | 359（铁甲 74 / 无色 41） | `CARD_RULES`                                |
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

按登记表逐条转写参考项目的精确行为，范围先限定铁甲 + 无色（25 张待实现）。

选牌屏、牌生命周期、玩家事件钩子、卡牌实例级状态那四批已做（见下方第三项）。
剩下卡在这些子系统上：

- `add_random_colorless` / `add_random_cards_to_draw`（各 2 张）—— 消耗 `cardRandomRng`，
  还需要「战斗内卡池」（`CombatCardPool` / `CombatColorlessCardPool`）与凭空造牌实例
- **`freeToPlayOnce`**（逐实例的「下次打出免能量」）—— 第七批把 `cost` / `costForTurn` /
  `specialData` 三个字段做了，唯独没做它：唯一的产出者是深谋远虑，而那张牌的参考侧
  升级分支整段被注释掉（见下表），没有预言机就不写
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

第五批（牌的生命周期）点名跳过的：

| 卡                                                         | 为什么跳过                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apparition` 幻影                                          | 以太本身已经做了，缺的只有 INTANGIBLE（把伤害压成 1）。另外参考的 `isCardEthereal` 对它是 `!upgraded`，登记时要给数据表加 `upgradedEthereal` |
| `dark_shackles` 黑暗镣铐                                   | 参考侧两处 bug 未修 + 依赖 `Monster::applyEndOfTurnTriggers`（见下方「已确认但尚未打补丁」）                                                 |
| ~~`sentinel` 哨兵~~                                        | **第六批已登记**（同步回能量，见下方事件钩子一节）                                                                                           |
| `necronomicurse` 死灵诅咒                                  | 同挂在 `triggerAndMoveToExhaustPile` 上（入口已就位），但要把自己变一张回手，还缺凭空造牌之外的东西                                          |
| `corruption` 腐化 / `havoc` 混乱 / `mayhem` 暴乱           | 抽牌与进手的时点已经打通（`drawOneCard` / `moveToHandHelper` 里都留了 TODO），但三张都要逐实例 `costForTurn`                                 |
| `decay` 腐朽 / `doubt` 怀疑 / `shame` 羞耻 / `regret` 悔恨 | 回合末在手里结算的诅咒牌，`useNoTriggerCard` 已经能接（灼伤就走它），但这四张目前**没有任何入手途径**                                        |
| `void` 虚无                                                | 抽到时 -1 能量，钩子位置在 `drawOneCard` 里已标注；同样没有入手途径（要遗物 / 怪物）                                                         |

第六批（玩家的事件钩子）点名跳过的：

| 卡                | 为什么跳过                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apparition` 幻影 | 同第五批：缺 INTANGIBLE，**而且**要给 `CardDef` 加 `upgradedEthereal`（参考的 `isCardEthereal` 对它是 `!upgraded`）。动类型定义按 WORKFLOW 第 5 步要先报告不要自己拍板，故仍跳过                                                                        |
| `dark_shackles`   | 参考侧两处 bug 未修 + 依赖 `Monster::applyEndOfTurnTriggers`（见下方「已确认但尚未打补丁」）                                                                                                                                                            |
| `pain` 剧痛       | 挂在 `triggerOnOtherCardPlayed`（每打出一张牌失 1 血）。钩子位置已在 `useCard` 里标注，但这张诅咒牌**没有入手途径**；且参考对它的 `PlayerLoseHp(1)` 没传 selfDamage——与暴虐同一类漏传，暴虐已随第七批修掉，剧痛按「补丁跟着登记一起打」留到登记它那一批 |
| `thousand_cuts`   | 同挂 `triggerOnOtherCardPlayed`，是观者/静默的牌，当前范围外                                                                                                                                                                                            |
| `after_image`     | 挂在三个 `onUseXxxCard` 上（每打出一张牌加格挡），静默的牌，当前范围外                                                                                                                                                                                  |

第七批（卡牌实例级状态）点名跳过的：

| 卡                     | 为什么跳过                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forethought` 深谋远虑 | 参考的**升级分支整段被注释掉**（`Actions.cpp:784-806`），全升级 variant 会照错的跑。把它补上不是转写而是**发明**：参考侧只有单选的 `chooseForethoughtCard(int)`，`FORETHOUGHT` 也只在 `isValidSingleCardSelectAction` / `enumerateCardSelectActions` 的单选分支里，多选那套（`chooseForethoughtCards` + 校验 + 枚举）全都不存在。按 WORKFLOW 第 5 步留给人裁定，见本批报告 |

它也是 `freeToPlayOnce` 唯一的产出者，所以那个字段这一批一并没加。

### 三、整类缺失的机制

- ~~**选牌屏**（card select screen）~~ **已完成**：`inputState` 加 `card_select`、
  `cardSelect: CardSelectInfo | null`、`selectCard` / `selectCards` 两个入口，以及
  `executeActions` 顶部的 `inputState !== "executing" → break`（开屏时**队列原样留着**，
  这是全部时序的根）。已转写 8 个 task：`armaments` / `exhaust_one` / `exhaust_many` /
  `exhume` / `headbutt` / `secret_technique` / `secret_weapon` / `warcry`。
  尚缺的 task：`codex` / `discovery` / `dual_wield` / `forethought` / `gamble` / `hologram` /
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
  仍缺的分支：镀甲、如水般（需姿态）、爆发 / 双重施法 / 缠绕 / 平衡 / 欧米茄 / 反弹 / 再生 /
  玩家侧仪式 / 怨灵形态、炸弹（需「N 回合后结算」计数器）
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
  仍缺：`freeToPlayOnce`（深谋远虑 / 发现 / 液态记忆）、`retain`（保留整套）、
  困惑（抽到时掷 `cardRandomRng` 改费用）、X 费牌（旋风斩那类读 `energyOnUse`）
- ~~**虚无缥缈**（INTANGIBLE：受到的一切伤害降为 1）~~ **已完成**（第七批，随幻影登记）。
  三条钳制路径在参考里是**三段不同的代码**，逐个转写：怪物攻击走
  `Monster::calculateDamageToPlayer` 的 `min(damage, 1.0f)`（在所有倍率之后、截断之前；
  `Player::attacked` 里明写「assume intangible is already handled」）、非攻击伤害走
  `Player::damage` 顶部的 `damage > 0 && …`、主动失血走 `Player::loseHp` 顶部（**不带**
  `> 0` 判断）。回合末 `decrementStatus` **无条件**递减，所以幻影给的 1 层当回合末就掉光。
  仍缺：怪物侧的 INTANGIBLE（`Monster::attacked` / `Monster::damage` 各一处，没有已登记的
  怪有它）、缓冲（BUFFER）
- **战斗内遗物**：现只 8 个。79 个钩子随近似实现删掉了，要从参考项目重新转写
  （包括开局 buff、回合触发、出牌/失血/消耗/击杀响应、跨战斗计数型如笔尖 / 幸运花 / 双节棍）
- **姿态**（观者）与**充能球**（机器人）—— 当前范围外，但迟早要做
- **精英战语义**：勇气投索 / 密封昆虫那类「精英战内」判定（`isElite` 现在没传进战斗）

## 验证方式

数据由参考项目**真实 `BattleContext`** 驱动产出（不是手工转写的第二实现），记录「动作序列 +
每步全量状态快照」，TS 重放同一份已记录动作逐帧比对。

- 数据：`test/golden/traces/<encounter>.jsonl`，每行一条 trace
- 测试：
  - `test/sts-combat-trace.test.ts` —— 逐帧对拍（5475 例）
  - `test/sts-combat-wiring.test.ts` —— 接线：入参一致性、存档往返、胜负出口、未迁移即抛错、
    选牌屏（开屏 / 存档往返 / 残留动作不丢 / 非法选择被拒 / 两个策略都不死循环）；
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

| variant | 牌组                                        | 种子   | 升级 |
| ------- | ------------------------------------------- | ------ | ---- |
| 0       | 起始 + 首批 11 张（21 张）——**冻结**        | 全 125 | 否   |
| 1       | 起始 + 第一~六批全部已登记卡牌（93 张）     | 前 40  | 否   |
| 2       | 同上                                        | 前 40  | 是   |
| 3       | 起始 + 第五批 + `mind_blast`（23 张，聚焦） | 前 40  | 否   |
| 4       | 同上                                        | 前 40  | 是   |
| 5       | 起始 + 第七批 + 8 张使能牌（24 张，聚焦）   | 前 40  | 否   |
| 6       | 同上                                        | 前 40  | 是   |

当前 87MB / 5475 例。

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

⚠ **例数是随数据变的**，换 variant 就得重量。下面标 § 的是在**当前布局（5475 例，
variant 5/6 为第七批的 24 张聚焦牌组）**上量的；标 ★ 的是第六批那版布局（4275 例，
variant 1/2 为 93 张）；标 ‡ 的是第五批那版（同为 4275 例，但 variant 1/2 是 85 张）；
标 † 的是 3075 例那版；没标的更早（3675 例）。绝对值会有出入，但都远离 0、定性结论
（有背书）不受影响。第六批抽查了几个旧数据点，量级都还在：
`inputState` 门 ★489（‡511）、以太回合末消耗 ★369（‡355）、固有分区本身 ★2395（‡2400）、
回合末灼伤那一族 ★5/4/1（与 ‡ 完全一致）。
⚠ 第七批只**追加**了 variant 5/6，variants 0-4 逐字节未变，所以 ★ / ‡ / † 那些例数
仍然成立（只会因为多了 1200 条 trace 而偏大，不会变小）。

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

已确认**没有**覆盖到的，改动它们时对拍不会报警：

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
  - **`cardsResetAttributesAtEndOfTurn` 整条（0 例）。** 它要有活干，前提是回合末某张牌的
    `costForTurn != cost`；而当前唯一让两者分岔的是腐化的进牌钩子，那条钩子作用的牌
    `cost` 早已被 `onBuffCorruption` 一并压成 0 了。等「本回合免费」（深谋远虑 / 发现 /
    液态记忆）或困惑登记后会自然可观察。
  - **`playCard` 读 `costForTurn` 而不是 `cost`（0 例）。** 同一个根：两个字段在当前内容里
    几乎不分岔。注意「读实例值而不是从数据表现算」那条**是有背书的**（767 例），
    没背书的只是 `cost` 与 `costForTurn` 之间的区别。
  - **`updateCardCost` 的 `max(0, …)` 下限与「值没变就整个不动」的 if（各 0 例）。**
    血债血偿的 `cost` 掉到 0 之后再降，去掉这两道也只让 `cost` 变成负数，而
    `costForTurn` 仍被另一个 `max(0, …)` 夹住——可观察行为完全相同。
  - **`setCostForTurn` 的 `costForTurn >= 0` 门（0 例）。** 只有 X 费牌（-1）与打不出的
    状态/诅咒牌（-2）会命中它，而腐化只动技能牌、X 费牌一张都没登记。
    同源的 **`initialCardCost` 的 -2 哨兵改成 0 也是 0 例**：状态牌既不是技能牌
    （腐化不碰）、又在 `playCard` 里先被牌型挡掉，费用数值无人读。
  - **腐化的 `drawOneCard` / `moveToHandHelper` 两个进牌钩子（各 0 例）。**
    `onBuffCorruption` 已经把**四个牌堆**里所有技能的 `cost` 永久压成 0，之后进手的技能
    `costForTurn` 本来就是 0，钩子没有活干。真实游戏里它们是给「腐化之后凭空造出来的技能牌」
    （发现 / 双持 / 液态记忆）准备的，那些都还没登记。
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
  - **血债血偿升级时的 `upgradeBaseCost` 分支（0 例，且是参考自己写死的死代码）。**
    `CardInstance::upgrade` 里先按当前费用 -1，紧接着尾部又无条件把
    `cost = costForTurn = getEnergyCost(BFB, true) = 3` 盖掉（未升级是 4，两者必不相等）。
    参考自己在那行标了 `// TODO(dmz) is this logic right?`。我们照抄了，含它无效这件事。
  - **`specialData` 是逐实例而非逐定义（trace 0 例）。** variant 5/6 里暴走与灼热之刃各只有
    一张，trace 分不出「记在实例上」和「记在定义上」。改由
    `sts-combat-wiring.test.ts` 的「卡牌实例级状态跟着存档往返」守着（10 张暴走的牌组，
    断言每张打出过的暴走各自是 +5 而不是累加）。

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

与已修的 `TRIP` 那条的区别在于：`TRIP` 是**显式写错**（真的被列进了费用 1 组），这几张是
**根本没被列举**。后者顺带说明一件事——`getEnergyCost` 不能当作全表的费用预言机，
只有它显式列举的牌才算权威；而 `isCardInnate` / `doesCardExhaust` / `doesCardSelfRetain`
都是「完整名单 + `default: return false`」，那三个是可以全表信任的。

`SHIV` / `SEEK` / `THROUGH_VIOLENCE` 这三张参考项目三个 switch 里都没有 case，
等于压根没实现，铺量到它们时只能以真实游戏为准。

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

### 待裁定

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
