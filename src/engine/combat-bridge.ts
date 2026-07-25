import type { GameState } from "./types.js";
import { getCardDef } from "./cards/cards.js";
import { getEncounterDef } from "./enemies/enemies.js";
import { getRelicDef } from "./relics/relics.js";
import type { RelicDef } from "./relics/relics.js";
import { getPotionDef } from "./potions/potions.js";
import {
  endTurn as legacyEndTurn,
  playCard as legacyPlayCard,
  startCombat as legacyStartCombat,
  usePotion as legacyUsePotion,
} from "./combat/combat.js";
import type { PlayCardResult, UsePotionResult } from "./combat/combat.js";
import {
  drinkPotion,
  endTurn as stsEndTurn,
  exportState,
  importState,
  initCombat,
  isCardSupported,
  isEncounterSupported,
  isPotionSupported,
  isRelicSupported,
  playCard as stsPlayCard,
  type BattleContext,
} from "./sts-combat.js";
import { StsRandom } from "./sts-rng.js";
import { grantBossVictory } from "./post-combat.js";

// === 两套战斗实现接到引擎上的唯一接缝（TODOS「接线」第 1、2 项）===
//
// run.ts / engine.ts 只认这里导出的 startCombat / playCard / endTurn / usePotion，
// 由本文件按 state.combatEngine 与**逐场覆盖面**决定把这场战斗交给谁：
//
//   combatEngine = "legacy" → 一律走 combat/combat.ts（近似实现，覆盖几乎全部内容）
//   combatEngine = "sts"    → 覆盖得到就走 sts-combat.ts（与原版逐位一致），
//                             覆盖不到则回退 legacy 并在 log 里写明原因
//
// 两条路径的战斗状态分别落在 state.combat / state.stsCombat，同一时刻至多一个非 null；
// 动作分发看的就是哪个非 null，所以一场战斗中途不会换实现。
//
// 为什么不直接一刀切换：sts-combat 现在只覆盖 14 张牌 / 4 只怪 / 5 个编队（见 TODOS.md），
// 硬切会让引擎在绝大多数战斗里当场抛错。回退是**显式且可见的**（log + stsCombatCoverage
// 可查），不是静默降级。

// ============================================================================
// 覆盖面判定
// ============================================================================

export type CombatCoverage = { supported: true } | { supported: false; reason: string };

/**
 * 战斗内会触发的遗物钩子。onCombatEnd 不在其中——它是战斗**之后**的 run 级结算，
 * 本文件在胜利时统一补上（fireCombatEndRelics），故燃烧之血这类遗物不妨碍走 sts 路径。
 * onEquip / onAddCard 同理属局外。
 */
const IN_COMBAT_HOOKS: readonly (keyof RelicDef["hooks"])[] = [
  "onCombatStart",
  "onTurnStart",
  "onTurnEnd",
  "onCardPlayed",
  "onLoseHp",
  "onExhaust",
  "onEnemyKilled",
  "onUsePotion",
  "onShuffle",
  "onDiscard",
];

/**
 * 有战斗内行为、但不走钩子的遗物——它们的效果散在 combat.ts 里按 `hasRelic` 内联判断。
 * 光看 hooks 判不出来，只能列出来；查法：`grep -o 'hasRelic(state, "[a-z_]*"' combat.ts`
 * 与 `grep -o 'relic.id === "[a-z_]*"' combat.ts`。
 * 等某个遗物在 sts-combat 里登记后，isRelicSupported 会先命中，这份名单不必删。
 */
const HOOKLESS_IN_COMBAT_RELICS: readonly string[] = [
  "ancient_tea_set",
  "blue_candle",
  "calipers",
  "champion_belt",
  "chemical_x",
  "cracked_core",
  "emotion_chip",
  "gambling_chip",
  "ginger",
  "gold_plated_cables",
  "golden_eye",
  "hand_drill",
  "ice_cream",
  "magic_flower",
  "medical_kit",
  "odd_mushroom",
  "paper_krane",
  "paper_phrog",
  "pen_nib",
  "pure_water",
  "ring_of_the_snake",
  "runic_pyramid",
  "sacred_bark",
  "snecko_eye",
  "snecko_skull",
  "sozu",
  "strange_spoon",
  "strike_dummy",
  "the_boot",
  "the_specimen",
  "torii",
  "tungsten_rod",
  "turnip",
  "unceasing_top",
  "velvet_choker",
  "violet_lotus",
  "wrist_blade",
];

