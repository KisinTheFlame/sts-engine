import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyAction, newRun } from "../src/engine/engine.js";
import type { GameAction } from "../src/engine/engine.js";
import { costOf, getCardDef } from "../src/engine/cards/cards.js";
import {
  pendingCardSelect,
  startCombat,
  stsCombatCoverage,
  usePotion,
} from "../src/engine/combat-bridge.js";
import {
  ASC_SUPPORTED_ENCOUNTERS,
  SUPPORTED_ENCOUNTERS,
  addToBot,
  exportState,
  importState,
  initCombat,
} from "../src/engine/sts-combat.js";
import { StsRandom } from "../src/engine/sts-rng.js";
import { seedRng } from "../src/engine/rng.js";
import { GreedyPolicy, RandomPolicy } from "../src/sim/policy.js";
import type { GameState } from "../src/engine/types.js";

// ============================================================================
// 接线：run.ts / engine.ts 经 combat-bridge 用 sts-combat 打所有战斗，
// 战斗状态落在 GameState.combat（BattleContext 的纯数据投影）上。
//
// 这里钉三件事：
//   ① 接线本身不扰动战斗——桥递进去的入参必须与直接调 initCombat 逐字段一致
//   ② 快照可往返——GameState 过一遍 JSON 后继续打，结果与不落盘完全相同
//   ③ 尚未迁移的内容显式抛错——没有近似实现可退，静默降级比失败危险
// ============================================================================

/** 起一局并越过涅奥祝福，停在可以直接开战的状态。 */
function runAtMap(seed = 1): GameState {
  const state = newRun({ runId: "wiring", seed });
  state.event = null;
  state.screen = "map";
  return state;
}

/**
 * sts 路径的下一步动作：能量够就打最右边那张（从右往左取，出牌不会让下标漂移），
 * 都打不动就结束回合。目标取第一只活着的怪。
 *
 * 选牌屏优先——屏没关之前打牌与结束回合都会被拒，不先处理它会死循环。
 */
function nextAction(state: GameState): GameAction {
  const combat = state.combat!;
  const selecting = pendingCardSelect(state);
  if (selecting !== null) {
    return selecting.mode === "single"
      ? { type: "select_card", index: selecting.idxs[0] }
      : { type: "select_cards", indices: [] };
  }
  const targetIndex = combat.monsters.findIndex((m) => m.alive);
  for (let i = combat.hand.length - 1; i >= 0; i -= 1) {
    const card = combat.hand[i];
    // 费用读**实例级**的 costForTurn（腐化 / 疯狂 / 血债血偿会改它）；打不出的牌
    // （数据表 cost 为 null）直接跳过——它们的 costForTurn 是负的哨兵值。
    if (costOf(getCardDef(card.defId), card.upgraded) === null) {
      continue;
    }
    if (card.costForTurn <= combat.player.energy) {
      return { type: "play_card", handIndex: i, targetIndex };
    }
  }
  return { type: "end_turn" };
}

/** 起一局并把牌组换成指定的（只用已登记的牌，否则 startCombat 会挡）。 */
function runWithDeck(defIds: string[], seed = 5): GameState {
  const state = runAtMap(seed);
  state.deck = defIds.map((defId, i) => ({ uid: 1000 + i, defId, upgraded: false }));
  return state;
}

/** 打一张焚誓开出「消耗一张手牌」的选牌屏，返回停在屏上的对局。 */
function openExhaustOneScreen(): GameState {
  // 全是焚誓：起手 5 张必然都是它，打第一张后手里还剩 4 张候选 → 必然开屏（≥2 张才开）。
  const state = runWithDeck(new Array<string>(10).fill("burning_pact"));
  startCombat(state, "cultist");
  expect(applyAction(state, { type: "play_card", handIndex: 0 })).toEqual({ ok: true });
  expect(state.combat!.inputState).toBe("card_select");
  return state;
}

