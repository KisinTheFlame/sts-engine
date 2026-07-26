# 铺量工作流

给接手「往 `sts-combat.ts` 里铺卡牌 / 怪物 / 遗物 / 药水 / 编队」这件事的人（或 Agent）。
**方向**看 [TODOS.md](TODOS.md)，这里只讲**怎么做一轮**。

一轮的形状固定是：**开发 → 生成预言机 → 验证 → 修复**。四步都做完才算一批。

---

## 0. 唯一要先记住的事

这个项目的价值全部建立在一件事上：**同种子逐位复现原版**。所以

> **未验证的实现比没有实现更糟。**

没登记的内容会**显式抛错**，调用方立刻知道。而登记了却错的内容会静默产出错误数值，
把「复现原版」变成谎话。因此**「登记」不是完成，「有 trace 背书」才是**。

三条推论，后面反复出现：

1. 参考项目**没实现**的卡（`shiv` / `smite` / `through_violence` / `insight` / `miracle` /
   `safety`，三个 switch 里都没 case）**不要登记**——没有预言机可背书。
2. 一张卡进了 harness 的牌组，**不等于**它被验证了。策略只打手牌最左侧的可打出牌，
   它可能一次没被打出。必须查打出次数。
3. **对拍全绿不等于新代码被验证了。** 必须做变异测试，见第 4 步。

---

## 1. 开发

### 范围怎么选

先读 TODOS 的「二、内容铺量」和「三、整类缺失的机制」。剩下的卡几乎每张都卡在某个
缺失机制上，所以一轮的形状通常是 **一个机制 + 它解锁的那批卡**。

选机制看「解锁卡数 / 爆炸半径」：只动 `sts-combat.ts` 内部的机制（如回合边界 Power）
比要改动作空间、`GameState` 形状、`migrate.ts` 的机制（如选牌屏）安全得多。
**机制与铺量尽量分成两个 commit**，出问题时好定位。

### 硬性规矩

- **逐位转写参考项目**，不要凭对游戏的印象写。`addToBot` vs 同步调用是最大的分歧来源——
  参考写 `addToBot(Actions::X)` 就 `addToBot`，写直接调用就直接调用。
- `addToBot` 的第三个参数（`clearOnCombatVictory`）要与参考的第二个参数一致。
- 消耗 RNG 的地方行尾标 `// ★ 消耗一次 xxxRng`。
- 每条规则上方写中文注释 + 参考定位（`对齐 BattleContext.cpp:NNN CARD_NAME`）。
  **非直觉但照抄**的地方要写清为什么（范例：`heavy_blade` 的力量算三次、
  `iron_wave` 的笔误记录、`applyEndOfTurnPowers` 的枚举序遍历）。
- 伤害/格挡走 `calculateCardDamage` / `calculateCardBlock`，不要自己算力量与易伤。
- 遇到还缺别的机制的分支：留 `TODO(后续PR)` 注释跳过，**不要顺手做第二个机制**。

### 参考项目错了怎么办

北极星是**真实游戏**，参考项目只是目前最好的预言机。参考自己有 bug（已发现 5 处，
见 TODOS「已知偏离参考项目之处」）。

判据：

- `getEnergyCost` 以 `default: return 1` 收尾 → **只对它显式列举的牌算权威**，
  未列举的牌一律返回 1，那不是权威只是默认值。
- `isCardInnate` / `doesCardExhaust` / `doesCardSelfRetain` 是「完整名单 + `default: false`」
  → **可以全表信任**。

发现参考错了：**不要自己拍板改参考仓库**，写进报告。补丁的打法是
**跟着登记一起打**（理由见 TODOS）——因为提前打的补丁没有 trace 走到它，
既验证不了修对没有，又会在重新克隆参考项目时静默丢失。

---

## 2. 生成预言机

