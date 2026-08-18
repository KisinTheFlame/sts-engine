// === 尖塔引擎的领域类型 ===
//
// 全部为纯数据（JSON 可往返），是存档、模拟器、HTTP 契约共享的形状。
// 复刻的是杀戮尖塔的**机制与数值**（功能性游戏规则），卡面文案为原创中文。
//
// 设计依据：本仓库根 AGENTS.md「KV 缓存优先」+ office-hours 设计文档 + issue #234。

// 只取类型（编译后擦除），故与 sts-combat.ts 互相 import type 不产生运行时循环依赖。
import type { StsCombatState } from "./sts-combat.js";
// 游戏级 RNG 单条流的可序列化状态（{counter, seed0, seed1}），区别于下方玩具 RNG 的 RngState。
import type { RandomState } from "./sts-rng.js";

export type CharacterId = "ironclad" | "silent" | "defect" | "watcher";

export type CardType = "attack" | "skill" | "power" | "status" | "curse";

/** 卡牌颜色：决定属于哪个角色的卡池；status/curse = 塞进牌组的废牌（不进任何奖励池）。 */
export type CardColor = "red" | "green" | "blue" | "purple" | "colorless" | "status" | "curse";

/** 卡稀有度：奖励按稀有度加权抽取；starter/special 不进普通奖励池。 */
type CardRarity = "starter" | "common" | "uncommon" | "rare" | "special";