describe("接线：战斗由 sts-combat 承担", () => {
  it("开战后战斗快照落在 GameState.combat 上", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    expect(state.screen).toBe("combat");
    expect(state.combat).not.toBeNull();
    expect(state.combat!.encounterId).toBe("cultist");
    expect(state.combat!.monsters.map((m) => m.defId)).toEqual(["cultist"]);
    // 起手 5 张、能量 3——由 sts-combat 的 init 决定，不是桥自己造的。
    expect(state.combat!.hand).toHaveLength(5);
    expect(state.combat!.player.energy).toBe(3);
  });

  it("桥递进去的入参与直接调 initCombat 逐字段一致（接线不扰动 RNG）", () => {
    const state = runAtMap(42);
    state.floorNum = 7; // 战斗流按 Random(seed + floorNum) 播种，换层必须换结果
    startCombat(state, "two_louse");
    const direct = initCombat({
      seedLong: BigInt(state.seed),
      floorNum: 7,
      ascension: 0,
      encounterId: "two_louse",
      deck: state.deck.map((card) => ({ defId: card.defId, upgraded: card.upgraded })),
      playerHp: state.hp,
      playerMaxHp: state.maxHp,
      // 金币也是桥必须带进去的 run 级资源（对齐 `player.gold = gc.gold`）。
      // 漏了它这条断言就红——正是要它红。
      gold: state.gold,
      character: "ironclad",
      relics: state.relics.map((relic) => relic.id),
      potions: [...state.potions],
      potionCapacity: state.potions.length,
      potionRng: new StsRandom(BigInt(state.seed)),
    });
    expect(state.combat).toEqual(exportState(direct));
  });

  it("固有牌开局归位：定义级与瓶装遗物封入的实例都进起手牌", () => {
    // 第五批之前这里断言的是「固有牌 → 覆盖面检查抛错」。归位实现之后闸门撤了，
    // 换成钉住真正的行为：固有牌被搬到抽牌堆**顶**，所以开局那 5 张必定含它们。
    // 实例级的 innate（瓶装遗物）是桥必须逐实例带过去的位——杀戮本身不固有，
    // 它出现在起手牌里只能来自那个位。
    const state = runAtMap();
    state.deck.push({ uid: 998, defId: "dramatic_entrance", upgraded: false });
    state.deck.push({ uid: 999, defId: "carnage", upgraded: false, innate: true });
    expect(stsCombatCoverage(state, "cultist")).toEqual({ supported: true });
    startCombat(state, "cultist");
    const hand = state.combat!.hand.map((c) => c.defId);
    expect(hand).toHaveLength(5);
    expect(hand).toContain("dramatic_entrance");
    expect(hand).toContain("carnage");
    const draw = state.combat!.drawPile.map((c) => c.defId);
    expect(draw).not.toContain("dramatic_entrance");
    expect(draw).not.toContain("carnage");
  });

  it("玩家血量与药水槽写回 GameState", () => {
    const state = runAtMap();
    state.potions = ["block_potion", null, null];
    startCombat(state, "cultist");
    expect(usePotion(state, 0, null)).toEqual({ ok: true });
    expect(state.potions).toEqual([null, null, null]);
    expect(state.combat!.player.block).toBe(12);
    expect(state.log.join("")).toContain("你使用了");

    // 挨几刀，血量要跟着掉（战斗内的血是 run 级资源）。
    applyAction(state, { type: "end_turn" });
    applyAction(state, { type: "end_turn" });
    expect(state.hp).toBeLessThan(state.maxHp);
    expect(state.hp).toBe(state.combat!.player.hp);
  });

  it("贪婪之手赚到的金币写回 GameState（战斗内 → run 级）", () => {
    // 金币是本项目第一个进 BattleContext 的**战斗外**资源，所以要钉两头：
    //   ① 入场值来自 run 层（桥传 `gold: state.gold`）；
    //   ② 战斗内赚到的钱每个动作之后都写回 `state.gold`，且与快照里的值一致。
    // trace 对拍看不见这一条（harness 的快照只输出「本场赚了多少」这个增量），
    // 所以接线这一层必须自己有测试守着。
    const state = runWithDeck(new Array<string>(10).fill("hand_of_greed"), 7);
    const goldBefore = state.gold;
    startCombat(state, "two_louse"); // 虱子 10~15 血，20 点一击必杀
    expect(state.combat!.player.gold).toBe(goldBefore);

    // 打到有虱子被杀掉为止（每杀一只 +20）。
    let kills = 0;
    for (let step = 0; step < 30 && state.combat !== null && kills === 0; step += 1) {
      applyAction(state, nextAction(state));
      if (state.combat !== null) {
        kills = state.combat.monsters.filter((m) => !m.alive).length;
      }
    }
    expect(kills).toBeGreaterThan(0);
    expect(state.combat!.player.gold).toBe(goldBefore + 20 * kills);
    // 写回 run 层，且两处一致（中途取档再读回来不能对不上）。
    expect(state.gold).toBe(state.combat!.player.gold);
    expect(exportState(importState(state.combat!))).toEqual(state.combat);
  });

  it("炸弹的三格计时器跟着存档往返，且第 3 个回合末引爆", () => {
    // 炸弹在参考侧压根不在 statusMap 里（buff<THE_BOMB> 只加 bomb3 就 return），
    // 所以它在 trace 的状态快照里**看不见**——只有三回合后那一下全体伤害能被看到。
    // 计时器本身的往返因此得靠这条接线测试。
    const state = runWithDeck(["the_bomb", ...new Array<string>(9).fill("defend")], 3);
    startCombat(state, "cultist");
    const idx = state.combat!.hand.findIndex((c) => c.defId === "the_bomb");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(applyAction(state, { type: "play_card", handIndex: idx })).toEqual({ ok: true });
    // 打出的当回合三格都还没动（结算在回合末）。
    expect([state.combat!.player.bomb1, state.combat!.player.bomb2, state.combat!.player.bomb3]) //
      .toEqual([0, 0, 40]);
    // 往返：三格是纯数据。
    expect(exportState(importState(state.combat!))).toEqual(state.combat);

    // 三个回合末：40 依次前移到 bomb1 再引爆。
    applyAction(state, { type: "end_turn" });
    expect([state.combat!.player.bomb1, state.combat!.player.bomb2]).toEqual([0, 40]);
    applyAction(state, { type: "end_turn" });
    expect([state.combat!.player.bomb1, state.combat!.player.bomb2]).toEqual([40, 0]);
    const hpBefore = state.combat!.monsters[0].hp;
    applyAction(state, { type: "end_turn" });
    // 邪教徒 48~54 血，40 点炸不死它（第三回合它才咏唱完一次），所以战斗还在。
    expect(state.combat).not.toBeNull();
    expect(state.combat!.monsters[0].hp).toBe(hpBefore - 40);
    expect([state.combat!.player.bomb1, state.combat!.player.bomb2, state.combat!.player.bomb3]) //
      .toEqual([0, 0, 0]);
  });

  it("打赢后清空 combat、发奖励，并结算燃烧之血", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    let hpInCombat = state.combat!.player.hp;
    let lastAction: GameAction = { type: "end_turn" };
    for (let step = 0; step < 200 && state.combat !== null; step += 1) {
      hpInCombat = state.combat.player.hp;
      lastAction = nextAction(state);
      applyAction(state, lastAction);
    }
    expect(state.combat).toBeNull();
    // 收尾那一下是出牌（不是敌人回合），故 hpInCombat 就是结算前的血量。
    expect(lastAction.type).toBe("play_card");
    expect(state.screen).toBe("reward");
    expect(state.reward!.cardChoices.length).toBeGreaterThan(0);
    expect(state.gold).toBeGreaterThan(0);
    expect(state.log.join("")).toContain("战斗胜利！");
    // 燃烧之血（铁甲起始遗物）：战斗结束回 6 血。它只有 onCombatEnd 钩子，
    // 属战斗之后的 run 级结算，由桥补上。
    expect(state.hp).toBe(Math.min(state.maxHp, hpInCombat + 6));
  });

  it("玩家阵亡切 gameover 并清空战斗", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    state.combat!.player.hp = 1;
    for (let step = 0; step < 20 && state.screen === "combat"; step += 1) {
      applyAction(state, { type: "end_turn" });
    }
    expect(state.screen).toBe("gameover");
    expect(state.combat).toBeNull();
    expect(state.hp).toBe(0);
    expect(applyAction(state, { type: "end_turn" }).ok).toBe(false);
  });
});

