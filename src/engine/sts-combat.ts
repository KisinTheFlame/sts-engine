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

export type PowerInstance = { id: string; amount: number };

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
};

export type CombatPlayer = {
  hp: number;
  maxHp: number;
  block: number;
  energy: number;
  energyPerTurn: number;
  cardDrawPerTurn: number;
  powers: PowerInstance[];
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
    },
    monsters: [],
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
  // ② rollMove：逐怪滚初始意图（aiRng）。
  for (const m of bc.monsters) {
    rollMove(bc, m);
  }
  // ③ preBattleAction（Curl Up 等消耗 monsterHpRng 的开局 buff）：骨架单怪无此项，留后续。

  // —— cards.init ——
  // 建实例（按 master deck 顺序）→ 一次 shuffleRng 洗牌 → Innate 归位（铁甲基础组无 Innate）。
  const drawPile: CombatCard[] = input.deckCardIds.map((defId) => ({ uid: bc.nextUid++, defId }));
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
  // TODO(后续PR): useCard 分派（attack/skill/power）+ 随机目标(cardRandomRng) + 效果入队。
  throw new Error("sts-combat 骨架层暂未实现打牌；仅支持 endTurn 项");
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
    } else if (eff.kind === "deal_damage") {
      dealDamageToPlayer(bc, eff.amount);
    }
    // 其余效果留后续 PR。
  }
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
  bc.turnHasEnded = false;
  bc.monsterTurnIdx = 6; // 复位到「非怪物回合」
  bc.turn += 1;
  // 新回合：清玩家格挡、抽牌、回能量。
  bc.player.block = 0;
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