function relicActsInCombat(relicId: string): boolean {
  const hooks = getRelicDef(relicId).hooks;
  return (
    IN_COMBAT_HOOKS.some((hook) => hooks[hook] !== undefined) ||
    HOOKLESS_IN_COMBAT_RELICS.includes(relicId)
  );
}

/**
 * 这场战斗能否交给 sts-combat。
 *
 * 只看「会不会漏东西」：编队/牌/药水未登记会抛错或静默错配 RNG，未登记的遗物会
 * 被悄悄跳过——两种都不能接受。ascension 不在判据内：怪物的 asc 分支是逐行转写的
 * （只是 trace 目前只跑了 asc 0）。
 */
export function stsCombatCoverage(state: GameState, encounterId: string): CombatCoverage {
  const no = (reason: string): CombatCoverage => ({ supported: false, reason });

  // 姿态 / 充能球整类未迁移，其余三个角色的起始牌与起始遗物都会用到。
  if (state.character !== "ironclad") {
    return no(`sts-combat 目前只覆盖铁甲，本局是 ${state.character}`);
  }
  if (!isEncounterSupported(encounterId)) {
    return no(`编队「${encounterId}」尚未迁移（无 trace 背书）`);
  }
  for (const card of state.deck) {
    const def = getCardDef(card.defId);
    if (!isCardSupported(card.defId)) {
      return no(`牌「${def.name}」尚未迁移`);
    }
    // 固有牌需要开局归位，sts-combat 还没实现（见 initCombat 里的 TODO）。
    if (card.innate === true || def.innate === true || (card.upgraded && def.upgradedInnate)) {
      return no(`固有牌「${def.name}」的开局归位尚未迁移`);
    }
  }
  for (const potion of state.potions) {
    if (potion !== null && !isPotionSupported(potion)) {
      return no(`药水「${potion}」尚未迁移`);
    }
  }
  for (const relic of state.relics) {
    if (!isRelicSupported(relic.id) && relicActsInCombat(relic.id)) {
      return no(`遗物「${getRelicDef(relic.id).name}」的战斗内行为尚未迁移`);
    }
  }
  return { supported: true };
}

// ============================================================================
// GameState ↔ BattleContext
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

function startStsCombat(state: GameState, encounterId: string): void {
  const bc = initCombat({
    seedLong: BigInt(state.seed),
    // resolveNode 已在进入节点时自增，对齐 GameContext::transitionToMapNode 的
    // ++floorNum → Random(seed + floorNum)。
    floorNum: state.floorNum,
    ascension: state.ascension,
    encounterId,
    deck: state.deck.map((card) => ({ defId: card.defId, upgraded: card.upgraded })),
    playerHp: state.hp,
    playerMaxHp: state.maxHp,
    character: state.character,
    relics: state.relics.map((relic) => relic.id),
    potions: [...state.potions],
    // 药水槽容量就是槽位数组长度（药水腰带 onEquip 直接 push 了两格）。
    potionCapacity: state.potions.length,
    potionRng: takePotionRng(state),
  });
  state.combat = null;
  state.screen = "combat";
  settleStsCombat(state, bc);
}

/**
 * 每个动作之后把战斗状态写回 GameState。
 *
 * 战斗未结束 → 存快照；已结束 → 清快照并做 run 级收尾。非 Boss 的卡/金币/药水奖励
 * 留给 engine.ts 的 settleAfterCombat（它看到 screen 仍是 "combat" 且两个战斗字段都
 * 为 null 就生成奖励），与 legacy 路径同一条出口。
 */
function settleStsCombat(state: GameState, bc: BattleContext): void {
  // 玩家血量与药水槽是 run 级资源，战斗内的变化（果汁涨上限、喝掉药水）要落回去。
  state.hp = bc.player.hp;
  state.maxHp = bc.player.maxHp;
  state.potions = [...bc.potions];
  state.stsPotionRng = bc.rng.potionRng.toState();

  if (bc.outcome === "player_victory") {
    state.stsCombat = null;
    state.log.push("战斗胜利！");
    fireCombatEndRelics(state);
    if (getEncounterDef(bc.encounterId).isBoss) {
      grantBossVictory(state);
    }
    return;
  }
  if (bc.outcome === "player_loss") {
    state.stsCombat = null;
    state.screen = "gameover";
    state.log.push("你倒下了。");
    return;
  }
  state.stsCombat = exportState(bc);
}