/** 状态效果标识。切片集合：被动修正器 + 时机触发机制（见 powers/）。 */
export type PowerId =
  | "strength" // 力量：攻击伤害 +N（被动，可负、持续）
  | "dexterity" // 敏捷：获得的格挡 +N（被动，可负、持续）
  | "vulnerable" // 易伤：受到攻击伤害 ×1.5（回合末 -1）
  | "weak" // 虚弱：造成攻击伤害 ×0.75（回合末 -1）
  | "frail" // 脆弱：获得的格挡 ×0.75（回合末 -1）
  // 缠绕：无法打出攻击牌（红色奴隶主专属）。⚠ 不是「回合末 -1」而是**整条清除**：
  // 参考在 `Player::applyEndOfTurnPowers` 里对它写的是 `RemoveStatus<ENTANGLED>`
  // 而不是 `decrementStatus`（Player.cpp:382），所以层数多少都只封住一个玩家回合。
  | "entangled"
  // 诅咒（选民）：玩家每打出一张**非攻击牌**（技能 / 能力 / 状态 / 诅咒），
  // 就把一张「恍惚」**洗入抽牌堆**（`MakeTempCardInDrawPile(DAZED, 1, true)`，
  // 因此每次消耗一次 cardRandomRng）。触发点在 `BattleContext::onUseSkillCard` /
  // `onUsePowerCard` / `onUseStatusOrCurseCard` 三处（BattleContext.cpp:1796/1875/1938），
  // **`onUseAttackCard` 里没有**。
  // ⚠ 它是**纯 bool**：`Player::debuff` 对 `CONFUSED` / `HEX` 走
  // `setHasStatus(true); return;`（Player.h:406-409），所以再上一次也还是 1 层、层数不叠。
  // ⚠ 整场战斗不递减、不过期（`removeStatus<HEX>` 只在 `Player::removeDebuffs` 里，
  // 那是橙色药丸 / 神性那一路，与回合末无关）。
  | "hex"
  // 困惑（史尼克的惑目，第二十五批）：**抽到每一张牌时**把它的费用改成 `cardRandomRng.random(3)`
  // 的结果（0~3，含端）。与诅咒是同一族的纯 bool 状态，实现全在 `CardManager::draw`
  // （CardManager.cpp:403-412），见 `drawOneCard` 的注释。
  // ⚠ 四处非直觉，都在 `drawOneCard` 里逐条写着：**每抽一张就消耗一次 cardRandomRng**
  //   （与新费用是否等于原费用无关）、**`cost` 与 `costForTurn` 都改且是永久的**、
  //   只在 `cost != newCost` 时才赋值、`freeToPlayOnce = false` 在 `cost >= 0` 的门**里面**。
  // ⚠ 与腐化/疯狂那类「只改 `costForTurn`」的降费不是一族：它改的是 `cost` 本身，
  //   所以回合末 `resetAttributesAtEndOfTurn` 复位过去也还是新费用。
  | "confused"
  // 束缚（尖塔幼体的缠绕，第三十三批）：**玩家身上**，每个玩家回合结束受到 = 层数的伤害。
  // 对齐 `Player::applyEndOfTurnPowers` 的 `case PS::CONSTRICTED: addToBot(DamagePlayer(层数))`
  // （Player.cpp:374-376）——就这一句，整条 Power 没有别的读点。
  // ⚠ 三处照抄：
  //  ① **不递减、不摘除**：那条 case 只有伤害、没有 `decrementStatus` 也没有 `RemoveStatus`
  //     （与缠绕 / 二连击那种「回合末整条清掉」正相反）。所以一旦上身就跟到战斗结束，
  //     而尖塔幼体的出招规则里有一道 `!player.hasStatus<CONSTRICTED>()` 的门 →
  //     **它那一招一场仗最多出一次**。
  //  ② 伤害走 `Actions::DamagePlayer` = **非攻击伤害**（不吃怪物力量与玩家易伤），
  //     但**照样被格挡吸收**，且 `selfDamage` 取默认的 false（不触发破裂）。
  //  ③ 枚举值是 **9**，排在 `ENTANGLED`(10) **之前**——`applyEndOfTurnPowers` 遍历的是
  //     `std::map`（枚举序），所以它是那个循环里第一个命中的。
  // ⚠ 施加走的是普通的 `Player::debuff` 尾段（`statusMap[s] += amount`），会**叠加**，
  //   而且**会被神器吃掉**（那道门在前面）。
  | "constricted"
  | "poison" // 中毒：持有者回合开始受到 = 层数的伤害（无视格挡），然后层数 -1（静默主机制）
  | "focus" // 集中：机器人充能球的被动/唤醒数值 +N（被动修正器）
  | "metallicize" // 金属化：每当自己回合结束，获得 N 点格挡（拉加维林睡眠期）
  // 沉睡：拉加维林开局自带的**纯 bool** 标记（`isBooleanPower(MS::ASLEEP)` 为真，
  // MonsterStatusEffects.h:168），层数无意义、harness 按 1 输出（`getStatusInternal` 对
  // bool 类 `return true`）。它有三个读者：`getMoveForRoll`（决定首个意图是睡还是吸魂）、
  // `preBattleAction`（睡着才上金属化 8 + 格挡 8）、以及睡眠那条 case 的醒没醒判断。
  // 清除点在**两条伤害路径**的「未被格挡」段里（Monster.cpp:388 / :448），并连带把
  // 金属化 8 层一起递减掉。
  | "asleep"
  | "ritual" // 仪式：回合开始 +N 力量（触发）
  | "curl_up" // 蜷缩：首次被攻击时获得格挡（触发，一次性）
  | "sharp_hide" // 反甲：被攻击时对攻击者（玩家）反弹 N 点无视格挡的伤害（守卫者防御姿态）
  | "enrage" // 激怒：玩家每打出一张技能牌，此敌人获得 = 层数的力量（地精头目）
  | "artifact" // 神器：抵消下一个施加到自己身上的减益（每抵消一个消耗一层）
  | "demon_form" // 恶魔形态：每个玩家回合开始时获得 = 层数的力量（玩家能力牌）
  // 荆棘：**玩家侧**（青铜鳞片等）每次被攻击时对攻击者反弹 = 层数的伤害；
  // **怪物侧**（第三十二批的尖刺客，全参考项目只有它带）挂在 `attackedUnblockedHelper`
  // 那条 else-if 链的**第六格**（易塑/反应之后、沉睡之前，Monster.cpp:384-386）：
  //   `bc.addToTop( Actions::DamagePlayer(getStatus<MS::THORNS>()) )`
  // ⚠ 两侧共用这一个 PowerId（harness 两边都 dump 成 `THORNS`），但触发点不同：
  //   玩家那条在 `Player::attacked` 里、怪物这条要求**先破格挡**，且都是 `addToTop`。
  // ⚠⚠ 与守卫者的「尖锐外壳」（`sharp_hide`）**不是一回事**：那条挂在
  //   `BattleContext::onUseAttackCard` 的最末，**打出攻击牌**就触发（哪怕这一击被格挡吃光、
  //   哪怕打的是别的怪）。两者都走 `DamagePlayer`，形状像、时点完全不同。
  // ⚠ 怪物侧的荆棘**只增不减**：开局 `{3,4,7}[getTriIdx(asc,2,17)]`，增生尖刺每次 +2，
  //   而出招规则攒够 6 次就封顶（asc0 上限 15）。
  | "thorns"
  // 再生（觉醒者，第三十七批第一次有宿主）：**怪物身上**，`preBattleAction` 上 10 层
  // （asc19 是 15）。
  // ⚠ 唯一的读点是 `Monster::applyEndOfTurnTriggers` 的**第五句**
  //   （金属化 → 易塑 → 镀甲 → 虚无缥缈 → **再生** → 枷锁，Monster.cpp:59-61）：
  //       if (hasStatus<MS::REGEN>()) { heal(getStatus<MS::REGEN>()); }
  // ⚠⚠ **怪物侧的再生一层都不掉**——参考这里只有 `heal`，没有任何 `decrementStatus`。
  //   玩家侧那条（回合末回血再 -1 层，`Player::applyAtEndOfRoundPowers`）是**另一回事**，
  //   两边共用这一个 PowerId（harness 两边都 dump 成 `REGEN`），但语义不同，别互相顶替。
  // ⚠ `Monster::heal` 是 `curHp = std::min(maxHp, curHp + amount)`（Monster.cpp:276），
  //   所以满血时这一层白加、也不会溢出。
  // ⚠ 半死的觉醒者**不吃这一条**：`applyEndOfRoundPowers` 的两个循环都跳过 `isDying()` 的怪，
  //   而半死必然伴随 `curHp == 0`。所以假死期间它不会被自己的再生救回来。
  | "regen"
  // 好奇心（觉醒者，第三十七批）：**怪物身上**，`preBattleAction` 上 1 层（asc19 是 2）。
  // ⚠⚠ **参考里它是一个纯粹的标记：唯一的读点被整段注释掉了。**
  //   真实游戏的语义是「玩家每打出一张能力牌，此怪 +层数 力量」，而参考的那段
  //   （`BattleContext::onUsePowerCard` 的最末，BattleContext.cpp:1909-1912）写着
  //       // auto &m = monsters.optionMap[2];
  //       // if (m.hasStatusInternal<MS::CURIOSITY>()) { m.buff<MS::STRENGTH>(...); }
  //   ——连怪物下标都是写死的 2。**照抄参考的实际行为（什么都不做）**：补上它就没有预言机
  //   了（预言机就是参考本身）。这是「参考与真实游戏分歧」的候选，见 TODOS 的待裁定。
  // ⚠ 它照样**必须建模**：它进怪物快照（开局那一帧就是 `CURIOSITY: 1`），而且
  //   `Monster::die` 的觉醒者分支会 `removeStatus<MS::CURIOSITY>()` 把它摘掉
  //   ——所以「假死之后它从快照里消失」是逐帧可比对的。
  // ⚠ 复活那条 case **不补回来**（与暗影客重生时补 REGROW 正相反），二阶段身上没有它。
  | "curiosity"
  // 镀甲（带壳寄生虫，第二十五批）：两处协同，都在 sts-combat.ts 里。
  //  ① **回合末加 = 层数的格挡**（`applyEndOfTurnTriggers`，Monster.cpp:51-52，
  //     是同步 `addBlock`，排在金属化与易塑之后）；
  //  ② **受到未被格挡的攻击伤害时 -1 层**（`attackedUnblockedHelper` 的 else-if 链里
  //     排**第二格**——无敌之后、蜷缩之前，Monster.cpp:352-355），且**归零那一刻**
  //     若这只怪是带壳寄生虫就把意图改成 `SHELLED_PARASITE_STUNNED`（那道门是怪种专属的，
  //     镀甲本身别的怪也有）。
  // ⚠ 与飞行**正相反**：`decrementStatus<PLATED_ARMOR>` 走的是「`<= WEAK` 那一支」，
  //   它 `setHasStatus(newAmount)`，所以归零时 statusBits **真的被清掉**（Monster.h:299-303）。
  //   于是壳破之后这一格让位给链上后面的蜷缩 / 飞行 / 易塑，回合末也不再加格挡。
  //   飞行那条写的是裸的 `setStatus`、不碰 bit，所以摔下来之后它照样占着自己那一格。
  //   两者建模方式因此不同：镀甲归零**整条摘掉**，飞行**永不摘除**。
  | "plated_armor"
  // 狂怒：每次**受到攻击**（`Monster::attacked`，Monster.cpp:424）就获得 = 层数的力量。
  // ⚠ 判定在格挡吸收**之前**且与伤害无关——打在格挡上、甚至 0 伤害也照涨，与蜷缩
  // （只在破了格挡时触发）正相反。狂暴地精开局自带 1 层（asc17 是 2）。
  | "angry"
  // 孢子云：真菌兽开局自带（preBattleAction 里 buff 2 层），死亡时给玩家 2 层易伤。
  // ⚠ 层数只是标记：参考的 `Monster::die` 硬写 `DebuffPlayer<VULNERABLE>(2, …)`，不读层数。
  | "spore_cloud"
  // 易塑：每受到一次**未被格挡**的攻击伤害就获得 = 层数的格挡，然后层数 +1；
  // 回合末复位回 3。开局由 preBattleAction 给 3 层（食蛇草 / 蠕动血块，全项目只有这两只）。
  // ⚠ 三处协同（漏一处就静默错）：`Monster::preBattleAction` 置 3
  // （MonsterSpecific.cpp:248-250）、`attackedUnblockedHelper` 的 else-if 链里加格挡并 +1
  // （Monster.cpp:369-374）、`applyEndOfTurnTriggers` 复位成 3（Monster.cpp:47-49）。
  // ⚠ 加的那层格挡是 `addToBot(MonsterGainBlock)`——**入队**，所以触发它的那一击不被减免。
  | "malleable"
  // 飞行（拜鸟，全项目只有它带）：三处协同，任何一处漏了都不会报错、只会越打越偏。
  //  ① **减半来卡牌伤害**：`calculateCardDamage` 末段 `if (hasStatus<FLIGHT>()) damage *= .5;`
  //     （BattleContext.cpp:2764），位置在易伤之后、虚无缥缈之前。
  //  ② **受到未被格挡的攻击伤害时层数 -1**（`attackedUnblockedHelper` 的 else-if 链里
  //     自成一格，排在蜷缩之后、易塑之前，Monster.cpp:362-368）；**减到 0 的那一击**
  //     （判的是「减之前恰好是 1」）把意图改成 `BYRD_STUNNED`，也就是「摔下来」。
  //  ③ **每个怪物回合开始复位回 3**（asc17 是 4，Monster.cpp:28-30），于是它又飞起来。
  // ⚠⚠ **层数归零不等于这条 Power 没了**：参考的 `setStatus` 只写数值、**不碰 statusBits**
  //   （Monster.h:194-241），而上面三处读的全是 `hasStatus`（读 bit）。所以摔下来之后
  //   ① 伤害**照样减半**、③ 回合开始**照样复位**，而 ② 还会把层数一路减成负数。
  //   我们这边因此把它建模成「条目一旦加上就永不摘除」，`amount` 可以是 0 甚至负数
  //   ——快照两侧都按「层数为 0 就不输出」折叠，所以负数是真的会出现在 trace 里的。
  // ⚠ 起飞（`BYRD_FLY`）用的是 `buff`（**累加** 3），不是 setStatus——而那一回合开头刚被
  //   复位成 3，于是飞完是 6。照抄，别写成「置 3」。
  | "flight"
  | "mode_shift" // 模式切换累计（守卫者，内部计数用）
  // 随从（第二十七批）：**怪物身上**的纯 bool 标记（`isBooleanPower(MS::MINION)` 为真，
  // MonsterStatusEffects.h:184-187），harness 因此恒输出 `MINION: 1`。
  // ⚠ **在参考的战斗内它一次都不被读**：三个读者全在卡牌效果里
  // （`Actions.cpp:1084 / :1123 / :1174`——「不影响随从」那一族，对应真实游戏里
  // 恐惧/献祭之类不对随从生效的牌），而那三张牌一张都没登记。
  // 它照样必须建模：地精首领带来的两只小鬼与召唤出来的两只都有它，会进怪物快照。
  | "minion"
  // 随从首领（第二十七批）：同样是纯 bool 标记，地精首领开局自带（preBattleAction）。
  // ⚠ **它有一个战斗内的真读者，而且是决定性的**：`Monster::die` 的
  //   `if (monstersAlive == 0 || hasStatus<MS::MINION_LEADER>()) { outcome = 胜利; return; }`
  //   （Monster.cpp:293-297）——首领一死**当场判胜**，小鬼还站着也算赢，
  //   而且那条 `return` 让后面的亡语一概不跑。
  // ⚠ 参考里另有四个宿主（青铜自动机 / 蜥蜴法师 / 收藏家 / 觉醒者二阶段），
  //   第二十八批装上了青铜自动机，剩下三只还没登记。
  | "minion_leader"
  // 痛苦突刺（第二十八批）：突刺之书开局自带的纯 bool 标记（`isBooleanPower` 为真，
  // MonsterStatusEffects.h:188 那张名单里），harness 恒输出 `PAINFUL_STABS: 1`。
  // ⚠ 读点在**玩家侧**：`Player::attacked` 的 `damage > 0` 分支里
  //   `addToBot(Actions::MakeTempCardInDiscard({CardId::WOUND}))`（Player.cpp:250-252）
  //   ——**每一次「打穿了格挡」的攻击**塞一张伤口，所以多段攻击每段各塞一张，
  //   而被完全挡住的那一段一张都不塞。
  // ⚠ 位置逐位对齐：它排在**镀甲递减之后、`hpWasLost` 之前**（同一个 `if (damage > 0)` 块）。
  | "painful_stabs"
  // 停滞（第二十八批）：青铜球用过停滞后自带的纯 bool 标记（`isBooleanPower` 为真）。
  // ⚠ 唯一的读点是 `Monster::die` 的 else-if 链（Monster.cpp:308-309）：带这一位的怪死掉时
  //   把它扣住的那张牌还回手牌。⚠ 它与孢子云 / 重生**在同一条 else-if 链上**，
  //   所以顺序照抄（当前没有一只怪同时带两位）。
  // ⚠ 「已经用过停滞」这件事**另有一份记录**：出招规则读的是 `miscInfo`，不是这一位
  //   （MonsterSpecific.cpp:2110）。两者由两条独立的语句维护，别合成一处。
  | "stasis"
  // 通用力量增长（暗球游荡者，第三十三批）：**怪物身上**，开局 `preBattleAction` 自带
  // 3 层（asc17 是 5）。⚠ 层数**真的被读**——`Monster::applyEndOfRoundPowers` 的最后一句是
  //   `if (hasStatus<GENERIC_STRENGTH_UP>()) buff<MS::STRENGTH>(getStatus<...>());`
  //   （Monster.cpp:103-105），即**每个回合末涨 = 层数的力量**，而它自己一层都不掉。
  // ⚠ 与仪式（RITUAL）不是一回事，两处差别都可观察：
  //   ① 仪式带 `wasJustApplied` 的 skipFirst（施加当回合不结算），这一条**没有**——
  //      开局上的 3 层在**第一个回合末**就生效；
  //   ② 位置不同：仪式是那个函数的**第一句**、这一条是**最后一句**（中间隔着缓慢 / 锁定 /
  //      虚弱 / 易伤的递减）。当前没有一只怪同时带两者，但照抄位置。
  //   参考自己在枚举那行注了 `// todo just merge this with orb walker strength up`，
  //   说明它清楚两者像但没合并——**照抄，别自作主张合并**。
  // ⚠ 全参考项目**只有暗球游荡者一个宿主**。
  | "generic_strength_up"
  // 重生（暗影客，第三十四批）：**怪物身上**的纯 bool 标记（`isBooleanPower(MS::REGROW)`
  // 为真，MonsterStatusEffects.h:189），harness 恒输出 `REGROW: 1`。
  // ⚠ 唯一的读点是 `Monster::die` 的那条 else-if 链（Monster.cpp:303-306）——它排在
  //   **孢子云与停滞之间**（第二十八批装停滞时特意留出的那个「中间格」）：
  //       if (SPORE_CLOUD) … else if (REGROW) { resetAllStatusEffects(); setMove(DARKLING_REGROW);
  //                                             halfDead = true; } else if (STASIS) …
  //   所以带这一位的怪不是真死，而是进入**半死**态（`halfDead`，见 `CombatMonster`）。
  // ⚠⚠ **它自己会被 `resetAllStatusEffects()` 一起清掉**（那句 `statusBits = 0`），
  //   所以复活那条 case 里必须**再 buff 一次**（MonsterSpecific.cpp:1493）——
  //   漏掉的话第二次死亡就变成真死。
  // ⚠ 那条判胜 `return` 排在这条链**之前**：最后一只暗影客倒下时玩家直接获胜，
  //   它不会半死、也不会重生。
  | "regrow"
  // 变换（复形怪，第三十四批）：**怪物身上**的纯 bool 标记（`isBooleanPower(MS::SHIFTING)`
  // 为真），harness 恒输出 `SHIFTING: 1`，开局 `preBattleAction` 上。
  // ⚠ 读点有**两处**，都在「未被格挡的伤害」段里，形状不同：
  //   ① `attackedUnblockedHelper` 那条 else-if 链的**最后一格**（Monster.cpp:393-396）；
  //   ② `damageUnblockedHelper` 里的一个**独立 if**（Monster.cpp:453-456，与沉睡同族）。
  //   两处的函数体一模一样：`addDebuff<MS::STRENGTH>(-damage); buff<MS::SHACKLED>(damage);`
  // ⚠ 于是「这一击打了多少」被原样转成**负力量 + 等量枷锁**，而枷锁在**回合末**
  //   （`applyEndOfTurnTriggers`）又原样还回力量——所以复形怪在**它自己的回合里**
  //   力量是负的（本回合挨了多少就减多少），回合末归零。
  | "shifting"
  // 消逝（复形怪，第三十四批）：**怪物身上**的层数 Power（`uniquePower0` 后端），
  // 开局 `preBattleAction` 上 5 层（asc17 是 6）。
  // ⚠ 它**没有**任何回合末的自动递减：唯一的递减点是复形怪那条招式的**最后一句**
  //   `decrementStatus<MS::FADING>()`（MonsterSpecific.cpp:1528），所以「层数」实际是
  //   「还能出手几次」。层数降到 0 时 `decrementStatus` 连 statusBits 一起清掉。
  // ⚠ 自杀的门是**递减之前**的 `getStatus<FADING>() == 1`（`:1524`），而且那条
  //   `Actions::SuicideAction(idx, **false**)` 走的是 `Monster::suicideAction`
  //   ——**不是**死亡链（见 Effect 的 `suicide`）。
  | "fading"
  // 反应（蠕动血块，第三十五批）：**怪物身上**，`uniquePower1` 后端（与无敌 / 尖锐外壳同族）。
  // ⚠⚠ 开局是 `setHasStatus<MS::REACTIVE>(true); setStatus<MS::REACTIVE>(0);`
  //   （MonsterSpecific.cpp:210-214）——**bit 置上、层数是 0**，不是 `buff(1)`。
  //   所以它在快照里**平时不出现**（harness 的 `getStatusInternal` 返回 0 就被折叠掉），
  //   只有「挨了打、`ReactiveRollMove` 还没出队」的那几帧才看得见 `REACTIVE: n`。
  //   我们这边因此把它建模成「条目一直在、`amount` 可以是 0」（同飞行那一族）。
  // ⚠ 它与易塑**共用** `attackedUnblockedHelper` 那条 else-if 链的**同一格**
  //   （`else if (hasStatus<MALLEABLE>() || hasStatus<REACTIVE>())`，Monster.cpp:369-383），
  //   进去之后两个 if 各判各的。全参考项目只有蠕动血块两者都带。
  // ⚠ 语义：每挨一次**未被格挡**的攻击，层数为 0 时置 1 并**入队**一条
  //   `Actions::ReactiveRollMove`，否则 +1；那条动作按层数**连滚 N 次意图**再把层数置 0。
  | "reactive"
  // 缓慢（巨头，第三十五批）：**怪物身上**，`uniquePower0` 后端（与易塑 / 荆棘同族）。
  // ⚠ 开局同样是 `setHasStatus<MS::SLOW>(true); setStatus<MS::SLOW>(0);`
  //   （MonsterSpecific.cpp:163-165）——bit 置上、层数 0，不是 `buff(n)`。
  // ⚠ 三处协同，缺一处就静默错：
  //   ① `BattleContext::onAfterUseCard` 顶部 `if (m.hasStatus<SLOW>()) m.buff<SLOW>(1);`
  //      （BattleContext.cpp:1986-1988）——玩家**每打出一张牌** +1，而且**只看 0 号位**；
  //   ② `calculateCardDamage` 的「敌人 AtDamageReceive」段
  //      `damage *= 1 + static_cast<float>(getStatus<SLOW>()) * 0.1f;`（:2748-2750），
  //      排在**易伤之前**；
  //   ③ `Monster::applyEndOfRoundPowers` 的**第二句** `setStatus<SLOW>(0)`（Monster.cpp:79-81）
  //      ——**每个回合末清零**（不是递减、也不摘除 bit）。
  | "slow"
  // —— 玩家能力牌触发型 power（在对应触发点由 combat 结算，玩家专属）——
  | "combust" // 燃烧：每个玩家回合结束，失 1 生命并对所有敌人造成 = 层数的伤害
  | "feel_no_pain" // 无痛：每消耗一张牌，获得 = 层数的格挡
  | "dark_embrace" // 暗黑拥抱：每消耗一张牌，抽 = 层数的牌
  | "juggernaut" // 主宰：每当你获得格挡，对随机敌人造成 = 层数的伤害
  | "brutality" // 残暴：每个玩家回合开始，失 = 层数的生命并抽 = 层数的牌
  | "barricade" // 壁垒：格挡不再于回合开始清空（层数只作存在标记）
  | "rupture" // 破裂：每当你因打出的牌失去生命，获得 = 层数的力量
  | "thousand_cuts" // 千刃：每打出一张牌，对所有敌人造成 = 层数的伤害
  | "after_image" // 残影：每打出一张牌，获得 = 层数的格挡
  | "noxious_fumes" // 毒雾：每个玩家回合开始，令所有敌人获得 = 层数的中毒
  | "devotion" // 虔诚：每个玩家回合开始，获得 = 层数的法力（观者）
  | "mental_fortress" // 心之堡垒：每次姿态改变，获得 = 层数的格挡（观者）
  | "rushdown" // 疾攻：每次进入愤怒姿态，抽 = 层数的牌（观者）
  | "storm" // 风暴：每打出一张能力牌，充能 = 层数的闪电球（机器人）
  | "heatsinks" // 散热：每打出一张能力牌，抽 = 层数的牌（机器人）
  | "static_discharge" // 静电放电：每受到穿透格挡的攻击伤害，充能 = 层数的闪电球（机器人）
  | "machine_learning" // 机器学习：每个玩家回合开始，多抽 = 层数的牌（机器人）
  | "evolve" // 进化：每抽到一张状态牌，额外抽 = 层数的牌
  | "corruption" // 腐化：技能牌费用变 0，且打出后消耗（铁甲）
  | "nirvana" // 涅槃：每次预知，获得 = 层数的格挡（观者）
  | "infinite_blades" // 无尽之刃：每个玩家回合开始，将 = 层数的飞刀加入手牌（静默）
  | "intangible" // 虚无缥缈：受到的一切伤害降为 1（回合结束 -1 层）
  | "blur" // 疾影：格挡不在回合开始清空（层数即剩余生效回合数，回合末 -1）
  | "biased_cognition" // 偏置认知：每个玩家回合开始失去 1 点集中（机器人）
  | "buffer" // 缓冲：抵消下一次会让你失去生命的伤害（每抵消一次 -1 层）
  | "battle_hymn" // 战歌：每个玩家回合开始，将 = 层数的痛斩加入手牌（观者）
  | "strength_temp" // 临时力量：回合结束时失去 = 层数的力量（屈伸），随后本 power 清零
  | "dexterity_temp" // 临时敏捷：本回合按此加成格挡，回合结束时清零（对偶手镯）
  | "rage" // 暴怒：本回合每打出一张攻击牌，获得 = 层数的格挡（回合末清零）
  | "double_tap" // 连击：接下来的 = 层数张攻击牌各额外结算一次（每消耗一次 -1 层）
  | "berserk" // 狂暴：每个玩家回合开始，获得 = 层数的能量（代价是自身易伤，狂暴）
  | "loop" // 循环：每个玩家回合开始，额外触发最左侧球的被动 = 层数次（机器人）
  | "tools_of_the_trade" // 行业工具：每个玩家回合开始，抽 = 层数的牌并随机弃 = 层数的牌（静默）
  | "wave_of_the_hand" // 挥手：本回合每当你获得格挡，令所有敌人获得 = 层数的虚弱（观者，回合末清零）
  | "deva_form" // 提婆形态：每个玩家回合开始获得 = 层数的能量，然后层数 +1（观者，能量递增）
  | "vigor" // 活力：下一张攻击牌额外造成 = 层数的伤害（打出后清零，烈焰花环）
  | "no_draw" // 本回合无法再抽牌（战意；回合开始清除）
  | "foresight" // 未卜先知：每个玩家回合开始预知 = 层数张（观者）
  | "panache" // 华彩：本回合每打出满 5 张牌，对所有敌人造成 = 层数的伤害（观者）
  | "free_attack" // 回身步：下 = 层数张攻击牌费用视为 0（每打出一张攻击消耗一层）
  | "accuracy" // 敏锐：飞刀（shiv）额外造成 = 层数的伤害（静默）
  | "lock_on" // 靶心：带此的敌人受到闪电/暗球伤害 ×1.5（回合末 -1，机器人）
  | "choked" // 扼喉：本回合玩家每打出一张牌，此敌人损失 = 层数的生命（玩家回合末清除，静默）
  | "well_laid_plans" // 深谋远虑：回合结束可额外保留至多 = 层数张牌（静默）
  | "mark" // 标记：玩家每次攻击此敌人，获得 = 层数的格挡（观者·以手言心，敌人身上）
  // 偷窃：此敌人每次「抢劫」类招式偷走的金币上限（拾荒者 / 盗贼，开局 preBattleAction 掷定）。
  // ⚠ 它是**数值来源**而不是显示标记：参考的 `stealGoldFromPlayer(bc, getStatus<MS::THIEVERY>())`
  // 直接读它（MonsterSpecific.cpp:920/912），所以数值写在 `PRE_BATTLE_ACTION` 而非招式里。
  | "thievery"
  | "envenom" // 淬毒：玩家攻击造成穿透格挡的伤害时，给该敌人施加 = 层数的中毒（静默）
  | "shackled" // 枷锁：此敌人被临时削弱的力量，将在其行动过后归还（内部记账，黑暗枷锁）
  | "sadistic_nature" // 虐念：玩家每给敌人施加一个减益，对其造成 = 层数的伤害（静默）
  | "establishment" // 既定事实：每当一张牌被保留，其费用永久 -层数（观者）
  | "study" // 研习：每个玩家回合结束，将 = 层数张「洞悉」加入抽牌堆（观者）
  | "omega" // 奥米加：每个玩家回合结束，对所有敌人造成 50×层数 的伤害（观者）
  | "master_reality" // 掌控现实：战斗中生成的牌进场即升级（观者）
  | "corpse_bomb" // 尸爆：此敌人死亡时，把它的中毒施加给其余所有敌人（静默，敌人身上）
  | "self_repair" // 自我修复：战斗结束时回复 = 层数的生命（机器人）
  | "magnetism" // 磁力：每个玩家回合开始，将 = 层数张随机无色牌加入手牌（机器人）
  | "flame_barrier" // 火焰屏障：本回合每当被攻击，对攻击者反弹 = 层数的伤害（回合末清除，铁甲）
  | "like_water" // 静如止水：回合结束若处于平静姿态，获得 = 层数的格挡（观者）
  | "burst" // 爆发：接下来的 = 层数张技能牌各额外结算一次（每消耗一次 -1 层，静默）
  | "phantasmal" // 幻杀：本回合你的攻击造成双倍伤害（回合末清除，静默）
  | "collect" // 采集：接下来 = 层数个回合，回合开始各将一张 0 费「洞悉」加入手牌（每回合 -1，观者）
  | "fire_breathing" // 烈焰吐息：每当你抽到状态牌或诅咒牌，对所有敌人造成 = 层数的伤害（铁甲）
  | "mayhem" // 混乱：每个玩家回合开始，打出抽牌堆顶 = 层数张牌（机器人）
  | "amplify" // 增幅：接下来的 = 层数张能力牌各额外结算一次（每张 -1 层，机器人）
  | "echo_form" // 回响形态：每回合你打出的第一张牌额外结算一次（机器人）
  | "creative_ai" // 创意 AI：每个玩家回合开始，将 = 层数张随机能力牌加入手牌（机器人）
  | "hello_world" // 你好世界：每个玩家回合开始，将 = 层数张随机普通牌加入手牌（机器人）
  | "no_card_block" // 无法格挡：牌产生的格挡被抑制（层数即剩余生效回合数，回合末 -1，应急按钮）
  | "electrodynamics" // 电动力学：闪电球伤害命中所有敌人（机器人）
  // 时间扭曲（时间吞噬者，**敌人身上·计数器**，第三十八批）。
  // ⚠ 层数是「本场已打出多少张牌」的计数，不是强度：`preBattleAction` 里 `buff<TIME_WARP>(0)`
  //   开局置 0，玩家每打出一张牌 +1，**数到 11 的那一次**（即第 12 张）归零、此敌人 +2 力量、
  //   并**立即结束玩家回合**。结算点在 `onAfterUseCard` 那条共享出牌路径上，见那里的注释。
  // ⚠ 与缓慢（SLOW）同族的「位置上、层数 0」写法：0 层时不进快照，读点必须用 `hasPower`。
  | "time_warp"
  // 抽牌削减（时间吞噬者的头槌，**玩家身上·一次性**，第三十八批）。
  // ⚠ 它是个**纯 bool 标记**，真正的数值住在 `CombatPlayer.cardDrawPerTurn`：
  //   `Player::debuff<DRAW_REDUCTION>` 无视 amount、恒 `--cardDrawPerTurn` 并置位
  //   （Player.h:385-390），回合开始那次 skipFirst 到期时再 `++cardDrawPerTurn` 并摘掉
  //   （BattleContext.cpp:2227-2233）。所以层数恒是 1（harness 也按 1 输出），叠加两次
  //   只会让 `cardDrawPerTurn` 再少 1，快照里还是 1。
  | "draw_reduction"
  // 无敌（腐化之心，**敌人身上**，第四十七批）。
  // ⚠⚠ 它是 `attackedUnblockedHelper` 那条 else-if 链的**第一格**，也是整条链上最后一个
  //   补上宿主的格子（第三十五批点名过：「链上现在只剩第一格『无敌』没有宿主」）。
  //   全参考项目**只有腐化之心**带它（`preBattleAction`：`buff<INVINCIBLE>(asc19 ? 200 : 300)`，
  //   MonsterSpecific.cpp:144）。
  // ⚠ 读点有**三处**，形状各不相同，逐处照抄：
  //   ① `applyStartOfTurnPowers`（Monster.cpp:32-34）：**每个怪物回合开始复位**回
  //      `asc19 ? 200 : 300`——门是 `hasStatus`，写的是 `setStatus`（覆盖）。
  //      这是「每回合最多只能被打掉 N 点血」的机制本体。
  //   ② `attackedUnblockedHelper` 的链首（:348-351）：
  //        damage = std::min(damage, getStatus<INVINCIBLE>());
  //        setStatus<INVINCIBLE>(getStatus<INVINCIBLE>() - damage);
  //      ⚠ **它改写 `damage` 本身**，而这个值一路流到末尾的 `curHp -= damage`——
  //      所以它不是「先扣血再记账」，是「先把这一击削平再扣血」。
  //   ③ `damageUnblockedHelper` 的**第一个 if**（:444-447），函数体逐字相同，
  //      但那里它**不构成 else-if**（沉睡与变换是并列的独立 if）。
  // ⚠ 层数**永不摘除**（写的是裸 `setStatus`、不碰 statusBits，与飞行同族），
  //   所以打到 0 之后它照样占着链首那一格——本回合此后任何一击都被削成 0 点。
  | "invincible"
  // 死亡节拍（腐化之心，**敌人身上**，第四十七批）。
  // ⚠ 唯一读点在 `BattleContext::onAfterUseCard` 的 `triggerOnUse` 门里
  //   （BattleContext.cpp:1988-1990）：`addToBot(Actions::DamagePlayer(层数))`
  //   ——**玩家每打出一张牌**吃一次非攻击伤害。它是那道门里的**第三条**，
  //   顺序照参考：时间扭曲 → 缓慢 → 死亡节拍，三者共用同一道门、都只读 `arr[0]`。
  // ⚠ 层数有两个来源：`preBattleAction` 的 `buff<BEAT_OF_DEATH>(asc19 ? 2 : 1)`
  //   与「强化」那一招的第二档 `buff<BEAT_OF_DEATH>(1)`（**累加**，MonsterSpecific.cpp:1848）。
  | "beat_of_death"
  // 被围攻（尖塔护盾开局给**玩家**上的纯 bool 标记，第四十七批）。
  // ⚠ 它在参考里是 `Player::debuff` 那条「只置位、不写 statusMap」的名单里
  //   （Player.h:335-343，与壁垒 / 腐化 / 困惑 / 笔尖同族），所以 harness 恒输出 `SURROUNDED: 1`。
  // ⚠⚠ 唯一读点在 `Monster::calculateDamageToPlayer`（Monster.cpp:565-570），
  //   而且它读的是一个**此前没有任何人读过的字段** `Player::lastTargetedMonster`：
  //     const bool facingSelf = p.lastTargetedMonster == idx ||
  //                             bc.monsters.arr[p.lastTargetedMonster].isDeadOrEscaped();
  //     if (!facingSelf) { damage *= 1.5; }
  //   即「你没在打这只怪的时候，它从背后打你多 50%」。参考在这一行自注 `// todo this is
  //   probably wrong`——照抄，见 TODOS 待裁定。
  | "surrounded"
  | "duplication"; // 复制：接下来 = 层数张打出的牌各额外结算一次（复制药水；每张 -1 层）

