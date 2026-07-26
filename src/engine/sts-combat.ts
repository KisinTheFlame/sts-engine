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
import { exhaustsOf, getCardDef, targetedOf } from "./cards/cards.js";
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
  /**
   * 燃烧的失血量（对齐 Player::combustHpLoss）。**不是**燃烧的层数：
   * `Player::buff<PS::COMBUST>` 每次调用都 `++combustHpLoss`，而层数按 5/7 累加，
   * 所以「打了几张燃烧」和「对所有敌人打多少」是两个独立的数。
   */
  combustHpLoss: number;
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

function drawCards(bc: BattleContext, count: number): void {
  // 抽牌堆顶 = 数组尾（对齐 CardManager::popFromDrawPile = drawPile.back()+pop_back()）。
  const MAX_HAND = 10;
  // 对齐 BattleContext::drawCards 顶部四条提前返回里的 NO_DRAW（战斗恍惚打完那一张牌
  // 之后本回合就再也抽不到牌）。⚠ 位置在**最前面**：命中它连 reshuffle 都不做，
  // 所以不会白吃一次 shuffleRng。
  if (getPower(bc.player.powers, "no_draw") > 0) {
    return;
  }
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
  bc.exhaustPile.push(card);
}

/** 随机消耗手牌若干张（对齐 Actions::ExhaustRandomCardInHand）。手牌空即提前返回。 */
function exhaustRandomCardInHand(bc: BattleContext, count: number): void {
  for (let i = 0; i < count; i += 1) {
    if (bc.hand.length <= 0) {
      return;
    }
    const idx = bc.rng.cardRandomRng.random(bc.hand.length - 1); // ★ 消耗一次 cardRandomRng
    const [card] = bc.hand.splice(idx, 1);
    bc.exhaustPile.push(card);
  }
}

// ============================================================================
// init（对齐 BattleContext::init 顶层顺序）
//   monsters.init(HP→rollMove) → cards.init(建库+洗牌) → initRelics → 抽起手
// ============================================================================

