// === 游戏级怪物遭遇序列：同种子复现每幕打谁（issue #1）===
//
// 移植 sts_lightspeed/src/game/GameContext.cpp 的 generateWeak/Strong/Elites/Boss +
// MonsterEncounters.h 的遭遇池表。monsterRng 是单条持久流（Random(seed)），跨幕续 counter。
// 逐幕产出 { monsters（weak+strong）, elites, boss }。
//
// 黄金对拍：test/golden/encounters.json（池表 + 生成函数定向编译 dump，单持久流跑三幕）。

import { StsRandom, JavaRandom, javaShuffle, seedStringToLong } from "./sts-rng.js";

/** 怪物遭遇（值与 C++ MonsterEncounter 一致，0-indexed）。 */
export enum MonsterEncounter {
  INVALID = 0,
  CULTIST,
  JAW_WORM,
  TWO_LOUSE,
  SMALL_SLIMES,
  BLUE_SLAVER,
  GREMLIN_GANG,
  LOOTER,
  LARGE_SLIME,
  LOTS_OF_SLIMES,
  EXORDIUM_THUGS,
  EXORDIUM_WILDLIFE,
  RED_SLAVER,
  THREE_LOUSE,
  TWO_FUNGI_BEASTS,
  GREMLIN_NOB,
  LAGAVULIN,
  THREE_SENTRIES,
  SLIME_BOSS,
  THE_GUARDIAN,
  HEXAGHOST,
  SPHERIC_GUARDIAN,
  CHOSEN,
  SHELL_PARASITE,
  THREE_BYRDS,
  TWO_THIEVES,
  CHOSEN_AND_BYRDS,
  SENTRY_AND_SPHERE,
  SNAKE_PLANT,
  SNECKO,
  CENTURION_AND_HEALER,
  CULTIST_AND_CHOSEN,
  THREE_CULTIST,
  SHELLED_PARASITE_AND_FUNGI,
  GREMLIN_LEADER,
  SLAVERS,
  BOOK_OF_STABBING,
  AUTOMATON,
  COLLECTOR,
  CHAMP,
  THREE_DARKLINGS,
  ORB_WALKER,
  THREE_SHAPES,
  SPIRE_GROWTH,
  TRANSIENT,
  FOUR_SHAPES,
  MAW,
  SPHERE_AND_TWO_SHAPES,
  JAW_WORM_HORDE,
  WRITHING_MASS,
  GIANT_HEAD,
  NEMESIS,
  REPTOMANCER,
  AWAKENED_ONE,
  TIME_EATER,
  DONU_AND_DECA,
  SHIELD_AND_SPEAR,
  THE_HEART,
  LAGAVULIN_EVENT,
  COLOSSEUM_EVENT_SLAVERS,
  COLOSSEUM_EVENT_NOBS,
  MASKED_BANDITS_EVENT,
  MUSHROOMS_EVENT,
  MYSTERIOUS_SPHERE_EVENT,
}

const ME = MonsterEncounter;

// === 遭遇池表（对齐 MonsterEncounterPool，按幕索引 [act-1]）===

const WEAK_ENEMIES: MonsterEncounter[][] = [
  [ME.CULTIST, ME.JAW_WORM, ME.TWO_LOUSE, ME.SMALL_SLIMES],
  [ME.SPHERIC_GUARDIAN, ME.CHOSEN, ME.SHELL_PARASITE, ME.THREE_BYRDS, ME.TWO_THIEVES],
  [ME.THREE_DARKLINGS, ME.ORB_WALKER, ME.THREE_SHAPES],
];
const WEAK_WEIGHTS: number[][] = [
  [1 / 4, 1 / 4, 1 / 4, 1 / 4],
  [1 / 5, 1 / 5, 1 / 5, 1 / 5, 1 / 5],
  [1 / 3, 1 / 3, 1 / 3],
];

const STRONG_ENEMIES: MonsterEncounter[][] = [
  [
    ME.GREMLIN_GANG,
    ME.LOTS_OF_SLIMES,
    ME.RED_SLAVER,
    ME.EXORDIUM_THUGS,
    ME.EXORDIUM_WILDLIFE,
    ME.BLUE_SLAVER,
    ME.LOOTER,
    ME.LARGE_SLIME,
    ME.THREE_LOUSE,
    ME.TWO_FUNGI_BEASTS,
  ],
  [
    ME.CHOSEN_AND_BYRDS,
    ME.SENTRY_AND_SPHERE,
    ME.CULTIST_AND_CHOSEN,
    ME.THREE_CULTIST,
    ME.SHELLED_PARASITE_AND_FUNGI,
    ME.SNECKO,
    ME.SNAKE_PLANT,
    ME.CENTURION_AND_HEALER,
  ],
  [
    ME.SPIRE_GROWTH,
    ME.TRANSIENT,
    ME.FOUR_SHAPES,
    ME.MAW,
    ME.SPHERE_AND_TWO_SHAPES,
    ME.JAW_WORM_HORDE,
    ME.THREE_DARKLINGS,
    ME.WRITHING_MASS,
  ],
];
const STRONG_WEIGHTS: number[][] = [
  [1 / 16, 1 / 16, 1 / 16, 1.5 / 16, 1.5 / 16, 2 / 16, 2 / 16, 2 / 16, 2 / 16, 2 / 16],
  [2 / 29, 2 / 29, 3 / 29, 3 / 29, 3 / 29, 4 / 29, 6 / 29, 6 / 29],
  [1 / 8, 1 / 8, 1 / 8, 1 / 8, 1 / 8, 1 / 8, 1 / 8, 1 / 8],
];