/**
 * 爬升度分档（第二十一批）。**敌人专用**——参考里带 asc 分档的全部是怪物侧数值。
 *
 * 匹配规则：按 `atLeast` **降序**取第一条满足 `ascension >= atLeast` 的，一条都不满足就用
 * 效果自己的基础值。所以基础值恒等于 asc0，既有数据一个字节都不用改。
 *
 * 为什么放在**效果**上而不是「整条招式换一份效果表」：参考写的是
 * `attackPlayerHelper(bc, asc2 ? 12 : 11)`——分档挂在**那个数**上。挂在招式上就得把整份
 * 效果表复制一遍，以后改基础表要记得同步改每一档，而这里改的是同一处。
 *
 * ⚠ 三档以上也照抄得动：参考的 `strengthBuff[] = {3,4,5}` + `hallwayIdx =
 * getTriIdx(asc, 2, 17)` 等价于 `[{atLeast:17,amount:5},{atLeast:2,amount:4}]` + 基础 3。
 */
export type AscTier = { atLeast: number; amount: number };

/** 玩家出牌 / 敌人出招共用的效果原语。target 相对「行动者」解析。 */
export type Effect =
  // strengthMultiplier：力量按该倍率计入伤害（重刃 ×3/×5）；省略即 ×1（普通攻击）。
  // ascAmount：敌人专用的爬升度分档，覆盖 `amount`（见 AscTier）。
  // perMonsterTurn：敌人专用的**回合线性成长**（第三十四批）。伤害是
  //   `amount + perMonsterTurn * (getMonsterTurnNumber() - 1)`，对齐复形怪的
  //   `const auto damage = (asc2 ? 40 : 30) + 10*(bc.getMonsterTurnNumber()-1);`
  //   （MonsterSpecific.cpp:1522）。省略 = 不成长（既有的怪都是这一种）。
  // ⚠ 它读的是**全局回合计数**（`bc.turn + 1`），与这只怪自己的状态无关——与大嘴吞噬的
  //   `times: "monsterTurnHalf"` 同源、与 `deal_damage_rolled` 的 `miscInfo` 无关。
  // ⚠ `ascAmount` 只覆盖 `amount`（那个 `asc2 ? 40 : 30`），成长步长 10 是常数。
  // monsterTurnRamp：敌人专用的**封顶回合成长**（第三十五批）。伤害是
  //   `amount + min(getMonsterTurnNumber() - subtract, cap) * scale`，对齐巨头「时候到了」的
  //   `const auto t = std::min(bc.getMonsterTurnNumber()-5, 6) * 5;`
  //   `const auto damage = (asc3 ? 40 : 30) + t;`（MonsterSpecific.cpp:1578-1580）。
  // ⚠ 它与 `perMonsterTurn` 是**两种不同的成长**，别互相顶替：那条是无上限的线性
  //   `step * (turnNo - 1)`（复形怪的重殴），这条先减一个偏移、再**封顶**、最后乘步长。
  // ⚠⚠ `t` **可以是负数**（`std::min` 不夹下界）：巨头的第一次「时候到了」出在第 4 个怪物
  //   回合，`min(4-5, 6) * 5 = -5`，伤害是 30-5 = **25**，比第 5 回合的 30 还低。
  //   写成 `max(0, …)` 会让第一击多打 5 点。
  // ⚠ `ascAmount` 只覆盖 `amount`（那个 `asc3 ? 40 : 30`），三个成长参数都是常数。
  | {
      kind: "deal_damage";
      amount: number;
      strengthMultiplier?: number;
      ascAmount?: AscTier[];
      perMonsterTurn?: number;
      monsterTurnRamp?: { subtract: number; cap: number; scale: number };
    }
  | { kind: "deal_damage_all"; amount: number }
  // 敌人用：**非攻击伤害**打在玩家身上（爆破怪的自爆 30 点，第三十二批）。对齐
  // `bc.addToBot( Actions::DamagePlayer(30) )`（MonsterSpecific.cpp:1395）。
  //
  // ⚠ **不能拿 `deal_damage` 顶替**，四处不同：
  //   ① 走 `Player::damage` 而不是 `Player::attacked`：**不过 `calculateDamageToPlayer`**
  //      ——怪物力量、玩家易伤、虚弱一概不参与，30 就是 30；
  //   ② **不触发玩家侧的荆棘 / 火焰屏障**（那两条挂在 `Player::attacked` 上，需要攻击者下标）；
  //   ③ 照样**被格挡吸收**（与 `lose_hp` 那族相反）；
  //   ④ 它**不在 `isMoveAttack` 白名单里**——参考的判据正是「有没有走 `attackPlayerHelper`」，
  //      所以带着这条效果的招式在觅敌之弱眼里**不是攻击**。⚠ 真实游戏显示的是攻击意图，
  //      这一格记在 TODOS「待裁定」。
  | { kind: "damage_player_non_attack"; amount: number; ascAmount?: AscTier[] }
  // 敌人用：**自杀**（爆破怪的自爆，第三十二批）。对齐
  // `bc.addToBot( Actions::SuicideAction(idx, true) )`（MonsterSpecific.cpp:1396）。
  //
  // 不带参数：`triggerRelics = true` 那一支的函数体就是
  //   `if (m.isAlive()) { m.damage(bc, m.curHp); }`（Actions.cpp:923-933），
  // 即**走正常的非攻击伤害路径把自己打到 0**——所以死亡链（亡语 / 地精角 / 活体样本）
  // 全部照常触发，这正是那个参数名的含义。逐条形状见 sts-combat.ts 里那条 case。
  // ⚠ 全参考项目有两个宿主：爆破怪与蜥蜴法师的匕首（`DAGGER_EXPLODE`，:1634），
  //   两者写法逐字相同。⚠ 但**匕首的自爆算攻击**（走 `attackPlayerHelper(bc, 25)`）、
  //   爆破怪的不算（走 `DamagePlayer(30)`），别把两只怪的前半段也当成一样的。
  //
  // ⚠⚠ **`triggerRelics` 的另一支（第三十四批）**：复形怪写的是
  //   `Actions::SuicideAction(idx, **false**)`（MonsterSpecific.cpp:1525），走的是
  //   `Monster::suicideAction`（Monster.cpp:327-337）而**不是** `m.damage(bc, curHp)`：
  //       if (!isAlive()) return;
  //       --bc.monsters.monstersAlive;
  //       curHp = 0;
  //       if (monstersAlive == 0) outcome = PLAYER_VICTORY;
  //   即「把血置 0 并自己减活怪数」——**整条死亡链一句都不跑**（没有 `Monster::die`，
  //   于是亡语 / 重生 / 地精角 / 活体样本全不触发），也**不扣格挡**、不走 `onHpLost`。
  //   两支的差别在带重生的怪身上是决定性的，所以这个开关必须逐招写清。
  // ⚠ 默认值取 **true**（= 爆破怪与匕首那一支），这样已登记的两处一个字都不用改。
  //
  // ⚠ `onlyIfSelfPower`（第三十四批）：这条自杀带一道门——复形怪那句是
  //   `if (getStatus<MS::FADING>() == 1) { addToBot(SuicideAction(idx, false)); }`。
  //   门读的是**递减之前**的层数，所以「最后一次出手」才自杀；把 `equals` 抄成 0
  //   会让它永远不消失（层数在收尾里减，读到 0 时它已经不在身上了）。
  | {
      kind: "suicide";
      triggerRelics?: boolean;
      onlyIfSelfPower?: { power: PowerId; equals: number };
    }
  // ascAmount 覆盖**每一击**的 amount。绝大多数多段攻击的段数是恒定的——参考写的是
  // `attackPlayerHelper(bc, asc4 ? 6 : 5, 2)`（六火幽魂冲撞 MonsterSpecific.cpp:841），
  // 分档挂在那个伤害数上，段数是第二个实参、恒定。
  //
  // ⚠ `times: "miscInfo"`（第二十八批）：段数取本敌人的 `miscInfo`，而不是一个字面量。
  // 唯一的用户是突刺之书的乱刺——`attackPlayerHelper(bc, asc3 ? 7 : 6, miscInfo)`
  //（MonsterSpecific.cpp:457-460）。它是本项目第一条「段数由状态决定」的多段攻击：
  // `miscInfo` 从 1 起步（`preBattleAction` 里 `++miscInfo`），出招规则每发一次乱刺再 +1，
  // 于是整场单调递增。⚠ **别把它写成 `deal_damage_rolled`**：那一条读 `miscInfo` 当**伤害**
  // （虱子的咬击），这一条读它当**段数**，两者的宿主都在用同一个字段但含义相反。
  //
  // ⚠⚠ `ascTimes`（第三十批）：**爬升度挂在段数上**，而不是每击伤害上。全参考项目只有三处
  // 把 `asc? :` 写在 `attackPlayerHelper` 的**第三个**实参位上，第二幕里只有一处——
  // 拜鸟的啄击 `attackPlayerHelper(bc, 1, asc2 ? 6 : 5)`（MonsterSpecific.cpp:548）；
  // 另两处是 `SPIRE_SPEAR_SKEWER`（:1824，`10, asc3 ? 4 : 3`）与 `CORRUPT_HEART_BLOOD_SHOTS`
  //（:1829，`2, asc4 ? 15 : 12`），都在第三 / 四幕。
  // ⚠ 它与 `ascAmount` **正交**：判据只有一条——**看参考把 `asc? :` 写在哪个实参位上**。
  //   啄击的每击伤害是常数 1、段数才分档；冲撞正相反。两者写反的代价不是「总伤害差一点」，
  //   而是段数错 → 玩家侧格挡 / 荆棘 / 火焰屏障各自触发的**次数**都错。
  // ⚠ `ascTimes` 与 `times: "miscInfo"` 互斥（参考里没有任何一招同时用状态段数与分档段数）。
  //
  // ⚠⚠ `times: "monsterTurnHalf"`（第三十三批）：段数 = `(getMonsterTurnNumber() + 1) / 2`
  //   的 **C++ 整数除法**。唯一的用户是大嘴的吞噬——`attackPlayerHelper(bc, 5, t)`
  //   （MonsterSpecific.cpp:1440-1441）。于是段数是 1,1,2,2,3,3,…（第 1/2 个怪物回合各 1 段，
  //   第 3/4 个各 2 段……），整场随回合数单调不减。
  //   ⚠ 它与 `"miscInfo"` 是两件事：那条读的是**这只怪的状态字段**（会被出招规则改写），
  //     这条读的是**全局回合计数**（`bc.turn + 1`，与这只怪无关）。
  //   ⚠ 与 `ascTimes` 也互斥：吞噬的每击伤害是裸的 5（参考那里没有任何 `asc? :`）。
  //   ⚠ 段数在**排队那一刻**读一次就定了（`attackPlayerHelper` 里的 `for` 循环早于任何一段落地）。
  | {
      kind: "deal_damage_multi";
      amount: number;
      times: number | "miscInfo" | "monsterTurnHalf";
      ascAmount?: AscTier[];
      ascTimes?: AscTier[];
    }
  // 每次命中随机挑一个存活敌人（剑刃回旋镖：3 点 ×3，逐次随机目标）。
  | { kind: "deal_damage_random"; amount: number; times: number }
  | { kind: "deal_damage_equal_to_block" }
  // 敌人用：伤害取自本敌人锁定的固定值（红虱咬击；六火幽魂六重打击 times 连击）。
  // ⚠ `ascAdd`（第三十四批）：在**掷定值之上再加**一个爬升度分档的常数，而不是像
  //   `ascAmount` 那样**覆盖**。唯一的用户是暗影客的撕咬——
  //   `const auto damage = miscInfo + (asc2 ? 2 : 0);`（MonsterSpecific.cpp:1475）。
  //   基础值是 0，所以 asc0 下就是纯 `miscInfo`。别把它写成 `ascAmount`：那会把掷定值整个丢掉。
  | { kind: "deal_damage_rolled"; times?: number; ascAdd?: AscTier[] }
  // 敌人用：按玩家当前生命锁定一个每击伤害存入 miscInfo（六火幽魂激活：floor(hp/divisor)+add）。
  | { kind: "store_hp_scaled_damage"; divisor: number; add: number }
  // 敌人用：**直接把 `miscInfo` 覆盖成一个常数**（第三十五批）。唯一的用户是蠕动血块的
  // 「植入」——参考那条 case 的第一句就是 `miscInfo = true;`（MonsterSpecific.cpp:1540），
  // 即「这场仗已经植入过了」的标志位，读点在 `getMoveForRoll` 的 `haveUsedImplant`。
  // ⚠ `miscInfo` 是**一个 int、含义逐怪种不同**（见 `CombatMonster.miscInfo`），所以这条
  //   原语只管「写进去」，语义由宿主自己的出招规则决定；别按用途拆成新字段。
  // ⚠ 与 `store_hp_scaled_damage` 的差别：那条要算（读玩家血量），这条是字面量覆盖。
  // ⚠ **同步**（参考那一句不在任何 `addToBot` 里），而且排在紧随其后那次同步 `rollMove`
  //   之前——出招规则读的正是它，顺序错了「植入」会连出两次。
  | { kind: "set_misc_info"; amount: number }
  // 敌人用：**往玩家牌组里塞一张诅咒**（第四十批）。唯一的用户仍是蠕动血块的「植入」。
  // ⚠⚠ **参考不建模那张牌**（塞进 master deck 属于 run 层），所以这条效果在战斗内
  //   **只剩两个遗物的反应**（MonsterSpecific.cpp:1541-1545）：
  //       if (!bc.player.hasRelic<R::OMAMORI>()) {
  //           if (bc.player.hasRelic<R::DARKSTONE_PERIAPT>()) { bc.player.increaseMaxHp(6); }
  //       }
  //   两个遗物都没有的场次（此前的全部语料）它是**彻底的空操作**——这正是它到第四十批
  //   才登记的原因：在此之前写了也没有任何 trace 能分辨。
  // ⚠ 它与 `set_misc_info` 是**同一条 case 里的两句**，参考的顺序是先置位再走这一支；
  //   拆成两条效果是为了别把遗物反应误挂到觉醒者那条 `set_misc_info` 上。
  // ⚠ **同步**（那两句都不在 `addToBot` 里）。
  | { kind: "obtain_curse" }
  // sync：敌人专用。参考的怪物加格挡有**两种写法并存**——绝大多数是**同步** `addBlock(n)`
  // （拾荒者烟雾弹 MonsterSpecific.cpp:937 等 20 余处），少数是 `addToBot(MonsterGainBlock)`
  // （颚虫的猛击/咆哮 :858/:865 等 6 处）。省略 = 入队（既有怪都是这一种）。
  // minAscension：敌人专用，语义与 `apply_power` 上那一位相同（**整条效果**只在
  // `ascension >= minAscension` 时才结算）。第三十八批加的宿主是时间吞噬者的加速——
  // `if (asc19) { addBlock(32); }`（MonsterSpecific.cpp:1640-1642），一条多出来的语句。
  | {
      kind: "gain_block";
      amount: number;
      sync?: boolean;
      ascAmount?: AscTier[];
      minAscension?: number;
    }
  // 玩家用：当前格挡翻倍（坚守）。
  | { kind: "double_block" }
  // 玩家用：充能一颗指定类型的球（机器人；球槽满则先唤醒最左侧的球）。
  | { kind: "channel_orb"; orbType: OrbType }
  // 玩家用：唤醒最左侧 count 颗球（触发唤醒效果后移除）。
  | { kind: "evoke"; count: number }
  // 玩家用：进入指定姿态（观者；离开平静时 +2 能量）。
  | { kind: "enter_stance"; stance: PlayerStance }
  // 敌人用：给一名随机存活友军加格挡（护盾地精保护）。
  | { kind: "gain_block_ally"; amount: number; ascAmount?: AscTier[] }
  // 敌人用：给**写死 1 号位**的友军加格挡（百夫长的防守，第二十六批）。对齐
  // `MonsterSpecific.cpp:562-569`：`if (getAliveCount() > 1) { auto &mystic = arr[1];
  // mystic.addBlock(asc17 ? 20 : 15); }`。
  //
  // ⚠ 与上面那条 `gain_block_ally`（护盾地精）**是三件不同的事**，别复用：
  //   ① 目标是**写死的 1 号位**，不是随机友军——一次 aiRng 都不掷；
  //   ② 它是**同步** `addBlock`，不是 `addToBot(GainBlockRandomEnemy)`；
  //   ③ 候选为空（只剩自己）时**什么都不做**，而护盾地精那条会退化成「给自己加」。
  // ⚠ 百夫长自己**一点格挡都不加**——这一招是纯粹「护住奶妈」。它与出招规则是配套的：
  //   秘法师死了之后 `getMoveForRoll` 就不再返回防守（改出狂怒连斩），所以「场上只剩自己
  //   还出防守」这个局面在参考的内容集合里压根不存在。
  //
  // noAliveGate（第二十八批）：**连那道 `monstersAlive > 1` 的门都没有**。青铜球的支援光束
  //   整条 case 就是 `bc.monsters.arr[1].addBlock(12);`（MonsterSpecific.cpp:524-527）——
  //   一个 if 都不带。省略 = 百夫长那种带门的形状。
  //   ⚠ 在**当前的内容集合**里两者同解，而且是可以证明的：出这一招要求这颗球活着
  //   （`doMonsterTurn` 的门），而自动机一死战斗当场就结束（它带 `MINION_LEADER`，
  //   `Monster::die` 命中即写 `outcome` 并 `return`）——于是「球活着」蕴含「自动机也活着」，
  //   `monstersAlive >= 2` 恒成立。所以这一位是**等价改写**、不是盲区，仍然照抄形状：
  //   参考真的没写那道门，补上去就是第二份真相。
  | {
      kind: "gain_block_ally_fixed";
      amount: number;
      ascAmount?: AscTier[];
      noAliveGate?: boolean;
    }
  // sync：敌人专用。给玩家上减益有两种写法并存：绝大多数是
  // `addToBot(Actions::DebuffPlayer<...>)`，而拉加维林的吸取灵魂写的是
  // `Actions::DebuffPlayer<PS::DEXTERITY>(-1).actFunc(bc)`（MonsterSpecific.cpp:882-883）
  // ——**当场执行**。与 `gain_block` 的 sync 同族。
  //
  // ⚠⚠ **省略时的含义逐 `on` 不同，因为参考的两族各有各的多数写法**（第三十批）：
  //   * `on: "target"` 省略 = **入队**（`addToBot(Actions::DebuffPlayer<...>)`，绝大多数怪）；
  //   * `on: "self"`   省略 = **同步**（`buff<MS::X>(n)`，全部 40 余处自身 buff 都是这一种）。
  //   这个不对称是故意的：它让**已登记的每一只怪都不必回填任何一位**，而参考侧的形状
  //   仍然逐位可表达。反过来（统一成「省略 = 入队」+ 给所有既有怪补 `sync: true`）需要
  //   回填 40 余处，漏一处就是静默改变一只已冻结怪的行为——那是这个项目最不能容忍的失败模式。
  // ⚠ `on: "self"` 侧的唯一例外、也是加这一位的**唯一理由**：工头 asc18 那条
  //   `addToBot(Actions::BuffEnemy<MS::STRENGTH>(idx, 1))`（MonsterSpecific.cpp:1237）
  //   ——**入队**的自身 buff，写 `sync: false`。它排在伤害之后、塞伤口之前，所以那 1 点力量
  //   要等动作出队才出现在快照里，本回合这一鞭的伤害吃不到它。
  //   ⚠ 同族的先例是守卫者的双重猛击（`addToBot(Actions::BuffEnemy<MODE_SHIFT>(idx, miscInfo))`，
  //     :1371），但那一条走的是 `MOVE_TURN_END` 里的手写函数（实参要在建动作那一刻求值），
  //     不是数据表里的一条效果。
  // ⚠ 第二十九批多了**第三种写法**：冠军的嘲讽写的是裸的
  //   `bc.player.debuff<PS::WEAK>(2, true);`（MonsterSpecific.cpp:1302-1303）
  //   ——连 `Actions::DebuffPlayer` 都没经过，直接调 `Player::debuff`。它与拉加维林那种
  //   `.actFunc(bc)` 逐位等价（那个 Action 的函数体就是 `player.debuff<s>(amount,
  //   isSourceMonster)`，BattleContext.h:229-234），所以这边同样用 `sync: true` 表达。
  // ascAmount：敌人专用的爬升度分档，覆盖 `amount`（见 AscTier）。
  // minAscension：敌人专用——**整条效果**只在 `ascension >= minAscension` 时才结算。
  //   参考里这是「case 里多出来的一句 `if (asc17) addToBot(...)`」，与「同一个数换个值」
  //   是两回事：肥胖地精的猛击在 asc17 会**额外**上一层脆弱（MonsterSpecific.cpp:646-648）。
  | {
      kind: "apply_power";
      power: PowerId;
      amount: number;
      on: "self" | "target" | "all_enemies";
      sync?: boolean;
      ascAmount?: AscTier[];
      minAscension?: number;
    }
  | { kind: "draw"; amount: number }
  | { kind: "gain_energy"; amount: number }
  | { kind: "lose_hp"; amount: number }
  // 玩家回复最大生命的百分比（血之药水 40%）。
  | { kind: "heal_percent"; percent: number }
  // 玩家回复固定生命（包扎等）。
  | { kind: "heal"; amount: number }
  // 玩家用：当前力量翻倍（极限爆发）。
  | { kind: "double_strength" }
  // 玩家永久提升最大生命并回复等量（果汁药水）。
  | { kind: "gain_max_hp"; amount: number }
  // 敌人用：偷取玩家金币（拾荒者 / 盗贼）。
  // ⚠ **不带数值**：偷多少由本敌人的 `thievery` Power 决定（开局 preBattleAction 掷定），
  // 对齐 `stealGoldFromPlayer(bc, getStatus<MS::THIEVERY>())`。玩家金币不足则按余额钳制。
  | { kind: "steal_gold" }
  // 敌人用：本敌人逃离战斗（拾荒者烟雾弹后逃跑）。
  // ⚠ 逃跑**不是死亡**：生命保持 >0、不触发任何亡语，但 `isDeadOrEscaped` 为真，
  // 于是它不再行动、不能被指向、不参与随机选敌，并且 `monstersAlive` 会减一。
  | { kind: "escape" }
  // 敌人用：**吸血攻击**（带壳寄生虫的吸取，第二十五批）。对齐
  // `Actions::VampireAttack`（Actions.cpp:97-106）——参考里全项目只有它一个用户，
  // 注释写着 `// only used by shelled parasite so idx is 0`。
  //
  // ⚠ 一条动作里干两件事，不能拆成「攻击 + heal_self」两条效果：
  //   ① `bc.player.attacked(bc, 0, damage)`；
  //   ② 紧接着**同步**判 `m.isAlive()`（血 > 0，不是 `!isDeadOrEscaped`），
  //      真则 `m.heal(min(damage, player.lastAttackUnblockedDamage))`。
  //   回血量取的是「这一击**真正扣掉的血**」——被格挡挡住多少就少回多少，全挡住就一点不回。
  //   拆成两条效果的话第二条会排在别的动作后面，而且拿不到那一击的未被格挡量。
  // ⚠ 它的 `clearOnCombatVictory` 是**默认的 true**，而普通攻击 `Actions::AttackPlayer`
  //   显式传的是 **false**（Actions.cpp:85-88）。照抄这个不对称。
  // ⚠ 目标写死 **0 号位**（连荆棘/火焰屏障反弹给谁也是 0），不是「自己」——见
  //   `vampireAttack` 的注释：参考的内容集合里带壳寄生虫恒在 0 号位，故不产生分歧。
  | { kind: "vampire_attack"; amount: number; ascAmount?: AscTier[] }
  // 敌人用：治疗 **0 号位的友军 + 自己**（秘法师的治疗，第二十六批）。对齐
  // `MonsterSpecific.cpp:600-608`：
  //   `if (monstersAlive > 1) { auto &knight = arr[0]; knight.heal(amt); } heal(amt);`
  //
  // ⚠ **不是**「治一名受伤的友军，没有就治自己」（这条注释在第二十六批之前就是这么写的、
  //   而且是错的）。参考里三处都要照抄：
  //   ① 目标写死 **0 号位**，不看谁受伤、不掷任何 RNG；
  //   ② 自己**无条件**也回同样的量——不是「二选一」，同伴活着时两只都回；
  //   ③ 两句都是**同步**的，所以紧随其后那次同步 rollMove 已经看得见新血量
  //      （秘法师的出招规则读的正是「自己或 0 号位缺了多少血」，见 `MOVE_RULES.mystic`）。
  // ⚠ `heal` 本身带上限钳制（`curHp = min(maxHp, curHp + amount)`，Monster.cpp:269-277）。
  | { kind: "heal_ally"; amount: number; ascAmount?: AscTier[] }
  // 敌人用：给 **0 号位的友军 + 自己**加一个 Power（秘法师的鼓舞，第二十六批）。对齐
  // `MonsterSpecific.cpp:588-598`：
  //   `if (monstersAlive > 1) { arr[0].buff<MS::STRENGTH>(n); } buff<MS::STRENGTH>(n);`
  // 形状与 `heal_ally` 逐字对应（写死 0 号位、自己无条件、两句都同步），只是换成 buff。
  // ⚠ 与 `apply_power` + `on: "all_enemies"` **不是一回事**：那个是「场上每一只」，
  //   这个是「0 号位与自己」——三只以上的编队里两者会分岔（当前没有这样的编队）。
  //
  // noAliveGate（第三十九批）：**连那道 `monstersAlive > 1` 的门都没有**。多努的能量之环
  //   整条 case 就是 `bc.monsters.arr[0].buff<MS::STRENGTH>(3); buff<MS::STRENGTH>(3);`
  //   （`MonsterSpecific.cpp:1677-1681`），而且参考在第一句行尾自注
  //   `// shouldn't matter if deca is dead`——它**知道**迪卡可能已经死了，并且**故意**
  //   不判。省略 = 秘法师那种带门的形状。
  //   ⚠⚠ 与 `gain_block_ally_fixed.noAliveGate`（青铜球那条）**不是同一种「当前同解」**：
  //   青铜球那条可以证明门恒真（球活着 ⇒ 自动机也活着），而这条**真的会走到 false 侧**
  //   ——harness 的策略恒打 0 号位，迪卡先死是常态，多努照样每两个回合给尸体 +3 力量。
  //   实测「补上那道门」红 58 例，见 TODOS「验证方式 · 第三十九批」。
  | {
      kind: "buff_ally";
      power: PowerId;
      amount: number;
      ascAmount?: AscTier[];
      noAliveGate?: boolean;
    }
  // 敌人用：给**写死 1 号位**的友军加一个 Power（迪卡守护方阵的 asc19 镀甲，第四十六批）。
  // 对齐 `MonsterSpecific.cpp:1689-1699`：
  //   ```cpp
  //   auto &deca = *this;
  //   auto &donu = bc.monsters.arr[1];
  //   deca.addBlock(16);
  //   donu.addBlock(16);
  //   if (asc19) { deca.buff<MS::PLATED_ARMOR>(3); donu.buff<MS::PLATED_ARMOR>(3); }
  //   ```
  // ⚠⚠ **它与 `buff_ally` 的差别只有一处，但那一处是承重的：下标。** `buff_ally` 写死的是
  //   **0 号位**（秘法师的鼓舞 / 多努的能量之环，两者都站在 1 号位、照顾 0 号位的同伴），
  //   这一条写死的是 **1 号位**（迪卡站在 0 号位、照顾 1 号位的多努）。第三十九批装迪卡时
  //   **正是因为缺这个原语**，asc19 那两句镀甲**整条没有转写**（`ascCalibrated` 没置，
  //   asc>0 直接抛错），账记在 `enemies.ts` 的守护方阵注释与 TODOS 里，本批一并结清。
  // ⚠ 形状与 `gain_block_ally_fixed` 逐字对应（同一个下标、同样**同步**执行、同样
  //   「候选为空就什么都不做」），只是把格挡换成 Power——两条正好是同一条 case 里的两句。
  // ⚠ **它不给自己加**：参考那两句是两条独立语句，自己那一份走的是 `apply_power` +
  //   `on: "self"`（省略 `sync` = 同步，与 `buff<MS::PLATED_ARMOR>(3)` 同解）。这与
  //   `buff_ally` / `heal_ally` 那种「友军 + 自己」的合并形状**不同**，别照搬。
  //   ⚠ 书写顺序也照抄参考：**自己那条排在前面**（`deca.buff` 先于 `donu.buff`）。
  // noAliveGate：与 `gain_block_ally_fixed` / `buff_ally` 上那一位同名同形——省略 = 带
  //   `monstersAlive > 1` 的门（百夫长 / 秘法师那种）。迪卡这条**一道门都没有**，所以为真。
  //   ⚠ 这一位在本条上是**盲区**而不是「当前同解」：策略恒打 0 号位 ⇒ 迪卡先死是常态，
  //   而「多努先死」在这个编队里实测 0 / 120。关门条件是 `donu_and_deca@tgt1`。
  // minAscension：整条效果只在 `ascension >= minAscension` 时才结算，语义与
  //   `apply_power` 上那一位相同。参考那两句包在 `if (asc19)` 里，是「多出来的一整条语句」。
  | {
      kind: "buff_ally_fixed";
      power: PowerId;
      amount: number;
      ascAmount?: AscTier[];
      noAliveGate?: boolean;
      minAscension?: number;
    }
  // 敌人用：**蜥蜴法师的召唤**（第三十六批）。对齐 `Monster::reptomancerSummon`
  //（MonsterSpecific.cpp:3589-3608）——本项目**第四条也是最后一条**召唤路径。
  // ⚠ 第三十六批之前这里是一个通用的 `{ kind: "summon"; defIds: string[] }`，那是旧近似
  //   战斗留下的占位、唯一的读者是数据表自己。四个召唤宿主并排看之后（并列表见 WORKFLOW）
  //   **没有任何两个能共用代码**，所以那条通用形状连同它的最后一个用户一起删掉了。
  //
  // ⚠⚠ **它与前三条一处都不共用，十处形状全不同**（照搬邻居必错）：
  //   ①⚠⚠ **召几只由爬升度决定**：`reptomancerSummon(bc, asc18 ? 2 : 1)`——全参考项目
  //      唯一一个「召唤数量看爬升度」的地方（地精 / 青铜球恒 2，收藏家是 `3 - monstersAlive`）。
  //      asc0 下恒 1 只，所以 asc18 那一档是本批的结构性盲区。
  //   ②⚠ **参考是 `Monster` 的成员函数 + 一个自由的 helper**（`reptoSummonHelper`），
  //      而且在 `takeTurn` 里是**裸的同步调用**（`:1620-1622` 没有 addToBot）——
  //      与青铜球同侧、与地精首领 / 收藏家（都是 `Actions::` + addToBot）相反。
  //   ③⚠⚠ **找空位的顺序是写死的 `{4, 1, 3, 0}`**，门是 `!isAlive()`（血 <= 0）。
  //      地精是 `{1, 2, 0}`、青铜球写死 0 与 2 且不判空、收藏家用一张两格的落位表。
  //      ⚠ 它扫 **4** 格（0/1/3/4），**跳过 2 号位**——那是法师自己站的地方。
  //   ④ **有 `= Monster()` 整只重建**（地精 / 收藏家有、青铜球没有）。
  //   ⑤ 血量：`construct` 里掷一次（匕首是普通的 `setRandomHp`，没有白掷也不跑两遍）。
  //   ⑥⚠ **意图靠 `setMove(DAGGER_STAB)`**（与收藏家同侧，与地精 / 青铜球的 `rollMove` 相反），
  //      所以召唤本身不为「选意图」掷 aiRng。
  //   ⑦⚠⚠ **aiRng 在循环里逐只还**：`bc.noOpRollMove()` 写在 for 体内、每召一只一次。
  //      收藏家是**循环之外**再跑一个 `for` 统一还——次数相同、位置不同，而位置在
  //      「召两只」时才可观察（中间隔着第二只的 construct，monsterHpRng 与 aiRng 的交错不同）。
  //   ⑧ `++monstersAlive` 在循环**里面**，且排在 `construct` **之后、`setMove` 之前**
  //      （收藏家那条在循环末尾）。
  //   ⑨⚠⚠ **末尾 `bc.monsters.skipTurn.set(daggerIdx, true)`** ——全参考项目**唯一**的
  //      写入点（`MonsterGroup.h:24` 的 `std::bitset<5>`）。落在游标还没走到的格子里的匕首
  //      **本回合不行动**。前三条召唤都不用它：青铜球靠 `++monsterTurnIdx`、
  //      地精首领与收藏家的宿主位置让新来的本来就轮不到。
  //   ⑩ **没有 `++monsterTurnIdx`**（青铜球那条有）。
  // 与前三条相同的只有两件事：`buff<MS::MINION>()`、以及 `monsterCount` 一动不动。
  // 逐条见 sts-combat.ts 的 `reptomancerSummon`。
  | { kind: "summon_daggers"; count: number; ascAmount?: AscTier[] }
  // 敌人用：**地精首领的召唤**（第二十七批）。对齐 `Actions::SummonGremlins`
  //（Actions.cpp:459-497）——参考里全项目只有它一个用户，写死了地精首领的场地形状。
  //
  // ⚠ 不带参数（与 `split` / `split_boss` 同族）：召唤什么、填哪一格、消耗哪条 RNG 全部
  // 写在 sts-combat.ts 的 `summonGremlins` 里，因为每一条都是「地精首领专属」而不是数据。
  // 逐条见那个函数的注释；最容易抄错的三处是
  //   ① 找空位的顺序是 **1, 2, 0**（0 号位是开局预留的空格，排在最后）；
  //   ② 挑种类走 **aiRng**，而建怪时（`MonsterGroup::createMonsters`）走的是 **miscRng**；
  //   ③ **不重跑 `preBattleAction`** —— 召唤出来的狂暴小鬼因此没有狂怒。
  | { kind: "summon_gremlins" }
  // 敌人用：**青铜自动机的召唤**（第二十八批）。对齐 `Monster::spawnBronzeOrbs`
  //（MonsterSpecific.cpp:3443-3464）。
  //
  // ⚠⚠ **它与 `summon_gremlins` 不共用任何东西，五处形状都不同**（照搬地精那条必错）：
  //   ① 参考不是一个 `Action`，而是 `takeTurn` 里的**同步**函数调用（`:503` 没有 addToBot）；
  //      地精那条是 `addToBot(Actions::SummonGremlins())`。
  //   ② 落位下标**写死 0 与 2**，没有「按 1,2,0 找空位」那套搜索、也不判 `isDying()`；
  //   ③ 怪种是**固定的** `BRONZE_ORB`，所以**一次 aiRng 都不为「挑种类」而掷**
  //      （地精那条走 `getGremlin(bc.aiRng)`，两只各一次）；
  //   ④ **没有 `= Monster()` 重建**（地精那条有）——那两格从没被构造过，所以当前等价；
  //   ⑤ 末尾多一句 **`++bc.monsterTurnIdx`**，于是 2 号位那颗球**本回合不行动**
  //      （与 `largeSlimeSplit` 里那次同源，地精那条没有）。
  // 相同的只有两件事：`buff<MS::MINION>()`、以及每只各自 `rollMove`（各一次 aiRng 起）。
  // ⚠ 每颗球照样在 `construct` 里掷血量，而青铜球带 `hpDiscardRoll` → 每颗 **2 次** monsterHpRng。
  | { kind: "summon_bronze_orbs" }
  // 敌人用：**收藏家的召唤**（第二十九批）。对齐 `Actions::SpawnTorchHeads`
  //（Actions.cpp:500-527）——本项目**第三条召唤路径**。
  //
  // ⚠⚠ **它与前两条一处都不共用，八处形状全不同**（照搬邻居必错，并列表见 WORKFLOW）：
  //   ① **召几只不是常数**：`spawnCount = 3 - bc.monsters.monstersAlive`——这是全参考项目
  //      **唯一**按 `monstersAlive` 决定召唤数量的地方，所以它也是「预留空位不算活怪」
  //      这件事的预言机（把空位算成活的 → 开局一只都不召）。
  //   ② **落位表是 `spawnIdxs[2] {(arr[1].isDying() ? 1 : 0), 0}`**：先 1 号位（空着的话）、
  //      再 0 号位。既不是地精那套「按 1,2,0 搜索」，也不是青铜球那种「写死 0 与 2」。
  //      ⚠ 第二格恒是 **0**（不是搜索出来的），所以两只时必然填 1 与 0。
  //   ③ **有 `= Monster()` 整只重建**（青铜球那条没有）。
  //   ④⚠⚠ **`construct` 之后又显式 `initHp` 了一次**（参考那行注着 `// bug somewhere in
  //      game`），于是每只火炬头消耗 **2 次** monsterHpRng、**保留第二次的取值**。
  //      这**不是** `hpDiscardRoll`：那一族的白掷在 `initHp` 内部、恒用低档区间，
  //      这里是整个 `initHp` 跑两遍（asc>=9 时两次都用高档）。
  //   ⑤ **意图靠 `setMove(TORCH_HEAD_TACKLE)`，不是 `rollMove`**——前两条召唤都是 rollMove。
  //      于是召唤本身**一次 aiRng 都不掷**。
  //   ⑥ **aiRng 在末尾统一还**：`for (i < spawnCount) bc.noOpRollMove();`——按**只数**
  //      掷同样多次 `random(99)` 并全部丢掉。次数与召几只绑定，抄成固定 2 次会在
  //      「只死了一只」的那些回合错位。
  //   ⑦ `++monstersAlive` 在循环**里面**（每召一只加一次），不是末尾一次 `+= 2`。
  //   ⑧ **没有 `++monsterTurnIdx`**（青铜球那条有）：收藏家在**最后一格**，新召的两只
  //      本回合本来就轮不到。
  // 与前两条相同的只有两件事：`buff<MS::MINION>()`、以及 `monsterCount` 一动不动。
  | { kind: "summon_torch_heads" }
  // 敌人用：给**前两格**（火炬头的两个位置）加一个 Power（收藏家的增幅，第二十九批）。
  // 对齐 `MonsterSpecific.cpp:1310-1321` 那个 for 循环：
  //   ```cpp
  //   for (int i = 0; i < 2; ++i) {
  //       auto &torchHead = bc.monsters.arr[i];
  //       if (!torchHead.isDying()) {
  //           torchHead.buff<MS::STRENGTH>(strAmounts[bossDiffIdx]);
  //       }
  //   }
  //   ```
  // ⚠ 与地精首领的 `buff_minions` **不是同一族**，两处不同：① 范围是 0..**1** 两格
  //   （首领那条是 0..2 三格）；② **不给随从加格挡**（首领那条给 `asc3 ? 10 : 6`）。
  //   收藏家自己的力量与格挡是循环**之后**两句独立语句，在数据表里用 `apply_power` +
  //   `gain_block sync` 表达，与这条一一对应参考的三句。
  // ⚠ 门是 `!isDying()` = **血 > 0**（不是 `alive`）：开局那两个空格血 0，天然跳过；
  //   刚死的火炬头也跳过。全部**同步**，不入队。
  | { kind: "buff_torch_heads"; power: PowerId; amount: number; ascAmount?: AscTier[] }
  // 敌人用：**清掉自己身上的减益**（冠军的暴怒，第二十九批）。对齐 `Monster::removeDebuffs`
  //（Monster.cpp:522-535）——参考里怪物侧只有它与觉醒者的假死两个调用点。
  //
  // ⚠ 它**不是「清空所有 Power」**，而是一张写死的名单：
  //   ① `if (getStatus<STRENGTH>() < 0) setStatus<STRENGTH>(0);` ——**只抬负值**，
  //      正的力量原样保留（所以暴怒不会把自己刚加的力量清掉）；
  //   ② `removeStatus<>()` 九条：BLOCK_RETURN / CHOKED / CORPSE_EXPLOSION / LOCK_ON /
  //      MARK / POISON / SHACKLED / VULNERABLE / WEAK。
  //   `removeStatus` 同时清数值与 statusBits（Monster.h:495-501），所以我们整条摘掉。
  // ⚠ 名单里 `BLOCK_RETURN` / `CORPSE_EXPLOSION` 在我们的 `PowerId` 里**还不存在**
  //   （它们的来源——束缚之球 / 尸爆——都没登记）。登记那两张牌时要回来把它们加进这一条。
  | { kind: "remove_debuffs" }
  // 敌人用：**停滞**——把玩家的一张牌从牌堆里扣住（青铜球，第二十八批）。对齐
  // `Monster::stasisAction`（MonsterSpecific.cpp:3515-3549）。不带参数：取哪一张、扣到哪里、
  // 什么时候还回来全写在 sts-combat.ts 的 `stasisAction` / `returnStasisCard` 里。
  //
  // ⚠ 逐条形状（每一条都有可观测面，因为牌堆快照逐帧比对）：
  //  ① 抽牌堆与弃牌堆**都空**时直接 return，**一次 RNG 都不掷**、也不上 STASIS；
  //  ② 抽牌堆空则从**弃牌堆**取，否则从**抽牌堆**取（不是「两堆合起来」）；
  //  ③ 挑哪一张走 `stasisHelper`：先按**稀有度**筛（RARE > UNCOMMON > COMMON），
  //     三种都没有才退化成 `cardRandomRng.random(n-1)` 平均挑；筛出来之后按参考的
  //     `cardSortedIdx` **稳定排序**再 `cardRandomRng.random(size-1)` 取一个。
  //     ⚠ 两条路径都**恰好掷一次** cardRandomRng。
  //  ④ 取走之后 `notifyRemoveFromCombat`（会减 `strikeCount`），然后存进
  //     `stasisCards[min(1, idx)]` —— 0 号位的球存槽 0、2 号位的球存槽 1；
  //  ⑤ 上 `MS::STASIS`（进怪物快照）。这颗球**死的时候**（`Monster::die` 的 else-if 链，
  //     Monster.cpp:308-309）把牌**还进手牌**（走 `moveToHandHelper`，满 10 张改进弃牌堆）。
  | { kind: "stasis" }
  // 敌人用：**给「随从」们加 Power 与格挡，然后给自己加同样的 Power**（地精首领的鼓舞，
  // 第二十七批）。对齐 `MonsterSpecific.cpp:710-727`：
  //   ```cpp
  //   for (int i = 0; i < 3; ++i) {              // 0/1/2 三格，写死
  //       auto &minion = bc.monsters.arr[i];
  //       if (!minion.isDying()) {               // 死的（含从没构造过的空格）跳过
  //           minion.buff<MS::STRENGTH>(strGain);
  //           minion.addBlock(asc3 ? 10 : 6);
  //       }
  //   }
  //   buff<MS::STRENGTH>(strGain);               // 自己只加力量，**不加格挡**
  //   ```
  // ⚠ 与第二十六批那三条「写死下标」的原语（`gain_block_ally_fixed` / `heal_ally` /
  //   `buff_ally`）**不是同一族**：那三条只碰一个固定下标，这条是**遍历 0..2**
  //   （参考真的写了 for 循环，注释里还说 `// not going to use action queue here`）。
  //   也与 `apply_power` + `on: "all_enemies"` 不是一回事——那个是「场上每一只」，
  //   这条的范围是**前三格**，首领自己（3 号位）走的是循环外那一句、而且没有格挡。
  // ⚠ 参考在循环**之前**还有一句 `bc.aiRng.random(0, 2)`（注了 `// for in game quote`），
  //   结果丢弃、只影响计数器。它不是效果，落在 `MOVE_TURN_BEGIN` 里。
  // ⚠ 门是 `!isDying()`（血 ≤ 0），不是 `alive`：形状照抄，理由见那个函数。
  // ascAmount 覆盖 `amount`（力量），blockAscAmount 覆盖 `block`——两档是**两个独立的分档**
  //   （力量是 `{3,4,5}[eliteDiffIdx]`，格挡是 `asc3 ? 10 : 6`），别合成一个。
  | {
      kind: "buff_minions";
      power: PowerId;
      amount: number;
      ascAmount?: AscTier[];
      block: number;
      blockAscAmount?: AscTier[];
    }
  // 敌人用：**分裂**——本敌人当场被 `splitInto` 那两只顶替（对齐 `Monster::largeSlimeSplit`）。
  // 分裂出来的怪继承分裂瞬间的当前生命（同时也是它们的生命上限），不重掷 monsterHpRng。
  // 它不带参数：分裂成什么写在 `EnemyDef.splitInto` 上，时点与 RNG 消耗写在 sts-combat.ts。
  | { kind: "split" }
  // 敌人用：**史莱姆王的分裂**（对齐 `Monster::slimeBossSplit`，MonsterSpecific.cpp:3391）。
  // ⚠ 与上面那条 `split` 是**两个不同的函数**，形状差五处（落位下标写死 0/2、
  // `monsterCount` 直接赋 3 因而留出一个空格、`monstersAlive` 与 `monsterTurnIdx` 都是赋值
  // 而不是自增、一次 `noOpRollMove` 都不掷）。复用 `split` 那条路径必错，故单开一个 kind。
  // 分裂成什么同样读 `EnemyDef.splitInto`（下标 0 落在 0 号位、下标 1 落在 2 号位）。
  | { kind: "split_boss" }
  // 敌人用：**复活**（暗影客的重生，第三十四批）。对齐 `MMID::DARKLING_REINCARNATE`
  // 那条 case 的**全部五句**（MonsterSpecific.cpp:1488-1497）：
  //   ```cpp
  //   curHp = maxHp / 2;                                     // ← C++ 整除
  //   halfDead = false;
  //   ++bc.monsters.monstersAlive;
  //   buff<MS::REGROW>();                                    // ← 再上一次，见 PowerId 那条
  //   if (player.hasRelic<PHILOSOPHERS_STONE>()) buff<MS::STRENGTH>(1);   // TODO(后续PR)
  //   ```
  // 全部**同步**（这条 case 一个 `addToBot` 都没有），收尾是同步的真 `rollMove`。
  // ⚠ 不带参数：五句里没有一句是「数据」，全是引擎侧的状态机，所以写在 sts-combat.ts。
  // ⚠ `++monstersAlive` 是与 `Monster::die` 里那句 `--monstersAlive` 配对的——两者
  //   一个都不能漏，否则判胜与 `getRandomMonsterIdx` 会整体偏。
  // ⚠ 参考在这条 case 上自注 `// todo does it heep its buffs and debuffs?`——那是作者的
  //   **疑问**不是结论，照抄它实际做的（`die` 里已经 `resetAllStatusEffects()` 清空过，
  //   这里只补回 REGROW）。
  | { kind: "reincarnate" }
  // 敌人用：**觉醒者的复活**（第三十七批）。对齐 `MMID::AWAKENED_ONE_REBIRTH` 那条 case 的
  // **前七句**（MonsterSpecific.cpp:1711-1720，末尾两句 `setMove` + `noOpRollMove` 是收尾，
  // 见 `MOVE_TURN_END`）：
  //   ```cpp
  //   maxHp = asc9 ? 320 : 300;
  //   curHp = maxHp;
  //   halfDead = false;
  //   miscInfo = true;                     // ← 二阶段锁存位，出招规则读它
  //   strength = std::max(0, strength);    // ← **直接写数值字段**，不碰 statusBits
  //   ++bc.monsters.monstersAlive;
  //   buff<MS::MINION_LEADER>();           // ← 从此「它一死当场判胜」
  //   ```
  // ⚠⚠ **与暗影客的 `reincarnate` 是两条完全不同的 case，别复用**，差别有五处：
  //  ① 血量是**写死的 300/320**（不是 `maxHp / 2`），而且**连 `maxHp` 一起重写**；
  //  ② 多一个 `miscInfo = true` 的阶段锁存位（暗影客可以反复重生，觉醒者只能一次）；
  //  ③ 多一句 `strength = max(0, strength)`；
  //  ④ 上的是 `MINION_LEADER` 而不是补回 `REGROW`（`die` 的觉醒者分支根本没清状态——
  //     它走的是逐个 `removeDebuffs()`，不是 `resetAllStatusEffects()`）；
  //  ⑤ 收尾是 `setMove(DARK_ECHO)` + **同步 `noOpRollMove`**（暗影客是同步的**真** rollMove）。
  // ⚠ 不带参数：七句里没有一句是「数据」，全是引擎侧的状态机。asc9 那一档写在实现里。
  | { kind: "awakened_rebirth" }
  // 敌人用：**打一下，然后获得等于这一击伤害输出的格挡**（尖塔护盾的重砸，第四十七批）。
  // 对齐 `MMID::SPIRE_SHIELD_SMASH`（MonsterSpecific.cpp:1789-1795）：
  //   ```cpp
  //   const auto damageOutput = calculateDamageToPlayer(bc, asc3 ? 38 : 34);
  //   bc.addToBot( Actions::AttackPlayer(idx, damageOutput) );
  //   bc.addToBot( Actions::MonsterGainBlock(idx, asc18 ? 99 : damageOutput));
  //   ```
  // ⚠⚠ **不能写成「`deal_damage` + `gain_block`」两条效果**，这是这条原语存在的全部理由：
  //   格挡的数量是**那一击算完之后的 `damageOutput`**（怪物力量、玩家易伤 / 虚弱、
  //   虚无缥缈钳制全部已经乘进去、并且已经截断成整数），不是招式的基础伤害 34。
  //   参考把 `attackPlayerHelper` 拆开写正是为了把这个中间值留下来复用。
  // ⚠ 三处照抄：
  //  ① 伤害在**排队那一刻**算好（与 `attackPlayerHelper` 同源），所以两条动作看到的是
  //     同一个数，中间就算玩家掉了易伤也不会变。
  //  ② 两条都是 `addToBot`（**入队**），顺序是先伤害后格挡。
  //  ③⚠ `ascBlock` 覆盖的是**格挡那一半**：`asc18 ? 99 : damageOutput`——asc>=18 时格挡
  //     变成写死的 99、与伤害脱钩。它与 `ascAmount`（覆盖伤害基数）正交，两者可以同时出现。
  | {
      kind: "deal_damage_block_equal";
      amount: number;
      ascAmount?: AscTier[];
      ascBlock?: AscTier[];
    }
  // 敌人用：**腐化之心的「强化」**（第四十七批）。对齐 `MMID::CORRUPT_HEART_BUFF` 那条 case
  // 的**前面全部**（MonsterSpecific.cpp:1838-1861，末尾的 `rollMove(bc)` 是收尾）：
  //   ```cpp
  //   const auto newStr = std::max(0, getStatus<MS::STRENGTH>()) + 2;
  //   setStatus<MS::STRENGTH>(newStr);
  //   const auto buffCount = bc.getMonsterTurnNumber() / 3;
  //   switch (buffCount) {
  //       case 1: buff<MS::ARTIFACT>(2);        break;
  //       case 2: buff<MS::BEAT_OF_DEATH>(1);   break;
  //       case 3: buff<MS::PAINFUL_STABS>();    break;
  //       case 4: buff<MS::STRENGTH>(10);       break;
  //       default: buff<MS::STRENGTH>(50);      break;
  //   }
  //   ```
  // ⚠ 不带参数：五个分支各是一个写死的字面量，`buffCount` 是全局怪物回合数的整数除法。
  //   把它做成「数据表里的五条效果」需要一个「按回合数选第几条」的通用机制，而全参考
  //   只有这一处——那就是第二份真相。逐条形状见 sts-combat.ts 里那条 case。
  // ⚠⚠ 第一句**不是 `buff`（累加）而是 `setStatus`（覆盖）**，而且先把负力量夹回 0：
  //   它是这只怪对「玩家给它减力量」的解药，抄成 `buff<STRENGTH>(2)` 会让负力量一直留着。
  | { kind: "corrupt_heart_buff" }
  // sync：敌人专用。参考塞状态牌同样**两种写法并存**——史莱姆们是
  // `addToBot(Actions::MakeTempCardInDiscard(...))`，而史莱姆王的黏液喷射写的是
  // `Actions::MakeTempCardInDiscard({SLIMED}, 3).actFunc(bc)`（MonsterSpecific.cpp:1112）
  // ——**当场执行**。省略 = 入队。与 `gain_block` / `apply_power` 的 sync 同族。
  // upgradedAfterTurn：敌人专用。参考造牌时把「升不升级」写进 `CardInstance` 的构造实参
  // ——六火幽魂的灼烧是 `CardInstance(CardId::BURN, bc.turn > 8)`（MonsterSpecific.cpp:825），
  // 即**第 10 个怪物回合起**塞的是灼伤+（回合末 4 点而不是 2 点）。省略 = 恒不升级。
  // ⚠ 阈值与 asc 无关（asc 只分张数），且实参在**排队那一刻**求值。
  // ascAmount：敌人专用的爬升度分档，覆盖 **`count`**（不是别的字段）——参考的
  //   `MakeTempCardInDiscard({DAZED}, asc18 ? 3 : 2)`（哨卫射钉 MonsterSpecific.cpp:1064）与
  //   `MakeTempCardInDiscard({SLIMED}, asc19 ? 5 : 3)`（史莱姆王黏液喷射 :1112）都是分张数。
  //   ⚠ 与 `upgradedAfterTurn` 正交：一个管**几张**、一个管**升不升级**，两条分档互不影响。
  // minAscension：敌人专用，语义与 `apply_power` / `gain_block` 上那一位相同（**整条效果**
  //   只在 `ascension >= minAscension` 时才结算）。第三十八批加的宿主是时间吞噬者的头槌——
  //   `if (asc19) { addToBot(MakeTempCardInDiscard(SLIMED, 2)); }`（MonsterSpecific.cpp:1651-1653），
  //   一条多出来的语句，与「同一个 `count` 换个值」（`ascAmount`）是两回事。
  | {
      kind: "add_card";
      cardId: string;
      pile: "draw" | "discard" | "hand";
      count: number;
      sync?: boolean;
      upgradedAfterTurn?: number;
      ascAmount?: AscTier[];
      minAscension?: number;
    }
  // —— X 费牌：xValue = 打出时的能量，以下效果按 X 次 / X 倍结算 ——
  | { kind: "deal_damage_all_x"; amount: number } // 对所有敌人造成 amount 伤害，X 次（旋风斩）
  | { kind: "deal_damage_x"; amount: number } // 对目标造成 amount 伤害，X 次（穿刺）
  | { kind: "gain_block_x"; amount: number } // 获得 amount 格挡，X 次（强化机体）
  | { kind: "evoke_x" } // 唤醒 X 颗球（多重施法）
  | { kind: "channel_orb_x"; orbType: OrbType } // X 费：充能 X 颗指定球（雷暴倾泻）
  | { kind: "channel_orb_per_enemy"; orbType: OrbType } // 每个存活敌人充能 1 颗指定球（透骨寒）
  | {
      kind: "apply_power_x";
      power: PowerId;
      amount: number;
      on: "self" | "target" | "all_enemies";
    } // 施加 amount×X 层
  // —— 按数量结算：伤害 / 格挡随牌堆 / 手牌 / 状态动态计算 ——
  | { kind: "deal_damage_draw_pile_count" } // 对目标造成 = 抽牌堆张数的伤害（心灵冲击）
  | { kind: "gain_block_per_hand_card"; amount: number } // 每张手牌获得 amount 格挡（灵盾）
  | { kind: "deal_damage_per_hand_type"; cardType: CardType; amount: number } // 手牌中每张该类型牌，对目标造成 amount 伤害（飞镖：每张技能）
  | { kind: "deal_damage_perfected"; amount: number; per: number } // 基础 amount + per×(各区「打击」名牌数)（完美打击）
  | { kind: "deal_damage_bane"; amount: number } // 对目标造成 amount；若目标中毒则再造成 amount（剧毒之刃）
  // 玩家用：增减球槽数（吞噬 -1、电容器 +2）；下限 0。
  | { kind: "change_orb_slots"; delta: number }
  // 玩家用：获得法力（观者；累积到 10 自动进入神性姿态）。
  | { kind: "gain_mantra"; amount: number }
  // 玩家用：预知——看抽牌堆顶 amount 张，自动弃掉其中的状态牌，其余留在顶端（观者）。
  | { kind: "scry"; amount: number }
  // 玩家用：抽到手牌上限（疾书）。
  | { kind: "draw_to_full" }
  // —— 消耗手牌联动 / 生命偷取 ——
  | { kind: "exhaust_non_attacks" } // 消耗手牌中所有非攻击牌（断魂）
  | { kind: "exhaust_non_attacks_gain_block"; amount: number } // 消耗所有非攻击牌，每张 +amount 格挡（二度呼吸）
  | { kind: "exhaust_hand_damage"; amount: number } // 消耗全部手牌，每张对目标造成 amount 伤害（恶魔烈焰）
  | { kind: "deal_damage_all_lifesteal"; amount: number } // 对所有敌人造成 amount，回复实际造成的总伤害（收割）
  // —— 更多计数 / 状态操作 ——
  | { kind: "multiply_target_poison"; factor: number } // 将目标当前中毒层数乘以 factor（催化剂）
  | { kind: "deal_damage_per_orb"; amount: number } // 场上每颗充能球对目标造成 amount 伤害（弹幕）
  | { kind: "deal_damage_per_enemy"; amount: number } // 对目标造成 amount×(存活敌人数) 伤害（保龄冲击）
  | { kind: "deal_damage_lesson"; amount: number } // 对目标造成 amount；若因此击杀，永久升级牌组中一张随机牌（研学有成）
  | { kind: "drain_marked_enemies" } // 所有敌人损失 = 各自标记层数的生命（点穴）
  | { kind: "play_top_card_exhaust" } // 打出抽牌堆顶的牌并消耗之（浩劫）
  | { kind: "cap_hand_cost"; cap: number } // 本回合把手牌费用压到不超过 cap（顿悟）
  | { kind: "add_random_card_free"; pool: "power" | "skill" | "attack" } // 将一张随机牌加入手牌，费用视为 0（白噪音/分心/地狱之刃）
  | { kind: "discard_hand_draw_same" } // 弃掉整手，然后抽等量的牌（精算赌注）
  | { kind: "bonus_if_target_weak"; energy: number; draw: number } // 若目标虚弱：+energy 能量并抽 draw 张（勾拳）
  | { kind: "put_hand_card_on_draw_bottom_free" } // 把一张手牌置于抽牌堆底，本场费用视为 0（深谋；自动取最贵）
  | { kind: "draw_if_no_attacks"; amount: number } // 若手牌中没有攻击牌，抽 amount 张（急躁）
  | { kind: "exhaust_hand_up_to"; count: number } // 消耗手牌中至多 count 张（净化；自动取费用最低的）
  | { kind: "exhaust_one_draw"; draw: number } // 消耗一张手牌，然后抽 draw 张（焚誓；自动取费用最低）
  | { kind: "copy_hand_card"; count: number } // 复制手牌中的一张攻击/能力牌 count 份加入手牌（双持；自动取费用最高）
  | { kind: "gain_energy_if_last_attack"; amount: number } // 若上一张打出的是攻击牌，获得 amount 能量（追击）
  | { kind: "return_from_discard" } // 从弃牌堆取回一张牌到手牌（冥想；自动取最近弃掉的一张）
  | { kind: "gain_random_potion" } // 获得一瓶随机药水（炼金）
  | { kind: "transmutation" } // X 费：将 X 张随机无色牌加入手牌，本场费用视为 0（嬗变）
  | { kind: "upgrade_all_cards" } // 本场剩余时间内升级你所有的牌（神化）
  | { kind: "upgrade_hand_cards"; all: boolean } // 升级手牌：all=全部，否则升级一张（军备）
  | { kind: "schedule_bomb"; turns: number; damage: number } // turns 回合后对所有敌人造成 damage（炸弹）
  | { kind: "add_random_cards_to_draw"; pool: "skill" | "attack"; count: number } // 将 count 张随机牌洗入抽牌堆，费用视为 0（蜕变/变形）
  | { kind: "fission" } // 唤醒所有充能球，每唤醒一颗获得 1 能量并抽 1 张（裂变）
  | { kind: "return_from_exhaust" } // 从消耗堆取回一张牌到手牌（掘尸；自动取最近消耗的一张）
  | { kind: "conjure_blade" } // X 费：将一张「湮灭之刃」加入手牌，其伤害随 X 提升（铸刃）
  | { kind: "lose_hp_per_hand_card" } // 失去 = 手牌张数的生命（悔恨，回合末在手时触发）
  | { kind: "play_top_card_twice" } // 打出抽牌堆顶的牌两次，随后消耗（全知）
  | { kind: "schedule_phantasmal" } // 下个回合你的攻击造成双倍伤害（幻杀）
  | { kind: "return_zero_cost_from_discard" } // 把弃牌堆里所有 0 费牌收回手牌（一心一意）
  | { kind: "put_hand_card_on_draw_free" } // 把一张手牌置于抽牌堆顶，本场费用视为 0（布置；自动取最贵的一张）
  | { kind: "scrape_draw"; count: number } // 抽 count 张，随后弃掉其中费用 >0 的（削刮）
  | { kind: "schedule_card_copies"; count: number } // 把一张手牌（自动取当前费用最高）预约到下回合加 count 张副本（噩梦）
  | { kind: "schedule_extra_turn" } // 本次结束回合后跳过敌人行动，直接再获得一个回合（宝库）
  | { kind: "collect_charge" } // X 费：接下来 X 个回合，回合开始各将一张 0 费「洞悉」加入手牌（采集）
  | { kind: "end_turn" } // 打出结算后立即结束本回合（终局；在 playCard 收尾处检测）
  | { kind: "bonus_if_target_vulnerable"; energy: number; draw: number } // 若目标易伤：+energy 能量并抽 draw 张（飞踢）
  | { kind: "weaken_enemy_strength"; amount: number } // 使目标临时失去 amount 力量，其行动后归还（黑暗枷锁）
  | { kind: "weaken_all_enemies_strength"; amount: number } // 使所有敌人临时失去 amount 力量，各自行动后归还（穿刺尖啸）
  | { kind: "deal_damage_plus_mantra_gained"; base: number } // 对目标造成 base + 本场累计法力（璀璨光辉）
  | { kind: "deal_damage_all_per_frost_channeled"; per: number } // 对所有敌人造成 per×本场充能冰霜数（暴风雪）
  | { kind: "deal_damage_random_per_lightning_channeled"; amount: number } // 对随机敌人造成 amount，重复=本场充能闪电数（雷霆一击）
  // —— 下回合预约 / 弃牌 / 随机毒 / 抽到指定张数 ——
  | { kind: "gain_block_next_turn"; amount: number } // 下个回合开始获得 amount 格挡（闪转腾挪）
  | { kind: "gain_energy_next_turn"; amount: number } // 下个回合开始获得 amount 能量（飞膝/战略欺骗）
  | { kind: "draw_next_turn"; amount: number } // 下个回合开始多抽 amount 张（掠食者）
  | { kind: "schedule_next_turn_x" } // X 费：下回合多抽 X 张并多得 X 能量（镜影分身）
  | { kind: "schedule_stance_next_turn"; stance: PlayerStance; draw: number } // 下回合开始进入姿态并抽 draw 张（烈怒渐起）
  | { kind: "set_doomed" } // 下个回合开始时角色死亡（亵渎）
  | { kind: "gain_energy_if_discarded"; amount: number } // 若本回合弃过牌，获得 amount 能量（声东击西）
  | { kind: "draw_if_cards_played_le"; max: number; amount: number } // 若本回合出牌数≤max，抽 amount（超光速）
  | { kind: "draw_then_block_if_skill"; amount: number } // 抽 1 张，若为技能则获得 amount 格挡（脱身之策）
  | { kind: "discard_random"; count: number } // 随机弃掉 count 张手牌（优先状态牌）（杂技/有备而来）
  | { kind: "discard_non_attacks" } // 弃掉手牌中所有非攻击牌（卸货）
  | { kind: "apply_poison_random"; amount: number; times: number } // 对随机敌人施加 amount 中毒，重复 times 次（弹跳药瓶）
  | { kind: "draw_up_to"; target: number } // 抽牌直到手牌达到 target 张（专精）
  | { kind: "deal_damage_per_attack"; amount: number } // 对目标造成 amount×(本回合此前打出的攻击牌数)（终结技）
  // —— 机器人补完：条件格挡 / 随机球 / 计数能量 / 移除格挡 ——
  | { kind: "gain_block_if_none"; amount: number } // 若当前无格挡，获得 amount 格挡（自动护盾）
  | { kind: "channel_random_orb"; count: number } // 随机充能 count 颗球（混沌）
  | { kind: "gain_block_discard_count"; perCard: number } // 每张弃牌堆的牌获得 perCard 格挡（堆叠）
  | { kind: "gain_energy_per_draw_pile"; divisor: number } // 抽牌堆每 divisor 张给 1 能量（聚合）
  | { kind: "remove_target_block" } // 移除目标的全部格挡（熔化）
  // —— 观者补完 / 铁甲收尾 ——
  | { kind: "change_max_energy"; delta: number } // 增减每回合最大能量（苦修 -1）
  | { kind: "gain_block_if_wrath"; base: number; bonus: number } // 获得 base 格挡；若处于愤怒姿态再 +bonus（止）
  | { kind: "execute_if_below"; threshold: number } // 若目标当前生命 ≤ threshold 则直接击杀（审判）
  | { kind: "apply_strength_temp"; amount: number } // 立即 +amount 力量，本回合结束时失去（屈伸）
  // —— 单卡实例自我成长（读写打出的这张牌的 bonus，本场战斗内有效）——
  | { kind: "deal_damage_scaling"; base: number } // 对目标造成 base + 本牌 bonus 的伤害（暴走/玻璃刀）
  | { kind: "gain_block_scaling"; base: number } // 获得 base + 本牌 bonus 的格挡（坚韧）
  | { kind: "grow_self"; amount: number } // 本牌 bonus += amount（可负，玻璃刀 -2）
  | { kind: "shuffle_discard_into_draw" } // 将弃牌堆洗入抽牌堆（深呼吸）
  // —— 击杀触发 / 意图条件 ——
  | { kind: "deal_damage_kill_maxhp"; base: number; maxhp: number } // 造成 base；若击杀目标，永久 +maxhp 最大生命（喂养）
  | { kind: "deal_damage_kill_gold"; base: number; gold: number } // 造成 base；若击杀目标，获得 gold 金币（贪婪之手）
  | { kind: "deal_damage_ritual"; base: number; grow: number } // 造成 base+本牌bonus；若击杀，本牌 bonus += grow（仪式匕首）
  | { kind: "gain_strength_if_target_attacking"; amount: number } // 若目标意图为攻击，获得 amount 力量（觅敌之弱）
  | { kind: "deal_damage_weak_if_attacking"; base: number; weak: number } // 造成 base；若目标意图为攻击，施加 weak 虚弱（瞄准眼睛）
  | { kind: "put_discard_card_on_top" } // 将弃牌堆最近一张牌置于抽牌堆顶（头槌）
  | { kind: "fetch_from_draw"; cardType?: CardType } // 从抽牌堆检索一张（指定类型则限该类型）到手牌（秘密武器/技巧/搜寻）
  | { kind: "add_random_colorless"; count: number } // 将 count 张随机无色卡加入手牌（全能）
  // —— 条件伤害 / 击杀返能 / 受击加甲 ——
  | { kind: "deal_damage_all_if_draw_empty"; amount: number } // 若抽牌堆为空，对所有敌人造成 amount（大结局）
  | { kind: "deal_damage_kill_energy"; base: number; energy: number } // 造成 base；若击杀目标，获得 energy 能量（分裂）
  | { kind: "deal_damage_gain_block_dealt"; base: number } // 造成 base，获得等同于实际造成伤害的格挡（痛打）
  | { kind: "reboot"; draw: number } // 将手牌与弃牌堆全部洗回抽牌堆，然后抽 draw 张（重启）
  | { kind: "make_random_hand_card_free" } // 随机使一张手牌本场费用变 0（疯狂）
  | { kind: "put_hand_card_on_top" } // 将一张手牌（随机非本牌）置于抽牌堆顶（未雨绸缪）
  | { kind: "return_discard_to_hand" } // 将弃牌堆最近一张牌收回手牌（全息影像）
  | { kind: "recursion" } // 唤醒最左侧球，再把同类型球重新充能到末位（递归）
  | { kind: "discard_hand_for_shivs" } // 弃掉全部手牌，每弃一张将 1 张飞刀加入手牌（钢铁风暴）
  // —— 观者条件牌 ——
  | { kind: "gain_block_draw_if_last_skill"; block: number; draw: number } // 获得 block 格挡；若上一张打出的是技能牌则抽 draw 张（神圣）
  | { kind: "deal_or_enter_wrath"; vuln: number } // 若处于愤怒则令所有敌人获得 vuln 易伤，否则进入愤怒（义愤）
  | { kind: "draw_or_enter_calm"; draw: number } // 若处于平静则抽 draw 张，否则进入平静（内心平静）
  | { kind: "deal_damage_if_hand_all_attacks"; amount: number } // 若手牌其余全为攻击牌，对目标造成 amount（招牌动作）
  | { kind: "exhaust_random"; count: number } // 随机消耗 count 张手牌（坚毅）
  | { kind: "deal_damage_claw"; base: number } // 对目标造成 base + 本场爪击加成 的伤害，随后使本场爪击加成 +2（爪击）
  | { kind: "exhaust_hand_gain_energy" } // 消耗手牌中费用最高的一张，获得 = 其费用的能量（回收；自动取最贵）
  | { kind: "double_energy" } // 获得等同于当前能量的能量（双倍能量）
  | { kind: "retain_hand" } // 本回合结束时保留全部手牌（平衡）
  // 敌人自身：**把当前生命直接写成 `maxHp / 2`**（时间吞噬者的加速，第三十八批）。
  // 对齐 `MMID::TIME_EATER_HASTE` 那条 case 的第二句 `curHp = maxHp / 2;`
  //（MonsterSpecific.cpp:1639）。⚠ 三处照抄：
  //  ① 它是**赋值**不是 `heal()`——参考那一族（秘法师 / 冠军）走的是 `Monster::heal`
  //     （带上限钳制、还会清 `halfDead`），这一句只写数值字段。当前两者同解（出招门是
  //     `curHp < maxHp/2`，所以恒是回血且不可能超上限），形状照抄。
  //  ② 是 C++ 的**整数除法**（向零截断）：456 / 2 = 228。
  //  ③ **同步**（那条 case 一个 addToBot 都没有）。
  | { kind: "set_hp_half_max" }
  | { kind: "fill_potion_slots" } // 玩家：把所有空药水槽填满随机药水（熵酿）
  | { kind: "channel_orb_per_slot"; orbType: OrbType } // 玩家：每个球槽充能 1 颗指定球（暗影精华）
  | { kind: "randomize_hand_costs" } // 玩家：将手牌费用随机改为 0~3（本场有效，蛇油药水）
  | { kind: "play_top_n"; count: number }; // 玩家：打出抽牌堆顶 count 张（蒸馏混沌）

