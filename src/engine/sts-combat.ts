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
import type { CharacterId } from "./types.js";

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
  | { kind: "after_use_card"; card: CombatCard; exhaustOnUse: boolean; purgeOnUse?: boolean }
  | { kind: "draw_cards"; count: number };

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
   * 出生时掷定、整场固定的招式伤害（对齐 Monster::miscInfo）。虱子的咬击用它。
   * 未使用该机制的怪保持 0。
   */
  rolledDamage: number;
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

export type CombatPlayer = {
  hp: number;
  maxHp: number;
  block: number;
  energy: number;
  energyPerTurn: number;
  cardDrawPerTurn: number;
  powers: PowerInstance[];
  cardsPlayedThisTurn: number;
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
   * 盗贼/劫掠者偷金币（`Monster::stealGoldFromPlayer`，那两只怪还没登记）。
   */
  gold: number;
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
  /** 持有的遗物 id（按获得顺序）。 */
  relics: string[];

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

  /** 怪物回合游标：>= monsters.length 表示当前不在怪物回合（对齐 monsterTurnIdx，游戏初值 6）。 */
  monsterTurnIdx: number;
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

function livingMonsters(bc: BattleContext): CombatMonster[] {
  return bc.monsters.filter((m) => m.alive);
}

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
};

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

function createMonster(bc: BattleContext, defId: string): CombatMonster {
  const def = getEnemyDef(defId);
  const hp = bc.rng.monsterHpRng.random(def.hpMin, def.hpMax); // ★ 消耗一次 monsterHpRng
  const m: CombatMonster = {
    defId,
    hp,
    maxHp: hp,
    block: 0,
    currentMove: "",
    moveHistory: [],
    powers: [],
    alive: true,
    rolledDamage: 0,
  };
  // construct 的怪种特例：虱子的咬击伤害整场固定，出生时掷定（对齐 Monster.cpp:116）。
  if (defId === "louse" || defId === "green_louse") {
    m.rolledDamage =
      bc.ascension >= 2 ? bc.rng.monsterHpRng.random(6, 8) : bc.rng.monsterHpRng.random(5, 7); // ★ 再消耗一次 monsterHpRng
  }
  bc.monsters.push(m);
  return m;
}

// ============================================================================
// 变体编队（对齐 MonsterGroup::createMonsters 中消耗 miscRng 的分支）
//
// ⚠ 这些编队的成员由 miscRng 在战斗开始时掷定，静态 encounter 表里的 enemies
// 只是给旧版 combat.ts 用的占位，sts-combat 走这里的构建器。
// ============================================================================

type EncounterBuilder = (bc: BattleContext) => void;

/** 对齐 MonsterGroup::getLouse：一次 miscRng.randomBoolean 决定红/绿。 */
function getLouse(bc: BattleContext): string {
  return bc.rng.miscRng.randomBoolean() ? "louse" : "green_louse";
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
};

// ============================================================================
// preBattleAction（对齐 MonsterSpecific.cpp 的开局 buff）
// ============================================================================

type PreBattleAction = (bc: BattleContext, m: CombatMonster) => void;

