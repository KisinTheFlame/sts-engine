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
   * 抢劫者/劫匪偷金币（`stealGoldFromPlayer`，第十五批登记了抢劫者）。
   *
   * ⚠ **入场值有语义，不能随便填 0**：偷金是 `min(player.gold, 额度)`，按金币的**绝对值**
   * 钳制。第十五批之前 trace 重放故意从 0 起算（那时没有任何东西读金币），登记抢劫者之后
   * 那样做会让一分钱都偷不到——见 `test/sts-combat-trace.test.ts` 的 `HARNESS_GOLD_BASELINE`。
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
  // ⚠ 三条都**只写 asc<17 那一支**。参考里选民与食蛇草各有一整块 `if (asc17) { … }`
  //   （MonsterSpecific.cpp:2253-2272 / :2757-2769），但本批 `ascCalibrated` 没置，
  //   `constructMonster` 在 `ascension > 0` 时直接抛错，所以那两块**走不到、也没有预言机**。
  //   照第十八批对地精头目 asc18 出招块的先例：**留到给它们铺爬升度的那一批再转写**，
  //   不提前写没人验证的代码。

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

  // 选民：对齐 MonsterSpecific.cpp:2274-2291 CHOSEN（asc<17 那一段）。
  // ⚠ 四处照抄：
  //  ① 首回合（`firstTurn()`）必**戳刺**，roll 照掷但结果被丢掉；
  //  ② 第二段判的是 `lastMoveBefore(INVALID)`，也就是 `moveHistory[1] == INVALID`
  //     ——「上上步还不存在」＝**这是第二回合**，于是第二招恒为诅咒。⚠ 这是全项目
  //     **第一次**用到 `moveHistory[1] == INVALID` 这个谓词（此前只有 `lastMove` /
  //     `lastTwoMoves`），不能拿 `firstTurn` 或 `lastMove` 顶替；
  //  ③ 「削弱 / 汲取」那一段的门是 `!lastMove(DEBILITATE) && !lastMove(DRAIN)`
  //     ——两条各自的连续限制是 1，而且**互相**也算（上一招是其中任一条就跳过整段）；
  //  ④ 电击的门是 `roll < 40`，戳刺是兜底。两者**都没有**连续限制。
  chosen: (_bc, m, roll) => {
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

  // 食蛇草：对齐 MonsterSpecific.cpp:2771-2782 SNAKE_PLANT（asc<17 那一段）。
  // ⚠ 三处照抄：
  //  ① **没有 `firstTurn()` 特例**——开局那次 rollMove 就走 roll 分支（历史全空，
  //     `lastTwoMoves` 恒假，于是 `roll < 65` 必出撕咬、否则必出孢子）；
  //  ② 高位那一支（`roll >= 65`）判的是 **`lastMove`**（连续 1 次），而低位那一支
  //     （`roll < 65`）判的是 **`lastTwoMoves`**（连续 2 次）——两个谓词不一样，
  //     照抄不要统一。⚠ asc17 那一块把高位那支也换成了 `lastTwoMoves`，正是这一点
  //     构成两块的唯一差别（本批不转写，见上）；
  //  ③ 两支的兜底方向相反：低位兜底撕咬、高位兜底孢子。
  snake_plant: (_bc, m, roll) => {
    if (roll < 65) {
      return lastTwoMoves(m, "sp_chomp") ? "sp_spores" : "sp_chomp";
    }
    return lastMove(m, "sp_spores") ? "sp_chomp" : "sp_spores";
  },
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
  // 血量区间的第二组（对齐 `Monster::initHp` → `setRandomHp(hpRng, ascension >= N)`，
  // MonsterSpecific.cpp:26-128）。⚠ 阈值 N **逐怪不同**（普通 7 / 精英 8 / Boss 9），
  // 所以它写在数据表里跟着区间走，这里不猜。
  // ⚠ 无论走哪一组都**只掷一次** monsterHpRng——`setRandomHp` 只有一句 `hpRng.random(a,b)`，
  //   换组不改 RNG 消耗次数，只改上下界。
  const range =
    def.hpHigh !== undefined && bc.ascension >= def.hpHigh.atLeast
      ? { min: def.hpHigh.hpMin, max: def.hpHigh.hpMax }
      : { min: def.hpMin, max: def.hpMax };
  // ⚠⚠ 少数怪**一次 monsterHpRng 都不掷**（第二十三批的球状守卫者，以及尚未登记的
  //   THE_MAW / TRANSIENT）：`Monster::initHp` 给它们的是
  //   `curHp = monsterHpRange[id][0][0]`，连 `setRandomHp` 都不调（MonsterSpecific.cpp:119-124）。
  //   这与「上下界相同」**不是一回事**——守卫者的 `{240,240}` 照样掷一次
  //   （`Random::random(int,int)` 无条件 `++counter`）。把这一条写成普通掷法会让此后
  //   每一次 monsterHpRng 取值整体错位，`rng.hp` 计数器当场对不上。
  const hp = def.hpNoRoll === true ? range.min : bc.rng.monsterHpRng.random(range.min, range.max); // ★ 掷法二选一：hpNoRoll 时**不**消耗 monsterHpRng
  const m: CombatMonster = {
    defId,
    hp,
    maxHp: hp,
    block: 0,
    currentMove: "",
    moveHistory: [],
    powers: [],
    alive: true,
    miscInfo: 0,
    uniquePower0: 0,
  };
  // construct 的怪种特例：虱子的咬击伤害整场固定，出生时掷定（对齐 Monster.cpp:116）。
  if (defId === "louse" || defId === "green_louse") {
    m.miscInfo =
      bc.ascension >= 2 ? bc.rng.monsterHpRng.random(6, 8) : bc.rng.monsterHpRng.random(5, 7); // ★ 再消耗一次 monsterHpRng
  }
  return m;
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
    miscInfo: 0,
    uniquePower0: 0,
  };
  // 先落位再 rollMove，对齐 `arr[idx] = Monster(); arr[idx].initSpawnedMonster(...)`。
  bc.monsters[at] = nm;
  rollMove(bc, nm); // ★ 消耗 aiRng（1 次；中号酸液的分支可能追加 1 次）
  // TODO(后续PR): 贤者之石（PHILOSOPHERS_STONE）会给分裂出来的两只各 +1 力量
  //   （MonsterSpecific.cpp:3378 / :3406）。harness 的遗物轮换里没有它
  //   （trace_dump.cpp:218 那八个），写了也没有预言机走到。
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
//（不掷血量、maxHp 压成当前血量、不继承状态、各自 rollMove）与贤者之石那个 TODO。
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
  // 蓝 / 红奴隶主（`:428-429` / `:484-485`）
  "blue_slaver/stab",
  "blue_slaver/rake",
  "red_slaver/rs_stab",
  "red_slaver/scrape",
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
  // 真菌兽（`:455`）
  "fungi_beast/fungi_bite",
  // 红 / 绿虱（`:458` / `:481`）
  "green_louse/bite",
  "louse/bite",
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
  // 哨卫（`:489`）
  "sentry/beam",
  // 史莱姆王（`:494`）
  "slime_boss/slam",
  // 食蛇草（`:495`，第二十三批）
  "snake_plant/sp_chomp",
  // 球状守卫者（`:499-501`，第二十三批）。⚠ 硬化在列——它同时加格挡，这就是那个反例。
  "spheric_guardian/sg_slam",
  "spheric_guardian/sg_harden",
  "spheric_guardian/sg_attack_debuff",
  // 守卫者（`:518-521`）
  "the_guardian/fierce_bash",
  "the_guardian/whirlwind",
  "the_guardian/roll_attack",
  "the_guardian/twin_slam",
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
  const tempDamage = damage;
  damage -= m.block;
  m.block = Math.max(0, m.block - tempDamage);
  // TODO(后续PR): 虚无缥缈（怪物侧，位置在狂怒**之前**）、手钻（破盾时上易伤）。
  if (damage > 0) {
    monsterDamageUnblocked(bc, m, damage);
  }
}

