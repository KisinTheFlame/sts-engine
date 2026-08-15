import type { CardInstance, CardType, CharacterId, GameState, RelicState } from "../types.js";
import { getCardDef, rewardCardPoolOf } from "../cards/cards.js";
import { POTION_DROP_POOL } from "../potions/potions.js";
import { nextInt } from "../rng.js";

// 角色颜色（避免引入 characters 造成循环）；转化卡从该色奖励池里随机取。
const CHARACTER_COLOR: Record<CharacterId, "red" | "green" | "blue" | "purple"> = {
  ironclad: "red",
  silent: "green",
  defect: "blue",
  watcher: "purple",
};

/** 把一张牌实例转化为本角色奖励池里的一张随机牌（潘多拉魔盒/星盘）。 */
function transformCardInstance(state: GameState, card: CardInstance): void {
  const pool = rewardCardPoolOf(CHARACTER_COLOR[state.character]);
  card.defId = pool[nextInt(state.rng, pool.length)]!;
  card.upgraded = false;
}

// === 遗物系统 ===
//
// 本表现在是**数据表 + 局外行为**：id / 名称 / 稀有度 / 文案 / 池归属 / 角色专属，
// 加上三个战斗外钩子（见下方 RelicHooks）。
//
// 遗物的**战斗内**行为属于 sts-combat.ts 的登记表（`RELIC_IMMEDIATE` /
// `RELIC_AT_BATTLE_START`）——那边才是逐位对齐的实现。本表里凡是描述战斗内效果的遗物，
// 只要还没登记进去，就暂时只有文案没有行为；进度见 TODOS.md。
//
// state.relics 只存可序列化的 { id, counter }；计数型遗物读写 self.counter。

// "shop"：商店专属遗物（只在商店出现，不进宝箱/精英/事件掉落池）。
// "special"：**不进任何随机池**的遗物——事件专属（金偶像 / 血腥雕像 / 绽放印记 / 教士之面 /
//   尼奥的挽歌 / 诅咒之书那三本 / 尼洛斯那两件 / 蛇头 / 扭曲钳）与兜底的两枚头环。
//   ⚠ 这一档对齐参考的 `RelicTier::SPECIAL`（`Relics.h:228` 那张 `relicTiers[]`，
//   181 项逐位对得上），**不是**我们自己发明的分类。判据是「玩家只能从某个具体来源拿到它」，
//   所以它必须落在 `relicIdsOfRarity` 的三个池之外——见 `REWARD_RELIC_POOL` /
//   `SHOP_RELIC_POOL` / `bossRelicPool`，三处都只列举具体档位，加一档不会自动渗进去。
type RelicRarity = "starter" | "common" | "uncommon" | "rare" | "boss" | "shop" | "special";

/**
 * 遗物钩子——**只剩战斗外的三个**。
 *
 * 战斗内行为（开局 buff、回合触发、出牌计数、失血/消耗/击杀响应…）随近似战斗一起删了：
 * 那些实现是照着近似战斗写的，逐位对齐版本要从参考项目重新转写，登记进 sts-combat.ts 的
 * `RELIC_IMMEDIATE` / `RELIC_AT_BATTLE_START`。本表因此退回「数据表 + 局外行为」。
 * 已迁移的战斗内遗物见 sts-combat.ts；进度见 TODOS.md。
 */
type RelicHooks = {
  /** 战斗胜利结算（燃烧之血、带肉骨头回血）。参考项目里这一步也在 BattleContext 之外。 */
  onCombatEnd?: (state: GameState, self: RelicState) => void;
  /** 获得该遗物时结算一次（草莓 +最大生命、药水腰带 +药水槽、磨刀石/战争彩绘升级牌）。 */
  onEquip?: (state: GameState, self: RelicState) => void;
  /** 每当一张牌被加入牌组（奖励/商店/事件）后结算（陶瓷鱼 +金币、各色蛋升级加入的牌）。 */
  onAddCard?: (state: GameState, self: RelicState, card: CardInstance) => void;
};

export type RelicDef = {
  id: string;
  name: string;
  rarity: RelicRarity;
  description: string;
  /** 角色专属：仅该角色的奖励 / 商店池里出现（省略=通用，任何角色可得）。 */
  characterLock?: CharacterId;
  hooks: RelicHooks;
};

const BURNING_BLOOD_HEAL = 6;
const STRAWBERRY_MAX_HP = 7;

function healPlayer(state: GameState, amount: number): void {
  state.hp = Math.min(state.maxHp, state.hp + amount);
}

/** 随机升级牌组中 count 张未升级的指定类型牌（磨刀石=攻击、战争彩绘=技能）。 */
function upgradeRandomCardsOfType(state: GameState, type: CardType, count: number): void {
  const candidates = state.deck.filter(
    (card) => !card.upgraded && getCardDef(card.defId).type === type,
  );
  for (let n = 0; n < count && candidates.length > 0; n += 1) {
    const idx = nextInt(state.rng, candidates.length);
    candidates[idx].upgraded = true;
    candidates.splice(idx, 1);
  }
}

/** 从牌组随机移除 count 张牌（空笼获得时净化牌组）。 */
function removeRandomCards(state: GameState, count: number): void {
  for (let n = 0; n < count && state.deck.length > 0; n += 1) {
    state.deck.splice(nextInt(state.rng, state.deck.length), 1);
  }
}

/** 瓶装遗物：把牌组里一张随机指定类型的牌封入瓶中（实例级固有，战斗开局必在起手）。 */
function bottleRandomCardOfType(state: GameState, type: CardType): void {
  const candidates = state.deck.filter(
    (card) => getCardDef(card.defId).type === type && !card.innate,
  );
  if (candidates.length > 0) {
    candidates[nextInt(state.rng, candidates.length)].innate = true;
  }
}