/** 卡定义（静态数据表）。cost=null 表示不可打出（status/废牌）。 */
export type CardDef = {
  id: string;
  name: string;
  type: CardType;
  rarity: CardRarity;
  /** 卡牌颜色（所属角色卡池）。 */
  color: CardColor;
  cost: number | null;
  /** 升级后的费用（省略=不变）；用于力压/见红等升级降费卡。 */
  upgradedCost?: number;
  /** X 费牌：打出时消耗全部能量，X = 消耗的能量，effects 里的 *_x 效果按 X 结算（旋风斩等）。 */
  xCost?: boolean;
  /** 固有：战斗开局必定在起手牌中（背刺等）。 */
  innate?: boolean;
  /** 升级后才具有固有（你好世界+）；与 innate 取或。 */
  upgradedInnate?: boolean;
  /** 打出时费用按本回合已弃牌数下调（下限 0）（剖体斩）。 */
  costMinusDiscardThisTurn?: boolean;
  /** 打出时费用按本场已打出的能力牌数下调（下限 0）（力场）。 */
  costMinusPowersPlayedThisCombat?: boolean;
  /** 打出时费用按本场失血次数下调（下限 0）（血债血偿）。 */
  costMinusHpLossCountThisCombat?: boolean;
  /** 每打出一次，本实例本场永久 -1 费（下限 0）（流水线）。 */
  costReducesOnPlay?: boolean;
  /** 打出时费用按本场失血次数上调（巧计一击）。 */
  costPlusHpLossCountThisCombat?: boolean;
  /** 需要选择一个敌人目标（攻击类多为 true；AoE / 自身增益为 false）。 */
  targeted: boolean;
  /**
   * 升级后是否需要选目标（省略=不变）；用于致盲+/绊摔+ 那类「升级后改为对所有敌人」。
   * 对齐 Cards.h:673 cardTargetsEnemy 里 BLIND / TRIP 的 `!upgraded`。
   */
  upgradedTargeted?: boolean;
  /** 打出后进入消耗堆而非弃牌堆。 */
  exhausts: boolean;
  /**
   * 升级后是否消耗（省略=不变）；用于极限爆发+/发现+ 那类「升级后不再消耗」。
   * 对齐 Cards.h:534 doesCardExhaust 里那组 `!upgraded`。
   */
  upgradedExhausts?: boolean;
  /** 保留：回合结束时不进弃牌堆，留在手中（观者部分卡）。 */
  retain?: boolean;
  /** 虚无：回合结束时若仍在手牌中，则被消耗（而非进弃牌堆）。 */
  ethereal?: boolean;
  /**
   * 升级后是否仍为虚无（省略=不变）；用于幻影/回响成型/提婆形态那类「升级后不再虚无」。
   * 对齐 Cards.h:466 isCardEthereal 里 APPARITION / ECHO_FORM / DEVA_FORM 的 `!upgraded`。
   */
  upgradedEthereal?: boolean;
  /** 回合结束时若此牌在手牌中，以玩家为行动者结算这些效果（灼烧/腐朽自伤、疑虑虚弱等）。 */
  endOfTurnInHand?: Effect[];
  /** 被牌效果从手牌弃掉时，以玩家为行动者结算这些效果（急智回能量、应激反射抽牌）。 */
  onDiscard?: Effect[];
  /** 升级后的 onDiscard（省略则沿用 onDiscard）。 */
  upgradedOnDiscard?: Effect[];
  /** 被消耗（进消耗堆）时，以玩家为行动者结算这些效果（哨戒回能量）。 */
  onExhaust?: Effect[];
  /**
   * 升级后的 onExhaust（省略则沿用 onExhaust）。与 upgradedOnDiscard 同一模式。
   * 哨兵是目前唯一的用户：消耗时回 `up ? 3 : 2` 点能量（BattleContext.cpp:2857）。
   */
  upgradedOnExhaust?: Effect[];
  /** 被抽到手牌时，以玩家为行动者结算这些效果（无尽痛楚：加一张自身副本）。 */
  onDraw?: Effect[];
  /** 被抽到时立即消耗自身（机械降神：抽到即生成奇迹并消耗）。 */
  exhaustOnDraw?: boolean;
  effects: Effect[];
  upgradedEffects: Effect[];
  description: string;
  upgradedDescription: string;
};

