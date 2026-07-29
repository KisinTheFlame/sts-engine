import type { GameState } from "./types.js";
import { getCardDef } from "./cards/cards.js";
import { getEncounterDef } from "./enemies/enemies.js";
import { getRelicDef } from "./relics/relics.js";
import { getPotionDef } from "./potions/potions.js";
import {
  cardSelectOptions,
  drinkPotion,
  endTurn as stsEndTurn,
  exportState,
  importState,
  initCombat,
  isCardSupported,
  isEncounterAscSupported,
  isEncounterSupported,
  isPotionSupported,
  playCard as stsPlayCard,
  selectCard as stsSelectCard,
  selectCards as stsSelectCards,
  type BattleContext,
  type CardSelectOptions,
  type EndTurnResult,
  type PlayCardResult,
  type SelectCardResult,
} from "./sts-combat.js";
import { StsRandom } from "./sts-rng.js";
import { grantBossVictory } from "./post-combat.js";

// === GameState ↔ BattleContext ===
//
// 引擎只有一套战斗实现：`sts-combat.ts`（与原版逐位一致）。本文件负责它与 run 层之间
// 的接线——把 GameState 折成 initCombat 的入参、把 BattleContext 折成可存档的纯数据、
// 战斗结束后做 run 级收尾。
//
// 近似实现（旧 `combat/combat.ts`）已删除，因此**没有回退路径**：碰到尚未迁移的编队 /
// 牌 / 药水会显式抛错。这是有意的——静默降级会让「同种子复现原版」这个目标失去意义，
// 而错配 RNG 比直接失败危险得多。迁移进度见 TODOS.md。

// ============================================================================
// 开战前置条件
// ============================================================================

export type CombatCoverage = { supported: true } | { supported: false; reason: string };

/**
 * 这场战斗 sts-combat 能不能打。
 *
 * 只查「会不会漏东西或错配 RNG」的四类：编队、**编队 × 爬升度**、牌组里的牌、手上的药水。
 * 遗物不在此列——它的战斗内行为要么已登记进 sts-combat，要么还没迁移（那就是无行为），
 * 两种都不会错配 RNG。
 *
 * ⚠ 爬升度是**第二十一批新加的一条独立轴**。此前这里的注释写着「ascension 不查：怪物的
 * asc 分支是逐行转写的」——那句话当时就不完全成立（`enemies.ts` 只有一组血量区间、
 * 招式数值全是 asc0 的值），开了爬升度这条轴之后更不成立。现在按编队查，
 * 兜底在 `constructMonster`（按怪查 `EnemyDef.ascCalibrated`，直接抛错）。
 */
export function stsCombatCoverage(state: GameState, encounterId: string): CombatCoverage {
  const no = (reason: string): CombatCoverage => ({ supported: false, reason });

  if (!isEncounterSupported(encounterId)) {
    return no(`编队「${encounterId}」尚未迁移（无 trace 背书）`);
  }
  if (!isEncounterAscSupported(encounterId, state.ascension)) {
    return no(`编队「${encounterId}」的爬升度分档尚未校准（ascension=${String(state.ascension)}）`);
  }
  for (const card of state.deck) {
    const def = getCardDef(card.defId);
    if (!isCardSupported(card.defId)) {
      return no(`牌「${def.name}」尚未迁移`);
    }
    // 固有牌的开局归位第五批已实现（sts-combat 的 cards.init 一段，含瓶装遗物的实例级
    // innate 位），所以这里不再拦它——`isCardSupported` 那一道就够了。
  }
  for (const potion of state.potions) {
    if (potion !== null && !isPotionSupported(potion)) {
      return no(`药水「${potion}」尚未迁移`);
    }
  }
  return { supported: true };
}

// ============================================================================
// 开战 / 收尾
// ============================================================================

/**
 * run 级持久 potionRng：与四条战斗流不同，它**不**逐层重播种，counter 要跨房间续算
 * （见 sts-combat.ts 顶部注释）。null = 本局还没用过，按 Random(seed) 起头。
 */