数据由参考项目**真实的 `BattleContext`** 驱动产出，不是第二份手工转写。
生成器在 fork 的 `sts-engine-harness` 分支（`KisinTheFlame/sts_lightspeed`，
`tools/sts-engine-harness/`）。

### 先确认管道可信

```bash
tools/regen-traces.sh --check
```

它重新构建 harness、重新生成、并断言**已提交的数据能被逐字节复现**。
不先证明管道能复现旧数据，重生成的新数据就没有理由可信。
这一条不过就先别往下走——它意味着已提交的上千例背书失效了。

**必须在动 harness 之前跑**：`--check` 的前提就是「还没改」，所以它比对**整个文件**。
改完 harness 再跑它会报行数/内容不符，那是预期的，不是坏了——改完之后该用 `--install`，
它只要求 variant 0 那一段不动（其后的行本就该被本批重新生成）。

校验范围由**模式**决定，不靠行数猜。行数是「种子数 × 楼层数 × variant 数」，
**与牌组大小无关**：在「每批替换 variant 1/2」的策略下它逐批恒定，
所以任何想从行数反推「harness 改没改」的做法都是错的（这个坑踩过一次，
表现是下一批直接被卡死、且诊断错报成「variant 0 被扰动」）。

### 把本批的卡加进牌组

编辑 harness 的 `trace_dump.cpp`：

- 在 `BATCH_N` 里加本批的 `CardId::XXX`（用**参考的枚举名**）
- **variant 1/2 每批重新生成**（未升级 + 全升级各一个），牌组是**当前全牌组**：
  起始 10 + 已登记的全部批次。**variant 0 一律不动。**
- 为什么是「替换」而不是「每批新开一对」：一对 variant 约 12MB，几批下来仓库就过 100MB。
  替换的真实代价是**覆盖密度**——牌组越大，单张卡出现在某一手牌里的概率越低，打出次数变稀。
  这件事不靠推断，`--install` 打印的覆盖表就是量尺：73 张牌组下最薄的 `BLUDGEON` 是
  41/41 次，离 0 还很远，所以替换成立。哪天覆盖表里真的出现 0，再考虑给那一批单开一对更
  聚焦的牌组——理由写「覆盖密度」，不要写成内存上限。
- ⚠ **覆盖表只看「卡被打出几次」，看不到分支级的退化。** 换布局之后要把 TODOS 里
  **例数小的那些变异重量一遍**：换成 73 张全牌组时 `drawToHandAction` 的「候选恰好 1 张
  就不开屏」捷径就从 20 例掉到 0——牌组一大，抽牌堆几乎永远有 ≥2 张匹配牌。
  对拍全绿，覆盖表全非 0，唯一能发现它的是变异测试。

三条不变量（改 harness 后必须复验，脚本会自动查前两条）：

- ⚠ **牌组不得超过 96 张**（`Deck::MAX_SIZE`）。上限来自**主牌组**：`Deck::cards` 是
  `fixed_list<Card, 96>`，而 `fixed_list` **没有任何越界检查**，第 97 张就是静默内存破坏、
  不是 assert（`CardManager::init` 的 `fixed_list<int, Deck::MAX_SIZE> idxs` 与
  `isInnateMemo[Deck::MAX_SIZE]` 同源）。harness 里有一道显式检查会先报错退出。
  ⚠ **不是 64**：三个牌堆声明成 `fixed_list<CardInstance, MAX_GROUP_SIZE=64>` 的那个分支在
  `#ifdef sts_card_manager_use_fixed_list` 里（`CardManager.h:34`），而 `sts_common.h:12`
  把那个 `#define` 注释掉了、构建命令也不带任何 `-D`——实际编译的是 `std::vector`，无上限。
- **variant 0 必须排在最前且不变**。`traceIdx` 驱动遗物/药水轮换，位置一动它那几百例背书
  全部失效。它之后的行是**允许被替换**的，脚本认这一点：行数一变就只比 variant 0 那一段。