/** 牌组里的一张牌实例。bonus=本场自我成长数值（暴走/玻璃刀）；costZero=本实例本场费用视为 0（疯狂）。 */
export type CardInstance = {
  uid: number;
  defId: string;
  upgraded: boolean;
  bonus?: number;
  costZero?: boolean;
  /** 本实例本场累计的永久降费（流水线：每打出一次 +1，playCard 时从费用扣除，下限 0）。 */
  costReduction?: number;
  /** 本回合费用上限（顿悟：把手牌费用压到不超过此值；回合结束清除）。 */
  costCapThisTurn?: number;
  /** 蛇眼混乱：抽到时掷定的随机费用（0~3，覆盖原费用；X 费/废牌不受影响）。本场有效。 */
  randomCost?: number;
  /** 瓶装遗物：此实例被封入瓶中，战斗开局必在起手牌（覆盖 def.innate 的实例级固有）。 */
  innate?: boolean;
};

export type PowerInstance = { id: PowerId; amount: number };

/** 敌人一次出招。intent 是给玩家看的意图分类；effects 是实际结算。 */
type EnemyMove = {
  id: string;
  name: string;
  effects: Effect[];
  /** 给玩家渲染意图用的分类。attack 的展示数值在运行时按当前状态重算。 */
  intent: EnemyIntentKind;
};