const ELITES: MonsterEncounter[][] = [
  [ME.GREMLIN_NOB, ME.LAGAVULIN, ME.THREE_SENTRIES],
  [ME.GREMLIN_LEADER, ME.SLAVERS, ME.BOOK_OF_STABBING],
  [ME.GIANT_HEAD, ME.NEMESIS, ME.REPTOMANCER],
];

const BOSSES: MonsterEncounter[][] = [
  [ME.THE_GUARDIAN, ME.HEXAGHOST, ME.SLIME_BOSS],
  [ME.AUTOMATON, ME.COLLECTOR, ME.CHAMP],
  [ME.AWAKENED_ONE, ME.TIME_EATER, ME.DONU_AND_DECA],
];

// === 生成函数（对齐 GameContext）===

/** 权重累加取索引（对齐 rollWeightedIdx）。 */
function rollWeightedIdx(roll: number, weights: number[]): number {
  let cur = 0;
  for (let i = 0; i < weights.length; i += 1) {
    cur += weights[i];
    if (roll < cur) {
      return i;
    }
  }
  return weights.length - 1;
}

function populateMonsterList(
  monsterList: MonsterEncounter[],
  rng: StsRandom,
  monsters: MonsterEncounter[],
  weights: number[],
  numMonsters: number,
): void {
  for (let i = 0; i < numMonsters; i += 1) {
    if (monsterList.length === 0) {
      monsterList.push(monsters[rollWeightedIdx(rng.randomFloat(), weights)]);
    } else {
      const toAdd = monsters[rollWeightedIdx(rng.randomFloat(), weights)];
      const n = monsterList.length;
      if (toAdd !== monsterList[n - 1] && (n < 2 || toAdd !== monsterList[n - 2])) {
        monsterList.push(toAdd);
      } else {
        i -= 1;
      }
    }
  }
}

function populateFirstStrongEnemy(
  monsterList: MonsterEncounter[],
  rng: StsRandom,
  monsters: MonsterEncounter[],
  weights: number[],
): void {
  const lastMonster = monsterList[monsterList.length - 1];
  for (;;) {
    const toAdd = monsters[rollWeightedIdx(rng.randomFloat(), weights)];
    if (
      (toAdd === ME.LARGE_SLIME || toAdd === ME.LOTS_OF_SLIMES) &&
      lastMonster === ME.SMALL_SLIMES
    ) {
      continue;
    }
    if (toAdd === ME.THREE_LOUSE && lastMonster === ME.TWO_LOUSE) {
      continue;
    }
    monsterList.push(toAdd);
    return;
  }
}

function rollElite(rng: StsRandom): number {
  const roll = rng.randomFloat();
  if (roll < 1 / 3) {
    return 0;
  }
  if (roll < 2 / 3) {
    return 1;
  }
  return 2;
}

export type ActEncounters = {
  act: number;
  /** weak + strong 遭遇序列（act1 有 3 弱，其余 2 弱；随后 1+12 强）。 */
  monsters: MonsterEncounter[];
  /** 10 个精英遭遇。 */
  elites: MonsterEncounter[];
  boss: MonsterEncounter;
  /** 第二 boss：仅 act3 有值（洗牌次位），A20 双 boss 用；其余幕为 null。 */
  secondBoss: MonsterEncounter | null;
};

/**
 * 从游戏种子生成全部三幕的怪物遭遇（逐位对齐游戏 monsterRng 消耗顺序）。
 * monsterRng 是单条持久流：act1 从 Random(seed) 起，act2/3 续 counter。
 * @param seed 游戏种子字符串（base-35）或 int64 bigint。
 */
export function generateEncounters(seed: string | bigint): ActEncounters[] {
  const seedLong = typeof seed === "bigint" ? seed : seedStringToLong(seed);
  const rng = new StsRandom(seedLong);
  const acts: ActEncounters[] = [];

  for (let act = 1; act <= 3; act += 1) {
    const idx = act - 1;
    const monsterList: MonsterEncounter[] = [];

    // weak
    populateMonsterList(monsterList, rng, WEAK_ENEMIES[idx], WEAK_WEIGHTS[idx], act === 1 ? 3 : 2);
    // strong：1 首战（带约束）+ 12
    populateFirstStrongEnemy(monsterList, rng, STRONG_ENEMIES[idx], STRONG_WEIGHTS[idx]);
    populateMonsterList(monsterList, rng, STRONG_ENEMIES[idx], STRONG_WEIGHTS[idx], 12);

    // elites：10 个，rollElite 三分 + 不与上一个重复
    const eliteList: MonsterEncounter[] = [];
    for (let i = 0; i < 10; i += 1) {
      const candidate = ELITES[idx][rollElite(rng)];
      if (eliteList.length === 0) {
        eliteList.push(candidate);
      } else if (candidate !== eliteList[eliteList.length - 1]) {
        eliteList.push(candidate);
      } else {
        i -= 1;
      }
    }

    // boss：java 洗牌 {0,1,2}，取首个（act3 次位为第二 boss）
    const indices = [0, 1, 2];
    javaShuffle(indices, new JavaRandom(rng.randomLong()));
    const boss = BOSSES[idx][indices[0]];
    const secondBoss = act === 3 ? BOSSES[idx][indices[1]] : null;

    acts.push({ act, monsters: monsterList, elites: eliteList, boss, secondBoss });
  }

  return acts;
}
