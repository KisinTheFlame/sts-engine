# 战斗系统待办

本文档只记录 `src/engine/sts-combat.ts`（游戏级战斗）的待实现部分。

## 背景：现在有两套战斗实现并存

|              | `combat/combat.ts`                          | `sts-combat.ts`                                       |
| ------------ | ------------------------------------------- | ----------------------------------------------------- |
| 行数         | 3901                                        | ~1700                                                 |
| 覆盖         | 广（几乎全部内容）                          | 窄（见下表）                                          |
| 精度         | **近似**：单条玩具 RNG、无动作队列          | **逐位精确**：与参考项目真实 `BattleContext` 逐帧对拍 |
| 是否接入引擎 | **是** —— `newRun` / `applyAction` 走的是它 | **否** —— 目前只有测试在用                            |

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

1. 让 `run.ts` / `engine.ts` 改用 `sts-combat.ts`
2. 状态结构对接：`GameState.combat` ↔ `BattleContext`
3. 同时接入其余游戏级模块 —— `sts-map` / `sts-neow` / `sts-encounters` **目前同样未接线**，只有各自的测试在用
4. 删除 `combat/combat.ts` 及其测试

前置条件已完成：`GameState.seed` 已是 int64 字符串、`GameState.floorNum` 已随地图推进自增。

## 验证方式

数据由参考项目**真实 `BattleContext`** 驱动产出（不是手工转写的第二实现），记录「动作序列 + 每步全量状态快照」，TS 重放同一份已记录动作逐帧比对。

- 数据：`test/golden/traces/<encounter>.jsonl`，每行一条 trace
- 测试：`test/sts-combat-trace.test.ts`
- 生成器：不在本仓库。见 fork 的 `sts-engine-harness` 分支
  （`KisinTheFlame/sts_lightspeed`，`tools/sts-engine-harness/`）

每批铺量后需重新生成 trace 数据。harness 已支持选牌屏动作（`select_card` / `select_cards`），
姿态 / 赌博 / 预知等屏幕尚无编码。

## 退役条件

删除 `combat/combat.ts` 需同时满足：

1. `sts-combat.ts` 覆盖当前 Act 1 全部编队与铁甲全部卡牌，且都有 trace 背书
2. 完成上面「接线」第 1、2 项
3. 依赖旧实现的 127 个测试文件已改写或删除

在此之前删除会让 `newRun` / `applyAction` 失去战斗能力。

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
