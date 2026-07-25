# 战斗系统待办

本文档只记录 `src/engine/sts-combat.ts`（游戏级战斗）的待实现部分。

## 背景：现在有两套战斗实现并存

|              | `combat/combat.ts`                 | `sts-combat.ts`                                       |
| ------------ | ---------------------------------- | ----------------------------------------------------- |
| 行数         | 3885                               | ~1940（+ 接线 350）                                   |
| 覆盖         | 广（几乎全部内容）                 | 窄（见下表）                                          |
| 精度         | **近似**：单条玩具 RNG、无动作队列 | **逐位精确**：与参考项目真实 `BattleContext` 逐帧对拍 |
| 是否接入引擎 | **是** —— 缺省实现                 | **是** —— `newRun({ combatEngine: "sts" })` 逐场启用  |

目标是让 `sts-combat.ts` 取代 `combat.ts`。在它覆盖面足够之前，删掉 `combat.ts` 会让引擎失去战斗能力（见文末「退役条件」）。

## 覆盖现状

数据定义（`cards.ts` / `relics.ts` / `enemies.ts` / `potions.ts`）两套实现共用，**定义本身早已齐全**；缺的是把参考项目里的精确行为转写进 `sts-combat.ts` 的登记表并用 trace 验证。

| 类别 | 已登记 | 我们的数据定义           | 登记表                                      |
| ---- | ------ | ------------------------ | ------------------------------------------- |
| 卡牌 | 14     | 359（铁甲 74 / 无色 41） | `CARD_RULES`                                |
| 怪物 | 4      | 227                      | `MOVE_RULES`                                |
| 遗物 | 8      | 169                      | `RELIC_IMMEDIATE` / `RELIC_AT_BATTLE_START` |
| 药水 | 13     | 42                       | `POTION_RULES`                              |
| 编队 | 5      | 63                       | `ENCOUNTER_BUILDERS` / `ENCOUNTER_SETUP`    |

未登记的内容会**显式抛错**，不会静默错配 RNG。

## 待实现

### 一、内容铺量

按登记表逐条转写参考项目的精确行为。当前范围建议限定在铁甲 + 无色（101 张待实现）。

其中 **58 张**用现有机制即可表达；**43 张**需要下列子系统。

### 二、缺失的子系统

按涉及卡数排序：

- `fetch_from_draw`（6 张）—— 从抽牌堆检索，需选牌屏
- `add_random_colorless` / `add_random_cards_to_draw`（各 2 张）—— 消耗 `cardRandomRng`
- `put_hand_card_on_top`（2 张）—— 需选牌屏
- 各 1 张：`double_block`、`double_strength`、`deal_damage_all_x`（X 费）、`deal_damage_random`、
  `deal_damage_draw_pile_count`、`deal_damage_perfected`、`exhaust_non_attacks`、
  `exhaust_non_attacks_gain_block` 等

### 三、整类缺失的机制

- **消耗堆相关**：消耗触发（无痛之心 / 黑暗拥抱）、从消耗堆取回
- **回合末 Power**：金属化、燃烧、恶魔形态一类持续生效的能力牌
- **状态牌 / 诅咒牌**：灼伤、伤口、眩晕等的入手与结算
- **姿态**（观者）与**充能球**（机器人）—— 当前范围外，但迟早要做
- **跨战斗计数型遗物**：笔尖、幸运花、双节棍、墨水瓶等（需要在战斗间持久化计数器）

### 四、接线（真正决定「战斗系统是否完成」的部分）

1. ~~让 `run.ts` / `engine.ts` 改用 `sts-combat.ts`~~ **已完成**（`src/engine/combat-bridge.ts`）
2. ~~状态结构对接：`GameState.combat` ↔ `BattleContext`~~ **已完成**（`GameState.stsCombat`）
3. 同时接入其余游戏级模块 —— `sts-map` / `sts-neow` / `sts-encounters` **目前同样未接线**，只有各自的测试在用
4. 把缺省实现从 legacy 翻成 sts（等覆盖面够，见「退役条件」）
5. 删除 `combat/combat.ts` 及其测试

前置条件已完成：`GameState.seed` 已是 int64 字符串、`GameState.floorNum` 已随地图推进自增。

#### 第 1、2 项做成了什么样

`combat-bridge.ts` 是两套实现接到引擎上的唯一接缝：`run.ts` / `engine.ts` 只认它导出的
`startCombat` / `playCard` / `endTurn` / `usePotion`，由它按 `state.combatEngine` 与**逐场
覆盖面**选实现。战斗状态分别落在 `state.combat`（legacy）与 `state.stsCombat`（sts），
同一时刻至多一个非 null，动作分发看哪个非 null，所以一场战斗中途不会换实现。

- `GameState.stsCombat` 是 `BattleContext` 的纯数据投影（`exportState` / `importState`）。
  两条队列不入档：只在 `executeActions` 抽干后才被观察，那时它们必空；中途取档会显式抛错。
