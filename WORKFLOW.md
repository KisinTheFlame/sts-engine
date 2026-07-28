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

### 怪物与编队特有的规矩

卡牌那条线的形状是「一个机制 + 它解锁的一批卡」，怪物这条线是**「一组编队 + 它们要的怪」**——
选批次的单位是**编队**，因为预言机是按编队分文件的。

- **`enemies.ts` 的数值不可信，要跟着一起校准。** 卡牌那边 `cards.ts` 早就齐全，
  怪物这边不是：文件头自己写着「精确权重 / 连续限制 / 守卫者阈值待真机 ground truth 校准」。
  所以一只怪的工作量是**三份**：`enemies.ts` 的血量区间与招式数值、`MOVE_RULES` 的
  `getMoveForRoll`、以及 `takeTurn` 走得通的 `effects`。三份都要逐位对参考。
- **`isMonsterAttacking` 现在读数据表的 `intent`，参考读的是招式 id 白名单**
  （`MonsterMoves.h:414` 的大 switch）。当前四只怪两边判定一致纯属巧合——白名单里
  **存在反例**（球状守卫的 HARDEN 带伤害却被算作攻击）。**每登记一只怪都必须回白名单逐条复核**，
  不一致就改成白名单。
- **`construct` 里的怪种特例会消耗 `monsterHpRng`**（虱子的咬击伤害就是这么定的）。
  漏掉不会静默——`rng.hp` 计数器当场对不上。
- ⚠ **「构造全部再选一个」**：`createWeakWildlife` / `createStrongHumanoid` /
  `createStrongWildlife` 把**候选全部 construct 一遍**（每只都掷血量、掷怪种特例），
  然后才 `miscRng.random(n)` 选一个，其余**直接丢弃**。所以一场 `EXORDIUM_THUGS`
  会为三只没出场的怪消耗 RNG。这类地方照抄，不要「优化」成先选后造。
- **`preBattleAction` 在全部 `rollMove` 之后**（`MonsterGroup::init`：createMonsters →
  逐怪 rollMove → 逐怪 preBattleAction），不是建怪时。
- ⚠ **一只怪的工作量其实是四份，第四份最容易漏：招式的「收尾」。** `takeTurn` 每条 case
  的**最后一句**决定下回合出什么，参考里**四种形态并存**，对 `aiRng` 的消耗各不相同：
  `addToBot(RollMove(idx))`（掷 1 次并选新意图）/ `addToBot(NoOpRollMove())`（**照样掷
  1 次**然后丢掉、意图不变）/ 同步 `setMove(x)`（**一次都不掷**）/ **什么都没有**
  （第十四批的分裂：收尾藏在 `largeSlimeSplit` 函数内部，`MOVE_TURN_END` 记作 `"none"`）。
  第十三批四只怪占了三种，第十四批补上第四种。
  收尾选错不会被伤害数值掩盖——`rng.ai` 计数器当场对不上。登记表在 `MOVE_TURN_END`。
- ⚠ **不是所有意图都由 `getMoveForRoll` 掷出来。** 分裂 / 守卫者模式切换走的是
  `Monster::onHpLost`（`Monster.cpp:499`）——在**掉血那一刻**直接改写意图，两条伤害路径
  （`attacked` / `damage`）末尾各有一处，且**只在这一击没打死它时**才跑。
  登记表在 `MONSTER_ON_HP_LOST`。写法上还有个坑：参考在这里是裸的
  `moveHistory[0] = X`（**不前移历史**），不是 `setMove`——同一个 switch 里两种写法并存。
- ⚠ **`getMoveForRoll` 可以完全不看 `roll`**。酸液史莱姆小（asc<17）直接
  `bc.aiRng.randomBoolean()` 二选一，顶部那次 `random(99)` 照掷但结果被丢掉——
  于是它一次 rollMove 消耗 **2** 次 aiRng。别以为「不追加 RNG」等于「只消耗 1 次」。