describe("接线：GameState 快照可 JSON 往返", () => {
  it("往返后逐字段不变", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    applyAction(state, { type: "play_card", handIndex: 0, targetIndex: 0 });
    const roundTripped = JSON.parse(JSON.stringify(state)) as GameState;
    expect(roundTripped).toEqual(state);
    // importState→exportState 也必须是恒等（RNG 走 fromState，不重放 counter）。
    expect(exportState(importState(state.combat!))).toEqual(state.combat);
  });

  it("卡牌实例级状态跟着存档往返（暴走的成长、灼热之刃的升级次数、腐化的降费）", () => {
    // 第七批新增的三个逐实例字段是 `GameState.combat` 的一部分，漏掉任何一个，
    // 读回来的档就会把暴走的成长清零、把腐化压过的费用弹回去——都是静默的错。
    const state = runWithDeck([
      "rampage",
      "rampage",
      "corruption",
      "searing_blow",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
    ]);
    startCombat(state, "cultist");

    // 手里的暴走全打掉：每打一次这一实例 +5，两张互不影响。
    let played = 0;
    for (let i = state.combat!.hand.length - 1; i >= 0; i -= 1) {
      if (state.combat!.hand[i].defId === "rampage") {
        expect(applyAction(state, { type: "play_card", handIndex: i, targetIndex: 0 })).toEqual({
          ok: true,
        });
        played += 1;
      }
    }
    const grown = [...state.combat!.discardPile, ...state.combat!.hand].filter(
      (c) => c.defId === "rampage" && c.specialData > 0,
    );
    expect(grown).toHaveLength(played);
    for (const card of grown) {
      expect(card.specialData).toBe(5);
    }

    // 过一遍 JSON：三个字段都是纯数据，往返必须恒等。
    const roundTripped = JSON.parse(JSON.stringify(state)) as GameState;
    expect(roundTripped).toEqual(state);
    expect(exportState(importState(state.combat!))).toEqual(state.combat);
  });

  it("腐化把技能牌压成 0 费这件事也在档里（费用是实例级的）", () => {
    const state = runWithDeck([
      "corruption",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
      "shrug_it_off",
    ]);
    startCombat(state, "cultist");
    const idx = state.combat!.hand.findIndex((c) => c.defId === "corruption");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(applyAction(state, { type: "play_card", handIndex: idx })).toEqual({ ok: true });
    // onBuffCorruption 扫的是四个牌堆，改的是 cost 本身（永久），所以抽牌堆里的也变了。
    for (const card of [...state.combat!.hand, ...state.combat!.drawPile]) {
      if (card.defId === "shrug_it_off") {
        expect(card.cost).toBe(0);
        expect(card.costForTurn).toBe(0);
      }
    }
    // 之后打出的技能牌一律消耗（腐化的另一半），且不扣能量。
    const energyBefore = state.combat!.player.energy;
    const skillIdx = state.combat!.hand.findIndex((c) => c.defId === "shrug_it_off");
    expect(applyAction(state, { type: "play_card", handIndex: skillIdx })).toEqual({ ok: true });
    expect(state.combat!.player.energy).toBe(energyBefore);
    expect(state.combat!.exhaustPile.map((c) => c.defId)).toContain("shrug_it_off");
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  // 一路打到分出胜负：邪教徒那局赢（顺带过一遍奖励结算），
  // 残血进三虱那局输（过一遍阵亡分支）。
  const cases = [
    { seed: 1, encounter: "cultist", startHp: 80, ending: "reward" },
    { seed: 777, encounter: "three_louse", startHp: 6, ending: "gameover" },
  ] as const;

  for (const { seed, encounter, startHp, ending } of cases) {
    it(`每步存盘读盘一次，结果与不落盘完全相同（${encounter} → ${ending}）`, () => {
      const live = runAtMap(seed);
      live.hp = startHp;
      startCombat(live, encounter);
      let saved = JSON.parse(JSON.stringify(live)) as GameState;

      for (let step = 0; step < 200 && live.screen === "combat"; step += 1) {
        // 动作按 live 的手牌挑；两份状态每步都断言相等，所以对 saved 同样合法。
        const action = nextAction(live);
        const liveResult = applyAction(live, action);
        expect(applyAction(saved, action)).toEqual(liveResult);
        // 模拟 HTTP 层的真实节奏：每个动作之后落盘、读回。
        saved = JSON.parse(JSON.stringify(saved)) as GameState;
        expect(saved).toEqual(live);
      }
      expect(live.screen).toBe(ending);
    });
  }
});

describe("接线：战斗内选牌屏", () => {
  it("开屏后状态挂在 combat.cardSelect 上，屏幕仍是 combat", () => {
    const state = openExhaustOneScreen();
    expect(state.screen).toBe("combat");
    expect(state.combat!.cardSelect).toEqual({ task: "exhaust_one", pickCount: 1 });
    // 候选 = 剩下那 4 张手牌。
    expect(pendingCardSelect(state)).toEqual({
      mode: "single",
      task: "exhaust_one",
      idxs: [0, 1, 2, 3],
    });
  });

  it("开屏时队列里的残留动作全部进档（否则读回来会少一次结算）", () => {
    const state = openExhaustOneScreen();
    // 焚誓是 addToBot(开屏) → addToBot(抽牌)，再由 useCard 追加「这张牌去哪个牌堆」。
    // 开屏那一刻后两条还在队里，都必须能存下来。
    expect(state.combat!.pendingActions).toEqual([
      { kind: "draw_cards", count: 2 },
      {
        kind: "after_use_card",
        // 卡牌实例级状态（第七批）也要跟着这条动作一起进档：焚誓 1 费、无 specialData。
        card: {
          uid: expect.any(Number) as number,
          defId: "burning_pact",
          upgraded: false,
          cost: 1,
          costForTurn: 1,
          specialData: 0,
        },
        exhaustOnUse: false,
        // 第九批新增：二连击复制出来的那份结算完直接丢掉，不进任何牌堆。
        purgeOnUse: false,
        // 第三十五批新增：缓慢（巨头）那道 `if (item.triggerOnUse)` 的门。
        // 正常出牌恒为真；老档没有这一位时按 true 回填。
        triggerOnUse: true,
      },
    ]);
    // 出牌队列此刻是空的——只有嵌套出牌（二连击 / 混乱）才会让它非空。
    expect(state.combat!.pendingCardQueue).toEqual([]);
  });

  it("选牌屏上存档读盘，再选完，结果与不落盘完全相同", () => {
    const live = openExhaustOneScreen();
    const saved = JSON.parse(JSON.stringify(live)) as GameState;
    expect(saved).toEqual(live);

    const action: GameAction = { type: "select_card", index: 0 };
    expect(applyAction(live, action)).toEqual({ ok: true });
    expect(applyAction(saved, action)).toEqual({ ok: true });
    expect(saved).toEqual(live);

    const combat = live.combat!;
    expect(combat.inputState).toBe("player_normal");
    expect(combat.cardSelect).toBeNull();
    expect(combat.pendingActions).toEqual([]);
    // 选中的那张进消耗堆；打出的那张进弃牌堆（焚誓自己不消耗）；
    // 手牌 4 → 消耗 1 → 3 → 排队的「抽 2 张」兑现 → 5。这就是残留动作没丢的证据。
    expect(combat.exhaustPile.map((c) => c.defId)).toEqual(["burning_pact"]);
    expect(combat.discardPile.map((c) => c.defId)).toEqual(["burning_pact"]);
    expect(combat.hand).toHaveLength(5);
  });

  it("屏没关之前，打牌 / 结束回合 / 喝药水都被拒，且状态分毫不动", () => {
    const state = openExhaustOneScreen();
    state.potions = ["block_potion", null, null];
    state.combat!.potions = ["block_potion", null, null];
    const before = JSON.parse(JSON.stringify(state.combat)) as unknown;

    for (const action of [
      { type: "play_card", handIndex: 0 },
      { type: "end_turn" },
      { type: "use_potion", slotIndex: 0 },
    ] satisfies GameAction[]) {
      const result = applyAction(state, action);
      expect(result.ok, `${action.type} 本该被拒`).toBe(false);
      expect(result.ok ? "" : result.reason).toContain("正在选牌");
    }
    expect(state.combat).toEqual(before);
  });

  it("非法选择被拒：越界、不是候选、用错了单选/多选入口", () => {
    const state = openExhaustOneScreen();
    expect(applyAction(state, { type: "select_card", index: 9 }).ok).toBe(false);
    expect(applyAction(state, { type: "select_card", index: -1 }).ok).toBe(false);
    // exhaust_one 是单选，走多选入口要被拒。
    expect(applyAction(state, { type: "select_cards", indices: [0] }).ok).toBe(false);
    expect(state.combat!.inputState).toBe("card_select");
  });

  it("没开屏时选牌被拒", () => {
    const state = runAtMap();
    startCombat(state, "cultist");
    expect(pendingCardSelect(state)).toBeNull();
    expect(applyAction(state, { type: "select_card", index: 0 }).ok).toBe(false);
  });

  it("净化的多选屏：候选形状是「从手牌挑至多 N 张」", () => {
    const state = runWithDeck(new Array<string>(10).fill("purity"));
    startCombat(state, "cultist");
    expect(applyAction(state, { type: "play_card", handIndex: 0 })).toEqual({ ok: true });
    expect(pendingCardSelect(state)).toEqual({
      mode: "multi",
      task: "exhaust_many",
      maxPick: 3,
      handSize: 4,
    });
    // 超过上限、重复下标、越界都要挡住。
    expect(applyAction(state, { type: "select_cards", indices: [0, 1, 2, 3] }).ok).toBe(false);
    expect(applyAction(state, { type: "select_cards", indices: [0, 0] }).ok).toBe(false);
    expect(applyAction(state, { type: "select_cards", indices: [4] }).ok).toBe(false);
    expect(applyAction(state, { type: "select_cards", indices: [0, 2] })).toEqual({ ok: true });
    // 按下标降序消耗，故消耗的是原来的第 0、2 张，手牌剩下原来的第 1、3 张。
    expect(state.combat!.hand).toHaveLength(2);
    expect(state.combat!.exhaustPile).toHaveLength(3); // 选中的 2 张 + 净化自己
  });

  it("发现的选牌屏：候选是当场生成的 3 张，且跟着存档往返", () => {
    // 发现是**第一个**「候选不在任何牌堆里」的选牌屏——那 3 张是打牌时从战斗内卡池
    // 随机抽出来的，只存在于 `cardSelect.cards` 里。漏存它，读回来的档就再也不知道
    // 玩家在选什么（而 RNG 已经消耗过了，重抽会得到另外三张）。
    const state = runWithDeck(new Array<string>(10).fill("discovery"));
    startCombat(state, "cultist");
    expect(applyAction(state, { type: "play_card", handIndex: 0 })).toEqual({ ok: true });

    const info = state.combat!.cardSelect!;
    expect(info.task).toBe("discovery");
    expect(info.data0).toBe(1);
    expect(info.cards).toHaveLength(3);
    expect(new Set(info.cards).size).toBe(3); // 拒绝采样保证互不相同
    // 候选取自铁甲的 70 张战斗内卡池，不是无色池。
    for (const id of info.cards!) {
      expect(getCardDef(id).color).toBe("red");
    }
    // 下标恒为 0..2（与任何牌堆无关）。
    expect(pendingCardSelect(state)).toEqual({
      mode: "single",
      task: "discovery",
      idxs: [0, 1, 2],
    });

    const roundTripped = JSON.parse(JSON.stringify(state)) as GameState;
    expect(roundTripped).toEqual(state);
    expect(exportState(importState(state.combat!))).toEqual(state.combat);

    // 选中的那张进手牌，**本回合** 0 费：costForTurn 归零而 cost 保持数据表的值。
    const picked = info.cards![1];
    expect(applyAction(state, { type: "select_card", index: 1 })).toEqual({ ok: true });
    const conjured = state.combat!.hand.find((c) => c.defId === picked)!;
    expect(conjured.costForTurn).toBe(0);
    expect(conjured.cost).toBe(costOf(getCardDef(picked), false));
  });

  /**
   * 停在「头槌的选牌屏开着、而二连击的复制项还排在出牌队列里」那一刻。
   *
   * 第九批之前「可取档时点出牌队列必空」是成立的，exportState 甚至为此显式抛错。
   * 二连击 + 头槌打破了它：头槌是**攻击牌**，所以 onUseAttackCard 会把一份复制项塞进
   * 出牌队列；而头槌自己又开选牌屏，于是屏开着时那份复制项还排在队里。
   * trace 那边看不到这条（harness 不做存档往返），所以只能由这两条接线测试守着。
   */
  function openHeadbuttScreenWithPurgedCopy(): GameState {
    // 种子 1 的起手是 headbutt,double_tap,defend,double_tap,defend。
    const state = runWithDeck(
      [
        "double_tap",
        "double_tap",
        "double_tap",
        "headbutt",
        "headbutt",
        "headbutt",
        "defend",
        "defend",
        "defend",
        "defend",
      ],
      1,
    );
    startCombat(state, "cultist");
    // 两张二连击各 1 费：叠到 2 层，同时把 2 张牌送进弃牌堆——头槌候选必须 ≥2 张才开屏
    // （恰好 1 张时 HeadbuttAction 走「直接替玩家选掉」的捷径）。
    for (let i = 0; i < 2; i += 1) {
      const dt = state.combat!.hand.findIndex((c) => c.defId === "double_tap");
      expect(dt).toBeGreaterThanOrEqual(0);
      expect(applyAction(state, { type: "play_card", handIndex: dt })).toEqual({ ok: true });
    }
    expect(state.combat!.player.powers.find((p) => p.id === "double_tap")?.amount).toBe(2);
    const hb = state.combat!.hand.findIndex((c) => c.defId === "headbutt");
    expect(hb).toBeGreaterThanOrEqual(0);
    expect(applyAction(state, { type: "play_card", handIndex: hb })).toEqual({ ok: true });
    expect(state.combat!.inputState).toBe("card_select");
    expect(state.combat!.cardSelect!.task).toBe("headbutt");
    return state;
  }

  it("二连击的复制项确实排在出牌队列里（存档里看得见）", () => {
    const state = openHeadbuttScreenWithPurgedCopy();
    const queued = state.combat!.pendingCardQueue;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.purgeOnUse).toBe(true);
    expect(queued[0]!.autoplay).toBe(true);
    expect(queued[0]!.card!.defId).toBe("headbutt");
    // 层数已经被**同步**递减掉一层（2 → 1）。
    expect(state.combat!.player.powers.find((p) => p.id === "double_tap")?.amount).toBe(1);
  });

  it("出牌队列里的复制项跟着存档往返，选完之后两条路结果一致", () => {
    const state = openHeadbuttScreenWithPurgedCopy();
    const roundTripped = JSON.parse(JSON.stringify(state)) as GameState;
    expect(roundTripped).toEqual(state);
    expect(exportState(importState(state.combat!))).toEqual(state.combat);

    // 选完之后复制项要真的结算掉——第二块头槌屏就是它开的。
    const action: GameAction = { type: "select_card", index: 0 };
    expect(applyAction(state, action)).toEqual({ ok: true });
    expect(applyAction(roundTripped, action)).toEqual({ ok: true });
    expect(roundTripped).toEqual(state);
    expect(state.combat!.pendingCardQueue).toEqual([]);
  });

  // 自动对战策略必须能应付选牌屏，否则 `pnpm sim` 会在屏上原地死循环：
  // sts-combat 在屏没关之前拒绝一切打牌 / 结束回合，策略若只在那两个里挑就永远推不动。
  for (const [name, policy] of [
    ["贪心", new GreedyPolicy()],
    ["随机", new RandomPolicy(seedRng(7))],
  ] as const) {
    it(`${name}策略遇到选牌屏能推进到战斗结束（不死循环）`, () => {
      // 一副全是「会开选牌屏」的牌，把这条路径踩满。
      const state = runWithDeck([
        "burning_pact",
        "purity",
        "warcry",
        "thinking_ahead",
        "headbutt",
        "true_grit",
        "armaments",
        "exhume",
        "secret_weapon",
        "secret_technique",
      ]);
      startCombat(state, "cultist");
      let steps = 0;
      while (state.screen === "combat" && steps < 500) {
        const result = applyAction(state, policy.decide(state));
        expect(result.ok, `第 ${steps} 步被拒: ${result.ok ? "" : result.reason}`).toBe(true);
        steps += 1;
      }
      expect(state.screen).not.toBe("combat");
      expect(state.combat).toBeNull();
    });
  }

  it("残留动作没有 ActionDesc 时 exportState 抛错（绝不静默丢弃）", () => {
    // 这是整套 pendingActions 机制的安全网：将来某张牌在选牌屏后面排了一条没描述的动作，
    // 必须当场炸掉，而不是存出一个「少一次结算」的档。
    const bc = importState(openExhaustOneScreen().combat!);
    addToBot(bc, () => {
      /* 没有 desc 的动作 */
    });
    expect(() => exportState(bc)).toThrow(/ActionDesc/);
  });
});