const PRE_BATTLE_ACTION: Record<string, PreBattleAction> = {
  // 虱子蜷缩：首次受到未被格挡的攻击时获得格挡，层数开局掷定（走 monsterHpRng）。
  louse: (bc, m) => {
    const amount =
      bc.ascension >= 7 ? bc.rng.monsterHpRng.random(4, 8) : bc.rng.monsterHpRng.random(3, 7);
    addPower(m.powers, "curl_up", amount);
  },
  green_louse: (bc, m) => {
    const amount =
      bc.ascension >= 7 ? bc.rng.monsterHpRng.random(4, 8) : bc.rng.monsterHpRng.random(3, 7);
    addPower(m.powers, "curl_up", amount);
  },
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
 * 目标当前意图是否为攻击（对齐 Monster::isAttacking → isMoveAttack(moveHistory[0])）。
 *
 * ⚠ 参考用的是**招式 id 白名单**（MonsterMoves.h:414 的大 switch），这里改读数据表的
 * intent 字段。已逐项核对：当前登记的四种怪（邪教徒 / 颚虫 / 红虱 / 绿虱）两边判定完全
 * 一致——颚虫的乱抓虽然同时加格挡，白名单里也算攻击。新登记怪种时**必须**回白名单复核，
 * 因为白名单里存在「带伤害却不算攻击」与反向的例外（如球状守卫的 HARDEN 被算作攻击）。
 */
function isMonsterAttacking(bc: BattleContext, idx: number): boolean {
  const m = bc.monsters[idx];
  if (m === undefined) {
    return false;
  }
  const move = getEnemyDef(m.defId).moves.find((mv) => mv.id === m.currentMove);
  return move?.intent === "attack";
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
 * TODO(后续PR): 困惑（抽到时掷 cardRandomRng 改费用，位置在这条链**之前**）、
 *   虚无（抽到时 -1 能量，位置在烈焰吐息之后）。两张都还没有入手途径。
 */
function drawOneCard(bc: BattleContext, card: CombatCard): void {
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
    onShuffle();
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
 * 洗牌触发点（对齐 BattleContext::onShuffle）。
 * TODO(遗物PR): 算盘（+6 格挡）、日晷（每三次洗牌 +2 能量）、什锦。
 * 目前无一登记，故是空实现——但保留这个调用点，免得将来漏掉时点。
 */
function onShuffle(): void {
  // 无 RNG 消耗；日晷是跨洗牌计数器，需要玩家级状态，随遗物迁移一起做。
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
 * TODO(遗物PR): 卡戎的骨灰（addToTop DamageAllEnemy 3）、枯枝（随机牌入手，消耗 cardRandomRng）。
 * TODO(后续PR): 死灵诅咒（消耗时自己再回手，排在无痛之心与哨兵之间）。
 */
function triggerAndMoveToExhaustPile(bc: BattleContext, card: CombatCard): void {
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
  /** 入场时持有的遗物 id。 */
  relics?: string[];
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
};

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
    relics: [...(input.relics ?? [])],
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
      cardsPlayedThisTurn: 0,
      combustHpLoss: 0,
      bomb1: 0,
      bomb2: 0,
      bomb3: 0,
      // 对齐 `BattleContext::init` 的 `player.gold = gc.gold`（BattleContext.cpp:55）。
      gold: input.gold ?? 0,
    },
    monsters: [],
    monstersAlive: 0,
    hand: [],
    drawPile: [],
    discardPile: [],
    exhaustPile: [],
    // 对齐 `CardManager::init` 顶部的 `strikeCount = 0`——下面建大牌组实例时逐张加回来。
    strikeCount: 0,
    monsterTurnIdx: 6, // 对齐游戏初值（>= monsterCount 即「非怪物回合」）
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
  bc.monstersAlive = bc.monsters.length;
  // ①b 编队开局特例（军团 buff / 预置哨兵等），仍属 createMonsters 阶段。
  ENCOUNTER_SETUP[input.encounterId]?.(bc);
  // ② rollMove：逐怪滚初始意图（aiRng）。
  for (const m of bc.monsters) {
    rollMove(bc, m);
  }
  // ③ preBattleAction：开局 buff，其中蜷缩等会再消耗 monsterHpRng——注意它排在
  //    所有 HP roll 与所有 rollMove **之后**。
  for (const m of bc.monsters) {
    PRE_BATTLE_ACTION[m.defId]?.(bc, m);
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
  initRelics(bc); // 第一遍：立即属性
  addToBot(bc, (c) => drawCards(c, c.player.cardDrawPerTurn));
  initRelicsAtBattleStart(bc); // 第二遍：排在抽牌之后
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
    // TODO(后续PR): 欧米茄、短暂（TRANSIENT，那只怪自己会跑）也算「不靠牌」。
    if (bc.hand.length + bc.discardPile.length + bc.drawPile.length === 0) {
      const hasDamageWithoutCards =
        getPower(bc.player.powers, "thorns") > 0 ||
        bc.player.bomb1 !== 0 ||
        bc.player.bomb2 !== 0 ||
        bc.player.bomb3 !== 0;
      if (!hasDamageWithoutCards) {
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
  // TODO(后续PR): `if (c.isFreeToPlay(bc)) c.freeToPlayOnce = true;` 与
  //   `player.lastTargetedMonster = item.target`（只被未登记的内容读）。
  const canUseCard =
    item.purgeOnUse ||
    (item.triggerOnUse && cardCanUse(bc, card, item.target, item.autoplay) === null);
  const targetStillValid =
    !targetedOf(getCardDef(card.defId), card.upgraded) || bc.monsters[item.target]?.alive === true;
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
  // 顶部那道目标门：需要目标而目标已死（或全场怪已死）就打不出。
  if (targetedOf(def, card.upgraded)) {
    const t = bc.monsters[target];
    if (t === undefined || !t.alive) {
      return `目标无效: ${target}`;
    }
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
    // 灼伤：升级形态 4 点（灼伤+ 只由六焰鬼在第 9 回合后生成，我们尚无来源）。
    // ⚠ selfDamage=true（`DamagePlayer(…, true)`）——灼伤的自伤**会**触发破裂。
    const damage = card.upgraded ? 4 : 2;
    addToTop(bc, (c) => damagePlayerNonAttack(c, damage, true));
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

function getPower(powers: PowerInstance[], id: string): number {
  return powers.find((p) => p.id === id)?.amount ?? 0;
}

export function calculateCardDamage(
  bc: BattleContext,
  targetIdx: number,
  baseDamage: number,
): number {
  let damage = Math.fround(baseDamage);

  // 玩家 Power AtDamageGive
  damage = Math.fround(damage + getPower(bc.player.powers, "strength"));
  const vigor = getPower(bc.player.powers, "vigor");
  if (vigor > 0) {
    damage = Math.fround(damage + vigor);
  }
  if (getPower(bc.player.powers, "weak") > 0) {
    damage = Math.fround(damage * 0.75);
  }
  // TODO(后续PR): 双倍伤害/笔尖/姿态（愤怒×2、神性×3）。

  // 敌人 Power AtDamageReceive
  const target = bc.monsters[targetIdx];
  if (target !== undefined && getPower(target.powers, "vulnerable") > 0) {
    damage = Math.fround(damage * 1.5);
  }
  // TODO(后续PR): 缓慢、飞行、虚无。

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
  // 格挡吸收：先扣伤害再削格挡，两者都基于进入时的原值（对齐 Monster::attacked）。
  const tempDamage = damage;
  damage -= m.block;
  m.block = Math.max(0, m.block - tempDamage);
  // TODO(后续PR): 蜷缩/镀甲/反甲/狂怒等 onAttacked 触发。
  if (damage > 0) {
    monsterDamageUnblocked(bc, m, damage);
  }
}

function monsterDamageUnblocked(bc: BattleContext, m: CombatMonster, damage: number): void {
  // onAttacked 链（对齐 attackedUnblockedHelper 的 if/else-if 顺序）。蜷缩把加格挡
  // addToBot 排在扣血之后，故这里先记下、扣完血再加。
  const curl = m.powers.find((p) => p.id === "curl_up");
  if (curl !== undefined && curl.amount > 0) {
    const amount = curl.amount;
    m.powers.splice(m.powers.indexOf(curl), 1); // 触发一次即清除
    // 必须**入队**而非当场加：这是 addToBot(Actions::MonsterGainBlock)，
    // 所以 ① 触发那一击不被它减免；② 怪物即便被这一击打死，格挡照样落在尸体上；
    // ③ 但若这一击终结了战斗，clearPostCombatActions 会把它连同其它排队动作清掉。
    // 三种表现同时成立，只有走队列才能都对上。
    addToBot(bc, () => {
      m.block += amount;
    });
  }
  // TODO(后续PR): 无敌/镀甲/飞行/易塑等其余 onAttacked 分支。

  m.hp -= damage;
  if (m.hp <= 0) {
    m.hp = 0;
    monsterDie(bc, m);
  }
}

function monsterDie(bc: BattleContext, m: CombatMonster): void {
  m.alive = false;
  bc.monstersAlive -= 1;
  if (bc.monstersAlive === 0) {
    bc.outcome = "player_victory";
  }
  // TODO(后续PR): 孢子云/重生/尸爆/地精角等死亡触发。
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
  const artifact = m.powers.find((p) => p.id === "artifact");
  if (artifact !== undefined && artifact.amount > 0) {
    artifact.amount -= 1;
    return;
  }
  addPower(m.powers, power, amount);
  if (isSourceMonster && (power === "weak" || power === "vulnerable")) {
    const p = m.powers.find((x) => x.id === power);
    if (p !== undefined) {
      p.justApplied = true;
    }
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
  const p = m.powers.find((x) => x.id === id);
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
// （对齐 `addToBot(Actions::AttackEnemy(t, calculateCardDamage(...)))`）。
// 故痛击的易伤只影响其后打出的牌，不影响痛击自身那一击。
// ============================================================================

// ============================================================================
// 战斗内遗物（对齐 BattleContext::initRelics）
//
// initRelics 是**两遍**：第一遍立即改属性；随后把开局抽牌入队；第二遍
// atBattleStart 的效果也入队——所以它们在开局抽牌**之后**才结算。
// 顺序错了（比如先上易伤再抽牌）在多数场景下看不出来，但会错。
// ============================================================================

export function hasRelic(bc: BattleContext, id: string): boolean {
  return bc.relics.includes(id);
}

/** 第一遍：立即生效的属性类。 */
const RELIC_IMMEDIATE: Record<string, (bc: BattleContext) => void> = {
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
};

function initRelics(bc: BattleContext): void {
  for (const id of bc.relics) {
    RELIC_IMMEDIATE[id]?.(bc);
  }
  // 开局抽牌（由调用方在此之后入队），再挂 atBattleStart。
}

function initRelicsAtBattleStart(bc: BattleContext): void {
  for (const id of bc.relics) {
    RELIC_AT_BATTLE_START[id]?.(bc);
  }
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
  // TODO(后续PR): 化学 X（CHEMICAL_X）遗物 +2，未登记。
  const effectAmount = energy;
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
  strike: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 9 : 6);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },
  // 防御：获得 5(升级 8) 点格挡。GainBlock 的 clearOnCombatVictory=false。
  defend: (bc, _item, up) => {
    const blk = calculateCardBlock(bc, up ? 8 : 5);
    addToBot(bc, (c) => gainBlock(c, blk), false);
  },
  // 痛击：造成 8(升级 10) 点伤害并施加 2(升级 3) 层易伤。对齐 BattleContext.cpp:980 BASH。
  bash: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 8);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => debuffEnemy(c, item.target, "vulnerable", up ? 3 : 2));
  },

  // —— 铁甲常用卡首批 ——

  // 愤怒：伤害 + 复制一张自身进弃牌堆。
  anger: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 8 : 6);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => {
      c.discardPile.push(makeCardInstance(c, "anger", up));
    });
  },

  // 顺劈斩：对全体。基础值先加精力，再由 AttackAllEnemy 逐怪算伤害。
  cleave: (bc, _item, up) =>
    attackAllEnemies(bc, (up ? 11 : 8) + getPower(bc.player.powers, "vigor")),

  // 十字打击：伤害 + 虚弱。
  clothesline: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 14 : 12);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => debuffEnemy(c, item.target, "weak", up ? 3 : 2));
  },

  // 重刃：⚠ 基础值已含 2×力量，再过一次 calculateCardDamage 又加一次力量——
  // 力量实际算了**三**次。这是参考的算法，不是笔误，照抄。
  heavy_blade: (bc, item, up) => {
    const base = 14 + (up ? 4 : 2) * getPower(bc.player.powers, "strength");
    const dmg = calculateCardDamage(bc, item.target, base);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 铁浪：格挡 + 伤害，先加格挡后造成伤害。
  //
  // ⚠ 参考项目曾在这里把 calculateCardBlock 套了两层，敏捷因此被算两次
  //（敏捷 2 时给 9 点而非 7 点）。全项目 15 处同类写法都是单层、只有这里嵌套，
  // 且无测试覆盖——已确认是笔误并在参考侧修复（sts_lightspeed 49c5390），
  // 样例数据随之重新生成。此处按正确的单层实现。
  iron_wave: (bc, item, up) => {
    const blk = calculateCardBlock(bc, up ? 7 : 5);
    const dmg = calculateCardDamage(bc, item.target, up ? 7 : 5);
    addToBot(bc, (c) => gainBlock(c, blk), false);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 柄击：伤害 + 抽牌。
  pommel_strike: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 9);
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
  thunderclap: (bc, _item, up) => {
    attackAllEnemies(bc, (up ? 7 : 4) + getPower(bc.player.powers, "vigor"));
    addToBot(bc, (c) => {
      for (let i = c.monsters.length - 1; i >= 0; i -= 1) {
        if (c.monsters[i]?.alive === true) {
          addToTop(c, (c2) => debuffEnemy(c2, i, "vulnerable", 1, false));
        }
      }
    });
  },

  // 双重打击：同一伤害值打两次（伤害只算一次，两击等值）。
  twin_strike: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 7 : 5);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 全身撞击：伤害等于**当前格挡**（入队时取值）。
  body_slam: (bc, item) => {
    const dmg = calculateCardDamage(bc, item.target, bc.player.block);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 燃烧：+2(升级 3) 力量（能力牌）。
  inflame: (bc, _item, up) =>
    addToBot(bc, (c) => addPower(c.player.powers, "strength", up ? 3 : 2)),

  // ==========================================================================
  // 铺量第二批 · 攻击牌（对齐 BattleContext::useAttackCard，BattleContext.cpp:966 起）
  // ==========================================================================

  // 撕咬：造成 7(升级 8) 点伤害，回复 2(升级 3) 点生命。对齐 BattleContext.cpp:986 BITE。
  bite: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 8 : 7);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    // HealPlayer 的 clearOnCombatVictory=false（Actions.cpp:117）：打出致命一击后战斗虽已
    // 胜利，这口血照样要回。标 true 会让它被 clearPostCombatActions 吞掉。
    addToBot(bc, (c) => healPlayer(c, up ? 3 : 2), false);
  },

  // 血肉巨兵：造成 32(升级 42) 点伤害。对齐 BattleContext.cpp:999 BLUDGEON。
  bludgeon: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 42 : 32);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 飞踢：造成 5(升级 8) 点伤害；若目标处于易伤，获得 1 点能量并抽 1 张牌。
  // 对齐 BattleContext.cpp:1028 DROPKICK → Actions::DropkickAction（Actions.cpp:1035）。
  //
  // ⚠ 三处都要照抄：① 伤害在动作**执行时**才算（不同于绝大多数攻击牌在打牌时算好）；
  // ② 易伤判定排在攻击**之前**，所以即便这一击打死目标，能量与抽牌照样兑现；
  // ③ 三个 addToTop 的推入顺序是「抽牌 → 能量 → 攻击」，故实际执行顺序反过来：
  //    先结算攻击，再回能量，最后抽牌。
  dropkick: (bc, item, up) => {
    addToBot(bc, (c) => {
      const m = c.monsters[item.target];
      if (m?.alive === true && getPower(m.powers, "vulnerable") > 0) {
        addToTop(c, (c2) => drawCards(c2, 1));
        addToTop(c, (c2) => {
          c2.player.energy += 1;
        });
      }
      const dmg = calculateCardDamage(c, item.target, up ? 8 : 5);
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
  feed: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 12 : 10);
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
  fiend_fire: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 7);
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
  flash_of_steel: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 6 : 3);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => drawCards(c, 1));
  },

  // 血液动力：自失 2 点生命，造成 15(升级 20) 点伤害。
  // 对齐 BattleContext.cpp:1061 HEMOKINESIS。
  //
  // ⚠ 伤害在**打牌时**就算好，所以失血引起的加力量（破裂）不影响这一击——参考里那两行
  // 注释正是作者自问自答确认了这一点。失血走 PlayerLoseHp(2, **true**)，
  // clearOnCombatVictory=false。
  hemokinesis: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 20 : 15);
    addToBot(bc, (c) => playerLoseHp(c, 2, true), false);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 冲拳：造成 4(升级 5) 次 2 点伤害。消耗。对齐 BattleContext.cpp:1100 PUMMEL。
  // 伤害只算一次，各击等值（与双重打击同款写法）。
  pummel: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, 2);
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
  reaper: (bc, _item, up) => {
    const base = (up ? 5 : 4) + getPower(bc.player.powers, "vigor");
    addToBot(bc, (c) => {
      let healAmount = 0;
      for (let i = 0; i < c.monsters.length; i += 1) {
        const m = c.monsters[i];
        if (m === undefined || !m.alive) {
          continue;
        }
        const hpBefore = m.hp;
        monsterAttacked(c, m, calculateCardDamage(c, i, base));
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
  sever_soul: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 22 : 16);
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
  sword_boomerang: (bc, _item, up) => {
    const base = 3 + getPower(bc.player.powers, "vigor");
    const hits = up ? 4 : 3;
    for (let i = 0; i < hits; i += 1) {
      addToBot(bc, (c) => {
        // 对齐 getRandomMonsterIdx(rng, aliveOnly=true) 的 -1 提前返回：全灭则不掷 RNG。
        if (c.monstersAlive === 0) {
          return;
        }
        const idx = getRandomMonsterIdx(c); // ★ 消耗一次 cardRandomRng
        const dmg = calculateCardDamage(c, idx, base);
        addToTop(c, (c2) => attackEnemy(c2, idx, dmg));
      });
    }
  },

  // 迅捷打击：造成 7(升级 10) 点伤害。对齐 BattleContext.cpp:1148 SWIFT_STRIKE。
  swift_strike: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 7);
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
      onShuffle(); // 同步调用（参考在入队之前直接调），当前无副作用
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
  uppercut: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, 13);
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
  headbutt: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 12 : 9);
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
  immolate: (bc, _item, up) => {
    attackAllEnemies(bc, (up ? 28 : 21) + getPower(bc.player.powers, "vigor"));
    addToBot(bc, (c) => makeTempCardInDiscard(c, "burn", 1));
  },

  // 鲁莽冲锋：造成 7(升级 10) 点伤害，把一张眩晕**洗入抽牌堆**。
  // 对齐 BattleContext.cpp:1127 RECKLESS_CHARGE。★ 洗入消耗一次 cardRandomRng。
  reckless_charge: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 10 : 7);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => makeTempCardInDrawPile(c, "dazed", 1)); // ★ 消耗一次 cardRandomRng
  },

  // 狂野劈砍：造成 12(升级 17) 点伤害，把一张伤口**洗入抽牌堆**。
  // 对齐 BattleContext.cpp:1187 WILD_STRIKE。★ 洗入消耗一次 cardRandomRng。
  wild_strike: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 17 : 12);
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
  carnage: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 28 : 20);
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
  dramatic_entrance: (bc, _item, up) =>
    attackAllEnemies(bc, (up ? 12 : 8) + getPower(bc.player.powers, "vigor")),

  // 心灵冲击：造成等同于**抽牌堆张数**的伤害。固有。对齐 BattleContext.cpp:1081 MIND_BLAST。
  // ⚠ 张数在**打牌时**取（本牌此刻还在手上，不影响抽牌堆）；升级只降费（2 → 1），
  // 伤害公式两个分支相同。
  //
  // ⚠ 它的背书**只来自 23 张的聚焦牌组变体**（variant 3/4）：85 张全牌组里它是固有牌、
  // 每条 trace 起手必有、抽牌堆约 80 张 → 一击 80 点会把邪教徒/颚虫第一回合打死，
  // 1230 条 trace 从 ~40 步塌成 1 步。所以它**故意不在全牌组变体里**。
  mind_blast: (bc, item) => {
    const dmg = calculateCardDamage(bc, item.target, bc.drawPile.length);
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
    const dmg = calculateCardDamage(bc, item.target, 8 + card.specialData);
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
    const dmg = calculateCardDamage(bc, item.target, base);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 血债血偿：造成 18(升级 22) 点伤害。4(升级 3) 费，本场每失血一次费用 -1。
  // 对齐 BattleContext.cpp:1011 BLOOD_FOR_BLOOD。
  //
  // ⚠ 卡效果本身只有伤害那一句——降费不在这里，而在 `Player::hpWasLost` 里的
  // `cards.onTookDamage()`（见 cardsOnTookDamage）。所以**被怪打一下也降费**，
  // 不限于自伤，这一点与破裂的 selfDamage 判据不同。
  blood_for_blood: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 22 : 18);
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
  whirlwind: (bc, item, up) => {
    if (!item.ignoreEnergyTotal && bc.player.energy < item.energyOnUse) {
      item.energyOnUse = bc.player.energy;
    }
    const baseDamage = (up ? 8 : 5) + getPower(bc.player.powers, "vigor");
    const energy = item.energyOnUse;
    // TODO(后续PR): `c.freeToPlayOnce`（深谋远虑 / 液态记忆），还没有产出者。
    const useEnergy = !item.freeToPlay;
    addToBot(bc, (c) => whirlwindAction(c, baseDamage, energy, useEnergy));
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
  perfected_strike: (bc, item, up) => {
    const strikeDmg = bc.strikeCount * (up ? 3 : 2);
    const dmg = calculateCardDamage(bc, item.target, 6 + strikeDmg);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
  },

  // 冲撞：仅当手牌中全是攻击牌时才能打出；造成 14(升级 18) 点伤害。
  // 对齐 BattleContext.cpp:1023 CLASH（效果本身平平无奇，门槛在 cardCanUse / canUseClash）。
  clash: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 18 : 14);
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
  hand_of_greed: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 25 : 20);
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
function attackAllEnemies(bc: BattleContext, baseDamage: number): void {
  addToBot(bc, (c) => {
    const matrix = c.monsters.map((m, i) => (m.alive ? calculateCardDamage(c, i, baseDamage) : 0));
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
): void {
  if (useEnergy) {
    bc.player.energy = 0; // 对齐 `player.useEnergy(player.energy)`
  }
  const matrix = bc.monsters.map((m, i) =>
    m.alive ? Math.min(65535, calculateCardDamage(bc, i, baseDamage)) : 0,
  );
  // TODO(后续PR): 化学 X（CHEMICAL_X）遗物 +2，未登记。
  const effectAmount = energy;
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
  } else if (def.type === "skill" && getPower(bc.player.powers, "corruption") > 0) {
    // 腐化：技能牌打出后被消耗。位置照抄——在 useSkillCard() / onUseSkillCard() **之后**，
    // 所以卡效果自己读到的 exhaustOnUse 还是原值（当前没有卡效果读它，记着以防将来有）。
    item.exhaustOnUse = true;
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
  addToBot(bc, (c) => onAfterUseCard(c, card, exhaustOnUse, purgeOnUse), false, {
    kind: "after_use_card",
    card,
    exhaustOnUse,
    purgeOnUse,
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
    card.costForTurn > 0 &&
    !item.autoplay &&
    !(def.type === "skill" && getPower(bc.player.powers, "corruption") > 0)
  ) {
    bc.player.energy -= card.costForTurn;
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
 * ⚠ 参考在这里还有 `p.attacksPlayedThisTurn++` 与 `removeStatus<PS::VIGOR>()`。前者只被
 * 遗物读（战争艺术 / 苦无 / 装饰扇，都未登记），后者没有任何已登记内容能给出精力，
 * 都留 TODO——现在写了也没有 trace 走得到，等于无背书的代码。
 */
function onUseAttackCard(bc: BattleContext, item: CardQueueItem, card: CombatCard): void {
  if (!item.purgeOnUse && getPower(bc.player.powers, "double_tap") > 0) {
    queuePurgeCard(bc, card, item.target, item.energyOnUse);
    decrementPlayerPower(bc, "double_tap");
  }
  const rage = getPower(bc.player.powers, "rage");
  if (rage > 0) {
    addToBot(bc, (c) => gainBlock(c, rage), false);
  }
}

/**
 * 对齐 onAfterUseCard 的卡去向：消耗 or 进弃牌堆。
 *
 * ⚠ `purgeOnUse` 那道提前返回排在**最前**（BattleContext.cpp:1979，还在能力牌那道之前）：
 * 二连击复制出来的那份是队列项里的副本，结算完就直接丢掉——不进弃牌堆、不进消耗堆，
 * 也不触发消耗链。少了这道门，二连击每打一次就凭空多出一张牌。
 */
function onAfterUseCard(
  bc: BattleContext,
  card: CombatCard,
  exhaustOnUse: boolean,
  purgeOnUse: boolean,
): void {
  if (purgeOnUse) {
    return;
  }
  // 能力牌打出后**直接离场**，不进任何牌堆（参考里是把 c.id 置为 INVALID 后 return）。
  if (getCardDef(card.defId).type === "power") {
    return;
  }
  if (exhaustOnUse) {
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
      return makeAction((c) => onAfterUseCard(c, card, exhaustOnUse, purgeOnUse), false, {
        kind: "after_use_card",
        card,
        exhaustOnUse,
        purgeOnUse,
      });
    }
    case "draw_cards": {
      const count = desc.count;
      return makeAction((c) => drawCards(c, count), true, { kind: "draw_cards", count });
    }
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
type PotionRule = (bc: BattleContext, target: number) => void;

const POTION_RULES: Record<string, PotionRule> = {
  block_potion: (bc) => addToBot(bc, (c) => gainBlock(c, 12), false),
  // 火焰/爆炸药水走 DamageEnemy（非攻击伤害），**不**触发蜷缩等 onAttacked 链。
  fire_potion: (bc, target) => addToBot(bc, (c) => damageEnemyNonAttack(c, target, 20)),
  explosive_potion: (bc) =>
    addToBot(bc, (c) => {
      for (let i = 0; i < c.monsters.length; i += 1) {
        damageEnemyNonAttack(c, i, 10);
      }
    }),
  strength_potion: (bc) => addToBot(bc, (c) => addPower(c.player.powers, "strength", 2)),
  dexterity_potion: (bc) => addToBot(bc, (c) => addPower(c.player.powers, "dexterity", 2)),
  energy_potion: (bc) =>
    addToBot(bc, (c) => {
      c.player.energy += 2;
    }),
  swift_potion: (bc) => addToBot(bc, (c) => drawCards(c, 3)),
  // 药水施加的减益同样是 isSourceMonster=false，不跳过首次递减。
  weak_potion: (bc, target) => addToBot(bc, (c) => debuffEnemy(c, target, "weak", 3, false)),
  fear_potion: (bc, target) => addToBot(bc, (c) => debuffEnemy(c, target, "vulnerable", 3, false)),
  blood_potion: (bc) => {
    // 对齐 (float)(maxHp * 40) / 100.0f 后截断。
    const heal = Math.trunc(Math.fround((bc.player.maxHp * 40) / 100));
    addToBot(bc, (c) => healPlayer(c, heal));
  },
  fruit_juice: (bc) => {
    // 立即生效，不入队（对齐 player.increaseMaxHp）。
    bc.player.maxHp += 5;
    bc.player.hp += 5;
  },
  ancient_potion: (bc) => addToBot(bc, (c) => addPower(c.player.powers, "artifact", 1)),
  // 熵酿：把空槽填满随机药水——战斗内唯一消耗 potionRng 的地方。
  entropic_brew: (bc) =>
    addToBot(bc, (c) => {
      for (let i = 0; i < c.potionCapacity; i += 1) {
        obtainPotion(c, returnRandomPotion(c, true));
      }
    }),
};

function healPlayer(bc: BattleContext, amount: number): void {
  bc.player.hp = Math.min(bc.player.maxHp, bc.player.hp + amount);
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
  // TODO(遗物PR): 以太（提前返回，一分钱都不给）、血腥雕像（加完回 5 血）。
  bc.player.gold += amount;
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
 * TODO(遗物PR): 钨钢棒减 1（在 loseHp 里、hpWasLost 之前）。
 */
function playerLoseHp(bc: BattleContext, amount: number, selfDamage: boolean): void {
  let loss = amount;
  if (getPower(bc.player.powers, "intangible") > 0) {
    loss = 1;
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
 * TODO(遗物PR): 百年拼图（抽 3）、情绪芯片、自成型黏土、鲁尼方块、红骷髅。
 */
function playerHpWasLost(bc: BattleContext, amount: number, selfDamage: boolean): void {
  bc.player.hp = Math.max(0, bc.player.hp - amount);
  const rupture = getPower(bc.player.powers, "rupture");
  if (selfDamage && rupture > 0) {
    addPower(bc.player.powers, "strength", rupture);
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
  const tempDamage = damage;
  damage -= m.block;
  m.block = Math.max(0, m.block - tempDamage);
  if (damage <= 0) {
    return;
  }
  m.hp -= damage;
  if (m.hp <= 0) {
    m.hp = 0;
    monsterDie(bc, m);
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

  discardPotion(bc, idx); // 先清槽，再结算
  rule(bc, target);
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
    case "headbutt":
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
 * 回合末动作（对齐 BattleContext::callEndOfTurnActions，BattleContext.cpp:2032）。
 *
 * 触发点是 cardQueue 里的 endTurn 项——所以它排在 onTurnEnding **之前**：先把
 * 「回合末拿格挡」一类效果入队跑完，再进弃手牌与怪物回合。两者顺序反了的话金属化的
 * 格挡会落到怪物已经打完之后。
 */
function callEndOfTurnActions(bc: BattleContext): void {
  // —— 玩家遗物 OnPlayerEndTurn ——
  // TODO(遗物PR): 斗篷夹扣（按手牌数加格挡）、冰核、尼尔的法典、山铜（无格挡时 addToTop
  // 加 6 点）、石历（第 6 回合 52 点全体伤害）。⚠ 整组排在下面的 Power 之前，
  // 且山铜那条是 addToTop 而非 addToBot。

  // —— 玩家 Power AtEndOfTurnPreEndTurnCards ——
  // 金属化：层数在**入队时**取，GainBlock 的 clearOnCombatVictory=false（打完这一回合
  // 就赢了的话格挡照样加上）。
  const metallicize = getPower(bc.player.powers, "metallicize");
  if (metallicize > 0) {
    addToBot(bc, (c) => gainBlock(c, metallicize), false);
  }
  // TODO(后续PR): 镀甲（PLATED_ARMOR，紧接金属化之后）、如水般（需姿态）、充能球回合末触发。

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
 * 命中项的枚举序：LOSE_STRENGTH(14) → NO_DRAW(16) → DOUBLE_TAP(30) → COMBUST(41) → RAGE(71)。
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

  // TODO(后续PR): 爆发 / 束缚 / 双重施法 / 缠绕 / 平衡 / 建立 / 敏捷流失 / 欧米茄 /
  //   反弹 / 再生 / 仪式（玩家侧） / 怨灵形态。
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
 * TODO(后续PR): 保留牌（自带保留 / 卢恩金字塔 / 平衡）——参考在①之前还有一段 limbo 搬运。
 */
function discardAtEndOfTurn(bc: BattleContext): void {
  addToTop(bc, (c) => discardAtEndOfTurnHelper(c));
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
 * 怪物阶段开始（对齐 Actions::MonsterStartTurnAction → MonsterGroup::applyPreTurnLogic）：
 * 逐怪清空格挡（壁垒除外）。注意时点——玩家回合内怪物格挡仍在，故开局自带格挡的
 * 编队（如颚虫军团）第一回合会挡下玩家攻击。
 */
function applyPreTurnLogic(bc: BattleContext): void {
  for (const m of bc.monsters) {
    if (!m.alive) {
      continue;
    }
    m.block = 0;
  }
  // TODO(后续PR): 壁垒、窒息等开局状态。
}

function doMonsterTurn(bc: BattleContext, idx: number): void {
  const m = bc.monsters[idx];
  if (m === undefined || !m.alive) {
    return;
  }
  takeTurn(bc, m);
  // 玩家阵亡后参考会在处理后续排队动作前跳出主循环，故这一步的 RollMove 不会执行——
  // 不短路的话 aiRng 会多消耗一次，counter 就对不上了。
  if (bc.outcome !== "undecided") {
    return;
  }
  // ★ 滚下一意图必须**入队**（对齐 takeTurn 末尾的 addToBot(Actions::RollMove)）。
  // 同步调用会抢在荆棘之前：荆棘伤害走 addToTop 会插到 RollMove 前面，若它打死了
  // 最后一只怪，这次 RollMove 就该被 clearPostCombatActions 清掉、不消耗 aiRng。
  addToBot(bc, (c) => rollMove(c, m));
}

/** 执行怪物当前意图效果（骨架层：Cultist 咏唱=自身 ritual；attack=对玩家造成伤害）。 */
function takeTurn(bc: BattleContext, m: CombatMonster): void {
  const def = getEnemyDef(m.defId);
  const move = def.moves.find((mv) => mv.id === m.currentMove);
  if (move === undefined) {
    return;
  }
  for (const eff of move.effects) {
    // 同理：一旦分出胜负，后续排队效果在参考里也不会再执行。
    if (bc.outcome !== "undecided") {
      return;
    }
    // ⚠ 入队与否要逐项对齐参考的 takeTurn：力量类 buff 是**立即**执行
    //（`buff<MS::STRENGTH>(...)`），而加格挡、造成伤害、给玩家上减益都是
    // `addToBot(Actions::...)`。差别看得见——荆棘伤害走 addToTop 会插到排队的
    // 加格挡之前，若格挡改成同步就会把荆棘吃掉。
    if (eff.kind === "apply_power" && eff.on === "self") {
      addPower(m.powers, eff.power, eff.amount);
      if (eff.power === "ritual") {
        // 仪式当回合不结算（skipFirst），回合末只清标志。
        const ritual = m.powers.find((p) => p.id === "ritual");
        if (ritual !== undefined) {
          ritual.justApplied = true;
        }
      }
    } else if (eff.kind === "deal_damage" || eff.kind === "deal_damage_rolled") {
      // 伤害在**入队时**按当下状态算好（attackPlayerHelper 先 calculateDamageToPlayer
      // 再 addToBot(AttackPlayer)）；deal_damage_rolled 取出生时掷定的固定值。
      const base = eff.kind === "deal_damage_rolled" ? m.rolledDamage : eff.amount;
      const dmg = calculateDamageToPlayer(bc, m, base);
      const idx = bc.monsters.indexOf(m);
      addToBot(bc, (c) => dealDamageToPlayer(c, dmg, idx));
    } else if (eff.kind === "apply_power" && eff.on === "target") {
      // 怪物给玩家上减益：isSourceMonster=true，故虚弱/易伤**跳过**首次递减。
      addToBot(bc, (c) => debuffPlayer(c, eff.power, eff.amount, true));
    } else if (eff.kind === "gain_block") {
      // 对齐 addToBot(Actions::MonsterGainBlock)——排队，不能当场加。
      addToBot(bc, () => {
        m.block += eff.amount;
      });
    }
    // 其余效果留后续 PR。
  }
}

/**
 * 怪物攻击伤害（对齐 Monster::calculateDamageToPlayer）。
 * float32 全程：先加怪物力量，再乘玩家易伤 1.5f，末尾一次截断。
 */
function calculateDamageToPlayer(bc: BattleContext, m: CombatMonster, baseDamage: number): number {
  let damage = Math.fround(baseDamage + getPower(m.powers, "strength"));
  if (getPower(m.powers, "weak") > 0) {
    damage = Math.fround(damage * 0.75);
  }
  if (getPower(bc.player.powers, "vulnerable") > 0) {
    damage = Math.fround(damage * 1.5);
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
  // 神器优先抵消一层（古代药水等来源）。
  const artifact = bc.player.powers.find((p) => p.id === "artifact");
  if (artifact !== undefined && artifact.amount > 0) {
    artifact.amount -= 1;
    if (artifact.amount === 0) {
      bc.player.powers.splice(bc.player.powers.indexOf(artifact), 1);
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
 * TODO(后续PR): 金属化 / 镀甲（都要 `Monster::addBlock`）、易塑（`setStatus<MALLEABLE>(3)`，
 * 与它的 onAttacked 成长分支配套）、怪物侧虚无缥缈递减、再生（`Monster::heal`）。
 * 当前登记的四种怪（邪教徒 / 颚虫 / 红虱 / 绿虱）一个都没有这五种 Power，写了也没有
 * 预言机走到——等登记带它们的怪（如拉加维林的金属化、史莱姆王一族）时按上面的顺序补。
 */
function applyMonsterEndOfTurnTriggers(m: CombatMonster): void {
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
  // ⚠ 两个怪物循环各自带 `isDying() || isEscaping()` 的跳过（`isDying()` 就是 `curHp <= 0`，
  // 即我们的 `!alive`；逃跑还没建模，没有已登记的怪会逃）。
  for (const m of bc.monsters) {
    if (!m.alive) {
      continue;
    }
    applyMonsterEndOfTurnTriggers(m);
  }
  decrementPlayerDebuff(bc, "frail");
  decrementPlayerDebuff(bc, "vulnerable");
  decrementPlayerDebuff(bc, "weak");
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
    const ritual = m.powers.find((p) => p.id === "ritual");
    if (ritual !== undefined && ritual.amount > 0) {
      if (ritual.justApplied === true) {
        ritual.justApplied = false; // 施加当回合跳过
      } else {
        addPower(m.powers, "strength", ritual.amount);
      }
    }
    // 顺序对齐参考：仪式 → 缓慢 → 锁定 → 虚弱 → 易伤。
    decrementDebuff(m, "weak");
    decrementDebuff(m, "vulnerable");
  }
  // TODO(后续PR): 缓慢清零、锁定递减。
}

function addPower(powers: PowerInstance[], id: string, amount: number): void {
  const existing = powers.find((p) => p.id === id);
  if (existing) {
    existing.amount += amount;
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
  const unblocked = amount - blocked;
  if (unblocked > 0) {
    playerHpWasLost(bc, unblocked, false);
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
 * TODO(遗物PR): 钨钢棒减 1、缓冲（BUFFER）。
 */
function damagePlayerNonAttack(bc: BattleContext, amount: number, selfDamage: boolean): void {
  let damage = amount;
  if (damage > 0 && getPower(bc.player.powers, "intangible") > 0) {
    damage = 1;
  }
  const blocked = Math.min(bc.player.block, damage);
  bc.player.block -= blocked;
  const unblocked = damage - blocked;
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
  for (let i = 0; i < bc.potionCapacity; i += 1) {
    if (bc.potions[i] === "fairy_in_a_bottle") {
      discardPotion(bc, i);
      const healAmount = Math.max(1, Math.trunc(Math.fround(bc.player.maxHp) * 0.3));
      healPlayer(bc, healAmount);
      return;
    }
  }
  // TODO(遗物PR): 蜥蜴尾巴（回半血）、绽放印记（禁用复活）。
  bc.outcome = "player_loss";
}

/**
 * 玩家 Power 的回合开始（抽牌之后）结算（对齐 Player::applyStartOfTurnPostDrawPowers，
 * Player.cpp:674）。
 *
 * ⚠ 同 applyEndOfTurnPowers：参考遍历 statusMap，即按枚举值升序，与获得顺序无关。
 * 本批只有恶魔形态（DEMON_FORM=44）命中。
 */
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
  // TODO(遗物PR): applyStartOfTurnRelics（战争艺术 / 硫磺石 / 船长之轮 …），排在清格挡之前。
  // 回合开始的玩家 Power（抽牌之前）。位置照抄：applyStartOfTurnRelics 之后、
  // **清格挡之前**（对齐 BattleContext.cpp:2188）。火焰屏障就在这里退场。
  applyStartOfTurnPowers(bc);
  // 新回合：清玩家格挡、抽牌、回能量。
  // ⚠ 清格挡是一条 if/else-if 链（对齐 BattleContext.cpp:2178）：壁垒 → 模糊 → 卡钳 →
  // 归零，**只走第一个命中的分支**。壁垒那支是空的（格挡原样留着）。
  if (getPower(bc.player.powers, "barricade") > 0) {
    // 壁垒：格挡不清空。
  } else {
    // TODO(后续PR): 模糊（BLUR，递减一层并保留格挡）、卡钳遗物（只减 15 点）。
    bc.player.block = 0;
  }
  bc.player.cardsPlayedThisTurn = 0;
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
  // TODO(后续PR): DRAW_REDUCTION 的 skipFirst 递减；applyStartOfTurnPostDrawRelics（怀表 / 扭曲钳）。
  applyStartOfTurnPostDrawPowers(bc);
  bc.player.energy = bc.player.energyPerTurn;
  // 胜负检查（怪全灭）。
  if (livingMonsters(bc).length === 0) {
    bc.outcome = "player_victory";
  }
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
  relics: string[];
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
    relics: [...bc.relics],
    potions: [...bc.potions],
    potionCount: bc.potionCount,
    potionCapacity: bc.potionCapacity,
    outcome: bc.outcome,
    inputState: bc.inputState,
    cardSelect: copyCardSelect(bc.cardSelect),
    pendingActions,
    pendingCardQueue: copyCardQueueItems(bc.cardQueue.all()),
    turn: bc.turn,
    player: { ...bc.player, powers: copyPowers(bc.player.powers) },
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
    relics: [...s.relics],
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
    player: { ...s.player, powers: copyPowers(s.player.powers) },
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
    monsterTurnIdx: s.monsterTurnIdx,
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
];

export function isEncounterSupported(encounterId: string): boolean {
  return SUPPORTED_ENCOUNTERS.includes(encounterId);
}

export function isCardSupported(defId: string): boolean {
  return CARD_RULES[defId] !== undefined;
}

export function isPotionSupported(potionId: string): boolean {
  return POTION_RULES[potionId] !== undefined;
}

/** 战斗内行为已转写的遗物（两遍 initRelics 的并集）。 */
export function isRelicSupported(relicId: string): boolean {
  return RELIC_IMMEDIATE[relicId] !== undefined || RELIC_AT_BATTLE_START[relicId] !== undefined;
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
