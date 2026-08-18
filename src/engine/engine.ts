import type { CardInstance, CharacterId, GameState } from "./types.js";
import { getCharacterConfig } from "./characters/characters.js";
import { seedRng } from "./rng.js";
import { seedStringToLong } from "./sts-rng.js";
import { endTurn, playCard, selectCard, selectCards, usePotion } from "./combat-bridge.js";
import { TOTAL_ACTS, advanceToNextAct, applyChoose, buildMap, generateReward } from "./run/run.js";
import { POTION_SLOTS } from "./potions/potions.js";
import { NEOW_EVENT_ID } from "./events/events.js";
import { encounterIdOf, generateEncounters } from "./sts-encounters.js";
import type { EncounterPlan } from "./types.js";

// === 引擎顶层：新建对局 + 动作分发 ===
//
// 纯函数式副作用：applyAction 原地改传入的 GameState。HTTP 层负责 version 自增与存档。

export type GameAction =
  | { type: "play_card"; handIndex: number; targetIndex?: number | null }
  | { type: "end_turn" }
  | { type: "use_potion"; slotIndex: number; targetIndex?: number | null }
  // 战斗内选牌屏（军备 / 焚誓 / 头槌 …）。合法候选由 combat-bridge 的 pendingCardSelect
  // 给出；下标是**相对该任务的源牌堆**的（见 sts-combat 的 cardSelectSource）。
  // 与 `choose` 无关——那个是 run 层屏幕（奖励 / 事件 / 商店 / 大牌组选牌）的通用选项。
  | { type: "select_card"; index: number }
  | { type: "select_cards"; indices: number[] }
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
    combat: null,
    stsPotionRng: null,
    reward: null,
    event: null,
    shop: null,
    cardSelect: null,
    combatsEntered: 0,
    // 遭遇计划：`monsterRng` 是一条**持久流**（`Random(seed)`，三幕续 counter），
    // 所以开局算一次、存下来按序索引（第五十一批）。
    encounterPlan: buildEncounterPlan(seedLong),
    encounterCursor: { monsters: [0, 0, 0], elites: [0, 0, 0] },
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

/**
 * 把 `generateEncounters` 的三幕结果投影成引擎的编队 id（第五十一批）。
 *
 * ⚠ 这里**一次算完三幕**，而不是每幕现算：`monsterRng` 是一条持久流，三幕续同一个 counter，
 * 分幕现算会让第二 / 三幕的取值整体错位。
 * ⚠ `migrate.ts` 给老存档回填时走的也是这个函数——它对同一个 seed 是确定的，所以回填出来的
 * 计划与新开局逐位相同（缺的只是「已经打过几场」，见那边的注释）。
 */
export function buildEncounterPlan(seedLong: bigint): EncounterPlan {
  return generateEncounters(seedLong).map((act) => ({
    monsters: act.monsters.map(encounterIdOf),
    elites: act.elites.map(encounterIdOf),
    boss: encounterIdOf(act.boss),
    secondBoss: act.secondBoss === null ? null : encounterIdOf(act.secondBoss),
  }));
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
      const result = endTurn(state);
      if (result.ok) {
        settleAfterCombat(state);
      }
      return result;
    }
    case "select_card": {
      const result = selectCard(state, action.index);
      if (result.ok) {
        settleAfterCombat(state);
      }
      return result;
    }
    case "select_cards": {
      const result = selectCards(state, action.indices);
      if (result.ok) {
        settleAfterCombat(state);
      }
      return result;
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
  // 「combat 已清空但还停在战斗屏」= 刚刚打赢一场非 Boss 战。
  if (state.combat === null && state.screen === "combat") {
    generateReward(state);
    return;
  }
  // Boss 胜利（战斗实现已置 screen="victory"）：非最终幕则进入下一幕。
  if (state.screen === "victory" && state.act < TOTAL_ACTS) {
    advanceToNextAct(state);
  }
}