type EnemyIntentKind = "attack" | "defend" | "buff" | "debuff" | "unknown";

/** 敌人意图选择规则：脚本开局 + 加权随机 + 连续限制（复刻 StS 手感，issue #234 C8）。 */
type IntentRule = {
  /** 按回合序号固定出招（1-based）；用尽后转 weighted。 */
  scripted: string[];
  weighted: { move: string; weight: number; maxInARow: number }[];
};

/** 敌人定义（静态数据表）。 */
export type EnemyDef = {
  id: string;
  name: string;
  hpMin: number;
  hpMax: number;
  /**
   * 高爬升度的**第二组**血量区间（第二十一批）。
   *
   * 参考的 `monsterHpRange[id]`（`MonsterIds.h:150`）每只怪都有**两组**，由
   * `Monster::initHp`（`MonsterSpecific.cpp:26-128`）按爬升度阈值二选一——而阈值**逐怪不同**：
   * 普通怪 `>= 7`、精英 `>= 8`、Boss `>= 9`。所以阈值必须跟着区间一起写，
   * 不能在引擎里按「是不是精英」猜。
   *
   * 省略 = 这只怪的爬升度分档**还没校准**（见 `ascCalibrated`），不是「没有第二组」。
   */
  hpHigh?: { atLeast: number; hpMin: number; hpMax: number };
  /**
   * 血量**不掷 RNG**：直接取 `hpMin`，一次 `monsterHpRng` 都不消耗（第二十三批）。
   *
   * 对齐 `Monster::initHp` 里那条与众不同的 case（`MonsterSpecific.cpp:119-124`）：
   * ```cpp
   * case MonsterId::SPHERIC_GUARDIAN:
   * case MonsterId::THE_MAW:
   * case MonsterId::TRANSIENT:
   *     curHp = monsterHpRange[id][0][0];   // 低档区间的**下界**，没有 setRandomHp
   *     maxHp = curHp;
   * ```
   * ⚠ **与「上下界相同」不是一回事。** 守卫者是 `{240,240}` 却照样走 `setRandomHp` →
   * `Random::random(240,240)` **无条件 `++counter`**（Random.h:159），掷了一次。
   * 球状守卫者这条连 `setRandomHp` 都不调，`rng.hp` 计数器一动不动——把它写成
   * 「hpMin == hpMax 的普通怪」会让此后每一次 monsterHpRng 取值整体错位。
   * ⚠ 它也让 `hpHigh` 失去意义（参考那条 case 压根不看 ascension，两组区间都是 `{20,20}`）。
   */
  hpNoRoll?: boolean;
  /**
   * 掷血量**之前**先白掷一次、结果丢弃的那一次 `monsterHpRng`（第二十七批）。
   *
   * 对齐 `Monster::initHp` 里那一族「先掷一次废的再掷一次」的 case
   * （`MonsterSpecific.cpp` 的 `ORB_WALKER` / `REPTOMANCER` / `BRONZE_ORB` / `TASKMASTER`）：
   * ```cpp
   * case MonsterId::TASKMASTER:
   *     hpRng.random(54, 60);                    // 参考在 ORB_WALKER 那条注了
   *     setRandomHp(hpRng, ascension >= 8);      // "first call is discarded by game"
   * ```
   * ⚠ **区间要单独写，不能复用「本场实际用的那一组」。** 白掷那次的上下界在参考里恒是
   * `monsterHpRange[id][0]`（低档那一组），而正式那次在 `ascension >= N` 时用的是**高档**：
   * 青铜球是先掷 `(52,58)`、再按 `{52,58}`（asc<9）或 `{54,60}`（asc>=9）取值。
   * 所以 asc>=N 时两次的上下界**真的不同**，而 `Random::random(a,b)` 的取值依赖上下界——
   * 拿 `range` 顶替会让此后每一次 monsterHpRng 错位。
   * ⚠ 第二十七批这里曾把青铜球的低档写成 `{50,56}`，与 `MonsterIds.h:160` 不符，
   *   第二十八批登记它时校正。四只宿主的白掷区间都等于自己的低档组（工头 54~60、
   *   暗球游荡者 90~96、蜥蜴法师 180~190、青铜球 52~58）。
   * ⚠ 它与 `hpNoRoll` 互斥（一个掷两次、一个一次都不掷）。
   */
  hpDiscardRoll?: { min: number; max: number };
  /**
   * 本条目的爬升度分档（血量第二组 + 招式数值的 asc 档）是否已按 trace 预言机校准。
   *
   * ⚠ **不是「支持爬升度」的开关，而是「这份数据在 asc>0 下可信」的断言。**
   * `sts-combat.ts` 的 `constructMonster` 在 `ascension > 0` 且此位不为 true 时**直接抛错**
   * ——与「未登记的编队/卡牌显式抛错」同一条理由：静默拿 asc0 的数值去打 asc19 的仗
   * 比直接失败危险得多。第二十一批只校准了 14 个普通编队涉及的 19 只怪。
   */
  ascCalibrated?: boolean;
  moves: EnemyMove[];
  intentRule: IntentRule;
  // ⚠ 第十九批删掉了 `modeShiftThreshold` / `stanceMoves` 两个「守卫者专用」字段。
  //   它们是旧近似战斗的遗留：模式切换的阈值真相在 `PRE_BATTLE_ACTION.the_guardian`
  //   （`miscInfo = asc19?40:asc9?35:30` + `buff<MODE_SHIFT>`）与
  //   `MONSTER_ON_HP_LOST.the_guardian` 里，姿态链的真相在 `MOVE_TURN_END` 的七条同步
  //   `setMove` 里。留着就是第二份真相，与第十五批 `steal_gold` 去掉 `amount`、
  //   第十六批删掉真菌兽 `deathEffects` 同一条理由。
  // ⚠ **第三十二批把 `deathEffects` 这个字段本身也删了**（它此时只剩爆破怪一个用户，
  //   而那条是错的）。参考里根本没有「数据驱动的亡语」这种东西，只有两族各自的代码：
  //   ① `Monster::die` 里那条写死的 else-if 链（孢子云 / 重生 / 停滞，Monster.cpp:299-310）
  //      ——层数与 `isSourceMonster` 都是 `die` 里硬写的，见 `monsterDie`；
  //   ② **招式**（爆破怪的自爆是 `EXPLODER_EXPLODE` 这一招：`DamagePlayer(30)` +
  //      `SuicideAction`，MonsterSpecific.cpp:1394-1398），它由意图链定时、**不是死亡触发**
  //      ——被玩家打死的爆破怪一点伤害都不会造成。写成 `deathEffects` 是两处都不对。
  /** 半血分裂：降到 ≤maxHp/2 时分裂成这些敌人（各自 HP = 分裂瞬间当前 HP）。 */
  splitInto?: string[];
  // ⚠ 第三十八批删掉了 `reviveHp`（第三十七批留下的账）。它自觉醒者按参考校准之后就没有
  //   任何写入者、也没有任何读者：二阶段的血量是复活那条 case 里**另一个写死的字面量**
  //   （`maxHp = asc9 ? 320 : 300`，MonsterSpecific.cpp:1712），与数据表那次 `setRandomHp`
  //   并列、不是同一份真相。实现见 `Effect` 的 `awakened_rebirth`。
  //   与第十九批删 `modeShiftThreshold`、第三十二批删 `deathEffects`、第三十六批删
  //   `intangibleAfterMove` 同一条判据：**只剩一个错误的或零个用户的字段就是第二份真相**。
  // ⚠ 第三十六批删掉了 `intangibleAfterMove`（复仇魔那条「出招后补虚无缥缈」）。
  //   它是旧近似战斗的字段，与参考对不上：参考把这件事写在**三条 case 各自的尾部**
  //   （`if (!hasStatus<MS::INTANGIBLE>())`），而且**三条的形状不一样**——多重打击与巨镰是
  //   `addToBot(Actions::BuffEnemy<MS::INTANGIBLE>(idx, 2))`、排在入队的 RollMove **之后**，
  //   灼烧诅咒却是**同步**的 `buff<MS::INTANGIBLE>(2)`、排在同步的 rollMove 之后
  //   （MonsterSpecific.cpp:1585-1607）。一个数据字段表达不了这三种时序，真相在 `MOVE_TURN_END`。
  //   与第十九批删守卫者 `modeShift`、第三十二批删 `deathEffects` 同一条理由。
  // ⚠ 第三十八批删掉了 `timeWarpEvery`（旧近似战斗给时间吞噬者起的字段）。真相不是一个
  //   「每 N 张」的周期数，而是 `BattleContext::onAfterUseCard` 里那段状态机
  //   （BattleContext.cpp:1974-1985）：门是**字面量 `timeWarp == 11`**（不是 `>=`、
  //   也不是可配置的模），命中时归零 + `buff<STRENGTH>(2)` + `callEndTurnEarlySequence()`。
  //   把周期写进数据表就是第二份真相——与本批删 `reviveHp` 同一条判据，先例见上一条注释。
};

