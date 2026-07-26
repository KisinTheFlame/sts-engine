import type { GameState } from "../engine/types.js";
import type { GameAction } from "../engine/engine.js";
import { costOf, getCardDef, targetedOf } from "../engine/cards/cards.js";
import { getEventDef } from "../engine/events/events.js";
import { nextInt } from "../engine/rng.js";
import { availableNext } from "../engine/map/map.js";
import { cardSelectOptions } from "../engine/sts-combat.js";
import type { RngState } from "../engine/types.js";

// === 自动对战策略 ===
//
// 纯引擎层：只读 GameState、产出合法 GameAction。用于平衡验证（跑几千局看胜率/回合数）
// 与黄金种子回归（确定性）。策略自带 RNG（与游戏 RNG 分离，不污染对局种子）。

/** 策略需要的战斗视图（从 BattleContext 快照里取那么几项）。 */
type CombatView = {
  hand: { defId: string; upgraded: boolean }[];
  energy: number;
  /** 贪心的攻击目标：血最低的存活怪。 */
  target: number;
  /** 缠绕：本回合打不出攻击牌。 */
  entangled: boolean;
};

function combatView(state: GameState): CombatView | null {
  if (state.screen !== "combat" || state.combat === null) {
    return null;
  }
  const combat = state.combat;
  let target = 0;
  let bestHp = Infinity;
  combat.monsters.forEach((monster, index) => {
    if (monster.alive && monster.hp < bestHp) {
      bestHp = monster.hp;
      target = index;
    }
  });
  return {
    hand: combat.hand.map((card) => ({ defId: card.defId, upgraded: card.upgraded })),
    energy: combat.player.energy,
    target,
    entangled: combat.player.powers.some((p) => p.id === "entangled" && p.amount > 0),
  };
}

/**
 * 战斗内选牌屏的合法动作（null = 没开屏）。
 *
 * ⚠ 必须先于普通战斗动作判断：选牌屏没关之前 sts-combat 会拒绝打牌 / 结束回合，
 * 策略若还在那两个里挑，`pnpm sim` 会在选牌屏上原地死循环。
 *
 * 多选（净化）只给「一张都不选」这一个选项，与 harness 的策略
 *（`enumerateCardSelectActions` 对 EXHAUST_MANY 只产出空选择）一致——于是 sim 走的路径
 * 正好是 trace 验证过的那条。想让 sim 真去消耗手牌，得先有能背书它的预言机。
 */
function cardSelectActions(state: GameState): GameAction[] | null {
  if (state.screen !== "combat" || state.combat === null) {
    return null;
  }
  const options = cardSelectOptions(state.combat);
  if (options === null) {
    return null;
  }
  if (options.mode === "multi") {
    return [{ type: "select_cards", indices: [] }];
  }
  // 候选为空是不可能的：开屏的前提就是「≥2 个候选」（见 sts-combat 的开屏动作）。
  return options.idxs.map((index) => ({ type: "select_card", index }));
}

