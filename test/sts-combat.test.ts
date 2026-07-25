import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initCombat, endTurn, probe } from "../src/engine/sts-combat.js";
import { IRONCLAD_STARTER_DECK } from "../src/engine/cards/cards.js";

// golden 把牌型编码为 strike=0 / defend=1 / bash=2（同型牌洗牌等价，只比牌型序）。
const CARD_CODE: Record<string, number> = { strike: 0, defend: 1, bash: 2 };
const encode = (ids: string[]): number[] => ids.map((id) => CARD_CODE[id]!);

type GoldenCounters = {
  aiRng: number;
  monsterHpRng: number;
  shuffleRng: number;
  cardRandomRng: number;
};
type GoldenCase = {
  seed: string;
  seedLong: string;
  floor: number;
  afterInit: {
    hp: number;
    intent: string;
    hand: number[];
    draw: number[];
    counters: GoldenCounters;
    turn: number;
  };
  afterTurn1: {
    intent: string;
    hand: number[];
    counters: GoldenCounters;
    turn: number;
  };
};

const goldenPath = fileURLToPath(new URL("./golden/combat.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { cases: GoldenCase[] };

describe("sts-combat 骨架层：单 Cultist 战斗对拍 C++ 黄金向量（逐位对齐）", () => {
  for (const g of golden.cases) {
    it(`seed "${g.seed}" @floor ${g.floor}：init 后 HP/意图/牌序/counter`, () => {
      const bc = initCombat({
        seedLong: BigInt(g.seedLong),
        floorNum: g.floor,
        ascension: 0,
        encounterId: "cultist",
        deckCardIds: [...IRONCLAD_STARTER_DECK],
        playerHp: 80,
        playerMaxHp: 80,
      });
      const p = probe(bc);

      expect(p.monsterHps).toEqual([g.afterInit.hp]);
      expect(p.monsterIntents).toEqual([g.afterInit.intent]);
      expect(encode(p.handCardIds)).toEqual(g.afterInit.hand);
      expect(encode(p.drawPileCardIds)).toEqual(g.afterInit.draw);
      expect(p.counters).toEqual(g.afterInit.counters);
      expect(p.turn).toBe(g.afterInit.turn);
      expect(p.outcome).toBe("undecided");
    });

    it(`seed "${g.seed}" @floor ${g.floor}：endTurn 后怪物 rollMove/新回合抽牌 counter`, () => {
      const bc = initCombat({
        seedLong: BigInt(g.seedLong),
        floorNum: g.floor,
        ascension: 0,
        encounterId: "cultist",
        deckCardIds: [...IRONCLAD_STARTER_DECK],
        playerHp: 80,
        playerMaxHp: 80,
      });
      endTurn(bc);
      const p = probe(bc);

      // Cultist 咏唱后第二次 rollMove → 暗袭；aiRng counter 从 1 推进到 2。
      expect(p.monsterIntents).toEqual([g.afterTurn1.intent]);
      expect(encode(p.handCardIds)).toEqual(g.afterTurn1.hand);
      expect(p.counters).toEqual(g.afterTurn1.counters);
      expect(p.turn).toBe(g.afterTurn1.turn);
      // 咏唱给邪教徒自身叠 3 层仪式。
      const ritual = bc.monsters[0]!.powers.find((pw) => pw.id === "ritual");
      expect(ritual?.amount).toBe(3);
    });
  }
});
