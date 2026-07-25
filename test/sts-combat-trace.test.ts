import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  initCombat,
  endTurn,
  playCard,
  drinkPotion,
  type BattleContext,
} from "../src/engine/sts-combat.js";
import { StsRandom } from "../src/engine/sts-rng.js";

// ============================================================================
// 逐帧重放对拍：数据由参考项目**真实 BattleContext** 驱动产出（非手工转写）。
//
// trace 里记录了「动作序列 + 每步之后的全量状态」。本测试重放同一动作序列，
// 逐帧比对状态。因为两边消费的是同一份已记录的动作，策略本身不可能成为分歧来源——
// 只有引擎行为会。
// ============================================================================

type Snapshot = {
  turn: number;
  outcome: string;
  player: {
    hp: number;
    maxHp: number;
    block: number;
    energy: number;
    powers: Record<string, number>;
  };
  monsters: {
    id: string;
    hp: number;
    maxHp: number;
    block: number;
    alive: boolean;
    move: string;
    powers: Record<string, number>;
  }[];
  hand: string[];
  draw: string[];
  discard: string[];
  exhaust: string[];
  potions: string[];
  rng: {
    ai: number;
    hp: number;
    shuffle: number;
    cardRandom: number;
    misc: number;
    potion: number;
  };
};

type Step = { action: { type: string; idx?: number; target?: number }; after: Snapshot };

type Trace = {
  seed: string;
  potionRngSeed: string;
  seedLong: string;
  floor: number;
  encounter: string;
  character: string;
  deck: string[];
  initial: Snapshot;
  steps: Step[];
};

const tracePath = fileURLToPath(new URL("./golden/combat_traces.json", import.meta.url));
const { traces } = JSON.parse(readFileSync(tracePath, "utf8")) as { traces: Trace[] };

// —— 参考枚举名 → 我们的 id ——
const CARD: Record<string, string> = {
  STRIKE_RED: "strike",
  DEFEND_RED: "defend",
  BASH: "bash",
};
const ENCOUNTER: Record<string, string> = {
  CULTIST: "cultist",
  JAW_WORM: "jaw_worm",
  JAW_WORM_HORDE: "jaw_worm_horde",
  TWO_LOUSE: "two_louse",
  THREE_LOUSE: "three_louse",
};
const MONSTER: Record<string, string> = {
  CULTIST: "cultist",
  JAW_WORM: "jaw_worm",
  RED_LOUSE: "louse",
  GREEN_LOUSE: "green_louse",
};
const MOVE: Record<string, string> = {
  CULTIST_INCANTATION: "incantation",
  CULTIST_DARK_STRIKE: "dark_strike",
  JAW_WORM_CHOMP: "chomp",
  JAW_WORM_BELLOW: "bellow",
  JAW_WORM_THRASH: "thrash",
  RED_LOUSE_BITE: "bite",
  RED_LOUSE_GROW: "grow",
  GREEN_LOUSE_BITE: "bite",
  GREEN_LOUSE_SPIT_WEB: "spit_web",
};
// 药水在 trace 里是显示名。含熵酿填回来的未登记药水——它们只占槽位、不会被喝。
const POTION: Record<string, string | null> = {
  EMPTY: null,
  "Ancient Potion": "ancient_potion",
  "Block Potion": "block_potion",
  "Blood Potion": "blood_potion",
  "Colorless Potion": "colorless_potion",
  "Dexterity Potion": "dexterity_potion",
  "Elixir Potion": "elixir_potion",
  "Energy Potion": "energy_potion",
  "Entropic Brew": "entropic_brew",
  "Essence Of Steel": "essence_of_steel",
  "Explosive Potion": "explosive_potion",
  "Fear Potion": "fear_potion",
  "Fire Potion": "fire_potion",
  "Flex Potion": "flex_potion",
  "Fruit Juice": "fruit_juice",
  "Liquid Bronze": "liquid_bronze",
  "Regen Potion": "regen_potion",
  "Speed Potion": "speed_potion",
  "Strength Potion": "strength_potion",
  "Swift Potion": "swift_potion",
  "Weak Potion": "weak_potion",
};

const POWER: Record<string, string> = {
  RITUAL: "ritual",
  VULNERABLE: "vulnerable",
  WEAK: "weak",
  CURL_UP: "curl_up",
  STRENGTH: "strength",
  DEXTERITY: "dexterity",
  ARTIFACT: "artifact",
};

const mapPotion = (p: string): string | null => (p in POTION ? POTION[p]! : p);

const mapPowers = (p: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    const id = POWER[k];
    if (id !== undefined && v !== 0) {
      out[id] = v;
    }
  }
  return out;
};

