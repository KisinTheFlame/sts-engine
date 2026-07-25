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
// 骨架层（本 PR）：立起队列结构 + 6 流播种 + 一场最小可跑战斗（固定单怪编队）：
//   init → roll 怪物 HP(monsterHpRng) → roll 初始意图(aiRng) → 建库洗牌(shuffleRng)
//   → 抽起手 → 玩家 endTurn → 怪物 takeTurn + rollMove(aiRng) → 新回合抽牌 → 回合循环。
// 逐位对齐面：monsterHpRng/aiRng/shuffleRng/cardRandomRng 的 counter 与牌序、HP、意图。
// 后续 PR 逐张卡效果 / 逐怪 AI / reshuffle / 药水 迁移进来。

import { StsRandom, JavaRandom, javaShuffle } from "./sts-rng.js";
import { getEnemyDef, getEncounterDef } from "./enemies/enemies.js";
import { getCardDef } from "./cards/cards.js";

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
//   miscRng  = gc.miscRng;    // 跨房间持久（run 级）
//   potionRng = gc.potionRng; // 跨房间持久（run 级）
//
// 四条同源流各自是 startRandom 的独立拷贝（构造后 counter 都为 0，各自推进）。
// miscRng/potionRng 是 run 级持久流——骨架层暂用占位新建并留 TODO，待 run 级
// RNG 账本补齐后接入。
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
 * @param runMiscRng  run 级持久 miscRng；缺省时占位新建（TODO：接入 run 账本）。
 * @param runPotionRng run 级持久 potionRng；缺省时占位新建（TODO：接入 run 账本）。
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
    // TODO(run级RNG): miscRng/potionRng 应从 run 级持久流传入，占位新建仅为骨架自洽。
    miscRng: runMiscRng ?? new StsRandom(base),
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

const MOVE_RULES: Record<string, MoveForRoll> = {
  // 邪教徒：首回合（无历史）必咏唱，之后恒暗袭。roll 被消耗但不影响结果（故不取用）。
  // 对齐 MonsterSpecific.cpp:2280 CULTIST。
  cultist: (_bc, m) => (m.moveHistory.length === 0 ? "incantation" : "dark_strike"),
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
  /** 可选：run 级持久流。 */
  miscRng?: StsRandom;
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

  // —— monsters.init ——
  // ① createMonsters：固定编队不消耗 miscRng，逐怪按下标 roll HP(monsterHpRng)。
  //    变体编队（miscRng 选怪、Louse/Darkling miscInfo、ORB_WALKER 双 roll）留后续 PR。
  for (const defId of encounter.enemies) {
    const def = getEnemyDef(defId);
    const hp = bc.rng.monsterHpRng.random(def.hpMin, def.hpMax); // ★ 消耗一次 monsterHpRng
    bc.monsters.push({
      defId,
      hp,
      maxHp: hp,
      block: 0,
      currentMove: "",
      moveHistory: [],
      powers: [],
      alive: true,
    });
  }
  bc.monstersAlive = bc.monsters.length;
  // ② rollMove：逐怪滚初始意图（aiRng）。
  for (const m of bc.monsters) {
    rollMove(bc, m);
  }
  // ③ preBattleAction（Curl Up 等消耗 monsterHpRng 的开局 buff）：骨架单怪无此项，留后续。

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

/** 对齐 BattleContext::debuffEnemy：神器优先抵消一层。 */
function debuffEnemy(bc: BattleContext, idx: number, power: string, amount: number): void {
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
}

function doMonsterTurn(bc: BattleContext, idx: number): void {
  const m = bc.monsters[idx];
  if (m === undefined || !m.alive) {
    return;
  }
  takeTurn(bc, m);
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

/** 对齐 MonsterGroup::applyEndOfRoundPowers：回合末怪物 Power 结算。 */
function applyEndOfRoundPowers(bc: BattleContext): void {
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
  }
  // TODO(后续PR): 缓慢清零、锁定递减、虚弱/易伤递减等。
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
