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
// 尚未迁移：遗物、姿态与球、其余怪种/卡牌/药水。
//
// 登记式扩展点（新增怪/编队/卡/药水时往这些表里加，未登记会显式抛错而非静默错配 RNG）：
//   MOVE_RULES / ENCOUNTER_BUILDERS / ENCOUNTER_SETUP / PRE_BATTLE_ACTION
//   CARD_RULES / POTION_RULES

import { StsRandom, JavaRandom, javaShuffle } from "./sts-rng.js";
import { getEnemyDef, getEncounterDef } from "./enemies/enemies.js";
import { getCardDef } from "./cards/cards.js";
import { getPotionDef } from "./potions/potions.js";
import type { CharacterId } from "./types.js";

// ============================================================================
// 战斗结局（对齐 Outcome）
// ============================================================================

export type Outcome = "undecided" | "player_victory" | "player_loss";

/** 输入状态机（对齐 InputState 的子集）。EXECUTING 时抽干队列，PLAYER_NORMAL 时把控制权还给玩家。 */
export type InputState = "executing" | "player_normal";

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

export type Action = {
  fn: ActionFn;
  /** 战斗胜利结算时是否连同清除（对齐 Action::clearOnCombatVictory，默认 true）。 */
  clearOnCombatVictory: boolean;
};

export function makeAction(fn: ActionFn, clearOnCombatVictory = true): Action {
  return { fn, clearOnCombatVictory };
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

  get size(): number {
    return this.items.length;
  }
}

// ============================================================================
// 出牌队列（对齐 include/combat/CardQueue.h）
//
// 骨架层只保留最小可跑战斗需要的字段；autoplay / regret / randomTarget 等
// 复杂标记随对应卡效果迁移时再补。
// ============================================================================

export type CardQueueItem = {
  /** 被打出的牌实例 uid（引用 hand 中的牌）；endTurn 项为 null。 */
  cardUid: number | null;
  target: number;
  isEndTurn: boolean;
  triggerOnUse: boolean;
  energyOnUse: number;
  freeToPlay: boolean;
  exhaustOnUse: boolean;
  purgeOnUse: boolean;
  /** 打出时才掷随机目标（对齐 CardQueueItem::randomTarget，消耗 cardRandomRng）。 */
  randomTarget: boolean;
};