/** 把我方 BattleContext 折成与 trace 同构的形状，便于逐字段 diff。 */
function shape(bc: BattleContext): Record<string, unknown> {
  const powersOf = (ps: { id: string; amount: number }[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of ps) {
      if (p.amount !== 0) {
        out[p.id] = p.amount;
      }
    }
    return out;
  };
  return {
    turn: bc.turn,
    outcome: bc.outcome,
    player: {
      hp: bc.player.hp,
      maxHp: bc.player.maxHp,
      block: bc.player.block,
      energy: bc.player.energy,
      powers: powersOf(bc.player.powers),
    },
    monsters: bc.monsters.map((m) => ({
      id: m.defId,
      hp: m.hp,
      maxHp: m.maxHp,
      block: m.block,
      alive: m.alive,
      move: m.currentMove,
      powers: powersOf(m.powers),
    })),
    hand: bc.hand.map((c) => c.defId),
    draw: bc.drawPile.map((c) => c.defId),
    discard: bc.discardPile.map((c) => c.defId),
    exhaust: bc.exhaustPile.map((c) => c.defId),
    potions: [...bc.potions],
    rng: {
      ai: bc.rng.aiRng.counter,
      hp: bc.rng.monsterHpRng.counter,
      shuffle: bc.rng.shuffleRng.counter,
      cardRandom: bc.rng.cardRandomRng.counter,
      misc: bc.rng.miscRng.counter,
      potion: bc.rng.potionRng.counter,
    },
  };
}

/** 把 trace 快照折成同构形状。 */
function shapeExpected(s: Snapshot): Record<string, unknown> {
  return {
    turn: s.turn,
    outcome: s.outcome,
    player: {
      hp: s.player.hp,
      maxHp: s.player.maxHp,
      block: s.player.block,
      energy: s.player.energy,
      powers: mapPowers(s.player.powers),
    },
    monsters: s.monsters.map((m) => ({
      id: MONSTER[m.id] ?? m.id,
      hp: m.hp,
      maxHp: m.maxHp,
      block: m.block,
      alive: m.alive,
      move: MOVE[m.move] ?? m.move,
      powers: mapPowers(m.powers),
    })),
    hand: s.hand.map((c) => CARD[c] ?? c),
    draw: s.draw.map((c) => CARD[c] ?? c),
    discard: s.discard.map((c) => CARD[c] ?? c),
    exhaust: s.exhaust.map((c) => CARD[c] ?? c),
    potions: s.potions.map(mapPotion),
    rng: s.rng,
  };
}

const start = (t: Trace): BattleContext =>
  initCombat({
    seedLong: BigInt(t.seedLong),
    floorNum: t.floor,
    ascension: 0,
    encounterId: ENCOUNTER[t.encounter]!,
    deckCardIds: t.deck.map((c) => CARD[c] ?? c),
    playerHp: t.initial.player.hp,
    playerMaxHp: t.initial.player.maxHp,
    character: "ironclad",
    potions: t.initial.potions.map(mapPotion),
    // potionRng 是 run 级持久流，harness 明确把它钉在 Random(seed)。
    potionRng: new StsRandom(BigInt(t.potionRngSeed)),
  });

const byEncounter = new Map<string, Trace[]>();
for (const t of traces) {
  const list = byEncounter.get(t.encounter) ?? [];
  list.push(t);
  byEncounter.set(t.encounter, list);
}

describe("sts-combat 逐帧重放参考项目真实战斗 trace", () => {
  for (const [encounter, list] of byEncounter) {
    describe(encounter, () => {
      for (const t of list) {
        it(`seed "${t.seed}" @floor ${t.floor}（${t.steps.length} 步）`, () => {
          const bc = start(t);
          expect(shape(bc)).toEqual(shapeExpected(t.initial));

          t.steps.forEach((step, i) => {
            if (step.action.type === "card") {
              const r = playCard(bc, step.action.idx!, step.action.target!);
              expect(r, `第 ${i + 1} 步出牌被拒: ${JSON.stringify(step.action)}`).toEqual({
                ok: true,
              });
            } else if (step.action.type === "potion") {
              const r = drinkPotion(bc, step.action.idx!, step.action.target!);
              expect(r, `第 ${i + 1} 步喝药水被拒: ${JSON.stringify(step.action)}`).toEqual({
                ok: true,
              });
            } else {
              endTurn(bc);
            }
            expect(
              shape(bc),
              `第 ${i + 1} 步后状态不符（动作 ${JSON.stringify(step.action)}）`,
            ).toEqual(shapeExpected(step.after));
          });
        });
      }
    });
  }
});