const RELIC_LIST: RelicDef[] = [
  {
    id: "burning_blood",
    name: "燃烧之血",
    rarity: "starter",
    description: "每场战斗结束后，回复 6 点生命。",
    hooks: {
      onCombatEnd: (state) => healPlayer(state, BURNING_BLOOD_HEAL),
    },
  },
  {
    id: "ring_of_the_snake",
    name: "蛇之戒指",
    rarity: "starter",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每场战斗的第一回合，额外抽 2 张牌。",
    hooks: {},
  },
  {
    id: "cracked_core",
    name: "残破核心",
    rarity: "starter",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每场战斗开始时，充能 1 颗闪电球。",
    hooks: {},
  },
  {
    id: "pure_water",
    name: "净水",
    rarity: "starter",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每场战斗开始时，将 1 张奇迹加入手牌。",
    hooks: {},
  },
  {
    id: "anchor",
    name: "船锚",
    rarity: "common",
    description: "每场战斗开始时，获得 10 点格挡。",
    hooks: {},
  },
  {
    id: "blood_vial",
    name: "血瓶",
    rarity: "common",
    description: "每场战斗开始时，回复 2 点生命。",
    hooks: {},
  },
  {
    id: "vajra",
    name: "金刚杵",
    rarity: "common",
    description: "每场战斗开始时，获得 1 点力量。",
    hooks: {},
  },
  {
    id: "lantern",
    name: "提灯",
    rarity: "common",
    description: "每场战斗的第一回合，额外获得 1 点能量。",
    hooks: {},
  },
  {
    id: "bag_of_marbles",
    name: "弹珠袋",
    rarity: "common",
    description: "每场战斗开始时，令所有敌人获得 1 层易伤。",
    hooks: {},
  },
  {
    id: "oddly_smooth_stone",
    name: "光滑石",
    rarity: "common",
    description: "每场战斗开始时，获得 1 点敏捷。",
    hooks: {},
  },
  {
    id: "shuriken",
    name: "手里剑",
    rarity: "common",
    description: "每打出 3 张攻击牌，获得 1 点力量。",
    hooks: {},
  },
  {
    id: "kunai",
    name: "苦无",
    rarity: "common",
    description: "每打出 3 张攻击牌，获得 1 点敏捷。",
    hooks: {},
  },
  {
    id: "ornamental_fan",
    name: "装饰扇",
    rarity: "uncommon",
    description: "每打出 3 张攻击牌，获得 4 点格挡。",
    hooks: {},
  },
  {
    id: "happy_flower",
    name: "欢乐花",
    rarity: "common",
    description: "每 3 个回合开始时，额外获得 1 点能量。",
    hooks: {},
  },
  {
    id: "horn_cleat",
    name: "角锚",
    rarity: "common",
    description: "第 2 个回合开始时，获得 14 点格挡。",
    hooks: {},
  },
  {
    id: "orichalcum",
    name: "山铜",
    rarity: "common",
    description: "若回合结束时你没有格挡，获得 6 点格挡。",
    hooks: {},
  },
  {
    id: "meat_on_the_bone",
    name: "带肉骨头",
    rarity: "uncommon",
    description: "战斗结束时若生命低于一半，回复 12 点生命。",
    hooks: {
      onCombatEnd: (state) => {
        if (state.hp <= Math.floor(state.maxHp / 2)) {
          healPlayer(state, 12);
        }
      },
    },
  },
  {
    id: "bird_faced_urn",
    name: "鸟面瓮",
    rarity: "rare",
    description: "每打出一张能力牌，回复 2 点生命。",
    hooks: {},
  },
  {
    id: "bronze_scales",
    name: "青铜鳞片",
    rarity: "common",
    description: "每场战斗开始时，获得 3 层荆棘（被攻击时反弹 3 点伤害）。",
    hooks: {},
  },
  {
    id: "letter_opener",
    name: "开信刀",
    rarity: "uncommon",
    description: "每打出 3 张技能牌，对所有敌人造成 5 点伤害。",
    hooks: {},
  },

  // —— 补全批次：通用遗物 ——
  {
    id: "nunchaku",
    name: "双节棍",
    rarity: "common",
    description: "每打出 10 张攻击牌，获得 1 点能量。",
    hooks: {},
  },
  {
    id: "mercury_hourglass",
    name: "水银沙漏",
    rarity: "uncommon",
    description: "每个回合开始时，对所有敌人造成 3 点伤害。",
    hooks: {},
  },
  {
    id: "pantograph",
    name: "缩放仪",
    rarity: "uncommon",
    description: "进入 Boss 战时，回复 25 点生命。",
    hooks: {},
  },
  {
    id: "captains_wheel",
    name: "船长之轮",
    rarity: "rare",
    description: "第 3 个回合开始时，获得 18 点格挡。",
    hooks: {},
  },
  {
    id: "stone_calendar",
    name: "石历",
    rarity: "rare",
    description: "第 7 个回合结束时，对所有敌人造成 52 点伤害。",
    hooks: {},
  },
  {
    id: "thread_and_needle",
    name: "织补针线",
    rarity: "rare",
    description: "每场战斗开始时，获得 4 层镀甲（每回合结束获得 4 点格挡）。",
    hooks: {},
  },

  // —— 补全批次：角色专属遗物 ——
  {
    id: "red_mask",
    name: "赤红面具",
    rarity: "common",
    characterLock: "silent",
    description: "每场战斗开始时，令所有敌人获得 1 层虚弱。",
    hooks: {},
  },
  {
    id: "ninja_scroll",
    name: "忍者卷轴",
    rarity: "common",
    characterLock: "silent",
    description: "每场战斗开始时，将 3 张飞刀加入手牌。",
    hooks: {},
  },
  {
    id: "twisted_funnel",
    name: "扭曲漏斗",
    rarity: "uncommon",
    characterLock: "silent",
    description: "每场战斗开始时，令所有敌人获得 4 层中毒。",
    hooks: {},
  },
  {
    id: "data_disk",
    name: "数据盘",
    rarity: "common",
    characterLock: "defect",
    description: "每场战斗开始时，获得 1 点集中。",
    hooks: {},
  },
  {
    id: "teardrop_locket",
    name: "泪滴坠饰",
    rarity: "uncommon",
    characterLock: "watcher",
    description: "每场战斗开始时，进入平静姿态。",
    hooks: {},
  },
  {
    id: "holy_water",
    name: "圣水",
    rarity: "rare",
    characterLock: "watcher",
    description: "每场战斗开始时，将 3 张奇迹加入手牌。",
    hooks: {},
  },
  // —— 通用普通遗物批次（借新增的 onEquip / onLoseHp 钩子）——
  {
    id: "strawberry",
    name: "草莓",
    rarity: "common",
    description: "获得时，最大生命 +7。",
    hooks: {
      onEquip: (state) => {
        state.maxHp += STRAWBERRY_MAX_HP;
        state.hp += STRAWBERRY_MAX_HP;
      },
    },
  },
  {
    id: "potion_belt",
    name: "药水腰带",
    rarity: "common",
    description: "获得时，额外增加 2 个药水槽。",
    hooks: {
      onEquip: (state) => {
        state.potions.push(null, null);
      },
    },
  },
  {
    id: "whetstone",
    name: "磨刀石",
    rarity: "common",
    description: "获得时，随机升级 2 张攻击牌。",
    hooks: {
      onEquip: (state) => upgradeRandomCardsOfType(state, "attack", 2),
    },
  },
  {
    id: "war_paint",
    name: "战争彩绘",
    rarity: "common",
    description: "获得时，随机升级 2 张技能牌。",
    hooks: {
      onEquip: (state) => upgradeRandomCardsOfType(state, "skill", 2),
    },
  },
  {
    id: "akabeko",
    name: "赤红牛铃",
    rarity: "common",
    description: "每场战斗你的第一张攻击牌额外造成 8 点伤害。",
    hooks: {},
  },
  {
    id: "bag_of_preparation",
    name: "行囊",
    rarity: "common",
    description: "每场战斗第一回合额外抽 2 张牌。",
    hooks: {},
  },
  {
    id: "centennial_puzzle",
    name: "百年谜题",
    rarity: "common",
    description: "每场战斗中第一次失去生命时，抽 3 张牌。",
    hooks: {},
  },
  {
    id: "the_boot",
    name: "战靴",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "common",
    description: "当你的一次无格挡攻击伤害为 4 或更低时，改为造成 5 点。",
    hooks: {},
  },
  // —— 通用遗物批次 2（借既有钩子：计数 / 回合始 / 失血 / 战斗始）——
  {
    id: "art_of_war",
    name: "战争艺术",
    rarity: "common",
    description: "若某个回合你没有打出攻击牌，下个回合开始时获得 1 点能量。",
    hooks: {},
  },
  {
    id: "ink_bottle",
    name: "墨水瓶",
    rarity: "uncommon",
    description: "每打出 10 张牌，抽 1 张牌。",
    hooks: {},
  },
  {
    id: "incense_burner",
    name: "熏香炉",
    rarity: "rare",
    description: "每过 6 个回合，获得 1 层虚无缥缈。",
    hooks: {},
  },
  {
    id: "self_forming_clay",
    name: "自塑黏土",
    rarity: "uncommon",
    description: "每当你失去生命，下个回合开始时获得 3 点格挡。",
    hooks: {},
  },
  {
    id: "du_vu_doll",
    name: "杜巫娃娃",
    rarity: "rare",
    description: "牌组中每有一张诅咒牌，战斗开始时获得 1 点力量。",
    hooks: {},
  },
  // —— 减伤 / 失血联动遗物批次 ——
  {
    id: "fossilized_helix",
    name: "化石螺壳",
    rarity: "rare",
    description: "每场战斗开始时，获得 1 层缓冲（抵消下一次会让你失去生命的伤害）。",
    hooks: {},
  },
  {
    id: "runic_cube",
    name: "符文魔方",
    rarity: "boss",
    characterLock: "ironclad",
    description: "每当你失去生命，抽 1 张牌。",
    hooks: {},
  },
  {
    id: "torii",
    name: "鸟居",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "rare",
    description: "当你受到 5 点或更少的无格挡攻击伤害时，改为只受到 1 点。",
    hooks: {},
  },
  {
    id: "tungsten_rod",
    name: "钨钢棒",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "boss",
    description: "每当你失去生命时，少失去 1 点。",
    hooks: {},
  },
  // —— 消耗 / 击杀 / 用药水 触发型遗物批次 ——
  {
    id: "charons_ashes",
    name: "卡戎之烬",
    rarity: "rare",
    characterLock: "ironclad",
    description: "每当你消耗一张牌，对所有敌人造成 3 点伤害。",
    hooks: {},
  },
  {
    id: "dead_branch",
    name: "枯枝",
    rarity: "rare",
    description: "每当你消耗一张牌，将一张随机无色牌加入手牌。",
    hooks: {},
  },
  {
    id: "gremlin_horn",
    name: "哥布林之角",
    rarity: "uncommon",
    description: "每当一个敌人死亡，获得 1 点能量并抽 1 张牌。",
    hooks: {},
  },
  {
    id: "toy_ornithopter",
    name: "玩具扑翼机",
    rarity: "common",
    description: "每当你使用一瓶药水，回复 5 点生命。",
    hooks: {},
  },
  // —— 计数 / 能量 触发型遗物批次 ——
  {
    id: "ice_cream",
    name: "冰淇淋",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "rare",
    description: "能量在回合之间保留，不再于回合开始清零。",
    hooks: {},
  },
  {
    id: "pocketwatch",
    name: "怀表",
    rarity: "rare",
    description: "若某个回合你打出的牌不超过 3 张，下个回合开始时抽 3 张牌。",
    hooks: {},
  },
  {
    id: "mummified_hand",
    name: "木乃伊手",
    rarity: "uncommon",
    description: "每当你打出一张能力牌，手牌中一张随机牌本回合费用变为 0。",
    hooks: {},
  },
  // —— 首领遗物批次（打首领掉落；均带「代价」，此切片以正收益为主，部分代价近似/略）——
  {
    id: "coffee_dripper",
    name: "咖啡滴滤器",
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量（代价：无法在篝火休息回血）。",
    hooks: {},
  },
  {
    id: "fusion_hammer",
    name: "融合锤",
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量（代价：无法在篝火打铁升级）。",
    hooks: {},
  },
  {
    id: "runic_dome",
    name: "符文圆顶",
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量（代价：无法看到敌人意图）。",
    hooks: {},
  },
  {
    id: "sozu",
    name: "斗笠",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量（代价：无法使用药水）。",
    hooks: {},
  },
  {
    id: "philosophers_stone",
    name: "贤者之石",
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量；所有敌人在战斗开始时获得 1 点力量。",
    hooks: {},
  },
  {
    id: "mark_of_pain",
    name: "痛苦烙印",
    rarity: "boss",
    characterLock: "ironclad",
    description: "每回合开始时多获得 1 点能量；每场战斗开始时抽牌堆放入 2 张伤口。",
    hooks: {},
  },
  {
    id: "empty_cage",
    name: "空笼",
    rarity: "boss",
    description: "获得时，从牌组中移除 2 张牌。",
    hooks: { onEquip: (state) => removeRandomCards(state, 2) },
  },
  {
    id: "tiny_house",
    name: "小屋",
    rarity: "boss",
    description: "获得时，最大生命 +6、金币 +50，并升级一张随机牌。",
    hooks: {
      onEquip: (state) => {
        state.maxHp += 6;
        state.hp += 6;
        state.gold += 50;
        upgradeRandomCardsOfType(state, "attack", 1);
      },
    },
  },
  // —— onEquip 一次性遗物批次 ——
  {
    id: "old_coin",
    name: "古钱币",
    rarity: "rare",
    description: "获得时，金币 +300。",
    hooks: {
      onEquip: (state) => {
        state.gold += 300;
      },
    },
  },
  {
    id: "mango",
    name: "芒果",
    rarity: "rare",
    description: "获得时，最大生命 +14。",
    hooks: {
      onEquip: (state) => {
        state.maxHp += 14;
        state.hp += 14;
      },
    },
  },
  {
    id: "lees_waffle",
    name: "李的松饼",
    rarity: "rare",
    description: "获得时，最大生命 +7，并回复全部生命。",
    hooks: {
      onEquip: (state) => {
        state.maxHp += 7;
        state.hp = state.maxHp;
      },
    },
  },
  {
    id: "ginger",
    name: "姜",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "rare",
    description: "你不再受到「虚弱」。",
    hooks: {},
  },
  {
    id: "turnip",
    name: "萝卜",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "rare",
    description: "你不再受到「脆弱」。",
    hooks: {},
  },
  // —— 洗牌触发型遗物 ——
  {
    id: "sundial",
    name: "日晷",
    rarity: "uncommon",
    description: "每洗牌 3 次，获得 2 点能量。",
    hooks: {},
  },
  {
    id: "the_abacus",
    name: "算盘",
    rarity: "uncommon",
    description: "每当你洗牌，获得 6 点格挡。",
    hooks: {},
  },
  {
    id: "red_skull",
    name: "红骷髅",
    rarity: "common",
    characterLock: "ironclad",
    description: "战斗开始时若生命不高于一半，获得 3 点力量。",
    hooks: {},
  },
  {
    id: "toolbox",
    name: "工具箱",
    rarity: "uncommon",
    description: "每场战斗开始时，将一张随机无色牌加入手牌。",
    hooks: {},
  },
  {
    id: "cauldron",
    name: "大锅",
    rarity: "rare",
    description: "获得时，把所有空药水槽填满随机药水。",
    hooks: {
      onEquip: (state) => {
        for (let i = 0; i < state.potions.length; i += 1) {
          if (state.potions[i] === null) {
            state.potions[i] = POTION_DROP_POOL[nextInt(state.rng, POTION_DROP_POOL.length)]!;
          }
        }
      },
    },
  },
  {
    id: "dollys_mirror",
    name: "多莉的镜子",
    rarity: "rare",
    description: "获得时，复制牌组中的一张牌。",
    hooks: {
      onEquip: (state) => {
        if (state.deck.length > 0) {
          const src = state.deck[nextInt(state.rng, state.deck.length)];
          state.deck.push({ uid: state.nextUid++, defId: src.defId, upgraded: src.upgraded });
        }
      },
    },
  },
  {
    id: "calipers",
    name: "卡钳",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "rare",
    description: "回合开始时只失去 15 点格挡，而非全部。",
    hooks: {},
  },
  {
    id: "runic_pyramid",
    name: "符文金字塔",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "boss",
    description: "回合结束时不再弃掉手牌。",
    hooks: {},
  },
  // —— onAddCard 触发型遗物（加牌进牌组时） ——
  {
    id: "ceramic_fish",
    name: "陶瓷鱼",
    rarity: "common",
    description: "每当一张牌被加入你的牌组，获得 9 金币。",
    hooks: {
      onAddCard: (state) => {
        state.gold += 9;
      },
    },
  },
  {
    id: "molten_egg",
    name: "熔岩蛋",
    rarity: "uncommon",
    description: "每当一张攻击牌被加入你的牌组，它会自动升级。",
    hooks: {
      onAddCard: (_state, _self, card) => {
        if (!card.upgraded && getCardDef(card.defId).type === "attack") {
          card.upgraded = true;
        }
      },
    },
  },
  {
    id: "toxic_egg",
    name: "剧毒蛋",
    rarity: "uncommon",
    description: "每当一张技能牌被加入你的牌组，它会自动升级。",
    hooks: {
      onAddCard: (_state, _self, card) => {
        if (!card.upgraded && getCardDef(card.defId).type === "skill") {
          card.upgraded = true;
        }
      },
    },
  },
  {
    id: "frozen_egg",
    name: "冰冻蛋",
    rarity: "uncommon",
    description: "每当一张能力牌被加入你的牌组，它会自动升级。",
    hooks: {
      onAddCard: (_state, _self, card) => {
        if (!card.upgraded && getCardDef(card.defId).type === "power") {
          card.upgraded = true;
        }
      },
    },
  },
  // —— 引擎特判型遗物（不走钩子） ——
  {
    id: "regal_pillow",
    name: "富贵枕头",
    // 篝火休息回血 +15 在 run.ts 的 rest 分支按 hasRelic 处理。
    rarity: "common",
    description: "在篝火休息时，额外回复 15 点生命。",
    hooks: {},
  },
  {
    id: "velvet_choker",
    name: "天鹅绒项圈",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量；但每回合最多只能打出 6 张牌。",
    hooks: {},
  },
  {
    id: "magic_flower",
    name: "魔法花",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "rare",
    characterLock: "ironclad",
    description: "战斗中回复生命时，多回复 50%。",
    hooks: {},
  },
  // —— onAddCard 诅咒联动 ——
  {
    id: "darkstone_periapt",
    name: "暗石护符",
    rarity: "uncommon",
    description: "每当你获得一张诅咒牌，最大生命 +6。",
    hooks: {
      onAddCard: (state, _self, card) => {
        if (getCardDef(card.defId).type === "curse") {
          state.maxHp += 6;
          state.hp += 6;
        }
      },
    },
  },
  {
    id: "omamori",
    name: "御守",
    rarity: "common",
    description: "抵消接下来加入你牌组的 2 张诅咒牌。",
    hooks: {
      onAddCard: (state, self, card) => {
        if (self.counter < 2 && getCardDef(card.defId).type === "curse") {
          const idx = state.deck.findIndex((c) => c.uid === card.uid);
          if (idx >= 0) {
            state.deck.splice(idx, 1);
            self.counter += 1;
          }
        }
      },
    },
  },
  // —— 更多 +1 能量类 boss 遗物（代价近似/略） ——
  {
    id: "ectoplasm",
    name: "灵质",
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量（代价：无法获得金币）。",
    hooks: {},
  },
  {
    id: "cursed_key",
    name: "诅咒之钥",
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量（代价：打开宝箱时会附带一张诅咒）。",
    hooks: {},
  },
  {
    id: "busted_crown",
    name: "破损王冠",
    rarity: "boss",
    description: "每回合开始时多获得 1 点能量（代价：战斗奖励的卡牌选项减少）。",
    hooks: {},
  },
  {
    id: "slavers_collar",
    name: "奴隶主项圈",
    rarity: "boss",
    description: "在精英或首领战中，每回合开始时多获得 1 点能量。",
    hooks: {},
  },
  // —— 伤害修正型遗物（战斗内行为待迁移进 sts-combat.ts） ——
  {
    id: "paper_phrog",
    name: "纸蛙",
    rarity: "uncommon",
    description: "易伤的敌人受到你的攻击伤害提升到 1.75 倍（原为 1.5 倍）。",
    hooks: {},
  },
  {
    id: "paper_krane",
    name: "纸鹤",
    rarity: "uncommon",
    description: "被你削弱（虚弱）的敌人对你造成的伤害降到 0.6 倍（原为 0.75 倍）。",
    hooks: {},
  },
  // —— 转化牌组的 onEquip 遗物 ——
  {
    id: "pandoras_box",
    name: "潘多拉魔盒",
    rarity: "boss",
    description: "获得时，将你所有的打击与防御转化为随机牌。",
    hooks: {
      onEquip: (state) => {
        for (const card of state.deck) {
          if (card.defId === "strike" || card.defId === "defend") {
            transformCardInstance(state, card);
          }
        }
      },
    },
  },
  {
    id: "astrolabe",
    name: "星盘",
    rarity: "boss",
    description: "获得时，转化并升级 3 张随机牌。",
    hooks: {
      onEquip: (state) => {
        const pool = state.deck.slice();
        for (let n = 0; n < 3 && pool.length > 0; n += 1) {
          const idx = nextInt(state.rng, pool.length);
          const card = pool[idx];
          pool.splice(idx, 1);
          transformCardInstance(state, card);
          card.upgraded = true;
        }
      },
    },
  },
  {
    id: "lizard_tail",
    name: "蜥蜴之尾",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "rare",
    description: "当你在战斗中濒死时，回复至一半生命（整局限一次）。",
    hooks: {},
  },
  // —— 更多遗物批次 ——
  {
    id: "pear",
    name: "梨",
    rarity: "common",
    description: "获得时，最大生命 +10。",
    hooks: {
      onEquip: (state) => {
        state.maxHp += 10;
        state.hp += 10;
      },
    },
  },
  {
    id: "odd_mushroom",
    name: "奇异蘑菇",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "uncommon",
    description: "你受到的易伤伤害加成从 50% 降为 25%。",
    hooks: {},
  },
  {
    id: "gremlin_visage",
    name: "地精面容",
    rarity: "common",
    description: "每场战斗开始时，你获得 1 层虚弱。",
    hooks: {},
  },
  {
    id: "cultist_headpiece",
    name: "邪教头饰",
    rarity: "common",
    description: "一件散发着不祥气息的头饰，似乎并没有什么实际用处。",
    hooks: {},
  },
  {
    id: "mutagenic_strength",
    name: "诱变力量",
    rarity: "rare",
    description: "每场战斗开始时获得 3 点力量，但在本回合结束时失去。",
    hooks: {},
  },
  {
    id: "ring_of_the_serpent",
    name: "蛇之指环",
    rarity: "rare",
    characterLock: "silent",
    description: "每个回合开始时，多抽 1 张牌。",
    hooks: {},
  },
  // —— 引擎特判 / 房间钩子 遗物（不走既有钩子） ——
  {
    id: "sacred_bark",
    name: "神圣树皮",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "boss",
    description: "你使用药水的效果翻倍。",
    hooks: {},
  },
  {
    id: "champion_belt",
    name: "冠军腰带",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    rarity: "uncommon",
    characterLock: "ironclad",
    description: "当你对敌人施加易伤时，也对其施加 1 层虚弱。",
    hooks: {},
  },
  {
    id: "maw_bank",
    name: "巨口银行",
    // 进入非商店房间时 +12 金币，在 run.ts 的 resolveNode 按 hasRelic 处理。
    rarity: "common",
    description: "每当你进入一个非商店房间，获得 12 金币。",
    hooks: {},
  },
  {
    id: "meal_ticket",
    name: "餐券",
    // 进入商店时回 15 血，在 run.ts 的 resolveNode 商店分支按 hasRelic 处理。
    rarity: "common",
    description: "每当你进入一间商店，回复 15 点生命。",
    hooks: {},
  },
  {
    id: "eternal_feather",
    name: "永恒羽毛",
    // 篝火休息时按牌组张数回血，在 run.ts 的 rest 分支按 hasRelic 处理。
    rarity: "uncommon",
    description: "每当你在篝火休息，每有 5 张牌就额外回复 3 点生命。",
    hooks: {},
  },
  {
    id: "spirit_poop",
    name: "精魂便便",
    rarity: "common",
    description: "呃……闻起来可不太妙。它似乎没有任何实际效果。",
    hooks: {},
  },
  // === 补全批次 A：战斗时点遗物（onCombatStart / onTurn* / onDiscard 等）===
  {
    id: "black_blood",
    name: "黑血",
    rarity: "boss",
    characterLock: "ironclad",
    description: "燃烧之血的进化：每场战斗结束后，回复 12 点生命。",
    hooks: {
      onCombatEnd: (state) => healPlayer(state, 12),
    },
  },
  {
    id: "brimstone",
    name: "硫磺石",
    rarity: "shop",
    characterLock: "ironclad",
    description: "每个玩家回合开始，获得 2 点力量，且所有敌人获得 1 点力量。",
    hooks: {},
  },
  {
    id: "damaru",
    name: "手鼓",
    rarity: "common",
    characterLock: "watcher",
    description: "每个玩家回合开始，获得 1 点法力。",
    hooks: {},
  },
  {
    id: "clockwork_souvenir",
    name: "发条纪念品",
    rarity: "shop",
    description: "每场战斗开始时，获得 1 层神器（抵消下一个施加到你身上的减益）。",
    hooks: {},
  },
  {
    id: "nuclear_battery",
    name: "核电池",
    rarity: "boss",
    characterLock: "defect",
    description: "每场战斗开始时，充能 1 颗等离子球。",
    hooks: {},
  },
  {
    id: "symbiotic_virus",
    name: "共生病毒",
    rarity: "uncommon",
    characterLock: "defect",
    description: "每场战斗开始时，充能 1 颗暗球。",
    hooks: {},
  },
  {
    id: "cloak_clasp",
    name: "斗篷别扣",
    rarity: "rare",
    characterLock: "watcher",
    description: "每个玩家回合结束时，每有 1 张手牌就获得 1 点格挡。",
    hooks: {},
  },
  {
    id: "melange",
    name: "香料混合",
    rarity: "shop",
    characterLock: "watcher",
    description: "每当你洗牌时，预知 3 张。",
    hooks: {},
  },
  {
    id: "golden_eye",
    name: "金色之眼",
    rarity: "rare",
    characterLock: "watcher",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每当你预知时，额外预知 2 张。",
    hooks: {},
  },
  {
    id: "sling_of_courage",
    name: "勇气投索",
    rarity: "shop",
    description: "每场精英战斗开始时，获得 2 点力量。",
    hooks: {},
  },
  {
    id: "preserved_insect",
    name: "密封昆虫",
    rarity: "common",
    description: "精英战斗中，敌人以最大生命 75% 的生命开始战斗。",
    hooks: {},
  },
  {
    id: "frozen_core",
    name: "冰冻核心",
    rarity: "boss",
    characterLock: "defect",
    description: "每个玩家回合结束时，若有空的充能球槽，则充能 1 颗冰霜球。",
    hooks: {},
  },
  {
    id: "inserter",
    name: "插入器",
    rarity: "rare",
    characterLock: "defect",
    description: "每 2 个回合，获得 1 个充能球槽。",
    hooks: {},
  },
  {
    id: "runic_capacitor",
    name: "符文电容",
    rarity: "shop",
    characterLock: "defect",
    description: "每场战斗开始时，额外获得 3 个充能球槽。",
    hooks: {},
  },
  {
    id: "violet_lotus",
    name: "紫莲",
    rarity: "boss",
    characterLock: "watcher",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每当你离开平静姿态，额外获得 1 点能量。",
    hooks: {},
  },
  {
    id: "tough_bandages",
    name: "坚韧绷带",
    rarity: "uncommon",
    characterLock: "silent",
    description: "每当你弃掉一张牌，获得 3 点格挡。",
    hooks: {},
  },
  {
    id: "tingsha",
    name: "叮沙",
    rarity: "rare",
    characterLock: "silent",
    description: "每当你弃掉一张牌，对一名随机敌人造成 3 点伤害。",
    hooks: {},
  },
  {
    id: "hovering_kite",
    name: "悬浮风筝",
    rarity: "boss",
    characterLock: "silent",
    description: "每个玩家回合，你第一次弃牌时获得 1 点能量。",
    hooks: {
      // counter 作「本回合是否已弃过牌」标记：回合开始归零，首弃回能量后置 1。
    },
  },
  {
    id: "unceasing_top",
    name: "不停转陀螺",
    rarity: "rare",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "在你的回合，每当手牌被清空，抽 1 张牌。",
    hooks: {},
  },
  // === 补全批次 B：奖励 / 篝火 / 宝箱时点遗物（多数逻辑在 run.ts 里按 hasRelic 处理）===
  {
    id: "question_card",
    name: "问号卡",
    rarity: "uncommon",
    description: "每次卡牌奖励多显示 1 张可选卡。",
    hooks: {},
  },
  {
    id: "prayer_wheel",
    name: "祈祷之轮",
    rarity: "rare",
    description: "普通战斗的卡牌奖励额外多显示 1 张可选卡。",
    hooks: {},
  },
  {
    id: "singing_bowl",
    name: "唱钵",
    rarity: "uncommon",
    description: "获得卡牌奖励时，可改为放弃卡牌、获得 2 点最大生命。",
    hooks: {},
  },
  {
    id: "white_beast_statue",
    name: "白兽雕像",
    rarity: "uncommon",
    description: "每次战斗后必定掉落一瓶药水。",
    hooks: {},
  },
  {
    id: "black_star",
    name: "黑洞之星",
    rarity: "boss",
    description: "精英敌人掉落 2 个遗物。",
    hooks: {},
  },
  {
    id: "girya",
    name: "壮力手环",
    rarity: "rare",
    // counter 记本局举重次数（篝火「举重」每次 +1，至多 3）；每场战斗开始施加等量力量。
    description: "可在篝火举重，永久获得 1 点力量（至多 3 次）。每场战斗开始时获得已积累的力量。",
    hooks: {},
  },
  {
    id: "shovel",
    name: "铁铲",
    rarity: "rare",
    description: "可在篝火挖掘，挖出一个遗物。",
    hooks: {},
  },
  {
    id: "dream_catcher",
    name: "织梦者",
    rarity: "common",
    description: "每当你在篝火休息时，可以额外获得一次卡牌奖励。",
    hooks: {},
  },
  {
    id: "ancient_tea_set",
    name: "古董茶具",
    rarity: "common",
    // counter=1 表示「刚在篝火休息过」；下场战斗第一回合 +2 能量后清零（待迁移进 sts-combat）。
    description: "每当你在篝火休息后，下一场战斗的第一回合额外获得 2 点能量。",
    hooks: {},
  },
  {
    id: "matryoshka",
    name: "俄罗斯套娃",
    rarity: "uncommon",
    // counter 记剩余生效次数；获得时为 2，接下来 2 个宝箱各额外给 1 个遗物。
    description: "接下来打开的 2 个宝箱各额外包含 1 个遗物。",
    hooks: {
      onEquip: (_state, self) => {
        self.counter = 2;
      },
    },
  },
  // === 补全批次 C：商店 / 状态牌可打 / X 费 / 破甲发伤 ===
  {
    id: "membership_card",
    name: "会员卡",
    rarity: "shop",
    // 效果在 shop.ts 的 generateShop 里按 hasRelic 处理（全场商品与去牌 5 折）。
    description: "商店中所有商品和去牌服务的价格降低 50%。",
    hooks: {},
  },
  {
    id: "smiling_mask",
    name: "微笑面具",
    rarity: "common",
    // 效果在 shop.ts 的 generateShop 里按 hasRelic 处理（去牌固定 50 金）。
    description: "商店的去牌服务价格永远为 50 金。",
    hooks: {},
  },
  {
    id: "medical_kit",
    name: "医疗包",
    rarity: "shop",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "你可以打出状态牌。打出状态牌时费用为 0，并将其消耗。",
    hooks: {},
  },
  {
    id: "blue_candle",
    name: "蓝烛",
    rarity: "uncommon",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "你可以打出诅咒牌。打出诅咒牌会失去 1 点生命，并将其消耗。",
    hooks: {},
  },
  {
    id: "chemical_x",
    name: "化学 X",
    rarity: "shop",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每当你打出一张 X 费牌，其 X 视为额外 +2。",
    hooks: {},
  },
  {
    id: "snecko_eye",
    name: "蛇之眼",
    rarity: "boss",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每回合多抽 2 张牌。战斗中，抽到的牌费用随机变为 0~3（X 费牌与废牌除外）。",
    hooks: {},
  },
  {
    id: "hand_drill",
    name: "手钻",
    rarity: "shop",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每当你用攻击打破一名敌人的格挡，令其获得 2 层易伤。",
    hooks: {},
  },
  {
    id: "strike_dummy",
    name: "打桩人偶",
    rarity: "uncommon",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "打出名字中带有「打击」的牌时，额外造成 3 点伤害。",
    hooks: {},
  },
  {
    id: "wrist_blade",
    name: "腕刃",
    rarity: "rare",
    characterLock: "silent",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "你打出的 0 费攻击牌，额外造成 4 点伤害。",
    hooks: {},
  },
  {
    id: "snecko_skull",
    name: "蛇之头骨",
    rarity: "common",
    characterLock: "silent",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每当你对敌人施加中毒，额外施加 1 层。",
    hooks: {},
  },
  // === 补全批次 D：瓶装固有 / 死亡传毒 / 无色奖励 / 攻击计数 / 局外一次性 ===
  {
    id: "bottled_flame",
    name: "火焰之瓶",
    rarity: "uncommon",
    description: "获得时，将牌组中一张攻击牌封入瓶中；它此后每场战斗开局必在起手牌。",
    hooks: {
      onEquip: (state) => bottleRandomCardOfType(state, "attack"),
    },
  },
  {
    id: "bottled_lightning",
    name: "闪电之瓶",
    rarity: "uncommon",
    description: "获得时，将牌组中一张技能牌封入瓶中；它此后每场战斗开局必在起手牌。",
    hooks: {
      onEquip: (state) => bottleRandomCardOfType(state, "skill"),
    },
  },
  {
    id: "bottled_tornado",
    name: "旋风之瓶",
    rarity: "uncommon",
    description: "获得时，将牌组中一张能力牌封入瓶中；它此后每场战斗开局必在起手牌。",
    hooks: {
      onEquip: (state) => bottleRandomCardOfType(state, "power"),
    },
  },
  {
    id: "the_specimen",
    name: "样本瓶",
    rarity: "rare",
    characterLock: "silent",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每当一名敌人死亡，将它身上的中毒转移给一名随机敌人。",
    hooks: {},
  },
  {
    id: "prismatic_shard",
    name: "棱镜碎片",
    rarity: "shop",
    // 效果在 run.ts 的 rollRewardCard 里按 hasRelic 处理（奖励池并入无色牌）。
    description: "战斗的卡牌奖励中会出现所有职业的无色牌。",
    hooks: {},
  },
  {
    id: "pen_nib",
    name: "钢笔尖",
    rarity: "common",
    characterLock: "ironclad",
    // counter 记本局已打出的攻击牌数；每第 10 张造成双倍伤害（待迁移进 sts-combat）。
    description: "每打出 10 张攻击牌，下一张攻击牌造成双倍伤害。",
    hooks: {},
  },
  {
    id: "frozen_eye",
    name: "冰冻之眼",
    rarity: "shop",
    // 纯观察类（可查看抽牌堆顺序）；对计算引擎无机制影响，仅作收藏。
    description: "战斗中你可以随时查看抽牌堆的顺序。",
    hooks: {},
  },
  {
    id: "calling_bell",
    name: "唤魔铃",
    rarity: "boss",
    description: "获得时，得到 3 个遗物，但牌组中会混入一张诅咒牌。",
    hooks: {
      onEquip: (state) => {
        // 获得 3 个未持有的遗物（掉落池：普通/罕见/稀有）。
        const pool = shopRelicPool(state.character).filter((id) => !hasRelic(state, id));
        for (let n = 0; n < 3 && pool.length > 0; n += 1) {
          const idx = nextInt(state.rng, pool.length);
          grantRelic(state, pool[idx]);
          pool.splice(idx, 1);
        }
        // 混入一张诅咒（唤魔铃的代价）。
        state.deck.push({ uid: state.nextUid++, defId: "clumsy", upgraded: false });
      },
    },
  },
  // === 补全批次 E：姿态/球/弃牌/消耗联动 + 选牌篝火 ===
  {
    id: "duality",
    name: "对偶手镯",
    rarity: "uncommon",
    characterLock: "watcher",
    description: "每当你打出一张攻击牌，本回合获得 1 点敏捷（回合结束时失去）。",
    hooks: {},
  },
  {
    id: "orange_pellets",
    name: "橙色药丸",
    rarity: "shop",
    // counter 作本回合已打出牌型的位掩码（攻/技/能）；集齐则清除全部减益。
    description: "在同一回合内打出攻击、技能和能力牌各一张后，移除你身上所有减益。",
    hooks: {},
  },
  {
    id: "emotion_chip",
    name: "情绪芯片",
    rarity: "rare",
    characterLock: "defect",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "若上一回合你失去了生命，则本回合开始时触发所有充能球的被动效果。",
    hooks: {},
  },
  {
    id: "gold_plated_cables",
    name: "镀金电缆",
    rarity: "uncommon",
    characterLock: "defect",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "每个玩家回合结束时，最右侧的充能球额外触发一次被动效果。",
    hooks: {},
  },
  {
    id: "strange_spoon",
    name: "奇怪的勺子",
    rarity: "shop",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    description: "本应被消耗的牌有 50% 的概率改为进入弃牌堆。",
    hooks: {},
  },
  {
    id: "orrery",
    name: "浑天仪",
    rarity: "shop",
    description: "获得时，将 5 张随机牌加入你的牌组。",
    hooks: {
      onEquip: (state) => {
        const pool = rewardCardPoolOf(CHARACTER_COLOR[state.character]);
        for (let n = 0; n < 5; n += 1) {
          state.deck.push({
            uid: state.nextUid++,
            defId: pool[nextInt(state.rng, pool.length)],
            upgraded: false,
          });
        }
      },
    },
  },
  {
    id: "the_courier",
    name: "信使",
    rarity: "shop",
    // 效果在 shop.ts 的 generateShop 里按 hasRelic 处理（商店额外多进 1 张牌 + 1 瓶药水）。
    description: "商店会多进货：额外多 1 张牌与 1 瓶药水可供选购。",
    hooks: {},
  },
  {
    id: "peace_pipe",
    name: "和平烟斗",
    rarity: "rare",
    // 效果在 run.ts 的篝火菜单里：可在篝火抽去一张牌（openCardRemoval）。
    description: "你可以在篝火抽去牌组中的一张牌。",
    hooks: {},
  },
  // === 补全批次 F：? 房间 / 地图路径 ===
  {
    id: "tiny_chest",
    name: "迷你宝箱",
    rarity: "common",
    // counter 记已进入的 ? 房间数；每第 4 个变为宝箱房（run.ts 的 resolveNode 处理）。
    description: "每进入 4 个未知（?）房间，其中第 4 个必定变为宝箱房。",
    hooks: {},
  },
  {
    id: "juzu_bracelet",
    name: "念珠手链",
    rarity: "common",
    // 本引擎的 ? 房间恒为事件（从不是怪物遭遇），故本遗物的「? 不出怪」天然满足。
    description: "未知（?）房间不再出现怪物遭遇。",
    hooks: {},
  },
  {
    id: "wing_boots",
    name: "仙女靴",
    rarity: "rare",
    // counter 记已用次数（至多 3）；有余量时可无视路径直达下一层任意节点（run.ts 处理）。
    description: "可以 3 次无视路径限制，在地图上前往下一层的任意节点。",
    hooks: {},
  },
  {
    id: "gambling_chip",
    name: "赌博芯片",
    rarity: "rare",
    // 战斗内行为待迁移进 sts-combat.ts 的遗物登记表。
    // 由外部选择要弃的手牌），纯计算引擎无战斗内多选原语，故按赌徒酿药水的同款近似：弃整手、补抽等量。
    description: "每场战斗开始、抽出起手牌后，弃掉整手牌并补抽等量的新牌。",
    hooks: {},
  },
  {
    id: "circlet",
    // ⚠ 稀有度由 `common` 改成 `special`（第四十四批）：参考的 `relicTiers[]` 给
    // `CIRCLET` / `RED_CIRCLET` 的是 `RelicTier::SPECIAL`，而真实游戏里它们**只**在
    // 「奖励池已经掏空」时兜底发放。写成 `common` 会让两枚头环真的混进宝箱 / 精英掉落池。
    name: "头环",
    rarity: "special",
    description: "当再也没有别的遗物可拿时，你得到了它。纯属收藏。",
    hooks: {},
  },
  {
    id: "red_circlet",
    name: "赤红头环",
    rarity: "special",
    description: "当再也没有别的遗物可拿、连头环都齐了时，你得到了它。",
    hooks: {},
  },

  // ===========================================================================
  // 第四十四批：与参考 `RelicId` 做全表比对之后补齐的 12 条
  // ===========================================================================
  //
  // 起因是 `bloody_idol`：它在 `sts-combat.ts` 里登记了战斗行为、对拍有 136 例背书，
  // **却根本不在这张表里** —— 于是「预言机侧可达、产品侧不可达」，真实引擎里玩家永远拿不到。
  // 顺着查下去，参考的 `RelicId` 有 181 项，这张表只有 168 条，差 13 条
  // （12 条真遗物 + 一个 `INVALID` 哨兵）。这一批把 12 条补齐，并加了一条永久的数据表用例
  // （`test/data-tables.test.ts` 的「战斗内已登记的遗物必须在数据表里」）把这个形状堵死。
  //
  // ⚠ 12 条**全部**是参考的 `RelicTier::SPECIAL`，所以一条都不会渗进奖励 / 商店 / 首领池
  //   （那三个池按具体档位列举）。补条目填的名称 / 描述是**产品数据**，不是预言机数据；
  //   战斗内行为该不该登记另说，见 `sts-combat.ts` 的三张时点表。
  {
    id: "bloody_idol",
    name: "血腥雕像",
    rarity: "special",
    // 战斗内行为已登记（`Player::gainGold` 末尾，见 sts-combat.ts）。
    description: "每当你获得金币时，回复 5 点生命。",
    hooks: {},
  },
  {
    id: "golden_idol",
    name: "金偶像",
    rarity: "special",
    description: "战斗获得的金币增加 25%。",
    hooks: {},
  },
  {
    id: "mark_of_the_bloom",
    name: "绽放印记",
    rarity: "special",
    // 战斗内行为已登记（`Player::heal` 与 `Player::wouldDie` 各一处，见 sts-combat.ts）。
    description: "你再也无法回复生命。",
    hooks: {},
  },
  {
    id: "face_of_cleric",
    name: "教士之面",
    rarity: "special",
    description: "生命上限增加 1 点（每场战斗后）。",
    hooks: {},
  },
  {
    id: "ssserpent_head",
    name: "蛇头",
    rarity: "special",
    description: "每当你进入一个 ? 房间，获得 50 金币。",
    hooks: {},
  },
  {
    id: "nloths_gift",
    name: "尼洛斯的礼物",
    rarity: "special",
    description: "接下来 3 次战斗的卡牌奖励中，必定出现 1 张稀有牌。",
    hooks: {},
  },
  {
    id: "nloths_hungry_face",
    name: "尼洛斯的饥饿之颜",
    rarity: "special",
    description: "下一个你打开的宝箱是空的。",
    hooks: {},
  },
  {
    id: "neows_lament",
    name: "尼奥的挽歌",
    rarity: "special",
    // 战斗内行为已登记（`initRelics` 里把全场怪的生命压成 1，counter 记剩余次数）。
    description: "接下来 3 场战斗中，敌人的初始生命降为 1。",
    hooks: {},
  },
  {
    id: "necronomicon",
    name: "死灵之书",
    rarity: "special",
    // 战斗内行为已登记（`onUseAttackCard`，见 sts-combat.ts）。
    description: "每回合第一张费用 2 或更高的攻击牌会被打出两次。",
    hooks: {},
  },
  {
    id: "enchiridion",
    name: "秘典",
    rarity: "special",
    // 战斗内行为**不登记**：`initRelics` 里造的是「从整个能力牌池随机取一张」，
    // 随机牌可能是尚未登记的牌 ⇒ trace 不可重放（与手册 / 枯枝 / 尼尔的法典同族）。
    description: "每场战斗开始时，将 1 张随机能力牌加入手牌，其本场费用为 0。",
    hooks: {},
  },
  {
    id: "nilrys_codex",
    name: "尼尔的法典",
    rarity: "special",
    description: "每回合结束时，从 3 张随机牌中选 1 张洗入抽牌堆。",
    hooks: {},
  },
  {
    id: "warped_tongs",
    name: "扭曲钳",
    rarity: "special",
    // 战斗内行为已登记（`initRelics` 的 atTurnStartPostDraw + `applyStartOfTurnPostDrawRelics`）。
    description: "每回合开始时，随机升级 1 张手牌（仅限本场战斗）。",
    hooks: {},
  },
];

