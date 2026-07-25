import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  initCombat,
  endTurn,
  playCard,
  probe,
  type BattleContext,
} from "../src/engine/sts-combat.js";
import { IRONCLAD_STARTER_DECK, getCardDef } from "../src/engine/cards/cards.js";

type Counters = { aiRng: number; monsterHpRng: number; shuffleRng: number; cardRandomRng: number };
type GoldenTurn = {
  turn: number;
  played: number[];
  monsterHps: number[];
  monsterBlocks: number[];
  monsterStrengths: number[];
  playerHp: number;
  playerBlock: number;
  aiRng: number;
  outcome: number;
};
type GoldenCase = {
  seed: string;
  seedLong: string;
  floor: number;
  initHps: number[];
  initIntents: string[];
  aiRngAfterInit: number;
  turns: GoldenTurn[];
  final: { turn: number; playerHp: number; outcome: number; intents: string[]; counters: Counters };
};

const goldenPath = fileURLToPath(new URL("./golden/combat_horde.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { cases: GoldenCase[] };

const CARD_CODE: Record<string, number> = { strike: 0, defend: 1, bash: 2 };
const encode = (ids: string[]): number[] => ids.map((id) => CARD_CODE[id]!);

// golden 用 0/1/2 表示未决/胜/负。
const OUTCOME_CODE = { undecided: 0, player_victory: 1, player_loss: 2 } as const;

const powersOf = (bc: BattleContext, id: string): number[] =>
  bc.monsters.map((m) => m.powers.find((p) => p.id === id)?.amount ?? 0);

/** 贪心：反复打出第一张打得起的牌，攻击指向下标最小的存活怪。与 C++ dumper 一致。 */
function playGreedy(bc: BattleContext): string[] {
  const played: string[] = [];
  if (probe(bc).outcome !== "undecided") {
    return played;
  }
  for (;;) {
    let pick = -1;
    for (let i = 0; i < bc.hand.length; i += 1) {
      const cost = getCardDef(bc.hand[i]!.defId).cost ?? 0;
      if (cost <= bc.player.energy) {
        pick = i;
        break;
      }
    }
    if (pick < 0) {
      break;
    }
    const target = bc.monsters.findIndex((m) => m.alive);
    played.push(bc.hand[pick]!.defId);
    const r = playCard(bc, pick, target < 0 ? 0 : target);
    if (!r.ok) {
      throw new Error(`playCard 失败: ${r.reason}`);
    }
    if (probe(bc).outcome !== "undecided") {
      break;
    }
  }
  return played;
}

describe("sts-combat 多怪编队 + 逐怪 rollMove 对拍 C++ 黄金向量（颚虫军团）", () => {
  for (const g of golden.cases) {
    it(`seed "${g.seed}" @floor ${g.floor}：三怪 HP / 初始意图 / 四回合逐位一致`, () => {
      const bc = initCombat({
        seedLong: BigInt(g.seedLong),
        floorNum: g.floor,
        ascension: 0,
        encounterId: "jaw_worm_horde",
        deckCardIds: [...IRONCLAD_STARTER_DECK],
        playerHp: 80,
        playerMaxHp: 80,
      });

      // 三只逐一 roll HP（monsterHpRng），再逐一 roll 初始意图（aiRng）。
      expect(probe(bc).monsterHps).toEqual(g.initHps);
      expect(probe(bc).monsterIntents).toEqual(g.initIntents);
      expect(bc.rng.aiRng.counter).toBe(g.aiRngAfterInit);

      for (const gt of g.turns) {
        const played = playGreedy(bc);
        const p = probe(bc);

        expect(p.turn).toBe(gt.turn);
        expect(encode(played)).toEqual(gt.played);
        expect(bc.monsters.map((m) => (m.alive ? m.hp : 0))).toEqual(gt.monsterHps);
        expect(bc.monsters.map((m) => m.block)).toEqual(gt.monsterBlocks);
        expect(powersOf(bc, "strength")).toEqual(gt.monsterStrengths);
        expect(p.playerHp).toBe(gt.playerHp);
        expect(p.playerBlock).toBe(gt.playerBlock);
        // aiRng 每回合的增量不是常数：颚虫的 getMoveForRoll 有三条分支会追加
        // 一次 randomBoolean，命中与否取决于意图历史。
        expect(bc.rng.aiRng.counter).toBe(gt.aiRng);
        expect(OUTCOME_CODE[p.outcome]).toBe(gt.outcome);

        endTurn(bc);
      }

      const p = probe(bc);
      expect(p.turn).toBe(g.final.turn);
      expect(p.playerHp).toBe(g.final.playerHp);
      expect(OUTCOME_CODE[p.outcome]).toBe(g.final.outcome);
      expect(p.monsterIntents).toEqual(g.final.intents);
      expect(p.counters).toEqual(g.final.counters);
    });
  }

  it("军团开局：三只各 +3 力量 +5 格挡，且首次 rollMove 不走 firstTurn 分支", () => {
    const g = golden.cases[0]!;
    const bc = initCombat({
      seedLong: BigInt(g.seedLong),
      floorNum: g.floor,
      ascension: 0,
      encounterId: "jaw_worm_horde",
      deckCardIds: [...IRONCLAD_STARTER_DECK],
      playerHp: 80,
      playerMaxHp: 80,
    });
    expect(powersOf(bc, "strength")).toEqual([3, 3, 3]);
    expect(bc.monsters.map((m) => m.block)).toEqual([5, 5, 5]);
    // 预置哨兵使 firstTurn() 为假：若未预置，三只初始意图会被强制成 chomp。
    expect(bc.monsters.every((m) => m.currentMove !== "")).toBe(true);
    expect(g.initIntents.some((i) => i !== "chomp")).toBe(true);
  });

  it("怪物格挡在怪物阶段开始时才清零（玩家回合内仍能挡伤害）", () => {
    const g = golden.cases[0]!;
    const bc = initCombat({
      seedLong: BigInt(g.seedLong),
      floorNum: g.floor,
      ascension: 0,
      encounterId: "jaw_worm_horde",
      deckCardIds: [...IRONCLAD_STARTER_DECK],
      playerHp: 80,
      playerMaxHp: 80,
    });
    const hpBefore = bc.monsters[0]!.hp;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    if (idx >= 0) {
      playCard(bc, idx, 0);
      // 打击 6 打在 5 点格挡上，只透 1 点。
      expect(bc.monsters[0]!.hp).toBe(hpBefore - 1);
      expect(bc.monsters[0]!.block).toBe(0);
    }
  });
});