- **`deckUpgraded` 只在确有升级牌时输出**，故未升级的行与该字段存在之前的数据逐字节一致。

`tools/split-traces.mjs` 按 **variant 在 harness 输出里的首次出现顺序**排，不按牌组张数：
张数排序其实是在**推断** harness 的声明顺序，多一层不必要的假设——哪一批的牌组比上一批小
（换更聚焦的牌组、或临时砍几张）就会被插进 variant 0 中间去。首次出现顺序与牌组大小无关，
是 harness 真正的输出顺序。（这个坑真踩到过：第一次 `--install` 就红在第 376 行。）

**牌组要为「让新代码被走到」而设计，不只是「把新卡塞进去」。** 第四批加了第二张 `EXHUME`：
`ExhumeAction` 会把消耗堆里的掘尸滤掉，而掘尸自己是在 `OnAfterCardUsed`（晚于 `ExhumeAction`）
才进消耗堆的，只有一张时那个过滤器**永远走不到**——变异测试当场证实了它是盲区（0 例失败），
加第二张之后变成 52 例。

### 生成并安装

```bash
tools/regen-traces.sh --install UPPERCUT DEMON_FORM METALLICIZE ...
```

参数是本批新卡的**参考枚举名**。脚本会：生成 → 校验 variant 0 未被扰动 →
校验每张新卡两个分支（未升级 / 已升级）都真的被打出过 → 才安装。任一条不过就拒绝安装。

### 别忘了

- **参考仓库的改动要提交**，否则这份数据不可复现。脚本会在有未提交改动时警告。
- 补 `test/sts-combat-trace.test.ts` 的 `CARD` 映射（参考枚举名 → 我们的 id）。
  漏了会在 `initCombat` 抛「暂未登记卡牌行为」。
- 新出现的 Power 要补 `POWER` 映射。**漏了会抛错，不会静默**——这是故意的，
  `mapPowers` 早先会静默丢弃未映射的 power，于是「参考施加了某个我们没实现的 power」
  两边都得空对象、测试反而变绿。

---