- ⚠ **怪物会往玩家牌堆塞状态牌，而 harness 的 `isReplayableCard` 默认放行任何牌。**
  黏液是**唯一不需要医疗包就能打出的状态牌**（`CardInstance.cpp:329` 有个 `id != SLIMED`
  的例外），所以策略真会去打它 → 必须在 `CARD_RULES` 登记，否则 trace 不可重放。
  同理，塞进来的状态牌一律要补 `test/sts-combat-trace.test.ts` 的 `CARD` 映射
  （它会出现在牌堆快照里）。

### 参考项目错了怎么办

北极星是**真实游戏**，参考项目只是目前最好的预言机。参考自己有 bug（已发现 6 处，
见 TODOS「已知偏离参考项目之处」）——不只是卡牌数值抄错，第五批还挖出一处**数据结构级**的：
`clearPostCombatActions` 压缩动作环形缓冲时不修 `back`，胜利之后再 `addToBot` 就会丢动作。

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
- 为什么是「替换」而不是「每批新开一对」：一对全牌组 variant 约 12MB，几批下来仓库就过 100MB。
  替换的真实代价是**覆盖密度**——牌组越大，单张卡出现在某一手牌里的概率越低，打出次数变稀。
  这件事不靠推断，`--install` 打印的覆盖表就是量尺：85 张牌组下最薄的 `SEVER_SOUL` 是
  25/19 次，离 0 还很远，所以替换成立。
- **聚焦小牌组这个逃生口已经用过一次**：第五批加了 variant 3/4（起始 + 本批 + `mind_blast`
  = 23 张）。触发它的不是「某张卡 0 次」，而是**两条分支在全牌组下结构性不可达**：灼伤要靠
  洗牌才能从弃牌堆回到手里（85 张的抽牌堆一场仗轮不完，实测手牌 0 帧），
  而 `mind_blast` 的伤害等于抽牌堆张数、它又是固有牌（80 点一击把邪教徒/颚虫第一回合打死，
  1230 条 trace 从 ~40 步塌成 1 步）。加聚焦变体前**先量**（覆盖表 + 该分支的变异例数），
  确认是全牌组导致的，再加；理由一律写「覆盖密度」，不要写成内存上限。
  variant 3/4 与 1/2 一样每批重新生成，只有 variant 0 是冻结的。
- ⚠ **覆盖表只看「卡被打出几次」，看不到分支级的退化。** 换布局之后要把 TODOS 里
  **例数小的那些变异重量一遍**：换成 73 张全牌组时 `drawToHandAction` 的「候选恰好 1 张
  就不开屏」捷径就从 20 例掉到 0——牌组一大，抽牌堆几乎永远有 ≥2 张匹配牌。
  对拍全绿，覆盖表全非 0，唯一能发现它的是变异测试。

三条不变量（改 harness 后必须复验，脚本会自动查前两条）：

- ⚠ **全牌组从第七批起已经装不下了**：93（批 1-6）+ 6 = 99 > 96。第七批的做法是
  **给本批单开一对聚焦 variant、variants 0-4 原样不动**（重生成后前 855 行/编队逐字节未变，
  所有已量过的变异例数一条都没失效）。代价是新卡不与全牌组共存，收益是覆盖密度高得多。
  下一批要么继续这么做（每批 +~19MB），要么把全牌组拆两副并重量所有 ★ 例数。
- ⚠ **新 variant 的牌组张数不必回避已有的 variant**：指纹已改成整副牌组的内容
  （`split-traces.mjs` / `variant0-rows.mjs`）。旧的「张数 + 是否升级」指纹撞号会把两个
  variant 的行静默排到一起、段长也跟着错，且不报任何错——第七批差点踩上。
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

### 把本批的编队加进保留策略（怪物批次专用）

**harness 一直就在跑第一幕全部 20 个编队**——`encounters` 那个列表从第一个 commit 起
一个字没变过，我们过去只安装了其中五个，另外十五个每次生成完就丢掉。所以铺量怪物
**完全不需要改 `trace_dump.cpp`**。