export function endTurnItem(): CardQueueItem {
  return {
    cardUid: null,
    target: 0,
    isEndTurn: true,
    triggerOnUse: true,
    energyOnUse: 0,
    freeToPlay: false,
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

export type CombatCard = {
  /** 牌实例 uid。 */
  uid: number;
  /** 卡定义 id（cards.ts）。 */
  defId: string;
  upgraded: boolean;
};

export type CombatPlayer = {
  hp: number;
  maxHp: number;
  block: number;
  energy: number;
  energyPerTurn: number;
  cardDrawPerTurn: number;
  powers: PowerInstance[];
  cardsPlayedThisTurn: number;
};

// ============================================================================
// BattleContext 状态（对齐 struct BattleContext）——骨架层字段集
// ============================================================================

export type BattleContext = {
  rng: CombatRng;

  seedLong: bigint;
  floorNum: number;
  ascension: number;
  /** 角色（决定药水池前 3 项）。 */
  character: CharacterId;

  /** 药水槽（定长 potionCapacity；null = 空）。 */
  potions: (string | null)[];
  potionCount: number;
  potionCapacity: number;

  outcome: Outcome;
  inputState: InputState;
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

  /** 怪物回合游标：>= monsters.length 表示当前不在怪物回合（对齐 monsterTurnIdx，游戏初值 6）。 */
  monsterTurnIdx: number;
  endTurnQueued: boolean;
  turnHasEnded: boolean;

  /** uid 分配器。 */
  nextUid: number;
};

/** 便捷入队（对齐 addToTop / addToBot）。 */
export function addToTop(bc: BattleContext, fn: ActionFn, clearOnVictory = true): void {
  bc.actionQueue.pushFront(makeAction(fn, clearOnVictory));
}

export function addToBot(bc: BattleContext, fn: ActionFn, clearOnVictory = true): void {
  bc.actionQueue.pushBack(makeAction(fn, clearOnVictory));
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

function drawCards(bc: BattleContext, count: number): void {
  // 抽牌堆顶 = 数组尾（对齐 CardManager::popFromDrawPile = drawPile.back()+pop_back()）。
  const MAX_HAND = 10;
  let toDraw = Math.min(MAX_HAND - bc.hand.length, count);
  if (toDraw <= 0) {
    return;
  }
  if (bc.drawPile.length < toDraw) {
    // reshuffle：先抽干现有牌库（无 RNG），再把弃牌堆洗回，补抽剩余。
    const before = bc.drawPile.length;
    for (let i = 0; i < before; i += 1) {
      bc.hand.push(bc.drawPile.pop()!);
    }
    toDraw -= before;
    if (bc.discardPile.length > 0) {
      shuffleCards(bc, bc.discardPile); // ★ 消耗一次 shuffleRng
      bc.drawPile = bc.discardPile;
      bc.discardPile = [];
    }
  }
  const n = Math.min(toDraw, bc.drawPile.length);
  for (let i = 0; i < n; i += 1) {
    bc.hand.push(bc.drawPile.pop()!);
  }
}

// ============================================================================
// init（对齐 BattleContext::init 顶层顺序）
//   monsters.init(HP→rollMove) → cards.init(建库+洗牌) → initRelics → 抽起手
// ============================================================================

export type CombatInitInput = {
  seedLong: bigint;
  floorNum: number;
  ascension: number;
  encounterId: string;
  /** 大牌组（master deck）卡定义 id，按获得顺序。 */
  deckCardIds: string[];
  /** 玩家当前生命/上限。 */
  playerHp: number;
  playerMaxHp: number;
  /** 角色（决定药水池前 3 项）；缺省铁甲。 */
  character?: CharacterId;
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
    character: input.character ?? "ironclad",
    potions: [...(input.potions ?? [null, null, null])],
    potionCount: (input.potions ?? []).filter((p) => p !== null).length,
    potionCapacity: input.potionCapacity ?? 3,
    outcome: "undecided",
    inputState: "executing",
    turn: 1,
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
    },
    monsters: [],
    monstersAlive: 0,
    hand: [],
    drawPile: [],
    discardPile: [],
    exhaustPile: [],
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

  // —— cards.init ——
  // 建实例（按 master deck 顺序）→ 一次 shuffleRng 洗牌 → Innate 归位（铁甲基础组无 Innate）。
  // TODO(后续PR): 升级态应随 master deck 传入；骨架期起始牌组均未升级。
  const drawPile: CombatCard[] = input.deckCardIds.map((defId) => ({
    uid: bc.nextUid++,
    defId,
    upgraded: false,
  }));
  shuffleCards(bc, drawPile); // ★ 消耗一次 shuffleRng
  bc.drawPile = drawPile;

  // —— initRelics ——（骨架层跳过：铁甲燃烧之血等开局遗物不消耗 RNG，效果留后续 PR）

  // —— player 能量 + 抽起手 ——
  bc.player.energy += bc.player.energyPerTurn;
  addToBot(bc, (c) => drawCards(c, c.player.cardDrawPerTurn));
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
    // ① 动作队列永远优先抽干。
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
    callEndOfTurnActions();
    return;
  }
  if (item.randomTarget) {
    // ★ 随机目标走 cardRandomRng（对齐 BattleContext.cpp:844 getRandomMonsterIdx）
    item.target = getRandomMonsterIdx(bc);
  }
  useCard(bc, item);
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

export function calculateCardBlock(bc: BattleContext, baseBlock: number): number {
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
  let curlUpBlock = 0;
  const curl = m.powers.find((p) => p.id === "curl_up");
  if (curl !== undefined && curl.amount > 0) {
    curlUpBlock = curl.amount;
    m.powers.splice(m.powers.indexOf(curl), 1); // 触发一次即清除
  }
  // TODO(后续PR): 无敌/镀甲/飞行/易塑等其余 onAttacked 分支。

  m.hp -= damage;
  if (m.hp <= 0) {
    m.hp = 0;
    monsterDie(bc, m);
  }
  if (curlUpBlock > 0 && m.alive) {
    m.block += curlUpBlock;
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

function gainBlock(bc: BattleContext, amount: number): void {
  if (amount <= 0) {
    return;
  }
  bc.player.block += amount;
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
  if (m === undefined || !m.alive) {
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

type CardRule = (bc: BattleContext, item: CardQueueItem, upgraded: boolean) => void;

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
};

/** 对齐 BattleContext::useCard：分派效果入队 → OnAfterCardUsed → 移出手牌 + 扣能量。 */
function useCard(bc: BattleContext, item: CardQueueItem): void {
  const card = bc.hand.find((c) => c.uid === item.cardUid);
  if (card === undefined) {
    throw new Error(`useCard: 手牌中找不到 uid=${String(item.cardUid)}`);
  }
  const def = getCardDef(card.defId);
  const rule = CARD_RULES[card.defId];
  if (rule === undefined) {
    throw new Error(`sts-combat 暂未登记卡牌行为: ${card.defId}`);
  }

  item.exhaustOnUse ||= def.exhausts === true;
  bc.player.cardsPlayedThisTurn += 1;

  rule(bc, item, card.upgraded);

  addToBot(bc, (c) => onAfterUseCard(c, card, item));

  // 移出手牌 + 扣能量（对齐 useCard 尾部）。
  const handIdx = bc.hand.indexOf(card);
  if (handIdx >= 0) {
    bc.hand.splice(handIdx, 1);
  }
  if (item.energyOnUse > 0 && !item.freeToPlay) {
    bc.player.energy -= item.energyOnUse;
  }
}

/** 对齐 onAfterUseCard 的卡去向：消耗 or 进弃牌堆。 */
function onAfterUseCard(bc: BattleContext, card: CombatCard, item: CardQueueItem): void {
  if (item.exhaustOnUse) {
    bc.exhaustPile.push(card);
  } else {
    bc.discardPile.push(card);
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
 * 非攻击伤害（对齐 Monster::damage，区别于 attacked）：同样先被格挡吸收，
 * 但**不**触发蜷缩 / 反甲等 onAttacked 链。
 */
function damageEnemyNonAttack(bc: BattleContext, idx: number, rawDamage: number): void {
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
  const card = bc.hand[handIdx];
  if (card === undefined) {
    return { ok: false, reason: `手牌下标越界: ${handIdx}` };
  }
  const def = getCardDef(card.defId);
  const cost = def.cost ?? 0;
  if (cost > bc.player.energy) {
    return { ok: false, reason: `能量不足：需要 ${cost}，剩余 ${bc.player.energy}` };
  }
  if (def.targeted) {
    const t = bc.monsters[target];
    if (t === undefined || !t.alive) {
      return { ok: false, reason: `目标无效: ${target}` };
    }
  }

  bc.cardQueue.pushBack({
    cardUid: card.uid,
    target,
    isEndTurn: false,
    triggerOnUse: true,
    energyOnUse: cost,
    freeToPlay: false,
    exhaustOnUse: false,
    purgeOnUse: false,
    randomTarget: false,
  });
  bc.inputState = "executing";
  executeActions(bc);
  return { ok: true };
}

// ============================================================================
// 回合结束 → 怪物回合 → 新回合（对齐 endTurn/callEndOfTurnActions/onTurnEnding/afterMonsterTurns）
// ============================================================================

/** 玩家点「结束回合」：入队 endTurn 项并驱动执行。 */
export function endTurn(bc: BattleContext): void {
  bc.cardQueue.pushBack(endTurnItem());
  bc.endTurnQueued = true;
  bc.inputState = "executing";
  executeActions(bc);
}

function callEndOfTurnActions(): void {
  // TODO(后续PR): 回合末遗物/Power、手中 Burn/Decay 等 noTrigger 卡入队。骨架层无。
}

function onTurnEnding(bc: BattleContext): void {
  // 弃掉手牌（保留牌/以太消失留后续），进入怪物回合。均无 RNG。
  for (const card of bc.hand) {
    bc.discardPile.push(card);
  }
  bc.hand = [];
  bc.endTurnQueued = false;
  bc.turnHasEnded = true;
  bc.monsterTurnIdx = 0; // 从第一个怪开始行动
  applyPreTurnLogic(bc);
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
  rollMove(bc, m); // ★ 行动后滚下一意图（消耗 aiRng）
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
    if (eff.kind === "apply_power" && eff.on === "self") {
      addPower(m.powers, eff.power, eff.amount);
      if (eff.power === "ritual") {
        // 仪式当回合不结算（skipFirst），回合末只清标志。
        const ritual = m.powers.find((p) => p.id === "ritual");
        if (ritual !== undefined) {
          ritual.justApplied = true;
        }
      }
    } else if (eff.kind === "deal_damage") {
      const dmg = calculateDamageToPlayer(bc, m, eff.amount);
      dealDamageToPlayer(bc, dmg);
    } else if (eff.kind === "deal_damage_rolled") {
      // 伤害取出生时掷定的固定值（虱子咬击）。
      const dmg = calculateDamageToPlayer(bc, m, m.rolledDamage);
      dealDamageToPlayer(bc, dmg);
    } else if (eff.kind === "apply_power" && eff.on === "target") {
      // 怪物给玩家上减益：isSourceMonster=true，故虚弱/易伤**跳过**首次递减。
      debuffPlayer(bc, eff.power, eff.amount);
    } else if (eff.kind === "gain_block") {
      // 怪物自身获得格挡（对齐 Actions::MonsterGainBlock）。
      m.block += eff.amount;
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
  // TODO(后续PR): 被围攻/姿态/虚无。
  return Math.max(0, Math.trunc(damage));
}

/**
 * 怪物给玩家施加减益（对齐 Actions::DebuffPlayer，isSourceMonster=true）。
 * 与玩家打牌施加的减益相反，虚弱/易伤在此**跳过**首次递减。
 */
function debuffPlayer(bc: BattleContext, power: string, amount: number): void {
  // 神器优先抵消一层（古代药水等来源）。
  const artifact = bc.player.powers.find((p) => p.id === "artifact");
  if (artifact !== undefined && artifact.amount > 0) {
    artifact.amount -= 1;
    if (artifact.amount === 0) {
      bc.player.powers.splice(bc.player.powers.indexOf(artifact), 1);
    }
    return;
  }
  addPower(bc.player.powers, power, amount);
  if (power === "weak" || power === "vulnerable") {
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

/** 对齐 MonsterGroup::applyEndOfRoundPowers：回合末怪物 Power 结算。 */
function applyEndOfRoundPowers(bc: BattleContext): void {
  // 顺序对齐 BattleContext::applyEndOfRoundPowers：怪物 endOfTurnTriggers（留后续）
  // → **玩家减益递减** → 怪物 endOfRoundPowers。
  decrementPlayerDebuff(bc, "frail");
  decrementPlayerDebuff(bc, "vulnerable");
  decrementPlayerDebuff(bc, "weak");

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

function dealDamageToPlayer(bc: BattleContext, amount: number): void {
  const blocked = Math.min(bc.player.block, amount);
  bc.player.block -= blocked;
  bc.player.hp -= amount - blocked;
  if (bc.player.hp <= 0) {
    bc.player.hp = 0;
    bc.outcome = "player_loss";
  }
}

function afterMonsterTurns(bc: BattleContext): void {
  applyEndOfRoundPowers(bc); // 回合末怪物 Power（仪式涨力量等）
  bc.turnHasEnded = false;
  bc.monsterTurnIdx = 6; // 复位到「非怪物回合」
  bc.turn += 1;
  // 新回合：清玩家格挡、抽牌、回能量。
  bc.player.block = 0;
  bc.player.cardsPlayedThisTurn = 0;
  drawCards(bc, bc.player.cardDrawPerTurn);
  bc.player.energy = bc.player.energyPerTurn;
  // 胜负检查（怪全灭）。
  if (livingMonsters(bc).length === 0) {
    bc.outcome = "player_victory";
  }
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