describe("接线：尚未迁移的内容显式抛错", () => {
  // 近似实现已删除，没有回退路径。静默降级会让「同种子复现原版」失去意义，
  // 错配 RNG 也比直接失败危险，所以这里要的就是抛错。
  const reason = (state: GameState, encounterId: string): string => {
    const coverage = stsCombatCoverage(state, encounterId);
    expect(coverage.supported).toBe(false);
    return coverage.supported ? "" : coverage.reason;
  };

  // ⚠⚠ **第四十八批：这条用例失去了它历来的样本，改成断言不变量本身。**
  //
  //   历来的做法是「挑一个真实存在、但最晚才会被登记的编队」当样本：
  //   `gremlin_nob`（十八批顶掉）→ `giant_head`（三十五）→ `donu_deca`（三十九）→
  //   `the_heart`（四十七）→ `mysterious_sphere`（**本批顶掉**）。本批把最后六个编队
  //   一次装完，参考的 `MonsterEncounter` 63 项**全部**进了 `SUPPORTED_ENCOUNTERS`,
  //   于是「真实存在却未迁移的编队」一个都不剩——与第四十七批怪物那条用例遇到的是
  //   同一件事，办法照抄那边：**断言让那道 throw 不可达的不变量本身**。
  //
  //   ⚠ 下面那张 `REFERENCE_ENCOUNTERS` 是从参考的 `MonsterEncounters.h`
  //   （`monsterEncounterEnumNames[]`，去掉 `INVALID` 哨兵）逐条抄下来的**独立来源**，
  //   不是从 `SUPPORTED_ENCOUNTERS` 派生的——派生出来的名单只能证明「它等于它自己」。
  //   它守的是两个方向：谁删掉一条登记会红，参考将来加了第 64 个编队也会红。
  const REFERENCE_ENCOUNTERS = [
    "cultist",
    "jaw_worm",
    "two_louse",
    "small_slimes",
    "blue_slaver",
    "gremlin_gang",
    "looter",
    "large_slime",
    "lots_of_slimes",
    "exordium_thugs",
    "exordium_wildlife",
    "red_slaver",
    "three_louse",
    "two_fungi_beasts",
    "gremlin_nob",
    "lagavulin",
    "three_sentries",
    "slime_boss",
    "the_guardian",
    "hexaghost",
    "spheric_guardian",
    "chosen",
    "shell_parasite",
    "three_byrds",
    "two_thieves",
    "chosen_and_byrds",
    "sentry_and_sphere",
    "snake_plant",
    "snecko",
    "centurion_and_healer",
    "cultist_and_chosen",
    "three_cultist",
    "shelled_parasite_and_fungi",
    "gremlin_leader",
    "slavers",
    "book_of_stabbing",
    "automaton",
    "collector",
    "champ",
    "three_darklings",
    "orb_walker",
    "three_shapes",
    "spire_growth",
    "transient",
    "four_shapes",
    "maw",
    "sphere_and_two_shapes",
    "jaw_worm_horde",
    "writhing_mass",
    "giant_head",
    "nemesis",
    "reptomancer",
    "awakened_one",
    "time_eater",
    "donu_and_deca",
    "shield_and_spear",
    "the_heart",
    "lagavulin_event",
    "colosseum_event_slavers",
    "colosseum_event_nobs",
    "masked_bandits_event",
    "mushrooms_event",
    "mysterious_sphere_event",
  ];

  it("编队收官：参考的 63 个编队与 SUPPORTED_ENCOUNTERS 双向相等", () => {
    expect(REFERENCE_ENCOUNTERS.length).toBe(63);
    expect([...REFERENCE_ENCOUNTERS].sort()).toEqual([...SUPPORTED_ENCOUNTERS].sort());
  });

  // ⚠ **那道 throw 本身留着**，而且它现在守的不是「还没铺到的编队」，是**旧近似表的残留**：
  //   `enemies.ts` 的 `ENCOUNTERS` 里还有 13 条参考**没有对应枚举**的条目
  //   （`two_orb_walkers` / `exploder` / `spiker` / `repulsor` / `two_exploders` /
  //   `small_slimes_a|b` / `large_slime_acid|spike` / `centurion` / `two_centurions` …），
  //   它们是旧近似战斗编的，而且**当前的 run 层真的会掏到它们**（第一 / 三幕的权重表里有）。
  //   所以样本选 `two_orb_walkers`：它是真实可达的 id、却永远不会有预言机
  //   （参考的 `MonsterEncounter` 里压根没有这一项），接 `sts-encounters`（TODOS 一.4）
  //   那一批应当把这一族整体删掉——**那时**这条用例才会再次需要换写法。
  it("未迁移的编队：startCombat 抛错，且不留半个战斗状态", () => {
    const state = runAtMap();
    expect(SUPPORTED_ENCOUNTERS).not.toContain("two_orb_walkers");
    expect(() => startCombat(state, "two_orb_walkers")).toThrow(/two_orb_walkers/);
    expect(state.combat).toBeNull();
    expect(reason(state, "two_orb_walkers")).toContain("尚未迁移");
  });

  // 样本牌选 `seek` 搜寻：参考项目三个 switch 里都**没有 case**，等于压根没实现，
  // 所以它永远不会有预言机、永远不会进 CARD_RULES——拿它当「未迁移」样本不会再被下一批
  // 铺量顶掉。（原先用的是 `whirlwind`，第十批把它登记了，故换掉。别换成
  // `the_bomb` / `hand_of_greed` 那类「下一批就要登记」的牌。）
  it("牌组里有未迁移的牌 → 抛错", () => {
    const state = runAtMap();
    state.deck.push({ uid: 999, defId: "seek", upgraded: false });
    expect(reason(state, "cultist")).toContain("尚未迁移");
    expect(() => startCombat(state, "cultist")).toThrow();
  });

  // 样本药水选 `essence_of_darkness` 暗影精华，理由与上面那张 `seek` 同族、而且**是永久的**：
  // 参考的 `Actions::EssenceOfDarkness` 是 `return sts::Action();`——一个 `actFunc` 为空的
  // `std::function`，`executeActions` 那句 `a(*this)` 会抛 `std::bad_function_call`，
  // harness 当场终止 ⇒ 它永远不可能有预言机。（第四十五批把原样本 `snecko_oil` 登记了。）
  it("未迁移的药水 → 抛错", () => {
    const state = runAtMap();
    state.potions = ["essence_of_darkness", null, null];
    expect(reason(state, "cultist")).toContain("essence_of_darkness");
  });

  it("非铁甲角色：起始牌组就有未迁移的牌，因此照样挡住", () => {
    const state = newRun({ runId: "w", seed: 1, character: "silent" });
    expect(reason(state, "cultist")).toContain("尚未迁移");
  });

  // ⚠⚠ 这三条守的是 `RelicInstance.data`（第四十四批）——**它没有 trace 预言机**：
  //   一条 trace 就是一场战斗，而 `data` 的语义是「跨战斗延续」，写回去的值下一场才被读到。
  //   对拍能守的只有 `initRelics` 那一半（`@relic12` 发了非 0 的 data）；「写回」与
  //   「run 层 ⟺ 战斗内的搬运」只能靠这里守。
  it("遗物的 data：run 层的 counter 搬进战斗（快乐花 `= data + 1` 那个非直觉的 +1）", () => {
    const state = runAtMap();
    // counter = 2 ⇒ 战斗内 happyFlowerCounter = 3 ⇒ 当场命中「== 3」并给 1 点能量后归零。
    state.relics.push({ id: "happy_flower", counter: 2 });
    startCombat(state, "cultist");
    expect(state.combat!.player.happyFlowerCounter).toBe(0);
    // 第 1 回合能量 = energyPerTurn(3) + 快乐花那 1 点。
    expect(state.combat!.player.energy).toBe(4);
  });

  it("遗物的 data：战斗结束时写回 run 层（对齐 `updateRelicsOnExit`）", () => {
    // 全是打击，邪教徒 48 血——几回合就能打完，中途每打一张牌墨水瓶都 +1。
    const state = runWithDeck(new Array<string>(10).fill("strike"));
    state.relics.push({ id: "ink_bottle", counter: 7 });
    startCombat(state, "cultist");
    expect(state.combat!.player.inkBottleCounter).toBe(7);
    let guard = 0;
    while (state.combat !== null && guard < 500) {
      applyAction(state, nextAction(state));
      guard += 1;
    }
    expect(state.combat).toBeNull();
    // 打了 n 张牌 ⇒ 计数器从 7 走了 n 步（每到 10 归零），并写回 run 层。
    const relic = state.relics.find((r) => r.id === "ink_bottle")!;
    expect(relic.counter).not.toBe(7);
    expect(relic.counter).toBeGreaterThanOrEqual(0);
    expect(relic.counter).toBeLessThan(10);
  });

  it("遗物的 data：御守 / 蜥蜴尾读的是「真假」，counter 为 0 等于战斗内没有这颗遗物", () => {
    const withCharge = runAtMap();
    withCharge.relics.push({ id: "lizard_tail", counter: 1 });
    startCombat(withCharge, "cultist");
    expect(withCharge.combat!.player.relicBits).toContain("lizard_tail");

    const depleted = runAtMap();
    depleted.relics.push({ id: "lizard_tail", counter: 0 });
    startCombat(depleted, "cultist");
    // ⚠ 容器里**有**这颗遗物，但玩家那份位集合里没有——`setHasRelic<X>(r.data)` 覆盖掉了。
    expect(depleted.combat!.relics.map((r) => r.id)).toContain("lizard_tail");
    expect(depleted.combat!.player.relicBits).not.toContain("lizard_tail");
  });

  it("遗物不参与前置检查——已登记的照常生效（金刚杵 +1 力量）", () => {
    const state = runAtMap();
    state.relics.push({ id: "vajra", counter: 0 });
    expect(stsCombatCoverage(state, "cultist")).toEqual({ supported: true });
    startCombat(state, "cultist");
    expect(state.combat!.player.powers).toEqual([{ id: "strength", amount: 1 }]);
  });

  it("遗物不参与前置检查——未登记的不挡路，只是暂时没有战斗内效果", () => {
    // ⚠⚠ **样本挑的是「永远不会被登记」的那一族，而不是「下一批就要装」的那种。**
    //   原先用的是赤备（第四十四批把它装了），换样本这件事与「未迁移编队」那两条用例
    //   同族——区别是这里**有**永久解：圣水 / 忍者卷轴 / 纯净水造的是 `MIRACLE` / `SHIV`，
    //   而这两张牌在参考项目的三个 switch 里**都没有 case**（与 `seek` 完全同理），
    //   所以它们永远不会有预言机、永远不会进 `sts-combat.ts` 的任何一张时点表。
    //   别换成工具箱 / 什锦那种——它们不能登记的理由是「多选屏 / 被注释掉」，
    //   哪天补上多选屏就不成立了。
    const state = runAtMap();
    state.relics.push({ id: "holy_water", counter: 0 });
    expect(stsCombatCoverage(state, "cultist")).toEqual({ supported: true });
    startCombat(state, "cultist");
    expect(state.combat!.player.powers).toEqual([]);
  });
});

