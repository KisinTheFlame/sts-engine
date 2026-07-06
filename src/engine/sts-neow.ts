// === 游戏级 Neow 三选项：同种子复现开局 Neow 奖励（issue #1）===
//
// 逐行移植 sts_lightspeed/src/game/Neow.cpp 的 Neow::getOptions。给定游戏种子即产出
// 与游戏一致的 4 个 Neow 选项（bonus + drawback）。neowRng = StsRandom(seed)。
//
// 本层只做「选项枚举」——getCardReward/getColorlessCardReward 依赖卡池，另层再做。
// 黄金对拍：test/golden/neow.json（Neow::getOptions 定向编译 dump）。

import { StsRandom, seedStringToLong } from "./sts-rng.js";

/** Neow 奖励（bonus），值与 C++ Neow::Bonus 一致。 */
export enum NeowBonus {
  THREE_CARDS = 0,
  ONE_RANDOM_RARE_CARD,
  REMOVE_CARD,
  UPGRADE_CARD,
  TRANSFORM_CARD,
  RANDOM_COLORLESS,
  THREE_SMALL_POTIONS,
  RANDOM_COMMON_RELIC,
  TEN_PERCENT_HP_BONUS,
  THREE_ENEMY_KILL,
  HUNDRED_GOLD,
  RANDOM_COLORLESS_2,
  REMOVE_TWO,
  ONE_RARE_RELIC,
  THREE_RARE_CARDS,
  TWO_FIFTY_GOLD,
  TRANSFORM_TWO_CARDS,
  TWENTY_PERCENT_HP_BONUS,
  BOSS_RELIC,
  INVALID,
}

/** Neow 代价（drawback），值与 C++ Neow::Drawback 一致。 */
export enum NeowDrawback {
  INVALID = 0,
  NONE,
  TEN_PERCENT_HP_LOSS,
  NO_GOLD,
  CURSE,
  PERCENT_DAMAGE,
  LOSE_STARTER_RELIC,
}

export type NeowOption = { bonus: NeowBonus; drawback: NeowDrawback };

const BONUS_STRINGS: Record<NeowBonus, string> = {
  [NeowBonus.THREE_CARDS]: "Choose a card to obtain.",
  [NeowBonus.ONE_RANDOM_RARE_CARD]: "Obtain a random rare card.",
  [NeowBonus.REMOVE_CARD]: "Remove a card.",
  [NeowBonus.UPGRADE_CARD]: "Upgrade a card.",
  [NeowBonus.TRANSFORM_CARD]: "Transform a card.",
  [NeowBonus.RANDOM_COLORLESS]: "Choose a colorless card to obtain.",
  [NeowBonus.THREE_SMALL_POTIONS]: "Obtain three potions.",
  [NeowBonus.RANDOM_COMMON_RELIC]: "Obtain a random common relic.",
  [NeowBonus.TEN_PERCENT_HP_BONUS]: "Max Hp +10%.",
  [NeowBonus.THREE_ENEMY_KILL]: "Obtain Neow's Lament.",
  [NeowBonus.HUNDRED_GOLD]: "Obtain 100 gold.",
  [NeowBonus.RANDOM_COLORLESS_2]: "Choose a rare colorless card to obtain.",
  [NeowBonus.REMOVE_TWO]: "Remove two cards.",
  [NeowBonus.ONE_RARE_RELIC]: "Obtain a random rare relic.",
  [NeowBonus.THREE_RARE_CARDS]: "Choose a rare card to obtain.",
  [NeowBonus.TWO_FIFTY_GOLD]: "Obtain 250 gold.",
  [NeowBonus.TRANSFORM_TWO_CARDS]: "Transform two cards in your cards.",
  [NeowBonus.TWENTY_PERCENT_HP_BONUS]: "Max Hp +20%.",
  [NeowBonus.BOSS_RELIC]: "Obtain a random boss relic.",
  [NeowBonus.INVALID]: "INVALID",
};