> ⚠ 反过来说：**绝对不要动那个 `encounters` 列表**。增删任何一项都会平移其后所有 trace 的
> `traceIdx`，把遗物/药水轮换整体错位，已提交数据全线作废。真要加第二幕的编队，
> 得在**现有双重循环跑完之后**再追加一遍循环，让老的 `traceIdx` 原样保留。

要做的只是把编队名加进 `tools/regen-traces.sh` 的 `ENC_V0`：

```bash
ENC_V0="small_slimes lots_of_slimes large_slime"
```

`ENC_V0` 的语义是**只保留 variant 0 那 375 行，装完即永久冻结**（此后每批都必须逐字节复现
整份文件）。与卡牌那五个编队的 `ENC_ALL`（整份保留、每批随全牌组重生成）是两套策略。

为什么怪物走 variant 0：

- 怪物行为几乎与牌组无关，拉开差异的是**种子**——而 variant 0 恰恰是种子最多的那个
  （125 个，其余 variant 只有 40 个），牌组还最弱（21 张），战斗更长 = 怪物回合更多。
- 体积是实测的：15 个第一幕编队整份保留合计约 **500MB**，只留 variant 0 是 **100MB**。
- 附带好处：这些文件从此不再重写，git 里只有一份 blob。

**本批给参考打了补丁、确实改变了某个已冻结编队的行为时**，用
`ALLOW_CHANGED="编队名..."` 显式放行，并把理由写进报告与 TODOS。不要拿它绕过意外的扰动。

⚠ **`ENC_V0` 的代价：这些文件里只有 variant 0 那副 21 张牌组。**
「要靠长战斗才走到的东西」在**短仗编队**上结构性不可达，而且**在 variant 那一维没有逃生口**
——新开一对聚焦 variant 只会产出 variant 0 之后的行，那些行按定义会被 `head -n` 裁掉。
第十三批实测：史莱姆塞进弃牌堆的黏液出现了 426 帧，**进手牌 0 帧**（`small_slimes` 最长
3 回合、`lots_of_slimes` 最长 5 回合，抽牌堆一次都没洗回来），于是「打出黏液」这条路零背书。

⚠ **逃生口在「编队」那一维：换一个更耐打的编队。** 第十四批的 `large_slime` 用的还是
同一副 21 张牌组、同样只留 variant 0，但那只 64~70 血的单怪把仗拖得够久，抽牌堆真的洗回来了
——黏液被打出 46 次，第十三批那三个「0 例」的变异一次性转成 36 例。
所以：选批次时先量一眼战斗长度，**并把「这一批能救回哪条旧盲区」写进计划**；
真需要长战斗的东西，等带它的长仗编队（Boss / 大怪）那一批。

### 生成并安装

```bash
tools/regen-traces.sh --install UPPERCUT DEMON_FORM --moves SENTRY_BOLT SENTRY_BEAM ...
```

参数分三段：**（无前缀）普通卡**要求未升级/已升级两栏都非 0；**`--no-upgrade`** 只要求
未升级那栏，**仅限根本没有升级形态的卡**（状态牌与诅咒牌的 `canUpgrade()` 恒假，
放进普通那段就是必然失败、整批装不上）；**`--moves`** 是怪物招式。
⚠ 别拿 `--no-upgrade` 给「这批懒得覆盖升级分支」的普通卡开后门，那是真的少了一半背书。

`--moves` 之前是本批新卡的参考枚举名，之后是本批新怪物招式的参考枚举名
（`monsterMoveStrings` 里那个，自带怪物前缀）。脚本会：生成 → 校验冻结数据未被扰动 →
校验每张新卡两个分支都被打出过、每个新招式都**出现且执行**过 → 才安装。

**「出现」与「执行」必须都非 0**，这是怪物侧的不变量 ③：

⚠ **`--moves` 之前那半（卡牌）同时要求「未升级」与「已升级」两栏都非 0，所以状态牌不能放进去。**
状态/诅咒牌参考侧 `canUpgrade` 恒假，永远不会出现在升级栏里，写进去就是必然失败、整批装不上。
第十三批的黏液因此没进这个列表，只能靠肉眼看覆盖表——这是工具的一个已知缺口。

