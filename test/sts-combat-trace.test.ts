import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initCombat,
  endTurn,
  playCard,
  drinkPotion,
  selectCard,
  selectCards,
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

type Step = {
  action: { type: string; idx?: number; target?: number; idxs?: number[] };
  after: Snapshot;
};

type Trace = {
  seed: string;
  relics: string[];
  potionRngSeed: string;
  seedLong: string;
  floor: number;
  encounter: string;
  character: string;
  deck: string[];
  /**
   * 与 deck 等长的 0/1，标记每张牌是否升级。
   *
   * 仅在**确有**升级牌时由 harness 输出，所以未升级的 trace 行与这个字段存在之前提交的
   * 数据逐字节一致——冻结的 variant 0 因此不必随这个字段的引入重生成。
   */
  deckUpgraded?: number[];
  initial: Snapshot;
  steps: Step[];
};

// 按编队分文件存放（JSONL，每行一条 trace）：
//  * 新增编队 = 新增一个文件，既有文件零改动，git 历史里不会多出重写的大 blob
//  * 单个编队重生成只碰它自己那份
//  * 行结构让 git 能在版本间做增量，diff 也能看出是哪几条 trace 变了
// 生成是确定性的：同参数重跑逐字节一致，因此不会平白产生新 blob。
const traceDir = fileURLToPath(new URL("./golden/traces", import.meta.url));
const traces: Trace[] = readdirSync(traceDir)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()
  .flatMap((f) =>
    readFileSync(join(traceDir, f), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Trace),
  );

// —— 参考枚举名 → 我们的 id ——
const CARD: Record<string, string> = {
  STRIKE_RED: "strike",
  DEFEND_RED: "defend",
  BASH: "bash",
  ANGER: "anger",
  CLEAVE: "cleave",
  CLOTHESLINE: "clothesline",
  HEAVY_BLADE: "heavy_blade",
  IRON_WAVE: "iron_wave",
  POMMEL_STRIKE: "pommel_strike",
  SHRUG_IT_OFF: "shrug_it_off",
  THUNDERCLAP: "thunderclap",
  TWIN_STRIKE: "twin_strike",
  BODY_SLAM: "body_slam",
  INFLAME: "inflame",
  // —— 第二批 29 张 ——
  BITE: "bite",
  BLUDGEON: "bludgeon",
  DROPKICK: "dropkick",
  FEED: "feed",
  FIEND_FIRE: "fiend_fire",
  FLASH_OF_STEEL: "flash_of_steel",
  HEMOKINESIS: "hemokinesis",
  PUMMEL: "pummel",
  REAPER: "reaper",
  SEVER_SOUL: "sever_soul",
  SWORD_BOOMERANG: "sword_boomerang",
  SWIFT_STRIKE: "swift_strike",
  BANDAGE_UP: "bandage_up",
  BLIND: "blind",
  BLOODLETTING: "bloodletting",
  DEEP_BREATH: "deep_breath",
  ENTRENCH: "entrench",
  FINESSE: "finesse",
  GOOD_INSTINCTS: "good_instincts",
  IMPERVIOUS: "impervious",
  INTIMIDATE: "intimidate",
  JAX: "jax",
  MASTER_OF_STRATEGY: "master_of_strategy",
  OFFERING: "offering",
  PANACEA: "panacea",
  SECOND_WIND: "second_wind",
  SHOCKWAVE: "shockwave",
  SPOT_WEAKNESS: "spot_weakness",
  BERSERK: "berserk",
  // —— 第三批 12 张（回合边界 Power 解锁的）——
  UPPERCUT: "uppercut",
  BATTLE_TRANCE: "battle_trance",
  DISARM: "disarm",
  FLEX: "flex",
  IMPATIENCE: "impatience",
  LIMIT_BREAK: "limit_break",
  SEEING_RED: "seeing_red",
  TRIP: "trip",
  BARRICADE: "barricade",
  COMBUST: "combust",
  DEMON_FORM: "demon_form",
  METALLICIZE: "metallicize",
  // —— 第四批 10 张（选牌屏解锁的）——
  ARMAMENTS: "armaments",
  BURNING_PACT: "burning_pact",
  EXHUME: "exhume",
  HEADBUTT: "headbutt",
  PURITY: "purity",
  SECRET_TECHNIQUE: "secret_technique",
  SECRET_WEAPON: "secret_weapon",
  THINKING_AHEAD: "thinking_ahead",
  TRUE_GRIT: "true_grit",
  WARCRY: "warcry",
  // —— 第五批 11 张（牌的生命周期：消耗触发 / 状态牌生成 / 以太 / 固有归位）——
  DARK_EMBRACE: "dark_embrace",
  FEEL_NO_PAIN: "feel_no_pain",
  IMMOLATE: "immolate",
  RECKLESS_CHARGE: "reckless_charge",
  WILD_STRIKE: "wild_strike",
  POWER_THROUGH: "power_through",
  CARNAGE: "carnage",
  GHOSTLY_ARMOR: "ghostly_armor",
  DRAMATIC_ENTRANCE: "dramatic_entrance",
  MIND_BLAST: "mind_blast",
  BRUTALITY: "brutality",
  EVOLVE: "evolve",
  // —— 第六批 7 张（玩家的事件钩子）——
  FLAME_BARRIER: "flame_barrier",
  FIRE_BREATHING: "fire_breathing",
  RAGE: "rage",
  JUGGERNAUT: "juggernaut",
  RUPTURE: "rupture",
  SENTINEL: "sentinel",
  PANIC_BUTTON: "panic_button",
  // 第五批凭空造出来的状态牌。三张都**不在牌组里**，只由卡效果生成，所以不进 CARD_RULES
  // （打不出来，playCard 有一道 canUse 门拦着），但会出现在牌堆快照里，必须能映射。
  BURN: "burn",
  WOUND: "wound",
  DAZED: "dazed",
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
  "Attack Potion": "attack_potion",
  "Blessing Of The Forge": "blessing_of_the_forge",
  "Block Potion": "block_potion",
  "Blood Potion": "blood_potion",
  "Colorless Potion": "colorless_potion",
  "Cultist Potion": "cultist_potion",
  "Dexterity Potion": "dexterity_potion",
  "Distilled Chaos": "distilled_chaos",
  "Duplication Potion": "duplication_potion",
  "Elixir Potion": "elixir_potion",
  "Energy Potion": "energy_potion",
  "Entropic Brew": "entropic_brew",
  "Essence Of Steel": "essence_of_steel",
  "Explosive Potion": "explosive_potion",
  "Fairy Potion": "fairy_in_a_bottle",
  "Fear Potion": "fear_potion",
  "Fire Potion": "fire_potion",
  "Flex Potion": "flex_potion",
  "Fruit Juice": "fruit_juice",
  "Gamblers Brew": "gamblers_brew",
  "Heart Of Iron": "heart_of_iron_potion",
  "Liquid Bronze": "liquid_bronze",
  "Liquid Memories": "liquid_memories",
  "Power Potion": "power_potion",
  "Regen Potion": "regen_potion",
  "Skill Potion": "skill_potion",
  "Smoke Bomb": "smoke_bomb",
  "Snecko Oil": "snecko_oil",
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
  THORNS: "thorns",
  VIGOR: "vigor",
  // —— 回合边界 Power（第三批）——
  METALLICIZE: "metallicize",
  COMBUST: "combust",
  DEMON_FORM: "demon_form",
  // 灵活的「回合末归还力量」标记，打出灵活那一帧就可见。
  LOSE_STRENGTH: "lose_strength",
  // 战斗恍惚的封抽牌标记，同上。
  NO_DRAW: "no_draw",
  // 纯 bool 状态：参考只置 bit、从不写 statusMap，harness 按 1 输出（见 trace_dump 的
  // playerStatusValue），我们这边也存 1。
  BARRICADE: "barricade",
  // —— 牌生命周期 Power（第五批）——
  BRUTALITY: "brutality",
  DARK_EMBRACE: "dark_embrace",
  EVOLVE: "evolve",
  FEEL_NO_PAIN: "feel_no_pain",
  // —— 事件钩子 Power（第六批）——
  FLAME_BARRIER: "flame_barrier",
  FIRE_BREATHING: "fire_breathing",
  JUGGERNAUT: "juggernaut",
  RAGE: "rage",
  RUPTURE: "rupture",
  // 应急按钮的「无法从牌获得格挡」。参考的枚举名是 NO_BLOCK，我们的 PowerId 叫
  // no_card_block（types.ts 早就这么定了，名字更准：拦的只有牌产生的格挡）。
  NO_BLOCK: "no_card_block",
};