/** 充能球类型（机器人专属）：闪电/冰霜/暗/等离子。 */
export type OrbType = "lightning" | "frost" | "dark" | "plasma";

/** 一颗充能球实例（占一个球槽）。value 供暗球累积的伤害用（其它球恒为 0/省略）。 */
export type Orb = { type: OrbType; value?: number };

/** 玩家姿态（观者专属）：平静 / 愤怒 / 神性 / 无。神性下攻击 ×3，回合结束退出。 */
export type PlayerStance = "none" | "calm" | "wrath" | "divinity";

type RewardState = {
  /** 三选一（或跳过）的卡奖励，存 defId + 是否升级。 */
  cardChoices: { defId: string; upgraded: boolean }[];
};

/** 持有的遗物实例。counter 供计数型遗物用（如「每出 N 张攻击牌」），默认 0。 */
export type RelicState = { id: string; counter: number };

export type MapNodeType = "combat" | "elite" | "event" | "rest" | "shop" | "treasure" | "boss";

/** 分支地图节点（DAG）。next 是上一层可达节点 id；Boss 节点 next 为空。 */
export type MapNode = {
  id: string;
  row: number;
  col: number;
  type: MapNodeType;
  next: string[];
};

export type MapGraph = {
  nodes: Record<string, MapNode>;
  rows: number;
  /** 底层入口节点 id（首次选路从这里挑）。 */
  startNodeIds: string[];
  bossNodeId: string;
};