- 只有出现 → 意图选出来了但从没轮到执行。`MOVE_RULES` 有背书，`takeTurn` 那条效果**没有**。
- ⚠ 这不是理论风险，**第一批怪物就撞上了**：`LOOTER_ESCAPE` 在 `looter.jsonl` 里
  出现 16 次、**执行 0 次**——单挑抢劫者的战斗永远在第 5 回合的怪物阶段之前就结束了。
  它唯一有背书的地方是 `exordium_thugs`（执行 16 次），因为那里抢劫者有同伴、仗打得更久。
  **结论：选批次之前先量一遍招式 × 编队矩阵**，别假设「登记这只怪就装它的单怪编队」够用。

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

全绿是**下限**，不是完成。`sts-combat-trace.test.ts` 现有 9555 例逐帧对拍，
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

- **`sts-combat-wiring.test.ts` 里那条「未迁移卡牌」用例需要一张永远不会被登记的样本。**
  第十批之前用的是 `whirlwind`，本批登记它时换成了 **`seek`**——参考项目三个 switch 里都没有
  `SEEK` 的 case，等于压根没实现，所以它永远不会有预言机、永远不会进 `CARD_RULES`。
  别换成 `the_bomb` / `hand_of_greed` / `clash` 那类「下一批就要登记」的牌。
- **`isReplayableCard` 那道门要覆盖「会自动打出别的牌」的卡，不只是卡自己。**
  浩劫 / 混乱把选择权交给 `playTopCardInDrawPile`，参考取抽牌堆顶那张、不看任何门。
  第十批被这个洞咬到（详情见 TODOS「已修正」里那条）：一张未登记的 `clash` 被混乱打出去，
  整条 trace 不可重放。现在 harness 有 `mayPlayHandCard`，但它同时意味着
  **凡是从卡池造牌的卡（含嬗变）都不能与混乱同处一副牌组**——第十批因此拆了两对 variant。
- **凡是「从卡池随机取牌」的卡，harness 必须有一道「只打已登记的牌」的门**
  （`isReplayableCard`，与 `isReplayablePotion` 同源）。第八批之前能进战斗的牌全部来自牌组，
  而牌组里只有已登记的牌；蜕变/变形/发现/多面手/地狱之刃一来，`CardPools.h` 的三个池
  一共点名 104 张牌，其中十几张没登记——策略一旦打出去，重放端就抛「暂未登记卡牌行为」，
  整条 trace **不可重放**（不是「未验证」，是直接坏掉）。
  那道门写成**黑名单**（列出池里未登记的那些）而不是白名单：可达集合就是
  「牌组 ∪ 三个池 ∪ 状态牌生成器」，黑名单因此是完备的，而且漏一项是**当场抛错**，
  不像白名单漏一项那样悄悄少掉覆盖。
  ⚠ 加这道门之后先**只加门、不加新 variant** 跑一次 `--check`：已提交数据逐字节复现，
  就证明了这道门对既有 variant 是空操作。
- **`tools/split-traces.mjs` 不能把 harness 输出整份读成字符串**：第八批起输出超过了
  V8 的字符串上限（0x1fffffe8 ≈ 512MB），`readFileSync(src, "utf8")` 直接抛
  `ERR_STRING_TOO_LONG`。已改成读 Buffer + 按顶层 trace 边界切片、逐条 parse。
  逐条仍走 `JSON.stringify(JSON.parse(...))`，所以输出与旧写法逐字节等价。
- **参考的 `ActionQueue` 是手写环形缓冲，`clearPostCombatActions` 只修 `size` 不修 `back`**。
  于是「胜利清扫之后又 `addToBot`」会取到残留的旧动作、新动作永远轮不到。第五批已打补丁。
  凡是**胜负已定之后**还会入队的东西（消耗触发、`onAfterUseCard` 之后的连锁）都会踩到它。
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
  **抽牌堆里的攻击牌数**算。第十二批登记 `violence` 时数过了：最大的牌组（93 张）里攻击牌
  40 出头，远够不到 64。以后新加牌组按「攻击牌数」而不是牌组张数来数。
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
