# 战斗系统待办

目标：让引擎里**只有一套**实现——`src/engine/sts-combat.ts` 那套与原版逐位一致的游戏级实现。

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
| 卡牌 | 43     | 359（铁甲 74 / 无色 41） | `CARD_RULES`                                |
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

按登记表逐条转写参考项目的精确行为，范围先限定铁甲 + 无色（72 张待实现）。
其中 **29 张**用现有机制即可表达；**43 张**需要下列子系统。

- `fetch_from_draw`（6 张）—— 从抽牌堆检索，需选牌屏
- `add_random_colorless` / `add_random_cards_to_draw`（各 2 张）—— 消耗 `cardRandomRng`
- `put_hand_card_on_top`（2 张）—— 需选牌屏
- 各 1 张：`double_block`、`double_strength`、`deal_damage_all_x`（X 费）、`deal_damage_random`、
  `deal_damage_draw_pile_count`、`deal_damage_perfected`、`exhaust_non_attacks`、
  `exhaust_non_attacks_gain_block` 等

### 三、整类缺失的机制

- **消耗堆相关**：消耗触发（无痛之心 / 黑暗拥抱）、从消耗堆取回
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
  - `test/sts-combat-wiring.test.ts` —— 接线：入参一致性、存档往返、胜负出口、未迁移即抛错；
    其中一条把 `SUPPORTED_ENCOUNTERS` 与 trace 文件名双向对齐，漏加或多加都失败
  - `test/data-tables.test.ts` —— 数据表不变量。**数据表是两代实现共用的**，它错了游戏级实现
    会照着错的数值逐位复现。首次跑就抓到了 `teardrop_locket` 重复定义（watcher 奖励池里
    双倍权重）——这类问题此前一直没有测试守着
- 生成器：不在本仓库。见 fork 的 `sts-engine-harness` 分支
  （`KisinTheFlame/sts_lightspeed`，`tools/sts-engine-harness/`）

harness 已支持选牌屏动作（`select_card` / `select_cards`），姿态 / 赌博 / 预知等屏幕尚无编码。

### 铺量是追加式的，不重生成既有数据

每条 trace 都自带**生成它的那副牌组**，重放端按行走。所以铺一批卡不是重生成，而是加一个
deck variant，只追加行：

| variant | 牌组              | 种子   | 升级 |
| ------- | ----------------- | ------ | ---- |
| 0       | 起始 + 首批 11 张 | 全 125 | 否   |
| 1       | + 第二批 29 张    | 前 40  | 否   |
| 2       | + 第二批 29 张    | 前 40  | 是   |

两条不变量（改 harness 后必须复验）：

- **variant 0 必须排在最前且不变**：`traceIdx` 驱动遗物/药水轮换，位置一动既有文件就不再逐字节
  可复现。排序是 variant 优先的全序，所以新数据是字面意义的追加——`head -n <旧行数>`
  仍与旧文件逐字节一致
- **`deckUpgraded` 只在确有升级牌时输出**，故未升级的行与该字段存在之前提交的数据完全一致

variant 2（全升级）补的是一个真实漏洞：在它之前，所有 trace 的牌组都未升级，每条卡牌规则
`up ? x : y` 的**一半从来没有预言机看过**。变异验证：把 `playCard` 退回忽略 `upgradedCost`
的写法，230 例失败且全部落在升级变体上；这批数据之前，同样的 bug 是零失败。

**登记了不等于有背书。** 策略只打手牌最左侧的可打出牌，一张卡可以躺在牌组里一次没被打出。
每次重生成后要统计各卡的实际打出次数，0 次就是「有规则、没预言机」，属于本项目不接受的状态。

**第 3 批起替换 variant 1/2，不要再堆新的一对**：后一批的牌组是前一批的超集、本来就覆盖得住，
再追加一对等于花约 20MB 重复验证同一批卡，几轮下去仓库过 100MB。

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

### 已确认但尚未打补丁

以下 4 条已逐条核对真实游戏确认是参考项目错、我们对，但**参考侧还没有改**。
涉及的卡牌目前都未登记进 `CARD_RULES`，所以今天不影响任何 trace 数据。

⚠ **登记对应卡牌之前必须先在参考侧修掉**，否则重新生成的 trace 会带着错值，
而我们的数据表是对的 —— 对拍会红在「我们错」的位置上，实际是预言机错。

| 卡                | 参考的错                                                                                                                                        | 真实游戏               | 性质                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------- |
| `DISARM` 缴械     | `BattleContext.cpp:1281-1282` 只有 `Actions::DebuffEnemy<MS::STRENGTH>(t, -2, false)`，**完全不读 `up`**，升级分支缺失                          | -2 / 升级 -3           | 笔误                                                  |
| `IMPATIENCE` 急躁 | `BattleContext.cpp:1341-1348` 循环里找到攻击牌后写 `hasAttack = false;`（应为 `true`，见 1345 行），于是 `hasAttack` 恒假、退化成**无条件抽牌** | 「手里没有攻击牌才抽」 | 笔误（同一分支里紧跟着 `break`，说明本意就是 `true`） |
| `TRIP` 绊摔       | `Cards.h:703 getEnergyCost` 把 TRIP 归入费用 **1** 组                                                                                           | **0** 费               | 数据遗漏                                              |
| `SEEING_RED` 见红 | `Cards.h:534 doesCardExhaust` 的名单里**没有** SEEING_RED                                                                                       | 消耗牌                 | 数据遗漏                                              |

前两条是明显笔误，性质与已修的铁浪那条相同，适合走上游 PR；后两条是数据遗漏。

另有 4 处性质不同，单独记：**`Cards.h:703 getEnergyCost` 以 `default: return 1` 收尾**，
所以它对未列举的牌一律返回 1 费。`RAGE` 暴怒（红）、`SHIV` 飞刀、`SEEK` 搜寻、
`THROUGH_VIOLENCE` 以暴制暴都落进这个兜底，实际都是 0 费。四张全在铁甲 + 无色的铺量范围内。

与上表那 4 条的区别在于：上表是**显式写错**（`TRIP` 真的被列进了费用 1 组），这 4 张是
**根本没被列举**。后者顺带说明一件事——`getEnergyCost` 不能当作全表的费用预言机，
只有它显式列举的牌才算权威；而 `isCardInnate` / `doesCardExhaust` / `doesCardSelfRetain`
都是「完整名单 + `default: return false`」，那三个是可以全表信任的。

`SHIV` / `SEEK` / `THROUGH_VIOLENCE` 这三张参考项目三个 switch 里都没有 case，
等于压根没实现，铺量到它们时只能以真实游戏为准。