function takePotionRng(state: GameState): StsRandom {
  return state.stsPotionRng === null
    ? new StsRandom(BigInt(state.seed))
    : StsRandom.fromState(state.stsPotionRng);
}

/** 开一场战斗。尚未迁移的内容直接抛错（没有近似实现可退）。 */
export function startCombat(state: GameState, encounterId: string): void {
  const coverage = stsCombatCoverage(state, encounterId);
  if (!coverage.supported) {
    throw new Error(`无法开始战斗：${coverage.reason}`);
  }
  const bc = initCombat({
    seedLong: BigInt(state.seed),
    // resolveNode 已在进入节点时自增，对齐 GameContext::transitionToMapNode 的
    // ++floorNum → Random(seed + floorNum)。
    floorNum: state.floorNum,
    ascension: state.ascension,
    encounterId,
    // innate 是**实例级**的固有位（瓶装遗物封入的那一张），必须逐实例带过去——
    // 定义级的固有由 sts-combat 自己读数据表，实例级的它无从得知。
    deck: state.deck.map((card) => ({
      defId: card.defId,
      upgraded: card.upgraded,
      innate: card.innate,
    })),
    playerHp: state.hp,
    playerMaxHp: state.maxHp,
    // 金币要带进战斗（对齐 `player.gold = gc.gold`）：贪婪之手在战斗内加钱，
    // settleCombat 再写回来。带的是**当前值**而不是 0，因为参考的战斗内金币是绝对值
    // （盗贼/劫掠者偷钱时读它，虽然那两只怪还没登记）。
    gold: state.gold,
    character: state.character,
    relics: state.relics.map((relic) => relic.id),
    potions: [...state.potions],
    // 药水槽容量就是槽位数组长度（药水腰带 onEquip 直接 push 了两格）。
    potionCapacity: state.potions.length,
    potionRng: takePotionRng(state),
  });
  state.screen = "combat";
  settleCombat(state, bc);
}

/**
 * 每个动作之后把战斗状态写回 GameState。
 *
 * 战斗未结束 → 存快照；已结束 → 清快照并做 run 级收尾。非 Boss 的卡/金币/药水奖励
 * 留给 engine.ts 的 settleAfterCombat（它看到 screen 仍是 "combat" 而 combat 已为 null
 * 就生成奖励）。
 */
function settleCombat(state: GameState, bc: BattleContext): void {
  // 玩家血量、金币与药水槽是 run 级资源，战斗内的变化（果汁涨上限、贪婪之手赚钱、
  // 喝掉药水）要落回去。金币这条对齐参考的 `exitBattle`：`g.gold = player.gold`
  // （BattleContext.cpp:484）。⚠ 与 hp 一样是**每个动作之后**都写回，不是只在战斗结束时——
  // 战斗中途取档再读回来时 `state.gold` 与 `state.combat.player.gold` 必须一致。
  state.hp = bc.player.hp;
  state.maxHp = bc.player.maxHp;
  state.gold = bc.player.gold;
  state.potions = [...bc.potions];
  state.stsPotionRng = bc.rng.potionRng.toState();

  if (bc.outcome === "player_victory") {
    state.combat = null;
    state.log.push("战斗胜利！");
    fireCombatEndRelics(state);
    if (getEncounterDef(bc.encounterId).isBoss) {
      grantBossVictory(state);
    }
    return;
  }
  if (bc.outcome === "player_loss") {
    state.combat = null;
    state.screen = "gameover";
    state.log.push("你倒下了。");
    return;
  }
  state.combat = exportState(bc);
}

/**
 * 战斗后的遗物结算（燃烧之血回血一类）。参考项目里这也不在 BattleContext 内，而是战斗
 * 结束后由 GameContext 做，所以留在 run 层：`onCombatEnd` 是 relics.ts 仅存的战斗相关钩子。
 */