const DRAWBACK_STRINGS: Record<NeowDrawback, string> = {
  [NeowDrawback.INVALID]: "INVALID",
  [NeowDrawback.NONE]: "",
  [NeowDrawback.TEN_PERCENT_HP_LOSS]: "Max Hp -10%.",
  [NeowDrawback.NO_GOLD]: "Lose all gold.",
  [NeowDrawback.CURSE]: "Obtain a curse.",
  [NeowDrawback.PERCENT_DAMAGE]: "Take 30% Hp damage.",
  [NeowDrawback.LOSE_STARTER_RELIC]: "Lose your starter relic.",
};

export function neowBonusText(b: NeowBonus): string {
  return BONUS_STRINGS[b];
}
export function neowDrawbackText(d: NeowDrawback): string {
  return DRAWBACK_STRINGS[d];
}

// drawback → 对应的 bonus 候选子表（对齐 Neow.cpp 的 switch）。
const HP_LOSS_REWARDS = [
  NeowBonus.RANDOM_COLORLESS_2,
  NeowBonus.REMOVE_TWO,
  NeowBonus.ONE_RARE_RELIC,
  NeowBonus.THREE_RARE_CARDS,
  NeowBonus.TWO_FIFTY_GOLD,
  NeowBonus.TRANSFORM_TWO_CARDS,
];
const NO_GOLD_REWARDS = [
  NeowBonus.RANDOM_COLORLESS_2,
  NeowBonus.REMOVE_TWO,
  NeowBonus.ONE_RARE_RELIC,
  NeowBonus.THREE_RARE_CARDS,
  NeowBonus.TRANSFORM_TWO_CARDS,
  NeowBonus.TWENTY_PERCENT_HP_BONUS,
];
const CURSE_REWARDS = [
  NeowBonus.RANDOM_COLORLESS_2,
  NeowBonus.ONE_RARE_RELIC,
  NeowBonus.THREE_RARE_CARDS,
  NeowBonus.TWO_FIFTY_GOLD,
  NeowBonus.TRANSFORM_TWO_CARDS,
  NeowBonus.TWENTY_PERCENT_HP_BONUS,
];

/**
 * 从游戏种子生成 4 个 Neow 选项（逐位对齐 Neow::getOptions）。
 * @param seed 游戏种子字符串（base-35）或 int64 bigint。
 */
export function generateNeowOptions(seed: string | bigint): NeowOption[] {
  const seedLong = typeof seed === "bigint" ? seed : seedStringToLong(seed);
  const r = new StsRandom(seedLong);

  const options: NeowOption[] = [
    { bonus: NeowBonus.INVALID, drawback: NeowDrawback.NONE },
    { bonus: NeowBonus.INVALID, drawback: NeowDrawback.NONE },
    { bonus: NeowBonus.INVALID, drawback: NeowDrawback.INVALID },
    { bonus: NeowBonus.INVALID, drawback: NeowDrawback.INVALID },
  ];

  options[0].bonus = r.random(0, 5);
  options[0].drawback = NeowDrawback.NONE;
  options[1].bonus = (6 + r.random(0, 4));
  options[1].drawback = NeowDrawback.NONE;

  options[2].drawback = (2 + r.random(0, 3));
  switch (options[2].drawback) {
    case NeowDrawback.TEN_PERCENT_HP_LOSS:
      options[2].bonus = HP_LOSS_REWARDS[r.random(0, 5)]!;
      break;
    case NeowDrawback.NO_GOLD:
      options[2].bonus = NO_GOLD_REWARDS[r.random(0, 5)]!;
      break;
    case NeowDrawback.CURSE:
      options[2].bonus = CURSE_REWARDS[r.random(0, 5)]!;
      break;
    case NeowDrawback.PERCENT_DAMAGE:
      options[2].bonus = (11 + r.random(0, 6));
      break;
    default:
      break;
  }

  options[3].bonus = NeowBonus.BOSS_RELIC;
  options[3].drawback = NeowDrawback.LOSE_STARTER_RELIC;
  r.random(0, 0); // 对齐游戏：末尾多消耗一次

  return options;
}
