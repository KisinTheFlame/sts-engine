import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  initCombat,
  endTurn,
  playCard,
  probe,
  calculateCardDamage,
  type BattleContext,
} from "../src/engine/sts-combat.js";
import { IRONCLAD_STARTER_DECK, getCardDef } from "../src/engine/cards/cards.js";

// golden 把牌型编码为 strike=0 / defend=1 / bash=2。
const CARD_CODE: Record<string, number> = { strike: 0, defend: 1, bash: 2 };
const encode = (ids: string[]): number[] => ids.map((id) => CARD_CODE[id]!);

type GoldenTurn = {
  turn: number;
  played: number[];
  monsterHp: number;
  monsterVuln: number;
  monsterStrength: number;
  playerHp: number;
  playerBlock: number;
  energy: number;
  handAfterPlay: number[];
  discard: number[];
};
type GoldenCase = {
  seed: string;
  seedLong: string;
  floor: number;
  turns: GoldenTurn[];
  final: {
    turn: number;
    intent: string;
    monsterHp: number;
    monsterStrength: number;
    playerHp: number;
    hand: number[];
    drawPile: number[];
    counters: { aiRng: number; monsterHpRng: number; shuffleRng: number; cardRandomRng: number };
  };
};

const goldenPath = fileURLToPath(new URL("./golden/combat_play.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { cases: GoldenCase[] };

const powerOf = (bc: BattleContext, id: string): number =>
  bc.monsters[0]!.powers.find((p) => p.id === id)?.amount ?? 0;

/** 贪心策略：反复取手牌中第一张打得起的牌打出，攻击恒指向 0 号敌人。与 C++ dumper 一致。 */
function playGreedy(bc: BattleContext): string[] {
  const played: string[] = [];
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
    played.push(bc.hand[pick]!.defId);
    const r = playCard(bc, pick, 0);
    if (!r.ok) {
      throw new Error(`playCard 失败: ${r.reason}`);
    }
  }
  return played;
}

const newBattle = (g: GoldenCase): BattleContext =>
  initCombat({
    seedLong: BigInt(g.seedLong),
    floorNum: g.floor,
    ascension: 0,
    encounterId: "cultist",
    deckCardIds: [...IRONCLAD_STARTER_DECK],
    playerHp: 80,
    playerMaxHp: 80,
  });

describe("sts-combat 打牌路径对拍 C++ 黄金向量（三回合贪心，逐位对齐）", () => {
  for (const g of golden.cases) {
    it(`seed "${g.seed}" @floor ${g.floor}：逐回合出牌 / 伤害 / 格挡 / 易伤`, () => {
      const bc = newBattle(g);
      for (const gt of g.turns) {
        const played = playGreedy(bc);
        const p = probe(bc);

        expect(p.turn).toBe(gt.turn);
        expect(encode(played)).toEqual(gt.played);
        expect(p.monsterHps[0]).toBe(gt.monsterHp);
        expect(powerOf(bc, "vulnerable")).toBe(gt.monsterVuln);
        expect(powerOf(bc, "strength")).toBe(gt.monsterStrength);
        expect(p.playerHp).toBe(gt.playerHp);
        expect(p.playerBlock).toBe(gt.playerBlock);
        expect(p.energy).toBe(gt.energy);
        expect(encode(p.handCardIds)).toEqual(gt.handAfterPlay);
        expect(encode(p.discardPileCardIds)).toEqual(gt.discard);

        endTurn(bc);
      }

      // 三回合后：仪式已两次结算、抽牌堆经历过一次 reshuffle。
      const p = probe(bc);
      expect(p.turn).toBe(g.final.turn);
      expect(p.monsterIntents[0]).toBe(g.final.intent);
      expect(p.monsterHps[0]).toBe(g.final.monsterHp);
      expect(powerOf(bc, "strength")).toBe(g.final.monsterStrength);
      expect(p.playerHp).toBe(g.final.playerHp);
      expect(encode(p.handCardIds)).toEqual(g.final.hand);
      expect(encode(p.drawPileCardIds)).toEqual(g.final.drawPile);
      // shuffleRng 从 1 涨到 2 即证明第 3 回合抽牌触发了弃牌堆回洗。
      expect(p.counters).toEqual(g.final.counters);
    });
  }

  it("痛击的易伤只影响其后打出的牌，不影响自身那一击", () => {
    const g = golden.cases[0]!;
    const bc = newBattle(g);
    // 伤害在入队时结算：此刻敌人无易伤，痛击按 8 计。
    expect(calculateCardDamage(bc, 0, 8)).toBe(8);
    bc.monsters[0]!.powers.push({ id: "vulnerable", amount: 2 });
    // 易伤生效后，打击 6 → floor(6*1.5)=9。
    expect(calculateCardDamage(bc, 0, 6)).toBe(9);
  });

  it("敌人被击杀即判定胜利，并清空出牌队列", () => {
    const g = golden.cases[0]!;
    const bc = newBattle(g);
    bc.monsters[0]!.hp = 1;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    expect(idx).toBeGreaterThanOrEqual(0);
    const r = playCard(bc, idx, 0);
    expect(r.ok).toBe(true);
    expect(bc.monsters[0]!.alive).toBe(false);
    expect(bc.monstersAlive).toBe(0);
    expect(probe(bc).outcome).toBe("player_victory");
  });

  it("能量不足时拒绝出牌且不改变状态", () => {
    const g = golden.cases[0]!;
    const bc = newBattle(g);
    bc.player.energy = 0;
    const before = probe(bc);
    const r = playCard(bc, 0, 0);
    expect(r.ok).toBe(false);
    expect(probe(bc)).toEqual(before);
  });
});
