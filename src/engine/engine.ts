import type { CardInstance, CharacterId, CombatEngine, GameState } from "./types.js";
import { getCharacterConfig } from "./characters/characters.js";
import { seedRng } from "./rng.js";
import { seedStringToLong } from "./sts-rng.js";
import { endTurn, playCard, usePotion } from "./combat-bridge.js";
import { TOTAL_ACTS, advanceToNextAct, applyChoose, buildMap, generateReward } from "./run/run.js";
import { POTION_SLOTS } from "./potions/potions.js";
import { NEOW_EVENT_ID } from "./events/events.js";

// === 引擎顶层：新建对局 + 动作分发 ===
//
// 纯函数式副作用：applyAction 原地改传入的 GameState。HTTP 层负责 version 自增与存档。

export type GameAction =
  | { type: "play_card"; handIndex: number; targetIndex?: number | null }
  | { type: "end_turn" }
  | { type: "use_potion"; slotIndex: number; targetIndex?: number | null }
  | { type: "choose"; optionIndex: number };

export type ActionResult = { ok: true } | { ok: false; reason: string };

export function newRun(input: {
  runId: string;
  /**
   * 种子。传 number / bigint 视作数值种子；传 string 视作**游戏内显示的种子串**
   * （base-35，如 "1RGBGHNF7L"），会按原版规则换算成 int64。
   */
  seed: number | bigint | string;
  character?: CharacterId;
  ascension?: number;
  /**
   * 用哪套战斗实现，缺省 `"legacy"`（近似实现，覆盖几乎全部内容）。
   * 传 `"sts"` 则逐场优先走游戏级战斗 `sts-combat.ts`（与原版逐位一致），
   * 它尚未覆盖的战斗会自动回退 legacy 并在 log 里写明——详见 combat-bridge.ts。
   */
  combatEngine?: CombatEngine;
}): GameState {
  const character: CharacterId = input.character ?? "ironclad";
  const config = getCharacterConfig(character);
  const seedLong =
    typeof input.seed === "string" ? seedStringToLong(input.seed) : BigInt(input.seed);
  // 旧的玩具 RNG 仍按低位数值播种，维持现有近似栈的行为不变。
  const rng = seedRng(Number(BigInt.asIntN(53, seedLong)));
  let nextUid = 1;
  const deck: CardInstance[] = config.starterDeck.map((defId) => ({
    uid: nextUid++,
    defId,
    upgraded: false,
  }));
  const state: GameState = {
    version: 0,
    runId: input.runId,
    seed: seedLong.toString(),
    floorNum: 0,
    character,
    ascension: input.ascension ?? 0,
    act: 1,
    screen: "map",
    hp: config.maxHp,
    maxHp: config.maxHp,
    gold: 0,
    deck,
    relics: [{ id: config.starterRelic, counter: 0 }],
    potions: new Array<string | null>(POTION_SLOTS).fill(null),
    potionDropBonus: 0,
    map: { nodes: {}, rows: 0, startNodeIds: [], bossNodeId: "" },
    currentNodeId: null,
    combatEngine: input.combatEngine ?? "legacy",
    combat: null,
    stsCombat: null,
    stsPotionRng: null,
    reward: null,
    event: null,
    shop: null,
    cardSelect: null,
    combatsEntered: 0,
    pendingRelicReward: false,
    rng,
    nextUid,
    log: [],
  };
  buildMap(state);
  // 开局先给涅奥祝福（复用事件界面）；选完 backToMap 回到已生成的地图。
  state.event = { id: NEOW_EVENT_ID };
  state.screen = "event";
  return state;
}

export function applyAction(state: GameState, action: GameAction): ActionResult {
  state.log = [];
  if (state.screen === "gameover" || state.screen === "victory") {
    return { ok: false, reason: "对局已结束，调用 start_run 开始新的一局。" };
  }

  switch (action.type) {
    case "play_card": {
      const result = playCard(state, action.handIndex, action.targetIndex ?? null);
      if (result.ok) {
        settleAfterCombat(state);
      }
      return result;
    }
    case "end_turn": {
      if (state.screen !== "combat") {
        return { ok: false, reason: "现在不在战斗中，无法结束回合。" };
      }
      endTurn(state);
      settleAfterCombat(state);
      return { ok: true };
    }
    case "use_potion": {
      const result = usePotion(state, action.slotIndex, action.targetIndex ?? null);
      if (result.ok) {
        settleAfterCombat(state);
      }
      return result;
    }
    case "choose": {
      if (
        state.screen !== "reward" &&
        state.screen !== "rest" &&
        state.screen !== "map" &&
        state.screen !== "event" &&
        state.screen !== "shop" &&
        state.screen !== "card_select"
      ) {
        return { ok: false, reason: "当前屏幕没有可选项。" };
      }
      return applyChoose(state, action.optionIndex);
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return { ok: false, reason: "未知动作。" };
    }
  }
}

/** 战斗胜利后收尾：非 Boss 转卡奖励；Boss 胜利若还有后续幕则携带状态进入下一幕，否则通关。 */
function settleAfterCombat(state: GameState): void {
  // 「战斗字段清空但还停在战斗屏」= 刚刚打赢一场非 Boss 战。两套实现各占一个字段，
  // 都要判：走 sts 路径时 state.combat 恒为 null，只看它会每个动作都发一次奖励。
  if (state.combat === null && state.stsCombat === null && state.screen === "combat") {
    generateReward(state);
    return;
  }
  // Boss 胜利（战斗实现已置 screen="victory"）：非最终幕则进入下一幕。
  if (state.screen === "victory" && state.act < TOTAL_ACTS) {
    advanceToNextAct(state);
  }
}