/**
 * 战斗后的遗物结算（燃烧之血回血一类）。参考项目里这也不在 BattleContext 内，
 * 而是战斗结束后由 GameContext 做，所以这里复用 legacy 的 onCombatEnd 钩子。
 *
 * emit 直接抛错：目前所有 onCombatEnd 钩子都只回血，一旦有遗物开始发射战斗 Effect，
 * 就说明它需要在 sts-combat 里登记，宁可测试当场炸掉也不静默丢掉效果。
 */
function fireCombatEndRelics(state: GameState): void {
  for (const relic of state.relics) {
    getRelicDef(relic.id).hooks.onCombatEnd?.(state, relic, (effect) => {
      throw new Error(
        `遗物「${relic.id}」的 onCombatEnd 发射了战斗 Effect（${effect.kind}），` +
          `sts-combat 路径无法结算——需要先把它登记进 sts-combat.ts`,
      );
    });
  }
}

/**
 * 指向性动作的目标解析：与 legacy 对齐——给了有效目标就用它，否则场上只剩一只怪时
 * 自动指那只。都不成立就原样递下去，交给 sts-combat 拒绝（引擎层不替玩家瞎猜目标）。
 */
function resolveTarget(bc: BattleContext, targetIndex: number | null): number {
  if (targetIndex !== null && bc.monsters[targetIndex]?.alive === true) {
    return targetIndex;
  }
  const living = bc.monsters.flatMap((m, index) => (m.alive ? [index] : []));
  return living.length === 1 ? living[0] : (targetIndex ?? 0);
}

// ============================================================================
// 引擎入口（run.ts / engine.ts 只用这四个）
// ============================================================================

/**
 * 开一场战斗：按 combatEngine 与覆盖面选实现。
 *
 * isElite 只递给 legacy——sts 侧暂无对应语义（用它的勇气投索 / 密封昆虫都还没迁移，
 * 覆盖面检查会先把它们挡住）。精英战的遗物奖励走 state.pendingRelicReward，与此无关。
 */
export function startCombat(state: GameState, encounterId: string, isElite = false): void {
  if (state.combatEngine === "sts") {
    const coverage = stsCombatCoverage(state, encounterId);
    if (coverage.supported) {
      startStsCombat(state, encounterId);
      return;
    }
    state.log.push(`（本场走近似战斗：${coverage.reason}）`);
  }
  legacyStartCombat(state, encounterId, isElite);
}

export function playCard(
  state: GameState,
  handIndex: number,
  targetIndex: number | null,
): PlayCardResult {
  if (state.stsCombat === null) {
    return legacyPlayCard(state, handIndex, targetIndex);
  }
  const bc = importState(state.stsCombat);
  const result = stsPlayCard(bc, handIndex, resolveTarget(bc, targetIndex));
  // 被拒时 bc 是丢弃的副本，GameState 自然分毫未动。
  if (result.ok) {
    settleStsCombat(state, bc);
  }
  return result;
}

export function endTurn(state: GameState): void {
  if (state.stsCombat === null) {
    legacyEndTurn(state);
    return;
  }
  const bc = importState(state.stsCombat);
  stsEndTurn(bc);
  settleStsCombat(state, bc);
}

export function usePotion(
  state: GameState,
  slotIndex: number,
  targetIndex: number | null,
): UsePotionResult {
  // 战斗外喝药水（地图上喝血药水等）本就走 legacy 的局外分支。
  if (state.stsCombat === null) {
    return legacyUsePotion(state, slotIndex, targetIndex);
  }
  const potionId = state.potions[slotIndex] ?? null;
  const bc = importState(state.stsCombat);
  const result = drinkPotion(bc, slotIndex, resolveTarget(bc, targetIndex));
  if (result.ok) {
    // ok 蕴含槽位非空（drinkPotion 会先拒空槽），null 分支只是替断言省事。
    if (potionId !== null) {
      state.log.push(`你使用了「${getPotionDef(potionId).name}」。`);
    }
    settleStsCombat(state, bc);
  }
  return result;
}