## 3. 验证

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format
```

全绿是**下限**，不是完成。`sts-combat-trace.test.ts` 现有 3075 例逐帧对拍，
其中一部分用**全升级牌组**——所以每条规则 `up ? x : y` 的两个分支都会被验证。

改共享路径（`callEndOfTurnActions`、`drawCards`、`onTurnEnding`、`useCard` 之类）时，
对拍是最强的自查工具：它对每场战斗每个回合都生效，时点或顺序写错会当场红一大片。
**红了先假设自己写错了**，尤其是 `addToBot` 顺序、以及在已有函数里重复实现了已有逻辑。

---

## 4. 变异测试（这一步最容易被跳过，也最不能跳）

**「对拍全绿」只说明代码与数据不冲突，不说明数据看得见这段代码。**
把一段逻辑改坏，如果对拍**仍然全绿**，那段逻辑就没有预言机看着——它今天对是因为抄对了，
不是因为被验证了，而且以后改坏不会有人报警。

做法：改坏一处 → 跑对拍 → 看失败例数 → **还原**。

```bash
cp src/engine/sts-combat.ts /tmp/sc.bak
# ...改坏一处...
npx vitest run test/sts-combat-trace.test.ts 2>&1 | grep -E "^\s+Tests "
cp /tmp/sc.bak src/engine/sts-combat.ts
```

每个「非直觉但照抄」的点都值得来一次——那些正是最可能抄错、也最难靠肉眼发现的地方。
已确认的结果（括号内为变异后失败例数）与**已知盲区**记录在 TODOS 的「验证方式」一节，
新发现的盲区要如实补进去。

盲区不一定要立刻消除（有些分支近乎不可达），但**必须记下来**，
否则下一个人会以为它有背书。

---

## 5. 修复

自查出的问题自己修完再交。属于下列情况的**不要自己拍板**，写进报告：

- 参考项目看着像 bug（要不要打补丁、算不算笔误）
- 我们数据表与参考冲突（谁对）
- 需要动 `CardDef` 之类的类型定义（会影响别的颜色 / 卡池 / 存档）

---

## 6. 交付

- 在当前分支提交，**不要 push、不要开 PR**。
- 建议拆 commit：机制 / 铺量 / trace 数据 各一个。
- 顺手更新 TODOS：「覆盖现状」表的已登记数、「二、内容铺量」的剩余张数、
  「三、整类缺失的机制」里本批做掉的那条的状态。

报告里必须有：

1. **已登记清单** —— 逐条 id + 参考 `文件:行号` + 一句话效果。
   这份清单是下一步填 harness 牌组的输入，**id 必须准确完整**。
2. **跳过清单** —— 按缺失机制归类，会变成下一批的输入。
3. **新增/改动的共享原语与时点** —— 逐个说明为什么必须动。
4. **变异测试结果** —— 哪些点验证到了（失败例数）、哪些是盲区。
5. **不确定的点** —— 见第 5 步。
6. 四条命令的实际结果。

---

## 附：踩过的坑

- **`whirlwind` 必须保持未登记**：`sts-combat-wiring.test.ts` 用它当「未迁移卡牌」的样本。
- **`setHasStatus` 从不写 `statusMap`**（`Player.h:233`），所以纯 bool 状态
  （壁垒 / 腐化 / 困惑 / 笔尖 …）在参考侧 `getStatusRuntime` 会 `statusMap.at()` 抛
  `out_of_range`。harness 的 `playerStatusValue` 已规避（按 1 输出），不必再改。
- **玩家 Power 按 `PlayerStatus` 枚举序结算，不是获得顺序**（参考遍历 `std::map`）。
- **`Player::cc` 全项目无人赋值**（UB，影响熵酿药水池），harness 里显式赋值规避。
- **`fixed_list` 全项目无越界检查**（`include/data_structure/fixed_list.h`：`push_back` 就是
  `arr[list_size++] = t`，`resize` 就是 `list_size = size`）。但**牌组的上限不是 64 而是 96**：
  卡住牌组的是主牌组 `Deck::cards`（`fixed_list<Card, Deck::MAX_SIZE=96>`），不是三个牌堆
  ——牌堆那份 `fixed_list<CardInstance, 64>` 声明在 `#ifdef sts_card_manager_use_fixed_list`
  里，而 `sts_common.h:12` 的 `#define` 是注释掉的，实际编译成 `std::vector`。
  真正会被 64 卡住的是 `ViolenceAction` 的 `attackIdxList`（`Actions.cpp:616`），按
  **抽牌堆里的攻击牌数**算——73 张牌组远够不到，但登记 `violence` 时要重新数一遍。
  `UpgradeRandomCardAction` 的 `upgradeableHandIdxs`（`:942`）是 `fixed_list<int,10>`，
  手牌上限本就是 10，安全。
- **harness 的策略可以比 `enumerateCardSelectActions` 更聪明**。那个枚举器对多选屏
  （净化 / 赌博）只产出「一张都不选」，还自带注释 `just dont deal with this right now`——
  照它走的话 `chooseExhaustCards` 的非空路径永远没有预言机。枚举器只是搜索用的辅助，
  **预言机是 `BattleContext`**：自己拼一个合法的多选 action（`isValidMultiCardSelectAction`
  会校验）交给 `Action::execute`，跑的仍是参考的真实代码。第四批就是这么把净化从
  「开屏关屏」变成真的消耗 1~5 张的。
- **重新克隆参考项目会丢掉所有补丁**，TODOS 里列了清单，要重新应用。
- `git` 相关：本仓库在 worktree 里跑，`gh pr merge --delete-branch` 会因 master 被主仓库
  检出而失败，删远端分支用 `git push origin --delete <branch>`。