/** 首领遗物池（rarity=boss；含该角色专属 boss 遗物）。打首领时随机掉一件未持有的。 */
export function bossRelicPool(character: CharacterId): readonly string[] {
  return [...relicIdsOfRarity("boss"), ...relicIdsForCharacter(character, "boss")];
}

/** 获得一件遗物：入列 + 结算 onEquip（草莓 +最大生命等一次性效果）。日志由调用方按情景补。 */
export function grantRelic(state: GameState, id: string): void {
  const self: RelicState = { id, counter: 0 };
  state.relics.push(self);
  getRelicDef(id).hooks.onEquip?.(state, self);
}

const RELIC_MAP: ReadonlyMap<string, RelicDef> = new Map(
  RELIC_LIST.map((relic) => [relic.id, relic]),
);

export const ALL_RELICS: readonly RelicDef[] = RELIC_LIST;

export function getRelicDef(id: string): RelicDef {
  const def = RELIC_MAP.get(id);
  if (!def) {
    throw new Error(`未知遗物 id: ${id}`);
  }
  return def;
}

export function hasRelic(state: GameState, id: string): boolean {
  return state.relics.some((relic) => relic.id === id);
}

/** 铁甲战士起始遗物。 */
export const IRONCLAD_STARTER_RELIC = "burning_blood";