/** 枚举当前态下的合法动作。 */
function legalActions(state: GameState): GameAction[] {
  const selecting = cardSelectActions(state);
  if (selecting !== null) {
    return selecting;
  }
  const combat = combatView(state);
  if (combat) {
    const actions: GameAction[] = [];
    combat.hand.forEach((instance, handIndex) => {
      const def = getCardDef(instance.defId);
      const cost = costOf(def, instance.upgraded);
      const blockedByEntangle = combat.entangled && def.type === "attack";
      if (cost !== null && cost <= combat.energy && !blockedByEntangle) {
        actions.push({
          type: "play_card",
          handIndex,
          targetIndex: targetedOf(def, instance.upgraded) ? combat.target : null,
        });
      }
    });
    actions.push({ type: "end_turn" });
    return actions;
  }
  if (state.screen === "map") {
    const count = availableNext(state.map, state.currentNodeId).length;
    return Array.from({ length: Math.max(1, count) }, (_, optionIndex) => ({
      type: "choose" as const,
      optionIndex,
    }));
  }
  if (state.screen === "event" && state.event) {
    const count = getEventDef(state.event.id).choices.length;
    return Array.from({ length: Math.max(1, count) }, (_, optionIndex) => ({
      type: "choose" as const,
      optionIndex,
    }));
  }
  if (state.screen === "shop" && state.shop) {
    // 去牌子界面：移除任意一张牌或取消（都推进流程）。
    if (state.shop.removing) {
      return Array.from({ length: state.deck.length + 1 }, (_, optionIndex) => ({
        type: "choose" as const,
        optionIndex,
      }));
    }
    // 只列「买得起且未售」的商品 + 离开，避免策略卡在非法购买上。
    const actions: GameAction[] = [];
    state.shop.items.forEach((item, optionIndex) => {
      const roomForPotion = item.kind !== "potion" || state.potions.indexOf(null) >= 0;
      if (!item.sold && state.gold >= item.cost && roomForPotion) {
        actions.push({ type: "choose", optionIndex });
      }
    });
    actions.push({ type: "choose", optionIndex: state.shop.items.length + 1 }); // 离开
    return actions;
  }
  if (state.screen === "reward" || state.screen === "rest") {
    // 选项数量 = currentOptions().length；这里不引 run 层，直接按已知结构估算上界后再交给引擎校验。
    // reward: cardChoices + 跳过；rest: 1(休息) + 可升级卡数。用一个安全上界枚举，引擎会拒绝越界。
    const count =
      state.screen === "reward"
        ? (state.reward?.cardChoices.length ?? 0) + 1
        : 1 + state.deck.filter((card) => !card.upgraded).length;
    return Array.from({ length: Math.max(1, count) }, (_, optionIndex) => ({
      type: "choose" as const,
      optionIndex,
    }));
  }
  return [];
}

export interface Policy {
  decide(state: GameState): GameAction;
}

export class RandomPolicy implements Policy {
  private readonly rng: RngState;
  public constructor(rng: RngState) {
    this.rng = rng;
  }
  public decide(state: GameState): GameAction {
    const actions = legalActions(state);
    return actions[nextInt(this.rng, actions.length)] ?? { type: "end_turn" };
  }
}

/** 贪心：能打的攻击往最低血敌人砸、否则出防御，最后 end_turn；非战斗屏永远选第一项。 */
export class GreedyPolicy implements Policy {
  public decide(state: GameState): GameAction {
    // 选牌屏优先：不选完，打牌与结束回合都会被拒。取最小下标，与 harness 的策略一致。
    const selecting = cardSelectActions(state);
    if (selecting !== null) {
      return selecting[0];
    }
    // 商店：贪心不购物也不去牌，直接离开（去牌子界面则取消），避免卡在售罄/买不起上。
    if (state.screen === "shop" && state.shop) {
      if (state.shop.removing) {
        return { type: "choose", optionIndex: state.deck.length }; // 取消
      }
      return { type: "choose", optionIndex: state.shop.items.length + 1 }; // 离开
    }
    const combat = combatView(state);
    if (!combat) {
      return { type: "choose", optionIndex: 0 };
    }
    // 先上能力牌（常驻收益），再出攻击牌，最后加格挡牌，够费就打。
    const order = ["power", "attack", "skill"];
    for (const wantType of order) {
      for (let handIndex = 0; handIndex < combat.hand.length; handIndex += 1) {
        const def = getCardDef(combat.hand[handIndex].defId);
        const cost = costOf(def, combat.hand[handIndex].upgraded);
        if (combat.entangled && def.type === "attack") {
          continue; // 缠绕：本回合打不出攻击牌。
        }
        if (def.type === wantType && cost !== null && cost <= combat.energy) {
          return {
            type: "play_card",
            handIndex,
            targetIndex: targetedOf(def, combat.hand[handIndex].upgraded) ? combat.target : null,
          };
        }
      }
    }
    return { type: "end_turn" };
  }
}