function monsterDamageUnblocked(bc: BattleContext, m: CombatMonster, damage: number): void {
  // onAttacked 链（对齐 attackedUnblockedHelper 的 if/**else-if**顺序，Monster.cpp:348-396）。
  // 参考的顺序是：无敌 → 镀甲 → 蜷缩 → 飞行 → 易塑/反应 → 荆棘 → **沉睡** → 变换。
  // ⚠ 它是一条 **else-if 链**：同时带蜷缩与沉睡的怪只会触发排在前面的那一条。当前没有这种
  //   怪（虱子只有蜷缩、拉加维林只有沉睡），但形状照抄——写成两个独立 if 会在将来静默出错。
  // 蜷缩把加格挡 addToBot 排在扣血之后，故这里先记下、扣完血再加。
  const curl = m.powers.find((p) => p.id === "curl_up");
  const malleable = m.powers.find((p) => p.id === "malleable");
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
  } else if (malleable !== undefined && malleable.amount > 0) {
    // 易塑（MALLEABLE，食蛇草）：对齐 Monster.cpp:369-374 那一格。
    // ⚠ 参考写的是 `else if (hasStatus<MALLEABLE>() || hasStatus<REACTIVE>())`，进去之后
    //   **两个 if 各判各的**（蠕动血块两者都有）。当前只有食蛇草带易塑、没有怪带反应，
    //   所以这里只写易塑那一半；补反应时要注意它俩共用这一格（不是两格）。
    // ⚠ 三处照抄：
    //  ① 加的格挡是 `addToBot(MonsterGainBlock(idx, malleable))` ——**入队**，所以
    //     触发它的那一击不被减免（与蜷缩同族）；
    //  ② 层数 **+1**（`setStatus<MALLEABLE>(malleable+1)`），不是消耗掉——挨得越多、
    //     下一次挡得越多；
    //  ③ 复位**不在这里**，在 `applyMonsterEndOfTurnTriggers`（每回合末拉回 3）。
    const amount = malleable.amount;
    addToBot(bc, () => {
      m.block += amount;
    });
    malleable.amount = amount + 1;
  } else {
    // 沉睡被打断（Monster.cpp:388-391）。⚠ 它排在这条 else-if 链的**倒数第二**格。
    wakeUpLagavulin(m);
  }
  // TODO(后续PR): 无敌 / 镀甲 / 飞行 / 反应 / 荆棘 / 变换等其余 onAttacked 分支。

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
    const metallicize = m.powers.find((p) => p.id === "metallicize");
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
  if (bc.monstersAlive === 0) {
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
  }
  // TODO(后续PR): 重生（暗黑之种）/ 尸爆 / 停滞 / 地精角 / 活体样本，以及觉醒者的假死。
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
  } else if (def.type === "power") {
    // 第二十三批新增（此前能力牌这条 case 是空的）：诅咒挂在这三个函数上，
    // **攻击牌那个里没有**——分派本身就是「非攻击牌才触发」的实现。
    onUsePowerCard(bc);
  } else if (def.type === "status" || def.type === "curse") {
    onUseStatusOrCurseCard(bc);
  } else if (def.type === "skill") {
    onUseSkillCard(bc);
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
 * ⚠ 参考在这里还有 `++p.skillsPlayedThisTurn`。它唯一的读者是拆信刀（LETTER_OPENER，
 * 每 3 张技能牌打 5 点全体伤害），遗物轮换里没有它——写了也没有预言机走到，留 TODO。
 *
 * TODO(后续PR): 爆发（`onUseSkillCard` 里的 queuePurgeCard）、复制药水、回响形态、残影、
 *   六芒星的眩晕、华彩，以及墨水瓶 / 橙色药丸 / 拆信刀三个遗物。
 */
function onUseSkillCard(bc: BattleContext): void {
  // 诅咒（HEX，选民）：位置照抄——排在残影 / 爆发 / 复制 / 回响形态**之后**、华彩与全部遗物
  // **之前**，因此也在最末那条激怒之前（BattleContext.cpp:1796-1798）。见 `hexShuffleDazed`。
  hexShuffleDazed(bc);
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
 * TODO(后续PR): 残影 / 复制 / 回响形态 / 华彩，以及鸟面坛 / 墨水瓶 / 橙色药丸 / 木乃伊手
 * 四个遗物（都还没有对应内容登记）。
 */
function onUsePowerCard(bc: BattleContext): void {
  hexShuffleDazed(bc);
}

/**
 * 打出一张**状态牌 / 诅咒牌**之后的触发（对齐 `BattleContext::onUseStatusOrCurseCard`，
 * BattleContext.cpp:1915-1960）。第二十三批新增，目前只有诅咒一条。
 *
 * ⚠ 能走到这里的只有**打得出去**的状态/诅咒牌。当前唯一登记的是黏液
 *（`CardInstance.cpp:329` 那个 `id != SLIMED` 的例外），恍惚 / 伤口 / 灼伤都打不出。
 *
 * TODO(后续PR): 残影 / 复制 / 回响形态 / 华彩，以及蓝色蜡烛（诅咒牌失 1 血并消耗）。
 */
function onUseStatusOrCurseCard(bc: BattleContext): void {
  hexShuffleDazed(bc);
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
  // 沉睡被打断（Monster.cpp:448-452）。⚠ 这条路上它是**独立的 if**、不在任何 else-if 链里
  //（那条链只在 attacked 那条路上），所以非攻击伤害叫醒它时不受蜷缩之类的遮挡。
  wakeUpLagavulin(m);
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
 * 命中项的枚举序：ENTANGLED(10) → LOSE_STRENGTH(14) → NO_DRAW(16) → DOUBLE_TAP(30) →
 * COMBUST(41) → RAGE(71)。
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

  // 缠绕（ENTANGLED=10，枚举序排在 LOSE_STRENGTH=14 之前）：本回合结束即**整条清除**。
  // ⚠ 是 `addToBot(RemoveStatus<ENTANGLED>)` 而不是递减（Player.cpp:382），所以红色奴隶主
  // 连着放两次缠绕也只是「下一个玩家回合打不出攻击牌」，不会累积成两回合。
  if (getPower(bc.player.powers, "entangled") > 0) {
    addToBot(bc, (c) => removePower(c.player.powers, "entangled"));
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
 */
function applyPreTurnLogic(bc: BattleContext): void {
  for (const m of bc.monsters) {
    if (!m.alive) {
      continue;
    }
    if (getPower(m.powers, "barricade") > 0) {
      continue;
    }
    m.block = 0;
  }
  // TODO(后续PR): 窒息、飞行复位、无敌复位、中毒扣血等其余 applyStartOfTurnPowers 分支。
}

function doMonsterTurn(bc: BattleContext, idx: number): void {
  const m = bc.monsters[idx];
  if (m === undefined || !m.alive) {
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
    if (eff.kind === "apply_power" && eff.minAscension !== undefined) {
      if (bc.ascension < eff.minAscension) {
        continue;
      }
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
      addPower(m.powers, eff.power, ascValue(bc, eff.amount, eff.ascAmount));
      if (eff.power === "ritual") {
        // 仪式当回合不结算（skipFirst），回合末只清标志。
        const ritual = m.powers.find((p) => p.id === "ritual");
        if (ritual !== undefined) {
          ritual.justApplied = true;
        }
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
      // ⚠ `deal_damage_multi` 的 `ascAmount` 覆盖的是**每一击的伤害**，`times` 没有分档
      //   ——参考写的是 `attackPlayerHelper(bc, asc4 ? 3 : 2, 6)`（六火幽魂地狱之火
      //   MonsterSpecific.cpp:808）与 `(bc, asc4 ? 6 : 5, 2)`（冲撞 :841），第二个实参恒定。
      //   第二十二批加的字段：在此之前没有一只已登记的怪用到多段攻击的 asc 分档。
      const base =
        eff.kind === "deal_damage_rolled" ? m.miscInfo : ascValue(bc, eff.amount, eff.ascAmount);
      const times = eff.kind === "deal_damage" ? 1 : (eff.times ?? 1);
      const dmg = calculateDamageToPlayer(bc, m, base);
      const idx = bc.monsters.indexOf(m);
      for (let i = 0; i < times; i += 1) {
        addToBot(bc, (c) => dealDamageToPlayer(c, dmg, idx), false);
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
      // ⚠ 只有弃牌堆这一路不消耗 RNG；洗入抽牌堆那一路要掷 cardRandomRng，当前没有怪用到。
      // ⚠ 史莱姆王的黏液喷射写的却是 `.actFunc(bc)`（MonsterSpecific.cpp:1112）——**同步**，
      //   与加格挡 / 上减益那两族同形，用 `sync` 区分。
      if (eff.pile !== "discard") {
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
      if (eff.sync === true) {
        makeTempCardInDiscard(bc, cardId, count, upgraded);
      } else {
        addToBot(bc, (c) => makeTempCardInDiscard(c, cardId, count, upgraded));
      }
    } else if (eff.kind === "store_hp_scaled_damage") {
      // 按玩家**此刻**的生命算定一个每击伤害，存进 miscInfo（六火幽魂的激活，
      // MonsterSpecific.cpp:794 `miscInfo = bc.player.curHp / 12 + 1;`）。
      // ⚠ 三处照抄：
      //  ① 时点是**激活那一回合的怪物阶段**，不是六重打击落下的时候——此后玩家掉多少血
      //     （灼伤自伤、别的攻击）都不再改这个数；
      //  ② 是 C++ 的**整数除法**（向零截断），不是四舍五入；
      //  ③ 它是**同步**语句（整条 case 里没有任何 addToBot），所以紧随其后的收尾看得见它。
      m.miscInfo = Math.trunc(bc.player.hp / eff.divisor) + eff.add;
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
  // 纯 bool 减益（对齐 Player.h:406-409 `if (s == PS::CONFUSED || s == PS::HEX) {
  // setHasStatus<s>(true); return; }`）：**只置位、不写 statusMap**，所以再上一次也还是 1 层。
  // ⚠ 位置就在神器那道门**之后**——诅咒照样会被神器吃掉。
  // ⚠ harness 的 `playerStatusValue` 对这一族按 1 输出（statusMap 里查不到），所以我们也存 1；
  //   写成累加会在选民第二次诅咒时红成 `HEX: 2`。
  // ⚠ 困惑（CONFUSED）走同一支，但它还没有产出者（史尼克未登记），所以这里只列诅咒。
  if (power === "hex") {
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
 * TODO(后续PR): 镀甲（同样是 `Monster::addBlock`）、易塑（`setStatus<MALLEABLE>(3)`，
 * 与它的 onAttacked 成长分支配套）、怪物侧虚无缥缈递减、再生（`Monster::heal`）。
 * 当前登记的怪一只都没有这四种 Power，写了也没有预言机走到。
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
  const malleable = m.powers.find((p) => p.id === "malleable");
  if (malleable !== undefined && malleable.amount > 0) {
    malleable.amount = 3;
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
 * **覆盖**一个 Power 的层数（对齐 `Monster::setStatus`，Monster.h:196）。
 *
 * ⚠ 与 `addPower`（= 参考的 `buff`）的差别是承重的：`setStatus` **只写数值、不碰
 * statusBits**，所以它只能用在「这个 Power 已经在身上」的地方——守卫者的形态切换
 * （`setStatus<MODE_SHIFT>(newAmount)`，Monster.cpp:527）就是唯一的用户，
 * 而那一支的前置条件正是 `hasStatus<MODE_SHIFT>()`。
 * 参考在层数归零时走的是另一支（`removeStatus`），所以这里不会被传 0。
 */
function setPower(powers: PowerInstance[], id: string, amount: number): void {
  const existing = powers.find((p) => p.id === id);
  if (existing === undefined) {
    throw new Error(`sts-combat setPower: ${id} 不在身上（参考的 setStatus 不写 statusBits）`);
  }
  existing.amount = amount;
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
  //   ⚠ 它们**只有 asc0 的背书**：三只怪的 `ascCalibrated` 都没置，
  //   所以不在 `ASC_SUPPORTED_ENCOUNTERS` 里，`ascension > 0` 时显式抛错。
  "spheric_guardian",
  "chosen",
  "snake_plant",
];

export function isEncounterSupported(encounterId: string): boolean {
  return SUPPORTED_ENCOUNTERS.includes(encounterId);
}

/**
 * 爬升度分档**已有 trace 背书**的编队（第二十一批 14 个普通编队 + 第二十二批
 * 三精英 + 三 Boss = 第一幕 20 个编队全覆盖）。
 *
 * ⚠ 与 `SUPPORTED_ENCOUNTERS` 是两条独立的轴：一个编队可以「asc0 有背书」而
 * 「asc>0 没有」。两张表现在恰好同集合，但**不要合并**——第二幕的编队装进
 * `SUPPORTED_ENCOUNTERS` 时，它的 asc 分档仍然要单独一批才有预言机。
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