// 通用遗物（无 characterLock）按稀有度取 id；角色专属遗物由 relicIdsForCharacter 单独并入。
function relicIdsOfRarity(...rarities: RelicRarity[]): readonly string[] {
  const set = new Set(rarities);
  return RELIC_LIST.filter(
    (relic) => set.has(relic.rarity) && relic.characterLock === undefined,
  ).map((relic) => relic.id);
}

/** 某角色专属、且在给定稀有度里的遗物 id。 */
function relicIdsForCharacter(
  character: CharacterId,
  ...rarities: RelicRarity[]
): readonly string[] {
  const set = new Set(rarities);
  return RELIC_LIST.filter(
    (relic) => set.has(relic.rarity) && relic.characterLock === character,
  ).map((relic) => relic.id);
}

/** 通用宝箱 / 精英 / 事件掉落的遗物池（common + uncommon，不含角色专属）。 */
export const REWARD_RELIC_POOL: readonly string[] = relicIdsOfRarity("common", "uncommon");

/** 通用商店遗物池（含稀有 + 商店专属，不含角色专属）。 */
export const SHOP_RELIC_POOL: readonly string[] = relicIdsOfRarity(
  "common",
  "uncommon",
  "rare",
  "shop",
);

/** 某角色实际可得的掉落遗物池 = 通用 + 该角色专属（common + uncommon）。 */
export function rewardRelicPool(character: CharacterId): readonly string[] {
  return [...REWARD_RELIC_POOL, ...relicIdsForCharacter(character, "common", "uncommon")];
}

/** 某角色实际可得的商店遗物池 = 通用 + 该角色专属（含稀有 + 商店专属）。 */
export function shopRelicPool(character: CharacterId): readonly string[] {
  return [
    ...SHOP_RELIC_POOL,
    ...relicIdsForCharacter(character, "common", "uncommon", "rare", "shop"),
  ];
}