/** 入场牌组的一张牌（master deck 的投影：只有 defId 与升级态影响战斗）。 */
export type CombatDeckCard = { defId: string; upgraded: boolean };

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
  // TODO(后续PR): Innate 归位（背刺 / 瓶装遗物）；目前登记的牌里没有固有牌，
  // combat-bridge 的覆盖面检查也会把带固有的牌组挡在门外。
  const drawPile: CombatCard[] = input.deck.map((card) => ({
    uid: bc.nextUid++,
    defId: card.defId,
    upgraded: card.upgraded,
  }));
  shuffleCards(bc, drawPile); // ★ 消耗一次 shuffleRng
  bc.drawPile = drawPile;

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

  // —— 铁甲常用卡首批 ——

  // 愤怒：伤害 + 复制一张自身进弃牌堆。
  anger: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 8 : 6);
    addToBot(bc, (c) => attackEnemy(c, item.target, dmg));
    addToBot(bc, (c) => {
      c.discardPile.push({ uid: c.nextUid++, defId: "anger", upgraded: up });
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
  // 注释正是作者自问自答确认了这一点。失血走 PlayerLoseHp，clearOnCombatVictory=false。
  hemokinesis: (bc, item, up) => {
    const dmg = calculateCardDamage(bc, item.target, up ? 20 : 15);
    addToBot(bc, (c) => playerLoseHp(c, 2), false);
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
  bloodletting: (bc, _item, up) => {
    addToBot(bc, (c) => playerLoseHp(c, 3), false);
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
  jax: (bc, _item, up) => {
    addToBot(bc, (c) => playerLoseHp(c, 3), false);
    addToBot(bc, (c) => addPower(c.player.powers, "strength", up ? 3 : 2));
  },

  // 战略大师：抽 3(升级 4) 张牌。消耗。对齐 BattleContext.cpp:1384 MASTER_OF_STRATEGY。
  master_of_strategy: (bc, _item, up) => {
    addToBot(bc, (c) => drawCards(c, up ? 4 : 3));
  },

  // 献祭：自失 6 点生命，获得 2 点能量，抽 3(升级 5) 张牌。消耗。
  // 对齐 BattleContext.cpp:1392 OFFERING。⚠ 能量恒为 2，升级只加抽牌数。
  offering: (bc, _item, up) => {
    addToBot(bc, (c) => playerLoseHp(c, 6), false);
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
};

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
  const card = bc.hand.find((c) => c.uid === item.cardUid);
  if (card === undefined) {
    throw new Error(`useCard: 手牌中找不到 uid=${String(item.cardUid)}`);
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

  rule(bc, item, card.upgraded);

  // clearOnCombatVictory=false（对齐 Actions::OnAfterCardUsed 的第二参数）：
  // 打出致命一击后战斗虽已胜利，这张牌仍要落进弃牌堆。标 true 会让它凭空消失。
  addToBot(bc, (c) => onAfterUseCard(c, card, item), false);

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
  // 能力牌打出后**直接离场**，不进任何牌堆（参考里是把 c.id 置为 INVALID 后 return）。
  if (getCardDef(card.defId).type === "power") {
    return;
  }
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
 * 玩家主动失血（对齐 Actions::PlayerLoseHp → Player::loseHp → hpWasLost）。
 *
 * ⚠ 与受击伤害是两条路：**不过格挡**、不触发荆棘，直接扣血。归零走同一个 wouldDie
 * （瓶中仙灵仍能救回）。参考里 selfDamage 位只用来判定破裂（RUPTURE）加力量，
 * 那张能力牌尚未登记，故这里不需要该参数。
 * TODO(遗物PR): 钨钢棒减 1、百年拼图 / 鲁尼方块 / 自成型黏土的失血响应。
 */
function playerLoseHp(bc: BattleContext, amount: number): void {
  if (amount <= 0) {
    return;
  }
  bc.player.hp = Math.max(0, bc.player.hp - amount);
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
  // 升级降费必须走 upgradedCost（对齐 Cards.h:703 getEnergyCost 里那几组 `upgraded ? a : b`）：
  // 严阵以待 2→1、见红 1→0、全身撞击 1→0 等。此前只读 def.cost，升级态的能量会多扣。
  const cost = (card.upgraded ? def.upgradedCost : undefined) ?? def.cost ?? 0;
  if (cost > bc.player.energy) {
    return { ok: false, reason: `能量不足：需要 ${cost}，剩余 ${bc.player.energy}` };
  }
  // 指向性同样是**升级相关**属性：致盲+/绊摔+ 改为对所有敌人，不再需要选目标
  // （对齐 Cards.h:673 cardTargetsEnemy 里 BLIND / TRIP 的 `!upgraded`）。
  if (targetedOf(def, card.upgraded)) {
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
  // TODO(后续PR): 手中灼伤 / 腐朽 / 怀疑 / 羞耻 / 悔恨按 noTrigger 入 cardQueue——
  //   需要状态牌 / 诅咒牌生成机制，本批未实现。
  // TODO(后续PR): 姿态 onEndOfTurn。
}

/**
 * 玩家 Power 的回合末结算（对齐 Player::applyEndOfTurnPowers，Player.cpp:349），
 * 由 onTurnEnding 同步调用。
 *
 * ⚠ 参考遍历的是 `std::map<PlayerStatus, int16_t> statusMap`，即按
 * `PlayerStatusEffects.h` 的**枚举值升序**，与「先获得哪个 Power」无关。我们的 powers
 * 是获得顺序的数组，所以这里按枚举顺序**逐项显式判断**，不能改成遍历数组。
 * 本批命中的三项枚举序为：LOSE_STRENGTH(14) → NO_DRAW(16) → COMBUST(41)。
 */
function applyEndOfTurnPowers(bc: BattleContext): void {
  // TODO(后续PR): 炸弹（THE_BOMB）排在整个循环**之前**，需要「N 回合后结算」的计数器。

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

  // 燃烧：先失血再对全体造成伤害，两者都入队。
  // ⚠ 三处照抄：① 「怪是不是已经全死了」在**入队时**判（areMonstersBasicallyDead 即
  // monstersAlive <= 0），死绝了这一回合连血都不掉；② 失血量取 combustHpLoss（打过几张
  // 燃烧），伤害取层数，两个数不一样；③ PlayerLoseHp 的 clearOnCombatVictory=false，
  // DamageAllEnemy 是默认的 true。
  const combust = getPower(bc.player.powers, "combust");
  if (combust > 0 && bc.monstersAlive > 0) {
    const hpLoss = bc.player.combustHpLoss;
    addToBot(bc, (c) => playerLoseHp(c, hpLoss), false);
    addToBot(bc, (c) => damageAllEnemiesNonAttack(c, combust));
  }

  // TODO(后续PR): 爆发 / 束缚 / 双重施法 / 缠绕 / 平衡 / 建立 / 敏捷流失 / 欧米茄 /
  //   暴怒（红） / 反弹 / 再生 / 仪式（玩家侧） / 怨灵形态。
}

/**
 * 弃掉手牌（对齐 BattleContext::discardAtEndOfTurn → discardAtEndOfTurnHelper）。
 *
 * ⚠ **顺序要命**：对齐 `for (i = cardsInHand-1; i >= 0; --i)`——从手牌末尾往前弃。
 * 弃牌堆的排列会成为下次 reshuffle 的洗牌输入，正序会洗出另一副牌序。
 * TODO(后续PR): 保留牌（自带保留 / 卢恩金字塔 / 平衡）与以太牌消失。
 */
function discardAtEndOfTurn(bc: BattleContext): void {
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
  // TODO(后续PR): cards.resetAttributesAtEndOfTurn()（费用修改 / 本回合免费等卡实例级状态）。
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
  // TODO(后续PR): 被围攻/姿态/虚无。
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

function dealDamageToPlayer(bc: BattleContext, amount: number, attackerIdx = -1): void {
  // 荆棘：对齐 Player::damage 的 addToTop(DamageEnemy(...))——排在队首，
  // 且走非攻击伤害路径（不触发蜷缩）。
  const thorns = getPower(bc.player.powers, "thorns");
  if (thorns > 0 && attackerIdx >= 0) {
    addToTop(bc, (c) => damageEnemyNonAttack(c, attackerIdx, thorns));
  }
  const blocked = Math.min(bc.player.block, amount);
  bc.player.block -= blocked;
  bc.player.hp -= amount - blocked;
  if (bc.player.hp <= 0) {
    wouldDie(bc);
  }
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
  // TODO(后续PR): 暴虐（BRUTALITY=39，排在恶魔形态**之前**）——卡牌本体升级后是固有牌，
  //   缺「固有牌归位」机制，故整张牌尚未登记。
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
  // TODO(后续PR): applyStartOfTurnPowers（战斗圣歌 / 无限之刃 / 混乱 MAYHEM …）。
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
  drawCards(bc, bc.player.cardDrawPerTurn);
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
// 两条队列（存的是闭包）。队列**只在 executeActions 抽干后才被观察**——那时玩家
// 重获控制权（inputState=player_normal）、两队列必空，故快照不需要它们。
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
  turn: number;
  player: CombatPlayer;
  monsters: CombatMonster[];
  hand: CombatCard[];
  drawPile: CombatCard[];
  discardPile: CombatCard[];
  exhaustPile: CombatCard[];
  monsterTurnIdx: number;
  endTurnQueued: boolean;
  turnHasEnded: boolean;
  nextUid: number;
  rng: CombatRngState;
};

const copyPowers = (powers: PowerInstance[]): PowerInstance[] => powers.map((p) => ({ ...p }));
const copyCards = (cards: CombatCard[]): CombatCard[] => cards.map((c) => ({ ...c }));

/**
 * 导出快照。要求两条队列已抽干——非空说明调用方在动作执行中途取档，那样的档
 * 复原后会丢掉排队动作，宁可当场炸掉也不留一个静默错的存档。
 */
export function exportState(bc: BattleContext): StsCombatState {
  if (!bc.actionQueue.isEmpty() || !bc.cardQueue.isEmpty()) {
    throw new Error("exportState: 队列未抽干（只能在玩家可操作时取档）");
  }
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
    // 存档点必然是玩家可操作态（见上方注释）。
    inputState: "player_normal",
    turn: s.turn,
    actionQueue: new ActionQueue(),
    cardQueue: new CardQueue(),
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