type Screen =
  "map" | "combat" | "reward" | "rest" | "event" | "shop" | "card_select" | "gameover" | "victory";

/**
 * 选牌子界面（图书馆选一张新牌 / 复制器复制一张牌 / 和平烟斗去一张牌）。
 * add：choices 为可加入的新牌；duplicate/remove：choices.uid 指向牌组中的实例。
 */
export type CardSelectState = {
  mode: "add" | "duplicate" | "remove";
  /** 情境标题（渲染用）。 */
  title: string;
  choices: { defId: string; upgraded: boolean; uid?: number }[];
  /** 是否允许跳过（不选）。 */
  canSkip: boolean;
};

/** 当前进行中的事件（? 节点）。 */
type EventState = { id: string };

/** 商店一件在售商品。sold 后不可再买。 */
export type ShopItem =
  | { kind: "card"; defId: string; cost: number; sold: boolean }
  | { kind: "relic"; id: string; cost: number; sold: boolean }
  | { kind: "potion"; id: string; cost: number; sold: boolean };

/** 商店库存（进店时一次性生成，定价固定）。 */
export type ShopState = {
  items: ShopItem[];
  /** 去牌服务费用。 */
  purgeCost: number;
  /** 本店去牌服务是否已用（每店限一次）。 */
  purgeUsed: boolean;
  /** 是否处于「选择要移除的牌」子界面。 */
  removing: boolean;
};

/** RNG 内部状态：必须完整可序列化并从存档精确复原（issue #234 C11）。 */
export type RngState = { s0: number; s1: number; s2: number; s3: number };

/**
 * 一幕的遭遇队列（`sts-encounters` 的 `ActEncounters` 投影成引擎的编队 id）。
 * 见 `GameState.encounterPlan`。
 */
export type ActEncounterPlan = {
  monsters: string[];
  elites: string[];
  boss: string;
  secondBoss: string | null;
};

/** 三幕的遭遇计划，下标 0/1/2 = 第一/二/三幕。 */
export type EncounterPlan = ActEncounterPlan[];

/** 三条队列各自的游标，按幕分开。 */
export type EncounterCursor = {
  monsters: number[];
  elites: number[];
};

export type GameState = {
  /** 每个动作后自增，供 HTTP 幂等（expectedVersion）与乐观并发。 */
  version: number;
  runId: string;
  /**
   * run 种子，**int64 的十进制字符串**。
   *
   * 必须是字符串而非 number：原版种子是 int64，超过 2^53 后 JSON number 会丢精度，
   * 而游戏级的 sts-map / sts-neow / sts-encounters / sts-combat 全都按 int64 播种，
   * 差一位就完全对不上。想要玩家在游戏里看到的那种 base-35 串（如 "1RGBGHNF7L"），
   * 用 sts-rng 的 seedLongToString 转换。
   */
  seed: string;
  /**
   * 当前楼层号，从 0 起（对齐 GameContext::floorNum）。每进入一个地图节点自增。
   * 游戏级 RNG 按 `Random(seed + floorNum)` 逐层重播种，故它是复现的必需输入。
   */
  floorNum: number;
  character: CharacterId;
  ascension: number;
  /** 当前幕（1-based）。打完本幕 Boss 若还有后续幕则携带状态进入下一幕。 */
  act: number;
  screen: Screen;
  hp: number;
  maxHp: number;
  gold: number;
  /** 大牌组（master deck）。 */
  deck: CardInstance[];
  /** 持有的遗物（按获得顺序）。 */
  relics: RelicState[];
  /** 药水槽（定长 3；null = 空槽）。 */
  potions: (string | null)[];
  /** 战斗后掉药水的概率加成（基础 40%，未掉 +10、掉了 -10）。 */
  potionDropBonus: number;
  map: MapGraph;
  /** 当前所在地图节点 id；null = 还没进入地图（在底层选入口）。 */
  currentNodeId: string | null;
  /** 战斗状态（`sts-combat.ts` 的 `BattleContext` 纯数据投影）；null = 不在战斗中。 */
  combat: StsCombatState | null;
  /**
   * run 级持久 potionRng 状态（熵酿在战斗内消耗它）。
   *
   * 与逐层重播种的四条战斗流不同，它的 counter 必须跨房间续算，所以存在 run 上而不是
   * 战斗里。null = 本局还没用过，按 `Random(seed)` 起头。
   */
  stsPotionRng: RandomState | null;
  reward: RewardState | null;
  /** 当前进行中的事件（? 节点）；null = 不在事件屏。 */
  event: EventState | null;
  /** 当前商店库存；null = 不在商店屏。 */
  shop: ShopState | null;
  /** 当前选牌子界面（图书馆/复制器/和平烟斗）；null = 不在选牌屏。 */
  cardSelect: CardSelectState | null;
  /** 已进入过的普通战斗数（决定抽 weak / strong encounter 池，复刻 StS Act1 节奏）。 */
  combatsEntered: number;

  /**
   * 本局的**怪物遭遇计划**（第五十一批，TODOS「一、接线」第 4 项）。
   *
   * 由 `generateEncounters(seed)` 在开局算一次——它是一条**持久的 `monsterRng`**
   * （`Random(seed)`，三幕续 counter），所以**必须一次性生成、存下来按序索引**，
   * 不能每进一间房现掷：现掷会让 RNG 消耗顺序与原版对不上。
   *
   * ⚠ 每一幕三条队列：`monsters`（弱池 + 强池，按序消费）、`elites`（10 个）、`boss`。
   * ⚠ `secondBoss` 只有第三幕有值（A20 双 Boss 用），当前 run 层还没消费它。
   */
  encounterPlan: EncounterPlan;
  /**
   * 三条队列各自的游标，**按幕分开存**（下标 0/1/2 = 第一/二/三幕）。
   *
   * ⚠ 按幕存而不是「换幕时清零」是有意的：清零逻辑要挂在某个「进入下一幕」的时点上，
   * 而那个时点当前散在几处；按幕存的话游标天然不会串幕。
   */
  encounterCursor: EncounterCursor;
  /** 本场战斗胜利后是否发一个遗物（精英战为 true；下次 generateReward 消费后清零）。 */
  pendingRelicReward: boolean;
  rng: RngState;
  /** 递增的牌实例 uid 分配器。 */
  nextUid: number;
  /** 仅「本次动作」产生的日志；GET /state 返回时清空（KV 字节确定性，issue #234 C3）。 */
  log: string[];
};