const mapPotion = (p: string): string | null => (p in POTION ? POTION[p]! : p);

const mapPowers = (p: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === 0) {
      continue;
    }
    const id = POWER[k];
    // 未映射的 power 必须**报错**，不能静默丢掉：丢掉的话「参考施加了某个我们没实现的
    // power」两边都是空对象，测试反而变绿——正是这类静默通过最危险。
    if (id === undefined) {
      throw new Error(`trace 里出现未映射的 power: ${k}=${String(v)}（请补进 POWER 映射表）`);
    }
    out[id] = v;
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
    deck: t.deck.map((c, i) => ({
      defId: CARD[c] ?? c,
      upgraded: (t.deckUpgraded?.[i] ?? 0) === 1,
    })),
    playerHp: t.initial.player.hp,
    playerMaxHp: t.initial.player.maxHp,
    character: "ironclad",
    relics: t.relics,
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
        // 牌组规格进标题：同一 (seed, floor) 现在有多条 trace（不同 deck variant），
        // 不标出来失败时看不出是哪一副牌组翻的。
        const variant = `${t.deck.length}张${t.deckUpgraded === undefined ? "" : "·升级"}`;
        it(`seed "${t.seed}" @floor ${t.floor} [${variant}]（${t.steps.length} 步）`, () => {
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
            } else if (step.action.type === "select_card") {
              // 选牌屏单选。被拒**同样是失败**：说明我们这边压根没开屏、或开的是另一块屏、
              // 或候选集算错了——静默跳过会让整块机制看着是绿的。
              const r = selectCard(bc, step.action.idx!);
              expect(r, `第 ${i + 1} 步选牌被拒: ${JSON.stringify(step.action)}`).toEqual({
                ok: true,
              });
            } else if (step.action.type === "select_cards") {
              const r = selectCards(bc, step.action.idxs!);
              expect(r, `第 ${i + 1} 步多选被拒: ${JSON.stringify(step.action)}`).toEqual({
                ok: true,
              });
            } else {
              const r = endTurn(bc);
              expect(r, `第 ${i + 1} 步结束回合被拒`).toEqual({ ok: true });
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