function fireCombatEndRelics(state: GameState): void {
  for (const relic of state.relics) {
    getRelicDef(relic.id).hooks.onCombatEnd?.(state, relic);
  }
}

/** 指向性动作的目标解析：给了有效目标就用它，否则场上只剩一只怪时自动指那只。 */
function resolveTarget(bc: BattleContext, targetIndex: number | null): number {
  if (targetIndex !== null && bc.monsters[targetIndex]?.alive === true) {
    return targetIndex;
  }
  const living = bc.monsters.flatMap((m, index) => (m.alive ? [index] : []));
  return living.length === 1 ? living[0] : (targetIndex ?? 0);
}

// ============================================================================
// 玩家动作（engine.ts 的 applyAction 只用这三个）
// ============================================================================

export type UsePotionResult = { ok: true } | { ok: false; reason: string };

export function playCard(
  state: GameState,
  handIndex: number,
  targetIndex: number | null,
): PlayCardResult {
  if (state.combat === null) {
    return { ok: false, reason: "现在不在战斗中。" };
  }
  const bc = importState(state.combat);
  const result = stsPlayCard(bc, handIndex, resolveTarget(bc, targetIndex));
  // 被拒时 bc 是丢弃的副本，GameState 自然分毫未动。
  if (result.ok) {
    settleCombat(state, bc);
  }
  return result;
}

export function endTurn(state: GameState): EndTurnResult {
  if (state.combat === null) {
    return { ok: false, reason: "现在不在战斗中。" };
  }
  const bc = importState(state.combat);
  const result = stsEndTurn(bc);
  // 被拒时 bc 是丢弃的副本，GameState 自然分毫未动（同 playCard）。
  if (result.ok) {
    settleCombat(state, bc);
  }
  return result;
}

// ============================================================================
// 选牌屏（战斗内）
//
// ⚠ 与 run 层的 `screen === "card_select"`（图书馆 / 复制器 / 和平烟斗那套）是两回事：
// 那个走 applyChoose，改的是大牌组；这里是战斗内的一次输入，屏幕仍停在 "combat"，
// 状态挂在 `state.combat.cardSelect` 上。合成一个屏幕会让两套完全不同的动作语义打架。
// ============================================================================

/** 当前是否在等玩家选牌；顺带给出合法候选（null = 没开屏）。 */
export function pendingCardSelect(state: GameState): CardSelectOptions | null {
  if (state.combat === null) {
    return null;
  }
  return cardSelectOptions(state.combat);
}

export function selectCard(state: GameState, index: number): SelectCardResult {
  if (state.combat === null) {
    return { ok: false, reason: "现在不在战斗中。" };
  }
  const bc = importState(state.combat);
  const result = stsSelectCard(bc, index);
  if (result.ok) {
    settleCombat(state, bc);
  }
  return result;
}

export function selectCards(state: GameState, indices: readonly number[]): SelectCardResult {
  if (state.combat === null) {
    return { ok: false, reason: "现在不在战斗中。" };
  }
  const bc = importState(state.combat);
  const result = stsSelectCards(bc, indices);
  if (result.ok) {
    settleCombat(state, bc);
  }
  return result;
}

export function usePotion(
  state: GameState,
  slotIndex: number,
  targetIndex: number | null,
): UsePotionResult {
  const potionId = state.potions[slotIndex] ?? null;
  if (potionId === null) {
    return { ok: false, reason: `药水槽 ${slotIndex} 是空的。` };
  }
  // TODO(接线): 战斗外喝药水（地图上喝血药水等）随近似实现一起删了，
  // 等游戏级 run 层（奖励 / 事件 / 商店）落地时一并重写。
  if (state.combat === null) {
    return { ok: false, reason: "战斗外使用药水尚未迁移。" };
  }
  const bc = importState(state.combat);
  const result = drinkPotion(bc, slotIndex, resolveTarget(bc, targetIndex));
  if (result.ok) {
    state.log.push(`你使用了「${getPotionDef(potionId).name}」。`);
    settleCombat(state, bc);
  }
  return result;
}