describe("接线：覆盖面登记与 trace 数据双向对齐", () => {
  it("SUPPORTED_ENCOUNTERS 与 test/golden/traces 一一对应", () => {
    const traceDir = fileURLToPath(new URL("./golden/traces", import.meta.url));
    const withTrace = [
      ...new Set(
        readdirSync(traceDir)
          .filter((f) => f.endsWith(".jsonl"))
          // `<编队>@ascN` / `<编队>@tgtN` / `<编队>@relicN` / `<编队>@potN` 是同一个编队在
          // 另一个**爬升度**（第二十一批）、另一个**目标策略**（第三十一批）、另一套
          // **遗物**（第四十批）或另一套**药水 / 喝药时机**（第四十五批）上的数据，
          // 不是新编队——把后缀全部剥掉再去重，否则这条对齐会把
          // `cultist@asc19` / `large_slime@relic1` / `champ@pot1` 当成没登记的编队。
          // ⚠ 顺序与 `tools/split-traces.mjs` 的拼接顺序一致（asc → tgt → relic → pot），
          //   所以从右往左剥：先 `@potN`、再 `@relicN`、再 `@tgtN`、最后 `@ascN`。
          .map((f) =>
            f
              .replace(/\.jsonl$/, "")
              .replace(/@pot\d+$/, "")
              .replace(/@relic\d+$/, "")
              .replace(/@tgt\d+$/, "")
              .replace(/@asc\d+$/, ""),
          ),
      ),
    ].sort();
    // 多列（登记了却没 trace 背书）与漏列（有 trace 却不启用）都会在这里失败。
    expect([...SUPPORTED_ENCOUNTERS].sort()).toEqual(withTrace);
  });

  it("ASC_SUPPORTED_ENCOUNTERS 与 test/golden/traces 的 @ascN 文件一一对应", () => {
    const traceDir = fileURLToPath(new URL("./golden/traces", import.meta.url));
    // 一个编队只要在**任一**爬升度上有 trace，就算它的 asc 分档有背书。
    const withAscTrace = [
      ...new Set(
        readdirSync(traceDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => /^(.+)@asc\d+\.jsonl$/.exec(f))
          .flatMap((m) => (m === null ? [] : [m[1]!])),
      ),
    ].sort();
    // 多列 = 声称校准过却没有任何 asc trace 走到它（`stsCombatCoverage` 会放行一场
    // 没有预言机的战斗）；漏列 = 有 asc trace 却不启用。两个方向都必须失败。
    expect([...ASC_SUPPORTED_ENCOUNTERS].sort()).toEqual(withAscTrace);
  });

  it("ASC_SUPPORTED_ENCOUNTERS 必须是 SUPPORTED_ENCOUNTERS 的子集", () => {
    // 「asc>0 有背书、asc0 没有」是不可能的：asc19 那批 variant 用的是同一批编队。
    const base = new Set(SUPPORTED_ENCOUNTERS);
    expect(ASC_SUPPORTED_ENCOUNTERS.filter((e) => !base.has(e))).toEqual([]);
  });
});
