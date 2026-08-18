// 游戏级战斗核心（issue #1 第五层：同种子逐位复现原版战斗）。
//
// 与 combat.ts（现有近似实现）并存：本文件按参考项目 sts_lightspeed 的
// BattleContext 架构重建——6 条独立 StsRandom 流 + ActionQueue/CardQueue 出队执行模型。
// 目标是一场战斗的 RNG 消耗顺序（尤其 aiRng/shuffleRng/monsterHpRng/cardRandomRng 的
// counter）与原版逐位一致。迁移完成后 combat.ts 废弃。
//
// 参考：~/Workspace/sts_lightspeed/src/combat/{BattleContext,MonsterGroup,Monster,
//       MonsterSpecific,CardManager}.cpp、include/combat/{ActionQueue,CardQueue}.h
//
// 迁移进度（逐层 PR，每层都有对拍 C++ 的 golden）：
//   ① 骨架：双队列 + 6 流播种 + 最小可跑战斗（init → 抽起手 → endTurn → 怪物回合）
//   ② 打牌：useCard 分派、伤害/格挡计算（float32 全程）、击杀判胜、reshuffle
//   ③ 多怪：逐怪 rollMove（含分支内追加 aiRng 的非常数消耗）、编队开局特例
//   ④ 变体编队：miscRng 选怪与 monsterHpRng **交错**、construct 额外 roll、preBattleAction
//   ⑤ 药水：drinkPotion 路径、药水池与 returnRandomPotion 拒绝采样（potionRng）
//   ⑥ 接线：可序列化快照（exportState/importState）+ 覆盖面登记（SUPPORTED_ENCOUNTERS 等），
//      供 combat-bridge.ts 把本文件挂到 GameState 上
// 尚未迁移：姿态与球、其余怪种/卡牌/药水/遗物。
//
// 登记式扩展点（新增怪/编队/卡/药水时往这些表里加，未登记会显式抛错而非静默错配 RNG）：
//   MOVE_RULES / ENCOUNTER_BUILDERS / ENCOUNTER_SETUP / PRE_BATTLE_ACTION
//   CARD_RULES / POTION_RULES

import { StsRandom, JavaRandom, javaShuffle } from "./sts-rng.js";
import type { RandomState } from "./sts-rng.js";
import { getEnemyDef, getEncounterDef } from "./enemies/enemies.js";
import { costOf, etherealOf, exhaustsOf, getCardDef, targetedOf } from "./cards/cards.js";
import { getPotionDef } from "./potions/potions.js";
import type { AscTier, CharacterId } from "./types.js";

// ============================================================================
// 战斗结局（对齐 Outcome）
// ============================================================================

export type Outcome = "undecided" | "player_victory" | "player_loss";

/**
 * 输入状态机（对齐 InputState 的子集）。EXECUTING 时抽干队列，PLAYER_NORMAL 时把控制权
 * 还给玩家，CARD_SELECT 时等玩家从某个牌堆里选牌。
 *
 * ⚠ 参考的 executeActions 主循环**顶部**就是 `if (inputState != EXECUTING_ACTIONS) break;`
 * （BattleContext.cpp:740）。所以开屏的那条动作执行完，循环立刻退出，**队列里剩下的动作
 * 原样留着**——选完牌再接着抽。这条是选牌屏一切时序的根，写漏了会把后续动作提前跑掉。
 */
export type InputState = "executing" | "player_normal" | "card_select";

/** 玩家可操作的两个时点（即允许取档的 inputState）。 */
export type PlayerInputState = "player_normal" | "card_select";

// ============================================================================
// 选牌屏（对齐 include/combat/CardSelectInfo.h + BattleContext::inputState）
//
// 参考的 CardSelectTask 有 21 项，这里只登记已转写的那些；未登记的开屏路径压根不存在，
// 所以不会出现「屏开了但不知道怎么处理」的状态。
// ============================================================================

/** 选牌任务（对齐 CardSelectTask 的已转写子集，命名保持一致便于回查）。 */
export type CardSelectTask =
  | "armaments"
  | "discovery"
  | "dual_wield"
  | "exhaust_one"
  | "exhaust_many"
  | "exhume"
  | "headbutt"
  // 液态记忆（第四十五批）：从**弃牌堆**里挑 1 张进手牌并压成本回合 0 费。
  // ⚠ 参考的枚举名就叫 `LIQUID_MEMORIES_POTION`（CardSelectInfo.h），照抄。
  | "liquid_memories_potion"
  | "secret_technique"
  | "secret_weapon"
  | "warcry";

/**
 * 选牌屏状态（对齐 CardSelectInfo 的已用字段）。
 *
 * ⚠ 只存 task / pickCount / cards / data0。参考的 `canPickZero` / `canPickAnyNumber`
 * 在已登记的这些 task 上都无人读取：
 *   * `openSimpleCardSelectScreen` / `openDiscoveryScreen` 把两者恒置 false；
 *   * `ExhaustMany` / `ExhumeAction` / `WarcryAction` / `DrawToHandAction` **不走**它们，
 *     直接改 `cardSelectTask` + `inputState`，于是那两个 bool 是**上一次开屏留下的残值**——
 *     正因为没人读才无害。
 * pickCount 同理：单选类 task 的校验（`isValidSingleCardSelectAction`）不读它，我们统一记 1。
 * `cards` 只有 discovery 用（第八批新增）；`data0` 由 discovery（份数）与 dual_wield
 * （复制份数，`dualWield_CopyCount()`）共用，参考里那两个访问器就是同一个 `data0`。
 * 参考里另有液态记忆 / 法典也用它，两张都未登记。
 */
export type CardSelectInfo = {
  task: CardSelectTask;
  /** 多选上限（只对 exhaust_many 有意义；单选类恒 1）。 */
  pickCount: number;
  /**
   * 候选牌的**定义 id**（对齐 `cardSelectInfo.cards` / `discovery_Cards()`）。
   * 只有 discovery 有：它选的不是某个牌堆里的牌，而是当场随机生成的 3 张候选。
   */
  cards?: string[];
  /**
   * 对齐 `cardSelectInfo.data0`（`discovery_CopyCount()` / `dualWield_CopyCount()`）：
   * 选定后造几份。
   */
  data0?: number;
};

/**
 * 某个选牌任务从哪个牌堆里选（供 UI / 策略定位候选，参考里散在各 case 的隐含约定）。
 *
 * ⚠ `"generated"` 不是牌堆：发现的 3 张候选是当场从战斗内卡池随机生成的，
 * 存在 `cardSelect.cards` 里，下标 0..2 与任何牌堆都无关。
 */
export function cardSelectSource(
  task: CardSelectTask,
): "hand" | "draw_pile" | "discard_pile" | "exhaust_pile" | "generated" {
  switch (task) {
    case "armaments":
    case "dual_wield":
    case "exhaust_one":
    case "exhaust_many":
    case "warcry":
      return "hand";
    case "headbutt":
    case "liquid_memories_potion":
      return "discard_pile";
    case "exhume":
      return "exhaust_pile";
    case "secret_technique":
    case "secret_weapon":
      return "draw_pile";
    case "discovery":
      return "generated";
  }
}

// ============================================================================
// 动作队列（对齐 include/combat/ActionQueue.h）
//
// C++ 版是定长循环缓冲；TS 用普通数组，pushFront/pushBack/popFront 的出队顺序
// 与循环缓冲完全一致（顺序才是 RNG 逐位对齐的关键，循环缓冲只是性能实现）。
//
// 一个 Action 就是一次对 BattleContext 的原地变更。addToTop=pushFront、
// addToBot=pushBack；主循环恒从 front 出队。clearOnCombatVictory 供战斗胜利时
// 清理"战斗后不应再执行"的排队动作。
// ============================================================================

export type ActionFn = (bc: BattleContext) => void;

/**
 * 排队动作的**数据描述**——用来跨存档往返重建它。
 *
 * 为什么需要：选牌屏是一个新的「玩家可操作」时点，而它打开时动作队列**必然非空**。
 * `useCard` 把 `onAfterUseCard`（这张牌去哪个牌堆）排在卡效果之后，开屏的动作一执行、
 * executeActions 就在下一轮循环顶部退出，那条 onAfterUseCard 还躺在队里。焚誓更明显：
 * `addToBot(ChooseExhaustOne)` → `addToBot(DrawCards)`，开屏时抽牌还没结算。
 *
 * 队列存的是闭包，序列化不了，所以凡是**可能跨越选牌屏存活**的动作都要带一个描述。
 * 漏带的后果是 `exportState` **抛错**而不是静默丢掉它——丢一条排队动作会让读回来的档少
 * 一次结算（少抽两张牌、牌凭空消失），正是这个项目最不能容忍的静默错。
 */
export type ActionDesc =
  | {
      kind: "after_use_card";
      card: CombatCard;
      exhaustOnUse: boolean;
      purgeOnUse?: boolean;
      /**
       * 第三十五批新增（缓慢那道 `if (item.triggerOnUse)` 的门）。**老档没有这一位，
       * 按 `true` 回填**——参考的 `CardQueueItem::triggerOnUse` 默认就是 true，而能排出
       * 这条动作的路径上它恒为真（唯一的假值来源是尚未登记的时间吞噬者）。
       */
      triggerOnUse?: boolean;
    }
  | { kind: "draw_cards"; count: number }
  /**
   * 橙色药丸集齐三种牌型时排的那条清减益（第四十二批）。它与抽牌那条同族：由
   * `onUseXxxCard` 排在**卡效果之后**，所以打出军备 / 焚誓 / 头槌那类开选牌屏的牌时
   * 它会跨越选牌屏活着。
   */
  | { kind: "remove_player_debuffs" };

export type Action = {
  fn: ActionFn;
  /** 战斗胜利结算时是否连同清除（对齐 Action::clearOnCombatVictory，默认 true）。 */
  clearOnCombatVictory: boolean;
  /** 可存档描述；null = 这条动作不可能跨越选牌屏存活（见 ActionDesc）。 */
  desc: ActionDesc | null;
};

export function makeAction(
  fn: ActionFn,
  clearOnCombatVictory = true,
  desc: ActionDesc | null = null,
): Action {
  return { fn, clearOnCombatVictory, desc };
}

export class ActionQueue {
  private items: Action[] = [];

  clear(): void {
    this.items = [];
  }

  /** addToTop：插到队首，下一个执行。 */
  pushFront(a: Action): void {
    this.items.unshift(a);
  }

  /** addToBot：追加到队尾。 */
  pushBack(a: Action): void {
    this.items.push(a);
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  popFront(): Action {
    const a = this.items.shift();
    if (a === undefined) {
      throw new Error("ActionQueue.popFront on empty queue");
    }
    return a;
  }

  /**
   * 战斗胜利时丢弃标了 clearOnCombatVictory 的排队动作，保留其余（对齐
   * BattleContext::clearPostCombatActions 的筛选语义）。
   */
  clearOnCombatVictory(): void {
    this.items = this.items.filter((a) => !a.clearOnCombatVictory);
  }

  /** 队列里各动作的数据描述（供 exportState）；不可存档的位置为 null。 */
  descriptors(): (ActionDesc | null)[] {
    return this.items.map((a) => a.desc);
  }

  /** 整体替换（供 importState 用描述重建）。 */
  replaceAll(actions: Action[]): void {
    this.items = [...actions];
  }

  get size(): number {
    return this.items.length;
  }
}

// ============================================================================
// 出牌队列（对齐 include/combat/CardQueue.h）
//
// ⚠ 这个队列是**可嵌套**的：出牌过程中还能再往里塞出牌项。第九批的四张牌全靠它——
// 浩劫 / 混乱把抽牌堆顶那张牌当作「被打出」入队（addToTopCard），二连击把**当前这张牌的
// 一份副本**塞回队里（addPurgeCardToCardQueue）。所以 useCard → 入队 → useCard 会重入。
//
// 参考的 `CardQueueItem::card` 是 `CardInstance card;`，即**按值存一份副本**。我们这里存
// 的是 `CombatCard` 对象引用：
//   * 正常打牌 —— 传手牌里那个对象本身，于是卡效果对它的改写（暴走的 specialData、
//     灼热之刃的升级次数）会跟着 onAfterUseCard 一起进弃牌堆，与参考「改副本、再把副本
//     放进弃牌堆」等价；
//   * 二连击的复制项 —— 必须显式 `{...card}` 拷一份（见 queuePurgeCard），因为参考那份
//     副本在 onAfterUseCard 里被 purgeOnUse 提前返回**丢掉了**，对它的改写不该落到原牌上。
// ============================================================================

export type CardQueueItem = {
  /** 被打出的牌实例（对齐 `CardQueueItem::card`）；endTurn 项为 null。 */
  card: CombatCard | null;
  target: number;
  isEndTurn: boolean;
  triggerOnUse: boolean;
  /**
   * 「打出这张牌时手上有多少能量」（对齐 `CardQueueItem::energyOnUse`）。
   *
   * ⚠ 这就是 **X 费牌的 X**。参考在三个入队点分别填：
   *   * 玩家点牌（`search::Action::execute` 的 CARD 支，Action.cpp:433）—— `player.energy`，
   *     即**当前全部能量**，不是这张牌的费用；
   *   * 浩劫 / 混乱（`playTopCardInDrawPile`，BattleContext.cpp:2540）—— 同样是
   *     `player.energy`，但那一项还带 `freeToPlay = true`，于是 X 照算、能量**不扣**；
   *   * 二连击的复制项（`queuePurgeCard`，:2782）—— **继承**当前项的值，并置
   *     `ignoreEnergyTotal = true`，于是复制的那一击 X 与第一击相同。
   * 非 X 费牌不读它（扣能量读的是实例级 `costForTurn`），所以第十批之前这个字段填什么
   * 都观察不到——早先 `playCard` 填的是 `card.costForTurn`，与参考不符但无人读。
   */
  energyOnUse: number;
  /**
   * 「别再把 energyOnUse 往下夹了」（对齐 `CardQueueItem::ignoreEnergyTotal`）。
   * 只有 `queuePurgeCard` 置真：复制项结算时能量早被第一击花光，若照旋风斩/嬗变那两句
   * `player.energy < energyOnUse → energyOnUse = player.energy` 夹一下，X 就会塌成 0。
   */
  ignoreEnergyTotal: boolean;
  /**
   * 对齐 `CardQueueItem::freeToPlay`。两个读它的地方：X 费牌的
   * `useEnergy = !(item.freeToPlay || c.freeToPlayOnce)`（旋风斩 / 嬗变），以及死藤（未登记）。
   * 浩劫 / 混乱打出的牌置真，所以它们打出的旋风斩按满能量打、却一点能量都不花。
   */
  freeToPlay: boolean;
  /**
   * 「不是玩家自己点出来的」（对齐 `CardQueueItem::autoplay`）。
   * 它是 useCard 扣能量那条判断里的一项，也是 `canUse` 跳过能量检查的开关——
   * 浩劫 / 混乱从抽牌堆顶打出的牌、二连击的复制项都是 autoplay。
   */
  autoplay: boolean;
  exhaustOnUse: boolean;
  purgeOnUse: boolean;
  /** 打出时才掷随机目标（对齐 CardQueueItem::randomTarget，消耗 cardRandomRng）。 */
  randomTarget: boolean;
};

/**
 * 「不触发效果」的出牌项（对齐 `CardQueueItem item; item.triggerOnUse = false; item.card = c;`）。
 *
 * 回合末手里的灼伤那一类用它：playCardQueueItem 见 triggerOnUse 为假就**跳过** useCard、
 * 只走 useNoTriggerCard。energyOnUse 保持 0——那条路径压根不扣能量。
 */
export function noTriggerItem(card: CombatCard): CardQueueItem {
  return {
    card,
    target: 0,
    isEndTurn: false,
    triggerOnUse: false,
    energyOnUse: 0,
    ignoreEnergyTotal: false,
    freeToPlay: false,
    autoplay: false,
    exhaustOnUse: false,
    purgeOnUse: false,
    randomTarget: false,
  };
}

export function endTurnItem(): CardQueueItem {
  return {
    card: null,
    target: 0,
    isEndTurn: true,
    triggerOnUse: true,
    energyOnUse: 0,
    ignoreEnergyTotal: false,
    freeToPlay: false,
    autoplay: false,
    exhaustOnUse: false,
    purgeOnUse: false,
    randomTarget: false,
  };
}

export class CardQueue {
  private items: CardQueueItem[] = [];

  clear(): void {
    this.items = [];
  }

  pushFront(item: CardQueueItem): void {
    this.items.unshift(item);
  }

  pushBack(item: CardQueueItem): void {
    this.items.push(item);
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  popFront(): CardQueueItem {
    const item = this.items.shift();
    if (item === undefined) {
      throw new Error("CardQueue.popFront on empty queue");
    }
    return item;
  }

  /** 队首（对齐 `CardQueue::front()`，只有 addPurgeCardToCardQueue 用）。 */
  front(): CardQueueItem {
    const item = this.items[0];
    if (item === undefined) {
      throw new Error("CardQueue.front on empty queue");
    }
    return item;
  }

  /** 覆写队首（对齐参考的 `cardQueue.front() = item;`，front() 返回的是引用）。 */
  replaceFront(item: CardQueueItem): void {
    this.items[0] = item;
  }

  /**
   * 队列里有没有这个 uid 的牌（对齐 `CardQueue::containsCardWithId`）。
   * 唯一的读者是木乃伊之手：它不能把「已经排着队要打」的那张压成 0 费。
   */
  containsCardWithUid(uid: number): boolean {
    return this.items.some((item) => item.card?.uid === uid);
  }

  /** 全部项（供 exportState；返回副本，调用方改不到内部数组）。 */
  all(): CardQueueItem[] {
    return [...this.items];
  }

  /** 整体替换（供 importState）。 */
  replaceAll(items: CardQueueItem[]): void {
    this.items = [...items];
  }

  get size(): number {
    return this.items.length;
  }
}

// ============================================================================
// 六条 RNG 流的播种约定（对齐 BattleContext::init, BattleContext.cpp:28-34）
//
//   auto startRandom = Random(seed + floorNum);
//   aiRng = monsterHpRng = shuffleRng = cardRandomRng = startRandom;  // 同源逐字节拷贝
//   miscRng  = gc.miscRng;    // 承接自 GameContext
//   potionRng = gc.potionRng; // 承接自 GameContext
//
// 四条同源流各自是 startRandom 的独立拷贝（构造后 counter 都为 0，各自推进）。
//
// ⚠ 关于 miscRng：它并非「跨 run 持久」。GameContext::transitionToMapNode 每上一层都做
//   `const auto r = Random(seed + floorNum); miscRng = shuffleRng = cardRandomRng = r;`
//   （GameContext.cpp:758-761，initFromSave 也据此重建、存档根本不存它的 counter）。
//   所以进入某层的战斗时，miscRng 与四条战斗流**同源同态**、counter 为 0——除非该层
//   在战斗前先消耗过它（如先进事件房）。故默认新建即为正确语义，调用方需要接续时
//   仍可用 runMiscRng 覆盖。
//   potionRng 才是真正的 run 级持久流（Random(seed, potion_seed_count)，存档存其 counter）。
//   战斗内唯一消耗点是熵酿；跨房间续算时**必须**由调用方传入已推进的实例，
//   否则每场战斗都会从头重来。
// ============================================================================

export type CombatRng = {
  aiRng: StsRandom;
  monsterHpRng: StsRandom;
  shuffleRng: StsRandom;
  cardRandomRng: StsRandom;
  miscRng: StsRandom;
  potionRng: StsRandom;
};

/**
 * 播种战斗 RNG 流。
 * @param seedLong run 级 int64 种子（bigint）。
 * @param floorNum 当前楼层号（对齐 gc.floorNum）。
 * @param runMiscRng  覆盖 miscRng（本层战斗前已消耗过它时传入）；缺省即同源新建。
 * @param runPotionRng run 级持久 potionRng；缺省新建，待药水迁移时由调用方传入。
 */
export function seedCombatRng(
  seedLong: bigint,
  floorNum: number,
  runMiscRng?: StsRandom,
  runPotionRng?: StsRandom,
): CombatRng {
  const base = seedLong + BigInt(floorNum);
  // 四条同源流：各自独立构造同一个 (seed+floor) 播种的 StsRandom，counter 从 0 起。
  // 语义等价于 C++ 的 `aiRng = monsterHpRng = ... = startRandom`（拷贝出四份独立副本）。
  return {
    aiRng: new StsRandom(base),
    monsterHpRng: new StsRandom(base),
    shuffleRng: new StsRandom(base),
    cardRandomRng: new StsRandom(base),
    // 与四条战斗流同源（见上方注释）；仅当本层战斗前已消耗过 miscRng 时才需覆盖。
    miscRng: runMiscRng ?? new StsRandom(base),
    // run 级持久流：调用方跨房间续算时须传入已推进的实例（缺省仅便于单场测试）。
    potionRng: runPotionRng ?? new StsRandom(base),
  };
}

// ============================================================================
// 战斗内实体（骨架层最小形态）
// ============================================================================

export type PowerInstance = {
  id: string;
  amount: number;
  /**
   * 本回合刚施加（对齐 Monster 的 justApplied 位）。仪式/虚弱等「首回合跳过」的
   * 效果靠它在回合末判定是否生效：邪教徒咏唱当回合不涨力量，下回合起才涨。
   */
  justApplied?: boolean;
  /**
   * **数值还在、`statusBits` 那一位已清**（第三十四批）。
   *
   * ⚠⚠ 参考把「有没有」与「几层」存在**两个地方**：`statusBits` 一个位、外加一个具名 int
   * 字段（`weak` / `vulnerable` / `artifact` / …，Monster.h:225-282）。绝大多数清除点走
   * `removeStatus`——它**先 `setStatus(0)` 再清 bit**（Monster.h:495-501），两者一起归零，
   * 所以「整条摘掉」与参考等价，这也是 `removePower` 的做法。
   *
   * **唯一的例外是 `Monster::resetAllStatusEffects()`**（Monster.cpp:554-558）：
   * ```cpp
   * statusBits = 0;              // ← 只清 bit
   * setStatus<MS::STRENGTH>(0);  // ← 力量单独归零（它没有 bit）
   * block = 0;
   * ```
   * 那些 int 字段**原样留着**。于是下一次 `buff` / `addDebuff`（都是 `field += n` 再置 bit）
   * 会**从残留值上继续加**。
   *
   * ⚠ 这是**可观察的**，第三十四批当场撞上：暗影客死→重生（走 `resetAllStatusEffects`）之前
   * 挨过 1 层虚弱，复活之后再吃一张衣领（+2 层）——参考显示 **3** 层而不是 2。
   * 全参考项目只有这一个调用点（`Monster::die` 的 REGROW 分支），所以只有走过重生的怪
   * 身上会出现 `cleared` 条目。
   *
   * ⚠ **纯 bool 的 Power 没有这种残留**（它们压根没有数值字段，`buff` 只置 bit），
   * 所以 `resetAllMonsterStatusEffects` 把它们**整条丢掉**而不是标 cleared。
   */
  cleared?: boolean;
};

export type CombatMonster = {
  /** 敌人定义 id（enemies.ts）。 */
  defId: string;
  hp: number;
  maxHp: number;
  block: number;
  /** 当前已确定的意图（move id）。 */
  currentMove: string;
  /**
   * 意图历史，最近的在前（对齐 Monster::moveHistory：[0]=上一步，[1]=上上步）。
   * rollMove 前先读它做 lastMove/lastTwoMoves 判定，setMove 时前移写入。
   */
  moveHistory: string[];
  powers: PowerInstance[];
  alive: boolean;
  /**
   * **半死**（对齐 `Monster::halfDead`，Monster.h:46；第三十四批）。
   *
   * ⚠⚠ `isDeadOrEscaped()` 有**三位**（Monster.cpp:253）：
   *     `isDying()`（血 ≤ 0） || `isHalfDead()`（这一位） || `isEscaping()`（逃跑）
   * 我们的 `alive` 建模的是 `!isDeadOrEscaped()`（harness 的快照字段就是这么算的），
   * 所以半死的怪 `alive === false`。这一位是**额外**的，不能靠 `alive` 推出来。
   *
   * 它唯一的差别在**怪物回合的那道门**（`MonsterGroup::doMonsterTurn`，MonsterGroup.cpp:572）：
   *     `if ((!m.isDeadOrEscaped() || m.isHalfDead()) && !skipTurn[...])`
   * ——半死的怪**照样行动**（这正是暗影客能在下一个怪物回合滚出「重生」的原因），
   * 而其余所有读 `isDeadOrEscaped` 的地方（能不能被指向、随机选敌、群伤、
   * `Monster::attacked` / `damage` 的入口）都把它当死的。
   *
   * ⚠ 另外两个循环（`applyPreTurnLogic` / `BattleContext::applyEndOfRoundPowers`）
   *   的门是 `isDying() || isEscaping()`，**没有** halfDead 这一位——但它们照样跳过
   *   半死的怪，因为**半死必然伴随 `curHp == 0`**（`die` 只可能从「扣血扣到 ≤ 0」进来），
   *   `isDying()` 已经为真。所以这两处不需要改门，写 `!alive` 与参考同解。
   *
   * ⚠ 两个写入点：`Monster::die` 的 REGROW 分支置 true（暗影客）、
   *   `DARKLING_REINCARNATE` 那条 case 置 false。参考里还有第三处（觉醒者的假死，
   *   `Monster::die` 的**第一个**分支）尚未登记。
   */
  halfDead: boolean;
  /**
   * 怪物侧的通用整数字段（对齐 `Monster::miscInfo`，Monster.h:83）。
   *
   * ⚠ 参考就是**一个 int**，含义**逐怪种不同**——我们照抄这个形状，不给每种含义单开字段，
   * 否则同一个参考字段会在这里裂成好几份、以后逐只怪都要再加一个。当前三种用法：
   *   * 虱子：出生时掷定、整场固定的咬击伤害（`Monster::construct`，Monster.cpp:116）
   *   * 红色奴隶主：`usedEntangle` 标志（0/1）。⚠ 这一位是**我们给参考打的补丁**才有的——
   *     参考读了它却从没写过，见 `MOVE_RULES.red_slaver` 与
   *     `MOVE_TURN_BEGIN["red_slaver/entangle"]`
   *   * 地精巫师：蓄力计数（第十七批）。⚠ 它由**三处**协同维护，改一处就错：
   *     `MOVE_RULES.gremlin_wizard` 置 1（起点）、`MOVE_TURN_BEGIN["gremlin_wizard/charging"]`
   *     每回合 +1、`MOVE_TURN_END["gremlin_wizard/ultimate_blast"]` 清 0。
   *   * 守卫者：下一次形态切换的阈值（第十九批，`PRE_BATTLE_ACTION` 置起点、双重猛击 +10）。
   *   * 六火幽魂：六重打击的每击伤害（第二十批，激活那一回合按玩家当时生命算定）。
   * ⚠ 参考的 `Monster::rollMove` 把它**按引用**传进 `getMoveForRoll`（Monster.cpp:629-634：
   * 拷出去、传引用、写回），所以**出招规则本身也能改它**——地精巫师那条就是这么写的
   * （而红色奴隶主那条读的却是**成员**，两者当前等价）。
   * 参考里还有若干种我们没用到的含义：刺穿之书的连刺计数、暗影的咬击伤害、
   * 蠕动血块的位掩码。未使用该机制的怪保持 0。
   */
  miscInfo: number;
  /**
   * 怪物侧的**第二个**通用整数字段（对齐 `Monster::uniquePower0`，Monster.h:66）。
   *
   * ⚠ 它与 `miscInfo` 是参考里**两个不同的成员**，不能合并：六火幽魂同时用到两个
   * （`miscInfo` = 六重打击伤害、`uniquePower0` = 六焰计数），合并必错。
   *
   * ⚠ 参考里它同时兼任一批 Power 的存储后端（`Monster::getStatusInternal`，
   * Monster.cpp:190-211：MODE_SHIFT / SPORE_CLOUD / THORNS / THIEVERY / RITUAL / …）。
   * 我们把 Power 建模成 `powers` 数组，所以这里只留「非 Power 的那一种用法」。
   * 当前唯一的使用者是六火幽魂，而它身上**没有**任何走 uniquePower0 的 Power，
   * 因此两种含义不会在同一只怪身上撞车。以后登记既有此类 Power、又用它当计数器的怪
   * （参考里目前没有）时要回来重新审这条。
   *
   * ⚠ 它**不进 trace 快照**（harness 只 dump `hasStatus` 为真的 Power），所以六焰计数
   * 只能通过「下一招是谁」被间接看到——写错不会当场报「未映射的 power」，
   * 而是几回合后招式序列整体错位。
   */
  uniquePower0: number;
};

/**
 * 战斗内的一张牌实例（对齐 struct CardInstance，include/combat/CardInstance.h:20）。
 *
 * 前三个字段是「这是哪张牌」，后三个是**逐实例**的可变状态——同一张定义的两个实例可以
 * 有不同的值，所以它们必须住在实例上、不能从数据表派生：
 *
 *  * `cost` / `costForTurn` —— 血债血偿每失血一次费用 -1、疯狂把某张手牌的费用置 0、
 *    腐化把技能牌的费用压成 0。参考的费用读取一律走 `costForTurn`，`cost` 是它的复位基准
 *    （回合末 `resetAttributesAtEndOfTurn` 把 costForTurn 拉回 cost）。
 *  * `specialData` —— 暴走的伤害成长、灼热之刃的升级次数（对齐 `usesSpecialData()`
 *    列举的 SEARING_BLOW / RAMPAGE / GENETIC_ALGORITHM / RITUAL_DAGGER，后两张未登记）。
 *
 * ⚠ 未建模的 CardInstance 字段：`freeToPlayOnce`（深谋远虑，参考的升级分支整段被注释掉，
 * 本批未登记——见 TODOS）与 `retain`（保留，整套机制未做）。它们没有任何已登记内容能产生，
 * 现在加进来就是没有预言机看着的死字段。
 */
export type CombatCard = {
  /** 牌实例 uid。 */
  uid: number;
  /** 卡定义 id（cards.ts）。 */
  defId: string;
  upgraded: boolean;
  /**
   * 本场战斗的基础费用（对齐 CardInstance::cost）。
   * 特殊值照抄参考的 `getEnergyCost`：**-1 = X 费**、**-2 = 打不出的状态/诅咒牌**。
   * 这两个负值是 `setCostForTurn` 的哨兵（它只在 `costForTurn >= 0` 时才写），不能规整成 0。
   */
  cost: number;
  /** 本回合的费用（对齐 CardInstance::costForTurn）。打牌读的是它，不是 cost。 */
  costForTurn: number;
  /** 逐实例特殊数值（对齐 CardInstance::specialData）：暴走的成长量 / 灼热之刃的升级次数。 */
  specialData: number;
};

// ============================================================================
// 卡牌实例级状态的原语（对齐 CardInstance 的几个 setter）
// ============================================================================

/**
 * 一张牌进入战斗时的基础费用（对齐 `getEnergyCost(id, upgraded)`）。
 *
 * ⚠ 两个负值是参考的哨兵，必须原样带进来：X 费牌 -1、打不出的状态/诅咒牌 -2。
 * `setCostForTurn` 靠 `costForTurn >= 0` 认它们（负数一律不改），所以规整成 0 会让
 * 腐化/疯狂去动一张伤口的费用。
 */
export function initialCardCost(defId: string, upgraded: boolean): number {
  const def = getCardDef(defId);
  if (def.xCost === true) {
    return -1;
  }
  const cost = costOf(def, upgraded);
  return cost ?? -2;
}

/**
 * 一张牌进入战斗时的 specialData（对齐 `CardInstance(const Card &card)`，
 * CardInstance.cpp:16）：灼热之刃取大牌组里那张的**升级次数**，其余取 `Card::misc`。
 *
 * ⚠ 我们的 run 层只有 `upgraded: boolean`，所以灼热之刃在这里最多只能是 0 或 1——
 * 篝火反复升级同一张灼热之刃的 run 级语义尚未建模（`CardInstance` 那边同样只从
 * `Card::misc` 读）。战斗**内**的反复升级（军备）由 `upgradeCard` 正确累加。
 */
function initialSpecialData(defId: string, upgraded: boolean): number {
  return defId === "searing_blow" && upgraded ? 1 : 0;
}

/**
 * 设置本回合费用（对齐 CardInstance::setCostForTurn，CardInstance.cpp:120）。
 *
 * ⚠ 两处照抄：① `costForTurn >= 0` 才写——负的 costForTurn（X 费 -1、状态/诅咒 -2）
 * 是「没有费用」的哨兵，任何降费都不该动它；② 写入前 `max(0, newCost)`，所以腐化传
 * 的 -9 落地是 0（参考真的传 -9，不是笔误：游戏里技能牌的费用修正量就是 -9）。
 */
function setCostForTurn(card: CombatCard, newCost: number): void {
  if (card.costForTurn >= 0) {
    card.costForTurn = Math.max(0, newCost);
  }
}

/**
 * 按增量改基础费用（对齐 CardInstance::updateCost，CardInstance.cpp:106）。
 * 血债血偿每次失血调用一次（amount = -1）。
 *
 * ⚠ 形状照抄：先记下 `cost - costForTurn` 的差，改完 cost 再按同样的差重算 costForTurn，
 * 于是「本回合已被别的效果降过费」这件事在跨回合时不会被抹掉。cost 已经是 0 时
 * `max(0, cost-1)` 仍是 0，与旧值相等 → 整个 if 不进，costForTurn 也不动。
 */
function updateCardCost(card: CombatCard, amount: number): void {
  const tmpCost = Math.max(0, card.cost + amount);
  const diff = card.cost - card.costForTurn;
  if (tmpCost !== card.cost) {
    card.cost = tmpCost;
    card.costForTurn = Math.max(0, card.cost - diff);
  }
}

/**
 * 「这张牌是不是血牌」（对齐 CardInstance::isBloodCard）：血债血偿与精妙之刺。
 * 后者是静默的牌、当前范围外，所以这里只有一张。
 */
function isBloodCard(card: CombatCard): boolean {
  return card.defId === "blood_for_blood";
}

/**
 * 玩家失血时更新血牌的费用（对齐 CardManager::onTookDamage，CardManager.cpp:448）。
 *
 * ⚠ 三处：① 扫的是**手牌 / 抽牌堆 / 弃牌堆**，消耗堆不在其列；② 触发点是
 * `Player::hpWasLost`，即**所有**失血路径（受击、自伤、灼伤）都算，不只「因牌失血」——
 * 与破裂那条 `selfDamage` 判定不同；③ 血债血偿走 `updateCost(-1)`，精妙之刺是 `+1`
 * （参考的 else 分支，未登记）。
 */
function cardsOnTookDamage(bc: BattleContext): void {
  for (const pile of [bc.hand, bc.drawPile, bc.discardPile]) {
    for (const card of pile) {
      if (isBloodCard(card)) {
        updateCardCost(card, -1);
      }
    }
  }
}

/**
 * 回合末复位本回合费用（对齐 CardManager::resetAttributesAtEndOfTurn，CardManager.cpp:379）。
 *
 * ⚠ 只扫**手牌 / 弃牌堆 / 抽牌堆**——消耗堆不复位（腐化把消耗堆里的技能也压成 0 费，
 * 但那条改的是 `cost` 本身，复位读的正是 `cost`，所以两边不打架）。
 */
function cardsResetAttributesAtEndOfTurn(bc: BattleContext): void {
  for (const pile of [bc.hand, bc.discardPile, bc.drawPile]) {
    for (const card of pile) {
      setCostForTurn(card, card.cost);
    }
  }
}

/**
 * 战斗内的一件遗物（对齐 `RelicInstance`，`RelicContainer.h:10`：`{RelicId id; int data;}`）。
 *
 * ⚠⚠ **`data` 有两种含义，别按一种抄**（第四十四批把这一族接上）：
 *  * **数值**——`initRelics` 把它搬进 `Player` 的某个计数器、`updateRelicsOnExit` 再写回去，
 *    所以它在真实 run 里**跨战斗延续**：快乐花（`= data + 1`，那个 +1 非直觉但照抄）/
 *    熏香炉 / 墨水瓶 / 插入器 / 双节棍 / 笔尖（`data == 9` 走另一支）/ 日晷 /
 *    尼奥的挽歌（`data > 0` 才生效，出战斗时递减）。
 *  * **真假**——`p.setHasRelic<X>(r.data)`，只有御守与蜥蜴尾两颗（`BattleContext.cpp:178`
 *    与 `:186`）。⚠ **`data == 0` 等于「这颗遗物在战斗内不存在」**：那一句**覆盖**从
 *    run 层拷进来的位，所以带着 0 充能的御守在战斗里一点作用都没有。
 *
 * run 层对应的是 `RelicState.counter`（`types.ts`），`combat-bridge` 负责两头搬运。
 */
export type CombatRelic = {
  id: string;
  /** 对齐 `RelicInstance::data`；刚拿到的遗物是 0（御守 / 蜥蜴尾那种「充能」除外）。 */
  data: number;
};

export type CombatPlayer = {
  hp: number;
  maxHp: number;
  block: number;
  energy: number;
  energyPerTurn: number;
  cardDrawPerTurn: number;
  powers: PowerInstance[];
  /**
   * 玩家身上「有哪些遗物」的位集合（对齐 `Player::relicBits0/1`，Player.h:96-97）。
   *
   * ⚠⚠ **它与 `bc.relics`（遗物容器）不是同一个东西，参考也把两者分开存**：
   * `initRelics` 的**第一句**是 `player.relicBits = gc.relics.relicBits`（拷一份），
   * 之后有四处**只改这一份**：
   *   * `setHasRelic<LIZARD_TAIL>(r.data)` / `setHasRelic<OMAMORI>(r.data)`
   *     （`BattleContext.cpp:178` / `:186`）——data 0 时把位**清掉**；
   *   * `setHasRelic<LIZARD_TAIL>(false)`（`Player.cpp:340`，复活用掉了）；
   *   * `setHasRelic<CENTENNIAL_PUZZLE>(false)`（`Player.cpp:295`，一场只触发一次）。
   * 所以「战斗内还有没有这颗遗物」必须读这一份，`hasRelic()` 因此走它而不是 `bc.relics`。
   * ⚠ 反过来，`initRelics` / `atBattleStart` 那两个 `for (auto &r : g.relics.relics)`
   * 遍历的是**容器**（要读 `r.data`），那两处仍然走 `bc.relics`。
   */
  relicBits: string[];
  cardsPlayedThisTurn: number;
  /**
   * 本回合已打出的**攻击牌**张数（对齐 `Player::attacksPlayedThisTurn`，Player.h:80）。
   *
   * ⚠ 自增点在 `onUseAttackCard` 的**第一句**（BattleContext.cpp:1643），排在所有读者
   * **之前**——所以「本回合第 1 张攻击牌」读到的是 1，不是 0。三颗遗物的判据是
   * `% 3 == 0`，而 0 也满足它：把自增挪到读点之后会让每张攻击牌都在「上一张的计数」上判，
   * 第 1 张（读到 0）就误触发。**顺序即语义，照抄。**（第四十一批）
   *
   * 读者：苦无 / 装饰扇 / 手里剑（`onUseAttackCard` 里三处独立的 `% 3 == 0`），
   * 以及尚未登记的战争艺术（`applyStartOfTurnRelics` 里读 `== 0`，而清零排在它**之后**，
   * 所以它读的是**上一回合**的计数——登记它时要专门核这一处）。
   */
  attacksPlayedThisTurn: number;
  /**
   * 本回合已打出的**技能牌**张数（对齐 `Player::skillsPlayedThisTurn`，Player.h:81）。
   * 自增点同样在 `onUseSkillCard` 的第一句（BattleContext.cpp:1769）。
   * 唯一读者是拆信刀（第四十一批登记）。
   */
  skillsPlayedThisTurn: number;
  /**
   * 墨水瓶的「已打出牌数」计数器（对齐 `Player::inkBottleCounter`，Player.h:67）。
   *
   * ⚠ 它**不是**回合级的：`applyStartOfTurnRelics` 里没有它，整场战斗一直累加，
   * 每到 10 就归零并抽一张。与 `attacksPlayedThisTurn` 那一族（回合末清零）是两回事。
   * ⚠ 参考在 `initRelics` 里写 `p.inkBottleCounter = r.data`（BattleContext.cpp:164-165）、
   * 在 `updateRelicsOnExit` 里写回 `r.data = player.inkBottleCounter`（:532-533），
   * 所以它在真实 run 里**跨战斗延续**。✅ 第四十四批把这一对读写接上了
   * （`bc.relics` 带 `data` + `updateRelicsOnExit`）。
   *
   * 读者：`onUseAttackCard` :1694 / `onUseSkillCard` :1811 / `onUsePowerCard` :1889 /
   * `onUseStatusOrCurseCard` :1958 —— **四处逐字相同**，见 `inkBottleOnUseCard`。
   */
  inkBottleCounter: number;
  /**
   * 快乐花的计数器（对齐 `Player::happyFlowerCounter`，Player.h:64）。
   *
   * ⚠⚠ **`initRelics` 写的是 `r.data + 1`**（BattleContext.cpp:149），不是 `r.data`——
   * 那个 `+1` 是「开局这一回合也算一回合」，非直觉但照抄。紧接着的
   * `if (counter == 3) { ++energy; counter = 0; }` 与回合开始那一处**不是同一份代码**
   * （`Player.cpp:522-527` 那份是 `if (++counter == 3) { counter = 0; addToBot(GainEnergy(1)) }`
   * ——先自增再判，而且能量是**入队**的）。两处的形状真的不同，别合并。
   */
  happyFlowerCounter: number;
  /**
   * 熏香炉的计数器（对齐 `Player::incenseBurnerCounter`，Player.h:65）。
   * `initRelics` 是 `= r.data` 之后 `if (++counter == 6)`（先赋值再自增，**净效果 data+1**），
   * 回合开始那份是同样的 `if (++counter == 6)`。⚠ 与快乐花的 `= data + 1` 写法不同、
   * 数值同解——照抄各自的写法。
   */
  incenseBurnerCounter: number;
  /** 双节棍的「已打出攻击牌数」（对齐 `Player::nunchakuCounter`，Player.h:68）。 */
  nunchakuCounter: number;
  /**
   * 笔尖的「已打出攻击牌数」（对齐 `Player::penNibCounter`，Player.h:69）。
   *
   * ⚠⚠ **它可以是 -1**：数到 9 那一刻参考写 `penNibCounter = -1`（`BattleContext.cpp:1732`，
   * 行尾自注 `// take note of this`），意思是「本次强化已经发出去了」。出战斗时
   * `updateRelicsOnExit` 把 -1 又写回成 **9**（`:552-556`，参考自注 `// possible bug`），
   * 于是下一场开局 `r.data == 9` 那一支直接带着 `PEN_NIB` 进场。照抄两处。
   */
  penNibCounter: number;
  /** 日晷的「已洗牌次数」（对齐 `Player::sundialCounter`，Player.h:70）。 */
  sundialCounter: number;
  /**
   * 死灵之书本回合是否已经复制过一张牌（对齐 `Player::haveUsedNecronomiconThisTurn`，
   * Player.h:76）。回合开始在 `applyStartOfTurnRelics` 里复位（`Player.cpp:555-557`）——
   * ⚠ 那一处是**同步**赋 false，不是 Power、不进快照。
   */
  haveUsedNecronomiconThisTurn: boolean;
  /**
   * 橙色药丸的「本回合已打出的牌型」位掩码（对齐 `Player::orangePelletsCardTypesPlayed`，
   * `std::bitset<3>`，Player.h:82）。
   *
   * ⚠ 位序**就是 `CardType` 的枚举值**（Cards.h:406-413：ATTACK=0 / SKILL=1 / POWER=2），
   * 参考写的是 `set(static_cast<int>(CardType::X), true)`。诅咒与状态牌的枚举值是 3 / 4，
   * 而 `bitset<3>` 只有三位——参考因此**根本没在 `onUseStatusOrCurseCard` 里放橙色药丸**
   * （放了就是越界）。这不是我们简化的，是参考的形状。
   *
   * ⚠ 三个写点（:1706 / :1819 / :1897）只负责置位与「集齐就清空 + 入队清减益」，
   * **回合开始的复位是另一处**（`Player::applyStartOfTurnRelics` 的最后一句，
   * Player.cpp:559-561）。两件事分开记，见 `orangePelletsOnUseCard` 与 `RELIC_AT_TURN_START`。
   */
  orangePelletsCardTypesPlayed: number;
  /**
   * 燃烧的失血量（对齐 Player::combustHpLoss）。**不是**燃烧的层数：
   * `Player::buff<PS::COMBUST>` 每次调用都 `++combustHpLoss`，而层数按 5/7 累加，
   * 所以「打了几张燃烧」和「对所有敌人打多少」是两个独立的数。
   */
  combustHpLoss: number;
  /**
   * 炸弹的三格计时器（对齐 Player::bomb1 / bomb2 / bomb3，Player.h:89-91）。
   *
   * 炸弹**不是** statusMap 里的 Power：`Player::buff<PS::THE_BOMB>` 在写 statusMap 之前就
   * `bomb3 += amount; return;` 了（Player.h:330）。每个回合末**先**引爆 `bomb1`，再整体
   * 前移一格（`bomb1 = bomb2; bomb2 = bomb3; bomb3 = 0`），所以打出后要等三个回合末。
   * 同一回合打两张就是 `bomb3` 累加，不是两个独立计时器。
   */
  bomb1: number;
  bomb2: number;
  bomb3: number;
  /**
   * 战斗内金币（对齐 Player::gold，Player.h:36）。
   *
   * 金币是 **run 级**资源：参考在 `BattleContext::init` 里 `player.gold = gc.gold`、
   * 在 `exitBattle` 里 `g.gold = player.gold` 写回去（BattleContext.cpp:55 / :484）。
   * 我们照同一形状：`initCombat` 从入参带进来，`combat-bridge.settleCombat` 写回
   * `GameState.gold`。战斗内唯一的增点是贪婪之手（`gainGold`），唯一的减点是
   * 抢劫者/劫匪偷金币（`stealGoldFromPlayer`，第十五批登记了抢劫者）。
   *
   * ⚠ **入场值有语义，不能随便填 0**：偷金是 `min(player.gold, 额度)`，按金币的**绝对值**
   * 钳制。第十五批之前 trace 重放故意从 0 起算（那时没有任何东西读金币），登记抢劫者之后
   * 那样做会让一分钱都偷不到——见 `test/sts-combat-trace.test.ts` 的 `HARNESS_GOLD_BASELINE`。
   */
  gold: number;
  /**
   * 上一次**被攻击**时真正扣掉的血（对齐 `Player::lastAttackUnblockedDamage`，Player.h:86）。
   *
   * 参考在 `Player::attacked` 末尾维护它：扣掉格挡（以及缓冲 / 鸟居 / 钨钢棒）之后
   * 若还剩伤害就记下那个值，否则记 **0**（Player.cpp:243-257）。
   *
   * ⚠ 唯一的读者是带壳寄生虫的吸取（`Actions::VampireAttack`，第二十五批）：
   * 回血量是 `min(这一击的伤害, lastAttackUnblockedDamage)`，所以格挡挡住多少就少回多少。
   * 它是个**跨调用的字段**而不是返回值，形状照抄参考——将来若有第二个「隔着动作队列
   * 读上一击」的读者，返回值那种写法就会静默错。
   * ⚠ 只有 `attacked`（怪物攻击）这条路写它；`damage` / `loseHp`（灼伤、自伤）**不写**。
   */
  lastAttackUnblockedDamage: number;
  /**
   * 上一次「需要指定目标的牌」打在了哪个下标上（对齐 `Player::lastTargetedMonster`，
   * Player.h:47）。**初值是 1，不是 0**——参考的成员初始化器写死 `= 1`。
   *
   * ⚠ 写入点只有一处，而且带两道门（BattleContext.cpp:864-874）：
   *     if (canUseCard) { … if (c.requiresTarget()) { player.lastTargetedMonster = item.target; } … }
   *   ① 在 `canUseCard` 里面——被 `canUse` 挡下的牌（浩劫翻出的诅咒 / 状态牌）不写；
   *   ② `requiresTarget()` 就是 `cardTargetsEnemy(id, upgraded)`，与我们的 `targetedOf`
   *      同源——技能 / 能力 / 群伤牌一律不写，所以它可以在整场仗里停在 1 不动。
   * ⚠ 它排在紧接着的目标有效性判断**之前**：目标死了、这张牌没打出去，这个字段照样已经改了。
   *
   * ⚠⚠ 唯一的读者是被围攻（SURROUNDED，第四十七批的尖塔护盾）：
   *   `Monster::calculateDamageToPlayer` 的
   *     facingSelf = (lastTargetedMonster == idx) || arr[lastTargetedMonster].isDeadOrEscaped()
   *   在此之前它是纯粹的死字段，所以第四十七批之前这里只有一条 `TODO(后续PR)`。
   */
  lastTargetedMonster: number;
};

// ============================================================================
// BattleContext 状态（对齐 struct BattleContext）——骨架层字段集
// ============================================================================

export type BattleContext = {
  rng: CombatRng;

  seedLong: bigint;
  floorNum: number;
  ascension: number;
  /** 本场编队 id（对齐 BattleContext::encounter）。战斗后的 Boss 判定要读它。 */
  encounterId: string;
  /** 角色（决定药水池前 3 项）。 */
  character: CharacterId;
  /**
   * 遗物容器（对齐 `RelicContainer::relics`，按获得顺序）。
   *
   * ⚠ 这是**容器**，不是「玩家身上还有没有」——后者是 `player.relicBits`，见那里的注释。
   * `initRelics` 的两遍遍历读的是这一份（要拿 `r.data`），别的地方一律走 `hasRelic()`。
   */
  relics: CombatRelic[];

  /** 药水槽（定长 potionCapacity；null = 空）。 */
  potions: (string | null)[];
  potionCount: number;
  potionCapacity: number;

  outcome: Outcome;
  inputState: InputState;
  /**
   * 选牌屏状态（对齐 BattleContext::cardSelectInfo）；null ⟺ inputState 不是 card_select。
   *
   * 参考那边它是个常驻结构、关屏后残值留着；我们用 null 表达「没开屏」，这样存档往返有个
   * 明确不变量可查，也不会在快照里留一份看着像真的残值。
   */
  cardSelect: CardSelectInfo | null;
  turn: number;

  actionQueue: ActionQueue;
  cardQueue: CardQueue;

  player: CombatPlayer;
  monsters: CombatMonster[];
  /** 存活怪物数（对齐 MonsterGroup::monstersAlive）；归零即玩家胜利。 */
  monstersAlive: number;

  hand: CombatCard[];
  drawPile: CombatCard[];
  discardPile: CombatCard[];
  exhaustPile: CombatCard[];

  /**
   * 「在场」的打击牌张数（对齐 CardManager::strikeCount）。完美打击的伤害读它。
   *
   * 是**增量计数器**而不是派生量：见 `notifyAddCardToCombat` / `notifyRemoveFromCombat`
   * 那一节。它算上「已离开手牌、还没进弃牌堆」的在飞牌，所以扫牌堆是数不出来的。
   */
  strikeCount: number;

  /**
   * 被青铜球「停滞」扣住的牌（对齐 `CardManager::stasisCards`，CardManager.h:32）。
   *
   * ⚠ 定长 **2** 格，索引是 `min(1, 怪物下标)`（`MonsterSpecific.cpp:3540` / `:3553`）——
   * 青铜自动机的两颗球落在 0 号位与 2 号位，于是各占一格。参考的注释就写着
   * `// for bronze automaton fight`，全项目只有这一个用户。
   * ⚠ 它**不在** harness 的快照里，但两头都可观察：取走那一刻抽/弃牌堆少一张，
   * 那颗球死掉时手牌（或弃牌堆）多一张。
   */
  stasisCards: (CombatCard | null)[];

  /** 怪物回合游标：>= monsters.length 表示当前不在怪物回合（对齐 monsterTurnIdx，游戏初值 6）。 */
  monsterTurnIdx: number;

  /**
   * 「这一轮跳过谁的怪物回合」（对齐 `MonsterGroup::skipTurn`，`MonsterGroup.h:24` 的
   * `std::bitset<5>`，第三十六批）。
   *
   * ⚠ 全参考项目**只有一个写入点**：`Monster::reptomancerSummon`（MonsterSpecific.cpp:3606）。
   * 蜥蜴法师在 2 号位，召唤出来的匕首可能落在 3 或 4 号位——那两格的游标还没走到，
   * 不置这一位的话新匕首**本回合就会行动**。
   * ⚠ 读点是 `MonsterGroup::doMonsterTurn` 的门（`:572-578`），清点是
   * `BattleContext::executeActions` 里「怪物回合走完」那一句 `monsters.skipTurn.reset()`
   * （BattleContext.cpp:805）——所以它的生命周期**不跨回合**。
   * ⚠ 前三条召唤路径都不用它：青铜自动机靠 `++monsterTurnIdx` 推游标，
   * 地精首领与收藏家的宿主位置让新来的本来就轮不到。
   *
   * ⚠ **不进 `StsCombatState`**：存档点必然是玩家可操作态（`exportState` 有断言），
   * 而走到那里的每一条路径都先经过「怪物回合走完 → reset」那一句，所以它在存档点恒为空。
   * 存一个恒空的字段只会多一处可以对不上的地方。
   */
  skipTurn: Set<number>;

  endTurnQueued: boolean;
  turnHasEnded: boolean;

  /** uid 分配器。 */
  nextUid: number;
};

/** 便捷入队（对齐 addToTop / addToBot）。desc 见 ActionDesc：只有能跨选牌屏存活的才需要。 */
export function addToTop(
  bc: BattleContext,
  fn: ActionFn,
  clearOnVictory = true,
  desc: ActionDesc | null = null,
): void {
  bc.actionQueue.pushFront(makeAction(fn, clearOnVictory, desc));
}

export function addToBot(
  bc: BattleContext,
  fn: ActionFn,
  clearOnVictory = true,
  desc: ActionDesc | null = null,
): void {
  bc.actionQueue.pushBack(makeAction(fn, clearOnVictory, desc));
}

// ⚠ 这里原先有一个 `livingMonsters(bc)` 辅助函数，唯一的调用者是 `afterMonsterTurns`
//   末尾那句「场上没有活怪就判胜」。第三十七批把那句删掉了（参考里没有它，理由见那一处），
//   于是这个函数也跟着退场。判胜的完整名单在 `monsterDie` / `monsterEscape` /
//   `monsterSuicideNoTrigger` 三个函数里，都是「怪物退场的那一刻」判。

// ============================================================================
// 怪物意图选择（rollMove）——对齐 Monster::rollMove + getMoveForRoll
//
// rollMove 恒先消耗一次 aiRng.random(99) 得到 roll(0-99)，再交给 getMoveForRoll 分派。
// 关键：roll 本体消耗恒为 1，但某些怪的 getMoveForRoll 分支内会追加 aiRng.randomBoolean，
// 所以「单次 rollMove 的 aiRng 消耗不是常数」。骨架层先登记确定性单怪（Cultist），
// 追加消耗的怪随迁移登记。未登记的怪抛错，保持诚实（不静默错配 RNG）。
// ============================================================================

/** getMoveForRoll：给定 roll 与意图历史，返回下一个 move id。可在内部追加消耗 aiRng。 */
type MoveForRoll = (bc: BattleContext, m: CombatMonster, roll: number) => string;

/**
 * 占位意图（对齐参考给颚虫军团预置的 DARKLING_REGROW 哨兵）：只要不是 INVALID 即可，
 * 作用是让首次 rollMove 的 firstTurn() 为假，从而直接走 roll 分支。
 */
const MOVE_SENTINEL = "__preset__";

/** 对齐 Monster::firstTurn（moveHistory[0] == INVALID）。 */
function firstTurn(m: CombatMonster): boolean {
  return m.moveHistory.length === 0;
}

/** 对齐 Monster::lastMove（moveHistory[0] == moveId）。 */
function lastMove(m: CombatMonster, moveId: string): boolean {
  return m.moveHistory[0] === moveId;
}

/** 对齐 Monster::lastTwoMoves（moveHistory[0] 与 [1] 均为 moveId）。 */
function lastTwoMoves(m: CombatMonster, moveId: string): boolean {
  return m.moveHistory[0] === moveId && m.moveHistory[1] === moveId;
}

/**
 * 对齐 `Monster::lastMoveBefore`（**moveHistory[1]** == moveId，Monster.cpp:617-619）。
 *
 * ⚠ 它与 `lastTwoMoves` 不是一回事：那条要求两格**都**是 moveId，这条**只看上上一格**。
 * 第二十九批的冠军二阶段用的是 `!lastMove(EXECUTE) && !lastMoveBefore(EXECUTE)`
 * ——「最近两格里都没有处决」，这正是 `eitherLastTwo` 的反面。
 */
function lastMoveBefore(m: CombatMonster, moveId: string): boolean {
  return m.moveHistory[1] === moveId;
}

/**
 * 对齐 `Monster::eitherLastTwo`（**moveHistory[0] 或 [1]** == moveId，Monster.cpp:625-627）。
 *
 * ⚠ 参考在 Monster.cpp:609-627 并排放了五个谓词（`firstTurn` / `lastMove` /
 * `lastMoveBefore` / `lastTwoMoves` / `eitherLastTwo`），登记时要逐字看清用的是哪一个：
 * 这一条是 `lastTwoMoves` 的**对偶**（那条要求两格都是，这条只要有一格是），
 * 也正好是 `!lastMove && !lastMoveBefore` 的反面（第二十九批冠军那条）。
 * 第一个用户是复仇魔的巨镰连续限制（第三十六批）。
 */
function eitherLastTwo(m: CombatMonster, moveId: string): boolean {
  return m.moveHistory[0] === moveId || m.moveHistory[1] === moveId;
}

/**
 * 对齐 `lastMoveBefore(MonsterMoveId::INVALID)`（**moveHistory[1] 还没被写过**）。
 *
 * 参考的 `moveHistory` 是一个初值全 `INVALID` 的定长两格数组，所以「上上一格是 INVALID」
 * 等价于「这只怪至多出过一次手」。我们这边 `moveHistory` 是 `string[]`（最近的在前），
 * 于是同一件事就是 `moveHistory[1] === undefined`。
 *
 * ⚠ 唯一的用户是尖塔护盾的猛击与加固（第四十七批，MonsterSpecific.cpp:1768 / :1780）：
 *   `if (lastMoveBefore(SPIRE_SHIELD_SMASH) || lastMoveBefore(INVALID))`——两个析取项，
 *   第二项专门管「这才是它第二次出手，上上格还是空的」那一帧。漏掉它会让护盾第二次
 *   出手就滚进重砸，整条意图链从第二个怪物回合起全错。
 */
function lastMoveBeforeInvalid(m: CombatMonster): boolean {
  return m.moveHistory[1] === undefined;
}

const MOVE_RULES: Record<string, MoveForRoll> = {
  // 邪教徒：首回合（无历史）必咏唱，之后恒暗袭。roll 被消耗但不影响结果（故不取用）。
  // 对齐 MonsterSpecific.cpp:2280 CULTIST。
  cultist: (_bc, m) => (firstTurn(m) ? "incantation" : "dark_strike"),

  // 颚虫：对齐 MonsterSpecific.cpp:2450 JAW_WORM。
  // ⚠ 三处分支会**追加**一次 aiRng.randomBoolean(chance)，故单次 rollMove 的 aiRng
  // 消耗不是常数（1 或 2 次）——这是逐位对齐最易错的地方。
  // chance 走 Math.fround 收窄成 float32，与 C++ 的 `nextFloat() < 0.357f` 同精度比较。
  jaw_worm: (bc, m, roll) => {
    if (firstTurn(m)) {
      return "chomp";
    }
    if (roll < 25) {
      if (lastMove(m, "chomp")) {
        return bc.rng.aiRng.randomBoolean(Math.fround(0.5625)) ? "bellow" : "thrash";
      }
      return "chomp";
    }
    if (roll < 55) {
      if (lastTwoMoves(m, "thrash")) {
        return bc.rng.aiRng.randomBoolean(Math.fround(0.357)) ? "chomp" : "bellow";
      }
      return "thrash";
    }
    if (lastMove(m, "bellow")) {
      return bc.rng.aiRng.randomBoolean(Math.fround(0.416)) ? "chomp" : "thrash";
    }
    return "bellow";
  },

  // 红虱：纯 roll 分支，不追加 aiRng。对齐 MonsterSpecific.cpp:2583 RED_LOUSE。
  // （asc17 会放宽连续 grow 的限制，这里按 ascension<17 转写并保留判断位置。）
  louse: (bc, m, roll) => {
    if (roll < 25) {
      if (lastMove(m, "grow") && (bc.ascension >= 17 || lastTwoMoves(m, "grow"))) {
        return "bite";
      }
      return "grow";
    }
    if (lastTwoMoves(m, "bite")) {
      return "grow";
    }
    return "bite";
  },

  // 绿虱：与红虱同构，buff 招换成吐丝。对齐 MonsterSpecific.cpp:2313 GREEN_LOUSE。
  green_louse: (bc, m, roll) => {
    if (roll < 25) {
      if (lastMove(m, "spit_web") && (bc.ascension >= 17 || lastTwoMoves(m, "spit_web"))) {
        return "bite";
      }
      return "spit_web";
    }
    if (lastTwoMoves(m, "bite")) {
      return "spit_web";
    }
    return "bite";
  },

  // —— 史莱姆四只（第十三批）——

  // 酸液史莱姆（中）：对齐 MonsterSpecific.cpp:1903 ACID_SLIME_M。
  // ⚠ 三条分支会**追加**一次 aiRng.randomBoolean，所以单次 rollMove 的 aiRng 消耗是 1 或 2。
  // ⚠ 三处非直觉但照抄：
  //  ① 第一段（roll<30）的连续限制是 `lastTwoMoves(腐蚀喷吐)`，第二段（roll<70）却是
  //     `lastMove(冲撞)`——**一个看两回合、一个只看一回合**，不是笔误，asc17 那份才两段
  //     都用 lastTwoMoves（见下）。
  //  ② 第一段追加的 randomBoolean **不带概率参数**（即 0.5），另两段是 0.4f。
  //     ⚠ `randomBoolean()` 走 `nextBoolean()`、`randomBoolean(0.5f)` 走 `nextFloat() < 0.5f`
  //     ——**两条不同的路径，同种子下取值不同**（Random.h:126 / :196）。asc17 那份第二段
  //     写的正是显式的 `0.5f`，不能与这里的无参版本合并。
  //  ③ 三条 randomBoolean 的 true 分支各自返回不同的招，别按「true=攻击」想当然。
  // ⚠ asc>=17 是**另一整块**（第二十一批转写）：阈值 40/80（而非 30/70）、
  //   第二段改用 `lastTwoMoves(冲撞)` + 显式 `0.5f`、第三段改用 `lastMove(舔舐)`。
  //   四处差别没有一处是「等价改写」，逐条照抄。
  acid_slime_m: (bc, m, roll) => {
    if (bc.ascension >= 17) {
      // —— START ASCENSION 17（MonsterSpecific.cpp:1928-1963）——
      if (roll < 40) {
        if (lastTwoMoves(m, "corrosive_spit")) {
          return bc.rng.aiRng.randomBoolean() ? "tackle" : "lick"; // ★ 追加一次 aiRng
        }
        return "corrosive_spit";
      }
      if (roll < 80) {
        if (lastTwoMoves(m, "tackle")) {
          // ⚠ 显式 0.5f（走 nextFloat 那条路），与 asc<17 第一段的无参 randomBoolean 不同。
          return bc.rng.aiRng.randomBoolean(Math.fround(0.5)) ? "corrosive_spit" : "lick"; // ★ 追加一次 aiRng
        }
        return "tackle";
      }
      if (lastMove(m, "lick")) {
        return bc.rng.aiRng.randomBoolean(Math.fround(0.4)) ? "corrosive_spit" : "tackle"; // ★ 追加一次 aiRng
      }
      return "lick";
      // —— END ASCENSION 17 ——
    }
    if (roll < 30) {
      if (lastTwoMoves(m, "corrosive_spit")) {
        return bc.rng.aiRng.randomBoolean() ? "tackle" : "lick"; // ★ 追加一次 aiRng
      }
      return "corrosive_spit";
    }
    if (roll < 70) {
      if (lastMove(m, "tackle")) {
        return bc.rng.aiRng.randomBoolean(Math.fround(0.4)) ? "corrosive_spit" : "lick"; // ★ 追加一次 aiRng
      }
      return "tackle";
    }
    if (lastTwoMoves(m, "lick")) {
      return bc.rng.aiRng.randomBoolean(Math.fround(0.4)) ? "corrosive_spit" : "tackle"; // ★ 追加一次 aiRng
    }
    return "lick";
  },

  // 酸液史莱姆（小）：对齐 MonsterSpecific.cpp:1889 ACID_SLIME_S。
  // ⚠ **完全不看 roll**，而是**再掷一次** aiRng.randomBoolean 决定首招——于是它的
  // rollMove 恒消耗 **2** 次 aiRng（roll 那次照掷、只是结果被丢掉）。
  // ⚠ 而且这个 rule 一场仗只会被调用一次：takeTurn 那两条用的是**同步 setMove** 严格交替，
  // 压根不排 RollMove（见 MOVE_TURN_END）。
  // ⚠ asc>=17 直接 `return ACID_SLIME_S_LICK`（MonsterSpecific.cpp:1912-1913），
  //   **不掷** randomBoolean——于是它的 rollMove 从恒 2 次 aiRng 变成恒 1 次。
  //   这不是「少个分支」，是 aiRng 计数器整场错位，第二十一批转写。
  acid_slime_s: (bc) => {
    if (bc.ascension >= 17) {
      return "lick_weak";
    }
    return bc.rng.aiRng.randomBoolean() ? "tackle_acid_s" : "lick_weak"; // ★ 追加一次 aiRng
  },

  // 尖刺史莱姆（中）：对齐 MonsterSpecific.cpp:2820 SPIKE_SLIME_M。
  // 纯 roll 分支，不追加 aiRng。asc17 那条判断是**内联**在同一表达式里的，故一并转写。
  spike_slime_m: (bc, m, roll) => {
    if (roll < 30) {
      return lastTwoMoves(m, "flame_tackle") ? "lick_frail" : "flame_tackle";
    }
    if (lastTwoMoves(m, "lick_frail") || (bc.ascension >= 17 && lastMove(m, "lick_frail"))) {
      return "flame_tackle";
    }
    return "lick_frail";
  },

  // 尖刺史莱姆（小）：对齐 MonsterSpecific.cpp:2769 SPIKE_SLIME_S——恒返回冲撞。
  // roll 照掷（rollMove 顶部那次），但结果被丢掉，与邪教徒同形。
  spike_slime_s: () => "tackle_s",

  // —— 大史莱姆两只（第十四批）——
  //
  // ⚠ 两只的 `getMoveForRoll` 里都**没有分裂**。分裂不是掷出来的意图，而是
  // `Monster::onHpLost`（Monster.cpp:499）在掉到半血时**直接改写 moveHistory[0]**
  // ——见下方 `MONSTER_ON_HP_LOST`。所以这里的分支表与 M 号完全同构。

  // 酸液史莱姆（大）：对齐 MonsterSpecific.cpp:1976 ACID_SLIME_L。
  // 与 acid_slime_m 逐分支同构（阈值 30/70、三条追加 randomBoolean 的概率 0.5/0.4/0.4、
  // 连续限制 lastTwoMoves/lastMove/lastTwoMoves），只有返回的招式 id 换成 L 号自己的。
  // ⚠ 同样是「第一段看两回合、第二段只看一回合」那个非直觉但照抄的形状。
  // ⚠ asc>=17 是另一整块（第二十一批转写）：阈值 **40/70**（M 号是 40/80）、
  //   前两段的追加概率是 **0.6f**（M 号是 0.5f/0.4f）、第三段才是 0.4f。
  // ⚠⚠ **参考那一块的第一段原先写的是 `lastTwoMoves(ACID_SLIME_M_CORROSIVE_SPIT)`
  //   ——M 号的枚举，出现在 L 号的 case 里**（MonsterSpecific.cpp:2006）。L 号的
  //   moveHistory 里永远不会有 M 号的招式，于是那个条件**恒假**，追加的
  //   `randomBoolean(0.6F)` 与它后面的两个返回值全是死代码：roll<40 时恒出腐蚀喷吐。
  //   **第二十二批给参考打了补丁**（改成 L 号自己的枚举），这边同步改成 `corrosive_spit_l`。
  //   证据链：同一块 asc17 的第二段读 `L_TACKLE`、第三段读 `L_LICK`，**只有第一段是 M**。
  //   ⚠ 补丁把 `randomBoolean(0.6F)` 从死代码变成活代码，而那个 0.6 **未经验证**
  //   （本项目自己就是预言机，判不了它）——与缠绕补丁复活的阈值 50 同一档，记在 TODOS。
  //   ⚠ 背书只有 **1 例**（第二十一批实测：把笔误「修好」后对拍红 1 例），因为要求
  //   「连着两回合腐蚀喷吐 + 这一次 roll<40」，120 条 `large_slime@asc19` 里只有一条走到。
  acid_slime_l: (bc, m, roll) => {
    if (bc.ascension >= 17) {
      // —— START ASCENSION 17（MonsterSpecific.cpp:2002-2033）——
      if (roll < 40) {
        // ⚠ 见上：这里读的是 L 号自己的腐蚀喷吐（补丁后）。
        if (lastTwoMoves(m, "corrosive_spit_l")) {
          return bc.rng.aiRng.randomBoolean(Math.fround(0.6)) ? "tackle_l" : "lick_l"; // ★ 追加一次 aiRng
        }
        return "corrosive_spit_l";
      }
      if (roll < 70) {
        if (lastTwoMoves(m, "tackle_l")) {
          return bc.rng.aiRng.randomBoolean(Math.fround(0.6)) ? "corrosive_spit_l" : "lick_l"; // ★ 追加一次 aiRng
        }
        return "tackle_l";
      }
      if (lastMove(m, "lick_l")) {
        return bc.rng.aiRng.randomBoolean(Math.fround(0.4)) ? "corrosive_spit_l" : "tackle_l"; // ★ 追加一次 aiRng
      }
      return "lick_l";
      // —— END ASCENSION 17 ——
    }
    if (roll < 30) {
      if (lastTwoMoves(m, "corrosive_spit_l")) {
        return bc.rng.aiRng.randomBoolean() ? "tackle_l" : "lick_l"; // ★ 追加一次 aiRng
      }
      return "corrosive_spit_l";
    }
    if (roll < 70) {
      if (lastMove(m, "tackle_l")) {
        return bc.rng.aiRng.randomBoolean(Math.fround(0.4)) ? "corrosive_spit_l" : "lick_l"; // ★ 追加一次 aiRng
      }
      return "tackle_l";
    }
    if (lastTwoMoves(m, "lick_l")) {
      return bc.rng.aiRng.randomBoolean(Math.fround(0.4)) ? "corrosive_spit_l" : "tackle_l"; // ★ 追加一次 aiRng
    }
    return "lick_l";
  },

  // 尖刺史莱姆（大）：对齐 MonsterSpecific.cpp:2799 SPIKE_SLIME_L。
  // 纯 roll 分支，不追加 aiRng；asc17 那条判断**内联**在同一表达式里，故一并转写。
  // 与 spike_slime_m 逐分支同构。
  spike_slime_l: (bc, m, roll) => {
    if (roll < 30) {
      return lastTwoMoves(m, "flame_tackle_l") ? "lick_frail_l" : "flame_tackle_l";
    }
    if (lastTwoMoves(m, "lick_frail_l") || (bc.ascension >= 17 && lastMove(m, "lick_frail_l"))) {
      return "flame_tackle_l";
    }
    return "lick_frail_l";
  },

  // —— 奴隶主两只 + 抢劫者（第十五批）——

  // 蓝色奴隶主：纯 roll 分支，不追加 aiRng。对齐 MonsterSpecific.cpp:2046 BLUE_SLAVER。
  // ⚠ **没有首回合特例**——第一次 rollMove 也照常走这三条分支（此时 moveHistory 全空，
  //   两个 lastTwoMoves 都为假，于是 roll>=40 出刺击、否则出耙击）。
  // ⚠ 第二段那个 `|| (asc17 && !lastMove(RAKE))` 是**内联**在同一表达式里的，一并转写。
  blue_slaver: (bc, m, roll) => {
    if (roll >= 40 && !lastTwoMoves(m, "stab")) {
      return "stab";
    }
    if (!lastTwoMoves(m, "rake") || (bc.ascension >= 17 && !lastMove(m, "rake"))) {
      return "rake";
    }
    return "stab";
  },

  // 红色奴隶主：对齐 MonsterSpecific.cpp:2773 RED_SLAVER。
  //
  // ⚠⚠ **这四条分支里的 `usedEntangle` 依赖第十六批给参考打的补丁。**
  // 参考开头是 `const bool usedEntangle = miscInfo;`（:2777），但在补丁之前**全项目没有
  // 任何地方给红色奴隶主写过 `miscInfo`**——于是它恒为 false，「缠绕一场只用一次」失效
  // （第十五批实测：375 条 variant 0 里有一条放了 8 次缠绕），第二段整段是死代码。
  // 第十六批按 TODOS 的裁定在 `RED_SLAVER_ENTANGLE` 那条 case 补上了 `miscInfo = 1`
  // （MonsterSpecific.cpp:1017），两段因此都活了过来，这里跟着转写。
  // ⚠ 第二段的阈值 **50 未经验证**（真实游戏疑似 55，我们没有预言机能判它）——补丁注释里
  //   也标了。它现在是活代码，改它会改变行为，不要以为是死分支。
  // 我们侧的写入点在 `MOVE_TURN_BEGIN["red_slaver/entangle"]`（对齐参考写在 case 开头）。
  red_slaver: (bc, m, roll) => {
    // 对齐 `const bool usedEntangle = miscInfo;`——读的是**成员**，不是 rollMove 传进来的副本。
    const usedEntangle = m.miscInfo !== 0;
    // 参考写的是 `lastMove(MMID::INVALID)`，即 moveHistory[0] 还是初值——就是首回合。
    if (firstTurn(m)) {
      return "rs_stab";
    }
    if (roll >= 75 && !usedEntangle) {
      return "entangle";
    }
    // ⚠ 这一段在补丁之前是死代码，第十六批起才可达。阈值 50 未验证，见上。
    if (roll >= 50 && usedEntangle && !lastTwoMoves(m, "rs_stab")) {
      return "rs_stab";
    }
    if (!lastTwoMoves(m, "scrape") || (bc.ascension >= 17 && !lastMove(m, "scrape"))) {
      return "scrape";
    }
    return "rs_stab";
  },

  // 抢劫者：对齐 MonsterSpecific.cpp:2501 LOOTER——恒返回抢劫，roll 照掷但被丢掉
  // （与邪教徒 / 尖刺史莱姆小同形）。
  // ⚠ 参考在这行注了 `// called first turn only`，而且是真的：抢劫者的四条 case 尾部
  //   全是**同步 setMove**（或什么都没有），一次都不排 RollMove，所以整场只会调用它一次。
  looter: () => "mug",

  // —— 真菌兽（第十六批）——
  //
  // 对齐 MonsterSpecific.cpp:2294 FUNGI_BEAST。纯 roll 分支，不追加 aiRng，也**没有首回合特例**
  // （首次 rollMove 时 moveHistory 全空，两个 last* 都为假，于是 roll<60 出撕咬、否则出成长）。
  // ⚠ 两段的连续限制**不同宽**，照抄不要统一：第一段是 `lastTwoMoves(BITE)`（连咬两次才逼成长），
  //   第二段是 `lastMove(GROW)`（刚成长过就必须咬）——与酸液史莱姆中号那条「一段看两回合、
  //   一段只看一回合」同族。
  // ⚠ 这只怪的 `getMoveForRoll` 里**一条 asc 分档都没有**（阈值 60 恒定），所以这就是全部，
  //   不像史莱姆/奴隶主那样还欠一块 asc17。
  fungi_beast: (_bc, m, roll) => {
    if (roll < 60) {
      return lastTwoMoves(m, "fungi_bite") ? "fungi_grow" : "fungi_bite";
    }
    if (lastMove(m, "fungi_grow")) {
      return "fungi_bite";
    }
    return "fungi_grow";
  },

  // —— 地精帮五只（第十七批）——
  //
  // ⚠ 五条**全部不看 roll**（roll 照掷、结果被丢掉），与邪教徒 / 尖刺史莱姆小 / 抢劫者同形。
  //   出招的全部逻辑都在 takeTurn 的 case 尾部，见 `MOVE_TURN_END`。
  // ⚠ 而且这五条**一场仗基本只被调用一次**：狂暴/肥胖地精的收尾是 `NoOpRollMove`
  //   （掷 aiRng 但不改意图）、鬼祟地精与护盾地精与巫师干脆什么都不排——没有一只排
  //   真正的 `RollMove`。所以 `MonsterGroup::init` 那一轮之后它们再也不掷新意图。

  // 狂暴地精：对齐 MonsterSpecific.cpp:2527 MAD_GREMLIN——恒返回抓挠。
  mad_gremlin: () => "scratch",

  // 鬼祟地精：对齐 MonsterSpecific.cpp:2767 SNEAKY_GREMLIN——恒返回穿刺。
  sneaky_gremlin: () => "puncture",

  // 肥胖地精：对齐 MonsterSpecific.cpp:2311 FAT_GREMLIN——恒返回猛击。
  fat_gremlin: () => "smash",

  // 护盾地精：对齐 MonsterSpecific.cpp:2719 SHIELD_GREMLIN——恒返回保护。
  // 「场上只剩自己就改出盾击」不在这里，而在保护那条 case 的尾部
  //（见 `MOVE_TURN_END["shield_gremlin/protect"]`）。
  shield_gremlin: () => "protect",

  // 地精巫师：对齐 MonsterSpecific.cpp:2458-2461 GREMLIN_WIZARD。
  // ⚠ **这是唯一一条会写 `miscInfo` 的出招规则**：参考写的是 `monsterData = 1;`，
  //   而 `monsterData` 是 `Monster::rollMove` 把 `miscInfo` **按引用**传进来的那个副本
  //   （Monster.cpp:629-634：拷出去 → 传引用 → 写回）。所以它等价于「置成员 miscInfo = 1」。
  // ⚠ 这个 1 是蓄力计数的**起点**，直接决定第一次大招来得多早：起点 1 时只蓄 2 回合
  //   （1→2、2→3）就放大招，而大招之后 `miscInfo = 0` 让后续每轮蓄 3 回合。
  //   两段节奏不同是参考（与真实游戏）的原样，不是笔误。
  gremlin_wizard: (_bc, m) => {
    m.miscInfo = 1; // ★ 不消耗 RNG，但改变蓄力计数的起点
    return "charging";
  },

  // —— 第一幕三个精英（第十八批）——

  // 地精头目：对齐 MonsterSpecific.cpp:2424-2455 GREMLIN_NOB。纯 roll 分支，不追加 aiRng。
  // ⚠ 三处照抄：
  //  ① 首回合（`lastMove(MMID::INVALID)`）**必咆哮**，roll 照掷但结果被丢掉；
  //  ② 第二段是 `roll < 33 || lastTwoMoves(RUSH)` —— **一个 `||`**，也就是「连两次猛冲
  //     就必须碎颅」与「掷到低位就碎颅」是同一条分支，不是两层嵌套；
  //  ③ 碎颅击**没有**连续限制（连着掷到 <33 就能连碎），与猛冲不对称。
  // ⚠⚠ asc>=18 是**另一整块**（MonsterSpecific.cpp:2434-2447），第二十二批转写。
  //   参考写的是：
  //       if (!lastTwoMoves(SKULL_BASH))  return RUSH;
  //       if (lastTwoMoves(RUSH))         return SKULL_BASH; else return RUSH;
  //   照这个形状读下来，**碎颅击在 asc>=18 时结构性不可达**：它只在第二段被返回，
  //   而第二段要求 `lastTwoMoves(SKULL_BASH)` 为真，也就是要求它此前已经连出过两次。
  //   于是首招咆哮之后**永远是猛冲**，第二段两个返回值整支是死代码。
  //   ⚠ 这**看着是参考的笔误**（真实游戏的 A18 地精头目会更频繁地碎颅），但与酸液 L 那条
  //   「一个词」不同：要修得先知道正确形状是「第一段返回碎颅」还是别的写法，参考侧没有
  //   任何东西可抄。按 WORKFLOW 第 5 步「参考项目看着像 bug → 不要自己拍板」，
  //   **本批照抄参考、不打补丁**，写进报告与 TODOS「已确认但尚未打补丁」。
  //   关门条件：拿到真实游戏 `GremlinNob.java` 的 ground truth。
  gremlin_nob: (bc, m, roll) => {
    if (firstTurn(m)) {
      return "bellow";
    }
    if (bc.ascension >= 18) {
      // —— START ASCENSION 18（MonsterSpecific.cpp:2434-2447）——
      if (!lastTwoMoves(m, "skull_bash")) {
        return "rush";
      }
      // ⚠ 以下两支恒不可达（见上）。照抄，不要「化简」掉。
      if (lastTwoMoves(m, "rush")) {
        return "skull_bash";
      }
      return "rush";
      // —— END ASCENSION 18 ——
    }
    if (roll < 33 || lastTwoMoves(m, "rush")) {
      return "skull_bash";
    }
    return "rush";
  },

  // 拉加维林：对齐 MonsterSpecific.cpp:2515-2521 LAGAVULIN。
  // ⚠ 参考在这行注了 `// called first turn only`，而且是真的：三条 case 的收尾全是
  //   **同步 setMove** + noOpRollMove，一次都不排真正的 RollMove，所以整场只调用它一次。
  // ⚠ **完全不看 roll**（roll 照掷、结果丢弃），分支只看沉睡位——而沉睡位由**编队**给
  //   （见 `ENCOUNTER_SETUP.lagavulin`）。所以「事件版拉加维林开局就吸魂」是同一段代码
  //   的另一支，只是那个编队不在 harness 的 20 个里。
  lagavulin: (_bc, m) => (getPower(m.powers, "asleep") > 0 ? "sleep" : "siphon_soul"),

  // 哨卫：对齐 MonsterSpecific.cpp:2664-2673 SENTRY。
  // ⚠ **首招不是掷出来的，是按自己在编队里的下标定的**：`idx % 2 == 0` 出射钉、否则出光束
  //   （roll 照掷、结果丢弃）。于是三只哨卫开局固定是 射钉 / 光束 / 射钉——**不是各自独立
  //   随机**，这是 `THREE_SENTRIES` 唯一的特别之处（`MonsterGroup.cpp:431` 那条 case 本身
  //   只是三句 `createMonster`，没有任何特例）。
  // ⚠ `firstTurn()` 之外**没有 else**：参考的 case 直接 `break` 掉出 switch。这不是漏写，
  //   而是「它永远不会被第二次调用」——两条 case 的收尾都是同步 setMove。我们这边照抄成
  //   「非首回合就抛错」，真被调用到要当场知道，而不是静默返回一个瞎猜的招式。
  sentry: (bc, m) => {
    if (!firstTurn(m)) {
      throw new Error("sts-combat: sentry 的 getMoveForRoll 只应在开局被调用一次");
    }
    return bc.monsters.indexOf(m) % 2 === 0 ? "bolt" : "beam";
  },

  // —— 第一幕两个 Boss（第十九批）——

  // 守卫者：对齐 MonsterSpecific.cpp:2961-2964 THE_GUARDIAN——**无条件**返回蓄能，
  // 连 `firstTurn()` 都不判（roll 照掷、结果丢弃）。
  // ⚠ 它整场只被调用一次：七条 case 的收尾全是**同步 setMove**，一次 RollMove 都不排；
  //   形态切换那条也是 `setMove`（在 `MONSTER_ON_HP_LOST` 里），同样不掷 aiRng。
  //   所以这只 240 血、能打十几个回合的 Boss，`rng.ai` 一整场只 +1。
  the_guardian: () => "charging_up",

  // 史莱姆王：对齐 MonsterSpecific.cpp:2724-2733 SLIME_BOSS。
  // ⚠ 与哨卫同形：`if (firstTurn()) return GOOP_SPRAY;` 之后**没有 else**，参考直接
  //   `break` 掉出 switch、落到函数末尾的 `return MMID::INVALID`（:3344）。这不是漏写——
  //   三条 case 的收尾都是同步 setMove、分裂那条压根没有收尾，所以它永远不会被第二次调用。
  //   我们照抄成「非首回合就抛错」，真被调用到要当场知道，而不是静默返回一个瞎猜的招式。
  slime_boss: (_bc, m) => {
    if (!firstTurn(m)) {
      throw new Error("sts-combat: slime_boss 的 getMoveForRoll 只应在开局被调用一次");
    }
    return "goop_spray";
  },

  // —— 第一幕最后一个 Boss（第二十批）——

  // 六火幽魂：对齐 MonsterSpecific.cpp:2464-2470 HEXAGHOST——整条 case 就是
  // `assert(firstTurn()); return HEXAGHOST_ACTIVATE;`，**完全不看 roll**
  //（顶部那次 `aiRng.random(99)` 照掷、结果丢弃）。
  // ⚠ 那句 assert 在 `#ifdef sts_asserts` 里，而构建命令不带任何 `-D`，所以参考实际
  //   编译出来是「无条件返回激活」。我们照 assert 的**意图**写成抛错（同 slime_boss）：
  //   六条 case 的收尾全是同步 setMove / noOpRollMove，一次 RollMove 都不排，
  //   真被第二次调用说明我们哪条收尾抄错了，要当场知道而不是静默返回激活。
  // ⚠ 于是这只 250 血、能打二三十个回合的 Boss，`rng.ai` 一整场只 +（1 + 每回合 1 次
  //   noOpRollMove）——次数是钉死的，抄错当场落在 counter 上。
  hexaghost: (_bc, m) => {
    if (!firstTurn(m)) {
      throw new Error("sts-combat: hexaghost 的 getMoveForRoll 只应在开局被调用一次");
    }
    return "activate";
  },

  // —— 第二幕开张：三只单怪（第二十三批）——
  //
  // ✅ **第三十批补上了选民与食蛇草的 `if (asc17) { … }` 两整块**（第二十三批留的账）。
  //   在此之前它们只写了 asc<17 那一支，理由是 `ascCalibrated` 没置、asc>0 开不了战，
  //   所以那两块走不到也没有预言机；本批第二幕铺了 asc19，两块都有了背书。

  // 球状守卫者：对齐 MonsterSpecific.cpp:2806-2808 SPHERIC_GUARDIAN——**无条件**返回激活，
  // 参考自己在那行注了 `// called first turn only`（roll 照掷、结果丢弃）。
  // ⚠ 与守卫者 / 六火幽魂同形：四条 case 的收尾全是「同步 setMove + 同步 noOpRollMove」，
  //   一次真正的 RollMove 都不排，所以整场只调用它一次。照抄成「第二次被调用就抛错」。
  spheric_guardian: (_bc, m) => {
    if (!firstTurn(m)) {
      throw new Error("sts-combat: spheric_guardian 的 getMoveForRoll 只应在开局被调用一次");
    }
    return "sg_activate";
  },

  // 选民：对齐 MonsterSpecific.cpp:2246-2291 CHOSEN（**两块**，asc17 一块、asc<17 一块）。
  // ⚠ 四处照抄（asc<17 那一段）：
  //  ① 首回合（`firstTurn()`）必**戳刺**，roll 照掷但结果被丢掉；
  //  ② 第二段判的是 `lastMoveBefore(INVALID)`，也就是 `moveHistory[1] == INVALID`
  //     ——「上上步还不存在」＝**这是第二回合**，于是第二招恒为诅咒。⚠ 这是全项目
  //     **第一次**用到 `moveHistory[1] == INVALID` 这个谓词（此前只有 `lastMove` /
  //     `lastTwoMoves`），不能拿 `firstTurn` 或 `lastMove` 顶替；
  //  ③ 「削弱 / 汲取」那一段的门是 `!lastMove(DEBILITATE) && !lastMove(DRAIN)`
  //     ——两条各自的连续限制是 1，而且**互相**也算（上一招是其中任一条就跳过整段）；
  //  ④ 电击的门是 `roll < 40`，戳刺是兜底。两者**都没有**连续限制。
  // ⚠⚠ **asc17 那一块与低档只差两处**（第三十批转写，MonsterSpecific.cpp:2252-2271）——
  //   照抄整块、不要写成「低档 + 一个 if」：
  //  ⑤ 首回合返回的是**诅咒**而不是戳刺（`firstTurn()` → `CHOSEN_HEX`）；
  //  ⑥ **没有那条 `lastMoveBefore(INVALID)` 的第二段**——于是第二回合直接进「削弱 / 汲取」
  //     那一段。可观察面很大：低档的前两招恒是「戳刺 → 诅咒」，asc17 是「诅咒 → 削弱/汲取」。
  //   其余三段（阈值 50 / 40、两条 `lastMove` 的门、兜底戳刺）两块逐字相同。
  chosen: (bc, m, roll) => {
    if (bc.ascension >= 17) {
      if (firstTurn(m)) {
        return "hex";
      }
      if (!lastMove(m, "debilitate") && !lastMove(m, "drain")) {
        return roll < 50 ? "debilitate" : "drain";
      }
      if (roll < 40) {
        return "zap";
      }
      return "poke";
    }
    if (firstTurn(m)) {
      return "poke";
    }
    if (m.moveHistory[1] === undefined) {
      // 对齐 `lastMoveBefore(MMID::INVALID)`：我们的 moveHistory 是「有几步存几步」，
      // 长度 < 2 就等价于上上步是 INVALID。
      return "hex";
    }
    if (!lastMove(m, "debilitate") && !lastMove(m, "drain")) {
      return roll < 50 ? "debilitate" : "drain";
    }
    if (roll < 40) {
      return "zap";
    }
    return "poke";
  },

  // 食蛇草：对齐 MonsterSpecific.cpp:2763-2793 SNAKE_PLANT（**两块**，asc17 一块、asc<17 一块）。
  // ⚠ 三处照抄（asc<17 那一段）：
  //  ① **没有 `firstTurn()` 特例**——开局那次 rollMove 就走 roll 分支（历史全空，
  //     `lastTwoMoves` 恒假，于是 `roll < 65` 必出撕咬、否则必出孢子）；
  //  ② 高位那一支（`roll >= 65`）判的是 **`lastMove`**（连续 1 次），而低位那一支
  //     （`roll < 65`）判的是 **`lastTwoMoves`**（连续 2 次）——两个谓词不一样，
  //     照抄不要统一；
  //  ③ 两支的兜底方向相反：低位兜底撕咬、高位兜底孢子。
  // ⚠⚠ **asc17 那一块只差一处**（第三十批转写）：高位那支的门从 `lastMove(SPORES)` 换成了
  //   **`!lastTwoMoves(SPORES)`**——注意**连谓词的方向都反了**（低档写「刚放过孢子就改撕咬」，
  //   高档写「没连放两次孢子就再放孢子」），所以孢子在 asc17 能连出两次。
  //   两块的低位那一支逐字相同。照抄整块，别写成「低档 + 一个三元」。
  snake_plant: (bc, m, roll) => {
    if (bc.ascension >= 17) {
      if (roll < 65) {
        return lastTwoMoves(m, "sp_chomp") ? "sp_spores" : "sp_chomp";
      }
      return !lastTwoMoves(m, "sp_spores") ? "sp_spores" : "sp_chomp";
    }
    if (roll < 65) {
      return lastTwoMoves(m, "sp_chomp") ? "sp_spores" : "sp_chomp";
    }
    return lastMove(m, "sp_spores") ? "sp_chomp" : "sp_spores";
  },

  // —— 第二十四批 ——

  // 拜鸟：对齐 MonsterSpecific.cpp:2126-2184 BYRD。
  // ⚠ 五处照抄：
  //  ① **每一段都可能追加一次 aiRng**（首回合那支必追加），所以单次 rollMove 消耗 1 或 2 次
  //     ——与颚虫同族，是逐位对齐最易错的地方。四个概率各不相同：
  //     0.375f（首回合）/ 0.4f（连啄两次之后）/ 0.375f（刚俯冲过）/ **0.2857f**（刚啼鸣过）。
  //  ② 首回合那支的 true = **啼鸣**、false = 啄击（`randomBoolean(0.375f) ? CAW : PECK`）；
  //     第三段那支的 true = **啼鸣**、false = 啄击（同向）；
  //     第二段（连啄两次）的 true = **俯冲**、false = 啼鸣；
  //     第四段（刚啼鸣过）的 true = **俯冲**、false = 啄击。四支各写各的，别统一。
  //  ③ 三段的连续限制**不同宽**：啄击看 `lastTwoMoves`（连两次才逼换），
  //     俯冲与啼鸣都只看 `lastMove`（连一次就逼换）。
  //  ④ 阈值是 **50 / 70**（不是 50 / 65 之类），最后一段是兜底。
  //  ⑤ 参考在这条 case 顶部注释掉了一段
  //     `if (!hasStatusInternal<MS::FLIGHT>()) return BYRD_HEADBUTT;`，旁边写着
  //     `// handled during turn`——摔下来改出头槌那件事是在 `attackedUnblockedHelper` 里
  //     做的（见 `monsterDamageUnblocked`），不在这里。**照抄注释掉的形态**，别把它写回来。
  byrd: (bc, m, roll) => {
    if (firstTurn(m)) {
      return bc.rng.aiRng.randomBoolean(Math.fround(0.375)) ? "caw" : "peck"; // ★ 追加一次 aiRng
    }
    if (roll < 50) {
      if (lastTwoMoves(m, "peck")) {
        return bc.rng.aiRng.randomBoolean(Math.fround(0.4)) ? "swoop" : "caw"; // ★ 追加一次 aiRng
      }
      return "peck";
    }
    if (roll < 70) {
      if (lastMove(m, "swoop")) {
        return bc.rng.aiRng.randomBoolean(Math.fround(0.375)) ? "caw" : "peck"; // ★ 追加一次 aiRng
      }
      return "swoop";
    }
    if (lastMove(m, "caw")) {
      return bc.rng.aiRng.randomBoolean(Math.fround(0.2857)) ? "swoop" : "peck"; // ★ 追加一次 aiRng
    }
    return "caw";
  },

  // 劫匪：对齐 MonsterSpecific.cpp:2550-2551 MUGGER——恒返回抢劫，roll 照掷但被丢掉
  // （与抢劫者 / 邪教徒 / 尖刺史莱姆小同形）。
  // ⚠ 参考在这行同样注了 `// called first turn only`：劫匪四条 case 的收尾全是**同步
  //   setMove**（逃跑那条什么都没有），一次 RollMove 都不排，所以整场只调用它一次。
  mugger: () => "mug",

  // —— 第二十五批 ——

  // 带壳寄生虫：对齐 MonsterSpecific.cpp:2694-2736 SHELLED_PARASITE。
  // ⚠ 四处照抄：
  //  ① 首回合分两支：asc17 直接返回重击（**不掷 RNG**），否则
  //     `aiRng.randomBoolean()` ——**无参**版本（= 50/50 的 `nextBoolean`，不是
  //     `randomBoolean(float)`），true 是**双重打击**、false 是吸取。所以 asc0 的首回合
  //     一定**追加一次 aiRng**，asc17 一次都不追加。
  //  ② 连续限制**不同宽**：双重打击与吸取都看 `lastTwoMoves`（连两次才逼换），
  //     重击只看 `lastMove`（连一次就逼换）。
  //  ③ 阈值是 **20 / 60**。
  //  ④⚠⚠ `roll2` 是「重击刚出过就重掷一个 [20,99] 来判 60 那道线」。
  //     **参考原样是坏的，第二十六批给参考打了补丁**（`MonsterSpecific.cpp:2712-2724`）：
  //     它原先写 `int roll2 = 100;` + `if (roll < 60 || roll2 < 60)`，而 `roll < 20` 蕴含
  //     `roll < 60`，于是 `||` 的左边恒真、右边**永远不求值**——那次重掷的**取值**被短路
  //     吃掉，只剩计数器可观察。真实游戏那边是
  //     `num = AbstractDungeon.aiRng.random(20, 99);` 直接**覆盖同一个数**再判；参考里
  //     `roll` 是 `const int` 形参改不了，作者才引入 `roll2`，却漏了把左边那半去掉。
  //     补丁的形状是「`roll2` 初值取 `roll`、后面只判 `roll2`」= 覆盖语义，逐位等价。
  //     裁定过程与三条判据见 TODOS「已修正（参考侧已打补丁）」。
  //     ⚠⚠ 补丁**没有动那次掷骰**（位置与次数一个字没改，它已有 80 例背书），
  //     只改了取值怎么被用。千万别把它「优化」掉：去掉它 `rng.ai` 当场对不上。
  shelled_parasite: (bc, m, roll) => {
    if (firstTurn(m)) {
      if (bc.ascension >= 17) {
        return "fell";
      }
      return bc.rng.aiRng.randomBoolean() ? "double_strike" : "suck"; // ★ 追加一次 aiRng
    }
    let roll2 = roll;
    if (roll < 20) {
      if (!lastMove(m, "fell")) {
        return "fell";
      }
      roll2 = bc.rng.aiRng.random(20, 99); // ★ 追加一次 aiRng（覆盖 roll2，下面只判它）
    }
    if (roll2 < 60) {
      return lastTwoMoves(m, "double_strike") ? "suck" : "double_strike";
    }
    if (!lastTwoMoves(m, "suck")) {
      return "suck";
    }
    return "double_strike";
  },

  // 史尼克：对齐 MonsterSpecific.cpp:2790-2803 SNECKO。**不追加任何 aiRng。**
  // ⚠ 三处照抄：
  //  ① 首回合恒为惑目（施加困惑），没有任何随机；
  //  ② 第二支的条件是 `roll < 40 || lastTwoMoves(SNECKO_BITE)` ——**一个 `||`**，
  //     即「掷到低段」或「撕咬连了两次」都出尾击。写成两个独立的 if 会改语义。
  //  ③ 尾击自己**没有**连续限制（参考没有 `lastTwoMoves(TAIL_WHIP)` 那一支），
  //     所以它理论上能连出很多次。照抄，别按「每招都该有上限」的直觉补。
  snecko: (_bc, m, roll) => {
    if (firstTurn(m)) {
      return "perplexing_glare";
    }
    if (roll < 40 || lastTwoMoves(m, "snecko_bite")) {
      return "tail_whip";
    }
    return "snecko_bite";
  },

  // —— 第二十六批 ——

  // 百夫长：对齐 MonsterSpecific.cpp:2187-2216 CENTURION。**不追加任何 aiRng。**
  // ⚠ 四处照抄：
  //  ① 「秘法师还活着吗」= `bc.monsters.getAliveCount() > 1`，也就是 `monstersAlive`
  //     （MonsterGroup.cpp:36-38），**不是**「数组里活着的个数」，也不是「1 号位那只活着」。
  //     单怪的百夫长编队（参考里没有）会让它恒假，于是防守整招不出场。
  //  ② 它**先算一次、后面用两次**（参考把 `mysticAlive` 声明在 switch case 顶部）：
  //     两个「防守 or 狂怒」的分岔读的是同一个值。当前两处等价，照抄形状。
  //  ③ 阈值是 **65**（`roll >= 65`），而且那一支**同时**要求「斩击之外的两招都没连出两次」
  //     ——`!lastTwoMoves(DEFEND) && !lastTwoMoves(FURY)`，两个都要满足。
  //  ④ 第二支的连续限制只看斩击（`!lastTwoMoves(SLASH)`），落空才走第三支。
  // ⚠⚠ **`!mysticAlive` 那两支（狂怒连斩）曾经是「选择有背书、效果一例都没有」的典型，
  //   第三十一批的目标策略轴关掉了后一半。两件事仍然值得分开看：**
  //   ① **选择**：第二十六批时，狂怒连斩在 375 条 trace 里作为意图出现 **88 次，全部落在
  //      一具已死的百夫长身上**。机制是**荆棘**（遗物轮换里的青铜鳞片）：百夫长斩击玩家
  //      触发的荆棘走 `addToTop`，插在它自己那条**入队的 RollMove 之前**——低血的百夫长
  //      先被荆棘打死，紧接着那次 RollMove 在尸体上执行，`monstersAlive == 1` → 狂怒连斩。
  //      死怪的意图**在快照里**（harness 连死怪一起 dump），所以那时这一支就有 8 例背书。
  //      ✅ 第三十一批把它抬到 **128 例**（`mysticAlive` 恒真）。
  //   ② **效果**（`takeTurn` 的 6×3 与收尾）：第二十六~三十批一直是 **0 例**——死怪永远不会
  //      `takeTurn`，而要让**活着**的百夫长出这一招得让秘法师**先死**。
  //      `CENTURION_AND_HEALER` 是全参考项目**唯一**带百夫长的编队
  //      （`MonsterGroup.cpp:193-196` 是 `MonsterId::CENTURION` 的唯一出处）、百夫长恒在
  //      0 号位，而 harness 的策略当时恒打 `firstAliveMonster` = 0 号位；换牌组也救不回来
  //      （单体伤害只落在百夫长身上、群伤两只平摊，秘法师每次治疗给两只各回 16 而自己血上限
  //      更低）。**关门条件是 harness 的一条新轴：目标策略**，第三十一批交付
  //      （`@tgt1` = 打下标最大的活怪，见 WORKFLOW「目标策略这条轴」）。
  //      ✅ 实测 `centurion_and_healer@tgt1` 里 **119 / 120** 条 trace 是秘法师先死，
  //      狂怒连斩执行 **127 帧 / 97 条**：每击伤害 6→7 红 **91 例**、段数 3→2 红 **96 例**、
  //      收尾 `roll`→`none` 红 **88 例**。
  //      ⚠ **仍然为 0 的只剩它的 asc2 伤害档**——`@tgt1` 只做了 asc0，关门条件是
  //      `asc19 × tgt1` 那个组合（TODOS「四、下一步 ⑤」）。
  //      ⚠ 真实游戏里「先秒奶妈」是标准打法，所以这一支从来就不是边角，只是我们此前量不到。
  // ⚠ 顺带：第二十六批时 `check-coverage.mjs` 把这一招报成「出现 0 / 执行 0」，因为它的
  //   `countMoves` 跳过 `!alive` 的怪（现在「出现」栏已改成连死怪一起数）。覆盖表报 0 时
  //   仍要再去数据里 grep 一遍死怪的意图，见 TODOS。
  centurion: (bc, m, roll) => {
    const mysticAlive = bc.monstersAlive > 1;
    if (roll >= 65 && !lastTwoMoves(m, "cent_defend") && !lastTwoMoves(m, "cent_fury")) {
      return mysticAlive ? "cent_defend" : "cent_fury";
    }
    if (!lastTwoMoves(m, "cent_slash")) {
      return "cent_slash";
    }
    return mysticAlive ? "cent_defend" : "cent_fury";
  },

  // 秘法师：对齐 MonsterSpecific.cpp:2219-2244 MYSTIC。**不追加任何 aiRng。**
  // ⚠⚠ 它是全项目**唯一**一条读生命值的出招规则，五处都要照抄：
  //  ① 缺血阈值是 `asc17 ? 21 : 16`，**与治疗量（asc17 ? 20 : 16）不是同一个数**
  //     ——asc17 下阈值 21 > 治疗量 20。别对齐成一个常量。
  //  ② 判据是 `maxHp - curHp >= healNeedAmt`（**缺了多少**，不是「剩多少」）。
  //  ③ 只看**自己**与**0 号位**两只，写死；而且 `knight` 那半还带 `knight.isAlive()`
  //     ——参考的 `isAlive()` 是 `curHp > 0`（Monster.cpp:237），**不是**
  //     `!isDeadOrEscaped()`。当前两者在这个编队里同解（百夫长不逃跑、不假死），
  //     所以这里照抄成「血 > 0」而不是我们的 `alive` 字段，把差别留在原处。
  //  ④ 短路顺序照抄：`自己缺血 || (knight 活着 && knight 缺血)`——C++ 的 `||` 与 `&&`
  //     都短路，但这里两边都没有副作用，所以顺序不可观察。写成参考的形状即可。
  //  ⑤ 第二支的连续限制**随爬升度变宽**：`asc17 ? !lastMove(ATTACK) : !lastTwoMoves(ATTACK)`
  //     ——高层数只要上一招是法击就不许再来，低层数要连两次才拦。
  // ⚠ 治疗与鼓舞的收尾都是**同步的真 rollMove**（见 `MOVE_TURN_END`），所以这条规则被调用时
  //   治疗**已经生效**了：刚治完的那一回合缺血量已经回落，不会连着强制治疗第二次。
  mystic: (bc, m, roll) => {
    const healNeedAmt = bc.ascension >= 17 ? 21 : 16;
    const knight = bc.monsters[0];
    const knightNeedsHeal =
      knight !== undefined && knight.hp > 0 && knight.maxHp - knight.hp >= healNeedAmt;
    if (m.maxHp - m.hp >= healNeedAmt || knightNeedsHeal) {
      return "mystic_heal";
    }
    const attackBlocked =
      bc.ascension >= 17 ? lastMove(m, "mystic_attack") : lastTwoMoves(m, "mystic_attack");
    if (roll >= 40 && !attackBlocked) {
      return "mystic_attack";
    }
    if (!lastTwoMoves(m, "mystic_buff")) {
      return "mystic_buff";
    }
    return "mystic_attack";
  },

  // —— 第二十七批 ——

  // 地精首领：对齐 MonsterSpecific.cpp:2371-2440 GREMLIN_LEADER。
  //
  // ⚠⚠ 它按**活着的小鬼数**分成三整块，块与块之间阈值与连续限制全都不同，照抄不要合并：
  //   0 只 → 阈值 75，集结/突刺二选一（`roll < 75` 时「刚集结过就突刺、否则集结」）
  //   1 只 → 阈值 50 / 80，**两处追加 aiRng**（见下）
  //  >1 只 → 阈值 66，鼓舞/突刺二选一，**永不集结**（场上满了）
  //
  // ⚠ 「活着的小鬼数」= `Monster::getAliveGremlinCount`（MonsterSpecific.cpp:3612-3620）：
  //   遍历 **0/1/2 三格**（不含首领自己那格 3），门是 `!isDying()` = **血 > 0**。
  //   ⚠ 开局 0 号位是个**从没被构造过**的空格（血 0），所以它天然算「不活」——
  //   我们用 `hp > 0` 而不是 `alive`，把「逃跑 / 假死」那两位的差别留在原处
  //   （小鬼不会逃跑，当前两者同解；判据同 `MOVE_RULES.mystic` 的 `knight.isAlive()`）。
  //
  // ⚠⚠ **「1 只」那块里的两次 `roll2` 是本项目第一处「正确写法」的 roll2。**
  //   第二十六批给带壳寄生虫打的那个补丁的证据链第②条指的就是这里：参考在这里把 `roll2`
  //   声明在**分支内部**、并且**只判 roll2**（`if (roll2 < 80)` / `if (roll2 < 50)`），
  //   没有和原 `roll` 做 `||`。两次的区间还**不一样**：`aiRng.random(50, 99)` 与
  //   `aiRng.random(0, 80)`（**闭区间上界 80，不是 79**）。照抄，别统一。
  gremlin_leader: (bc, m, roll) => {
    // ⚠ 只数 0/1/2 三格，且用「血 > 0」而不是 `alive`（见上）。
    let aliveGremlins = 0;
    for (let i = 0; i < 3; i += 1) {
      if ((bc.monsters[i]?.hp ?? 0) > 0) {
        aliveGremlins += 1;
      }
    }
    if (aliveGremlins === 0) {
      if (roll < 75) {
        return lastMove(m, "rally") ? "gl_stab" : "rally";
      }
      return lastMove(m, "gl_stab") ? "rally" : "gl_stab";
    }
    if (aliveGremlins === 1) {
      if (roll < 50) {
        if (lastMove(m, "rally")) {
          const roll2 = bc.rng.aiRng.random(50, 99); // ★ 追加一次 aiRng
          return roll2 < 80 ? "encourage" : "gl_stab";
        }
        return "rally";
      }
      if (roll < 80) {
        return lastMove(m, "encourage") ? "gl_stab" : "encourage";
      }
      if (lastMove(m, "gl_stab")) {
        const roll2 = bc.rng.aiRng.random(0, 80); // ★ 追加一次 aiRng（⚠ 上界 80，闭区间）
        return roll2 < 50 ? "rally" : "encourage";
      }
      return "gl_stab";
    }
    // >1 只：不再集结。
    if (roll < 66) {
      return lastMove(m, "encourage") ? "gl_stab" : "encourage";
    }
    if (lastMove(m, "gl_stab")) {
      return "encourage";
    }
    return "gl_stab";
  },

  // 工头：对齐 MonsterSpecific.cpp:2887-2890 TASKMASTER——恒返回抽打，roll 照掷但被丢掉
  //（与邪教徒 / 抢劫者 / 劫匪 / 尖刺史莱姆小同形）。
  // ⚠ 与劫匪那条的差别：劫匪的收尾全是**同步 setMove**，所以那条规则整场只跑一次；
  //   工头的收尾是**同步的 `noOpRollMove`**（掷完丢掉、不改意图），所以这条规则也只在
  //   开局的 `MonsterGroup::init` 里跑一次——但两者的 aiRng 消耗次数完全不同，见 MOVE_TURN_END。
  taskmaster: () => "scouring_whip",

  // —— 第二十八批 ——
  //
  // 突刺之书：对齐 MonsterSpecific.cpp:2295-2319 BOOK_OF_STABBING。
  //
  // ⚠⚠ **这条规则会改 `miscInfo`（乱刺的段数），是本项目第三个「出招规则写状态」的例子**
  //   （前两个是地精巫师的蓄力位、带壳寄生虫那次被短路的 roll2）。参考把它绑成了引用：
  //   `auto &stabCount = monsterData;`——而 `monsterData` 就是 `Monster::rollMove` 拷出去
  //   再写回的那份 `miscInfo`（Monster.cpp:629-635）。所以直接改 `m.miscInfo` 等价。
  //   ⚠ 计数**只在发出乱刺的那两支**加一，发重刺的两支不加（asc18 那两句是死代码，见下）。
  //     于是段数 = 「开局的 1」+「此前发过几次乱刺」，整场单调递增、永不清零。
  //
  // ⚠ 三处阈值/门照抄：
  //  ① 唯一的阈值是 `roll < 15`，进门之后**不看 roll**、只看「上一招是不是重刺」：
  //     刚重刺过 → 乱刺（并 +1）；否则 → 重刺。
  //  ② 第二段是 `lastTwoMoves(MULTI_STAB)`（连着两次乱刺）→ 强制重刺。
  //  ③ 兜底是乱刺（并 +1）。所以重刺**只有两条**产生路径，乱刺是常态。
  //
  // ⚠⚠ **参考在这里有两处死代码，本批不转写、也不打补丁**（写进报告）：
  //     `return (MMID::BOOK_OF_STABBING_SINGLE_STAB); if (asc18) { ++stabCount; }`
  //   （`:2304-2307` 与 `:2310-2313`）——`if` 排在 `return` **之后**，永远执行不到。
  //   两条都在「本次发重刺」的支上，即「asc18 时发重刺也算一段」。判据三条都不过：
  //   ① 当前内容集合里 asc>0 压根开不了战（`ascCalibrated` 没置），产生不了分歧；
  //   ② 因此也没有预言机；③ 行为不唯一确定——真实游戏 `BookOfStabbing.getMove` 里**没有**
  //   任何 ascension 相关的 stabCount 自增，所以「补上它」与「删掉它」是两种不同的行为，
  //   参考自己答不了。**照抄参考的实际行为（= 不加）**，如实记进 TODOS 待裁定。
  book_of_stabbing: (_bc, m, roll) => {
    if (roll < 15) {
      if (lastMove(m, "big_stab")) {
        m.miscInfo += 1; // ★ 段数 +1（参考的 `++stabCount`，走引用写回 miscInfo）
        return "multi_stab";
      }
      // ⚠ 参考在这里的 `if (asc18) ++stabCount;` 排在 return 之后 = 死代码，故不转写。
      return "big_stab";
    }
    if (lastTwoMoves(m, "multi_stab")) {
      // ⚠ 同上，这一支的 `if (asc18) ++stabCount;` 也在 return 之后。
      return "big_stab";
    }
    m.miscInfo += 1; // ★ 段数 +1
    return "multi_stab";
  },

  // 青铜自动机：对齐 MonsterSpecific.cpp:2101-2104 BRONZE_AUTOMATON——**无条件**返回召唤，
  // roll 照掷、结果丢弃。
  // ⚠ 与球状守卫者 / 六火幽魂 / 守卫者同形：五条 case 的收尾全是「同步 setMove + 同步
  //   noOpRollMove」，一次真正的 RollMove 都不排，所以整场只调用它一次。
  //   照抄成「第二次被调用就抛错」——真被第二次调用说明我们哪条收尾抄错了。
  bronze_automaton: (_bc, m) => {
    if (!firstTurn(m)) {
      throw new Error("sts-combat: bronze_automaton 的 getMoveForRoll 只应在开局被调用一次");
    }
    return "spawn_orbs";
  },

  // 青铜球：对齐 MonsterSpecific.cpp:2106-2124 BRONZE_ORB。**不追加任何 aiRng。**
  // ⚠ 四处照抄：
  //  ① 第一支的门是 `!haveUsedStasis && roll >= 25`，其中 `haveUsedStasis` 读的是
  //     **`miscInfo`**（不是那个引用形参，参考写的是裸的成员）。它由停滞那条 case 的收尾
  //     `miscInfo = 1` 置上，所以**一颗球整场只放一次停滞**。
  //     ⚠ 阈值方向是 `>=`：召唤出来时那次 rollMove 有 75% 概率直接出停滞。
  //  ② 第二支 `roll >= 70 && !lastTwoMoves(SUPPORT_BEAM)` → 支援光束；
  //  ③ 第三支 `!lastTwoMoves(BEAM)` → 光束；
  //  ④ 兜底又是支援光束——**所以支援光束能连出三次以上**（第二支被连续限制挡住时，
  //     若光束也连了两次就落到兜底）。照抄，别按「每招都该有上限」的直觉补。
  bronze_orb: (_bc, m, roll) => {
    const haveUsedStasis = m.miscInfo;
    if (!haveUsedStasis && roll >= 25) {
      return "stasis";
    }
    if (roll >= 70 && !lastTwoMoves(m, "orb_support")) {
      return "orb_support";
    }
    if (!lastTwoMoves(m, "orb_beam")) {
      return "orb_beam";
    }
    return "orb_support";
  },

  // —— 第二十九批 ——
  //
  // 冠军：对齐 MonsterSpecific.cpp:2892-2946 THE_CHAMP。
  //
  // ⚠⚠ **二阶段是「血量阈值锁存」，而且整条住在这里、不在 `Monster::onHpLost`。**
  //   `Monster::onHpLost` 那个 switch（Monster.cpp:499-535）**压根没有 `THE_CHAMP` 这一格**
  //   ——它只有三种大史莱姆的分裂与守卫者的模式切换。差别是可观察的：守卫者在**挨打那一
  //   瞬间**就改意图，冠军要等到**下一次 rollMove**（也就是它自己回合的收尾）才发现自己
  //   过了半血。所以我们这边也**不能**给它写 `MONSTER_ON_HP_LOST` 条目。
  //
  // ⚠⚠ **`miscInfo` 一个字段两种用途**（参考 Monster.h:73 那行注释就叫 `champ phase2`）：
  //     bit 0~1（`miscInfo & 0x3`）= 防御姿态的**已用次数**，上限 2；
  //     bit 2  （`miscInfo & 0x4`）= 二阶段标志。
  //   出防御姿态时是 `++monsterData`（整数自增），因为次数被 `< 2` 卡住，
  //   它永远进不到 bit 2——照抄这个「自增而不是按位或」的写法。
  //
  // ⚠ 参考在这里同时读**成员** `miscInfo`（次数那一处）与**引用形参** `monsterData`
  //   （二阶段判定与两处写入）。`Monster::rollMove` 是「拷出去 → 传引用 → 写回」
  //   （Monster.cpp:629-635），所以进函数那一刻两者相等；而写完 `monsterData` 的两支
  //   都**立刻 return**，中间没有再读次数的机会——于是当前两者等价，我们统一读写
  //   `m.miscInfo`。（同族的先例是红奴隶主那条，第十六批已核过。）
  //
  // ⚠ 分支顺序照抄，三段：
  //  ① **二阶段块**：已在二阶段 → 「最近两格都不是处决」就出处决；否则**穿透**到下面。
  //     ⚠ 判据是 `!lastMove(EXECUTE) && !lastMoveBefore(EXECUTE)`（不是 `!lastTwoMoves`）
  //       ——`lastTwoMoves` 只在两格**都**是处决时为真，会让处决连出，与参考不同。
  //  ② **一阶段块**：`curHp < maxHp / 2`（C++ 整除；⚠ 是 **<** 而不是守卫者那种 `<=`）
  //     → 置 bit 2 并出**暴怒**；否则 `(getMonsterTurnNumber() + 1) % 4 == 0` → **嘲讽**。
  //     两支都 return，其余穿透。
  //  ③ **公共块**（两个阶段都会落进来）：防御姿态 → 自夸 → 扇脸 → 重斩 → 兜底扇脸。
  //     ⚠ 防御姿态的 roll 阈值有 asc 分档（`asc19 ? 30 : 15`），另两个（30 / 55）没有。
  //     ⚠ 自夸那支的门里有**两个** `lastMove`（自夸 / 防御姿态），照抄别少一个。
  champ: (bc, m, roll) => {
    // ① 二阶段：处决优先，穿透到公共块。
    if (m.miscInfo & 0x4) {
      if (!lastMove(m, "execute") && !lastMoveBefore(m, "execute")) {
        return "execute";
      }
    } else {
      // ② 一阶段：过半血锁存 → 暴怒；否则每四个怪物回合嘲讽一次。
      if (m.hp < Math.trunc(m.maxHp / 2)) {
        m.miscInfo |= 0x4; // ★ 二阶段标志（一次性，此后再也回不去）
        return "anger";
      } else if ((getMonsterTurnNumber(bc) + 1) % 4 === 0) {
        return "taunt";
      }
    }
    // ③ 公共块。
    const defensiveStanceUseCount = m.miscInfo & 0x3;
    const rollThreshold = bc.ascension >= 19 ? 30 : 15;
    if (roll <= rollThreshold && !lastMove(m, "champ_defend") && defensiveStanceUseCount < 2) {
      m.miscInfo += 1; // ★ 已用次数 +1（参考写的是 `++monsterData`，不是按位或）
      return "champ_defend";
    }
    if (roll <= 30 && !lastMove(m, "gloat") && !lastMove(m, "champ_defend")) {
      return "gloat";
    } else if (roll <= 55 && !lastMove(m, "face_slap")) {
      return "face_slap";
    } else if (!lastMove(m, "champ_slash")) {
      return "champ_slash";
    }
    return "face_slap";
  },

  // 收藏家：对齐 MonsterSpecific.cpp:2948-2986 THE_COLLECTOR。
  //
  // ⚠ 五处照抄：
  //  ① 首回合**恒召唤**（`firstTurn()`），roll 照掷但结果被丢掉；
  //  ② `bc.getMonsterTurnNumber() == 3` **恒出巨型削弱**（参考注的是 `// always uses mega
  //     debuff turn 4`——注释与代码差一，因为 `getMonsterTurnNumber()` 是 `turn + 1`，
  //     它说的是游戏里显示的第 4 回合。**照抄代码那个 3**）；
  //  ③⚠⚠ **`canUseSpawn` 读的是 `bc.monsters.monstersAlive < 3`**，再 `&& !lastMove(SPAWN)`
  //     ——这是「预留空位不算活怪」的第二个读点（第一个是 `SpawnTorchHeads` 的
  //     `3 - monstersAlive`）。抄成「数组长度」会让它开局就以为满员、再也不召；
  //  ④ `roll <= 25 && canUseSpawn` → 召唤；`roll <= 70 && !lastTwoMoves(FIREBALL)` → 火球；
  //  ⑤ 兜底二选一：**刚增幅过就火球，否则增幅**（`lastMove(BUFF) ? FIREBALL : BUFF`）。
  //     ⚠ 于是「火球」有**两条**产生路径，而巨型削弱只在第 3 个怪物回合出现一次。
  the_collector: (bc, m, roll) => {
    // ① 首回合恒召唤。
    if (firstTurn(m)) {
      return "spawn_torches";
    }
    // ② 第 3 个怪物回合恒出巨型削弱。
    if (getMonsterTurnNumber(bc) === 3) {
      return "mega_debuff";
    }
    // ③ 「还能不能召」——读 monstersAlive，不是数组长度。
    const canUseSpawn = bc.monstersAlive < 3 && !lastMove(m, "spawn_torches");
    if (roll <= 25 && canUseSpawn) {
      return "spawn_torches";
    }
    if (roll <= 70 && !lastTwoMoves(m, "fireball")) {
      return "fireball";
    }
    // ⑤ 兜底。
    if (lastMove(m, "collector_buff")) {
      return "fireball";
    }
    return "collector_buff";
  },

  // 火炬头：⚠⚠ **它的 `getMoveForRoll` 永远不该被调用。**
  // 参考对 `TORCH_HEAD` 的处理是落在 `default` 上、返回 `MMID::INVALID`
  //（MonsterSpecific.cpp:3364，那行注着 `// setting in collector spawn move`）：
  //   * 意图由 `Actions::SpawnTorchHeads` 的 `setMove(TORCH_HEAD_TACKLE)` 写入；
  //   * 冲撞那条 case **没有任何收尾语句**（`MOVE_TURN_END` 记作 `"none"`），所以既不排
  //     `RollMove` 也不 `noOpRollMove`；
  //   * 它不在任何建怪列表里，故 `MonsterGroup::init` 那次开局 rollMove 也轮不到它。
  // 于是照抄成「被调用就抛错」——真被调用说明我们哪条收尾抄错了，而那种错在参考侧是
  // 一个 `INVALID` 意图（release 版静默），在我们这边应该当场炸出来。
  torch_head: () => {
    throw new Error(
      "sts-combat: torch_head 的 getMoveForRoll 永远不该被调用（参考返回 INVALID，意图只由 setMove 写入）",
    );
  },

  // —— 第三幕开张（第三十二批）：三只「形状怪」——

  // 爆破怪：整条规则就是 `return EXPLODER_SLAM;`（MonsterSpecific.cpp:3012-3015，
  // 参考在里面注了 `// first turn only`）。**roll 照掷一次却完全不看**——与酸液史莱姆小
  // 那种「不看 roll 但追加一次 randomBoolean」不同，这条一次都不追加。
  // ⚠ 它之所以只在「首回合」有意义：撞击那条 case 的收尾是**同步 setMove + 同步 noOpRollMove**
  //   （见 `MOVE_TURN_END`），意图链因此完全钉死（撞击 → 撞击 → 自爆），
  //   开局那次 `MonsterGroup::init` 的 rollMove 之后这条规则再也不会决定任何东西。
  exploder: () => "exp_slam",

  // 斥力怪：对齐 MonsterSpecific.cpp:3017-3023。
  //     if (roll < 20 && !lastMove(REPULSOR_BASH)) return BASH; else return REPULSE;
  // ⚠ 不追加 aiRng（一次 rollMove 恒消耗 1 次）。
  // ⚠ 门是 `!lastMove(BASH)`（只看上一格），不是 `!lastTwoMoves`——所以撞击**不会连出**。
  repulsor: (_bc, m, roll) => {
    if (roll < 20 && !lastMove(m, "rep_bash")) {
      return "rep_bash";
    }
    return "repulse";
  },

  // 尖刺客：对齐 MonsterSpecific.cpp:3026-3032。
  //     if (miscInfo > 5 || roll < 50 && !lastMove(SPIKER_CUT)) return CUT; else return SPIKE;
  // ⚠⚠ **C++ 的运算符优先级**：`&&` 紧于 `||`，所以真正的形状是
  //     `(miscInfo > 5) || ((roll < 50) && !lastMove(CUT))`
  //   ——括号写错（`(miscInfo > 5 || roll < 50) && !lastMove(CUT)`）会让攒满尖刺之后
  //   连续切割那一支消失。
  // ⚠ `miscInfo` 在这只怪身上是**「已经放过几次增生尖刺」**（参考在那行注了
  //   `// times used thorns > 5`，`MOVE_TURN_BEGIN` 里 `++`）。攒到 6 次之后它**只切割**，
  //   荆棘就此封顶在 `3 + 2*6 = 15`（asc0）。这是 `miscInfo` 的第九种含义。
  // ⚠ 它读的是**成员** `miscInfo` 而不是 `rollMove` 传进来的那个引用参数
  //   （`Monster::rollMove` 拷出去、传引用、原样写回，这条规则自己不改它，故两者等价）
  //   ——与红奴隶主那条同族，照抄即可。
  spiker: (_bc, m, roll) => {
    if (m.miscInfo > 5 || (roll < 50 && !lastMove(m, "spk_cut"))) {
      return "spk_cut";
    }
    return "spk_spike";
  },

  // —— 第三十三批：三只第三幕单怪 ——

  // 暗球游荡者：对齐 MonsterSpecific.cpp:2609-2620。
  //     if (roll < 40) {
  //         if (!lastTwoMoves(CLAW)) return CLAW; else return LASER;
  //     } else if (!lastTwoMoves(LASER)) {
  //         return LASER;
  //     } else {
  //         return CLAW;
  //     }
  // ⚠ 两道门都是 **`lastTwoMoves`**（连出两次才封），不是 `lastMove`——两招各自都能连出两次。
  // ⚠ 不追加 aiRng（一次 rollMove 恒消耗 1 次）。
  // ⚠ 分界是 **40**（低位出利爪、高位出激光），与「50/50」那种直觉相反：利爪的窗口更窄。
  orb_walker: (_bc, m, roll) => {
    if (roll < 40) {
      return lastTwoMoves(m, "ow_claw") ? "ow_laser" : "ow_claw";
    }
    return lastTwoMoves(m, "ow_laser") ? "ow_claw" : "ow_laser";
  },

  // 尖塔增生：对齐 MonsterSpecific.cpp:3097-3113。
  //     const auto useConstrict = !bc.player.hasStatus<PS::CONSTRICTED>()
  //                               && !lastMove(SPIRE_GROWTH_CONSTRICT)
  //                               && (asc17 || roll >= 50);
  //     if (useConstrict) return CONSTRICT;
  //     else if (roll < 50 && !lastTwoMoves(QUICK_TACKLE)) return QUICK_TACKLE;
  //     else if (!lastTwoMoves(SMASH)) return SMASH;
  //     else return QUICK_TACKLE;
  // ⚠ 四处照抄：
  //  ① 第一道门读的是**玩家**身上的束缚，而束缚**永不递减、永不摘除**（见 PowerId 那条）
  //     ——所以缠绕一场仗最多出一次。这与「连续限制」是两回事，两个条件同时挂在那里。
  //  ② `asc17 || roll >= 50`：高层数时**不看 roll**，缠绕的窗口从一半变成全部。
  //     当前 trace 全是 asc0，那一支走不到但照抄。
  //  ③ 后两道门是 `lastTwoMoves`，而第一道是 `lastMove`——**三道门两种谓词**，别统一。
  //  ④ 兜底是急冲（不是重砸）。
  spire_growth: (bc, m, roll) => {
    const useConstrict =
      !hasPower(bc.player.powers, "constricted") &&
      !lastMove(m, "sg_constrict") &&
      (bc.ascension >= 17 || roll >= 50);
    if (useConstrict) {
      return "sg_constrict";
    }
    if (roll < 50 && !lastTwoMoves(m, "sg_quick_tackle")) {
      return "sg_quick_tackle";
    }
    if (!lastTwoMoves(m, "sg_smash")) {
      return "sg_smash";
    }
    return "sg_quick_tackle";
  },

  // 大嘴：对齐 MonsterSpecific.cpp:3035-3050。
  //     if (firstTurn()) return ROAR;
  //     else if (roll < 50 && !lastMove(NOM)) return NOM;
  //     else if (!lastMove(SLAM)) return SLAM;   // 参考在这里注了
  //     else return DROOL;                       // "dont include not last move nom condition,
  //                                              //  because it can't be, we handle in the move logic"
  // ⚠ 三处照抄：
  //  ① 三道门全是 **`lastMove`**（只看上一格），一个 `lastTwoMoves` 都没有——与暗球游荡者
  //     和尖塔增生都不同，别照搬邻居。
  //  ② 流涎只在「roll >= 50（或刚吞噬过）且刚重击过」时才由**这条规则**滚出来；
  //     另一条更常走的路是吞噬的收尾 `setMove(THE_MAW_DROOL)`（见 `MOVE_TURN_END`）
  //     ——参考那句注释说的就是这件事：吞噬之后意图已被写死成流涎，所以这里的第二道门
  //     不必再排除「刚吞噬过」。
  //  ③ 首回合恒咆哮，`roll` 照掷但不看。
  the_maw: (_bc, m, roll) => {
    if (firstTurn(m)) {
      return "maw_roar";
    }
    if (roll < 50 && !lastMove(m, "maw_nom")) {
      return "maw_nom";
    }
    if (!lastMove(m, "maw_slam")) {
      return "maw_slam";
    }
    return "maw_drool";
  },

  // 暗影客：对齐 MonsterSpecific.cpp:3052-3093。
  //     auto myRoll = roll;
  //     if (firstTurn()) { if (myRoll < 50) return HARDEN; else return NIP; }
  //     if (halfDead) return REINCARNATE;
  //     if (myRoll < 40) {
  //         if (!lastMove(CHOMP) && idx != 1) return CHOMP;
  //         else myRoll = bc.aiRng.random(40, 99);              // ★ 追加一次 aiRng
  //     }
  //     if (myRoll < 70) { if (!lastMove(HARDEN)) return HARDEN; else return NIP; }
  //     if (!lastTwoMoves(NIP)) return NIP;
  //     else return getMoveForRoll(bc, monsterData, bc.aiRng.random(0, 99));  // ★ 递归 + aiRng
  // ⚠ 六处照抄，一处都不能省：
  //  ①⚠⚠ **`idx != 1`**：**1 号位（中间那只）永远不啃食**。这是全参考项目唯一一条
  //     「出招规则读自己在队列里的下标」的门——它让三只暗影客的行为**不对称**。
  //     写成「三只一样」不会报错，只会让中间那只多出啃食、少出别的。
  //  ②⚠⚠ **`myRoll = aiRng.random(40, 99)` 是一次真的重掷**（40 + nextInt(60)），
  //     不是「把 roll 钳到 40」。它只在「roll < 40 但啃食被封住」时发生，
  //     所以单次 rollMove 的 aiRng 消耗是 **1 或 2**（还可能因为下面那条递归更多）。
  //  ③⚠⚠ **最后那一支是递归**：`getMoveForRoll(bc, monsterData, aiRng.random(0, 99))`
  //     ——重新从头跑一遍（含 `firstTurn` / `halfDead` 两道门，此刻都为假），
  //     每递归一层再掷一次 aiRng。`random(0, 99)` 与顶层的 `random(99)` 逐位等价
  //     （`0 + nextInt(100)` vs `nextInt(100)`）。⚠ 它必然终止：连出两次撕咬时
  //     `lastMove(HARDEN)` 必假，所以只要重掷到 < 70 就落进硬化那一支。
  //  ④ 首回合那道门用的是 **`myRoll < 50`**（不是 40），且**没有** halfDead 判断
  //     ——顺序是「先首回合、再半死」，反过来会让首回合的半死怪（不可能出现）走错。
  //  ⑤ 三道连续限制**两种谓词并存**：啃食与硬化是 `lastMove`（连一次就封），
  //     撕咬是 `lastTwoMoves`（连两次才封）。照搬邻居必错。
  //  ⑥ **半死那道门排在首回合之后、一切 roll 分支之前**，所以半死的暗影客下一招恒是复活。
  darkling: (bc, m, roll) => {
    let myRoll = roll;
    if (firstTurn(m)) {
      return myRoll < 50 ? "darkling_harden" : "darkling_nip";
    }
    if (m.halfDead) {
      return "darkling_reincarnate";
    }
    if (myRoll < 40) {
      if (!lastMove(m, "darkling_chomp") && bc.monsters.indexOf(m) !== 1) {
        return "darkling_chomp";
      }
      myRoll = bc.rng.aiRng.random(40, 99); // ★ 追加一次 aiRng（重掷，不是钳制）
    }
    if (myRoll < 70) {
      return lastMove(m, "darkling_harden") ? "darkling_nip" : "darkling_harden";
    }
    if (!lastTwoMoves(m, "darkling_nip")) {
      return "darkling_nip";
    }
    // ★ 追加一次 aiRng，然后**整条规则重跑**（对齐参考的递归调用）
    return MOVE_RULES["darkling"](bc, m, bc.rng.aiRng.random(99));
  },

  // 复形怪：对齐 MonsterSpecific.cpp:3115-3117 —— `return (MMID::TRANSIENT_ATTACK);`。
  // 只有一招，`roll` 照掷（`rollMove` 顶部那一次）但**一眼都不看**。
  // ⚠ 这条规则**只在开局那次 `MonsterGroup::init` 的 rollMove 里被调到一次**：此后每个
  //   怪物回合的收尾是**同步**的 `bc.noOpRollMove()`（掷一次 aiRng 就丢，意图与
  //   moveHistory 都不动），从不再走 `rollMove`。见 `MOVE_TURN_END`。
  transient: () => "transient_slam",

  // —— 第三十五批：蠕动血块与巨头 ——

  // 蠕动血块：对齐 MonsterSpecific.cpp:3119-3202。参考的形状是一个 **`while (true)` 循环 +
  // 一串并列的（不是 else-if 的）`if`**，每个 if 要么 return、要么把 `myRoll` **重掷**到
  // 下一段区间然后**落到下一个 if**：
  //
  //     if (firstTurn()) { <33 乱抽 / <66 挥击 / 否则 萎缩 }
  //     const bool haveUsedImplant = miscInfo;
  //     auto myRoll = roll;
  //     while (true) {
  //       if (myRoll < 10) { if (!lastMove(重抽)) return 重抽; myRoll = aiRng.random(10, 99); }
  //       if (myRoll < 20) { if (!haveUsedImplant && !lastMove(植入)) return 植入;
  //                          else if (aiRng.randomBoolean(0.1f)) return 重抽;
  //                          myRoll = aiRng.random(20, 99); }
  //       if (myRoll < 40) { if (!lastMove(萎缩)) return 萎缩;
  //                          if (aiRng.randomBoolean(0.4f)) {
  //                            myRoll = aiRng.random(0, 19);
  //                            if (myRoll < 10) return 重抽;
  //                            if (!haveUsedImplant) return 植入;
  //                            if (aiRng.randomBoolean(0.1f)) return 重抽;
  //                            myRoll = aiRng.random(20, 99); continue; }
  //                          myRoll = aiRng.random(40, 99); }
  //       if (myRoll < 70) { if (!lastMove(乱抽)) return 乱抽;
  //                          else if (aiRng.randomBoolean(0.3f)) return 挥击;
  //                          else { myRoll = aiRng.random(0, 39); continue; } }
  //       if (!lastMove(挥击)) return 挥击; else return 萎缩;
  //     }
  //
  // ⚠ 八处照抄，一处都不能省：
  //  ①⚠⚠ **那些 `if` 是并列的、不是 else-if**：重掷之后**接着往下判**同一轮里的下一段。
  //     写成 else-if / switch 会让「重掷到 25 之后落进 `< 40` 那一段」这条路整个消失。
  //  ②⚠⚠ 每一次 `myRoll = aiRng.random(a, b)` 都是**真的重掷**（`a + nextInt(b-a+1)`），
  //     不是把 roll 钳到 a。所以单次 rollMove 的 aiRng 消耗是 **1 到很多次**。
  //  ③ 三个 `randomBoolean` 的概率各不相同（0.1 / 0.4 / 0.3），而且 0.1 那个出现**两次**
  //     （`< 20` 段一次、`< 40` 段的内层一次）——是两处独立的字面量。
  //  ④ **`continue` 与「落到下一个 if」不是一回事**：`continue` 回到 `myRoll < 10` 重头判，
  //     所以 `< 70` 段那次 `random(0, 39)` 之后真的可能再出重抽 / 植入 / 萎缩。
  //  ⑤ `haveUsedImplant` 在**进循环之前**读一次就定了（`const`），循环里不再刷新——
  //     当前无差别（循环内不改 miscInfo），照抄形状。
  //  ⑥ 首回合三分（33 / 66）用的是**顶层那次 roll**，且首回合**不看**植入标志。
  //  ⑦ `< 40` 段内层的 `random(0, 19)` 之后判的是 `myRoll < 10`（**10 而不是 20**），
  //     另一半才轮到植入。
  //  ⑧ 兜底（`myRoll >= 70`）是「没连挥击就挥击、否则萎缩」，不是「恒挥击」。
  // ⚠ 它必然终止：`< 70` 段的 `continue` 要求刚出过乱抽，而重抽 / 植入 / 萎缩 / 挥击
  //   任何一条命中都直接 return。
  writhing_mass: (bc, m, roll) => {
    if (firstTurn(m)) {
      if (roll < 33) {
        return "wm_multi_strike";
      }
      if (roll < 66) {
        return "wm_flail";
      }
      return "wm_wither";
    }
    const haveUsedImplant = m.miscInfo !== 0;
    let myRoll = roll;
    for (;;) {
      if (myRoll < 10) {
        if (!lastMove(m, "wm_strong_strike")) {
          return "wm_strong_strike";
        }
        myRoll = bc.rng.aiRng.random(10, 99); // ★ 追加一次 aiRng（重掷，不是钳制）
      }
      if (myRoll < 20) {
        if (!haveUsedImplant && !lastMove(m, "wm_implant")) {
          return "wm_implant";
        } else if (bc.rng.aiRng.randomBoolean(Math.fround(0.1))) {
          // ★ 追加一次 aiRng
          return "wm_strong_strike";
        }
        myRoll = bc.rng.aiRng.random(20, 99); // ★ 追加一次 aiRng
      }
      if (myRoll < 40) {
        if (!lastMove(m, "wm_wither")) {
          return "wm_wither";
        }
        // 刚萎缩过
        if (bc.rng.aiRng.randomBoolean(Math.fround(0.4))) {
          // ★ 追加一次 aiRng
          myRoll = bc.rng.aiRng.random(0, 19); // ★ 追加一次 aiRng
          if (myRoll < 10) {
            return "wm_strong_strike";
          } else if (!haveUsedImplant) {
            return "wm_implant";
          } else if (bc.rng.aiRng.randomBoolean(Math.fround(0.1))) {
            // ★ 追加一次 aiRng
            return "wm_strong_strike";
          } else {
            myRoll = bc.rng.aiRng.random(20, 99); // ★ 追加一次 aiRng
            continue;
          }
        }
        myRoll = bc.rng.aiRng.random(40, 99); // ★ 追加一次 aiRng
      }
      if (myRoll < 70) {
        if (!lastMove(m, "wm_multi_strike")) {
          return "wm_multi_strike";
        } else if (bc.rng.aiRng.randomBoolean(Math.fround(0.3))) {
          // ★ 追加一次 aiRng
          return "wm_flail";
        } else {
          myRoll = bc.rng.aiRng.random(0, 39); // ★ 追加一次 aiRng
          continue;
        }
      }
      if (!lastMove(m, "wm_flail")) {
        return "wm_flail";
      }
      return "wm_wither";
    }
  },

  // 巨头：对齐 MonsterSpecific.cpp:3207-3229。
  //     if (bc.getMonsterTurnNumber() >= 4) return IT_IS_TIME;
  //     if (roll < 50) { if (!lastTwoMoves(GLARE)) return GLARE; else return COUNT; }
  //     if (!lastTwoMoves(COUNT)) return COUNT; else return GLARE;
  // ⚠ 四处照抄：
  //  ①⚠⚠ **第一道门读的是全局怪物回合数**（`bc.turn + 1`），不是这只怪自己的历史——
  //     一旦到了第 4 个怪物回合，此后**每一次** rollMove 都返回「时候到了」。
  //     配合那条 case 的收尾（同步 `noOpRollMove`，**不改意图**），它其实只会被走到一次。
  //  ② 两道连续限制都是 `lastTwoMoves`（连出两次才封），不是 `lastMove`。
  //  ③ 分界恰好 50，两侧对称（低位偏凝视、高位偏数数）。
  //  ④ 首回合**没有**特判：`moveHistory` 为空时两个 `lastTwoMoves` 都为假，
  //     于是 roll < 50 出凝视、否则出数数。
  giant_head: (bc, m, roll) => {
    if (getMonsterTurnNumber(bc) >= 4) {
      return "gh_it_is_time";
    }
    if (roll < 50) {
      return lastTwoMoves(m, "gh_glare") ? "gh_count" : "gh_glare";
    }
    return lastTwoMoves(m, "gh_count") ? "gh_glare" : "gh_count";
  },

  // —— 第三十六批：第三幕两个精英 ——

  // 复仇魔：对齐 MonsterSpecific.cpp:2554-2607。逐位照抄，**别按「三档 roll」的直觉简化**：
  //
  //     if (firstTurn())  return roll < 50 ? ATTACK : DEBUFF;
  //     if (roll < 30) {                                   // 巨镰档
  //         if (!eitherLastTwo(SCYTHE))       return SCYTHE;
  //         else if (aiRng.randomBoolean())   return lastTwoMoves(ATTACK) ? DEBUFF : ATTACK;
  //         else if (!lastMove(DEBUFF))       return DEBUFF;
  //         else                              return ATTACK;
  //     }
  //     if (roll < 65) {                                   // 多重打击档
  //         if (!lastTwoMoves(ATTACK))                          return ATTACK;
  //         else if (!aiRng.randomBoolean() || eitherLastTwo(SCYTHE)) return DEBUFF;
  //         else                                                return SCYTHE;
  //     }
  //     if (!lastMove(DEBUFF)) return DEBUFF;              // 灼烧诅咒档
  //     if (aiRng.randomBoolean() && !eitherLastTwo(SCYTHE)) return SCYTHE;
  //     return ATTACK;
  //
  // ⚠ 六处照抄：
  //  ① **首回合只看 roll < 50**（没有任何连续限制），分界与后面两档的 30 / 65 完全无关。
  //  ② 巨镰的连续限制是 **`eitherLastTwo`**（最近两格里出现过就不再出），不是 `lastTwoMoves`
  //     ——它是这两个谓词第一次在本项目里分家，抄成 `lastTwoMoves` 会让巨镰隔一回合就连出。
  //  ③ 多重打击的连续限制却是 **`lastTwoMoves`**（连出两次才封）。同一只怪上两种并存。
  //  ④⚠⚠ **三处 `randomBoolean` 的极性各不相同**：巨镰档是 `if (randomBoolean())` 走
  //     「打击族」，多重打击档是 **`if (!randomBoolean() || …)`** 走灼烧，最后一档是
  //     `if (randomBoolean() && …)` 走巨镰。抄反任何一处都只在一半种子上分岔。
  //  ⑤ **那几次 `randomBoolean` 是短路求值的**：多重打击档写的是 `!randomBoolean() || eitherLastTwo(SCYTHE)`
  //     ——`randomBoolean` 在**左边**，所以**无论右边是什么都会掷**；最后一档写的是
  //     `randomBoolean() && !eitherLastTwo(SCYTHE)`，同样掷在左边。两处都必须先掷再判，
  //     顺序写反会让 `rng.ai` 计数器在「刚出过巨镰」的那些回合对不上。
  //  ⑥ 三档的 roll 分界是 **30 / 65**（不是 33 / 66），三档宽度 30 / 35 / 35。
  nemesis: (bc, m, roll) => {
    if (firstTurn(m)) {
      return roll < 50 ? "nem_attack" : "nem_debuff";
    }
    if (roll < 30) {
      if (!eitherLastTwo(m, "nem_scythe")) {
        return "nem_scythe";
      } else if (bc.rng.aiRng.randomBoolean()) {
        // ★ 追加一次 aiRng
        return lastTwoMoves(m, "nem_attack") ? "nem_debuff" : "nem_attack";
      } else if (!lastMove(m, "nem_debuff")) {
        return "nem_debuff";
      } else {
        return "nem_attack";
      }
    }
    if (roll < 65) {
      if (!lastTwoMoves(m, "nem_attack")) {
        return "nem_attack";
      }
      // ⚠ `randomBoolean` 在 `||` 的**左边**，所以这一掷无条件发生。
      if (!bc.rng.aiRng.randomBoolean() || eitherLastTwo(m, "nem_scythe")) {
        // ★ 追加一次 aiRng
        return "nem_debuff";
      }
      return "nem_scythe";
    }
    if (!lastMove(m, "nem_debuff")) {
      return "nem_debuff";
    }
    // ⚠ 同上：`randomBoolean` 在 `&&` 的**左边**，无条件掷。
    if (bc.rng.aiRng.randomBoolean() && !eitherLastTwo(m, "nem_scythe")) {
      // ★ 追加一次 aiRng
      return "nem_scythe";
    }
    return "nem_attack";
  },

  // 蜥蜴法师：对齐 MonsterSpecific.cpp:2641-2677。
  //
  //     if (firstTurn()) return SUMMON;
  //     int myRoll = roll;
  //     const bool canSpawn = bc.monsters.monstersAlive < 4;   // ← 循环**之前**算一次
  //     while (true) {
  //         if (myRoll < 33) {
  //             if (!lastMove(SNAKE_STRIKE)) return SNAKE_STRIKE;
  //             else myRoll = aiRng.random(33, 99);            // ★ 重掷，然后**继续往下**
  //         }
  //         if (myRoll < 66) {
  //             if (!lastTwoMoves(SUMMON) && canSpawn) return SUMMON;
  //             else return SNAKE_STRIKE;                       // ← 这一档**必然返回**
  //         }
  //         if (!lastMove(BIG_BITE)) return BIG_BITE;
  //         myRoll = aiRng.random(0, 65);                       // ★ 重掷并回到循环顶
  //     }
  //
  // ⚠ 五处照抄：
  //  ①⚠ **首回合恒召唤**，`canSpawn` 那道门在这条路上**不生效**——开局 3 只活怪
  //     （法师 + 两把匕首）虽然 `< 4` 成立，但即便不成立也照样召。
  //  ② **`canSpawn` 在循环外算一次**（`monstersAlive < 4`）：循环里重掷 roll 不会重新读它。
  //     ⚠ 这个 4 与「预留空位不算活怪」直接挂钩：开局 `monstersAlive = 3`（0 / 3 号位是空格），
  //     写成数组长度 5 的话第一次重掷之后就再也召不出来。
  //  ③ **第一段的 else 是「重掷到 [33,99] 然后往下走」，不是 continue**——所以重掷之后
  //     一定落进第二段或第三段，不会再判一次 `myRoll < 33`。
  //  ④ **第二段两条分支都 return**，于是「重掷到 [33,66) 」必然出毒牙或召唤。
  //  ⑤ 末尾那次 `random(0, 65)` 才是真正回到循环顶的那一支（`myRoll` 可能又 < 33）。
  //     ⚠ 与蠕动血块那种「五段并列 if + 两处 continue」形似，但这条的循环边只有一条。
  reptomancer: (bc, m, roll) => {
    if (firstTurn(m)) {
      return "summon_daggers";
    }
    let myRoll = roll;
    const canSpawn = bc.monstersAlive < 4;
    for (;;) {
      if (myRoll < 33) {
        if (!lastMove(m, "snake_strike")) {
          return "snake_strike";
        }
        myRoll = bc.rng.aiRng.random(33, 99); // ★ 追加一次 aiRng（重掷，然后继续往下判）
      }
      if (myRoll < 66) {
        if (!lastTwoMoves(m, "summon_daggers") && canSpawn) {
          return "summon_daggers";
        }
        return "snake_strike";
      }
      if (!lastMove(m, "big_bite")) {
        return "big_bite";
      }
      myRoll = bc.rng.aiRng.random(0, 65); // ★ 追加一次 aiRng（重掷并回到循环顶）
    }
  },

  // 匕首：对齐 MonsterSpecific.cpp:2679-2681——**恒返回突刺**，一条分支都没有。
  // ⚠ 它的另一个意图（自爆）不是掷出来的：突刺那条 case 的收尾是同步 `setMove(DAGGER_EXPLODE)`，
  //   见 `MOVE_TURN_END`。而召唤出来的匕首同样靠 `setMove(DAGGER_STAB)` 定意图、不走 rollMove
  //   ——所以这条规则其实只在**开局那两把**匕首身上被调用（`MonsterGroup::init` 的
  //   rollMove 循环），召唤路径一次都不调。
  dagger: () => "dagger_stab",

  // —— 第三十七批：第三幕 Boss 觉醒者 ——
  //
  // 对齐 MonsterSpecific.cpp:3280-3328。它是本项目第一条**按阶段分成两块**的出招规则：
  //
  //     if (halfDead) return REBIRTH;                       // ← 假死期间的兜底
  //     const bool phase2 = miscInfo;
  //     if (!phase2) {
  //         if (firstTurn()) return SLASH;
  //         if (roll < 25) return lastMove(SOUL_STRIKE) ? SLASH : SOUL_STRIKE;
  //         return !lastTwoMoves(SLASH) ? SLASH : SOUL_STRIKE;
  //     }
  //     if (roll < 50) return !lastTwoMoves(SLUDGE) ? SLUDGE : TACKLE;
  //     return !lastTwoMoves(TACKLE) ? TACKLE : SLUDGE;
  //
  // ⚠ 六处照抄：
  //  ①⚠⚠ **`halfDead` 那道门排在最前面，而且它真的会被走到——只是薄（实测 2 例）**。
  //     大多数时候用不上它：`Monster::die` 的觉醒者分支已经 `setMove(REBIRTH)` 过了，
  //     而重生那条 case 的收尾是 `noOpRollMove`（掷完就丢），所以没人会在假死期间
  //     重新滚意图。**唯一走到它的局面是「觉醒者死在怪物阶段」**：它自己的攻击
  //     `addToBot(RollMove(idx))` 排在伤害之后，而青铜鳞片的荆棘是 `addToTop` 的
  //     ——荆棘把它打进假死，紧接着那条 RollMove 就在**半死的怪身上**执行。
  //     实测 46 条走到假死的 trace 里恰有 **2 条**是这么进去的（`GEN20@floor3` /
  //     `GEN9@floor7`，两条都带青铜鳞片，触发动作是 `end_turn` 而不是打牌）。
  //     去掉这道门红 **2 例**。⚠ 机理与第二十六批百夫长的 `CENTURION_FURY` 完全相同。
  //     ⚠ 它与暗影客那条形状相同（`if (halfDead) return DARKLING_REINCARNATE`），但那一条
  //     的分母厚得多：暗影客的「重生」是一条空 case、收尾是同步的**真** rollMove，
  //     每次复活都要走一遍。**别按分母大小推形状，也别按形状推分母。**
  //  ②⚠⚠ **阶段位是 `miscInfo`，不是任何 Power**（参考在 `die` 那行自注
  //     `// todo change to status`）。它由复活那条 case 的 `miscInfo = true` 置起，
  //     整场只可能置一次——所以觉醒者只会假死一次，第二次死是真死。
  //  ③ 一阶段的 `firstTurn()` 恒出斩击（开局那次 rollMove 的 roll 被丢掉）。
  //  ④ 一阶段两档的分界是 **25**，二阶段是 **50**——两个独立的字面量，别统一。
  //  ⑤ 一阶段 roll < 25 那档读的是 **`lastMove`**（上一格），而下面那档读的是
  //     **`lastTwoMoves`**（最近两格都是）。同一只怪上两种谓词并存，抄串了只在
  //     「刚出过一次灵魂打击」的那些回合分岔。
  //  ⑥ 二阶段两档**互为镜像**（污泥档满了出冲撞、冲撞档满了出污泥），都用 `lastTwoMoves`。
  awakened_one: (_bc, m, roll) => {
    if (m.halfDead) {
      return "rebirth";
    }
    const phase2 = m.miscInfo !== 0;
    if (!phase2) {
      if (firstTurn(m)) {
        return "aw_slash";
      }
      if (roll < 25) {
        return lastMove(m, "soul_strike") ? "aw_slash" : "soul_strike";
      }
      return !lastTwoMoves(m, "aw_slash") ? "aw_slash" : "soul_strike";
    }
    // 二阶段
    if (roll < 50) {
      return !lastTwoMoves(m, "sludge") ? "sludge" : "aw_tackle";
    }
    return !lastTwoMoves(m, "aw_tackle") ? "aw_tackle" : "sludge";
  },

  // —— 第三十八批：第三幕 Boss 时间吞噬者 ——
  //
  // 对齐 MonsterSpecific.cpp:3231-3270。它是本项目**追加 aiRng 次数最多**的一条出招规则
  // （单次 rollMove 可以消耗 1、2 或 3 次），三处追加各不相同：
  //
  //     const bool usedHaste   = miscInfo;
  //     const bool underHalfHp = curHp < maxHp/2;
  //     if (!usedHaste && underHalfHp) return HASTE;
  //
  //     auto myRoll = roll;
  //     if (myRoll < 45) {
  //         if (!lastTwoMoves(REVERBERATE)) return REVERBERATE;
  //         myRoll = bc.aiRng.random(50,99);          // ← 追加①：重掷进 [50,99]
  //     }
  //     if (myRoll < 80) {
  //         if (!lastMove(HEAD_SLAM)) return HEAD_SLAM;
  //         if (bc.aiRng.randomBoolean(0.66f)) return REVERBERATE;   // ← 追加②
  //         return RIPPLE;
  //     }
  //     if (lastMove(RIPPLE)) {
  //         myRoll = bc.aiRng.random(74);             // ← 追加③：单参 random(74) = [0,74]
  //         if (myRoll < 45) return REVERBERATE;
  //         else             return HEAD_SLAM;
  //     }
  //     return RIPPLE;
  //
  // ⚠ 七处照抄：
  //  ①⚠⚠ **加速那道门排在最前面，而且它是个「一次性」门**：`miscInfo` 由加速那条 case
  //     自己置起（`set_misc_info`），所以整场最多滚出一次加速。⚠ 血量读的是
  //     **`curHp < maxHp/2`**（严格小于，C++ 整除），而 `maxHp` 恒是 456 —— 228 血是分界。
  //  ②⚠⚠ **第一段的重掷不是「再滚一次同样的 roll」**：`aiRng.random(50,99)` 的取值
  //     区间是 **[50, 99]**，恒 ≥ 50。所以重掷之后第二段那道 `myRoll < 80` 仍有可能命中
  //     （50~79），而第三段（≥ 80）也有可能。写成 `random(99)` 会让分布整个变形。
  //  ③⚠ **第二段用的是 `lastMove`（上一格），第一段用的是 `lastTwoMoves`（最近两格都是）**
  //     ——同一只怪上两种谓词并存，与觉醒者同族。抄串了只在「刚出过一次头槌」的回合分岔。
  //  ④⚠ `randomBoolean(0.66f)` 的 **true 那一支是混响**（不是涟漪）。⚠ 它是 `float`
  //     字面量，必须走 `Math.fround`——这条流的取值靠 `nextFloat() < chance` 比较。
  //  ⑤⚠⚠ **第三段的 `random(74)` 是单参重载**（`Random::random(int range)` = 闭区间
  //     `[0, 74]`，75 个取值），不是 `random(0, 74)` 之外的什么东西——两者同解，但别抄成
  //     `random(74, 99)` 或 `random(73)`。它只在「上一招是涟漪」时才掷，所以这一段的
  //     aiRng 消耗**逐回合不同**。
  //  ⑥⚠ 第三段那道门读的是 `lastMove(RIPPLE)`：**不满足就直接返回涟漪、一次都不掷**。
  //     所以「roll >= 80」这一档的 aiRng 消耗是 0 次或 1 次两种。
  //  ⑦ 三个字面量分界 **45 / 80 / 45** 各自独立（第一段的 45 与第三段的 45 同值但是两处），
  //     别合并成一个常量。
  time_eater: (bc, m, roll) => {
    const usedHaste = m.miscInfo !== 0;
    const underHalfHp = m.hp < Math.trunc(m.maxHp / 2);
    if (!usedHaste && underHalfHp) {
      return "haste";
    }
    let myRoll = roll;
    if (myRoll < 45) {
      if (!lastTwoMoves(m, "te_reverberate")) {
        return "te_reverberate";
      }
      myRoll = bc.rng.aiRng.random(50, 99); // ★ 追加一次 aiRng（重掷进 [50,99]）
    }
    if (myRoll < 80) {
      if (!lastMove(m, "te_head_slam")) {
        return "te_head_slam";
      }
      if (bc.rng.aiRng.randomBoolean(Math.fround(0.66))) {
        // ★ 追加一次 aiRng
        return "te_reverberate";
      }
      return "te_ripple";
    }
    if (lastMove(m, "te_ripple")) {
      myRoll = bc.rng.aiRng.random(74); // ★ 追加一次 aiRng（单参重载 = [0,74]）
      if (myRoll < 45) {
        return "te_reverberate";
      }
      return "te_head_slam";
    }
    return "te_ripple";
  },

  // —— 第三十九批：第三幕 Boss 迪卡与多努 ——
  //
  // 对齐 MonsterSpecific.cpp:3272-3278。两条 case 各只有一句 `return`，**一个分支都没有**：
  //
  //     case MonsterId::DECA: { return MonsterMoveId::DECA_BEAM; }
  //     case MonsterId::DONU: { return MonsterMoveId::DONU_CIRCLE_OF_POWER; }
  //
  // ⚠ 三处照抄：
  //  ① **roll 被掷出来但一个字都不读**（`Monster::rollMove` 顶上那句
  //     `bc.aiRng.random(99)` 是无条件的），所以一次 rollMove 恒消耗 **1 次** aiRng。
  //     与邪教徒那种「roll 被消耗但不影响结果」同族。
  //  ② **两只返回的是不同的招**（迪卡开光束、多努开能量之环），不是同一个常量。
  //     这就是「迪卡先打人、多努先增益」的开局节奏，抄反了第一个怪物回合就错。
  //  ③⚠⚠ **`getMoveForRoll` 在这个编队里只被调用一次**——开局那次 `MonsterGroup::init`
  //     的 rollMove。四条 case 的收尾全是**同步 `setMove`**（见 `MOVE_TURN_END`），
  //     没有一条排 `RollMove` / `NoOpRollMove`，所以整场仗的意图链是严格的 2-循环：
  //     迪卡「光束 → 守护 → 光束 → …」、多努「能量之环 → 光束 → 能量之环 → …」。
  //     这也是为什么四条招式的覆盖**任何牌组都满足**（第二个怪物回合就全走过了），
  //     本批选牌组要解决的是别的事（见 TODOS「牌组先量再定」）。
  deca: () => "deca_beam",
  donu: () => "circle_of_power",

  // —— 第四十七批乙：第四幕与蒙面强盗，`MOVE_RULES` 的最后六只（65 / 65）——
  //
  // 腐化之心（MonsterSpecific.cpp:3330-3340）：
  //     if (firstTurn()) { return CORRUPT_HEART_DEBILITATE; }
  //     // only called if not going to buff
  //     if (bc.aiRng.randomBoolean()) { return CORRUPT_HEART_BLOOD_SHOTS; }
  //     else                          { return CORRUPT_HEART_ECHO; }
  // ⚠ 三处照抄：
  //  ①⚠ **顶部那次 `random(99)` 照掷、结果被丢掉**，这里又掷一次 `randomBoolean()`
  //     ——所以一次 rollMove 消耗 **2 次** aiRng（与酸液史莱姆小同族）。
  //     写成「读 roll 分档」会少掷一次，`rng.ai` 计数器当场对不上。
  //  ② 参考那行注释 `// only called if not going to buff` 是在说：**强化永远不会被
  //     roll 出来**，它只由血弹 / 回响的收尾 `setMove` 定出来（见 `MOVE_TURN_END`）。
  //  ③ `firstTurn()` 读的是 `moveHistory[0] == INVALID`，所以虚弱化恰好出现在第一个
  //     怪物回合，一场仗一次。
  corrupt_heart: (bc, m) => {
    if (firstTurn(m)) {
      return "debilitate";
    }
    return bc.rng.aiRng.randomBoolean() ? "blood_shots" : "heart_echo"; // ★ 消耗一次 aiRng
  },

  // 尖塔护盾（MonsterSpecific.cpp:3342-3351）：
  //     if (bc.aiRng.randomBoolean()) { return SPIRE_SHIELD_FORTIFY; }
  //     else                          { return SPIRE_SHIELD_BASH; }
  // ⚠ 与长矛的差别是**没有 `firstTurn()` 那道门**——两只怪的规则并排放着，照抄邻居必错。
  // ⚠ 重砸（SMASH）**不在这条规则里**：它只由猛击 / 加固的收尾 `setMove` 定出来，
  //   参考在这条 case 上方还并排注了 `// 1 bash / 2 fortify / 3 smash` 三行。
  // ⚠ 同样是「掷 99 丢掉 + 再掷一次 randomBoolean」＝ **2 次** aiRng。
  spire_shield: (bc) => (bc.rng.aiRng.randomBoolean() ? "fortify" : "shield_bash"), // ★ 一次 aiRng

  // 尖塔长矛（MonsterSpecific.cpp:3353-3362）：
  //     if (firstTurn()) { return SPIRE_SPEAR_BURN_STRIKE; }
  //     if (bc.aiRng.randomBoolean()) { return SPIRE_SPEAR_PIERCER; }
  //     else                          { return SPIRE_SPEAR_BURN_STRIKE; }
  // ⚠ `firstTurn()` 那一支**不掷** `randomBoolean`，所以开局那次 rollMove 只消耗 1 次
  //   aiRng（顶部那次），其后每次 2 次。护盾没有这道门 —— 两只的计数器从第一帧就不同。
  spire_spear: (bc, m) => {
    if (firstTurn(m)) {
      return "burn_strike";
    }
    return bc.rng.aiRng.randomBoolean() ? "piercer" : "burn_strike"; // ★ 消耗一次 aiRng
  },

  // 蒙面强盗三只（MonsterSpecific.cpp:2996-3009）：三条 case 各只有一句 `return`，
  // 与迪卡 / 多努同形——**roll 被掷出来但一个字都不读**，一次 rollMove 恒消耗 1 次 aiRng。
  // ⚠ 而且这三只的 `takeTurn` **没有一条排 RollMove / NoOpRollMove**（全是同步 setMove
  //   或干脆什么都没有，见 `MOVE_TURN_END`），所以整个编队的 `rng.ai` 计数器在开局那
  //   三次 rollMove 之后**再也不动**。
  bear: () => "bear_hug",
  romeo: () => "mock",
  pointy: () => "pointy_attack",
};

// ============================================================================
// 掉血触发（对齐 `Monster::onHpLost`，Monster.cpp:499）
//
// ⚠ 只在**这一击没打死它**时调用（`curHp > 0`），打死了走 `die`。两条伤害路径
// （`attacked` → `attackedUnblockedHelper`、`damage` → `damageUnblockedHelper`）末尾各有一处。
//
// ⚠ 大史莱姆的分裂靠它触发，写法是**直接赋值 `moveHistory[0]`**，而不是 `setMove`：
// 所以 `moveHistory[1]`（上上步）**不前移**，被顶掉的那个意图就此消失。这个差别是可观察的
// ——分裂之后那两只是新怪、历史全空，但同族的守卫者模式切换（第十九批）会接着用历史。
//
// ⚠ 阈值是 `curHp <= maxHp/2` 的 **C++ 整除**（向零截断）：65 血的 maxHp/2 = 32，
// 掉到 32 才分裂，不是 32.5。
// ============================================================================

type OnHpLost = (bc: BattleContext, m: CombatMonster, amount: number) => void;

const MONSTER_ON_HP_LOST: Record<string, OnHpLost> = {
  // 酸液史莱姆（大）：对齐 Monster.cpp:501-506。
  acid_slime_l: (_bc, m) => {
    if (m.hp <= Math.trunc(m.maxHp / 2)) {
      overwriteMove(m, "split");
    }
  },
  // 尖刺史莱姆（大）：对齐 Monster.cpp:514-518，与上一条逐字同构。
  spike_slime_l: (_bc, m) => {
    if (m.hp <= Math.trunc(m.maxHp / 2)) {
      overwriteMove(m, "split");
    }
  },
  // 史莱姆王：对齐 Monster.cpp:507-511，与两只大史莱姆**逐字同构**（同样是裸的
  // `moveHistory[0] = X`、同样的 `curHp <= maxHp/2` 整除阈值）。差别全在分裂函数本身，
  // 见 `slimeBossSplit`。
  slime_boss: (_bc, m) => {
    if (m.hp <= Math.trunc(m.maxHp / 2)) {
      overwriteMove(m, "split");
    }
  },

  // 守卫者的形态切换：对齐 Monster.cpp:519-529。这是同一个 switch 里**形状完全不同**的
  // 另一支，四处照抄：
  //  ① 入口是 `hasStatus<MODE_SHIFT>()` —— 已经在防御形态里（层数被摘掉）时整条不跑，
  //     所以防御链那三回合再挨多少打也不会二次切换；
  //  ② 扣的是**这一次掉的血**（`amount`），不是「累计伤害」——`onHpLost` 的实参就是
  //     未被格挡的那一段，打在怪物格挡上的部分不算；
  //  ③ 归零判据是 `<= 0`（不是 `== 0`），溢出的伤害直接丢弃、不带到下一轮阈值里；
  //  ④ 归零那支用的是 **`setMove`**（前移历史），而不是分裂那种裸的 `moveHistory[0] = X`
  //     ——同一个 switch 里两种写法并存，别统一。紧跟着的
  //     `addToBot(Actions::MonsterGainBlock(idx, 20))` 是**入队**：那 20 点挡要等动作出队
  //     才落地，而意图当场就变了。
  // ⚠ 下一轮的阈值不在这里涨，在双重猛击的收尾里（`miscInfo += 10` 然后重新
  //   `buff<MODE_SHIFT>(miscInfo)`），见 `MOVE_TURN_END["the_guardian/twin_slam"]`。
  the_guardian: (bc, m, amount) => {
    const modeShift = getPower(m.powers, "mode_shift");
    if (modeShift === 0) {
      return;
    }
    const next = modeShift - amount;
    if (next <= 0) {
      removePower(m.powers, "mode_shift");
      setMove(m, "defensive_mode");
      addToBot(bc, () => {
        m.block += 20;
      });
    } else {
      setPower(m.powers, "mode_shift", next);
    }
  },
};

function monsterOnHpLost(bc: BattleContext, m: CombatMonster, amount: number): void {
  MONSTER_ON_HP_LOST[m.defId]?.(bc, m, amount);
}

// ============================================================================
// 招式收尾：下一个意图怎么定（对齐参考 `Monster::takeTurn` 各 case 的最后一句）
//
// 参考把「下回合出什么」写在每条招式的 case 尾部，而且**三种形态并存**，不能统一：
//
//   roll        `addToBot(Actions::RollMove(idx))`   —— 绝大多数怪：入队，执行时掷 aiRng
//   no_op_roll  `addToBot(Actions::NoOpRollMove())`  —— 入队，执行时**照样掷一次**
//                                                       `aiRng.random(99)`（BattleContext.cpp:2814）
//                                                       但**不改意图**。只出招唯一的怪用它。
//   { setMove } 同步 `setMove(下一招)`               —— **不掷任何 aiRng**，当场锁定。
//   none        case 尾部**什么都没有**             —— 第十四批新增的第四形态。分裂就是这样：
//                                                       `largeSlimeSplit(...)` 之后直接 `break`，
//                                                       收尾（两次 noOpRollMove）在那个函数**内部**，
//                                                       见 `splitMonster`。
//   (bc, m) => …  任意收尾语句                        —— 第十五批新增的第五形态。抢劫者的
//                                                       抢劫是 `if (回合数==1) setMove(抢劫)
//                                                       else setMove(aiRng.randomBoolean(0.5)
//                                                       ? 烟雾弹 : 猛扑)`——**下一招与
//                                                       aiRng 消耗都取决于运行时状态**，
//                                                       静态表达不了，只能写成函数。
//
// ⚠ 五者对 aiRng 的消耗完全不同（1 / 1 / 0 / 由效果自己负责 / 函数自己负责），
//   选错就是 counter 当场对不上。
// ⚠ `no_op_roll` 与 `roll` 消耗相同但语义不同：前者不写 moveHistory，所以
//   `lastMove` / `lastTwoMoves` 看到的历史也不同。
//
// 键是 `${怪 id}/${招式 id}`——招式 id 在不同怪之间会重名（多只史莱姆都有「舔舐」）。
// 表里没有的招式一律按 `roll` 处理，这是参考的多数形态。
// ============================================================================

type MoveTurnEnd =
  | "roll"
  | "no_op_roll"
  | "none"
  | { readonly setMove: string }
  | ((bc: BattleContext, m: CombatMonster) => void);

const MOVE_TURN_END: Record<string, MoveTurnEnd> = {
  // 酸液史莱姆（小）：舔舐 ↔ 冲撞严格交替，两条都是**同步** setMove、不消耗 aiRng。
  // 对齐 MonsterSpecific.cpp:393 / :398。
  "acid_slime_s/lick_weak": { setMove: "tackle_acid_s" },
  "acid_slime_s/tackle_acid_s": { setMove: "lick_weak" },
  // 尖刺史莱姆（小）：只有一招，参考用 NoOpRollMove——**照样消耗一次** aiRng.random(99)，
  // 但意图不变、moveHistory 也不推进。对齐 MonsterSpecific.cpp:1204。
  "spike_slime_s/tackle_s": "no_op_roll",
  // 大史莱姆分裂：参考的 case 只有一句 `largeSlimeSplit(...)` 然后 `break`，**没有任何收尾语句**
  // （MonsterSpecific.cpp:364 / :1198）。收尾在 largeSlimeSplit 内部，见 `splitMonster`。
  "acid_slime_l/split": "none",
  "spike_slime_l/split": "none",

  // —— 抢劫者（第十五批）：四条 case 的收尾**一次都不掷 RollMove** ——
  //
  // 抢劫：对齐 MonsterSpecific.cpp:924-932。首个怪物回合锁死「再抢一次」且**不掷** aiRng；
  // 之后每次抢劫都 `aiRng.randomBoolean(0.5f)` 二选一。⚠ true 那支是**烟雾弹**。
  "looter/mug": (bc, m) => {
    if (getMonsterTurnNumber(bc) === 1) {
      setMove(m, "mug");
      return;
    }
    setMove(m, bc.rng.aiRng.randomBoolean(Math.fround(0.5)) ? "smoke_bomb" : "lunge"); // ★ 消耗一次 aiRng
  },
  // 猛扑 → 烟雾弹 → 逃跑，两条都是**同步** setMove、不消耗 aiRng
  // （MonsterSpecific.cpp:914 / :938）。
  "looter/lunge": { setMove: "smoke_bomb" },
  "looter/smoke_bomb": { setMove: "flee" },
  // 逃跑：case 里只有「置逃跑位 + monstersAlive--（+判胜）」然后 break，**没有任何收尾语句**
  // （MonsterSpecific.cpp:899-909）——与分裂同为 `none` 形态。逃跑之后它再也不行动，
  // 所以「意图不变」也不会被观察到。
  "looter/flee": "none",

  // —— 地精帮五只（第十七批）：**没有一条排真正的 RollMove** ——
  //
  // ⚠ 三只只有一招的地精，收尾却**不一样**，照抄不要统一：
  //   狂暴 / 肥胖 → `addToBot(NoOpRollMove())`（照掷一次 aiRng 丢掉）
  //   鬼祟         → **什么都没有**（一次都不掷）
  // 参考里就是这么写的（MonsterSpecific.cpp:650-654 / :660-664 / :670-672），
  // 差别当场体现在 aiRng 计数器上。

  // ⚠ 三条 case 的收尾其实都长这样：
  //     if (doesEscapeNext()) { setMove(GENERIC_ESCAPE_MOVE); } else { …… }
  //   而 `Monster::escapeNext` 在参考里**全项目没有任何写入点**（只有 Monster.h:47 的
  //   初值 false 与 Monster.cpp:261 的 getter），所以 `doesEscapeNext()` 恒假、逃跑那支是
  //   死代码——与第十六批修掉的红奴隶主 `usedEntangle` **同一类笔误**。
  //   真实游戏里这一位由地精头领（GREMLIN_LEADER）被打死时置上，而那个编队不在 harness 的
  //   20 个第一幕编队里，**没有预言机**，所以这一批既不建模 `escapeNext`、也不给参考打补丁，
  //   只转写 else 那一支。见 TODOS「已确认但尚未打补丁」。
  "mad_gremlin/scratch": "no_op_roll",
  "fat_gremlin/smash": "no_op_roll",
  "sneaky_gremlin/puncture": "none",

  // 护盾地精的保护：尾部是**条件同步 setMove**（第五形态：任意函数）。
  // 对齐 MonsterSpecific.cpp:1099-1101 `if (bc.monsters.getAliveCount() <= 1) setMove(SHIELD_BASH)`。
  // ⚠ 三处逐位对齐点：
  //  ① `getAliveCount()` 就是 `monstersAlive`（MonsterGroup.cpp:36-38），不是「数组里活着的个数」；
  //  ② 判定跑在**同步**语句里，也就是排在上面那条 `addToBot(GainBlockRandomEnemy)` 之前生效
  //     ——快照里意图当场就变成盾击，而格挡要等动作出队才加；
  //  ③ `<= 1` 而不是 `== 1`：护盾地精自己此刻还活着，所以这就是「场上只剩我」。
  //  ⚠ 一旦改成盾击就**再也回不去**（盾击那条 case 尾部什么都没有），所以这是单向门。
  "shield_gremlin/protect": (bc, m) => {
    if (bc.monstersAlive <= 1) {
      setMove(m, "shield_bash");
    }
  },
  // 盾击：`attackPlayerHelper` 之后直接 break（MonsterSpecific.cpp:1105-1107），
  // 没有任何收尾语句——它会一直盾击到死。
  "shield_gremlin/shield_bash": "none",

  // 地精巫师的蓄力：尾部是「攒够 3 次就改出大招」（MonsterSpecific.cpp:776-778）。
  // ⚠ 计数那句 `++miscInfo` 排在**它之前**，落在 `MOVE_TURN_BEGIN` 里；这里只判阈值。
  // ⚠ 判的是 `== 3` 而不是 `>= 3`——配合大招那条的 `miscInfo = 0` 才不会溢出。
  "gremlin_wizard/charging": (_bc, m) => {
    if (m.miscInfo === 3) {
      setMove(m, "ultimate_blast");
    }
  },
  // 大招：尾部是 `if (!asc17) { miscInfo = 0; setMove(CHARGING); }`
  // （MonsterSpecific.cpp:784-788）。asc17 时**整段不跑**——意图停在大招上，于是每回合都放，
  // 这就是高层数地精巫师那么凶的原因。当前 trace 全是 asc0，那一支走不到但照抄。
  "gremlin_wizard/ultimate_blast": (bc, m) => {
    if (bc.ascension < 17) {
      m.miscInfo = 0; // 清零蓄力计数
      setMove(m, "charging");
    }
  },

  // —— 第一幕三个精英（第十八批）——
  //
  // 地精头目三条 case 的收尾都是**裸的 `addToBot(Actions::RollMove(idx))`**
  //（MonsterSpecific.cpp:758 / :762 / :769），即默认的 `"roll"`，所以这里**一条都不写**。
  // 它是本批唯一一只真的会反复 rollMove 的怪。
  //
  // ⚠ 拉加维林与哨卫的五条 case 全是「**同步 setMove** + 一次 noOpRollMove」的组合，
  //   四个静态形态一个都表达不了（`{setMove}` 不掷 aiRng、`"no_op_roll"` 不改意图），
  //   所以全部写成第五形态（任意函数）。
  // ⚠ 而且 noOpRollMove 的写法在同一只怪里**两种并存**，照抄不要统一：
  //     重击      `bc.addToBot(Actions::NoOpRollMove())`  —— **入队**（:878）
  //     吸取灵魂  `bc.noOpRollMove()`                     —— **同步**（:885）
  //     沉睡      `bc.noOpRollMove()`                     —— **同步**（:894）
  //     光束/射钉 `bc.addToBot(Actions::NoOpRollMove())`  —— **入队**（:1060 / :1066）
  //   两者消耗的 aiRng 次数相同，差别在「这一次掷发生在本回合排的动作之前还是之后」。

  // 重击：`attackPlayerHelper` 之后先判连击、再入队 NoOpRollMove（MonsterSpecific.cpp:871-879）。
  // ⚠ `lastTwoMoves(ATTACK)` 读的是**改写之前**的历史，而此刻 moveHistory[0] 正是本次执行的
  //   重击本身——所以「连两次重击」意味着上一回合也是重击，节奏是 重击 → 重击 → 吸魂 → 重击…
  //   而苏醒后的第一击因为 moveHistory[1] 还是沉睡，会多打一次重击。
  "lagavulin/lag_attack": (bc, m) => {
    if (lastTwoMoves(m, "lag_attack")) {
      setMove(m, "siphon_soul");
    } else {
      setMove(m, "lag_attack");
    }
    addToBot(bc, (c) => {
      c.rng.aiRng.random(99); // ★ 消耗一次 aiRng（NoOpRollMove，入队）
    });
  },
  // 吸取灵魂：同步 setMove + **同步** noOpRollMove（MonsterSpecific.cpp:884-885）。
  "lagavulin/siphon_soul": (bc, m) => {
    setMove(m, "lag_attack");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  // 沉睡：`if (bc.turn == 2 || !hasStatus<ASLEEP>()) setMove(ATTACK) else setMove(SLEEP)`
  //（MonsterSpecific.cpp:888-894），随后**同步** noOpRollMove。⚠ 三处照抄：
  //  ① 判的是 **`bc.turn == 2`**（`==` 不是 `>=`）。`bc.turn` 从 0 起、在 `afterMonsterTurns`
  //     里才自增，所以怪物阶段读到的是「上一个玩家回合的编号」：turn 0/1/2 三个怪物回合都
  //     在睡，第三个（turn==2）那次把意图改成重击 → 第 4 个回合才动手。这就是「睡 3 回合」。
  //  ② 第二个条件是**被打醒**：伤害路径把 ASLEEP 清掉之后，下一次沉睡收尾立刻改出重击。
  //     ⚠ 但「打醒」本身不会让它当回合行动——它这一回合仍然执行沉睡（无效果）。
  //  ③ `bc.turn == 2` 与醒没醒是 `||`，所以第 3 个回合无论醒没醒都会转重击。
  "lagavulin/sleep": (bc, m) => {
    if (bc.turn === 2 || getPower(m.powers, "asleep") === 0) {
      setMove(m, "lag_attack");
    } else {
      setMove(m, "sleep");
    }
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },

  // 哨卫：光束 ↔ 射钉**严格交替**，同步 setMove + 入队 NoOpRollMove
  //（MonsterSpecific.cpp:1057-1067）。所以三只哨卫从开局的 射钉/光束/射钉 起，
  // 整场都保持错位——这正是它们成组出现时的压迫感来源。
  "sentry/beam": (bc, m) => {
    setMove(m, "bolt");
    addToBot(bc, (c) => {
      c.rng.aiRng.random(99); // ★ 消耗一次 aiRng（NoOpRollMove，入队）
    });
  },
  "sentry/bolt": (bc, m) => {
    setMove(m, "beam");
    addToBot(bc, (c) => {
      c.rng.aiRng.random(99); // ★ 消耗一次 aiRng（NoOpRollMove，入队）
    });
  },

  // —— 第一幕两个 Boss（第十九批）：**十一条 case 一次 aiRng 都不掷** ——
  //
  // 守卫者七条、史莱姆王三条全是**同步 setMove**（第三形态），分裂那条是 `"none"`。
  // 于是两只 Boss 的 `rng.ai` 一整场只有开局那一次 rollMove 的 +1（史莱姆王分裂时
  // 再 +2，那是分裂出来的两只各自 rollMove，见 `slimeBossSplit`）。

  // 守卫者的进攻链：蓄能 → 重砸 → 泄气 → 旋风 → 蓄能 …
  // （MonsterSpecific.cpp:1348 / :1358 / :1377 / :1382）
  "the_guardian/charging_up": { setMove: "fierce_bash" },
  "the_guardian/fierce_bash": { setMove: "vent_steam" },
  "the_guardian/vent_steam": { setMove: "whirlwind" },
  "the_guardian/whirlwind": { setMove: "charging_up" },
  // 防御链：防御形态 → 滚压 → 双重猛击 →（回进攻链的旋风）
  // （MonsterSpecific.cpp:1353 / :1363 / :1370）
  // ⚠ 进入防御形态那一步**不在这里**——它由掉血触发写进意图（`MONSTER_ON_HP_LOST`），
  //   所以防御链是从任意一条进攻招式中途插进来的，进攻链的进度直接被丢弃。
  "the_guardian/defensive_mode": { setMove: "roll_attack" },
  "the_guardian/roll_attack": { setMove: "twin_slam" },

  // 双重猛击的收尾（MonsterSpecific.cpp:1367-1372）：case 里效果之后还有**四句**，
  // 逐句照抄，顺序即参考的书写顺序：
  //   ① `removeStatus<MS::SHARP_HIDE>()` —— **同步**摘掉尖锐外壳。所以「打出攻击牌吃反伤」
  //      在双重猛击这一回合的怪物阶段就停了，不用等到下一个玩家回合。
  //   ② `miscInfo += 10` —— 下一次形态切换的阈值。⚠ 它是**累加**：30 → 40 → 50 …
  //      每进一次防御形态就更难触发一次，这就是守卫者后期不再切换的原因。
  //      ⚠ 起点由 `PRE_BATTLE_ACTION.the_guardian` 写进 miscInfo（asc0 是 30），
  //      三处协同（preBattle 置起点 / 这里 +10 / onHpLost 递减 MODE_SHIFT 层数）。
  //   ③ `setMove(WHIRLWIND)` —— 同步，不掷 aiRng。
  //   ④ `addToBot(Actions::BuffEnemy<MS::MODE_SHIFT>(idx, miscInfo))` —— **入队**，
  //      而且 `miscInfo` 是 C++ 的**实参**、在建动作那一刻就求值。所以 MODE_SHIFT 那一层
  //      要等动作出队才出现在快照里，且值是「此刻」的 miscInfo。
  //      ⚠ 它是 `buff`（累加到 0 上），不是 setStatus——上一轮已被 `removeStatus` 摘掉。
  "the_guardian/twin_slam": (bc, m) => {
    removePower(m.powers, "sharp_hide");
    m.miscInfo += 10;
    setMove(m, "whirlwind");
    const amount = m.miscInfo; // ★ 实参在此刻求值（C++ 按值捕获）
    addToBot(bc, () => {
      addPower(m.powers, "mode_shift", amount);
    });
  },

  // 史莱姆王：黏液喷射 → 蓄力 → 猛砸 → 黏液喷射 …（MonsterSpecific.cpp:1113 / :1117 / :1122）
  // ⚠ 参考在猛砸那行注了 `// the attack is executed after, which is critical`：
  //   `setMove` 是同步的、伤害是入队的，所以意图先变、伤害后落。
  "slime_boss/goop_spray": { setMove: "preparing" },
  "slime_boss/preparing": { setMove: "slam" },
  "slime_boss/slam": { setMove: "goop_spray" },
  // 分裂：case 里只有一句 `slimeBossSplit(bc, curHp)` 然后 break（MonsterSpecific.cpp:1125-1127），
  // **没有任何收尾语句**——与两只大史莱姆的分裂同为 `"none"` 形态。
  // ⚠ 但两者的 aiRng 消耗完全不同：大史莱姆那条在函数内部掷 2 次 noOpRollMove，
  //   史莱姆王这条**一次都不掷**，见 `slimeBossSplit`。
  "slime_boss/split": "none",

  // —— 第一幕最后一个 Boss（第二十批）：六火幽魂的**固定七招循环** ——
  //
  // 六条 case 的收尾全是第五形态（任意函数），因为每一条都是
  // 「同步 setMove + 一次 noOpRollMove」，再加上对 `uniquePower0`（六焰计数）的读写。
  //
  // ⚠ **出招序完全不掷 roll**：`getMoveForRoll` 只在开局被调用一次（恒返回激活），
  //   之后每一步都由这里的同步 `setMove` 钉死。整条序列是
  //     激活 → 六重打击 → 灼烧 → 冲撞 → 灼烧 → 燃焰 → 冲撞 → 灼烧 → 地狱之火 →（回到灼烧）
  //   ——分岔全部藏在灼烧那条 case 的 `uniquePower0` 三分支里，其余五条都是无条件的。
  //
  // ⚠ `uniquePower0` 由**五处**协同维护（六重打击 / 地狱之火清零，灼烧 / 冲撞 / 燃焰 +1），
  //   而且灼烧那条是**先读后加**。任意一处抄错都不会当场报错，只会让几回合后的招式错位。
  //
  // ⚠ noOpRollMove 的两种写法在这只怪身上同样并存，照抄不要统一：
  //     激活 / 燃焰            `bc.noOpRollMove()`                    —— **同步**（:796 / :819）
  //     六重打击 / 地狱之火 /  `bc.addToBot(Actions::NoOpRollMove())` —— **入队**
  //     灼烧 / 冲撞                                    （:804 / :811 / :837 / :844）
  //   次数相同，差别只在「这一掷发生在本回合排的动作之前还是之后」。

  // 激活（MonsterSpecific.cpp:793-798）：case 里效果之后是 `setMove(DIVIDER)` + **同步**
  // noOpRollMove。伤害那句（`miscInfo = curHp/12 + 1`）是效果，在数据表里。
  "hexaghost/activate": (bc, m) => {
    setMove(m, "divider");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  // 六重打击（MonsterSpecific.cpp:800-805）：`uniquePower0 = 0` 排在攻击**之后**、setMove 之前。
  // ⚠ 清零而不是 +1——它把六焰计数拉回起点，于是紧接着的灼烧走 `== 0` 那支（转冲撞）。
  "hexaghost/divider": (bc, m) => {
    m.uniquePower0 = 0;
    setMove(m, "sear");
    addToBot(bc, (c) => {
      c.rng.aiRng.random(99); // ★ 消耗一次 aiRng（NoOpRollMove，入队）
    });
  },
  // 地狱之火（MonsterSpecific.cpp:807-812）：与六重打击**逐字同形**（清零 → 灼烧 → 入队 NoOp）。
  // 所以一轮大循环之后计数从头开始，七招序列稳定重复。
  "hexaghost/inferno": (bc, m) => {
    m.uniquePower0 = 0;
    setMove(m, "sear");
    addToBot(bc, (c) => {
      c.rng.aiRng.random(99); // ★ 消耗一次 aiRng（NoOpRollMove，入队）
    });
  },
  // 燃焰（MonsterSpecific.cpp:814-820）：`++uniquePower0` 排在 setMove **之前**，
  // 收尾是**同步** noOpRollMove（与激活同写法）。
  "hexaghost/inflame": (bc, m) => {
    m.uniquePower0 += 1;
    setMove(m, "tackle");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  // 灼烧（MonsterSpecific.cpp:822-838）：整只怪唯一的分岔点，三分支照抄。
  // ⚠ 判据读的是**自增之前**的 `uniquePower0`：
  //     == 0 → 冲撞（刚被六重打击 / 地狱之火清过零）
  //     == 2 → 燃焰
  //     其它 → 地狱之火（实际走到这一支时它恒为 5）
  //   `++uniquePower0` 排在整个 if/else 之后，最后才入队 NoOpRollMove。
  "hexaghost/sear": (bc, m) => {
    if (m.uniquePower0 === 0) {
      setMove(m, "tackle");
    } else if (m.uniquePower0 === 2) {
      setMove(m, "inflame");
    } else {
      setMove(m, "inferno");
    }
    m.uniquePower0 += 1;
    addToBot(bc, (c) => {
      c.rng.aiRng.random(99); // ★ 消耗一次 aiRng（NoOpRollMove，入队）
    });
  },
  // 冲撞（MonsterSpecific.cpp:840-845）：`setMove(SEAR)` 在前、`++uniquePower0` 在后
  // ——与灼烧那条的顺序**相反**，照抄（两句都同步，当前不可分辨，但方向照参考）。
  "hexaghost/tackle": (bc, m) => {
    setMove(m, "sear");
    m.uniquePower0 += 1;
    addToBot(bc, (c) => {
      c.rng.aiRng.random(99); // ★ 消耗一次 aiRng（NoOpRollMove，入队）
    });
  },

  // —— 球状守卫者（第二十三批）：四条 case 的收尾**逐字同形** ——
  //
  //     setMove(下一招);        // 同步，快照里意图当场就变
  //     bc.noOpRollMove();      // **同步**（不是 addToBot(NoOpRollMove())），照掷一次 aiRng
  //
  // （MonsterSpecific.cpp:1166-1191，四条 case 各两句。）所以它是第五形态（任意函数）：
  // 三个静态形态里 `{setMove}` 不掷 aiRng、`no_op_roll` 不改意图，都表达不了「两件事都做」。
  //
  // ⚠ 于是这只怪的意图序列是**完全钉死**的、一次 roll 都不看：
  //     激活 → 攻击削弱 → 猛击 → 硬化 → 猛击 → 硬化 → …（猛击/硬化无限交替）
  //   而 `rng.ai` 每个怪物回合恰好 +1（开局 rollMove 那次 +1）。次数抄错当场落在计数器上。
  // ⚠ **硬化与攻击削弱都转到猛击**，不是互相转——照抄，别按「交替」的直觉写。
  "spheric_guardian/sg_activate": (bc, m) => {
    setMove(m, "sg_attack_debuff");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  "spheric_guardian/sg_attack_debuff": (bc, m) => {
    setMove(m, "sg_slam");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  "spheric_guardian/sg_harden": (bc, m) => {
    setMove(m, "sg_slam");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  "spheric_guardian/sg_slam": (bc, m) => {
    setMove(m, "sg_harden");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },

  // —— 选民与食蛇草（第二十三批）：**没有条目** ——
  // 选民五条 case、食蛇草两条 case 的收尾全是 `addToBot(Actions::RollMove(idx))`
  //（MonsterSpecific.cpp:614-639 / :1131-1140），也就是这张表的默认值 `"roll"`。
  // 写进来反而多一份可以抄错的真相，所以留空。

  // —— 拜鸟（第二十四批）：六条 case 里只有两条不是默认的 `roll` ——
  //
  // 啄击 / 俯冲 / 啼鸣 / 起飞四条都是 `addToBot(Actions::RollMove(idx))`
  //（MonsterSpecific.cpp:532-560），即默认值，不写进表里。
  //
  // 头槌：同步 `setMove(MMID::BYRD_FLY)`（`:544`）——**不掷 aiRng**。
  // 于是「摔下来 → 眩晕 → 头槌 → 起飞 → 回到 roll」是一条钉死的四步链。
  "byrd/headbutt": { setMove: "fly" },
  // 眩晕：整条 case 是 `bc.noOpRollMove(); setMove(MMID::BYRD_HEADBUTT);`（`:552-555`），
  // 两句都是**同步**的，所以它是第五形态（任意函数）：
  // `{setMove}` 表达不了那次 aiRng，`no_op_roll` 表达不了改意图。
  // ⚠ 顺序照抄：**先 noOpRollMove 再 setMove**（球状守卫者那四条恰好相反，先 setMove
  //   再 noOpRollMove）。两者都不读对方的状态，所以顺序当前不可观察——但两种写法在参考里
  //   真的并存，统一它就是在制造第二份真相。
  "byrd/stunned": (bc, m) => {
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
    setMove(m, "headbutt");
  },

  // —— 劫匪（第二十四批）：与抢劫者同形、数不同 ——
  //
  // 抢劫：对齐 MonsterSpecific.cpp:972-981。⚠ **判据是「第 2 个怪物回合」**，
  // 而抢劫者那条判的是第 1 个（`MOVE_TURN_END["looter/mug"]`）——两只怪的行为序列因此相同
  // （第 1 回合都锁死「再抢一次」），但**掷 aiRng 的回合不同**，抄错当场落在计数器上。
  // ⚠ true 那支是**烟雾弹**（与抢劫者一致）。
  "mugger/mug": (bc, m) => {
    if (getMonsterTurnNumber(bc) === 2) {
      setMove(m, bc.rng.aiRng.randomBoolean(Math.fround(0.5)) ? "smoke_bomb" : "lunge"); // ★ 消耗一次 aiRng
      return;
    }
    setMove(m, "mug");
  },
  // 猛扑 → 烟雾弹 → 逃跑，两条都是同步 setMove、不消耗 aiRng
  // （MonsterSpecific.cpp:960 / :986）。
  "mugger/lunge": { setMove: "smoke_bomb" },
  "mugger/smoke_bomb": { setMove: "flee" },
  // 逃跑：case 里只有「置逃跑位 + monstersAlive--（+判胜）」然后 break，**没有任何收尾语句**
  // （MonsterSpecific.cpp:944-954），与抢劫者逐字相同。
  // ⚠ 这一格正是第十五批那条盲区的关门点：抢劫者单挑时逃跑当场判胜，`doMonsterTurn` 的
  //   「结局已定就直接返回」抢在收尾之前，于是 `"none"` 与 `"roll"` 分不开。
  //   `TWO_THIEVES` 里两只贼互为同伴，先逃的那只不会结束战斗，这一格第一次可观察。
  "mugger/flee": "none",

  // —— 带壳寄生虫（第二十五批）：四条 case 里只有眩晕不是默认的 `roll` ——
  //
  // 双重打击 / 重击 / 吸取三条都是 `addToBot(Actions::RollMove(idx))`
  // （MonsterSpecific.cpp:1074 / :1080 / :1090），即默认值，不写进表里。
  //
  // 眩晕：整条 case 是 `setMove(MMID::SHELLED_PARASITE_FELL); rollMove(bc);`
  // （MonsterSpecific.cpp:1083-1086），两句都是**同步**的，所以它是第五形态（任意函数）。
  // ⚠⚠ 这是**第一次**出现「同步的真 rollMove」：
  //  ① `setMove` 与 `rollMove` **都**前移 moveHistory，所以一次眩晕推两格历史
  //     （`[眩晕, 上一招]` → `[重击, 眩晕]` → `[新意图, 重击]`）；
  //  ② `rollMove` 是**真的滚一个新意图**（消耗一次 `aiRng.random(99)`，还可能在
  //     `getMoveForRoll` 里再追加一次），不是 `no_op_roll` 那种掷完丢掉；
  //  ③ 顺序照抄且**这里的顺序真的可观察**：先 `setMove(重击)` 让 `lastMove` 变成重击，
  //     紧接着的 `getMoveForRoll` 才读到它——于是「roll < 20 且刚重击过」那一支被点亮
  //     （壳破之后不会立刻再来一次重击）。反过来写就没有这个效果。
  //     这与球状守卫者 / 拜鸟那种「setMove + noOpRollMove」形状相似但语义完全不同，别照搬。
  //  ④ 它是**同步**的，所以跑在本回合排的动作**执行之前**——但眩晕这条 case 一个效果都没有，
  //     队列里本来就是空的。
  "shelled_parasite/stunned": (bc, m) => {
    setMove(m, "fell");
    rollMove(bc, m); // ★ 消耗一次 aiRng（真 rollMove，不是 no_op；getMoveForRoll 还可能再追加一次）
  },

  // —— 史尼克（第二十五批）：三条 case 的收尾全是默认的 `roll` ——
  //
  // 撕咬 / 惑目 / 尾击都以 `addToBot(Actions::RollMove(idx))` 结尾
  // （MonsterSpecific.cpp:1147 / :1152 / :1162），也就是这张表的默认值。
  // 写进来反而多一份可以抄错的真相，所以留空（与第二十三批选民 / 食蛇草同理）。

  // —— 百夫长 + 秘法师（第二十六批）：**「照顾友军」的三招都是同步的真 rollMove** ——
  //
  // 两只攻击招（`CENTURION_SLASH` / `CENTURION_FURY` / `MYSTIC_ATTACK_DEBUFF`）都是
  // `addToBot(Actions::RollMove(idx))`（MonsterSpecific.cpp:573 / :578 / :584），
  // 即这张表的默认值，不写进来。
  //
  // 而防守 / 治疗 / 鼓舞三条 case 的最后一句都是裸的 `rollMove(bc);`
  // （MonsterSpecific.cpp:567 / :596 / :606）——与带壳寄生虫的眩晕同族的**第六形态**：
  // 同步的**真** rollMove（掷一次 `aiRng.random(99)` 并真的选出新意图），
  // 不是 `noOpRollMove` 那种掷完丢掉，也不是入队的 `Actions::RollMove`。
  // ⚠⚠ **被钉住的是「效果排在 rollMove 之前」这个相对顺序，不是「同步 vs 入队」这个标签。**
  //   实测（第二十六批）：把这三条收尾从同步改成入队的 `"roll"` 是 **0 例**——**等价改写**。
  //   原因：怪物回合是「队列排空了才开始」的（`executeActions` 里 `doMonsterTurn` 的前提），
  //   而这三条 case 的效果**全是同步的**，所以轮到收尾时队列本来就是空的，入队即刻出队。
  //   反过来，把**治疗**改成入队、收尾仍同步，红 **79 例**：那样 rollMove 会读到治疗
  //   **之前**的血量，而秘法师的 `getMoveForRoll` 正是读「自己或 0 号位缺了多少血」
  //   ——刚治完还会再强制治疗一次。所以形状照抄仍然重要，只是可观察面在相对顺序上。
  // ⚠ 与眩晕那条的差别：眩晕是 `setMove(FELL); rollMove(bc);` 两句（一次推两格历史），
  //   这三条**只有** `rollMove(bc)` 一句。别照搬邻居。
  "centurion/cent_defend": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove，不是 no_op）
  },
  "mystic/mystic_heal": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },
  "mystic/mystic_buff": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },

  // —— 第二十七批 ——
  //
  // 地精首领三条 case 的收尾都是**裸的 `addToBot(Actions::RollMove(idx))`**
  //（MonsterSpecific.cpp:726 / :732 / :738），也就是这张表的默认值 `"roll"`，不写进来。
  //
  // 工头：⚠⚠ 收尾是**同步的** `bc.noOpRollMove()`（MonsterSpecific.cpp:1247），
  // 不是入队的 `Actions::NoOpRollMove()`——所以它是第五形态（任意函数），
  // 不能写成这张表的 `"no_op_roll"`（那一支是入队的）。
  // ⚠ **这里的「同步 vs 入队」真的可观察，不是等价改写。** 判据是 WORKFLOW 第二十六批那条
  //   反过来用：这条 case 的效果**全是入队的**（伤害与塞伤口都是 `addToBot`），所以轮到收尾
  //   时队列里还压着东西。抽打打死玩家 → `executeActions` 跳出主循环 → 入队的那次 noOp
  //   **永远轮不到**，而同步的那次已经掷过了。写错就是 `rng.ai` 计数器对不上。
  //   （拉加维林那两条同步 `noOpRollMove` 之所以只红 8~11 例，正是因为它们那几条 case
  //   的效果同样是入队的、但那只怪打不死人得那么快。）
  "taskmaster/scouring_whip": (bc) => {
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**，意图不变）
  },

  // —— 第二十八批 ——
  //
  // 突刺之书两条 case 的收尾都是**裸的 `addToBot(Actions::RollMove(idx))`**
  //（MonsterSpecific.cpp:459 / :464），也就是这张表的默认值 `"roll"`，不写进来。
  //
  // —— 青铜自动机（第二十八批）：五条 case 的收尾**逐字同形**，与球状守卫者同族 ——
  //
  //     setMove(下一招);        // 同步，快照里意图当场就变
  //     bc.noOpRollMove();      // **同步**（不是 addToBot(NoOpRollMove())），照掷一次 aiRng
  //
  // （MonsterSpecific.cpp:471-511，五条 case 各两句。）所以全是第五形态（任意函数）。
  // ⚠ 于是这只 300 血的 Boss 的意图序列**完全钉死、一次 roll 都不看**：
  //     召唤 → 连枷 → 增益 → 连枷 → 增益 → 超射线 → 眩晕 → 连枷 → 增益 → 连枷 → 增益 → 超射线 → …
  //   而 `rng.ai` 每个怪物回合恰好 +1（开局那次 rollMove 也 +1）。次数抄错当场落在计数器上。
  //
  // ⚠⚠ 分岔靠 **`miscInfo`**，参考在增益那条 case 里把它绑成
  //   `auto &lastBoostWasFlail = miscInfo;`（`:474`）——**这是 `miscInfo` 的第 N 种含义**。
  //   到本批为止同一个字段同时是：虱子的咬击伤害、红奴隶主的 `usedEntangle`、地精巫师的
  //   蓄力位、守卫者的模式切换阈值、六火幽魂的每击伤害（`deal_damage_rolled`）、
  //   **突刺之书的乱刺段数**、**青铜球的「已用过停滞」**、**青铜自动机的「上次增益之后出的是
  //   连枷吗」**。八种含义、一个字段——这正是参考的形状（Monster.h:66-81 那串注释），
  //   所以不要按用途拆字段（第十六批已经把拆开的那次改回来过一遍）。
  //
  // ⚠ 增益那条的**顺序**照抄：先判 `lastBoostWasFlail`、再翻转它、再 setMove、最后 noOpRollMove。
  //   翻转与 setMove 在参考里是同一个 if/else 的两句（`:475-481`）。
  "bronze_automaton/boost": (bc, m) => {
    if (m.miscInfo) {
      setMove(m, "hyperbeam");
      m.miscInfo = 0;
    } else {
      setMove(m, "flail");
      m.miscInfo = 1;
    }
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  "bronze_automaton/flail": (bc, m) => {
    setMove(m, "boost");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  // 超射线：⚠ asc19 **不进眩晕**，直接回增益（MonsterSpecific.cpp:494-498）。
  //   当前 trace 全是 asc0，那一支走不到但照抄（与地精巫师 asc17 那条同族）。
  "bronze_automaton/hyperbeam": (bc, m) => {
    setMove(m, bc.ascension >= 19 ? "boost" : "stunned");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  "bronze_automaton/spawn_orbs": (bc, m) => {
    setMove(m, "flail");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },
  // 眩晕：整条 case 就这两句，一个效果都没有（MonsterSpecific.cpp:508-511）。
  "bronze_automaton/stunned": (bc, m) => {
    setMove(m, "flail");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，同步）
  },

  // —— 青铜球（第二十八批）：三条 case 的收尾**三种形态各占一条** ——
  //
  // 光束   `addToBot(Actions::RollMove(idx))`（MonsterSpecific.cpp:515）→ 默认值，不写进来。
  // 停滞   `miscInfo = 1; rollMove(bc);`（`:520-521`）——**同步的真 rollMove**。
  // 支援   `rollMove(bc);`（`:526`）——同样是**同步的真 rollMove**。
  //
  // ⚠ 「同步的真 rollMove」与 `no_op_roll` 的差别：它**真的滚一个新意图**并前移 moveHistory，
  //   所以下一回合出什么当场就定了、且能被 `lastTwoMoves` 看见。与秘法师那三条同族。
  // ⚠ 停滞那条的两句**顺序可观察**：`miscInfo = 1` 必须排在 `rollMove` **之前**，
  //   否则紧接着的 `getMoveForRoll` 会读到 `haveUsedStasis == 0`、有 75% 概率再出一次停滞。
  "bronze_orb/stasis": (bc, m) => {
    m.miscInfo = 1; // ★ 「已经用过停滞」——必须在 rollMove 之前置上
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },
  "bronze_orb/orb_support": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },

  // —— 第二十九批 ——
  //
  // 冠军：**七条 case 分两族**（MonsterSpecific.cpp:1251-1307），照抄别统一：
  //   入队 `addToBot(Actions::RollMove(idx))` —— 处决 / 扇脸 / 重斩（= 这张表的默认值 `"roll"`，
  //                                             不写进来）；
  //   **同步的真 `rollMove(bc)`**            —— 暴怒 / 防御姿态 / 自夸 / 嘲讽（下面四条）。
  // ⚠ 分族的判据不是「攻击 vs 非攻击」这个直觉，而是参考那四条 case 的最后一句真的写的是
  //   裸的 `rollMove(bc);`（`:1255` / `:1270` / `:1291` / `:1305`）。与第二十六批的
  //   秘法师三招、第二十八批的青铜球两招同族（第六形态：同步的真 rollMove）。
  // ⚠ 这四条 case 的效果**全是同步的**（加力量 / 加格挡 / 清减益 / 上减益都没有 addToBot），
  //   所以按第二十六批那条判据，「同步 ↔ 入队」在这四条上预期是**等价改写**——
  //   被钉住的是「效果排在 rollMove 之前」这个相对顺序。⚠ 而这里的相对顺序**真的可观察**：
  //   暴怒把二阶段标志置上之后才 rollMove，而防御姿态那条 case 之后的 rollMove 会读到
  //   刚 +1 的已用次数（`miscInfo & 0x3`）。
  "champ/anger": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },
  "champ/champ_defend": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },
  "champ/gloat": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },
  "champ/taunt": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },

  // 收藏家四条 case 的收尾**全是**入队的 `addToBot(Actions::RollMove(idx))`
  //（MonsterSpecific.cpp:1322 / :1328 / :1336 / :1340），也就是这张表的默认值，不写进来。
  // ⚠ 召唤那条是 `addToBot(SpawnTorchHeads()); addToBot(RollMove(idx));` 两条紧挨着入队
  //   ——所以下一次 `getMoveForRoll` 必然看到**已经填满的** `monstersAlive == 3`，
  //   于是它的 `canUseSpawn` 恒假，`!lastMove(SPAWN)` 那一半在这条路上永远用不上
  //   （与第二十七批地精首领的集结同构，那边两个 `lastMove(RALLY)` 分支整支是死代码）。
  //   ⚠ 差别在于收藏家这条的 `monstersAlive < 3` 之后**还会**再有机会为真（火炬头被打死），
  //   所以召唤本身不是死代码，只有「刚召唤过」那一半的**独立作用**量不出来。

  // 火炬头的冲撞：整条 case 就是 `attackPlayerHelper(bc, 7);` + `break`
  //（MonsterSpecific.cpp:1388-1390）——**什么收尾都没有**，第四形态。
  // ⚠ 于是它一辈子只出这一招、召唤之后再也不碰 aiRng。写成 `"no_op_roll"` 会让每个
  //   火炬头每回合多掷一次 `aiRng.random(99)`，`rng.ai` 计数器当场对不上。
  // ⚠ 参考的 `getMoveForRoll` 对它返回 `INVALID`（见 `MOVE_RULES.torch_head`），
  //   所以写成 `"roll"` 不只是多掷一次，还会把意图打成一个不存在的招式。
  "torch_head/torch_tackle": "none",

  // —— 第三十二批：三只「形状怪」——
  //
  // 六条 case 里有四条不是默认的 `roll`，而且**三只怪各用一种形态**，照抄别统一。
  //
  // 撞击（爆破怪，MonsterSpecific.cpp:1400-1408）：
  //     attackPlayerHelper(bc, asc2 ? 11 : 9);
  //     if (lastTwoMoves(EXPLODER_SLAM)) { setMove(EXPLODER_EXPLODE); }
  //     else                             { setMove(EXPLODER_SLAM); }
  //     bc.noOpRollMove();
  // ⚠ 四处照抄：
  //  ①⚠⚠ **判据是 `lastTwoMoves(SLAM)`，读的是「已经连撞两次了吗」**。此刻 `moveHistory[0]`
  //     就是正在执行的这一撞，`[1]` 是上一撞——所以第二次撞击时它为真、当场改成自爆，
  //     于是链条是「撞、撞、爆」（与真实游戏的三回合倒计时一致）。
  //     ⚠ 抄成 `lastMove(SLAM)` 会让它第一次撞完就准备自爆（早一回合）。
  //  ② `setMove` 与 `noOpRollMove` **都是同步的**（`bc.noOpRollMove()` 是裸调用，
  //     不是 `addToBot(Actions::NoOpRollMove())`），所以这是第五形态（任意函数）。
  //  ③⚠⚠ **「效果入队 + 收尾同步」这个组合真的可观察**（第二十七批工头那条的同族）：
  //     攻击是 `addToBot`，收尾却已经跑完了。这一撞若打死玩家，主循环跳出，
  //     而同步那次 `noOpRollMove` 已经掷过——写成入队的 `"no_op_roll"` 会少掷一次 aiRng。
  //  ④ 无论走哪一支都**照掷一次** `aiRng.random(99)` 并丢掉：意图已经由 setMove 定死了。
  "exploder/exp_slam": (bc, m) => {
    if (lastTwoMoves(m, "exp_slam")) {
      setMove(m, "exp_explode");
    } else {
      setMove(m, "exp_slam");
    }
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**，意图不变）
  },
  // 自爆（爆破怪，MonsterSpecific.cpp:1394-1398）：两条效果入队之后同样是**同步**的
  // `bc.noOpRollMove()`。⚠ 它在自爆那一回合仍然要掷——参考没有为「反正要死了」开特例，
  // 而这一位是可观察的：30 点伤害若打死玩家，主循环跳出、入队的自杀动作永远轮不到，
  // 但这次 aiRng 已经掷过了。
  "exploder/exp_explode": (bc) => {
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**）
  },

  // 斥力（斥力怪，MonsterSpecific.cpp:1415-1418）：整条 case 是
  //     Actions::ShuffleTempCardIntoDrawPile(CardId::DAZED, 2).actFunc(bc);
  //     rollMove(bc);
  // 两句都**同步**，所以收尾是第六形态（同步的真 rollMove）——与秘法师三招、青铜球两招同族。
  // ⚠ 顺序可观察：两张恍惚**先**洗进抽牌堆（消耗两次 cardRandomRng），rollMove 才掷 aiRng。
  //   两条流不同、交错顺序对取值无影响，但 `rollMove` 之后 `moveHistory` 会前移，
  //   而斥力怪的出招规则读 `lastMove` —— 顺序颠倒不改结果，形状照抄。
  // ⚠ 撞击那条是裸的 `addToBot(Actions::RollMove(idx))`（`:1412`），即默认值，不写进来。
  "repulsor/repulse": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove，不是 no_op）
  },

  // 增生尖刺（尖刺客，MonsterSpecific.cpp:1425-1429）：整条 case 是
  //     ++miscInfo;            // ← 在 MOVE_TURN_BEGIN 里
  //     buff<MS::THORNS>(2);   // ← 数据表里的 apply_power（同步）
  //     rollMove(bc);
  // 同样是第六形态。⚠⚠ **三句的顺序真的可观察**：`++miscInfo` 必须排在 `rollMove` **之前**，
  //   因为紧接着的 `getMoveForRoll` 读的正是 `miscInfo > 5`（放满六次之后只切割）。
  //   把计数挪到收尾之后，封顶会晚一整回合、荆棘多涨 2 层。
  // ⚠ 切割那条是裸的 `addToBot(Actions::RollMove(idx))`（`:1422`），即默认值，不写进来。
  "spiker/spk_spike": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },

  // —— 第三十三批：三只第三幕单怪 ——
  //
  // 暗球游荡者（激光 / 利爪）与尖塔增生（急冲 / 重砸 / 缠绕）**五条 case 的收尾全是**
  // 裸的 `addToBot(Actions::RollMove(idx))`（MonsterSpecific.cpp:992 / :999 /
  // :1505 / :1510 / :1515），即这张表的默认值 `"roll"`，所以两只怪一条都不写进来。
  //
  // 大嘴不同：四条 case **三种形态并存**（MonsterSpecific.cpp:1434-1457），照抄别统一。
  //   咆哮   `rollMove(bc);`                      —— 第六形态：**同步的真 rollMove**（`:1452`）
  //   流涎   `rollMove(bc);`                      —— 同上（`:1436`）
  //   吞噬   `setMove(DROOL); bc.noOpRollMove();` —— 第五形态：同步 setMove + **同步** noOp
  //   重击   `addToBot(Actions::RollMove(idx));`  —— 默认值 `"roll"`，不写进来（`:1456`）

  // 咆哮：整条 case 是「两句同步 debuff + 同步 rollMove」（MonsterSpecific.cpp:1447-1453）。
  // ⚠ 顺序可观察：两个减益**先**上身，紧接着的 `getMoveForRoll` 才跑——不过大嘴的出招规则
  //   不读玩家状态，所以这一处目前观察不到；形状照抄。
  "the_maw/maw_roar": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove，不是 no_op）
  },
  // 流涎：`buff<MS::STRENGTH>(asc17 ? 5 : 3); rollMove(bc);`（MonsterSpecific.cpp:1434-1437）。
  // ⚠ 力量是**同步**加的（`on: "self"` 的默认），排在 rollMove 之前——但出招规则同样不读力量。
  "the_maw/maw_drool": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },
  // 吞噬：`setMove(MMID::THE_MAW_DROOL); bc.noOpRollMove();`（MonsterSpecific.cpp:1442-1443）。
  // ⚠⚠ **这是「同步 setMove + 同步 noOpRollMove」那一族**（与球状守卫者 / 拜鸟 / 青铜自动机
  //   同形），不是第六形态：`noOpRollMove` 掷完就丢，意图由前一句写死成流涎。
  //   写成 `"roll"` 会让流涎失去它唯一的强制来源、意图链整个走样；写成 `{setMove:"maw_drool"}`
  //   则会少掷一次 aiRng，`rng.ai` 计数器当场对不上。
  // ⚠ **「效果入队 + 收尾同步」这个组合真的可观察**（工头 / 爆破怪那一族）：吞噬的伤害是
  //   `addToBot`，而这两句已经跑完。这一轮若打死玩家，主循环跳出，但 aiRng 已经掷过。
  "the_maw/maw_nom": (bc, m) => {
    setMove(m, "maw_drool");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**，意图不变）
  },

  // —— 第三十四批：暗影客与复形怪 ——
  //
  // 暗影客五条 case 里**三条**不是默认值（MonsterSpecific.cpp:1461-1499）：
  //   啃食 / 撕咬  `addToBot(Actions::RollMove(idx));` —— 默认值 `"roll"`，不写进来
  //   硬化         `rollMove(bc);`                     —— 第六形态：**同步的真 rollMove**
  //   重生         `rollMove(bc);`                     —— 同上
  //   复活         `rollMove(bc);`                     —— 同上
  //
  // ⚠⚠ 后三条**必须是同步**的，而且**顺序真的可观察**：
  //   * 硬化那条：`addBlock(12)` 与 asc17 的力量都是同步的，rollMove 在它们之后；
  //   * 复活那条：`curHp = maxHp/2; halfDead = false; ++monstersAlive; buff<REGROW>()`
  //     全部同步，**紧接着**的 `getMoveForRoll` 读的正是 `halfDead`——
  //     写成入队的 `"roll"`，出队时 `halfDead` 已经是 false，本来也一样；
  //     但写成 `{setMove: …}` 会少掷一次 aiRng，`rng.ai` 计数器当场对不上。
  //   * 重生那条：case 体是空的（参考写着 `// do nothing`），收尾就是它的全部。
  //     此刻 `halfDead` 仍为真，所以这次 rollMove 必然滚出「复活」。
  "darkling/darkling_harden": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove；暗影客的规则内还可能追加）
  },
  "darkling/darkling_regrow": (bc, m) => {
    rollMove(bc, m); // ★ 同上——此刻 halfDead 仍为真，必然滚出「复活」
  },
  "darkling/darkling_reincarnate": (bc, m) => {
    rollMove(bc, m); // ★ 同上——此刻 halfDead 已被效果置回 false，走正常 roll 分支
  },

  // 复形怪的重殴（MonsterSpecific.cpp:1520-1530）：效果之后还有**两句同步语句**，
  // 静态形态一个都表达不了，所以走第五形态（任意函数）。
  //     bc.noOpRollMove();               // ← 掷一次 aiRng 丢掉，意图不动
  //     decrementStatus<MS::FADING>();   // ← **排在 noOpRollMove 之后**
  // ⚠ 四处照抄：
  //  ①⚠⚠ **「效果入队 + 收尾同步」这个组合真的可观察**（工头 / 爆破怪 / 大嘴那一族）：
  //     攻击与自杀都是 `addToBot`，而这两句已经跑完。这一击若打死玩家，主循环跳出、
  //     入队的自杀永远轮不到，但 aiRng 已经掷过、消逝也已经减过。
  //     ⚠ 复形怪的伤害 30/40/50/60/70 一路涨，**玩家阵亡是常态**，所以这一位分母很厚。
  //  ② `noOpRollMove` 是**裸调用**（不是 `addToBot(Actions::NoOpRollMove())`），
  //     所以不能写成 `"no_op_roll"`（那是入队版）。
  //  ③ 递减用的是 `decrementStatus<MS::FADING>()`：FADING 的枚举值落在
  //     `WEAK < s <= TIME_WARP` 这一段（`uniquePower0` 后端），语义是
  //     `uniquePower0 -= 1; if (uniquePower0 == 0) setHasStatus(false);`
  //     ——归零时**连条目一起摘掉**（与镀甲同族、与飞行那种裸 `setStatus` 正相反）。
  //     所以最后一次出手之后快照里就没有 FADING 了。
  //  ④ **两句的顺序**照抄：先掷后减。当前不可观察（noOp 不读消逝），但形状照抄。
  "transient/transient_slam": (bc, m) => {
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**，意图不变）
    const fading = findPower(m.powers, "fading");
    if (fading !== undefined) {
      fading.amount -= 1;
      if (fading.amount === 0) {
        m.powers.splice(m.powers.indexOf(fading), 1);
      }
    }
  },

  // —— 第三十五批：蠕动血块与巨头 ——
  //
  // 蠕动血块五条 case 里只有**一条**不是默认值（MonsterSpecific.cpp:1534-1565）：
  //   挥击 / 乱抽 / 重抽 / 萎缩  `addToBot(Actions::RollMove(idx));` —— 默认 `"roll"`，不写进来
  //   植入                        `rollMove(bc);`                     —— 第六形态：**同步的真 rollMove**
  //
  // ⚠⚠ 植入那条**必须是同步**，而且**必须排在 `miscInfo = true` 之后**：紧接着的
  //   `getMoveForRoll` 读的正是 `haveUsedImplant = miscInfo`。写成入队的 `"roll"` 在
  //   当前形状下取值相同（出队时 miscInfo 已经是 1），但那条 case **没有排任何队列动作**，
  //   所以「同步 ↔ 入队」在这里属于第二十六批那条判据说的**等价改写**——照抄参考。
  //   ⚠ 写成 `{setMove: …}` 则会少掷一次 aiRng，`rng.ai` 计数器当场对不上。
  "writhing_mass/wm_implant": (bc, m) => {
    rollMove(bc, m); // ★ 消耗至少一次 aiRng（同步的真 rollMove，不是 no_op）
  },

  // 巨头三条 case 的收尾**三种形态并存**（MonsterSpecific.cpp:1567-1583）：
  //   数数        `addToBot(Actions::RollMove(idx));` —— 默认 `"roll"`，不写进来
  //   凝视        `rollMove(bc);`                     —— 第六形态：**同步的真 rollMove**
  //   时候到了    `bc.noOpRollMove();`                —— **同步**的 noOpRollMove
  //
  // ⚠ 凝视那条：虚弱是同步施加的（`sync: true`），排在 rollMove 之前——但出招规则不读玩家
  //   状态，所以顺序当前不可观察；照抄。
  "giant_head/gh_glare": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },
  // ⚠⚠ 「时候到了」用的是 `noOpRollMove` 而不是 `RollMove`：掷一次 aiRng 就丢、**意图不变**。
  //   配合出招规则那道 `getMonsterTurnNumber() >= 4`，效果是**这一招一旦出场就再也不换**
  //   ——巨头从第 4 个怪物回合起每回合都砸，伤害 25 / 30 / 35 …一路涨到 60 封顶。
  //   写成 `"roll"` 表面上也永远滚到「时候到了」（那道门恒成立），但 `moveHistory` 会被
  //   一路前移，而且它是**入队**的——这一击若打死玩家，主循环跳出、那次掷骰就永远不发生，
  //   `rng.ai` 计数器当场对不上（「效果入队 + 收尾同步」那一族，工头 / 复形怪同理）。
  "giant_head/gh_it_is_time": (bc) => {
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**，意图不变）
  },

  // —— 第三十六批：复仇魔 / 蜥蜴法师 / 匕首 ——
  //
  // ⚠⚠ **复仇魔三条 case 的收尾全都不是默认值，而且三条的形状两两不同**
  //（MonsterSpecific.cpp:1585-1607）。差别全在「虚无缥缈那一句怎么排」：
  //
  //   多重打击 / 巨镰                          灼烧诅咒
  //   ------------------------------------     ------------------------------------
  //   attackPlayerHelper(...)   ← 入队伤害      MakeTempCardInDiscard(...).actFunc(bc) ← **同步**
  //   addToBot(RollMove(idx))   ← **入队**      rollMove(bc)                            ← **同步的真 roll**
  //   if (!hasStatus<INTANGIBLE>())             if (!hasStatus<INTANGIBLE>())
  //       addToBot(BuffEnemy<INTANGIBLE>(2))        buff<INTANGIBLE>(2)                 ← **同步**
  //
  // ⚠ 五处照抄：
  //  ①⚠⚠ **那道 `if` 判在 takeTurn 里、也就是排队的那一刻**（不是出队时）——三条都一样。
  //     写成「出队时再判」会在同一回合里被别的动作改写掉 statusBits 时分岔。
  //  ②⚠⚠ **虚无缥缈那条动作排在 RollMove 之后**（不是之前）：于是下一次
  //     `getMoveForRoll` 跑在补层之前。当前出招规则不读虚无缥缈，所以顺序不可观察；照抄。
  //  ③ 攻击那两条的 buff 是**入队**的 `Actions::BuffEnemy`，所以攻击若打死玩家、主循环
  //     跳出，这一层就**永远补不上**——「效果入队 + 收尾入队」，两者一起被跳过。
  //  ④ 灼烧诅咒整条 case **一个 addToBot 都没有**（塞牌是 `.actFunc(bc)`），所以它的
  //     「同步 vs 入队」按第二十六批那条判据属于**等价改写**；但 rollMove 是**真 roll**
  //     （第六形态），写成 `"no_op_roll"` 会让意图不变、写成 `{setMove}` 会少掷一次 aiRng。
  //  ⑤⚠ 门是 `hasStatus`（条目在不在），不是层数 > 0。虚无缥缈的层数在回合末
  //     `decrementStatus` 归零时**连条目一起摘掉**（见 `applyMonsterEndOfTurnTriggers`），
  //     所以两者当前同解——但形状照抄，别写成 `getPower(...) > 0`。
  //  ⚠ 净效果：2 层 → 回合末减到 1 → 下一个玩家回合仍然无敌 → 那个怪物回合不补层 →
  //    回合末减到 0（条目消失）→ 再下一个玩家回合正常吃伤害。这就是「隔回合无敌」。
  "nemesis/nem_attack": (bc, m) => {
    const idx = bc.monsters.indexOf(m);
    addToBot(bc, (c) => {
      rollMove(c, m);
    });
    if (!hasPower(m.powers, "intangible")) {
      addToBot(bc, (c) => {
        buffEnemy(c, idx, "intangible", 2);
      });
    }
  },
  "nemesis/nem_scythe": (bc, m) => {
    const idx = bc.monsters.indexOf(m);
    addToBot(bc, (c) => {
      rollMove(c, m);
    });
    if (!hasPower(m.powers, "intangible")) {
      addToBot(bc, (c) => {
        buffEnemy(c, idx, "intangible", 2);
      });
    }
  },
  "nemesis/nem_debuff": (bc, m) => {
    rollMove(bc, m); // ★ 消耗至少一次 aiRng（同步的真 rollMove）
    if (!hasPower(m.powers, "intangible")) {
      addPower(m.powers, "intangible", 2); // 同步 buff，排在 rollMove 之后
    }
  },

  // 蜥蜴法师：三条 case 里只有**召唤**不是默认值（MonsterSpecific.cpp:1609-1623）：
  //   巨口 / 毒牙   `addToBot(Actions::RollMove(idx));` —— 默认 `"roll"`，不写进来
  //   召唤          `rollMove(bc);`                     —— 第六形态：**同步的真 rollMove**
  //
  // ⚠⚠ 这一条的「同步」**真的可观察**，与秘法师治疗那条同族：召唤本身是同步的，
  //   它当场把 `monstersAlive` 加了 1，而紧接着这次 `getMoveForRoll` 里的
  //   `canSpawn = monstersAlive < 4` 读的正是**加过之后**的值。写成入队的 `"roll"`
  //   在当前形状下取值相同（召唤也是同步的，早就跑完了），但形状照抄。
  "reptomancer/summon_daggers": (bc, m) => {
    rollMove(bc, m); // ★ 消耗至少一次 aiRng（同步的真 rollMove）
  },

  // 匕首两条 case 的收尾（MonsterSpecific.cpp:1625-1636）：
  //   突刺  `setMove(DAGGER_EXPLODE); bc.noOpRollMove();`  —— 同步 setMove + **同步** noOp
  //   自爆  `bc.noOpRollMove();`                           —— **同步** noOp，意图不变
  //
  // ⚠ 三处照抄：
  //  ① 突刺那条与球状守卫者 / 青铜自动机同形（第五形态：两件事都做）——`{setMove}` 不掷
  //     aiRng、`"no_op_roll"` 不改意图，静态形态一个都表达不了。
  //  ② **两条都是同步的 `bc.noOpRollMove()`**，而它们的效果**全是入队的**——正是第二十七批
  //     工头那条判据说的「效果入队 + 收尾同步」组合：自爆打 25 点，打死玩家时主循环跳出，
  //     入队的伤害与自杀都还没跑完，但这次掷骰**已经发生**。写成入队版会让 `rng.ai` 对不上。
  //  ③ 自爆那条**不改意图**（noOp 掷完就丢）：匕首自杀之后不会再行动，所以意图停在自爆上，
  //     这一点在快照里看得到（尸体的 move 仍是 `dagger_explode`）。
  "dagger/dagger_stab": (bc, m) => {
    setMove(m, "dagger_explode");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**）
  },
  "dagger/dagger_explode": (bc) => {
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**，意图不变）
  },

  // —— 第三十七批：觉醒者 ——
  //
  // 六条 case 里只有**重生**不是默认值（MonsterSpecific.cpp:1702-1759）：
  //   斩击 / 灵魂打击 / 黑暗回响 / 污泥 / 冲撞  `addToBot(Actions::RollMove(idx));` —— 默认 `"roll"`
  //   重生                                       `setMove(DARK_ECHO); bc.noOpRollMove();`
  //
  // ⚠ 四处照抄：
  //  ① 第五形态（两件事都做）：与球状守卫者 / 青铜自动机 / 匕首的突刺同形——
  //     `{setMove: …}` 不掷 aiRng、`"no_op_roll"` 不改意图，静态形态一个都表达不了。
  //  ② **两句都是同步的**，而重生那条 case 的效果**也全是同步的**（七句状态机里
  //     一个 `addToBot` 都没有）。按第二十六批那条判据，这里的「同步 ↔ 入队」属于
  //     **等价改写**——但顺序照抄：`setMove` 排在 `noOpRollMove` 之前。
  //  ③ ⚠⚠ **`setMove` 前移历史**（`moveHistory[1] = moveHistory[0]`），所以复活之后
  //     那一格里躺着的是「重生」，上上格是死之前的最后一个意图。二阶段第一次真正 roll
  //     发生在黑暗回响打完之后，那时 `lastTwoMoves(SLUDGE)` / `(TACKLE)` 读到的正是
  //     「黑暗回响 + 重生」——两条都不满足，所以二阶段第二招按 roll 自由二选一。
  //  ④ `noOpRollMove` 掷完就丢：这一次不改意图，黑暗回响就此钉死为下一个怪物回合的招式。
  "awakened_one/rebirth": (bc, m) => {
    setMove(m, "dark_echo");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**，意图不变）
  },

  // —— 第三十八批：时间吞噬者 ——
  //
  // 四条 case **两种形态并存**（MonsterSpecific.cpp:1638-1671），照抄别统一：
  //   混响 / 头槌   `addToBot(Actions::RollMove(idx));` —— 默认值 `"roll"`，不写进来
  //   涟漪 / 加速   `rollMove(bc);`                     —— 第六形态：**同步的真 rollMove**
  //
  // ⚠ 判据仍是那句老话：**照着 case 从上到下读**——分界不在「这一招打不打人」上
  //   （混响与头槌都入队 RollMove，而涟漪与加速都同步），而在参考写了哪一句。
  // ⚠ 两条同步收尾都是**真** rollMove（掷 `aiRng.random(99)` 并选新意图，出招规则里
  //   还可能再追加 1 次），不是 `noOpRollMove` 那种掷完丢掉。
  //
  // 涟漪：整条 case 是「同步加格挡 + 三句同步 debuff + 同步 rollMove」。
  // ⚠ 顺序可观察性：加格挡与减益都排在 rollMove **之前**，而时间吞噬者的出招规则
  //   不读玩家状态、也不读自己的格挡——所以这一处当前观察不到；形状照抄。
  "time_eater/te_ripple": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove，不是 no_op）
  },
  // 加速：整条 case 是「置锁存位 + 抬血到半血 + (asc19 格挡) + 清减益 + 同步 rollMove」。
  // ⚠⚠ **这里的顺序真的可观察**：紧接着的 `getMoveForRoll` 读的正是刚被置起的 `miscInfo`
  //   （`usedHaste`）与刚被抬到 `maxHp/2` 的 `curHp`（`underHalfHp`）。两个字段都在
  //   「加速那道门」上，所以把 rollMove 提到效果之前会让加速**当场再滚出一次自己**、
  //   下一个怪物回合再加速一遍（血量会被反复压回半血）。
  "time_eater/haste": (bc, m) => {
    rollMove(bc, m); // ★ 消耗一次 aiRng（同步的真 rollMove）
  },

  // —— 第三十九批：迪卡与多努，四条 case 全是**同步 setMove**（MonsterSpecific.cpp:
  //   1672-1700）——整个编队从开局那次 rollMove 之后**再也不掷一次 aiRng**。
  //
  // ⚠⚠ 这是本项目**唯一**一个「全员静态循环」的编队：四条收尾都是第一形态
  //   （`{ setMove }`，同步、不掷 aiRng），既没有 `RollMove` 也没有 `NoOpRollMove`。
  //   最像的先例是酸液史莱姆（小）的「舔舐 ↔ 冲撞」，但那只怪是编队里的一员，
  //   这里是整场仗。⚠ 后果之一是 `rng.ai` 计数器在这个编队里**恒是 2**（开局两次 rollMove），
  //   所以任何一条收尾抄成 `no_op_roll` 都会当场被计数器抓住。
  // ⚠ 两条链是**互相错开**的：迪卡「光束 → 守护 → 光束…」、多努「能量之环 → 光束 →
  //   能量之环…」，于是每个怪物回合恰好是「一攻一辅」，玩家永远同时挨一次 20 点双击
  //   与一次 16 格挡或 +3 力量。抄成同相位（比如两只都从光束起步）会让伤害分布整个变形。
  "deca/deca_beam": { setMove: "square_of_protection" },
  "deca/square_of_protection": { setMove: "deca_beam" },
  "donu/donu_beam": { setMove: "circle_of_power" },
  "donu/circle_of_power": { setMove: "donu_beam" },

  // —— 第四十七批乙：第四幕的两只（尖塔护盾 / 尖塔长矛）——
  //
  // 六条 case **两种形态并存**（MonsterSpecific.cpp:1761-1826），照抄别统一：
  //   猛击 / 加固 / 灼烧打击 / 穿刺   条件 `setMove` + **同步** `bc.noOpRollMove()`
  //                                   —— 第五形态（两件事都做），静态形态一个都表达不了
  //   重砸 / 贯穿                     `addToBot(Actions::RollMove(idx));` —— 默认 `"roll"`，不写进来
  //
  // ⚠⚠ **两只怪的条件长得像，其实不一样，这是本批最容易抄串的一处**：
  //   护盾是 `lastMoveBefore(SMASH) || lastMoveBefore(INVALID)`（**两个析取项**），
  //   长矛是 `lastMoveBefore(SKEWER)`（**一个**）。差别在于护盾要处理「第二次出手时
  //   上上格还是空的」那一帧——那一帧长矛不需要，因为它的首招被 `firstTurn()` 钉死成
  //   灼烧打击、第二次出手时上上格必然已经写过。
  // ⚠ 两条真侧的 `setMove` 也不同：护盾在猛击后进加固、在加固后进猛击（两条互换），
  //   长矛在灼烧打击后进穿刺、在穿刺后进灼烧打击。假侧则**都是**「进那条大招」
  //   （重砸 / 贯穿）——于是两只都是「小招小招大招」的三拍循环。
  "spire_shield/shield_bash": (bc, m) => {
    if (lastMoveBefore(m, "shield_smash") || lastMoveBeforeInvalid(m)) {
      setMove(m, "fortify");
    } else {
      setMove(m, "shield_smash");
    }
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**）
  },
  "spire_shield/fortify": (bc, m) => {
    if (lastMoveBefore(m, "shield_smash") || lastMoveBeforeInvalid(m)) {
      setMove(m, "shield_bash");
    } else {
      setMove(m, "shield_smash");
    }
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**）
  },
  "spire_spear/burn_strike": (bc, m) => {
    if (lastMoveBefore(m, "skewer")) {
      setMove(m, "piercer");
    } else {
      setMove(m, "skewer");
    }
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**）
  },
  "spire_spear/piercer": (bc, m) => {
    if (lastMoveBefore(m, "skewer")) {
      setMove(m, "burn_strike");
    } else {
      setMove(m, "skewer");
    }
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**）
  },

  // —— 第四十七批乙：腐化之心 ——
  //
  // 四条 case **三种形态并存**（MonsterSpecific.cpp:1828-1884）：
  //   血弹 / 回响   按**全局怪物回合数**分岔的 `setMove` + **同步** `bc.noOpRollMove()`
  //   强化 / 虚弱化 **同步的真** `rollMove(bc)` —— 第六形态（掷 `aiRng.random(99)` 并选
  //                 新意图，而出招规则里还会再掷一次 `randomBoolean`）
  //
  // ⚠⚠ **`% 3 == 0` 读的是「执行这一招的那个怪物回合」的编号**，而不是下一个：参考在
  //   `takeTurn` 里读 `bc.getMonsterTurnNumber()`，那一刻本回合的计数已经生效。于是
  //   第 2 个怪物回合的血弹（2 % 3 != 0）排回响、第 3 个怪物回合的回响（3 % 3 == 0）
  //   排强化 —— 强化因此落在第 **4** 个怪物回合执行，而它自己读的 `buffCount =
  //   getMonsterTurnNumber() / 3` 那时是 4/3 = **1**。两处的回合数差一个，照抄别对齐。
  // ⚠ 两条的 else 分支**互为对方**（血弹回落到回响、回响回落到血弹），所以两条各写各的。
  "corrupt_heart/blood_shots": (bc, m) => {
    setMove(m, getMonsterTurnNumber(bc) % 3 === 0 ? "heart_buff" : "heart_echo");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**）
  },
  "corrupt_heart/heart_echo": (bc, m) => {
    setMove(m, getMonsterTurnNumber(bc) % 3 === 0 ? "heart_buff" : "blood_shots");
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng（noOpRollMove，**同步**）
  },
  // ⚠ 这两条是**真** rollMove（`rollMove(bc)`），不是 noOpRollMove：它会掷一次
  //   `aiRng.random(99)`（结果丢弃）**再**进出招规则掷一次 `randomBoolean` —— 一次收尾
  //   消耗 **2** 次 aiRng。写成 `"no_op_roll"` 会少掷一次且意图不变。
  "corrupt_heart/heart_buff": (bc, m) => {
    rollMove(bc, m); // ★ 消耗至少一次 aiRng（同步的真 rollMove）
  },
  "corrupt_heart/debilitate": (bc, m) => {
    rollMove(bc, m); // ★ 消耗至少一次 aiRng（同步的真 rollMove）
  },

  // —— 第四十七批乙：蒙面强盗三只 ——
  //
  // 七条 case 里六条是**同步 `setMove`**（第一形态），一条**什么都没有**
  // （MonsterSpecific.cpp:405-438）——整个编队一次 RollMove / NoOpRollMove 都不排。
  //
  // ⚠ 熊是三拍循环，但**不是回到起点**：熊抱 → 猛扑 → 撕咬 → **猛扑** → 撕咬 → …
  //   （撕咬的收尾是 `setMove(BEAR_LUNGE)`，不是熊抱）。熊抱一场仗只出一次。
  // ⚠ 罗密欧同理：嘲讽 → 苦痛斩 → 十字斩 → 苦痛斩 → …，嘲讽也只出一次。
  // ⚠⚠ 尖头怪那条 case **只有 `attackPlayerHelper` 一句**，效果之后什么都没有——
  //   与大史莱姆的分裂、抢劫者的逃跑同为 `"none"` 形态。它因此整场只出这一招，
  //   而且 `moveHistory` 从第一次 rollMove 之后再也不推进。
  //   判据仍是那句老话：**照着 case 从上到下读，效果之外的每一句都要有地方放**。
  "bear/bear_hug": { setMove: "bear_lunge" },
  "bear/bear_lunge": { setMove: "maul" },
  "bear/maul": { setMove: "bear_lunge" },
  "pointy/pointy_attack": "none",
  "romeo/mock": { setMove: "agonizing_slash" },
  "romeo/agonizing_slash": { setMove: "cross_slash" },
  "romeo/cross_slash": { setMove: "agonizing_slash" },
};

/**
 * 招式的**开场**语句（对齐参考 `Monster::takeTurn` 各 case 里排在效果之前的那几句）。
 *
 * 两个用户，都不是「效果」而是引擎侧的记账，所以单开一张表、不塞进数据表的 effects
 * （`enemies.ts` 不该知道 aiRng 与 miscInfo 这种东西）。键与 `MOVE_TURN_END` 同构
 * （`${怪 id}/${招式 id}`）。
 */
const MOVE_TURN_BEGIN: Record<string, (bc: BattleContext, m: CombatMonster) => void> = {
  // 抢劫者：**第一个怪物回合**的抢劫开头 `bc.aiRng.randomBoolean(0.6f)`，参考在那行注了
  // `// for a dialog message in game`——结果被完全丢弃，只有「掷了一次」体现在 aiRng
  // 计数器上（MonsterSpecific.cpp:919-921）。
  "looter/mug": (bc) => {
    if (getMonsterTurnNumber(bc) === 1) {
      bc.rng.aiRng.randomBoolean(Math.fround(0.6)); // ★ 消耗一次 aiRng，结果丢弃（游戏里的对白）
    }
  },
  // 红色奴隶主的缠绕：置 `usedEntangle`（对齐**第十六批给参考打的补丁**
  // ——`miscInfo = 1;`，MonsterSpecific.cpp:1017 那条 case 的第一句）。
  // ⚠ 它在补丁之前根本不存在：参考读 `miscInfo` 却从没写过，于是「一场只放一次缠绕」失效。
  //   写的是**同步**语句（不入队），所以紧随其后那条 `addToBot(RollMove)` 执行时已经看得见。
  "red_slaver/entangle": (_bc, m) => {
    m.miscInfo = 1;
  },
  // 地精巫师的蓄力计数（对齐 MonsterSpecific.cpp:775 那条 case 的**第一句** `++miscInfo`）。
  // ⚠ 这条 case 没有任何效果，所以「开场」与「收尾」其实是同一个时点；写在这里是为了保住
  //   参考的语句顺序——先加一，再由 `MOVE_TURN_END` 判 `== 3`。
  // ⚠ 计数的**起点是 1**（`MOVE_RULES.gremlin_wizard` 在 rollMove 里置的），
  //   所以开局那轮只蓄两回合；大招之后清零，此后每轮蓄三回合。
  "gremlin_wizard/charging": (_bc, m) => {
    m.miscInfo += 1;
  },

  // —— 劫匪（第二十四批）：两条 case 各自在效果之前白掷 aiRng ——
  //
  // 抢劫：`bc.aiRng.random(2);` **无条件**（每一次抢劫都掷），随后
  // `if (getMonsterTurnNumber() == 2) bc.aiRng.randomBoolean(0.6f);`
  // 两句都注着 `// for a dialog message in game`，结果全被丢弃
  // （MonsterSpecific.cpp:965-970）。
  // ⚠ 与抢劫者的差别有两处，别照搬邻居：① 抢劫者**没有**那句无条件的 `random(2)`；
  //   ② 抢劫者的 0.6f 在**第 1 个**怪物回合，劫匪在**第 2 个**。
  // ⚠ `random(2)` 与 `randomBoolean(0.6f)` 在 aiRng 上各算**一次**，
  //   所以劫匪第 2 个怪物回合的抢劫一共白掷 2 次。
  "mugger/mug": (bc) => {
    bc.rng.aiRng.random(2); // ★ 消耗一次 aiRng，结果丢弃（游戏里的对白）
    if (getMonsterTurnNumber(bc) === 2) {
      bc.rng.aiRng.randomBoolean(Math.fround(0.6)); // ★ 消耗一次 aiRng，结果丢弃（对白）
    }
  },
  // 猛扑：同样在效果之前 `bc.aiRng.random(2);`（MonsterSpecific.cpp:957）。
  // ⚠ 抢劫者的猛扑**没有**这一句（MonsterSpecific.cpp:910-914）。
  "mugger/lunge": (bc) => {
    bc.rng.aiRng.random(2); // ★ 消耗一次 aiRng，结果丢弃（游戏里的对白）
  },

  // —— 第二十七批 ——
  //
  // 地精首领的鼓舞：效果之前 `bc.aiRng.random(0, 2);`，参考在那行注了 `// for in game quote`
  //（MonsterSpecific.cpp:714）。结果完全丢弃，只有「掷了一次」体现在 aiRng 计数器上。
  // ⚠ 与劫匪那句 `random(2)` 是**同一个取值范围**（`random(0,2)` 与 `random(2)` 等价），
  //   但参考在这里写的是两参数形式。两者消耗次数相同，照抄写法。
  // ⚠ 首领另外两条 case（集结 / 突刺）**没有**任何开场语句。
  "gremlin_leader/encourage": (bc) => {
    bc.rng.aiRng.random(0, 2); // ★ 消耗一次 aiRng，结果丢弃（游戏里的对白）
  },

  // —— 第三十二批 ——
  //
  // 尖刺客的增生尖刺：效果之前那句 `++miscInfo;`，参考在那行注了 `// used thorns count`
  //（MonsterSpecific.cpp:1426）。它**不掷 RNG**，但它是「什么时候封顶」的唯一状态：
  // `MOVE_RULES.spiker` 判 `miscInfo > 5`，攒够六次之后这只怪只切割。
  // ⚠⚠ 它必须排在同一条 case 末尾那次**同步** `rollMove` 之前——那次 rollMove 当场就会
  //   读这个值。写在 `MOVE_TURN_END` 里（收尾之后）会让封顶晚一整回合、荆棘多涨 2 层。
  // ⚠ 这是 `miscInfo` 的第九种含义（前八种见 `MOVE_TURN_END` 里青铜自动机那条的注释）。
  //   **不要按用途另开字段**，第十六批已经把拆开的那次改回来过一遍。
  // ⚠ 切割那条 case **没有**任何开场语句。
  "spiker/spk_spike": (_bc, m) => {
    m.miscInfo += 1; // ★ 「已经放过几次增生尖刺」
  },
};

/**
 * 「这是第几个怪物回合」（对齐 `BattleContext::getMonsterTurnNumber`，BattleContext.cpp:643）。
 *
 * 参考就是一句 `return turn + 1;`：`bc.turn` 在 `afterMonsterTurns` 里才自增，所以怪物阶段
 * 里读到的还是**上一个**玩家回合的编号，首个怪物回合恰好得 1。
 */
function getMonsterTurnNumber(bc: BattleContext): number {
  return bc.turn + 1;
}

// ============================================================================
// 编队开局特例（对齐 MonsterGroup::createMonsters 中各 encounter 的额外初始化）
//
// 在「逐怪 roll HP」之后、「逐怪 rollMove」之前执行——顺序对齐参考的
// createMonsters → rollMove 循环。
// ============================================================================

// ============================================================================
// 建怪（对齐 MonsterGroup::createMonster → Monster::construct）
//
// construct 的顺序是 initHp 先、随后按怪种追加 miscInfo roll——两次都走 monsterHpRng，
// 且紧挨着，中间不会插入别的怪。变体编队因此呈现 misc,hp,hp,misc,hp,hp… 的交错。
// ============================================================================

/**
 * 掷一只怪的初始血量（对齐 `Monster::initHp`，MonsterSpecific.cpp:26-128）。
 *
 * ⚠ 单独拆成函数是因为参考里有**第二个调用点**：`Actions::SpawnTorchHeads` 在
 * `construct`（内部已经跑过一次 `initHp`）之后**又显式调了一次**
 * （Actions.cpp:513，参考在那行注着 `// bug somewhere in game`）。所以一只火炬头
 * 消耗 **2 次** monsterHpRng、保留**第二次**的取值。见 `summonTorchHeads`。
 * ⚠ 它与 `hpDiscardRoll` 不是一族：那一族的白掷在本函数**内部**、恒用低档区间，
 *   而火炬头是整个 `initHp` 跑两遍（asc>=9 时两次都用高档区间）。
 *
 * 三种掷法都在这里：
 *  ① 普通：一次 `setRandomHp` → 一次 monsterHpRng；
 *  ② `hpNoRoll`：`curHp = monsterHpRange[id][0][0]`，**一次都不掷**；
 *  ③ `hpDiscardRoll`：先白掷一次（结果丢弃）再正常掷 → 两次。
 */
function initMonsterHp(bc: BattleContext, defId: string): number {
  const def = getEnemyDef(defId);
  // 血量区间的第二组（对齐 `setRandomHp(hpRng, ascension >= N)`）。
  // ⚠ 阈值 N **逐怪不同**（普通 7 / 精英 8 / Boss 9），所以它写在数据表里跟着区间走，
  //   这里不猜。⚠ 火炬头是个「随从却走 Boss 档（asc>=9）」的反例，见它的数据表注释。
  // ⚠ 无论走哪一组都**只掷一次** monsterHpRng——`setRandomHp` 只有一句 `hpRng.random(a,b)`，
  //   换组不改 RNG 消耗次数，只改上下界。
  const range =
    def.hpHigh !== undefined && bc.ascension >= def.hpHigh.atLeast
      ? { min: def.hpHigh.hpMin, max: def.hpHigh.hpMax }
      : { min: def.hpMin, max: def.hpMax };
  // ⚠⚠ 第三种掷法：**先白掷一次、结果丢弃，再正常掷**（第二十七批的工头）。
  //   `Monster::initHp` 里有一族 case 长这样（`MonsterSpecific.cpp:33-36 / :105-117`）：
  //       hpRng.random(54, 60);                 // 参考在 ORB_WALKER 那条注了
  //       setRandomHp(hpRng, ascension >= 8);   // "first call is discarded by game"
  //   所以一次建怪消耗 **2 次** monsterHpRng。⚠ 白掷那次的**上下界要单独写**
  //   （见 `hpDiscardRoll`）：工头两组恰好相同，青铜球却是 `(52,58)` 对 `{52,58}`/`{54,60}`。
  //   漏掉这一次不会静默——`rng.hp` 计数器当场对不上。
  if (def.hpDiscardRoll !== undefined) {
    bc.rng.monsterHpRng.random(def.hpDiscardRoll.min, def.hpDiscardRoll.max); // ★ 消耗一次 monsterHpRng，取值丢弃
  }
  // ⚠⚠ 少数怪**一次 monsterHpRng 都不掷**（第二十三批的球状守卫者，以及尚未登记的
  //   THE_MAW / TRANSIENT）：`Monster::initHp` 给它们的是
  //   `curHp = monsterHpRange[id][0][0]`，连 `setRandomHp` 都不调（MonsterSpecific.cpp:119-124）。
  //   这与「上下界相同」**不是一回事**——守卫者的 `{240,240}` 照样掷一次
  //   （`Random::random(int,int)` 无条件 `++counter`）。把这一条写成普通掷法会让此后
  //   每一次 monsterHpRng 取值整体错位，`rng.hp` 计数器当场对不上。
  if (def.hpNoRoll === true) {
    return range.min;
  }
  return bc.rng.monsterHpRng.random(range.min, range.max); // ★ 消耗一次 monsterHpRng
}

/**
 * 只**造**一只怪，不入场（对齐 `Monster::construct`，Monster.cpp:107）。
 *
 * 拆出来是因为 `createWeakWildlife` / `createStrongHumanoid` 那类编队会把候选
 * **全部 construct 一遍**（每只都掷血量）、然后只留一只，其余直接丢弃——
 * 丢弃的那些照样消耗了 monsterHpRng，见 `ENCOUNTER_BUILDERS.exordium_thugs`。
 */
function constructMonster(bc: BattleContext, defId: string): CombatMonster {
  const def = getEnemyDef(defId);
  // 爬升度未校准就**直接抛错**（对齐「未登记的内容显式抛错」那条总纲）。
  // 静默拿 asc0 的血量区间与招式数值去打 asc19 的仗，比开不了战危险得多——
  // 它会产出看着合理、其实与原版不符的数值，而「同种子复现原版」正是这个项目的全部价值。
  // 第二十一批校准了 14 个普通编队涉及的 19 只怪，第二十二批补上三精英与三 Boss
  // 的 6 只（阈值 8 / 9），于是第一幕 25 只怪全部校准；剩下的 40 只全在第二 / 三幕。
  if (bc.ascension > 0 && def.ascCalibrated !== true) {
    throw new Error(
      `sts-combat: 敌人「${defId}」的爬升度分档尚未按预言机校准，无法在 ascension=${String(bc.ascension)} 下开战`,
    );
  }
  const hp = initMonsterHp(bc, defId);
  const m: CombatMonster = {
    defId,
    hp,
    maxHp: hp,
    block: 0,
    currentMove: "",
    moveHistory: [],
    powers: [],
    alive: true,
    halfDead: false,
    miscInfo: 0,
    uniquePower0: 0,
  };
  // construct 的怪种特例：虱子的咬击伤害整场固定，出生时掷定（对齐 Monster.cpp:116）。
  if (defId === "louse" || defId === "green_louse") {
    m.miscInfo =
      bc.ascension >= 2 ? bc.rng.monsterHpRng.random(6, 8) : bc.rng.monsterHpRng.random(5, 7); // ★ 再消耗一次 monsterHpRng
  }
  // 暗影客的撕咬伤害同样出生时掷定（对齐 Monster.cpp:124-130，第三十四批）。
  // ⚠ **区间与虱子不同**（虱子 5~7 / 6~8，暗影客 7~11 / 9~13），照抄邻居必错。
  // ⚠ 它与虱子是 `Monster::construct` 那个 switch 里仅有的两格；顺序照抄（虱子在前）
  //   ——两格互斥，当前顺序不可观察，但形状对齐。
  if (defId === "darkling") {
    m.miscInfo =
      bc.ascension >= 2 ? bc.rng.monsterHpRng.random(9, 13) : bc.rng.monsterHpRng.random(7, 11); // ★ 再消耗一次 monsterHpRng
  }
  return m;
}

/**
 * **就地** construct 一只怪，不新建实体（对齐裸的 `arr[idx].construct(bc, id, idx)`）。
 *
 * ⚠⚠ **这不是 `constructMonster` 的一个包装，差别是「那一格原来的东西留不留」。**
 * `Monster::construct`（Monster.cpp:109-135）只写四样：`id` / `idx` / `initHp` /
 * 虱子与暗影客的 `miscInfo`。**状态位、力量、格挡、意图历史一个都不碰。**
 * 所以参考里「先 `arr[idx] = Monster()` 再 construct」与「直接 construct」是两种行为，
 * 而四个召唤宿主里**只有青铜自动机走后者**（WORKFLOW 那张 13 维表的 `= Monster()` 一行：
 * 地精首领有 / 自动机**没有** / 收藏家有 / 蜥蜴法师有）。
 *
 * ⚠ 在第四十批之前这个差别**结构性不可观察**：自动机的 0 / 2 号位是开局预留、
 * 从没被写过的空格，里面什么都没有，「保留」与「清空」同解。**贤者之石把它掀开了**
 * ——`initRelics` 那一格给**包括空格在内**的每一格 +1 力量（那个循环没有任何过滤），
 * 于是青铜球出生时身上就带着 1 点残留力量，再加召唤自己那 +1 = **2**。
 * 实测：按「新建实体」建模时 `automaton@relic1` 的 120 条全红（快照里球是 1 点力量、
 * 参考是 2 点）。
 *
 * ⚠ `alive` 是我们对 `!isDeadOrEscaped()` 的建模，三位里 construct 只动 `curHp`；
 * 逃跑那一位我们没有单独的字段，但青铜球不会逃跑，所以这里按「血 > 0 且不半死」算。
 */
function constructMonsterInPlace(bc: BattleContext, slot: CombatMonster, defId: string): void {
  const fresh = constructMonster(bc, defId); // ★ 掷血量（青铜球带 hpDiscardRoll，2 次）
  slot.defId = defId;
  slot.hp = fresh.hp;
  slot.maxHp = fresh.maxHp;
  // construct 的怪种特例只写 `miscInfo`，其余字段原样留着——所以这里也只搬这一个。
  if (fresh.miscInfo !== 0) {
    slot.miscInfo = fresh.miscInfo;
  }
  slot.alive = slot.hp > 0 && !slot.halfDead;
}

function createMonster(bc: BattleContext, defId: string): CombatMonster {
  const m = constructMonster(bc, defId);
  bc.monsters.push(m);
  return m;
}

// ============================================================================
// 分裂（对齐 `Monster::largeSlimeSplit`，MonsterSpecific.cpp:3364）
//
// 大史莱姆掉到半血时**不是加两只小弟**，而是被两只中史莱姆**顶替**：母体所在的下标
// 直接被覆盖，第二只落在它右边一格。逐条照抄的点（每条都有可观测面）：
//
//  ① **不掷 monsterHpRng**。`initSpawnedMonster`（:3347）只有 `curHp = maxHp = hp`，
//     没有 `initHp`。而且 `maxHp` 也被压成分裂瞬间的**当前**血量，不是母体的上限
//     ——trace 里那两只中史莱姆是满血的 26/26，母体是 26/65。
//  ② **不继承任何状态**：参考写的是 `arr[idx] = Monster()` 再 init，母体身上的易伤 /
//     虚弱 / 格挡全部清零（trace 逐帧可见）。
//  ③ 两只各自 `rollMove`（:3352），所以 aiRng 消耗是 2 次**起步**——中号酸液的
//     `getMoveForRoll` 还可能追加一次 randomBoolean。
//  ④ 之后还有**两次** `noOpRollMove`（各掷一次 `aiRng.random(99)` 丢掉）：
//     一次在 largeSlimeSplit 尾部（:3386），另一次是它 `extraRollMoveOnTurn.set(idx2)`
//     之后、回到 `MonsterGroup::doMonsterTurn`（MonsterGroup.cpp:583）立刻被读掉的那次。
//     ⚠ 那个 bitset **只由本函数写、当场就被读掉**（中间没有任何入队动作），
//     所以这里直接连着掷两次是等价的，不需要把它做成持久状态。
//  ⑤ **游标推进两格**：largeSlimeSplit 自己 `++bc.monsterTurnIdx`（:3388），
//     `doMonsterTurn` 末尾还会再 `++` 一次。于是新生的第二只**本回合不行动**。
//     我们的主循环把第二次 `+= 1` 放在调用方（对齐参考把它放在 doMonsterTurn 末尾），
//     所以这里只做第一次。
// ============================================================================

/**
 * 参考的 `MonsterGroup::arr` 是**定长 5 的数组**，`monsterCount` 只是「dump / 遍历到第几格」。
 * 于是「场上的怪数」与「数组里被用掉几格」并不是一回事：史莱姆王分裂后 `monsterCount = 3`
 * 而 1 号格从没被写过，harness 照样把它 dump 出来（`"id":"INVALID = 0"`、血量 0、`alive:false`、
 * 意图 `"INVALID"`）。
 *
 * 我们用 `bc.monsters.length` 当 `monsterCount`，所以那种空格必须有个实体占位。
 * 它满足 `!alive`，因此所有循环（伤害、随机选敌、怪物回合、回合末结算）都会跳过它，
 * 与参考里那只 `curHp = 0` 的默认 `Monster` 表现一致。
 *
 * ⚠ `defId` 故意取一个**没有数据表条目**的名字：谁要是真去 `getEnemyDef` 它，当场抛错
 * 比静默拿到一只假怪好。唯一需要放行的读点是 `isMonsterAttacking`（参考对它是
 * `isMoveAttack(INVALID)` = false），那里显式判掉。
 */
const EMPTY_MONSTER_SLOT = "__empty";

function emptyMonsterSlot(): CombatMonster {
  return {
    defId: EMPTY_MONSTER_SLOT,
    hp: 0,
    maxHp: 0,
    block: 0,
    currentMove: "",
    moveHistory: [],
    powers: [],
    alive: false,
    halfDead: false,
    miscInfo: 0,
    uniquePower0: 0,
  };
}

/**
 * 新生的分裂体落位（对齐 `arr[idx] = Monster(); arr[idx].initSpawnedMonster(...)`，
 * MonsterSpecific.cpp:3372-3376）。两个分裂函数共用。
 *
 * ⚠ `initSpawnedMonster`（:3345-3352）只有 `curHp = maxHp = hp; rollMove(bc);`——
 * **不掷 monsterHpRng**，而且 `maxHp` 被压成分裂瞬间的**当前**血量。
 * ⚠ `arr[idx] = Monster()` 是整只重建，母体的易伤 / 虚弱 / 格挡 / 意图历史全清零。
 */
function spawnSplitMonster(bc: BattleContext, defId: string, at: number, hp: number): void {
  const nm: CombatMonster = {
    defId,
    hp,
    maxHp: hp,
    block: 0,
    currentMove: "",
    moveHistory: [],
    powers: [],
    alive: true,
    halfDead: false,
    miscInfo: 0,
    uniquePower0: 0,
  };
  // 先落位再 rollMove，对齐 `arr[idx] = Monster(); arr[idx].initSpawnedMonster(...)`。
  bc.monsters[at] = nm;
  rollMove(bc, nm); // ★ 消耗 aiRng（1 次；中号酸液的分支可能追加 1 次）
  // ⚠ 贤者之石那一支**不在这里**：参考是「两只都造完之后」才一起 buff，见调用方。
}

/**
 * 贤者之石给「刚上场的怪」+1 力量。参考在**七处**逐字重复同一句
 * `if (bc.player.hasRelic<R::PHILOSOPHERS_STONE>()) { …buff<MS::STRENGTH>(1); }`：
 *
 * | 出处                                | 位置                                                       |
 * | ----------------------------------- | ---------------------------------------------------------- |
 * | `largeSlimeSplit`（:3406）          | **两只都造完之后**，在 `monstersAlive++` 之前               |
 * | `slimeBossSplit`（:3433）           | 同上                                                       |
 * | `Actions::SummonGremlins`（:488）   | `monstersAlive += 2` 之后、**`buff<MINION>` 之前**         |
 * | `Monster::spawnBronzeOrbs`（:3454） | `buff<MINION>` **之后**、`rollMove` 之前                   |
 * | `Actions::SpawnTorchHeads`（:517）  | 循环内，`buff<MINION>` 之后、`++monstersAlive` 之前         |
 * | `Monster::reptomancerSummon`（:3601）| 循环内，`buff<MINION>` 之后、`noOpRollMove` 之前            |
 * | `DARKLING_REINCARNATE`（:1494）     | `buff<MS::REGROW>()` 之后、收尾的 `rollMove` 之前           |
 *
 * ⚠ **相对 `buff<MINION>` 的先后逐处不同**（地精是之前、另外三条召唤是之后），照抄。
 * 当前观察不到差别——harness 的快照按 `MonsterStatus` **枚举序**输出，不是获得顺序
 * （`monsterStatuses` 逐个下标扫），而我们这边比对时也按 id 归一。**照抄，别对齐成一种。**
 *
 * ⚠ 这一句与 `initRelics` 里那一格（开局给全场 +1）是**两件事**：那一格只跑一次、
 * 覆盖开局就在场的怪；这一句覆盖开局之后才出现的怪。缺任何一边都会让「后来的怪没力量」
 * 或「开局的怪没力量」。
 */
function philosophersStoneBuff(bc: BattleContext, m: CombatMonster): void {
  if (hasRelic(bc, "philosophers_stone")) {
    addPower(m.powers, "strength", 1);
  }
}

function splitMonster(bc: BattleContext, m: CombatMonster): void {
  const idx1 = bc.monsters.indexOf(m);
  const idx2 = idx1 + 1;
  const into = getEnemyDef(m.defId).splitInto;
  if (into === undefined || into.length !== 2) {
    throw new Error(`sts-combat 暂未登记分裂去向: ${m.defId}`);
  }
  const countBefore = bc.monsters.length;
  const hp = m.hp; // ★ 继承分裂瞬间的当前生命，同时成为新怪的生命上限
  spawnSplitMonster(bc, into[0], idx1, hp);
  // ⚠ 参考是往定长数组 `arr[idx2]` 里**写**，右边已经有东西就顶掉。这在史莱姆王那条链上
  //   真的会发生：王分裂出的尖刺大在 0 号格，它再分裂时 idx2 = 1 —— 而 1 号格正是王
  //   留下的那个空位（第十九批实测走到了这一支；第十四批当时写的是一道显式抛错）。
  spawnSplitMonster(bc, into[1], idx2, hp);

  // 贤者之石：**两只都造完之后**才 buff（MonsterSpecific.cpp:3406-3409），
  // 排在 `monstersAlive++` 之前。见 `philosophersStoneBuff`。
  philosophersStoneBuff(bc, bc.monsters[idx1]);
  philosophersStoneBuff(bc, bc.monsters[idx2]);

  bc.monstersAlive += 1;
  // `monsterCount = std::min(monsterCount+1, 4)`（MonsterSpecific.cpp:3384）。
  // ⚠ 这条**不等于**「数组长了一格」：顶掉右边那种情形里数组长度没变，monsterCount 照涨，
  //   于是尾部多出一个从没被写过的空格（史莱姆王链上 3 → 4，快照里真的多出一个
  //   `INVALID = 0`）。所以这里按参考的公式算，再补占位到那个长度。
  const newCount = Math.min(countBefore + 1, 4);
  while (bc.monsters.length < newCount) {
    bc.monsters.push(emptyMonsterSlot());
  }

  bc.rng.aiRng.random(99); // ★ largeSlimeSplit 尾部的 noOpRollMove（MonsterSpecific.cpp:3386）
  bc.monsterTurnIdx += 1; // 对齐 :3388 的 ++bc.monsterTurnIdx
  bc.rng.aiRng.random(99); // ★ doMonsterTurn 里 extraRollMoveOnTurn 命中的那次 noOpRollMove
}

// ============================================================================
// 史莱姆王的分裂（对齐 `Monster::slimeBossSplit`，MonsterSpecific.cpp:3391）
//
// ⚠⚠ **这不是 `largeSlimeSplit` 的一个特例，是另一个函数。** 五处形状差别，逐条照抄：
//
//  ① **落位下标写死 0 / 2**（`const auto idx1 = 0; const auto idx2 = 2;`），不是
//     「母体所在格 + 右边一格」。史莱姆王恒在 0 号格，所以 1 号格被**跳过**——
//     那正是快照里那个 `INVALID = 0` 的来历。
//  ② **`monsterCount = 3` 是直接赋值**，不是 `min(count+1, 4)`。所以从 1 只变成
//     「3 格、其中 1 格是空的」。
//  ③ **`monstersAlive = 2` 也是直接赋值**，不是 `++`。数值上与「1 只 → +1」相同，
//     但语义不同（母体不算进去，是被顶替掉的）。
//  ④ **`monsterTurnIdx = 3` 直接赋值**，不是 `++`。3 == monsterCount，于是回到
//     `doMonsterTurn` 时 `extraRollMoveOnTurn.test(3)` 恒假、`++` 之后循环也结束
//     ——两只新怪本回合都不行动。
//  ⑤ **一次 `noOpRollMove` 都不掷**，也不设 `extraRollMoveOnTurn`。所以整个分裂只消耗
//     两次 aiRng（两只新怪各自 rollMove），而大史莱姆那条是 2 + 2 = 4 次起步。
//
// 两者相同的只有中间那一段：`arr[idx] = Monster()` + `initSpawnedMonster(…, curHp)`
//（不掷血量、maxHp 压成当前血量、不继承状态、各自 rollMove），以及紧随其后的贤者之石那一支。
// ============================================================================

function slimeBossSplit(bc: BattleContext, m: CombatMonster): void {
  const into = getEnemyDef(m.defId).splitInto;
  if (into === undefined || into.length !== 2) {
    throw new Error(`sts-combat 暂未登记分裂去向: ${m.defId}`);
  }
  const hp = m.hp; // ★ 同 largeSlimeSplit：当前血量既是新怪的血也是它们的上限
  // ① 下标写死 0 / 2。1 号格从头到尾没被碰过 → 空占位。
  while (bc.monsters.length < 3) {
    bc.monsters.push(emptyMonsterSlot());
  }
  spawnSplitMonster(bc, into[0], 0, hp); // ★ 消耗一次 aiRng（尖刺大）
  spawnSplitMonster(bc, into[1], 2, hp); // ★ 消耗一次 aiRng（酸液大）

  // 贤者之石：与 `largeSlimeSplit` 同形，两只都造完之后一起 buff（:3433-3436）。
  philosophersStoneBuff(bc, bc.monsters[0]);
  philosophersStoneBuff(bc, bc.monsters[2]);

  // ②③④ 三个都是**赋值**。`monsterCount` 由数组长度表达，上面已经补到 3。
  bc.monstersAlive = 2;
  bc.monsterTurnIdx = 3;
  // ⑤ 没有 noOpRollMove、没有 extraRollMoveOnTurn——这里**故意什么都不掷**。
}

// ============================================================================
// 变体编队（对齐 MonsterGroup::createMonsters 中消耗 miscRng 的分支）
//
// ⚠ 这些编队的成员由 miscRng 在战斗开始时掷定，静态 encounter 表里的 enemies
// 只是给旧版 combat.ts 用的占位，sts-combat 走这里的构建器。
// ============================================================================

type EncounterBuilder = (bc: BattleContext) => void;

/** 对齐 MonsterGroup::getLouse（MonsterGroup.cpp:553）：一次 miscRng.randomBoolean，true = 红。 */
function getLouse(bc: BattleContext): string {
  return bc.rng.miscRng.randomBoolean() ? "louse" : "green_louse";
}

/**
 * 对齐 MonsterGroup::getSlaver（MonsterGroup.cpp:563）：一次 miscRng.randomBoolean。
 *
 * ⚠ **true = 红色**。这个方向必须逐个回参考看，不能照抄别的同族函数：`getLouse` 是
 * true=红虱、`small_slimes` 是 true=尖刺、`large_slime` 却是 true=酸液——四条各写各的。
 */
function getSlaver(bc: BattleContext): string {
  return bc.rng.miscRng.randomBoolean() ? "red_slaver" : "blue_slaver";
}

/**
 * 从 8 项候选表里掷一只小鬼（对齐 `MonsterGroup::getGremlin`，MonsterGroup.cpp:541-552）。
 *
 * ⚠⚠ **它的参数是「哪条 RNG 流」，而且两个调用方用的不是同一条**：
 *   * `MonsterGroup::createMonsters` 建 `GREMLIN_LEADER` 的两只随从时传 **`bc.miscRng`**；
 *   * `Actions::SummonGremlins` 召唤时传 **`bc.aiRng`**（Actions.cpp:484-485）。
 * 参考正是为此把 rng 做成形参。写死一条流会让另一条的计数器整体错位。
 *
 * ⚠ 候选表**带重复**（狂暴 ×2、鬼祟 ×2、肥胖 ×2、护盾 ×1、巫师 ×1），掷的是
 * `rng.random(7)`（闭区间上界 7 = 8 项）。这与 `gremlin_gang` 的 8 选 4 是**同一张表**，
 * 但那边是不放回抽样、这边每次都从完整的 8 项里掷。
 */
function getGremlin(rng: StsRandom): string {
  const gremlins = [
    "mad_gremlin",
    "mad_gremlin",
    "sneaky_gremlin",
    "sneaky_gremlin",
    "fat_gremlin",
    "fat_gremlin",
    "shield_gremlin",
    "gremlin_wizard",
  ];
  return gremlins[rng.random(7)]; // ★ 消耗一次传入的那条流
}

/**
 * 从 3 项候选表里掷一只「形状怪」（对齐 `MonsterGroup::getAncientShape`，
 * MonsterGroup.cpp:532-539）。第三十二批。
 *
 * ```cpp
 * MonsterId MonsterGroup::getAncientShape(Random &miscRng) {
 *     const MonsterId shapes[] { SPIKER, REPULSOR, EXPLODER };
 *     return shapes[miscRng.random(2)];
 * }
 * ```
 *
 * ⚠⚠ **它与 `createShapes` 的那张 6 项池不是同一张表，也不是同一种抽法**，照搬必错：
 *   * 这条是 **3 项、不带重复、有放回**（每次都从完整的三项里掷），唯一的调用方是
 *     `SPHERE_AND_TWO_SHAPES`——所以那个编队**真的可能出两只一样的形状怪**；
 *   * `createShapes` 是 **6 项、每种两份、不放回**，用 `lastIdx` 收缩有效区间。
 * ⚠ **顺序也不同**：这里是 尖刺客 / 斥力怪 / 爆破怪，那张池是 斥力 斥力 爆破 爆破 尖刺 尖刺。
 *   下标 0 取到的东西两边不一样，抄错会让同种子下的编队整体变样。
 * ⚠ 掷的是 `miscRng.random(2)`（**闭区间上界**，3 项）。
 */
function getAncientShape(bc: BattleContext): string {
  const shapes = ["spiker", "repulsor", "exploder"];
  return shapes[bc.rng.miscRng.random(2)]; // ★ 消耗一次 miscRng
}

/**
 * 从 6 项池里**不放回**地抽 count 只形状怪并依次建出来（对齐 `MonsterGroup::createShapes`，
 * MonsterGroup.cpp:508-530）。第三十二批，`THREE_SHAPES`（3 只）与 `FOUR_SHAPES`（4 只）共用。
 *
 * ```cpp
 * MonsterId shapePool[] { REPULSOR, REPULSOR, EXPLODER, EXPLODER, SPIKER, SPIKER };
 * int lastIdx = 5;
 * for (int i = 0; i < count; ++i) {
 *     int idx = bc.miscRng.random(lastIdx);
 *     MonsterId shape = shapePool[idx];
 *     while (idx < lastIdx) { shapePool[idx] = shapePool[idx + 1]; ++idx; }
 *     --lastIdx;
 *     createMonster(bc, shape);
 * }
 * ```
 *
 * ⚠ 与 `gremlin_gang` 的 8 选 4 是**同族但不是同一段代码**，四处逐条对过：
 *  ① 池子是 **6 项、每种恰好两份**（斥力 ×2、爆破 ×2、尖刺 ×2）——所以一场最多两只同种，
 *     而 `FOUR_SHAPES` 抽 4 只必然是「两种各两只」或「一种两只 + 另两种各一只」；
 *  ② 有效区间由**独立的 `lastIdx`**（初值 5）表达，每轮取完才 `--lastIdx`；
 *  ③ 取走 `pool[idx]` 之后是**整体左移**（`while (idx < lastIdx)`），**不是**与末位交换
 *     ——两种写法分布相同、同种子下排列不同（第十三批实测史莱姆群改成交换红 253 例）；
 *  ④ RNG 交错是 misc, hp, misc, hp, …：每轮**先**掷下标（miscRng）、**再**建怪（monsterHpRng），
 *     不是先选完再统一建。
 * ⚠ 池子的**书写顺序**照抄（斥力在前、尖刺在后），它决定下标 → 怪种的映射。
 */
function createShapes(bc: BattleContext, count: number): void {
  const pool = ["repulsor", "repulsor", "exploder", "exploder", "spiker", "spiker"];
  let lastIdx = 5;
  for (let i = 0; i < count; i += 1) {
    let idx = bc.rng.miscRng.random(lastIdx); // ★ 消耗一次 miscRng
    const shape = pool[idx];
    while (idx < lastIdx) {
      pool[idx] = pool[idx + 1]!;
      idx += 1;
    }
    lastIdx -= 1;
    createMonster(bc, shape); // ★ 消耗一次 monsterHpRng
  }
}

/**
 * 地精首领的召唤（对齐 `Actions::SummonGremlins`，Actions.cpp:459-497）。
 *
 * 本项目**第一个「凭空加怪」的机制**。与第十四 / 十九批的分裂形状不同：分裂是「一只变两只、
 * 母体退场」（写母体那一格 + 右边一格），召唤是**往预留的空位里填**——地精首领开局就
 * 留好了 0 号位（见 `ENCOUNTER_BUILDERS.gremlin_leader`），`monsterCount` 从头到尾是 4。
 *
 * 逐条照抄的点（每一条都有可观测面）：
 *
 *  ① **找空位的顺序是 1, 2, 0**，参考在函数第一行就注了
 *     `// gremlin leader searches in the order 1, 2, 0 for open space`。
 *     0 号位那一格还带一道额外的门 `openIdxCount < 2`（前两格都空时压根不看它）。
 *     ⚠ 顺序决定**哪只新怪落在哪一格**：两次 `getGremlin` 的取值分别给 `newGremlinIdxs[0]`
 *     与 `[1]`，所以「1 号位空、2 号位有怪、0 号位空」时第一只落 1 号、第二只落 **0 号**。
 *  ② 门是 `isDying()`（**血 ≤ 0**），不是 `isDeadOrEscaped()`。开局那个从没构造过的空格
 *     血是 0，因此天然算「空」。我们用 `hp <= 0`，把逃跑 / 假死那两位的差别留在原处。
 *  ③ **恒好 2 只**。参考在 `sts_asserts` 下 `assert(openIdxCount == 2)`，release 版直接读
 *     `newGremlinIdxs[1]`（越界即 UB）。它成立的原因在出招规则里：集结只在
 *     「活着的小鬼 ≤ 1」时才被选出，也就是 0/1/2 里至少两格是空的，而小鬼只会死不会复活。
 *     我们这里显式抛错而不是猜——与 `splitMonster` 当年那道门同一条理由。
 *  ④ **挑种类走 `aiRng`**（建怪时是 `miscRng`），而且它是 `construct` 的**实参**：
 *     C++ 先算实参再进函数，所以流是 ai, hp, ai, hp。
 *  ⑤ `gremlin0 = Monster()` 是**整只重建**：那一格上残留的易伤 / 虚弱 / 格挡 / 意图历史
 *     全部清零（与分裂的 `arr[idx] = Monster()` 同形）。
 *  ⑥ **`monstersAlive += 2`，`monsterCount` 一动不动**。数组长度因此不变——0 号位那个占位
 *     实体是被**覆盖**掉的，不是 push。
 *  ⑦⚠⚠ **不重跑 `preBattleAction`**。所以召唤出来的狂暴小鬼**没有狂怒**、护盾小鬼也没有
 *     任何开局 buff——与 `GREMLIN_GANG` 里建出来的同种小鬼不是一回事。trace 里逐帧可见
 *     （召唤出的 `MAD_GREMLIN` 的 powers 只有 `MINION: 1`）。
 *  ⑧ 两只各自 `rollMove`（再各消耗一次 aiRng，`getMoveForRoll` 还可能追加；巫师那条
 *     还会在规则里置 `miscInfo = 1`）。**排在 buff MINION 之后**。
 *  ⑨ 整个动作是**入队**的（`addToBot(Actions::SummonGremlins())`，MonsterSpecific.cpp:731），
 *     所以它跑在首领那条入队 RollMove **之前**、但在本回合先排的动作之后。
 */
function summonGremlins(bc: BattleContext): void {
  const newIdxs: number[] = [];
  // ① 顺序 1, 2, 0；② 门是「血 ≤ 0」。
  if ((bc.monsters[1]?.hp ?? 0) <= 0) {
    newIdxs.push(1);
  }
  if ((bc.monsters[2]?.hp ?? 0) <= 0) {
    newIdxs.push(2);
  }
  if (newIdxs.length < 2 && (bc.monsters[0]?.hp ?? 0) <= 0) {
    newIdxs.push(0);
  }
  // ③ 参考在这里是 assert；我们显式抛错（release 版参考会读越界的 newGremlinIdxs[1]）。
  if (newIdxs.length !== 2) {
    throw new Error(`sts-combat 召唤地精时空位不是 2 个: ${String(newIdxs.length)}`);
  }
  const spawned: CombatMonster[] = [];
  for (const at of newIdxs) {
    // ④ 种类走 aiRng，且掷在这一只的血量之前（实参先求值）。
    // ⑤ 整只重建：`constructMonster` 造的是全新实体，那一格原来的东西被覆盖。
    const nm = constructMonster(bc, getGremlin(bc.rng.aiRng)); // ★ 一次 aiRng + 一次 monsterHpRng
    bc.monsters[at] = nm;
    spawned.push(nm);
  }
  // ⑥ 只动 monstersAlive，monsterCount（= 数组长度）不变。
  bc.monstersAlive += 2;
  // 贤者之石（Actions.cpp:488-491）：⚠ 这一条排在 **`buff<MINION>` 之前**，与另外三条
  // 召唤（青铜球 / 火炬头 / 匕首都是 MINION 在前）相反。照抄，见 `philosophersStoneBuff`。
  for (const nm of spawned) {
    philosophersStoneBuff(bc, nm);
  }
  for (const nm of spawned) {
    addPower(nm.powers, "minion", 1);
  }
  // ⑦ 这里**没有** preBattleAction —— 参考真的没调，照抄。
  // ⑧ 两只各自 rollMove，排在 buff 之后。
  for (const nm of spawned) {
    rollMove(bc, nm); // ★ 消耗 aiRng（1 次起；巫师/护盾那些规则不追加，但形状上允许）
  }
}

/**
 * 青铜自动机的召唤（对齐 `Monster::spawnBronzeOrbs`，MonsterSpecific.cpp:3443-3464）。
 *
 * 本项目**第二个「凭空加怪」的宿主**，而它与第二十七批的 `summonGremlins`
 * **不共用任何代码，也不该共用**——参考那边是一个 `Action`、这边是 `takeTurn` 里的一个
 * 成员函数，五处形状都不同。逐条照抄的点：
 *
 *  ①⚠⚠ **它是同步调用**：`case BRONZE_AUTOMATON_SPAWN_ORBS: spawnBronzeOrbs(bc); …`
 *     （`:502-506`）——没有 `addToBot`。地精首领那条是 `addToBot(Actions::SummonGremlins())`。
 *     差别可观察：同步意味着两颗球的血量、意图、以及那两次 aiRng / 四次 monsterHpRng
 *     都掷在**本回合排的动作执行之前**（而召唤这条 case 一个入队效果都没有，
 *     所以队列本来就空——但顺序仍然照抄，理由见 WORKFLOW 第二十六批那条判据）。
 *  ②⚠ **落位下标写死 0 与 2**（`auto &orb1 = arr[0]; auto &orb2 = arr[2];`）：
 *     没有「按 1,2,0 找空位」那套搜索、也**不判 `isDying()`**。1 号位是自动机自己，跳过。
 *     ⚠ 这与史莱姆王分裂的写死 0/2 形状相同、但那边还要改 `monsterCount` / `monsterTurnIdx`
 *     的赋值，这边只 `++` 后者。
 *  ③⚠ **怪种是固定的 `BRONZE_ORB`**，所以**一次 aiRng 都不为「挑种类」而掷**
 *     （地精那条走 `getGremlin(bc.aiRng)`，两只各一次）。这颗球的 aiRng 只花在 rollMove 上。
 *  ④⚠ **没有 `= Monster()` 重建**（地精那条有 `gremlin0 = Monster();`）。
 *     在当前内容集合里等价：那两格从没被构造过（自动机的召唤整场只发生一次，见
 *     `MOVE_RULES.bronze_automaton` 的「只调用一次」断言），所以格子上没有任何残留。
 *     我们用「造一个全新实体再赋值」表达，等于「重建 + construct」——比参考更强，但同解。
 *  ⑤ 每颗球照样走 `construct` → `initHp`，而青铜球带 `hpDiscardRoll`
 *     （先白掷一次 `(52,58)` 再正式掷）→ **每颗 2 次 monsterHpRng，两颗共 4 次**。
 *  ⑥ `buff<MS::MINION>()` 两颗都上，排在 construct 之后、rollMove 之前（与地精那条同序）。
 *  ⑦ 两颗各自 `rollMove`（各一次 aiRng；`MOVE_RULES.bronze_orb` 不追加）。
 *  ⑧ `monstersAlive += 2`，**`monsterCount` 一动不动**（那两格开局就在数组里）。
 *     ⚠ 参考把这一句放在两次 rollMove **之后**——而 0 号球的出招规则不读 `monstersAlive`，
 *     所以当前不可分辨；照抄位置。
 *  ⑨⚠⚠ **末尾多一句 `++bc.monsterTurnIdx`**（`:3463`）。自动机在 1 号位，本回合的游标就是 1；
 *     推到 2 之后，`doMonsterTurn` 末尾那次 `++` 把它推到 3 == `monsterCount`，循环结束
 *     ——于是 **2 号位那颗球本回合不行动**（0 号位那颗本来就已经被游标走过了）。
 *     我们的主循环把第二次 `+= 1` 放在调用方（对齐参考放在 `doMonsterTurn` 末尾），
 *     所以这里只做第一次，与 `splitMonster` 同一套写法。
 */
function spawnBronzeOrbs(bc: BattleContext): void {
  // ②⑤ 下标写死、每颗两次 monsterHpRng。参考先 construct 0 号再 construct 2 号。
  // ⚠⚠ ⑤ 是「**没有** `arr[idx] = Monster()`」——四个召唤宿主里只有这一个是**就地
  //   construct**，那一格原来的状态位 / 力量 / 格挡 / 意图历史**全部留着**。
  //   第四十批的贤者之石把这个差别变成了可观察的：开局 `initRelics` 给包括 0 / 2 号
  //   空格在内的每一格 +1 力量，于是球出生时就带 1 点，再加召唤那 +1 = 2。
  //   逐条见 `constructMonsterInPlace`。
  const orb1 = bc.monsters[0];
  const orb2 = bc.monsters[2];
  if (orb1 === undefined || orb2 === undefined) {
    throw new Error("sts-combat: 青铜自动机召唤时 0 / 2 号格不存在（编队构建器没预留空位？）");
  }
  constructMonsterInPlace(bc, orb1, "bronze_orb"); // ★ 2 次 monsterHpRng（白掷 + 正式）
  constructMonsterInPlace(bc, orb2, "bronze_orb"); // ★ 2 次 monsterHpRng
  // ⑥ MINION 标记（进怪物快照）。
  addPower(orb1.powers, "minion", 1);
  addPower(orb2.powers, "minion", 1);
  // 贤者之石（MonsterSpecific.cpp:3454-3457）：⚠ 这里排在 `buff<MINION>` **之后**、
  // 两次 rollMove 之前，与地精召唤那条（MINION 在后）相反。见 `philosophersStoneBuff`。
  philosophersStoneBuff(bc, orb1);
  philosophersStoneBuff(bc, orb2);
  // ⑦ 两颗各自 rollMove，排在 buff 之后。
  rollMove(bc, orb1); // ★ 消耗一次 aiRng
  rollMove(bc, orb2); // ★ 消耗一次 aiRng
  // ⑧ 只动 monstersAlive（排在两次 rollMove 之后，照抄位置）。
  bc.monstersAlive += 2;
  // ⑨ 游标推一格：2 号位那颗球本回合不行动。
  bc.monsterTurnIdx += 1;
}

/**
 * 收藏家的召唤（对齐 `Actions::SpawnTorchHeads`，Actions.cpp:500-527）。
 *
 * 本项目**第三条召唤路径**。前两条（地精首领的 `Actions::SummonGremlins`、青铜自动机的
 * `Monster::spawnBronzeOrbs`）在第二十八批已经并排比过、**八处形状全不同**；这一条与那
 * 两条**同样一处都不共用**。逐条照抄的点：
 *
 *  ①⚠⚠ **召几只是算出来的**：`spawnCount = 3 - bc.monsters.monstersAlive`。
 *     这是**全参考项目唯一**按 `monstersAlive` 决定召唤数量的地方，于是它顺带成了
 *     「预留空位不算活怪」这件事的预言机——`ENCOUNTER_BUILDERS.collector` 建完是
 *     `monsterCount = 3 / monstersAlive = 1`，所以开局那次召 **2** 只；若把两个空格
 *     算成活的（3），开局就一只都不召。第二十七批留下的那条盲区在这里关门。
 *     ⚠ 参考在这里只有一句 `assert(spawnCount > 0)`（release 版不检查）。调用点是
 *     出招规则里的 `monstersAlive < 3` 那道门 + 首回合恒召，所以 <= 0 走不到；
 *     我们照抄「循环 spawnCount 次」，自然对 <= 0 是空操作。
 *  ②⚠ **落位表写死**：`const int spawnIdxs[2] {(arr[1].isDying() ? 1 : 0), 0};`
 *     ——第一个是「1 号位空着就填 1、否则填 0」，第二个**恒是 0**。
 *     既不是地精那套「按 1,2,0 顺序搜索」，也不是青铜球那种「写死 0 与 2」。
 *     ⚠ 表在循环**之前**一次算好（C++ 的数组初始化），所以第一只填进 1 号位之后，
 *       第二只的下标仍然读的是那份旧快照里的 0——不会因为「1 号位现在活了」而改。
 *  ③⚠ 门是 `isDying()` = **血 <= 0**（空格血 0 也算），与地精那条同族。
 *  ④ **`torchHead = Monster()` 整只重建**（地精那条有、青铜球那条没有）。
 *  ⑤⚠⚠ **`construct` 之后又显式 `initHp` 一次**（`:513`，参考注着 `// bug somewhere
 *     in game`）→ 每只 **2 次 monsterHpRng**、**保留第二次**的取值。见 `initMonsterHp`。
 *  ⑥ `buff<MS::MINION>()`，排在 setMove 之后。
 *  ⑦⚠⚠ **意图靠 `setMove(TORCH_HEAD_TACKLE)`，不是 `rollMove`**——所以召唤本身
 *     **一次 aiRng 都不掷**（前两条召唤都是每只一次 rollMove）。参考的
 *     `getMoveForRoll` 对 `TORCH_HEAD` 落在 `default` 上（MonsterSpecific.cpp:3364）。
 *  ⑧ `++monstersAlive` 在**循环里**（每召一只加一次），不是末尾一次 `+= 2`。
 *  ⑨⚠⚠ **aiRng 在末尾按只数统一还**：`for (i < spawnCount) bc.noOpRollMove();`
 *     ——掷 `spawnCount` 次 `aiRng.random(99)` 全部丢掉。次数与召几只**绑定**：
 *     写成固定 2 次会在「只死了一只」的那些回合把 `rng.ai` 计数器错位。
 *  ⑩ **没有 `++monsterTurnIdx`**（青铜球那条有）：收藏家在**最后一格**（2 号位），
 *     新召的两只本回合本来就轮不到，参考因此不需要推游标。
 *  ⑪ `monsterCount`（= 我们的数组长度）一动不动，与前两条相同。
 */
function summonTorchHeads(bc: BattleContext): void {
  // ① 召几只由 monstersAlive 决定。
  const spawnCount = 3 - bc.monstersAlive;
  // ② 落位表在循环之前一次算好，第二格恒是 0。
  const spawnIdxs = [(bc.monsters[1]?.hp ?? 0) <= 0 ? 1 : 0, 0];
  for (let i = 0; i < spawnCount; i += 1) {
    const at = spawnIdxs[i];
    if (at === undefined) {
      // 参考的 `spawnIdxs` 只有两格，spawnCount 最多也是 2（3 - 1）。
      throw new Error(`sts-combat: 召唤火炬头的只数超出参考的落位表: ${String(spawnCount)}`);
    }
    // ④⑤ 整只重建 + 两次 monsterHpRng（construct 一次、显式 initHp 一次）。
    const torchHead = constructMonster(bc, "torch_head"); // ★ 消耗一次 monsterHpRng
    const rerolled = initMonsterHp(bc, "torch_head"); // ★ 再消耗一次 monsterHpRng（参考的「bug」）
    torchHead.hp = rerolled;
    torchHead.maxHp = rerolled;
    bc.monsters[at] = torchHead;
    // ⑦ setMove 而不是 rollMove：不掷 aiRng，且会前移 moveHistory（新怪的历史本来是空的）。
    setMove(torchHead, "torch_tackle");
    // ⑥ MINION 标记（进怪物快照）。
    addPower(torchHead.powers, "minion", 1);
    // 贤者之石（Actions.cpp:517-519）：在**循环里面**，MINION 之后、`++monstersAlive`
    // 之前。见 `philosophersStoneBuff`。
    philosophersStoneBuff(bc, torchHead);
    // ⑧ 每召一只加一次。
    bc.monstersAlive += 1;
  }
  // ⑨ 末尾按只数还 aiRng（noOpRollMove，掷完丢掉）。
  for (let i = 0; i < spawnCount; i += 1) {
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng，取值丢弃
  }
}

/**
 * 蜥蜴法师的召唤（对齐 `Monster::reptomancerSummon` + `reptoSummonHelper`，
 * MonsterSpecific.cpp:3565-3608）。
 *
 * 本项目**第四条也是最后一条**召唤路径。前三条（地精首领的 `Actions::SummonGremlins`、
 * 青铜自动机的 `Monster::spawnBronzeOrbs`、收藏家的 `Actions::SpawnTorchHeads`）在
 * 第二十九批已经并排比过 **11 个维度、没有一个三族一致**；这一条与那三条**同样一处都不共用**。
 * 逐条照抄的点：
 *
 *  ①⚠⚠ **召几只由爬升度决定**：`reptomancerSummon(bc, asc18 ? 2 : 1)`（`:1621`）——
 *     全参考项目唯一一个「召唤数量看爬升度」的地方。地精 / 青铜球恒 2、收藏家是
 *     `3 - monstersAlive`。asc0 下恒 **1** 只，所以 asc18 那一档是本批的结构性盲区。
 *  ②⚠ **同步调用**（`:1620-1622` 没有 addToBot），与青铜自动机同侧、与地精首领 /
 *     收藏家（都是 `addToBot(Actions::…)`）相反。
 *  ③⚠⚠ **找空位的顺序是写死的 `{4, 1, 3, 0}`**（`reptoSummonHelper` 的 `searchOrder`），
 *     门是 `!isAlive()` = **血 <= 0**。⚠ 它只扫这 **4** 格，**2 号位（法师自己）不在表里**。
 *     ⚠ 三条对比：地精是 `{1, 2, 0}`、青铜球写死 0 与 2 且**不判空**、收藏家是
 *       `{arr[1].isDying() ? 1 : 0, 0}` 这张两格的落位表。四条各写各的。
 *     ⚠ 参考在找不满时是 `assert(false)`（release 版会读未初始化的下标），我们显式抛错。
 *  ④ **`dagger = Monster()` 整只重建**（地精 / 收藏家有、青铜球没有）：那一格上残留的
 *     易伤 / 格挡 / 意图历史全清零。
 *  ⑤ 血量：`construct` 里掷**一次**（匕首是普通的 `setRandomHp`，既不白掷也不跑两遍）。
 *  ⑥⚠ **`++monstersAlive` 排在 `construct` 之后、`setMove` 之前**（收藏家那条在循环末尾）。
 *  ⑦⚠ **意图靠 `setMove(DAGGER_STAB)`**（与收藏家同侧、与地精 / 青铜球的 `rollMove` 相反），
 *     所以召唤本身不为「选意图」掷 aiRng。
 *  ⑧ `buff<MS::MINION>()` 排在 setMove 之后。⚠ 匕首自己的 `preBattleAction` 也是这一句，
 *     而召唤**不重跑** `preBattleAction`——两者净效果相同，所以这条「不重跑」在匕首身上
 *     是可证的空操作（探针无效），见 `PRE_BATTLE_ACTION.dagger`。
 *  ⑨⚠⚠ **aiRng 在循环里逐只还**：`bc.noOpRollMove()` 写在 for 体**内**，每召一只一次。
 *     收藏家是循环**之外**再跑一个 for 统一还——次数相同、位置不同（召两只时可观察）。
 *  ⑩⚠⚠ **末尾 `bc.monsters.skipTurn.set(daggerIdx, true)`**：全参考项目**唯一**的写入点。
 *     落在游标还没走到的格子里的匕首**本回合不行动**（法师在 2 号位，4 号与 3 号都在它右边）。
 *     ⚠ 前三条召唤都不用它：青铜球靠 `++monsterTurnIdx` 推游标，地精首领与收藏家的宿主
 *     位置让新来的本来就轮不到。见 `BattleContext.skipTurn` 与 `doMonsterTurn`。
 *  ⑪ **没有 `++monsterTurnIdx`**（青铜球那条有）；`monsterCount`（= 数组长度）一动不动。
 */
function reptomancerSummon(bc: BattleContext, daggerCount: number): void {
  // ③ 落位：写死的搜索顺序 {4, 1, 3, 0}，门是「血 <= 0」（空格血 0，天然算空）。
  const searchOrder = [4, 1, 3, 0];
  const daggerIdxs: number[] = [];
  for (const mIdx of searchOrder) {
    if ((bc.monsters[mIdx]?.hp ?? 0) <= 0) {
      daggerIdxs.push(mIdx);
    }
    if (daggerIdxs.length === daggerCount) {
      break;
    }
  }
  if (daggerIdxs.length !== daggerCount) {
    throw new Error(`sts-combat 召唤匕首时空位不够: 要 ${String(daggerCount)} 个`);
  }
  for (const daggerIdx of daggerIdxs) {
    // ④⑤ 整只重建 + 一次 monsterHpRng。
    const dagger = constructMonster(bc, "dagger"); // ★ 消耗一次 monsterHpRng
    bc.monsters[daggerIdx] = dagger;
    // ⑥ 每召一只加一次，排在 setMove 之前。
    bc.monstersAlive += 1;
    // ⑦ setMove 而不是 rollMove：不掷 aiRng（新怪的历史本来是空的）。
    setMove(dagger, "dagger_stab");
    // ⑧ MINION 标记（进怪物快照）。
    addPower(dagger.powers, "minion", 1);
    // 贤者之石（MonsterSpecific.cpp:3601-3603）：在**循环里面**，MINION 之后、
    // `noOpRollMove` 之前。见 `philosophersStoneBuff`。
    philosophersStoneBuff(bc, dagger);
    // ⑨ 每只各还一次 aiRng（noOpRollMove，掷完丢掉）——**在循环里面**。
    bc.rng.aiRng.random(99); // ★ 消耗一次 aiRng，取值丢弃
    // ⑩ 本回合不行动。
    bc.skipTurn.add(daggerIdx);
  }
}

// ============================================================================
// 停滞（对齐 `Monster::stasisAction` / `stasisHelper` / `returnStasisCard`，
// MonsterSpecific.cpp:3467-3565）。青铜球专用，参考里全项目只有它一个用户。
// ============================================================================

/**
 * 参考的**卡牌稀有度**与**排序下标**（`Cards.h` 的 `cardRarities` / `cardSortedIdx`）。
 *
 * ⚠⚠ **这张表不能从 `CardDef.rarity` 派生**，这是本批最容易「省掉」的一处：
 *  * 我们的 `CardDef.rarity` 表达的是「进哪个**奖励池**」（run 层语义），参考的
 *    `cardRarities` 是游戏里那张**每张牌自带的稀有度**表，两者在 118 张已映射的牌里
 *    **有 15 张不一致**——状态牌（伤口 / 灼伤 / 恍惚 / 黏液）在参考里是 **COMMON**
 *    而我们是 `special`，另外 11 张（急躁 / 极限爆发 / 掘尸 / 未雨绸缪 / 鲁莽冲锋 /
 *    幻影 / 多面手 / 启蒙 / 先见之明 / 施虐本性 / 炸弹）我们比参考低一档。
 *    拿 `rarity` 顶替会让停滞挑错牌，而且**只在特定牌堆构成下才分岔**（静默错）。
 *  * 判据与第二十三批的 `isMoveAttack` 白名单同一条：意图表是给渲染用的，
 *    参考怎么判是另一件事，**两者必须分开存**。
 *
 * ⚠ `cardSortedIdx`（`Cards.h:427`）是「按游戏内部卡 id 字符串字典序」的下标——
 * 与枚举名序**不完全一致**（`A_THOUSAND_CUTS` 是 0、`RUSHDOWN` 的内部 id 是 "Adaptation"
 * 所以排在 3、`APPARITION` 的内部 id 是 "Ghostly" 所以排在 166）。所以它只能**照抄数值**，
 * 不能在这边按名字重算。
 *
 * ⚠ 表里只列 harness 能真正塞进牌堆的那 118 张（= `test/sts-combat-trace.test.ts` 的 `CARD`
 * 映射那一份）。查不到就**显式抛错**——与「未登记的卡显式抛错」同一条总纲：停滞挑错一张
 * 比开不了战危险得多。
 */
const STASIS_CARD_INFO: Record<
  string,
  readonly [number, "common" | "uncommon" | "rare" | "other"]
> = {
  anger: [11, "common"],
  apotheosis: [12, "rare"],
  armaments: [13, "common"],
  ascenders_bane: [14, "other"], // SPECIAL
  bandage_up: [19, "uncommon"],
  barricade: [22, "rare"],
  bash: [23, "other"], // BASIC
  battle_trance: [24, "uncommon"],
  berserk: [28, "rare"],
  bite: [31, "other"], // SPECIAL
  blind: [34, "uncommon"],
  blood_for_blood: [36, "uncommon"],
  bloodletting: [37, "uncommon"],
  bludgeon: [38, "rare"],
  body_slam: [40, "common"],
  brutality: [45, "rare"],
  burn: [48, "common"], // ⚠ 状态牌在参考里是 COMMON，不是 special
  burning_pact: [49, "uncommon"],
  carnage: [54, "uncommon"],
  chrysalis: [60, "rare"],
  clash: [61, "common"],
  cleave: [63, "common"],
  clothesline: [65, "common"],
  combust: [69, "uncommon"],
  corruption: [80, "rare"],
  dark_embrace: [89, "uncommon"],
  dark_shackles: [90, "uncommon"],
  dazed: [93, "common"], // ⚠ 同上
  deep_breath: [97, "uncommon"],
  defend: [98, "other"], // BASIC
  demon_form: [104, "rare"],
  disarm: [109, "uncommon"],
  discovery: [110, "uncommon"],
  double_tap: [116, "rare"],
  dramatic_entrance: [118, "uncommon"],
  dropkick: [119, "uncommon"],
  dual_wield: [120, "uncommon"],
  enlightenment: [128, "uncommon"],
  entrench: [129, "uncommon"],
  evolve: [136, "uncommon"],
  exhume: [137, "rare"],
  feed: [144, "rare"],
  feel_no_pain: [145, "uncommon"],
  fiend_fire: [146, "rare"],
  finesse: [147, "uncommon"],
  fire_breathing: [149, "uncommon"],
  flame_barrier: [151, "uncommon"],
  flash_of_steel: [152, "uncommon"],
  flex: [154, "common"],
  forethought: [162, "uncommon"],
  apparition: [166, "other"], // SPECIAL；内部 id 是 "Ghostly"，故排在这里
  ghostly_armor: [167, "uncommon"],
  good_instincts: [171, "uncommon"],
  hand_of_greed: [174, "rare"],
  havoc: [175, "common"],
  headbutt: [176, "common"],
  heavy_blade: [178, "common"],
  hemokinesis: [181, "uncommon"],
  immolate: [185, "rare"],
  impatience: [186, "uncommon"],
  impervious: [187, "rare"],
  infernal_blade: [189, "uncommon"],
  inflame: [191, "uncommon"],
  intimidate: [195, "uncommon"],
  iron_wave: [196, "common"],
  jax: [197, "other"], // SPECIAL
  jack_of_all_trades: [198, "uncommon"],
  juggernaut: [200, "rare"],
  limit_break: [206, "rare"],
  madness: [211, "uncommon"],
  magnetism: [212, "rare"],
  master_of_strategy: [214, "rare"],
  mayhem: [217, "rare"],
  metallicize: [221, "uncommon"],
  metamorphosis: [222, "rare"],
  mind_blast: [224, "uncommon"],
  offering: [233, "rare"],
  panacea: [238, "uncommon"],
  panache: [239, "rare"],
  panic_button: [240, "uncommon"],
  perfected_strike: [243, "common"],
  pommel_strike: [248, "common"],
  power_through: [249, "uncommon"],
  pummel: [256, "uncommon"],
  purity: [257, "uncommon"],
  rage: [259, "uncommon"],
  rampage: [262, "uncommon"],
  reaper: [264, "rare"],
  reckless_charge: [267, "uncommon"],
  rupture: [277, "uncommon"],
  sadistic_nature: [278, "rare"],
  searing_blow: [285, "uncommon"],
  second_wind: [286, "uncommon"],
  secret_technique: [287, "rare"],
  secret_weapon: [288, "rare"],
  seeing_red: [289, "uncommon"],
  sentinel: [292, "uncommon"],
  sever_soul: [294, "uncommon"],
  shockwave: [297, "uncommon"],
  shrug_it_off: [298, "common"],
  slimed: [303, "common"], // ⚠ 同上
  spot_weakness: [306, "uncommon"],
  strike: [316, "other"], // BASIC（`STRIKE_RED`；四个角色的起始打击共用这一条）
  swift_strike: [323, "uncommon"],
  sword_boomerang: [325, "common"],
  the_bomb: [331, "rare"],
  thinking_ahead: [332, "rare"],
  thunderclap: [336, "common"],
  transmutation: [338, "rare"],
  trip: [339, "uncommon"],
  true_grit: [340, "common"],
  twin_strike: [342, "common"],
  uppercut: [346, "uncommon"],
  violence: [351, "rare"],
  warcry: [354, "common"],
  whirlwind: [359, "uncommon"],
  wild_strike: [361, "common"],
  wound: [366, "common"], // ⚠ 同上
};

function stasisCardInfo(
  defId: string,
): readonly [number, "common" | "uncommon" | "rare" | "other"] {
  const info = STASIS_CARD_INFO[defId];
  if (info === undefined) {
    throw new Error(`sts-combat 停滞：暂未登记卡牌的参考稀有度 / 排序下标: ${defId}`);
  }
  return info;
}

/**
 * 从一个牌堆里挑出「被停滞扣住」的那一张的下标（对齐 `stasisHelper`，
 * MonsterSpecific.cpp:3474-3513）。**恰好消耗一次 `cardRandomRng`**（两条路径都是）。
 *
 * 逐条照抄：
 *  ① 先数一遍稀有度，按 **RARE → UNCOMMON → COMMON** 的优先级选一个目标稀有度；
 *  ② 三种一张都没有（整堆只有 BASIC / SPECIAL / CURSE）→ **直接** `rng.random(n-1)`
 *     在**整堆**里平均挑，不再过滤。⚠ 这是唯一不看稀有度的一支。
 *  ③ 否则把该稀有度的牌收成 `{堆内下标, cardSortedIdx}`，按 `cardSortedIdx` **稳定排序**，
 *     再 `rng.random(size-1)` 取一个，返回它的**堆内下标**。
 *     ⚠ 排序是必要的：它把「取到第几个」从「牌堆里的物理顺序」换成了「卡 id 的字典序」。
 * ⚠ 参考的 `idxList` 是 `fixed_list<StasisPair, CardManager::MAX_GROUP_SIZE = 64>` 且
 *   `fixed_list` **没有越界检查**——同一稀有度的牌在一个牌堆里超过 64 张就是静默内存破坏。
 *   当前 harness 给自动机的牌组只有 22 张，够不到；将来把它配大牌组时要先数一遍。
 */
function stasisHelper(bc: BattleContext, pile: CombatCard[]): number {
  const counts = { common: 0, uncommon: 0, rare: 0, other: 0 };
  for (const c of pile) {
    counts[stasisCardInfo(c.defId)[1]] += 1;
  }
  const target =
    counts.rare !== 0
      ? "rare"
      : counts.uncommon !== 0
        ? "uncommon"
        : counts.common !== 0
          ? "common"
          : null;
  if (target === null) {
    return bc.rng.cardRandomRng.random(pile.length - 1); // ★ 消耗一次 cardRandomRng
  }
  const idxList: { groupIdx: number; idOrder: number }[] = [];
  for (let i = 0; i < pile.length; i += 1) {
    const [idOrder, rarity] = stasisCardInfo(pile[i]?.defId ?? "");
    if (rarity === target) {
      idxList.push({ groupIdx: i, idOrder });
    }
  }
  // `std::stable_sort`：等值时保持原有相对顺序。`cardSortedIdx` 逐 id 唯一，所以
  // 只有「同一张牌的多份副本」会等值，而它们本来就按堆内顺序排着——用稳定排序照抄。
  idxList.sort((a, b) => a.idOrder - b.idOrder);
  const pick = bc.rng.cardRandomRng.random(idxList.length - 1); // ★ 消耗一次 cardRandomRng
  const chosen = idxList[pick];
  if (chosen === undefined) {
    throw new Error(`sts-combat 停滞取样越界: ${pick}/${idxList.length}`);
  }
  return chosen.groupIdx;
}

/**
 * 停滞：把玩家的一张牌从牌堆里扣住（对齐 `Monster::stasisAction`，MonsterSpecific.cpp:3515-3549）。
 *
 * 逐条照抄：
 *  ①⚠ **抽牌堆与弃牌堆都空时直接 return**：不掷 RNG、不上 `STASIS`、什么都不做。
 *     （这一支真的会走到——被停滞的球活到玩家把牌打空的时候。）
 *  ②⚠ **抽牌堆空才去弃牌堆**，不是「两堆合起来挑」。
 *  ③ 取走之后 `notifyRemoveFromCombat`（会减 `strikeCount` —— 完美打击的伤害读它）。
 *  ④⚠ 槽位是 **`min(1, idx)`**：0 号位的球存槽 0，2 号位的球存槽 1（1 号位是自动机自己，
 *     不会调这个函数）。两颗球各占一格，所以两张牌能同时被扣住。
 *  ⑤ 最后 `buff<MS::STASIS>()` —— 它进怪物快照，也是 `monsterDie` 还牌的开关。
 */
function stasisAction(bc: BattleContext, m: CombatMonster): void {
  if (bc.drawPile.length === 0 && bc.discardPile.length === 0) {
    return; // ① 两堆都空：一次 RNG 都不掷
  }
  const fromDiscard = bc.drawPile.length === 0; // ②
  const pile = fromDiscard ? bc.discardPile : bc.drawPile;
  const removeIdx = stasisHelper(bc, pile); // ★ 消耗一次 cardRandomRng
  const card = pile[removeIdx];
  if (card === undefined) {
    throw new Error(`sts-combat 停滞：取牌下标越界 ${removeIdx}`);
  }
  pile.splice(removeIdx, 1);
  notifyRemoveFromCombat(bc, card); // ③
  const slot = Math.min(1, bc.monsters.indexOf(m)); // ④
  bc.stasisCards[slot] = card;
  addPower(m.powers, "stasis", 1); // ⑤
}

/**
 * 把被扣住的牌还回手牌（对齐 `Monster::returnStasisCard`，MonsterSpecific.cpp:3552-3565）。
 * 由 `monsterDie` 的 else-if 链调用。
 *
 * ⚠ 三处照抄：① 槽位同样是 `min(idx, 1)`；② `notifyAddCardToCombat` 在
 * `moveToHandHelper` **之前**（`strikeCount` 先加回来）；③ 走 `moveToHandHelper`，
 * 所以**手牌满 10 张时它进弃牌堆**而不是被丢掉。
 * ⚠ 参考在还完之后把槽位写回 `INVALID`（我们置 null）——一颗球只会死一次，
 * 但那一句是参考写着的，照抄。
 */
function returnStasisCard(bc: BattleContext, m: CombatMonster): void {
  const slot = Math.min(bc.monsters.indexOf(m), 1);
  const card = bc.stasisCards[slot];
  if (card === undefined || card === null) {
    throw new Error(`sts-combat 停滞：${slot} 号槽是空的，却要还牌（哪一处漏了 stasisAction？）`);
  }
  notifyAddCardToCombat(bc, card);
  moveToHandHelper(bc, card);
  bc.stasisCards[slot] = null;
}

/**
 * 「先把候选全部造出来，再挑一个」（对齐 `MonsterGroup::createWeakWildlife` /
 * `createStrongHumanoid`，MonsterGroup.cpp:497 / :477）。
 *
 * ⚠ 这是本批最容易「优化」错的地方，照抄不要改成「先选后造」：
 *  ① 三个候选**全部** `construct` 一遍——每只都掷一次 monsterHpRng，虱子还要再掷一次
 *     咬击伤害。落选的两只的 RNG 消耗**不会退回**。
 *  ② 候选表本身可能带 RNG：`createWeakWildlife` 的第 0 项是 `getLouse(bc.miscRng)`、
 *     `createStrongHumanoid` 的第 1 项是 `getSlaver(bc.miscRng)`——它们是**实参**，
 *     所以在那一只的血量之前就掷了。
 *  ③ 最后才 `miscRng.random(2)` 选下标（**恒掷**，即使只有一个候选活得下来）。
 * 于是一场 `EXORDIUM_THUGS` 开局固定消耗 7 次 monsterHpRng、4 次 miscRng。
 */
function createFromConstructedPool(bc: BattleContext, defIds: (() => string)[]): void {
  const temp = defIds.map((pick) => constructMonster(bc, pick())); // ★ 每只一次（虱子两次）monsterHpRng
  const idx = bc.rng.miscRng.random(temp.length - 1); // ★ 消耗一次 miscRng
  const chosen = temp[idx];
  if (chosen === undefined) {
    throw new Error(`sts-combat 候选池取样越界: ${idx}/${temp.length}`);
  }
  bc.monsters.push(chosen);
}

const ENCOUNTER_BUILDERS: Record<string, EncounterBuilder> = {
  two_louse: (bc) => {
    createMonster(bc, getLouse(bc));
    createMonster(bc, getLouse(bc));
  },
  three_louse: (bc) => {
    createMonster(bc, getLouse(bc));
    createMonster(bc, getLouse(bc));
    createMonster(bc, getLouse(bc));
  },

  // 小史莱姆组：一次 miscRng.randomBoolean 在两种**固定组合**之间二选一
  // （对齐 MonsterGroup.cpp:126 SMALL_SLIMES）。
  // ⚠ 不是「逐只随机」——两只的种类是绑定的，而且**顺序也绑定**（true 那支尖刺小在前）。
  small_slimes: (bc) => {
    if (bc.rng.miscRng.randomBoolean()) {
      // ★ 消耗一次 miscRng
      createMonster(bc, "spike_slime_s");
      createMonster(bc, "acid_slime_m");
    } else {
      createMonster(bc, "acid_slime_s");
      createMonster(bc, "spike_slime_m");
    }
  },

  // 史莱姆群：成员集合是固定的 5 只（3 尖刺小 + 2 酸液小），随机的只有**出场顺序**
  // （对齐 MonsterGroup.cpp:137 LOTS_OF_SLIMES）。
  //
  // ⚠ 这不是普通的洗牌，**照抄不要等价改写**：
  //  ① 循环是 `for (i = 4; i >= 0; --i)`，每轮 `miscRng.random(i)` 的**上界逐轮缩小**
  //     （5 次消耗，bound 依次 4/3/2/1/0，最后一次 `random(0)` 照样掷）；
  //  ② 取走 `pool[idx]` 之后把它**右边的元素整体左移一格**（`while (idx < i)`），
  //     而不是常见的「与末位交换」。两种写法产生的排列分布相同，但**同种子下的排列不同**；
  //  ③ 参考不缩短数组，只靠 i 递减来收缩有效区间——左移之后 `pool[i]` 是一份残留副本，
  //     下一轮取不到它，因为 bound 已经变成 i-1。
  lots_of_slimes: (bc) => {
    const pool = [
      "spike_slime_s",
      "spike_slime_s",
      "spike_slime_s",
      "acid_slime_s",
      "acid_slime_s",
    ];
    for (let i = 4; i >= 0; i -= 1) {
      let idx = bc.rng.miscRng.random(i); // ★ 消耗一次 miscRng
      const slime = pool[idx];
      while (idx < i) {
        pool[idx] = pool[idx + 1]!;
        idx += 1;
      }
      createMonster(bc, slime);
    }
  },

  // 大史莱姆：一次 miscRng.randomBoolean 在酸液 / 尖刺之间二选一
  // （对齐 MonsterGroup.cpp:157 LARGE_SLIME）。
  // ⚠ true 那支是**酸液**（与小史莱姆组那条 true=尖刺 反过来），照抄不要凭印象写。
  large_slime: (bc) => {
    const id = bc.rng.miscRng.randomBoolean() ? "acid_slime_l" : "spike_slime_l"; // ★ 消耗一次 miscRng
    createMonster(bc, id);
  },

  // 恶棍二人组：`createWeakWildlife` 再 `createStrongHumanoid`（对齐 MonsterGroup.cpp:163）。
  // 两段都是「构造全部再选一个」，见 `createFromConstructedPool`。
  // ⚠ 顺序不能换：先野生动物后人形，两段的 RNG 消耗是串在一条流上的。
  exordium_thugs: (bc) => {
    // createWeakWildlife（MonsterGroup.cpp:497）：红/绿虱二选一 → 尖刺史莱姆中 → 酸液史莱姆中。
    createFromConstructedPool(bc, [
      () => getLouse(bc),
      () => "spike_slime_m",
      () => "acid_slime_m",
    ]);
    // createStrongHumanoid（MonsterGroup.cpp:477）：邪教徒 → 红/蓝奴隶主二选一 → 抢劫者。
    createFromConstructedPool(bc, [() => "cultist", () => getSlaver(bc), () => "looter"]);
  },

  // 荒野二人组（第十六批）：`createStrongWildlife` 再 `createWeakWildlife`
  // （对齐 MonsterGroup.cpp:168-171）。
  // ⚠⚠ **顺序与恶棍二人组相反**：这里是**先 strong 后 weak**。两段的 RNG 消耗串在同一条流上，
  //    换个顺序 monsterHpRng / miscRng 会整体错位（恶棍二人组是先 weak 后 strong）。
  // ⚠ `createStrongWildlife` 的候选只有两个，所以选下标那次是 `miscRng.random(1)`
  //   （`createFromConstructedPool` 用 `候选数 - 1` 表达，不写死 2）。
  // ⚠ 参考给这两只 construct 传的 idx 是**常量 0** 而不是 `monsterCount`
  //   （MonsterGroup.cpp:489-490）——本编队里 strong 排第一，两者恰好相等；而且我们的
  //   下标是数组位置，`Monster::idx` 只被 RollMove 用来指回自己，故不受影响。
  // 一场 EXORDIUM_WILDLIFE 因此固定消耗 **6 次 monsterHpRng**（真菌兽 1 + 颚虫 1 + 虱子 2
  // + 尖刺中 1 + 酸液中 1）与 **3 次 miscRng**（getLouse 1 + 两次选下标）。
  exordium_wildlife: (bc) => {
    // createStrongWildlife（MonsterGroup.cpp:487）：真菌兽 → 颚虫，二选一。
    createFromConstructedPool(bc, [() => "fungi_beast", () => "jaw_worm"]);
    // createWeakWildlife（MonsterGroup.cpp:497）：红/绿虱二选一 → 尖刺史莱姆中 → 酸液史莱姆中。
    // 与 exordium_thugs 那段是同一个函数、同一份候选表。
    createFromConstructedPool(bc, [
      () => getLouse(bc),
      () => "spike_slime_m",
      () => "acid_slime_m",
    ]);
  },

  // 地精帮（第十七批）：从 8 个候选里**不放回地抽 4 只**（对齐 MonsterGroup.cpp:100-122）。
  //
  // ⚠ 与 `lots_of_slimes` 同族但**不是同一段代码**，四处差别都要照抄：
  //  ① 候选表是 8 项且**带重复**（狂暴 ×2、鬼祟 ×2、肥胖 ×2、护盾 ×1、巫师 ×1）
  //     ——所以「同一只怪出现两次」是正常的，而护盾/巫师最多各一只；
  //  ② 有效区间由**独立的 `lastIdx`**（初值 7）表达，每轮取完才 `--lastIdx`；
  //     史莱姆群那段是拿循环变量 `i` 兼作上界。两者在本例里等价，但写法照抄更安全；
  //  ③ 循环**恰好 4 轮**（`for i in 0..3`），不是把池子抽干；
  //  ④ 取走 `pool[idx]` 之后是**整体左移**（`while (idx < lastIdx) pool[idx] = pool[idx+1]`），
  //     **不是**「与末位交换」——两种写法分布相同、同种子下排列不同。
  //     第十三批实测过这条：史莱姆群改成交换当场红 253 例。
  // ⚠ RNG 交错：每轮先 `miscRng.random(lastIdx)` 选下标，**再** `createMonster` 掷血量，
  //   所以流是 misc,hp,misc,hp,misc,hp,misc,hp（狂暴地精没有 construct 特例，不额外掷）。
  gremlin_gang: (bc) => {
    const pool = [
      "mad_gremlin",
      "mad_gremlin",
      "sneaky_gremlin",
      "sneaky_gremlin",
      "fat_gremlin",
      "fat_gremlin",
      "shield_gremlin",
      "gremlin_wizard",
    ];
    let lastIdx = 7;
    for (let i = 0; i < 4; i += 1) {
      let idx = bc.rng.miscRng.random(lastIdx); // ★ 消耗一次 miscRng
      const gremlin = pool[idx];
      while (idx < lastIdx) {
        pool[idx] = pool[idx + 1]!;
        idx += 1;
      }
      lastIdx -= 1;
      createMonster(bc, gremlin); // ★ 消耗一次 monsterHpRng
    }
  },

  // 地精首领（第二十七批）：对齐 MonsterGroup.cpp:248-259。
  //
  // ⚠⚠ **它是第一个「开局就留空位」的编队**，而且不走 `createMonster`：参考直接写
  //   `arr[1] / arr[2] / arr[3]` 三格，然后**手动赋值** `monstersAlive = 3; monsterCount = 4;`
  //   ——于是 **0 号位从头到尾没被构造过**（默认 `Monster`，血 0、`idx == -1`、
  //   意图 `INVALID`），却因为 `monsterCount == 4` 照样被 dump 出来。
  //   那一格正是 `Actions::SummonGremlins` 要往里填的空位之一。
  //   ⚠ 与史莱姆王分裂留下的 1 号空格是**同一种占位**（`EMPTY_MONSTER_SLOT`），
  //     只是那个是打着打着出现的、这个开局就在。
  //
  // ⚠ RNG 交错是 misc, hp, misc, hp, hp：两只小鬼各「先掷种类（miscRng）再掷血（hpRng）」
  //   ——`getGremlin(bc.miscRng)` 是 `construct` 的实参，C++ 先算实参。首领自己只掷血。
  //
  // ⚠ 两只小鬼在 `construct` **之后**立刻 `buff<MS::MINION>()`（首领的 MINION_LEADER 反而在
  //   `preBattleAction` 里，晚得多）。MINION 在战斗内一次都不被读，但它进怪物快照。
  //
  // ⚠ **`arr[0]` 不参与 `MonsterGroup::init` 的后两个循环**：那两个循环的门是
  //   `if (arr[i].idx != -1)`（MonsterGroup.cpp:76-89），默认 `Monster` 的 `idx` 是 -1。
  //   所以空格既不 rollMove 也不 preBattleAction，见 `initCombat` 里那两处的跳过条件。
  gremlin_leader: (bc) => {
    // 0 号位：预留的空格（参考压根没碰它，我们用占位实体表达 `monsterCount` 数到它）。
    bc.monsters.push(emptyMonsterSlot());
    for (let i = 0; i < 2; i += 1) {
      const g = constructMonster(bc, getGremlin(bc.rng.miscRng)); // ★ 一次 miscRng + 一次 monsterHpRng
      addPower(g.powers, "minion", 1);
      bc.monsters.push(g);
    }
    // 3 号位：首领本尊（`ENCOUNTERS.gremlin_leader.enemies` 那份 `enemies` 只是旧近似战斗的
    // 占位，真相在这里）。
    createMonster(bc, "gremlin_leader"); // ★ 消耗一次 monsterHpRng
  },

  // 青铜自动机（第二十八批）：对齐 MonsterGroup.cpp:173-177。
  //
  // ⚠⚠ **参考这三句要照抄，别「整理」**：
  //   ```cpp
  //   monsterCount = 1;                              // ← 先把游标推到 1
  //   createMonster(bc, MonsterId::BRONZE_AUTOMATON); // ← 于是它落在 arr[1]，count → 2
  //   ++monsterCount;                                // ← 再空出一格，count → 3
  //   ```
  //   净效果是「**0 号位与 2 号位都是预留空位**，自动机在中间的 1 号位，`monsterCount = 3`、
  //   `monstersAlive = 1`」。那两格正是 `spawnBronzeOrbs` 要往里填的。
  // ⚠ 与地精首领那个预留写法**形状不同**（那边只留 0 号位，而且 `monstersAlive` /
  //   `monsterCount` 是手动赋值的 3 / 4）。两处各写各的，照抄邻居必错。
  // ⚠ 顺序的可观察面：自动机在 **1 号位**，所以青铜球的支援光束那句写死的 `arr[1]`
  //   正好指着它；而 harness 的策略恒打 0 号位，于是召唤之前打自动机、召唤之后打 0 号球。
  // ⚠ 两个空格都不参与 `MonsterGroup::init` 的后两个循环（门是 `arr[i].idx != -1`），
  //   见 `initCombat` 里那两处的 `EMPTY_MONSTER_SLOT` 跳过条件。
  automaton: (bc) => {
    bc.monsters.push(emptyMonsterSlot()); // 0 号位：预留（`monsterCount = 1` 跳过的那一格）
    createMonster(bc, "bronze_automaton"); // 1 号位 ★ 消耗一次 monsterHpRng
    bc.monsters.push(emptyMonsterSlot()); // 2 号位：预留（末尾那句 `++monsterCount`）
  },

  // 收藏家（第二十九批）：对齐 MonsterGroup.cpp:198-201。
  //
  // ⚠⚠ **「怎么预留空位」的第三种写法**，参考只有两句：
  //   ```cpp
  //   monsterCount = 2;                            // ← 游标直接跳到 2
  //   createMonster(bc, MonsterId::THE_COLLECTOR); // ← 于是它落在 arr[2]，count → 3
  //   ```
  //   净效果是「**0 号位与 1 号位都是预留空位**，收藏家在**最后一格**（2 号位），
  //   `monsterCount = 3`、`monstersAlive = 1`」。那两格正是 `summonTorchHeads` 要填的。
  // ⚠ 三种预留写法逐个都不同，照抄邻居必错：
  //   地精首领 —— 建 1/2/3 三格 + **手动赋值** `monstersAlive = 3; monsterCount = 4;`（只留 0 号位）；
  //   青铜自动机 —— `monsterCount = 1; createMonster(...); ++monsterCount;`（留 0 与 2、宿主在中间）；
  //   收藏家 —— `monsterCount = 2; createMonster(...);`（留 0 与 1、宿主在最后，**没有**末尾那句 `++`）。
  // ⚠ 「宿主在最后一格」有可观察面：`doMonsterTurn` 的游标走到 2 时收藏家才行动，
  //   它排的 `SpawnTorchHeads` 出队时游标已经越过 `monsterCount`——所以新召的两只
  //   本回合不行动，参考因此**不需要** `++monsterTurnIdx`（青铜自动机那条需要）。
  // ⚠ 两个空格都不参与 `MonsterGroup::init` 的后两个循环（门是 `arr[i].idx != -1`），
  //   见 `initCombat` 里那两处的 `EMPTY_MONSTER_SLOT` 跳过条件。
  collector: (bc) => {
    bc.monsters.push(emptyMonsterSlot()); // 0 号位：预留
    bc.monsters.push(emptyMonsterSlot()); // 1 号位：预留（`monsterCount = 2` 跳过的那两格）
    createMonster(bc, "the_collector"); // 2 号位 ★ 消耗一次 monsterHpRng
  },

  // —— 第三十二批：第三幕开张，三个「形状怪」编队 ——
  //
  // ⚠⚠ **三个编队用的不是同一条建怪路径**，照抄别合并（这正是本批最容易错的一处）：
  //   `THREE_SHAPES` / `FOUR_SHAPES`  → `createShapes(bc, n)`：6 项池、**不放回**；
  //   `SPHERE_AND_TWO_SHAPES`         → 两次 `getAncientShape(bc.miscRng)`：3 项表、**有放回**。
  // 两张表的项数、重复度、书写顺序全都不同，见那两个函数的注释。

  // 三形状（MonsterGroup.cpp:437-439）：`createShapes(bc, 3)`，一句话。
  three_shapes: (bc) => {
    createShapes(bc, 3);
  },

  // 四形状（MonsterGroup.cpp:240-242）：`createShapes(bc, 4)`。
  // ⚠ 池子只有 6 项、每种两份，所以抽 4 只之后必然至少有两种各出两只。
  four_shapes: (bc) => {
    createShapes(bc, 4);
  },

  // 球卫 + 两形状（MonsterGroup.cpp:384-388）：
  //     createMonster(bc, getAncientShape(bc.miscRng));
  //     createMonster(bc, getAncientShape(bc.miscRng));
  //     createMonster(bc, MonsterId::SPHERIC_GUARDIAN);
  // ⚠ 三处照抄：
  //  ① 两只形状怪走的是 **`getAncientShape`（3 项、有放回）**，不是 `createShapes`
  //     ——所以两只**可以是同一种**，而 `THREE_SHAPES` 里不可能出现三只同种。
  //  ② **球状守卫者排在最后**（2 号位），两只形状怪在 0 / 1 号位。
  //  ③ RNG 交错是 misc, hp, misc, hp，**然后**球卫那一次**一次 monsterHpRng 都不掷**
  //     （它是 `hpNoRoll` 那一族，见 `initMonsterHp`）。所以整场只消耗 2 次 miscRng
  //     与 2 次 monsterHpRng。
  sphere_and_two_shapes: (bc) => {
    createMonster(bc, getAncientShape(bc)); // ★ 一次 miscRng + 一次 monsterHpRng
    createMonster(bc, getAncientShape(bc)); // ★ 一次 miscRng + 一次 monsterHpRng
    createMonster(bc, "spheric_guardian"); // ★ hpNoRoll：**不掷** monsterHpRng
  },

  // 蜥蜴法师（第三十六批）：对齐 MonsterGroup.cpp:339-345。
  //
  // ⚠⚠ **「怎么预留空位」的第四种写法**，参考是五句：
  //   ```cpp
  //   ++monsterCount;                            // ← 先空出 0 号位，count → 1
  //   createMonster(bc, MonsterId::DAGGER);       // ← 落在 arr[1]，count → 2
  //   createMonster(bc, MonsterId::REPTOMANCER);  // ← 落在 arr[2]，count → 3
  //   ++monsterCount;                            // ← 再空出 3 号位，count → 4
  //   createMonster(bc, MonsterId::DAGGER);       // ← 落在 arr[4]，count → 5
  //   ```
  //   净效果是「**0 号位与 3 号位是预留空位**，两把匕首在 1 / 4 号位、法师在**中间的
  //   2 号位**，`monsterCount = 5`、`monstersAlive = 3`」。
  // ⚠⚠ 它与前三种预留写法**没有一处相同**（并列表见 WORKFLOW）：
  //   地精首领 —— 建 1/2/3 三格 + 手动赋值 `monstersAlive = 3; monsterCount = 4`（只留 0 号位）；
  //   青铜自动机 —— `monsterCount = 1; createMonster(...); ++monsterCount;`（留 0 与 2、宿主在中间）；
  //   收藏家 —— `monsterCount = 2; createMonster(...);`（留 0 与 1、宿主在最后）；
  //   蜥蜴法师 —— **两个 `++` 夹着三次 createMonster**，是唯一一个 **5 格**、也是唯一一个
  //   **两个空位之间还夹着活怪**的编队。
  // ⚠ 三处可观察面：
  //  ① `monstersAlive` 开局是 **3**（不是数组长度 5）——出招规则的 `canSpawn = monstersAlive < 4`
  //     直接读它，写成 5 的话第一次重掷之后就再也召不出匕首。
  //  ② RNG 交错是 hp(匕首) → hp+hp(法师，`hpDiscardRoll` 掷两次) → hp(匕首)，共 **4 次**
  //     monsterHpRng；两个空格一次都不掷。
  //  ③ harness 的策略恒打 0 号位的活怪 = 1 号位那把匕首（0 号是空格），所以战斗前期
  //     打的是匕首而不是法师。
  // ⚠ 两个空格都不参与 `MonsterGroup::init` 的后两个循环（门是 `arr[i].idx != -1`），
  //   见 `initCombat` 里那两处的 `EMPTY_MONSTER_SLOT` 跳过条件。
  reptomancer: (bc) => {
    bc.monsters.push(emptyMonsterSlot()); // 0 号位：预留（第一句 `++monsterCount`）
    createMonster(bc, "dagger"); // 1 号位 ★ 消耗一次 monsterHpRng
    createMonster(bc, "reptomancer"); // 2 号位 ★ 消耗**两次** monsterHpRng（hpDiscardRoll）
    bc.monsters.push(emptyMonsterSlot()); // 3 号位：预留（第二句 `++monsterCount`）
    createMonster(bc, "dagger"); // 4 号位 ★ 消耗一次 monsterHpRng
  },

  // 时间吞噬者（第三十八批）：对齐 MonsterGroup.cpp:441-443，一句
  // `createMonster(bc, MonsterId::TIME_EATER);`——**单怪**，没有预留空位、没有候选池。
  // ⚠ 与觉醒者不同（那个是邪教徒 ×2 + Boss 三只），所以策略从第一张牌起就在打 Boss 本人。
  time_eater: (bc) => {
    createMonster(bc, "time_eater"); // ★ 消耗一次 monsterHpRng
  },
};

// ============================================================================
// preBattleAction（对齐 MonsterSpecific.cpp 的开局 buff）
// ============================================================================

type PreBattleAction = (bc: BattleContext, m: CombatMonster) => void;

/**
 * 虱子蜷缩的层数（对齐 `Monster::preBattleAction` 的 GREEN_LOUSE / RED_LOUSE 那条
 * case，MonsterSpecific.cpp:290-306）。红绿虱共用同一条 case，故这里也共用一个函数。
 *
 * ⚠ 三级分档、**一次** monsterHpRng：参考先按 asc 选好 `curlUpMin` / `curlUpMax`，
 *   末尾才 `bc.monsterHpRng.random(curlUpMin, curlUpMax)`。
 */
function rollCurlUp(bc: BattleContext): number {
  const [min, max] = bc.ascension >= 17 ? [9, 12] : bc.ascension >= 7 ? [4, 8] : [3, 7];
  return bc.rng.monsterHpRng.random(min, max); // ★ 消耗一次 monsterHpRng
}

/**
 * 迪卡与多努共用的开局 buff（对齐 `Monster::preBattleAction` 里那条**两个 case 标签落在
 * 同一个函数体上**的 case，MonsterSpecific.cpp:195-198）。**不消耗 RNG。**
 *
 * ⚠ 分档是 **asc19**（Boss 那一族的高阈值），不是常见的 asc17。
 */
function decaDonuPreBattle(bc: BattleContext, m: CombatMonster): void {
  addPower(m.powers, "artifact", bc.ascension >= 19 ? 3 : 2);
}

const PRE_BATTLE_ACTION: Record<string, PreBattleAction> = {
  // 虱子蜷缩：首次受到未被格挡的攻击时获得格挡，层数开局掷定（走 monsterHpRng）。
  //
  // 对齐 MonsterSpecific.cpp:290-306：分档是**三级** asc17 / asc7 / 其余，
  // 而且是先算好上下界、最后**只掷一次** `monsterHpRng.random(min, max)`。
  // ⚠ 第二十一批修：此前只写了 asc7 那一级，漏掉 asc17 的 9~12——asc0 下走不到，
  //   开了爬升度这条轴才暴露。**别把它写成两次 random 的分支**，次数是钉死的。
  louse: (bc, m) => {
    addPower(m.powers, "curl_up", rollCurlUp(bc));
  },
  green_louse: (bc, m) => {
    addPower(m.powers, "curl_up", rollCurlUp(bc));
  },
  // 抢劫者的偷窃额度（对齐 MonsterSpecific.cpp:233 `buff<MS::THIEVERY>(asc17 ? 20 : 15)`，
  // 与劫匪共用同一条 case）。**不消耗 RNG**，但它是抢劫/猛扑偷多少的唯一数值来源，
  // 而且会出现在 trace 的怪物 powers 快照里（`THIEVERY: 15`）。
  looter: (bc, m) => {
    addPower(m.powers, "thievery", bc.ascension >= 17 ? 20 : 15);
  },
  // 真菌兽的孢子云（对齐 MonsterSpecific.cpp:182-184 `buff<MS::SPORE_CLOUD>(2)`）。
  // **不消耗 RNG、也没有 asc 分档**，层数恒 2 且**从不被读**（参考在那行自注
  // 「the value here isn't used. it is always 2」，`Monster::die` 只判 `hasStatus`）。
  // 它照样必须建模：SPORE_CLOUD 会出现在 trace 的怪物 powers 快照里。
  fungi_beast: (_bc, m) => {
    addPower(m.powers, "spore_cloud", 2);
  },
  // 狂暴地精的狂怒（对齐 MonsterSpecific.cpp:156-158 `buff<MS::ANGRY>(asc17 ? 2 : 1)`）。
  // **不消耗 RNG**。层数就是每次挨打涨的力量，触发在 `monsterAttacked` 里。
  // 与孢子云 / 偷窃同理：它会进 trace 的怪物 powers 快照（`ANGRY: 1`），不建模会当场抛错。
  mad_gremlin: (bc, m) => {
    addPower(m.powers, "angry", bc.ascension >= 17 ? 2 : 1);
  },
  // 拉加维林的金属化（对齐 MonsterSpecific.cpp:286-291）。**不消耗 RNG**。
  // ⚠ 三处照抄：
  //  ① **以睡着为前提**——`if (hasStatus<MS::ASLEEP>())`。事件版编队（LAGAVULIN_EVENT）
  //     不上沉睡位，于是它开局既没有金属化也没有那 8 点格挡，直接吸魂。
  //  ② 金属化与格挡是**两件事**：`buff<METALLICIZE>(8)` 只是「每个回合末加 8 格挡」的能力，
  //     `addBlock(8)` 才是开局那层挡。少了后者，第一个玩家回合它是光着的。
  //  ③ 苏醒时 `decrementStatus<METALLICIZE>(8)` 把能力整条减没（8-8=0 → hasStatus 清零），
  //     但**已经加上去的格挡不退**——见 `wakeUpLagavulin`。
  // 两条都进 trace 的怪物快照（`ASLEEP: 1` / `METALLICIZE: 8` / `block: 8`）。
  lagavulin: (_bc, m) => {
    if (getPower(m.powers, "asleep") > 0) {
      addPower(m.powers, "metallicize", 8);
      m.block += 8;
    }
  },
  // 哨卫的神器（对齐 MonsterSpecific.cpp:311-313 `buff<MS::ARTIFACT>(1)`）。**不消耗 RNG，
  // 也没有 asc 分档**。
  // ⚠ 这是本项目**第一只带神器的怪**——在此之前「怪物身上的神器」那一族分支
  //（`debuffEnemy` 的拦截、黑暗镣铐的 `!hasArtifact` 条件、束缚归还走 buff 而不是 addDebuff）
  //  一条都没有预言机，见 TODOS 第十二批盲区。装完本批它们才第一次被数据看着。
  sentry: (_bc, m) => {
    addPower(m.powers, "artifact", 1);
  },
  // 守卫者的形态切换阈值（对齐 MonsterSpecific.cpp:316-330）。**不消耗 RNG**。
  // ⚠ 参考把同一个数写进**两个**地方，两个都要：
  //   ① `miscInfo = d` —— 「下一次切换的阈值」，双重猛击的收尾 `+= 10` 改的就是它；
  //   ② `buff<MS::MODE_SHIFT>(d)` —— 真正的倒计时层数，每次掉血在 `onHpLost` 里递减。
  //  少了①，第二次切换的阈值会从 10 起算（`0 + 10`）而不是 40；
  //  少了②，`onHpLost` 的入口条件恒假，这只 Boss 永远进不了防御形态。
  // ⚠ 分档是 asc19 / asc9（不是常见的 asc17 / asc7），asc0 取 30。
  // ⚠ MODE_SHIFT 会进 trace 的怪物 powers 快照（`MODE_SHIFT: 30`），漏了当场抛
  //   「未映射的 power」；而 `miscInfo` **不进快照**，它只能靠第二次切换的阈值被间接看到。
  the_guardian: (bc, m) => {
    const d = bc.ascension >= 19 ? 40 : bc.ascension >= 9 ? 35 : 30;
    m.miscInfo = d;
    addPower(m.powers, "mode_shift", d);
  },

  // —— 第二幕开张（第二十三批）——

  // 食蛇草的易塑（对齐 MonsterSpecific.cpp:248-250 `buff<MS::MALLEABLE>(3)`）。
  // **不消耗 RNG、没有 asc 分档**。
  // ⚠ 它是本项目**第一只带易塑的怪**（全项目只有它与蠕动血块）。三处协同，缺一处就静默错：
  //   ① 这里的初值 3；
  //   ② `monsterDamageUnblocked` 的 else-if 链里「入队加 = 层数的格挡，然后层数 +1」；
  //   ③ `applyMonsterEndOfTurnTriggers` 每个回合末**复位回 3**（不是清零、不是保留）。
  // ⚠ MALLEABLE 会进 trace 的怪物 powers 快照（`MALLEABLE: 3`），漏了当场抛「未映射的 power」。
  snake_plant: (_bc, m) => {
    addPower(m.powers, "malleable", 3);
  },

  // 球状守卫者（对齐 MonsterSpecific.cpp:253-259）。**不消耗 RNG、没有 asc 分档**，三句都要：
  //   `buff<MS::ARTIFACT>(3)` / `buff<MS::BARRICADE>()` / `addBlock(40)`
  // ⚠ **壁垒是怪物侧第一次出现**：它让 `applyPreTurnLogic` 那句「逐怪清空格挡」跳过这只怪
  //   （`Monster::applyStartOfTurnPowers` 的 `if (!hasStatus<MS::BARRICADE>()) block = 0;`，
  //   Monster.cpp:19-22）。于是那 40 点开局格挡与后来攒的每一层都**永久累积**——这只怪
  //   只有 20 血，格挡才是它真正的血条，漏掉壁垒会让它几回合就被打死。
  // ⚠ 壁垒是**纯 bool**（`isBooleanPower` 为真），harness 按 1 输出（`BARRICADE: 1`），
  //   与玩家侧壁垒能力牌共用同一个 PowerId 映射。
  // ⚠ 神器 3 层是本项目**第二只**带神器的怪（第一只是哨卫，1 层）。它拦的是
  //   `debuffEnemy` 那条路（黑暗镣铐 / 缴械 / 易伤…），每拦一次减一层。
  spheric_guardian: (_bc, m) => {
    addPower(m.powers, "artifact", 3);
    addPower(m.powers, "barricade", 1);
    m.block += 40;
  },

  // —— 第二十四批 ——

  // 拜鸟的飞行（对齐 MonsterSpecific.cpp:228-231 `buff<MS::FLIGHT>(asc17 ? 4 : 3)`）。
  // **不消耗 RNG**。它是本项目**第一只带飞行的怪**（全项目也只有它），四处协同：
  //   ① 这里的初值 3；
  //   ② `calculateCardDamage` 末段把牌造成的伤害**减半**；
  //   ③ `monsterDamageUnblocked` 的 else-if 链里受击 -1，减到 0 那一击改出 `stunned`；
  //   ④ `applyPreTurnLogic` 每个怪物回合开始**复位回 3**（于是它又飞起来）。
  // ⚠ FLIGHT 会进 trace 的怪物 powers 快照（`FLIGHT: 3`），漏了当场抛「未映射的 power」。
  // ✅ asc17 那一档（4 层）第三十批有背书了（这一处改成恒 3 红 240 例）。
  byrd: (bc, m) => {
    addPower(m.powers, "flight", bc.ascension >= 17 ? 4 : 3);
  },
  // 劫匪的偷窃额度：与抢劫者**共用参考里的同一条 case**
  // （MonsterSpecific.cpp:233-235 `case LOOTER: case MUGGER: buff<MS::THIEVERY>(asc17 ? 20 : 15)`），
  // 所以数值与 `PRE_BATTLE_ACTION.looter` 逐字相同。**不消耗 RNG**。
  // ⚠ `TWO_THIEVES` 里两只贼各带 15，合起来能把玩家偷穷——这正是第十五批那条
  //   「`min(玩家金币, 额度)` 钳制没有背书」的关门条件。
  mugger: (bc, m) => {
    addPower(m.powers, "thievery", bc.ascension >= 17 ? 20 : 15);
  },

  // —— 第二十五批 ——

  // 带壳寄生虫的镀甲（对齐 MonsterSpecific.cpp:242-246）。**不消耗 RNG、没有 asc 分档**，
  // 两句都要：`buff<MS::PLATED_ARMOR>(14)` 与 `addBlock(14)`。
  // ⚠ 与拉加维林的「金属化 8 + 格挡 8」同族：Power 只管「以后每个回合末加多少」，
  //   开局那 14 点挡是**另一句**。少了后者，第一个玩家回合它是光着的。
  // ⚠ 两个 14 是**两处独立的字面量**，改一个不会带动另一个。
  // ⚠ 镀甲三处协同（缺一处就静默错）：
  //   ① 这里的初值 14；
  //   ② `monsterDamageUnblocked` 的 else-if 链里受击 -1（排**第二格**，蜷缩之前），
  //      归零时因为这只怪是带壳寄生虫而把意图改成 `stunned`；
  //   ③ `applyMonsterEndOfTurnTriggers` 每个回合末加 = 层数的格挡。
  // ⚠ PLATED_ARMOR 会进 trace 的怪物 powers 快照（`PLATED_ARMOR: 14`），漏了当场抛
  //   「未映射的 power」。
  // ⚠ 史尼克**没有** preBattleAction（`Monster::preBattleAction` 的 switch 里没有它的 case）。
  shelled_parasite: (_bc, m) => {
    addPower(m.powers, "plated_armor", 14);
    m.block += 14;
  },

  // —— 第二十七批 ——

  // 地精首领的「随从首领」标记（对齐 MonsterSpecific.cpp:168-170
  // `case GREMLIN_LEADER: buff<MS::MINION_LEADER>(); break;`，参考在那行注了
  // `// game adds MinionPower to all gremlins`）。**不消耗 RNG、没有 asc 分档**。
  // ⚠ 它不是装饰：`monsterDie` 读它——**首领一死当场判胜**，小鬼还站着也算赢。
  //   所以漏掉它不是「少个字段」，而是这场仗会一直打到把小鬼也清完。
  // ⚠ 是纯 bool（`isBooleanPower` 为真），harness 按 1 输出（`MINION_LEADER: 1`）。
  // ⚠ 两只小鬼的 `MINION` 反而在 **createMonsters 阶段**就上了（见 `ENCOUNTER_BUILDERS`），
  //   不在这里——参考把这两件事放在两个不同的时点。
  // ⚠ 工头**没有** preBattleAction（`Monster::preBattleAction` 的 switch 里没有它的 case）。
  gremlin_leader: (_bc, m) => {
    addPower(m.powers, "minion_leader", 1);
  },

  // —— 第二十八批 ——

  // 突刺之书（对齐 MonsterSpecific.cpp:177-180，参考在那行注了
  // `// game adds PainfulStabsPower`）。**不消耗 RNG、没有 asc 分档**，两句都要：
  //     buff<MS::PAINFUL_STABS>();
  //     ++miscInfo; // stab count
  //
  // ⚠⚠ **第二句是乱刺的段数起点，而且它跑在开局那次 `rollMove` 之后**
  //   （`MonsterGroup::init` 是 createMonsters → 逐怪 rollMove → 逐怪 preBattleAction）。
  //   于是开局那次出招规则看到的是 `miscInfo == 0`：
  //     * roll >= 15 且没连续两次乱刺 → 规则自己 `++` 到 1，preBattleAction 再 `++` → **段数 2**
  //     * roll < 15（首回合 `lastMove` 是空、不是重刺）→ 出重刺，段数停在 **1**
  //   两条都对得上 trace。⚠ 把这两句的**顺序**或**时点**抄错，第一发乱刺的段数就差一段。
  // ⚠ `PAINFUL_STABS` 是纯 bool（`isBooleanPower` 为真），harness 按 1 输出，会进怪物快照。
  //   它的读点在**玩家侧**（`dealDamageToPlayer` 里，见那个函数的注释）。
  book_of_stabbing: (_bc, m) => {
    addPower(m.powers, "painful_stabs", 1);
    m.miscInfo += 1; // ★ 乱刺段数的起点（参考的 `++miscInfo; // stab count`）
  },

  // 青铜自动机（对齐 MonsterSpecific.cpp:217-221）。**不消耗 RNG、没有 asc 分档**，两句都要：
  //     buff<MS::MINION_LEADER>();
  //     buff<MS::ARTIFACT>(3);
  //
  // ⚠ `MINION_LEADER` 是本项目**第二个**宿主（第一个是地精首领）：它一死当场判胜，
  //   两颗球还站着也算赢。⚠ `ARTIFACT 3` 是**第二个**宿主（第一个是第二十三批的球状守卫者）
  //   ——怪物神器抵挡玩家施加的减益。
  // ⚠ 青铜球**没有** preBattleAction（`Monster::preBattleAction` 的 switch 里没有它的 case）
  //   ——它的 `MINION` 是召唤函数里加的，见 `spawnBronzeOrbs`。
  bronze_automaton: (_bc, m) => {
    addPower(m.powers, "minion_leader", 1);
    addPower(m.powers, "artifact", 3);
  },

  // 收藏家（第二十九批，对齐 MonsterSpecific.cpp:272-274）。**只有一句**：
  //     buff<MS::MINION_LEADER>();
  //
  // ⚠ `MINION_LEADER` 的**第三个宿主**（前两个是地精首领与青铜自动机）：它一死当场判胜
  //   （`Monster::die` 那条 `if (monstersAlive == 0 || hasStatus<MINION_LEADER>())`，
  //   Monster.cpp:293-297），火炬头还站着也算赢。
  // ⚠ 与青铜自动机的差别：收藏家**没有** `ARTIFACT`（别照搬邻居）。
  // ⚠ 火炬头**没有** preBattleAction（`Monster::preBattleAction` 的 switch 里没有它的
  //   case）——它的 `MINION` 是召唤函数里加的，见 `summonTorchHeads`。
  // ⚠ 冠军也**没有** preBattleAction（同一个 switch 里没有 `THE_CHAMP`）：它的二阶段
  //   不靠开局 Power，而是 `getMoveForRoll` 里的 `miscInfo` bit 2，见 `MOVE_RULES.champ`。
  the_collector: (_bc, m) => {
    addPower(m.powers, "minion_leader", 1);
  },

  // —— 第三十二批 ——

  // 尖刺客的荆棘（对齐 MonsterSpecific.cpp:204-208）：
  //     case MonsterId::SPIKER: {
  //         const int thorns[] {3,4,7};
  //         buff<MS::THORNS>(thorns[hallwayDiffIdx]);
  //         break;
  //     }
  // **不消耗 RNG。** 分档是**走廊小怪那一族** `getTriIdx(asc, 2, 17)`，三档 3 / 4 / 7。
  // ⚠ 第三档是 **7**（不是等差的 5），别按前两档补。
  // ⚠ 中间那一档（asc2~16 的 4）在 `{0, 19}` 这对档位下**永远走不到**——本批只做 asc0，
  //   三档一条都没有背书，`ascCalibrated` 不置（`constructMonster` 在 asc>0 时照旧抛错）。
  // ⚠⚠ **它与守卫者的「尖锐外壳」（SHARP_HIDE）不是一回事**，两处都别混：
  //   * 荆棘挂在 `attackedUnblockedHelper` 的 else-if 链里（**被攻击**才触发，
  //     而且要**破了格挡**），见 `monsterDamageUnblocked`；
  //   * 尖锐外壳挂在 `BattleContext::onUseAttackCard` 的最末（**打出攻击牌**就触发，
  //     哪怕这一击被格挡吃光、甚至打的是别的怪），见 `onUseAttackCard`。
  //   两者都走 `addToBot/addToTop(Actions::DamagePlayer(层数))`，形状像、时点完全不同。
  // ⚠ THORNS 会进 trace 的怪物 powers 快照（`THORNS: 3`），漏了当场抛「未映射的 power」。
  // ⚠ 层数还会被增生尖刺**每次 +2** 涨上去（`apply_power` + `on: "self"` 同步），
  //   而且 `MOVE_RULES.spiker` 攒够 6 次就封顶——asc0 下上限是 `3 + 2*6 = 15`。
  // ⚠ 爆破怪与斥力怪**都没有** preBattleAction：`Monster::preBattleAction` 的 switch 里
  //   爆破怪那一格是空的（`case MonsterId::EXPLODER: break;`，参考在那行注了
  //   `// game adds explosive power`——真实游戏的「爆炸」倒计时是个 Power，参考改用
  //   意图链表达，见 `MOVE_TURN_END`），斥力怪压根没有 case。
  spiker: (bc, m) => {
    const thorns = bc.ascension >= 17 ? 7 : bc.ascension >= 2 ? 4 : 3;
    addPower(m.powers, "thorns", thorns);
  },

  // —— 第三十三批 ——

  // 暗球游荡者的通用力量增长（对齐 MonsterSpecific.cpp:200-202）：
  //     case MonsterId::ORB_WALKER:
  //         buff<MS::GENERIC_STRENGTH_UP>(asc17 ? 5 : 3);
  //         break;
  // **不消耗 RNG。** 分档是**两档**（asc17），不是走廊小怪那种三档 `getTriIdx`——
  // 别照搬尖刺客那条荆棘的写法。
  // ⚠ 效果在 `applyEndOfRoundPowers`：**每个回合末** `buff<STRENGTH>(层数)`，
  //   而它自己一层都不掉（Monster.cpp:103-105）。所以整场力量是 3、6、9…线性涨。
  // ⚠ 它与仪式（RITUAL）**不是一回事**，两处差别都要照抄：仪式带 skipFirst（施加当回合
  //   不结算）、排在 `applyEndOfRoundPowers` 的**第一句**；这一条**没有** skipFirst、
  //   排在**最后一句**。参考自己在枚举那行注了 `// todo just merge this with orb walker
  //   strength up`，说明它清楚两者像但**没有**合并。
  // ⚠ `GENERIC_STRENGTH_UP` 会进 trace 的怪物 powers 快照（`GENERIC_STRENGTH_UP: 3`），
  //   漏了当场抛「未映射的 power」。
  // ⚠ 尖塔增生与大嘴**都没有** preBattleAction（`Monster::preBattleAction` 的 switch 里
  //   两者都没有 case），开局身上一个 Power 都没有。
  orb_walker: (bc, m) => {
    addPower(m.powers, "generic_strength_up", bc.ascension >= 17 ? 5 : 3);
  },

  // —— 第三十四批 ——

  // 暗影客的重生（对齐 MonsterSpecific.cpp:152-154）：
  //     case MonsterId::DARKLING:       // game adds regrow power
  //         buff<MS::REGROW>();
  //         break;
  // **纯 bool**（`isBooleanPower(MS::REGROW)` 为真），不消耗 RNG，快照里是 `REGROW: 1`。
  // ⚠ 它是「怪物死亡时不真死」的唯一开关，读点在 `Monster::die` 的 else-if 链第二格，
  //   见 `monsterDie`。⚠ 那条链会 `resetAllStatusEffects()` 把它自己也清掉，
  //   所以复活那条 case 必须**再上一次**（见 `reincarnate`）。
  darkling: (_bc, m) => {
    addPower(m.powers, "regrow", 1);
  },

  // 复形怪的变换 + 消逝（对齐 MonsterSpecific.cpp:171-175）：
  //     case MonsterId::TRANSIENT:      // game adds ShiftingPower
  //         buff<MS::SHIFTING>();
  //         buff<MS::FADING>(asc17 ? 6 : 5);
  //         break;
  // ⚠ 三处照抄：
  //  ① **一次上两个**（参考只给第一个写了注释，别以为只有一个）；
  //  ② 变换是**纯 bool**（快照 `SHIFTING: 1`），消逝是**层数**（快照 `FADING: 5`）；
  //  ③ 分档是**两档**（asc17），不是走廊小怪那种三档 `getTriIdx`。
  // ⚠ 消逝的层数就是「还能出手几次」——它没有任何回合末的自动递减，唯一的递减点
  //   在重殴那条 case 的最后一句，见 `MOVE_TURN_END`。
  transient: (bc, m) => {
    addPower(m.powers, "shifting", 1);
    addPower(m.powers, "fading", bc.ascension >= 17 ? 6 : 5);
  },

  // —— 第三十五批 ——

  // 蠕动血块的反应 + 易塑（对齐 MonsterSpecific.cpp:210-215）：
  //     case MonsterId::WRITHING_MASS: {
  //         setHasStatus<MS::REACTIVE>(true);
  //         setStatus<MS::REACTIVE>(0);
  //         buff<MS::MALLEABLE>(3);
  //         break;
  //     }
  // **不消耗 RNG、没有 asc 分档。**
  // ⚠⚠ **前两句不是 `buff<REACTIVE>(0)`**：`buff` 会 `uniquePower1 += 0` 再置 bit，
  //   数值上同解，但参考写的是「置位 + 覆盖成 0」这两句，而**第三十四批的 `cleared` 那条
  //   教训正是「bit 与数值是两回事」**——照抄形状。我们这边两种写法都落成
  //   「条目在、`amount` 是 0」，所以用 `addPower(…, 0)` 表达（条目一旦加上就永不摘除，
  //   同飞行那一族）。
  // ⚠ 层数 0 的条目**不进快照**（harness 的 `getStatusInternal` 返回 0 就被 `v == 0` 折叠，
  //   我们的 `powersOf` 同样滤掉），所以开局那一帧只看得见 `MALLEABLE: 3`。
  //   反应只在「挨了打、`ReactiveRollMove` 还没出队」的那几帧现身。
  // ⚠⚠ 它是**全参考项目唯一同时带易塑与反应的怪**，而那两者在
  //   `attackedUnblockedHelper` 的 else-if 链上**共用同一格**（见 `monsterDamageUnblocked`）。
  //   第二十三批装食蛇草时只写了易塑那一半，本批把那一格补完整。
  writhing_mass: (_bc, m) => {
    addPower(m.powers, "reactive", 0);
    addPower(m.powers, "malleable", 3);
  },

  // 巨头的缓慢（对齐 MonsterSpecific.cpp:163-166）：
  //     case MonsterId::GIANT_HEAD:     // game adds slow power
  //         setHasStatus<MS::SLOW>(true);
  //         setStatus<MS::SLOW>(0);
  //         break;
  // **不消耗 RNG、没有 asc 分档。**
  // ⚠ 与反应同形：**置位 + 覆盖成 0**，不是 `buff(n)`。所以开局快照里巨头身上
  //   一个 power 都没有——缓慢要等玩家打出第一张牌（`onAfterUseCard` 里 +1）才现身。
  // ⚠ 三个读点见 `PowerId` 的注释；回合末清零在 `applyEndOfRoundPowers`。
  giant_head: (_bc, m) => {
    addPower(m.powers, "slow", 0);
  },

  // —— 第三十六批 ——

  // 蜥蜴法师的随从首领（对齐 MonsterSpecific.cpp:238-240）：
  //     case MonsterId::REPTOMANCER:
  //         buff<MS::MINION_LEADER>();
  //         break;
  // **纯 bool**，不消耗 RNG，快照里是 `MINION_LEADER: 1`。
  // ⚠ 它给 `Monster::die` 加了第二条判胜路径（`monstersAlive == 0 || hasStatus<MINION_LEADER>()`，
  //   Monster.cpp:293-297）：法师一死当场判胜，匕首还站着也算赢。地精首领是同族的第一个宿主。
  // ⚠ 复仇魔**没有** `preBattleAction`（那个 switch 里没有 `NEMESIS` 这一格），
  //   开局身上一个 Power 都没有；虚无缥缈全靠它自己三条 case 的尾部补。
  reptomancer: (_bc, m) => {
    addPower(m.powers, "minion_leader", 1);
  },

  // 匕首的随从标记（对齐 MonsterSpecific.cpp:148-150）：
  //     case MonsterId::DAGGER:
  //         buff<MS::MINION>();
  //         break;
  // **纯 bool**，不消耗 RNG，快照里是 `MINION: 1`。开局那两把匕首走这一条。
  // ⚠ 召唤出来的那些**不走这里**（召唤一律不重跑 `preBattleAction`），而是由
  //   `reptomancerSummon` 自己手写的那句 `dagger.buff<MS::MINION>()` 上——两处的净效果相同。
  // ⚠⚠ **所以「不重跑 preBattleAction」这条在匕首身上没有判别力，但理由要说准**：
  //   在**参考里**重跑一遍是严格的空操作（`Monster::buff` 对纯 bool 只 `setHasStatus(true)`，
  //   不带层数）；在**我们这边**它不是——`addPower` 一律累加，重跑会把 `MINION` 变成 2 层，
  //   于是快照当场不符（第三十六批实测那个探针红 120 例）。
  //   **那 120 例量的是我们自己的建模差异，不是参考的语义**，所以它记成「探针无效」。
  //   ⚠ 这处差异当前不可达（没有任何代码路径对同一只怪 `buff` 两次纯 bool Power），
  //   但下一个「召唤 + 同种怪预置」的宿主要先回来看这一条。
  //   与火炬头那条（它压根没有 `preBattleAction` 的 case）同为「探针无效」、理由不同；
  //   真正有背书的只有地精首领那条（召唤出来的狂暴小鬼没有狂怒，红 300 例）。
  dagger: (_bc, m) => {
    addPower(m.powers, "minion", 1);
  },

  // —— 第三十七批 ——

  // 觉醒者（对齐 MonsterSpecific.cpp:186-193）：
  //     case MonsterId::AWAKENED_ONE:
  //         // buff minion leader only in stage 2
  //         if (asc4) { buff<MS::STRENGTH>(2); }
  //         buff<MS::CURIOSITY>(asc19 ? 2 : 1);
  //         buff<MS::REGEN>(asc19 ? 15 : 10);
  //         break;
  // **不消耗 RNG。**
  // ⚠ 四处照抄：
  //  ① 力量那一条是**多出来的一整条效果**（asc>=4 才有，Boss 那一族的低阈值），
  //     不是「换个数」——asc0 下觉醒者开局**没有** STRENGTH 条目。
  //  ② 参考那句注释 `// buff minion leader only in stage 2` 是在说：`MINION_LEADER`
  //     **不在这里上**，而在复活那条 case（`MonsterSpecific.cpp:1718`）。开局快照里
  //     只有 `CURIOSITY` 与 `REGEN` 两条。
  //  ③ **好奇心的效果在参考里被整段注释掉了**（`BattleContext.cpp:1909-1912`），所以它
  //     只是个进快照的标记——照抄「什么都不做」，理由见 `PowerId` 的 `curiosity`。
  //  ④ 再生**一层都不掉**（`applyEndOfTurnTriggers` 里只有 `heal`，没有递减），
  //     所以它在快照里整场恒是 10；玩家侧那条会 -1 的再生是另一回事。
  awakened_one: (bc, m) => {
    if (bc.ascension >= 4) {
      addPower(m.powers, "strength", 2);
    }
    addPower(m.powers, "curiosity", bc.ascension >= 19 ? 2 : 1);
    addPower(m.powers, "regen", bc.ascension >= 19 ? 15 : 10);
  },

  // 时间吞噬者（MonsterSpecific.cpp:223-226，第三十八批）：整条 case 只有一句
  // `buff<MS::TIME_WARP>(0);`。
  // ⚠⚠ **这是「开局 Power 的第三种写法」**（`buff` 到「位置上、层数 0」）：
  //   `Monster::buff` 对 TIME_WARP 走的是 `setHasStatus(true); uniquePower0 += 0;`
  //   （Monster.h:545-558），与蠕动血块的反应 / 巨头的缓慢那两条
  //   `setHasStatus(true); setStatus(0);` 数值终态相同。三条形状差别是承重的：
  //   ① **它平时不进快照**（harness 的 `getStatusInternal` 返回 0 就被 `v == 0` 折叠），
  //      所以开局那一帧看不见 TIME_WARP——第一次见到它是玩家打出第一张牌之后的 `TIME_WARP: 1`；
  //   ② **`onAfterUseCard` 里的读点必须用 `hasPower`（条目在不在）而不是「层数 > 0」**，
  //      否则计数器一次都涨不起来（0 > 0 恒假）。
  // ⚠ 参考没有给它任何别的开局 buff：456 血的 Boss 开局身上一个 Power 都看不见。
  time_eater: (_bc, m) => {
    addPower(m.powers, "time_warp", 0);
  },

  // 迪卡与多努（MonsterSpecific.cpp:195-198，第三十九批）。⚠ 参考把两只**并在同一条
  // case 上**（`case DECA: case DONU:` 共用一个函数体），整条只有一句：
  //     buff<MS::ARTIFACT>(asc19 ? 3 : 2);
  // ⚠ 三处照抄：
  //  ① **不消耗任何 RNG**；
  //  ② 分档是 **asc19**（Boss 那一族 `getTriIdx(asc, 4, 19)` 的**高**阈值），
  //     不是常见的 asc17——照搬邻居必错。asc0 是 2 层。
  //  ③ 两只**层数相同**，所以这里写成同一个函数、两个键各指一次（与参考的
  //     「两个 case 标签落在同一个函数体上」同构）。
  // ⚠ 神器是第**四 / 五**个宿主（前三个：哨卫 1 层、球状守卫者 3 层、青铜自动机 3 层）。
  //   它拦的是 `debuffEnemy` 那条路（易伤 / 虚弱 / 缴械…），每拦一次减一层；
  //   起始牌组里那张精准打击（BASH）上的易伤正是它最常见的消耗者
  //   ——实测 120 条 trace 里 106 条看得见迪卡的神器被扣掉。
  // ⚠ `ARTIFACT` 会进 trace 的怪物 powers 快照（`ARTIFACT: 2`），漏了当场抛「未映射的 power」。
  deca: decaDonuPreBattle,
  donu: decaDonuPreBattle,

  // —— 第四十七批乙：第四幕的三只 ——
  //
  // 腐化之心（MonsterSpecific.cpp:142-146）：
  //     buff<MS::BEAT_OF_DEATH>(asc19 ? 2 : 1);
  //     buff<MS::INVINCIBLE>(asc19 ? 200 : 300);
  // ⚠ 三处照抄：
  //  ① 顺序（死亡节拍在前、无敌在后）；
  //  ②⚠⚠ **无敌的 asc19 档是变小**（300 → 200，怪更难打是因为「每回合能被打掉的血更少」），
  //     与「爬升度让数值变大」的直觉相反——照抄，别顺手写成 `asc19 ? 400 : 300`；
  //  ③ **两条都进快照**（层数非 0），所以开局那一帧就是 `{"BEAT_OF_DEATH":1,"INVINCIBLE":300}`。
  //     与缓慢 / 反应 / 时间扭曲那种「层数 0 看不见」的第三种写法**不同族**。
  corrupt_heart: (bc, m) => {
    addPower(m.powers, "beat_of_death", bc.ascension >= 19 ? 2 : 1);
    addPower(m.powers, "invincible", bc.ascension >= 19 ? 200 : 300);
  },

  // 尖塔护盾（MonsterSpecific.cpp:261-265）：
  //     bc.player.buff<PS::SURROUNDED>();
  //     buff<MS::ARTIFACT>(asc18 ? 2 : 1);
  // ⚠⚠ **第一句是全参考唯一一处「怪物的 preBattleAction 给玩家上 Power」**，所以它
  //   只能写在这里，不能进数据表的 `effects`（那张表的 `on: "target"` 是招式效果的目标）。
  // ⚠ 被围攻是**纯 bool**（`Player::debuff` 那条「只置位、不写 statusMap」的名单，
  //   Player.h:335-343），harness 恒输出 `SURROUNDED: 1` ⇒ 我们这边层数写 1。
  // ⚠ 分档是 **asc18**（精英那一族 `getTriIdx(asc, 3, 18)` 的高阈值），不是 asc17 也不是 19。
  spire_shield: (bc, m) => {
    addPower(bc.player.powers, "surrounded", 1);
    addPower(m.powers, "artifact", bc.ascension >= 18 ? 2 : 1);
  },

  // 尖塔长矛（MonsterSpecific.cpp:267-270）：只有 `buff<MS::ARTIFACT>(asc18 ? 2 : 1);`
  // ⚠ **没有**护盾那句被围攻——两只并排放着、只差第一句，照抄邻居必错。
  spire_spear: (bc, m) => {
    addPower(m.powers, "artifact", bc.ascension >= 18 ? 2 : 1);
  },

  // ⚠ 熊 / 尖头怪 / 罗密欧在 `Monster::preBattleAction` 的 switch 里**压根没有 case**，
  //   所以这里三只一条都不写（同斥力怪那条注释：别按「事件编队」给它们加东西）。
};

type EncounterSetup = (bc: BattleContext) => void;

const ENCOUNTER_SETUP: Record<string, EncounterSetup> = {
  // 颚虫军团：三只开局各 +3 力量 +5 格挡（ascension 0），并预置意图哨兵使首次
  // rollMove 直接走 roll 分支。对齐 MonsterGroup.cpp JAW_WORM_HORDE。
  jaw_worm_horde: (bc) => {
    const strBuff = bc.ascension >= 17 ? 5 : bc.ascension >= 2 ? 4 : 3;
    const blockBuff = bc.ascension >= 17 ? 9 : bc.ascension >= 2 ? 6 : 5;
    for (const m of bc.monsters) {
      addPower(m.powers, "strength", strBuff);
      m.block += blockBuff;
      m.moveHistory = [MOVE_SENTINEL];
    }
  },

  // 拉加维林：开局置**沉睡位**（对齐 MonsterGroup.cpp:293-296 的
  // `createMonster(...); bc.monsters.arr[0].setHasStatus<MS::ASLEEP>(true);`）。
  //
  // ⚠ 它属于 **createMonsters 阶段**，所以排在 rollMove 与 preBattleAction **之前**——
  //   而那两步都要读它（出招规则判首招、preBattleAction 判上不上金属化）。顺序错了
  //   拉加维林开局就会站起来打人。
  // ⚠ 它写在**编队**上而不是怪物上：同一只怪在 `LAGAVULIN_EVENT`（睡魔事件打断版）里
  //   **不睡**（MonsterGroup.cpp:298-300 没有这一句）。那个编队不在 harness 的 20 个里，
  //   但形状照抄，将来装它时不必再改。
  lagavulin: (bc) => {
    const m = bc.monsters[0];
    if (m !== undefined) {
      addPower(m.powers, "asleep", 1);
    }
  },
};

function rollMove(bc: BattleContext, m: CombatMonster): void {
  const rule = MOVE_RULES[m.defId];
  if (rule === undefined) {
    throw new Error(`sts-combat 骨架层暂未登记怪物 rollMove: ${m.defId}`);
  }
  const roll = bc.rng.aiRng.random(99); // ★ 恒消耗一次 aiRng
  const move = rule(bc, m, roll);
  setMove(m, move);
}

/**
 * 写入意图并前移历史（对齐 Monster::setMove：moveHistory[1]=moveHistory[0]; moveHistory[0]=move）。
 * moveHistory[0] 即「最近一次决定的意图」，getMoveForRoll 的 lastMove/lastTwoMoves 读它。
 * 历史保留最近两项即可满足 lastTwoMoves 判定。
 */
function setMove(m: CombatMonster, move: string): void {
  m.moveHistory.unshift(move);
  if (m.moveHistory.length > 2) {
    m.moveHistory.length = 2;
  }
  m.currentMove = move;
}

/**
 * **顶替**当前意图（对齐参考里裸写的 `moveHistory[0] = X`，Monster.cpp:502 / :510 / :516）。
 *
 * ⚠ 与 `setMove` 的差别是承重的：这里**不前移历史**，`moveHistory[1]` 原样留着，
 * 被顶掉的那个意图直接消失。参考在 `onHpLost` 里用的就是这个形态（分裂 / 史莱姆王分裂），
 * 而守卫者的模式切换在同一个 switch 里用的却是 `setMove`——两种写法并存，不能统一。
 */
function overwriteMove(m: CombatMonster, move: string): void {
  if (m.moveHistory.length === 0) {
    m.moveHistory.push(move);
  } else {
    m.moveHistory[0] = move;
  }
  m.currentMove = move;
}

/**
 * 「这个意图算不算攻击」的**招式白名单**（逐条转写 `MonsterMoves.h:414-535` 的
 * `isMoveAttack` 大 switch）。键是 `${怪 id}/${招式 id}`，与 `MOVE_TURN_END` 同构。
 *
 * ⚠⚠ **第二十三批把实现从「读数据表的 `intent`」换成了这张表**，兑现了 WORKFLOW 从第十三批
 * 起挂着的那条警告。触发它的正是本批的 `SPHERIC_GUARDIAN_HARDEN`（`MonsterMoves.h:500`）：
 * 那一招**加 15 点格挡再打 10 点**，名字叫「硬化」、真实游戏里显示的是「攻击 + 防御」双意图
 * ——而我们的 `EnemyIntentKind` 只有五个互斥的值，无论选 `attack` 还是 `defend` 都在表达
 * 一件与「参考怎么判」无关的事。前 25 只怪两边碰巧一致，到这一只为止，
 * **「渲染用的意图分类」与「isAttacking 谓词」必须拆开**：前者留在数据表给 UI 用，
 * 后者以参考的白名单为唯一真相。
 *
 * 逐条核对的结果（本批之前的 25 只怪原样保留，作为「两种实现同解」的记录）：
 *   * 邪教徒 / 颚虫 / 红虱 / 绿虱（前十二批）：颚虫的乱抓虽然同时加格挡，白名单里也算攻击；
 *     `CULTIST_INCANTATION` / `RED_LOUSE_GROW` / `GREEN_LOUSE_SPIT_WEB` 不在。
 *   * 史莱姆四只（第十三批）：白名单里只有 `ACID_SLIME_M_CORROSIVE_SPIT` / `ACID_SLIME_M_TACKLE`
 *     / `ACID_SLIME_S_TACKLE`（`:419-421`）与 `SPIKE_SLIME_M_FLAME_TACKLE` /
 *     `SPIKE_SLIME_S_TACKLE`（`:504-505`），三条舔舐**都不在**。
 *   * 大史莱姆两只（第十四批）：`ACID_SLIME_L_CORROSIVE_SPIT` / `_TACKLE`（`:417-418`）与
 *     `SPIKE_SLIME_L_FLAME_TACKLE`（`:503`）在，两条舔舐与**两条分裂**不在。
 *   * 奴隶主两只 + 抢劫者（第十五批）：`BLUE_SLAVER_STAB` / `_RAKE`（`:428-429`）、
 *     `RED_SLAVER_STAB` / `_SCRAPE`（`:484-485`）、`LOOTER_MUG` / `_LUNGE`（`:470-471`）在；
 *     `RED_SLAVER_ENTANGLE` / `LOOTER_SMOKE_BOMB` / `LOOTER_ESCAPE` 不在。
 *   * 真菌兽（第十六批）：只有 `FUNGI_BEAST_BITE`（`:455`），`_GROW` 不在。
 *   * 地精帮五只（第十七批）：`FAT_GREMLIN_SMASH`（`:454`）、`GREMLIN_WIZARD_ULTIMATE_BLAST`
 *     （`:462`）、`MAD_GREMLIN_SCRATCH`（`:472`）、`SHIELD_GREMLIN_SHIELD_BASH`（`:493`）、
 *     `SNEAKY_GREMLIN_PUNCTURE`（`:496`）在；`SHIELD_GREMLIN_PROTECT` / `GREMLIN_WIZARD_CHARGING`
 *     不在。
 *   * 第一幕三个精英（第十八批）：`GREMLIN_NOB_RUSH`(`:460`) / `_SKULL_BASH`(`:461`)、
 *     `LAGAVULIN_ATTACK`(`:469`)、`SENTRY_BEAM`(`:489`) 在；`GREMLIN_NOB_BELLOW`、
 *     `LAGAVULIN_SLEEP` / `_SIPHON_SOUL`、`SENTRY_BOLT` 不在。
 *     ⚠ `SENTRY_BOLT` 一点伤害都不带（只塞两张恍惚），照样不在白名单里。
 *   * 第一幕两个 Boss（第十九批）：`SLIME_BOSS_SLAM`(`:494`)、`THE_GUARDIAN_FIERCE_BASH` /
 *     `_WHIRLWIND` / `_ROLL_ATTACK` / `_TWIN_SLAM`(`:518-521`) 在；`SLIME_BOSS_GOOP_SPRAY` /
 *     `_PREPARING` / `_SPLIT`、`THE_GUARDIAN_CHARGING_UP` / `_DEFENSIVE_MODE` / `_VENT_STEAM`
 *     不在（`_VENT_STEAM` 不带伤害却是整只怪最危险的一招）。
 *   * 六火幽魂（第二十批）：`HEXAGHOST_DIVIDER` / `_INFERNO` / `_SEAR` / `_TACKLE`
 *     （`:463-466`）在；`_ACTIVATE` 与 `_INFLAME` 不在——`_INFLAME` 是「加格挡 + 加力量」，
 *     形状最像 `SPHERIC_GUARDIAN_HARDEN`，方向却相反。
 *   * **第二十三批的三只**（逐条核对，这就是报告里那张表）：
 *     | 参考招式                          | 在白名单？ | 我们的键                            | 数据表 intent |
 *     | --------------------------------- | ---------- | ----------------------------------- | ------------- |
 *     | `SPHERIC_GUARDIAN_SLAM` (`:499`)   | **是**     | `spheric_guardian/sg_slam`          | attack        |
 *     | `SPHERIC_GUARDIAN_HARDEN` (`:500`) | **是**     | `spheric_guardian/sg_harden`        | attack ⚠ 反例 |
 *     | `SPHERIC_GUARDIAN_ATTACK_DEBUFF`   | **是**     | `spheric_guardian/sg_attack_debuff` | attack        |
 *     | `SPHERIC_GUARDIAN_ACTIVATE`        | 否         | —                                   | defend        |
 *     | `CHOSEN_POKE` (`:441`)             | **是**     | `chosen/poke`                       | attack        |
 *     | `CHOSEN_ZAP` (`:442`)              | **是**     | `chosen/zap`                        | attack        |
 *     | `CHOSEN_DEBILITATE` (`:443`)       | **是**     | `chosen/debilitate`                 | attack        |
 *     | `CHOSEN_DRAIN`                     | 否         | —                                   | buff          |
 *     | `CHOSEN_HEX`                       | 否         | —                                   | debuff        |
 *     | `SNAKE_PLANT_CHOMP` (`:495`)       | **是**     | `snake_plant/sp_chomp`              | attack        |
 *     | `SNAKE_PLANT_ENFEEBLING_SPORES`    | 否         | —                                   | debuff        |
 *   * **第二十四批的两只**（逐条核对 `MonsterMoves.h:436-438` / `:473-474`）：
 *     | 参考招式                       | 在白名单？ | 我们的键             | 数据表 intent |
 *     | ------------------------------ | ---------- | -------------------- | ------------- |
 *     | `BYRD_PECK` (`:436`)           | **是**     | `byrd/peck`          | attack        |
 *     | `BYRD_SWOOP` (`:437`)          | **是**     | `byrd/swoop`         | attack        |
 *     | `BYRD_HEADBUTT` (`:438`)       | **是**     | `byrd/headbutt`      | attack        |
 *     | `BYRD_CAW`                     | 否         | —                    | buff          |
 *     | `BYRD_FLY`                     | 否         | —                    | buff          |
 *     | `BYRD_STUNNED`                 | 否         | —                    | unknown       |
 *     | `MUGGER_MUG` (`:473`)          | **是**     | `mugger/mug`         | attack        |
 *     | `MUGGER_LUNGE` (`:474`)        | **是**     | `mugger/lunge`       | attack        |
 *     | `MUGGER_SMOKE_BOMB`            | 否         | —                    | defend        |
 *     | `MUGGER_ESCAPE`                | 否         | —                    | unknown       |
 *     ⚠ 三条鸟的顺序在参考里是 PECK / SWOOP / **HEADBUTT**（不按枚举序），照抄时按名字找、
 *     别按位置数。
 *   * **第二十五批的两只**（逐条核对 `MonsterMoves.h:490-492` / `:497-498`）：
 *     | 参考招式                                    | 在白名单？ | 我们的键                         | 数据表 intent |
 *     | ------------------------------------------- | ---------- | -------------------------------- | ------------- |
 *     | `SHELLED_PARASITE_DOUBLE_STRIKE` (`:490`)   | **是**     | `shelled_parasite/double_strike` | attack        |
 *     | `SHELLED_PARASITE_SUCK` (`:491`)            | **是**     | `shelled_parasite/suck`          | attack        |
 *     | `SHELLED_PARASITE_FELL` (`:492`)            | **是**     | `shelled_parasite/fell`          | attack        |
 *     | `SHELLED_PARASITE_STUNNED`                  | 否         | —                                | unknown       |
 *     | `SNECKO_TAIL_WHIP` (`:497`)                 | **是**     | `snecko/tail_whip`               | attack        |
 *     | `SNECKO_BITE` (`:498`)                      | **是**     | `snecko/snecko_bite`             | attack        |
 *     | `SNECKO_PERPLEXING_GLARE`                   | 否         | —                                | debuff        |
 *     ⚠ 寄生虫那三条在参考里的顺序是 DOUBLE_STRIKE / **SUCK** / FELL，而枚举声明序是
 *     DOUBLE_STRIKE / FELL / STUNNED / SUCK——又一个「按名字找、别按位置数」的例子。
 *   * **第二十六批的两只**（逐条核对 `MonsterMoves.h:439-440` / `:475`）：
 *     | 参考招式                        | 在白名单？ | 我们的键                | 数据表 intent |
 *     | ------------------------------- | ---------- | ----------------------- | ------------- |
 *     | `CENTURION_SLASH` (`:439`)      | **是**     | `centurion/cent_slash`  | attack        |
 *     | `CENTURION_FURY` (`:440`)       | **是**     | `centurion/cent_fury`   | attack        |
 *     | `CENTURION_DEFEND`              | 否         | —                       | defend        |
 *     | `MYSTIC_ATTACK_DEBUFF` (`:475`) | **是**     | `mystic/mystic_attack`  | attack        |
 *     | `MYSTIC_HEAL`                   | 否         | —                       | buff          |
 *     | `MYSTIC_BUFF`                   | 否         | —                       | buff          |
 *     ⚠ 白名单里百夫长只有两条（枚举声明序是 SLASH / FURY / DEFEND，参考的白名单也按这个序
 *     写，但秘法师那三条只挑了 ATTACK_DEBUFF 一条、位置在 `:475` 而不是 `:475-477`）。
 *     本批另外两个新编队（`THREE_CULTIST` / `CULTIST_AND_CHOSEN` / `SENTRY_AND_SPHERE`）
 *     里的怪全是已登记的，白名单一条都不用加。
 *   * **第二十七批的两只**（`MonsterMoves.h:459` / `:512`）：`GREMLIN_LEADER_STAB` 与
 *     `TASKMASTER_SCOURING_WHIP` 在；`GREMLIN_LEADER_RALLY` / `_ENCOURAGE` 不在。
 *   * **第二十八批的三只**（逐条核对 `MonsterMoves.h:431-435`）：
 *     | 参考招式                                | 在白名单？ | 我们的键                        | 数据表 intent |
 *     | --------------------------------------- | ---------- | ------------------------------- | ------------- |
 *     | `BOOK_OF_STABBING_MULTI_STAB` (`:431`)  | **是**     | `book_of_stabbing/multi_stab`   | attack        |
 *     | `BOOK_OF_STABBING_SINGLE_STAB` (`:432`) | **是**     | `book_of_stabbing/big_stab`     | attack        |
 *     | `BRONZE_AUTOMATON_FLAIL` (`:433`)       | **是**     | `bronze_automaton/flail`        | attack        |
 *     | `BRONZE_AUTOMATON_HYPER_BEAM` (`:434`)  | **是**     | `bronze_automaton/hyperbeam`    | attack        |
 *     | `BRONZE_AUTOMATON_BOOST`                | 否         | —                               | buff          |
 *     | `BRONZE_AUTOMATON_SPAWN_ORBS`           | 否         | —                               | unknown       |
 *     | `BRONZE_AUTOMATON_STUNNED`              | 否         | —                               | unknown       |
 *     | `BRONZE_ORB_BEAM` (`:435`)              | **是**     | `bronze_orb/orb_beam`           | attack        |
 *     | `BRONZE_ORB_STASIS`                     | 否         | —                               | debuff        |
 *     | `BRONZE_ORB_SUPPORT_BEAM`               | 否         | —                               | defend        |
 *     ⚠ 白名单里这五条是**连续**的（`:431-435`），因为枚举声明序恰好把突刺之书两条、
 *     自动机五条、球三条排在一起，而白名单又按枚举名字典序写——但**仍然要按名字核**：
 *     自动机的 `BOOST` / `SPAWN_ORBS` / `STUNNED` 与球的 `STASIS` / `SUPPORT_BEAM` 五条
 *     被跳过了，位置上并不连续。
 *   * **第三十二批的三只**（逐条核对 `MonsterMoves.h:453` / `:486` / `:502`）：
 *     | 参考招式                    | 在白名单？ | 我们的键             | 数据表 intent |
 *     | --------------------------- | ---------- | -------------------- | ------------- |
 *     | `EXPLODER_SLAM` (`:453`)    | **是**     | `exploder/exp_slam`  | attack        |
 *     | `EXPLODER_EXPLODE`          | **否**     | —                    | attack        |
 *     | `REPULSOR_BASH` (`:486`)    | **是**     | `repulsor/rep_bash`  | attack        |
 *     | `REPULSOR_REPULSE`          | 否         | —                    | debuff        |
 *     | `SPIKER_CUT` (`:502`)       | **是**     | `spiker/spk_cut`     | attack        |
 *     | `SPIKER_SPIKE`              | 否         | —                    | buff          |
 *     ⚠⚠ **`EXPLODER_EXPLODE` 是这张表迄今最刺眼的一格：它打 30 点却不算攻击。**
 *     参考的判据其实很自洽——`isMoveAttack` 收的是走 `attackPlayerHelper` /
 *     `Actions::AttackPlayer` 的那些招，而自爆走的是 `Actions::DamagePlayer`
 *     （MonsterSpecific.cpp:1394-1397，非攻击伤害、不吃力量与易伤）。
 *     ⚠ 同族的反例就在隔壁：匕首的自爆 `DAGGER_EXPLODE`（`:445`）**在**白名单里，
 *     因为它写的是 `attackPlayerHelper(bc, 25)`（`:1632-1636`）。两条形状几乎一样
 *     （打人 + `SuicideAction`），一条在一条不在，差别只在用了哪个 Action。
 *     ⚠ **真实游戏这里显示的是攻击意图**，所以这一格是「参考与真实游戏可能分歧」的候选，
 *     已如实写进 TODOS「待裁定」——照抄参考，不打补丁（补丁没有预言机）。
 *   * **第三十三批的三只**（逐条核对 `MonsterMoves.h:478-479` / `:506-507` / `:522-523`）：
 *     | 参考招式                                 | 在白名单？ | 我们的键                      | 数据表 intent |
 *     | ---------------------------------------- | ---------- | ----------------------------- | ------------- |
 *     | `ORB_WALKER_LASER` (`:478`)              | **是**     | `orb_walker/ow_laser`         | attack        |
 *     | `ORB_WALKER_CLAW` (`:479`)               | **是**     | `orb_walker/ow_claw`          | attack        |
 *     | `SPIRE_GROWTH_QUICK_TACKLE` (`:506`)     | **是**     | `spire_growth/sg_quick_tackle`| attack        |
 *     | `SPIRE_GROWTH_SMASH` (`:507`)            | **是**     | `spire_growth/sg_smash`       | attack        |
 *     | `SPIRE_GROWTH_CONSTRICT`                 | 否         | —                             | debuff        |
 *     | `THE_MAW_SLAM` (`:522`)                  | **是**     | `the_maw/maw_slam`            | attack        |
 *     | `THE_MAW_NOM` (`:523`)                   | **是**     | `the_maw/maw_nom`             | attack        |
 *     | `THE_MAW_ROAR`                           | 否         | —                             | debuff        |
 *     | `THE_MAW_DROOL`                          | 否         | —                             | buff          |
 *     ⚠ 本批**七条全部**与「走没走 `attackPlayerHelper`」这条判据一致，一个反例都没有：
 *     缠绕 / 咆哮是裸的 `bc.player.debuff<...>`、流涎是 `buff<MS::STRENGTH>`，
 *     三条都不经过那个函数。⚠ 而吞噬每击才 5 点却**在**列——判据是**函数**不是伤害量，
 *     与爆破怪那一格恰好是同一条判据的两个方向。
 *   * ⚠ 参考的白名单里 `THE_MAW_SLAM` / `THE_MAW_NOM` 紧挨着守卫者四条之后（`:518-523`），
 *     而 `ORB_WALKER_*` 在 `NEMESIS_*` 与 `POINTY_ATTACK` 之间——**它整张表按怪名字母序、
 *     不按枚举序**，抄的时候按名字找、别按位置数（与第二十四 / 二十五批同一条教训）。
 *
 * ⚠⚠ **第二十四批起这张表第一次有预言机**：`isMonsterAttacking` 的唯一读者是觅敌之弱，
 * 而第十三批之后的编队都走 `ENC_V0`（只有 variant 0 那副 21 张牌组，里面没有它）。
 * 那一批给 act-2 的新 variant 加了一张 `SPOT_WEAKNESS`，于是它那三个编队里这条谓词
 * **真的被读**。
 * ✅ **第三十批把第二幕剩下的三个编队也补上了**：variant 30（19 编队 × asc19）的牌组同样带
 * 觅敌之弱，而它的编队列表**包含第二十三批那三个**（`spheric_guardian` / `chosen` /
 * `snake_plant`，那一批的 variant 里没有这张牌）。于是**硬化那个反例第一次有了预言机**
 * ——去掉它红 131 例，多加 `chosen/drain` 红 147 例、多加 `snake_plant/sp_spores` 红 30 例。
 * ⚠ 第十三~二十三批登记的**第一幕**那些怪仍然没有背书（它们的编队走 `ENC_V0`、
 * 牌组里没有觅敌之弱），见 TODOS 盲区表。
 *
 * ⚠ **登记新怪时必须回 `MonsterMoves.h` 逐条抄这张表**，不要从「带不带伤害」或数据表的
 * intent 推——硬化就是反例的存在证明。漏一条不会静默：这只怪的那个意图会被判成「不是攻击」。
 *
 * ⚠ 表里只列**已登记**的怪。未登记的怪根本进不了战斗（`constructMonster` / 编队闸门先抛错），
 * 所以不必预先抄第二 / 三幕那 40 只——抄了也没有预言机看着。
 */
const MONSTER_ATTACK_MOVES: ReadonlySet<string> = new Set([
  // 酸液史莱姆 L / M / S（`:417-421`）
  "acid_slime_l/corrosive_spit_l",
  "acid_slime_l/tackle_l",
  "acid_slime_m/corrosive_spit",
  "acid_slime_m/tackle",
  "acid_slime_s/tackle_acid_s",
  // 尖刺史莱姆 L / M / S（`:503-505`）
  "spike_slime_l/flame_tackle_l",
  "spike_slime_m/flame_tackle",
  "spike_slime_s/tackle_s",
  // 拜鸟（`:436-438`，第二十四批）。⚠ 起飞 / 啼鸣 / 眩晕都不在。
  "byrd/peck",
  "byrd/swoop",
  "byrd/headbutt",
  // 突刺之书（`:431-432`，第二十八批）。两招都是攻击，一条不落。
  "book_of_stabbing/multi_stab",
  "book_of_stabbing/big_stab",
  // 青铜自动机（`:433-434`，第二十八批）。⚠ **五招里只有两条在**：
  //   连枷 / 超射线 → 在；增益（力量+格挡）/ 召唤青铜球 / 眩晕 → **不在**。
  "bronze_automaton/flail",
  "bronze_automaton/hyperbeam",
  // 青铜球（`:435`，第二十八批）。⚠ **三招里只有光束在**：支援光束（给 1 号位加格挡）
  //   与停滞（扣牌）都不在。
  "bronze_orb/orb_beam",
  // 蓝 / 红奴隶主（`:428-429` / `:484-485`）
  "blue_slaver/stab",
  "blue_slaver/rake",
  "red_slaver/rs_stab",
  "red_slaver/scrape",
  // 百夫长（`:439-440`，第二十六批）。⚠ 防守不在——它给 1 号位加格挡、不带伤害。
  "centurion/cent_slash",
  "centurion/cent_fury",
  // 秘法师（`:475`，第二十六批）。⚠ 治疗与鼓舞都不在（纯 buff），只有法击在。
  "mystic/mystic_attack",
  // 选民（`:441-443`，第二十三批）
  "chosen/poke",
  "chosen/zap",
  "chosen/debilitate",
  // 邪教徒（`:446`）
  "cultist/dark_strike",
  // 地精五只（`:454` / `:462` / `:472` / `:493` / `:496`）
  "fat_gremlin/smash",
  "gremlin_wizard/ultimate_blast",
  "mad_gremlin/scratch",
  "shield_gremlin/shield_bash",
  "sneaky_gremlin/puncture",
  // 爆破怪（`:453`，第三十二批）。⚠⚠ **自爆不在**——它打 30 点却走 `Actions::DamagePlayer`，
  //   而这张表收的是走 `attackPlayerHelper` 的那些招。判据见上方表格里那条 ⚠⚠。
  "exploder/exp_slam",
  // 真菌兽（`:455`）
  "fungi_beast/fungi_bite",
  // 红 / 绿虱（`:458` / `:481`）
  "green_louse/bite",
  "louse/bite",
  // 地精首领（`:459`，第二十七批）。⚠ 集结与鼓舞**都不在**——白名单里只有突刺一条。
  "gremlin_leader/gl_stab",
  // 地精头目（`:460-461`）
  "gremlin_nob/rush",
  "gremlin_nob/skull_bash",
  // 六火幽魂（`:463-466`）
  "hexaghost/divider",
  "hexaghost/inferno",
  "hexaghost/sear",
  "hexaghost/tackle",
  // 颚虫（`:467-468`）
  "jaw_worm/chomp",
  "jaw_worm/thrash",
  // 拉加维林（`:469`）
  "lagavulin/lag_attack",
  // 抢劫者（`:470-471`）
  "looter/mug",
  "looter/lunge",
  // 劫匪（`:473-474`，第二十四批）。⚠ 烟雾弹与逃跑不在，与抢劫者同形。
  "mugger/mug",
  "mugger/lunge",
  // 斥力怪（`:486`，第三十二批）。⚠ 斥力（洗两张恍惚）不在。
  "repulsor/rep_bash",
  // 哨卫（`:489`）
  "sentry/beam",
  // 带壳寄生虫（`:490-492`，第二十五批）。⚠ 眩晕不在（那一回合它什么也不做）。
  "shelled_parasite/double_strike",
  "shelled_parasite/suck",
  "shelled_parasite/fell",
  // 史莱姆王（`:494`）
  "slime_boss/slam",
  // 食蛇草（`:495`，第二十三批）
  "snake_plant/sp_chomp",
  // 史尼克（`:497-498`，第二十五批）。⚠ 惑目不在（纯 debuff）。
  "snecko/tail_whip",
  "snecko/snecko_bite",
  // 球状守卫者（`:499-501`，第二十三批）。⚠ 硬化在列——它同时加格挡，这就是那个反例。
  "spheric_guardian/sg_slam",
  "spheric_guardian/sg_harden",
  "spheric_guardian/sg_attack_debuff",
  // 尖刺客（`:502`，第三十二批）。⚠ 增生尖刺（+2 荆棘）不在。
  "spiker/spk_cut",
  // 工头（`:512`，第二十七批）。它只有这一招，自然在列。
  "taskmaster/scouring_whip",
  // 火炬头（`:513`，第二十九批）。它只有这一招，自然在列。
  "torch_head/torch_tackle",
  // 冠军（`:514-516`，第二十九批）。⚠ **七招里只有三条在**：
  //   扇脸 / 重斩 / 处决 → 在；防御姿态 / 嘲讽 / 自夸 / 暴怒 → **不在**。
  //   ⚠ 防御姿态在参考里不算攻击（它只加格挡与金属化），与球状守卫者的「硬化」
  //   （加格挡**再打人**，因此在列）不是一回事——别按名字猜。
  "champ/face_slap",
  "champ/champ_slash",
  "champ/execute",
  // 收藏家（`:517`，第二十九批）。⚠ **四招里只有火球在**：
  //   召唤火炬头 / 增幅 / 巨型削弱都不在。
  "the_collector/fireball",
  // 守卫者（`:518-521`）
  "the_guardian/fierce_bash",
  "the_guardian/whirlwind",
  "the_guardian/roll_attack",
  "the_guardian/twin_slam",
  // 暗球游荡者（`:478-479`，第三十三批）。它只有这两招，**两条都在**。
  "orb_walker/ow_laser",
  "orb_walker/ow_claw",
  // 尖塔增生（`:506-507`，第三十三批）。⚠ **三招里只有两条在**：急冲 / 重砸 → 在；
  //   缠绕 → **不在**（它走的是裸的 `bc.player.debuff<PS::CONSTRICTED>`，不带任何伤害，
  //   自然不经过 `attackPlayerHelper`）。
  "spire_growth/sg_quick_tackle",
  "spire_growth/sg_smash",
  // 大嘴（`:522-523`，第三十三批）。⚠ **四招里只有两条在**：重击 / 吞噬 → 在；
  //   咆哮（裸 debuff）/ 流涎（自身 buff）→ **不在**。
  //   ⚠ 吞噬在列这件事值得记一笔：它每击才 5 点、段数还从 1 起步，可它走的是
  //     `attackPlayerHelper(bc, 5, t)`——判据是**函数**不是伤害量，与第三十二批
  //     「爆破怪自爆 30 点却不在」正好是同一条判据的两个方向。
  "the_maw/maw_slam",
  "the_maw/maw_nom",
  // 暗影客（`:449-450`，第三十四批）。⚠ **五招里只有两条在**：撕咬 / 啃食 → 在；
  //   硬化（裸 `addBlock`）/ 重生（空 case）/ 复活（纯状态机）→ **都不在**。
  //   ⚠ 撕咬的伤害是出生时掷定的 `miscInfo`，可它照样走 `attackPlayerHelper`
  //     ——判据永远是**函数**，不是伤害从哪来。
  "darkling/darkling_nip",
  "darkling/darkling_chomp",
  // 复形怪（`:526`，第三十四批）。它只有这一招，在列。
  "transient/transient_slam",
  // 巨头（`:456-457`，第三十五批）。⚠ **三招里只有两条在**：数数 / 时候到了 → 在；
  //   凝视 → **不在**（它走的是裸的 `bc.player.debuff<PS::WEAK>(1, true)`，不带任何伤害）。
  "giant_head/gh_count",
  "giant_head/gh_it_is_time",
  // 蠕动血块（`:527` / `:550-552`，第三十五批登记，**第三十六批打补丁补上萎缩**）。
  //   挥击 / 乱抽 / 重抽 / **萎缩** → 在；植入（没有伤害）→ 不在。
  //   ⚠⚠ **萎缩这一条是本项目给参考打的补丁**，不是照抄：第三十五批发现它走
  //   `attackPlayerHelper(bc, asc2 ? 12 : 10)`（MonsterSpecific.cpp:1560-1565）却**不在**
  //   参考的白名单里，并记进 TODOS「待裁定」；第三十六批复核后打了补丁（`isMoveAttack` 加一行）。
  //   证据链两条：① 全表扫过之后**它是整个参考里唯一一个「伤害走 `attackPlayerHelper`
  //   却不在白名单」的招式**（反方向那些例外要么走 `Actions::DamagePlayer`——爆破怪的自爆，
  //   那是自洽的；要么走 `Actions::VampireAttack`——寄生虫的吸取）；② 四个同族的
  //   「攻击 + 减益」招式 `CHOSEN_DEBILITATE` / `SPHERIC_GUARDIAN_ATTACK_DEBUFF` /
  //   `MYSTIC_ATTACK_DEBUFF` / `SNECKO_TAIL_WHIP` **全在表里**，只有它例外。
  //   ⚠ 与爆破怪那一格的分水岭：爆破怪是**参考在自己的规则下自洽**（非攻击伤害路 → 不在表里），
  //   萎缩是**参考跟自己不自洽**（攻击路 → 却不在表里，且全表唯一）。
  //   「隔壁那个是这样」不是证据，**「全表只有它一个例外」才是**。
  //   ⚠ 补丁只影响 `writhing_mass.jsonl` 一个已冻结文件，第三十六批走
  //   `ALLOW_CHANGED="writhing_mass"` 重新生成（24 例）。
  "writhing_mass/wm_flail",
  "writhing_mass/wm_wither",
  "writhing_mass/wm_multi_strike",
  "writhing_mass/wm_strong_strike",
  // 复仇魔（`:476-477`，第三十六批）。⚠ **三招里只有两条在**：
  //   多重打击 / 巨镰 → 在；灼烧诅咒 → **不在**（它一点伤害都不带，只往弃牌堆塞灼烧，
  //   自然不经过 `attackPlayerHelper`）。与哨卫的射钉那一格同形。
  "nemesis/nem_attack",
  "nemesis/nem_scythe",
  // 蜥蜴法师（`:484-485`，第三十六批）。⚠ **三招里只有两条在**：
  //   毒牙 / 巨口 → 在；召唤匕首 → **不在**（纯召唤，不带伤害）。
  //   ⚠ 参考的白名单里这两条的顺序是 SNAKE_STRIKE 在前、BIG_BITE 在后，而枚举声明序是
  //   SUMMON / SNAKE_STRIKE / BIG_BITE——又一个「按名字找、别按位置数」的例子。
  "reptomancer/snake_strike",
  "reptomancer/big_bite",
  // 匕首（`:447-448`，第三十六批）。⚠⚠ **两招全在，而自爆这一格是爆破怪那一格的镜像**：
  //   突刺 → 在；**自爆也在**——它写的是 `attackPlayerHelper(bc, 25)`（MonsterSpecific.cpp:1632），
  //   而爆破怪的自爆写的是 `Actions::DamagePlayer(30)`，于是打 30 点的那个不算攻击、
  //   打 25 点的这个算。两条 case 的形状几乎一样（打人 + `SuicideAction`），
  //   **差别只在用了哪个函数**——这就是判据本身。
  "dagger/dagger_stab",
  "dagger/dagger_explode",
  // 觉醒者（`:422-426`，第三十七批）。⚠ **六招里有五条在**——白名单里连着五行：
  //   `AWAKENED_ONE_SLASH` / `_SOUL_STRIKE` / `_DARK_ECHO` / `_SLUDGE` / `_TACKLE`；
  //   只有 **`AWAKENED_ONE_REBIRTH` 不在**（它一点伤害都不带，整条是状态机）。
  // ⚠ 污泥在列这件事值得记一笔：它「打 18 点 + 往抽牌堆塞一张虚无」，与球状守卫者的
  //   「攻击削弱」、复仇魔的「灼烧诅咒」正好是同一条判据的两侧——判据是**有没有走
  //   `attackPlayerHelper`**，不是「这一招还顺手做了别的没有」。灼烧诅咒之所以不在，
  //   是因为它**一点伤害都不带**。
  // ⚠ 白名单里这五条的顺序（SLASH / SOUL_STRIKE / **DARK_ECHO** / SLUDGE / TACKLE）
  //   与枚举声明序（SLASH / SOUL_STRIKE / **REBIRTH** / DARK_ECHO / SLUDGE / TACKLE）
  //   不同——又一个「按名字找、别按位置数」的例子（先例是蜥蜴法师那两条）。
  "awakened_one/aw_slash",
  "awakened_one/soul_strike",
  "awakened_one/dark_echo",
  "awakened_one/sludge",
  "awakened_one/aw_tackle",
  // 时间吞噬者（`:524-525`，第三十八批）。⚠ **四招里只有两条在**，而且两条挨着写：
  //   `TIME_EATER_REVERBERATE` / `TIME_EATER_HEAD_SLAM` → 在（两条都走 `attackPlayerHelper`）；
  //   `TIME_EATER_RIPPLE` / `TIME_EATER_HASTE`          → **不在**（一点伤害都不带）。
  // ⚠ 头槌在列的理由与觉醒者的污泥同族：判据是**有没有走 `attackPlayerHelper`**，
  //   不是「这一招还顺手做了别的没有」——头槌还会上抽牌削减、asc19 还塞两张黏液，照样算攻击。
  // ⚠ 涟漪在真实游戏里显示的是「防御 + debuff」双意图，而加速显示的是「buff」；
  //   两者都不带伤害，所以参考不把它们收进白名单，与我们的 `intent` 字段无关。
  "time_eater/te_reverberate",
  "time_eater/te_head_slam",
  // 迪卡与多努（`:451-452`，第三十九批）。⚠ 四招里**只有两条光束在**，而且参考把它们
  //   并排写在一起：`DECA_BEAM` / `DONU_BEAM` → 在；
  //   `DECA_SQUARE_OF_PROTECTION` / `DONU_CIRCLE_OF_POWER` → **不在**（都不带伤害）。
  // ⚠ 迪卡的光束还会往弃牌堆塞两张恍惚，照样算攻击——判据仍是**有没有走
  //   `attackPlayerHelper`**，与「这一招还顺手做了别的没有」无关（同族：觉醒者的污泥、
  //   时间吞噬者的头槌）。
  // ⚠ 两只怪的招式 id 在我们这边不带怪名前缀（`deca_beam` / `donu_beam`），
  //   但键是 `defId/moveId`，所以两条互不干扰。
  "deca/deca_beam",
  "donu/donu_beam",
  // —— 第四十七批乙：第四幕与蒙面强盗，**白名单就此抄完**（`MonsterMoves.h:416-535`
  //   的每一格现在都有宿主）——
  //
  // 腐化之心（`:444-445`）：四招里**只有两条在**——
  //   `CORRUPT_HEART_BLOOD_SHOTS` / `CORRUPT_HEART_ECHO` → 在（都走 `attackPlayerHelper`）；
  //   `CORRUPT_HEART_DEBILITATE` / `CORRUPT_HEART_BUFF`  → **不在**（一点伤害都不带）。
  // ⚠ 虚弱化上三层减益 + 塞五张牌却不算攻击，判据仍是那一条：**有没有走
  //   `attackPlayerHelper` / `Actions::AttackPlayer`**。
  "corrupt_heart/blood_shots",
  "corrupt_heart/heart_echo",
  // 尖塔护盾（`:508-509`）：猛击与重砸在，**加固不在**。
  // ⚠ 重砸走的是拆开写的 `calculateDamageToPlayer` + `Actions::AttackPlayer`（不是
  //   `attackPlayerHelper`），照样算攻击——那正是第三十二批那条更强判据的措辞
  //   「走 `attackPlayerHelper` / `Actions::AttackPlayer` 的那些招」。
  "spire_shield/shield_bash",
  "spire_shield/shield_smash",
  // 尖塔长矛（`:510-511`）：灼烧打击与贯穿在，**穿刺不在**（它只加力量）。
  "spire_spear/burn_strike",
  "spire_spear/skewer",
  // 蒙面强盗三只（`:427-428` / `:480` / `:487-488`）：
  //   熊     猛扑 / 撕咬 在，**熊抱不在**（只减敏捷）；
  //   尖头怪 唯一那招在；
  //   罗密欧 苦痛斩 / 十字斩 在，**嘲讽不在**（它连效果都没有）。
  "bear/bear_lunge",
  "bear/maul",
  "pointy/pointy_attack",
  "romeo/agonizing_slash",
  "romeo/cross_slash",
]);

/**
 * 目标当前意图是否为攻击（对齐 `Monster::isAttacking` → `isMoveAttack(moveHistory[0])`）。
 *
 * 白名单与逐条核对见 `MONSTER_ATTACK_MOVES`。
 */
function isMonsterAttacking(bc: BattleContext, idx: number): boolean {
  const m = bc.monsters[idx];
  if (m === undefined) {
    return false;
  }
  // 分裂留下的空格（见 `EMPTY_MONSTER_SLOT`）：参考那一格是默认构造的 `Monster`，
  // `moveHistory[0] == INVALID` → `isMoveAttack(INVALID)` 走 `default: return false`。
  // 走白名单之后这一条其实是冗余的（`__empty/` 不可能命中），但留着让意图显式。
  if (m.defId === EMPTY_MONSTER_SLOT) {
    return false;
  }
  return MONSTER_ATTACK_MOVES.has(`${m.defId}/${m.currentMove}`);
}

// ============================================================================
// 抽牌 / 洗牌（对齐 BattleContext::drawCards + CardManager 洗牌）
//
// 洗牌：一次 shuffleRng.randomLong() 作 java::Random(LCG) 种子，Java Collections.shuffle。
// reshuffle：抽牌堆不足时把弃牌堆洗回（EmptyDeckShuffle，同一模式消耗一次 shuffleRng）。
// ============================================================================

function shuffleCards(bc: BattleContext, cards: CombatCard[]): void {
  const lcg = new JavaRandom(bc.rng.shuffleRng.randomLong()); // ★ 消耗一次 shuffleRng
  javaShuffle(cards, lcg);
}

/**
 * 抽一张牌进手（对齐 CardManager::draw 的循环体，CardManager.cpp:397）。
 *
 * 参考在每张牌**离开抽牌堆之后、进手牌之前**跑一串逐张触发。已登记两条，都是**入队**
 * 而非当场结算，所以它们排在本次 drawCards 的全部牌抽完之后：
 *   ① 进化 —— 抽到**状态牌**时 `addToBot(DrawCards(层数))`；
 *   ② 烈焰吐息 —— 抽到**状态牌或诅咒牌**时 `addToBot(DamageAllEnemy(层数))`。
 * 状态牌那支两条都走，且顺序固定「进化 → 烈焰吐息」；诅咒牌那支**只有**烈焰吐息
 *（进化在真实游戏与参考里都只认状态牌）。
 *
 * ⚠ 参考把 evolve / fireBreathing 两个层数读在**循环之外**（每次 draw 只读一次）。
 * 这里逐张读是等价的：两条触发都只入队、不同步改层数，一次 draw 内两个值不可能变。
 *
 * ⚠ 腐化那条与状态/诅咒两条是**同一条 if/else-if 链**（技能牌 → 状态牌 → 诅咒牌），
 * 三者互斥。传的是 -9，`setCostForTurn` 夹成 0。
 *
 * ⚠ 困惑（第二十五批）排在那条链**之前**，是函数体的第一段——见下方注释。
 *
 * TODO(后续PR): 虚无（抽到时 -1 能量，位置在烈焰吐息之后）——那张状态牌还没有入手途径。
 */
function drawOneCard(bc: BattleContext, card: CombatCard): void {
  // 困惑（CONFUSED，第二十五批的史尼克）：对齐 `CardManager::draw` 的第一段
  // （CardManager.cpp:403-412），位置在下面那条「技能 / 状态 / 诅咒」链**之前**。
  //
  //     if (bc.player.hasStatus<PS::CONFUSED>()) {
  //         if (c.cost >= 0) {
  //             const auto newCost = static_cast<std::int8_t>(bc.cardRandomRng.random(3));
  //             if (c.cost != newCost) { c.costForTurn = newCost; c.cost = newCost; }
  //             c.freeToPlayOnce = false;
  //         }
  //     }
  //
  // ⚠⚠ 四处非直觉、逐条照抄：
  //  ①⚠ **每抽一张就消耗一次 `cardRandomRng`**，与新费用是否等于原费用**无关**——
  //     那次 `random(3)` 写在 `if (c.cost != newCost)` 的**外面**。`cardRandomRng` 是共享流
  //     （洗牌塞牌、随机弃牌、随机目标都在用），所以困惑一上身，此后所有 cardRandomRng
  //     消费者的取值全部平移。`rng.cardRandom` 计数器在每一帧都盯着这件事。
  //     ⚠ 把 `random(3)` 挪进那个 if 里是**最容易犯**的等价化错误：绝大多数时候新旧费用
  //     不同、看着没差别，一旦掷出等于原费用的那一次，此后整条流就错位了。
  //  ② **`cost` 与 `costForTurn` 都被改，而且是永久的**——不是「本回合」。与腐化 / 疯狂
  //     那类只改 `costForTurn` 的降费不是一族：回合末 `resetAttributesAtEndOfTurn` 把
  //     `costForTurn` 复位成 `cost`，而 `cost` 已经是新值了，所以改动跨回合留着。
  //     ⚠ 这里是**直接赋值**，不走 `setCostForTurn`（那个有 `costForTurn >= 0` 的门与
  //     `max(0, …)`，语义不同）；上面 `cost >= 0` 那道门已经保证了不会碰到哨兵值。
  //  ③ **只在 `cost != newCost` 时才赋值**。语义上是空操作（相等时赋值也一样），
  //     但形状照抄。
  //  ④ `c.cost >= 0` 这道门排除**两种**哨兵：X 费牌（-1）与打不出的状态/诅咒牌（-2）
  //     ——所以困惑既不会把 X 费牌变成定费，也不会让伤口变得能打。
  //     参考在那行留了 `// todo status and curses affected by this?`，照抄它的判据。
  // ⚠ `freeToPlayOnce = false` 那一句我们**没有对应字段**，而且它在参考里是**死代码**：
  //   `freeToPlayOnce` 只有两个写入点——`playCardQueueItem` 里 `if (c.isFreeToPlay(*this))`
  //   （而 `isFreeToPlay` = `freeToPlayOnce || (攻击牌 && FREE_ATTACK_POWER)`，
  //   而 `PS::FREE_ATTACK_POWER` **全项目没有任何写入点**），以及 `chooseForethoughtCard`
  //   （深谋远虑，参考没有实现完、我们永久跳过）。所以它恒为 false，这一句什么也没做。
  //   ⚠ 将来登记「回身步」那类给 FREE_ATTACK_POWER 上层数的牌时，要连字段一起补。
  if (getPower(bc.player.powers, "confused") > 0) {
    if (card.cost >= 0) {
      const newCost = bc.rng.cardRandomRng.random(3); // ★ 恒消耗一次 cardRandomRng（在 if 外面！）
      if (card.cost !== newCost) {
        card.costForTurn = newCost;
        card.cost = newCost;
      }
    }
  }
  const type = getCardDef(card.defId).type;
  if (type === "skill") {
    if (getPower(bc.player.powers, "corruption") > 0) {
      setCostForTurn(card, -9);
    }
  } else if (type === "status") {
    const evolve = getPower(bc.player.powers, "evolve");
    if (evolve > 0) {
      addToBot(bc, (c) => drawCards(c, evolve));
    }
    const fireBreathing = getPower(bc.player.powers, "fire_breathing");
    if (fireBreathing > 0) {
      addToBot(bc, (c) => damageAllEnemiesNonAttack(c, fireBreathing));
    }
    // 虚无（VOID，觉醒者的污泥塞进抽牌堆的那张，第三十七批）：对齐 CardManager.cpp:426-429
    //     if (c.getId() == CardId::VOID) {
    //         // game adds action to bottom of the queue but I think it is ok to do directly
    //         bc.player.energy = std::max(0, bc.player.energy-1);
    //     }
    // ⚠ 四处照抄：
    //  ① **同步**扣能量，不入队——参考在那行自注「游戏里是入队的，但我觉得直接做也行」，
    //     那是作者**明说的偏离真实游戏**，照抄参考（预言机就是它）。
    //  ② `std::max(0, …)`：能量已经是 0 时抽到它不会变成 -1。
    //  ③ 位置在**状态牌那一段的最后**（进化抽牌 → 烈焰吐息 → 这一条），而且整段排在
    //     「进手牌」之前——所以这一点能量在这张牌落进手牌之前就没了。
    //  ④ 它是按**卡 id** 判的，不是按某个属性。虚无自己打不出（费用哨兵 -2）、是虚无牌
    //     （回合末没打出去就被消耗），两者都由数据表带着，与这一条无关。
    if (card.defId === "void") {
      bc.player.energy = Math.max(0, bc.player.energy - 1);
    }
  } else if (type === "curse") {
    const fireBreathing = getPower(bc.player.powers, "fire_breathing");
    if (fireBreathing > 0) {
      addToBot(bc, (c) => damageAllEnemiesNonAttack(c, fireBreathing));
    }
  }
  // 手牌上限由调用方的 toDraw 保证不会越界（对齐参考 `if (cardsInHand < 10) moveToHand`）。
  bc.hand.push(card);
}

/**
 * 抽牌（对齐 `BattleContext::drawCards`，BattleContext.cpp:2413）。
 * 抽牌堆顶 = 数组尾（对齐 `CardManager::popFromDrawPile` = `drawPile.back()` + `pop_back()`）。
 *
 * ⚠ 四条提前返回逐字照抄，顺序不能动。第三条 `抽牌堆 + 弃牌堆 == 0` 是**唯一**能免掉下面
 * 那次 shuffleRng 的门：两堆都空才不洗，只有抽牌堆空是**照样要洗**的（见下）。
 * NO_DRAW（战斗恍惚）排在最前面，命中它连 reshuffle 都不做。
 *
 * ⚠ 抽不够时**不是**同步「抽干 → 洗回 → 补抽」，而是拆成三步、后两步走**动作队列**：
 *   ① `addToTop(DrawCards(缺的张数))`、② `onShuffle()`、③ `addToTop(EmptyDeckShuffle())`
 *      —— ①③ 都是 addToTop 且 ③ 后推，所以执行顺序是「先洗、再补抽」；
 *   ④ 抽牌堆非空时**同步**把它剩下的抽干（递归调自己，参数是抽牌堆张数）。
 *
 * ⚠ 第十一批修掉的转写错误：原先这里写的是「弃牌堆非空才洗」，于是
 * **「抽牌堆还剩几张、但弃牌堆是空的」这种局面白省了一次 shuffleRng**。参考的
 * `EmptyDeckShuffle` 无条件先取 `shuffleRng.randomLong()` 再洗（Actions.cpp:181），
 * 空弃牌堆同样消耗一次；能免掉它的只有上面那条「两堆都空」的提前返回。
 * 第十一批炸弹那副牌组（净化 + 坚毅把牌大量消耗掉）第一次走到这个局面，对拍红了 3 例。
 */
function drawCards(bc: BattleContext, count: number): void {
  if (
    count <= 0 ||
    getPower(bc.player.powers, "no_draw") > 0 ||
    bc.drawPile.length + bc.discardPile.length === 0 ||
    bc.hand.length === MAX_HAND_SIZE
  ) {
    return;
  }
  const amountToDraw = Math.min(MAX_HAND_SIZE - bc.hand.length, count);
  if (bc.drawPile.length < amountToDraw) {
    const temp = amountToDraw - bc.drawPile.length;
    addToTop(bc, (c) => drawCards(c, temp), true, { kind: "draw_cards", count: temp });
    onShuffle(bc);
    addToTop(bc, (c) => emptyDeckShuffle(c));
    if (bc.drawPile.length > 0) {
      drawCards(bc, bc.drawPile.length); // 同步递归（参考自注 `// the game adds this to top`）
    }
    return;
  }
  // 对齐 CardManager::draw：上面那道门保证抽牌堆够，所以这里不再取 min。
  for (let i = 0; i < amountToDraw; i += 1) {
    drawOneCard(bc, bc.drawPile.pop()!);
  }
}

/**
 * 弃牌堆并入抽牌堆（对齐 CardManager::moveDiscardPileIntoToDrawPile）。
 * 抽牌堆为空时直接接管整叠；非空时**逐张压到牌堆顶**（数组尾即顶）。
 * 两条分支的结果牌序不同，不能统一成一种写法。
 */
function moveDiscardPileIntoDrawPile(bc: BattleContext): void {
  if (bc.drawPile.length === 0) {
    bc.drawPile = bc.discardPile;
  } else {
    for (const c of bc.discardPile) {
      bc.drawPile.push(c);
    }
  }
  bc.discardPile = [];
}

/**
 * 洗牌触发点（对齐 `BattleContext::onShuffle`，BattleContext.cpp:2826-2844）。
 *
 * 参考的函数体是三条并列的 `if`，顺序由源码定死：算盘 → 什锦 → 日晷。
 *
 * ⚠ 算盘（THE_ABACUS，第四十三批）：`addToBot(Actions::GainBlock(6))`。
 *  ① 是 `addToBot`（入队），而两个调用点都是**同步**调它的——所以那 6 点格挡排在
 *     调用方随后入队的洗牌 / 抽牌动作**之前**（`drawCards` 那条路上，`onShuffle()` 在
 *     两次 `addToTop` **之间**，于是最终执行序是「洗牌 → 抽牌 → 加格挡」）。
 *  ② `Actions::GainBlock` 的 `clearOnCombatVictory` 是 false。
 *  ③ 触发点是「洗牌」而不是「抽牌堆见底」：深呼吸那条路也算一次。
 *
 * ⚠ 什锦（MELANGE）**在参考里整条被注释掉了**（`// addToBot(Actions::SetState(InputState::SCRY, 3))`，
 *   BattleContext.cpp:2831-2833），所以它没有预言机、不登记——与 SEEK 那族卡同理。
 */
function onShuffle(bc: BattleContext): void {
  if (hasRelic(bc, "the_abacus")) {
    addToBot(bc, (c) => gainBlock(c, 6), false);
  }
  // 日晷（SUNDIAL，第四十四批）：排在什锦那一格**之后**、也就是这个函数的最后一段
  // （BattleContext.cpp:2835-2842）：
  //     if (player.hasRelic<R::SUNDIAL>()) {
  //         if (player.sundialCounter == 2) {
  //             player.sundialCounter = 0;
  //             addToBot( Actions::GainEnergy(2) );
  //         } else {
  //             ++player.sundialCounter;
  //         }
  //     }
  // ⚠ 四处照抄：
  //  ①⚠⚠ **它是「先判后增」，与快乐花 / 熏香炉 / 双节棍那一族（先增后判）相反**：
  //     计数器停在 2 的那一次洗牌才给能量，也就是**第 3 次**洗牌。
  //     写成先增后判会让能量早一次洗牌到手。
  //  ② 命中那一支**不自增**（走的是 if 而不是 else），所以周期恰好是 3。
  //  ③ 能量是**入队**的 `GainEnergy(2)`，不是同步——与算盘那条格挡同在这个函数里，
  //     两条的 `clearOnCombatVictory` 不同（`GainEnergy` 默认 true、`GainBlock` 是 false）。
  //  ④ 计数器跨战斗延续（`initRelics` 搬进来、`updateRelicsOnExit` 写回去）。
  if (hasRelic(bc, "sundial")) {
    if (bc.player.sundialCounter === 2) {
      bc.player.sundialCounter = 0;
      addToBot(bc, (c) => {
        c.player.energy += 2;
      });
    } else {
      bc.player.sundialCounter += 1;
    }
  }
}

/** 手牌上限（对齐 CardManager::MAX_HAND_SIZE）。 */
const MAX_HAND_SIZE = 10;

// ============================================================================
// 「在场的打击牌张数」（对齐 CardManager::strikeCount）
//
// 完美打击的伤害是 `6 + strikeCount * (up ? 3 : 2)`，而 strikeCount **不是**每次打牌时
// 扫牌堆数出来的，是一个**增量计数器**：参考在 `notifyAddCardToCombat`（+1）与
// `notifyRemoveFromCombat`（-1）两个钩子里维护它（CardManager.cpp:258/264）。
//
// ⚠ 语义是「在这场战斗里」而不是「在某个牌堆里」：
//  * **加**的时机是「一张牌凭空进入战斗」——建大牌组实例、三个 createTempCardIn*、
//    两个 MakeTempCardIn(s)Hand 动作、以及掘尸把牌从消耗堆取回来。
//    牌堆之间的搬运（抽牌 / 弃牌 / 洗牌 / 打出）**一次都不动它**。
//  * **减**的时机只有一个：`moveToExhaustPile`。所以一张被打出、已离开手牌但还没进消耗堆
//    的牌**仍然算在内**——完美打击自己就是打击牌，它在算伤害那一刻还没进弃牌堆，故计入
//    自己（参考在那行注了 `// hack because we calculate strikeCount while non purge cards
//    are still in hand.`）。
//  * 二连击的复制项**不算**：`queuePurgeCard` 是按值拷贝、不走任何 notify，
//    对应地它结算完直接丢掉、也不走 `moveToExhaustPile`，两头都不动计数器。
//
// ⚠ 由此还有一处参考的边角行为被顺带照抄了：浩劫/混乱从抽牌堆顶拿走的牌若 canUse 不通过，
// 它凭空消失且**不**走 notifyRemoveFromCombat——计数器就永久偏高一张。当前观察不到
// （能被 canUse 拒掉的只有状态/诅咒牌，没有一张是打击牌），照参考写着。
// ============================================================================

/**
 * 名字含「打击」的牌（对齐 `isCardStrikeCard`，Cards.h:512）。
 *
 * 参考那份名单是「完整枚举 + `default: false`」，可以全表信任，故逐字抄全 13 项——
 * 其中只有 `strike` / `perfected_strike` / `pommel_strike` / `twin_strike` / `wild_strike` /
 * `swift_strike` 属于铁甲+无色，其余是别的角色的。判据是**牌名**、与颜色无关，所以整份
 * 名单照抄，铺到别的角色时这里不用改。
 * ⚠ `strike_blue` / `strike_green` / `strike_purple` 在**我们的数据表里还不存在**（四个角色
 * 的起始打击共用同一张 `strike`，见 TODOS「待裁定」）。仍然列着，是为了将来真的拆成四份时
 * 这个谓词自动跟上——现在它们只是三个匹配不到任何牌的名字，没有副作用。
 */
function isStrikeCard(defId: string): boolean {
  switch (defId) {
    case "meteor_strike":
    case "perfected_strike":
    case "pommel_strike":
    case "sneaky_strike":
    case "strike": // 四个角色的起始打击共用一张 `strike`（见 TODOS「待裁定」）
    case "strike_blue":
    case "strike_green":
    case "strike_purple":
    case "swift_strike":
    case "thunder_strike":
    case "twin_strike":
    case "wild_strike":
    case "windmill_strike":
      return true;
    default:
      return false;
  }
}

/** 一张牌进入战斗（对齐 CardManager::notifyAddCardToCombat，CardManager.cpp:258）。 */
function notifyAddCardToCombat(bc: BattleContext, card: CombatCard): void {
  if (isStrikeCard(card.defId)) {
    bc.strikeCount += 1;
  }
}

/** 一张牌离开战斗（对齐 CardManager::notifyRemoveFromCombat，CardManager.cpp:264）。 */
function notifyRemoveFromCombat(bc: BattleContext, card: CombatCard): void {
  if (isStrikeCard(card.defId)) {
    bc.strikeCount -= 1;
  }
}

/**
 * 进消耗堆（对齐 BattleContext::triggerAndMoveToExhaustPile，BattleContext.cpp:2814）。
 *
 * 参考在压入消耗堆**之前**先跑一串消耗触发，顺序固定：
 *   卡戎的骨灰 → 枯枝 → 黑暗拥抱 → 无痛之心 → 死灵诅咒 → 哨兵。
 * 本批登记了中间两条（都是玩家 Power），其余留 TODO。这个函数是全项目**唯一**的消耗入口，
 * 所以补触发只需改这一处、不会漏掉某条消耗路径（第四批把消耗收成单一入口就是为了这个）。
 *
 * ⚠ 两条 Power 都是 addToBot，且顺序不可换（黑暗拥抱的抽牌排在无痛之心的格挡之前）。
 * ⚠ 无痛之心走的是 `Actions::GainBlock(层数)`——**不过** calculateCardBlock，敏捷/脆弱都
 * 不参与；且 GainBlock 的 clearOnCombatVictory=false（Actions.cpp:161）。
 *
 * ⚠ 哨兵是**卡牌自身**的消耗触发（不是 Power），排在两条 Power 之后、压入消耗堆之前，
 * 而且是**同步**回能量：参考写 `player.gainEnergy(...)` 并自注 `// the game adds to bot
 * here`——真实游戏入队、参考图省事直接调。预言机是参考，故照它写同步（见报告）。
 * ⚠ 参考另有一份 `CardInstance::triggerOnExhaust`（CardInstance.cpp:207）也处理哨兵、
 * 且是 addToTop——但那个函数**全项目无人调用**，是死代码，不要照它写。
 *
 * ⚠ 卡戎的骨灰（CHARONS_ASHES，第四十三批）是这个函数的**第一句**
 *   （BattleContext.cpp:2850-2852）：`addToTop(Actions::DamageAllEnemy(3));`
 *  ①⚠⚠ 是 **`addToTop`**，而紧随其后的黑暗拥抱 / 无痛之心是 `addToBot`——所以骨灰的
 *     3 点伤害排在它们**之前**结算，且插在调用方还没出队的动作前面。
 *  ② 3 点是**非攻击**全体伤害（`DamageAllEnemy` 走 `Monster::damage`，不吃力量与易伤，
 *     但照样被怪物格挡吸收，也照样能触发手钻那道破盾门）。
 *  ③ `clearOnCombatVictory` 取默认的 true。
 *  ④ 触发点是「任何一张牌进消耗堆」——包括回合末以太牌（眩晕 / 幽灵护甲）的消耗，
 *     不只是「打出带消耗的牌」。
 *
 * TODO(遗物PR): 枯枝（DEAD_BRANCH，`getTrulyRandomCardInCombat` 从**整个牌池**造一张牌
 *   进手牌——随机牌可能是未登记的牌，trace 会不可重放，故本批不登记）。
 * TODO(后续PR): 死灵诅咒（消耗时自己再回手，排在无痛之心与哨兵之间）。
 */
function triggerAndMoveToExhaustPile(bc: BattleContext, card: CombatCard): void {
  if (hasRelic(bc, "charons_ashes")) {
    addToTop(bc, (c) => damageAllEnemiesNonAttack(c, 3));
  }
  const darkEmbrace = getPower(bc.player.powers, "dark_embrace");
  if (darkEmbrace > 0) {
    addToBot(bc, (c) => drawCards(c, darkEmbrace));
  }
  const feelNoPain = getPower(bc.player.powers, "feel_no_pain");
  if (feelNoPain > 0) {
    addToBot(bc, (c) => gainBlock(c, feelNoPain), false);
  }
  if (card.defId === "sentinel") {
    bc.player.energy += card.upgraded ? 3 : 2;
  }
  // 全项目**唯一**的「离场」点（对齐 CardManager::moveToExhaustPile 里那句
  // notifyRemoveFromCombat）：消耗是唯一让一张牌不再属于这场战斗的去向。
  notifyRemoveFromCombat(bc, card);
  bc.exhaustPile.push(card);
}

// ============================================================================
// 凭空造牌（对齐 Actions::MakeTempCardIn{Hand,DrawPile,Discard} +
// CardManager::createTempCardIn{Hand,DrawPile,Discard}）
//
// 状态牌 / 诅咒牌就是这么进场的。三个去向的 RNG 表现完全不同：
//   * 进弃牌堆   —— 无 RNG，直接 push_back
//   * 进手牌     —— 无 RNG，走 moveToHandHelper（手牌满 10 张改进弃牌堆）
//   * 洗入抽牌堆 —— **每张消耗一次 cardRandomRng**（抽牌堆为空时不掷）
//
// uid 一律取 nextUid++（对齐 `c.uniqueId = nextUniqueCardId++`）。参考的 nextUniqueCardId
// 初值是大牌组张数，我们的 nextUid 在建库时正好推进到同一个数，故两边一致。
// ============================================================================

function makeCardInstance(bc: BattleContext, defId: string, upgraded = false): CombatCard {
  return instantiate(bc, cardInstanceProto(defId, upgraded));
}

/**
 * 把一份**模板**变成真正入场的实例：取 uid + 通知「进入战斗」
 *（对齐 `c.uniqueId = nextUniqueCardId++;` 紧跟 `notifyAddCardToCombat(c)` 那两行）。
 *
 * 这两步在参考里成对出现于**每一个**造牌点（`createTempCardIn{Hand,DrawPile,Discard}`、
 * `Actions::MakeTempCardIn(s)Hand`、`chooseDualWieldCard` / `chooseDiscoveryCard` 的副本），
 * 所以收成一个函数；漏调一处就是 strikeCount 少算一张。
 *
 * ⚠ **不包括** `chooseDualWieldCard` 给原牌换 uid 那一步：那里只有 `uniqueId = ...`、
 * 没有 notify（原牌本来就在场）。也**不包括** `queuePurgeCard`（二连击的副本按值拷贝，
 * 两头都不动计数器）。
 */
function instantiate(bc: BattleContext, proto: CombatCard): CombatCard {
  const card = { ...proto, uid: bc.nextUid++ };
  notifyAddCardToCombat(bc, card);
  return card;
}

/**
 * 一份**尚未分配 uid** 的牌实例（对齐 `CardInstance(CardId, bool)` 本身：它只算费用，
 * `uniqueId` 保持默认 -1，要等 `createTempCardIn*` / `MakeTempCardInHand` 才递增计数器）。
 *
 * 分成两步是因为参考里这两个时点**真的会分开**：地狱之刃 / 多面手先在自己的动作里造实例，
 * 再 `addToTop(MakeTempCardInHand(...))`，uid 到那条动作执行时才取。多面手升级后推两条，
 * 后推的先执行，于是**第二张抽到的牌 uid 反而更小**——把 uid 提前到造实例时就反了。
 */
function cardInstanceProto(defId: string, upgraded = false): CombatCard {
  const cost = initialCardCost(defId, upgraded);
  return {
    uid: -1,
    defId,
    upgraded,
    // 对齐 `CardInstance::CardInstance(CardId, bool)`：cost = costForTurn = getEnergyCost(...)。
    cost,
    costForTurn: cost,
    specialData: initialSpecialData(defId, upgraded),
  };
}

/** 对齐 Actions::MakeTempCardInDiscard：逐张 push 到弃牌堆末尾，不消耗 RNG。 */
function makeTempCardInDiscard(
  bc: BattleContext,
  defId: string,
  amount: number,
  upgraded = false,
): void {
  for (let i = 0; i < amount; i += 1) {
    bc.discardPile.push(makeCardInstance(bc, defId, upgraded));
  }
}

/** 对齐 Actions::MakeTempCardInHand：逐张走 moveToHandHelper，不消耗 RNG。 */
function makeTempCardInHand(
  bc: BattleContext,
  defId: string,
  amount: number,
  upgraded = false,
): void {
  for (let i = 0; i < amount; i += 1) {
    moveToHandHelper(bc, makeCardInstance(bc, defId, upgraded));
  }
}

/**
 * 对齐 `Actions::MakeTempCardInHand(CardInstance card, int amount)`（Actions.cpp:227）：
 * 按**已经准备好的模板**逐张复制进手牌，每份各取一个新 uid。
 *
 * ⚠ 与上面按 defId 造牌那版的区别只在「模板已被调用方改过」：地狱之刃先
 * `c.setCostForTurn(0)` 再 addToTop 这条动作，那个 0 必须跟着复制过去。
 * 模板自身的 uid 是**未分配**（参考的 `CardInstance::uniqueId` 默认 -1），
 * 真正的 uid 在这里才取，与参考 `c.uniqueId = bc.cards.nextUniqueCardId++` 的时点一致。
 */
function makeTempCardInstanceInHand(bc: BattleContext, proto: CombatCard, amount = 1): void {
  for (let i = 0; i < amount; i += 1) {
    moveToHandHelper(bc, instantiate(bc, proto));
  }
}

/**
 * 对齐 `Actions::MakeTempCardsInHand(std::vector<CardInstance>)`（Actions.cpp:261）：
 * 把**一串各不相同**的牌实例逐张送进手牌，按数组顺序各取一个新 uid。
 *
 * ⚠ 与上面那个「同一个模板复制 amount 份」的重载是两条不同的代码：嬗变造出来的 X 张牌
 * 每张都是**独立随机**的，不能靠复制模板。此外这条是 `addToBot` 的一条**单独动作**——
 * 嬗变先在自己的动作里把 X 张牌全抽好（消耗 X 次 cardRandomRng），再排这条动作进手牌。
 */
function makeTempCardsInHand(bc: BattleContext, protos: readonly CombatCard[]): void {
  for (const proto of protos) {
    moveToHandHelper(bc, instantiate(bc, proto));
  }
}

/**
 * 对齐 Actions::MakeTempCardInDrawPile（Actions.cpp:239）的 `shuffleInto = true` 分支。
 *
 * ⚠ 三处照抄：
 *  ① 插入位置 `cardRandomRng.random(drawPile.size() - 1)`，即 0..size-1——**永远不会**插到
 *     牌堆顶（下标 size）。下标 0 是牌堆底、末尾是牌堆顶（`popFromDrawPile` 取 back）。
 *  ② 抽牌堆为空时 idx 取 0 且**不掷 RNG**。少判这个条件会白吃一次 cardRandomRng。
 *  ③ 每张牌各掷一次：`amount` 张就消耗 `amount` 次（本批登记的牌 amount 都是 1）。
 *  参考的 `shuffleInto = false` 分支是 `// todo else`（压根没实现），所以只转写 true 那支。
 */
function makeTempCardInDrawPile(
  bc: BattleContext,
  defId: string,
  amount: number,
  upgraded = false,
): void {
  for (let i = 0; i < amount; i += 1) {
    const idx = bc.drawPile.length === 0 ? 0 : bc.rng.cardRandomRng.random(bc.drawPile.length - 1); // ★ 消耗一次 cardRandomRng
    bc.drawPile.splice(idx, 0, makeCardInstance(bc, defId, upgraded));
  }
}

/**
 * 一张牌进手牌（对齐 BattleContext::moveToHandHelper，BattleContext.cpp:2546）：
 * 手牌满了就改进弃牌堆。
 *
 * ⚠ 腐化的钩子在**手牌未满**那一支里（进弃牌堆的那张不改费用，等它以后被抽到时
 * `drawOneCard` 里那条再补上）。传的是 -9，`setCostForTurn` 会夹成 0。
 */
function moveToHandHelper(bc: BattleContext, card: CombatCard): void {
  if (bc.hand.length < MAX_HAND_SIZE) {
    if (getPower(bc.player.powers, "corruption") > 0 && getCardDef(card.defId).type === "skill") {
      setCostForTurn(card, -9);
    }
    bc.hand.push(card);
  } else {
    bc.discardPile.push(card);
  }
}

// ============================================================================
// 战斗内卡池（对齐 include/constants/CardPools.h 的三个 namespace）
//
// ⚠ 这三个池与 **run 级奖励卡池**（`cards.ts` 的 `cardPoolOf`）不是一回事，别混用：
// 奖励池按 color + rarity 派生、且是 run 级 `cardRng` 的事；这三个是**战斗内**凭空造牌
// 用的固定数组，顺序写死在头文件里、消耗的是 `cardRandomRng`。取错池子或取错流会让
// 同种子的结果整个错位。三个池逐字抄自 CardPools.h：
//
//   * CombatTypeCardPool（`CardPools.h:150`）—— 按牌型取，铁甲 攻击 28 / 技能 28 / 能力 14。
//     蜕变（技能）与变形（攻击）走它。
//   * CombatCardPool（`:177`）—— 不分牌型的 70 张铁甲牌。**发现**走它。
//   * CombatColorlessCardPool（`:189`）—— 34 张无色牌。多面手走它。
//
// ⚠ `getPoolSize(cc, ...)` / `getCardAt(cc, ...)` 的 `cc` 参数**完全没被使用**——三个池
// 都只有铁甲那一份数据。我们的迁移范围本来就是铁甲，所以照抄成无参数的常量；
// 铺到别的角色时这里要跟着参考一起改（参考自己也还没有别的角色的池）。
// ============================================================================

/** 对齐 `CombatTypeCardPool::cardBlob`（攻击，28 张）。 */
const COMBAT_ATTACK_POOL: readonly string[] = [
  "sword_boomerang",
  "perfected_strike",
  "heavy_blade",
  "wild_strike",
  "headbutt",
  "clothesline",
  "twin_strike",
  "pommel_strike",
  "thunderclap",
  "clash",
  "body_slam",
  "iron_wave",
  "cleave",
  "anger",
  "uppercut",
  "dropkick",
  "carnage",
  "searing_blow",
  "whirlwind",
  "sever_soul",
  "rampage",
  "pummel",
  "blood_for_blood",
  "hemokinesis",
  "reckless_charge",
  "bludgeon",
  "fiend_fire",
  "immolate",
];

/** 对齐 `CombatTypeCardPool::skills`（技能，28 张）。 */
const COMBAT_SKILL_POOL: readonly string[] = [
  "havoc",
  "armaments",
  "shrug_it_off",
  "true_grit",
  "flex",
  "warcry",
  "ghostly_armor",
  "bloodletting",
  "second_wind",
  "battle_trance",
  "sentinel",
  "entrench",
  "rage",
  "disarm",
  "seeing_red",
  "shockwave",
  "burning_pact",
  "flame_barrier",
  "intimidate",
  "infernal_blade",
  "dual_wield",
  "power_through",
  "spot_weakness",
  "double_tap",
  "limit_break",
  "impervious",
  "exhume",
  "offering",
];

/** 对齐 `CombatTypeCardPool::powers`（能力，14 张）。当前没有登记的牌从它取，留着备用。 */
const COMBAT_POWER_POOL: readonly string[] = [
  "evolve",
  "fire_breathing",
  "rupture",
  "feel_no_pain",
  "dark_embrace",
  "combust",
  "metallicize",
  "inflame",
  "demon_form",
  "corruption",
  "barricade",
  "berserk",
  "juggernaut",
  "brutality",
];

/** 对齐 `CombatCardPool::cardBlob`（不分牌型，70 张）。 */
const COMBAT_CARD_POOL: readonly string[] = [
  "sword_boomerang",
  "perfected_strike",
  "heavy_blade",
  "wild_strike",
  "headbutt",
  "havoc",
  "armaments",
  "clothesline",
  "twin_strike",
  "pommel_strike",
  "thunderclap",
  "clash",
  "shrug_it_off",
  "true_grit",
  "body_slam",
  "iron_wave",
  "flex",
  "warcry",
  "cleave",
  "anger",
  "evolve",
  "uppercut",
  "ghostly_armor",
  "fire_breathing",
  "dropkick",
  "carnage",
  "bloodletting",
  "rupture",
  "second_wind",
  "searing_blow",
  "battle_trance",
  "sentinel",
  "entrench",
  "rage",
  "feel_no_pain",
  "disarm",
  "seeing_red",
  "dark_embrace",
  "combust",
  "whirlwind",
  "sever_soul",
  "rampage",
  "shockwave",
  "metallicize",
  "burning_pact",
  "pummel",
  "flame_barrier",
  "blood_for_blood",
  "intimidate",
  "hemokinesis",
  "reckless_charge",
  "infernal_blade",
  "dual_wield",
  "power_through",
  "inflame",
  "spot_weakness",
  "double_tap",
  "demon_form",
  "bludgeon",
  "limit_break",
  "corruption",
  "barricade",
  "fiend_fire",
  "berserk",
  "impervious",
  "juggernaut",
  "brutality",
  "exhume",
  "offering",
  "immolate",
];

/** 对齐 `CombatColorlessCardPool::cards`（34 张）。 */
const COMBAT_COLORLESS_POOL: readonly string[] = [
  "madness",
  "thinking_ahead",
  "mind_blast",
  "metamorphosis",
  "jack_of_all_trades",
  "swift_strike",
  "good_instincts",
  "master_of_strategy",
  "magnetism",
  "finesse",
  "discovery",
  "chrysalis",
  "transmutation",
  "panacea",
  "purity",
  "enlightenment",
  "forethought",
  "flash_of_steel",
  "hand_of_greed",
  "mayhem",
  "apotheosis",
  "secret_weapon",
  "panache",
  "violence",
  "deep_breath",
  "secret_technique",
  "blind",
  "the_bomb",
  "impatience",
  "dramatic_entrance",
  "trip",
  "panic_button",
  "sadistic_nature",
  "dark_shackles",
];

/**
 * 按牌型随机取一张战斗内卡牌（对齐 `sts::getTrulyRandomCardInCombat(rng, cc, type)`，
 * Game.cpp:221）。★ **消耗一次 cardRandomRng**，bound 是 `池大小 - 1`。
 *
 * ⚠ 参考的 `CombatTypeCardPool::getCardAt` 的 else 分支（type 既不是攻击也不是技能也不是
 * 能力）返回的是 **powers**，不是报错——照抄，虽然当前没有调用方走到它。
 */
function getTrulyRandomCardInCombat(bc: BattleContext, type: "attack" | "skill" | "power"): string {
  const pool =
    type === "attack"
      ? COMBAT_ATTACK_POOL
      : type === "skill"
        ? COMBAT_SKILL_POOL
        : COMBAT_POWER_POOL;
  const idx = bc.rng.cardRandomRng.random(pool.length - 1); // ★ 消耗一次 cardRandomRng
  return pool[idx];
}

/**
 * 不分牌型随机取一张战斗内卡牌（对齐 `sts::getTrulyRandomCardInCombat(rng, cc)`，
 * Game.cpp:215）。★ **消耗一次 cardRandomRng**。
 */
function getTrulyRandomCardInCombatAnyType(bc: BattleContext): string {
  const idx = bc.rng.cardRandomRng.random(COMBAT_CARD_POOL.length - 1); // ★ 消耗一次 cardRandomRng
  return COMBAT_CARD_POOL[idx];
}

/**
 * 随机取一张无色牌（对齐 `sts::getTrulyRandomColorlessCardInCombat`，Game.cpp:209）。
 * ★ **消耗一次 cardRandomRng**。
 */
function getTrulyRandomColorlessCardInCombat(bc: BattleContext): string {
  const idx = bc.rng.cardRandomRng.random(COMBAT_COLORLESS_POOL.length - 1); // ★ 消耗一次 cardRandomRng
  return COMBAT_COLORLESS_POOL[idx];
}

/**
 * 生成「发现」屏的 3 张候选（对齐 `sts::generateDiscoveryCards`，Game.cpp:228）。
 *
 * ⚠ **拒绝采样，RNG 消耗次数不定**：每转一圈掷一次，抽到与已选重复的就丢掉重来。
 * 三张互不相同这件事是循环保证的，不是一次抽三张。
 * ⚠ 参考用 `CardType` 当哑参数：`INVALID` = 不分牌型（走 70 张的 CombatCardPool）、
 * `STATUS` = 无色（走 34 张的 CombatColorlessCardPool，注释自注 "status card type is
 * being used to indicate colorless"），其余就是按牌型。发现这张牌传的是 **INVALID**。
 */
function generateDiscoveryCards(bc: BattleContext, type: DiscoveryPoolKind): string[] {
  const cards: string[] = [];
  while (cards.length < 3) {
    const id =
      type === "any"
        ? getTrulyRandomCardInCombatAnyType(bc)
        : type === "colorless"
          ? getTrulyRandomColorlessCardInCombat(bc)
          : getTrulyRandomCardInCombat(bc, type);
    if (!cards.includes(id)) {
      cards.push(id);
    }
  }
  return cards;
}

/**
 * 发现屏的取样池（对齐参考拿 `CardType` 当哑参数的那套：INVALID → any、STATUS → colorless）。
 * 现在只有「发现」这张牌用 `any`；攻击 / 技能 / 能力三支等药水（力量药水那三个「发现」类）
 * 登记时才会用到。
 */
type DiscoveryPoolKind = "any" | "colorless" | "attack" | "skill" | "power";

/**
 * 这张牌能不能升级（对齐 CardInstance::canUpgrade，CardInstance.cpp:55）。
 *
 * ⚠ 照抄两处反直觉：① **不**检查这张牌是否真有升级形态，只看「还没升级」；
 * ② 灼热之刃可以反复升级（它的升级次数记在 specialData 上，见 upgradeCard）。
 */
function canUpgradeCard(card: CombatCard): boolean {
  if (card.upgraded && card.defId !== "searing_blow") {
    return false;
  }
  const type = getCardDef(card.defId).type;
  return type !== "curse" && type !== "status";
}

/**
 * 这张牌被升级过几次（对齐 CardInstance::getUpgradeCount，CardInstance.cpp:47）。
 * 只有灼热之刃会大于 1——它的伤害公式直接读这个数。
 */
function getUpgradeCount(card: CombatCard): number {
  return card.defId === "searing_blow" ? card.specialData : card.upgraded ? 1 : 0;
}

/**
 * 改基础费用并保住本回合的降费差（对齐 CardInstance::upgradeBaseCost，CardInstance.cpp:99）。
 * 只有血债血偿的升级分支调它。
 */
function upgradeBaseCost(card: CombatCard, newBaseCost: number): void {
  const diff = card.costForTurn - card.cost;
  card.cost = newBaseCost;
  if (card.costForTurn > 0) {
    card.costForTurn = Math.max(0, card.cost + diff);
  }
}

/**
 * 升级一张战斗内的牌实例（对齐 CardInstance::upgrade，CardInstance.cpp:132）。
 *
 * ⚠ 尾部那段是关键：升级前后 `getEnergyCost` 不同的牌（严阵以待 2→1、见红 1→0、
 * 心灵冲击 2→1…）会把 **cost 与 costForTurn 一起**改成升级后的费用。此前费用是从
 * `costOf(def, upgraded)` 现算的，加了实例级费用之后必须在这里同步，否则军备升级了一张
 * 严阵以待，它的费用还停在 2。
 *
 * ⚠ 血债血偿那一支照抄，包括它**没有效果**这件事：`upgradeBaseCost(cost-1)` 之后紧接着
 * 的尾部又把 `cost = costForTurn = getEnergyCost(BFB, true) = 3` 无条件盖掉了
 * （未升级是 4，两者不等 → 一定进那个 if）。所以「升级时按当前费用再减 1」在参考里等于
 * 没写，升完一律是 3 费。参考自己在那行标了 `// TODO(dmz) is this logic right?`。
 * 预言机是参考，故照它写；真实游戏的行为存疑，记在报告里。
 */
function upgradeCard(card: CombatCard): void {
  if (card.defId === "searing_blow") {
    // 灼热之刃：升级次数累加，且 `upgraded` 位照样置真（下面的尾部负责）。
    card.specialData += 1;
  } else if (card.defId === "blood_for_blood" && !card.upgraded && card.cost < 4 && card.cost > 0) {
    upgradeBaseCost(card, card.cost - 1);
  }
  // 致盲 / 绊摔在参考里也有 case，但里面只有一句 `// todo change card target here`，
  // 我们的指向性走 targetedOf(def, upgraded) 现算，无需实例级同步。
  if (!card.upgraded) {
    card.upgraded = true;
    const newCost = initialCardCost(card.defId, true);
    if (initialCardCost(card.defId, false) !== newCost) {
      card.cost = newCost;
      card.costForTurn = newCost;
    }
  }
}

/**
 * 消耗手牌中指定的一张（对齐 BattleContext::exhaustSpecificCardInHand）。
 *
 * ⚠ 参考的兜底查找有笔误：`for (i...) if (cards.hand[idx].uniqueId == uniqueId)` 比较的是
 * `hand[idx]` 而非 `hand[i]`，条件在循环里恒定——快路径已经覆盖了它为真的情形，所以
 * 兜底实际恒查不到、直接「card not found」返回。即：下标对不上就什么都不消耗。
 * 照抄这个行为（调用方都是当场算好下标立刻消耗，走不到兜底）。
 */
function exhaustSpecificCardInHand(bc: BattleContext, idx: number, uid: number): void {
  const card = bc.hand[idx];
  if (card === undefined || card.uid !== uid) {
    return;
  }
  bc.hand.splice(idx, 1);
  triggerAndMoveToExhaustPile(bc, card);
}

/** 随机消耗手牌若干张（对齐 Actions::ExhaustRandomCardInHand）。手牌空即提前返回。 */
function exhaustRandomCardInHand(bc: BattleContext, count: number): void {
  for (let i = 0; i < count; i += 1) {
    if (bc.hand.length <= 0) {
      return;
    }
    const idx = bc.rng.cardRandomRng.random(bc.hand.length - 1); // ★ 消耗一次 cardRandomRng
    const [card] = bc.hand.splice(idx, 1);
    triggerAndMoveToExhaustPile(bc, card);
  }
}

// ============================================================================
// init（对齐 BattleContext::init 顶层顺序）
//   monsters.init(HP→rollMove) → cards.init(建库+洗牌) → initRelics → 抽起手
// ============================================================================

/**
 * 入场牌组的一张牌（master deck 的投影）。
 *
 * `innate` 是**实例级**的固有位，对齐参考 `CardManager::init` 里那句
 * `isInnateMemo[i] = deckCard.isInnate() || isBottled`——瓶装遗物封入的那一张是靠
 * `gc.deck.bottleIdxs` 判定的，与卡定义无关，所以必须逐实例带过来。
 */
export type CombatDeckCard = { defId: string; upgraded: boolean; innate?: boolean };

/**
 * 这张牌开局是否固有（对齐 `Card::isInnate()` → `isCardInnate(id, upgraded)`，
 * 再或上瓶装遗物的实例位）。
 *
 * 参考的 `isCardInnate` 是「完整名单 + `default: false`」，可全表信任；名单里
 * 背刺 / 启动程序 / 华丽登场 / 心灵冲击 / 扭曲恒为真，暴虐 / 无限之刃 / 残影 / 寒冷 /
 * 你好世界 / 风暴 / 机器学习 / 战斗圣歌 / 阿尔法 / 建立是 `upgraded`——两组与数据表的
 * `innate` / `upgradedInnate` 逐项对齐过。
 */
function isDeckCardInnate(card: CombatDeckCard): boolean {
  if (card.innate === true) {
    return true;
  }
  const def = getCardDef(card.defId);
  return def.innate === true || (card.upgraded && def.upgradedInnate === true);
}

export type CombatInitInput = {
  seedLong: bigint;
  floorNum: number;
  ascension: number;
  encounterId: string;
  /** 大牌组（master deck），按获得顺序——顺序即洗牌输入，不可排序。 */
  deck: CombatDeckCard[];
  /** 玩家当前生命/上限。 */
  playerHp: number;
  playerMaxHp: number;
  /**
   * 入场时的金币（对齐 `player.gold = gc.gold`）；缺省 0。
   *
   * 战斗内只有贪婪之手会改它，改完由 `combat-bridge.settleCombat` 写回 `GameState.gold`。
   * trace 重放**故意不传**（即从 0 起算），这样 `player.gold` 直接就是「本场赚了多少」，
   * 与 harness 输出的 `goldGained` 同形——参考那边入场值是 GameContext 的 99，
   * 而这五个编队里没有任何东西**读**金币，所以差个常数不影响任何行为。
   */
  gold?: number;
  /** 角色（决定药水池前 3 项）；缺省铁甲。 */
  character?: CharacterId;
  /**
   * 入场时持有的遗物（按获得顺序）。
   *
   * ⚠ 第四十四批起每一件都带 `data`（对齐 `RelicInstance::data`）：run 层存在
   * `RelicState.counter` 里，`combat-bridge` 负责搬进来、战斗结束再写回去。
   * 只写 id 的老调用方可以传字符串，等价于 `{ id, data: 0 }`——
   * ⚠ **御守 / 蜥蜴尾例外**：它们的 `data` 是「有没有」，0 等于战斗内不存在这颗遗物。
   */
  relics?: readonly (string | CombatRelic)[];
  /** 入场时的药水槽（null = 空）；缺省三个空槽。 */
  potions?: (string | null)[];
  /** 药水槽容量（点金石 +2 等）；缺省 3。 */
  potionCapacity?: number;
  /**
   * 可选：覆盖 miscRng（本层战斗前已消耗过它时传入，例如先进了事件房）。
   * 不传即按 Random(seed+floorNum) 新建，与四条战斗流同源——这是常规战斗的正确语义。
   */
  miscRng?: StsRandom;
  /** 可选：run 级持久 potionRng（战斗内药水生成用，目前尚无消耗点）。 */
  potionRng?: StsRandom;
  /**
   * 这场仗所在的房间类型（对齐 `BattleContext::init` 开头那句 `auto room = gc.curRoom;`，
   * BattleContext.cpp:88），第五十批加。缺省 `"invalid"` = 与这个字段存在之前逐字节等价。
   *
   * ⚠ **它只在 `initRelics` 里被读**（五颗遗物的门），战斗开始之后没有任何读点，
   *   所以**不进 `BattleContext`、不进快照、不进 `exportState`**——传进来、用一次、丢掉。
   *   这是它比爬升度便宜得多的原因：那条轴要进状态、要 migrate，这条不用。
   */
  room?: RoomKind;
  /**
   * **上一个**房间的类型（对齐 `gc.lastRoom`），古董茶具唯一的门。
   * ⚠ 参考读的是 `gc.lastRoom` 而不是那个局部变量 `room`——**两个不同的字段**，别合并。
   */
  lastRoom?: RoomKind;
};

/**
 * 房间类型（对齐参考的 `Room` 枚举里战斗内**真正被读到**的那几项）。
 *
 * ⚠ 只列参考在 `src/combat` 里读的四种 + 哨兵：`initRelics` 的五颗遗物读 `BOSS` / `ELITE`
 * / `REST`，其余房型在战斗内没有任何读点。哨兵 `invalid` 对齐 `Room::INVALID`，也是
 * harness 在第五十批之前**恒**处于的那个值——所以缺省值必须是它。
 */
export type RoomKind = "invalid" | "monster" | "elite" | "boss" | "rest";

export function initCombat(input: CombatInitInput): BattleContext {
  const rng = seedCombatRng(input.seedLong, input.floorNum, input.miscRng, input.potionRng);
  const encounter = getEncounterDef(input.encounterId);

  const bc: BattleContext = {
    rng,
    seedLong: input.seedLong,
    floorNum: input.floorNum,
    ascension: input.ascension,
    encounterId: input.encounterId,
    character: input.character ?? "ironclad",
    relics: (input.relics ?? []).map((r) =>
      typeof r === "string" ? { id: r, data: 0 } : { ...r },
    ),
    potions: [...(input.potions ?? [null, null, null])],
    potionCount: (input.potions ?? []).filter((p) => p !== null).length,
    potionCapacity: input.potionCapacity ?? 3,
    outcome: "undecided",
    inputState: "executing",
    cardSelect: null,
    // 对齐 BattleContext::turn——初值 0，afterMonsterTurns 里才 ++。玩家的第一个回合
    // turn 为 0；getMonsterTurnNumber() 那类「第几回合」语义要另行 +1，别混用。
    turn: 0,
    actionQueue: new ActionQueue(),
    cardQueue: new CardQueue(),
    player: {
      hp: input.playerHp,
      maxHp: input.playerMaxHp,
      block: 0,
      energy: 0,
      energyPerTurn: 3,
      cardDrawPerTurn: 5,
      powers: [],
      // `initRelics` 的第一句才从容器拷位（对齐 `player.relicBits0 = gc.relics.relicBits0`），
      // 这里先留空。⚠ 别在这里预填：`BattleContext::init` 里在 initRelics **之前**读遗物的
      // 那两处（史尼克之眼 / 蛇之指环的 `cardDrawPerTurn`）读的是 **`gc.relics`**，
      // 也就是容器，不是玩家那份位集合。
      relicBits: [],
      cardsPlayedThisTurn: 0,
      attacksPlayedThisTurn: 0,
      skillsPlayedThisTurn: 0,
      // 对齐 `Player::inkBottleCounter` 的初值 0（Player.h:67）。`initRelics` 那一格
      // （`= r.data`）见 `RELIC_IMMEDIATE.ink_bottle`。
      inkBottleCounter: 0,
      // 下面五个同样对齐 Player.h 的默认 0；`initRelics` 里各自 `= r.data` 覆盖。
      happyFlowerCounter: 0,
      incenseBurnerCounter: 0,
      nunchakuCounter: 0,
      penNibCounter: 0,
      sundialCounter: 0,
      haveUsedNecronomiconThisTurn: false,
      // 对齐 `std::bitset<3> orangePelletsCardTypesPlayed` 的默认全 0（Player.h:82）。
      orangePelletsCardTypesPlayed: 0,
      combustHpLoss: 0,
      bomb1: 0,
      bomb2: 0,
      bomb3: 0,
      // 对齐 `BattleContext::init` 的 `player.gold = gc.gold`（BattleContext.cpp:55）。
      gold: input.gold ?? 0,
      // 对齐 `Player::lastAttackUnblockedDamage` 的初值 0（Player.h:86）。
      lastAttackUnblockedDamage: 0,
      // ⚠ 对齐 `Player::lastTargetedMonster` 的初值 **1**（Player.h:47），不是 0。
      //   它在被围攻那条门里是可观察的：玩家还没打过任何指定目标的牌时，0 号位的怪
      //   看到的 `facingSelf` 是假（`1 != 0` 且 1 号位还活着）⇒ 它开场那一击 ×1.5。
      lastTargetedMonster: 1,
    },
    monsters: [],
    monstersAlive: 0,
    hand: [],
    drawPile: [],
    discardPile: [],
    exhaustPile: [],
    // 对齐 `CardManager::init` 顶部的 `strikeCount = 0`——下面建大牌组实例时逐张加回来。
    strikeCount: 0,
    // 对齐 `CardManager::stasisCards` 的初值 `{INVALID, INVALID}`（CardManager.h:32）。
    stasisCards: [null, null],
    monsterTurnIdx: 6, // 对齐游戏初值（>= monsterCount 即「非怪物回合」）
    skipTurn: new Set<number>(), // 对齐 `MonsterGroup::skipTurn` 的空 bitset
    endTurnQueued: false,
    turnHasEnded: false,
    nextUid: 0,
  };

  // —— monsters.init（对齐 MonsterGroup::init 的三段）——
  // ① createMonsters：变体编队在此逐怪消耗 miscRng 选型，且与 monsterHpRng **交错**
  //    （选一只 → 立刻建它 → roll 它的 HP），不是先选完再统一 roll。
  const builder = ENCOUNTER_BUILDERS[input.encounterId];
  if (builder !== undefined) {
    builder(bc);
  } else {
    for (const defId of encounter.enemies) {
      createMonster(bc, defId);
    }
  }
  // `monstersAlive` = **真正建出来的怪数**，不是 `monsterCount`（= 数组长度）。
  // 两者在绝大多数编队里相等，但地精首领那条 case 手动写的是 `monstersAlive = 3;
  // monsterCount = 4;`（MonsterGroup.cpp:256-257）——0 号位是预留的空位，
  // 它进 dump（`monsterCount` 数到它）却不算「活着的怪」。
  // ⚠ 写成 `bc.monsters.length` 会让 `monstersAlive` 多 1：那之后每一处
  //   `monstersAlive > 1` / `getRandomMonsterIdx` / 判胜都会偏。
  bc.monstersAlive = bc.monsters.filter((m) => m.defId !== EMPTY_MONSTER_SLOT).length;
  // ①b 编队开局特例（军团 buff / 预置哨兵等），仍属 createMonsters 阶段。
  ENCOUNTER_SETUP[input.encounterId]?.(bc);
  // ② rollMove：逐怪滚初始意图（aiRng）。
  // ⚠ 空位**跳过**：参考这两个循环的门是 `if (arr[i].idx != -1)`（MonsterGroup.cpp:78 / :84），
  //   而从没被构造过的那一格 `idx` 是 -1。地精首领的 0 号位走的就是这一支。
  for (const m of bc.monsters) {
    if (m.defId === EMPTY_MONSTER_SLOT) {
      continue;
    }
    rollMove(bc, m);
  }
  // ③ preBattleAction：开局 buff，其中蜷缩等会再消耗 monsterHpRng——注意它排在
  //    所有 HP roll 与所有 rollMove **之后**。
  for (const m of bc.monsters) {
    if (m.defId === EMPTY_MONSTER_SLOT) {
      continue;
    }
    PRE_BATTLE_ACTION[m.defId]?.(bc, m);
  }

  // —— 每回合抽牌数（对齐 BattleContext.cpp:61-67）——
  //
  // ⚠⚠ **位置在 `monsters.init` 之后、`cards.init` 之前**，不能挪：`cards.init` 末尾那句
  //   「固有牌比起手数还多就补抽差额」读的正是 `cardDrawPerTurn`。
  // ⚠⚠ **这两处读的是 `gc`（遗物**容器**）而不是 `player.relicBits`**——`initRelics` 还没跑，
  //   那份位集合此刻还是空的。参考一处写 `gc.hasRelic(...)`、一处写 `gc.relics.has(...)`，
  //   两个访问器同解（`RelicContainer::has`），照抄各自的写法没有意义，语义都是「容器里有没有」。
  const hasInContainer = (id: string): boolean => bc.relics.some((r) => r.id === id);
  // 史尼克之眼（SNECKO_EYE，第四十四批）：+2 抽牌。它的第二个读点是 `initRelics` 里的
  // `p.debuff<PS::CONFUSED>(1)`，见 `RELIC_IMMEDIATE.snecko_eye`。
  if (hasInContainer("snecko_eye")) {
    bc.player.cardDrawPerTurn += 2;
  }
  // 蛇之指环（RING_OF_THE_SERPENT，第四十四批）：+1 抽牌。⚠ 它在 `initRelics` 里**也有**
  // 一格（BattleContext.cpp:325-329），但那一格的函数体被注释掉了、只剩一句
  // `// now handled in battlecontext init`——真正生效的是这里。别两处都加。
  if (hasInContainer("ring_of_the_serpent")) {
    bc.player.cardDrawPerTurn += 1;
  }

  // —— cards.init（对齐 CardManager::init，CardManager.cpp:15）——
  //
  // ① 建实例：uid 就是它在 master deck 里的下标（对齐 `c.setUniqueId(deckIdx)` 与
  //    `nextUniqueCardId = gc.deck.size()`，故建完 nextUid 正好等于牌组张数）。
  // ② 一次 shuffleRng 洗牌。参考洗的是下标数组 `idxs` 再按 idxs[i] 取牌，与直接洗牌实例
  //    等价（Collections::shuffle 的交换序列只由 RNG 决定，作用在哪个数组上都是同一置换）。
  // ③ **固有归位**：把固有牌搬到抽牌堆**顶**。参考的写法是一次稳定分区——
  //    `normalIdx` 从 0 起、`innateIdx` 从 normalCount 起，按洗牌后的顺序依次落位，
  //    所以两组各自的相对顺序都保留。数组尾即牌堆顶（popFromDrawPile 取 back），
  //    于是固有牌排在最后就是「开局第一批被抽到」。
  const innateUids = new Set<number>();
  const instances: CombatCard[] = input.deck.map((card) => {
    // uid 就是 master deck 的下标（makeCardInstance 取 nextUid++，此刻它正好从 0 开始）。
    const instance = makeCardInstance(bc, card.defId, card.upgraded);
    if (isDeckCardInnate(card)) {
      innateUids.add(instance.uid);
    }
    return instance;
  });
  shuffleCards(bc, instances); // ★ 消耗一次 shuffleRng
  const isInnate = (c: CombatCard): boolean => innateUids.has(c.uid);
  const innateCount = innateUids.size;
  bc.drawPile = [...instances.filter((c) => !isInnate(c)), ...instances.filter(isInnate)];
  // ④ 固有牌比起手数还多时补抽差额（对齐 CardManager::init 末尾）。⚠ 这条 addToBot 排在
  //    下面那条「抽起手」**之前**，因为参考的 cards.init 早于 initRelics 里的 DrawCards。
  if (innateCount > bc.player.cardDrawPerTurn) {
    const extra = innateCount - bc.player.cardDrawPerTurn;
    addToBot(bc, (c) => drawCards(c, extra));
  }

  // —— initRelics ——（骨架层跳过：铁甲燃烧之血等开局遗物不消耗 RNG，效果留后续 PR）

  // —— initRelics + 抽起手 ——（顺序对齐 BattleContext::init）
  // ⚠ 房间类型只在这一遍里被读（五颗遗物的门），读完就丢——不进 BattleContext、不进快照。
  initRelics(bc, { room: input.room ?? "invalid", lastRoom: input.lastRoom ?? "invalid" }); // 第一遍：立即属性
  addToBot(bc, (c) => drawCards(c, c.player.cardDrawPerTurn));
  // 第二遍：排在抽牌之后。⚠ 传的是**入场血量**（`gc.curHp`）而不是 `bc.player.hp`：
  // 红骷髅那道门读的是 GameContext 的值，而血瓶的 `heal(2)` 已经在第一遍里改过 `player.hp`。
  initRelicsAtBattleStart(bc, input.playerHp);
  bc.player.energy += bc.player.energyPerTurn;
  executeActions(bc);

  return bc;
}

// ============================================================================
// executeActions 主循环（对齐 BattleContext::executeActions 的优先级状态机子集）
// ============================================================================

const LOOP_GUARD = 100000;

export function executeActions(bc: BattleContext): void {
  let guard = 0;
  for (;;) {
    if (++guard > LOOP_GUARD) {
      throw new Error("executeActions 循环熔断（可能死循环）");
    }
    // ⓪ 不再是「执行中」就立刻退出——**这一条必须排在最前**（对齐 BattleContext.cpp:740
    // 的 `if (inputState != InputState::EXECUTING_ACTIONS) break;`）。选牌屏就是靠它生效：
    // 开屏的动作把 inputState 改成 card_select，下一轮循环顶部退出，**队列里剩下的动作
    // 原样留着**，等玩家选完牌由 selectCard 重新进来接着抽。
    // 少了这一条，焚誓会在玩家还没选要消耗哪张牌之前就先把牌抽了。
    if (bc.inputState !== "executing") {
      break;
    }
    // ① 玩家阵亡立刻跳出——**排在抽干队列之前**（对齐参考主循环把 PLAYER_LOSS
    // 判断放在 actionQueue.pop 之前）。放到后面的话，怪物这一击打死玩家后，
    // 它排在后面的加格挡 / RollMove 还会继续执行。
    // 注意胜利不在此列：胜利要继续抽干队列，只是 clearPostCombatActions 已经
    // 把该清的清掉了。
    if (bc.outcome === "player_loss") {
      break;
    }
    // ② 动作队列优先抽干。
    if (!bc.actionQueue.isEmpty()) {
      const a = bc.actionQueue.popFront();
      a.fn(bc);
      continue;
    }
    // ② 结局已定 → 收尾退出。
    if (bc.outcome !== "undecided") {
      break;
    }
    // ③ 出牌队列。
    if (!bc.cardQueue.isEmpty()) {
      playCardQueueItem(bc, bc.cardQueue.popFront());
      continue;
    }
    // ③b 「打不赢了」检查（对齐 BattleContext.cpp:767）：三个牌堆全空且没有不靠牌的伤害
    // 来源，直接判负。位置必须在出牌队列**之后**、怪物回合**之前**。
    // 净化 / 恶魔之火 / 断魂斩那类清手牌的牌能把牌全消耗掉，命中这条就该输而不是空转。
    // ⚠ 炸弹的三格计时器算「不靠牌的伤害来源」（对齐 BattleContext.cpp:786-788 那三行
    // `player.bomb1 || player.bomb2 || player.bomb3`）：手牌打空但还有炸弹在倒计时时
    // 不能判负，得等它炸完。
    // ⚠⚠ **复形怪是这道门上一条怪种专属的例外**（第三十四批，BattleContext.cpp:790）：
    //   `if (!hasDamageWithoutCards && monsters.arr[0].id != MonsterId::TRANSIENT)`
    //   ——它读的是 **0 号位那一只**（不是「场上有没有」），理由是复形怪的消逝层数一到
    //   就自己退场，所以「打不出牌」并不等于「赢不了」，干等就行。
    //   ⚠ 它与 `hasDamageWithoutCards` 是**并列的两个条件**，不是把复形怪塞进那个 bool 里
    //   ——形状照抄（谓词的语义不同：一个是「玩家有没有伤害来源」，一个是「怪会不会自己走」）。
    // TODO(后续PR): 欧米茄（`player.hasStatus<PS::OMEGA>()`）也算「不靠牌」。
    if (bc.hand.length + bc.discardPile.length + bc.drawPile.length === 0) {
      const hasDamageWithoutCards =
        getPower(bc.player.powers, "thorns") > 0 ||
        bc.player.bomb1 !== 0 ||
        bc.player.bomb2 !== 0 ||
        bc.player.bomb3 !== 0;
      if (!hasDamageWithoutCards && bc.monsters[0]?.defId !== "transient") {
        bc.outcome = "player_loss";
        break;
      }
    }
    // ④ 怪物回合。
    if (bc.monsterTurnIdx < bc.monsters.length) {
      doMonsterTurn(bc, bc.monsterTurnIdx);
      bc.monsterTurnIdx += 1;
      continue;
    }
    // ④b 怪物回合全部走完 → 清空「本轮跳过谁」（对齐 BattleContext.cpp:805 那句
    //     `monsters.skipTurn.reset();`，第三十六批）。⚠ 位置照抄：它排在④那个 `continue`
    //     之后、⑤之前，所以每一轮「游标已经越过最后一格」的主循环迭代都会清一次
    //     ——包括玩家回合里的那些空转。幂等，且这正是它在存档点恒为空的原因。
    bc.skipTurn.clear();
    // ⑤ 怪物回合走完 → 回合结算。
    if (bc.turnHasEnded) {
      afterMonsterTurns(bc);
      continue;
    }
    // ⑥ 玩家点了结束回合 → 进入结束序列。
    if (bc.endTurnQueued) {
      onTurnEnding(bc);
      continue;
    }
    // ⑥b 不休陀螺（UNCEASING_TOP，第四十三批）：对齐 BattleContext.cpp:825-836，
    //     位置就在⑥那个 `continue` 与⑦之间：
    //         if (player.hasRelic<R::UNCEASING_TOP>()) {
    //             // turn cannot have ended here
    //             if (cards.cardsInHand == 0) {
    //                 drawCards(1);
    //             }
    //         }
    // ⚠ 四处照抄：
    //  ①⚠⚠ **位置就是它的全部语义**：这里是「队列排空、回合没结束、马上要把控制权交回玩家」
    //     的那一格。放到别处（比如打完每张牌之后）会在动作还没抽干时就补牌。
    //  ②⚠ 抽牌是**同步**的 `drawCards(1)`，不是 `addToBot(Actions::DrawCards(1))`
    //     ——参考在这里直接调 `BattleContext::drawCards`，紧接着就 `break`（**不再回到
    //     循环顶部**）。所以这次抽牌顺带入队的效果（进化 / 烈焰吐息）会留在队列里，
    //     等玩家的下一个动作触发 `executeActions` 时才结算。
    //  ③ 门是 `cardsInHand == 0`，与「这一回合抽过几张」无关：一回合内可以触发很多次。
    //  ④ 参考在这里有三条 `assert`（回合没结束、两个队列都空），是这一格位置的自证；
    //     我们的主循环走到这里时同样满足，不复制断言。
    if (hasRelic(bc, "unceasing_top") && bc.hand.length === 0) {
      drawCards(bc, 1);
    }
    // ⑦ 无事可做 → 把控制权还给玩家。
    bc.inputState = "player_normal";
    break;
  }
}

function playCardQueueItem(bc: BattleContext, item: CardQueueItem): void {
  if (item.isEndTurn) {
    callEndOfTurnActions(bc);
    return;
  }
  if (item.randomTarget) {
    // ★ 随机目标走 cardRandomRng（对齐 BattleContext.cpp:860 getRandomMonsterIdx）
    item.target = getRandomMonsterIdx(bc);
  }
  const card = item.card;
  if (card === null) {
    throw new Error("playCardQueueItem: 非 endTurn 项却没有牌");
  }
  // 对齐 playCardQueueItem 的两道分支（BattleContext.cpp:864/882）：
  //   canUseCard = purgeOnUse || (triggerOnUse && canUse(…) && 目标可选) → useCard()
  //   if (!triggerOnUse)                                                → useNoTriggerCard()
  //
  // ⚠ `canUse` 这道门第九批才真正长出牙来：浩劫 / 混乱是把**抽牌堆顶那张**当作被打出，
  // 而那张牌可能是眩晕/伤口（状态牌，没有医疗包就打不出）或诅咒牌。命中时这张牌
  // **既不结算也不进任何牌堆**——它在 playTopCardInDrawPile 里就已经被 pop 出抽牌堆、
  // 只活在队列项里，于是凭空消失。参考如此（真实游戏同样如此）。
  //
  // ⚠ 复制项（purgeOnUse）**不过** canUse——但它照样过下面那道**单独的**目标门。
  // 参考把「目标还在不在」写了**两遍**：一次在 canUseCard 的合取里（与 canUse 顶部那条重复），
  // 一次是 `if (canUseCard)` 里紧挨 useCard() 的最后一道。对普通出牌两者冗余，
  // 但对 purgeOnUse **只剩后一道生效**，于是二连击的表现是：第一击打死了这只怪、
  // 而场上还有别的怪时，复制的那一击**不会**打出去（目标已死）。TWO_LOUSE 上很常见。
  // 参考在那行自注 `// this is redundant right???? -> no i think echo form abilities can
  // queue a card with invalid target`。
  // TODO(后续PR): `if (c.isFreeToPlay(bc)) c.freeToPlayOnce = true;`。
  const canUseCard =
    item.purgeOnUse ||
    (item.triggerOnUse && cardCanUse(bc, card, item.target, item.autoplay) === null);
  const targetsEnemy = targetedOf(getCardDef(card.defId), card.upgraded);
  const targetStillValid = !targetsEnemy || bc.monsters[item.target]?.alive === true;
  // `player.lastTargetedMonster = item.target`（BattleContext.cpp:872-874，第四十七批）。
  // ⚠ 三处照抄：
  //  ① 它在 **`canUseCard` 里面**——被 `canUse` 挡下的牌（浩劫翻出的诅咒 / 状态牌）不写；
  //  ② 门是 `c.requiresTarget()`（= `cardTargetsEnemy`，与我们的 `targetedOf` 同源），
  //     所以技能 / 能力 / 群伤牌一律不写，它可以整场停在初值 1 不动；
  //  ③⚠ 它排在紧接着那道**目标有效性**判断**之前**：目标已经死了、这张牌根本没打出去，
  //     这个字段照样已经被改写。（二连击的复制项就会走到这一格。）
  // ⚠ 在被围攻（第四十七批的尖塔护盾）之前它是纯粹的死字段，所以此前这里只有一条 TODO。
  if (canUseCard && targetsEnemy) {
    bc.player.lastTargetedMonster = item.target;
  }
  if (canUseCard && targetStillValid) {
    useCard(bc, item);
  }
  if (!item.triggerOnUse) {
    useNoTriggerCard(bc, item);
  }
}

/**
 * 这张牌现在能不能打（对齐 `CardInstance::canUse`，CardInstance.cpp:278）。
 * 返回 `null` 表示可以，否则是给人看的原因。
 *
 * 两个调用点：`playCard`（玩家点牌，对齐 `isValidCardAction` 尾部那句 `canUse(bc, t, false)`）
 * 与 `playCardQueueItem`（自动打出的牌，`inAutoplay` 为真）。两处必须是**同一个谓词**——
 * 早先 playCard 把这几道门内联着写，第九批浩劫/混乱要在队列里再判一次，写两份就会分岔。
 *
 * ⚠ `inAutoplay` 只影响**能量**那一道：自动打出的牌不看能量够不够（浩劫打出的 3 费牌
 * 在 0 能量下照样打）。牌型那几道（诅咒/状态/缠绕/冲突/秘密技巧武器）对它一视同仁。
 *
 * TODO(后续PR): canUse 剩下的分支——缠绕封攻击（ENTANGLED）、
 *   大结局 / 招牌动作 / 反射 / 天降神兵 / 战术家。都还没有对应内容登记。
 */
/**
 * 冲撞能不能打（对齐 `canUseClash`，CardInstance.cpp:260）：**手牌里**每一张都得是攻击牌。
 *
 * ⚠ 两处照抄：
 *  ① 扫的是整只手牌、**不排除冲撞自己**。玩家点牌时冲撞还在手里，而它自己是攻击牌，
 *     所以自己那一格恒通过；浩劫/混乱翻出来的那张已经离开抽牌堆、不在手牌里，也不参与。
 *     （数据表卡面写的是「其余全为攻击牌」，与参考的实现在结果上等价。）
 *  ② 空手牌 → 恒真（循环不进）。这不是空谈：浩劫可以在手牌打空之后才结算。
 */
function canUseClash(bc: BattleContext): boolean {
  return bc.hand.every((c) => getCardDef(c.defId).type === "attack");
}

function cardCanUse(
  bc: BattleContext,
  card: CombatCard,
  target: number,
  inAutoplay: boolean,
): string | null {
  const def = getCardDef(card.defId);
  // 天鹅绒颈圈（VELVET_CHOKER，第四十四批）：对齐 `BattleContext::isCardPlayAllowed`
  // （BattleContext.cpp:725-727）：
  //     if (player.hasRelic<R::VELVET_CHOKER>() && player.cardsPlayedThisTurn >= 6) return false;
  // ⚠ 四处照抄：
  //  ①⚠⚠ **参考把它放在 `isCardPlayAllowed()` 里，而那个函数 `BattleContext` 自己一次都不调**
  //     ——三个调用点全在 `src/sim/`（`Action::isValidCardAction` 等），也就是**出牌的合法性
  //     检查**这一层。我们的 `canPlayCard` 就是那一层，所以放在这里与参考同解。
  //  ② 门是 `>= 6`，而 `cardsPlayedThisTurn` 在出牌时自增 ⇒ **第 7 张打不出来**。
  //  ③ 它与那个函数里的第二条（困惑度 / `handNormalityCount`）是并列的 `if`；
  //     后者的产出者（正常性 Power）全参考没有，故未登记。
  //  ④ 它的另一半是 `initRelics` 里的 `energyPerTurn++`。
  if (hasRelic(bc, "velvet_choker") && bc.player.cardsPlayedThisTurn >= 6) {
    return `「${def.name}」打不出来：天鹅绒颈圈限制每回合 6 张`;
  }
  // 顶部那道目标门：需要目标而目标已死（或全场怪已死）就打不出。
  if (targetedOf(def, card.upgraded)) {
    const t = bc.monsters[target];
    if (t === undefined || !t.alive) {
      return `目标无效: ${target}`;
    }
  }
  // 缠绕（ENTANGLED）：有这个状态时**一张攻击牌都打不出**（对齐 CardInstance.cpp:292，
  // 排在同一个 ATTACK 分支里、冲撞那道门**之前**）。
  // ⚠ 与冲撞同理，对 `inAutoplay` **一视同仁**：浩劫 / 混乱翻出攻击牌照样被它拦住。
  // ⚠ 它是「有没有」而不是「几层」——参考用的是 `hasStatus`。清除见 applyEndOfTurnPowers。
  if (def.type === "attack" && getPower(bc.player.powers, "entangled") > 0) {
    return `「${def.name}」被缠绕封住了（本回合无法打出攻击牌）`;
  }
  // 冲撞：只有**手牌全是攻击牌**时才打得出（对齐 canUse 的 ATTACK 分支，
  // CardInstance.cpp:295 → canUseClash）。⚠ 这一道对 `inAutoplay` **一视同仁**：
  // 浩劫 / 混乱从抽牌堆顶翻出一张冲撞时照样要过它，不过就凭空消失（那张牌已被拿走）。
  if (def.type === "attack" && card.defId === "clash" && !canUseClash(bc)) {
    return `「${def.name}」需要手牌全是攻击牌`;
  }
  // 打不出来的牌（对齐 canUse 的按类型分支）：诅咒牌要蓝烛、状态牌要医疗包
  //（黏液除外，它本来就能打）。第五批开始有灼伤 / 伤口 / 眩晕真的躺在手里，少了这道门
  // 它们会一路走到 CARD_RULES 查不到而抛「暂未登记」——而它们其实是登记了的、只是打不出来。
  if (def.type === "curse" && !hasRelic(bc, "blue_candle")) {
    return `「${def.name}」是诅咒牌，打不出来`;
  }
  if (def.type === "status" && card.defId !== "slimed" && !hasRelic(bc, "medical_kit")) {
    return `「${def.name}」是状态牌，打不出来`;
  }
  // 秘密技巧 / 秘密武器：抽牌堆里得真有对应牌型（对齐 CardInstance.cpp:301-319）。
  if (card.defId === "secret_technique" || card.defId === "secret_weapon") {
    const want = card.defId === "secret_technique" ? "skill" : "attack";
    if (!bc.drawPile.some((c) => getCardDef(c.defId).type === want)) {
      return `「${def.name}」需要抽牌堆里有${want === "skill" ? "技能" : "攻击"}牌`;
    }
  }
  // 费用读**实例级**的 costForTurn（对齐 `bc.player.energy < costForTurn`，
  // CardInstance.cpp:341）。它在建实例时由 `getEnergyCost(id, upgraded)` 播种（升级降费
  // 因此照样生效），之后可被腐化 / 疯狂 / 血债血偿 / 战斗内升级改写——从数据表现算就
  // 看不到这些。
  // TODO(后续PR): `isFreeToPlay`（freeToPlayOnce / 自由攻击）也能豁免这道门，两者都未登记。
  if (bc.player.energy < card.costForTurn && !inAutoplay) {
    return `能量不足：需要 ${card.costForTurn}，剩余 ${bc.player.energy}`;
  }
  return null;
}

/**
 * 打出抽牌堆顶的那张牌（对齐 `BattleContext::playTopCardInDrawPile`，BattleContext.cpp:2531）。
 * 浩劫（消耗它）与混乱（不消耗）共用，`Actions::PlayTopCard` 就是它的一层包装。
 *
 * ⚠ 四处照抄：
 *  ① 抽牌堆空时**先看弃牌堆**：弃牌堆也空就什么都不做（连动作都不排）；否则
 *     `addToTop(PlayTopCard)` 再 `addToTop(EmptyDeckShuffle)`——两条都插队首，
 *     所以实际执行是「先洗回、再重新打顶牌」。顺序写反就会对着空抽牌堆再走一遍。
 *  ② 那张牌是 `popFromDrawPile()` **拿走**的，不是拷贝——它离开抽牌堆之后只活在队列项里。
 *     于是 canUse 不通过时（顶上是眩晕/伤口）它就真的消失了，见 playCardQueueItem。
 *  ③ `energyOnUse` 取的是**当前全部能量**（`player.energy`），不是这张牌的费用。当前只有
 *     X 费牌读它（未登记），但复制项会把这个值原样继承下去，所以照抄。
 *  ④ `autoplay = freeToPlay = true`（参考自注 `// todo remove the autoplay boolean?`），
 *     于是既不扣能量、也不受能量检查约束。
 *  ⚠ 入的是 `addToTopCard`（出牌队列**队首**），所以它排在已经排队的其它出牌项之前。
 */
function playTopCardInDrawPile(bc: BattleContext, target: number, exhausts: boolean): void {
  if (bc.drawPile.length === 0) {
    if (bc.discardPile.length > 0) {
      addToTop(bc, (c) => playTopCardInDrawPile(c, target, exhausts));
      addToTop(bc, (c) => emptyDeckShuffle(c));
    }
    return;
  }
  const card = bc.drawPile.pop()!;
  bc.cardQueue.pushFront({
    card,
    target,
    isEndTurn: false,
    triggerOnUse: true,
    energyOnUse: bc.player.energy,
    ignoreEnergyTotal: false,
    freeToPlay: true,
    autoplay: true,
    exhaustOnUse: exhausts,
    purgeOnUse: false,
    randomTarget: false,
  });
}

/**
 * 把弃牌堆洗回抽牌堆（对齐 `Actions::EmptyDeckShuffle`，Actions.cpp:181）。
 *
 * 两个调用方：`drawCards` 抽不够时（那边自己**同步**调 `onShuffle()`，因为参考的
 * `BattleContext::drawCards` 是这么写的）与 `playTopCardInDrawPile`（浩劫 / 混乱，
 * 那边**不**调 onShuffle）。这个函数自己只做「洗弃牌堆 + 并入抽牌堆」两步。
 *
 * ★ **无条件**消耗一次 shuffleRng：`java::Random(bc.shuffleRng.randomLong())` 在洗之前
 * 就取好了，弃牌堆是空的照样掷。想省掉这一次只能在**调用之前**判掉（`drawCards` 的
 * 「两堆都空」提前返回、深呼吸的「弃牌堆非空」判断都是这么做的）。
 */
function emptyDeckShuffle(bc: BattleContext): void {
  shuffleCards(bc, bc.discardPile); // ★ 消耗一次 shuffleRng
  moveDiscardPileIntoDrawPile(bc);
}

/**
 * 把当前这张牌的一份**副本**塞回出牌队列，让它再结算一次
 *（对齐 `BattleContext::queuePurgeCard`，BattleContext.cpp:2777）。
 * 二连击就靠它；同族的复制 / 回响形态 / 死藤都走同一条路（都未登记）。
 *
 * ⚠ 三处照抄：
 *  ① `item.card = c` 是**按值拷贝**。所以复制项里那张牌的改写（暴走的 specialData +5、
 *     灼热之刃的升级次数）**不会**落到原牌上——原牌在 OnAfterCardUsed 里早已带着第一次的
 *     改写进了弃牌堆，而副本在 onAfterUseCard 顶部被 purgeOnUse 提前返回、直接丢掉。
 *     于是「暴走被二连击」的表现是：第二击按 +10 打，但进弃牌堆那张只涨了 +5。
 *  ② `energyOnUse` 继承当前项的值，`ignoreEnergyTotal = autoplay = true`；
 *     purgeOnUse 本身就让 useCard 跳过「移出手牌 + 扣能量」整段。
 *  ③ 入队位置不是队首而是**第二位**（见 addPurgeCardToCardQueue）。
 */
function queuePurgeCard(
  bc: BattleContext,
  card: CombatCard,
  target: number,
  energyOnUse: number,
): void {
  addPurgeCardToCardQueue(bc, {
    card: { ...card },
    target,
    isEndTurn: false,
    triggerOnUse: true,
    energyOnUse,
    ignoreEnergyTotal: true,
    freeToPlay: false,
    autoplay: true,
    exhaustOnUse: false,
    purgeOnUse: true,
    randomTarget: false,
  });
}

/**
 * 对齐 `BattleContext::addPurgeCardToCardQueue`（BattleContext.cpp:2788）。
 *
 * ⚠ 队列非空时它做的是「把队首覆写成新项，再把原队首推回队首」，
 * 结果是 `[原队首, 新项, 其余…]`——新项排在**第二位**而不是第一位。参考自注
 * `// not really the front but hey`。混乱叠到 2 层时（同一回合排两条 PlayTopCard）
 * 就能走到这一支：第二张牌打出时队里还压着第一张。
 */
function addPurgeCardToCardQueue(bc: BattleContext, item: CardQueueItem): void {
  if (bc.cardQueue.size > 0) {
    const temp = bc.cardQueue.front();
    bc.cardQueue.replaceFront(item);
    bc.cardQueue.pushFront(temp);
  } else {
    bc.cardQueue.pushFront(item);
  }
}

/**
 * 「不触发效果」的牌结算（对齐 BattleContext::useNoTriggerCard，BattleContext.cpp:919）。
 *
 * 回合末手里的灼伤走这条：**不**过 useCard，所以不计入 cardsPlayedThisTurn、不扣能量、
 * 不排 OnAfterCardUsed。顺序照抄：
 *   ① `addToTop(DamagePlayer(层数, selfDamage))` —— 走 Player::damage，**过格挡**；
 *   ② 同步从手牌移除；
 *   ③ `addToBot(DiscardNoTriggerCard)` —— 把队列项里那份**副本**放进弃牌堆。
 * ①是 addToTop、③是 addToBot，此刻动作队列已抽干，故执行顺序就是「先失血、再进弃牌堆」。
 *
 * TODO(后续PR): 腐朽（2 点伤害）、怀疑（1 层虚弱，**同步** debuff）、羞耻（1 层脆弱，同步）、
 *   悔恨（按 regretCardCount 失血）。四张诅咒牌都还没有入手途径。
 */
function useNoTriggerCard(bc: BattleContext, item: CardQueueItem): void {
  const card = item.card;
  if (card === null) {
    throw new Error("useNoTriggerCard: 队列项没有牌");
  }
  if (card.defId === "burn") {
    // 灼伤：升级形态 4 点（`BattleContext.cpp:939-940`）。
    // ⚠ 灼伤+ 的**唯一来源**是六火幽魂的灼烧（第二十批登记）：`bc.turn > 8` 时它塞的就是
    //   升级版（MonsterSpecific.cpp:825），即第 10 个怪物回合起。牌堆快照只 dump 牌名、
    //   不 dump 升级位，所以这一支唯一的可观察面就是回合末的 4 点而不是 2 点。
    // ⚠ selfDamage=true（`DamagePlayer(…, true)`）——灼伤的自伤**会**触发破裂。
    // ⚠ `clearOnCombatVictory` 是 **false**：`Actions::DamagePlayer` 那行是
    //   `return {[=](BattleContext &bc){...}, false};`（Actions.cpp:91-95，与 `AttackPlayer`
    //   逐字同形）。第十九批修 `AttackPlayer` 时把这一条记进了 TODOS 的「尚未修」，
    //   第二十批一并修掉。⚠ **它没有预言机（0 例），而且是结构性的**：这条动作走的是
    //   `addToTop`、下一步就出队，中间不可能插进任何能判胜的东西（灼伤只打玩家，
    //   `clearPostCombatActions` 又只在**胜利**时跑）。`AttackPlayer` 那一位能被看见靠的是
    //   「多段攻击 + 荆棘反伤打死怪」，灼伤没有这个结构。理由与量测记在 TODOS。
    const damage = card.upgraded ? 4 : 2;
    addToTop(bc, (c) => damagePlayerNonAttack(c, damage, true), false);
  }
  removeFromHandByUid(bc, card.uid);
  addToBot(bc, (c) => {
    c.discardPile.push(card);
  });
}

/**
 * 从手牌里按 uid 摘掉一张（对齐 `CardManager::removeFromHandById`）。
 *
 * ⚠ 按 uid 而不是按对象引用：出牌队列项可能装着一份**副本**（二连击的复制项、
 * 或读档重建出来的那份），按引用比对会漏删、让同一张牌既留在手上又进弃牌堆。
 * 找不到就什么都不做（参考同样是「找到才删」）。
 */
function removeFromHandByUid(bc: BattleContext, uid: number): void {
  const idx = bc.hand.findIndex((c) => c.uid === uid);
  if (idx >= 0) {
    bc.hand.splice(idx, 1);
  }
}

/** 对齐 MonsterGroup::getRandomMonsterIdx（存活怪中随机，消耗一次 cardRandomRng）。 */
function getRandomMonsterIdx(bc: BattleContext): number {
  const alive = bc.monsters.filter((m) => m.alive);
  if (alive.length === 0) {
    return 0;
  }
  const pick = bc.rng.cardRandomRng.random(alive.length - 1); // ★ 消耗一次 cardRandomRng
  return bc.monsters.indexOf(alive[pick]);
}

// ============================================================================
// 伤害 / 格挡计算（对齐 BattleContext::calculateCardDamage / calculateCardBlock）
//
// 伤害全程 float32 运算、末尾一次向零截断——这是逐位对齐的要害：先加力量/精力，
// 再乘虚弱 0.75f，再乘易伤 1.5f，顺序不可换（浮点不满足结合律）。
// 用 Math.fround 逐步收窄模拟 C++ float。
// ============================================================================

/**
 * 取出一条**可见的** Power 条目（`statusBits` 那一位为真的那些）。
 *
 * ⚠⚠ 它不是 `powers.find(...)` 的同义词：`cleared` 的条目在参考里是「数值还在、bit 已清」，
 * 一切读点（`hasStatus` / `getStatus` / 各处的 `find`）都必须当它不存在。
 * 详见 `PowerInstance.cleared`。**新增读点一律走这个函数，不要裸 `find`。**
 */
function findPower(powers: PowerInstance[], id: string): PowerInstance | undefined {
  const p = powers.find((x) => x.id === id);
  return p === undefined || p.cleared === true ? undefined : p;
}

function getPower(powers: PowerInstance[], id: string): number {
  return findPower(powers, id)?.amount ?? 0;
}

/**
 * 「身上有没有这条 Power」——对齐参考的 `hasStatus<s>()`，它读的是 **statusBits**
 * （Monster.h:407-409），与层数无关。
 *
 * ⚠ 绝大多数地方用 `getPower(...) > 0` 与它等价，因为参考清层数时走的是
 * `removeStatus`（先 setStatus(0) 再清 bit）。**飞行是唯一的例外**：
 * `attackedUnblockedHelper` 那一格写的是裸的 `setStatus<FLIGHT>(flight-1)`，
 * **只写数值、不清 bit**，所以拜鸟摔下来（层数 0）之后 `hasStatus<FLIGHT>()` 仍然为真
 * ——伤害照样减半、回合开始照样复位、再挨打还会减成负数。
 * 我们这边把这件事建模成「条目一旦加上就永不摘除」，于是这个谓词就是「条目在不在」。
 */
function hasPower(powers: PowerInstance[], id: string): boolean {
  return findPower(powers, id) !== undefined;
}

/** 缓慢每层的伤害加成，对齐参考的字面量 `0.1f`（float，不是精确的 0.1）。 */
const SLOW_STEP = Math.fround(0.1);

export function calculateCardDamage(
  bc: BattleContext,
  targetIdx: number,
  baseDamage: number,
  card: CombatCard,
): number {
  let damage = Math.fround(baseDamage);

  // —— 玩家遗物 AtDamageModify（对齐 BattleContext.cpp:2706-2715）——
  //
  // ⚠⚠ **这一段排在力量之前**，也就是所有加法/乘法的最前面。位置就是它全部的可观察面：
  //   打击假人若挪到虚弱之后，那 3 点就不会被虚弱的 ×0.75 打折。
  // ⚠ 打击假人（STRIKE_DUMMY，第四十三批）：`if (STRIKE_DUMMY && card.isStrikeCard()) damage += 3;`
  //   判据是**牌名**（`isCardStrikeCard`，见 `isStrikeCard`），与颜色、与升级与否都无关；
  //   而且它按**每一次结算**加 3——双重打击那种「一张牌打两下」的会各加一次。
  // ⚠ 这是 `calculateCardDamage` 第一次需要知道「是哪张牌」，所以本批给它加了 `card` 形参
  //   （参考的签名一直是 `calculateCardDamage(const CardInstance &card, int targetIdx, int base)`，
  //   我们此前少的就是第一个实参）。
  if (hasRelic(bc, "strike_dummy") && isStrikeCard(card.defId)) {
    damage = Math.fround(damage + 3);
  }
  // 腕刃（WRIST_BLADE，第四十四批）：排在打击假人**之后**（BattleContext.cpp:2712-2714）：
  //     if (player.hasRelic<R::WRIST_BLADE>() && card.costForTurn == 0) { damage += 4; }
  // ⚠ 四处照抄：
  //  ①⚠⚠ 判的是 `costForTurn`（**实例级本回合费用**）而不是数据表里的 `cost`——所以
  //     被腐化压成 0 费的技能、被木乃伊手压成 0 的牌、以及升级后降到 0 费的牌都吃这 4 点。
  //  ② 它与打击假人一样按**每一次结算**加，多段攻击每段各 +4。
  //  ③ 位置在力量之前 ⇒ 这 4 点吃虚弱的 ×0.75、吃易伤的 ×1.5。
  //  ④ 与打击假人是同一段里的两条并列 `if`，两者可以同时命中（0 费的打击牌 +7）。
  if (hasRelic(bc, "wrist_blade") && card.costForTurn === 0) {
    damage = Math.fround(damage + 4);
  }

  // 玩家 Power AtDamageGive
  damage = Math.fround(damage + getPower(bc.player.powers, "strength"));
  const vigor = getPower(bc.player.powers, "vigor");
  if (vigor > 0) {
    damage = Math.fround(damage + vigor);
  }
  // 笔尖（PEN_NIB，第四十四批）：排在**虚弱之前**（BattleContext.cpp:2729-2731）：
  //     if (player.hasStatus<PS::PEN_NIB>()) { damage *= 2; }
  // ⚠ 三处照抄：
  //  ①⚠⚠ **位置在虚弱之前**——两者都是乘法，`×2` 再 `×0.75` 与反过来在 float 域上
  //     不保证同解（先 ×2 会把中间值抬到另一个尾数区间）。
  //  ② 门是 `hasStatus`（纯 bool Power，`Player.h:338` 那条名单里有它），不是层数。
  //  ③ 摘除在 `onUseAttackCard` 里（`addToBot(RemoveStatus<PEN_NIB>())`，:1686-1691），
  //     而伤害在**打牌那一刻**就算好了 ⇒ **这一张牌自己也翻倍**，一张多段攻击牌的每一段都翻。
  if (hasPower(bc.player.powers, "pen_nib")) {
    damage = Math.fround(damage * 2);
  }
  if (getPower(bc.player.powers, "weak") > 0) {
    damage = Math.fround(damage * 0.75);
  }
  // TODO(后续PR): 双倍伤害 / 姿态（愤怒×2、神性×3）。

  // 敌人 Power AtDamageReceive
  const target = bc.monsters[targetIdx];
  // 缓慢（SLOW，巨头，第三十五批）：`if (monster.hasStatus<MS::SLOW>())
  //   damage *= 1 + static_cast<float>(monster.getStatus<MS::SLOW>()) * 0.1f;`
  // （BattleContext.cpp:2748-2750）。⚠ 四处照抄：
  //  ① **位置在易伤之前**——两者都是乘法，但 `float` 乘法不满足结合律，先后顺序真的会
  //     在个别数值上分岔（先 ×1.3 再 ×1.5 与反过来可能差 1 点）。
  //  ② 门是 `hasStatus`（条目在不在）而不是层数 > 0：巨头开局层数就是 0，
  //     但那时倍率也恰好是 1，所以当前两种写法同解；照抄 `hasPower`。
  //  ③ 层数就是「玩家本回合已经打出的牌数」（回合末清零），所以同一回合越往后打越疼
  //     ——这才是缓慢的全部玩法。
  //  ④ 浮点逐位对齐：`0.1f` 不是精确值，必须走 `Math.fround`，且三步各 round 一次
  //     （`slow * 0.1f` → `1 + …` → `damage * …`），与 C++ 的 float 运算一一对应。
  if (target !== undefined && hasPower(target.powers, "slow")) {
    const slowMult = Math.fround(1 + Math.fround(getPower(target.powers, "slow") * SLOW_STEP));
    damage = Math.fround(damage * slowMult);
  }
  // 易伤（对齐 BattleContext.cpp:2752-2758）。⚠ 纸蛙（PAPER_PHROG，第四十三批）就在这里：
  //     if (monster.hasStatus<MS::VULNERABLE>()) {
  //         if (player.hasRelic<R::PAPER_PHROG>()) { damage *= 1.75f; }
  //         else                                   { damage *= 1.5f;  }
  //     }
  // ⚠ 三处照抄：① 是**同一道门里的二选一**，不是「先 ×1.5 再补一份」——写成两次乘法
  //   （1.5 × 1.1667）在 float 域上会分岔；② 倍率写死 `1.75f`，与真实游戏一致；
  //   ③ 它只管**玩家的牌打怪**这条路，怪物打玩家那边的易伤倍率是另一处
  //   （`Monster::calculateDamageToPlayer` 里的奇特蘑菇，见 `calculateDamageToPlayer`）。
  if (target !== undefined && getPower(target.powers, "vulnerable") > 0) {
    damage = Math.fround(damage * (hasRelic(bc, "paper_phrog") ? 1.75 : 1.5));
  }

  // —— 怪物 Power AtDamageReceiveFinal ——
  // 飞行（拜鸟，第二十四批）：`if (monster.hasStatus<MS::FLIGHT>()) damage *= .5;`
  // （BattleContext.cpp:2764-2766）。三处照抄：
  //  ① 位置在**易伤之后、虚无缥缈之前**，也就是所有加法与其它倍率都算完之后；
  //  ② 判据是 `hasStatus`（statusBits）而**不是层数 > 0**——拜鸟摔下来（层数 0）之后
  //     伤害**照样减半**，见 `hasPower` 的注释。这是本条最容易抄错的地方：
  //     写成 `getPower(...) > 0` 会让眩晕那一回合的伤害翻倍。
  //  ③ 只挡**牌**造成的伤害：这个函数只有 `CARD_RULES` / 药水那条路会调，
  //     怪物之间的伤害与荆棘走别的路。
  if (target !== undefined && hasPower(target.powers, "flight")) {
    damage = Math.fround(damage * 0.5);
  }
  // 虚无缥缈（怪物侧，复仇魔，第三十六批）：
  //   `if (monster.hasStatus<MS::INTANGIBLE>()) { damage = std::max(damage, 1.0f); }`
  //   （BattleContext.cpp:2768-2770）。⚠ 四处照抄：
  //  ①⚠⚠ 它是 **`std::max`（下限）而不是 `min`（上限）**——这个函数只**预计算**一个数给
  //     `Actions::AttackEnemy` 用，真正的钳制在 `Monster::attacked` 里（见 `monsterAttacked`）。
  //     写成 `min(damage, 1)` 在最终血量上碰巧同解，但那是两处独立的逻辑，形状照抄。
  //     ⚠ 可观察面：玩家侧读这个预计算值的地方（打完之后的「上一击未被格挡量」等）会分岔。
  //  ② 位置在**飞行之后**，也就是所有加法与全部倍率都算完之后（`AtDamageReceiveFinal` 段）。
  //  ③ 门是 `hasStatus`（条目在不在），与飞行那一格同族；虚无缥缈归零时条目会被摘掉
  //     （`decrementStatus` 走 `uniquePower0` 那一支），所以当前两种写法同解。
  //  ④ 它在 `float` 域里做（`1.0f`），随后才是末尾那次 `max(0, trunc(...))`。
  if (target !== undefined && hasPower(target.powers, "intangible")) {
    damage = Math.max(damage, Math.fround(1));
  }

  return Math.max(0, Math.trunc(damage));
}

/**
 * 牌产生的格挡（对齐 BattleContext::calculateCardBlock，BattleContext.cpp:2759）。
 *
 * ⚠ 无法格挡（应急按钮的 NO_BLOCK）是**整个函数的第一道门**，命中就返回 0，敏捷/脆弱
 * 都不再参与。位置很关键：它只挡「过这个函数的格挡」，也就是**牌**产生的格挡；
 * 金属化 / 无痛之心 / 暴怒 / 严阵以待走的是裸 GainBlock，一律不受影响——真实游戏的措辞
 * 正是「你无法从**牌**获得格挡」。
 */
export function calculateCardBlock(bc: BattleContext, baseBlock: number): number {
  if (getPower(bc.player.powers, "no_card_block") > 0) {
    return 0;
  }
  let block = baseBlock;
  const dex = getPower(bc.player.powers, "dexterity");
  if (dex !== 0) {
    block = Math.max(0, block + dex);
  }
  if (getPower(bc.player.powers, "frail") > 0) {
    return Math.trunc((block * 3) / 4); // C++ 整除，向零截断
  }
  return block;
}

// ============================================================================
// 伤害结算（对齐 Actions::AttackEnemy → Monster::attacked → damageUnblockedHelper → die）
// ============================================================================

function attackEnemy(bc: BattleContext, idx: number, damage: number): void {
  const m = bc.monsters[idx];
  if (m === undefined || !m.alive) {
    return;
  }
  monsterAttacked(bc, m, damage);
  checkCombat(bc);
}

function monsterAttacked(bc: BattleContext, m: CombatMonster, rawDamage: number): void {
  let damage = Math.max(0, rawDamage);
  // 虚无缥缈（INTANGIBLE，怪物侧，复仇魔，第三十六批）：对齐 `Monster::attacked` 里那句
  //     `if (hasStatus<MS::INTANGIBLE>()) { if (damage > 0) { damage = 1; } }`
  //（Monster.cpp:418-422）。⚠ 四处照抄：
  //  ①⚠⚠ **位置在整条链的最前**——排在**狂怒之前**、更在格挡吸收之前。
  //     位置就是这一族全部的可观察面（第十七批把狂怒挪一格红 30 例的教训）：
  //     挪到狂怒之后当前不可分辨（没有怪同时带两者），挪到格挡吸收之后就完全错了
  //     （那样 1 点伤害会被格挡吃掉，而参考是「先压成 1，再让格挡吃」）。
  //  ② 内层还有一道 `damage > 0`：0 伤害**不会**被抬成 1。
  //  ③ 门是 `hasStatus`（条目在不在），不是层数 > 0。
  //  ④ 它在**两条**伤害路径上各有一份（`attacked` 与 `damage`，Monster.cpp:477-481），
  //     两处逐字相同——所以非攻击伤害（燃烧 / 主宰 / 荆棘 / 火焰药水）**照样**被压成 1，
  //     与蜷缩 / 镀甲那种「只挂在 attacked 上」的正相反。见 `monsterDamage`。
  if (hasPower(m.powers, "intangible") && damage > 0) {
    damage = 1;
  }
  // 狂怒（ANGRY，狂暴地精）：对齐 `Monster::attacked` 里那句 `if (hasStatus<ANGRY>())
  // buff<STRENGTH>(getStatus<ANGRY>())`（Monster.cpp:424-426）。三处非直觉但照抄：
  //  ① 位置在**格挡吸收之前**，而且这一族的判定与伤害无关——**打在格挡上照样涨力量**，
  //     甚至 `damage == 0` 也涨。与蜷缩正相反：蜷缩在 `attackedUnblockedHelper` 里，
  //     只有真的破了格挡才触发（见 `monsterDamageUnblocked`）。
  //  ② 是**同步** buff、不入队——所以同一回合里排在后面的攻击已经能吃到新力量。
  //  ③ **不会被消耗掉**：层数留着，每挨一次攻击就再涨一次。
  // ⚠ 它只挂在 `attacked` 这条路上：非攻击伤害（燃烧 / 主宰 / 火焰药水走 `damage`）不触发。
  const angry = getPower(m.powers, "angry");
  if (angry > 0) {
    addPower(m.powers, "strength", angry);
  }
  // 格挡吸收：先扣伤害再削格挡，两者都基于进入时的原值（对齐 Monster::attacked）。
  const hadBlock = m.block > 0; // ★ 手钻的门读的是**进入这一击时**有没有格挡
  const tempDamage = damage;
  damage -= m.block;
  m.block = Math.max(0, m.block - tempDamage);
  handDrillOnBlockBroken(bc, m, hadBlock);
  if (damage > 0) {
    monsterDamageUnblocked(bc, m, damage);
  }
}

/**
 * 手钻（HAND_DRILL，第四十批）：把这只怪的格挡打光时给它 2 层易伤。
 *
 * 参考在**两处**逐字写了同一段（`Monster::attacked` :433-435、`Monster::damage` :488-490）：
 * ```cpp
 * const bool hadBlock = block > 0;
 * const int tempDamage = damage;
 * damage -= block;
 * block = std::max(0, block - tempDamage);
 * if (hadBlock && block == 0 && bc.player.hasRelic<RelicId::HAND_DRILL>()) {
 *     bc.addToBot(Actions::DebuffEnemy<MS::VULNERABLE>(idx, 2, false));
 * }
 * ```
 * ⚠ 五处照抄：
 *  ①⚠⚠ **两条伤害路径上各有一份**——所以**非攻击伤害也算**（燃烧 / 荆棘 / 火焰药水 /
 *     爆炸药水 / 自爆走 `damage`）。这与蜷缩 / 镀甲那一族「只挂在 `attacked` 上」正相反，
 *     与虚无缥缈那一族（也是两条路各一份）同族。
 *  ②⚠ 门是「**进来时有格挡** 且 **打完之后归零**」的合取，不是「伤害溢出了格挡」：
 *     一击恰好打光格挡（`damage == block`）照样触发，而对本来就没格挡的怪**不触发**。
 *  ③ 位置在**格挡吸收之后、`damage > 0` 那道门之前**——所以「这一击被格挡完全吃掉」时
 *     易伤照样上。
 *  ④ 是 `addToBot`（**入队**），不是同步：同一批动作里排在它前面的还是先结算。
 *  ⑤ `isSourceMonster = false`（玩家来源），所以这层易伤**本回合末就开始递减**。
 *
 * ⚠ 它排在 `Monster::attacked` 里狂怒的**下方**、`attackedUnblockedHelper` 的**上方**
 *   ——不是那条 else-if 链上的一格，而是链外的一个独立 if。
 */
function handDrillOnBlockBroken(bc: BattleContext, m: CombatMonster, hadBlock: boolean): void {
  if (hadBlock && m.block === 0 && hasRelic(bc, "hand_drill")) {
    const idx = bc.monsters.indexOf(m);
    addToBot(bc, (c) => {
      debuffEnemy(c, idx, "vulnerable", 2, false);
    });
  }
}

function monsterDamageUnblocked(bc: BattleContext, m: CombatMonster, rawDamage: number): void {
  // 靴子（THE_BOOT，第四十三批）：`attackedUnblockedHelper` 的**第一句**（Monster.cpp:340-342）：
  //     if (bc.player.hasRelic<RelicId::THE_BOOT>() && damage > 0 && damage < 5) {
  //         damage = 5;
  //     }
  // ⚠ 五处照抄：
  //  ①⚠⚠ **位置在整条 else-if 链之前**，所以被抬高的 5 点会一路传下去——变换那一格的
  //     `addDebuff<STRENGTH>(-damage)` 与末尾的扣血读到的都是 5。
  //  ②⚠ 判的是**过完怪物格挡之后**剩下的量（调用方已经减过）：格挡把 12 点削到 3 点时
  //     靴子照样把它抬成 5。
  //  ③ 上界是 `< 5`（**不含** 5），与鸟居的 `<= 5` 不对称——两条并排看很容易抄串。
  //  ④ 它**只挂在 `attackedUnblockedHelper` 这条路上**（`damageUnblockedHelper` 里没有），
  //     所以非攻击伤害（荆棘 / 燃烧 / 骨灰 / 火焰药水）**不吃这条**。
  //  ⑤ 是「置为 5」而不是「加到 5」。
  let damage = rawDamage;
  if (hasRelic(bc, "the_boot") && damage > 0 && damage < 5) {
    damage = 5;
  }
  // onAttacked 链（对齐 attackedUnblockedHelper 的 if/**else-if**顺序，Monster.cpp:348-396）。
  // 参考的顺序是：无敌 → **镀甲** → 蜷缩 → 飞行 → 易塑/反应 → **荆棘** → **沉睡** → 变换。
  // ⚠ 第五格是**一格装两条 Power**（`hasStatus<MALLEABLE>() || hasStatus<REACTIVE>()`），
  //   不是两格——第三十五批装蠕动血块时补全，详见那一格的注释。
  // ⚠ 它是一条 **else-if 链**：同时带蜷缩与沉睡的怪只会触发排在前面的那一条。当前没有这种
  //   怪（虱子只有蜷缩、拉加维林只有沉睡），但形状照抄——写成两个独立 if 会在将来静默出错。
  // 蜷缩把加格挡 addToBot 排在扣血之后，故这里先记下、扣完血再加。
  //
  // ⚠⚠ **第一格：无敌（INVINCIBLE，腐化之心，第四十七批）**——链上最后一个补上宿主的格子。
  //   对齐 Monster.cpp:348-351：
  //       if (hasStatus<MS::INVINCIBLE>()) {
  //           damage = std::min(damage, getStatus<MS::INVINCIBLE>());
  //           setStatus<MS::INVINCIBLE>(getStatus<MS::INVINCIBLE>() - damage);
  //       } else if (…镀甲…)
  //   ⚠ 四处照抄：
  //    ①⚠⚠ 它**改写 `damage` 本身**，而这个值一路流到末尾的 `curHp -= damage`——所以
  //       它不是「扣完血再记账」，是「先把这一击削平再扣血」。写成「只减层数、不改伤害」
  //       在层数还够的时候两者同解，层数不够时就分岔。
  //    ② 减的是**削平之后**的 `damage`（两句共用同一个新值），不是原始伤害——所以层数
  //       永远不会变成负数。
  //    ③ 门是 `hasStatus`（条目在不在），写的是裸 `setStatus`（**只写数值、不碰 bit**），
  //       所以打到 0 之后它**照样占着这一格**：本回合此后任何一击都被削成 0 点，
  //       后面的镀甲 / 蜷缩 / 飞行 / 易塑 / 荆棘 / 沉睡 / 变换一格都轮不到。
  //    ④ 它每个怪物回合开始被复位回 300（`applyPreTurnLogic`），见那里。
  //   ⚠ 当前语料下**没有任何一副候选牌组能把它打到 0**（最强的一副只到 14 / 300），
  //     所以 `Math.min` 那道钳制是盲区；「逐击递减」这一半在快照里逐帧可见。
  const invincible = findPower(m.powers, "invincible");
  const platedArmor = findPower(m.powers, "plated_armor");
  const curl = findPower(m.powers, "curl_up");
  const flight = findPower(m.powers, "flight");
  const malleable = findPower(m.powers, "malleable");
  const reactive = findPower(m.powers, "reactive");
  const thorns = findPower(m.powers, "thorns");
  if (invincible !== undefined) {
    // ⚠ 两句共用**削平之后**的那个 `damage`，所以层数不会变成负数；而 `damage` 被改写
    //   之后一路流到末尾的扣血。
    damage = Math.min(damage, invincible.amount);
    invincible.amount -= damage;
  } else if (platedArmor !== undefined) {
    // 镀甲（PLATED_ARMOR，带壳寄生虫）：对齐 Monster.cpp:352-355 那一格。
    //
    //     } else if (hasStatus<MS::PLATED_ARMOR>()) {
    //         decrementStatus<MS::PLATED_ARMOR>();
    //         if (!hasStatus<MS::PLATED_ARMOR>() && id == MonsterId::SHELLED_PARASITE) {
    //             setMove(MMID::SHELLED_PARASITE_STUNNED);
    //         }
    //     }
    //
    // ⚠ 五处照抄：
    //  ①⚠⚠ **位置**：在这条 else-if 链里排**第二格**——无敌之后、**蜷缩之前**。
    //     链上的位置就是它全部的可观察面（同第十七批把狂怒挪一格红 30 例的教训）。
    //     往前挪一格（到无敌前面）当前无差别（没有怪带无敌），往后挪一格（到蜷缩后面）
    //     在「同时带镀甲与蜷缩的怪」上才有差别——当前没有这种怪，但形状照抄。
    //  ② 入口是 `hasStatus`（statusBits）。⚠ 与飞行**正相反**：
    //     `decrementStatus<PLATED_ARMOR>` 走的是「枚举值 <= WEAK」那一支
    //     （`newAmount = get-1; setStatus(newAmount); setHasStatus(newAmount);`，
    //     Monster.h:299-303），归零时 bit **真的被清掉**。所以我们这边**整条摘掉**，
    //     于是壳破之后这一格让位给链上后面的蜷缩 / 飞行 / 易塑（并且层数不会变成负数）。
    //     飞行那条写的是裸 `setStatus`、不碰 bit，所以它永不摘除——两者别照搬彼此。
    //  ③ **没有** `&& damage > 0`（整条链里只有飞行那一格带它）。调用方本来就有
    //     `if (damage > 0)` 的门，所以带不带当前不可观察，但形状照抄。
    //  ④ 那句 `id == MonsterId::SHELLED_PARASITE` 是**怪种专属的门**：镀甲不是只有它有
    //     （真实游戏里青铜机器人也有），所以「归零就改出眩晕」这一支只属于带壳寄生虫。
    //     写成「凡镀甲归零就改意图」会在登记下一只带镀甲的怪时静默出错。
    //  ⑤ 改意图用的是 **`setMove`（前移历史）**，不是 `onHpLost` 里那种裸的
    //     `moveHistory[0] =`——同一件事在参考里两种写法并存，别统一。
    // ⚠ 它**只挂在 attacked 这条路上**：非攻击伤害（燃烧 / 主宰 / 火焰药水走 `damage`
    //   → `damageUnblockedHelper`）里没有镀甲这一格，那种伤害不消耗镀甲层数。
    platedArmor.amount -= 1;
    if (platedArmor.amount === 0) {
      m.powers.splice(m.powers.indexOf(platedArmor), 1);
    }
    if (getPower(m.powers, "plated_armor") === 0 && m.defId === "shelled_parasite") {
      setMove(m, "stunned");
    }
  } else if (curl !== undefined && curl.amount > 0) {
    const amount = curl.amount;
    m.powers.splice(m.powers.indexOf(curl), 1); // 触发一次即清除
    // 必须**入队**而非当场加：这是 addToBot(Actions::MonsterGainBlock)，
    // 所以 ① 触发那一击不被它减免；② 怪物即便被这一击打死，格挡照样落在尸体上；
    // ③ 但若这一击终结了战斗，clearPostCombatActions 会把它连同其它排队动作清掉。
    // 三种表现同时成立，只有走队列才能都对上。
    addToBot(bc, () => {
      m.block += amount;
    });
  } else if (flight !== undefined && damage > 0) {
    // 飞行（FLIGHT，拜鸟）：对齐 Monster.cpp:362-368 那一格。
    //
    //     } else if (hasStatus<MS::FLIGHT>() && damage > 0) {
    //         auto flight = getStatus<MS::FLIGHT>();
    //         if (flight == 1) { setMove(MMID::BYRD_STUNNED); }
    //         setStatus<MS::FLIGHT>(flight-1);
    //     }
    //
    // ⚠ 五处照抄：
    //  ① **位置**：在这条 else-if 链里排第四，**蜷缩之后、易塑之前**。链上的位置就是它
    //     全部的可观察面（同第十七批把狂怒挪到蜷缩那一格的教训），挪了会静默改行为。
    //  ② 入口是 `hasStatus`（条目在不在），**不是层数 > 0**——摔下来之后再挨打会把层数
    //     减成 **-1、-2…**，而且照样占着这一格（后面的易塑/荆棘/沉睡都轮不到）。
    //  ③ `&& damage > 0` 是参考写着的，尽管调用方已经有 `if (damage > 0)` 的门
    //     ——整条链里只有这一格带它，照抄。
    //  ④ 判据是「**减之前恰好是 1**」而不是「减之后 <= 0」：所以只有 1 → 0 那一击摔下来，
    //     0 → -1、-1 → -2 都不会再触发一次眩晕。
    //  ⑤ 改意图用的是 **`setMove`（前移历史）**，不是 `onHpLost` 里那种裸的
    //     `moveHistory[0] =`——同一件事在参考里两种写法并存，别统一。
    // ⚠ 它**只挂在 attacked 这条路上**：非攻击伤害（燃烧 / 主宰 / 火焰药水走 `damage`
    //   → `damageUnblockedHelper`）里根本没有飞行这一格，所以那种伤害不消耗飞行层数。
    const amount = flight.amount;
    if (amount === 1) {
      setMove(m, "stunned");
    }
    flight.amount = amount - 1;
  } else if (malleable !== undefined || reactive !== undefined) {
    // 易塑 + 反应（MALLEABLE / REACTIVE）：对齐 Monster.cpp:369-383 那**一格**。
    //
    //     } else if (hasStatus<MS::MALLEABLE>() || hasStatus<MS::REACTIVE>()) {
    //         if (hasStatus<MS::MALLEABLE>()) {
    //             const auto malleable = getStatus<MS::MALLEABLE>();
    //             bc.addToBot( Actions::MonsterGainBlock(this->idx, malleable) );
    //             setStatus<MS::MALLEABLE>(malleable+1);
    //         }
    //         if (hasStatus<MS::REACTIVE>()) {
    //             if (getStatus<MS::REACTIVE>() == 0) {
    //                 setStatus<MS::REACTIVE>(1);
    //                 bc.addToBot( Actions::ReactiveRollMove() );
    //             } else {
    //                 setStatus<MS::REACTIVE>(getStatus<MS::REACTIVE>()+1);
    //             }
    //         }
    //     }
    //
    // ⚠⚠ **这是链上的一格、不是两格**（第二十三批装易塑时就记下了这条账，第三十五批结清）：
    //   门是两者的**或**，进去之后两个 if **各判各的**。蠕动血块两者都有，所以它一次挨打
    //   会同时加格挡与滚意图；食蛇草只有易塑、巨头两者都没有。
    //   拆成两个 else-if 会让蠕动血块只走到前一格——反应整条静默失效。
    // ⚠ 门读的是 `hasStatus`（**条目在不在**），不是层数 > 0：反应的层数平时**恰好是 0**
    //   （`preBattleAction` 就是 `setHasStatus(true); setStatus(0);`），写成 `> 0` 它永远
    //   触发不了。易塑那一半此前写的是 `amount > 0`，本批一并改成条目判定（同解，形状对齐）。
    //
    // 易塑三处照抄：
    //  ① 加的格挡是 `addToBot(MonsterGainBlock(idx, malleable))` ——**入队**，所以
    //     触发它的那一击不被减免（与蜷缩同族）；
    //  ② 层数 **+1**（`setStatus<MALLEABLE>(malleable+1)`），不是消耗掉——挨得越多、
    //     下一次挡得越多；
    //  ③ 复位**不在这里**，在 `applyMonsterEndOfTurnTriggers`（每回合末拉回 3）。
    //
    // 反应四处照抄：
    //  ①⚠⚠ 层数在这里的语义是「**这一波攒了几次重滚**」，不是强度：0 → 1 并**入队**
    //     一条 `Actions::ReactiveRollMove`，1 → 2 / 2 → 3 只加数、**不再入队**。
    //     所以一张多段攻击牌打三下只排**一条**动作，但那条动作会滚 **3** 次意图。
    //     写成「每次都入队」会让 aiRng 消耗次数相同、而 `moveHistory` 的推进次数完全不同。
    //  ② 排的是 `addToBot`，`clearOnCombatVictory` 取默认的 **true**
    //     （`Action(ActionFunction)` 单参构造）——所以**打死它的那一击不会再滚意图**，
    //     而层数已经被置成 1 且再也没人清：最后一帧快照里会留着 `REACTIVE: 1`。
    //  ③ 它排在易塑那条加格挡**之后**入队（两条都是 addToBot），顺序照抄。
    //  ④ 层数归零在 `reactiveRollMove` 里（`setStatus<REACTIVE>(0)`，**只写数值、不清 bit**）。
    if (malleable !== undefined) {
      const amount = malleable.amount;
      addToBot(bc, () => {
        m.block += amount;
      });
      malleable.amount = amount + 1;
    }
    if (reactive !== undefined) {
      if (reactive.amount === 0) {
        reactive.amount = 1;
        addToBot(bc, (c) => reactiveRollMove(c));
      } else {
        reactive.amount += 1;
      }
    }
  } else if (thorns !== undefined) {
    // 荆棘（THORNS，尖刺客，第三十二批）：对齐 Monster.cpp:384-386 那一格。
    //
    //     } else if (hasStatus<MS::THORNS>()) {
    //         bc.addToTop( Actions::DamagePlayer(getStatus<MS::THORNS>()) );
    //     }
    //
    // ⚠ 六处照抄：
    //  ①⚠⚠ **位置**：这条 else-if 链的**第六格**——易塑/反应之后、沉睡之前。链上的位置就是
    //     它全部的可观察面（同第十七批把狂怒挪一格红 30 例的教训）。当前没有哪只怪同时带
    //     荆棘与前面五位中的任何一位，所以挪位置暂时量不出来，但形状照抄。
    //  ② 入口是 `hasStatus`（statusBits）而不是层数 > 0。荆棘全项目**只增不减**
    //     （开局 3/4/7 + 每次增生尖刺 +2），所以两者当前同解；写成「条目在不在」是为了
    //     与参考的形状一致（同飞行那一格的理由，反面教材是镀甲的 `decrementStatus`）。
    //  ③ 是 **`addToTop`** 而不是 `addToBot`——反伤**插到队首**。可观察面：多段攻击的
    //     第一段触发之后，反伤排在**剩余几段之前**结算；玩家因此可能在后几段落下之前就死。
    //  ④ 走 `Actions::DamagePlayer` = **非攻击伤害**（`Player::damage`），所以**过格挡**、
    //     不触发荆棘/火焰屏障那一族（那两条挂在 `Player::attacked` 上），
    //     `selfDamage` 取默认的 false（不触发破裂）。
    //  ⑤ `clearOnCombatVictory` 是 **false**（Actions.cpp:91-95 第二个参数）——所以打死
    //     这只尖刺客的那一击，反伤**照样落在玩家身上**（`checkCombat` 清不掉它）。
    //  ⑥ 判定点是「**未被格挡**的攻击伤害」：调用方有 `if (damage > 0)` 的门（damage 是
    //     扣掉怪物格挡之后的值），而且它只挂在 `attacked` 这条路上——非攻击伤害
    //     （燃烧 / 主宰 / 火焰药水走 `damage` → `damageUnblockedHelper`）**不触发反伤**。
    // ⚠ 与守卫者的尖锐外壳（`onUseAttackCard` 的最末）时点完全不同，见 `PRE_BATTLE_ACTION.spiker`。
    const amount = thorns.amount;
    addToTop(bc, (c) => damagePlayerNonAttack(c, amount, false), false);
  } else if (getPower(m.powers, "asleep") > 0) {
    // 沉睡被打断（Monster.cpp:388-391）。⚠ 它排在这条 else-if 链的**第七格**——
    // 荆棘之后、变换之前。⚠ 第三十四批把它从「兜底的 else」改成了显式的 `else if`：
    // 变换必须接在它**后面**，而兜底写法占着最后一格、变换就没地方放了。
    // 两种写法在「没有怪同时带沉睡与变换」的前提下同解，但形状必须对齐。
    wakeUpLagavulin(m);
  } else if (getPower(m.powers, "shifting") > 0) {
    // 变换（SHIFTING，复形怪，第三十四批）：对齐 Monster.cpp:393-396 那一格。
    //
    //     } else if (hasStatus<MS::SHIFTING>()) {
    //         addDebuff<MS::STRENGTH>(-damage);
    //         buff<MS::SHACKLED>(damage);
    //     }
    //
    // ⚠ 六处照抄：
    //  ①⚠⚠ **位置**：这条 else-if 链的**最后一格**（第八格），排在沉睡之后。链上的位置
    //     就是它全部的可观察面——挪到前面去会在「同时带变换与前七位之一」的怪身上分岔。
    //     当前没有这种怪，形状照抄。
    //  ② `damage` 是**扣掉怪物格挡之后**的值（调用方已经减过），而且调用方有
    //     `if (damage > 0)` 的门——所以被完全挡住的攻击**不触发变换**。
    //  ③ 力量走 `addDebuff<STRENGTH>(-damage)` = **累减**（`strength += amount`，
    //     Monster.h:353-356），不是覆盖：同一回合挨两下就减两次。
    //  ④ 枷锁走 `buff<SHACKLED>(damage)` = **累加**。两个数恒等大小、方向相反。
    //  ⑤ **归还在回合末**：`applyEndOfTurnTriggers` 的最后一句
    //     `buff<STRENGTH>(shackled); removeStatus<SHACKLED>();`（Monster.cpp:62-65）。
    //     所以复形怪在**它自己的怪物回合里**力量是负的（本回合被打了多少就减多少），
    //     回合末才归零——它的重殴因此真的会被打软，这是这只怪全部的可玩性。
    //  ⑥ 它挂在**两条**伤害路径上：这里（`attacked`，else-if 链的一格）与
    //     `monsterDamage`（`damage`，一个**独立的 if**）。两处形状不同，别合并。
    addPower(m.powers, "strength", -damage);
    addPower(m.powers, "shackled", damage);
  }
  // TODO(后续PR): 无敌（链的第一格，腐化之心）。第三十五批补上了反应那半格。

  m.hp -= damage;
  if (m.hp <= 0) {
    m.hp = 0;
    monsterDie(bc, m);
  } else {
    // 掉血触发（对齐 `attackedUnblockedHelper` 末尾的 `onHpLost`，Monster.cpp:462）。
    // ⚠ 只在**没被打死**时跑：被打死走 die，大史莱姆被一击秒到 0 血就不会分裂。
    monsterOnHpLost(bc, m, damage);
  }
}

/**
 * 沉睡被伤害打断（对齐 Monster.cpp:388-391 与 :448-452 那两处**一模一样**的两行）。
 *
 * ⚠ 判定点是「**未被格挡**的伤害」，不是「被攻击」：两处都住在 `attackedUnblockedHelper` /
 * `damageUnblockedHelper` 里，而调用方都有 `if (damage > 0)` 的门（damage 是**扣掉格挡之后**
 * 的值）。所以：
 *   * 打在开局那 8 点格挡上 **叫不醒它**（这是拉加维林开局那层挡真正的作用）；
 *   * 攻击与非攻击伤害（燃烧 / 主宰 / 荆棘 / 火焰药水）**都能**叫醒它——与蜷缩只挂在
 *     attacked 那条路上不同；
 *   * 被**打死**那一击不会走到这里（die 分支在后面，但清位这两行排在扣血之前，
 *     所以致命一击其实照样先清位、再死。照抄这个顺序）。
 *
 * ⚠ 两处的**形状不同**，照抄不要合并：`attackedUnblockedHelper` 里它是那条 else-if 链的
 * 一格（前面还有无敌 / 镀甲 / 蜷缩 / 飞行 / 易塑 / 荆棘），`damageUnblockedHelper` 里它是
 * 一个**独立的 if**（只有无敌那条在它前面，且不构成 else-if）。
 *
 * ⚠ 金属化是 `decrementStatus<MS::METALLICIZE>(8)`——**减 8 而不是清零**。层数恰好是 8，
 * 减完 `setHasStatus(0)` 就整条没了；已经加在身上的格挡**不退**。
 */
function wakeUpLagavulin(m: CombatMonster): void {
  if (getPower(m.powers, "asleep") > 0) {
    removePower(m.powers, "asleep");
    const metallicize = findPower(m.powers, "metallicize");
    if (metallicize !== undefined) {
      metallicize.amount -= 8;
      if (metallicize.amount === 0) {
        m.powers.splice(m.powers.indexOf(metallicize), 1);
      }
    }
  }
}

/**
 * 怪物死亡（对齐 `Monster::die`，Monster.cpp:283）。
 *
 * ⚠ **判胜那一支是 `return`，不是 `if/else` 的一半**（Monster.cpp:293-297）：最后一只怪
 * 死掉时函数当场返回，后面所有死亡触发（孢子云 / 重生 / 尸爆 / 地精角 / 活体样本）
 * **一个都不跑**。所以「秒掉场上最后一只真菌兽不会吃到易伤」是参考的行为，不是我们漏了
 * ——这也是本批唯一需要格外小心的时点：死亡触发天然只在「还有同伴活着」时才可观察。
 *
 * ⚠ 孢子云是 `addToTop` 而不是 `addToBot`（Monster.cpp:301）。可观察面：这一击若还排着
 * 别的动作（多段攻击的后续段、荆棘反伤…），易伤会插在它们**之前**生效。
 * `clearOnCombatVictory` 用的是 `Action` 的默认值 true（ActionQueue.h:22，参考那行走的是
 * 单参构造）——于是「同一批动作里后来又打死了最后一只怪」时它会被清扫掉。
 */
function monsterDie(bc: BattleContext, m: CombatMonster): void {
  m.alive = false;
  bc.monstersAlive -= 1;
  // ⚠⚠ **判胜有两个条件，不只是「清场」**（对齐 Monster.cpp:293-297）：
  //     `if (monstersAlive == 0 || hasStatus<MS::MINION_LEADER>())`
  //   第二个是第二十七批加的：地精首领带着 `MINION_LEADER`，它一死**当场判胜**——
  //   两只小鬼还站在场上、血量原样，战斗直接结束。参考没有把小鬼一起清掉，
  //   trace 里那两格照旧 `alive: true`。
  //   ⚠ 真实游戏里首领死后小鬼是**逃跑**（`Monster::escapeNext` 那一位），参考用这条
  //     「首领死 = 判胜」直接短路掉了整个过程；两者在「战斗此刻结束」这一点上同解，
  //     所以那一位在参考里永远走不到，见 TODOS「已确认但尚未打补丁」的 `escapeNext` 那条。
  //   ⚠ **背书从 4 例涨到 21 例（第三十一批）**：`@tgt1` 直接打下标最大的活怪，而地精首领
  //     恰在 3 号位——19 次胜利里有 17 次是「首领死了但小鬼还站着」（tgt0 下是 55 次里 4 次）。
  //     第二十七批那 4 例薄得几乎像巧合，现在这条路是常态。
  // ⚠⚠ **觉醒者的假死排在判胜之前，是这条链上唯一能跳过判胜的路径**（第三十七批）。
  //   对齐 Monster.cpp:285-297 那个 `if / else if`：
  //   ```cpp
  //   if (id == MonsterId::AWAKENED_ONE && !miscInfo) { // is awakened one stage 1
  //       halfDead = true;                              // todo change to status
  //       removeDebuffs();
  //       removeStatus<MS::CURIOSITY>();
  //       setMove(MonsterMoveId::AWAKENED_ONE_REBIRTH);
  //       bc.cardQueue.clear();
  //   } else if (bc.monsters.monstersAlive == 0 || hasStatus<MS::MINION_LEADER>()) {
  //       bc.outcome = Outcome::PLAYER_VICTORY;
  //       return;
  //   }
  //   ```
  // ⚠ 七处照抄：
  //  ①⚠⚠ **门是「怪种 id + `miscInfo` 为 0」，不是任何状态位**。参考自己在那行注了
  //     `// todo change to status`——它清楚这跟暗影客的 `hasStatus<REGROW>()` 形状不同，
  //     只是没改。**照抄 id 判断**，别顺手统一成一个 Power。
  //  ②⚠⚠ **它排在判胜之前，而且是 `if / else if`**：一阶段的觉醒者倒下时**根本不看
  //     `monstersAlive`**——把最后一只怪打死也不算赢。这与暗影客的重生（在判胜
  //     `return` **之后**的那条 else-if 链上，所以「同伴全死了就是真赢」）正好相反，
  //     是同一个 `halfDead` 字段的两个相反的门。
  //  ③ **二阶段走的是另一支**：复活时 `miscInfo = 1`，于是这道门为假，落到 `else if`
  //     ——而那时它身上有 `MINION_LEADER`，所以**两只邪教徒还站着也当场判胜**。
  //  ④ 清减益走的是**逐个 `removeStatus`** 的 `Monster::removeDebuffs()`（Monster.cpp:538-552，
  //     与冠军的暴怒共用 `monsterRemoveDebuffs`），
  //     **不是** `resetAllStatusEffects()`。差别是承重的：前者数值与 bit 一起归零（等价于
  //     整条摘掉），后者只清 bit、留下会被下一次 buff 继续加的残值（见 `PowerInstance.cleared`）。
  //     所以觉醒者身上**不会**出现暗影客那种「复活后虚弱从 1 继续加到 3」的现象。
  //  ⑤ 好奇心是**在 `removeDebuffs()` 之外单独摘的**（它不是减益，不在那张名单里）。
  //     ⚠ 再生 / 力量**不摘**：`removeDebuffs` 只在力量为**负**时把它归零。
  //  ⑥ 改意图用的是 **`setMove`（前移历史）**，不是 `onHpLost` 里那种裸的 `moveHistory[0] =`。
  //  ⑦⚠ **`bc.cardQueue.clear()`** 是全参考项目怪物侧唯一一次清出牌队列（另一个调用点是
  //     `Actions::ClearCardQueue`）。语义：玩家这一击若来自「一张牌排了后续出牌项」的连锁
  //     （浩劫 / 混乱 / 二连击 / 复制…），觉醒者假死的那一刻把还没打的那些**整个丢掉**。
  //     ⚠ 它排在这一格的**最后一句**，在 `setMove` 之后。
  if (m.defId === "awakened_one" && m.miscInfo === 0) {
    m.halfDead = true;
    monsterRemoveDebuffs(m);
    removePower(m.powers, "curiosity");
    setMove(m, "rebirth");
    bc.cardQueue.clear();
  } else if (bc.monstersAlive === 0 || getPower(m.powers, "minion_leader") > 0) {
    bc.outcome = "player_victory";
    return; // ★ 参考在这里 return，下面的死亡触发一概不跑
  }
  // 孢子云（真菌兽）：死亡时给玩家 2 层易伤。
  // ⚠ 层数 2 是 `die` 里**硬写**的，不读 Power 的层数（参考在 preBattleAction 那行自注
  //   「the value here isn't used. it is always 2」）。
  // ⚠ 第二个参数 `isSourceMonster` 传的是 **`bc.turnHasEnded`**，不是常量 true——
  //   而且它是 C++ 的**实参**，在建动作那一刻就求值并按值捕获，不是执行时再读。
  //   语义上就是「怪物阶段里死的算怪物来源（本回合末不递减），玩家回合里死的不算」。
  if (getPower(m.powers, "spore_cloud") > 0) {
    const isSourceMonster = bc.turnHasEnded;
    addToTop(bc, (c) => debuffPlayer(c, "vulnerable", 2, isSourceMonster));
  } else if (getPower(m.powers, "regrow") > 0) {
    // 重生（暗影客，第三十四批）：对齐 Monster.cpp:303-306 这条链的**第二格**——
    //     } else if (hasStatus<MS::REGROW>()) {
    //         resetAllStatusEffects();
    //         setMove(MMID::DARKLING_REGROW);
    //         halfDead = true;
    //     }
    // ⚠⚠ 第二十八批装停滞时特意在注释里留出的就是这一格：链是
    //   `孢子云 → 重生 → 停滞`，插在中间而不是接在末尾。
    // ⚠ 五处照抄：
    //  ①⚠⚠ `resetAllStatusEffects()` = `statusBits = 0; setStatus<STRENGTH>(0); block = 0;`
    //     （Monster.cpp:554-558）——**只清 bit、不清数值**，与「逐个 removeStatus」不是
    //     一回事。残留的层数会被下一次 `buff` / `addDebuff` 继续加上去（实测：重生前挨的
    //     1 层虚弱让复活后那张衣领上出 3 层而不是 2 层）。逐条见
    //     `resetAllMonsterStatusEffects` 与 `PowerInstance.cleared`。
    //     ⚠ 它**不碰 `miscInfo`**，所以暗影客复活后撕咬伤害还是出生时掷定的那个数。
    //  ② 改意图用的是 **`setMove`（前移历史）**，不是 `onHpLost` 里那种裸的 `moveHistory[0] =`。
    //     可观察面：被顶掉的意图退到 `moveHistory[1]`，而暗影客的出招规则读 `lastTwoMoves(NIP)`。
    //  ③ `halfDead = true`——它是 `isDeadOrEscaped` 的第三位，`alive` 已经在函数开头置 false。
    //     半死的怪**照样轮到自己的怪物回合**（`doMonsterTurn` 那道门），这正是它能复活的原因。
    //  ④ ⚠ **血量已经是 0**（调用方在进 `die` 之前就 `curHp = 0` 了），这条分支不动它；
    //     血量是复活那条 case 才写回 `maxHp / 2` 的。
    //  ⑤ ⚠⚠ **它排在判胜 `return` 之后**：最后一只暗影客倒下时 `monstersAlive == 0`，
    //     函数当场返回，这一格根本不跑——所以「三只一起打死」就是赢，不会有人重生。
    //     这与孢子云那条「亡语只在同伴还活着时才跑」是同一条总纲。
    resetAllMonsterStatusEffects(m);
    setMove(m, "darkling_regrow");
    m.halfDead = true;
  } else if (getPower(m.powers, "stasis") > 0) {
    // 停滞（青铜球，第二十八批）：把它扣住的那张牌还回手牌。
    // ⚠⚠ 它与孢子云在**同一条 else-if 链**上（Monster.cpp:299-310），中间那一格
    //   **重生**（REGROW，暗影客）第三十四批装上了，链的三格现在齐了：
    //       if (SPORE_CLOUD) … else if (REGROW) … else if (STASIS) …
    //   所以这里必须是 `else if`（一只怪不可能同时带两位，但链的形状照抄）。
    // ⚠ 还牌是**同步**的（参考那一句是裸调用 `returnStasisCard(bc);`），不是入队——
    //   于是这一击若还排着别的动作，牌在它们执行**之前**就已经回到手里了。
    returnStasisCard(bc, m);
  }
  // TODO(后续PR): 尸爆（CORPSE_EXPLOSION）——它排在这里、地精角之前，是一个**独立的 if**
  //   （Monster.cpp:312-315，`DamageAllEnemy(maxHp * 层数)`）。唯一来源是静默的牌，还没登记。
  // 地精之角（GREMLIN_HORN，第四十批）：对齐 Monster.cpp:317-320 的
  //     if (bc.player.hasRelic<RelicId::GREMLIN_HORN>()) {
  //         bc.addToBot( Actions::GainEnergy(1) );
  //         bc.addToBot( Actions::DrawCards(1) );
  //     }
  // ⚠ 四处照抄：
  //  ①⚠⚠ **它在判胜 `return` 之后**——打死场上最后一只怪时一条都不跑。所以「最后一击」
  //     永远不给能量也不抽牌，这与孢子云 / 重生 / 停滞是同一条总纲（见函数头注释）。
  //  ② **两条独立的 `addToBot`**，不是一条动作里做两件事。可观察面：一只怪死时若还排着
  //     别的动作，回能量与抽牌之间插得进东西；连死两只时顺序是「能量、抽牌、能量、抽牌」。
  //  ③ 它排在尸爆那个独立 if **之后**、活体样本**之前**，不在孢子云那条 else-if 链上
  //     ——所以带孢子云的真菌兽死掉时**两者都触发**。
  //  ④ `Actions::GainEnergy` 的函数体就是 `player.energy += amount`（Actions.cpp:155-159 →
  //     Player::gainEnergy，Player.cpp:105-107），没有任何上限或钩子。
  if (hasRelic(bc, "gremlin_horn")) {
    addToBot(bc, (c) => {
      c.player.energy += 1;
    });
    addToBot(bc, (c) => {
      drawCards(c, 1);
    });
  }
  // ⚠⚠ **活体样本（THE_SPECIMEN）故意不登记，理由不是「不在轮换里」。** 参考给它排的是
  //   `addToBot(Actions::SetState(InputState::SELECT_ENEMY_THE_SPECIMEN_APPLY_POISON))`
  //   （Monster.cpp:322-324），而那个 InputState 在**整个参考项目里只出现两次**：这一处写入，
  //   与 `InputState.h:48` 的枚举声明。没有任何 `isValidAction` / `Action::execute` /
  //   枚举器能应答它，而 `executeActions` 的主循环第一句就是
  //   `if (inputState != InputState::EXECUTING_ACTIONS) break;`（BattleContext.cpp:756-758）
  //   ——于是第一只怪一死，整场战斗**永久卡住**。
  //   它属于「参考压根没实现完」那一族（与卡牌那边的 `SEEK` 同类），**没有预言机**：
  //   给某个 variant 发这颗遗物只会让那一批 trace 在第一次怪物死亡处截断。
  //   ✅ 觉醒者的假死（`Monster::die` 的**第一个**分支）第三十七批已补，见函数开头那一格。
}

/**
 * 怪物逃离战斗（对齐 `MMID::LOOTER_ESCAPE` 那条 case，MonsterSpecific.cpp:899-909）。
 *
 * ⚠ **逃跑不是死亡**，两者在参考里是不同的位：
 *   `isDeadOrEscaped() = isDying() || isHalfDead() || isEscaping()`（Monster.cpp:253）
 * 我们的 `m.alive` 建模的正是 `!isDeadOrEscaped()`（harness 的快照字段就是这么算的），
 * 所以这里置 `alive = false`——但**生命保持原样、不为 0**，`monsterDie` 那条路
 * （亡语 / 遗物击杀响应 / 孢子云…）一概不走。逃跑之后它：
 *   * 不再行动（`doMonsterTurn` 的 `!isDeadOrEscaped()` 门）
 *   * 不能被指向、不参与 `getRandomMonsterIdx`、不吃全体伤害
 *   * `applyPreTurnLogic` / `applyEndOfRoundPowers` 两个循环都跳过它
 *   * 仍然占着数组下标，快照里照旧带着它的血量与最后一个意图
 *
 * ⚠ 判胜是**直接写 outcome**，参考在这里**没有**调 `checkCombat`——所以动作队列不被
 * `clearPostCombatActions` 清扫。当前观察不到差别（逃跑那条 case 尾部什么都不排，
 * 而主循环在进下一只怪之前已经把队列抽干了），但照抄。
 *
 * TODO(run 层): 参考的 `exitBattle` 会把「没逃掉的抢劫者」偷走的金币还给玩家
 * （`g.info.stolenGold`，BattleContext.cpp:496-508，累加在 `Monster::miscInfo` 上）。
 * 那是战斗后的奖励结算（TODOS 一.7），战斗内没有任何东西读它，故本批不建模 `miscInfo`。
 */
function monsterEscape(bc: BattleContext, m: CombatMonster): void {
  m.alive = false;
  bc.monstersAlive -= 1;
  if (bc.monstersAlive === 0) {
    bc.outcome = "player_victory";
  }
}

/**
 * 「不触发任何东西」的自杀（对齐 `Monster::suicideAction`，Monster.cpp:327-337；第三十四批）。
 *
 * ```cpp
 * void Monster::suicideAction(BattleContext &bc) {
 *     if (!isAlive()) return;                 // 调用方已判过，这里再判一次（照抄）
 *     --bc.monsters.monstersAlive;
 *     curHp = 0;
 *     if (bc.monsters.monstersAlive == 0) bc.outcome = Outcome::PLAYER_VICTORY;
 * }
 * ```
 *
 * ⚠⚠ 它是 `Actions::SuicideAction` 的 **`triggerRelics = false`** 那一支，全参考项目
 * 只有复形怪的消逝归零走到（`SuicideAction(idx, **false**)`，MonsterSpecific.cpp:1525）。
 * 与另一支（爆破怪 / 匕首的 `m.damage(bc, m.curHp)`）差四处，**别互相顶替**：
 *   ① **不扣格挡**——直接置 0；
 *   ② **不进 `Monster::die`**：重生 / 孢子云 / 停滞 / 地精角 / 活体样本一条都不跑；
 *   ③ **不走 `onHpLost`**（分裂 / 守卫者模式切换那一族）；
 *   ④ 判胜是**直接写 outcome**，后面同样**没有 `checkCombat`**——队列不被清扫
 *      （形状与 `monsterEscape` 完全相同，两者是参考里仅有的两条「不走死亡链的退场」）。
 * ⚠ `--monstersAlive` 在这里是**自己减的**（`Monster::die` 里那句在另一条路上），
 *   两条路各减一次、不会重复：这条路根本不调 `die`。
 */
function monsterSuicideNoTrigger(bc: BattleContext, m: CombatMonster): void {
  if (m.hp <= 0) {
    return;
  }
  bc.monstersAlive -= 1;
  m.hp = 0;
  m.alive = false; // 我们的 alive = `!isDeadOrEscaped()`，血归零后 `isDying()` 为真
  if (bc.monstersAlive === 0) {
    bc.outcome = "player_victory";
  }
}

/**
 * 给一名随机友军加格挡（对齐 `Actions::GainBlockRandomEnemy`，Actions.cpp:436-458）。
 *
 * 本项目**第一个「怪物 → 怪物」的效果**，四处逐位对齐点：
 *
 *  ① **候选排除自己**（`i != sourceMonster`），也排除**已死**的（`!m.isDying()`）。
 *     ⚠ 参考用的是 `isDying()`（血 ≤ 0）而**不是** `isDeadOrEscaped()`——两者只在
 *     「逃跑 / 假死」时分岔，而地精帮里没有这两种怪，所以当前用 `m.alive`
 *     （= `!isDeadOrEscaped()`）与参考等价。以后若出现「逃跑的同伴还能被加格挡」的编队，
 *     这里要拆开成两个谓词。
 *  ② **候选为空时目标是自己**，而且那一支**一次 aiRng 都不掷**。护盾地精落单时走的就是它
 *     ——不过它一落单就会被 `MOVE_TURN_END` 改成盾击，所以这一支只在「排队时还有同伴、
 *     出队时同伴已死」的窄缝里出现。
 *  ③ 掷的是 `aiRng.random(validCount - 1)`（**闭区间上界**），不是 `random(validCount)`。
 *  ④ 加格挡走的是 `Monster::addBlock`，**不过** `calculateCardBlock`——怪物没有敏捷/脆弱。
 */
function gainBlockRandomEnemy(bc: BattleContext, sourceIdx: number, amount: number): void {
  const validIdxs: number[] = [];
  for (let i = 0; i < bc.monsters.length; i += 1) {
    if (i !== sourceIdx && bc.monsters[i]?.alive === true) {
      validIdxs.push(i);
    }
  }
  let targetIdx: number;
  if (validIdxs.length > 0) {
    targetIdx = validIdxs[bc.rng.aiRng.random(validIdxs.length - 1)]!; // ★ 消耗一次 aiRng
  } else {
    targetIdx = sourceIdx; // 没有同伴时给自己，**不掷** aiRng
  }
  const target = bc.monsters[targetIdx];
  if (target !== undefined) {
    target.block += amount;
  }
}

/**
 * 反应触发的重滚意图（对齐 `Actions::ReactiveRollMove`，Actions.cpp:133-142；第三十五批）。
 *
 * ```cpp
 * Action Actions::ReactiveRollMove() {
 *     return {[=] (BattleContext &bc) {
 *         // writhing mass is always monster 0
 *         Monster &m = bc.monsters.arr[0];
 *         for (int i = 0 ; i < m.getStatus<MS::REACTIVE>(); ++i) {
 *             m.rollMove(bc);
 *         }
 *         m.setStatus<MS::REACTIVE>(0);
 *     }};
 * }
 * ```
 *
 * ⚠ 四处照抄：
 *  ①⚠⚠ **目标写死 0 号位**，参考在那行自注 `// writhing mass is always monster 0`。
 *     它不查这只怪是不是排这条动作的那只、也不判死活。当前唯一的宿主是单怪编队
 *     `WRITHING_MASS`，所以两者同解；照抄写死的形状，别改成 `indexOf(m)`。
 *  ② 循环次数是**执行那一刻**的层数（这一波攒了几击就滚几次），而不是排队时的 1。
 *     每一次都是**真的 `rollMove`**：掷 `aiRng.random(99)` 走出招规则（那条规则自己还可能
 *     再追加若干次 aiRng），并且 `setMove` **推进 moveHistory**。
 *  ③ 层数在循环**结束后**才清零，所以循环条件每次重读也不会变（`rollMove` 不碰反应）。
 *  ④ 清零走 `setStatus`（**只写数值、不清 statusBits**），所以这条 Power 永不摘除
 *     ——下一次挨打照样从 0 → 1 重新入队。这与镀甲的 `decrementStatus` 正相反。
 * ⚠ 它是 `Action(ActionFunction)` 单参构造 → `clearOnCombatVictory` 取默认的 **true**，
 *   所以打死蠕动血块的那一击排下的这条动作会被 `checkCombat` 清掉，层数停在 1。
 */
function reactiveRollMove(bc: BattleContext): void {
  const m = bc.monsters[0];
  if (m === undefined) {
    return;
  }
  const reactive = findPower(m.powers, "reactive");
  if (reactive === undefined) {
    return;
  }
  for (let i = 0; i < reactive.amount; i += 1) {
    rollMove(bc, m); // ★ 每次至少消耗一次 aiRng（真 rollMove，会推进 moveHistory）
  }
  reactive.amount = 0; // setStatus：只写数值、不清 bit
}

/** 对齐 BattleContext::checkCombat：胜利时清扫「战斗后不该再跑」的排队动作。 */
function checkCombat(bc: BattleContext): void {
  if (bc.outcome === "player_victory") {
    bc.cardQueue.clear();
    bc.actionQueue.clearOnCombatVictory();
  }
}

/**
 * 玩家获得格挡（对齐 Player::gainBlock，Player.cpp:68）。
 *
 * 全项目**唯一**的加格挡入口：参考里 `Actions::GainBlock` 与 `EntrenchAction` 都走它，
 * 只有锚（`p.block += 10`，BattleContext.cpp:226）直接改字段绕开——所以锚**不触发主宰**。
 *
 * ⚠ 主宰挂在这里，位置照抄：`amount <= 0` 的提前返回排在它**之前**，所以「加 0 点格挡」
 * 不触发主宰。这不是空谈——无法格挡状态下 calculateCardBlock 返回 0，防御牌就走到这条。
 * ⚠ 伤害是 `addToBot(DamageRandomEnemy(层数))`，入队而非当场打，clearOnCombatVictory
 * 是默认的 true（Actions.cpp:343，参考在那行直接注了 `// juggernaut`）。
 */
function gainBlock(bc: BattleContext, amount: number): void {
  if (amount <= 0) {
    return;
  }
  bc.player.block += amount;
  const juggernaut = getPower(bc.player.powers, "juggernaut");
  if (juggernaut > 0) {
    addToBot(bc, (c) => damageRandomEnemy(c, juggernaut));
  }
}

/**
 * 对随机敌人造成**非攻击**伤害（对齐 Actions::DamageRandomEnemy，Actions.cpp:343）。
 *
 * ⚠ 三处：① 走 Monster::damage 而非 attacked，故不触发蜷缩；② 伤害是调用方给的固定值，
 * **不过** calculateCardDamage（力量/易伤都不参与）；③ 全灭时 getRandomMonsterIdx 返回 -1
 * 并**不掷 RNG**，所以要先判 monstersAlive（与回旋镖同款）。
 */
function damageRandomEnemy(bc: BattleContext, damage: number): void {
  if (bc.monstersAlive === 0) {
    return;
  }
  const idx = getRandomMonsterIdx(bc); // ★ 消耗一次 cardRandomRng
  monsterDamage(bc, idx, damage);
  checkCombat(bc);
}

/**
 * 对齐 BattleContext::debuffEnemy → Monster::addDebuff：神器优先抵消一层。
 *
 * ⚠ justApplied 只在 **isSourceMonster 为真**且为虚弱/易伤时设置（Monster.h:318）。
 * 玩家打牌施加的减益走 isSourceMonster=false，**不跳过**首次递减——即痛击的易伤
 * 在同一回合末就从 2 减到 1。
 */
function debuffEnemy(
  bc: BattleContext,
  idx: number,
  power: string,
  amount: number,
  isSourceMonster = false,
): void {
  const m = bc.monsters[idx];
  // ⚠ 不能加存活判断：参考的 debuffEnemy 只有神器那一道拦截，对已死的怪照样落减益
  //（AttackEnemy 才会 isDeadOrEscaped 提前返回）。加了会让「痛击击杀」少一层易伤。
  if (m === undefined) {
    return;
  }
  const artifact = findPower(m.powers, "artifact");
  if (artifact !== undefined && artifact.amount > 0) {
    artifact.amount -= 1;
    return;
  }
  addPower(m.powers, power, amount);
  if (isSourceMonster && (power === "weak" || power === "vulnerable")) {
    const p = findPower(m.powers, power);
    if (p !== undefined) {
      p.justApplied = true;
    }
  }
  // 冠军腰带（CHAMPION_BELT，第四十三批）：对齐 `BattleContext::debuffEnemy` 的**最后一句**
  // （BattleContext.h:294-296）：
  //     if (s == MS::VULNERABLE && player.hasRelic<RelicId::CHAMPION_BELT>()) {
  //         addToBot(Actions::DebuffEnemy<MS::WEAK>(idx, 1, false) );
  //     }
  // ⚠ 五处照抄：
  //  ①⚠⚠ **它在神器那道门的下方**——被神器吃掉的那次易伤**不会**带出虚弱（提前 return 了）。
  //  ②⚠ 它**不管来源**：怪物给玩家上易伤走的是 `Player::debuff`（另一个函数），
  //     但**怪物给怪物**、以及玩家的牌/遗物给怪物的易伤都会走到这里。
  //  ③ 虚弱是 `addToBot`（入队）而易伤本身是同步落下的——所以同一批动作里排在中间的
  //     效果先跑，虚弱最后才上。
  //  ④ 层数写死 **1**，与触发它的那次易伤的层数无关。
  //  ⑤ `isSourceMonster = false`，所以这层虚弱**本回合末就开始递减**。
  //  ⚠ 递归安全：这条排的是虚弱，虚弱不会再触发它。
  if (power === "vulnerable" && hasRelic(bc, "champion_belt")) {
    addToBot(bc, (c) => debuffEnemy(c, idx, "weak", 1, false));
  }
}

/**
 * 给某个敌人**加**一个 Power（对齐 `Actions::BuffEnemy` → `Monster::buff`，
 * BattleContext.h:251 / Monster.h:504）。
 *
 * ⚠ 与 `debuffEnemy` 的两处关键区别，都不是风格问题：
 *  ① **不过神器**——`Monster::buff` 里没有任何神器拦截，那道门只在 `addDebuff` 里。
 *  ② **不判存活**（参考在那行自注 `// todo check if alive?`），所以已死的怪照样落 Power。
 */
function buffEnemy(bc: BattleContext, idx: number, power: string, amount: number): void {
  const m = bc.monsters[idx];
  if (m === undefined) {
    return;
  }
  addPower(m.powers, power, amount);
}

/**
 * 对全体敌人施加减益（对齐 Actions::DebuffAllEnemy）。
 *
 * ⚠ 形状照抄：外层一个 addToBot，内层从**末尾往前** addToTop，于是最终按下标升序落到
 * 各怪身上。改成正序 addToBot 在多怪场景下结算顺序就反了（参考的注释自嘲这是 workaround，
 * 但它决定了可观察顺序，必须照抄）。
 */
function debuffAllEnemies(bc: BattleContext, power: string, amount: number): void {
  addToBot(bc, (c) => {
    for (let i = c.monsters.length - 1; i >= 0; i -= 1) {
      if (c.monsters[i]?.alive === true) {
        addToTop(c, (c2) => debuffEnemy(c2, i, power, amount, false));
      }
    }
  });
}

/** 回合末递减一层减益，减到 0 则移除（对齐 decrementStatus + hasStatus 清零）。 */
function decrementDebuff(m: CombatMonster, id: string): void {
  const p = findPower(m.powers, id);
  if (p === undefined) {
    return;
  }
  if (p.justApplied === true) {
    p.justApplied = false; // 施加当回合跳过（仅怪物来源的减益会走到这里）
    return;
  }
  p.amount -= 1;
  if (p.amount <= 0) {
    m.powers.splice(m.powers.indexOf(p), 1);
  }
}

// ============================================================================
// 卡牌行为（逐卡转写自参考 useAttackCard / useSkillCard 的 switch 分支）
//
// 关键语义：伤害/格挡在**入队时**就用当时的状态算好并捕获，不在执行时再算
// （对齐 `addToBot(Actions::AttackEnemy(t, calculateCardDamage(..., card)))`）。
// 故痛击的易伤只影响其后打出的牌，不影响痛击自身那一击。
// ============================================================================

// ============================================================================
// 战斗内遗物（对齐 BattleContext::initRelics）
//
// initRelics 是**两遍**：第一遍立即改属性；随后把开局抽牌入队；第二遍
// atBattleStart 的效果也入队——所以它们在开局抽牌**之后**才结算。
// 顺序错了（比如先上易伤再抽牌）在多数场景下看不出来，但会错。
// ============================================================================

/**
 * 「玩家身上还有没有这颗遗物」（对齐 `Player::hasRelic<X>()`，Player.h:462）。
 *
 * ⚠⚠ 读的是 `player.relicBits`，**不是**遗物容器 `bc.relics`。两者在 `initRelics` 的第一句
 * 同步一次，此后有四处只改前者：御守 / 蜥蜴尾的 `setHasRelic<X>(r.data)`（data 0 = 清位）、
 * 蜥蜴尾复活用掉、百年拼图触发过一次。用容器判会让这四处**静默失效**。
 */
export function hasRelic(bc: BattleContext, id: string): boolean {
  return bc.player.relicBits.includes(id);
}

/** 对齐 `Player::setHasRelic<X>(value)`（Player.h:445）——只写玩家那份位集合，不动容器。 */
function setHasRelic(bc: BattleContext, id: string, value: boolean): void {
  const idx = bc.player.relicBits.indexOf(id);
  if (value) {
    if (idx < 0) {
      bc.player.relicBits.push(id);
    }
  } else if (idx >= 0) {
    bc.player.relicBits.splice(idx, 1);
  }
}

/**
 * 第一遍：立即生效的属性类。
 *
 * ⚠ 第二个参数是**这一件遗物的容器条目**（对齐参考 `for (const auto &r : gc.relics.relics)`
 * 里的那个 `r`），只有读 `r.data` 的那一族用得上，见 `CombatRelic` 的注释。
 */
/**
 * `initRelics` 里那五颗读房间类型的遗物要的上下文（第五十批）。
 *
 * ⚠ **两个字段是参考里的两个不同来源**：`room` 是 `BattleContext::init` 开头
 * `auto room = gc.curRoom;` 那个局部变量，`lastRoom` 直接读 `gc.lastRoom`（古董茶具那一格
 * 写的就是 `gc.lastRoom`，不是 `room`）。合并成一个字段会让茶具与另外四颗共用一个值。
 */
type RoomContext = { room: RoomKind; lastRoom: RoomKind };

const RELIC_IMMEDIATE: Record<
  string,
  (bc: BattleContext, relic: CombatRelic, rooms: RoomContext) => void
> = {
  vajra: (bc) => addPower(bc.player.powers, "strength", 1),
  anchor: (bc) => {
    bc.player.block += 10;
  },
  bronze_scales: (bc) => addPower(bc.player.powers, "thorns", 3),
  oddly_smooth_stone: (bc) => addPower(bc.player.powers, "dexterity", 1),
  blood_vial: (bc) => healPlayer(bc, 2),
  lantern: (bc) => {
    bc.player.energy += 1;
  },
  // —— 第四十九批：三颗「`initRelics` 一句话」的遗物 ——
  //
  // 杜乌娃娃（DU_VU_DOLL）与巨铃（GIRYA）在参考里是**逐字相同的一句**
  // （`BattleContext.cpp:268-270` / `:280-282`，两格只差 case 标签）：
  //     p.buff<PS::STRENGTH>(r.data);
  // ⚠⚠ **两颗都读 `r.data`，而 `data` 的语义完全不同**：娃娃是「牌组里诅咒的张数」、
  //   巨铃是「已经举过几次（0~3）」。战斗内**看不出这个区别**——这一格只看数值。
  //   两者因此必须**分到两个 variant**才分得开谁给了多少力量（本批 `@relic13` 只带娃娃、
  //   `@relic14` 只带巨铃，各自的 `data` 也取了不同的值 3 / 2）。
  // ⚠ 是**同步** buff（没有 addToBot），属于 `initRelics` 第一遍，所以开局第一帧就带着力量。
  // ⚠ `data = 0` 时这一格是**空操作**（`buff(0)`）——那不是「没实现」，是参考的实际行为。
  du_vu_doll: (bc, relic) => addPower(bc.player.powers, "strength", relic.data),
  girya: (bc, relic) => addPower(bc.player.powers, "strength", relic.data),
  // 达摩鲁（DAMARU）：`BattleContext.cpp:260-262` 的 `p.buff<PS::MANTRA>(1);`。
  // ⚠⚠ **它是硫磺那一族：同一颗遗物有两个时点**，另一处在 `applyStartOfTurnRelics`
  //   （见 `RELIC_AT_TURN_START` 的那一格）。`init` 不走 `afterMonsterTurns`，所以
  //   这一处覆盖第 1 回合、那一处覆盖第 2 回合起。少写任一处不会报错，只会每回合少一层。
  // ⚠ **两处的形状不同，别照抄邻居**：这一处是**同步** `buff`，那一处是
  //   `addToBot(Actions::BuffPlayer<PS::MANTRA>(1))`。硫磺那一对是两处都同步，
  //   快乐花 / 熏香炉那两对也是「同步 vs 入队」各一处——三对形状两两不同，逐处照抄。
  // ⚠ 平静姿态那一半**参考没实现**（`Player.cpp:515` 自注 `// todo handle mantra change
  //   stance`），所以专注层数会一路涨上去、永远不触发姿态切换。**照抄，不要补**——
  //   补它没有预言机，预言机就是参考本身（同「好奇心」那条裁定）。
  damaru: (bc) => addPower(bc.player.powers, "mantra", 1),
  // —— 第五十批：五颗**读房间类型**的遗物 ——
  //
  // 它们在第四十三批的排除表里躺了七批，理由是「读 `gc.curRoom` / `gc.lastRoom`，而 harness
  // 从没设过这两个字段（恒 `Room::INVALID`）⇒ 结构性盲区」。本批给 harness 的 `DeckVariant`
  // 加了一个 `Room` 字段（与 `ascension` 同一个「默认值保持字节不变」的套路），前提到期，
  // **一次开五颗**。
  //
  // 缩放仪（PANTOGRAPH，`:310-314`）：`if (room == Room::BOSS) p.heal(25);`
  // ⚠ 是 `heal` 不是 `增加上限`；满血时它是空操作（本批的 `@relic21` 特意让玩家带伤进场）。
  pantograph: (bc, _relic, rooms) => {
    if (rooms.room === "boss") {
      healPlayer(bc, 25);
    }
  },
  // 昆虫标本（PRESERVED_INSECT，`:316-322`）：精英房里**全体怪物**掉到 75% 血。
  // ⚠⚠ **循环没有任何过滤**——裸的 `i < monsterCount`，与贤者之石 / 尼奥之殇同族、
  //   与硫磺的 `isTargetable()` 相反。所以**预留但从没构造过的空格也会被写**
  //   （`maxHp = 0` ⇒ `curHp = 0`，那一格因此从「非死非活」变成 `isDying()` 为真）。
  // ⚠ 取整是 C++ 的 `static_cast<int>(m.maxHp * .75)`——**向零截断**的 float 乘法，
  //   不是四舍五入、也不是整数除法。`Math.trunc` 照抄。
  preserved_insect: (bc, _relic, rooms) => {
    if (rooms.room === "elite") {
      for (const m of bc.monsters) {
        m.hp = Math.trunc(m.maxHp * 0.75);
      }
    }
  },
  // 奴隶主颈圈（SLAVERS_COLLAR，`:334-338`）：精英**或** Boss 房 +1 每回合能量。
  // ⚠ 门是**析取**（`ELITE || BOSS`），本批用两个 variant（`@relic20` 精英 / `@relic21` Boss）
  //   把两条都点亮——只测一边的话「把 `||` 写成只判其中一个」有一半观察不到。
  slavers_collar: (bc, _relic, rooms) => {
    if (rooms.room === "elite" || rooms.room === "boss") {
      bc.player.energyPerTurn += 1;
    }
  },
  // 勇气投索（SLING_OF_COURAGE，`:340-344`）：**只有精英房** +2 力量。
  // ⚠ 它与颈圈并排放着、只差 Boss 那一项——`@relic21`（Boss 房）里颈圈生效而投索不生效，
  //   这一对是「两条门写串了」的关门条件。
  sling_of_courage: (bc, _relic, rooms) => {
    if (rooms.room === "elite") {
      addPower(bc.player.powers, "strength", 2);
    }
  },
  // 古董茶具（ANCIENT_TEA_SET，`:230-234`）：**上一个房间**是篝火就 +2 能量。
  // ⚠⚠ 它读的是 `gc.lastRoom`，与上面四颗读的 `room` 是**两个不同的字段**。
  // ⚠ 是 `p.gainEnergy(2)`（当前回合的能量），不是 `energyPerTurn++`——只给第一回合。
  ancient_tea_set: (bc, _relic, rooms) => {
    if (rooms.lastRoom === "rest") {
      bc.player.energy += 2;
    }
  },
  // 贤者之石（第四十批）：对齐 `BattleContext::initRelics` 的那一格
  // （BattleContext.cpp:198-204）：
  //     case R::PHILOSOPHERS_STONE:
  //         for (int i = 0; i < monsters.monsterCount; ++i) {
  //             auto &m = monsters.arr[i];
  //             m.buff<MS::STRENGTH>(1);
  //         }
  //         p.energyPerTurn++;
  //         break;
  // ⚠ 四处照抄：
  //  ①⚠⚠ **循环没有任何过滤**——不是 `isTargetable()`、不是 `isAlive()`，而是裸的
  //     `i < monsterCount`。所以**预留但从没构造过的空格也会 +1 力量**：地精首领的 0 号位、
  //     青铜自动机的 0/2、收藏家的 0/1、蜥蜴法师的 0/3。参考那些格子里躺着默认构造的
  //     `Monster`，`buff` 照样写它的 strength 字段，而 harness 的快照按 `monsterCount`
  //     逐格 dump（`"id":"INVALID = 0"` 那一格会带上 `"STRENGTH":1`）。
  //     ⚠ 隔壁那一格是反例：`R::BRIMSTONE` 的同型循环写的是 `if (m.isTargetable())`
  //     （BattleContext.cpp:126-133）。**两个都在同一个 switch 里，逐条看清用的是哪个。**
  //  ② **时点在怪物建好之后**：`BattleContext::init` 的顺序是 `monsters.init` →
  //     `cards.init` → `initRelics`（BattleContext.cpp:56/69/71），所以开局那一帧就带着力量。
  //  ③ 是**同步** buff（这一格里一个 addToBot 都没有），属于 initRelics 的**第一遍**。
  //  ④ `energyPerTurn++` 而不是 `energy++`：`init` 末尾那句 `player.energy += energyPerTurn`
  //     排在 initRelics 之后，所以第一回合也吃得到；灯笼那条才是「只加这一回合」。
  philosophers_stone: (bc) => {
    for (const m of bc.monsters) {
      addPower(m.powers, "strength", 1);
    }
    bc.player.energyPerTurn += 1;
  },
  // 硫磺（BRIMSTONE，第四十一批）：对齐 `BattleContext::initRelics` 的那一格
  // （BattleContext.cpp:126-134）：
  //     case R::BRIMSTONE:
  //         p.buff<PS::STRENGTH>(2);
  //         for (int i = 0; i < monsters.monsterCount; ++i) {
  //             Monster &m = monsters.arr[i];
  //             if (m.isTargetable()) {
  //                 m.buff<MS::STRENGTH>(1);
  //             }
  //         }
  //         break;
  // ⚠⚠ **这一格是贤者之石那一格的对照，两者在同一个 switch 里、循环形状一模一样，
  //    只有过滤器不同**：硫磺写 `if (m.isTargetable())`，贤者之石是裸的 `i < monsterCount`。
  //    `Monster::isTargetable()` 就是 `!isDeadOrEscaped()`（Monster.cpp:241-243），
  //    而我们的 `m.alive` 建模的正是这一位——所以这里写 `m.alive` 与参考逐位同解。
  //    **可观察面只有一处**：地精首领 / 青铜自动机 / 收藏家 / 蜥蜴法师那些「预留但从没
  //    构造过」的格子（`curHp` 为 0 → `isDying()` 为真 → 不可指向）。别的编队两种写法同解。
  // ⚠ 玩家那 2 点力量排在怪物循环**之前**，照抄（当前不可观察：两边都是同步写快照字段）。
  // ⚠⚠ **硫磺有第二个读点，而且那才是真实游戏卡面描述的那一条**：
  //    `Player::applyStartOfTurnRelics`（Player.cpp:497-505）每个玩家回合开始重复同样的
  //    函数体。initRelics 覆盖第 1 回合，回合开始那处覆盖第 2 回合起——**两处缺一不可**，
  //    见 `applyStartOfTurnRelics`。
  brimstone: (bc) => {
    addPower(bc.player.powers, "strength", 2);
    for (const m of bc.monsters) {
      if (m.alive) {
        addPower(m.powers, "strength", 1);
      }
    }
  },
  // 墨水瓶（INK_BOTTLE，第四十二批）：对齐 `BattleContext::initRelics` 的那一格
  // （BattleContext.cpp:164-165）：
  //     case R::INK_BOTTLE:
  //         p.inkBottleCounter = r.data;
  //         break;
  // ⚠⚠ 它**不是效果**，是把 run 层存下来的计数器搬进战斗。配对的写回在
  //   `BattleContext::updateRelicsOnExit`（`r.data = player.inkBottleCounter`，:532-533）
  //   ——所以真实 run 里这个计数器**跨战斗延续**，只有刚拿到的墨水瓶才从 0 开始。
  // ✅ **第四十四批把 `data` 接上了**：`bc.relics` 带 `{id, data}`、`settleCombat` 走
  //   `updateRelicsOnExit` 写回 run 层的 `RelicState.counter`。此前这里只能写 0
  //   （harness 发的 `RelicSpec.data` 对墨水瓶恰好也是 0，所以 trace 侧逐位一致）。
  //   ⚠ 至今**没有任何 variant 给墨水瓶发非 0 的 data**，所以「读 data」这一句在对拍上
  //   仍然是 0 例；守它的是 `sts-combat-wiring.test.ts` 的往返用例。
  ink_bottle: (bc, relic) => {
    bc.player.inkBottleCounter = relic.data;
  },
  // —— 第四十三批：`initRelics` 第一遍里的「一两行开局效果」族 ——
  //
  // ⚠⚠ 下面五颗**函数体逐字相同**（`p.energyPerTurn++`），在参考里是五个独立的 case
  //   （BattleContext.cpp:244 / :248 / :256 / :276 / :206）。合并成一条「五选一」的写法
  //   在数值上同解，但会让「漏抄其中一颗」变得不可观察——保持五条各自独立。
  // ⚠ `energyPerTurn++` 而不是 `energy++`：`BattleContext::init` 末尾那句
  //   `player.energy += player.energyPerTurn` 排在 `initRelics` 之后，所以第一回合也吃得到，
  //   而且此后**每回合**都多一点（灯笼那条 `gainEnergy(1)` 才是「只加这一回合」）。
  //   两者的差别在第 2 回合的快照上当场可见。
  // ⚠ 这五颗在真实游戏里各带一条**战斗外**的代价（破损王冠少一张奖励牌、咖啡滤压壶不能休息、
  //   诅咒钥匙开箱得诅咒、融合锤不能锻造、如尼圆顶看不到意图），参考一条都没实现——
  //   预言机只认这一句，照抄。
  busted_crown: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  coffee_dripper: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  cursed_key: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  fusion_hammer: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  // 如尼圆顶（RUNIC_DOME，BattleContext.cpp:206-208）。⚠ 卡面的「看不到敌人意图」在参考里
  // **没有任何实现**（`R::RUNIC_DOME` 全项目只有这一处），而 harness 的快照是直接 dump
  // `moveHistory[0]` 的——所以它在 trace 里就只是 +1 能量。照抄参考。
  runic_dome: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  // 诱变强化剂（MUTAGENIC_STRENGTH，BattleContext.cpp:288-291）：
  //     case R::MUTAGENIC_STRENGTH: // this appears to be applied before clockwork if it was acquired first
  //         p.buff<PS::STRENGTH>(3);
  //         p.debuff<PS::LOSE_STRENGTH>(3);
  //         break;
  // ⚠ 三处照抄：
  //  ①⚠ **加力量走 `buff`、还债走 `debuff`**——两个方向的函数不同，而 `Player::debuff`
  //     里有神器那道门。所以「开局带神器」时这 3 层 LOSE_STRENGTH 会被神器吃掉，
  //     玩家白赚 3 点力量（真实游戏同此，参考那句注释说的正是这个获得顺序问题）。
  //  ② 还债在**第一个玩家回合末**结算（`applyEndOfTurnPowers` 的 LOSE_STRENGTH=14 那一格），
  //     不是「下一回合开始」。
  //  ③ 快照里开局那一帧同时有 `STRENGTH: 3` 与 `LOSE_STRENGTH: 3`。
  mutagenic_strength: (bc) => {
    addPower(bc.player.powers, "strength", 3);
    debuffPlayer(bc, "lose_strength", 3);
  },
  // 石化螺旋（FOSSILIZED_HELIX，BattleContext.cpp:272-274）：`p.buff<PS::BUFFER>(1)`。
  // ⚠ 缓冲的两个读点在 `Player::damage`（:196-199）与 `Player::attacked`（:220-224），
  //   见 `damagePlayerNonAttack` / `dealDamageToPlayer` 里那两段——两处的**位置不同**。
  fossilized_helix: (bc) => addPower(bc.player.powers, "buffer", 1),
  // 数据磁盘（DATA_DISK，BattleContext.cpp:264-266）：`p.buff<PS::FOCUS>(1)`。
  // ⚠⚠ **聚焦在参考里战斗内一次都不被读**：它是 `Player` 的一个独立 int 字段
  //   （与力量/敏捷/神器同族，Player.h:188/240/274），唯一的读者是偏移（BIAS）那条
  //   `DecrementStatus<FOCUS>`（Player.cpp:577-579），而偏移全项目没有产出者。
  //   它的全部可观察面是**快照里那一条 `FOCUS: 1`**（harness 的 `playerStatusValue`
  //   照样输出它）——与孢子云那 2 层同族：层数不被读，但漏了当场红。
  data_disk: (bc) => addPower(bc.player.powers, "focus", 1),
  // 线与针（THREAD_AND_NEEDLE，BattleContext.cpp:354-356）：`p.buff<PS::PLATED_ARMOR>(4)`。
  // ⚠⚠ 这是**玩家侧**的镀甲，与带壳寄生虫那条**怪物侧**的是两套代码，只是共用一个 Power id：
  //   * 回合末加格挡：`callEndOfTurnActions` 里紧接金属化之后的那一句（BattleContext.cpp:2100）；
  //   * 递减：`Player::attacked` 的 `if (damage > 0)` 分支里（Player.cpp:245-247），
  //     **只有攻击伤害且真的破了格挡**才减——非攻击伤害（燃烧 / 荆棘 / 束缚）不减。
  //     这与怪物侧那条「在 else-if 链上、且带 `SHELLED_PARASITE` 特例」的形状完全不同。
  thread_and_needle: (bc) => addPower(bc.player.powers, "plated_armor", 4),

  // ==========================================================================
  // 第四十四批 · 甲：读 `r.data` 的那一族（`initRelics` 那一半）
  // ==========================================================================
  //
  // ⚠⚠ 这一族的共同形状是「把 run 层的计数器搬进 `Player` 的某个字段」，配对的写回在
  //   `updateRelicsOnExit`。**六颗的写法两两都不同**，别照着邻居抄：
  //     快乐花   `= r.data + 1` 之后 `if (counter == 3)`      —— 先加 1，再判
  //     熏香炉   `= r.data`     之后 `if (++counter == 6)`     —— 先赋值，再自增判
  //     墨水瓶   `= r.data`                                    —— 光搬，不判（第四十二批）
  //     双节棍   `= r.data`                                    —— 光搬，不判
  //     日晷     `= r.data`                                    —— 光搬，不判
  //     笔尖     `if (r.data == 9) {上一层 Power; = -1} else = r.data`
  //   快乐花与熏香炉的**数值终态相同**（都等于「data + 1」），写法却不同——照抄各自的。

  // 快乐花（HAPPY_FLOWER，BattleContext.cpp:148-154）：
  //     case R::HAPPY_FLOWER:
  //         player.happyFlowerCounter = r.data + 1;
  //         if (player.happyFlowerCounter == 3) {
  //             ++player.energy;
  //             player.happyFlowerCounter = 0;
  //         }
  //         break;
  // ⚠ 四处照抄：
  //  ①⚠⚠ **那个 `+1` 非直觉但必须照抄**：卡面是「每 3 个回合获得 1 点能量」，而开局这一下
  //     算「第 1 个回合」。写成 `= r.data` 会让整场的能量全部晚一个回合。
  //  ②⚠ **这里是 `++player.energy`（同步、直接加 energy）**，而回合开始那一处是
  //     `addToBot(Actions::GainEnergy(1))`（**入队**）。同一颗遗物两处两种写法，照抄。
  //  ③⚠ **是 `energy` 而不是 `energyPerTurn`**：只加这一回合，与灯笼同族。
  //  ④ `== 3` 配合「命中就归零」，所以 data 只可能是 0/1/2；`>= 3` 在正常路径上同解，
  //     但那是巧合。
  happy_flower: (bc, relic) => {
    bc.player.happyFlowerCounter = relic.data + 1;
    if (bc.player.happyFlowerCounter === 3) {
      bc.player.energy += 1;
      bc.player.happyFlowerCounter = 0;
    }
  },
  // 熏香炉（INCENSE_BURNER，BattleContext.cpp:156-162）：
  //     case R::INCENSE_BURNER:
  //         p.incenseBurnerCounter = r.data;
  //         if (++p.incenseBurnerCounter == 6) {
  //             p.incenseBurnerCounter = 0;
  //             p.buff<PS::INTANGIBLE>(1);
  //         }
  //         break;
  // ⚠ 三处照抄：
  //  ① **先赋值再自增**（净效果 = data + 1），与快乐花的 `= data + 1` 数值同解、写法不同。
  //  ②⚠ **这里是同步 `buff<INTANGIBLE>(1)`**，回合开始那一处是
  //     `addToBot(Actions::BuffPlayer<PS::INTANGIBLE>(1))`（入队）。又一对「两处两种写法」。
  //  ③ 玩家侧的虚无缥缈（INTANGIBLE）：两条伤害入口各把伤害压成 1，回合末递减
  //     （与怪物侧那份共用同一个 Power id，第三十六批已铺好）。
  incense_burner: (bc, relic) => {
    bc.player.incenseBurnerCounter = relic.data;
    bc.player.incenseBurnerCounter += 1;
    if (bc.player.incenseBurnerCounter === 6) {
      bc.player.incenseBurnerCounter = 0;
      addPower(bc.player.powers, "intangible", 1);
    }
  },
  // 双节棍（NUNCHAKU，BattleContext.cpp:181-183）：`p.nunchakuCounter = r.data;`
  // ⚠ 光搬计数器，一个判断都没有。第二处在 `onUseAttackCard`（:1740-1745），见那里。
  nunchaku: (bc, relic) => {
    bc.player.nunchakuCounter = relic.data;
  },
  // 日晷（SUNDIAL，BattleContext.cpp:218-220）：`p.sundialCounter = r.data;`
  // ⚠ 第二处在 `BattleContext::onShuffle`（:2835-2842），见那里。
  sundial: (bc, relic) => {
    bc.player.sundialCounter = relic.data;
  },
  // 笔尖（PEN_NIB，BattleContext.cpp:189-196）：
  //     case R::PEN_NIB:
  //         if (r.data == 9) {
  //             p.buff<PS::PEN_NIB>(1);
  //             p.penNibCounter = -1;
  //         } else {
  //             p.penNibCounter = r.data;
  //         }
  //         break;
  // ⚠ 三处照抄：
  //  ①⚠⚠ **`== 9` 这一支是「上一场战斗把它攒满了」**：`updateRelicsOnExit` 把 -1 写回成 9
  //     （参考自注 `// possible bug`），于是下一场开局直接带一层笔尖 Power 进场。
  //     那条路只有非 0 的 `data` 才走得到——@relic12 就是为它发的 `data = 9`。
  //  ② `PEN_NIB` 是**纯 bool** Power（`Player.h:338` 那条 `setHasStatus` 名单里有它），
  //     所以 harness 输出恒是 `PEN_NIB: 1`。
  //  ③ `penNibCounter = -1` 不是「归零」：它表示「这一层已经发出去了」，
  //     之后 `onUseAttackCard` 里的 `++counter` 会把它带回 0。
  pen_nib: (bc, relic) => {
    if (relic.data === 9) {
      addPower(bc.player.powers, "pen_nib", 1);
      bc.player.penNibCounter = -1;
    } else {
      bc.player.penNibCounter = relic.data;
    }
  },
  // 蜥蜴尾（LIZARD_TAIL，BattleContext.cpp:177-179）：`p.setHasRelic<R::LIZARD_TAIL>(r.data);`
  // ⚠⚠ **这一格改的是玩家那份位集合、不是容器**，而且是**覆盖**：`data == 0`（充能用光了）
  //   的蜥蜴尾在整场战斗里等于不存在。第二处在 `Player::wouldDie`（:339-343）。
  lizard_tail: (bc, relic) => {
    setHasRelic(bc, "lizard_tail", relic.data !== 0);
  },
  // 御守（OMAMORI，BattleContext.cpp:185-187）：`p.setHasRelic<R::OMAMORI>(r.data);`
  // ⚠ 第四十批就登记了它的读点（蠕动血块的植入），但当时 `bc.relics` 还没有 `data`，
  //   那道门只能靠「id 在清单里」表达。第四十四批接上 `data` 之后语义才与参考逐位一致。
  omamori: (bc, relic) => {
    setHasRelic(bc, "omamori", relic.data !== 0);
  },
  // 尼奥的挽歌（NEOWS_LAMENT，BattleContext.cpp:293-300）：
  //     case R::NEOWS_LAMENT: // remember to decrement somewhere else
  //         if (r.data > 0) {
  //             for (int i = 0; i < monsters.monsterCount; ++i) {
  //                 Monster &m = monsters.arr[i];
  //                 m.curHp = 1;
  //             }
  //         }
  //         break;
  // ⚠ 三处照抄：
  //  ①⚠⚠ **循环没有过滤**（裸的 `i < monsterCount`，与贤者之石同族、与硫磺相反），
  //     所以**预留但从没构造过的空格也会被写成 1 点血**。那些格子在快照里带 `"hp":1`。
  //  ② **只改 `curHp`，不动 `maxHp`**——所以怪一开局就是 `1/maxHp`。
  //  ③ 递减在别处（`updateRelicsOnExit`），参考自己在行尾写了那句提醒。
  neows_lament: (bc, relic) => {
    if (relic.data > 0) {
      for (const m of bc.monsters) {
        m.hp = 1;
        // ⚠⚠ **`alive` 必须跟着刷新**：参考没有这个字段，`isDeadOrEscaped()` 是**算出来的**
        //   （`isDying()` 就是 `curHp <= 0`），而我们把它缓存成了 `m.alive`。这一格是全参考
        //   **唯一**一处「不走伤害/复活路径、直接写 `curHp`」的地方，所以也是唯一一处必须
        //   手动刷新这个投影的地方。⚠ 后果是可观察的：从没被构造过的空格（自动机的 0/2、
        //   收藏家的 0/1）`curHp` 本来是 0，被写成 1 之后**变成了可指向的活怪**，快照里
        //   `"alive": true`。⚠ 但 `monstersAlive` **一动不动**（参考同样不动它）——
        //   于是策略打死一个空格就直接判胜。
        m.alive = !(m.hp <= 0 || m.halfDead);
      }
    }
  },

  // ==========================================================================
  // 第四十四批 · 丙：`initRelics` 第一遍里的多钩子遗物（不读 data）
  // ==========================================================================

  // 赤芥子（AKABEKO，BattleContext.cpp:122-124）：`p.buff<PS::VIGOR>(8)`。
  // ⚠ 干劲（VIGOR）在 `calculateCardDamage` 里加进伤害、并在**下一张牌用掉时**摘除
  //   （`onAfterUseCard` 里那句 `if (hasStatus<VIGOR>()) removeStatus<VIGOR>()`），
  //   两处都是第九批就铺好的（干劲之刃）。所以这一颗只有这一行。
  akabeko: (bc) => addPower(bc.player.powers, "vigor", 8),
  // 史尼克之眼（SNECKO_EYE，BattleContext.cpp:210-212）：`p.debuff<PS::CONFUSED>(1)`。
  // ⚠ 三处照抄：
  //  ①⚠⚠ **它的第一个读点不在这里**：`+2 抽牌` 写在 `BattleContext::init`（:62-64），
  //     排在 `cards.init` **之前**（见 `initCombat` 里那一段）。两处缺一不可。
  //  ② 走 `debuff` ⇒ **过神器**（`Player::debuff` 的神器门在姜 / 芜菁之后）。
  //     所以「神器 + 史尼克之眼」时困惑会被吃掉一层，这是可观察的。
  //  ③ 困惑本身第二十五批就铺好了（`CardManager::draw` 的第一段，抽到的牌随机改费用、
  //     ★ 消耗 `cardRandomRng`）。史尼克之眼是它的第二个来源。
  snecko_eye: (bc) => debuffPlayer(bc, "confused", 1),
  // 蛇之指环（RING_OF_THE_SERPENT，BattleContext.cpp:325-329）：**整格是空的**——
  //     case R::RING_OF_THE_SERPENT:
  //         // now handled in battlecontext init
  //         // p.cardDrawPerTurn++;
  //         break;
  // ⚠ 唯一生效的地方是 `BattleContext::init` 的 `gc.relics.has(...)` 那一句，见 `initCombat`。
  //   这里留一个空函数是**故意的**：它让 `isRelicSupported("ring_of_the_serpent")` 为真，
  //   同时如实反映参考的形状（这一格真的什么都不做）。
  ring_of_the_serpent: () => {
    /* 空格：真正的 +1 抽牌在 BattleContext::init，见 initCombat */
  },
  // —— 三颗 `energyPerTurn++` + 一处代价 ——
  //
  // ⚠ 与第四十三批那五颗（破损王冠 / 咖啡滤压壶 / 诅咒钥匙 / 融合锤 / 如尼圆顶）不同：
  //   那五颗的代价全在战斗外、参考一行都没实现；这三颗的代价**在战斗内**，各有第二个读点。
  // 以太（ECTOPLASM，:136-138）：第二个读点在 `Player::gainGold` 的**第一句**（提前返回）。
  ectoplasm: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  // 清酒壶（SOZU，:214-216）：第二个读点在 `BattleContext::obtainPotion`（拿不到药水）。
  sozu: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  // 天鹅绒颈圈（VELVET_CHOKER，:222-224）：第二个读点在 `BattleContext::isCardPlayAllowed`
  // （本回合已打 6 张就不许再打）。
  velvet_choker: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  // 痛苦印记（MARK_OF_PAIN，:112-115）：
  //     case R::MARK_OF_PAIN:
  //         ++p.energyPerTurn;
  //         atBattleStart.push_back(r.id);
  //         break;
  // ⚠⚠ 它是全参考**唯一**一颗「第一遍改属性、同时还进 atBattleStart 队列」的遗物
  //   （别的要么只在第一遍、要么只 push）。两半都要，见 `RELIC_AT_BATTLE_START.mark_of_pain`。
  mark_of_pain: (bc) => {
    bc.player.energyPerTurn += 1;
  },
  // —— 四颗只做「进 atBattleStart 队列」的（BattleContext.cpp:102-110）——
  //
  // ⚠ 参考把它们与两个 bag_of_* 写在**同一串贯穿的 case 标签**里：
  //     case R::BAG_OF_MARBLES: case R::BAG_OF_PREPARATION: case R::CLOCKWORK_SOUVENIR:
  //     case R::GREMLIN_VISAGE: case R::RED_MASK: case R::RING_OF_THE_SNAKE:
  //     case R::TWISTED_FUNNEL:
  //         atBattleStart.push_back(r.id);
  //         break;
  //   我们这边用「在 `RELIC_AT_BATTLE_START` 里有条目」表达「进了那个队列」，所以第一遍
  //   不需要为它们写任何东西——**扭曲漏斗（TWISTED_FUNNEL）除外，它一处都没登记**，
  //   因为它排的是 `DebuffAllEnemy<MS::POISON>(4)` 而中毒这套机制还没有（毒的结算在
  //   `Monster::applyEndOfRoundPowers`，是绿色角色的整套东西）。发条纪念品 / 地精面罩 /
  //   红面具 / 蛇之戒指四颗见 `RELIC_AT_BATTLE_START`。
};

/** 第二遍：入队执行，落在开局抽牌之后。 */
const RELIC_AT_BATTLE_START: Record<string, (bc: BattleContext) => void> = {
  bag_of_marbles: (bc) =>
    addToBot(bc, (c) => {
      // 对齐 DebuffAllEnemy 的倒序 addToTop：最终按下标升序落到各怪身上。
      for (let i = c.monsters.length - 1; i >= 0; i -= 1) {
        if (c.monsters[i]?.alive === true) {
          addToTop(c, (c2) => debuffEnemy(c2, i, "vulnerable", 1, false));
        }
      }
    }),
  bag_of_preparation: (bc) => addToBot(bc, (c) => drawCards(c, 2)),

  // —— 第四十四批：atBattleStart 那一串里剩下的四颗（BattleContext.cpp:403-425）——
  //
  // ⚠⚠ **这个循环跑在开局抽牌之后**，所以它们的效果落在起手牌已经在手里之后。
  //   蛇之戒指的「额外抽 2」因此是 5 + 2 而不是「起手抽 7」——两者在洗牌顺序上同解，
  //   但在「抽牌堆空了要洗」的边界上不同，照抄参考的形状。

  // 发条纪念品（CLOCKWORK_SOUVENIR，:403-405）：`addToBot(Actions::BuffPlayer<PS::ARTIFACT>(1))`。
  // ⚠⚠ **它是第四十三批那三条盲区（姜 / 芜菁 / 冠军腰带与神器的相对顺序）的关门条件**：
  //   在它之前，玩家侧的神器只可能来自古代药水，而那几个 variant 把药水钉死了。
  // ⚠ 是**入队**的 `BuffPlayer`，不是同步 buff——与隔壁地精面罩正好相反，照抄。
  clockwork_souvenir: (bc) => addToBot(bc, (c) => addPower(c.player.powers, "artifact", 1)),
  // 地精面罩（GREMLIN_VISAGE，:407-409）：`p.debuff<PS::WEAK>(1);`
  // ⚠ 三处照抄：
  //  ①⚠⚠ **同步**（这一格里一个 addToBot 都没有），而它上下两格（发条纪念品、痛苦印记）
  //     都是入队的。**同一个 switch 里三种形状并存**，别统一。
  //  ② 走 `debuff` ⇒ 过神器，也过**姜**（虚弱免疫）。三颗一起带时姜赢。
  //  ③ `isSourceMonster` 取默认的 false ⇒ **不跳过首次递减**，所以这一层虚弱在第 1 个
  //     玩家回合末就掉掉了。
  gremlin_visage: (bc) => debuffPlayer(bc, "weak", 1),
  // 痛苦印记（MARK_OF_PAIN，:411-413）：
  //     addToBot( Actions::MakeTempCardInDrawPile( {CardId::WOUND}, 2, true) );
  // ⚠ 三处照抄：
  //  ① 两张**伤口**，塞进**抽牌堆**（不是弃牌堆），第三个实参 `shuffleIntoDrawPile = true`
  //     ⇒ ★ 每张消耗一次 `cardRandomRng`（随机插入位置）。
  //  ② 伤口打不出（状态牌、没有医疗包），只躺在牌堆快照里——覆盖表看不见它，
  //     但对拍逐帧比对牌堆内容，抄错位置当场红。
  //  ③ 它的第一半（`++energyPerTurn`）在第一遍里，见 `RELIC_IMMEDIATE.mark_of_pain`。
  mark_of_pain: (bc) => addToBot(bc, (c) => makeTempCardInDrawPile(c, "wound", 2)),
  // 红面具（RED_MASK，:415-417）：`addToBot(Actions::DebuffAllEnemy<MS::WEAK>(1));`
  // ⚠⚠ **它与紧邻的大理石袋差的不是 Power，而是那个省略掉的第二个实参**：
  //   `Actions::DebuffAllEnemy<s>(int amount, bool isSourceMonster = true)`（Actions.h:42）
  //   ——**默认是 `true`**，而大理石袋显式写了 `false`。全参考项目 10 个调用点里
  //   **只有红面具（和玩家侧的中毒那条）走默认值**，其余 8 处统统显式传 `false`。
  //   `isSourceMonster = true` ⇒ `justApplied` 置位 ⇒ **跳过第一个回合末的递减**，
  //   所以这层虚弱实际管到第 2 个玩家回合末。抄成 `false` 少一回合，实测红 **120 例**
  //   （champ 那份的全部；three_sentries 那份只有 3.7 回合、虚弱又常被怪的神器吃掉，所以没红）
  //   ——这是本批最容易照着邻居抄错的一处。
  //   遍历方向仍照抄大理石袋那条（倒序 addToTop ⇒ 最终按下标升序落地）。
  red_mask: (bc) =>
    addToBot(bc, (c) => {
      for (let i = c.monsters.length - 1; i >= 0; i -= 1) {
        if (c.monsters[i]?.alive === true) {
          addToTop(c, (c2) => debuffEnemy(c2, i, "weak", 1, true));
        }
      }
    }),
  // 蛇之戒指（RING_OF_THE_SNAKE，:419-421）：`addToBot(Actions::DrawCards(2));`
  // ⚠ 与准备袋（BAG_OF_PREPARATION）**逐字相同**，参考也是两个独立的 case。
  //   ⚠ 别与**蛇之指环**（RING_OF_THE_SERPENT，+1 每回合抽牌）搞混：两颗中文名只差一字、
  //   参考枚举名只差 SNAKE / SERPENT，效果完全不同。
  ring_of_the_snake: (bc) => addToBot(bc, (c) => drawCards(c, 2)),
};

/**
 * 战斗内有行为、但**不经过 `initRelics`** 的遗物（第四十批）。
 *
 * 参考的遗物钩子并不集中在一处：`initRelics` 只收「开局改属性 / 排一条开局动作」的那些，
 * 其余散在各自的时点上。这张表就是那些时点的索引：
 *
 * | 遗物                             | 钩子位置                                                        |
 * | -------------------------------- | --------------------------------------------------------------- |
 * | 地精之角 `gremlin_horn`          | `Monster::die` 末尾（Monster.cpp:317-320），回 1 能量 + 抽 1 张 |
 * | 手钻 `hand_drill`                | `Monster::attacked` :433 与 `Monster::damage` :488，破盾上易伤  |
 * | 御守 `omamori`                   | `WRITHING_MASS_IMPLANT`（:1541），拦住暗石护符那一支            |
 * | 暗石护符 `darkstone_periapt`     | 同上（:1543），`increaseMaxHp(6)`                                |
 * | 苦无 `kunai`                     | `onUseAttackCard` :1702，每 3 张攻击牌 +1 敏捷                  |
 * | 装饰扇 `ornamental_fan`          | `onUseAttackCard` :1714，每 3 张攻击牌 +4 格挡                  |
 * | 手里剑 `shuriken`                | `onUseAttackCard` :1718，每 3 张攻击牌 +1 力量                  |
 * | 开信刀 `letter_opener`           | `onUseSkillCard` :1828，每 3 张技能牌对全体 5 点非攻击伤害      |
 * | 橙色药丸 `orange_pellets`        | `onUse{Attack,Skill,Power}Card` :1706 / :1819 / :1897 三处置位 |
 *
 * ⚠ 贤者之石**不在**这张表里：它两头都有（`initRelics` 那一格 + 七处召唤/分裂/复活），
 * 所以走 `RELIC_IMMEDIATE` 就已经被认出来了。硫磺同理（`initRelics` + 回合开始那处），
 * **墨水瓶**同理（`initRelics` :164 搬计数器 + 四个 handler）。
 * ⚠ 橙色药丸**在**这张表里但**也在** `RELIC_AT_TURN_START` 里（回合复位那一句）——
 * 两处都登记不会重复触发，`isRelicSupported` 取的是并集。
 */
const RELIC_OTHER_HOOKS: ReadonlySet<string> = new Set([
  // 梅兰奇（MELANGE，第五十八批）：登记成**什么都不做**。
  // ⚠⚠ 参考里它唯一的读点整句被注释掉了（`BattleContext::onShuffle` :2831-2833）：
  //     if (player.hasRelic<R::MELANGE>()) {
  //   //     addToBot(Actions::SetState(InputState::SCRY, 3) ); // TODO SCRY Action
  //     }
  //   ——`if` 还在、函数体空了。**照抄「什么都不做」**，与情绪芯片（第四十九批）、
  //   好奇心（第三十七批）同一族：参考给出了答案，答案是「不做」。
  // ⚠ 它**不是**「活体样本」那一族（参考排了一个没人应答的 InputState、第一只怪一死就永久卡住），
  //   也不是「中毒」那一族（空 `Action` ⇒ `executeActions` 当场抛 `bad_function_call`）。
  //   三族的判据是**参考跑得动跑不动**：这一颗跑得动，所以它有预言机。
  // ⚠ 背书方向是**反的**：给它写任何一个真实效果（例如洗牌时抽/弃），`@relic23` 那 120 条
  //   会当场红——实测「洗牌时多抽一张」红 120 例。
  "melange",
  "gremlin_horn",
  "hand_drill",
  "omamori",
  "darkstone_periapt",
  "kunai",
  "ornamental_fan",
  "shuriken",
  "letter_opener",
  "orange_pellets",
  // —— 第四十三批 ——
  // | 遗物                       | 钩子位置                                                          |
  // | -------------------------- | ----------------------------------------------------------------- |
  // | 冠军腰带 `champion_belt`   | `debuffEnemy` 末尾（BattleContext.h:294），上易伤时附带 1 层虚弱   |
  // | 姜 `ginger`                | `Player::debuff`（Player.h:367），虚弱免疫                         |
  // | 芜菁 `turnip`              | 同上（:371），脆弱免疫                                            |
  // | 打击假人 `strike_dummy`    | `calculateCardDamage` :2708，打击牌 +3                            |
  // | 纸蛙 `paper_phrog`         | 同上 :2753，怪物易伤倍率 1.5 → 1.75                               |
  // | 纸鹤 `paper_krane`         | `Monster::calculateDamageToPlayer` :573，怪物虚弱倍率 0.75 → 0.6  |
  // | 奇特蘑菇 `odd_mushroom`    | 同上 :581，玩家易伤倍率 1.5 → 1.25                                |
  // | 靴子 `the_boot`            | `attackedUnblockedHelper` :340，1~4 点未格挡伤害抬成 5            |
  // | 鸟居 `torii`               | `Player::attacked` :235，1~5 点未格挡伤害压成 1                   |
  // | 如尼方块 `runic_cube`      | `Player::hpWasLost` :307，addToTop 抽 1                           |
  // | 自成型黏土 `self_forming_clay` | 同上 :303，`buff<NEXT_TURN_BLOCK>(3)`                         |
  // | 魔力之花 `magic_flower`    | `Player::heal` :161，回血量 ×3/2（整数除）                        |
  // | 血腥雕像 `bloody_idol`     | `Player::gainGold` :92，得金币后回 5 血                           |
  // | 鸟面坛 `bird_faced_urn`    | `onUsePowerCard` :1885，回 2 血                                   |
  // | 二元性 `duality`           | `onUseAttackCard` :1736，+1 敏捷 + 1 层敏捷流失                   |
  // | 卡戎的骨灰 `charons_ashes` | `triggerAndMoveToExhaustPile` :2850，addToTop 全体 3 点           |
  // | 奇异汤匙 `strange_spoon`   | `onAfterUseCard` :2016，消耗牌 50% 不消耗（★ cardRandomRng）       |
  // | 算盘 `the_abacus`          | `onShuffle` :2827，+6 格挡                                        |
  // | 不休陀螺 `unceasing_top`   | `executeActions` :825，手牌空时同步抽 1                           |
  // | 斗篷夹扣 `cloak_clasp`     | `callEndOfTurnActions` :2067，+手牌数格挡                         |
  // | 山铜 `orichalcum`          | 同上 :2081，无格挡时 addToTop +6                                  |
  // | 石历 `stone_calendar`      | 同上 :2087，第 7 回合末全体 52 点                                 |
  // | 卡钳 `calipers`            | `afterMonsterTurns` :2214，清格挡那条链的第三格                   |
  // | 如尼金字塔 `runic_pyramid` | `discardAtEndOfTurn` :2519，不弃手牌                              |
  // | 怀表 `pocketwatch`         | `applyStartOfTurnPostDrawRelics`（Player.cpp:663），上回合 ≤3 张抽 3 |
  // | 冰淇淋 `ice_cream`         | `Player::rechargeEnergy` :726，能量累加而不是覆盖                 |
  "champion_belt",
  "ginger",
  "turnip",
  "strike_dummy",
  "paper_phrog",
  "paper_krane",
  "odd_mushroom",
  "the_boot",
  "torii",
  "runic_cube",
  "self_forming_clay",
  "magic_flower",
  "bloody_idol",
  "bird_faced_urn",
  "duality",
  "charons_ashes",
  "strange_spoon",
  "the_abacus",
  "unceasing_top",
  "cloak_clasp",
  "orichalcum",
  "stone_calendar",
  "calipers",
  "runic_pyramid",
  "pocketwatch",
  "ice_cream",
  // —— 第四十四批 ——
  // | 遗物                         | 钩子位置                                                              |
  // | ---------------------------- | --------------------------------------------------------------------- |
  // | 钨钢棒 `tungsten_rod`        | `Player::damage` :201 / `attacked` :239 / `loseHp` :266，**三份**      |
  // | 红骷髅 `red_skull`           | `initRelics` :436 / `Player::heal` :169 / `hpWasLost` :311，**三处**   |
  // | 腕刃 `wrist_blade`           | `calculateCardDamage` :2712，0 费牌 +4                                |
  // | 百年拼图 `centennial_puzzle` | `Player::hpWasLost` :294，一次性 addToTop 抽 3                         |
  // | 绽放印记 `mark_of_the_bloom` | `Player::heal` :156 / `wouldDie` :331                                 |
  // | 神圣树皮 `sacred_bark`       | `drinkPotion` :2271（33 条 case 各一个三元式）/ `wouldDie` :332        |
  // | 以太 `ectoplasm`             | `initRelics` :136 / `Player::gainGold` :87                            |
  // | 清酒壶 `sozu`                | `initRelics` :214 / `obtainPotion` :2249                              |
  // | 天鹅绒颈圈 `velvet_choker`   | `initRelics` :222 / `isCardPlayAllowed` :726                          |
  // | 化学 X `chemical_x`          | `WhirlwindAction` :1267 / `TransmutationAction` :593                  |
  // | 木乃伊之手 `mummified_hand`  | `onUsePowerCard` :1905（技能牌那一格是空的 `// todo`）                |
  // | 死灵之书 `necronomicon`      | `onUseAttackCard` :1722 / `applyStartOfTurnRelics` :555               |
  "tungsten_rod",
  "red_skull",
  "wrist_blade",
  "centennial_puzzle",
  "mark_of_the_bloom",
  "sacred_bark",
  "ectoplasm",
  "sozu",
  "velvet_choker",
  "chemical_x",
  "mummified_hand",
  "necronomicon",
]);

function initRelics(bc: BattleContext, rooms: RoomContext): void {
  // ⚠⚠ **第一句是把容器的位拷进玩家**（对齐 `player.relicBits0 = gc.relics.relicBits0;`
  //   `BattleContext.cpp:78-79`）。它必须排在 switch **之前**：御守 / 蜥蜴尾那两格写的是
  //   `setHasRelic<X>(r.data)`，是在这份拷贝上**覆盖**——拷贝晚一步就把覆盖抹掉了。
  bc.player.relicBits = bc.relics.map((r) => r.id);
  for (const relic of bc.relics) {
    RELIC_IMMEDIATE[relic.id]?.(bc, relic, rooms);
  }
  // 开局抽牌（由调用方在此之后入队），再挂 atBattleStart。
}

function initRelicsAtBattleStart(bc: BattleContext, entryHp: number): void {
  for (const relic of bc.relics) {
    RELIC_AT_BATTLE_START[relic.id]?.(bc);
  }
  // ⚠ 参考在两个 `for (auto r : atBattleStart…)` 循环**之间**还夹着两条裸的 `if`
  //   （`BattleContext.cpp:432-438`），它们读的是 `gc.hasRelic(...)`（容器）而不是
  //   那两张 `fixed_list`——所以它们的**位置是写死的**：排在全部 atBattleStart 之后、
  //   atTurnStartPostDraw 之前，与玩家的遗物顺序无关。
  // 水银沙漏（MERCURY_HOURGLASS，第四十四批）：`addToBot(DamageAllEnemy(3))`。
  // ⚠ 它的第二个读点是 `Player::applyStartOfTurnRelics`（Player.cpp:551-553，函数体逐字相同）
  //   ——`init` 不走那条路，所以这一处覆盖第 1 回合、那一处覆盖第 2 回合起。与硫磺同族。
  if (hasRelic(bc, "mercury_hourglass")) {
    addToBot(bc, (c) => damageAllEnemiesNonAttack(c, 3));
  }
  // 红骷髅（RED_SKULL，第四十四批）的**第一个**读点（BattleContext.cpp:436-438）：
  //     if (gc.hasRelic(R::RED_SKULL) && gc.curHp <= gc.maxHp / 2) { p.buff<PS::STRENGTH>(3); }
  // ⚠ 三处照抄：
  //  ①⚠⚠ **判据读的是 `gc.curHp / gc.maxHp`（进战斗**之前**的血量），不是 `p.curHp`**。
  //     两者在这一刻几乎总是相同，唯一的分岔是**血瓶**（`initRelics` 第一遍里 `p.heal(2)`）
  //     恰好把玩家从半血以下抬到半血以上——那时参考照样给这 3 点力量。
  //     我们这边 `initCombat` 的入参 `playerHp` 就是「进战斗之前」的值，所以这里用它。
  //  ② **同步** buff，不是入队。
  //  ③ 另外两个读点在 `Player::heal`（回到半血以上就 `debuff<STRENGTH>(3)` 还债）与
  //     `Player::hpWasLost`（掉到半血及以下再 `buff<STRENGTH>(3)`），见那两个函数。
  if (hasRelic(bc, "red_skull") && entryHp <= Math.trunc(bc.player.maxHp / 2)) {
    addPower(bc.player.powers, "strength", 3);
  }
  // 第三个循环：atTurnStartPostDraw（`BattleContext.cpp:440-453`）。参考只有两颗，
  // 而且它们在**每个回合开始（抽牌之后）**还有第二份，见 `applyStartOfTurnPostDrawRelics`。
  for (const relic of bc.relics) {
    RELIC_AT_TURN_START_POST_DRAW_INIT[relic.id]?.(bc);
  }
}

/**
 * `initRelics` 的**第三个**循环（`atTurnStartPostDraw`，`BattleContext.cpp:440-453`）。
 *
 * ⚠ 它与 `applyStartOfTurnPostDrawRelics`（每回合那一份）是**两段独立的代码**，
 * 参考没有把它们合并：`init` 不走 `afterMonsterTurns`，所以这一份覆盖第 1 回合。
 * ⚠ 赌博芯片（`Actions::GambleAction`）**没有登记**：它开的是 `CardSelectTask::GAMBLE`
 * 多选屏，trace 格式表达不了，harness 在 `pickCardSelectAction` 里也没有它的分支。
 */
const RELIC_AT_TURN_START_POST_DRAW_INIT: Record<string, (bc: BattleContext) => void> = {
  warped_tongs: (bc) => addToBot(bc, (c) => upgradeRandomCardInHand(c)),
};

/**
 * 每个玩家回合开始的遗物（对齐 `Player::applyStartOfTurnRelics`，Player.cpp:490-560）。
 *
 * 本项目**第三个**遗物时点（前两个是 `initRelics` 的两遍），第四十一批为硫磺而开。
 * 调用点在 `afterMonsterTurns` 里、`applyStartOfTurnPowers` **之前**、清格挡之前
 * （对齐 BattleContext.cpp:2198）。
 *
 * ⚠⚠ **它只覆盖第 2 回合起**：`BattleContext::init` 不走 `afterMonsterTurns`，
 * 第 1 回合那一份由 `initRelics` 给。所以「每回合都有」的遗物（硫磺）必须在**两处**
 * 各写一遍，两处的函数体在参考里是逐字重复的。少写任一处都不会报错，只会静默少一次。
 *
 * ⚠ 参考在这个函数里还有一整串未登记的遗物，登记它们时注意两条已经看清的时序：
 *  * **战争艺术**读 `attacksPlayedThisTurn == 0`，而三个计数器的清零排在
 *    这个函数**之后**（BattleContext.cpp:2240-2242）——它读的是**上一回合**的张数。
 *  * **船长之轮**的门是 `bc.turn == 2`（不是「第 2 个玩家回合」，`turn` 在
 *    `afterMonsterTurns` 开头就已经自增过）。
 * TODO(后续PR): 战争艺术 / 船长之轮 / 达摩鲁 / 情绪芯片 / 悬停风筝 …
 */
function applyStartOfTurnRelics(bc: BattleContext): void {
  // ⚠⚠ **按参考的书写顺序遍历这张表，而不是按玩家的遗物顺序**（第四十二批改）。
  //   `initRelics` 与 `atBattleStart` 那两张表在参考里是
  //   `for (auto &r : g.relics.relics) switch (r.id)`——遍历的是**遗物容器**，所以我们那两处
  //   照着 `bc.relics` 走是对的。而 `Player::applyStartOfTurnRelics` 是一串**并列的 `if`**，
  //   顺序由**源码**定死、与玩家什么时候捡到哪颗遗物无关。表里只有硫磺一颗时两种写法同解，
  //   本批加进橙色药丸之后就必须写对形状（当前两者仍不互相读，所以还是观察不到——
  //   但下一颗进这张表的遗物随时会让它可观察，见战争艺术 / 船长之轮）。
  for (const [id, fn] of RELIC_AT_TURN_START) {
    if (hasRelic(bc, id)) {
      fn(bc);
    }
  }
}

/**
 * 回合开始的遗物表（对齐 `Player::applyStartOfTurnRelics` 里那串 `if (hasRelic<X>())`，
 * Player.cpp:489-562）。
 *
 * ⚠ 与 `RELIC_IMMEDIATE` / `RELIC_AT_BATTLE_START` 不同，这张表里的东西**每回合都跑**。
 * ⚠⚠ 它是**有序数组**而不是 Record：参考那一串是并列的 `if`，先后由源码决定。
 *   参考的完整书写顺序是 战争艺术 → **硫磺** → 船长之轮 → 达摩鲁 → 情绪芯片 → 快乐花 →
 *   号角 → 熏香炉 → 插入器 → 水银沙漏 → 死藤 → **橙色药丸**（最后一句）。
 *   已登记的两颗按这个顺序排；中间未登记的那些登记时插回各自的位置。
 */
const RELIC_AT_TURN_START: ReadonlyArray<readonly [string, (bc: BattleContext) => void]> = [
  // 战争艺术（ART_OF_WAR，第四十三批）：这张表的**第一句**（Player.cpp:492-496）：
  //     if (hasRelic<R::ART_OF_WAR>()) {
  //         if (attacksPlayedThisTurn == 0) {
  //             bc.addToBot(Actions::GainEnergy(1));
  //         }
  //     }
  // ⚠⚠ **它读的是上一个回合的张数**：`attacksPlayedThisTurn` 的清零排在
  //   `applyStartOfTurnRelics` **之后**（BattleContext.cpp:2240-2242，参考在那里自注
  //   `// this has to be here because some relics check this info.`）。所以卡面那句
  //   「若上回合没有打出攻击牌」全靠这个顺序——把清零挪到前面来，这颗遗物就**每回合都触发**。
  // ⚠ 是 `addToBot`（入队），不是同步加能量；`clearOnCombatVictory` 取 `Actions::GainEnergy`
  //   的默认值 true。
  // ⚠ 第 1 个玩家回合拿不到（`init` 不走 `afterMonsterTurns`），与硫磺那条同理。
  [
    "art_of_war",
    (bc) => {
      if (bc.player.attacksPlayedThisTurn === 0) {
        addToBot(bc, (c) => {
          c.player.energy += 1;
        });
      }
    },
  ],
  // 硫磺（BRIMSTONE）：Player.cpp:497-505，与 `initRelics` 那一格**逐字相同**——
  //     if (hasRelic<R::BRIMSTONE>()) {
  //         buff<PS::STRENGTH>(2);
  //         for (int i = 0; i < bc.monsters.monsterCount; i++) {
  //             if (bc.monsters.arr[i].isTargetable()) {
  //                 bc.monsters.arr[i].buff<MS::STRENGTH>(1);
  //             }
  //         }
  //     }
  // 两处都是**同步**的（一个 addToBot 都没有），过滤器同样是 `isTargetable()`。
  [
    "brimstone",
    (bc) => {
      addPower(bc.player.powers, "strength", 2);
      for (const m of bc.monsters) {
        if (m.alive) {
          addPower(m.powers, "strength", 1);
        }
      }
    },
  ],
  // 船长之轮（CAPTAINS_WHEEL，第四十三批）：Player.cpp:507-511，排在硫磺**之后**、
  // 达摩鲁之前：
  //     if (hasRelic<R::CAPTAINS_WHEEL>()) {
  //         if (bc.turn == 2) {
  //             bc.addToBot( Actions::GainBlock(18) );
  //         }
  //     }
  // ⚠⚠ 门是 `bc.turn == 2` 而**不是**「第 2 个玩家回合」：`BattleContext::turn` 初值 0、
  //   在 `afterMonsterTurns` 的**开头**就已经自增过，而这个函数排在那次自增之后。
  //   所以 `turn == 2` 命中的是玩家的**第 3 个**回合（真实游戏卡面写「第 3 回合」，一致）。
  // ⚠ `== 2` 而不是 `>= 2`：只给一次。
  // ⚠ `Actions::GainBlock` 的 `clearOnCombatVictory` 是 **false**（Actions.cpp:161-165）。
  [
    "captains_wheel",
    (bc) => {
      if (bc.turn === 2) {
        addToBot(bc, (c) => gainBlock(c, 18), false);
      }
    },
  ],
  // 达摩鲁（DAMARU，第四十九批）：Player.cpp:513-516，排在船长之轮**之后**、情绪芯片之前：
  //     if (hasRelic<R::DAMARU>()) {
  //         bc.addToBot( Actions::BuffPlayer<PS::MANTRA>(1) );
  //         // todo handle mantra change stance
  //     }
  // ⚠ 与 `initRelics` 那一格是**同一颗遗物的第二个时点**（硫磺那一族），但两处形状不同：
  //   那一处是同步 `buff`，这一处是 `addToBot`。逐处照抄，别对齐成一种。
  // ⚠ `Actions::BuffPlayer` 的 `clearOnCombatVictory` 取默认 true。
  [
    "damaru",
    (bc) => {
      addToBot(bc, (c) => addPower(c.player.powers, "mantra", 1));
    },
  ],
  // 情绪芯片（EMOTION_CHIP，第四十九批）：Player.cpp:518-520 **整格是空的**——
  //     if (hasRelic<R::EMOTION_CHIP>()) {
  //         // todo if lost hp last turn addToBot(new ImpulseAction())
  //     }
  // ⚠⚠ **照抄「什么都不做」，这不是漏抄**（同「好奇心」那条裁定：唯一读点被参考自己注释掉了）。
  //   补上真实游戏那句「上回合掉过血就触发全部战斗开始效果」**没有预言机**——预言机就是参考本身。
  // ⚠ 它仍然值得登记，而且它的背书是**反方向**的：给它写任何一个真实效果，
  //   `@relic13` 那 360 条 trace 会当场红（本批实测「改成 addToBot(GainEnergy(1))」红 240 例）。
  //   「登记成空操作」与「没登记」在 `isRelicSupported` 上是两种答案，前者说的是
  //   「参考在战斗内确实什么都不做」。
  [
    "emotion_chip",
    () => {
      // 参考在这里什么都不做（`// todo if lost hp last turn ...`）。
    },
  ],
  // 号角（HORN_CLEAT，第四十三批）：Player.cpp:529-533，排在快乐花**之后**、熏香炉之前：
  //     if (hasRelic<R::HORN_CLEAT>()) {
  //         if (bc.turn == 1) {
  //             bc.addToBot( Actions::GainBlock(14) );
  //         }
  //     }
  // ⚠ 与船长之轮**同族但差一格**：`turn == 1` = 玩家的第 2 个回合（卡面写「第 2 回合」）。
  //   两条并排放着正好互为对照，别把常数（14 / 18）与回合数（1 / 2）抄串。
  // —— 第四十四批：这张表里剩下的四颗，各自插回参考的书写位置 ——
  //
  // ⚠⚠ 参考的完整顺序是 战争艺术 → 硫磺 → 船长之轮 → 达摩鲁 → 情绪芯片 → **快乐花** →
  //   号角 → **熏香炉** → 插入器 → **水银沙漏** → **死灵之书** → 橙色药丸。
  //   本批把加粗那四颗插回各自的位置——**快乐花排在号角之前**，所以它在这张数组里也必须
  //   排在 `horn_cleat` 上面。这张表是有序数组正是为了这件事。
  //   （达摩鲁 = 姿态、情绪芯片 = 参考里是空的 `// todo`、插入器 = `increaseOrbSlots` 是
  //   空函数，三颗都没有预言机，见 TODOS 的排除表。）

  // 快乐花（HAPPY_FLOWER，Player.cpp:521-527）：
  //     if (hasRelic<R::HAPPY_FLOWER>()) {
  //         if (++happyFlowerCounter == 3) {
  //             happyFlowerCounter = 0;
  //             bc.addToBot( Actions::GainEnergy(1) );
  //         }
  //     }
  // ⚠⚠ **与 `initRelics` 那一半形状不同**：那边是「先算 `data + 1` 再判、能量**同步**加」，
  //   这边是「先自增再判、能量**入队**」。两处的顺序（判断在自增之后）相同，
  //   但一个读 `r.data`、一个读上一回合留下的计数器。照抄两份。
  [
    "happy_flower",
    (bc) => {
      bc.player.happyFlowerCounter += 1;
      if (bc.player.happyFlowerCounter === 3) {
        bc.player.happyFlowerCounter = 0;
        addToBot(bc, (c) => {
          c.player.energy += 1;
        });
      }
    },
  ],
  [
    "horn_cleat",
    (bc) => {
      if (bc.turn === 1) {
        addToBot(bc, (c) => gainBlock(c, 14), false);
      }
    },
  ],
  // 熏香炉（INCENSE_BURNER，Player.cpp:535-540）：与 `initRelics` 那一半除了「入队」之外
  // 逐字相同（`if (++counter == 6) { counter = 0; addToBot(BuffPlayer<INTANGIBLE>(1)) }`）。
  [
    "incense_burner",
    (bc) => {
      bc.player.incenseBurnerCounter += 1;
      if (bc.player.incenseBurnerCounter === 6) {
        bc.player.incenseBurnerCounter = 0;
        addToBot(bc, (c) => addPower(c.player.powers, "intangible", 1));
      }
    },
  ],
  // 水银沙漏（MERCURY_HOURGLASS，Player.cpp:551-553）：`addToBot(Actions::DamageAllEnemy(3))`。
  // ⚠ 与 `initRelics` 里那一句**逐字相同**（BattleContext.cpp:432-434），与硫磺同族：
  //   一处覆盖第 1 回合、一处覆盖第 2 回合起。⚠ 但两处的**写法不同**——`init` 那处的门是
  //   `gc.hasRelic(...)`（容器）、这处是 `hasRelic<>()`（玩家位集合），当前同解。
  [
    "mercury_hourglass",
    (bc) => {
      addToBot(bc, (c) => damageAllEnemiesNonAttack(c, 3));
    },
  ],
  // 死灵之书（NECRONOMICON，Player.cpp:555-557）：`haveUsedNecronomiconThisTurn = false;`
  // ⚠ **同步**赋值，不入队；它不是 Power、不进快照。真正的效果在 `onUseAttackCard`（:1722）。
  [
    "necronomicon",
    (bc) => {
      bc.player.haveUsedNecronomiconThisTurn = false;
    },
  ],
  // 橙色药丸（ORANGE_PELLETS，第四十二批）：对齐 `Player::applyStartOfTurnRelics` 的
  // **最后一句**（Player.cpp:559-561）：
  //     if (hasRelic<R::ORANGE_PELLETS>()) {
  //         orangePelletsCardTypesPlayed.reset();
  //     }
  // ⚠⚠ **这一处与三个 handler 里的那三处是两件不同的事**，别合并：
  //   handler 里那三处是**计数**（置位 + 集齐就清空并入队清减益），这一处是**回合复位**。
  //   卡面「在同一**回合**内打出攻击、技能和能力牌各一张」的「回合」二字全靠这一句。
  // ⚠ 位置：它在 `applyStartOfTurnRelics` 里，而那个函数排在
  //   `BattleContext::afterMonsterTurns` 的**清格挡与三个计数器清零之前**
  //   （BattleContext.cpp:2198 / :2240-2242）。与那三个计数器是**不同的清零点**——
  //   `attacksPlayedThisTurn` 那三个在这个函数**之后**清（战争艺术因此读到上一回合的数），
  //   橙色药丸这个在函数**里面**清。抄错顺序当前观察不到（没人在两者之间读它），照抄。
  // ⚠ 是**同步**清零（一个 addToBot 都没有）。
  [
    "orange_pellets",
    (bc) => {
      bc.player.orangePelletsCardTypesPlayed = 0;
    },
  ],
];

/**
 * 墨水瓶（INK_BOTTLE，第四十二批）：每打出 10 张牌抽 1 张。
 *
 * 参考把**逐字相同的五行**写在**四个** handler 里（BattleContext.cpp:1694 / :1811 /
 * :1889 / :1958）：
 * ```cpp
 * if (p.hasRelic<R::INK_BOTTLE>()) {
 *     p.inkBottleCounter++;
 *     if (p.inkBottleCounter == 10) {
 *         p.inkBottleCounter = 0;
 *         addToBot( Actions::DrawCards(1) );
 *     }
 * }
 * ```
 * ⚠ 五处照抄：
 *  ①⚠⚠ **四个 handler 都有**，所以**状态牌 / 诅咒牌也算一张**。这是「每打出 10 张**牌**」
 *     那句话的全部实现：没有任何牌型过滤，`onUseStatusOrCurseCard` 里那一份就是证据。
 *     漏抄任一份不会报错，只会让计数器从此**整体错位**——它不是回合级的，一错错到底。
 *  ② 阈值是 **`== 10`** 而不是 `>= 10`，配合「命中就归零」。写成 `>=` 在正常路径上同解，
 *     但那是巧合；真正被钉住的是「每 10 张」这个周期。
 *  ③ **自增在判据之前**（与三颗计数遗物同族），所以第 10 张牌读到的是 10。
 *  ④ 抽牌**入队**（`addToBot`），排在这张牌自己的效果之后；`clearOnCombatVictory`
 *     取 `Actions::DrawCards` 的默认值 true。
 *  ⑤⚠ 计数器**不随回合清零**（`applyStartOfTurnRelics` 里没有它），而且参考在
 *     `updateRelicsOnExit` 里把它写回遗物的 `data`——真实 run 里它跨战斗延续。
 *
 * ⚠ 位置逐 handler 不同，**必须逐个照抄**：
 *   * 攻击牌：在苦无**之前**（:1694 vs :1702）；
 *   * 技能牌：在橙色药丸**之前**、拆信刀之前（:1811）；
 *   * 能力牌：在鸟面坛**之后**、橙色药丸之前（:1889）；
 *   * 状态/诅咒牌：**整个函数的最后一句**，在蓝色蜡烛 / 医疗包那个分支**之后**（:1958），
 *     而且那个 handler 里**没有**橙色药丸（见 `orangePelletsOnUseCard` 的注释）。
 */
function inkBottleOnUseCard(bc: BattleContext): void {
  if (hasRelic(bc, "ink_bottle")) {
    bc.player.inkBottleCounter += 1;
    if (bc.player.inkBottleCounter === 10) {
      bc.player.inkBottleCounter = 0;
      addToBot(bc, (c) => drawCards(c, 1), true, { kind: "draw_cards", count: 1 });
    }
  }
}

/**
 * 橙色药丸（ORANGE_PELLETS，第四十二批）：一回合内三种牌型各打一张就清掉全部减益。
 *
 * 参考把**逐字相同的六行**写在**三个** handler 里（BattleContext.cpp:1706 / :1819 / :1897），
 * 只有 `CardType::X` 那一个模板实参不同：
 * ```cpp
 * if (p.hasRelic<R::ORANGE_PELLETS>()) {
 *     p.orangePelletsCardTypesPlayed.set(static_cast<int>(CardType::ATTACK), true);
 *     if (p.orangePelletsCardTypesPlayed.all()) {
 *         p.orangePelletsCardTypesPlayed.reset();
 *         addToBot(Actions::RemovePlayerDebuffs());
 *     }
 * }
 * ```
 * ⚠ 五处照抄：
 *  ①⚠⚠ **只有三个 handler**：`onUseStatusOrCurseCard` 里**没有**它。理由是形状而不是设计
 *     偏好——那个字段是 `std::bitset<3>`（Player.h:82），而 `CardType::CURSE` / `STATUS`
 *     的枚举值是 **3 / 4**（Cards.h:406-413），`set(3, true)` 就越界了。
 *     ⚠ 这与墨水瓶正好相反（墨水瓶四个 handler 全有），两颗遗物并排放在同一段里，
 *     **别照着邻居抄**。
 *  ② **先置位再判 `all()`**，所以「补上第三种牌型的那一张牌」自己就触发。
 *  ③ 命中时**先 `reset()` 再入队**——清减益是 `addToBot`，而位掩码是**同步**清空的。
 *     于是这张牌之后再打三种牌型可以再触发一次（一回合内可以触发多次）。
 *  ④ 清减益走 `Actions::RemovePlayerDebuffs`（Actions.cpp:940-944），
 *     `clearOnCombatVictory` 取默认的 true。
 *  ⑤ 回合开始的复位是**另一处**（`Player::applyStartOfTurnRelics` 的最后一句），
 *     见 `RELIC_AT_TURN_START`。
 *
 * ⚠ 位置：攻击牌那份夹在**苦无与装饰扇之间**（:1702 / :1706 / :1714），技能牌那份在
 * 墨水瓶**之后**、拆信刀之前，能力牌那份在墨水瓶之后、木乃伊手之前。
 */
function orangePelletsOnUseCard(bc: BattleContext, typeBit: 0 | 1 | 2): void {
  if (hasRelic(bc, "orange_pellets")) {
    bc.player.orangePelletsCardTypesPlayed |= 1 << typeBit;
    if (bc.player.orangePelletsCardTypesPlayed === 0b111) {
      bc.player.orangePelletsCardTypesPlayed = 0;
      addToBot(bc, (c) => removePlayerDebuffs(c), true, { kind: "remove_player_debuffs" });
    }
  }
}

/**
 * 清掉玩家身上的全部减益（对齐 `Player::removeDebuffs`，Player.cpp:121-149）。
 *
 * ⚠ 四处照抄：
 *  ①⚠⚠ **力量与敏捷不是「摘掉」而是「负数才归零」**：
 *     `if (getStatus<STRENGTH>() < 0) setStatusValueNoChecks<STRENGTH>(0);`
 *     正的力量原样留着。这两句是这个函数里**唯一会与「加力量 / 加敏捷」互相干扰的东西**，
 *     也就是苦无 / 手里剑那两条动作与这一条之间**唯一**的可观察面（第四十二批实测：
 *     两者同时触发 3 / 1440 条，且没有一条同时满足「力量或敏捷为负」）。
 *  ② **抽牌削减要先把 `cardDrawPerTurn` 还回去再摘 Power**，两句成对
 *     （与 `afterMonsterTurns` 里那次归还是同一对，摘一次还一次）。
 *  ③ 名单里**没有**中毒 / 燃烧那种「不是 Power 的东西」，也没有虚弱以外的怪物侧减益。
 *  ④ 走的是 `removeStatus`（整条摘掉）而不是 `decrementStatus`。
 *
 * ⚠ 名单里当前**没有产出者**的：偏移（BIAS）、禁食（FASTING）、恶灵形态（WRAITH_FORM）
 * ——照抄进来是纯粹的空操作，写着是为了下次有人登记它们时不用回参考重数一遍。
 */
function removePlayerDebuffs(bc: BattleContext): void {
  const powers = bc.player.powers;
  const strength = bc.player.powers.find((p) => p.id === "strength");
  if (strength !== undefined && strength.amount < 0) {
    strength.amount = 0;
  }
  const dexterity = bc.player.powers.find((p) => p.id === "dexterity");
  if (dexterity !== undefined && dexterity.amount < 0) {
    dexterity.amount = 0;
  }
  removePower(powers, "bias");
  removePower(powers, "confused");
  removePower(powers, "constricted");
  // 抽牌削减：先 `++cardDrawPerTurn` 再摘，与 `Player::debuff` 里那句 `--cardDrawPerTurn`
  // 配对（对齐 Player.cpp:133-136）。
  if (hasPower(powers, "draw_reduction")) {
    bc.player.cardDrawPerTurn += 1;
    removePower(powers, "draw_reduction");
  }
  removePower(powers, "entangled");
  removePower(powers, "fasting");
  removePower(powers, "frail");
  removePower(powers, "hex");
  removePower(powers, "lose_dexterity");
  removePower(powers, "lose_strength");
  removePower(powers, "no_card_block"); // PS::NO_BLOCK
  removePower(powers, "no_draw");
  removePower(powers, "vulnerable");
  removePower(powers, "weak");
  removePower(powers, "wraith_form");
}

// ============================================================================
// 选牌屏：开屏动作 + 选定处理
//
// 每个任务都是一对：
//   ① 开屏动作（Actions::XxxAction）——**先算候选数**，0 个就什么都不做，1 个就当场
//      替玩家选掉、根本不开屏，≥2 个才开屏。这条「1 个自动选」的捷径不是优化，它决定了
//      动作序列的长度（trace 里少一步 select_card），漏了两边就对不上。
//   ② 选定处理（BattleContext::chooseXxxCard）——真正搬牌。
// ============================================================================

/** 对齐 BattleContext::openSimpleCardSelectScreen。 */
function openSimpleCardSelectScreen(bc: BattleContext, task: CardSelectTask, count: number): void {
  bc.inputState = "card_select";
  bc.cardSelect = { task, pickCount: count };
}

/**
 * 对齐 BattleContext::chooseArmamentsCard。
 *
 * ⚠ 它顺手把手牌**重排**了：先是「其余可升级的牌」，然后是被选中的那张（已升级），
 * 最后是「其余不可升级的牌」。参考自己标了 `// todo cleaner solution`，但这个顺序是
 * 可观察的（trace 记手牌顺序），必须照抄。
 */
function chooseArmamentsCard(bc: BattleContext, handIdx: number): void {
  const valid: CombatCard[] = [];
  const invalid: CombatCard[] = [];
  for (let i = 0; i < bc.hand.length; i += 1) {
    if (i === handIdx) {
      continue;
    }
    const c = bc.hand[i];
    if (canUpgradeCard(c)) {
      valid.push(c);
    } else {
      invalid.push(c);
    }
  }
  const cardToUpgrade = bc.hand[handIdx];
  upgradeCard(cardToUpgrade);
  bc.hand = [...valid, cardToUpgrade, ...invalid];
}

/** 对齐 Actions::ArmamentsAction（军备的未升级分支）。 */
function armamentsAction(bc: BattleContext): void {
  let canUpgradeCount = 0;
  let lastUpgradeIdx = 0;
  for (let i = 0; i < bc.hand.length; i += 1) {
    if (canUpgradeCard(bc.hand[i])) {
      canUpgradeCount += 1;
      lastUpgradeIdx = i;
    }
  }
  if (canUpgradeCount === 0) {
    return;
  }
  if (canUpgradeCount === 1) {
    // ⚠ 只有一张可升级时**不走** chooseArmamentsCard，所以手牌也不重排——两条路径的
    // 可观察结果不同，不能合并。
    upgradeCard(bc.hand[lastUpgradeIdx]);
    return;
  }
  openSimpleCardSelectScreen(bc, "armaments", 1);
}

/** 对齐 Actions::UpgradeAllCardsInHand（军备的升级分支）。 */
function upgradeAllCardsInHand(bc: BattleContext): void {
  // ⚠ 参考这里**不**过 canUpgrade，直接对每张牌调 upgrade()；upgrade() 自己有
  // `if (!isUpgraded())` 兜底，所以已升级的牌原样不动。诅咒 / 状态牌会被真的标成升级，
  // 但它们没有升级形态、也没有任何规则读这个位，故不可观察。
  for (const card of bc.hand) {
    upgradeCard(card);
  }
}

/**
 * 双持能复制的牌型（对齐 `DualWieldAction` / `chooseDualWieldCard` /
 * `isValidSingleCardSelectAction` 里那句 `getType() == ATTACK || getType() == POWER`）。
 */
function isDualWieldable(card: CombatCard): boolean {
  const t = getCardDef(card.defId).type;
  return t === "attack" || t === "power";
}

/**
 * 对齐 `BattleContext::chooseDualWieldCard`（BattleContext.cpp:2952）。
 *
 * ⚠ 四处照抄（参考在函数顶部自注 "dual wield is so fucking buggy"）：
 *  ① 它顺手把手牌**重排**了：先是「其余可复制的牌（攻击/能力）」，然后是「其余不可复制的
 *     牌」，被选中的那张排到**最后**。与军备那次重排的形状不同（军备是 valid → 选中 →
 *     invalid），不能套用。
 *  ② 被选中的那张牌会**换一个新 uid**（`dualWieldCard.uniqueId = nextUniqueCardId++`）。
 *     参考注明这正是「双持仪式匕首」那个 bug 的来源。uid 不进 trace 快照，但它会推进
 *     计数器，后续凭空造牌的 uid 全跟着挪，所以必须照抄。
 *  ③ 副本走 `createTempCardInHand`——**整份实例拷贝**（cost / costForTurn / specialData /
 *     upgraded 一并带走），每份再各取一个新 uid。不是「按定义重造一张原型」：一张被腐化压成
 *     0 费的能力牌、一张已经涨过的暴走，复制出来的副本带着当时的数值。
 *  ④ 手牌满 10 张时改进**弃牌堆**（不是丢掉），且这个判断在**每一份**副本前各做一次。
 */
function chooseDualWieldCard(bc: BattleContext, handIdx: number, copyCount: number): void {
  const dualWieldCard = bc.hand[handIdx];
  const valid: CombatCard[] = [];
  const invalid: CombatCard[] = [];
  for (let i = 0; i < bc.hand.length; i += 1) {
    if (i === handIdx) {
      continue;
    }
    const c = bc.hand[i];
    if (isDualWieldable(c)) {
      valid.push(c);
    } else {
      invalid.push(c);
    }
  }
  // ⚠ 只换 uid，**不** notifyAddCardToCombat——原牌一直在场（参考这里只有一句
  // `dualWieldCard.uniqueId = nextUniqueCardId++`，没有 notify）。
  dualWieldCard.uid = bc.nextUid++;
  bc.hand = [...valid, ...invalid, dualWieldCard];
  for (let i = 0; i < copyCount; i += 1) {
    const copy = instantiate(bc, dualWieldCard);
    if (bc.hand.length + 1 <= MAX_HAND_SIZE) {
      bc.hand.push(copy);
    } else {
      bc.discardPile.push(copy);
    }
  }
}

/**
 * 对齐 `Actions::DualWieldAction`（Actions.cpp:701）。
 *
 * ⚠ 三条分支的可观察结果各不相同，不能合并：
 *  ① 没有可复制的牌 → 什么都不做（不开屏）；
 *  ② 恰好一张 → **直接复制那一张、不开屏**，而且**不重排手牌、不改原牌的 uid**——
 *     与走选牌屏那条路差着一次手牌重排和一次 uid 递增；
 *  ③ ≥2 张 → 开屏，把份数存进 `data0`。
 * ⚠ 双持自己是技能牌，且 useCard 在动作入队**之前**就把它移出了手牌，所以它不会
 *    把自己算进候选。
 */
function dualWieldAction(bc: BattleContext, copyCount: number): void {
  let validCount = 0;
  let lastValidIdx = 0;
  for (let i = 0; i < bc.hand.length; i += 1) {
    if (isDualWieldable(bc.hand[i])) {
      validCount += 1;
      lastValidIdx = i;
    }
  }
  if (validCount === 0) {
    return;
  }
  if (validCount === 1) {
    for (let i = 0; i < copyCount; i += 1) {
      const copy = instantiate(bc, bc.hand[lastValidIdx]);
      if (bc.hand.length + 1 <= MAX_HAND_SIZE) {
        bc.hand.push(copy);
      } else {
        bc.discardPile.push(copy);
      }
    }
    return;
  }
  bc.inputState = "card_select";
  bc.cardSelect = { task: "dual_wield", pickCount: 1, data0: copyCount };
}

/** 对齐 BattleContext::chooseExhaustOneCard。 */
function chooseExhaustOneCard(bc: BattleContext, handIdx: number): void {
  const [card] = bc.hand.splice(handIdx, 1);
  triggerAndMoveToExhaustPile(bc, card);
}

/** 对齐 Actions::ChooseExhaustOne（焚誓 / 坚毅+）。 */
function chooseExhaustOneAction(bc: BattleContext): void {
  if (bc.hand.length === 0) {
    return;
  }
  if (bc.hand.length === 1) {
    chooseExhaustOneCard(bc, 0);
    return;
  }
  openSimpleCardSelectScreen(bc, "exhaust_one", 1);
}

/**
 * 对齐 BattleContext::chooseExhaustCards（净化的多选）。
 * 按下标**降序**消耗，故下标始终有效——正序会越消耗越错位。
 */
function chooseExhaustCards(bc: BattleContext, idxs: number[]): void {
  if (idxs.length === 0) {
    return;
  }
  for (const handIdx of [...idxs].sort((a, b) => b - a)) {
    const [card] = bc.hand.splice(handIdx, 1);
    triggerAndMoveToExhaustPile(bc, card);
  }
}

/**
 * 对齐 Actions::ExhaustMany（净化）。
 *
 * ⚠ **无条件开屏**——手牌为空也开，与其它任务的「0 个候选就跳过」不同。照抄。
 */
function exhaustManyAction(bc: BattleContext, limit: number): void {
  bc.inputState = "card_select";
  bc.cardSelect = { task: "exhaust_many", pickCount: limit };
}

/**
 * 对齐 BattleContext::chooseExhumeCard（BattleContext.cpp:3036）：消耗堆 → 手牌。
 *
 * ⚠ 这里要 `notifyAddCardToCombat`：消耗是唯一的「离场」，掘尸把牌**重新带回战斗**，
 * 所以 strikeCount 要加回来（参考在 removeFromExhaustPile 之后显式调了它）。
 * `removeFromExhaustPile` 自己**不**调 notifyRemoveFromCombat——离场那一下在进消耗堆时
 * 就已经记过了，这里再减一次会重复。
 */
function chooseExhumeCard(bc: BattleContext, exhaustIdx: number): void {
  const [card] = bc.exhaustPile.splice(exhaustIdx, 1);
  notifyAddCardToCombat(bc, card);
  // TODO(后续PR): 参考标了「game handles corruption here」，腐化尚未登记。
  moveToHandHelper(bc, card);
}

/**
 * 对齐 Actions::ExhumeAction（掘尸）。
 *
 * ⚠ 三处照抄：① 消耗堆空**或手牌已满 10 张**就整个跳过（不是搬进弃牌堆）；
 * ② 候选里排除掘尸自己——参考标了 `// todo this is bugged because the selected card
 * cannot be exhume`，认为真实游戏能选到自己，但没改；这里以参考为准（预言机就是它）；
 * ③ 不走 openSimpleCardSelectScreen，直接改两个字段。
 */
function exhumeAction(bc: BattleContext): void {
  if (bc.exhaustPile.length === 0 || bc.hand.length === MAX_HAND_SIZE) {
    return;
  }
  let nonExhumeCards = 0;
  let lastNonExhumeIdx = -1;
  for (let i = 0; i < bc.exhaustPile.length; i += 1) {
    if (bc.exhaustPile[i].defId !== "exhume") {
      nonExhumeCards += 1;
      lastNonExhumeIdx = i;
    }
  }
  if (nonExhumeCards === 0) {
    return;
  }
  if (nonExhumeCards === 1) {
    chooseExhumeCard(bc, lastNonExhumeIdx);
    return;
  }
  bc.cardSelect = { task: "exhume", pickCount: 1 };
  bc.inputState = "card_select";
}

/**
 * 对齐 BattleContext::chooseHeadbuttCard：弃牌堆 → 抽牌堆**顶**（数组尾）。
 * ⚠ 顺序照抄：先 moveToDrawPileTop 再 removeFromDiscard。两步都不消耗 RNG，
 * 但反过来写会在「牌堆顶」与「弃牌堆下标」之间产生一次错位。
 */
function chooseHeadbuttCard(bc: BattleContext, discardIdx: number): void {
  bc.drawPile.push(bc.discardPile[discardIdx]);
  bc.discardPile.splice(discardIdx, 1);
}

/** 对齐 Actions::HeadbuttAction（头槌）。 */
function headbuttAction(bc: BattleContext): void {
  if (bc.discardPile.length === 0) {
    return;
  }
  if (bc.discardPile.length === 1) {
    chooseHeadbuttCard(bc, 0);
    return;
  }
  openSimpleCardSelectScreen(bc, "headbutt", 1);
}

/** 对齐 BattleContext::chooseWarcryCard：手牌 → 抽牌堆顶。 */
function chooseWarcryCard(bc: BattleContext, handIdx: number): void {
  bc.drawPile.push(bc.hand[handIdx]);
  bc.hand.splice(handIdx, 1);
}

/**
 * 对齐 Actions::WarcryAction（战吼 / 未雨绸缪）。
 *
 * ⚠ 只有「手牌恰好 1 张」那一支会**白吃一次 cardRandomRng**（`bc.cardRandomRng.random(1)`）。
 * 手牌 0 张或 ≥2 张都不掷。这一次消耗看不出任何用途、结果被丢掉，但它真实改了 counter，
 * 漏掉之后每一次 cardRandomRng 都错位。
 */
function warcryAction(bc: BattleContext): void {
  if (bc.hand.length === 0) {
    return;
  }
  if (bc.hand.length === 1) {
    bc.rng.cardRandomRng.random(1); // ★ 消耗一次 cardRandomRng（结果不用，照抄）
    chooseWarcryCard(bc, 0);
    return;
  }
  bc.inputState = "card_select";
  bc.cardSelect = { task: "warcry", pickCount: 1 };
}

/** 对齐 BattleContext::chooseDrawToHandCards 的单张形态：抽牌堆某张 → 手牌。 */
function chooseDrawToHandCard(bc: BattleContext, drawIdx: number): void {
  const [card] = bc.drawPile.splice(drawIdx, 1);
  moveToHandHelper(bc, card);
}

/**
 * 对齐 Actions::DrawToHandAction（秘密技巧 / 秘密武器）。
 *
 * ⚠ 扫描循环里藏着 RNG：每找到**第 2 张及以后**的匹配牌，就掷一次
 * `cardRandomRng.random(count - 1)`（count 是此前已找到的张数），结果丢掉。参考的注释说
 * 这是为了「keeping rng consistent with game」——真实游戏建了个临时列表并随机插入。
 * 所以匹配 n 张就消耗 n-1 次；n≤1 时一次都不掷。这是本批最容易漏、也最直接被 trace 的
 * cardRandom counter 抓住的一点。
 */
function drawToHandAction(bc: BattleContext, task: CardSelectTask, cardType: string): void {
  let count = 0;
  let idx = 0;
  for (let i = 0; i < bc.drawPile.length; i += 1) {
    if (getCardDef(bc.drawPile[i].defId).type === cardType) {
      if (count > 0) {
        bc.rng.cardRandomRng.random(count - 1); // ★ 消耗一次 cardRandomRng（结果不用）
      }
      idx = i;
      count += 1;
    }
  }
  if (count === 0) {
    return;
  }
  if (count === 1) {
    chooseDrawToHandCard(bc, idx);
    return;
  }
  bc.cardSelect = { task, pickCount: 1 };
  bc.inputState = "card_select";
}

/**
 * 暴力：把抽牌堆里 `count` 张**随机**攻击牌搬进手牌（对齐 `Actions::ViolenceAction`，
 * Actions.cpp:614）。没有选牌屏——它是随机检索。
 *
 * 形状是参考自己都嫌绕的一段（原文首行注释 `// todo a faster algorithm ...`），逐位照抄：
 *
 *  ① **扫描阶段**：正序遍历抽牌堆收集攻击牌的**下标**。第一张 `push_back`，其后每一张都
 *     `insert(cardRandomRng.random(已收集张数 - 1), i)`——★ **每张（第一张除外）消耗一次
 *     `cardRandomRng`**，而且结果**真的被用了**（决定插在列表哪一位），与秘密技巧那条
 *     「掷了就丢」的白吃不同族。所以这个列表既不是升序也不是随机洗过，是一种带偏的顺序。
 *  ② 列表为空就提前返回（一次 shuffleRng 也不掷）。
 *  ③ **取牌阶段**：第 i 轮先把列表的 `[i, end)` 这一段用
 *     `java::Collections::shuffle(..., java::Random(shuffleRng.randomLong()))` 洗一遍
 *     ——★ **每轮消耗一次 shuffleRng**——再取 `list[i]` 作为本轮要搬的抽牌堆下标。
 *     只洗尾段是因为 `[0, i)` 是已经搬走的那几张，参考的注释就是在解释这一点。
 *  ④ 手牌满 10 张时那一张改进**弃牌堆**（这个判断写在这里，所以**不走** `moveToHandHelper`
 *     ——腐化那条「进手就压成 0 费」的钩子在这条路径上根本不存在，与检索类的其它牌不同）。
 *  ⑤ **移除阶段**：真正把牌从抽牌堆删掉是最后统一做的，且必须把下标**升序排好后从大到小**
 *     删，否则前面的删除会让后面的下标错位。
 *
 * ⚠ 参考原文 ③ 那道提前退出写的是 `return` 而不是 `break`，于是抽牌堆里攻击牌**少于
 * `count` 张**时整个 ⑤ 被跳过：已经搬进手牌的那几张仍留在抽牌堆里，凭空多出副本。
 * **已随本批在参考侧修成 `break`**（见 TODOS「已修正」），这里写的是修正后的形态。
 * `i` 就是「实际搬了几张」，⑤ 本来就是按 `i` 收尾的。
 *
 * ⚠ 参考的 `attackIdxList` 是 `fixed_list<int, CardManager::MAX_GROUP_SIZE=64>`，而
 * `fixed_list` 没有任何越界检查——它按**抽牌堆里的攻击牌数**算，65 张就是静默内存破坏。
 * 当前所有 variant 的牌组都远不到（最大的全牌组 93 张里攻击牌 40 出头），安全。
 */
function violenceAction(bc: BattleContext, count: number): void {
  const attackIdxList: number[] = [];
  for (let i = 0; i < bc.drawPile.length; i += 1) {
    if (getCardDef(bc.drawPile[i].defId).type === "attack") {
      if (attackIdxList.length === 0) {
        attackIdxList.push(i);
      } else {
        // ★ 消耗一次 cardRandomRng；结果决定插入位置，**不是**白吃
        const randomIdx = bc.rng.cardRandomRng.random(attackIdxList.length - 1);
        attackIdxList.splice(randomIdx, 0, i);
      }
    }
  }
  if (attackIdxList.length === 0) {
    return;
  }
  const removeIdxs: number[] = [];
  let moved = 0;
  for (; moved < count; moved += 1) {
    if (attackIdxList.length - moved <= 0) {
      break; // 参考原文是 `return`（bug，已在参考侧修成 break）
    }
    // 只洗 [moved, end) 这一段。javaShuffle 的交换序列只取决于长度，所以「切出尾段洗完写回」
    // 与参考的「对着迭代器区间原地洗」逐位等价。
    const tail = attackIdxList.slice(moved);
    javaShuffle(tail, new JavaRandom(bc.rng.shuffleRng.randomLong())); // ★ 消耗一次 shuffleRng
    for (let k = 0; k < tail.length; k += 1) {
      attackIdxList[moved + k] = tail[k];
    }
    const removeIdx = attackIdxList[moved];
    removeIdxs.push(removeIdx);
    const card = bc.drawPile[removeIdx];
    if (bc.hand.length === MAX_HAND_SIZE) {
      bc.discardPile.push(card);
    } else {
      bc.hand.push(card);
    }
  }
  removeIdxs.sort((a, b) => a - b);
  for (let x = moved - 1; x >= 0; x -= 1) {
    bc.drawPile.splice(removeIdxs[x], 1);
  }
}

/**
 * 对齐 `Actions::DiscoveryAction`（Actions.cpp:564）：先抽 3 张候选，再开屏。
 *
 * ⚠ **无条件开屏**，没有「候选恰好 1 张就不开屏」那条捷径——候选恒为 3 张，
 * 参考的 `isValidSingleCardSelectAction` 对 DISCOVERY 也是写死的 `0 <= idx < 3`。
 * ⚠ 参考在这里还置了 `bc.haveUsedDiscoveryAction = true`（打出发现那一处另置
 * `undefinedBehaviorEvoked = true`）。两个字段全项目**只写不读**，是参考给自己的搜索层
 * 打的标记（「这张牌会让同一局出现不一致结果」），不影响任何可观察行为，故不转写。
 */
function discoveryAction(bc: BattleContext, type: DiscoveryPoolKind, amount: number): void {
  const cards = generateDiscoveryCards(bc, type); // ★ 消耗若干次 cardRandomRng（拒绝采样）
  // 对齐 BattleContext::openDiscoveryScreen（BattleContext.cpp:2894）。
  bc.inputState = "card_select";
  bc.cardSelect = { task: "discovery", pickCount: 1, cards, data0: amount };
}

/**
 * 对齐 `BattleContext::chooseDiscoveryCard`（BattleContext.cpp:3011）：把选中的那张牌
 * 造 `amount` 份进手牌，**本回合 0 费**。
 *
 * ⚠ 四处照抄：
 *  ① 用的是 `createTempCardInHand` / `createTempCardInDiscard`，**不是** `moveToHandHelper`
 *     ——手牌满的判断写在这里，且满了那份**不**享受腐化那条钩子（moveToHandHelper 的
 *     腐化分支在这条路径上根本不存在）。
 *  ② 0 费走 `setCostForTurn`，即**本回合**免费，不动 `cost`（与蜕变/变形的「本场战斗」不同）。
 *     X 费牌（嬗变，cost = -1）会被 `setCostForTurn` 的 `costForTurn >= 0` 门挡掉、维持 -1。
 *  ③ 腐化那句 `c.setCostForTurn(-9)` 在**同一个模板**上反复生效（amount > 1 时），
 *     但它与上一行的 `setCostForTurn(0)` 落地都是 0，**语义上无差别**——见报告的盲区一节。
 *  ④ 候选数组与份数都来自 `cardSelectInfo`（`cards` / `data0`）。我们的 `selectCard` 是
 *     **先关屏后派发**，所以这两个值由调用方读出来传进来。
 */
function chooseDiscoveryCard(bc: BattleContext, defId: string, amount: number): void {
  const proto = cardInstanceProto(defId, false);
  setCostForTurn(proto, 0);
  for (let i = 0; i < amount; i += 1) {
    if (bc.hand.length + 1 <= MAX_HAND_SIZE) {
      if (getPower(bc.player.powers, "corruption") > 0 && getCardDef(defId).type === "skill") {
        setCostForTurn(proto, -9);
      }
      bc.hand.push(instantiate(bc, proto));
    } else {
      bc.discardPile.push(instantiate(bc, proto));
    }
  }
}

// ============================================================================
// 战斗内随机取牌（对齐 Actions::PutRandomCardsInDrawPile / InfernalBladeAction /
// JackOfAllTradesAction）
//
// 三条都从上面那三个战斗内卡池里取牌定义，故都消耗 `cardRandomRng`。
// ============================================================================

/**
 * 对齐 `Actions::PutRandomCardsInDrawPile`（Actions.cpp:546，蜕变 / 变形共用）：
 * 把 `count` 张随机的该牌型卡洗入抽牌堆，**本场战斗 0 费**。
 *
 * ⚠ 四处照抄：
 *  ① **两个循环是分开的**——先把 `count` 张牌的 id 全抽完，再逐张算插入位置。所以
 *     cardRandomRng 的消耗形状是「count 次取牌 + 至多 count 次定位」，不是交替。
 *  ② 0 费改的是 **`cost` 和 `costForTurn` 两个字段**（直接赋值，不走 `setCostForTurn`，
 *     所以 X 费的 -1 哨兵也会被抹成 0——不过技能/攻击池里没有 X 费牌，观察不到）。
 *     改 `cost` 正是「本场战斗」与「本回合」的分界：回合末 `resetAttributesAtEndOfTurn`
 *     把 costForTurn 拉回 cost，而 cost 已经是 0。
 *  ③ 插入位置与 `MakeTempCardInDrawPile` 同款：`random(抽牌堆张数 - 1)`，空堆取 0 且**不掷**。
 *  ④ 造出来的牌恒为**未升级**（`CardInstance card(ids[i], false)`），全升级牌组也一样。
 */
function putRandomCardsInDrawPile(
  bc: BattleContext,
  type: "attack" | "skill" | "power",
  count: number,
): void {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(getTrulyRandomCardInCombat(bc, type)); // ★ 消耗一次 cardRandomRng
  }
  for (let i = 0; i < count; i += 1) {
    const card = makeCardInstance(bc, ids[i], false);
    card.cost = 0;
    card.costForTurn = 0;
    const idx = bc.drawPile.length === 0 ? 0 : bc.rng.cardRandomRng.random(bc.drawPile.length - 1); // ★ 消耗一次 cardRandomRng
    bc.drawPile.splice(idx, 0, card);
  }
}

/**
 * 对齐 `Actions::InfernalBladeAction`（Actions.cpp:571）：随机一张攻击牌进手牌，
 * **本回合 0 费**。
 *
 * ⚠ 两处照抄：① 进手是 `addToTop(MakeTempCardInHand(c))`——**不是**在这条动作里直接搬，
 * 于是它插在队首、排在本卡后续动作（OnAfterCardUsed）之前；② 0 费走 `setCostForTurn`，
 * 只管本回合，`cost` 保持原值。这正是让 `cost` 与 `costForTurn` 分岔的那一处。
 */
function infernalBladeAction(bc: BattleContext): void {
  const defId = getTrulyRandomCardInCombat(bc, "attack"); // ★ 消耗一次 cardRandomRng
  const proto = cardInstanceProto(defId, false);
  setCostForTurn(proto, 0);
  addToTop(bc, (c) => makeTempCardInstanceInHand(c, proto, 1));
}

/**
 * 对齐 `Actions::JackOfAllTradesAction`（Actions.cpp:580）：1(升级 2) 张随机无色牌进手牌。
 *
 * ⚠ 三处照抄：① **不改费用**——多面手给的牌是原价，与地狱之刃 / 发现不同；
 * ② 两张都是 `addToTop`，于是**后抽到的那张先进手牌**（也先拿到 uid）；
 * ③ 走 `MakeTempCardInHand(CardId)` 那个重载，即 `CardInstance(cid, upgraded=false)`，
 * 造出来的牌恒未升级。
 */
function jackOfAllTradesAction(bc: BattleContext, upgraded: boolean): void {
  const c1 = getTrulyRandomColorlessCardInCombat(bc); // ★ 消耗一次 cardRandomRng
  addToTop(bc, (c) => makeTempCardInHand(c, c1, 1));
  if (upgraded) {
    const c2 = getTrulyRandomColorlessCardInCombat(bc); // ★ 消耗一次 cardRandomRng
    addToTop(bc, (c) => makeTempCardInHand(c, c2, 1));
  }
}

/**
 * 对齐 `Actions::TransmutationAction`（Actions.cpp:591）：把 X 张随机**无色**牌加进手牌，
 * **本回合** 0 费。
 *
 * ⚠ 五处照抄：
 *  ① `effectAmount = energy + (化学 X ? 2 : 0)`，`=== 0` 就整个提前返回——注意是**等于**
 *     而不是 `<= 0`（能量不会是负数，形状照参考）。X 为 0 时连 `useEnergy` 都不走。
 *  ② X 张牌**先全抽完**（每张一次 cardRandomRng），装成一个数组，再由**一条单独的**
 *     `MakeTempCardsInHand` 动作送进手牌。所以造牌与进手牌之间隔着一次动作调度。
 *  ③ `CardInstance c(cid, upgraded)` —— **嬗变升级后造出来的牌是升级态的**。
 *     这正是嬗变的升级效果（真实游戏卡面「它们是升级过的」），不是「多造一张」。
 *     与多面手 / 发现 / 蜕变那几张「恒造未升级」的完全相反。
 *  ④ 0 费走 `setCostForTurn(0)`，只管**本回合**（`cost` 不动，回合末会复位）——与蜕变/变形
 *     的「本场战斗 0 费」不同。X 费牌（池里就有嬗变自己）的 `costForTurn = -1` 会被
 *     `setCostForTurn` 的 `costForTurn >= 0` 门挡掉，保持 -1。
 *  ⑤ `useEnergy` 排在**最后**（在 addToBot 之后），花的是「当前全部能量」而非 X。
 */
function transmutationAction(
  bc: BattleContext,
  upgraded: boolean,
  energy: number,
  useEnergy: boolean,
): void {
  // 化学 X（CHEMICAL_X，第四十四批）：对齐 `Actions::TransmutationAction`（Actions.cpp:593）
  //     const auto effectAmount = energy + (bc.player.hasRelic<R::CHEMICAL_X>() ? 2 : 0);
  // ——与旋风斩那一句**逐字相同**。⚠ 但**这一半没有预言机**：嬗变造的是整池随机无色牌，
  // 而 harness 的 `isReplayableCard` 把嬗变与化学 X 放不到同一副牌组里（造出未登记的牌
  // 就不可重放）。照抄，如实记成盲区。⚠ 门是 `== 0` 而不是 `> 0`，与旋风斩那条相反，照抄。
  const effectAmount = energy + (hasRelic(bc, "chemical_x") ? 2 : 0);
  if (effectAmount === 0) {
    return;
  }
  const cards: CombatCard[] = [];
  for (let i = 0; i < effectAmount; i += 1) {
    const defId = getTrulyRandomColorlessCardInCombat(bc); // ★ 消耗一次 cardRandomRng
    const proto = cardInstanceProto(defId, upgraded);
    setCostForTurn(proto, 0);
    cards.push(proto);
  }
  addToBot(bc, (c) => makeTempCardsInHand(c, cards));
  if (useEnergy) {
    bc.player.energy = 0; // 对齐 `player.useEnergy(player.energy)`
  }
}

/**
 * 对齐 `Actions::ApotheosisAction`（Actions.cpp:1005）：升级**四个牌堆**里所有能升级的牌。
 *
 * ⚠ 三处照抄：
 *  ① 扫的是 **手牌 → 抽牌堆 → 弃牌堆 → 消耗堆** 四个堆，顺序即参考的书写顺序。
 *     ⚠ 消耗堆**也在其列**（真实游戏卡面只说「你所有的牌」，参考确实连消耗堆一起升）——
 *     这与回合末费用复位（只扫手/弃/抽三堆）和血债血偿（只扫手/抽/弃三堆）都不同，
 *     别照着那两处想当然。**master deck 不在其列**：升级只管「本场战斗剩余时间」。
 *  ② 逐张 `if (c.canUpgrade()) c.upgrade()`，所以诅咒/状态牌被跳过，
 *     而灼热之刃**每次都能再升一级**（`canUpgrade` 对它恒真）。
 *  ③ 神化自己不在任何堆里：`useCard` 尾部已经把它摘出手牌，而它进消耗堆是
 *     `OnAfterCardUsed` 的事、排在这条动作**之后**。所以它不会升级自己。
 */
function apotheosisAction(bc: BattleContext): void {
  for (const pile of [bc.hand, bc.drawPile, bc.discardPile, bc.exhaustPile]) {
    for (const card of pile) {
      if (canUpgradeCard(card)) {
        upgradeCard(card);
      }
    }
  }
}

/** 疯狂那个重抽循环的熔断（参考是裸 `while(true)`，见 madnessAction）。 */
const MADNESS_GUARD = 100000;

/**
 * 对齐 Actions::MadnessAction（Actions.cpp:368）：把手牌里随机一张的费用置 0。
 *
 * ⚠ 三处必须逐字照抄，否则 cardRandomRng 的 counter 立刻错位：
 *  ① **预扫描的 break**。循环体是「先看 costForTurn > 0，是就置 haveNonZeroTurnCost 并
 *     **break**；否则再看 cost > 0，是就置 haveNonZeroCost」。所以 haveNonZeroCost 只累积
 *     到第一张「本回合费用 > 0」的牌为止——不是「全手牌有没有 cost>0 的」。
 *  ② 两个标志决定用哪个判据重抽：有 costForTurn>0 的牌就只认 costForTurn，否则只认 cost。
 *     两者会分岔：腐化把抽到的技能牌 costForTurn 压成 0 但 **cost 不变**，于是「全手牌
 *     costForTurn 都是 0、却有 cost>0」是真实可达的状态，走的正是第二支。
 *  ③ 重抽是**拒绝采样**：每转一圈掷一次 `cardRandomRng.random(手牌数-1)`，选中的牌不满足
 *     判据就丢掉结果重来。次数不定，这正是它对 RNG 时序的影响。
 *  命中后 cost 与 costForTurn **都**置 0（所以疯狂的 0 费是永久的，回合末复位也拉不回来）。
 */
function madnessAction(bc: BattleContext): void {
  let haveNonZeroCost = false;
  let haveNonZeroTurnCost = false;
  for (const card of bc.hand) {
    if (card.costForTurn > 0) {
      haveNonZeroTurnCost = true;
      break;
    }
    if (card.cost > 0) {
      haveNonZeroCost = true;
    }
  }
  if (!haveNonZeroCost && !haveNonZeroTurnCost) {
    return;
  }
  // 走到这里手牌必然非空、且必然存在满足判据的牌，所以参考的 `while(true)` 一定终止。
  // 熔断只是防我们自己抄错，触发即说明上面的预扫描与下面的判据对不上。
  for (let guard = 0; guard < MADNESS_GUARD; guard += 1) {
    const idx = bc.rng.cardRandomRng.random(bc.hand.length - 1); // ★ 消耗一次 cardRandomRng
    const card = bc.hand[idx];
    const hit = haveNonZeroTurnCost ? card.costForTurn > 0 : card.cost > 0;
    if (hit) {
      card.cost = 0;
      card.costForTurn = 0;
      return;
    }
  }
  throw new Error("madnessAction 重抽熔断（预扫描与判据不一致）");
}

/**
 * 获得腐化（对齐 `Actions::BuffPlayer<PS::CORRUPTION>`，BattleContext.h:220）。
 *
 * ⚠ 两处照抄：① **已经有腐化时整条什么都不做**——`player.buff<CORRUPTION>` 走的是
 * `setHasStatus(true)` 那一支（Player.h:335 把 CORRUPTION 与壁垒/困惑/笔尖/被围攻列在一起），
 * 是个纯 bool、没有层数，所以第二张腐化不会叠成 2 层；② 只有在**原本没有**腐化时才跑
 * `cards.onBuffCorruption()`，把场上已有的技能牌一次性压成 0 费。
 */
function buffCorruption(bc: BattleContext): void {
  if (getPower(bc.player.powers, "corruption") > 0) {
    return;
  }
  onBuffCorruption(bc);
  addPower(bc.player.powers, "corruption", 1);
}

/**
 * 腐化落地时的一次性扫场（对齐 CardManager::onBuffCorruption，CardManager.cpp:536）。
 *
 * ⚠ 与进牌时那两个钩子不同：这里改的是 **cost 本身**（连带 costForTurn），所以回合末的
 * `resetAttributesAtEndOfTurn` 拉不回来——腐化对当时在场的技能牌是**永久**降费。
 * 而 `drawOneCard` / `moveToHandHelper` 那两条只改 costForTurn，是**每回合重新压**。
 * ⚠ 四个牌堆都扫（含**消耗堆**），且只动 `cost > 0` 的技能牌。
 */
function onBuffCorruption(bc: BattleContext): void {
  for (const pile of [bc.hand, bc.drawPile, bc.discardPile, bc.exhaustPile]) {
    for (const card of pile) {
      if (getCardDef(card.defId).type === "skill" && card.cost > 0) {
        card.cost = 0;
        card.costForTurn = 0;
      }
    }
  }
}

/**
 * 一条卡牌规则。
 *
 * 第四个参数是**被打出的那张牌实例**——参考的 `useAttackCard` 等函数拿的是
 * `curCardQueueItem.card`，暴走的 `c.specialData += …`、灼热之刃的 `c.getUpgradeCount()`
 * 都读写它。⚠ 参考那份是 CardQueueItem 里的**副本**（`CardInstance card;` 按值存），
 * 而 `OnAfterCardUsed` 又是把那份副本放进弃牌堆/消耗堆的，所以对它的改动会跟着牌走。
 * 我们直接把手牌里那个对象传进来、`onAfterUseCard` 搬的也是同一个对象，两边等价
 * ——前提是打牌到结算之间没人动手牌，而 playCard 只在 player_normal 受理、
 * 入队后立刻抽干，这个前提成立。
 */
type CardRule = (
  bc: BattleContext,
  item: CardQueueItem,
  upgraded: boolean,
  card: CombatCard,
) => void;

const CARD_RULES: Record<string, CardRule> = {
  // 打击：造成 6(升级 9) 点伤害。对齐 BattleContext.cpp:967 STRIKE_RED。
  strike: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 9 : 6, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },
  // 防御：获得 5(升级 8) 点格挡。GainBlock 的 clearOnCombatVictory=false。
  defend: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 8 : 5);
    addToBot(bc, (c) => gainBlock(c, blk), false);
  },
  // 痛击：造成 8(升级 10) 点伤害并施加 2(升级 3) 层易伤。对齐 BattleContext.cpp:980 BASH。
  bash: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 8, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => debuffEnemy(c, item.target, "vulnerable", up ? 3 : 2));
  },

  // —— 铁甲常用卡首批 ——

  // 愤怒：伤害 + 复制一张自身进弃牌堆。
  anger: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 8 : 6, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => {
      c.discardPile.push(makeCardInstance(c, "anger", up));
    });
  },

  // 顺劈斩：对全体。基础值先加精力，再由 AttackAllEnemy 逐怪算伤害。
  cleave: (bc, _item, up, card) =>
    attackAllEnemies(bc, (up ? 11 : 8) + getPower(bc.player.powers, "vigor"), card),

  // 十字打击：伤害 + 虚弱。
  clothesline: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 14 : 12, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => debuffEnemy(c, item.target, "weak", up ? 3 : 2));
  },

  // 重刃：⚠ 基础值已含 2×力量，再过一次 calculateCardDamage 又加一次力量——
  // 力量实际算了**三**次。这是参考的算法，不是笔误，照抄。
  heavy_blade: (bc, item, up, card) => {
    const base = 14 + (up ? 4 : 2) * getPower(bc.player.powers, "strength");
    const dmg = calculateCardDamage(bc, item.target, base, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 铁浪：格挡 + 伤害，先加格挡后造成伤害。
  //
  // ⚠ 参考项目曾在这里把 calculateCardBlock 套了两层，敏捷因此被算两次
  //（敏捷 2 时给 9 点而非 7 点）。全项目 15 处同类写法都是单层、只有这里嵌套，
  // 且无测试覆盖——已确认是笔误并在参考侧修复（sts_lightspeed 49c5390），
  // 样例数据随之重新生成。此处按正确的单层实现。
  iron_wave: (bc, item, up, card) => {
    const blk = calculateCardBlock(bc, up ? 7 : 5);
    const dmg = calculateCardDamage(bc, item.target, up ? 7 : 5, card);
    addToBot(bc, (c) => gainBlock(c, blk), false);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 柄击：伤害 + 抽牌。
  pommel_strike: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 9, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => drawCards(c, up ? 2 : 1));
  },

  // 无视苦难：格挡 + 抽 1（升级只加格挡，抽牌恒为 1）。
  shrug_it_off: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 11 : 8);
    addToBot(bc, (c) => gainBlock(c, blk), false);
    addToBot(bc, (c) => drawCards(c, 1));
  },

  // 雷霆之击：对全体伤害 + 全体 1 层易伤。
  thunderclap: (bc, _item, up, card) => {
    attackAllEnemies(bc, (up ? 7 : 4) + getPower(bc.player.powers, "vigor"), card);
    addToBot(bc, (c) => {
      for (let i = c.monsters.length - 1; i >= 0; i -= 1) {
        if (c.monsters[i]?.alive === true) {
          addToTop(c, (c2) => debuffEnemy(c2, i, "vulnerable", 1, false));
        }
      }
    });
  },

  // 双重打击：同一伤害值打两次（伤害只算一次，两击等值）。
  twin_strike: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 7 : 5, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 全身撞击：伤害等于**当前格挡**（入队时取值）。
  body_slam: (bc, item, _up, card) => {
    const dmg = calculateCardDamage(bc, item.target, bc.player.block, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 燃烧：+2(升级 3) 力量（能力牌）。
  inflame: (bc, _item, up) =>
    addToBot(bc, (c) => addPower(c.player.powers, "strength", up ? 3 : 2)),

  // ==========================================================================
  // 铺量第二批 · 攻击牌（对齐 BattleContext::useAttackCard，BattleContext.cpp:966 起）
  // ==========================================================================

  // 撕咬：造成 7(升级 8) 点伤害，回复 2(升级 3) 点生命。对齐 BattleContext.cpp:986 BITE。
  bite: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 8 : 7, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    // HealPlayer 的 clearOnCombatVictory=false（Actions.cpp:117）：打出致命一击后战斗虽已
    // 胜利，这口血照样要回。标 true 会让它被 clearPostCombatActions 吞掉。
    addToBot(bc, (c) => healPlayer(c, up ? 3 : 2), false);
  },

  // 血肉巨兵：造成 32(升级 42) 点伤害。对齐 BattleContext.cpp:999 BLUDGEON。
  bludgeon: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 42 : 32, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 飞踢：造成 5(升级 8) 点伤害；若目标处于易伤，获得 1 点能量并抽 1 张牌。
  // 对齐 BattleContext.cpp:1028 DROPKICK → Actions::DropkickAction（Actions.cpp:1035）。
  //
  // ⚠ 三处都要照抄：① 伤害在动作**执行时**才算（不同于绝大多数攻击牌在打牌时算好）；
  // ② 易伤判定排在攻击**之前**，所以即便这一击打死目标，能量与抽牌照样兑现；
  // ③ 三个 addToTop 的推入顺序是「抽牌 → 能量 → 攻击」，故实际执行顺序反过来：
  //    先结算攻击，再回能量，最后抽牌。
  dropkick: (bc, item, up, card) => {
    addToBot(bc, (c) => {
      const m = c.monsters[item.target];
      if (m?.alive === true && getPower(m.powers, "vulnerable") > 0) {
        addToTop(c, (c2) => drawCards(c2, 1));
        addToTop(c, (c2) => {
          c2.player.energy += 1;
        });
      }
      const dmg = calculateCardDamage(c, item.target, up ? 8 : 5, card);
      addToTop(c, (c2) => attackEnemy(c2, item.target, dmg));
    });
  },

  // 进食：造成 10(升级 12) 点伤害；若这一击**击杀**目标，永久 +3(升级 4) 生命上限。消耗。
  // 对齐 BattleContext.cpp:1032 FEED → Actions::FeedAction（Actions.cpp:1070）。
  //
  // ⚠ 不能复用 attackEnemy：FeedAction 自己判死活、自己 checkCombat，而「加生命上限」
  // 夹在扣血与 checkCombat **之间**——顺序照抄。
  // 参考的豁免条件还有小怪(MINION) / 半死(halfDead) / 重生(REGROW)，当前登记的四种怪
  // 一个都不具备，故未转写；登记那些怪时必须补回来。
  feed: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 12 : 10, card);
    addToBot(bc, (c) => {
      const m = c.monsters[item.target];
      if (m === undefined || !m.alive) {
        return;
      }
      monsterAttacked(c, m, dmg);
      if (!m.alive) {
        increasePlayerMaxHp(c, up ? 4 : 3);
      }
      checkCombat(c);
    });
  },

  // 恶魔之火：消耗手中所有牌，每消耗一张造成 7(升级 10) 点伤害。自身也消耗。
  // 对齐 BattleContext.cpp:1036 FIEND_FIRE → Actions::FiendFireAction（Actions.cpp:1091）。
  //
  // ⚠ 两个循环都是 addToTop，且**攻击先入队、消耗后入队**，于是执行顺序整个反过来：
  // 先随机消耗 N 张，再打 N 次。N 是动作执行时的手牌数（本牌此时已被 useCard 移出手牌）。
  // 伤害在打牌时算好一次，N 次攻击等值。
  fiend_fire: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 7, card);
    addToBot(bc, (c) => {
      const n = c.hand.length;
      for (let i = 0; i < n; i += 1) {
        addToTop(c, (c2) => attackEnemy(c2, item.target, dmg));
      }
      for (let i = 0; i < n; i += 1) {
        addToTop(c, (c2) => exhaustRandomCardInHand(c2, 1)); // ★ 每张消耗一次 cardRandomRng
      }
    });
  },

  // 精钢闪光：造成 3(升级 6) 点伤害，抽 1 张牌。对齐 BattleContext.cpp:1040 FLASH_OF_STEEL。
  flash_of_steel: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 6 : 3, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => drawCards(c, 1));
  },

  // 血液动力：自失 2 点生命，造成 15(升级 20) 点伤害。
  // 对齐 BattleContext.cpp:1061 HEMOKINESIS。
  //
  // ⚠ 伤害在**打牌时**就算好，所以失血引起的加力量（破裂）不影响这一击——参考里那两行
  // 注释正是作者自问自答确认了这一点。失血走 PlayerLoseHp(2, **true**)，
  // clearOnCombatVictory=false。
  hemokinesis: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 20 : 15, card);
    addToBot(bc, (c) => playerLoseHp(c, 2, true), false);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 冲拳：造成 4(升级 5) 次 2 点伤害。消耗。对齐 BattleContext.cpp:1100 PUMMEL。
  // 伤害只算一次，各击等值（与双重打击同款写法）。
  pummel: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, 2, card);
    const hits = up ? 5 : 4;
    for (let i = 0; i < hits; i += 1) {
      addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    }
  },

  // 收割：对全体造成 4(升级 5) 点伤害，回复其中**未被格挡**的伤害总和。消耗。
  // 对齐 BattleContext.cpp:1121 REAPER → Actions::ReaperAction（Actions.cpp:1130）。
  //
  // ⚠ 与顺劈斩那类 AttackAllEnemy 不同：ReaperAction **逐怪现算现打**，不预先算伤害矩阵。
  // ⚠ 也**不调 checkCombat**——参考里那段被注释掉了（Actions.cpp:1148）。少了这一步，
  // 收割打死最后一只怪时排队动作不会被清，回血因此仍会落地。照抄。
  reaper: (bc, _item, up, card) => {
    const base = (up ? 5 : 4) + getPower(bc.player.powers, "vigor");
    addToBot(bc, (c) => {
      let healAmount = 0;
      for (let i = 0; i < c.monsters.length; i += 1) {
        const m = c.monsters[i];
        if (m === undefined || !m.alive) {
          continue;
        }
        const hpBefore = m.hp;
        monsterAttacked(c, m, calculateCardDamage(c, i, base, card));
        healAmount += hpBefore - m.hp;
      }
      if (healAmount > 0) {
        addToBot(c, (c2) => healPlayer(c2, healAmount), false);
      }
    });
  },

  // 断魂斩：消耗手中所有非攻击牌，造成 16(升级 22) 点伤害。
  // 对齐 BattleContext.cpp:1143 SEVER_SOUL → Actions::SeverSoulExhaustAction（Actions.cpp:1201）。
  //
  // ⚠ 时序反直觉但照抄：消耗动作本身先入队，但它执行时又把逐张消耗 addToBot 到队尾，
  // 于是排在攻击与 OnAfterCardUsed **之后**——实际是「先打伤害，再消耗那些非攻击牌」。
  // 手牌下标按**降序**消耗，因此下标始终有效。伤害在打牌时算好（消耗之前）。
  sever_soul: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 22 : 16, card);
    addToBot(bc, (c) => {
      for (let i = c.hand.length - 1; i >= 0; i -= 1) {
        const card = c.hand[i];
        if (getCardDef(card.defId).type !== "attack") {
          const idx = i;
          const uid = card.uid;
          addToBot(c, (c2) => exhaustSpecificCardInHand(c2, idx, uid));
        }
      }
    });
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 回旋镖：造成 3 点伤害，随机目标，重复 3(升级 4) 次。
  // 对齐 BattleContext.cpp:1152 SWORD_BOOMERANG → Actions::SwordBoomerangAction（Actions.cpp:1212）。
  //
  // ⚠ 基础值（含精力）在**打牌时**取，但目标与最终伤害在每次动作**执行时**才算——参考
  // 自己标注这是为了绕开「精力打完即清」的时序而刻意留的 hack，照抄。
  // 攻击走 addToTop，故节奏是「掷目标 → 立刻结算这一击 → 再掷下一个目标」。
  sword_boomerang: (bc, _item, up, card) => {
    const base = 3 + getPower(bc.player.powers, "vigor");
    const hits = up ? 4 : 3;
    for (let i = 0; i < hits; i += 1) {
      addToBot(bc, (c) => {
        // 对齐 getRandomMonsterIdx(rng, aliveOnly=true) 的 -1 提前返回：全灭则不掷 RNG。
        if (c.monstersAlive === 0) {
          return;
        }
        const idx = getRandomMonsterIdx(c); // ★ 消耗一次 cardRandomRng
        const dmg = calculateCardDamage(c, idx, base, card);
        addToTop(c, (c2) => attackEnemy(c2, idx, dmg));
      });
    }
  },

  // 迅捷打击：造成 7(升级 10) 点伤害。对齐 BattleContext.cpp:1148 SWIFT_STRIKE。
  swift_strike: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 7, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // ==========================================================================
  // 铺量第二批 · 技能牌（对齐 BattleContext::useSkillCard，BattleContext.cpp:1209 起）
  // ==========================================================================

  // 包扎：回复 4(升级 6) 点生命。消耗。对齐 BattleContext.cpp:1234 BANDAGE_UP。
  bandage_up: (bc, _item, up) => {
    addToBot(bc, (c) => healPlayer(c, up ? 6 : 4), false);
  },

  // 致盲：给目标 2 层虚弱；升级后改为**全体** 2 层。对齐 BattleContext.cpp:1243 BLIND。
  // 升级前后走的是两个不同 Action（DebuffEnemy vs DebuffAllEnemy），结算顺序不同，
  // 不能合并成一句。
  blind: (bc, item, up) => {
    if (up) {
      debuffAllEnemies(bc, "weak", 2);
    } else {
      addToBot(bc, (c) => debuffEnemy(c, item.target, "weak", 2, false));
    }
  },

  // 放血：自失 3 点生命，获得 2(升级 3) 点能量。对齐 BattleContext.cpp:1251 BLOODLETTING。
  // 失血是 `PlayerLoseHp(3, true)`，会触发破裂。
  bloodletting: (bc, _item, up) => {
    addToBot(bc, (c) => playerLoseHp(c, 3, true), false);
    addToBot(bc, (c) => {
      c.player.energy += up ? 3 : 2;
    });
  },

  // 深呼吸：把弃牌堆洗回抽牌堆，抽 1(升级 2) 张。对齐 BattleContext.cpp:1272 DEEP_BREATH。
  //
  // ⚠ 弃牌堆非空时消耗**两次** shuffleRng：EmptyDeckShuffle 先洗弃牌堆再并入抽牌堆，
  // 紧接着 ShuffleDrawPile 把整个抽牌堆再洗一次。弃牌堆为空时两次都不做，只抽牌——
  // 少判这个条件会白吃两次 shuffleRng，counter 立刻错位。
  deep_breath: (bc, _item, up) => {
    if (bc.discardPile.length > 0) {
      onShuffle(bc); // 同步调用（参考在入队之前直接调）
      addToBot(bc, (c) => {
        shuffleCards(c, c.discardPile); // ★ 消耗一次 shuffleRng
        moveDiscardPileIntoDrawPile(c);
      });
      addToBot(bc, (c) => {
        shuffleCards(c, c.drawPile); // ★ 再消耗一次 shuffleRng
      });
    }
    addToBot(bc, (c) => drawCards(c, up ? 2 : 1));
  },

  // 严阵以待：格挡翻倍。对齐 BattleContext.cpp:1302 ENTRENCH → Actions::EntrenchAction。
  //
  // ⚠ 两处与防御类卡不同：① 走 EntrenchAction 而非 GainBlock，故 clearOnCombatVictory 是
  // **默认 true**（战斗已胜利时这份格挡会被清掉）；② **不过** calculateCardBlock，
  // 敏捷/脆弱都不参与——它加的就是当前格挡值本身，且在动作执行时才读。
  entrench: (bc) => {
    addToBot(bc, (c) => gainBlock(c, c.player.block));
  },

  // 灵巧：获得 2(升级 4) 点格挡，抽 1 张牌。对齐 BattleContext.cpp:1310 FINESSE。
  finesse: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 4 : 2);
    addToBot(bc, (c) => gainBlock(c, blk), false);
    addToBot(bc, (c) => drawCards(c, 1));
  },

  // 直觉：获得 6(升级 9) 点格挡。对齐 BattleContext.cpp:1333 GOOD_INSTINCTS。
  good_instincts: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 9 : 6);
    addToBot(bc, (c) => gainBlock(c, blk), false);
  },

  // 铜墙铁壁：获得 30(升级 40) 点格挡。消耗。对齐 BattleContext.cpp:1355 IMPERVIOUS。
  impervious: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 40 : 30);
    addToBot(bc, (c) => gainBlock(c, blk), false);
  },

  // 恐吓：给全体 1(升级 2) 层虚弱。消耗。对齐 BattleContext.cpp:1363 INTIMIDATE。
  intimidate: (bc, _item, up) => debuffAllEnemies(bc, "weak", up ? 2 : 1),

  // 杰克斯：自失 3 点生命，获得 2(升级 3) 点力量。对齐 BattleContext.cpp:1371 JAX。
  // ⚠ 失血是 `PlayerLoseHp(3, true)`，先于加力量结算，所以破裂那份力量会叠在前面。
  jax: (bc, _item, up) => {
    addToBot(bc, (c) => playerLoseHp(c, 3, true), false);
    addToBot(bc, (c) => addPower(c.player.powers, "strength", up ? 3 : 2));
  },

  // 战略大师：抽 3(升级 4) 张牌。消耗。对齐 BattleContext.cpp:1384 MASTER_OF_STRATEGY。
  master_of_strategy: (bc, _item, up) => {
    addToBot(bc, (c) => drawCards(c, up ? 4 : 3));
  },

  // 献祭：自失 6 点生命，获得 2 点能量，抽 3(升级 5) 张牌。消耗。
  // 对齐 BattleContext.cpp:1392 OFFERING。⚠ 能量恒为 2，升级只加抽牌数。
  // 失血是 `PlayerLoseHp(6, true)`，会触发破裂。
  offering: (bc, _item, up) => {
    addToBot(bc, (c) => playerLoseHp(c, 6, true), false);
    addToBot(bc, (c) => {
      c.player.energy += 2;
    });
    addToBot(bc, (c) => drawCards(c, up ? 5 : 3));
  },

  // 万灵药：获得 1(升级 2) 层神器。消耗。对齐 BattleContext.cpp:1398 PANACEA。
  panacea: (bc, _item, up) => {
    addToBot(bc, (c) => addPower(c.player.powers, "artifact", up ? 2 : 1));
  },

  // 再生之风：消耗手中所有非攻击牌，每张获得 5(升级 7) 点格挡。
  // 对齐 BattleContext.cpp:1428 SECOND_WIND → Actions::SecondWindAction（Actions.cpp:1179）。
  //
  // ⚠ 两轮都是 addToTop：先按手牌下标**升序**推入 GainBlock（等值，顺序无所谓），再按
  // 升序推入逐张消耗 → 实际执行是下标**降序**消耗，下标因此始终有效。写成正序消耗会
  // 越消耗越错位。格挡额度在打牌时按当时的敏捷/脆弱算好一次。
  second_wind: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 7 : 5);
    addToBot(bc, (c) => {
      const toExhaust: { idx: number; uid: number }[] = [];
      for (let i = 0; i < c.hand.length; i += 1) {
        const card = c.hand[i];
        if (getCardDef(card.defId).type !== "attack") {
          toExhaust.push({ idx: i, uid: card.uid });
          addToTop(c, (c2) => gainBlock(c2, blk), false);
        }
      }
      for (const t of toExhaust) {
        addToTop(c, (c2) => exhaustSpecificCardInHand(c2, t.idx, t.uid));
      }
    });
  },

  // 冲击波：给全体 3(升级 5) 层虚弱与 3(升级 5) 层易伤。消耗。
  // 对齐 BattleContext.cpp:1440 SHOCKWAVE。两次 DebuffAllEnemy 顺序固定：先虚弱后易伤。
  shockwave: (bc, _item, up) => {
    debuffAllEnemies(bc, "weak", up ? 5 : 3);
    debuffAllEnemies(bc, "vulnerable", up ? 5 : 3);
  },

  // 觅敌之弱：若目标意图为攻击，获得 3(升级 4) 点力量。
  // 对齐 BattleContext.cpp:1450 SPOT_WEAKNESS → Actions::SpotWeaknessAction（Actions.cpp:1225）。
  // ⚠ 判定在动作**执行时**读目标当前意图，不是打牌时。
  spot_weakness: (bc, item, up) => {
    addToBot(bc, (c) => {
      if (isMonsterAttacking(c, item.target)) {
        addPower(c.player.powers, "strength", up ? 4 : 3);
      }
    });
  },

  // ==========================================================================
  // 铺量第二批 · 能力牌（对齐 BattleContext::usePowerCard，BattleContext.cpp:1516 起）
  // ==========================================================================

  // 狂暴：每回合能量 +1，并给自己 2(升级 1) 层易伤。对齐 BattleContext.cpp:1522 BERSERK。
  //
  // ⚠ 两点都反直觉：① energyPerTurn 是**同步**自增（`++player.energyPerTurn`，不入队），
  // 只有易伤走 addToBot；② 易伤传 isSourceMonster=false，故**不跳过**首次递减——
  // 本回合末就掉一层。升级是把易伤从 2 减到 1（数值方向与其它牌相反）。
  berserk: (bc, _item, up) => {
    bc.player.energyPerTurn += 1;
    addToBot(bc, (c) => debuffPlayer(c, "vulnerable", up ? 1 : 2, false));
  },

  // ==========================================================================
  // 铺量第三批 · 攻击牌
  // ==========================================================================

  // 上勾拳：造成 13 点伤害，施加 1(升级 2) 层虚弱与 1(升级 2) 层易伤。
  // 对齐 BattleContext.cpp:1172 UPPERCUT。⚠ 升级只加减益层数，伤害恒为 13。
  // 顺序固定：伤害 → 虚弱 → 易伤。
  uppercut: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, 13, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => debuffEnemy(c, item.target, "weak", up ? 2 : 1, false));
    addToBot(bc, (c) => debuffEnemy(c, item.target, "vulnerable", up ? 2 : 1, false));
  },

  // ==========================================================================
  // 铺量第三批 · 技能牌
  // ==========================================================================

  // 战斗恍惚：抽 3(升级 4) 张牌，本回合无法再抽牌。
  // 对齐 BattleContext.cpp:1238 BATTLE_TRANCE。
  // ⚠ 顺序不能换：先抽牌、后上 NO_DRAW，否则自己把自己的抽牌堵死。
  battle_trance: (bc, _item, up) => {
    addToBot(bc, (c) => drawCards(c, up ? 4 : 3));
    addToBot(bc, (c) => debuffPlayer(c, "no_draw", 1));
  },

  // 缴械：目标失去 2(升级 3) 点力量。消耗。对齐 BattleContext.cpp:1281 DISARM。
  //
  // ⚠ 参考此前完全没读 `up`（升级分支缺失），已在参考侧修正（sts_lightspeed 4c3893a）。
  // 走 DebuffEnemy 而非 BuffEnemy(-n)，所以会被神器吃掉一层。
  disarm: (bc, item, up) => {
    addToBot(bc, (c) => debuffEnemy(c, item.target, "strength", up ? -3 : -2, false));
  },

  // 灵活：获得 2(升级 4) 点力量，本回合结束时失去这些力量。
  // 对齐 BattleContext.cpp:1324 FLEX。
  //
  // ⚠ 加力量走 BuffPlayer、还债走 DebuffPlayer<LOSE_STRENGTH>——后者会被神器抵消，
  // 于是「神器在手时打灵活，力量白拿不用还」。参考与真实游戏都是这个表现。
  flex: (bc, _item, up) => {
    addToBot(bc, (c) => addPower(c.player.powers, "strength", up ? 4 : 2));
    addToBot(bc, (c) => debuffPlayer(c, "lose_strength", up ? 4 : 2));
  },

  // 急躁：若手中**没有攻击牌**，抽 2(升级 3) 张牌。
  // 对齐 BattleContext.cpp:1341 IMPATIENCE。
  //
  // ⚠ 两处：① 手牌扫描是**同步**做的（打牌时当场扫），只有抽牌入队；② 此刻本牌尚未被
  // useCard 移出手牌，但它是技能牌，不会被自己判成攻击牌。
  // 参考原先在循环里写 `hasAttack = false;`（应为 true），条件恒假、退化成无条件抽牌，
  // 已在参考侧修正（sts_lightspeed 4c3893a）。
  impatience: (bc, _item, up) => {
    const hasAttack = bc.hand.some((c) => getCardDef(c.defId).type === "attack");
    if (!hasAttack) {
      addToBot(bc, (c) => drawCards(c, up ? 3 : 2));
    }
  },

  // 极限爆发：当前力量翻倍。消耗（升级后不消耗）。
  // 对齐 BattleContext.cpp:1376 LIMIT_BREAK → Actions::LimitBreakAction（Actions.cpp:1124）。
  //
  // ⚠ 与严阵以待同款：翻倍量在动作**执行时**才读，且力量为 0 时 Player::buff 的
  // `amount == 0` 提前返回什么都不做。负力量同样翻倍（-3 → -6）。
  limit_break: (bc) => {
    addToBot(bc, (c) => {
      const strength = getPower(c.player.powers, "strength");
      if (strength !== 0) {
        addPower(c.player.powers, "strength", strength);
      }
    });
  },

  // 见红：获得 2 点能量。消耗。对齐 BattleContext.cpp:1432 SEEING_RED。
  // ⚠ 参考的 doesCardExhaust 名单漏了它，已在参考侧修正（sts_lightspeed 4c3893a）。
  // 升级只降费（1 → 0），能量恒为 2。
  seeing_red: (bc) => {
    addToBot(bc, (c) => {
      c.player.energy += 2;
    });
  },

  // 绊摔：给目标 2 层易伤；升级后改为**全体** 2 层。0 费。
  // 对齐 BattleContext.cpp:1474 TRIP。
  //
  // ⚠ 与致盲同构：升级前后走的是两个不同 Action（DebuffEnemy vs DebuffAllEnemy），
  // 多怪场景下结算顺序不同，不能合并成一句。
  // 参考的 getEnergyCost 把它错列进费用 1 组，已在参考侧修正（sts_lightspeed 4c3893a）。
  trip: (bc, item, up) => {
    if (up) {
      debuffAllEnemies(bc, "vulnerable", 2);
    } else {
      addToBot(bc, (c) => debuffEnemy(c, item.target, "vulnerable", 2, false));
    }
  },

  // ==========================================================================
  // 铺量第三批 · 能力牌（回合边界触发的那批，结算点见 callEndOfTurnActions /
  // applyEndOfTurnPowers / applyStartOfTurnPostDrawPowers）
  // ==========================================================================

  // 壁垒：格挡不再于回合开始时清空。对齐 BattleContext.cpp:1518 BARRICADE。
  //
  // ⚠ **同步**生效（`player.setHasStatus<PS::BARRICADE>(true)`，不入队），与狂暴的
  // energyPerTurn++ 同款。参考里它是个 bool 位、根本不进 statusMap，没有层数概念；
  // 我们统一用 powers 表达，故记为 1 层，判定只看「有没有」。
  barricade: (bc) => {
    addPower(bc.player.powers, "barricade", 1);
  },

  // 燃烧：获得 5(升级 7) 层燃烧。对齐 BattleContext.cpp:1535 COMBUST。
  //
  // ⚠ `Player::buff<PS::COMBUST>` 除了累加层数还 `++combustHpLoss`，两个数各自独立：
  // 层数决定每回合末对全体的伤害，combustHpLoss 决定失多少血（等于打过几张燃烧）。
  // 叠两张未升级的燃烧 = 10 点伤害 + 失 2 血，不是失 1 血。
  combust: (bc, _item, up) =>
    addToBot(bc, (c) => {
      c.player.combustHpLoss += 1;
      addPower(c.player.powers, "combust", up ? 7 : 5);
    }),

  // 恶魔形态：获得 2(升级 3) 层恶魔形态。对齐 BattleContext.cpp:1539 DEMON_FORM。
  demon_form: (bc, _item, up) =>
    addToBot(bc, (c) => addPower(c.player.powers, "demon_form", up ? 3 : 2)),

  // 金属化：获得 3(升级 4) 层金属化。对齐 BattleContext.cpp:1575 METALLICIZE。
  metallicize: (bc, _item, up) =>
    addToBot(bc, (c) => addPower(c.player.powers, "metallicize", up ? 4 : 3)),

  // ==========================================================================
  // 铺量第四批 · 选牌屏解锁的那批（开屏逻辑见上方「选牌屏」一节）
  // ==========================================================================

  // 军备：获得 5 点格挡，升级一张手牌（升级后改为升级**全部**手牌）。
  // 对齐 BattleContext.cpp:1217 ARMAMENTS。
  //
  // ⚠ 格挡恒为 5，升级只改第二项效果——两条分支走的是完全不同的 Action
  //（ArmamentsAction 会开选牌屏，UpgradeAllCardsInHand 不会），不能合并。
  armaments: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, 5);
    addToBot(bc, (c) => gainBlock(c, blk), false);
    if (up) {
      addToBot(bc, (c) => upgradeAllCardsInHand(c));
    } else {
      addToBot(bc, (c) => armamentsAction(c));
    }
  },

  // 焚誓：消耗一张手牌，然后抽 2(升级 3) 张牌。对齐 BattleContext.cpp:1256 BURNING_PACT。
  //
  // ⚠ 这是本批唯一「开屏时后面还排着动作」的牌：ChooseExhaustOne 开屏后 DrawCards 仍在
  // 队里，等选完才抽。故抽牌那条必须带 ActionDesc，否则选牌屏上取档会把它丢掉。
  burning_pact: (bc, _item, up) => {
    addToBot(bc, (c) => chooseExhaustOneAction(c));
    const count = up ? 3 : 2;
    addToBot(bc, (c) => drawCards(c, count), true, { kind: "draw_cards", count });
  },

  // 头槌：造成 9(升级 12) 点伤害，把弃牌堆里选一张置于抽牌堆顶。
  // 对齐 BattleContext.cpp:1049 HEADBUTT。
  headbutt: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 12 : 9, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => headbuttAction(c));
  },

  // 净化：消耗手牌中至多 3(升级 5) 张。消耗。对齐 BattleContext.cpp:1412 PURITY。
  //
  // ⚠ ExhaustMany 无条件开屏（手牌为空也开），且是本批唯一的**多选**屏。
  purity: (bc, _item, up) => {
    addToBot(bc, (c) => exhaustManyAction(c, up ? 5 : 3));
  },

  // 秘密技巧：从抽牌堆检索一张**技能**牌进手牌。消耗（升级后不消耗）。
  // 对齐 BattleContext.cpp:1420 SECRET_TECHNIQUE。
  secret_technique: (bc) => {
    addToBot(bc, (c) => drawToHandAction(c, "secret_technique", "skill"));
  },

  // 秘密武器：同上，检索**攻击**牌。对齐 BattleContext.cpp:1424 SECRET_WEAPON。
  secret_weapon: (bc) => {
    addToBot(bc, (c) => drawToHandAction(c, "secret_weapon", "attack"));
  },

  // 未雨绸缪：抽 2 张牌，把一张手牌置于抽牌堆顶。消耗（升级后不消耗）。
  // 对齐 BattleContext.cpp:1458 THINKING_AHEAD（参考注释：与升级版战吼同构）。
  // ⚠ 抽牌数恒为 2，升级只影响是否消耗。
  thinking_ahead: (bc) => {
    addToBot(bc, (c) => drawCards(c, 2));
    addToBot(bc, (c) => warcryAction(c));
  },

  // 坚毅：获得 7(升级 9) 点格挡，消耗一张手牌——未升级是**随机**消耗，升级后**由你选**。
  // 对齐 BattleContext.cpp:1482 TRUE_GRIT。
  //
  // ⚠ 两条分支的 RNG 消耗完全不同：随机那支走 cardRandomRng，选牌那支不掷 RNG 而是开屏。
  true_grit: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 9 : 7);
    addToBot(bc, (c) => gainBlock(c, blk), false);
    if (up) {
      addToBot(bc, (c) => chooseExhaustOneAction(c));
    } else {
      addToBot(bc, (c) => exhaustRandomCardInHand(c, 1)); // ★ 消耗一次 cardRandomRng
    }
  },

  // 掘尸：从消耗堆取回一张牌到手牌。消耗。对齐 BattleContext.cpp:1306 EXHUME。
  exhume: (bc) => {
    addToBot(bc, (c) => exhumeAction(c));
  },

  // 战吼：抽 1(升级 2) 张牌，把一张手牌置于抽牌堆顶。消耗。
  // 对齐 BattleContext.cpp:1495 WARCRY。
  warcry: (bc, _item, up) => {
    addToBot(bc, (c) => drawCards(c, up ? 2 : 1));
    addToBot(bc, (c) => warcryAction(c));
  },

  // ==========================================================================
  // 铺量第五批 · 牌的生命周期（消耗触发 / 状态牌生成 / 以太 / 固有归位）
  // ==========================================================================

  // —— 消耗触发（结算点见 triggerAndMoveToExhaustPile）——

  // 黑暗拥抱：每当一张牌被消耗，抽 1 张牌。对齐 BattleContext.cpp:1543 DARK_EMBRACE。
  // ⚠ 层数恒为 1，升级只降费（2 → 1）；抽牌数读的是层数，所以叠两张就抽 2。
  dark_embrace: (bc) => addToBot(bc, (c) => addPower(c.player.powers, "dark_embrace", 1)),

  // 无痛之心：每当一张牌被消耗，获得 3(升级 4) 点格挡。对齐 BattleContext.cpp:1551 FEEL_NO_PAIN。
  feel_no_pain: (bc, _item, up) =>
    addToBot(bc, (c) => addPower(c.player.powers, "feel_no_pain", up ? 4 : 3)),

  // —— 状态牌生成（结算点见 makeTempCardIn* 三个函数）——

  // 献焰：对全体造成 21(升级 28) 点伤害，往**弃牌堆**塞一张灼伤。
  // 对齐 BattleContext.cpp:1068 IMMOLATE。塞牌不消耗 RNG。
  immolate: (bc, _item, up, card) => {
    attackAllEnemies(bc, (up ? 28 : 21) + getPower(bc.player.powers, "vigor"), card);
    addToBot(bc, (c) => makeTempCardInDiscard(c, "burn", 1));
  },

  // 鲁莽冲锋：造成 7(升级 10) 点伤害，把一张眩晕**洗入抽牌堆**。
  // 对齐 BattleContext.cpp:1127 RECKLESS_CHARGE。★ 洗入消耗一次 cardRandomRng。
  reckless_charge: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 7, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => makeTempCardInDrawPile(c, "dazed", 1)); // ★ 消耗一次 cardRandomRng
  },

  // 狂野劈砍：造成 12(升级 17) 点伤害，把一张伤口**洗入抽牌堆**。
  // 对齐 BattleContext.cpp:1187 WILD_STRIKE。★ 洗入消耗一次 cardRandomRng。
  wild_strike: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 17 : 12, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => makeTempCardInDrawPile(c, "wound", 1)); // ★ 消耗一次 cardRandomRng
  },

  // 强行突破：往**手牌**塞两张伤口，获得 15(升级 20) 点格挡。
  // 对齐 BattleContext.cpp:1407 POWER_THROUGH。
  //
  // ⚠ 顺序反直觉但照抄：**先塞伤口、后加格挡**（两条都 addToBot）。塞牌走 moveToHandHelper，
  // 所以手牌满 10 张时伤口改进弃牌堆。塞牌不消耗 RNG。
  power_through: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 20 : 15);
    addToBot(bc, (c) => makeTempCardInHand(c, "wound", 2));
    addToBot(bc, (c) => gainBlock(c, blk), false);
  },

  // —— 以太（回合末未打出则消失，结算点见 discardAtEndOfTurn）——

  // 杀戮：造成 20(升级 28) 点伤害。以太。对齐 BattleContext.cpp:1003 CARNAGE。
  carnage: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 28 : 20, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 幽灵护甲：获得 10(升级 13) 点格挡。以太。对齐 BattleContext.cpp:1329 GHOSTLY_ARMOR。
  ghostly_armor: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 13 : 10);
    addToBot(bc, (c) => gainBlock(c, blk), false);
  },

  // —— 固有牌（开局归位见 initCombat 的 cards.init 一段）——

  // 戏剧性登场：对全体造成 8(升级 12) 点伤害。固有。消耗。
  // 对齐 BattleContext.cpp:1022 DRAMATIC_ENTRANCE。
  dramatic_entrance: (bc, _item, up, card) =>
    attackAllEnemies(bc, (up ? 12 : 8) + getPower(bc.player.powers, "vigor"), card),

  // 心灵冲击：造成等同于**抽牌堆张数**的伤害。固有。对齐 BattleContext.cpp:1081 MIND_BLAST。
  // ⚠ 张数在**打牌时**取（本牌此刻还在手上，不影响抽牌堆）；升级只降费（2 → 1），
  // 伤害公式两个分支相同。
  //
  // ⚠ 它的背书**只来自 23 张的聚焦牌组变体**（variant 3/4）：85 张全牌组里它是固有牌、
  // 每条 trace 起手必有、抽牌堆约 80 张 → 一击 80 点会把邪教徒/颚虫第一回合打死，
  // 1230 条 trace 从 ~40 步塌成 1 步。所以它**故意不在全牌组变体里**。
  mind_blast: (bc, item, _up, card) => {
    const dmg = calculateCardDamage(bc, item.target, bc.drawPile.length, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 暴虐：每回合开始时失去 1 点生命并抽 1 张牌。升级后**固有**。
  // 对齐 BattleContext.cpp:1527 BRUTALITY。⚠ 层数恒为 1，升级只加固有位。
  // 结算点见 applyStartOfTurnPostDrawPowers。
  brutality: (bc) => addToBot(bc, (c) => addPower(c.player.powers, "brutality", 1)),

  // —— 抽到状态牌时的触发 ——

  // 进化：每当你抽到一张状态牌，抽 1(升级 2) 张牌。对齐 BattleContext.cpp:1547 EVOLVE。
  // 结算点见 drawOneCard。
  evolve: (bc, _item, up) => addToBot(bc, (c) => addPower(c.player.powers, "evolve", up ? 2 : 1)),

  // ==========================================================================
  // 铺量第六批 · 玩家的事件钩子
  //
  // 前五批做的是「回合边界」与「牌的生命周期」两类时点，这批是**事件驱动**——
  // 「当某件事发生时」触发。五个钩子各自挂在一个已有的共享原语上：
  //   火焰屏障 → dealDamageToPlayer（被攻击）      对齐 Player::attacked
  //   烈焰吐息 → drawOneCard（抽到状态/诅咒牌）    对齐 CardManager::draw
  //   怒火     → onUseAttackCard（打出攻击牌）     对齐 BattleContext::onUseAttackCard
  //   主宰     → gainBlock（获得格挡）             对齐 Player::gainBlock
  //   破裂     → playerHpWasLost（因牌失血）       对齐 Player::hpWasLost
  // ⚠ 同一事件上有多个 Power 时，顺序**不是**获得顺序，而是参考在那个钩子函数里的书写
  // 顺序（那些钩子是手写 if 链，不是遍历 statusMap，所以与枚举序也无关）。
  // 回合边界那两个函数才是枚举序——两套规矩，别混。
  // ==========================================================================

  // 火焰屏障：获得 12(升级 16) 点格挡；本回合内每当你被攻击，对攻击者反弹 4(升级 6) 点伤害。
  // 对齐 BattleContext.cpp:1335 FLAME_BARRIER。
  //
  // ⚠ 反伤那一层在**下一个回合开始时**清除（applyStartOfTurnPowers），不是本回合末——
  // 所以整个怪物回合它都在，那正是它生效的时机。
  flame_barrier: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 16 : 12);
    addToBot(bc, (c) => gainBlock(c, blk), false);
    addToBot(bc, (c) => addPower(c.player.powers, "flame_barrier", up ? 6 : 4));
  },

  // 烈焰吐息：每当你抽到一张**状态牌或诅咒牌**，对所有敌人造成 6(升级 10) 点伤害。
  // 对齐 BattleContext.cpp:1571 FIRE_BREATHING。结算点见 drawOneCard。
  //
  // ⚠ 触发条件是「抽到状态/诅咒牌」，**不是**「打出攻击牌」——后者是这张牌很早的旧版本，
  // 真实游戏与参考（CardManager.cpp:398）都已经是前者。
  fire_breathing: (bc, _item, up) =>
    addToBot(bc, (c) => addPower(c.player.powers, "fire_breathing", up ? 10 : 6)),

  // 怒火：本回合内，每打出一张攻击牌就获得 3(升级 5) 点格挡。0 费。
  // 对齐 BattleContext.cpp:1432 RAGE。触发见 onUseAttackCard，清除见 applyEndOfTurnPowers。
  //
  // ⚠ 参考的 `Cards.h getEnergyCost` **没有列举** RAGE，于是落进 `default: return 1`，
  // 实际是 0 费。已在参考侧随本批登记一起修（与第三批的 TRIP 同款处理，见 TODOS）。
  rage: (bc, _item, up) => addToBot(bc, (c) => addPower(c.player.powers, "rage", up ? 5 : 3)),

  // 主宰：每当你获得格挡，对**随机**敌人造成 5(升级 7) 点伤害。
  // 对齐 BattleContext.cpp:1579 JUGGERNAUT。结算点见 gainBlock。
  // ⚠ 每次触发消耗一次 cardRandomRng（选目标），所以它会改动 counter——凡是加格挡的地方
  // 都变成了 RNG 消耗点，这是本批对 RNG 时序影响最大的一条。
  juggernaut: (bc, _item, up) =>
    addToBot(bc, (c) => addPower(c.player.powers, "juggernaut", up ? 7 : 5)),

  // 破裂：每当你因**打出的牌**失去生命，获得 1(升级 2) 点力量。
  // 对齐 BattleContext.cpp:1599 RUPTURE。结算点见 playerHpWasLost 的 selfDamage 分支。
  rupture: (bc, _item, up) => addToBot(bc, (c) => addPower(c.player.powers, "rupture", up ? 2 : 1)),

  // 哨兵：获得 5(升级 8) 点格挡；若本牌被消耗，回复 2(升级 3) 点能量。
  // 对齐 BattleContext.cpp:1452 SENTINEL。消耗触发见 triggerAndMoveToExhaustPile。
  // ⚠ 卡效果只有格挡那一半；回能量是消耗触发，且**同步**执行（照参考）。
  sentinel: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 8 : 5);
    addToBot(bc, (c) => gainBlock(c, blk), false);
  },

  // 应急按钮：获得 30(升级 40) 点格挡，接下来 2 个回合无法从**牌**获得格挡。消耗。
  // 对齐 BattleContext.cpp:1418 PANIC_BUTTON。
  //
  // ⚠ 两处：① 格挡在**打牌时**就过 calculateCardBlock 算好，所以本牌自己的格挡不会被
  // 自己上的 NO_BLOCK 吃掉；② NO_BLOCK 走 DebuffPlayer，会被神器抵消一层（于是「神器在手
  // 时打应急按钮，格挡白拿不受罚」）。递减见 applyEndOfRoundPowers。
  panic_button: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 40 : 30);
    addToBot(bc, (c) => gainBlock(c, blk), false);
    addToBot(bc, (c) => debuffPlayer(c, "no_card_block", 2));
  },

  // ==========================================================================
  // 铺量第七批 · 卡牌实例级状态
  //
  // 这六张的共同点是「效果记在**这一张牌实例**上」，而不是玩家身上：暴走的成长量、
  // 灼热之刃的升级次数记在 specialData，血债血偿 / 疯狂 / 腐化改的是 cost / costForTurn。
  // 原语见文件上方「卡牌实例级状态的原语」一节。
  // ==========================================================================

  // 暴走：造成 8 + 本实例累计成长 点伤害；每次打出后本实例永久 +5(升级 +8)。
  // 对齐 BattleContext.cpp:1125 RAMPAGE。
  //
  // ⚠ 三处：① 伤害在**打牌时**用当前 specialData 算好（所以本次打出不吃这次成长）；
  // ② 成长是**同步**自增、排在 addToBot 之后；③ 改的是打出的那份实例，而
  // onAfterUseCard 搬进弃牌堆的正是同一份，所以成长跟着牌走（参考那边是 CardQueueItem 的
  // 副本，同理）。
  // TODO(后续PR): 参考在 `item.purgeOnUse` 时还会 `findAndUpgradeSpecialData` 去回填牌堆里
  //   的本体（双击/复制那套复制打出）。purgeOnUse 尚未登记，恒为假。
  rampage: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, 8 + card.specialData, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    card.specialData += up ? 8 : 5;
  },

  // 灼热之刃：伤害 = n(n+7)/2 + 12，n 是本实例被升级过几次。
  // 对齐 BattleContext.cpp:1152 SEARING_BLOW。
  //
  // ⚠ 它是全表唯一能**反复**升级的牌（canUpgradeCard 里那条例外），升级次数记在
  // specialData 上而不是 `upgraded` 位。n=0 → 12，n=1 → 16，n=2 → 21，n=3 → 27。
  // `n*(n+7)` 恒为偶数（n 与 n+7 奇偶不同），所以 C++ 的整除没有截断，两边天然一致。
  searing_blow: (bc, item, _up, card) => {
    const n = getUpgradeCount(card);
    const base = (n * (n + 7)) / 2 + 12;
    const dmg = calculateCardDamage(bc, item.target, base, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 血债血偿：造成 18(升级 22) 点伤害。4(升级 3) 费，本场每失血一次费用 -1。
  // 对齐 BattleContext.cpp:1011 BLOOD_FOR_BLOOD。
  //
  // ⚠ 卡效果本身只有伤害那一句——降费不在这里，而在 `Player::hpWasLost` 里的
  // `cards.onTookDamage()`（见 cardsOnTookDamage）。所以**被怪打一下也降费**，
  // 不限于自伤，这一点与破裂的 selfDamage 判据不同。
  blood_for_blood: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 22 : 18, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 疯狂：把手牌中随机一张的费用变成 0。消耗。对齐 BattleContext.cpp:1396 MADNESS
  // → Actions::MadnessAction。升级只降费（1 → 0）。
  // ⚠ 那个拒绝采样循环的 RNG 消耗次数不定，见 madnessAction。
  madness: (bc) => {
    addToBot(bc, (c) => madnessAction(c));
  },

  // 腐化：技能牌费用变 0，但打出后被消耗。对齐 BattleContext.cpp:1547 CORRUPTION。
  //
  // ⚠ 它是**三处**联动，不是一条规则：① 落地时一次性把四个牌堆里 cost>0 的技能牌压成 0
  // （onBuffCorruption，改的是 cost 本身，永久）；② 之后每张进手/被抽到的技能牌走
  // setCostForTurn(-9)（只改本回合）；③ useCard 里技能牌 exhaustOnUse=true 且不扣能量。
  // ⚠ 它是纯 bool 状态（参考走 setHasStatus，statusMap 里没有条目），故层数恒记 1。
  corruption: (bc) => {
    addToBot(bc, (c) => buffCorruption(c));
  },

  // 幻影：获得 1 层虚无缥缈。虚无（升级后**不再**虚无）。消耗。
  // 对齐 BattleContext.cpp:1246 APPARITION。
  //
  // ⚠ 升级唯一改变的就是「不再虚无」，走数据表的 upgradedEthereal（第七批新增的字段），
  // 判定在 isEtherealCard 里。层数两个分支都是 1。
  // ⚠ 虚无缥缈**当回合末就掉一层**：参考用的是裸 `decrementStatus<INTANGIBLE>()`，
  // 不是 `decrementIfNotJustApplied`——所以幻影护住的是紧随其后的那个怪物回合，
  // 到玩家下个回合开始时它已经没了。见 applyEndOfRoundPowers 的注释。
  apparition: (bc) => {
    addToBot(bc, (c) => addPower(c.player.powers, "intangible", 1));
  },

  // ==========================================================================
  // 铺量第八批 · 随机卡池取牌
  //
  // 五张的共同点是「牌的**定义**是当场从战斗内卡池随机抽出来的」，所以都消耗
  // `cardRandomRng`；池子与取样函数见文件上方「战斗内卡池」一节。
  //
  // ⚠ 「本场战斗 0 费」与「本回合 0 费」是两件事，落在两个不同的实例字段上：
  //   * 蜕变 / 变形 —— 直接写 `cost` 与 `costForTurn`（回合末复位读的是 `cost`，拉不回来）
  //   * 地狱之刃 / 发现 —— 只走 `setCostForTurn`，回合末 `resetAttributesAtEndOfTurn` 会复位
  //   * 多面手 —— **不改费用**，给的牌是原价
  // ==========================================================================

  // 蜕变：把 3(升级 5) 张随机技能牌洗入抽牌堆，本场战斗费用为 0。
  // 对齐 BattleContext.cpp:1277 CHRYSALIS → Actions::PutRandomCardsInDrawPile(SKILL, …)。
  chrysalis: (bc, _item, up) => {
    addToBot(bc, (c) => putRandomCardsInDrawPile(c, "skill", up ? 5 : 3));
  },

  // 变形：把 3(升级 5) 张随机攻击牌洗入抽牌堆，本场战斗费用为 0。
  // 对齐 BattleContext.cpp:1404 METAMORPHOSIS → Actions::PutRandomCardsInDrawPile(ATTACK, …)。
  metamorphosis: (bc, _item, up) => {
    addToBot(bc, (c) => putRandomCardsInDrawPile(c, "attack", up ? 5 : 3));
  },

  // 发现：从 3 张随机牌里选 1 张进手牌，本回合费用 0。升级后不再消耗。
  // 对齐 BattleContext.cpp:1301 DISCOVERY → Actions::DiscoveryAction(INVALID, 1)。
  //
  // ⚠ 候选来自**铁甲的 70 张 CombatCardPool**（不分牌型），不是无色池——`CardType::INVALID`
  // 在 `generateDiscoveryCards` 里正是「不分牌型、走本职业池」那一支。走无色池的是多面手
  // （以及药水那条 `CardType::STATUS` 的哑参数用法）。
  // ⚠ 升级只改「份数吗」——不，只改**消耗与否**（`doesCardExhaust` 里发现是 `!upgraded`），
  // 份数恒为 1；两个分支的效果代码完全一样。
  discovery: (bc) => {
    addToBot(bc, (c) => discoveryAction(c, "any", 1));
  },

  // 多面手：把 1(升级 2) 张随机无色牌加入手牌。
  // 对齐 BattleContext.cpp:1383 JACK_OF_ALL_TRADES → Actions::JackOfAllTradesAction(up)。
  // ⚠ 参考在这一行自注 "the game decides the random cards here and adds maketempcardtobot"
  //   ——真实游戏在**打牌时**就定下了是哪几张牌并入队 MakeTempCard；参考把取牌推迟到动作
  //   执行时。两者之间没有别的 cardRandomRng 消耗点，故 counter 一致，照参考写。
  jack_of_all_trades: (bc, _item, up) => {
    addToBot(bc, (c) => jackOfAllTradesAction(c, up));
  },

  // 地狱之刃：把 1 张随机攻击牌加入手牌，本回合费用 0。消耗。
  // 对齐 BattleContext.cpp:1375 INFERNAL_BLADE → Actions::InfernalBladeAction()。
  // ⚠ 升级只降费（1 → 0），效果两分支完全一样。
  infernal_blade: (bc) => {
    addToBot(bc, (c) => infernalBladeAction(c));
  },

  // ==========================================================================
  // 铺量第九批 · 从牌堆打出 / 复制打出
  //
  // 四张的共同点是「把某张牌**再当作一次出牌**处理」，于是出牌队列会嵌套：
  // useCard → 往 cardQueue 里塞新项 → executeActions 抽干动作队列后又跑一次 useCard。
  // 机制在 playTopCardInDrawPile / queuePurgeCard / dualWieldAction 三处，见各自注释。
  // ==========================================================================

  // 浩劫：打出抽牌堆顶的那张牌，然后消耗它。
  // 对齐 BattleContext.cpp:1353 HAVOC → `Actions::PlayTopCard(getRandomMonsterIdx(cardRandomRng,
  // true), true)`。
  //
  // ⚠ 两处照抄：
  //  ① 目标在**打牌时**就掷定（★ 一次 cardRandomRng），不是等 PlayTopCard 执行时才掷。
  //     两者之间可能夹着别的 cardRandomRng 消耗点（主宰的加格挡就是一个），推迟就会错位。
  //  ② 第二参数 `exhausts = true`——被打出的那张牌走消耗（连带触发黑暗拥抱 / 无痛之心 /
  //     哨兵那条链）。混乱那边是 false，两张牌只差这一个 bool。
  havoc: (bc) => {
    const target = getRandomMonsterIdx(bc); // ★ 消耗一次 cardRandomRng
    addToBot(bc, (c) => playTopCardInDrawPile(c, target, true));
  },

  // 混乱：每回合开始时，打出抽牌堆顶的那张牌。
  // 对齐 BattleContext.cpp:1587 MAYHEM → `Actions::BuffPlayer<PS::MAYHEM>(1)`。
  // ⚠ 层数恒为 1、**与升级无关**（升级只把费用从 2 降到 1）。叠两张就是每回合打两张。
  // 结算点见 applyStartOfTurnPowers。
  mayhem: (bc) => {
    addToBot(bc, (c) => addPower(c.player.powers, "mayhem", 1));
  },

  // 二连击：接下来打出的 1(升级 2) 张攻击牌，各额外结算一次。
  // 对齐 BattleContext.cpp:1306 DOUBLE_TAP → `Actions::BuffPlayer<PS::DOUBLE_TAP>(up ? 2 : 1)`。
  // 触发见 onUseAttackCard，回合末清除见 applyEndOfTurnPowers。
  double_tap: (bc, _item, up) => {
    addToBot(bc, (c) => addPower(c.player.powers, "double_tap", up ? 2 : 1));
  },

  // 双持：复制手牌中的一张攻击牌或能力牌，把 1(升级 2) 张副本加入手牌。
  // 对齐 BattleContext.cpp:1310 DUAL_WIELD → `Actions::DualWieldAction(up ? 2 : 1)`。
  dual_wield: (bc, _item, up) => {
    addToBot(bc, (c) => dualWieldAction(c, up ? 2 : 1));
  },

  // ==========================================================================
  // 铺量第十批 · X 费
  //
  // X 费牌在参考里的表达是**两个字段配合**，缺一不可：
  //   * `getEnergyCost` 对它们返回 **-1**（第七批已原样照抄进 `CombatCard.cost` /
  //     `costForTurn`）。这个负值同时兼了三件事：`canUse` 的 `energy < costForTurn` 恒不成立
  //     （所以 0 能量也打得出）、`useCard` 尾部的 `costForTurn > 0` 恒不成立（所以扣能量
  //     **不走那条通路**）、`setCostForTurn` 的 `costForTurn >= 0` 门恒不成立（所以腐化 /
  //     疯狂 / 地狱之刃那些降费一律动不了它）。
  //   * 真正的 X 记在出牌队列项的 `energyOnUse` 上（见 CardQueueItem 的注释），
  //     能量由**卡自己的动作**一次花光（`player.useEnergy(player.energy)`）。
  //
  // 于是 X 在三条入队路径上各不相同：玩家点牌 = 点牌那一刻的全部能量；浩劫 / 混乱 =
  // 弹出顶牌那一刻的全部能量（且 `freeToPlay` 让能量**不被花掉**）；二连击的复制项 =
  // 继承第一击的 X（且 `ignoreEnergyTotal` 挡住下面那句夹取）。
  //
  // 神化不是 X 费牌，放在这一批是因为它同属「本批解锁的三张」。
  // ==========================================================================

  // 旋风斩：X 费。对所有敌人造成 5(升级 8) 点伤害，X 次。
  // 对齐 BattleContext.cpp:1194 WHIRLWIND。
  //
  // ⚠ 四处照抄：
  //  ① 那句 `if (!item.ignoreEnergyTotal && player.energy < item.energyOnUse)
  //     item.energyOnUse = player.energy;` —— 把 X 往下夹到「现在真的还有这么多能量」。
  //     它**改的是队列项本身**，所以夹过之后二连击的复制项继承到的也是夹后的值。
  //     ⚠ 嬗变那边还多一句「往上抬」，旋风斩**没有**——两张牌不对称，照抄，见嬗变的注释。
  //  ② 基础伤害先加精力（VIGOR），之后 `calculateCardDamage` 里还会再加一次
  //     ——与顺劈斩同款，是参考的算法（精力实际算两次），不是笔误。当前没有精力来源。
  //  ③ `useEnergy = !(item.freeToPlay || c.freeToPlayOnce)`：浩劫 / 混乱打出的旋风斩
  //     按满能量打、却一点能量都不花。
  //  ④ 伤害走 `WhirlwindAction` 那条**自己的**路径（矩阵算一次、addToTop 递归 X 轮），
  //     不是 `attackAllEnemies` 排 X 条动作，见 whirlwindAction。
  whirlwind: (bc, item, up, card) => {
    if (!item.ignoreEnergyTotal && bc.player.energy < item.energyOnUse) {
      item.energyOnUse = bc.player.energy;
    }
    const baseDamage = (up ? 8 : 5) + getPower(bc.player.powers, "vigor");
    const energy = item.energyOnUse;
    // TODO(后续PR): `c.freeToPlayOnce`（深谋远虑 / 液态记忆），还没有产出者。
    const useEnergy = !item.freeToPlay;
    addToBot(bc, (c) => whirlwindAction(c, baseDamage, energy, useEnergy, card));
  },

  // 嬗变：X 费。将 X 张随机无色牌加入手牌，**本回合**费用为 0（升级：它们是升级过的）。
  // 对齐 BattleContext.cpp:1479 TRANSMUTATION。
  //
  // ⚠ 两处与旋风斩不同，都照抄：
  //  ① 参考在夹取之前**多了一句往上抬**：`if (player.energy > item.energyOnUse)
  //     item.energyOnUse = player.energy;`。旋风斩没有这一句。两张牌本该同形，
  //     这处不对称在参考里没有注释；当前内容下两句都观察不到（energyOnUse 就是入队那一刻
  //     的能量，之后到结算之间没有任何东西改能量），记为盲区，见报告。
  //  ② 升级的效果是**造出来的牌带升级态**，不是多造一张（`CardInstance c(cid, upgraded)`）。
  //     我给出的任务描述里猜的是「+1 张」——源码不是那样。
  transmutation: (bc, item, up) => {
    if (bc.player.energy > item.energyOnUse) {
      item.energyOnUse = bc.player.energy;
    }
    if (!item.ignoreEnergyTotal && bc.player.energy < item.energyOnUse) {
      item.energyOnUse = bc.player.energy;
    }
    const energy = item.energyOnUse;
    // TODO(后续PR): `c.freeToPlayOnce`，同旋风斩。
    const useEnergy = !item.freeToPlay;
    addToBot(bc, (c) => transmutationAction(c, up, energy, useEnergy));
  },

  // 神化：本场战斗剩余时间内，升级你所有的牌。消耗。
  // 对齐 BattleContext.cpp:1242 APOTHEOSIS → `Actions::ApotheosisAction()`。
  // ⚠ 升级只降费（2 → 1），效果两分支完全一样；扫哪几个牌堆见 apotheosisAction。
  apotheosis: (bc) => {
    addToBot(bc, (c) => apotheosisAction(c));
  },

  // ==========================================================================
  // 铺量第十一批 · 四个互不相关的小机制
  //
  // 这一批不是「一个机制解锁一批卡」，而是四张各卡在一个独立小机制上的收尾牌：
  //   完美打击 → `strikeCount` 增量计数器（见 isStrikeCard 那一节）
  //   冲撞     → `cardCanUse` 的攻击牌分支（打出合法性门槛）
  //   炸弹     → `bomb1/2/3` 三格计时器（见 applyEndOfTurnPowers 的开头）
  //   贪婪之手 → 战斗内金币（`CombatPlayer.gold`，随 settleCombat 回写 run 层）
  // ==========================================================================

  // 完美打击：造成 6 点伤害；牌名含「打击」的牌每有一张，额外 2(升级 3) 点。
  // 对齐 BattleContext.cpp:1103 PERFECTED_STRIKE。
  //
  // ⚠ 三处照抄：
  //  ① 数的是 `cards.strikeCount`——「这场战斗里」的打击牌，不是「手牌里」，也不是
  //     「大牌组里」。手牌 / 抽牌堆 / 弃牌堆全算，消耗掉的不算，掘尸取回来的又算回来。
  //  ② **算上自己**：这张完美打击此刻已被 useCard 移出手牌，但「移出手牌」不等于「离场」，
  //     计数器没减过它。参考在这一行注了 `// hack because we calculate strikeCount while
  //     non purge cards are still in hand.`
  //  ③ 加成量是 `strikeCount * (up ? 3 : 2)` 加在**基础伤害**上，然后整体过一次
  //     `calculateCardDamage`——所以力量/易伤是作用在含加成的总额上的。
  perfected_strike: (bc, item, up, card) => {
    const strikeDmg = bc.strikeCount * (up ? 3 : 2);
    const dmg = calculateCardDamage(bc, item.target, 6 + strikeDmg, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 冲撞：仅当手牌中全是攻击牌时才能打出；造成 14(升级 18) 点伤害。
  // 对齐 BattleContext.cpp:1023 CLASH（效果本身平平无奇，门槛在 cardCanUse / canUseClash）。
  clash: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 18 : 14, card);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 炸弹：3 个回合后，对所有敌人造成 40(升级 50) 点伤害。
  // 对齐 BattleContext.cpp:1470 THE_BOMB → `Actions::BuffPlayer<PS::THE_BOMB>(up ? 50 : 40)`。
  //
  // ⚠ 它虽然写成 BuffPlayer，却**不是**一个普通 Power：`Player::buff<PS::THE_BOMB>`
  //（Player.h:330）在进 statusMap 之前就 `bomb3 += amount; return;` 了，所以
  //  ① 层数记在三个专用字段上、不在 statusMap 里；
  //  ② `setHasStatus` 一次都没调过，于是 `hasStatusRuntime(THE_BOMB)` **恒为假**——
  //     参考自己的状态 dump 因此看不见炸弹（harness 的快照同理，见报告的盲区一节）。
  //  两张炸弹叠加就是 `bomb3` 累加（40 + 40 = 80），不是两个独立的计时器。
  // 结算与推进见 applyEndOfTurnPowers 的开头。
  the_bomb: (bc, _item, up) => {
    const amount = up ? 50 : 40;
    addToBot(bc, (c) => {
      c.player.bomb3 += amount;
    });
  },

  // 贪婪之手：造成 20(升级 25) 点伤害；若这一击**击杀**目标，获得 20(升级 25) 金币。
  // 对齐 BattleContext.cpp:1061 HAND_OF_GREED → `Actions::HandOfGreedAction`（Actions.cpp:1103）。
  //
  // ⚠ 四处照抄（形状与进食那条同族，本就是同一份 copy-paste，只有伤害那行曾经不同）：
  //  ① 伤害走 `Monster::attacked`（我们的 `monsterAttacked`），所以蜷缩那条 onAttacked 链
  //     **会**触发。⚠ 参考原文写的是 `Monster::damage`，那是笔误——已随本批在参考侧修掉
  //     （见 TODOS「已修正」）。真实游戏里贪婪之手是攻击牌、走 `DamageAction`，蜷缩该触发；
  //     同文件的 `FeedAction` 与 `ReaperAction` 这两个同形动作都用的 `attacked`。
  //  ② 顶部先判 `isDeadOrEscaped` 直接返回，尾部**自己**调一次 checkCombat，
  //     「给金币」夹在扣血与 checkCombat 之间。
  //  ③ 伤害在**打牌时**算好（`calculateCardDamage` 在 addToBot 之外），动作里只结算。
  //  ④ 参考的豁免条件是 `!MINION && !isAlive() && !isHalfDead() &&
  //     !(REGROW && monstersAlive > 0)`。当前登记的四种怪（邪教徒 / 颚虫 / 红虱 / 绿虱）
  //     一个都没有 MINION / REGROW，`halfDead` 整个机制也还没建模（只有僧侣/书虫那类才有），
  //     所以这里只留 `!alive` 那一项——与进食（feed）当年的处理一致。
  //     ⚠ 登记那些怪时必须把三项补回来。
  hand_of_greed: (bc, item, up, card) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 25 : 20, card);
    const gold = up ? 25 : 20;
    addToBot(bc, (c) => {
      const m = c.monsters[item.target];
      if (m === undefined || !m.alive) {
        return;
      }
      monsterAttacked(c, m, dmg);
      if (!m.alive) {
        gainGold(c, gold);
      }
      checkCombat(c);
    });
  },

  // 黑暗镣铐：本回合内，使目标失去 9(升级 15) 点力量（其行动过后归还）。消耗。
  // 对齐 BattleContext.cpp:1281 DARK_SHACKLES。
  //
  // ⚠ **参考侧原文有两处 bug，已随本批一起修掉**（见 TODOS「已修正」），这里写的是修正后的形态：
  //  ① 符号：`Monster::addDebuff<MS::STRENGTH>`（Monster.h:354）是 `strength += amount`、
  //     **不取反**，所以要减力量就必须传负数（同项目的缴械与 Monster.cpp:394/:454 都传负数）。
  //     参考原文传的是正数，把「失去 9 点力量」写成了「获得 9 点力量」。
  //  ② 神器条件：参考原文写的是「目标**有**神器时才上 SHACKLED」，真实游戏是神器直接吃掉
  //     减力量、所以只有**没有**神器时才需要那条回合末归还的记账（否则神器吃掉削弱、
  //     SHACKLED 反而白送力量）。
  // ⚠ 三处照抄的形状：
  //  ① 减力量走 `DebuffEnemy` 故**过神器**（与缴械同族），归还走 `buff` 故**不过**。
  //  ② 神器判定是在**打牌那一刻**同步读的，排在那条 addToBot 的减力量**执行之前**——
  //     也就是说它读到的是还没被这次削弱消耗掉的神器层数。这是参考自己的形状，照抄。
  //  ③ `Actions::DebuffEnemy` 的第三参数 `isSourceMonster` **缺省是 true**（Actions.h:41），
  //     这里参考没显式传，所以是 true（与缴械显式传 false 不同）。对力量无可观察差别
  //     ——`justApplied` 只对虚弱/易伤设置——但照抄参数以免将来铺到别的 Power 时错位。
  // 回合末归还见 `applyMonsterEndOfTurnTriggers`。
  dark_shackles: (bc, item, up) => {
    const amount = up ? 15 : 9;
    addToBot(bc, (c) => debuffEnemy(c, item.target, "strength", -amount, true));
    if (getPower(bc.monsters[item.target]?.powers ?? [], "artifact") === 0) {
      addToBot(bc, (c) => buffEnemy(c, item.target, "shackled", amount));
    }
  },

  // 暴力：将 3(升级 4) 张随机攻击牌从抽牌堆置入手牌。消耗。
  // 对齐 BattleContext.cpp:1507 VIOLENCE → `Actions::ViolenceAction`（Actions.cpp:614）。
  violence: (bc, _item, up) => {
    addToBot(bc, (c) => violenceAction(c, up ? 4 : 3));
  },

  // 黏液（第十三批）：**打出后什么都不做**，只是消耗掉并花掉 1 点能量。
  //
  // 参考侧它走的是 `useCard` 的 STATUS 分支 → `onUseStatusOrCurseCard()`
  //（BattleContext.cpp:915/1915），那个函数里**没有任何按牌 id 分派的 switch**，
  // 全是残影 / 复制 / 回响成型 / 诅咒之咒 / 风采这些玩家 Power 的钩子（一条都还没登记）。
  // 所以这条规则是空的，不是「漏写了」。
  //
  // ⚠ 它是唯一一张**能打出**的状态牌（见 `cardCanUse` 与 cards.ts 里 `slimed` 的注释），
  // 也是第一张进 `CARD_RULES` 的非「铁甲+无色」牌：harness 的 `isReplayableCard` 默认放行它，
  // 不登记的话史莱姆一族的 trace 会在策略打出黏液的那一步抛「暂未登记卡牌行为」、整条不可重放。
  slimed: () => {
    // 无效果。
  },
};

/**
 * 已登记游戏级行为的卡牌 id（`CARD_RULES` 的键）。**只给测试用**，运行期不读它。
 *
 * 存在的理由：登记表是本仓库里唯一一处「知道某张牌属于哪个角色」的第二数据源——
 * 本次迁移的范围就是**铁甲（红）+ 无色**，所以任何进了这张表的牌，数据表里的 `color`
 * 必须是 `red` 或 `colorless`。`data-tables.test.ts` 拿它交叉验证 `color`
 * （哨兵曾被记成 `blue` 而无任何测试守着，就是靠这条挡住的）。
 */
export const REGISTERED_CARD_IDS: readonly string[] = Object.freeze(Object.keys(CARD_RULES));

/**
 * 对全体造成伤害（对齐 Actions::AttackAllEnemy）：先**逐怪算好**伤害矩阵，
 * 再逐怪结算。两段分开很重要——先打死的怪不会影响后面怪的伤害取值。
 */
function attackAllEnemies(bc: BattleContext, baseDamage: number, card: CombatCard): void {
  addToBot(bc, (c) => {
    const matrix = c.monsters.map((m, i) =>
      m.alive ? calculateCardDamage(c, i, baseDamage, card) : 0,
    );
    for (let i = 0; i < c.monsters.length; i += 1) {
      if (c.monsters[i]?.alive === true) {
        attackEnemy(c, i, matrix[i]);
      }
    }
  });
}

/**
 * 用**已经算好的伤害矩阵**对全体结算一次（对齐 `Actions::AttackAllEnemy(DamageMatrix)`，
 * Actions.cpp:49）。与上面那个按 baseDamage 现算的重载是两条不同的代码：矩阵在外面算一次，
 * 之后每一轮都用**同一份**数值，所以中途力量涨了 / 敌人上了易伤都不影响后续几轮。
 *
 * ⚠ 是**同步**的（参考里它被 `.actFunc(bc)` 直接调用，不入队）。
 */
function attackAllEnemiesWithMatrix(bc: BattleContext, matrix: readonly number[]): void {
  for (let i = 0; i < bc.monsters.length; i += 1) {
    const m = bc.monsters[i];
    if (m?.alive === true) {
      monsterAttacked(bc, m, matrix[i] ?? 0);
    }
  }
  checkCombat(bc);
}

/**
 * 「对全体打 N 次」（对齐 `Actions::AttackAllMonsterRecursive`，Actions.cpp:1262）。
 *
 * ⚠ 形状是「同步打一轮 + 把剩下的轮次 `addToTop` 回去」，**不是**一次性循环 N 遍：
 *  ① `timesRemaining <= 0` 提前返回；
 *  ② `AttackAllEnemy(matrix)` 是**同步**调用（`.actFunc(bc)`）；
 *  ③ 只有 `timesRemaining > 1` 才 `addToTop` 下一轮。
 * ⚠ ②③ 的先后决定了与「受击反应」的交织：本轮的攻击若给蜷缩/荆棘那类排了 addToTop 动作，
 *    下一轮是在**它们之后**才被推到队首的，于是**下一轮反而先跑**。参考在那行自注
 *    `// todo should this be to the top? test with`——照抄，包括这个疑问。
 */
function attackAllMonsterRecursive(
  bc: BattleContext,
  matrix: readonly number[],
  timesRemaining: number,
): void {
  if (timesRemaining <= 0) {
    return;
  }
  attackAllEnemiesWithMatrix(bc, matrix);
  if (timesRemaining > 1) {
    addToTop(bc, (c) => attackAllMonsterRecursive(c, matrix, timesRemaining - 1));
  }
}

/**
 * 旋风斩的动作（对齐 `Actions::WhirlwindAction`，Actions.cpp:1233）。
 *
 * ⚠ 四处照抄：
 *  ① **先花能量**（`useEnergy(player.energy)`，即清零），再算伤害矩阵。
 *     顺序在当前内容下观察不到（没有读能量的伤害修正），照参考写。
 *  ② 伤害矩阵**只算一次**，之后 X 轮共用；死掉的怪那格留 0。
 *  ③ 参考把每格夹进 `uint16`（`min(65535, dmg)`）——照抄这个上限，虽然当前伤害够不到。
 *  ④ `effectAmount = energy + (化学 X ? 2 : 0)`，`> 0` 才打；X 为 0 时旋风斩什么都不做
 *     （但仍然算作打出了一张牌，照常进弃牌堆）。
 */
function whirlwindAction(
  bc: BattleContext,
  baseDamage: number,
  energy: number,
  useEnergy: boolean,
  card: CombatCard,
): void {
  if (useEnergy) {
    bc.player.energy = 0; // 对齐 `player.useEnergy(player.energy)`
  }
  const matrix = bc.monsters.map((m, i) =>
    m.alive ? Math.min(65535, calculateCardDamage(bc, i, baseDamage, card)) : 0,
  );
  // 化学 X（CHEMICAL_X，第四十四批）：对齐 `Actions::WhirlwindAction` 的倒数第二句
  // （Actions.cpp:1267）：`const auto effectAmount = energy + (hasRelic<R::CHEMICAL_X>() ? 2 : 0);`
  // ⚠ 四处照抄：
  //  ①⚠⚠ **它加在「打几次」上、不加在伤害上**，而且加在 `useEnergy` 把能量清零**之后**
  //     ——所以 0 能量时旋风斩照样打 2 下。这是它在本项目里唯一有预言机的可观察面。
  //  ② 伤害矩阵在这一句**之前**就算好了（每只怪一份），追加的 2 次用的是同一份矩阵。
  //  ③ `if (effectAmount > 0)` 那道门排在这一句之后，照抄。
  //  ④ 它的第二个读点在 `Actions::TransmutationAction`（:593），见那里。
  const effectAmount = energy + (hasRelic(bc, "chemical_x") ? 2 : 0);
  if (effectAmount > 0) {
    attackAllMonsterRecursive(bc, matrix, effectAmount);
  }
}

/**
 * 对全体造成**非攻击**伤害（对齐 Actions::DamageAllEnemy）。
 *
 * ⚠ 与 attackAllEnemies 有三处不同：① 走 Monster::damage 而非 attacked，故不触发蜷缩等
 * onAttacked 链；② 伤害值是调用方给的固定值，**不**逐怪过 calculateCardDamage（力量/易伤
 * 都不参与）；③ checkCombat 在整个循环**之后**才调一次。
 */
function damageAllEnemiesNonAttack(bc: BattleContext, damage: number): void {
  for (let i = 0; i < bc.monsters.length; i += 1) {
    if (bc.monsters[i]?.alive === true) {
      monsterDamage(bc, i, damage);
    }
  }
  checkCombat(bc);
}

/** 对齐 BattleContext::useCard：分派效果入队 → OnAfterCardUsed → 移出手牌 + 扣能量。 */
function useCard(bc: BattleContext, item: CardQueueItem): void {
  const card = item.card;
  if (card === null) {
    throw new Error("useCard: 队列项没有牌");
  }
  const def = getCardDef(card.defId);
  // ⚠⚠ **扣能量读的是「进这个函数那一刻」的 `costForTurn`，不是函数末尾的当前值。**
  //   参考的 `CardQueueItem::card` 是**按值存的一份副本**，而 `cards.hand[...]` 是另一个对象；
  //   函数末尾那句 `player.useEnergy(c.costForTurn)` 读的是**副本**。我们这边 `item.card`
  //   故意指着手牌里那个对象（好让卡效果对它的改写跟着进弃牌堆，见 CardQueue 的注释），
  //   于是「有人在出牌中途改了手牌里这张牌的 costForTurn」这件事在两边不同解。
  // ⚠ 目前**唯一**的这种人是**木乃伊之手**（第四十四批）：它在 `onUsePowerCard` 里把一张
  //   随机手牌压成 0 费，而候选表里**包含正在被打出的这张能力牌**（参考此刻还没把它移出手牌，
  //   移出那一句排在下面）。抽中自己时，参考照样把手牌那份压成 0——但那份马上被移出手牌、
  //   而扣能量读的是副本，所以**一点能量都不少扣**。不快照的话我们会让这张牌变免费。
  //   实测（`@relic16`，牌组里唯一的 1 费能力牌是灵液）红 **73 例**。
  const costForTurnAtUse = card.costForTurn;
  const rule = CARD_RULES[card.defId];
  if (rule === undefined) {
    throw new Error(`sts-combat 暂未登记卡牌行为: ${card.defId}`);
  }

  // 消耗与否是**升级相关**属性：极限爆发/发现/未雨绸缪/秘密武器/秘密技巧升级后不再消耗
  // （对齐 Cards.h:534 doesCardExhaust 那组 `!upgraded`）。此前恒取 def.exhausts，
  // 升级态会把牌错误地送进消耗堆。
  item.exhaustOnUse ||= exhaustsOf(def, card.upgraded);
  bc.player.cardsPlayedThisTurn += 1;

  rule(bc, item, card.upgraded, card);

  // 打出后的 Power / 遗物触发。位置照抄参考 useCard 的 switch：每种牌型都是
  // 「先 useXxxCard() 跑卡效果、紧接着 onUseXxxCard() 跑触发」，于是这里入队的动作
  // 排在卡效果之后、OnAfterCardUsed **之前**。
  // TODO(后续PR): onUseSkillCard（爆发 / 复制 / 回响形态）、onUsePowerCard（缠绕的眩晕 /
  //   风采）、以及三种牌型共有的残影 / 精力清除 / 笔尖；还有紧跟 OnAfterCardUsed
  //   之后的 triggerOnOtherCardPlayed（千刃 / 剧痛）。都还没有对应内容登记。
  if (def.type === "attack") {
    onUseAttackCard(bc, item, card);
  } else if (def.type === "power") {
    // 第二十三批新增（此前能力牌这条 case 是空的）：诅咒挂在这三个函数上，
    // **攻击牌那个里没有**——分派本身就是「非攻击牌才触发」的实现。
    onUsePowerCard(bc, item, card);
  } else if (def.type === "status" || def.type === "curse") {
    onUseStatusOrCurseCard(bc, item, card);
  } else if (def.type === "skill") {
    onUseSkillCard(bc, item, card);
    if (getPower(bc.player.powers, "corruption") > 0) {
      // 腐化：技能牌打出后被消耗。位置照抄——在 useSkillCard() / onUseSkillCard() **之后**，
      // 所以卡效果自己读到的 exhaustOnUse 还是原值（当前没有卡效果读它，记着以防将来有）。
      item.exhaustOnUse = true;
    }
  }

  // clearOnCombatVictory=false（对齐 Actions::OnAfterCardUsed 的第二参数）：
  // 打出致命一击后战斗虽已胜利，这张牌仍要落进弃牌堆。标 true 会让它凭空消失。
  //
  // desc 是必须的：开选牌屏的牌（军备 / 焚誓 / 头槌 …）开屏时这条动作**还在队里**，
  // 存档必须能把它带过去，否则读回来那张牌凭空消失。
  // exhaustOnUse 在此刻取值而非执行时取——它在 rule() 之前就定了，之后无人改动；
  // 且 playCard 只在 player_normal 才受理，选牌屏期间不可能有第二张牌进来覆盖它
  //（参考读的是成员 curCardQueueItem，同理不会变）。
  const exhaustOnUse = item.exhaustOnUse;
  const purgeOnUse = item.purgeOnUse;
  const triggerOnUse = item.triggerOnUse;
  addToBot(bc, (c) => onAfterUseCard(c, card, exhaustOnUse, purgeOnUse, triggerOnUse), false, {
    kind: "after_use_card",
    card,
    exhaustOnUse,
    purgeOnUse,
    triggerOnUse,
  });

  // 移出手牌 + 扣能量（对齐 useCard 尾部）。
  // ⚠ 整段包在 `if (!item.purgeOnUse)` 里：二连击的复制项既不从手牌里再拿一次
  // （原牌早已离场），也不再扣一次能量。
  if (item.purgeOnUse) {
    return;
  }
  removeFromHandByUid(bc, card.uid);
  // ⚠ 四项逐字照抄 `c.costForTurn > 0 && !c.isFreeToPlay(bc) && !item.autoplay &&
  // !(hasStatus<CORRUPTION>() && getType() == SKILL)`：
  //   * 费用读**实例级** costForTurn（不是打牌那一刻记下的 energyOnUse——两者对普通打牌
  //     恒等，但浩劫/混乱把 energyOnUse 设成了「当前全部能量」，靠 autoplay 那项拦着）；
  //   * autoplay 那项是第九批新增的：浩劫 / 混乱从抽牌堆顶打出的牌不扣能量；
  //   * 腐化在场时技能牌**一律不扣能量**。多数时候它是冗余的（腐化早把 costForTurn 压成 0
  //     了），但「战斗内升级一张升级后费用不同的技能牌」会把 cost/costForTurn 一起改回非 0
  //     （见 upgradeCard 的尾部），那时就只剩这一项拦着——军备 + 腐化同场即可走到。
  // TODO(后续PR): `isFreeToPlay`（freeToPlayOnce / 自由攻击），两者都还没有产出者。
  if (
    costForTurnAtUse > 0 &&
    !item.autoplay &&
    !(def.type === "skill" && getPower(bc.player.powers, "corruption") > 0)
  ) {
    bc.player.energy -= costForTurnAtUse;
  }
}

/**
 * 打出一张**攻击牌**之后的 Power 触发（对齐 BattleContext::onUseAttackCard，
 * BattleContext.cpp:1623）。
 *
 * 已登记两条，顺序照参考的书写顺序（这一族不是遍历 statusMap，先后取决于源码里怎么写）：
 * 残影(未登记) → **二连击** → 复制(未登记) → 回响形态(未登记) → 风采(未登记) → 怒火。
 *
 * 二连击：`if (!item.purgeOnUse && hasStatus<DOUBLE_TAP>()) { queuePurgeCard(c, item.target);
 * decrementStatus<DOUBLE_TAP>(); }`。⚠ 三处照抄：
 *  ① `!item.purgeOnUse` —— 复制出来的那一击**不会**再触发一次二连击，否则会无限自我复制；
 *  ② 复制项走 queuePurgeCard，进的是**出牌队列**而不是动作队列，所以它排在本次出牌产生的
 *     所有动作（伤害、OnAfterCardUsed …）**之后**才结算；
 *  ③ 层数**同步**递减一层（不入队）。
 * ⚠ 由此得到一条重要表现：这一击若打死了最后一只怪，executeActions 在「抽干动作队列」
 * 与「取下一个出牌项」之间有一道 `outcome != UNDECIDED` 的门，复制项就再也轮不到了。
 *
 * 怒火：`addToBot(Actions::GainBlock(层数))`。
 * ⚠ 三处照抄：① 格挡走**裸** GainBlock，**不过** calculateCardBlock——敏捷/脆弱不参与，
 * 无法格挡（NO_BLOCK）也拦不住它（它只拦「牌产生的格挡」）；② GainBlock 的
 * clearOnCombatVictory=false，所以这一击打死最后一只怪时格挡照样加上；③ 只有攻击牌触发，
 * 技能/能力牌走各自的 onUseSkillCard / onUsePowerCard，里面没有怒火。
 * ⚠ 加格挡会走 gainBlock，因此**能连锁触发主宰**（怒火 → 格挡 → 主宰伤害）。
 *
 * ⚠ 参考在这里还有 `removeStatus<PS::VIGOR>()`：没有任何已登记内容能给出精力，
 * 留 TODO——现在写了也没有 trace 走得到，等于无背书的代码。
 *
 * ⚠ `++p.attacksPlayedThisTurn`（:1643）第四十一批补上了，见下方注释。
 */
/**
 * 复制（DUPLICATION，第四十五批的复制药水）：四个 `onUseXxxCard` 里**逐字相同**的一格。
 *
 * 对齐 `BattleContext::onUseAttackCard` :1656 / `onUseSkillCard` :1782 /
 * `onUsePowerCard` :1861 / `onUseStatusOrCurseCard` :1924：
 *     if (!item.purgeOnUse && p.hasStatus<PS::DUPLICATION>()) {
 *         queuePurgeCard(c, item.target);
 *         p.decrementStatus<PS::DUPLICATION>();
 *     }
 *
 * ⚠ 五处照抄：
 *  ①⚠⚠ **四个 handler 都有**，与墨水瓶（三个）/ 橙色药丸（三个）/ 二连击（只有攻击牌那个）
 *     都不同——复制药水复制的是**任何**牌型，包括状态牌与诅咒牌。
 *  ② `!item.purgeOnUse` 那道门：复制出来的那一份自己不再复制，否则一层复制会无限增殖。
 *  ③ 复制走 `queuePurgeCard`，与二连击**同一个函数**（`ignoreEnergyTotal` / `purgeOnUse`
 *     都为真），所以复制出来的那份不花能量、结算完直接丢掉、不进弃牌堆。
 *  ④ 递减是**同步**的裸 `decrementStatus`（不入队），所以同一回合的下一张牌立刻读到新层数。
 *  ⑤ 位置：在残影（未登记）之后、回响成型（未登记）与诅咒之前。攻击牌那个 handler 里
 *     它排在**二连击之后**——两者都带时同一张牌会被复制两次。
 */
function duplicationOnUseCard(bc: BattleContext, item: CardQueueItem, card: CombatCard): void {
  if (!item.purgeOnUse && getPower(bc.player.powers, "duplication") > 0) {
    queuePurgeCard(bc, card, item.target, item.energyOnUse);
    decrementPlayerPower(bc, "duplication");
  }
}

function onUseAttackCard(bc: BattleContext, item: CardQueueItem, card: CombatCard): void {
  // ⚠⚠ **自增排在整个函数的第一句**（对齐 BattleContext.cpp:1643，紧跟在取 `item` / `c` /
  //   `p` 三个引用之后、所有 Power 与遗物之前）。三颗计数遗物的判据都是 `% 3 == 0`，
  //   而 **0 也满足 `% 3 == 0`**——把这一句挪到读点之后，本回合第 1 张攻击牌就会读到 0
  //   并当场误触发，此后每三张错一位。**顺序即语义。**
  bc.player.attacksPlayedThisTurn += 1;
  if (!item.purgeOnUse && getPower(bc.player.powers, "double_tap") > 0) {
    queuePurgeCard(bc, card, item.target, item.energyOnUse);
    decrementPlayerPower(bc, "double_tap");
  }
  // 复制药水：紧跟在二连击之后（BattleContext.cpp:1656），见 duplicationOnUseCard。
  duplicationOnUseCard(bc, item, card);
  const rage = getPower(bc.player.powers, "rage");
  if (rage > 0) {
    addToBot(bc, (c) => gainBlock(c, rage), false);
  }
  // 干劲（VIGOR）的摘除（对齐 BattleContext.cpp:1678-1680，排在怒火**之后**、笔尖之前）：
  //     if (p.hasStatus<PS::VIGOR>()) { p.removeStatus<PS::VIGOR>(); }
  // ⚠⚠ **第四十四批才补上，因为在赤芥子之前干劲没有任何来源**——`getPower(…, "vigor")`
  //   恒是 0，摘不摘都一样。赤芥子（开局 8 层干劲）一登记它就承重了：少了这一句，
  //   那 8 点会加在**整场每一张**攻击牌上。
  // ⚠ 走 `removeStatus`（整条摘掉），不是递减；而且是**同步**的。
  // ⚠ 顺带解释一处看着像重复计数的地方：群伤牌（顺劈斩 / 旋风斩 / 剑刃回旋 …）在
  //   `CARD_RULES` 里把干劲**手动加进 baseDamage**，而 `calculateCardDamage` 里也加一次。
  //   两者不冲突——参考同样这么写（BattleContext.cpp:1028 等），理由是那些牌把伤害
  //   **入队**结算，而这一句在入队之前就把干劲摘了，出队时 `calculateCardDamage` 读到的是 0。
  //   参考在剑刃回旋那行自注 `// vigor is removed afterwards so this is a necessary hack`。
  if (hasPower(bc.player.powers, "vigor")) {
    removePower(bc.player.powers, "vigor");
  }
  // 笔尖那一层 Power 的**摘除**（对齐 BattleContext.cpp:1686-1691，排在干劲之后、
  // 自由攻击之后、墨水瓶之前）：
  //     if (p.hasStatus<PS::PEN_NIB>()) {
  //         // todo does this need to be added to bot?
  //         addToBot( Actions::RemoveStatus<PS::PEN_NIB>() );
  //     }
  // ⚠⚠ **是 `addToBot`（入队）而不是同步**，而干劲那一句是同步的——两条挨在一起、形状不同。
  //   差别可观察：伤害在打牌时就算好了，所以这一张照样翻倍；但**入队**意味着它排在这张牌
  //   自己的效果**之后**，于是同一张牌排的连锁伤害（例如二连击的复制项）还能吃到翻倍。
  // ⚠ 参考在这里自注 `// todo does this need to be added to bot?`——作者自己也不确定，
  //   但预言机就是参考，照抄 as-built。
  // ⚠ 自由攻击（FREE_ATTACK_POWER）那一格没有登记：全参考没有产出者（那是守望者的）。
  if (hasPower(bc.player.powers, "pen_nib")) {
    addToBot(bc, (c) => removePower(c.player.powers, "pen_nib"));
  }
  // —— 回合内攻击计数遗物（第四十一批）——
  //
  // 参考把它们写成 `onUseAttackCard` 里**三个各自独立的 `if`**，共用同一个计数器却分散在
  // 三个位置上，中间还夹着别的遗物（BattleContext.cpp:1698-1720）：
  //
  //     if (p.hasRelic<R::INK_BOTTLE>())      { … }                       // :1694
  //     if (p.hasRelic<R::KUNAI>() && p.attacksPlayedThisTurn % 3 == 0)    // :1702
  //         addToBot( Actions::BuffPlayer<PS::DEXTERITY>(1) );
  //     if (p.hasRelic<R::ORANGE_PELLETS>())  { … }                       // :1706
  //     if (p.hasRelic<R::ORNAMENTAL_FAN>() && … % 3 == 0)                 // :1714
  //         addToBot( Actions::GainBlock(4) );
  //     if (p.hasRelic<R::SHURIKEN>() && … % 3 == 0)                       // :1718
  //         addToBot( Actions::BuffPlayer<PS::STRENGTH>(1) );
  //
  // ⚠ 四处照抄：
  //  ① **逐条独立**，不要合并成「计数到 3 就一起结算」——中间那两颗（墨水瓶 / 橙色药丸，
  //     第四十二批登记）就无处安放。⚠ 但**登记它们并没有让「三颗的相对顺序」变得可观察**，
  //     那条盲区仍是 0 例，理由与实测例数见 TODOS（两道门：两颗遗物要在**同一张牌**上同时
  //     触发，且那一刻玩家的力量或敏捷要为负）。
  //  ② **入队**（`addToBot`），所以排在这张攻击牌自己的伤害**之后**——手里剑加的力量
  //     不影响触发它的那一击。
  //  ③ `clearOnCombatVictory` 逐条不同：`Actions::BuffPlayer` 用的是 `Action` 的默认值
  //     **true**（ActionQueue.h:22），而 `Actions::GainBlock` 显式传 **false**
  //     （Actions.cpp:161-165）。于是这一击打死最后一只怪时，装饰扇的 4 点格挡照样加上，
  //     苦无的敏捷与手里剑的力量却被 `clearPostCombatActions` 清掉。
  //  ④ 格挡走**裸** `GainBlock`（与怒火同一条），不过 `calculateCardBlock`。
  inkBottleOnUseCard(bc); // :1694，排在苦无之前
  if (hasRelic(bc, "kunai") && bc.player.attacksPlayedThisTurn % 3 === 0) {
    addToBot(bc, (c) => addPower(c.player.powers, "dexterity", 1));
  }
  orangePelletsOnUseCard(bc, 0); // :1706，**夹在苦无与装饰扇之间**（CardType::ATTACK = 0）
  if (hasRelic(bc, "ornamental_fan") && bc.player.attacksPlayedThisTurn % 3 === 0) {
    addToBot(bc, (c) => gainBlock(c, 4), false);
  }
  if (hasRelic(bc, "shuriken") && bc.player.attacksPlayedThisTurn % 3 === 0) {
    addToBot(bc, (c) => addPower(c.player.powers, "strength", 1));
  }
  // 二元性（DUALITY，第四十三批）：排在手里剑**之后**、笔尖之后、双截棍之前
  // （BattleContext.cpp:1736-1738）：`addToBot(Actions::DualityAction());`
  // 而那条动作的函数体是（Actions.cpp:1004-1009）：
  //     bc.player.buff<PS::DEXTERITY>(1);
  //     bc.player.debuff<PS::LOSE_DEXTERITY>(1);
  // ⚠ 四处照抄：
  //  ①⚠ **两句在同一条动作里**，所以「+1 敏捷」与「记一层敏捷流失」是原子的；
  //     它与苦无那条 `BuffPlayer<DEXTERITY>(1)` 的差别只在多了后面那句还债。
  //  ②⚠ 还债走 `debuff` ⇒ **过神器**：神器在手时 LOSE_DEXTERITY 被吃掉，这点敏捷就白赚。
  //  ③ **每张攻击牌都触发**（没有 `% 3` 那种门），所以一个回合能叠好几层。
  //  ④ 还债在**本回合末**结算（`applyEndOfTurnPowers` 的 LOSE_DEXTERITY=13 那一格），
  //     所以卡面「本回合」那两个字全靠那一格。
  // 死灵之书（NECRONOMICON，第四十四批）：排在手里剑**之后**、笔尖之前
  // （BattleContext.cpp:1722-1726）：
  //     if (p.hasRelic<R::NECRONOMICON>() && !p.haveUsedNecronomiconThisTurn && !item.freeToPlay &&
  //         !item.purgeOnUse && (c.costForTurn >= 2 || c.isXCost() && item.energyOnUse >= 2)) {
  //         queuePurgeCard(c, item.target);
  //         p.haveUsedNecronomiconThisTurn = true;
  //     }
  // ⚠ 五处照抄：
  //  ①⚠⚠ **`!item.purgeOnUse`**：复制出来的那一张自己不会再复制（否则无限递归）。
  //     与二连击 / 复制那条 Power 用的是同一个 `queuePurgeCard`（第九批铺好的）。
  //  ② 门是 `costForTurn >= 2`，读的是**实例级本回合费用**——腐化改过费的牌照新值判。
  //     X 费牌走另一支：`CardInstance::isXCost()` 就是 `cost == -1`（CardInstance.h:60），
  //     而 `cost` 是**基础**费用（`initialCardCost` 给 X 费牌播的哨兵就是 -1），
  //     所以这里读 `card.cost === -1` 而不是 `costForTurn`——旋风斩打出时
  //     `costForTurn` 已经被夹成实际花掉的能量了。
  //  ③ `haveUsedNecronomiconThisTurn` 在**回合开始**复位（`applyStartOfTurnRelics`），
  //     不是回合末——所以「每回合第一张」是靠那一处实现的。
  //  ④ 位置：在手里剑之后、笔尖之前。复制项进的是**出牌队列队首**，所以它在这张牌自己的
  //     效果结算完之后**紧接着**被打出。
  //  ⑤ 它**不**看这张牌打没打中、也不看有没有目标——`queuePurgeCard` 原样带走 `item.target`。
  if (
    hasRelic(bc, "necronomicon") &&
    !bc.player.haveUsedNecronomiconThisTurn &&
    !item.freeToPlay &&
    !item.purgeOnUse &&
    (card.costForTurn >= 2 || (card.cost === -1 && item.energyOnUse >= 2))
  ) {
    // ⚠ `queuePurgeCard` 的第四个实参在参考里是 `item.energyOnUse`
    //   （`BattleContext::queuePurgeCard` 的函数体里 `item.energyOnUse = curCardQueueItem.energyOnUse`），
    //   与二连击那条同源。
    queuePurgeCard(bc, card, item.target, item.energyOnUse);
    bc.player.haveUsedNecronomiconThisTurn = true;
  }
  // 笔尖（PEN_NIB，第四十四批）：排在死灵之书**之后**、二元性之前
  // （BattleContext.cpp:1728-1734）：
  //     if (p.hasRelic<R::PEN_NIB>()) {
  //         ++p.penNibCounter;
  //         if (p.penNibCounter == 9) {
  //             addToBot( Actions::BuffPlayer<PS::PEN_NIB>(1) );
  //             p.penNibCounter = -1; // take note of this
  //         }
  //     }
  // ⚠ 四处照抄：
  //  ①⚠⚠ **命中时写 -1 而不是 0**（参考在行尾自注 `// take note of this`）：这一张牌
  //     自己**不**被翻倍——`PEN_NIB` 是 `addToBot` 上的，而伤害早就算完了。-1 让下一张牌
  //     把计数器带回 0，于是「每 10 张攻击牌翻倍一次」而不是每 9 张。写成 0 会让周期变成 9。
  //  ② `== 9` 而不是 `>= 9`，配合那个 -1。
  //  ③ `PEN_NIB` 这个 Power 的两个读点：`calculateCardDamage` 里 `damage *= 2`
  //     （排在双重伤害之后、虚弱之前，BattleContext.cpp:2729-2731），
  //     以及**同一个函数上方**的 `addToBot(RemoveStatus<PEN_NIB>())`（:1686-1691，
  //     参考自注 `// todo does this need to be added to bot?`）——**打一张攻击牌就摘**。
  //  ④ 出战斗时 -1 被写回成 **9**（见 `updateRelicsOnExit`）。
  if (hasRelic(bc, "pen_nib")) {
    bc.player.penNibCounter += 1;
    if (bc.player.penNibCounter === 9) {
      addToBot(bc, (c) => addPower(c.player.powers, "pen_nib", 1));
      bc.player.penNibCounter = -1;
    }
  }
  if (hasRelic(bc, "duality")) {
    addToBot(bc, (c) => {
      addPower(c.player.powers, "dexterity", 1);
      debuffPlayer(c, "lose_dexterity", 1);
    });
  }
  // 双节棍（NUNCHAKU，第四十四批）：排在二元性**之后**（BattleContext.cpp:1740-1745）：
  //     if (p.hasRelic<R::NUNCHAKU>()) {
  //         if (++p.nunchakuCounter >= 10) {
  //             addToBot(Actions::GainEnergy(1));
  //             p.nunchakuCounter = 0;
  //         }
  //     }
  // ⚠ 三处照抄：
  //  ①⚠ **门是 `>= 10` 而不是 `== 10`**，与墨水瓶 / 笔尖那两颗正好相反——三颗计数遗物
  //     并排放在同一段里，写法却是 `== 10` / `== 9` / `>= 10` 三种。当前三者同解
  //     （每次只 +1，不可能跳过），但照抄，别统一。
  //  ② **归零排在入队之后**（先 addToBot 再 `= 0`），与笔尖那条的 `= -1` 位置相同。
  //  ③ 计数器跨战斗延续（`initRelics` 搬进来、`updateRelicsOnExit` 写回去）。
  if (hasRelic(bc, "nunchaku")) {
    bc.player.nunchakuCounter += 1;
    if (bc.player.nunchakuCounter >= 10) {
      addToBot(bc, (c) => {
        c.player.energy += 1;
      });
      bc.player.nunchakuCounter = 0;
    }
  }

  // —— 尖锐外壳（SHARP_HIDE，守卫者的防御形态）——
  //
  // 对齐 `BattleContext::onUseAttackCard` 的**最末**那三行（BattleContext.cpp:1756-1759）。
  // 这是本项目第二条「玩家出牌 → 怪物反应」的钩子（第一条是第十八批的激怒），四处照抄：
  //
  //  ① **挂在攻击牌上**，不是技能牌。激怒在 `onUseSkillCard` 的最末（:1847-1849），
  //     两条写法一模一样、位置却在两个不同的函数里——真实游戏的措辞也是「每当你打出
  //     一张**攻击**牌，受到 X 点伤害」。数据上可分辨：守卫者带外壳时打防御牌不掉血。
  //  ② 走 `Actions::DamagePlayer(层数)` —— **非攻击伤害**（`Player::damage`），
  //     所以**过格挡**、且 `selfDamage` 取默认的 false（不触发破裂）。
  //  ③ **入队**（`addToBot`），排在卡效果**之后**——卡把伤害排在前面，反伤落在后面。
  //     `clearOnCombatVictory` 是 false（Actions.cpp:91-95），所以这一击打死守卫者时
  //     反伤照样落在玩家身上。
  //  ④ ⚠ **参考只看 `monsters.arr[0]`**，写死下标 0、也不判死活——与激怒同一个写法。
  //     守卫者是单怪 Boss，当前与「遍历全体」完全等价。TODOS 已就激怒那条裁定过
  //     「不打补丁」（判据：① 在已登记内容里真的产生分歧 ② 补丁有预言机，两条都要成立），
  //     尖锐外壳两条同样不成立，故**照抄不改**。
  //     ⚠ 而且它比激怒更彻底：全参考项目 buff `SHARP_HIDE` 的**只有守卫者**
  //     （`MonsterSpecific.cpp:1352` 是唯一的写入点），而守卫者只出现在单怪编队里，
  //     所以这个 `arr[0]` 在参考的整个内容集合里**永远不可能产生分歧**——
  //     连「哪一批能关掉它」都没有，与激怒那条（`COLOSSEUM_EVENT_NOBS` 能关）不同。
  const m = bc.monsters[0];
  if (m === undefined) {
    return;
  }
  const sharpHide = getPower(m.powers, "sharp_hide");
  if (sharpHide > 0) {
    addToBot(bc, (c) => damagePlayerNonAttack(c, sharpHide, false), false);
  }
}

/**
 * 打出一张**技能牌**之后的触发（对齐 `BattleContext::onUseSkillCard`，
 * BattleContext.cpp:1764-1850）。本项目**第一个「玩家出牌 → 怪物获益」的钩子**。
 *
 * 已登记一条：**激怒（ENRAGE，地精头目）**——`m.buff<MS::STRENGTH>(m.getStatus<MS::ENRAGE>())`
 *（:1847-1849）。四处逐位对齐点：
 *
 *  ① **位置在整个函数的最末**，排在残影 / 爆发 / 复制 / 回响形态 / 六芒星 / 华彩以及全部
 *     遗物之后。这一族不是遍历 statusMap，先后完全取决于参考的书写顺序。
 *  ② 它排在 `useSkillCard()`（卡效果**入队**）**之后**，但自己是**同步** buff——于是
 *     「先加力量、后结算卡效果」。当前没有技能牌的排队效果读怪物力量，但顺序照抄。
 *  ③ **不消耗层数**（与狂怒同族、与蜷缩相反）：每打一张技能牌就再涨一次。
 *  ④ ⚠ **参考只看 `monsters.arr[0]`**，写死下标 0、也不判死活。地精头目是单怪编队，
 *     所以当前与「遍历全体」等价；但这是参考的简化（真实游戏里激怒是挂在那只怪身上的
 *     Power，谁有谁涨）。第一幕没有第二只带激怒的怪，**没有预言机能判它**，故照抄不改。
 *
 * ⚠ 只有**技能牌**触发：攻击牌走 onUseAttackCard、能力牌走 onUsePowerCard，两者里都没有
 * 激怒。状态/诅咒牌走 onUseStatusOrCurseCard，同样没有。
 *
 * ⚠ `++p.skillsPlayedThisTurn`（:1769）与拆信刀第四十一批一起补上了，见下方注释。
 *
 * TODO(后续PR): 爆发（`onUseSkillCard` 里的 queuePurgeCard）、复制药水、回响形态、残影、
 *   六芒星的眩晕、华彩，以及墨水瓶 / 橙色药丸两个遗物。
 */
function onUseSkillCard(bc: BattleContext, item: CardQueueItem, card: CombatCard): void {
  // ⚠ 自增排在整个函数的第一句（对齐 BattleContext.cpp:1769），与攻击那条同形、同理由。
  bc.player.skillsPlayedThisTurn += 1;
  // 复制药水：排在爆发（未登记）之后、回响成型（未登记）与诅咒之前（:1782）。
  duplicationOnUseCard(bc, item, card);
  // 诅咒（HEX，选民）：位置照抄——排在残影 / 爆发 / 复制 / 回响形态**之后**、华彩与全部遗物
  // **之前**，因此也在最末那条激怒之前（BattleContext.cpp:1796-1798）。见 `hexShuffleDazed`。
  hexShuffleDazed(bc);
  // —— 墨水瓶 / 橙色药丸（第四十二批）——
  // 参考在技能牌这条路上的书写顺序是 墨水瓶 :1811 → 橙色药丸 :1819 → 拆信刀 :1828 →
  // 木乃伊手（未登记）。⚠⚠ **墨水瓶与橙色药丸的先后是可观察的**（第四十二批实测）：
  // 墨水瓶排的是 `DrawCards(1)`、橙色药丸排的是 `RemovePlayerDebuffs`，而清减益里有
  // `removeStatus<PS::NO_DRAW>()`——玩家身上有「无法抽牌」（战斗恍惚）时，as-built
  // 的顺序是「先抽（被 NO_DRAW 挡住、一张都没抽）、后清」，对调就变成真的抽到一张。
  inkBottleOnUseCard(bc);
  orangePelletsOnUseCard(bc, 1); // CardType::SKILL = 1
  // —— 拆信刀（LETTER_OPENER，第四十一批）——
  //
  // 对齐 BattleContext.cpp:1827-1831：
  //     if (p.hasRelic<R::LETTER_OPENER>()) {
  //         if (p.skillsPlayedThisTurn >= 3 &&  p.skillsPlayedThisTurn % 3 == 0) {
  //             addToBot(Actions::DamageAllEnemy(5));
  //         }
  //     }
  // ⚠ 四处照抄：
  //  ① **位置在墨水瓶 / 橙色药丸之后、木乃伊手之前**，也就是所有 Power 与最末那条激怒之间。
  //  ② `>= 3` 这一半在**当前形状下是死条件**：计数器在函数第一句就自增过，所以到这里
  //     它至少是 1，而 `x >= 1 && x % 3 == 0` 蕴含 `x >= 3`。照抄不删——它记录的是
  //     作者对「0 也满足 `% 3 == 0`」这件事的防备，而那份防备在攻击那三颗上**没有**写。
  //     （判据：这是「等价改写」，不是笔误，也不该报补丁。）
  //  ③ 走 `Actions::DamageAllEnemy` = **非攻击伤害**、过 `Monster::damage`（不是 `attacked`），
  //     所以不吃力量/易伤加成、也不触发蜷缩，但**会**触发手钻那一份与荆棘。
  //  ④ **入队**，`clearOnCombatVictory` 取默认的 true。
  if (hasRelic(bc, "letter_opener")) {
    if (bc.player.skillsPlayedThisTurn >= 3 && bc.player.skillsPlayedThisTurn % 3 === 0) {
      addToBot(bc, (c) => damageAllEnemiesNonAttack(c, 5));
    }
  }
  const m = bc.monsters[0];
  if (m === undefined) {
    return;
  }
  const enrage = getPower(m.powers, "enrage");
  if (enrage > 0) {
    addPower(m.powers, "strength", enrage);
  }
}

/**
 * 诅咒（HEX）的触发：把**一张恍惚洗进抽牌堆**（对齐
 * `addToBot(Actions::MakeTempCardInDrawPile(CardInstance(CardId::DAZED), 1, true))`）。
 *
 * ⚠ 参考把**同一句**写在三个函数里：`onUseSkillCard`（BattleContext.cpp:1796）、
 * `onUsePowerCard`（`:1875`）、`onUseStatusOrCurseCard`（`:1938`）。
 * **`onUseAttackCard` 里没有**——这就是「非攻击牌才触发」的全部实现，没有别的判定。
 *
 * ⚠ 三处逐位对齐点：
 *  ① **入队**（`addToBot`），不是同步——所以它排在这张牌自己的效果**之后**；
 *  ② `shuffleInto = true` 那一路要掷 **cardRandomRng**（抽牌堆非空时
 *     `cardRandomRng.random(size-1)` 选插入位），与哨卫射钉那种「塞弃牌堆」不同；
 *  ③ 张数恒 1、恍惚恒不升级。
 */
function hexShuffleDazed(bc: BattleContext): void {
  if (getPower(bc.player.powers, "hex") > 0) {
    addToBot(bc, (c) => {
      makeTempCardInDrawPile(c, "dazed", 1); // ★ 抽牌堆非空时消耗一次 cardRandomRng
    });
  }
}

/**
 * 打出一张**能力牌**之后的触发（对齐 `BattleContext::onUsePowerCard`，
 * BattleContext.cpp:1852-1914）。第二十三批新增，目前只有诅咒一条。
 *
 * 第四十二批补上墨水瓶（:1889）与橙色药丸（:1897），第四十三批补上**鸟面坛**（:1885）。
 * 参考在这条路上的书写顺序是 鸟面坛 → 墨水瓶 → 橙色药丸 → 木乃伊手（未登记）。
 *
 * ⚠ 鸟面坛（BIRD_FACED_URN）：`if (p.hasRelic<R::BIRD_FACED_URN>()) { p.heal(2); }`
 *  ①⚠ **同步** `heal`，不入队——所以它排在这张能力牌自己排的效果**之前**落地。
 *  ② 走的是 `Player::heal`，因此会被**魔力之花**放大（×3/2 → 3 点）、被**绽放印记**整个挡掉，
 *     也会触发红骷髅那道「回到半血以上就掉 3 力量」。见 `healPlayer`。
 *  ③ 它是这一族里**唯一**的常规回血来源（血瓶只在开局回一次，而那时玩家通常满血）。
 *
 * TODO(后续PR): 残影 / 复制 / 回响形态 / 华彩，以及木乃伊手。
 */
function onUsePowerCard(bc: BattleContext, item: CardQueueItem, card: CombatCard): void {
  // 复制药水：排在残影（未登记）之后、回响成型（未登记）与诅咒之前（:1861）。
  duplicationOnUseCard(bc, item, card);
  hexShuffleDazed(bc);
  if (hasRelic(bc, "bird_faced_urn")) {
    healPlayer(bc, 2);
  }
  inkBottleOnUseCard(bc);
  orangePelletsOnUseCard(bc, 2); // CardType::POWER = 2
  // 木乃伊之手（MUMMIFIED_HAND，第四十四批）：整个函数的最后一句
  // （BattleContext.cpp:1905-1907）：`if (p.hasRelic<R::MUMMIFIED_HAND>()) mummifiedHandOnUsePower();`
  // ⚠⚠ **它在 `onUseSkillCard` 里也有一格（:1833-1835），但那一格的函数体是空的 `// todo`**
  //   ——参考只实现了能力牌这一条。照抄：技能牌那半不写。
  if (hasRelic(bc, "mummified_hand")) {
    mummifiedHandOnUsePower(bc);
  }
}

/**
 * 木乃伊之手的效果（对齐 `BattleContext::mummifiedHandOnUsePower`，BattleContext.cpp:2878-2907）。
 *
 * ```cpp
 * fixed_list<int,10> matchingIdxList;
 * for (int i = 0; i < cards.cardsInHand; ++i) {
 *     const auto &c = cards.hand[i];
 *     bool canPick = c.cost > 0 && c.costForTurn > 0 && !c.freeToPlayOnce;
 *     if (canPick) matchingIdxList.push_back(i);
 * }
 * if (matchingIdxList.empty()) return;
 * for (int i = matchingIdxList.size()-1; i >= 0; --i) {
 *     const auto uniqueId = cards.hand[matchingIdxList[i]].getUniqueId();
 *     if (cardQueue.containsCardWithId(uniqueId)) matchingIdxList.remove(i);
 * }
 * if (matchingIdxList.empty()) return;
 * const int selectedListIdx = cardRandomRng.random(0, matchingIdxList.size()-1);
 * cards.hand[matchingIdxList[selectedListIdx]].setCostForTurn(0);
 * ```
 * ⚠ 五处照抄：
 *  ①⚠⚠ **两道筛选之间有一次「空了就提前返回」，而且它排在掷骰之前**——所以「手里全是
 *     0 费牌」时**一次 `cardRandomRng` 都不掷**。漏掉任一道提前返回都会让 RNG 计数器错位。
 *  ② 第一道筛的是 `cost > 0 && costForTurn > 0`：**基础费用与本回合费用都要 > 0**。
 *     X 费牌的 `cost` 是 -1 ⇒ 选不中；被腐化压成 0 费的技能 `costForTurn` 是 0 ⇒ 也选不中。
 *  ③ 第二道**倒序**从候选里剔掉「已经在出牌队列里的那张」（二连击 / 混乱排着的那张）。
 *     倒序是因为 `remove(i)` 会改变后面的下标——照抄方向。
 *  ④ 掷的是 `random(0, n-1)`（★ 一次 `cardRandomRng`），不是 `random(n)`。
 *  ⑤ `setCostForTurn(0)` 只改**本回合**费用，不动 `cost`。
 */
function mummifiedHandOnUsePower(bc: BattleContext): void {
  let matching = bc.hand.flatMap((c, i) => (c.cost > 0 && c.costForTurn > 0 ? [i] : []));
  if (matching.length === 0) {
    return;
  }
  matching = matching.filter((i) => {
    const uid = bc.hand[i]?.uid;
    return uid === undefined || !bc.cardQueue.containsCardWithUid(uid);
  });
  if (matching.length === 0) {
    return;
  }
  const pick = bc.rng.cardRandomRng.random(0, matching.length - 1); // ★ 消耗一次 cardRandomRng
  const target = bc.hand[matching[pick]];
  if (target !== undefined) {
    setCostForTurn(target, 0);
  }
}

/**
 * 随机升级一张手牌（对齐 `Actions::UpgradeRandomCardAction`，Actions.cpp:946-968）。扭曲钳专用。
 *
 * ```cpp
 * fixed_list<int,10> upgradeableHandIdxs;
 * for (i…) if (bc.cards.hand[i].canUpgrade()) upgradeableHandIdxs.push_back(i);
 * if (upgradeableHandIdxs.empty()) return;
 * java::Collections::shuffle(begin, end, java::Random(bc.shuffleRng.randomLong()));
 * bc.cards.hand[upgradeableHandIdxs[0]].upgrade();
 * ```
 * ⚠ 四处照抄：
 *  ①⚠⚠ **它洗的是「可升级手牌的下标表」，然后取第 0 个**，不是掷一次 `random(n)`。
 *     两者消耗的 RNG **流不同**（这里是 `shuffleRng`，不是 `cardRandomRng`）也**不同源**，
 *     结果分布也不同（Java 的 `Collections.shuffle` 是 Fisher-Yates，取第 0 个 ≠ 掷一次）。
 *  ②⚠ **候选为空时一次 `shuffleRng` 都不掷**（提前返回排在洗牌之前）。
 *  ③ `canUpgrade()` = 「有升级形态且还没升级」；灼热之刃**永远可升级**（可反复升）。
 *  ④ 升级是**就地**改这张手牌实例，只影响本场战斗。
 */
function upgradeRandomCardInHand(bc: BattleContext): void {
  const idxs = bc.hand.flatMap((c, i) => (canUpgradeCard(c) ? [i] : []));
  if (idxs.length === 0) {
    return;
  }
  const lcg = new JavaRandom(bc.rng.shuffleRng.randomLong()); // ★ 消耗一次 shuffleRng
  javaShuffle(idxs, lcg);
  const card = bc.hand[idxs[0]];
  if (card !== undefined) {
    upgradeCard(card);
  }
}

/**
 * 打出一张**状态牌 / 诅咒牌**之后的触发（对齐 `BattleContext::onUseStatusOrCurseCard`，
 * BattleContext.cpp:1915-1960）。第二十三批新增，目前只有诅咒一条。
 *
 * ⚠ 能走到这里的只有**打得出去**的状态/诅咒牌。当前唯一登记的是黏液
 *（`CardInstance.cpp:329` 那个 `id != SLIMED` 的例外），恍惚 / 伤口 / 灼伤都打不出。
 *
 * 第四十二批补上**墨水瓶**（:1958）。⚠⚠ 两处形状必须照抄：
 *  ① 它是**整个函数的最后一句**，排在蓝色蜡烛 / 医疗包那个 `CURSE` / `STATUS` 分支
 *     （:1946-1957，两颗都未登记）**之后**；
 *  ② 这个 handler 里**没有橙色药丸**——`orangePelletsCardTypesPlayed` 是 `bitset<3>`，
 *     而 `CardType::CURSE` / `STATUS` 的枚举值是 3 / 4，放进来就越界了。
 *     **两颗遗物在另外三个 handler 里是并排的，只有这里分家，别照着邻居抄。**
 *
 * TODO(后续PR): 残影 / 复制 / 回响形态 / 华彩，以及蓝色蜡烛（诅咒牌失 1 血并消耗）。
 */
function onUseStatusOrCurseCard(bc: BattleContext, item: CardQueueItem, card: CombatCard): void {
  // 复制药水：排在残影（未登记）之后、回响成型（未登记）与诅咒之前（:1924）。
  // ⚠⚠ **状态牌 / 诅咒牌这一格是真的会被走到的**：黏液是策略唯一打得出去的状态牌，
  //   而复制药水对牌型没有任何过滤。
  duplicationOnUseCard(bc, item, card);
  hexShuffleDazed(bc);
  inkBottleOnUseCard(bc);
}

/**
 * 对齐 `BattleContext::onAfterUseCard`（BattleContext.cpp:1967-2046）。
 *
 * 参考的函数体分**两段**，中间夹着 `purgeOnUse` 那道提前返回：
 *   ① `if (item.triggerOnUse) { … }` —— 「玩家打完一张牌」这个时点上的**怪物侧**触发
 *      （时间扭曲 / **缓慢** / 死亡节拍），三条都只看 `monsters.arr[0]`；
 *   ② 卡去向：消耗 or 进弃牌堆。
 *
 * ⚠ `purgeOnUse` 那道提前返回排在**两段之间**（BattleContext.cpp:1993，还在能力牌那道之前）：
 * 二连击复制出来的那份是队列项里的副本，结算完就直接丢掉——不进弃牌堆、不进消耗堆，
 * 也不触发消耗链。少了这道门，二连击每打一次就凭空多出一张牌。
 * ⚠⚠ 但**第①段在它之前**，所以二连击复制出来的那一击**照样让缓慢 +1**。
 */
function onAfterUseCard(
  bc: BattleContext,
  card: CombatCard,
  exhaustOnUse: boolean,
  purgeOnUse: boolean,
  triggerOnUse: boolean,
): void {
  // —— 第①段：`if (item.triggerOnUse)`（BattleContext.cpp:1971-1991）——
  //
  // ⚠ 参考读的是 `monsters.arr[0]`：**写死 0 号位、不判死活**，与激怒 / 尖锐外壳同一个写法。
  //   缓慢全参考项目只有巨头一个宿主，而它是单怪编队，所以这里永远不会产生分歧。
  // ⚠ `triggerOnUse` 在**玩家出牌**那条路径上恒为真（`CardQueueItem::triggerOnUse` 默认 true，
  //   而 `playCardQueueItem` 只在 `purgeOnUse || (triggerOnUse && …)` 时才调 `useCard`，
  //   `purgeOnUse` 那一族又不改这一位）。唯一的假值来源是
  //   `Actions::TimeEaterPlayCardQueueItem`（第三十八批装上，见 `callEndTurnEarlySequence`）
  //   ——时间扭曲结束回合时被丢回来的那些牌**不再**推进计数器，否则一次结束回合会连锁触发。
  if (triggerOnUse) {
    const m0 = bc.monsters[0];
    // 时间扭曲（TIME_WARP，时间吞噬者，第三十八批）。对齐 BattleContext.cpp:1974-1985：
    //     if (m.hasStatus<MS::TIME_WARP>()) {
    //         auto timeWarp = m.getStatus<MS::TIME_WARP>();
    //         if (timeWarp == 11) {
    //             m.setStatus<MS::TIME_WARP>(0);
    //             m.buff<MS::STRENGTH>(2);
    //             callEndTurnEarlySequence();
    //         } else {
    //             m.setStatus<MS::TIME_WARP>(timeWarp + 1);
    //             ++timeWarp;          // ← 局部变量自增，之后没有任何人读它
    //         }
    //     }
    // ⚠ 六处照抄：
    //  ①⚠⚠ **阈值是 `== 11` 而不是 `>= 11`**。计数从 0 起（`preBattleAction` 的
    //     `buff<TIME_WARP>(0)`），第 1 张牌把它写成 1……第 11 张写成 11，**第 12 张**
    //     才命中。写成 `>=` 在正常路径上同解，但那是巧合——真正钉住它的是「12 张」这个周期。
    //  ②⚠⚠ **`setStatus<TIME_WARP>(0)` 只写数值、不碰 statusBits**（Monster.h:255-275），
    //     所以归零之后这条 Power **还在位置上**、计数继续从 0 涨。写成 `removeStatus`
    //     （整条摘掉）会让第二次时间扭曲永远不触发。⚠ 归零那一帧快照里看不见它
    //     （harness 折叠 `v == 0`），这与开局那一帧同理。
    //  ③⚠ **`++timeWarp` 是第 N 种死代码**：`timeWarp` 是 `auto`（值拷贝）的局部变量，
    //     自增之后函数就走到底了，没有任何人读它。照抄参考的实际行为 = 什么都不做。
    //  ④ 力量是 `buff<MS::STRENGTH>(2)`——**同步**、直接加在数值字段上，不过神器、不入队。
    //  ⑤⚠⚠ **读的是写死的 `monsters.arr[0]`、且不判死活**，与激怒 / 尖锐外壳 / 缓慢
    //     同一个写法。时间吞噬者全参考只出现在 `TIME_EATER`（单怪）里，所以不产生分歧。
    //  ⑥⚠⚠ 顺序照抄：**时间扭曲 → 缓慢 → 死亡节拍**。三者共用同一道 `triggerOnUse` 门。
    if (m0 !== undefined && hasPower(m0.powers, "time_warp")) {
      const timeWarp = getPower(m0.powers, "time_warp");
      if (timeWarp === 11) {
        setPower(m0.powers, "time_warp", 0);
        addPower(m0.powers, "strength", 2);
        callEndTurnEarlySequence(bc, card);
      } else {
        setPower(m0.powers, "time_warp", timeWarp + 1);
        // ⚠ 参考这里还有一句 `++timeWarp;`——局部变量自增、之后无人读。照抄 = 不写。
      }
    }
    // 缓慢（SLOW，巨头，第三十五批）：`if (m.hasStatus<MS::SLOW>()) m.buff<MS::SLOW>(1);`
    // ⚠ 三处照抄：
    //  ① 时点是 `Actions::OnAfterCardUsed` 这条**排队动作**执行的那一刻（`useCard` 末尾
    //     `addToBot`），也就是**这张牌自己的效果全部排完之后**。而攻击牌的伤害是在
    //     `CARD_RULES` 里就按当时的缓慢层数算好的——所以**打出的这张牌不吃自己那一层加成**，
    //     加成从下一张开始。把它挪到 `useCard` 开头会让每张牌都多吃一层。
    //  ② 是 `buff`（**累加**）而不是 `setStatus`：一个回合打 5 张就是 5 层。
    //  ③ 门是 `hasStatus`（条目在不在），而巨头开局层数恰好是 0 —— 写成 `> 0` 它永远涨不起来。
    if (m0 !== undefined && hasPower(m0.powers, "slow")) {
      addPower(m0.powers, "slow", 1);
    }
    // 死亡节拍（BEAT_OF_DEATH，腐化之心，第四十七批——第三十八批做时间扭曲时留的那笔账）：
    //     if (m.hasStatus<MS::BEAT_OF_DEATH>()) {
    //         addToBot( Actions::DamagePlayer(m.getStatus<MS::BEAT_OF_DEATH>()) );
    //     }
    //（BattleContext.cpp:1988-1990）
    // ⚠ 四处照抄：
    //  ①⚠ 它是这道 `triggerOnUse` 门里的**第三条**，顺序是**时间扭曲 → 缓慢 → 死亡节拍**。
    //     三者共用同一道门、都只读写死的 `monsters.arr[0]`、都不判死活。
    //  ② 是 `Actions::DamagePlayer`（**非攻击伤害**）：不过 `calculateDamageToPlayer`，
    //     所以怪物力量、玩家易伤 / 虚弱一概不参与——1 点就是 1 点；但**照样被格挡吸收**。
    //  ③ **入队**（`addToBot`），所以它排在这张牌自己排的效果之后。
    //  ④ 门是 `hasStatus`（条目在不在）。腐化之心开局层数就是 1（非 0），所以这里
    //     写 `hasPower` 与 `> 0` 当前同解——但形状照抄（同时间扭曲那条的教训）。
    // ⚠⚠ 它是这场仗真正的时间压力：**每打出一张牌**扣一次血，于是「多打牌」直接换成
    //   「少活几个回合」。本批的腐化之心牌组因此故意只打 2~3 张（见 harness 注释）。
    if (m0 !== undefined && hasPower(m0.powers, "beat_of_death")) {
      const amount = getPower(m0.powers, "beat_of_death");
      // ⚠ `Actions::DamagePlayer(n)` 的 `selfDamage` 取默认 **false**（不触发破裂），
      //   `clearOnCombatVictory` 是 **false**（Actions.cpp:91-95 的第二个实参）——
      //   与爆破怪的自爆走的是同一个 Action，两处形状必须一致。
      addToBot(bc, (c) => damagePlayerNonAttack(c, amount, false), false);
    }
  }
  if (purgeOnUse) {
    return;
  }
  // 能力牌打出后**直接离场**，不进任何牌堆（参考里是把 c.id 置为 INVALID 后 return）。
  if (getCardDef(card.defId).type === "power") {
    return;
  }
  // 奇异汤匙（STRANGE_SPOON，第四十三批）：对齐 BattleContext.cpp:2015-2023：
  //     bool spoonProc = false;
  //     if (item.exhaustOnUse && player.hasRelic<R::STRANGE_SPOON>()) {
  //         spoonProc = cardRandomRng.randomBoolean();
  //     }
  //     if (item.exhaustOnUse && !spoonProc) {
  //         triggerAndMoveToExhaustPile(c);
  //     } else { … moveToDiscardPile(c) … }
  // ⚠ 五处照抄：
  //  ①⚠⚠ **只有 `exhaustOnUse` 为真时才掷**——`cardRandomRng` 的计数器会当场抓住这一点。
  //     写成「无条件掷、再判」会让每打一张牌都白吃一次随机数。
  //  ②⚠ 掷中（true = 不消耗）时走的是 `else` 那一整支，也就是**进弃牌堆**（与普通牌同路）。
  //     所以「不消耗」的牌不会触发消耗链（骨灰 / 黑暗拥抱 / 无痛之心）。
  //  ③ 它排在**能力牌那道提前返回之后**——能力牌打出后直接离场，永远不掷这个随机数。
  //  ④ 用的是 `cardRandomRng` 而不是 `shuffleRng` / `miscRng`。
  //  ⑤ `randomBoolean()` 无参 = 50%（对齐 `Random::randomBoolean()`）。
  let spoonProc = false;
  if (exhaustOnUse && hasRelic(bc, "strange_spoon")) {
    spoonProc = bc.rng.cardRandomRng.randomBoolean(); // ★ 消耗一次 cardRandomRng
  }
  if (exhaustOnUse && !spoonProc) {
    triggerAndMoveToExhaustPile(bc, card);
  } else {
    bc.discardPile.push(card);
  }
}

/** 把可存档描述还原成一条排队动作（importState 用）。 */
function actionFromDesc(desc: ActionDesc): Action {
  switch (desc.kind) {
    case "after_use_card": {
      const card = { ...desc.card };
      const exhaustOnUse = desc.exhaustOnUse;
      // 老档没有 purgeOnUse（第九批新增），按 false 回填——它当时恒为假。
      const purgeOnUse = desc.purgeOnUse ?? false;
      // 老档没有 triggerOnUse（第三十五批新增），按 true 回填——参考的默认值就是 true。
      const triggerOnUse = desc.triggerOnUse ?? true;
      return makeAction(
        (c) => onAfterUseCard(c, card, exhaustOnUse, purgeOnUse, triggerOnUse),
        false,
        {
          kind: "after_use_card",
          card,
          exhaustOnUse,
          purgeOnUse,
          triggerOnUse,
        },
      );
    }
    case "draw_cards": {
      const count = desc.count;
      return makeAction((c) => drawCards(c, count), true, { kind: "draw_cards", count });
    }
    case "remove_player_debuffs":
      return makeAction((c) => removePlayerDebuffs(c), true, { kind: "remove_player_debuffs" });
  }
}

// ============================================================================
// 药水池（对齐 include/constants/Potions.h PotionPool::potionPool[4][33]）
//
// 每个角色 33 个：前 3 个是角色专属，后 30 个通用且四角色同序。
// 顺序**就是** getRandomPotion 的下标映射，改动即改变同种子结果。
// ============================================================================

const POTION_POOL_SIZE = 33;

/** 通用 30 项（下标 3..32），四角色共用同一顺序。 */
const SHARED_POTIONS: readonly string[] = [
  "block_potion",
  "dexterity_potion",
  "energy_potion",
  "explosive_potion",
  "fire_potion",
  "strength_potion",
  "swift_potion",
  "weak_potion",
  "fear_potion",
  "attack_potion",
  "skill_potion",
  "power_potion",
  "colorless_potion",
  "flex_potion",
  "speed_potion",
  "blessing_of_the_forge",
  "regen_potion",
  "ancient_potion",
  "liquid_bronze",
  "gamblers_brew",
  "essence_of_steel",
  "duplication_potion",
  "distilled_chaos",
  "liquid_memories",
  "cultist_potion",
  "fruit_juice",
  "snecko_oil",
  "fairy_in_a_bottle",
  "smoke_bomb",
  "entropic_brew",
];

/** 各角色专属的前 3 项。 */
const CLASS_POTIONS: Record<CharacterId, readonly string[]> = {
  ironclad: ["blood_potion", "elixir_potion", "heart_of_iron_potion"],
  silent: ["poison_potion", "cunning_potion", "ghost_in_a_jar"],
  defect: ["focus_potion", "potion_of_capacity", "essence_of_darkness"],
  watcher: ["bottled_miracle", "stance_potion", "ambrosia"],
};

function potionForClass(character: CharacterId, idx: number): string {
  const own = CLASS_POTIONS[character];
  return idx < own.length ? own[idx] : SHARED_POTIONS[idx - own.length];
}

/** 对齐 sts::getRandomPotion：一次 potionRng.random(poolSize-1)。 */
function getRandomPotion(bc: BattleContext): string {
  const idx = bc.rng.potionRng.random(POTION_POOL_SIZE - 1); // ★ 消耗一次 potionRng
  return potionForClass(bc.character, idx);
}

/**
 * 对齐 sts::returnRandomPotionOfRarity。
 *
 * ⚠ 这个循环的形状很怪但必须照抄：`limited` 为真时 spamCheck 初值即为真，所以**至少**
 * 会再抽一次；此后只要抽到果汁就把 spamCheck 保持为真、继续重抽。效果是 limited
 * 模式排除果汁，且消耗的 potionRng 次数不定。
 */
function returnRandomPotionOfRarity(bc: BattleContext, rarity: string, limited: boolean): string {
  let temp = getRandomPotion(bc);
  let spamCheck = limited;
  while (getPotionDef(temp).rarity !== rarity || spamCheck) {
    spamCheck = limited;
    temp = getRandomPotion(bc);
    if (temp !== "fruit_juice") {
      spamCheck = false;
    }
  }
  return temp;
}

/** 对齐 sts::returnRandomPotion：先掷稀有度，再在该稀有度里重抽。 */
export function returnRandomPotion(bc: BattleContext, limited = false): string {
  const roll = bc.rng.potionRng.random(0, 99); // ★ 消耗一次 potionRng
  const rarity = roll < 65 ? "common" : roll < 90 ? "uncommon" : "rare";
  return returnRandomPotionOfRarity(bc, rarity, limited);
}

// ============================================================================
// 药水槽与饮用（对齐 BattleContext::obtainPotion / discardPotion / drinkPotion）
// ============================================================================

/** 对齐 obtainPotion：满槽则丢弃，否则填入第一个空位。 */
export function obtainPotion(bc: BattleContext, potionId: string): void {
  // 清酒壶（SOZU，第四十四批）：对齐 `BattleContext::obtainPotion` 的第一道门
  // （BattleContext.cpp:2249-2251）：`if (potionCount == potionCapacity || hasRelic<R::SOZU>()) return;`
  // ⚠ 三处照抄：
  //  ①⚠ **它与「满槽」写在同一个 `if` 的析取里**——所以带着清酒壶时，药水直接消失，
  //     不是「先拿到再丢掉」。
  //  ② 战斗内唯一的调用点是熵酿（把空槽填满），所以两者一起带时熵酿一瓶都补不上。
  //  ③ 它的另一半是 `initRelics` 里的 `energyPerTurn++`。
  if (hasRelic(bc, "sozu")) {
    return;
  }
  if (bc.potionCount >= bc.potionCapacity) {
    return;
  }
  for (let i = 0; i < bc.potionCapacity; i += 1) {
    if (bc.potions[i] === null) {
      bc.potions[i] = potionId;
      bc.potionCount += 1;
      return;
    }
  }
}

export function discardPotion(bc: BattleContext, idx: number): void {
  if (bc.potions[idx] === null || bc.potions[idx] === undefined) {
    return;
  }
  bc.potions[idx] = null;
  bc.potionCount -= 1;
}

/**
 * 药水效果（逐个转写自 drinkPotion 的 switch 分支）。
 * 未登记的药水显式抛错，绝不静默跳过——静默会让 potionRng/战斗状态悄悄错位。
 */
type PotionRule = (bc: BattleContext, target: number, bark: boolean) => void;

/**
 * ⚠⚠ **第三个参数 `bark` 是神圣树皮（SACRED_BARK，第四十四批）**，对齐
 * `BattleContext::drinkPotion` 的第一句 `const bool hasBark = player.hasRelic<R::SACRED_BARK>();`
 * （BattleContext.cpp:2271）。参考把它写成**每一条 case 里的一个三元式**，33 条里
 * **32 条都是「翻倍」**（`hasBark ? 2n : n`）——所以它不是一条「统一 ×2」的规则，
 * 而是 33 个各写各的字面量。照抄每一条自己的两个数。
 */
const POTION_RULES: Record<string, PotionRule> = {
  block_potion: (bc, _target, bark) => addToBot(bc, (c) => gainBlock(c, bark ? 24 : 12), false),
  // 火焰/爆炸药水走 DamageEnemy（非攻击伤害），**不**触发蜷缩等 onAttacked 链。
  fire_potion: (bc, target, bark) =>
    addToBot(bc, (c) => damageEnemyNonAttack(c, target, bark ? 40 : 20)),
  explosive_potion: (bc, _target, bark) => {
    // ⚠ 参考把伤害算在**动作之外**（`const auto damage = hasBark ? 20 : 10;` 再入队），
    //   与别的 case 把三元式写在实参位上不同。当前同解，照抄形状。
    const damage = bark ? 20 : 10;
    addToBot(bc, (c) => {
      for (let i = 0; i < c.monsters.length; i += 1) {
        damageEnemyNonAttack(c, i, damage);
      }
    });
  },
  strength_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "strength", bark ? 4 : 2)),
  dexterity_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "dexterity", bark ? 4 : 2)),
  energy_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => {
      c.player.energy += bark ? 4 : 2;
    }),
  swift_potion: (bc, _target, bark) => addToBot(bc, (c) => drawCards(c, bark ? 6 : 3)),
  // 药水施加的减益同样是 isSourceMonster=false，不跳过首次递减。
  weak_potion: (bc, target, bark) =>
    addToBot(bc, (c) => debuffEnemy(c, target, "weak", bark ? 6 : 3, false)),
  fear_potion: (bc, target, bark) =>
    addToBot(bc, (c) => debuffEnemy(c, target, "vulnerable", bark ? 6 : 3, false)),
  blood_potion: (bc, _target, bark) => {
    // 对齐 `(int)((float)(player.maxHp * (hasBark ? 20 : 40)) / 100.0f)`（BattleContext.cpp:2300）。
    // ⚠⚠⚠ **那两个常数看着是反的，而且它是全表唯一的例外**：另外 32 条 `hasBark ? A : B`
    //   全部满足 A = 2B（翻倍），只有这一条是 A = B / 2（**带着神圣树皮反而回得更少**）。
    //   真实游戏里血之药水回 20% 上限、树皮翻成 40%，所以参考的两个数**都**对不上
    //   （基数多一倍、方向还反了）。
    //   ⚠ **本批照抄 as-built，不打补丁**：三条判据里第 ③ 条不过——「补上」有两种互不相同的
    //   写法（`hasBark ? 80 : 40` 保住既有 33946 例背书的基数、`hasBark ? 40 : 20` 对齐真实
    //   游戏），参考自己答不了是哪一种，而改基数会推翻全部已冻结数据。记进 TODOS「待裁定」。
    const heal = Math.trunc(Math.fround((bc.player.maxHp * (bark ? 20 : 40)) / 100));
    addToBot(bc, (c) => healPlayer(c, heal));
  },
  fruit_juice: (bc, _target, bark) => {
    // 立即生效，不入队（对齐 player.increaseMaxHp）。
    const amount = bark ? 10 : 5;
    bc.player.maxHp += amount;
    bc.player.hp += amount;
  },
  ancient_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "artifact", bark ? 2 : 1)),
  // 熵酿：把空槽填满随机药水——战斗内唯一消耗 potionRng 的地方。
  // ⚠ **它不吃神圣树皮**（参考那条 case 里没有 `hasBark`）：填满槽位这件事没法翻倍。
  entropic_brew: (bc) =>
    addToBot(bc, (c) => {
      for (let i = 0; i < c.potionCapacity; i += 1) {
        obtainPotion(c, returnRandomPotion(c, true));
      }
    }),

  // ==========================================================================
  // 第四十五批（药水战线第一批）：15 瓶
  //
  // 分三族，逐族一条注释；每一条自己的两个字面量仍然照抄参考那条 case。
  // ==========================================================================

  // —— 甲族：一句 `BuffPlayer<PS::X>`，而那个 Power 引擎已经有了 ——
  //
  // 这一族的转写成本是一行，但**不是没有可观察面**：层数直接进快照，翻倍常数抄错当场红。
  // ⚠ 逐条都要回参考数那两个字面量：同一个 switch 里 33 条 `hasBark ? A : B`，
  //   32 条是 A = 2B，值本身却各不相同（1/2、2/4、3/6、4/8、5/10、6/12）。

  // 灵活药水（BattleContext.cpp:2372-2375）：**两条动作**，与灵活那张牌逐字同形。
  // ⚠ 加力量走 `BuffPlayer`、还债走 `DebuffPlayer<LOSE_STRENGTH>`——后者过神器，
  //   于是「神器在手时喝灵活药水，力量白拿不用还」。参考与真实游戏都是这个表现。
  // ⚠ `Actions::DebuffPlayer` 的第二参数 `isSourceMonster` 这里取**默认的 true**
  //   （参考没写），但 LOSE_STRENGTH 不在 `Player::debuff` 那条 skipFirst 名单里
  //   （只有 WEAK / FRAIL / VULNERABLE / DRAW_REDUCTION），所以当前不可观察。
  flex_potion: (bc, _target, bark) => {
    addToBot(bc, (c) => addPower(c.player.powers, "strength", bark ? 10 : 5));
    addToBot(bc, (c) => debuffPlayer(c, "lose_strength", bark ? 10 : 5));
  },
  // 速度药水（:2384-2387）：与灵活药水逐字同形，只把 STRENGTH 换成 DEXTERITY。
  // ⚠ 两条 case 在参考里隔着几十行，常数却都是 10/5——照着邻居抄不会错，但要各写各的。
  speed_potion: (bc, _target, bark) => {
    addToBot(bc, (c) => addPower(c.player.powers, "dexterity", bark ? 10 : 5));
    addToBot(bc, (c) => debuffPlayer(c, "lose_dexterity", bark ? 10 : 5));
  },
  // 铁心药水（:2359-2360）：`BuffPlayer<PS::METALLICIZE>(hasBark ? 12 : 6)`。
  // 回合末加格挡那一半早就有了（金属化那张能力牌），这里只是第二个来源。
  heart_of_iron_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "metallicize", bark ? 12 : 6)),
  // 液态青铜（:2362-2363）：`BuffPlayer<PS::THORNS>(hasBark ? 6 : 3)`。
  // 玩家侧荆棘的反伤早就有了（青铜鳞片），这里只是第二个来源。
  liquid_bronze: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "thorns", bark ? 6 : 3)),
  // 钢铁精华（:2356-2357）：`BuffPlayer<PS::PLATED_ARMOR>(hasBark ? 8 : 4)`。
  // 玩家侧镀甲的两半（挨打 -1、回合末加格挡）早就有了（线与针），这里只是第二个来源。
  essence_of_steel: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "plated_armor", bark ? 8 : 4)),
  // 罐中幽灵（:2392-2393）：`BuffPlayer<PS::INTANGIBLE>(hasBark ? 2 : 1)`。
  // ⚠ 玩家侧的虚无缥缈**没有 skipFirst**（`Player::buff` 里那句 `setJustApplied` 是死代码，
  //   因为回合末走的是裸 `decrementStatus`，参考自注 `// todo this is definitely wrong`）。
  //   所以 1 层只护住紧随其后的那个怪物回合。
  // ⚠ 这瓶是**潜行者**的角色专属药水，铁甲的熵酿池里摇不出来（`CLASS_POTIONS`），
  //   只能靠 variant 的显式清单发。见 TODOS 里那条注记。
  ghost_in_a_jar: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "intangible", bark ? 2 : 1)),
  // 集中药水（:2378-2379）：`BuffPlayer<PS::FOCUS>(hasBark ? 4 : 2)`。
  // ⚠ 参考**战斗内一次都不读** FOCUS（唯一的读者是充能球的偏移，而它没有产出者），
  //   所以它的全部可观察面就是快照里那一条——与数据磁盘那颗遗物同族。
  // ⚠ 这瓶是**机器人**的角色专属药水，同罐中幽灵。
  focus_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "focus", bark ? 4 : 2)),
  // 再生药水（:2421-2422）：`BuffPlayer<PS::REGEN>(hasBark ? 10 : 5)`。
  // ⚠ 玩家侧的再生**每回合末回血再掉一层**，与怪物侧那条（一层都不掉）是两回事，
  //   见 `applyEndOfTurnPowers` 里新加的那一格。
  regen_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "regen", bark ? 10 : 5)),
  // 邪教徒药水（:2313-2314）：`BuffPlayer<PS::RITUAL>(hasBark ? 2 : 1)`。
  // ⚠⚠ **玩家侧的仪式没有 skipFirst**，与怪物侧那条（`wasJustApplied` 跳过施加当回合）
  //   正相反——见 `applyEndOfTurnPowers` 里新加的那一格。
  cultist_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "ritual", bark ? 2 : 1)),
  // 复制药水（:2333-2334）：`BuffPlayer<PS::DUPLICATION>(hasBark ? 2 : 1)`。
  // 效果在四个 `onUseXxxCard` 里（各一句 `queuePurgeCard` + 递减），外加回合末无条件 -1。
  duplication_potion: (bc, _target, bark) =>
    addToBot(bc, (c) => addPower(c.player.powers, "duplication", bark ? 2 : 1)),

  // —— 乙族：一条动作，而那条动作引擎已经有了 ——

  // 熔炉祝福（:2288-2289）：`addToBot(Actions::UpgradeAllCardsInHand())`。
  // ⚠ **不吃神圣树皮**（这条 case 里没有 `hasBark`）——升级这件事没法翻倍。
  // ⚠ 那个动作**不过 `canUpgrade`**，见 `upgradeAllCardsInHand`。
  blessing_of_the_forge: (bc) => addToBot(bc, (c) => upgradeAllCardsInHand(c)),
  // 灵液（:2335-2336）：`addToBot(Actions::ExhaustMany(10))`，与净化共用同一个动作。
  // ⚠ **不吃神圣树皮**，而且 10 是写死的（净化那张牌是 `up ? 5 : 3`）。
  // ⚠ `ExhaustMany` **无条件开屏**，手牌为空也开——照抄（harness 那边会答一个空选择）。
  elixir_potion: (bc) => addToBot(bc, (c) => exhaustManyAction(c, 10)),
  // 蛇形油（:2425-2427）：**两条动作**，抽牌在前、洗费用在后。
  // ⚠ 抽牌吃树皮（10/5），`RandomizeHandCost` 不吃——它没有数量可翻。
  // ⚠ 两条的先后是承重的：先抽进来的牌**也会**被洗费用。
  snecko_oil: (bc, _target, bark) => {
    addToBot(bc, (c) => drawCards(c, bark ? 10 : 5));
    addToBot(bc, (c) => randomizeHandCost(c));
  },
  // 混沌精华（:2323-2329）：按份数排 N 条 `PlayTopCard`。
  // ⚠ 三处照抄：
  //  ①⚠⚠ **目标在入队那一刻就逐条掷定**（`monsters.getRandomMonsterIdx(cardRandomRng)` 是
  //     实参，C++ 先算实参再进 `addToBot`）——与混乱那条逐字同形，★ 每份消耗一次
  //     cardRandomRng，哪怕后来那只怪已经死了。
  //  ② `exhausts = false`——与浩劫只差这一个 bool，打出的牌正常进弃牌堆。
  //  ③ 份数吃树皮（6/3），而**每一份都是一条独立的动作**，不是「一条动作打 N 张」。
  // ⚠⚠ 它与浩劫 / 混乱同族：把抽牌堆顶那张**无条件**打出去，一道门都不过。所以带这瓶药的
  //   variant 的牌组里不许有未登记的牌（harness 侧有一道显式检查兜底）。
  distilled_chaos: (bc, _target, bark) => {
    const cardsToPlay = bark ? 6 : 3;
    for (let i = 0; i < cardsToPlay; i += 1) {
      const target = getRandomMonsterIdx(bc); // ★ 消耗一次 cardRandomRng
      addToBot(bc, (c) => playTopCardInDrawPile(c, target, false));
    }
  },

  // —— 丙族：开选牌屏 ——

  // 液态记忆（:2340-2341）：`addToBot(BetterDiscardPileToHandAction(hasBark ? 2 : 1, …))`。
  // ⚠⚠ **那个 `amount` 参考一个字都没用**：`Actions::BetterDiscardPileToHandAction` 的函数体
  //   （Actions.cpp:670-682）只按弃牌堆张数分三支，从头到尾没有读 `amount`，而参考自己在
  //   函数上方注着 `// todo the amount should be the copies put into the hand 2 if have sacred
  //   bark and liquid memories`。**照抄 as-built：带不带树皮都只拿回一张。** 记进 TODOS。
  liquid_memories: (bc) => addToBot(bc, (c) => betterDiscardPileToHandAction(c)),
};

/**
 * 对齐 `Actions::RandomizeHandCost`（Actions.cpp:423-434，蛇形油）。
 *
 * ⚠ 四处照抄：
 *  ①⚠ 门是 `c.cost >= 0`——负费用（腐化把技能牌压成 -9、`freeToPlay` 那一族）**跳过**，
 *     而且跳过的那张**一次 cardRandomRng 都不掷**（掷在门里面）。这与困惑正相反：
 *     困惑是**每抽一张都掷**、再判要不要写。
 *  ② `cost` 与 `costForTurn` **两个都写**，所以是永久改价，回合末复位也回不去。
 *  ③ 取值是 `cardRandomRng.random(3)` = 0~3（含端），与困惑同一个分布、同一条流。
 *  ④ **无条件赋值**（不像困惑那样先比 `cost != newCost`），但两者同解——写的是同一个值。
 */
function randomizeHandCost(bc: BattleContext): void {
  for (const card of bc.hand) {
    if (card.cost >= 0) {
      const newCost = bc.rng.cardRandomRng.random(3); // ★ 消耗一次 cardRandomRng
      card.cost = newCost;
      card.costForTurn = newCost;
    }
  }
}

/**
 * 对齐 `BattleContext::chooseDiscardToHandCard`（BattleContext.cpp:3017-3024）：弃牌堆 → 手牌。
 *
 * ⚠ 三处照抄：
 *  ① 先**拷一份**再从弃牌堆移除，然后才改费用——顺序无关但形状照抄。
 *  ② `forZeroCost` 那个形参参考**没有读**：它判的是 `cardSelectInfo.cardSelectTask ==
 *     LIQUID_MEMORIES_POTION`（成员，不是形参）。当前只有液态记忆这一条路会进来，
 *     两者同解；照抄成员那一边的语义（进来就压 0 费）。
 *  ③ 压的是 `setCostForTurn(0)`（**本回合**免费），不是改 `cost`——与蛇形油正相反。
 *  ④ 收尾走 `moveToHandHelper`（手牌满了会落进弃牌堆），不是裸 push。
 */
function chooseDiscardToHandCard(bc: BattleContext, discardIdx: number): void {
  const [card] = bc.discardPile.splice(discardIdx, 1);
  if (card === undefined) {
    throw new Error(`chooseDiscardToHandCard: 弃牌堆下标越界 ${String(discardIdx)}`);
  }
  setCostForTurn(card, 0);
  moveToHandHelper(bc, card);
}

/**
 * 对齐 `Actions::BetterDiscardPileToHandAction`（Actions.cpp:670-682，液态记忆）。
 *
 * ⚠ 形状与头槌那条（`headbuttAction`）逐字同形：空弃牌堆直接返回、只有一张就直接选它、
 * 否则开单选屏。⚠ 「只有一张就直接选」这一支**不开屏**，所以 trace 里那一步没有
 * `select_card`——两条路的步数不同，抄错会当场对不上。
 */
function betterDiscardPileToHandAction(bc: BattleContext): void {
  if (bc.discardPile.length === 0) {
    return;
  }
  if (bc.discardPile.length === 1) {
    chooseDiscardToHandCard(bc, 0);
    return;
  }
  openSimpleCardSelectScreen(bc, "liquid_memories_potion", 1);
}

function healPlayer(bc: BattleContext, amount: number): void {
  // 魔力之花（MAGIC_FLOWER，第四十三批）：对齐 `Player::heal` 的第二道门
  // （Player.cpp:161-163）：`if (hasRelic<MAGIC_FLOWER>()) amount = amount * 3 / 2;`
  // ⚠ 三处照抄：
  //  ①⚠ **整数运算**：`amount * 3 / 2` 先乘后除、向下取整（C++ 的 int 除法），
  //     所以 2 点回血变 3、5 点变 7（不是 7.5）。写成 `* 1.5` 再取整在奇数上会分岔。
  //  ② 位置在**绽放印记那道提前返回之后**、在钳制之前——所以它放大的是「打算回多少」，
  //     真正回上多少仍受 `min(maxHp, …)` 限制。
  //  ③ 它对**所有**回血来源生效（鸟面坛 / 血瓶 / 血腥雕像 / 血之药水 / 收割 …），
  //     不区分来源。
  // 绽放印记（MARK_OF_THE_BLOOM，第四十四批）：**函数的第一句**（Player.cpp:156-158）：
  //     if (hasRelic<RelicId::MARK_OF_THE_BLOOM>()) { return; }
  // ⚠ 两处照抄：
  //  ①⚠ **排在魔力之花之前**：两颗一起带时一点血都回不了（不是「回 0×3/2」，是整条不跑）。
  //  ② 它的第二个读点在 `Player::wouldDie` 的第一道门（连仙女瓶与蜥蜴尾一起挡掉）。
  if (hasRelic(bc, "mark_of_the_bloom")) {
    return;
  }
  let healed = amount;
  if (hasRelic(bc, "magic_flower")) {
    healed = Math.trunc((healed * 3) / 2);
  }
  // 红骷髅（RED_SKULL，第四十四批）的**第二个**读点（Player.cpp:165-170）：
  //     bool wasBloodied = curHp <= maxHp/2;
  //     curHp = std::min(maxHp, curHp + amount);
  //     if (wasBloodied && curHp > maxHp/2 && hasRelic<RED_SKULL>()) { debuff<PS::STRENGTH>(3); }
  // ⚠ 四处照抄：
  //  ①⚠⚠ **`wasBloodied` 在回血之前取**，判据是「回血前在半血及以下 **且** 回血后在半血
  //     以上」——两侧都要，只判一侧会让每次回血都还债 / 永远不还债。
  //  ② **还债走 `debuff`** ⇒ 过神器：有神器时这 3 点力量白赚（与诱变强化剂同族）。
  //  ③ `maxHp/2` 是**整数除**，而且两次比较用的是同一个表达式（`<=` 与 `>`），
  //     所以奇数上限时「恰好半血」算 bloodied。
  //  ④ 另外两个读点：`initRelics` 的第二遍（入场血 ≤ 半血就 +3 力量）与
  //     `Player::hpWasLost`（掉到半血及以下再 +3）。三处合起来才是卡面那句
  //     「生命值低于一半时 +3 力量、回到一半以上时失去」。
  const wasBloodied = bc.player.hp <= Math.trunc(bc.player.maxHp / 2);
  bc.player.hp = Math.min(bc.player.maxHp, bc.player.hp + healed);
  if (wasBloodied && bc.player.hp > Math.trunc(bc.player.maxHp / 2) && hasRelic(bc, "red_skull")) {
    debuffPlayer(bc, "strength", 3);
  }
}

/**
 * 战斗内获得金币（对齐 Player::gainGold，Player.cpp:82）。
 *
 * ⚠ 两条遗物分支照参考的位置留 TODO：以太（ECTOPLASM）在**加钱之前**整个提前返回
 * （拿了它这一局再也捡不到金币），血腥雕像（BLOODY_IDOL）在加钱**之后**回 5 点血。
 * 两个都还没登记，所以现在只有加钱这一句。
 *
 * ⚠ 参考在函数顶部有 `assert(amount > 0)`，我们不复制断言：唯一的调用方是贪婪之手，
 * 它传的是 20/25 常量。
 */
function gainGold(bc: BattleContext, amount: number): void {
  // 以太（ECTOPLASM，第四十四批）：**函数的第一句**（Player.cpp:87-89）：
  //     if (hasRelic<R::ECTOPLASM>()) { return; }
  // ⚠ 两处照抄：
  //  ①⚠ 它排在血腥雕像**之前**，所以「以太 + 血腥雕像」时一分钱不给、**也不回血**。
  //  ② 战斗内唯一的调用点是贪婪之手打死一只怪，所以它的可观察面就是 trace 头部的
  //     `goldGained`（以及血腥雕像那 5 点血）。
  if (hasRelic(bc, "ectoplasm")) {
    return;
  }
  bc.player.gold += amount;
  // 血腥雕像（BLOODY_IDOL，第四十三批）：对齐 Player.cpp:92-94，紧跟在 `gold += amount` **之后**：
  //     if (hasRelic<R::BLOODY_IDOL>()) { heal(5); }
  // ⚠ 三处照抄：
  //  ①⚠ **同步** `heal(5)`，且走的是 `Player::heal` —— 会被魔力之花放大成 7。
  //  ② 触发条件是「战斗内**获得**金币」，而战斗内唯一的获得点是贪婪之手打死一只怪
  //     （`Actions::AttackEnemy` 的 `effectTriggered` 分支，Actions.cpp:1123-1131）。
  //     被抢劫者偷钱走的是 `stealGoldFromPlayer`，那条**不经过**这个函数。
  //  ③ 位置在加钱之后：以太那道门在前面，所以「以太 + 血腥雕像」时一分钱不给、也不回血。
  if (hasRelic(bc, "bloody_idol")) {
    healPlayer(bc, 5);
  }
}

/**
 * 怪物偷走玩家金币（对齐 `Monster::stealGoldFromPlayer`，MonsterSpecific.cpp:3333）。
 *
 * ⚠ 偷多少来自本怪的 `thievery` Power（开局 `preBattleAction` 掷定 15 / asc17 20），
 * 不是招式自带的常数——所以数据表那条 `steal_gold` 效果不带数值。
 *
 * ⚠ **按玩家金币的绝对值钳制**：`min(player.gold, amount)`。这一句让「战斗内金币」
 * 从「谁都不读的记账」变成了**真的有语义**——玩家只剩 5 块钱时抢劫者也只能偷 5 块。
 * 因此 trace 重放必须从与参考相同的绝对值起算（harness 那边是 `GameContext` 的初始
 * 99，见 `test/sts-combat-trace.test.ts` 的 `HARNESS_GOLD_BASELINE`），不能像以前那样
 * 从 0 起算——从 0 起算的话这里恒偷到 0，而 trace 里的 `goldGained` 是负数。
 *
 * ⚠ 只有真的偷到（`theftAmount > 0`）才记账，参考另有一句
 * `miscInfo += theftAmount`（战斗后还钱用）与 `setRequiresStolenGoldCheck(true)`，
 * 两者战斗内都没人读，见 `monsterEscape` 的 TODO。
 */
function stealGoldFromPlayer(bc: BattleContext, m: CombatMonster): void {
  const theftAmount = Math.min(bc.player.gold, getPower(m.powers, "thievery"));
  if (theftAmount > 0) {
    bc.player.gold -= theftAmount;
  }
}

/**
 * 玩家主动失血（对齐 Actions::PlayerLoseHp → Player::loseHp，Player.cpp:259）。
 *
 * ⚠ 与受击伤害是两条路：**不过格挡**、不触发荆棘/火焰屏障，直接扣血。归零走同一个
 * wouldDie（瓶中仙灵仍能救回）。
 *
 * ⚠ 虚无缥缈（INTANGIBLE）把失血压成 **1**，且这一句排在**最前面**、参考那边**没有**
 * `amount > 0` 的前置判断——所以 0 点失血在虚无缥缈下会变成 1 点。我们的
 * `amount <= 0` 提前返回是防御性的加法（`Player::loseHp` 没有它，`hpWasLost` 只有一句
 * assert），当前没有任何已登记内容会以 0 调用它，两边观察不到差别。
 *
 * @param selfDamage 这次失血算不算「因你打出的牌而失去生命」——破裂（RUPTURE）只认这一种。
 *   写成**必填**参数是故意的：漏传会静默少一次加力量，而 TS 的默认值不会报错。
 *   各调用点传什么逐个对齐了参考的 `Actions::PlayerLoseHp(n, selfDamage)` 第二参数。
 */
function playerLoseHp(bc: BattleContext, amount: number, selfDamage: boolean): void {
  let loss = amount;
  if (getPower(bc.player.powers, "intangible") > 0) {
    loss = 1;
  }
  // 钨钢棒（TUNGSTEN_ROD，第四十四批）的第三份（Player.cpp:266-271）：
  //     if (amount > 0 && hasRelic<RelicId::TUNGSTEN_ROD>()) {
  //         amount -= 1;
  //         if (amount == 0) { return; }
  //     }
  // ⚠⚠ **只有这一份带那个提前返回**，另外两份靠函数末尾的 `if (damage > 0)` 兜住。
  //   三份的形状不同但当前同解（都是「减完不剩就不掉血」）——照抄，别统一。
  if (loss > 0 && hasRelic(bc, "tungsten_rod")) {
    loss -= 1;
    if (loss === 0) {
      return;
    }
  }
  if (loss <= 0) {
    return;
  }
  playerHpWasLost(bc, loss, selfDamage);
}

/**
 * 失血落地（对齐 Player::hpWasLost，Player.cpp:274）——三条失血路径共用的尾巴。
 *
 * ⚠ 破裂在这里触发，三处照抄：① **只在 selfDamage 为真时**触发；② 加力量是**同步**的
 * （`buff<PS::STRENGTH>`，不入队）；③ 位置在扣血**之后**、濒死判定之前。
 * 怪物攻击走 Player::attacked，它固定传 selfDamage=false，所以永远不触发破裂。
 *
 * ⚠ `cards.onTookDamage()`（血债血偿降费）也挂在这里，位置在遗物之后、濒死判定之前。
 * 它**不看** selfDamage——被怪打一下同样降费，与破裂那条判据不同。
 *
 * ⚠ 「掉血触发」那一族在参考里是四条并列的 `if`（Player.cpp:290-315），顺序由源码定死：
 *   百年拼图 → 情绪芯片（`// todo`，空的）→ **自成型黏土** → **如尼方块** → 红骷髅。
 *   本批装上中间两颗，位置照抄。
 *  ⚠⚠ **它们都在 `hpWasLost` 里**，也就是三条失血路径（`attacked` / `damage` / `loseHp`）
 *     的共同尾巴——所以自伤（放血 / 燃烧 / 暴虐）**照样触发**，与 `selfDamage` 无关。
 *  ⚠ 自成型黏土是**同步** `buff<NEXT_TURN_BLOCK>(3)`（不入队、不过神器，因为走的是 `buff`），
 *     如尼方块是 **`addToTop`** 的 `DrawCards(1)`（插队首，所以排在触发它的那次攻击的
 *     后续段数**之前**——多段攻击每段各抽一张，且抽到的牌立刻能被下一段读到）。
 *
 * TODO(遗物PR): 情绪芯片（参考里两处都是空的 `// todo`，**没有预言机**，见 TODOS 排除表）。
 */
function playerHpWasLost(bc: BattleContext, amount: number, selfDamage: boolean): void {
  // 对齐 `Player::hpWasLost` 的第二句 `bool wasBloodied = curHp <= maxHp/2;`——
  // 它取在扣血**之前**，唯一的读者是红骷髅那一格（见下方）。
  const wasBloodiedBeforeLoss = bc.player.hp <= Math.trunc(bc.player.maxHp / 2);
  bc.player.hp = Math.max(0, bc.player.hp - amount);
  const rupture = getPower(bc.player.powers, "rupture");
  if (selfDamage && rupture > 0) {
    addPower(bc.player.powers, "strength", rupture);
  }
  // 百年拼图（CENTENNIAL_PUZZLE，第四十四批）：排在破裂**之后**、自成型黏土之前
  // （Player.cpp:294-297）：
  //     if (hasRelic<RelicId::CENTENNIAL_PUZZLE>()) {
  //         setHasRelic<RelicId::CENTENNIAL_PUZZLE>(false);
  //         bc.addToTop( Actions::DrawCards(3) );
  //     }
  // ⚠ 三处照抄：
  //  ①⚠⚠ **它是全参考项目里除蜥蜴尾之外唯一一处「战斗中途把自己从玩家身上摘掉」**
  //     （`setHasRelic(false)`）——一场战斗只触发一次，而这件事**只写玩家那份位集合**、
  //     不动容器，所以 `updateRelicsOnExit` 也不管它（下一场照样触发）。
  //     ⚠ 用容器判「有没有这颗遗物」的写法在这里会静默变成「每次掉血都抽 3 张」。
  //  ② **先摘再入队**：摘掉那一句排在 addToTop 之前，所以这一次掉血只抽一轮。
  //  ③ `addToTop` 而不是 addToBot，与如尼方块同族——抽到的牌在同一条伤害链里就能被读到。
  if (hasRelic(bc, "centennial_puzzle")) {
    setHasRelic(bc, "centennial_puzzle", false);
    addToTop(bc, (c) => drawCards(c, 3), true, { kind: "draw_cards", count: 3 });
  }
  if (hasRelic(bc, "self_forming_clay")) {
    addPower(bc.player.powers, "next_turn_block", 3);
  }
  if (hasRelic(bc, "runic_cube")) {
    addToTop(bc, (c) => drawCards(c, 1), true, { kind: "draw_cards", count: 1 });
  }
  // 红骷髅（RED_SKULL，第四十四批）的**第三个**读点（Player.cpp:311-313）：
  //     if (hasRelic<RED_SKULL>() && !wasBloodied && curHp <= maxHp/2) { buff<PS::STRENGTH>(3); }
  // ⚠ 三处照抄：
  //  ①⚠ `wasBloodied` 在**扣血之前**取（函数第二句），与 `Player::heal` 里那半镜像。
  //  ② **加力量走 `buff`**（不过神器），还债走 `debuff`（过神器）——两个方向的函数不同，
  //     与诱变强化剂同族。
  //  ③ 位置在如尼方块**之后**、`cards.onTookDamage()` 之前。
  if (
    hasRelic(bc, "red_skull") &&
    !wasBloodiedBeforeLoss &&
    bc.player.hp <= Math.trunc(bc.player.maxHp / 2)
  ) {
    addPower(bc.player.powers, "strength", 3);
  }
  cardsOnTookDamage(bc);
  if (bc.player.hp <= 0) {
    wouldDie(bc);
  }
}

/** 提升生命上限（对齐 Player::increaseMaxHp：上限 +n 后再回复同样的量）。 */
function increasePlayerMaxHp(bc: BattleContext, amount: number): void {
  bc.player.maxHp += amount;
  healPlayer(bc, amount);
}

/**
 * 非攻击伤害（对齐 Monster::damage，区别于 attacked）：同样先被格挡吸收，
 * 但**不**触发蜷缩 / 反甲等 onAttacked 链。
 *
 * 不含 checkCombat——调用方决定何时调（Actions::DamageEnemy 每次都调，
 * Actions::DamageAllEnemy 整个循环之后只调一次）。
 */
function monsterDamage(bc: BattleContext, idx: number, rawDamage: number): void {
  const m = bc.monsters[idx];
  if (m === undefined || !m.alive) {
    return;
  }
  let damage = Math.max(0, rawDamage);
  // 虚无缥缈（第三十六批）：`Monster::damage` 里那句与 `Monster::attacked` 的**逐字相同**
  //（Monster.cpp:477-481，参考在那行注着 `// this is probably wrong with potions`）。
  // ⚠ 所以**非攻击伤害也被压成 1**——荆棘 / 燃烧 / 主宰 / 火焰药水 / 自杀都算。
  //   这与蜷缩 / 镀甲 / 荆棘那一族「只挂在 attacked 那条 else-if 链上」正相反：
  //   那条链在这条路径上根本不存在，而虚无缥缈两条路各写了一份。
  // ⚠ 位置同样在**扣格挡之前**。
  if (hasPower(m.powers, "intangible") && damage > 0) {
    damage = 1;
  }
  const hadBlock = m.block > 0; // ★ 同 `monsterAttacked`，手钻的门读进入这一击时的格挡
  const tempDamage = damage;
  damage -= m.block;
  m.block = Math.max(0, m.block - tempDamage);
  // 手钻（Monster.cpp:488-490）：与 `Monster::attacked` 里那一份**逐字相同**，
  // 所以非攻击伤害（燃烧 / 荆棘 / 火焰药水 / 爆炸药水 / 自爆）打光格挡也上易伤。
  // ⚠ 它排在下面这道 `damage <= 0 → return` 的门**之前**，照抄。
  handDrillOnBlockBroken(bc, m, hadBlock);
  if (damage <= 0) {
    return;
  }
  // 无敌（INVINCIBLE，腐化之心，第四十七批）：`damageUnblockedHelper` 的**第一句**
  //（Monster.cpp:444-447），函数体与 `attackedUnblockedHelper` 那一格**逐字相同**：
  //     if (hasStatus<MS::INVINCIBLE>()) {
  //         damage = std::min(damage, getStatus<MS::INVINCIBLE>());
  //         setStatus<MS::INVINCIBLE>(getStatus<MS::INVINCIBLE>() - damage);
  //     }
  // ⚠⚠ **形状不同，别合并**：那条路上它是 else-if 链的**第一格**（挡住后面七位），
  //   这条路上它是一个**独立的 if**——沉睡与变换紧跟其后、**不被它遮挡**。
  //   所以「非攻击伤害打在无敌的怪身上」照样会叫醒拉加维林、照样触发变换（当前没有
  //   同时带无敌与那两位的怪，形状照抄）。
  // ⚠ 它排在这里意味着**燃烧 / 荆棘 / 主宰 / 火焰药水 / 自爆也吃这道上限**，
  //   而且它们与攻击共用同一份层数——同一个玩家回合里攻击先削 250、荆棘再来就只剩 50。
  const invincible = findPower(m.powers, "invincible");
  if (invincible !== undefined) {
    damage = Math.min(damage, invincible.amount);
    invincible.amount -= damage;
  }
  // 沉睡被打断（Monster.cpp:448-452）。⚠ 这条路上它是**独立的 if**、不在任何 else-if 链里
  //（那条链只在 attacked 那条路上），所以非攻击伤害叫醒它时不受蜷缩之类的遮挡。
  wakeUpLagavulin(m);
  // 变换（SHIFTING，复形怪，第三十四批）：对齐 Monster.cpp:453-456。
  // ⚠⚠ **同一段代码在两条路径上的形状不同，照抄别合并**：
  //   * `attackedUnblockedHelper` 里它是那条 else-if 链的**最后一格**（前面还有七位）；
  //   * 这里（`damageUnblockedHelper`）它是一个**独立的 if**，只跟在沉睡后面、
  //     两者互不遮挡。⚠ 于是**非攻击伤害**（燃烧 / 主宰 / 荆棘 / 火焰药水）**照样**
  //     触发变换——与蜷缩 / 镀甲 / 荆棘那一族「只挂在 attacked 上」正相反。
  // ⚠ `damage` 同样是扣掉格挡之后的值，调用方有 `if (damage <= 0) return;` 的门。
  if (getPower(m.powers, "shifting") > 0) {
    addPower(m.powers, "strength", -damage);
    addPower(m.powers, "shackled", damage);
  }
  m.hp -= damage;
  if (m.hp <= 0) {
    m.hp = 0;
    monsterDie(bc, m);
  } else {
    // 同上，只是这条路是 `damageUnblockedHelper`（Monster.cpp:403）。两条路都有 onHpLost，
    // 所以非攻击伤害（燃烧 / 主宰 / 剑刃回旋镖 / 火焰药水…）**照样能触发分裂**。
    monsterOnHpLost(bc, m, damage);
  }
}

/** 单体非攻击伤害（对齐 Actions::DamageEnemy = Monster::damage + checkCombat）。 */
function damageEnemyNonAttack(bc: BattleContext, idx: number, rawDamage: number): void {
  const m = bc.monsters[idx];
  if (m === undefined || !m.alive) {
    return;
  }
  monsterDamage(bc, idx, rawDamage);
  checkCombat(bc);
}

export type DrinkPotionResult = { ok: true } | { ok: false; reason: string };

/**
 * 喝下第 idx 槽的药水（对齐 BattleContext::drinkPotion）。
 * 注意顺序：**先清空槽位**再结算效果——熵酿因此能把自己腾出的那一格也填回去。
 */
export function drinkPotion(bc: BattleContext, idx: number, target = 0): DrinkPotionResult {
  if (bc.outcome !== "undecided") {
    return { ok: false, reason: "战斗已结束" };
  }
  // 对齐 isValidPotionAction 的第一道门（Action.cpp:67）：选牌屏没关之前不能喝药水。
  if (bc.inputState === "card_select") {
    return { ok: false, reason: "正在选牌，先完成选择" };
  }
  const potionId = bc.potions[idx];
  if (potionId === null || potionId === undefined) {
    return { ok: false, reason: `药水槽 ${idx} 为空` };
  }
  const rule = POTION_RULES[potionId];
  if (rule === undefined) {
    return { ok: false, reason: `sts-combat 暂未登记药水: ${potionId}` };
  }
  const def = getPotionDef(potionId);
  if (def.targeted) {
    const t = bc.monsters[target];
    if (t === undefined || !t.alive) {
      return { ok: false, reason: `目标无效: ${target}` };
    }
  }

  // 神圣树皮在**清槽之前**读（参考是 `drinkPotion` 的第一句），当前同解——清槽不碰遗物。
  const bark = hasRelic(bc, "sacred_bark");
  discardPotion(bc, idx); // 先清槽，再结算
  rule(bc, target, bark);
  bc.inputState = "executing";
  executeActions(bc);
  return { ok: true };
}

// ============================================================================
// 打牌公开入口
// ============================================================================

export type PlayCardResult = { ok: true } | { ok: false; reason: string };

/**
 * 打出手牌第 handIdx 张，target 为敌人下标（非指向性牌忽略）。
 * 合法性检查通过后入 cardQueue 并驱动执行（对齐游戏「点牌 → 排队 → 执行」）。
 */
export function playCard(bc: BattleContext, handIdx: number, target = 0): PlayCardResult {
  if (bc.outcome !== "undecided") {
    return { ok: false, reason: "战斗已结束" };
  }
  // 对齐 isValidCardAction 的第一道门（Action.cpp:100）：选牌屏没关之前不能打牌。
  if (bc.inputState === "card_select") {
    return { ok: false, reason: "正在选牌，先完成选择" };
  }
  const card = bc.hand[handIdx];
  if (card === undefined) {
    return { ok: false, reason: `手牌下标越界: ${handIdx}` };
  }
  // 对齐 `isValidCardAction` 尾部那句 `c.canUse(bc, target, false)`（Action.cpp:123）：
  // 牌型门、指向性门、能量门全在 cardCanUse 里，与自动打出的牌（浩劫 / 混乱）共用同一份
  // 谓词。⚠ 指向性是**升级相关**属性：致盲+/绊摔+ 改为对所有敌人，不再需要选目标。
  const reason = cardCanUse(bc, card, target, false);
  if (reason !== null) {
    return { ok: false, reason };
  }

  // ⚠ `energyOnUse` 是**当前全部能量**，不是这张牌的费用（对齐 Action.cpp:433
  // `CardQueueItem(hand[idx], target, bc.player.energy)`）。第十批之前这里填的是
  // `card.costForTurn`——与参考不符，但除了 X 费牌没人读它，所以对拍看不出来。
  // X 费牌（旋风斩 / 嬗变）读的正是它，即「打出时手上有多少能量」。
  bc.cardQueue.pushBack({
    card,
    target,
    isEndTurn: false,
    triggerOnUse: true,
    energyOnUse: bc.player.energy,
    ignoreEnergyTotal: false,
    freeToPlay: false,
    autoplay: false,
    exhaustOnUse: false,
    purgeOnUse: false,
    randomTarget: false,
  });
  bc.inputState = "executing";
  executeActions(bc);
  return { ok: true };
}

// ============================================================================
// 选牌屏公开入口（对齐 search::Action::execute 的 SINGLE/MULTI_CARD_SELECT 两支）
// ============================================================================

export type SelectCardResult = { ok: true } | { ok: false; reason: string };

/**
 * 当前选牌屏的合法候选（对齐 search::Action::enumerateCardSelectActions +
 * isValidSingleCardSelectAction / isValidMultiCardSelectAction）。
 *
 * 入参写成结构子集，故 `BattleContext` 与 `StsCombatState`（纯数据快照）都能直接传进来——
 * 策略层只有快照，不该为了枚举候选先 importState 一遍。
 */
export type CardSelectView = {
  cardSelect: CardSelectInfo | null;
  hand: readonly CombatCard[];
  drawPile: readonly CombatCard[];
  discardPile: readonly CombatCard[];
  exhaustPile: readonly CombatCard[];
};

export type CardSelectOptions =
  /** 单选：合法下标（相对 cardSelectSource(task) 指出的那个牌堆）。 */
  | { mode: "single"; task: CardSelectTask; idxs: number[] }
  /** 多选：从手牌里挑 0..maxPick 张，任意组合都合法。 */
  | { mode: "multi"; task: CardSelectTask; maxPick: number; handSize: number };

export function cardSelectOptions(v: CardSelectView): CardSelectOptions | null {
  const info = v.cardSelect;
  if (info === null) {
    return null;
  }
  const single = (idxs: number[]): CardSelectOptions => ({
    mode: "single",
    task: info.task,
    idxs,
  });
  const idxsWhere = (pile: readonly CombatCard[], p: (c: CombatCard) => boolean): number[] =>
    pile.flatMap((c, i) => (p(c) ? [i] : []));
  const isType = (c: CombatCard, t: string): boolean => getCardDef(c.defId).type === t;

  switch (info.task) {
    case "armaments":
      return single(idxsWhere(v.hand, canUpgradeCard));
    // 对齐 `isValidSingleCardSelectAction` 的 DISCOVERY 分支：**写死** `0 <= idx < 3`，
    // 与任何牌堆无关（下标指的是 cardSelect.cards 这三张候选）。
    case "discovery":
      return single([0, 1, 2]);
    // 对齐 `isValidSingleCardSelectAction` 的 DUAL_WIELD 分支：手牌里的攻击牌 / 能力牌。
    case "dual_wield":
      return single(idxsWhere(v.hand, isDualWieldable));
    case "exhaust_one":
    case "warcry":
      return single(idxsWhere(v.hand, () => true));
    // 对齐 `enumerateCardSelectActions` 的 HEADBUTT / LIQUID_MEMORIES_POTION 分支：
    // 两者共用一格、都是「弃牌堆里任意一张」（Action.cpp:519-522）。
    case "headbutt":
    case "liquid_memories_potion":
      return single(idxsWhere(v.discardPile, () => true));
    case "exhume":
      // 排除掘尸自己（对齐 isValidSingleCardSelectAction 的 EXHUME 分支）。
      return single(idxsWhere(v.exhaustPile, (c) => c.defId !== "exhume"));
    case "secret_technique":
      return single(idxsWhere(v.drawPile, (c) => isType(c, "skill")));
    case "secret_weapon":
      return single(idxsWhere(v.drawPile, (c) => isType(c, "attack")));
    case "exhaust_many":
      return { mode: "multi", task: info.task, maxPick: info.pickCount, handSize: v.hand.length };
  }
}

/** 单选（对齐 executeSingleCardSelectActionHelper）。 */
export function selectCard(bc: BattleContext, idx: number): SelectCardResult {
  if (bc.outcome !== "undecided") {
    return { ok: false, reason: "战斗已结束" };
  }
  const info = bc.cardSelect;
  if (bc.inputState !== "card_select" || info === null) {
    return { ok: false, reason: "现在没有选牌屏" };
  }
  const options = cardSelectOptions(bc);
  if (options === null || options.mode !== "single") {
    return { ok: false, reason: `任务「${info.task}」是多选，请用 selectCards` };
  }
  if (!options.idxs.includes(idx)) {
    return { ok: false, reason: `下标 ${idx} 不是「${info.task}」的合法候选` };
  }

  // 关屏放在派发之前，这样 choose* 里新开的第二块屏不会被误关。
  // ⚠ 参考的 `chooseDiscoveryCard` / `chooseDualWieldCard` 会**读** `cardSelectInfo`
  // （候选数组与份数），所以那两个值在关屏之前先从 info 里取出来传进去——先关后派发
  // 只对「不再读 cardSelectInfo」的 task 才与参考等价。（液态记忆 / 法典同样读它，都未登记。）
  const discoveryCards = info.cards;
  const copyCount = info.data0;
  bc.cardSelect = null;
  switch (info.task) {
    case "armaments":
      chooseArmamentsCard(bc, idx);
      break;
    case "discovery": {
      if (discoveryCards === undefined || copyCount === undefined) {
        throw new Error("selectCard: discovery 屏缺少候选牌或份数（cardSelect 被写坏了）");
      }
      chooseDiscoveryCard(bc, discoveryCards[idx], copyCount);
      break;
    }
    case "dual_wield": {
      if (copyCount === undefined) {
        throw new Error("selectCard: dual_wield 屏缺少复制份数（cardSelect 被写坏了）");
      }
      chooseDualWieldCard(bc, idx, copyCount);
      break;
    }
    case "exhaust_one":
      chooseExhaustOneCard(bc, idx);
      break;
    case "exhume":
      chooseExhumeCard(bc, idx);
      break;
    case "headbutt":
      chooseHeadbuttCard(bc, idx);
      break;
    case "liquid_memories_potion":
      chooseDiscardToHandCard(bc, idx);
      break;
    case "secret_technique":
    case "secret_weapon":
      chooseDrawToHandCard(bc, idx);
      break;
    case "warcry":
      chooseWarcryCard(bc, idx);
      break;
    case "exhaust_many":
      // 不可达：上面已按 mode 拦下。
      break;
  }
  // 对齐 search::Action::execute 的收尾：置 EXECUTING_ACTIONS 后继续抽干队列。
  bc.inputState = "executing";
  executeActions(bc);
  return { ok: true };
}

/** 多选（对齐 executeMultiCardSelectActionHelper）。 */
export function selectCards(bc: BattleContext, idxs: readonly number[]): SelectCardResult {
  if (bc.outcome !== "undecided") {
    return { ok: false, reason: "战斗已结束" };
  }
  const info = bc.cardSelect;
  if (bc.inputState !== "card_select" || info === null) {
    return { ok: false, reason: "现在没有选牌屏" };
  }
  const options = cardSelectOptions(bc);
  if (options === null || options.mode !== "multi") {
    return { ok: false, reason: `任务「${info.task}」是单选，请用 selectCard` };
  }
  // 对齐 isValidMultiCardSelectAction 的 EXHAUST_MANY 分支：张数不超上限、下标都在手牌内。
  // ⚠ 参考用 10 位 bitmask 表达选择，因此天然去重、天然升序；这里显式校验重复。
  if (idxs.length > options.maxPick) {
    return { ok: false, reason: `最多只能选 ${options.maxPick} 张` };
  }
  if (new Set(idxs).size !== idxs.length) {
    return { ok: false, reason: "选择里有重复下标" };
  }
  if (idxs.some((i) => i < 0 || i >= options.handSize)) {
    return { ok: false, reason: "选择里有越界下标" };
  }

  bc.cardSelect = null;
  if (info.task === "exhaust_many") {
    chooseExhaustCards(bc, [...idxs]);
  }
  bc.inputState = "executing";
  executeActions(bc);
  return { ok: true };
}

// ============================================================================
// 回合结束 → 怪物回合 → 新回合（对齐 endTurn/callEndOfTurnActions/onTurnEnding/afterMonsterTurns）
// ============================================================================

export type EndTurnResult = { ok: true } | { ok: false; reason: string };

/** 玩家点「结束回合」：入队 endTurn 项并驱动执行。 */
export function endTurn(bc: BattleContext): EndTurnResult {
  if (bc.outcome !== "undecided") {
    return { ok: false, reason: "战斗已结束" };
  }
  // 对齐 isValidAction 的 END_TURN 分支：只在 PLAYER_NORMAL 受理。
  if (bc.inputState === "card_select") {
    return { ok: false, reason: "正在选牌，先完成选择" };
  }
  bc.cardQueue.pushBack(endTurnItem());
  bc.endTurnQueued = true;
  bc.inputState = "executing";
  executeActions(bc);
  return { ok: true };
}

/**
 * **出牌中途强制结束玩家回合**（对齐 `BattleContext::callEndTurnEarlySequence`，
 * BattleContext.cpp:2152-2161）。全参考项目**只有时间扭曲**调它。
 *
 * ```cpp
 * void BattleContext::callEndTurnEarlySequence() {
 *     while (!cardQueue.isEmpty()) {
 *         auto item = cardQueue.popFront();
 *         if (item.autoplay && !item.purgeOnUse) {
 *             addToBot( Actions::TimeEaterPlayCardQueueItem(item) );
 *         }
 *     }
 *     addToTopCard(CardQueueItem::endTurnItem());
 *     endTurnQueued = true;
 * }
 * ```
 *
 * 它与 `endTurn()`（玩家点结束回合）的关系值得单写一段，因为形状差三处：
 *
 *  1. **`endTurn()` 往队尾推、这里往队首推**（`addToBotCard` vs `addToTopCard`）。当前同解
 *     ——上面那个 `while` 刚把队列抽空了——但形状照抄。
 *  2. **`endTurn()` 里那句 `energyWasted += player.energy` 这里没有**（我们还没登记任何
 *     读它的东西，两边都只是记账）。
 *  3. **`endTurn()` 带 `assert(!endTurnQueued)`，这里没有**。走到这里时玩家回合必然还没结束
 *     （出牌只在 `player_normal` 受理），所以两者当前同解。
 *
 * ⚠⚠ **队列里那些牌的去向是这个函数唯一的观察面，而三类去向各不相同**：
 *   * `autoplay && !purgeOnUse`（浩劫 / 混乱从抽牌堆顶翻出来、还没轮到结算的那张）
 *     → 排一条动作，把它按 **`triggerOnUse = false`** 走一遍 `onAfterUseCard`：
 *       **不结算效果**、不推进时间扭曲计数器，只是进弃牌堆（或消耗堆）。
 *       所以「浩劫翻出一张牌，同一瞬间时间扭曲结束了回合」的表现是：那张牌**白翻**了。
 *   * `purgeOnUse`（二连击的复制项）→ **直接丢弃**，连 `onAfterUseCard` 都不走。
 *       原牌早已带着第一次的结算进了弃牌堆，副本就此蒸发（复制的那一击**不会**打出去）。
 *   * 其余（当前只有 `isEndTurn`，走不到）→ 同样直接丢弃。
 *
 * ⚠ `exhaustOnUse` 那一句是参考的一处「读了个奇怪的东西」，照抄：
 *   `item.exhaustOnUse |= bc.curCardQueueItem.card.doesExhaust();`（Actions.cpp:896-904）
 *   ——它读的是**当前正在结算的那张牌**（即触发时间扭曲的那一张），不是队列项自己的牌。
 *   而那条动作紧接着又把 `curCardQueueItem` 覆写成自己这一项，所以**第二条起读到的是
 *   前一条的牌**。这条链在我们这边是在建动作那一刻**静态**算出来的，两者严格等价：
 *   这些动作全部在下一次 `playCardQueueItem` 之前执行完（主循环先抽干动作队列才看出牌队列，
 *   而没有任何动作会直接调 `playCardQueueItem`），所以中间没人能改写 `curCardQueueItem`。
 * ⚠ `Actions::TimeEaterPlayCardQueueItem` 的 `clearOnCombatVictory` 是 **false**
 *   （Actions.cpp:903 那行的第二个参数），与 `OnAfterCardUsed` 一致——打完这张牌就赢了的话
 *   那张牌照样要落进弃牌堆。
 */
function callEndTurnEarlySequence(bc: BattleContext, currentCard: CombatCard): void {
  // 「参考读到的 `curCardQueueItem.card`」在这条链上的取值：第一条是触发时间扭曲的那张牌，
  // 之后每一条都是前一项的牌。见上面那段等价性论证。
  let prevCard = currentCard;
  while (!bc.cardQueue.isEmpty()) {
    const item = bc.cardQueue.popFront();
    if (!item.autoplay || item.purgeOnUse) {
      continue; // 复制项与 endTurn 项直接丢弃（参考的 `if` 没有 else）
    }
    const card = item.card;
    if (card === null) {
      continue; // 只有 endTurn 项没有牌，而它的 autoplay 恒假——防御性分支
    }
    const exhaustOnUse =
      item.exhaustOnUse || exhaustsOf(getCardDef(prevCard.defId), prevCard.upgraded);
    prevCard = card;
    // ⚠ `purgeOnUse` **原样透传**（参考是 `auto item = x;` 整项拷贝，只改 `exhaustOnUse`
    //   与 `triggerOnUse` 两位）。上面那道过滤已经把复制项挡在外面，所以这里恒是 false
    //   ——但形状要照抄，否则「把过滤放宽」那个变异量到的是我们自己的实现细节而不是参考行为
    //   （写死 false 会让复制项进弃牌堆，而参考那条动作对复制项是**严格空操作**：
    //   `onAfterUseCard` 顶部的 `if (item.purgeOnUse) return;` 会把它挡回去）。
    // desc 与普通的 OnAfterCardUsed 完全同形（同一个函数、同一组实参），所以复用
    // `after_use_card` 这一条描述即可，不必新开一种 ActionDesc。
    const purgeOnUse = item.purgeOnUse;
    addToBot(bc, (c) => onAfterUseCard(c, card, exhaustOnUse, purgeOnUse, false), false, {
      kind: "after_use_card",
      card,
      exhaustOnUse,
      purgeOnUse,
      triggerOnUse: false,
    });
  }
  bc.cardQueue.pushFront(endTurnItem());
  bc.endTurnQueued = true;
}

/**
 * 回合末动作（对齐 BattleContext::callEndOfTurnActions，BattleContext.cpp:2032）。
 *
 * 触发点是 cardQueue 里的 endTurn 项——所以它排在 onTurnEnding **之前**：先把
 * 「回合末拿格挡」一类效果入队跑完，再进弃手牌与怪物回合。两者顺序反了的话金属化的
 * 格挡会落到怪物已经打完之后。
 */
function callEndOfTurnActions(bc: BattleContext): void {
  // —— 玩家遗物 OnPlayerEndTurn（对齐 BattleContext.cpp:2064-2090，整组排在下面的 Power 之前）——
  //
  // 参考在这里的书写顺序是：斗篷夹扣 → 冰核 → 尼尔的法典 → 山铜 → 石历。
  // 本批装上第一、第四、第五颗；中间两颗（冰核要充能球、尼尔的法典要 CARD_SELECT 且会从
  // 整个牌池随机造牌）留 TODO，登记时插回各自的位置。
  //
  // 斗篷夹扣（CLOAK_CLASP，BattleContext.cpp:2067-2069）：`addToBot(GainBlock(cards.cardsInHand))`。
  // ⚠ 三处照抄：① 手牌数在**入队时**取（与金属化同族），此后这一回合的弃手牌不影响它；
  //   ② `Actions::GainBlock` 的 `clearOnCombatVictory` 是 false；③ 它是这一组的**第一句**，
  //   所以山铜那道 `block <= 0` 的门读到的是**还没加上这些格挡**的值（夹扣的动作还在队列里）。
  if (hasRelic(bc, "cloak_clasp")) {
    const handSize = bc.hand.length;
    addToBot(bc, (c) => gainBlock(c, handSize), false);
  }
  // TODO(遗物PR): 冰核（FROZEN_CORE，有空充能球槽时充一个冰霜——需要充能球机制）、
  //   尼尔的法典（NILRYS_CODEX，`Actions::CodexAction` 开 CARD_SELECT 并从**整个牌池**
  //   随机生成三张候选；随机牌可能是未登记的牌，trace 会不可重放，故本批不登记）。
  //
  // 山铜（ORICHALCUM，BattleContext.cpp:2081-2085）：
  //     if (player.hasRelic<R::ORICHALCUM>()) {
  //         if (player.block <= 0) {
  //             addToTop(Actions::GainBlock(6));
  //         }
  //     }
  // ⚠ 四处照抄：
  //  ①⚠⚠ 是 **`addToTop`**，这一组里唯一的一个——所以它排在斗篷夹扣那条 `addToBot`
  //     **之前**结算。两条都加格挡，顺序当前观察不到差别，但形状照抄。
  //  ②⚠ 门是 `<= 0` 而不是 `== 0`（格挡不会是负数，同解；照抄）。
  //  ③ 门读的是**这一刻**的格挡，不是「结算完这一组之后」的——斗篷夹扣入队的那份还没执行。
  //  ④ `clearOnCombatVictory` 同样是 false。
  if (hasRelic(bc, "orichalcum") && bc.player.block <= 0) {
    addToTop(bc, (c) => gainBlock(c, 6), false);
  }
  // 石历（STONE_CALENDAR，BattleContext.cpp:2087-2091）：
  //     if (player.hasRelic<R::STONE_CALENDAR>()) {
  //         if (turn == 6) {
  //             addToBot(Actions::DamageAllEnemy(52));
  //         }
  //     }
  // ⚠ 三处照抄：① `turn == 6` 而不是 `>= 6`——**只在第 7 个玩家回合末打一次**
  //   （`turn` 从 0 起、在 `afterMonsterTurns` 开头自增，所以 `turn == 6` 是第 7 个回合，
  //   与卡面「第 7 回合结束时」一致）；② 52 点是**非攻击伤害**（`DamageAllEnemy` 走
  //   `Monster::damage`，不吃力量、不吃易伤，但照样被怪物格挡吸收）；
  //   ③ `clearOnCombatVictory` 取 `Actions::DamageAllEnemy` 的默认 true。
  if (hasRelic(bc, "stone_calendar") && bc.turn === 6) {
    addToBot(bc, (c) => damageAllEnemiesNonAttack(c, 52));
  }

  // —— 玩家 Power AtEndOfTurnPreEndTurnCards ——
  // 金属化：层数在**入队时**取，GainBlock 的 clearOnCombatVictory=false（打完这一回合
  // 就赢了的话格挡照样加上）。
  const metallicize = getPower(bc.player.powers, "metallicize");
  if (metallicize > 0) {
    addToBot(bc, (c) => gainBlock(c, metallicize), false);
  }
  // 镀甲（PLATED_ARMOR，**玩家侧**，第四十三批的线与针）：紧接金属化之后
  // （BattleContext.cpp:2099-2101），写法与金属化逐字同形。
  // ⚠ 与**怪物侧**的镀甲（带壳寄生虫，`applyMonsterEndOfTurnTriggers`）是两套代码：
  //   那边是「回合末加 = 层数的格挡」+「挨未被格挡的攻击就 `decrementStatus` 并可能改意图」，
  //   这边的递减在 `Player::attacked` 里、而且**没有**任何特例分支。共用一个 Power id。
  const platedArmor = getPower(bc.player.powers, "plated_armor");
  if (platedArmor > 0) {
    addToBot(bc, (c) => gainBlock(c, platedArmor), false);
  }
  // TODO(后续PR): 如水般（需姿态）、充能球回合末触发。

  // —— 手中的「回合末自己结算一次」的牌 ——
  // 灼伤 / 腐朽 / 怀疑 / 羞耻 / 悔恨在手上时，回合末按 `triggerOnUse = false` 入**出牌队列**
  // （不是动作队列），由 playCardQueueItem 走 useNoTriggerCard 那条分支。
  // ⚠ 三处照抄：① 扫描按手牌下标升序、逐张 addToBotCard；② 入的是 cardQueue，所以它们排在
  // onTurnEnding **之前**结算（executeActions 先抽干 cardQueue 再看 endTurnQueued）；
  // ③ `regretCardCount` 在此刻取手牌数（只有悔恨用，尚未登记）。
  // TODO(后续PR): 腐朽 / 怀疑 / 羞耻 / 悔恨——四张诅咒牌都还没有入手途径。
  for (const card of bc.hand) {
    if (card.defId === "burn") {
      bc.cardQueue.pushBack(noTriggerItem(card));
    }
  }
  // TODO(后续PR): 姿态 onEndOfTurn。
}

/**
 * 玩家 Power 的回合末结算（对齐 Player::applyEndOfTurnPowers，Player.cpp:349），
 * 由 onTurnEnding 同步调用。
 *
 * ⚠ 参考遍历的是 `std::map<PlayerStatus, int16_t> statusMap`，即按
 * `PlayerStatusEffects.h` 的**枚举值升序**，与「先获得哪个 Power」无关。我们的 powers
 * 是获得顺序的数组，所以这里按枚举顺序**逐项显式判断**，不能改成遍历数组。
 * 命中项的枚举序：CONSTRICTED(9) → ENTANGLED(10) → LOSE_STRENGTH(14) → NO_DRAW(16) →
 * DOUBLE_TAP(30) → COMBUST(41) → RAGE(71)。
 */
function applyEndOfTurnPowers(bc: BattleContext): void {
  // 炸弹（对齐 Player.cpp:350-355）：排在遍历 statusMap 的循环**之前**，与枚举序无关
  // ——它压根不在 statusMap 里（见 CombatPlayer.bomb1 的注释）。
  //
  // ⚠ 四处照抄：
  //  ① 先引爆 `bomb1`（**入队** DamageAllEnemy），**再**整体前移一格。所以「打出炸弹的那个
  //     回合末」它落在 bomb3，要经过三个回合末才轮到 bomb1 被引爆。
  //  ② 前移是**无条件**的三行赋值，不管有没有引爆过——`bomb3 = 0` 让同一回合打的几张
  //     炸弹合成一格。
  //  ③ 引爆判据是 `if (bomb1)`（非零即引爆），**不看**怪是否已全死——与紧随其后的燃烧
  //     （有 `areMonstersBasicallyDead` 门）不同。
  //  ④ 伤害是 `Actions::DamageAllEnemy`（非攻击、全体、不过 calculateCardDamage），
  //     clearOnCombatVictory 用默认的 true。
  const bomb1 = bc.player.bomb1;
  if (bomb1 !== 0) {
    addToBot(bc, (c) => damageAllEnemiesNonAttack(c, bomb1));
  }
  bc.player.bomb1 = bc.player.bomb2;
  bc.player.bomb2 = bc.player.bomb3;
  bc.player.bomb3 = 0;

  // 束缚（CONSTRICTED=9，第三十三批的尖塔增生）：**这个循环里第一个命中的**
  // （枚举序排在 ENTANGLED=10 之前）。对齐 Player.cpp:374-376：
  //     case PS::CONSTRICTED:
  //         bc.addToBot(Actions::DamagePlayer(pair.second));
  //         break;
  // ⚠ 四处照抄：
  //  ① 那条 case **只有伤害一句**——既不递减也不摘除，所以束缚跟到战斗结束
  //     （与紧随其后的缠绕「整条清除」正相反）；
  //  ② 伤害走 `Actions::DamagePlayer` = **非攻击伤害**（不吃怪物力量、不吃玩家易伤），
  //     但**照样被格挡吸收**；
  //  ③ `selfDamage` 取默认的 **false**，所以不触发破裂（与灼伤的 `true` 相反）；
  //  ④ `clearOnCombatVictory` 是 **false**（Actions.cpp:91-95 第二个参数）。
  const constricted = getPower(bc.player.powers, "constricted");
  if (constricted > 0) {
    addToBot(bc, (c) => damagePlayerNonAttack(c, constricted, false), false);
  }

  // 缠绕（ENTANGLED=10，枚举序排在 LOSE_STRENGTH=14 之前）：本回合结束即**整条清除**。
  // ⚠ 是 `addToBot(RemoveStatus<ENTANGLED>)` 而不是递减（Player.cpp:382），所以红色奴隶主
  // 连着放两次缠绕也只是「下一个玩家回合打不出攻击牌」，不会累积成两回合。
  if (getPower(bc.player.powers, "entangled") > 0) {
    addToBot(bc, (c) => removePower(c.player.powers, "entangled"));
  }

  // 敏捷流失（LOSE_DEXTERITY=13，第四十三批的二元性）：枚举序排在 LOSE_STRENGTH=14
  // **之前**。对齐 Player.cpp:394-397，与紧随其后的力量那一格逐字同形（只差状态名）：
  //     case PS::LOSE_DEXTERITY:
  //         bc.addToBot(Actions::DebuffPlayer<PS::DEXTERITY>(-pair.second));
  //         bc.addToBot(Actions::RemoveStatus<PS::LOSE_DEXTERITY>());
  //         break;
  // ⚠ 与灵活那条同理：扣敏捷走 `DebuffPlayer` 而不是 `BuffPlayer(-n)`，所以**会被神器吃掉**
  //   一层——神器在手时这点敏捷就白送了。
  const loseDexterity = getPower(bc.player.powers, "lose_dexterity");
  if (loseDexterity > 0) {
    addToBot(bc, (c) => debuffPlayer(c, "dexterity", -loseDexterity));
    addToBot(bc, (c) => removePower(c.player.powers, "lose_dexterity"));
  }

  // 灵活的还债：先扣力量，再摘掉标记。两条都走 addToBot。
  // ⚠ 扣力量走的是 DebuffPlayer 而不是 BuffPlayer(-n)，所以会被神器吃掉一层——
  // 神器在手时这 2 点力量就白送了（参考如此，真实游戏也如此）。
  const loseStrength = getPower(bc.player.powers, "lose_strength");
  if (loseStrength > 0) {
    addToBot(bc, (c) => debuffPlayer(c, "strength", -loseStrength));
    addToBot(bc, (c) => removePower(c.player.powers, "lose_strength"));
  }

  // 战斗恍惚的「本回合无法再抽牌」到此为止。
  if (getPower(bc.player.powers, "no_draw") > 0) {
    addToBot(bc, (c) => removePower(c.player.powers, "no_draw"));
  }

  // 二连击（DOUBLE_TAP=30）：没用掉的层数在回合末整个清掉。
  // ⚠ 走 `addToBot(RemoveStatus)`（**入队**，与同函数里暴怒那条的同步 removeStatus 不同），
  // 且是 RemoveStatus 而非递减——剩几层都一次清空。
  if (getPower(bc.player.powers, "double_tap") > 0) {
    addToBot(bc, (c) => removePower(c.player.powers, "double_tap"));
  }

  // 燃烧：先失血再对全体造成伤害，两者都入队。
  // ⚠ 三处照抄：① 「怪是不是已经全死了」在**入队时**判（areMonstersBasicallyDead 即
  // monstersAlive <= 0），死绝了这一回合连血都不掉；② 失血量取 combustHpLoss（打过几张
  // 燃烧），伤害取层数，两个数不一样；③ PlayerLoseHp 的 clearOnCombatVictory=false，
  // DamageAllEnemy 是默认的 true；④ 失血传 selfDamage=**true**，所以燃烧的自伤会触发破裂。
  const combust = getPower(bc.player.powers, "combust");
  if (combust > 0 && bc.monstersAlive > 0) {
    const hpLoss = bc.player.combustHpLoss;
    addToBot(bc, (c) => playerLoseHp(c, hpLoss, true), false);
    addToBot(bc, (c) => damageAllEnemiesNonAttack(c, combust));
  }

  // 暴怒（RAGE=71，枚举序排在 COMBUST=41 之后）：本回合结束即整层清除。
  // ⚠ **同步** removeStatus（不入队），与上面几条 addToBot 不同——参考在遍历 statusMap 的
  // 循环体里直接调 `removeStatus<PS::RAGE>()`。当前没有任何东西会在这之后、这一回合内
  // 再读暴怒，所以同步与入队观察不到差别；照抄。
  if (getPower(bc.player.powers, "rage") > 0) {
    removePower(bc.player.powers, "rage");
  }

  // 再生（REGEN=72，第四十五批的再生药水）：枚举序紧跟 RAGE=71 之后。
  // 对齐 Player.cpp:420-423：
  //     case PS::REGEN:
  //         bc.addToTop(Actions::HealPlayer(pair.second));
  //         bc.addToTop(Actions::DecrementStatus<PS::REGEN>());
  //         break;
  // ⚠ 四处照抄：
  //  ①⚠⚠ **两条都是 `addToTop`，而且递减那条排在后面**——于是出队时**递减先跑、回血后跑**，
  //     回的却是**递减之前**取好的那个数（`pair.second` 是循环里的当前层数）。
  //     写成两条 addToBot 会让它们跑在同一函数里排在后面的动作（燃烧的伤害等）之后；
  //     写成「先递减再按新层数回血」会每回合少回 1 点。
  //  ②⚠ 与**怪物侧**的再生完全不是一回事：`Monster::applyEndOfTurnTriggers` 那条只有
  //     `heal`、**一层都不掉**（觉醒者整场恒 10）。两边共用同一个 PowerId。
  //  ③ 递减走 `DecrementStatus`（归零即摘条目），所以 5 层 = 回 5 次、层数 5→4→3→2→1。
  //  ④ 回血走 `Actions::HealPlayer` → `Player::heal`，因此过绽放印记 / 魔力之花 / 红骷髅。
  const regen = getPower(bc.player.powers, "regen");
  if (regen > 0) {
    addToTop(bc, (c) => healPlayer(c, regen));
    addToTop(bc, (c) => decrementPlayerPower(c, "regen"));
  }

  // 仪式（RITUAL=73，第四十五批的邪教徒药水）：枚举序紧跟 REGEN=72 之后，
  // 也是这个循环里最后一格命中的。对齐 Player.cpp:427-429：
  //     case PS::RITUAL:
  //         bc.addToBot(Actions::BuffPlayer<PS::STRENGTH>(pair.second));
  //         break;
  // ⚠ 三处照抄：
  //  ①⚠⚠ **玩家侧没有 skipFirst**，与怪物侧那条正相反（`Monster::applyEndOfRoundPowers`
  //     的第一句带 `wasJustApplied`，施加当回合不结算）。所以喝下邪教徒药水的**那个回合末**
  //     就已经 +1 力量了。两边共用同一个 PowerId，但结算代码是两套。
  //  ② 加力量走 `BuffPlayer`（不过神器），层数自己一点不掉。
  //  ③ 位置在再生之后。当前没有任何东西能同时带两者以外的顺序依赖；照抄。
  const ritual = getPower(bc.player.powers, "ritual");
  if (ritual > 0) {
    addToBot(bc, (c) => addPower(c.player.powers, "strength", ritual));
  }

  // TODO(后续PR): 爆发 / 束缚 / 双重施法 / 缠绕 / 平衡 / 建立 / 欧米茄 / 反弹 / 怨灵形态。
}

/**
 * 玩家 Power 的回合开始（抽牌**之前**）结算（对齐 Player::applyStartOfTurnPowers，
 * Player.cpp:565），由 afterMonsterTurns 同步调用。
 *
 * ⚠ 同 applyEndOfTurnPowers：参考遍历 `statusMap`，即按枚举值升序，与获得顺序无关。
 * 命中项的枚举序：FLAME_BARRIER(54) → MAYHEM(63)。
 *
 * ⚠ 火焰屏障是在**下一个回合开始**才清除，不是本回合末——所以整个怪物回合里它都还在，
 * 那才是它反伤的时机。位置也要对：排在「清玩家格挡」之前、开局抽牌之前。
 *
 * ⚠ 混乱在这里，即**抽牌之前**（Player.cpp:625 在 applyStartOfTurnPowers 里，不是
 * applyStartOfTurnPostDrawPowers）。所以它打的是「上回合末洗牌之后的抽牌堆顶」，
 * 而且那张牌不会先被抽进手里。
 *
 * TODO(后续PR): 战斗圣歌 / 无限之刃（造牌）、下回合格挡 NEXT_TURN_BLOCK、
 *   回响形态计数复位、风采计数复位、渎神、预知。
 */
function applyStartOfTurnPowers(bc: BattleContext): void {
  if (getPower(bc.player.powers, "flame_barrier") > 0) {
    removePower(bc.player.powers, "flame_barrier");
  }
  // 混乱：每一层各排一条 PlayTopCard。
  // ⚠ 三处照抄：① 目标在**这里**就逐条掷定（★ 每层一次 cardRandomRng），不是等动作执行时；
  // ② `exhausts = false`——与浩劫只差这一个 bool，打出的牌正常进弃牌堆；
  // ③ 是 `addToBot`，所以两层混乱排出的两条动作按顺序执行，第二条把牌插到出牌队列**队首**，
  //    于是**后排的那张先打**（见 playTopCardInDrawPile 的 addToTopCard）。
  const mayhem = getPower(bc.player.powers, "mayhem");
  for (let i = 0; i < mayhem; i += 1) {
    const target = getRandomMonsterIdx(bc); // ★ 消耗一次 cardRandomRng
    addToBot(bc, (c) => playTopCardInDrawPile(c, target, false));
  }
  // 下回合格挡（NEXT_TURN_BLOCK=65，第四十三批的自成型黏土）：枚举序排在
  // METALLICIZE=64 之后、MAYHEM=63 之后。对齐 Player.cpp:631-634：
  //     case PS::NEXT_TURN_BLOCK:
  //         bc.addToBot( Actions::GainBlock(pair.second) );
  //         removeStatus<PS::NEXT_TURN_BLOCK>();
  //         break;
  // ⚠ 四处照抄：
  //  ①⚠ **加格挡入队、摘 Power 同步**——两句的形态不同。同步摘掉意味着这一帧之后快照里
  //     就没有它了，而格挡要等动作出队才加上。
  //  ② 它在 `applyStartOfTurnPowers` 里，也就是**清玩家格挡之后、开局抽牌之前**
  //     （BattleContext.cpp:2198 那一串的中段）——所以这份格挡不会被本回合的清格挡吃掉。
  //  ③ 是 `RemoveStatus`（整条摘掉）而不是递减：攒了几层一次性全给。
  //  ④ `Actions::GainBlock` 的 `clearOnCombatVictory` 是 false。
  const nextTurnBlock = getPower(bc.player.powers, "next_turn_block");
  if (nextTurnBlock > 0) {
    addToBot(bc, (c) => gainBlock(c, nextTurnBlock), false);
    removePower(bc.player.powers, "next_turn_block");
  }
}

/**
 * 这张牌是不是以太（对齐 CardInstance::isEthereal → isCardEthereal(id, upgraded)）。
 *
 * 参考那份名单是「完整枚举 + `default: false`」，可以全表信任：杀戮 / 幽灵护甲 / 眩晕 /
 * 笨拙 / 虚无 / 升华诅咒恒为真，幻影 / 回响成型 / 提婆形态是 `!upgraded`（升级后不再以太）。
 * 后一组由数据表的 `upgradedEthereal` 表达（第七批新增），取值器是 `etherealOf`——
 * 幻影登记之后就走到这一支了，不能再无条件读 `ethereal`。
 */
function isEtherealCard(card: CombatCard): boolean {
  return etherealOf(getCardDef(card.defId), card.upgraded);
}

/**
 * 回合末处理手牌（对齐 BattleContext::discardAtEndOfTurn，BattleContext.cpp:2465）。
 *
 * ⚠ 它自己**一张牌都不搬**，只往队首插两组动作：
 *   ① `addToTop(DiscardAtEndOfTurnHelper)` —— 真正的弃手牌；
 *   ② 再按手牌下标**升序** `addToTop(ExhaustSpecificCardInHand(i, uid))` 逐张消耗以太牌。
 * 因为都是 addToTop 且②在①之后推入，实际执行顺序是「以太牌按下标**降序**消耗 → 弃其余」。
 * 降序消耗使下标始终有效；反过来写（正序消耗、或把 helper 放到以太之后推）都会错位。
 *
 * ⚠ 以太牌走的是 exhaustSpecificCardInHand，因此会触发消耗链（黑暗拥抱 / 无痛之心）——
 * 而它们的 addToBot 落在整条回合末序列的**末尾**（UnnamedEndOfTurnAction 之后），
 * 这个位置是队列语义自然得出的，不是特例。
 *
 * ⚠ 如尼金字塔（RUNIC_PYRAMID，第四十三批）就是①那道门（BattleContext.cpp:2519-2521）：
 *     if (!player.hasRelic<R::RUNIC_PYRAMID>() && !player.hasStatus<PS::EQUILIBRIUM>()) {
 *         addToTop(Actions::DiscardAtEndOfTurnHelper());
 *     }
 * ⚠ 三处照抄：① 它只挡**弃手牌**那一条，以太牌的消耗（②那一组）**照旧**——带着金字塔
 *   照样会被眩晕/幽灵护甲消耗掉；② 门是「遗物 **或** 平衡」的合取取反，平衡尚无产出者，
 *   照抄进来是空操作；③ 手牌留下之后不清空，直接进入下一个玩家回合的抽牌
 *   （所以手牌上限 10 张那道门会开始起作用）。
 *
 * TODO(后续PR): 自带保留牌 / 平衡——参考在①之前还有一段 limbo 搬运。
 */
function discardAtEndOfTurn(bc: BattleContext): void {
  if (!hasRelic(bc, "runic_pyramid")) {
    addToTop(bc, (c) => discardAtEndOfTurnHelper(c));
  }
  for (let i = 0; i < bc.hand.length; i += 1) {
    const card = bc.hand[i];
    if (isEtherealCard(card)) {
      const idx = i;
      const uid = card.uid;
      addToTop(bc, (c) => exhaustSpecificCardInHand(c, idx, uid));
    }
  }
}

/**
 * 真正的弃手牌（对齐 BattleContext::discardAtEndOfTurnHelper，BattleContext.cpp:2501）。
 *
 * ⚠ 两处照抄：① 结局已定就整个跳过（以太牌的消耗若打死了最后一只怪，手牌就留在手上）；
 * ② **顺序要命**——`for (i = cardsInHand-1; i >= 0; --i)`，从手牌末尾往前弃。
 * 弃牌堆的排列会成为下次 reshuffle 的洗牌输入，正序会洗出另一副牌序。
 */
function discardAtEndOfTurnHelper(bc: BattleContext): void {
  if (bc.outcome !== "undecided") {
    return;
  }
  for (let i = bc.hand.length - 1; i >= 0; i -= 1) {
    bc.discardPile.push(bc.hand[i]);
  }
  bc.hand = [];
}

/**
 * 回合结束序列（对齐 BattleContext::onTurnEnding，BattleContext.cpp:2107）。
 *
 * ⚠ 除 applyEndOfTurnPowers 是同步调用外，其余三步全部 **addToBot**，顺序是
 * 「Power 结算 → 清出牌队列 → 弃手牌 → 进怪物回合」。弃手牌必须走队列：燃烧的
 * DamageAllEnemy 若打死了最后一只怪，clearPostCombatActions 会把后面这几条（都是
 * 默认的 clearOnCombatVictory=true）一并清掉，于是手牌**留在手上**、回合也不推进。
 * 写成同步弃牌就看不到这个表现了。
 */
function onTurnEnding(bc: BattleContext): void {
  bc.endTurnQueued = false; // 参考在 executeActions 的该分支里、调本函数之前就置了假
  applyEndOfTurnPowers(bc);
  addToBot(bc, (c) => {
    c.cardQueue.clear();
  });
  addToBot(bc, (c) => discardAtEndOfTurn(c));
  // 卡实例级状态复位：costForTurn 拉回 cost（对齐 CardManager::resetAttributesAtEndOfTurn）。
  // ⚠ **同步**调用，位置照抄参考——夹在 DiscardAtEndOfTurn 与 UnnamedEndOfTurnAction 两条
  // addToBot 之间。它是同步的，所以实际上跑在这三条动作全部之前，手牌那时还没弃掉。
  cardsResetAttributesAtEndOfTurn(bc);
  // UnnamedEndOfTurnAction：置 turnHasEnded，再入队怪物阶段开始，最后把游标归零。
  addToBot(bc, (c) => {
    c.turnHasEnded = true;
    addToBot(c, (c2) => applyPreTurnLogic(c2));
    c.monsterTurnIdx = 0; // 从第一个怪开始行动
  });
}

/**
 * 怪物阶段开始（对齐 Actions::MonsterStartTurnAction → MonsterGroup::applyPreTurnLogic
 * → `Monster::applyStartOfTurnPowers`，Monster.cpp:18-38）：逐怪清空格挡，**壁垒除外**。
 *
 * 注意时点——玩家回合内怪物格挡仍在，故开局自带格挡的编队（如颚虫军团）第一回合会挡下
 * 玩家攻击。
 *
 * ⚠ **壁垒（第二十三批）**：参考写的是
 * `if (!hasStatus<MS::BARRICADE>()) { block = 0; }`——不是「先清再补」，而是整句跳过。
 * 球状守卫者只有 20 血、开局 40 点格挡，格挡才是它真正的血条：这一位漏了它几回合就死。
 * ⚠ 它是**纯 bool**（`isBooleanPower` 为真），所以只判有无、不看层数。
 *
 * ⚠⚠ **壁垒那一支必须写成 `if`，不能写成 `continue`**（第二十四批修）：参考的
 * `applyStartOfTurnPowers` 是**并列的五段**（清格挡 / 窒息 / 飞行 / 无敌 / 中毒），
 * 壁垒只挡第一段。写成 `continue` 会连带跳过后面几段——在只有壁垒、没有飞行的第二十三批
 * 下两者等价，本批加了飞行之后就不再等价了（一只同时带壁垒与飞行的怪会不复位飞行）。
 * 当前没有这种怪，所以这是**预防性**的形状对齐，不是修 bug。
 */
function applyPreTurnLogic(bc: BattleContext): void {
  for (const m of bc.monsters) {
    if (!m.alive) {
      continue;
    }
    // ① 清空格挡，壁垒除外（`if (!hasStatus<MS::BARRICADE>()) block = 0;`）。
    if (getPower(m.powers, "barricade") === 0) {
      m.block = 0;
    }
    // ③ 飞行复位（第二十四批，Monster.cpp:28-30）：
    //      `if (hasStatus<MS::FLIGHT>()) setStatus<MS::FLIGHT>(bc.ascension >= 17 ? 4 : 3);`
    // ⚠ 三处照抄：
    //  ① 入口判的是 `hasStatus`（statusBits），**不是层数 > 0**——摔下来（层数 0）的拜鸟
    //     照样在自己回合开始复位，这正是它「重新起飞」的机制；写成 `> 0` 它就再也飞不起来。
    //  ② 是 **setStatus（覆盖）**，不是 `buff`（累加）——与 `BYRD_FLY` 那条 case 相反。
    //  ③ 时点是**怪物阶段开始**（整个 `applyPreTurnLogic` 循环），所以「玩家回合里把飞行
    //     打光」与「怪物回合开始又满了」之间只隔一个玩家回合末。
    // ✅ asc17 那一档第三十批有背书了（这一处改成恒 3 红 **225 例**；`PRE_BATTLE_ACTION`
    //   那一处是 240 例，两处必须分别量——它们是同一个数的两个独立字面量）。
    const flight = findPower(m.powers, "flight");
    if (flight !== undefined) {
      flight.amount = bc.ascension >= 17 ? 4 : 3;
    }
    // ④ 无敌复位（第四十七批，Monster.cpp:32-34）：
    //      `if (hasStatus<MS::INVINCIBLE>()) setStatus<MS::INVINCIBLE>(bc.ascension >= 19 ? 200 : 300);`
    // ⚠ 四处照抄：
    //  ①⚠⚠ **这一句就是「无敌」这个机制的本体**：链上那两处只负责削平并扣层数，
    //     真正让它变成「每个怪物回合最多掉 300 血」的是这次复位。整条去掉的话，
    //     腐化之心一场仗总共只能掉 300 血。
    //  ② 入口判的是 `hasStatus`（条目在不在），**不是层数 > 0**——被打到 0 的那一回合
    //     照样复位（与飞行那一条同族、与「层数 > 0」正相反）。
    //  ③ 是 **`setStatus`（覆盖）**，不是 `buff`（累加）。
    //  ④ 时点是**怪物阶段开始**（整个 `applyPreTurnLogic` 循环），排在清格挡与飞行复位
    //     **之后**——三段是并列的（不是 else-if），壁垒只挡第一段。
    // ⚠⚠ asc19 那一档是**变小**（300 → 200），照抄别顺手写成变大。本批只做 asc0。
    const invincible = findPower(m.powers, "invincible");
    if (invincible !== undefined) {
      invincible.amount = bc.ascension >= 19 ? 200 : 300;
    }
  }
  // TODO(后续PR): 窒息（②）、中毒扣血（⑤）。
}

function doMonsterTurn(bc: BattleContext, idx: number): void {
  const m = bc.monsters[idx];
  // ⚠⚠ 参考这道门是 `(!m.isDeadOrEscaped() || m.isHalfDead())`（MonsterGroup.cpp:572），
  //   **不是** `!isDeadOrEscaped()`——半死的怪（暗影客的重生态、觉醒者的假死）
  //   照样轮到自己的回合，这正是它们能在下一个怪物回合滚出「复活」的唯一路径。
  //   我们的 `alive` 建模的是 `!isDeadOrEscaped()`，所以这里要显式把 `halfDead` 放行。
  // ⚠ 反过来，另外两个循环（`applyPreTurnLogic` / `applyEndOfRoundPowers`）的门是
  //   `isDying() || isEscaping()`——那里**不**放行半死的怪（它血量为 0，`isDying` 已为真），
  //   所以那两处写 `!alive` 与参考同解，见 `CombatMonster.halfDead` 的注释。
  // ⚠ 门的第二半（第三十六批）：`&& !skipTurn[bc.monsterTurnIdx]`——蜥蜴法师召唤出来的
  //   匕首若落在游标右边的格子里，本回合**不行动**。它是这一整轮唯一的读点，
  //   清点在 `executeActions` 的「怪物回合走完」那一句，见 `BattleContext.skipTurn`。
  // ⚠ 参考在门内还有一句 `if (skipTurn[idx]) { skipTurn.set(idx, false); } else { takeTurn(); }`
  //   （MonsterGroup.cpp:576-578）——那个 if **恒假**（外层的 `&& !skipTurn[…]` 已经把它
  //   排除干净了），是一段死代码。它与 as-built 严格同解：那一位无论清不清，
  //   本轮都不会再被读第二次，而回合末的 `reset()` 一律清空。故**照抄 as-built，不报补丁**。
  if (m === undefined || (!m.alive && !m.halfDead) || bc.skipTurn.has(idx)) {
    return;
  }
  const move = takeTurn(bc, m);
  // 玩家阵亡后参考会在处理后续排队动作前跳出主循环，故这一步的 RollMove 不会执行——
  // 不短路的话 aiRng 会多消耗一次，counter 就对不上了。
  if (bc.outcome !== "undecided") {
    return;
  }
  // 收尾五形态见 MOVE_TURN_END。默认（也是绝大多数怪）是：
  // ★ 滚下一意图必须**入队**（对齐 takeTurn 末尾的 addToBot(Actions::RollMove)）。
  // 同步调用会抢在荆棘之前：荆棘伤害走 addToTop 会插到 RollMove 前面，若它打死了
  // 最后一只怪，这次 RollMove 就该被 clearPostCombatActions 清掉、不消耗 aiRng。
  const turnEnd: MoveTurnEnd =
    (move === null ? undefined : MOVE_TURN_END[`${m.defId}/${move}`]) ?? "roll";
  if (turnEnd === "roll") {
    addToBot(bc, (c) => rollMove(c, m));
  } else if (turnEnd === "no_op_roll") {
    // 对齐 `Actions::NoOpRollMove` → `BattleContext::noOpRollMove`（BattleContext.cpp:2814）：
    // 同样是**入队**，执行时掷一次 aiRng.random(99) 就丢掉，意图与 moveHistory 都不动。
    addToBot(bc, (c) => {
      c.rng.aiRng.random(99); // ★ 消耗一次 aiRng
    });
  } else if (turnEnd === "none") {
    // case 尾部什么都没有（分裂 / 抢劫者逃跑）：收尾由效果自己负责或压根没有。
  } else if (typeof turnEnd === "function") {
    // 任意收尾语句（抢劫者的抢劫）：与同步 setMove 一样跑在本次排的动作**执行之前**，
    // 掷不掷 aiRng 由函数自己决定。
    turnEnd(bc, m);
  } else {
    // 同步 setMove：**不消耗任何 aiRng**。参考写在 takeTurn 的 case 尾部（那里是纯同步语句），
    // 所以它在本次出招排的那些动作**执行之前**就生效了——快照里的 move 当场就变。
    setMove(m, turnEnd.setMove);
  }
}

/**
 * 执行怪物当前意图效果（对齐 `Monster::takeTurn` 各 case 的**效果部分**）。
 *
 * 返回实际执行的招式 id（找不到招式返回 null），调用方据此查 `MOVE_TURN_END` 决定收尾——
 * 收尾必须用**执行的那一招**而不是 `m.currentMove`，因为同步 setMove 会当场改掉后者。
 */
/**
 * 取效果的实际数值：有 `ascAmount` 就按爬升度分档，没有就用基础值（见 types.ts 的 `AscTier`）。
 *
 * ⚠ 取的是**满足 `ascension >= atLeast` 中 `atLeast` 最大**的那一条，不是数组第一条命中的
 *   ——顺序无关，写反了也不会错。参考的 `{a,b,c}[getTriIdx(asc, x, y)]` 语义正是这个。
 */
function ascValue(bc: BattleContext, base: number, tiers: AscTier[] | undefined): number {
  if (tiers === undefined) {
    return base;
  }
  let value = base;
  let matched = -1;
  for (const tier of tiers) {
    if (bc.ascension >= tier.atLeast && tier.atLeast > matched) {
      value = tier.amount;
      matched = tier.atLeast;
    }
  }
  return value;
}

function takeTurn(bc: BattleContext, m: CombatMonster): string | null {
  const def = getEnemyDef(m.defId);
  const move = def.moves.find((mv) => mv.id === m.currentMove);
  if (move === undefined) {
    return null;
  }
  // 开场语句（当前只有抢劫者首回合那次白掷的 aiRng），见 MOVE_TURN_BEGIN。
  MOVE_TURN_BEGIN[`${m.defId}/${move.id}`]?.(bc, m);
  for (const eff of move.effects) {
    // 爬升度门（第二十一批）：参考里「case 里多出来的一句 `if (asc17) addToBot(...)`」。
    // ⚠ 它必须**在 outcome 判断之前**跳过，否则会白占一次循环——不过两者都不消耗 RNG，
    //   放在这里只是为了让「这条效果压根不存在」这个语义最直白。
    // ⚠ 第三十八批把这道门从 `apply_power` 铺到 `gain_block` 与 `add_card`（时间吞噬者的
    //   加速 asc19 加 32 格挡、头槌 asc19 塞两张黏液，都是「case 里多出来的一整句」）。
    //   三种 `kind` 共用同一段判断，不再各写各的。
    // ⚠ 第四十六批加上第四种 `buff_ally_fixed`（迪卡守护方阵的 asc19 镀甲——参考那两句
    //   同样包在一个 `if (asc19)` 里，`deca.buff` 那一半走的是上面的 `apply_power`）。
    if (
      (eff.kind === "apply_power" ||
        eff.kind === "gain_block" ||
        eff.kind === "add_card" ||
        eff.kind === "buff_ally_fixed") &&
      eff.minAscension !== undefined &&
      bc.ascension < eff.minAscension
    ) {
      continue;
    }
    // 第五十二批：反方向的那道门（`ascension < belowAscension` 才结算）。
    // ⚠ 宿主是尖塔长矛的灼烧打击——参考 asc18 那一支调的是
    //   `MakeTempCardInDrawPile(BURN, 2, false)`，`shuffleInto = false` ⇒ **一张都不塞**。
    //   照抄 as-built：高档整条效果消失，而不是换个数值或换个牌堆。
    if (
      eff.kind === "add_card" &&
      eff.belowAscension !== undefined &&
      bc.ascension >= eff.belowAscension
    ) {
      continue;
    }
    // 同理：一旦分出胜负，后续排队效果在参考里也不会再执行。
    if (bc.outcome !== "undecided") {
      return move.id;
    }
    // ⚠ 入队与否要逐项对齐参考的 takeTurn：力量类 buff 是**立即**执行
    //（`buff<MS::STRENGTH>(...)`），而加格挡、造成伤害、给玩家上减益都是
    // `addToBot(Actions::...)`。差别看得见——荆棘伤害走 addToTop 会插到排队的
    // 加格挡之前，若格挡改成同步就会把荆棘吃掉。
    if (eff.kind === "apply_power" && eff.on === "self") {
      // ⚠⚠ `sync` 在这一族里**省略 = 同步**（与 `on: "target"` 那族相反，理由见 types.ts
      //   的注释）：参考的自身 buff 全部是同步的 `buff<MS::X>(n)`，唯一的例外是工头 asc18 的
      //   `addToBot(Actions::BuffEnemy<MS::STRENGTH>(idx, 1))`（MonsterSpecific.cpp:1237）。
      // ⚠ 层数在**排队那一刻**按当下爬升度算好（爬升度整场不变，只是形式上的讲究），
      //   与 `on: "target"` 那条一致。
      // ⚠ `Actions::BuffEnemy` 走的是 `Action(ActionFunction)` 单参构造
      //   （BattleContext.h:250-256），所以 `clearOnCombatVictory` 取默认的 **true**
      //   ——与 `addToBot` 的默认值一致，这里不用显式传。
      const power = eff.power;
      const amount = ascValue(bc, eff.amount, eff.ascAmount);
      const applySelfPower = (): void => {
        addPower(m.powers, power, amount);
        if (power === "ritual") {
          // 仪式当回合不结算（skipFirst），回合末只清标志。
          const ritual = findPower(m.powers, "ritual");
          if (ritual !== undefined) {
            ritual.justApplied = true;
          }
        }
      };
      if (eff.sync === false) {
        addToBot(bc, applySelfPower);
      } else {
        applySelfPower();
      }
    } else if (
      eff.kind === "deal_damage" ||
      eff.kind === "deal_damage_rolled" ||
      eff.kind === "deal_damage_multi"
    ) {
      // 伤害在**入队时**按当下状态算好（attackPlayerHelper 先 calculateDamageToPlayer
      // 再 addToBot(AttackPlayer)）；deal_damage_rolled 取出生时掷定的固定值。
      // ⚠ 多段（`attackPlayerHelper(bc, dmg, times)`，Monster.cpp:601-607）：伤害**只算一次**，
      //   然后循环 `addToBot` 同一个值——所以四段旋风吃的是同一个易伤/虚弱快照，
      //   中途被打掉易伤也不会让后面几段变弱。
      // ⚠ `Actions::AttackPlayer` 的 `clearOnCombatVictory` 是 **false**（Actions.cpp:85-88
      //   那行的第二个参数）。多段攻击才让这一位可观察：第一段触发荆棘 / 火焰屏障、
      //   反伤打死了怪 → `checkCombat` 清扫队列，剩下几段**照样落在玩家身上**。
      // ⚠ `deal_damage_rolled` 也带 `times`（六火幽魂的六重打击是 `attackPlayerHelper(bc,
      //   miscInfo, 6)`），只是虱子那条省略了它——所以这里必须 `?? 1` 而不是「只有
      //   deal_damage_multi 才多段」。第二十批修：漏掉它时六重打击只打一段。
      // ⚠ `deal_damage_rolled` 的 asc 分档不在这里：它的值是**出生时掷定**的
      //   （虱子的咬击区间 `asc2 ? random(6,8) : random(5,7)`，见 constructMonster）。
      // ⚠ `deal_damage_multi` 的 `ascAmount` 覆盖的是**每一击的伤害**——参考写的是
      //   `attackPlayerHelper(bc, asc4 ? 3 : 2, 6)`（六火幽魂地狱之火 MonsterSpecific.cpp:808）
      //   与 `(bc, asc4 ? 6 : 5, 2)`（冲撞 :841），第二个实参恒定。
      //   第二十二批加的字段：在此之前没有一只已登记的怪用到多段攻击的 asc 分档。
      // ⚠⚠ **段数也能分档**（`ascTimes`，第三十批）：拜鸟的啄击写的是
      //   `attackPlayerHelper(bc, 1, asc2 ? 6 : 5)`（MonsterSpecific.cpp:548）——每击伤害是
      //   常数 1，`asc? :` 落在**第三个**实参位上。两者正交，判据只有一条：**看参考把
      //   `asc? :` 写在哪个实参位上**。抄反了不是「总伤害差一点」，而是段数错 →
      //   玩家侧格挡 / 荆棘 / 火焰屏障各自触发的**次数**都错。
      // ⚠⚠ `deal_damage_multi` 的 `times` 从第二十八批起还可以是 **`"miscInfo"`**：突刺之书的
      //   乱刺写的是 `attackPlayerHelper(bc, asc3 ? 7 : 6, miscInfo)`（MonsterSpecific.cpp:458）
      //   ——段数是**状态**，整场随出招规则递增。它与 `deal_damage_rolled` 读的是**同一个字段**
      //   但含义相反（那条读它当每击伤害），所以两条不能互相顶替。
      //   ⚠ 段数在**排队那一刻**读一次就定了（参考的 `for` 循环在 `attackPlayerHelper` 里、
      //     早于任何一段落地），中途 `miscInfo` 再变也不影响这一轮的段数。
      // ⚠ `deal_damage_rolled` 的 `ascAdd`（第三十四批）：在掷定值之上**再加**一个分档常数，
      //   而不是覆盖。唯一的用户是暗影客的撕咬 `miscInfo + (asc2 ? 2 : 0)`
      //   （MonsterSpecific.cpp:1475）。基础值取 0，故 asc0 下就是纯 `miscInfo`。
      // ⚠ `deal_damage` 的 `perMonsterTurn`（第三十四批）：伤害**按全局回合线性成长**，
      //   `amount + perMonsterTurn * (getMonsterTurnNumber() - 1)`，对齐复形怪的
      //   `(asc2 ? 40 : 30) + 10*(bc.getMonsterTurnNumber()-1)`（MonsterSpecific.cpp:1522）。
      //   ⚠ `ascAmount` 只覆盖起点那个数，步长是常数——参考把 `asc? :` 写在加号左边。
      //   ⚠ 它与大嘴吞噬的 `times: "monsterTurnHalf"` 读的是**同一个**全局回合计数，
      //     但一个改伤害、一个改段数，别互相顶替。
      // ⚠ `deal_damage` 的 `monsterTurnRamp`（第三十五批）：**封顶**的回合成长，
      //   `amount + min(getMonsterTurnNumber() - subtract, cap) * scale`，对齐巨头的
      //   `const auto t = std::min(bc.getMonsterTurnNumber()-5, 6) * 5;`（MonsterSpecific.cpp:1578）。
      //   ⚠⚠ `t` **可以为负**（第 4 个怪物回合是 `min(-1, 6) * 5 = -5`），不能夹到 0。
      //   ⚠ 它与 `perMonsterTurn`（无上限线性，复形怪）互斥，两者都只加在 `amount` 上。
      const base =
        eff.kind === "deal_damage_rolled"
          ? m.miscInfo + ascValue(bc, 0, eff.ascAdd)
          : ascValue(bc, eff.amount, eff.ascAmount) +
            (eff.kind === "deal_damage" && eff.perMonsterTurn !== undefined
              ? eff.perMonsterTurn * (getMonsterTurnNumber(bc) - 1)
              : 0) +
            (eff.kind === "deal_damage" && eff.monsterTurnRamp !== undefined
              ? Math.min(
                  getMonsterTurnNumber(bc) - eff.monsterTurnRamp.subtract,
                  eff.monsterTurnRamp.cap,
                ) * eff.monsterTurnRamp.scale
              : 0);
      // ⚠⚠ `times` 从第三十三批起还可以是 **`"monsterTurnHalf"`**：大嘴的吞噬写的是
      //   `const auto t = (bc.getMonsterTurnNumber() + 1) / 2; attackPlayerHelper(bc, 5, t);`
      //   （MonsterSpecific.cpp:1440-1441）——段数取自**全局回合计数**，与这只怪的状态无关。
      //   `Math.trunc` 对应 C++ 的整数除法（回合数恒正，向零截断 = 向下取整）。
      //   ⚠ 别与 `"miscInfo"` 混：那条读的是**这只怪的字段**（出招规则会改写它）。
      const rawTimes = eff.kind === "deal_damage" ? 1 : (eff.times ?? 1);
      const times =
        rawTimes === "miscInfo"
          ? m.miscInfo
          : rawTimes === "monsterTurnHalf"
            ? Math.trunc((getMonsterTurnNumber(bc) + 1) / 2)
            : ascValue(bc, rawTimes, eff.kind === "deal_damage_multi" ? eff.ascTimes : undefined);
      const dmg = calculateDamageToPlayer(bc, m, base);
      const idx = bc.monsters.indexOf(m);
      for (let i = 0; i < times; i += 1) {
        addToBot(bc, (c) => dealDamageToPlayer(c, dmg, idx), false);
      }
    } else if (eff.kind === "vampire_attack") {
      // 吸血攻击（带壳寄生虫的吸取，第二十五批）：
      // `addToBot(Actions::VampireAttack(calculateDamageToPlayer(bc, asc2 ? 12 : 10)))`
      //（MonsterSpecific.cpp:1089）。
      // ⚠ 三处与普通攻击不同：
      //  ① 伤害同样在**入队时**算好（与 attackPlayerHelper 一致），但打与回血是**一条**动作；
      //  ② `clearOnCombatVictory` 是**默认的 true**（`Action(ActionFunction)` 单参构造，
      //     ActionQueue.h:22/26），而 `Actions::AttackPlayer` 显式传的是 **false**
      //     （Actions.cpp:85-88）。所以「胜负已定之后」这条会被 `clearPostCombatActions` 清掉、
      //     普通攻击不会。⚠ 照抄这个不对称，别顺手统一成 false。
      //  ③ 目标写死 0 号位（见 `vampireAttack`），不用 `bc.monsters.indexOf(m)`。
      const dmg = calculateDamageToPlayer(bc, m, ascValue(bc, eff.amount, eff.ascAmount));
      addToBot(bc, (c) => {
        vampireAttack(c, dmg);
      });
    } else if (eff.kind === "deal_damage_block_equal") {
      // 打一下、然后获得**等于这一击伤害输出**的格挡（尖塔护盾的重砸，第四十七批）。
      // 对齐 MonsterSpecific.cpp:1789-1795：
      //     const auto damageOutput = calculateDamageToPlayer(bc, asc3 ? 38 : 34);
      //     bc.addToBot( Actions::AttackPlayer(idx, damageOutput) );
      //     bc.addToBot( Actions::MonsterGainBlock(idx, asc18 ? 99 : damageOutput));
      // ⚠ 四处照抄：
      //  ①⚠⚠ 格挡取的是 **`damageOutput`**，也就是过完 `calculateDamageToPlayer` 之后的
      //     那个整数（力量、被围攻的 ×1.5、玩家虚弱 / 易伤、虚无缥缈钳制全都已经乘进去
      //     并且截断过）。拆成 `deal_damage` + `gain_block` 会退化成「34 点格挡」，
      //     在带被围攻的第四幕里差得很远。
      //  ② **两条都入队**，顺序是先伤害后格挡——中间隔着的荆棘 / 火焰屏障因此排在
      //     加格挡之前。
      //  ③ 攻击那条是 `Actions::AttackPlayer`，`clearOnCombatVictory` 是 **false**
      //     （与普通多段攻击同源）；格挡那条 `Actions::MonsterGainBlock` 走单参构造，
      //     取默认的 **true**。两者不对称，照抄。
      //  ④ `ascBlock` 覆盖的是**格挡那一半**（asc>=18 时是写死的 99、与伤害脱钩），
      //     与覆盖伤害基数的 `ascAmount` 正交。本批只做 asc0，那一档没有例数。
      const dmg = calculateDamageToPlayer(bc, m, ascValue(bc, eff.amount, eff.ascAmount));
      const blockAmount = ascValue(bc, dmg, eff.ascBlock);
      const idx = bc.monsters.indexOf(m);
      addToBot(bc, (c) => dealDamageToPlayer(c, dmg, idx), false);
      addToBot(bc, () => {
        m.block += blockAmount;
      });
    } else if (eff.kind === "corrupt_heart_buff") {
      // 腐化之心的「强化」（第四十七批）。对齐 MonsterSpecific.cpp:1838-1861：
      //     const auto newStr = std::max(0, getStatus<MS::STRENGTH>()) + 2;
      //     setStatus<MS::STRENGTH>(newStr);
      //     const auto buffCount = bc.getMonsterTurnNumber() / 3;
      //     switch (buffCount) {
      //         case 1: buff<MS::ARTIFACT>(2);      break;
      //         case 2: buff<MS::BEAT_OF_DEATH>(1); break;
      //         case 3: buff<MS::PAINFUL_STABS>();  break;
      //         case 4: buff<MS::STRENGTH>(10);     break;
      //         default: buff<MS::STRENGTH>(50);    break;
      //     }
      // ⚠ 五处照抄：
      //  ①⚠⚠ 第一句是 **`setStatus`（覆盖）而不是 `buff`（累加）**，而且先把负力量夹回 0
      //     ——它是这只怪对「玩家给它减力量」（缴械 / 黑暗镣铐）的解药。抄成
      //     `buff<STRENGTH>(2)` 会让负力量一直留着，而且**在没有减力量牌的牌组下两者同解**
      //     （本批的牌组正是这一种），所以这一处当前是盲区，见 TODOS。
      //  ② `buffCount` 用的是**整数除法**（`getMonsterTurnNumber() / 3`），
      //     而叫它出场的那道门在**另一招**里（血弹 / 回响的收尾 `% 3 == 0`）——
      //     两处读的回合数**差一个怪物回合**（收尾跑在第 N 回合、强化执行在第 N+1 回合），
      //     所以第 3 个怪物回合的收尾排出的强化，执行时 `buffCount = 4/3 = 1`。
      //     ⚠ 这正是 WORKFLOW 那条「分档读执行那一刻、出招门读滚意图那一刻」的第二个实例。
      //  ③ 五个分支**全是同步 `buff`（累加）**，没有一条入队。
      //  ④ `default` 收的是 `buffCount >= 5` **以及 0**——按上面那条时序，`buffCount == 0`
      //     结构性不可达（强化最早出在第 4 个怪物回合），所以 default 等价于「第 15 个
      //     怪物回合起」。
      //  ⑤ 痛苦突刺是**纯 bool**（`buff<PAINFUL_STABS>()` 无参），层数写 1。
      // ⚠ 裸 `find`（不是 `findPower`）：参考这两句读写的是**数值字段** `strength`，
      //   与 statusBits 无关——同 `addPower` / `setPower` 那两处故意保留裸 `find` 的理由。
      const strength = m.powers.find((p) => p.id === "strength");
      const newStr = Math.max(0, strength?.amount ?? 0) + 2;
      if (strength === undefined) {
        m.powers.push({ id: "strength", amount: newStr });
      } else {
        // ⚠ 只写数值、**不碰 `cleared`**：`Monster::setStatus<STRENGTH>` 就是
        //   `strength = amount;`，一个 bit 都不动（同飞行那条裸 `setStatus`）。
        strength.amount = newStr;
      }
      const buffCount = Math.trunc(getMonsterTurnNumber(bc) / 3);
      if (buffCount === 1) {
        addPower(m.powers, "artifact", 2);
      } else if (buffCount === 2) {
        addPower(m.powers, "beat_of_death", 1);
      } else if (buffCount === 3) {
        addPower(m.powers, "painful_stabs", 1);
      } else if (buffCount === 4) {
        addPower(m.powers, "strength", 10);
      } else {
        addPower(m.powers, "strength", 50);
      }
    } else if (eff.kind === "apply_power" && eff.on === "target") {
      // 怪物给玩家上减益：isSourceMonster=true，故虚弱/易伤**跳过**首次递减。
      // ⚠ 与加格挡同族，参考里两种写法并存（见 Effect 的 sync 注释）：
      //   省略      `addToBot(Actions::DebuffPlayer<...>(n, true))` —— 绝大多数怪
      //   sync:true `Actions::DebuffPlayer<...>(n).actFunc(bc)`     —— 拉加维林的吸取灵魂
      // ⚠ 注意 `.actFunc(bc)` 那两条**没有传第二个参数**，取的是默认值 `true`
      //   （Actions.h:35 `bool isSourceMonster=true`），与入队那条一致。
      // ⚠ 层数在**排队那一刻**按当下爬升度算好（爬升度整场不变，所以这只是形式上的讲究）。
      const { power } = eff;
      const amount = ascValue(bc, eff.amount, eff.ascAmount);
      if (eff.sync === true) {
        debuffPlayer(bc, power, amount, true);
      } else {
        addToBot(bc, (c) => debuffPlayer(c, power, amount, true));
      }
    } else if (eff.kind === "gain_block") {
      // 参考有两种写法并存，数据表用 `sync` 区分（见 Effect 的注释）：
      //   省略      `addToBot(Actions::MonsterGainBlock(idx, n))` —— 颚虫的猛击/咆哮
      //   sync:true 同步 `addBlock(n)`                            —— 抢劫者的烟雾弹
      // 差别在于「这次加格挡与本回合排的其它动作谁先」，例如荆棘的 addToTop 反伤。
      const blockAmount = ascValue(bc, eff.amount, eff.ascAmount);
      if (eff.sync === true) {
        m.block += blockAmount;
      } else {
        addToBot(bc, () => {
          m.block += blockAmount;
        });
      }
    } else if (eff.kind === "gain_block_ally") {
      // 给随机友军加格挡（护盾地精的保护）。参考是
      // `addToBot(Actions::GainBlockRandomEnemy(idx, blockAmount))`（MonsterSpecific.cpp:1098）
      // ——**入队**，所以选目标那次 aiRng 掷在动作**出队执行**的那一刻，不是排队的这一刻。
      // 差别可观察：同一回合里排在它前面的攻击若打死了某只怪，选目标时那只已经被排除。
      const amount = ascValue(bc, eff.amount, eff.ascAmount);
      const src = bc.monsters.indexOf(m);
      addToBot(bc, (c) => gainBlockRandomEnemy(c, src, amount));
    } else if (eff.kind === "gain_block_ally_fixed") {
      // 给**写死 1 号位**的友军加格挡（百夫长的防守，第二十六批）。参考是
      //   `if (bc.monsters.getAliveCount() > 1) { auto &mystic = bc.monsters.arr[1];
      //    mystic.addBlock(asc17 ? 20 : 15); }`（MonsterSpecific.cpp:562-569）
      // ⚠ 与护盾地精那条 `gain_block_ally` 三处都不同（见 `Effect` 的注释）：目标写死、
      //   **同步**执行、候选为空时什么都不做（不退化成「给自己加」）。
      // ⚠ `getAliveCount()` 就是 `monstersAlive`（MonsterGroup.cpp:36-38）。判的是「场上
      //   还有别人」，**不是**「1 号位那只活着」——两者在两怪编队里同解，参考写的是前者。
      // ⚠ 目标不判活：门是 `monstersAlive > 1`，进门之后直接 `arr[1].addBlock(...)`。
      //   给一只已死的怪加格挡在参考里是无害的（它不会再行动），照抄不要顺手补判活。
      // ⚠⚠ **这道门的 false 侧第三十一批才第一次有背书（66 例）**，而它要的局面比
      //   「秘法师先死」更细一层：防守这个意图是在秘法师**还活着**时滚出来的，等到怪物阶段
      //   执行它时秘法师已经被打死了。所以关门条件是「**滚意图与执行之间**同伴死掉」，
      //   `@tgt1`（打下标最大的活怪）恰好每场都制造这个局面。别把它记成「同伴先死」。
      // ⚠ `noAliveGate`（第二十八批）：青铜球的支援光束**连那道门都没有**，整条 case 就是
      //   `bc.monsters.arr[1].addBlock(12);`（MonsterSpecific.cpp:525）。在当前内容集合里
      //   两者同解且可证（见 `Effect` 里那条注释），但形状照抄——参考真的没写那个 if。
      if (eff.noAliveGate === true || bc.monstersAlive > 1) {
        const ally = bc.monsters[1];
        if (ally !== undefined) {
          ally.block += ascValue(bc, eff.amount, eff.ascAmount);
        }
      }
    } else if (eff.kind === "heal_ally") {
      // 治疗 **0 号位 + 自己**（秘法师的治疗，第二十六批）。参考是
      //   `const auto healAmt = asc17 ? 20 : 16;`
      //   `if (bc.monsters.monstersAlive > 1) { auto &knight = bc.monsters.arr[0];
      //    knight.heal(healAmt); }`
      //   `heal(healAmt);`（MonsterSpecific.cpp:600-608）
      // ⚠ 三处照抄：① 目标写死 0 号位、不看谁受伤、不掷 RNG；② 自己**无条件**也回
      //   （不是二选一）；③ 两句都是**同步**的——紧随其后那次同步 rollMove 读到的是
      //   治疗**之后**的血量，而它的判据正是「缺了多少血」。
      // ⚠ 门用的是 `monstersAlive`（与百夫长那条的 `getAliveCount()` 同值、两个访问器）。
      const healAmt = ascValue(bc, eff.amount, eff.ascAmount);
      if (bc.monstersAlive > 1) {
        const knight = bc.monsters[0];
        if (knight !== undefined) {
          monsterHeal(knight, healAmt);
        }
      }
      monsterHeal(m, healAmt);
    } else if (eff.kind === "buff_ally") {
      // 给 **0 号位 + 自己**加一个 Power（秘法师的鼓舞，第二十六批）。参考是
      //   `const int strAmts[] {2,3,4}; const auto strBuff = strAmts[hallwayIdx];`
      //   `if (bc.monsters.monstersAlive > 1) { arr[0].buff<MS::STRENGTH>(strBuff); }`
      //   `buff<MS::STRENGTH>(strBuff);`（MonsterSpecific.cpp:588-598）
      // 形状与 `heal_ally` 逐字对应（写死 0 号位、自己无条件、两句都同步）。
      // ⚠ `buff` 是**累加**（`setStatus(getStatus + n)`），不是覆盖——鼓舞两次就是 +4。
      // ⚠ `noAliveGate`（第三十九批）：多努的能量之环**连那道门都没有**，整条 case 就是
      //   `bc.monsters.arr[0].buff<MS::STRENGTH>(3); buff<MS::STRENGTH>(3);`
      //   （MonsterSpecific.cpp:1677-1681），参考还在第一句行尾自注
      //   `// shouldn't matter if deca is dead`。⚠ 它与青铜球那条 `noAliveGate` 不同：
      //   那条当前可证同解，这条**真的会走到 false 侧**（策略恒打 0 号位 → 迪卡先死，
      //   多努照样给尸体 +3 力量，快照里逐帧可见）。
      const { power } = eff;
      const strBuff = ascValue(bc, eff.amount, eff.ascAmount);
      if (eff.noAliveGate === true || bc.monstersAlive > 1) {
        const knight = bc.monsters[0];
        if (knight !== undefined) {
          addPower(knight.powers, power, strBuff);
        }
      }
      addPower(m.powers, power, strBuff);
    } else if (eff.kind === "buff_ally_fixed") {
      // 给**写死 1 号位**的友军加一个 Power（迪卡守护方阵 asc19 的镀甲，第四十六批）。参考是
      //   `if (asc19) { deca.buff<MS::PLATED_ARMOR>(3); donu.buff<MS::PLATED_ARMOR>(3); }`
      //   （MonsterSpecific.cpp:1694-1697，`donu` 就是 `bc.monsters.arr[1]`）
      // ⚠ 与 `buff_ally` 的唯一差别是下标（那条写死 0 号位），而这一处是承重的：
      //   迪卡站 0 号位、照顾 1 号位的多努，秘法师 / 多努站 1 号位、照顾 0 号位。
      //   第三十九批缺的正是这个原语，那两句因此整条没转写（账见 `enemies.ts` 的守护方阵）。
      // ⚠ 三处照抄，与 `gain_block_ally_fixed` 逐字同形（两者本来就是同一条 case 的两句）：
      //   ① 目标写死、**不判活**（参考进门之后直接 `arr[1].buff(...)`）；
      //   ② **同步**执行（`Monster::buff` 就是 `setStatus(getStatus + n)`，没有 addToBot）；
      //   ③ 候选为空时什么都不做，**不**退化成「给自己加」。
      // ⚠ 自己那一份**不在这里**：它是参考里并列的另一句，走 `apply_power` + `on: "self"`
      //   （省略 `sync` = 同步）。别把两者合并成「友军 + 自己」——那是 `buff_ally` 的形状。
      // ⚠ `noAliveGate`：迪卡这条**一道门都没有**（与多努的能量之环同源，见 `buff_ally`）。
      //   ⚠ 它在这一条上是**盲区**：策略恒打 0 号位 ⇒ 迪卡先死，`monstersAlive > 1` 的
      //   false 侧要的是「多努先死」，实测 0 / 120。关门条件是 `donu_and_deca@tgt1`。
      const { power } = eff;
      const buffAmt = ascValue(bc, eff.amount, eff.ascAmount);
      if (eff.noAliveGate === true || bc.monstersAlive > 1) {
        const ally = bc.monsters[1];
        if (ally !== undefined) {
          addPower(ally.powers, power, buffAmt);
        }
      }
    } else if (eff.kind === "buff_minions") {
      // 给「随从位」们加 Power 与格挡，然后给自己加同样的 Power（地精首领的鼓舞，
      // 第二十七批）。对齐 MonsterSpecific.cpp:710-727：
      //   `const int strBuff[] {3,4,5}; const auto strGain = strBuff[eliteDiffIdx];`
      //   `bc.aiRng.random(0, 2);`                    ← 在 MOVE_TURN_BEGIN 里
      //   `for (int i = 0; i < 3; ++i) { auto &minion = arr[i];`
      //   `    if (!minion.isDying()) { minion.buff<STRENGTH>(strGain);`
      //   `                            minion.addBlock(asc3 ? 10 : 6); } }`
      //   `buff<MS::STRENGTH>(strGain);`
      // ⚠ 五处照抄：
      //  ① 范围是**写死的 0/1/2 三格**（首领恒在 3 号位，所以「随从位」= 前三格）。
      //     不是 `all_enemies`（那会把首领自己算两次），也不是「随机友军」。
      //  ② 门是 `!isDying()` = **血 > 0**，不是 `alive`——开局那个空格血 0，天然跳过；
      //     刚死的小鬼也跳过（这一支 trace 里真的走到，见 TODOS 的例数）。
      //  ③ **自己只加 Power、不加格挡**，而且**无条件**（不看 `monstersAlive`）。
      //  ④ **全部同步**，参考在那里注了 `// not going to use action queue here`。
      //     于是紧随其后那条入队的 RollMove 出队时已经看得见新的力量与格挡。
      //  ⑤ 力量与格挡是**两个独立的 asc 分档**：`{3,4,5}[eliteDiffIdx]`（阈值 3 / 18）
      //     与 `asc3 ? 10 : 6`。别合成一个数。
      const { power } = eff;
      const strGain = ascValue(bc, eff.amount, eff.ascAmount);
      const blockGain = ascValue(bc, eff.block, eff.blockAscAmount);
      for (let i = 0; i < 3; i += 1) {
        const minion = bc.monsters[i];
        if (minion !== undefined && minion.hp > 0) {
          addPower(minion.powers, power, strGain);
          minion.block += blockGain;
        }
      }
      addPower(m.powers, power, strGain);
    } else if (eff.kind === "buff_torch_heads") {
      // 给**前两格**（火炬头的两个位置）加一个 Power（收藏家的增幅，第二十九批）。
      // 对齐 MonsterSpecific.cpp:1310-1321 那个 for 循环：
      //   `const int strAmounts[3] {3,4,5};`
      //   `for (int i = 0; i < 2; ++i) { auto &torchHead = bc.monsters.arr[i];`
      //   `    if (!torchHead.isDying()) { torchHead.buff<MS::STRENGTH>(strAmounts[bossDiffIdx]); } }`
      // ⚠ 三处照抄：
      //  ① 范围是**写死的 0/1 两格**（收藏家恒在 2 号位，那两格就是火炬头的位置）。
      //     与地精首领的 `buff_minions` 差一格——那条是 0..2（首领在 3 号位）。
      //  ② **不给随从加格挡**（`buff_minions` 那条给 `asc3 ? 10 : 6`）。收藏家自己的
      //     力量与格挡是循环之后的两句独立语句，在数据表里另有两条效果对应。
      //  ③ 门是 `!isDying()` = **血 > 0**，不是 `alive`——开局那两个空格血 0，天然跳过；
      //     刚死的火炬头也跳过。全部**同步**，不入队。
      const { power } = eff;
      const buffAmount = ascValue(bc, eff.amount, eff.ascAmount);
      for (let i = 0; i < 2; i += 1) {
        const torchHead = bc.monsters[i];
        if (torchHead !== undefined && torchHead.hp > 0) {
          addPower(torchHead.powers, power, buffAmount);
        }
      }
    } else if (eff.kind === "set_hp_half_max") {
      // 把当前生命**直接写成** `maxHp / 2`（时间吞噬者的加速，第三十八批）。对齐
      // `MonsterSpecific.cpp:1639` 那一句 `curHp = maxHp / 2;`。
      // ⚠ 三处照抄：
      //  ① 它是**赋值**不是 `Monster::heal`——heal 那一族（秘法师 / 冠军）会钳上限、
      //     还会把 `halfDead` 翻回来。当前两者同解（出招门是 `curHp < maxHp/2`，
      //     所以恒是回血、且结果恰好等于上限的一半，不可能溢出），形状照抄。
      //  ② C++ **整数除法**（向零截断）：456 / 2 = 228。
      //  ③ **同步**（那条 case 一个 addToBot 都没有），所以紧随其后的同步 rollMove
      //     读到的是抬完血之后的 `curHp`——这正是「加速不会连出两次」的实现。
      m.hp = Math.trunc(m.maxHp / 2);
    } else if (eff.kind === "remove_debuffs") {
      // 清掉自己身上的减益（冠军的暴怒，第二十九批）。对齐 `Monster::removeDebuffs`
      //（Monster.cpp:522-535）——**同步**，参考那条 case 里没有任何 addToBot。
      monsterRemoveDebuffs(m);
    } else if (eff.kind === "summon_torch_heads") {
      // 召唤火炬头（收藏家，第二十九批）。参考是 `addToBot(Actions::SpawnTorchHeads())`
      //（MonsterSpecific.cpp:1339）——**入队**（与地精首领的集结同侧，与青铜自动机的
      // 同步召唤相反）。所以那几次 monsterHpRng / aiRng 掷在动作**出队执行**的那一刻。
      // ⚠ 差别可观察：同一回合里排在它前面的动作若打死了某只火炬头，`3 - monstersAlive`
      //   算出来的只数就会多一只。逐条形状见 `summonTorchHeads`。
      addToBot(bc, (c) => {
        summonTorchHeads(c);
      });
    } else if (eff.kind === "summon_gremlins") {
      // 召唤两只小鬼（地精首领的集结，第二十七批）。参考是
      // `addToBot(Actions::SummonGremlins())`（MonsterSpecific.cpp:731）——**入队**，
      // 所以两次 `getGremlin` 与两次 rollMove 的 aiRng 掷在动作**出队执行**的那一刻。
      // ⚠ 差别可观察：同一回合里排在它前面的动作若打死了某只小鬼，找空位时那一格已经算空。
      // 逐条形状见 `summonGremlins`。
      addToBot(bc, (c) => {
        summonGremlins(c);
      });
    } else if (eff.kind === "summon_daggers") {
      // 召唤匕首（蜥蜴法师，第三十六批）。参考是**裸的同步调用**
      // `reptomancerSummon(bc, asc18 ? 2 : 1);`（MonsterSpecific.cpp:1621）——**不是** addToBot，
      // 与青铜自动机那条同侧、与地精首领 / 收藏家（都是入队）相反。
      // ⚠ 只数是全参考项目唯一一个**看爬升度**的召唤数量；asc0 下恒 1 只。
      // 逐条形状见 `reptomancerSummon`。
      reptomancerSummon(bc, ascValue(bc, eff.count, eff.ascAmount));
    } else if (eff.kind === "summon_bronze_orbs") {
      // 召唤两颗青铜球（青铜自动机，第二十八批）。参考是**裸的同步调用**
      // `spawnBronzeOrbs(bc);`（MonsterSpecific.cpp:503）——**不是** addToBot，
      // 与地精首领那条恰好相反。逐条形状见 `spawnBronzeOrbs`。
      spawnBronzeOrbs(bc);
    } else if (eff.kind === "stasis") {
      // 停滞（青铜球，第二十八批）。参考是裸的同步调用 `stasisAction(bc);`
      // （MonsterSpecific.cpp:519），排在同一条 case 里 `miscInfo = 1` 与 `rollMove` 之前。
      stasisAction(bc, m);
    } else if (eff.kind === "steal_gold") {
      // 偷金：**同步**执行（参考的 `stealGoldFromPlayer` 是裸调用，不是 addToBot），
      // 排在同一条 case 里的 attackPlayerHelper **之前**。
      stealGoldFromPlayer(bc, m);
    } else if (eff.kind === "escape") {
      // 逃跑：同样是裸调用（MonsterSpecific.cpp:899）。
      monsterEscape(bc, m);
    } else if (eff.kind === "add_card") {
      // 塞状态牌（史莱姆的黏液）。参考是 `addToBot(Actions::MakeTempCardInDiscard(SLIMED))`
      //（MonsterSpecific.cpp:375 / :1180），**排在攻击那条 addToBot 之后**，故顺序就是
      // effects 的书写顺序——数据表里黏液跟在 deal_damage 后面，与参考一致。
      // ⚠ 只有弃牌堆这一路不消耗 RNG；洗入抽牌堆那一路**每张掷一次 cardRandomRng**
      //   （第三十二批的斥力怪是第一个用户，见下）。
      // ⚠ 史莱姆王的黏液喷射写的却是 `.actFunc(bc)`（MonsterSpecific.cpp:1112）——**同步**，
      //   与加格挡 / 上减益那两族同形，用 `sync` 区分。
      if (eff.pile !== "discard" && eff.pile !== "draw") {
        throw new Error(`sts-combat 暂未登记怪物塞牌去向: ${eff.pile}`);
      }
      // ⚠ 「塞的是升级版还是原版」由 `CardInstance` 的构造实参决定，在**排队那一刻**求值
      //   （六火幽魂的灼烧：`CardInstance(CardId::BURN, bc.turn > 8)`，MonsterSpecific.cpp:825）。
      //   所以这里在闭包**外面**算好再捕获，不是在闭包里读 `c.turn`。
      // ⚠ 张数也有爬升度分档（第二十二批）：哨卫的射钉 `asc18 ? 3 : 2`
      //   （MonsterSpecific.cpp:1064）、史莱姆王的黏液喷射 `asc19 ? 5 : 3`（:1112）。
      //   它与 `upgradedAfterTurn` 正交——一个管几张、一个管升不升级。
      const { cardId } = eff;
      const count = ascValue(bc, eff.count, eff.ascAmount);
      const upgraded = eff.upgradedAfterTurn !== undefined && bc.turn > eff.upgradedAfterTurn;
      // 洗进**抽牌堆**（第三十二批的斥力怪：`Actions::ShuffleTempCardIntoDrawPile(DAZED, 2)`，
      // Actions.cpp:203-211）。⚠ 四处照抄：
      //  ① **每张各掷一次** `cardRandomRng.random(size-1)` 选插入位，而且第二张掷的时候
      //     抽牌堆**已经多了第一张**（上界随之 +1）——不是「先算两个位置再插」。
      //  ② 抽牌堆**为空**时 `idx = 0` 且**一次 RNG 都不掷**（那个三目在 `random` 外面）。
      //  ③ 它与诅咒（HEX）走的 `Actions::MakeTempCardInDrawPile(c, n, true)` 逐位同形
      //     （Actions.cpp:239-250 的循环体与这条一字不差），所以复用同一个 `makeTempCardInDrawPile`。
      //  ④ 斥力那条是 `.actFunc(bc)`（**同步**），所以两张恍惚在同一条 case 里紧接着的
      //     同步 `rollMove` 之前就已经进了抽牌堆。
      const push =
        eff.pile === "draw"
          ? (c: BattleContext): void => {
              makeTempCardInDrawPile(c, cardId, count, upgraded); // ★ 抽牌堆非空时每张一次 cardRandomRng
            }
          : (c: BattleContext): void => {
              makeTempCardInDiscard(c, cardId, count, upgraded);
            };
      if (eff.sync === true) {
        push(bc);
      } else {
        addToBot(bc, push);
      }
    } else if (eff.kind === "damage_player_non_attack") {
      // **非攻击伤害**打在玩家身上（爆破怪的自爆，第三十二批）。参考是
      // `bc.addToBot( Actions::DamagePlayer(30) )`（MonsterSpecific.cpp:1395）。
      // ⚠ 四处与普通 `deal_damage` 不同，别拿那条顶替：
      //  ① 走 `Player::damage` 而不是 `Player::attacked`——**不吃怪物力量、不吃玩家易伤**
      //     （所以不过 `calculateDamageToPlayer`，30 就是 30），也**不触发荆棘 / 火焰屏障**；
      //  ② 照样**被格挡吸收**（与 `lose_hp` 那族相反）；
      //  ③ `selfDamage` 取默认的 **false**，所以不触发破裂；
      //  ④ `clearOnCombatVictory` 是 **false**（Actions.cpp:91-95 第二个参数），与
      //     `Actions::AttackPlayer` 一致。
      // ⚠ 它与守卫者尖锐外壳 / 尖刺客荆棘用的是**同一个 Action**，只是入队位置不同。
      const amount = ascValue(bc, eff.amount, eff.ascAmount);
      addToBot(bc, (c) => damagePlayerNonAttack(c, amount, false), false);
    } else if (eff.kind === "suicide") {
      // 自杀（爆破怪的自爆，第三十二批）。参考是
      // `bc.addToBot( Actions::SuicideAction(idx, true) )`（MonsterSpecific.cpp:1396），
      // 而 `triggerRelics = true` 那一支是：
      //     if (m.isAlive()) { m.damage(bc, m.curHp); }        // Actions.cpp:923-933
      // ⚠ 五处照抄：
      //  ① 它走的是**正常的非攻击伤害路径** `Monster::damage`，不是「把血置 0」。
      //     于是死亡链正常跑——地精角 / 活体样本 / 亡语都会触发，
      //     这正是那个参数名 `triggerRelics` 的含义。
      //  ② 伤害量是**执行那一刻**的 `curHp`（不是最大生命）：这一击若先被别的动作打伤过，
      //     自杀伤害也跟着变小——但两者相等，照样归零。
      //  ③ ⚠ `Monster::damage` **会先扣格挡**（`damage -= block`）。爆破怪不会有格挡，
      //     所以当前观察不到；照抄这条路径而不是直接置 0，形状才对得上。
      //  ④ 入口门是 `isAlive()` = **血 > 0**（不是 `!isDeadOrEscaped()`）。
      //  ⑤ ⚠⚠ **`SuicideAction` 里没有 `bc.checkCombat()`**——与 `Actions::DamageEnemy`
      //     （Actions.cpp:63-71，末尾有一句）正相反。所以这只怪若是最后一只，
      //     `Monster::die` 写下胜利之后**队列不被清扫**，排在后面的动作照旧留着
      //     （由主循环那道 `outcome != UNDECIDED` 的门拦下）。故这里**不能**调
      //     `damageEnemyNonAttack`（那个带 checkCombat），只调 `monsterDamage`。
      //
      // ⚠⚠ **`triggerRelics = false` 是完全不同的另一支**（复形怪，第三十四批）：
      //     bc.monsters.arr[monsterIdx].suicideAction(bc);        // Actions.cpp:930
      //   而 `Monster::suicideAction`（Monster.cpp:327-337）是
      //     if (!isAlive()) return;
      //     --bc.monsters.monstersAlive;
      //     curHp = 0;
      //     if (bc.monsters.monstersAlive == 0) bc.outcome = PLAYER_VICTORY;
      //   ——**不走 `Monster::damage`**：不扣格挡、不进 `Monster::die`（于是重生 / 孢子云 /
      //   停滞 / 地精角 / 活体样本一条都不触发）、也不走 `onHpLost`；判胜是**直接写
      //   outcome**（同逃跑那条），后面同样没有 `checkCombat`。
      //   ⚠ 门是 `isAlive()` = 血 > 0，与另一支相同。
      //
      // ⚠ `onlyIfSelfPower`（复形怪）：整条自杀外面还包着
      //   `if (getStatus<MS::FADING>() == 1)`（MonsterSpecific.cpp:1524）——读的是
      //   **递减之前**的层数（递减在收尾里，见 `MOVE_TURN_END`）。
      //   这道门在**排队那一刻**判，不是执行时判，照抄参考的 `if` 位置。
      if (
        eff.onlyIfSelfPower === undefined ||
        getPower(m.powers, eff.onlyIfSelfPower.power) === eff.onlyIfSelfPower.equals
      ) {
        const selfIdx = bc.monsters.indexOf(m);
        const triggerRelics = eff.triggerRelics ?? true;
        addToBot(bc, (c) => {
          const self = c.monsters[selfIdx];
          if (self === undefined || self.hp <= 0) {
            return;
          }
          if (triggerRelics) {
            monsterDamage(c, selfIdx, self.hp);
          } else {
            monsterSuicideNoTrigger(c, self);
          }
        });
      }
    } else if (eff.kind === "reincarnate") {
      // 复活（暗影客的重生，第三十四批）。对齐 `MMID::DARKLING_REINCARNATE`
      // 那条 case 的前五句（MonsterSpecific.cpp:1486-1497）：
      //     curHp = maxHp / 2;
      //     halfDead = false;
      //     ++bc.monsters.monstersAlive;
      //     buff<MS::REGROW>();
      //     if (player.hasRelic<PHILOSOPHERS_STONE>()) buff<MS::STRENGTH>(1);
      // ⚠ 五处照抄：
      //  ① 血量是 `maxHp / 2` 的 **C++ 整除**（向零截断）：55 血的暗影客回到 27，不是 27.5。
      //     `maxHp` 是它出生时掷的那个数，一直没变过。
      //  ② `halfDead = false` 与 `alive` 要一起翻回来——我们的 `alive` 建模的是
      //     `!isDeadOrEscaped()`，而三位现在全为假（血 > 0、不半死、没逃跑）。
      //  ③ `++monstersAlive` 与 `Monster::die` 里那句 `--monstersAlive` 配对。
      //  ④ ⚠⚠ **再 buff 一次 REGROW**：`die` 里那句 `resetAllStatusEffects()` 把它自己
      //     也清掉了，不补回去的话第二次死亡就变成真死（链上那一格判不中）。
      //  ⑤ 全部**同步**（这条 case 一个 addToBot 都没有），收尾是同步的真 rollMove
      //     ——它读的正是刚被置回 false 的 `halfDead`。
      // ⚠ 参考在这条 case 上自注 `// todo does it heep its buffs and debuffs?`：那是作者的
      //   **疑问**、不是结论。照抄它实际做的（`die` 已经清空过，这里只补 REGROW）。
      // ⑥ 贤者之石（MonsterSpecific.cpp:1494-1496）：排在 `buff<MS::REGROW>()` **之后**、
      //    收尾那次 rollMove 之前。⚠ 它是七处里唯一一处宿主**不是新造的怪**——复活的暗影客
      //    刚被 `resetAllStatusEffects()` 清过 bit，所以这次 +1 是从 0 起算（而不是叠加）。
      //    见 `philosophersStoneBuff`。
      m.hp = Math.trunc(m.maxHp / 2);
      m.halfDead = false;
      m.alive = true;
      bc.monstersAlive += 1;
      addPower(m.powers, "regrow", 1);
      philosophersStoneBuff(bc, m);
    } else if (eff.kind === "awakened_rebirth") {
      // 觉醒者的复活（第三十七批）。对齐 `MMID::AWAKENED_ONE_REBIRTH` 那条 case 的**前七句**
      // （MonsterSpecific.cpp:1712-1718；末尾的 `setMove` + `noOpRollMove` 是收尾，
      // 见 `MOVE_TURN_END["awakened_one/rebirth"]`）：
      //     maxHp = asc9 ? 320 : 300;
      //     curHp = maxHp;
      //     halfDead = false;
      //     miscInfo = true;
      //     strength = std::max(0,strength);
      //     ++bc.monsters.monstersAlive;
      //     buff<MS::MINION_LEADER>();
      // ⚠ 七处照抄：
      //  ①⚠⚠ **`maxHp` 也被重写**，而且用的是**写死的字面量**（不是数据表里那次
      //     `setRandomHp` 的结果）。asc0 下两者恰好都是 300，所以这一句当前观察不到——
      //     它是 asc9 那一档才分岔的盲区（见 TODOS）。
      //  ② `curHp = maxHp` 是**满血**复活，与暗影客的 `maxHp / 2` 不同族。
      //  ③ `halfDead = false` 与 `alive` 要一起翻回来（三位现在全为假：血 > 0、不半死、没逃跑）。
      //  ④⚠⚠ `miscInfo = true` 是**二阶段锁存位**——出招规则读它分成两块，`Monster::die`
      //     的第一格也读它（`!miscInfo` 才假死）。所以它同时管「出什么招」与「下次死是不是真死」，
      //     一个字段两个读者。
      //  ⑤ `strength = std::max(0, strength)` 是**直接写数值字段**（不碰 statusBits），
      //     与 `Monster::removeDebuffs` 里那句同形。⚠ 它在 asc0 的当前语料下是**空操作**：
      //     觉醒者身上唯一的力量来源是 asc4 那条 +2，而 `die` 里的 `removeDebuffs()`
      //     已经把负力量抬回过 0，两次之间玩家也没有任何降力量的手段（这副牌组没有黑暗镣铐
      //     / 缴械）。照抄，记进盲区。
      //  ⑥ `++monstersAlive` 与 `Monster::die` 开头那句 `--monstersAlive` 配对。
      //  ⑦⚠⚠ `buff<MS::MINION_LEADER>()`——**从此它一死当场判胜**：二阶段的觉醒者倒下时，
      //     两只邪教徒还站着也算玩家赢。这是 `MINION_LEADER` 的第三个已登记宿主
      //     （地精首领 / 蜥蜴法师 / 它）。
      // ⚠ 全部**同步**（这条 case 一个 addToBot 都没有）。
      // ⚠ **不补 CURIOSITY**（与暗影客复活时补回 REGROW 正相反）：`die` 那一格把它摘掉之后
      //   就再也不回来，二阶段快照里没有它。
      m.maxHp = bc.ascension >= 9 ? 320 : 300;
      m.hp = m.maxHp;
      m.halfDead = false;
      m.alive = true;
      m.miscInfo = 1;
      const strength = findPower(m.powers, "strength");
      if (strength !== undefined && strength.amount < 0) {
        strength.amount = 0;
      }
      bc.monstersAlive += 1;
      addPower(m.powers, "minion_leader", 1);
    } else if (eff.kind === "store_hp_scaled_damage") {
      // 按玩家**此刻**的生命算定一个每击伤害，存进 miscInfo（六火幽魂的激活，
      // MonsterSpecific.cpp:794 `miscInfo = bc.player.curHp / 12 + 1;`）。
      // ⚠ 三处照抄：
      //  ① 时点是**激活那一回合的怪物阶段**，不是六重打击落下的时候——此后玩家掉多少血
      //     （灼伤自伤、别的攻击）都不再改这个数；
      //  ② 是 C++ 的**整数除法**（向零截断），不是四舍五入；
      //  ③ 它是**同步**语句（整条 case 里没有任何 addToBot），所以紧随其后的收尾看得见它。
      m.miscInfo = Math.trunc(bc.player.hp / eff.divisor) + eff.add;
    } else if (eff.kind === "set_misc_info") {
      // 把 `miscInfo` 覆盖成一个常数（蠕动血块的植入，MonsterSpecific.cpp:1540
      // `miscInfo = true;`，第三十五批）。
      // ⚠ 三处照抄：
      //  ① **同步**（那一句不在任何 addToBot 里），所以紧随其后的同步 `rollMove` 读得到它
      //     ——这正是「植入一场仗只出一次」的实现（出招规则的 `haveUsedImplant`）。
      //  ② 覆盖而不是自增：参考写的是 `= true`，再植入一次也还是 1。
      //  ③ ⚠ 那条 case 里紧跟着的是两个遗物的分支，第四十批登记成了下面的 `obtain_curse`。
      m.miscInfo = eff.amount;
    } else if (eff.kind === "obtain_curse") {
      // 往玩家牌组塞一张诅咒（蠕动血块的植入，MonsterSpecific.cpp:1541-1545，第四十批）。
      // ⚠ 参考**不建模那张寄生虫诅咒本身**（塞进 master deck 属于 run 层），战斗内只剩
      //   两个遗物的反应：
      //       if (!bc.player.hasRelic<R::OMAMORI>()) {
      //           if (bc.player.hasRelic<R::DARKSTONE_PERIAPT>()) { bc.player.increaseMaxHp(6); }
      //       }
      // ⚠ 五处照抄：
      //  ① 形状是**嵌套的两个 if**，照抄（御守在外、暗石护符在内）。⚠ 御守这一层在
      //     `Deck::obtain` 那边还会**递减充能**（Deck.cpp:157-160），这里**只读不减**
      //     ——同一个遗物两处两种写法，别顺手补上递减。
      //  ②⚠⚠ **御守在战斗内的「有没有」取决于它的 `data`**：`initRelics` 那一格写的是
      //     `p.setHasRelic<R::OMAMORI>(r.data)`（BattleContext.cpp:185-186），
      //     所以 `data = 0` 的御守在战斗内**等于没有**。harness 因此给它发 `data = 2`
      //     （真实游戏拿到时的充能数）。⚠ 全参考只有御守与蜥蜴尾是这个形状。
      //  ③ `Player::increaseMaxHp(6)` = `maxHp += 6; heal(6);`（Player.cpp:151-154）——
      //     **上限与当前生命都涨**，不是只涨上限。两者都进快照。
      //  ④ 是**同步**（那两句都不在 addToBot 里），排在 `miscInfo = true` 之后、
      //     收尾那次同步 `rollMove` 之前。
      //  ⑤ 两个遗物都没有时它是**彻底的空操作**——此前 116 个文件里的
      //     `writhing_mass.jsonl` 正是这一侧的背书。
      if (!hasRelic(bc, "omamori")) {
        if (hasRelic(bc, "darkstone_periapt")) {
          increasePlayerMaxHp(bc, 6);
        }
      }
    } else if (eff.kind === "split") {
      // 分裂：**同步**执行，不入队——参考的那条 case 就是一句裸的
      // `largeSlimeSplit(bc, ...)`（MonsterSpecific.cpp:365 / :1221），
      // 不是 addToBot。差别可观察：分裂当场就完成，母体这一回合不会再排出任何动作。
      splitMonster(bc, m);
    } else if (eff.kind === "split_boss") {
      // 史莱姆王的分裂：同样是一句裸调用（MonsterSpecific.cpp:1126），但函数不同——
      // 五处形状差别见 `slimeBossSplit`，**别复用 `splitMonster`**。
      slimeBossSplit(bc, m);
    }
    // 其余效果留后续 PR。
  }
  return move.id;
}

/**
 * 怪物攻击伤害（对齐 Monster::calculateDamageToPlayer）。
 * float32 全程：先加怪物力量，再乘玩家易伤 1.5f，末尾一次截断。
 */
function calculateDamageToPlayer(bc: BattleContext, m: CombatMonster, baseDamage: number): number {
  let damage = Math.fround(baseDamage + getPower(m.powers, "strength"));
  // 被围攻（SURROUNDED，尖塔护盾开局给玩家上的，第四十七批）：对齐 Monster.cpp:565-570，
  // **位置在力量之后、虚弱之前**（整条乘法链的第一格）：
  //     if (p.hasStatus<PS::SURROUNDED>()) { // todo this is probably wrong
  //         const bool facingSelf = p.lastTargetedMonster == idx ||
  //                                 bc.monsters.arr[p.lastTargetedMonster].isDeadOrEscaped();
  //         if (!facingSelf) { damage *= 1.5; }
  //     }
  // ⚠ 五处照抄：
  //  ①⚠⚠ `facingSelf` 是两个析取项：**「你上一次打的就是这只怪」或「你上一次打的那只
  //     已经死了 / 跑了」**。第二项是这条门在 `SHIELD_AND_SPEAR` 里真正会翻面的那一半
  //     ——护盾（0 号位）被打死之后，长矛读 `arr[0].isDeadOrEscaped()` 为真、
  //     于是它的 ×1.5 当场停掉。实测护盾被打死 26 / 120 条。
  //  ② `lastTargetedMonster` 的**初值是 1**（Player.h:47），所以玩家还没打出任何
  //     「需要指定目标」的牌时，0 号位那只怪看到的 `facingSelf` 是**假** ⇒ 它开场那一击
  //     ×1.5。写成初值 0 会让这一帧静默错。
  //  ③ 倍率写的是 **`1.5`（double 字面量）**而不是 `1.5f`——参考这一行是
  //     `damage *= 1.5;`，与虚弱 / 易伤那几行的 `0.75f` / `1.5f` 不同。
  //     在 `float` 域上 `1.5` 与 `1.5f` 精确相等（都是二进制可表示的），所以这里没有分岔，
  //     但记一笔：**不要**照着邻居把它写成别的常数。
  //  ④ 它排在**虚弱之前**，所以虚弱是在被围攻放大之后再打折的。位置目前不可观察
  //     （乘法可交换、且中间没有截断），形状照抄。
  //  ⑤⚠ 参考在这一行自注 `// todo this is probably wrong`——它知道自己可能与真实游戏
  //     不符。照抄，记进 TODOS 待裁定。
  if (getPower(bc.player.powers, "surrounded") > 0) {
    const last = bc.player.lastTargetedMonster;
    // ⚠ 参考的 `arr` 是定长 5 格、越界那几格躺着默认构造的 `Monster`（`curHp` 0 ⇒
    //   `isDeadOrEscaped()` 为真）。我们的 `bc.monsters` 只有真正的格子，所以
    //   「下标越界」与「那一格是死的」在这里必须**同解**——单怪编队的初值 1 正是这种情况。
    const facingSelf =
      last === bc.monsters.indexOf(m) || (bc.monsters[last]?.alive ?? false) === false;
    if (!facingSelf) {
      damage = Math.fround(damage * 1.5);
    }
  }
  // 虚弱（对齐 Monster.cpp:574-580）。⚠ 纸鹤（PAPER_KRANE，第四十三批）在这里：
  //     if (hasStatus<MS::WEAK>()) {
  //         if (p.hasRelic<RelicId::PAPER_KRANE>()) { damage *= 0.6f; }
  //         else                                    { damage *= 0.75f; }
  //     }
  // ⚠ 三处照抄：① **同一道门里的二选一**（与纸蛙同族），不是叠乘；
  //   ② 数值是 `0.6f`——真实游戏的措辞是「虚弱的敌人伤害降低 40% 而不是 25%」；
  //   ③ 判的是**这只怪身上**的虚弱、遗物在**玩家身上**。
  if (getPower(m.powers, "weak") > 0) {
    damage = Math.fround(damage * (hasRelic(bc, "paper_krane") ? 0.6 : 0.75));
  }
  // 易伤（对齐 Monster.cpp:582-588）。⚠ 奇特蘑菇（ODD_MUSHROOM，第四十三批）在这里：
  //     if (p.hasStatus<PS::VULNERABLE>()) {
  //         if (p.hasRelic<RelicId::ODD_MUSHROOM>()) { damage *= 1.25f; }
  //         else                                     { damage *= 1.5f;  }
  //     }
  // ⚠ 它与纸蛙是**两处不同的代码**：纸蛙管「玩家的牌打在易伤的怪身上」
  //   （`BattleContext::calculateCardDamage`），这条管「怪打在易伤的玩家身上」。
  //   两处的默认倍率恰好都是 1.5f，别抄串。
  if (getPower(bc.player.powers, "vulnerable") > 0) {
    damage = Math.fround(damage * (hasRelic(bc, "odd_mushroom") ? 1.25 : 1.5));
  }
  // 虚无缥缈：怪物攻击那条路的钳制在**这里**（Monster.cpp:594），不在 Player::attacked
  // ——参考在 attacked 里明写「assume intangible is already handled」。
  // ⚠ 是 `min(damage, 1.0f)` 而不是「置 1」：伤害本来不足 1（虚弱把 1 压成 0.75）时
  // 不会被抬高。位置在所有倍率之后、截断之前。
  if (getPower(bc.player.powers, "intangible") > 0) {
    damage = Math.min(damage, 1);
  }
  // TODO(后续PR): 被围攻 / 姿态。
  return Math.max(0, Math.trunc(damage));
}

/**
 * 给玩家施加减益（对齐 Actions::DebuffPlayer → Player::debuff）。
 *
 * isSourceMonster 决定虚弱/易伤是否**跳过**首次递减：怪物出招传 true（当回合不掉层），
 * 玩家自己打出的牌传 false（狂暴给自己的易伤本回合末就掉一层）。
 */
function debuffPlayer(
  bc: BattleContext,
  power: string,
  amount: number,
  isSourceMonster = true,
): void {
  // ⚠⚠ 三道门的**先后**照抄 `Player::debuff`（Player.h:362-379），顺序在本批变得可观察：
  //   `amount == 0` 提前返回 → 姜（虚弱）→ 芜菁（脆弱）→ 神器。
  //  ① `amount == 0` 那道门参考一直有（Player.h:363-365），我们此前没写；当前没有任何
  //     调用点传 0，两边同解，补上是为了形状对齐。
  //  ②⚠⚠ **姜与芜菁排在神器之前**，所以它们挡掉的那次减益**一层神器都不消耗**。
  //     把它们挪到神器下面会让「带着神器吃一次虚弱」白掉一层神器——差别当场可观察。
  if (amount === 0) {
    return;
  }
  // 姜（GINGER，第四十三批）：`if (s == PS::WEAK && hasRelic<GINGER>()) return;`
  // ⚠ 是**整条丢弃**（免疫），不是「减层数」；也不写 statusMap，所以快照里连条目都不会出现。
  if (power === "weak" && hasRelic(bc, "ginger")) {
    return;
  }
  // 芜菁（TURNIP，第四十三批）：`if (s == PS::FRAIL && hasRelic<TURNIP>()) return;`
  // ⚠ 与姜逐字同形、只差状态名，两条并排放着（Player.h:367-374）。别把两者抄串：
  //   姜挡虚弱（少打伤害），芜菁挡脆弱（少拿格挡）。
  if (power === "frail" && hasRelic(bc, "turnip")) {
    return;
  }
  // 神器优先抵消一层（古代药水等来源）。
  const artifact = bc.player.powers.find((p) => p.id === "artifact");
  if (artifact !== undefined && artifact.amount > 0) {
    artifact.amount -= 1;
    if (artifact.amount === 0) {
      bc.player.powers.splice(bc.player.powers.indexOf(artifact), 1);
    }
    return;
  }
  // 抽牌削减（DRAW_REDUCTION，时间吞噬者的头槌，第三十八批）。对齐 Player.h:385-390：
  //     if (s == PlayerStatus::DRAW_REDUCTION) {
  //         --cardDrawPerTurn;
  //         setJustApplied<PS::DRAW_REDUCTION>(true);
  //         setHasStatus<PS::DRAW_REDUCTION>(true);
  //         return;
  //     }
  // ⚠ 五处照抄：
  //  ①⚠⚠ **`amount` 被完全丢掉**：无论传几，`cardDrawPerTurn` 都只减 **1**。参考在头槌
  //     那里传的实参是 1，两者当前同值——但形状照抄（`Actions::DebuffPlayer<DRAW_REDUCTION>`
  //     的模板参数决定走这一支，实参只喂给顶部那道 `amount == 0` 的门）。
  //  ②⚠⚠ **真正的数值住在 `cardDrawPerTurn`，Power 本身只是个 bool 标记**：参考走
  //     `setHasStatus` 而不写 `statusMap`，所以 harness 的 `playerStatusValue` 按 1 输出，
  //     我们也存 1。叠加两次 → `cardDrawPerTurn` 再减 1，快照里还是 `DRAW_REDUCTION: 1`。
  //  ③ 位置在神器那道门**之后**——头槌的抽牌削减照样会被神器（古代药水）吃掉，
  //     而且被吃掉时 `cardDrawPerTurn` **一点都不减**。
  //  ④ `justApplied` 在这里是**无条件**置真的（上面那段 `isSourceMonster && !hasStatus`
  //     的通用逻辑对它是冗余的），所以「施加的那个回合不递减」恒成立。
  //  ⑤ 归还在 `afterMonsterTurns` 里（见那里的 skipFirst 段），**排在入队抽牌之后**
  //     ——所以本次抽牌真的少抽一张。
  if (power === "draw_reduction") {
    bc.player.cardDrawPerTurn -= 1;
    const existing = bc.player.powers.find((x) => x.id === "draw_reduction");
    if (existing === undefined) {
      bc.player.powers.push({ id: "draw_reduction", amount: 1, justApplied: true });
    } else {
      existing.amount = 1;
      existing.justApplied = true;
    }
    return;
  }
  // 纯 bool 减益（对齐 Player.h:406-409 `if (s == PS::CONFUSED || s == PS::HEX) {
  // setHasStatus<s>(true); return; }`）：**只置位、不写 statusMap**，所以再上一次也还是 1 层。
  // ⚠ 位置就在神器那道门**之后**——诅咒照样会被神器吃掉。
  // ⚠ harness 的 `playerStatusValue` 对这一族按 1 输出（statusMap 里查不到），所以我们也存 1；
  //   写成累加会在选民第二次诅咒时红成 `HEX: 2`。
  // ⚠ 困惑（CONFUSED，第二十五批的史尼克）走**同一支**，判据就是参考那句 `||`——
  //   两个都只置位。它的效果全在 `CardManager::draw`（见 `drawOneCard`），不在这里。
  //   与诅咒一样：整场不递减、不过期，而且**照样会被神器吃掉**（那道门在前面）。
  if (power === "hex" || power === "confused") {
    const existing = bc.player.powers.find((x) => x.id === power);
    if (existing === undefined) {
      bc.player.powers.push({ id: power, amount: 1 });
    } else {
      existing.amount = 1;
    }
    return;
  }
  // ⚠ 与怪物侧不对称：玩家这边只在**原本没有该状态**时才设 justApplied
  //（对齐 Player::debuff 的 `isSourceMonster && !hasStatus<s>()`）。叠加到已有减益上
  // 不重置标志，因此当回合末照常递减。Monster::addDebuff 则没有这道 !hasStatus 判断。
  const had = bc.player.powers.some((x) => x.id === power && x.amount > 0);
  addPower(bc.player.powers, power, amount);
  if (
    isSourceMonster &&
    !had &&
    (power === "weak" || power === "vulnerable" || power === "frail")
  ) {
    const p = bc.player.powers.find((x) => x.id === power);
    if (p !== undefined) {
      p.justApplied = true;
    }
  }
}

/** 玩家侧回合末减益递减（对齐 Player::applyEndOfTurnPowers 的同款 skipFirst 语义）。 */
function decrementPlayerDebuff(bc: BattleContext, id: string): void {
  const p = bc.player.powers.find((x) => x.id === id);
  if (p === undefined) {
    return;
  }
  if (p.justApplied === true) {
    p.justApplied = false;
    return;
  }
  p.amount -= 1;
  if (p.amount <= 0) {
    bc.player.powers.splice(bc.player.powers.indexOf(p), 1);
  }
}

/**
 * 无条件递减一层某个玩家 Power，归零即摘掉（对齐 `Player::decrementStatus<s>()`）。
 *
 * 与 decrementPlayerDebuff 的区别就是**不看 justApplied**。参考里两类混在
 * applyAtEndOfRoundPowers 同一个函数里，逐项用的是哪一个不能凭直觉猜、要逐条对。
 */
function decrementPlayerPower(bc: BattleContext, id: string): void {
  const p = bc.player.powers.find((x) => x.id === id);
  if (p === undefined) {
    return;
  }
  p.amount -= 1;
  if (p.amount <= 0) {
    bc.player.powers.splice(bc.player.powers.indexOf(p), 1);
  }
}

/**
 * 怪物的回合末触发（对齐 `Monster::applyEndOfTurnTriggers`，Monster.cpp:41）。
 *
 * 与紧随其后的 `Monster::applyEndOfRoundPowers` 是**两个不同的时点**，参考把它们分别放在
 * `BattleContext::applyEndOfRoundPowers` 的玩家结算**之前**与**之后**，中间夹着
 * `player.applyAtEndOfRoundPowers()`。所以「这条属于哪一半」不能凭直觉猜，要逐条对：
 * 金属化 / 易塑 / 镀甲 / 虚无缥缈 / 再生 / **束缚**在前半，仪式 / 缓慢 / 锁定 / 虚弱 /
 * 易伤 / 通用力量成长在后半。
 *
 * ⚠ 束缚（SHACKLED）归还力量走的是 `Monster::buff<MS::STRENGTH>`（Monster.h:536，
 * `strength += amount`）而**不是** `addDebuff`——所以它**不过神器**。神器只在施加那一刻
 * 拦截（见黑暗镣铐的注释），归还这一步无条件发生。
 * ⚠ 清除走 `removeStatus<SHACKLED>()`（Monster.h:495）：先 `setStatus(0)` 再清 bit，
 * 与我们的「整条摘掉」等价（层数归零的条目在快照里两边都被丢弃）。
 *
 * ⚠ **金属化排在这个函数的第一条**（Monster.cpp:43-45），在束缚归还之前。它是
 * **同步** `addBlock`、不入队，所以这一层格挡在紧随其后的怪物回合开头就已经在了。
 * 拉加维林睡着时每个回合末 +8——正因为它是「回合末」而不是「回合开始」，玩家在第一个
 * 回合看到的 8 点格挡来自 `preBattleAction` 那句 `addBlock(8)`，不是这里。
 * ⚠ 苏醒之后金属化被 `decrementStatus(8)` 减没（见 `wakeUpLagavulin`），这条自然不再触发。
 *
 * ✅ **六句现在全齐了**：金属化（第十八批）→ 易塑（第二十三批）→ 镀甲（第二十五批）→
 * 虚无缥缈（第三十六批）→ 再生（第三十七批）→ 枷锁（第十二批）。参考的
 * `Monster::applyEndOfTurnTriggers` 就这六条，名单封闭。
 */
function applyMonsterEndOfTurnTriggers(m: CombatMonster): void {
  const metallicize = getPower(m.powers, "metallicize");
  if (metallicize > 0) {
    m.block += metallicize;
  }
  // 易塑复位（对齐 Monster.cpp:47-49 `setStatus<MS::MALLEABLE>(3)`）——第二条，排在金属化
  // 之后、镀甲之前。
  // ⚠ 是**复位成 3**，不是清零、不是递减：受击时涨上去的层数每个回合末都被拉回起点。
  //   写成「减 1」或「不动」都会让食蛇草越往后挡得越多（或越少），差异逐回合累积。
  // ⚠ 常数 3 是**写死在参考里**的，与 `preBattleAction` 那个 `buff<MALLEABLE>(3)` 的 3
  //   是两处独立的字面量（改数据表的初值不会让这里跟着变）。
  const malleable = findPower(m.powers, "malleable");
  if (malleable !== undefined && malleable.amount > 0) {
    malleable.amount = 3;
  }
  // 镀甲加格挡（对齐 Monster.cpp:51-52 `if (hasStatus<PLATED_ARMOR>())
  // addBlock(getStatus<PLATED_ARMOR>())`）——**第三条**，排在金属化与易塑之后、虚无缥缈之前。
  // ⚠ 与金属化**同族但是两条独立的语句**：一只同时带两者的怪会加两次（当前没有这种怪，
  //   但顺序照抄——它决定了同一回合末两笔格挡谁先落，而两笔都是同步 `addBlock`，
  //   所以当前不可观察）。别为了「整齐」合成一条。
  // ⚠ 加的是**当前层数**：壳被打了几下就少加几点，打光（层数归零、条目摘掉）之后不再加。
  // ⚠ 是**同步** `addBlock`、不入队，所以这层格挡在紧随其后的怪物回合开头就已经在了
  //   （而怪物回合开始的清格挡在 `applyPreTurnLogic`，它排在**下一个**回合的开头）。
  const platedArmor = getPower(m.powers, "plated_armor");
  if (platedArmor > 0) {
    m.block += platedArmor;
  }
  // 虚无缥缈递减（复仇魔，第三十六批）：对齐 Monster.cpp:55-57
  //     if (hasStatus<MS::INTANGIBLE>()) { decrementStatus<MS::INTANGIBLE>(); }
  // ——这个函数的**第四句**（金属化 → 易塑 → 镀甲 → **虚无缥缈** → 再生 → 枷锁）。
  // ⚠ 四处照抄：
  //  ①⚠⚠ **无条件递减、没有 skipFirst**：参考在枚举那行自注
  //     `// differs from the game in that it always decrements at end of round`
  //     （MonsterStatusEffects.h:35）——真实游戏里怪物侧的虚无缥缈是「获得当回合不掉」，
  //     参考**故意**没有这么做。这是「参考与真实游戏可能分歧」的候选，但补丁没有预言机
  //     （预言机就是参考本身），照抄参考、记进 TODOS。
  //     ⚠ 而复仇魔的三条 case 在**补层之前**先判 `!hasStatus`，所以净效果仍然是「隔回合」：
  //     2 → 回合末 1（下个玩家回合仍无敌、怪物回合不补）→ 回合末 0（条目消失）→ 再补 2。
  //  ② `decrementStatus<INTANGIBLE>` 走的是 `WEAK < s <= TIME_WARP` 那一段
  //     （`uniquePower0 -= 1; if (uniquePower0 == 0) setHasStatus(false);`，Monster.h:303-307）
  //     ——**归零时连条目一起摘掉**（与镀甲 / 消逝同族，与飞行那种裸 `setStatus` 正相反）。
  //     这一点是承重的：条目留着的话 `hasPower` 恒真，复仇魔就**再也补不上第二次**。
  //  ③ 位置在**镀甲之后、枷锁之前**。当前没有一只怪同时带虚无缥缈与它们，故不可观察；照抄。
  //  ④ 它在 `applyEndOfRoundPowers` 的**第一个**循环里（`applyEndOfTurnTriggers`），
  //     不是第二个（仪式 / 缓慢 / 虚弱递减那个）。
  const intangible = findPower(m.powers, "intangible");
  if (intangible !== undefined) {
    intangible.amount -= 1;
    if (intangible.amount === 0) {
      m.powers.splice(m.powers.indexOf(intangible), 1);
    }
  }
  // 再生（觉醒者，第三十七批）：对齐 Monster.cpp:59-61
  //     if (hasStatus<MS::REGEN>()) { heal(getStatus<MS::REGEN>()); }
  // ——这个函数的**第五句**（金属化 → 易塑 → 镀甲 → 虚无缥缈 → **再生** → 枷锁）。
  // ⚠ 三处照抄：
  //  ①⚠⚠ **一层都不掉**：参考这里只有 `heal`，没有任何 `decrementStatus`。玩家侧那条再生
  //     （`Player::applyAtEndOfRoundPowers` 里回血再 -1 层）是**另一回事**，两边共用同一个
  //     PowerId（harness 两边都 dump 成 `REGEN`）但语义不同——所以觉醒者的 `REGEN: 10`
  //     在快照里整场恒定。
  //  ② 走的是 `Monster::heal`（`curHp = min(maxHp, curHp + amount)`，Monster.cpp:270-277）
  //     ——满血时白加、不会溢出。它与撕咬/吸取那条吸血用的是同一个函数。
  //  ③ 位置在**虚无缥缈之后、枷锁之前**。当前没有一只怪同时带再生与它们，故不可观察；照抄。
  // ⚠ 半死的怪走不到这里：`applyEndOfRoundPowers` 的两个循环都跳过 `!alive` 的怪，
  //   而半死必然伴随 `hp == 0`。所以假死期间觉醒者不会被自己的再生救回来。
  const regen = getPower(m.powers, "regen");
  if (regen > 0) {
    monsterHeal(m, regen);
  }
  const shackled = getPower(m.powers, "shackled");
  if (shackled > 0) {
    addPower(m.powers, "strength", shackled);
    removePower(m.powers, "shackled");
  }
}

/** 对齐 MonsterGroup::applyEndOfRoundPowers：回合末怪物 Power 结算。 */
function applyEndOfRoundPowers(bc: BattleContext): void {
  // 顺序对齐 BattleContext::applyEndOfRoundPowers（BattleContext.cpp:2148）：
  // 怪物 endOfTurnTriggers → **玩家减益递减** → 怪物 endOfRoundPowers。
  // ⚠ 两个怪物循环各自带 `isDying() || isEscaping()` 的跳过。`isDying()` 就是 `curHp <= 0`，
  // `isEscaping()` 是抢劫者逃跑那一位——两者在我们这边都体现为 `!alive`（见 `monsterEscape`）。
  for (const m of bc.monsters) {
    if (!m.alive) {
      continue;
    }
    applyMonsterEndOfTurnTriggers(m);
  }
  decrementPlayerDebuff(bc, "frail");
  decrementPlayerDebuff(bc, "vulnerable");
  decrementPlayerDebuff(bc, "weak");
  // 复制（DUPLICATION，第四十五批的复制药水）：**无条件**递减一层
  // （`decrementStatus<PS::DUPLICATION>()`，Player.cpp:469-471），排在虚弱之后、
  // 虚无缥缈之前（中间隔着未登记的双倍伤害与平衡）。
  // ⚠⚠ **这是第二个递减点**：打出一张牌时那四个 handler 各自还会 `decrementStatus` 一次。
  //   所以「喝一瓶 1 层的复制药水、这一回合一张牌都不打」，层数照样在回合末掉光。
  decrementPlayerPower(bc, "duplication");
  // 虚无缥缈：同样是**无条件**递减（`decrementStatus<PS::INTANGIBLE>()`，Player.cpp:477）。
  // ⚠ `Player::buff<INTANGIBLE>` 里那句 `setJustApplied(true)` 是死代码——这里用的不是
  // `decrementIfNotJustApplied`，所以「施加当回合跳过」并不成立：幻影给的 1 层在**本回合末**
  // 就掉光，只护住紧随其后的那个怪物回合。参考自己在那行标了 `// todo this is definitely wrong`。
  // 位置对齐参考的顺序：脆弱 → 易伤 → 虚弱 → 双倍伤害 → 复制 → 平衡 → INTANGIBLE → NO_BLOCK。
  decrementPlayerPower(bc, "intangible");
  // 无法格挡（应急按钮的 NO_BLOCK）：**无条件**递减一层，不走 justApplied 那一套——
  // 参考在 Player::applyAtEndOfRoundPowers 里对它用的是裸 `decrementStatus`，而脆弱/易伤/
  // 虚弱用的是 `decrementIfNotJustApplied`。所以 2 层 = 「本回合 + 下一回合」都封住。
  decrementPlayerPower(bc, "no_card_block");

  for (const m of bc.monsters) {
    if (!m.alive) {
      continue;
    }
    const ritual = findPower(m.powers, "ritual");
    if (ritual !== undefined && ritual.amount > 0) {
      if (ritual.justApplied === true) {
        ritual.justApplied = false; // 施加当回合跳过
      } else {
        addPower(m.powers, "strength", ritual.amount);
      }
    }
    // 顺序对齐参考：仪式 → 缓慢 → 锁定 → 虚弱 → 易伤 → 通用力量增长。
    // 缓慢清零（巨头，第三十五批）：`if (hasStatus<MS::SLOW>()) setStatus<MS::SLOW>(0);`
    // （Monster.cpp:79-81）——这个函数的**第二句**，紧跟仪式之后。
    // ⚠ 三处照抄：
    //  ① 是**清零**而不是递减：玩家下个回合从 0 重新攒，所以「回合内越打越疼」不会跨回合累积。
    //  ② 走 `setStatus`（只写数值、**不清 statusBits**），所以条目永不摘除——下个回合
    //     `onAfterUseCard` 里那道 `hasStatus` 照样成立。写成 `removeStatus`（整条摘掉）
    //     会让缓慢在第一个回合末永久失效。
    //  ③ 位置在虚弱 / 易伤递减**之前**。当前没有一只怪同时带缓慢与那两者，故不可观察；照抄。
    if (hasPower(m.powers, "slow")) {
      setPower(m.powers, "slow", 0);
    }
    decrementDebuff(m, "weak");
    decrementDebuff(m, "vulnerable");
    // 通用力量增长（暗球游荡者，第三十三批）：`Monster::applyEndOfRoundPowers` 的
    // **最后一句**（Monster.cpp:103-105）：
    //     if (hasStatus<MS::GENERIC_STRENGTH_UP>()) {
    //         buff<MS::STRENGTH>(getStatus<MS::GENERIC_STRENGTH_UP>());
    //     }
    // ⚠ 三处照抄：
    //  ① **没有 skipFirst**——与紧邻的仪式正相反：开局 preBattleAction 上的 3 层在
    //     **第一个回合末**就结算，不像仪式要跳过施加的那一回合。
    //  ② **自己一层都不掉**（既不递减也不摘除），所以力量是 3、6、9… 线性涨。
    //  ③ 位置是这个循环的**最后**，排在虚弱 / 易伤递减之后。当前没有一只怪同时带它与
    //     仪式，所以「排第一还是排最后」观察不到；照抄。
    const strengthUp = getPower(m.powers, "generic_strength_up");
    if (strengthUp > 0) {
      addPower(m.powers, "strength", strengthUp);
    }
  }
  // TODO(后续PR): 锁定递减（`decrementStatus<MS::LOCK_ON>()`，机器人的靶心，尚无产出者）。
}

function addPower(powers: PowerInstance[], id: string, amount: number): void {
  // ⚠ 这里**故意**用裸 `find` 而不是 `findPower`：参考的 `buff` / `addDebuff` 是
  //   `field += amount; setHasStatus(true);`——它读的是**数值字段**、与 bit 无关。
  //   所以 `cleared`（数值还在、bit 已清，见 `PowerInstance.cleared`）的条目会**从残留值
  //   继续加**，并且这一次把 bit 重新点亮。第三十四批实测：暗影客重生前的 1 层虚弱
  //   会让复活后那张衣领上出 3 层而不是 2 层。
  const existing = powers.find((p) => p.id === id);
  if (existing) {
    existing.amount += amount;
    delete existing.cleared;
  } else {
    powers.push({ id, amount });
  }
}

/**
 * 摘掉一个 Power（对齐 Actions::RemoveStatus → Player::setHasStatus(false)）。
 *
 * 参考只清 statusBits、把 statusMap 里的旧值留着不管；再次施加时走
 * `hasStatus` 为假的分支 `statusMap[s] = amount`（覆盖而非累加），所以「整条删掉」
 * 与它等价——而且我们这边删掉才不会在快照里留一个幽灵条目。
 */
function removePower(powers: PowerInstance[], id: string): void {
  const idx = powers.findIndex((p) => p.id === id);
  if (idx >= 0) {
    powers.splice(idx, 1);
  }
}

/**
 * **覆盖**一个 Power 的层数（对齐 `Monster::setStatus`，Monster.h:196）。
 *
 * ⚠ 与 `addPower`（= 参考的 `buff`）的差别是承重的：`setStatus` **只写数值、不碰
 * statusBits**，所以它只能用在「这个 Power 已经在身上」的地方——守卫者的形态切换
 * （`setStatus<MODE_SHIFT>(newAmount)`，Monster.cpp:527）与巨头的缓慢清零
 * （`setStatus<SLOW>(0)`，Monster.cpp:79-81）都满足这一点。
 * ⚠ **它会被传 0**（第三十五批起）：缓慢每个回合末归零，而条目要留着——这正是
 * `setStatus` 与 `removeStatus` 的分水岭，别把「层数 0」当成「摘掉」。
 * 层数 0 的条目在两边的快照里都被折叠掉，所以留着不会多出幽灵条目。
 *
 * ⚠ 这里也**故意**用裸 `find`（同 `addPower`）：`setStatus` 写的是数值字段、与 bit 无关，
 * 所以 `cleared` 的条目照样该被写到。当前唯一的用户（守卫者的形态切换）永远不会遇到
 * cleared 的条目——守卫者没有重生——但形状与参考一致。
 */
function setPower(powers: PowerInstance[], id: string, amount: number): void {
  const existing = powers.find((p) => p.id === id);
  if (existing === undefined) {
    throw new Error(`sts-combat setPower: ${id} 不在身上（参考的 setStatus 不写 statusBits）`);
  }
  existing.amount = amount;
}

/**
 * 怪物侧的**纯 bool** Power（对齐 `isBooleanPower`，MonsterStatusEffects.h:180-192）。
 *
 * 参考给它们**没有任何数值字段**：`buff` 只 `setHasStatus(true)`、`getStatusInternal`
 * 直接 `return true`（所以 harness 恒输出 1），`decrementStatus` 直接清 bit。
 * ⚠ 唯一读这张表的地方是 `resetAllMonsterStatusEffects`——它要把「有数值残留的」与
 * 「没有的」分开处理，见 `PowerInstance.cleared`。
 * ⚠ 别把孢子云 / 荆棘 / 仪式那些也塞进来：它们是 `uniquePower0` 那一族（有数值）。
 */
const MONSTER_BOOL_POWERS: ReadonlySet<string> = new Set([
  "asleep",
  "barricade",
  "minion",
  "minion_leader",
  "painful_stabs",
  "regrow",
  "shifting",
  "stasis",
]);

/**
 * 清空一只怪的全部状态（对齐 `Monster::resetAllStatusEffects`，Monster.cpp:554-558）。
 *
 * ```cpp
 * statusBits = 0;
 * setStatus<MS::STRENGTH>(0);
 * block = 0;
 * ```
 *
 * ⚠⚠ **它与「逐个 removeStatus」不是一回事**，差别当场可观察（第三十四批实测）：
 * `removeStatus` 先 `setStatus(0)` 再清 bit（数值一起归零），而这里**只清 bit**——
 * 那些具名 int 字段（`weak` / `vulnerable` / `artifact` / …）原样留着，下一次
 * `buff` / `addDebuff` 的 `field += n` 会**从残留值继续加**。
 * 我们用 `PowerInstance.cleared` 表达这个中间态，详见那条注释。
 *
 * ⚠ 三处照抄：
 *  ① **纯 bool 的 Power 整条丢掉**（它们没有数值字段，`buff` 只置 bit）——所以暗影客
 *     复活时那次 `buff<MS::REGROW>()` 拿到的是干净的一层，不是「残留 + 1」。
 *  ② **力量单独归零**（`setStatus<STRENGTH>(0)`）：力量在参考里没有 bit，
 *     `getStatusInternal` 对它特判、恒返回 `strength`。所以它必须是**真的 0**，
 *     不能留成 cleared 残留——否则复活后第一次 `buff<STRENGTH>` 会把旧力量捡回来。
 *  ③ `justApplied` 三位（虚弱 / 易伤 / 仪式）住在 `statusBits` 的高位上，
 *     一起被清掉。
 * ⚠ 全参考项目**只有一个调用点**：`Monster::die` 的 REGROW 分支。
 */
function resetAllMonsterStatusEffects(m: CombatMonster): void {
  m.powers = m.powers
    .filter((p) => !MONSTER_BOOL_POWERS.has(p.id) && p.id !== "strength")
    .map((p) => ({ id: p.id, amount: p.amount, cleared: true }));
  m.block = 0;
}

/**
 * 玩家被怪物攻击（对齐 Player::attacked，Player.cpp:209）。
 *
 * ⚠ 荆棘与火焰屏障两条反伤照抄三处：
 *   ① 都是 `addToTop(DamageEnemy(攻击者, 层数))`，且推入顺序是**荆棘先、火焰屏障后**——
 *      都插队首，所以实际执行顺序反过来：**先火焰屏障、再荆棘**；
 *   ② 都**不看这一击有没有被完全格挡**（判定在扣血分支之外）——挡满了照样反伤；
 *   ③ 走非攻击伤害路径（Monster::damage），不触发蜷缩。
 * ⚠ 扣血走 `hpWasLost(…, selfDamage=false)`，所以受击**永远不触发破裂**。
 */
function dealDamageToPlayer(bc: BattleContext, amount: number, attackerIdx = -1): void {
  // ⚠⚠ 参考在这里的语句顺序是（Player.cpp:209-257）：
  //   格挡吸收 → **缓冲** → 荆棘 → 火焰屏障 → **鸟居** → 钨钢棒 → `if (damage > 0) { … }`
  // 我们此前把「荆棘/火焰屏障」写在最前（两者与伤害数值无关，位置观察不到差别），
  // 本批把缓冲插在它们之前、鸟居插在它们之后，与参考同序。
  //
  // 缓冲（BUFFER，石化螺旋）：`if (damage > 0 && hasStatus<BUFFER>()) { decrement; damage = 0; }`
  //  ①⚠⚠ **位置与 `Player::damage` 里那一份不同**：这边排在荆棘/火焰屏障**之前**，
  //     那边（非攻击伤害）在扣格挡之后就直接判。参考在这行自注
  //     `// buffer triggers before tungsten rod in the game's implementation`。
  //  ②⚠ **荆棘照样反伤**：缓冲把伤害吞成 0，但荆棘那两条判的是「有没有荆棘」、
  //     与这一击留没留下伤害无关（它们在扣血分支之外）。
  const buffer = getPower(bc.player.powers, "buffer");
  const thorns = getPower(bc.player.powers, "thorns");
  if (thorns > 0 && attackerIdx >= 0) {
    addToTop(bc, (c) => damageEnemyNonAttack(c, attackerIdx, thorns));
  }
  const flameBarrier = getPower(bc.player.powers, "flame_barrier");
  if (flameBarrier > 0 && attackerIdx >= 0) {
    addToTop(bc, (c) => damageEnemyNonAttack(c, attackerIdx, flameBarrier));
  }
  const blocked = Math.min(bc.player.block, amount);
  bc.player.block -= blocked;
  let unblocked = amount - blocked;
  if (unblocked > 0 && buffer > 0) {
    decrementPlayerPower(bc, "buffer");
    unblocked = 0;
  }
  // 鸟居（TORII，第四十三批）：对齐 Player.cpp:235-237，排在荆棘/火焰屏障**之后**、
  // 钨钢棒之前：`if (damage > 0 && damage <= 5 && hasRelic<TORII>()) { damage = 1; }`
  // ⚠ 四处照抄：
  //  ①⚠ 判的是**过完格挡与缓冲之后**剩下的量，不是这一击的原始伤害——所以格挡把 20 点
  //     削到 4 点时鸟居照样把它压成 1。
  //  ② 上界是 `<= 5`（含 5），下界是 `> 0`；恰好 6 点不吃这条。
  //  ③ 它**只挂在 `Player::attacked` 这条路上**——非攻击伤害（灼伤 / 束缚 / 尖锐外壳 /
  //     怪物的 `DamagePlayer`）走 `Player::damage`，那边**没有**鸟居。这与钨钢棒
  //     （三条路各一份）正相反。
  //  ④ 是「置为 1」而不是「减去」。
  if (unblocked > 0 && unblocked <= 5 && hasRelic(bc, "torii")) {
    unblocked = 1;
  }
  // 钨钢棒（TUNGSTEN_ROD，第四十四批）：排在鸟居**之后**（Player.cpp:239-241）。
  // ⚠ 顺序可观察：鸟居先把 1~5 点压成 1，钨钢棒再减 1 ⇒ **归零**；反过来（先 -1 再压成 1）
  //   会留下 1 点。两颗都带的时候这一格决定挨不挨这一下。
  if (unblocked > 0 && hasRelic(bc, "tungsten_rod")) {
    unblocked -= 1;
  }
  // `lastAttackUnblockedDamage` 逐位对齐 `Player::attacked` 的末段（Player.cpp:243-257）：
  // 有剩余伤害就记下它，**否则显式记 0**（那个 else 分支是参考写着的，不是省略）。
  // 唯一的读者是吸血攻击（见 `vampireAttack`）。
  if (unblocked > 0) {
    bc.player.lastAttackUnblockedDamage = unblocked;
    // 玩家侧镀甲（PLATED_ARMOR，第四十三批的线与针）：对齐 Player.cpp:245-247，
    //     if (hasStatus<PS::PLATED_ARMOR>()) { decrementStatus<PS::PLATED_ARMOR>(); }
    // ⚠ 四处照抄：
    //  ①⚠⚠ 它在 `if (damage > 0)` **里面**——被格挡（或缓冲、鸟居之前的那一步）完全吃掉的
    //     那一击**不减层数**，而**多段攻击每段各减一层**。
    //  ②⚠ **只在 `Player::attacked` 这条路上**：非攻击伤害（灼伤 / 束缚 / 尖锐外壳）不减。
    //     怪物侧的镀甲相反——它挂在 `attackedUnblockedHelper` 的 else-if 链上，也只吃攻击。
    //  ③ 位置在记 `lastAttackUnblockedDamage` **之后**、痛苦突刺之前。
    //  ④ 走 `decrementStatus`（归零就整条摘掉，快照里当场消失），不是裸的 `setStatus`。
    if (getPower(bc.player.powers, "plated_armor") > 0) {
      decrementPlayerPower(bc, "plated_armor");
    }
    // 痛苦突刺（突刺之书，第二十八批）：对齐 Player.cpp:250-252
    //   `if (bc.monsters.arr[enemyIdx].hasStatus<MS::PAINFUL_STABS>()) {`
    //   `    bc.addToBot( Actions::MakeTempCardInDiscard({CardId::WOUND}) ); }`
    // ⚠ 四处照抄：
    //  ① 它在 `if (damage > 0)` **里面**——被格挡完全吃掉的那一击**一张都不塞**；
    //  ② 判的是**攻击者身上**的 Power，不是玩家身上的（所以要 `attackerIdx`）；
    //  ③ 位置在「记 `lastAttackUnblockedDamage`（+ 玩家镀甲递减）」之后、`hpWasLost` **之前**
    //     ——`hpWasLost` 可能触发别的入队动作，顺序因此可观察；
    //  ④ **每段各判一次**：多段攻击是多条独立的 `AttackPlayer` 动作，乱刺 3 段最多塞 3 张伤口，
    //     其中被挡住的那几段不塞。这与「一次出招塞一张」是完全不同的形状。
    // ⚠ 伤口**打不出**（`CardInstance.cpp:329` 的例外只放行黏液），所以它只躺在弃牌堆快照里。
    const attacker = attackerIdx >= 0 ? bc.monsters[attackerIdx] : undefined;
    if (attacker !== undefined && getPower(attacker.powers, "painful_stabs") > 0) {
      addToBot(bc, (c) => {
        makeTempCardInDiscard(c, "wound", 1);
      });
    }
    playerHpWasLost(bc, unblocked, false);
  } else {
    bc.player.lastAttackUnblockedDamage = 0;
  }
}

/**
 * 怪物回血（对齐 `Monster::heal`，Monster.cpp:269-277）：`curHp = min(maxHp, curHp + amount)`。
 * ⚠ 参考在这里只有一句钳制，**没有**「回血触发」之类的钩子。
 */
function monsterHeal(m: CombatMonster, amount: number): void {
  m.hp = Math.min(m.maxHp, m.hp + amount);
}

/**
 * 怪物侧的「清掉自己的减益」（对齐 `Monster::removeDebuffs`，Monster.cpp:538-552）。
 * **两个调用点**：冠军的暴怒（第二十九批，走数据表的 `remove_debuffs` 效果）与
 * 觉醒者的假死（第三十七批，`monsterDie` 的第一格直接调用）。
 * ⚠ 觉醒者那条在这个调用**之外**还单独摘了一次好奇心——好奇心不是减益，不在这张名单里。
 *
 * ⚠ 它**不是「清空所有 Power」**，而是一张写死的名单，两段：
 *  ①⚠ 力量**只抬负值**：`if (getStatus<STRENGTH>() < 0) setStatus<STRENGTH>(0);`
 *     ——正的力量原样保留（所以暴怒不会把自己此前累积的力量清掉），而且它走的是
 *     `setStatus` 而不是 `removeStatus`（力量的 `static_assert` 就禁了后者）。
 *     ⚠ 我们的 Power 表里「层数 0」与「没有这一条」在快照上是两件事：harness 的
 *     `monsterStatuses` 跳过 `getStatusInternal(s) == 0` 的项，而力量存在自己的 int 字段里、
 *     从不进 statusBits——所以抬回 0 就等于「快照里不再出现 STRENGTH」，
 *     用 `removePower` 表达是逐位一致的。
 *  ②⚠ `removeStatus<>()` 九条（**整条摘掉**：`removeStatus` 同时清数值与 statusBits，
 *     Monster.h:495-501）。其中 `BLOCK_RETURN` / `CORPSE_EXPLOSION` 在我们的 `PowerId` 里
 *     还不存在（束缚之球 / 尸爆都没登记），登记它们时要回来补进这张名单。
 * ⚠ 名单里**没有**脆弱：参考的 `Monster::removeDebuffs` 只清上面那些，
 *   而脆弱在怪物身上压根没有对应的 `MonsterStatus`（那是玩家侧的）。照抄，别按直觉补。
 */
function monsterRemoveDebuffs(m: CombatMonster): void {
  // ① 力量只抬负值。
  if (getPower(m.powers, "strength") < 0) {
    removePower(m.powers, "strength");
  }
  // ② 逐条摘掉（顺序照抄参考，虽然彼此独立）。
  // TODO(后续PR): `block_return`（束缚之球）与 `corpse_explosion`（尸爆）还没有 PowerId，
  //   登记那两张牌时补进来。
  for (const id of ["choked", "lock_on", "mark", "poison", "shackled", "vulnerable", "weak"]) {
    removePower(m.powers, id);
  }
}

/**
 * 吸血攻击（对齐 `Actions::VampireAttack`，Actions.cpp:97-106）。带壳寄生虫的吸取专用，
 * 全项目只有它一个用户。
 *
 * ⚠ 四处照抄：
 *  ①⚠⚠ **目标下标写死 0**（参考自注 `// only used by shelled parasite so idx is 0`）：
 *     攻击的来源方是 `arr[0]`，所以荆棘 / 火焰屏障的反弹也打在 0 号位，而回血的也是 0 号位
 *     ——**不是「自己」**。与尖锐外壳、激怒那两处 `arr[0]` 同族。
 *     在参考的**全部**内容里这不产生分歧：带壳寄生虫只出现在 `SHELL_PARASITE`（单怪）与
 *     `SHELLED_PARASITE_AND_FUNGI`（它在 0 号位、真菌兽在 1 号位，MonsterGroup.cpp:356-358），
 *     `arr[0]` 恒等于它自己。所以不给参考打补丁，见 TODOS。
 *  ② 回血量是 `min(damage, player.lastAttackUnblockedDamage)`：`damage` 是**入队时**算好的
 *     攻击力（含力量 / 虚弱 / 易伤），而 `lastAttackUnblockedDamage` 是刚刚**真正扣掉的血**。
 *     格挡挡掉一部分就少回一部分，全挡住则回 0（那时 `lastAttackUnblockedDamage` 被置 0）。
 *  ③ 判活用的是 `m.isAlive()` = **`curHp > 0`**，不是 `!isDeadOrEscaped()`
 *     ——逃跑 / 假死的怪照样能回血。当前无差别（带壳寄生虫不逃跑），照抄。
 *  ④ 攻击与回血在**同一条动作**里、回血是**同步**紧跟其后的：所以荆棘的 `addToTop` 反弹
 *     还没执行，即便那一下能打死寄生虫，血也已经回上去了。
 */
function vampireAttack(bc: BattleContext, damage: number): void {
  const target = 0; // ⚠ 参考写死的常量，不是「自己」
  dealDamageToPlayer(bc, damage, target);
  const m = bc.monsters[target];
  if (m !== undefined && m.hp > 0) {
    monsterHeal(m, Math.min(damage, bc.player.lastAttackUnblockedDamage));
  }
}

/**
 * 非攻击伤害打在玩家身上（对齐 Player::damage，Player.cpp:174）。
 *
 * ⚠ 与 attacked（怪物出招）和 playerLoseHp（放血一类）都不同：
 *   * **过格挡**（这一点与 playerLoseHp 相反——灼伤是能被格挡挡掉的）；
 *   * **不触发荆棘 / 火焰屏障**（那两条在 attacked 里，因为需要攻击者下标）。
 *
 * ⚠ 虚无缥缈（INTANGIBLE）在**格挡之前**把伤害压成 1（`if (damage > 0 && hasStatus<
 * PS::INTANGIBLE>()) damage = 1;`，Player.cpp:180）——注意这里带 `damage > 0` 判断，
 * 与 `loseHp` 那条不带的写法不同，照抄。
 *
 * @param selfDamage 同 playerLoseHp：破裂只认「因打出的牌」的失血。灼伤走
 *   `Actions::DamagePlayer(2, true)`（BattleContext.cpp:940），所以灼伤**会**触发破裂；
 *   而缠绕那类怪物来源的 `DamagePlayer(n)` 是默认的 false。写成必填参数同理。
 *
 * ⚠ 缓冲（BUFFER，第四十三批的石化螺旋）在**格挡之后**（Player.cpp:195-198）：
 *     if (damage > 0 && hasStatus<PS::BUFFER>()) { decrementStatus<PS::BUFFER>(); damage = 0; }
 *   ①⚠ 它**只挡穿透格挡的那部分**：先让格挡吃，剩下的才由缓冲整个吞掉（连 1 点都不留）。
 *   ② 每挡一次消耗一层。③ 这一条在 `Player::attacked` 里**也有一份**，但位置不同
 *      （那边排在荆棘/火焰屏障**之前**、鸟居之前），见 `dealDamageToPlayer`。
 */
function damagePlayerNonAttack(bc: BattleContext, amount: number, selfDamage: boolean): void {
  let damage = amount;
  if (damage > 0 && getPower(bc.player.powers, "intangible") > 0) {
    damage = 1;
  }
  const blocked = Math.min(bc.player.block, damage);
  bc.player.block -= blocked;
  let unblocked = damage - blocked;
  if (unblocked > 0 && getPower(bc.player.powers, "buffer") > 0) {
    decrementPlayerPower(bc, "buffer");
    unblocked = 0;
  }
  // 钨钢棒（TUNGSTEN_ROD，第四十四批）：三条伤害路径**各有一份，函数体逐字相同**
  //     if (damage > 0 && hasRelic<RelicId::TUNGSTEN_ROD>()) { damage -= 1; }
  //   `Player::damage` :201-203 / `Player::attacked` :239-241 / `Player::loseHp` :266-271。
  // ⚠⚠ **`loseHp` 那一份多两行**（`if (amount == 0) return;`），另外两份**没有**——
  //   见 `playerLoseHp`。三份缺一不可：漏掉哪一条，那条路上的每一点伤害都多 1。
  if (unblocked > 0 && hasRelic(bc, "tungsten_rod")) {
    unblocked -= 1;
  }
  if (unblocked <= 0) {
    return;
  }
  playerHpWasLost(bc, unblocked, selfDamage);
}

/**
 * 濒死结算（对齐 Player::wouldDie）：先归零，再找瓶中仙灵——找到就消耗掉它、
 * 回复 30% 最大生命（神圣树皮 60%，下限 1）并**存活**；没有才判负。
 * 蜥蜴尾巴同理，留到遗物迁移。
 */
function wouldDie(bc: BattleContext): void {
  bc.player.hp = 0;
  // 绽放印记（MARK_OF_THE_BLOOM，第四十四批）：对齐 `Player::wouldDie` 的那道外层门
  // （Player.cpp:331）——`if (!hasRelic<MARK_OF_THE_BLOOM>()) { …仙女瓶… …蜥蜴尾… }`。
  // ⚠ 它把**仙女瓶与蜥蜴尾一起**关在外面，不是只挡回血：带着它就是没有第二条命。
  if (!hasRelic(bc, "mark_of_the_bloom")) {
    for (let i = 0; i < bc.potionCapacity; i += 1) {
      if (bc.potions[i] === "fairy_in_a_bottle") {
        discardPotion(bc, i);
        // 神圣树皮（SACRED_BARK，第四十四批）的**第二个**读点（Player.cpp:330-334）：
        //     std::max(1, (int)((float)maxHp * (hasRelic<R::SACRED_BARK>() ? 0.6f : 0.3f)))
        // ⚠ 它与 `drinkPotion` 里那一整族「效果翻倍」是**两处不同的写法**：这里是把
        //   0.3f 换成 0.6f（一个浮点常量），那边是把整数量 ×2。照抄各自的。
        const ratio = hasRelic(bc, "sacred_bark") ? 0.6 : 0.3;
        const healAmount = Math.max(
          1,
          Math.trunc(Math.fround(Math.fround(bc.player.maxHp) * Math.fround(ratio))),
        );
        healPlayer(bc, healAmount);
        return;
      }
    }
    // 蜥蜴尾（LIZARD_TAIL，第四十四批）：对齐 Player.cpp:339-343：
    //     if (hasRelic<RelicId::LIZARD_TAIL>()) {
    //         setHasRelic<RelicId::LIZARD_TAIL>(false);
    //         heal(maxHp/2);
    //         return;
    //     }
    // ⚠ 五处照抄：
    //  ①⚠⚠ 门读的是**玩家那份位集合**，而它是 `initRelics` 里 `setHasRelic<X>(r.data)`
    //     置的——**充能为 0 的蜥蜴尾在战斗内根本不存在**，救不了人。
    //  ②⚠ **先摘再回血**：摘掉那一句排在 `heal` 之前，所以同一场仗只能救一次。
    //     摘掉之后 `updateRelicsOnExit` 会把 `r.data` 写成 0（永久失效）。
    //  ③ 回的是 `maxHp/2`（整数除），而且走的是 `Player::heal` ⇒ **过魔力之花与绽放印记**
    //     ——不过绽放印记那道外层门已经把整段挡在外面了，所以魔力之花才是真的会叠上来的那个。
    //  ④ `curHp` 在函数第一句就被写成 0 了，所以回血是从 0 起算。
    //  ⑤ **排在仙女瓶之后**：两者都有时先喝药水。
    if (hasRelic(bc, "lizard_tail")) {
      setHasRelic(bc, "lizard_tail", false);
      healPlayer(bc, Math.trunc(bc.player.maxHp / 2));
      return;
    }
  }
  bc.outcome = "player_loss";
}

/**
 * 玩家 Power 的回合开始（抽牌之后）结算（对齐 Player::applyStartOfTurnPostDrawPowers，
 * Player.cpp:674）。
 *
 * ⚠ 同 applyEndOfTurnPowers：参考遍历 statusMap，即按枚举值升序，与获得顺序无关。
 * 本批只有恶魔形态（DEMON_FORM=44）命中。
 */
/**
 * 回合开始（抽牌**之后**）的遗物（对齐 `Player::applyStartOfTurnPostDrawRelics`，
 * Player.cpp:661-672）。本项目**第四个**遗物时点，第四十三批为怀表而开。
 *
 * 调用点在 `afterMonsterTurns` 里、`applyStartOfTurnPostDrawPowers` **之前**、
 * 三个计数器清零**之前**（对齐 BattleContext.cpp:2236）。
 *
 * ⚠ 参考的函数体只有两条并列的 `if`，顺序由源码定死：怀表 → 扭曲钳。
 * ⚠ 名字里的 "PostDraw" 指的是「回合开始那次 `DrawCards` **入队之后**」，不是「抽完之后」
 *   ——那次抽牌是 `addToBot` 的，出队要等到 `executeActions` 再跑。所以怀表排的
 *   `DrawCards(3)` 落在开局那 5 张**后面**，手牌是 5+3。
 */
function applyStartOfTurnPostDrawRelics(bc: BattleContext): void {
  // 怀表（POCKETWATCH，Player.cpp:663-667）：
  //     if (hasRelic<R::POCKETWATCH>()) {
  //         if (cardsPlayedThisTurn <= 3) {
  //             bc.addToBot(Actions::DrawCards(3));
  //         }
  //     }
  // ⚠⚠ `cardsPlayedThisTurn` 在这一刻还是**上一个回合**的值（清零那三句排在本函数之后，
  //   见 `afterMonsterTurns` 里那段注释）——卡面「若上回合打出的牌不超过 3 张」就是这么来的。
  // ⚠ `<= 3` 而不是 `< 3`；第 1 个玩家回合拿不到（`init` 不走 `afterMonsterTurns`）。
  if (hasRelic(bc, "pocketwatch") && bc.player.cardsPlayedThisTurn <= 3) {
    addToBot(bc, (c) => drawCards(c, 3));
  }
  // 扭曲钳（WARPED_TONGS，第四十四批）：排在怀表**之后**（Player.cpp:669-671）：
  //     if (hasRelic<R::WARPED_TONGS>()) { bc.addToBot(Actions::UpgradeRandomCardAction()); }
  // ⚠ 三处照抄：
  //  ①⚠⚠ **它有第二份，在 `initRelics` 的第三个循环里**（`atTurnStartPostDraw`，
  //     BattleContext.cpp:450-452）——那一份覆盖第 1 回合，这一份覆盖第 2 回合起。
  //     与硫磺 / 水银沙漏同族，缺一处就每场少升一张。
  //  ②⚠ **入队**，而且排在怀表那条 `DrawCards(3)` 之后 ⇒ 抽到的那 3 张也在候选里。
  //  ③ 效果本身 ★ 消耗一次 `shuffleRng`（候选非空时），见 `upgradeRandomCardInHand`。
  if (hasRelic(bc, "warped_tongs")) {
    addToBot(bc, (c) => upgradeRandomCardInHand(c));
  }
}

/**
 * 回合开始回能量（对齐 `Player::rechargeEnergy`，Player.cpp:725-733）。
 *
 * ```cpp
 * if (hasRelic<R::ICE_CREAM>()) {
 *     gainEnergy(energyPerTurn);
 * } else {
 *     energy = energyPerTurn;
 * }
 * ```
 * ⚠ 冰淇淋（ICE_CREAM，第四十三批）就是这两支的差别：`gainEnergy` 是 `energy += n`
 * （**累加**，上一回合没花完的留着），`else` 那支是**覆盖**。
 * ⚠ 它没有别的读点，也不影响 `energyPerTurn`——所以「攒能量」这件事完全由这一个 if 承担。
 * ⚠ 参考在这两句之后还有一段 onEnergyRecharge 的 Power（收集 / 提婆形态 / 充能），
 *   一个都没登记，留 TODO。
 */
function rechargeEnergy(bc: BattleContext): void {
  if (hasRelic(bc, "ice_cream")) {
    bc.player.energy += bc.player.energyPerTurn;
  } else {
    bc.player.energy = bc.player.energyPerTurn;
  }
  // TODO(后续PR): 收集（COLLECT）/ 提婆形态 / 充能（ENERGIZED）三条 onEnergyRecharge Power。
}

function applyStartOfTurnPostDrawPowers(bc: BattleContext): void {
  // 暴虐（BRUTALITY=39）排在恶魔形态（DEMON_FORM=44）**之前**——枚举序，与获得顺序无关。
  // ⚠ 失血走 PlayerLoseHp（不过格挡、clearOnCombatVictory=false），抽牌是默认的 true；
  // 两条都 addToBot，故「先失血后抽牌」。
  //
  // ⚠⚠ selfDamage 传 **true**，所以暴虐的失血**会触发破裂**——这是**偏离参考原文的修正**，
  // 参考侧已同步打补丁（`Player.cpp:683` 原文是 `Actions::PlayerLoseHp(pair.second)`，
  // 第二参数缺省即 false，而同文件 :369 的燃烧、以及 BattleContext.cpp 里所有卡牌调用点
  // 都显式传了 true——只有暴虐漏了）。真实游戏里暴虐走的是 `LoseHPAction(owner, owner, …)`，
  // 来源是玩家自己，`onLoseHp` 因此会跑到，破裂**会**触发（暴虐+破裂是铁甲的经典组合）。
  // 补丁与重生成的 trace 一起落地，所以这条有预言机背书，见 TODOS「已修正」。
  const brutality = getPower(bc.player.powers, "brutality");
  if (brutality > 0) {
    addToBot(bc, (c) => playerLoseHp(c, brutality, true), false);
    addToBot(bc, (c) => drawCards(c, brutality));
  }
  const demonForm = getPower(bc.player.powers, "demon_form");
  if (demonForm > 0) {
    addToBot(bc, (c) => addPower(c.player.powers, "strength", demonForm));
  }
  // TODO(后续PR): 虔诚 / 下回合抽牌 / 毒雾 等其余分支。
}

function afterMonsterTurns(bc: BattleContext): void {
  applyEndOfRoundPowers(bc); // 回合末怪物 Power（仪式涨力量等）
  bc.turnHasEnded = false;
  bc.monsterTurnIdx = 6; // 复位到「非怪物回合」
  bc.turn += 1;
  // 回合开始的遗物（对齐 BattleContext.cpp:2198）。第四十一批为硫磺而开，位置照抄：
  // 排在 `applyStartOfTurnPowers` 与清格挡**之前**。
  applyStartOfTurnRelics(bc);
  // 回合开始的玩家 Power（抽牌之前）。位置照抄：applyStartOfTurnRelics 之后、
  // **清格挡之前**（对齐 BattleContext.cpp:2188）。火焰屏障就在这里退场。
  applyStartOfTurnPowers(bc);
  // 新回合：清玩家格挡、抽牌、回能量。
  // ⚠ 清格挡是一条 if/else-if 链（对齐 BattleContext.cpp:2178）：壁垒 → 模糊 → 卡钳 →
  // 归零，**只走第一个命中的分支**。壁垒那支是空的（格挡原样留着）。
  if (getPower(bc.player.powers, "barricade") > 0) {
    // 壁垒：格挡不清空。
  } else if (hasRelic(bc, "calipers")) {
    // 卡钳（CALIPERS，第四十三批）：这条 if/else-if 链的**第三格**
    // （BattleContext.cpp:2214-2215）：`player.block = std::max(0, player.block-15);`
    // ⚠ 三处照抄：
    //  ①⚠⚠ **它是链上的一格，不是「归零之后补回来」**。所以壁垒或模糊在身上时**轮不到它**
    //     ——写成独立的 if 会让「壁垒 + 卡钳」变成「先保留全部、再减 15」，正好反了。
    //  ② `max(0, …)` 而不是「减到 0 为止」：格挡不到 15 就归零，不会变负。
    //  ③ 位置在 `applyStartOfTurnPowers` **之后**——下回合格挡（自成型黏土）那份是在
    //     这一句之前加上的，所以**照样会被这一句削掉 15**。两颗遗物凑在一起时这个顺序可观察。
    bc.player.block = Math.max(0, bc.player.block - 15);
  } else {
    // TODO(后续PR): 模糊（BLUR，递减一层并保留格挡）——它排在壁垒与卡钳**之间**。
    bc.player.block = 0;
  }
  // ⚠ 回合开始的抽牌必须**入队**（`addToBot(Actions::DrawCards(player.cardDrawPerTurn))`，
  // BattleContext.cpp:2210），不能同步抽。这一条第六批才变得可观察：
  // 抽到状态牌时烈焰吐息会 `addToBot(DamageAllEnemy)`，而紧随其后的暴虐又 addToBot 了
  // 「失血 + 抽 1」。同步抽牌会让烈焰吐息的伤害排到暴虐那两条**之前**——它若打死最后一只怪，
  // clearPostCombatActions 就把暴虐的抽牌（clearOnCombatVictory=true）清掉，那张牌凭空少抽。
  // 入队之后三条的相对顺序才与参考一致：抽 5 → 暴虐失血 → 暴虐抽 1 → 烈焰吐息伤害。
  // ⚠ 张数在**入队时**取（参考捕获的是 `player.cardDrawPerTurn` 的当时值）：紧接其后的
  // DRAW_REDUCTION 会改这个字段，读晚了就会多抽。
  const drawCount = bc.player.cardDrawPerTurn;
  addToBot(bc, (c) => drawCards(c, drawCount));
  // 抽牌削减的 skipFirst 归还（第三十八批）。对齐 BattleContext.cpp:2227-2233：
  //     if (player.hasStatus<PS::DRAW_REDUCTION>()) {
  //         if (player.wasJustApplied<PS::DRAW_REDUCTION>()) {
  //             player.setJustApplied<PS::DRAW_REDUCTION>(false);
  //         } else {
  //             player.removeStatus<PS::DRAW_REDUCTION>();
  //             ++player.cardDrawPerTurn;
  //         }
  //     }
  // ⚠ 四处照抄：
  //  ①⚠⚠ **位置在 `addToBot(DrawCards(cardDrawPerTurn))` 之后**——张数在入队那一刻就已经
  //     取好（上面那行 `drawCount`），所以「归还」发生在本回合抽完之后、不影响本回合。
  //     把它提到抽牌之前会让削减一次都生效不了。
  //  ②⚠ 它是**两个回合边界**：头槌在第 N 个怪物回合施加 → 第 N+1 个玩家回合少抽一张
  //     （这一次只清 justApplied）→ 第 N+2 个玩家回合恢复。所以一次头槌只削减**一个回合**，
  //     而这个 Power 在快照里会连着出现两帧组的时间。
  //  ③ 走的是 `removeStatus`（整条摘掉）而不是 `decrementStatus`——它没有层数可减。
  //  ④ `++cardDrawPerTurn` 与 `Player::debuff` 里那句 `--cardDrawPerTurn` 配对，
  //     叠加两次头槌就要归还两次（每个回合末只归还一层，因为 Power 只有一条）。
  //     ⚠ 这正是参考的行为：两次削减只会被归还一次，`cardDrawPerTurn` 永久少 1。照抄。
  const drawReduction = bc.player.powers.find((p) => p.id === "draw_reduction");
  if (drawReduction !== undefined) {
    if (drawReduction.justApplied === true) {
      drawReduction.justApplied = false;
    } else {
      bc.player.powers.splice(bc.player.powers.indexOf(drawReduction), 1);
      bc.player.cardDrawPerTurn += 1;
    }
  }
  applyStartOfTurnPostDrawRelics(bc);
  applyStartOfTurnPostDrawPowers(bc);
  // 三个计数器一起清零（对齐 BattleContext.cpp:2240-2243，参考在那里自注
  // `// this has to be here because some relics check this info.`）。
  // ⚠⚠ **位置是承重的，第四十三批把它从「清格挡之后」挪到了这里**：参考把这三句放在
  //   `applyStartOfTurnPostDrawRelics` 与 `applyStartOfTurnPostDrawPowers` **之后**，
  //   于是两族「读上一回合的张数」的遗物各自读到的都是**上一个回合**的值：
  //     * 战争艺术在 `applyStartOfTurnRelics` 里读 `attacksPlayedThisTurn`（更靠前）；
  //     * **怀表**在 `applyStartOfTurnPostDrawRelics` 里读 `cardsPlayedThisTurn`（就在这三句上面）。
  //   在怀表登记之前这两种摆法同解（没人在中间读），登记之后就不是了——摆错会让怀表
  //   **每回合都触发**（那时计数恒为 0，`0 <= 3` 恒真）。
  // ⚠ 参考还有第四句 `cardsDiscardedThisTurn = 0;`，我们没有这个字段（没有读者）。
  bc.player.cardsPlayedThisTurn = 0;
  bc.player.attacksPlayedThisTurn = 0;
  bc.player.skillsPlayedThisTurn = 0;
  rechargeEnergy(bc);
  // ⚠⚠ **这里原先有一句「场上没有活怪就判胜」，第三十七批删掉了——参考的
  //   `BattleContext::afterMonsterTurns`（BattleContext.cpp:2183-2246）里没有这样一句。**
  //   参考在这个函数里唯一与胜负有关的是 `if (isBattleOver) return;`，而 `isBattleOver`
  //   **全项目只在 `BattleContext::init` 里被赋过一次 false**（:44），是个死标志位。
  //   判胜的完整名单是四处、全部在怪物退场那一刻：`Monster::die` 的两条
  //   （`monstersAlive == 0` / `MINION_LEADER`）、逃跑、`Monster::suicideAction`。
  // ⚠ 它一直是冗余的（那四处已经覆盖了「怪全灭」），到觉醒者才**变成错的**：
  //   一阶段的觉醒者假死时 `alive` 为假、`monstersAlive` 可以是 0，而参考**故意不判胜**
  //   （`Monster::die` 的第一个分支排在判胜之前，见 `monsterDie`）。留着它会让
  //   「打死一阶段觉醒者的那一刻场上没有别的活怪」直接结束战斗，复活永远不会发生。
  //   实测：留着它红 2 例（`awakened_one.jsonl` 里两条邪教徒先死光的 trace）。
}

// ============================================================================
// 可序列化快照（供 GameState 存档；接线用）
//
// BattleContext 里只有两处不是纯数据：6 条 StsRandom（有 toState/fromState）与
// 两条队列（存的是闭包）。
//
// **出牌队列从第九批起也可能非空**：二连击把复制项塞进出牌队列，如果那张攻击牌自己会开
// 选牌屏（头槌），屏开着时复制项就还排在队里；混乱叠两层时同理。所以它按纯数据逐项入档。
// 早先这里是「出牌队列在两个可取档时点都必空」的断言——从第九批起那句不再成立。
// **动作队列不再必空**：选牌屏是第四批新增的可操作时点，开屏时队列里至少还压着
// onAfterUseCard（那张牌去哪个牌堆），焚誓还多压一条抽牌。所以动作队列按 ActionDesc
// 逐条入档，读回来重建。没有描述的残留动作会让 exportState **抛错**——静默丢弃一条排队
// 动作等于让读回来的档少一次结算，比直接失败危险得多。
// 结局已定的战斗不入档（战斗当场结算掉），所以 player_loss 时残留的动作队列也不用管。
// ============================================================================

export type CombatRngState = Record<keyof CombatRng, RandomState>;

/** BattleContext 的纯数据投影：JSON 可往返，用作 GameState.stsCombat。 */
export type StsCombatState = {
  /** run 级 int64 种子的十进制字符串（与 GameState.seed 同形）。 */
  seedLong: string;
  floorNum: number;
  ascension: number;
  encounterId: string;
  character: CharacterId;
  /**
   * 遗物容器（对齐 `RelicContainer::relics`）。第四十四批从 `string[]` 改成带 `data` 的
   * 条目——老档由 `migrate.ts` 无损回填 `{ id, data: 0 }`（在此之前没有任何遗物读过 data）。
   */
  relics: CombatRelic[];
  potions: (string | null)[];
  potionCount: number;
  potionCapacity: number;
  outcome: Outcome;
  /**
   * 取档时玩家处于哪个可操作时点。第四批新增——老档没有这个字段，migrate.ts 回填
   * `"player_normal"`（当时唯一的可操作态）。
   */
  inputState: PlayerInputState;
  /** 选牌屏；null ⟺ inputState 为 player_normal。第四批新增，老档回填 null。 */
  cardSelect: CardSelectInfo | null;
  /**
   * 取档瞬间动作队列里的残留动作（按出队顺序）。第四批新增，老档回填 `[]`。
   * player_normal 时恒为空；card_select 时至少有一条（见本节顶部注释）。
   */
  pendingActions: ActionDesc[];
  /**
   * 取档瞬间**出牌队列**里的残留项（按出队顺序）。第九批新增，老档回填 `[]`。
   * 只有「二连击的复制项 / 混乱排的第二张牌」这类嵌套出牌能让它非空，见本节顶部注释。
   */
  pendingCardQueue: CardQueueItem[];
  turn: number;
  player: CombatPlayer;
  monsters: CombatMonster[];
  hand: CombatCard[];
  drawPile: CombatCard[];
  discardPile: CombatCard[];
  exhaustPile: CombatCard[];
  /**
   * 在场的打击牌张数（第十一批新增，老档由 migrate 从牌堆 + 在飞牌重算）。
   * **不能**在 importState 里派生：它算上「已离开手牌、还没进弃牌堆」的在飞牌。
   */
  strikeCount: number;
  /**
   * 被青铜球停滞扣住的两张牌（第二十八批新增，老档由 migrate 回填 `[null, null]`）。
   *
   * 回填是**无损**的：唯一的写入点是青铜球的停滞，而那只怪本批才登记——
   * 在此之前任何老档里这两格都必然是空的（参考的初值同样是两个 `CardId::INVALID`）。
   */
  stasisCards: (CombatCard | null)[];
  monsterTurnIdx: number;
  endTurnQueued: boolean;
  turnHasEnded: boolean;
  nextUid: number;
  rng: CombatRngState;
};

const copyPowers = (powers: PowerInstance[]): PowerInstance[] => powers.map((p) => ({ ...p }));
/**
 * 深拷贝选牌屏（`cards` 是数组，浅拷贝会让快照与实例共享同一份）。
 * 存档必须与实例彻底脱钩，否则「取档之后继续打」会倒过来改掉已经导出的快照。
 */
const copyCardSelect = (info: CardSelectInfo | null): CardSelectInfo | null =>
  info === null
    ? null
    : { ...info, ...(info.cards === undefined ? {} : { cards: [...info.cards] }) };
const copyCards = (cards: CombatCard[]): CombatCard[] => cards.map((c) => ({ ...c }));
/** 深拷贝停滞槽（第二十八批）：定长 2 格，每格是一张牌或空。 */
const copyStasisCards = (cards: (CombatCard | null)[]): (CombatCard | null)[] =>
  cards.map((c) => (c === null ? null : { ...c }));
/** 深拷贝出牌队列项（`card` 是对象，浅拷贝会让快照与实例共享同一张牌）。 */
const copyCardQueueItems = (items: CardQueueItem[]): CardQueueItem[] =>
  items.map((it) => ({ ...it, card: it.card === null ? null : { ...it.card } }));

/**
 * 导出快照。只能在玩家可操作时取档（player_normal / card_select），且动作队列里的残留
 * 动作必须都带 ActionDesc——否则那条动作复原不出来，宁可当场炸掉也不留一个静默错的存档。
 */
export function exportState(bc: BattleContext): StsCombatState {
  if (bc.inputState !== "player_normal" && bc.inputState !== "card_select") {
    throw new Error(`exportState: 不在玩家可操作态（inputState=${bc.inputState}），不能取档`);
  }
  const pendingActions = bc.actionQueue.descriptors().map((desc, i) => {
    if (desc === null) {
      throw new Error(
        `exportState: 动作队列第 ${i} 条没有 ActionDesc，存档会丢掉它。` +
          `给对应的 addToBot/addToTop 补一个描述（见 ActionDesc 注释）。`,
      );
    }
    return desc;
  });
  return {
    seedLong: bc.seedLong.toString(),
    floorNum: bc.floorNum,
    ascension: bc.ascension,
    encounterId: bc.encounterId,
    character: bc.character,
    relics: bc.relics.map((r) => ({ ...r })),
    potions: [...bc.potions],
    potionCount: bc.potionCount,
    potionCapacity: bc.potionCapacity,
    outcome: bc.outcome,
    inputState: bc.inputState,
    cardSelect: copyCardSelect(bc.cardSelect),
    pendingActions,
    pendingCardQueue: copyCardQueueItems(bc.cardQueue.all()),
    turn: bc.turn,
    player: {
      ...bc.player,
      powers: copyPowers(bc.player.powers),
      relicBits: [...bc.player.relicBits],
    },
    monsters: bc.monsters.map((m) => ({
      ...m,
      moveHistory: [...m.moveHistory],
      powers: copyPowers(m.powers),
    })),
    hand: copyCards(bc.hand),
    drawPile: copyCards(bc.drawPile),
    discardPile: copyCards(bc.discardPile),
    exhaustPile: copyCards(bc.exhaustPile),
    strikeCount: bc.strikeCount,
    stasisCards: copyStasisCards(bc.stasisCards),
    monsterTurnIdx: bc.monsterTurnIdx,
    endTurnQueued: bc.endTurnQueued,
    turnHasEnded: bc.turnHasEnded,
    nextUid: bc.nextUid,
    rng: {
      aiRng: bc.rng.aiRng.toState(),
      monsterHpRng: bc.rng.monsterHpRng.toState(),
      shuffleRng: bc.rng.shuffleRng.toState(),
      cardRandomRng: bc.rng.cardRandomRng.toState(),
      miscRng: bc.rng.miscRng.toState(),
      potionRng: bc.rng.potionRng.toState(),
    },
  };
}

/** 从快照复原。RNG 走 fromState（O(1) 直接装回 seed0/seed1 与 counter，不重放）。 */
export function importState(s: StsCombatState): BattleContext {
  const actionQueue = new ActionQueue();
  actionQueue.replaceAll(s.pendingActions.map(actionFromDesc));
  const cardQueue = new CardQueue();
  cardQueue.replaceAll(copyCardQueueItems(s.pendingCardQueue));
  return {
    rng: {
      aiRng: StsRandom.fromState(s.rng.aiRng),
      monsterHpRng: StsRandom.fromState(s.rng.monsterHpRng),
      shuffleRng: StsRandom.fromState(s.rng.shuffleRng),
      cardRandomRng: StsRandom.fromState(s.rng.cardRandomRng),
      miscRng: StsRandom.fromState(s.rng.miscRng),
      potionRng: StsRandom.fromState(s.rng.potionRng),
    },
    seedLong: BigInt(s.seedLong),
    floorNum: s.floorNum,
    ascension: s.ascension,
    encounterId: s.encounterId,
    character: s.character,
    relics: s.relics.map((r) => ({ ...r })),
    potions: [...s.potions],
    potionCount: s.potionCount,
    potionCapacity: s.potionCapacity,
    outcome: s.outcome,
    // 存档点必然是玩家可操作态（见上方注释）：player_normal 或 card_select。
    inputState: s.inputState,
    cardSelect: copyCardSelect(s.cardSelect),
    turn: s.turn,
    actionQueue,
    cardQueue,
    player: {
      ...s.player,
      powers: copyPowers(s.player.powers),
      relicBits: [...s.player.relicBits],
    },
    monsters: s.monsters.map((m) => ({
      ...m,
      moveHistory: [...m.moveHistory],
      powers: copyPowers(m.powers),
    })),
    // 由存活位重算，不入档：与 monsters 冗余的字段存两份只会有对不上的风险。
    monstersAlive: s.monsters.filter((m) => m.alive).length,
    hand: copyCards(s.hand),
    drawPile: copyCards(s.drawPile),
    discardPile: copyCards(s.discardPile),
    exhaustPile: copyCards(s.exhaustPile),
    strikeCount: s.strikeCount,
    stasisCards: copyStasisCards(s.stasisCards),
    monsterTurnIdx: s.monsterTurnIdx,
    // 存档点恒空（见 `BattleContext.skipTurn` 的注释），所以不入档、直接重建成空集。
    skipTurn: new Set<number>(),
    endTurnQueued: s.endTurnQueued,
    turnHasEnded: s.turnHasEnded,
    nextUid: s.nextUid,
  };
}

// ============================================================================
// 覆盖面登记（供接线层判断「这场战斗能不能交给 sts-combat」）
//
// 判据只有一条：**有 trace 背书**。派生式判断（比如「编队里的怪都登记了就算支持」）
// 会把没对拍过的编队悄悄放进来——三邪教徒的成员全是已登记的邪教徒，但参考项目里
// 该编队的 createMonsters 我们从没验证过，放进来就是无声的赌博。
// ============================================================================

/**
 * 已有 trace 背书的编队。新增一批 trace 后往这里加一行。
 * `test/sts-combat-wiring.test.ts` 会与 `test/golden/traces/*.jsonl` 双向对齐，
 * 漏加或多加都会失败。
 */
export const SUPPORTED_ENCOUNTERS: readonly string[] = [
  "cultist",
  "jaw_worm",
  "jaw_worm_horde",
  "two_louse",
  "three_louse",
  // —— 第十三批 ——
  "small_slimes",
  "lots_of_slimes",
  // —— 第十四批 ——
  "large_slime",
  // —— 第十五批 ——
  "blue_slaver",
  "red_slaver",
  "looter",
  "exordium_thugs",
  // —— 第十六批 ——
  "exordium_wildlife",
  // —— 第十七批 ——
  "gremlin_gang",
  // —— 第十八批：第一幕三个精英 ——
  "gremlin_nob",
  "lagavulin",
  "three_sentries",
  // —— 第十九批：第一幕两个 Boss ——
  "the_guardian",
  "slime_boss",
  // —— 第二十批：第一幕最后一个 Boss（装完这一个，第一幕 20 个编队全部有背书）——
  "hexaghost",
  // —— 第二十三批：**第二幕开张**。harness 的编队循环从此有两个（第一幕那个一个字没动，
  //   traceIdx 接着往下走），本批先装三个单怪、无召唤、无塞牌的编队。
  //   ✅ 第三十批补上了 asc19（三只怪的 `ascCalibrated` 已置，选民与食蛇草 `getMoveForRoll`
  //     里那两整块 asc17 也一并转写了）。
  "spheric_guardian",
  "chosen",
  "snake_plant",
  // —— 第二十四批：飞行（拜鸟）+ 劫匪。三个编队走 harness 新追加的 variant 24，
  //   牌组是 `BATCH_1 + SPOT_WEAKNESS`——多的那一张让 `isMonsterAttacking` 第一次有预言机。
  //   ✅ 第三十批补上了 asc19（拜鸟与劫匪的 `ascCalibrated` 已置）。
  "three_byrds",
  "two_thieves",
  "chosen_and_byrds",
  // —— 第二十五批：镀甲（带壳寄生虫）+ 困惑（史尼克）。三个编队走 harness 新追加的
  //   variant 25，牌组同样是 `BATCH_1 + SPOT_WEAKNESS`（`isMonsterAttacking` 的背书）。
  //   ⚠ 编队 id 是 `shell_parasite`（没有 ED），对齐参考的 `MonsterEncounter::SHELL_PARASITE`
  //     ——它建的怪才叫 `SHELLED_PARASITE`。
  //   ✅ 第三十批补上了 asc19（带壳寄生虫与史尼克的 `ascCalibrated` 已置）。
  "shell_parasite",
  "shelled_parasite_and_fungi",
  "snecko",
  // —— 第二十六批：友方增益（百夫长 + 秘法师）+ 三个「已登记怪的新组合」。走 harness 新
  //   追加的 variant 26，牌组同样是 `BATCH_1 + SPOT_WEAKNESS`。
  //   ⚠ 两个编队 id 跟着参考枚举名改过：`centurion_and_healer`（原 `centurion_mystic`）、
  //     `three_cultist`（**单数**，原 `three_cultists`）。
  //   ✅ 第三十批补上了 asc19（百夫长与秘法师的 `ascCalibrated` 已置）。
  "centurion_and_healer",
  "three_cultist",
  "cultist_and_chosen",
  "sentry_and_sphere",
  // —— 第二十七批：**召唤**（地精首领）+ 两个第二幕精英编队。走 harness 新追加的
  //   variant 27，牌组同样是 `BATCH_1 + SPOT_WEAKNESS`。
  //   ⚠ `gremlin_leader` 是第一个**开局就留空位**的编队（0 号位空、`monsterCount = 4`），
  //     `slavers` 的顺序是**蓝奴隶主 / 工头 / 红奴隶主**（工头在中间）。
  //   ✅ 第三十批补上了 asc19（地精首领与工头的 `ascCalibrated` 已置；工头 asc18 那条
  //     入队自身 buff 也一并补上了）。
  "gremlin_leader",
  "slavers",
  // —— 第二十八批：突刺之书（第二幕最后一个精英）+ 青铜自动机（第二个召唤宿主）。
  //   走 harness 新追加的 variant 28，牌组同样是 `BATCH_1 + SPOT_WEAKNESS`。
  //   ⚠ `automaton` 是**编队** id（对齐 `MonsterEncounter::AUTOMATON`），它建的**怪**
  //     才叫 `bronze_automaton`；0 号位与 2 号位都是预留空位（`monsterCount = 3`、
  //     `monstersAlive = 1`），由 `spawnBronzeOrbs` 往里填。
  //   ✅ 第三十批补上了 asc19（三只新怪的 `ascCalibrated` 已置）。
  "book_of_stabbing",
  "automaton",
  // —— 第二十九批：第二幕最后两个 Boss（**第二幕 19 / 19 收官**）。走 harness 新追加的
  //   variant 29，牌组同样是 `BATCH_1 + SPOT_WEAKNESS`。
  //   ⚠ `collector` 是**编队** id（对齐 `MonsterEncounter::COLLECTOR`），它建的**怪**
  //     才叫 `the_collector`；0 号位与 1 号位都是预留空位、收藏家在**2 号位**
  //     （`monsterCount = 3` / `monstersAlive = 1`），由 `summonTorchHeads` 往里填。
  //   ✅ 第三十批补上了 asc19（冠军 / 收藏家 / 火炬头的 `ascCalibrated` 已置）。
  "champ",
  "collector",
  // —— 第三十二批：**第三幕开张**。harness 追加了**第四个乘积**
  //   `emitProduct(act3Variants, act3Encounters)`，排在目标策略那个之后
  //   （加空乘积时单独跑过一次 `--check`，101 个已提交文件逐字节复现）。
  //   ⚠⚠ 第三幕做完之前，**不许再往它后面挂新乘积**：每一批第三幕都往 `act3Variants`
  //     追加一个 variant，而往「不是最后一个」的乘积里追加会平移其后所有 `traceIdx`。
  //   本批装三个「形状怪」编队（走 variant 32，牌组 `BATCH_1 + SPOT_WEAKNESS`、40 种子、
  //   asc0、目标策略 0）。
  //   ⚠ `three_shapes` / `four_shapes` 走 `createShapes`（6 项池、**不放回**），
  //     `sphere_and_two_shapes` 走两次 `getAncientShape`（3 项表、**有放回**）——
  //     两条路径不共用，见 `ENCOUNTER_BUILDERS`。
  //   ⚠ 三个编队**只有 asc0 的背书**：三只新怪的 `ascCalibrated` 一只都没置
  //     （尖刺客的荆棘 `{3,4,7}` 三档一条都没有预言机），`constructMonster` 在
  //     `ascension > 0` 下照旧抛错。
  "three_shapes",
  "four_shapes",
  "sphere_and_two_shapes",
  // —— 第三十三批：第三幕三个**单怪**编队（走 harness 新追加的 variant 33，variant 32 的
  //   encounters 一个字没动，那三个文件逐字节不变）。牌组沿用 `BATCH_1 + SPOT_WEAKNESS`、
  //   40 种子、asc0、目标策略 0。
  //   选它们是因为三只怪**全由已登记的原语拼成**，一个新机制都不带：
  //   ⚠ `orb_walker` 是 `hpDiscardRoll` 的**正主**（建怪掷 2 次 monsterHpRng）+
  //     `GENERIC_STRENGTH_UP` 的**唯一宿主**（回合末 +3 力量）；它的激光同时往**抽牌堆**
  //     与**弃牌堆**各塞一张灼伤。
  //   ⚠ `spire_growth` 带来 **CONSTRICTED**（玩家回合末非攻击伤害，不递减不摘除）。
  //   ⚠ `maw` 是**编队** id（对齐 `MonsterEncounter::MAW`），它建的**怪**才叫 `the_maw`；
  //     它是 `hpNoRoll` 的**第二个宿主**，一次 monsterHpRng 都不掷，吞噬的段数是
  //     `(怪物回合数 + 1) / 2`。
  //   ⚠ 三个编队**只有 asc0 的背书**：三只新怪的 `ascCalibrated` 一只都没置。
  "orb_walker",
  "spire_growth",
  "maw",
  // —— 第三十四批：第三幕的**两条死亡 / 回合边界机制**（走 harness 新追加的 variant 34，
  //   variant 33 的 encounters 一个字没动，那三个文件逐字节不变）。牌组沿用
  //   `BATCH_1 + SPOT_WEAKNESS`、40 种子、asc0、目标策略 0。
  //   ⚠ `three_darklings` 带来 **REGROW + 半死（`halfDead`）**：`Monster::die` 的
  //     else-if 链第二格（孢子云与停滞之间），以及 `isDeadOrEscaped` 的第三位——
  //     它是**第十五批做逃跑时点名跳过**的那一位，本批结清。
  //     三只暗影客互为同伴，所以「有人还活着时死掉」是常态，重生天然可观察。
  //   ⚠ `transient` 带来 **SHIFTING**（受击把伤害转成 −力量 + 等量枷锁，
  //     `attackedUnblockedHelper` 那条 else-if 链的**最后一格**，另有 `damageUnblockedHelper`
  //     里的独立 if）与 **FADING**（层数 = 还能出手几次，归零那一次自杀）。
  //     它还是 `hpNoRoll` 的**第三个也是最后一个**宿主（999 血、一次 monsterHpRng 都不掷），
  //     并且是主循环那道「打不赢了」判负门上唯一的怪种例外。
  //   ⚠ 两个编队**只有 asc0 的背书**：两只新怪的 `ascCalibrated` 一只都没置。
  "three_darklings",
  "transient",
  // —— 第三十五批：`attackedUnblockedHelper` 那一格的**另一半**（反应）与第一条
  //   「按出牌数放大受伤」的 Power（缓慢）。走 harness 新追加的 variant 35
  //   （variant 34 的 encounters 一个字没动，那两个文件逐字节不变）。牌组沿用
  //   `BATCH_1 + SPOT_WEAKNESS`、40 种子、asc0、目标策略 0。
  //   ⚠ `writhing_mass` 是**全参考项目唯一同时带易塑与反应的怪**——而那两条 Power 在
  //     `attackedUnblockedHelper` 的 else-if 链上**共用同一格**
  //     （`hasStatus<MALLEABLE>() || hasStatus<REACTIVE>()`，Monster.cpp:369-383）。
  //     第二十三批装食蛇草时只写了易塑那一半并留了账，本批结清。
  //     反应还带来本项目**第一条「挨打就重滚意图」**的动作（`Actions::ReactiveRollMove`）。
  //     它的出招规则是全参考项目最复杂的一个：`while(true)` + 五段并列的 if + 两处 `continue`，
  //     单次 rollMove 的 aiRng 消耗从 1 到七八次不等。
  //   ⚠ `giant_head` 带来 **SLOW**：三处协同（出牌 +1 / 伤害 ×(1+0.1N) / 回合末清零），
  //     而且是本项目第一条挂在 `onAfterUseCard` 那条共享路径上的怪物侧 Power。
  //     它的「时候到了」还是第一条**封顶回合成长**的伤害（`monsterTurnRamp`，且首击为负偏移）。
  //   ⚠ 两个编队**只有 asc0 的背书**：两只新怪的 `ascCalibrated` 一只都没置。
  "writhing_mass",
  "giant_head",
  // —— 第三十六批：第三幕两个**精英**（走 harness 新追加的 variant 36，variant 35 的
  //   encounters 一个字没动，那两个文件除了萎缩补丁引起的 `writhing_mass` 之外逐字节不变）。
  //   牌组沿用 `BATCH_1 + SPOT_WEAKNESS`、40 种子、asc0、目标策略 0。
  //   ⚠ `nemesis` 带来**怪物侧 INTANGIBLE**：四处协同——`Monster::attacked` 与
  //     `Monster::damage` 的入口各把伤害压成 1（**排在狂怒之前、格挡吸收之前**）、
  //     `calculateCardDamage` 末尾 `max(damage, 1.0f)`（**下限**，在飞行之后）、
  //     `applyEndOfTurnTriggers` 的第四句无条件递减。而它自己三条 case 的尾部各有一句
  //     `if (!hasStatus<INTANGIBLE>())` 补层——**三条的入队 / 同步形状两两不同**。
  //   ⚠ `reptomancer` 带来**召唤的第四族**（`Monster::reptomancerSummon`）与
  //     **预留空位的第四种写法**（0 与 3 号位空、两把匕首在 1 / 4、法师在中间的 2 号位、
  //     `monsterCount = 5`），外加全参考项目唯一的 `skipTurn` 写入点。
  //     它还是 `hpDiscardRoll` 四个宿主里最后一个被登记的。
  //   ⚠ `dagger` 是第一个**既预置又召唤**的怪（青铜球 / 火炬头都只有召唤这一个来源），
  //     它的自爆是「打人 + `SuicideAction`」这一族里**走攻击路**的那一支，与爆破怪相反。
  //   ⚠ 两个编队**只有 asc0 的背书**：三只新怪的 `ascCalibrated` 一只都没置。
  "nemesis",
  "reptomancer",
  // —— 第三十七批：第三幕 Boss **觉醒者**（走 harness 新追加的 variant 37，variant 36 的
  //   encounters 一个字没动，那两个文件逐字节不变）。40 种子、asc0、目标策略 0。
  //   ⚠⚠ **这是第一个不用 `BATCH_1 + SPOT_WEAKNESS` 的第三幕 variant**，而且理由是量出来的：
  //     那副 22 张牌组下战斗平均只有 **3.6 回合**、120 条 trace **一次都没打死过一阶段**，
  //     `REBIRTH` / `DARK_ECHO` / `SLUDGE` / `TACKLE` 四条招式全是「出现 0 / 执行 0」。
  //     改用 45 张的**全升级**聚焦牌组（BATCH_1 + 4×觅敌之弱 + 2×极限突破 + 4×幽灵护甲 +
  //     4×铜头 + 2×收割 + 2×剑刃回旋 + 2×直觉 + 2×灵巧 + 2×钢铁闪光）之后：平均 8.7 回合、
  //     45 / 120 条走到假死、六条招式全部出现且执行。理由与「聚焦小牌组」那条逃生口同族，
  //     只是这次为的是**怪物**覆盖而不是卡牌覆盖。牌组形状的两条约束见 harness 的注释：
  //     ① 策略严格从左往右花能量 → **3 费牌几乎打不出来**（恶魔形态 / 壁垒实测毫无作用）；
  //     ② `upgradeAll` 让极限突破**不再消耗**，那是整套力量引擎的发动机。
  //   ⚠ `awakened_one` 是**三只怪**（邪教徒 ×2 + 觉醒者，觉醒者在 **2 号位**），
  //     不是旧近似表写的单怪。
  //   ⚠ 它带来 **`Monster::die` 的第一个分支**（假死 / 两阶段 Boss）——那是这条链上
  //     **唯一排在判胜 `return` 之前**的一格，与暗影客的重生（在 `return` 之后）正好相反。
  //     另有 **CURIOSITY**（参考里读点被整段注释掉的纯标记）与 **REGEN**（怪物侧、一层不掉）
  //     两个新 Power，以及第一张「抽到时有效果」的状态牌**虚无**（抽到 -1 能量）。
  //   ⚠ 这个编队**只有 asc0 的背书**：觉醒者的 `ascCalibrated` 没有置。
  "awakened_one",
  // —— 第三十八批：第三幕 Boss **时间吞噬者**（走 harness 新追加的 variant 38，
  //   variant 37 的 encounters 一个字没动，`awakened_one.jsonl` 逐字节不变）。
  //   40 种子、**爬升度 0**、**目标策略 0**。
  //   ⚠⚠ 它带来 **TIME_WARP**——本项目第一条**改回合结构**的 Power：玩家每打出 12 张牌，
  //     这只怪 +2 力量并**当场结束玩家回合**（`BattleContext::callEndTurnEarlySequence`，
  //     BattleContext.cpp:2152）。读点与缓慢同在 `onAfterUseCard` 那条共享出牌路径上，
  //     顺序是**时间扭曲 → 缓慢 → 死亡节拍**（第三条是第四幕的，留 TODO）。
  //   ⚠ 另外三样都是新的：`Player::debuff<DRAW_REDUCTION>`（数值住在 `cardDrawPerTurn`、
  //     Power 本身只是 bool 标记，回合开始 skipFirst 归还）、
  //     `set_hp_half_max`（加速那句 `curHp = maxHp / 2`，赋值而非 heal）、
  //     以及 `minAscension` 从 `apply_power` 铺到 `gain_block` / `add_card`。
  //   ⚠⚠ **牌组是本批第二次为「让新代码被走到」而设计的**（第一次是第三十七批）：
  //     `BATCH_1 + SPOT_WEAKNESS`（22 张）下时间吞噬者 **120 / 120 条一次都没掉到半血**，
  //     `TIME_EATER_HASTE` 出现 0 / 执行 0。最终用的是 59 张全升级牌组，见 harness 注释。
  //     牌组里的浩劫 ×4 与二连击 ×2 是**专为 `callEndTurnEarlySequence` 的排空循环加的**
  //     ——它们是全项目仅有的两种「出牌队列里还压着东西」的产出者。
  //   ⚠ 这个编队**只有 asc0 的背书**：时间吞噬者的 `ascCalibrated` 没有置。
  "time_eater",
  // —— 第三十九批：第三幕 Boss **迪卡与多努**，第三幕收官（16 / 16）。走 harness 新追加的
  //   variant 39（variant 38 的 encounters 一个字没动，`time_eater.jsonl` 逐字节不变）。
  //   40 种子、**爬升度 0**、**目标策略 0**。
  //   ⚠⚠ **编队 id 与建怪顺序相反**：`MonsterEncounter::DONU_AND_DECA` 建的是
  //     `createMonster(DECA); createMonster(DONU);`（MonsterGroup.cpp:235-238）
  //     ——**迪卡在 0 号位、多努在 1 号位**。两只怪身上写死的下标全靠这个顺序。
  //   ⚠⚠ 它带来的不是新机制，而是**第二十六批那三条「写死下标」原语的反例**：
  //     百夫长 / 秘法师那三招全都带 `monstersAlive > 1` 的门，而这两只**一道门都没有**
  //     （参考还在多努那句行尾自注 `// shouldn't matter if deca is dead`）。
  //     `buff_ally` 因此多了一位 `noAliveGate`，与第二十八批青铜球给
  //     `gain_block_ally_fixed` 加的那一位同名同形——但**这一位真的走到了 false 侧**
  //     （策略恒打 0 号位 → 迪卡先死 56 / 120，多努照样给尸体 +3 力量）。
  //   ⚠ 四条 case 的收尾**全是同步 `setMove`**，整场仗除开局那两次 rollMove 之外
  //     **一次 aiRng 都不掷**——全参考唯一一个「全员静态循环」的编队。
  //   ⚠ 牌组沿用**第三十八批那 59 张全升级**的（逐字节相同）。两者指纹相同，所以
  //     encounters 必须互不相交：variant 38 只点名 `TIME_EATER`、这个只点名
  //     `DONU_AND_DECA`，成立。理由与七副候选牌组的实测对比见 TODOS。
  //   ⚠ 这个编队**只有 asc0 的背书**：两只怪的 `ascCalibrated` 都没有置
  //     （神器 3 层、光束 12 点、守护方阵那两句 asc19 镀甲一条都没有预言机）。
  "donu_and_deca",
  // —— 第四十七批乙：**第四幕两个 + 蒙面强盗**，`MOVE_RULES` 就此 65 / 65（怪物线收官）。
  //   走 harness 新开的**第九个乘积** `act4Variants`（两个 variant，各钉死遗物与药水，
  //   所以它既不冻结前面的乘积、也不被它们冻结）。40 种子、爬升度 0、目标策略 0。
  //
  //   `shield_and_spear`（尖塔护盾 0 号位 + 尖塔长矛 1 号位）带来三样新东西：
  //   ⚠⚠ ① **被围攻（SURROUNDED）**——全参考唯一一处「怪物的 `preBattleAction` 给玩家
  //        上 Power」，而它的唯一读点 `Monster::calculateDamageToPlayer` 读的是一个此前
  //        **从没有人读过的字段** `Player::lastTargetedMonster`（初值 **1**）。
  //        于是「你没在打的那只怪从背后打你 ×1.5」第一次有了预言机：护盾在 0 号位、
  //        长矛在 1 号位，而策略的攻击恒落在 0 号位 ⇒ **长矛的每一击都 ×1.5、护盾的不**，
  //        护盾一死（实测 26 / 120）长矛那一半也随之关掉（`isDeadOrEscaped` 那个析取项）。
  //   ② **`deal_damage_block_equal`**（重砸：格挡 = 这一击**算完之后**的伤害输出）；
  //   ③ 加固 / 穿刺分别复用迪卡的 `gain_block_ally_fixed` 与多努的 `buff_ally`
  //      ——两条**都不带存活门**，与第二十六批百夫长 / 秘法师那三条正相反。
  //
  //   `the_heart`（腐化之心，单怪）带来的是**两条共享路径上的最后两个格子**：
  //   ⚠⚠ ④ **无敌（INVINCIBLE）**——`attackedUnblockedHelper` 那条 else-if 链的**第一格**。
  //        第三十五批点名过「链上现在只剩第一格没有宿主（腐化之心）」，本批把它填上，
  //        **整条链八格第一次全部有背书**。它同时住在 `damageUnblockedHelper` 的链首与
  //        `applyPreTurnLogic` 的第四段（每个怪物回合复位回 300）。
  //   ⚠ ⑤ **死亡节拍（BEAT_OF_DEATH）**——`onAfterUseCard` 那道 `triggerOnUse` 门里的
  //        **第三条**（第三十八批做时间扭曲时留的 `TODO(后续PR)`），顺序是
  //        时间扭曲 → 缓慢 → 死亡节拍。
  //   ⚠⚠ **牌组是本项目第三次为「让新代码被走到」而设计，也是第一次往弱里挑**：
  //     腐化之心 750 血 + 无敌 300 ⇒ 强牌组三个回合就打完，而「强化」那一招的档位由
  //     `getMonsterTurnNumber() / 3` 决定（第 3 / 6 / 9 / 12 个怪物回合各一档）。
  //     打得快与死得快**都会**压低回合数，所以这个 variant 用的是一副**只防不攻**的
  //     40 张全升级牌组（10 铁壁 + 8 幽灵护甲 + 4 耸肩 + 4 包扎 + 2 金属化 + 2 觅敌之弱），
  //     实测平均 5.73 个怪物回合、最长 10。逐副候选的对比表见 harness 注释与 TODOS。
  //   ⚠ 代价：**没有任何候选牌组能把无敌打到 0**（最强的一副也只到 14 / 300），
  //     所以 `min(damage, invincible)` 那道**钳制**在本批是盲区；钳制之外的
  //     「逐击递减」与「每回合复位」两半都有背书。
  //
  //   `masked_bandits_event`（尖头怪 0 / 罗密欧 1 / 熊 2）是**第一个事件专属编队**：
  //   它不在任何 `MonsterEncounterPool` 里，run 层的事件也还没接线，所以它当前只有
  //   trace 这一条到达路径。三只怪的出招规则都是常量、收尾全是同步 `setMove` 或
  //   干脆没有 —— 整个编队开局三次 rollMove 之后 `rng.ai` 再也不动。
  //   ⚠ 我们这边原先有一条**错的** `masked_bandits`（劫掠者 ×2 + 抢劫者，旧近似表编的），
  //     本批按参考改名 + 改成员，`events.ts` 的引用跟着改（同第二十五批 `shell_parasite`
  //     那次改名的理由：编队 id 必须与参考枚举同名，trace 文件名就是它）。
  //   ⚠ 这三个编队**都只有 asc0 的背书**：六只怪的 `ascCalibrated` 一只都没有置。
  "shield_and_spear",
  "the_heart",
  "masked_bandits_event",

  // —— 第四十八批：最后六个编队，「编队」这一栏收官 63 / 63 ——
  //
  // ⚠⚠ **本批一只新怪都没有**：六个编队全部由已登记的 65 只怪拼成，所以 `MOVE_RULES` /
  //   `MONSTER_ATTACK_MOVES` / `enemies.ts` 的招式数值一个字都不用改。这也正是它便宜的原因
  //   ——第四十七批收官怪物线之后，剩下的只是「参考建了哪几只、什么顺序」。
  // ⚠ 六个都走 `initCombat` 的**默认建怪路径**（照 `ENCOUNTERS[id].enemies` 逐只
  //   `createMonster`），一条 `ENCOUNTER_BUILDERS` 都不用加：参考那六条 case 本身就只是
  //   两三句 `createMonster`，没有候选池、没有预留空位、没有 `miscRng`。
  //   ⚠ **唯一一处「像是要写 builder、其实不要」的是事件版拉加维林**：它与 `lagavulin`
  //     的差别是那条 `setHasStatus<ASLEEP>(true)`，而那一句住在 `ENCOUNTER_SETUP.lagavulin`
  //     ——按**编队 id** 索引，所以 `lagavulin_event` 天然取不到它。第十八批那条注释
  //     （「将来装它时不必再改」）本批兑现，实现侧真的一行没改。
  //
  // 本批关掉的三条老盲区（都是「结构性无宿主」，不是薄）：
  //   ① **金属化以睡着为前提**（第十八批留的账）——`lagavulin_event` 是唯一不置沉睡位的
  //      编队，于是 `preBattleAction` 那道 `if (hasStatus<ASLEEP>())` 第一次有了假分支。
  //   ② **激怒的宿主不在 0 号位**（第十八批留的账）——`colosseum_event_nobs` 里工头 0、
  //      头目 1，而 `gremlin_nob` 是单怪编队、`slavers` 里没有头目。
  //   ③ **孢子云在同伴还活着时触发**（第十六 / 二十五批留的账）——`two_fungi_beasts`（2 只）
  //      与 `mushrooms_event`（3 只）是全参考仅有的两个「多只真菌兽」编队。
  //
  // ⚠ 六个都只有 **asc0** 的背书（本批不叠第二条轴，第三十一批的教训）。它们的怪虽然
  //   `ascCalibrated` 早就置起来了（第一 / 二幕那两批），但**编队级**的 `ASC_SUPPORTED_ENCOUNTERS`
  //   这道闸门仍然拦着它们——要开得再来一批 `@asc19`。
  "two_fungi_beasts",
  "lagavulin_event",
  "colosseum_event_slavers",
  "colosseum_event_nobs",
  "mushrooms_event",
  "mysterious_sphere_event",
];

export function isEncounterSupported(encounterId: string): boolean {
  return SUPPORTED_ENCOUNTERS.includes(encounterId);
}

/**
 * 爬升度分档**已有 trace 背书**的编队（第二十一批 14 个普通编队 + 第二十二批
 * 三精英 + 三 Boss = 第一幕 20 个编队；**第三十批把第二幕 19 个全铺上**）。
 *
 * ⚠ 与 `SUPPORTED_ENCOUNTERS` 是两条独立的轴：一个编队可以「asc0 有背书」而
 * 「asc>0 没有」。两张表现在恰好同集合，但**不要合并**——第三幕的编队装进
 * `SUPPORTED_ENCOUNTERS` 时，它的 asc 分档仍然要单独一批才有预言机。
 *
 * ⚠ 「有背书」只到「每条 `asc >= N` 的高侧」这一层：档位是 `{0, 19}` 这一对，
 * 所以「分界恰好在 N」与「三档里的中间那一档」都还是盲区，关门条件见 TODOS
 * （跨两幕的 `asc7 + asc16` 那一批）。
 *
 * 真正的兜底在 `constructMonster`（按**怪**查 `EnemyDef.ascCalibrated`，直接抛错）：
 * 这里是编队粒度的**事前**判断，好让 run 层能在开战前就说「这场打不了」。
 * 两处必须一起改；`test/sts-combat-wiring.test.ts` 有一条用例把它们对起来。
 */
export const ASC_SUPPORTED_ENCOUNTERS: readonly string[] = [
  "cultist",
  "jaw_worm",
  "jaw_worm_horde",
  "two_louse",
  "three_louse",
  "small_slimes",
  "lots_of_slimes",
  "large_slime",
  "blue_slaver",
  "red_slaver",
  "looter",
  "exordium_thugs",
  "exordium_wildlife",
  "gremlin_gang",
  // —— 第二十二批：三个精英（血量阈值 asc>=8、数值档 asc3/asc18）——
  "gremlin_nob",
  "lagavulin",
  "three_sentries",
  // —— 第二十二批：三个 Boss（血量阈值 asc>=9、数值档 asc4/asc19）——
  "the_guardian",
  "slime_boss",
  "hexaghost",
  // —— 第三十批：**第二幕 19 个编队全部铺上 asc19**（harness 的 variant 30，一个档位）——
  //   17 只怪的 `ascCalibrated` 同批置起，三族阈值各自校准：普通怪血量 asc>=7 /
  //   精英 asc>=8 / Boss asc>=9，数值档 `getTriIdx(asc,2,17)` / `(3,18)` / `(4,19)`。
  //   ⚠ 顺序照 `act2Encounters`（5 weak + 8 strong + 3 elite + 3 boss）。
  "spheric_guardian",
  "chosen",
  "shell_parasite",
  "three_byrds",
  "two_thieves",
  "chosen_and_byrds",
  "sentry_and_sphere",
  "cultist_and_chosen",
  "three_cultist",
  "shelled_parasite_and_fungi",
  "snecko",
  "snake_plant",
  "centurion_and_healer",
  "gremlin_leader",
  "slavers",
  "book_of_stabbing",
  "champ",
  "collector",
  "automaton",
  // —— 第四十六批：**第三幕 15 个编队铺上 asc19**（harness 的第七个乘积）——
  //   17 只怪的 `ascCalibrated` 同批置起，三族阈值仍然逐只对着 `Monster::initHp` 抄：
  //   普通怪 asc>=7（爆破 / 斥力 / 尖刺 / 暗球游荡者 / 尖塔增生 / 暗影客 / 蠕动血块）、
  //   精英 asc>=8（巨头 / 复仇魔 / 蜥蜴法师 / **匕首**）、
  //   Boss asc>=9（觉醒者 / 时间吞噬者 / 迪卡 / 多努）、
  //   `hpNoRoll` 两只（大嘴 / 复形怪）**没有第二组区间**。
  //   ⚠ **匕首是精英档**，尽管它是随从——与第三十批的火炬头（Boss 档的随从）同一个坑，
  //     判据永远是「它落在 `Monster::initHp` 的哪一组 case 里」，不是「它是不是随从」。
  //   ⚠ 第十六个第三幕编队 `jaw_worm_horde` **不在这里新增**：它自第一个 commit 起就在
  //     第一幕那份冻结的 `encounters` 里，`jaw_worm_horde@asc19` 第二十一批就装好了
  //     （上面第三行）。
  //   ⚠ 顺序照 harness 的 `act3Encounters`（3 weak + 6 strong + 3 elite + 3 boss）。
  "three_darklings",
  "orb_walker",
  "three_shapes",
  "spire_growth",
  "transient",
  "four_shapes",
  "maw",
  "sphere_and_two_shapes",
  "writhing_mass",
  "giant_head",
  "nemesis",
  "reptomancer",
  "awakened_one",
  "time_eater",
  "donu_and_deca",
  // —— 第五十二批：第四幕 + 蒙面强盗的 asc19（六只怪的 `hpHigh` / `ascCalibrated` 同批补齐）——
  // ⚠ 三个编队的阈值**三档并存**：尖塔护盾 / 长矛是精英族 `asc >= 8`，腐化之心是 Boss 族
  //   `asc >= 9`，三只强盗是普通怪族 `asc >= 7`。asc19 一次点亮三族的高侧。
  "shield_and_spear",
  "the_heart",
  "masked_bandits_event",
];

/** 这个编队在这个爬升度下有没有背书。asc0 恒等于 `isEncounterSupported`。 */
export function isEncounterAscSupported(encounterId: string, ascension: number): boolean {
  return ascension === 0 || ASC_SUPPORTED_ENCOUNTERS.includes(encounterId);
}

export function isCardSupported(defId: string): boolean {
  return CARD_RULES[defId] !== undefined;
}

export function isPotionSupported(potionId: string): boolean {
  return POTION_RULES[potionId] !== undefined;
}

/**
 * 战斗内行为已转写的遗物 = 三张时点表的并集 **∪ `RELIC_OTHER_HOOKS`**。
 *
 * ⚠ 第四项是第四十批加的：那一批的四个遗物（地精之角 / 手钻 / 御守 / 暗石护符）在
 * `initRelics` 里**一个字都没有**，它们的钩子分别挂在 `Monster::die`、两条伤害路径、
 * 以及蠕动血块的植入上；第四十一批的四颗计数遗物同理（挂在 `onUseAttackCard` /
 * `onUseSkillCard` 上）。只看时点表会把它们报成「没登记」。
 * ⚠ `RELIC_AT_TURN_START` 里现在有硫磺与橙色药丸，两颗都同时出现在别的表里
 * （硫磺在 `RELIC_IMMEDIATE`、橙色药丸在 `RELIC_OTHER_HOOKS`）——这一项因此仍然是冗余的，
 * 但漏写它会在下一颗「只在回合开始有效」的遗物上静默失效。
 * ⚠ 第四十二批起 `RELIC_AT_TURN_START` 是**有序数组**（照抄参考那串并列 `if` 的书写顺序），
 * 所以这里查的是 `some`，不再是下标。
 */
export function isRelicSupported(relicId: string): boolean {
  return (
    RELIC_IMMEDIATE[relicId] !== undefined ||
    RELIC_AT_BATTLE_START[relicId] !== undefined ||
    RELIC_AT_TURN_START_POST_DRAW_INIT[relicId] !== undefined ||
    RELIC_AT_TURN_START.some(([id]) => id === relicId) ||
    RELIC_OTHER_HOOKS.has(relicId)
  );
}

/**
 * 出招规则（`MOVE_RULES`）已转写的全部怪物 id（第四十七批）。
 *
 * ⚠⚠ **它存在的理由是一条用例失去了样本**。`initCombat` → `rollMove` 里那句
 * 「暂未登记怪物 rollMove」的 throw 此前由 `sts-combat-rules.test.ts` 直接测：
 * 拿一只「在 `enemies.ts` 里、却不在 `MOVE_RULES` 里」的怪去开战。第四十七批把
 * `MOVE_RULES` 铺到 **65 / 65**（参考的 `MonsterId` 一共就 65 项）之后，
 * **这样的怪一只都不存在了**——而 WORKFLOW 明确禁止「造一只游戏里不存在的哨兵怪」。
 *
 * 于是那条用例改成断言**让那道 throw 不可达的不变量本身**：`ENEMIES` 与这份名单
 * 双向相等。它比原来那条样本用例**更强**（原来只证明「有一只没登记的会抛错」，
 * 现在证明「一只没登记的都没有」），而且**不会再被下一批顶掉**。
 * ⚠ 那道 throw 本身**留着**：它守的是「参考将来加了第 66 只怪、我们只补了数据表」
 * 这种情况，那时这条不变量会先红。
 */
export const SUPPORTED_MONSTER_IDS: readonly string[] = Object.keys(MOVE_RULES);

/**
 * 战斗内行为已转写的全部遗物 id（`isRelicSupported` 的枚举版）。
 *
 * ⚠ 存在的理由是 `test/data-tables.test.ts` 那条**永久**用例：凡是这里出现的 id，
 * 都必须在 `relics.ts` 的数据表里。第四十三批的 `bloody_idol` 就是反例——战斗内登记了、
 * 对拍有 136 例背书，`relics.ts` 里却没有这个条目，于是真实引擎里玩家永远拿不到它
 * （「预言机侧可达、产品侧不可达」）。谓词形式的 `isRelicSupported` 挡不住这种事，
 * 因为它需要先知道要问哪个 id。
 */
export const SUPPORTED_RELIC_IDS: readonly string[] = [
  ...new Set([
    ...Object.keys(RELIC_IMMEDIATE),
    ...Object.keys(RELIC_AT_BATTLE_START),
    ...Object.keys(RELIC_AT_TURN_START_POST_DRAW_INIT),
    ...RELIC_AT_TURN_START.map(([id]) => id),
    ...RELIC_OTHER_HOOKS,
  ]),
];

/**
 * 战斗结束时把战斗内的计数器写回遗物的 `data`（对齐
 * `BattleContext::updateRelicsOnExit`，BattleContext.cpp:521-570）。
 *
 * 参考那个函数是 `for (auto &r : g.relics.relics) switch (r.id)`，八格：
 * ```cpp
 * HAPPY_FLOWER   : r.data = player.happyFlowerCounter;
 * INCENSE_BURNER : r.data = player.incenseBurnerCounter;
 * INK_BOTTLE     : r.data = player.inkBottleCounter;
 * INSERTER       : r.data = player.inserterCounter;
 * NEOWS_LAMENT   : if (r.data > 0) { --r.data; }
 * NUNCHAKU       : r.data = player.nunchakuCounter;
 * PEN_NIB        : r.data = (player.penNibCounter == -1) ? 9 : player.penNibCounter;
 * SUNDIAL        : r.data = player.sundialCounter;
 * LIZARD_TAIL    : if (!player.hasRelic<LIZARD_TAIL>()) { r.data = 0; }
 * ```
 * ⚠ 四处照抄：
 *  ①⚠⚠ **尼奥的挽歌那一格与别人不同**：它不读任何计数器，而是把自己的 `data` 减 1
 *     （参考在 `initRelics` 那一格的行尾自注 `// remember to decrement somewhere else`）。
 *     所以「接下来 3 场战斗」是靠这一句实现的，与战斗内发生了什么无关。
 *  ②⚠⚠ **笔尖那一格把 -1 写回成 9**（参考自注 `// possible bug`）：战斗内数到 9 时
 *     `penNibCounter = -1` 表示「强化已发出」，写回 9 意味着**下一场开局又直接带一层笔尖**。
 *     看着像 bug，但它就是参考的行为，而且真实游戏里笔尖确实是「跨战斗计数、第 10 张翻倍」。
 *  ③ **蜥蜴尾**那一格读的是玩家那份位集合：复活用掉之后 `setHasRelic(false)`，
 *     于是 `data` 归零 = 这颗遗物此后永久失效（真实游戏里它变成灰色）。
 *  ④ 御守的递减**不在这个函数里**：它在 `exitBattle` 的**第一句**、且只在蠕动血块植入过
 *     寄生虫时才跑（BattleContext.cpp:461-468），见 `combat-bridge.settleCombat`。
 *
 * ⚠⚠ **这个函数没有 trace 预言机**：一条 trace 就是一场战斗，写回去的值下一场才被读到。
 *   它的正确性由 `initRelics` 那一半（有预言机：`relicData` 非 0 的 variant）与
 *   `test/sts-combat-relic-data.test.ts` 的往返用例一起守。
 */
export function updateRelicsOnExit(bc: BattleContext): void {
  for (const r of bc.relics) {
    switch (r.id) {
      case "happy_flower":
        r.data = bc.player.happyFlowerCounter;
        break;
      case "incense_burner":
        r.data = bc.player.incenseBurnerCounter;
        break;
      case "ink_bottle":
        r.data = bc.player.inkBottleCounter;
        break;
      case "neows_lament":
        if (r.data > 0) {
          r.data -= 1;
        }
        break;
      case "nunchaku":
        r.data = bc.player.nunchakuCounter;
        break;
      case "pen_nib":
        r.data = bc.player.penNibCounter === -1 ? 9 : bc.player.penNibCounter;
        break;
      case "sundial":
        r.data = bc.player.sundialCounter;
        break;
      case "lizard_tail":
        if (!hasRelic(bc, "lizard_tail")) {
          r.data = 0;
        }
        break;
      default:
        break;
    }
  }
  // ⚠ **插入器（INSERTER）那一格故意没写**：它的 `inserterCounter` 在战斗内的唯一用途是
  //   每 2 回合 `player.increaseOrbSlots(1)`，而参考的 `Player::increaseOrbSlots` 的函数体
  //   就是一句 `// todo`（Player.cpp:109-111）——整条是空操作，没有任何可观察面。
  //   与「什锦的 SCRY 被注释掉了」同族：**没有预言机，就不登记**。
}

// ============================================================================
// 对拍探针（供 golden 测试读取逐位状态）
// ============================================================================

export type CombatProbe = {
  monsterHps: number[];
  monsterIntents: string[];
  handCardIds: string[];
  drawPileCardIds: string[];
  discardPileCardIds: string[];
  playerHp: number;
  playerBlock: number;
  energy: number;
  potions: (string | null)[];
  counters: { aiRng: number; monsterHpRng: number; shuffleRng: number; cardRandomRng: number };
  turn: number;
  outcome: Outcome;
};

export function probe(bc: BattleContext): CombatProbe {
  return {
    monsterHps: bc.monsters.map((m) => m.hp),
    monsterIntents: bc.monsters.map((m) => m.currentMove),
    handCardIds: bc.hand.map((c) => c.defId),
    drawPileCardIds: bc.drawPile.map((c) => c.defId),
    discardPileCardIds: bc.discardPile.map((c) => c.defId),
    playerHp: bc.player.hp,
    playerBlock: bc.player.block,
    energy: bc.player.energy,
    potions: [...bc.potions],
    counters: {
      aiRng: bc.rng.aiRng.counter,
      monsterHpRng: bc.rng.monsterHpRng.counter,
      shuffleRng: bc.rng.shuffleRng.counter,
      cardRandomRng: bc.rng.cardRandomRng.counter,
    },
    turn: bc.turn,
    outcome: bc.outcome,
  };
}