- `GameState.stsPotionRng` 是 run 级持久 potionRng（熵酿消耗它，counter 要跨房间续算）。
- 覆盖不到就回退 legacy，并往 `state.log` 写明原因（编队/牌/药水/遗物/角色哪一项没迁移），
  不静默降级；`stsCombatCoverage(state, encounterId)` 可提前问。
- 缺省仍是 legacy：sts 现在只覆盖 5 个编队 / 14 张牌，硬切会让绝大多数战斗当场抛错。
  实测 300 局（GreedyPolicy、`combatEngine: "sts"`）里约 12% 的战斗走到了 sts 路径。

第 1、2 项之后仍缺的（不属于接线，列在这儿免得忘）：

- **战斗后的遗物**：桥在胜利时补跑 legacy 的 `onCombatEnd` 钩子（燃烧之血一类纯回血的
  都能用）。一旦有遗物在该钩子里发射战斗 Effect，桥会**抛错**而不是静默丢掉。
- **Boss 战没有 trace 背书**，所以 sts 路径的 Boss 分支（`grantBossVictory`）目前跑不到，
  只有 legacy 在用它。
- 战斗内 `isElite` 语义（勇气投索 / 密封昆虫）在 sts 侧没有对应物——这两个遗物本来就会
  被覆盖面检查挡在门外，等它们迁移时再补。

## 验证方式

数据由参考项目**真实 `BattleContext`** 驱动产出（不是手工转写的第二实现），记录「动作序列 + 每步全量状态快照」，TS 重放同一份已记录动作逐帧比对。

- 数据：`test/golden/traces/<encounter>.jsonl`，每行一条 trace
- 测试：`test/sts-combat-trace.test.ts`（逐帧对拍）、`test/sts-combat-wiring.test.ts`（接线；
  其中一条会把 `SUPPORTED_ENCOUNTERS` 与 trace 文件名双向对齐，漏加或多加都失败）
- 生成器：不在本仓库。见 fork 的 `sts-engine-harness` 分支
  （`KisinTheFlame/sts_lightspeed`，`tools/sts-engine-harness/`）

每批铺量后需重新生成 trace 数据。harness 已支持选牌屏动作（`select_card` / `select_cards`），
姿态 / 赌博 / 预知等屏幕尚无编码。

## 退役条件

删除 `combat/combat.ts` 需同时满足：

1. `sts-combat.ts` 覆盖当前 Act 1 全部编队与铁甲全部卡牌，且都有 trace 背书
2. ~~完成上面「接线」第 1、2 项~~ **已完成**
3. 缺省实现已翻成 sts（接线第 4 项），且 `stsCombatCoverage` 不再需要回退
4. 旧测试已按下节的规则逐项退役

在此之前删除会让 `newRun` / `applyAction` 在未覆盖的战斗里失去战斗能力。

### 旧测试怎么退役

**不是一刀切，而是跟着覆盖面逐项退役。**

136 个测试文件里只有 4 个是战斗主题的；其余约 132 个测的是遗物（24）、事件（7）、
卡牌（8）、药水（6）、地图（2）、商店（1）等——它们只是 `import engine.ts` 顺带
走了旧战斗，断言对象并不是战斗。

| 类别                                                  | 处置                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| 断言具体战斗数值的                                    | 对应内容迁入 `sts-combat` 并有 trace 背书后，**逐个删除**       |
| 战斗外系统（地图 / 事件 / 商店 / 篝火 / 奖励 / 幕间） | **永久保留**，与战斗系统换代无关                                |
| 纯数据（卡面费用、稀有度、文案）                      | **永久保留**，且应加强 —— 曾出现 3 处药水稀有度错误而无测试守着 |

注意：旧测试里凡是断言具体战斗数值的，都是照着**近似实现**写的，预言机本身就是错的。
它们的价值是「锁住当前行为不被意外改动」，不是「证明正确」。

另一面同样重要：目前尚未迁移的 345 张卡、219 只怪、161 个遗物，**唯一**在被执行和
被断言的地方就是旧实现与旧测试。过早删除会让这部分内容变成无人验证的死代码。

## 已知偏离参考项目之处

**北极星：真实游戏是目标，参考项目是目前最好的预言机、但不是目标本身。**

- 架构与代码组织 → 照抄（正是它让每次修正都是局部改动）
- 非直觉但正确的算法（重刃力量算 3 次、float32 逐步截断顺序、药水拒绝采样）→ 必须照抄
- 参考自身的 bug → 修正，并留可追溯记录

已修正的参考缺陷：

- **铁浪 `IRON_WAVE` 双重 `calculateCardBlock`**（敏捷算两次）。已向上游提 PR
  （gamerpuppy/sts_lightspeed#9），fork 的 `master` 已含修复。
  ⚠ 重新克隆参考项目时该补丁会丢失，需重新应用，否则重生成的数据会退回错值。
- **`Player::cc` 全项目无人赋值且无初始值**（UB，影响熵酿的药水池）。harness 里显式赋值规避。
