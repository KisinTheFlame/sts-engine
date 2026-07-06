import type { GameState, MapNode, MapNodeType } from "../types.js";
import { cardPoolOf, getCardDef, costOf } from "../cards/cards.js";
import { getCharacterConfig } from "../characters/characters.js";
import { pickBossEncounter, pickEliteEncounter, pickNormalEncounter } from "../enemies/enemies.js";
import { rewardRelicPool, getRelicDef, hasRelic, grantRelic } from "../relics/relics.js";
import {
  BASE_POTION_DROP_CHANCE,
  POTION_DROP_POOL,
  getPotionDef,
  potionPoolOfRarity,
} from "../potions/potions.js";
import { EVENT_POOL, getEventDef } from "../events/events.js";
import type { EventOutcome } from "../events/events.js";
import { generateShop } from "../shop/shop.js";
import { nextInt, nextRange } from "../rng.js";
import { startCombat } from "../combat/combat.js";
import { generateMap, availableNext } from "../map/map.js";

// === 爬塔 / 分支地图 / 奖励 / 休息 / 宝箱 ===
//
// 分支地图（StS 节点图）：在 "map" 屏 choose 一个上层节点 → 进入该节点（战斗/精英/未知/篝火/宝箱/Boss）
// → 结算后回到 "map" 屏继续选路，直到 Boss。节点类型内容随里程碑启用（商店待后续）。

const REST_HEAL_RATIO = 0.3;
const REWARD_CARD_COUNT = 3;
const TREASURE_GOLD_MIN = 25;
const TREASURE_GOLD_MAX = 35;
// 战斗胜利金币区间（对齐 StS asc0）。
const NORMAL_GOLD_MIN = 10;
const NORMAL_GOLD_MAX = 20;
const ELITE_GOLD_MIN = 25;
const ELITE_GOLD_MAX = 35;

/** 启用的地图节点类型（全类型齐备）。 */
const ENABLED_MAP_TYPES: readonly MapNodeType[] = [
  "combat",
  "elite",
  "event",
  "shop",
  "rest",
  "treasure",
];

const RARITY_LABELS: Record<string, string> = {
  common: "普通",
  uncommon: "罕见",
  rare: "稀有",
  starter: "起始",
  special: "特殊",
};

const NODE_TYPE_LABELS: Record<MapNodeType, string> = {
  combat: "战斗",
  elite: "精英",
  event: "未知",
  rest: "篝火",
  shop: "商店",
  treasure: "宝箱",
  boss: "首领",
};

/** 有内容的幕数：打完第 TOTAL_ACTS 幕 Boss 即通关；之前的 Boss 则进入下一幕。 */
export const TOTAL_ACTS = 3;

export function buildMap(state: GameState): void {
  state.map = generateMap(state.rng, ENABLED_MAP_TYPES);
  state.currentNodeId = null;
  state.screen = "map";
}

/** 进入下一幕：幕号 +1、重置本幕战斗计数、生成新地图，携带血/牌/遗物/金币/药水。 */
export function advanceToNextAct(state: GameState): void {
  state.act += 1;
  state.combatsEntered = 0;
  buildMap(state);
  state.log.push(`你踏入第 ${state.act} 幕。`);
}

/** 进入一个地图节点：按类型路由。战斗/Boss 起战斗；篝火切 rest 屏；宝箱即时给金币后回地图。 */
function resolveNode(state: GameState, node: MapNode): void {
  state.currentNodeId = node.id;
  // 巨口银行：进入非商店房间时 +12 金币。
  if (node.type !== "shop" && hasRelic(state, "maw_bank")) {
    state.gold += 12;
  }
  switch (node.type) {
    case "combat": {
      // 前若干场抽 weak 池、其余抽 strong 池（复刻 StS Act1 战斗节奏）。
      const encounterId = pickNormalEncounter(state.rng, state.combatsEntered, state.act);
      state.combatsEntered += 1;
      startCombat(state, encounterId);
      return;
    }
    case "elite": {
      // 精英战：独立精英池；胜利后必发 1 个遗物。isElite=true 供勇气投索 / 密封昆虫判定。
      startCombat(state, pickEliteEncounter(state.rng, state.act), true);
      state.pendingRelicReward = true;
      return;
    }
    case "boss": {
      startCombat(state, pickBossEncounter(state.rng, state.act));
      return;
    }
    case "event": {
      // 迷你宝箱：每进入第 4 个 ? 房间，该房间变为宝箱房。
      const tinyChest = state.relics.find((relic) => relic.id === "tiny_chest");
      if (tinyChest) {
        tinyChest.counter += 1;
        if (tinyChest.counter >= 4) {
          tinyChest.counter = 0;
          openTreasureChest(state);
          backToMap(state);
          state.log.push("这处未知房间里，竟藏着一个宝箱。");
          return;
        }
      }
      const eventId = EVENT_POOL[nextInt(state.rng, EVENT_POOL.length)];
      state.event = { id: eventId };
      state.screen = "event";
      state.log.push("你踏进一处未知的房间。");
      return;
    }
    case "rest": {
      state.screen = "rest";
      state.log.push("你来到一处篝火。");
      return;
    }
    case "shop": {
      // 餐券：进入商店时回复 15 点生命。
      if (hasRelic(state, "meal_ticket")) {
        state.hp = Math.min(state.maxHp, state.hp + 15);
      }
      generateShop(state);
      state.log.push("你走进一间商店。");
      return;
    }
    case "treasure": {
      openTreasureChest(state);
      backToMap(state);
      return;
    }
    default: {
      // 所有节点类型已启用；保守回地图兜底。
      backToMap(state);
    }
  }
}

/** 打开一个宝箱：给宝箱遗物；俄罗斯套娃前 2 次各额外掉 1 个遗物。 */
export function openTreasureChest(state: GameState): void {
  grantTreasure(state);
  const matryoshka = state.relics.find((relic) => relic.id === "matryoshka");
  if (matryoshka && matryoshka.counter > 0) {
    grantRandomRelic(state);
    matryoshka.counter -= 1;
  }
}

/** 宝箱：优先给一个未持有的遗物，遗物都齐了则给金币兜底（复刻 StS 宝箱给遗物）。 */
function grantTreasure(state: GameState): void {
  const available = rewardRelicPool(state.character).filter((id) => !hasRelic(state, id));
  if (available.length > 0) {
    const id = available[nextInt(state.rng, available.length)];
    grantRelic(state, id);
    state.log.push(`你打开宝箱，获得遗物「${getRelicDef(id).name}」。`);
    return;
  }
  const gold = nextRange(state.rng, TREASURE_GOLD_MIN, TREASURE_GOLD_MAX);
  state.gold += gold;
  state.log.push(`你打开宝箱，获得 ${gold} 金币。`);
}

/** 给一个未持有的普通遗物（精英 / 战斗掉落用）；都齐了给金币兜底。返回是否给了遗物。 */
export function grantRandomRelic(state: GameState): void {
  grantTreasure(state);
}

/** 结算完一个节点后回到地图选路屏。 */
function backToMap(state: GameState): void {
  state.screen = "map";
}

const WING_BOOTS_CHARGES = 3;

/**
 * 地图上可选择进入的下一个节点：正常受路径约束（availableNext）；
 * 但持有仍有余量的仙女靴（wing_boots）时，可无视路径直达下一层的任意节点。
 */
function mapNextChoices(state: GameState): string[] {
  const normal = availableNext(state.map, state.currentNodeId);
  const wingBoots = state.relics.find((relic) => relic.id === "wing_boots");
  if (!wingBoots || wingBoots.counter >= WING_BOOTS_CHARGES || state.currentNodeId === null) {
    return normal;
  }
  const current = state.map.nodes[state.currentNodeId];
  const rowNodes = Object.values(state.map.nodes)
    .filter((node) => node.row === current.row + 1)
    .map((node) => node.id);
  // 下一层就是 Boss（同层无其它节点）时退回普通可达。
  return rowNodes.length > 0 ? rowNodes : normal;
}

/** 把一张牌加入大牌组，并触发遗物 onAddCard（陶瓷鱼给金币、各色蛋升级加入的牌）。 */
function addCardToDeck(state: GameState, defId: string, upgraded: boolean): void {
  const card = { uid: state.nextUid++, defId, upgraded };
  state.deck.push(card);
  for (const relic of state.relics) {
    getRelicDef(relic.id).hooks.onAddCard?.(state, relic, card);
  }
}

/** 战斗后按概率掉药水（基础 40%，未掉逐场 +10、掉了 -10；槽满则不掉不调整）。 */
function rollPotionDrop(state: GameState): void {
  const emptySlot = state.potions.indexOf(null);
  if (emptySlot < 0) {
    return; // 槽满，不掉。
  }
  // 白兽雕像：药水必掉（概率视为 100）。
  const chance = hasRelic(state, "white_beast_statue")
    ? 100
    : Math.max(0, Math.min(100, BASE_POTION_DROP_CHANCE + state.potionDropBonus));
  if (nextInt(state.rng, 100) < chance) {
    // 掷稀有度（稀有 5% / 罕见 30% / 普通 65%），再从该档抽一瓶。
    const roll = nextInt(state.rng, 100);
    const rarity = roll < 5 ? "rare" : roll < 35 ? "uncommon" : "common";
    const pool = potionPoolOfRarity(rarity, state.character);
    const id = pool[nextInt(state.rng, pool.length)];
    state.potions[emptySlot] = id;
    state.potionDropBonus -= 10;
    state.log.push(`你获得了药水「${getPotionDef(id).name}」。`);
  } else {
    state.potionDropBonus += 10;
  }
}

/** 非 Boss 战斗胜利后生成奖励：精英战先发一个遗物，掷药水掉落，再给三选一卡奖励。 */
export function generateReward(state: GameState): void {
  const isElite = state.pendingRelicReward;
  if (state.pendingRelicReward) {
    grantRandomRelic(state);
    // 黑洞之星：精英额外掉 1 个遗物。
    if (hasRelic(state, "black_star")) {
      grantRandomRelic(state);
    }
    state.pendingRelicReward = false;
  }
  // 战斗胜利掉金币（普通 10-20 / 精英 25-35，对齐 StS）。
  const gold = isElite
    ? nextRange(state.rng, ELITE_GOLD_MIN, ELITE_GOLD_MAX)
    : nextRange(state.rng, NORMAL_GOLD_MIN, NORMAL_GOLD_MAX);
  state.gold += gold;
  state.log.push(`战斗胜利，获得 ${gold} 金币。`);
  rollPotionDrop(state);
  const choices: { defId: string; upgraded: boolean }[] = [];
  const picked = new Set<string>();
  // 问号卡：+1 卡奖励选项；祈祷之轮：普通战斗额外 +1 卡奖励选项。
  const cardCount =
    REWARD_CARD_COUNT +
    (hasRelic(state, "question_card") ? 1 : 0) +
    (!isElite && hasRelic(state, "prayer_wheel") ? 1 : 0);
  for (let i = 0; i < cardCount; i += 1) {
    const defId = rollRewardCard(state, picked);
    if (defId === null) {
      break;
    }
    picked.add(defId);
    choices.push({ defId, upgraded: false });
  }
  state.reward = { cardChoices: choices };
  state.screen = "reward";
}

/** 织梦者：休息附带的纯卡奖励（无金币/药水），复用奖励屏。选完由 reward 分支回地图。 */
function generateRestCardReward(state: GameState): void {
  const choices: { defId: string; upgraded: boolean }[] = [];
  const picked = new Set<string>();
  const cardCount = REWARD_CARD_COUNT + (hasRelic(state, "question_card") ? 1 : 0);
  for (let i = 0; i < cardCount; i += 1) {
    const defId = rollRewardCard(state, picked);
    if (defId === null) {
      break;
    }
    picked.add(defId);
    choices.push({ defId, upgraded: false });
  }
  state.reward = { cardChoices: choices };
  state.screen = "reward";
  state.log.push("篝火的余烬中，你窥见了一张新的牌。");
}

/** 复制器：打开选牌屏，复制牌组中的一张牌。 */
function openDuplicator(state: GameState): void {
  state.cardSelect = {
    mode: "duplicate",
    title: "选择一张牌进行复制",
    choices: state.deck.map((c) => ({ defId: c.defId, upgraded: c.upgraded, uid: c.uid })),
    canSkip: false,
  };
  state.screen = "card_select";
}

/** 和平烟斗：打开选牌屏，从牌组抽去一张牌。 */
function openCardRemoval(state: GameState): void {
  state.cardSelect = {
    mode: "remove",
    title: "选择一张牌抽去",
    choices: state.deck.map((c) => ({ defId: c.defId, upgraded: c.upgraded, uid: c.uid })),
    canSkip: false,
  };
  state.screen = "card_select";
}

/** 掷一张奖励卡：先掷稀有度（稀有 4% / 罕见 36% / 普通 60%），再从本角色该档池里挑未重复的。 */
function rollRewardCard(state: GameState, exclude: ReadonlySet<string>): string | null {
  const color = getCharacterConfig(state.character).color;
  const roll = nextInt(state.rng, 100);
  const rarity = roll < 4 ? "rare" : roll < 40 ? "uncommon" : "common";
  // 棱镜碎片：奖励卡池并入无色牌（该档）。
  const prismatic = hasRelic(state, "prismatic_shard");
  // 依次尝试目标档 → 降级兜底，保证总能给出一张不重复的卡。
  for (const tier of [rarity, "uncommon", "common"] as const) {
    const pool = prismatic
      ? [...cardPoolOf(color, tier), ...cardPoolOf("colorless", tier)]
      : cardPoolOf(color, tier);
    const candidates = pool.filter((id) => !exclude.has(id));
    if (candidates.length > 0) {
      return candidates[nextInt(state.rng, candidates.length)];
    }
  }
  return null;
}

/** 当前屏幕可选项（渲染 + 校验 choose 用）。 */
export function currentOptions(state: GameState): string[] {
  if (state.screen === "map") {
    return mapNextChoices(state).map((id) => {
      const node = state.map.nodes[id];
      return `第${node.row + 1}层 ${NODE_TYPE_LABELS[node.type]}`;
    });
  }
  if (state.screen === "reward" && state.reward) {
    const cards = state.reward.cardChoices.map((choice) => {
      const def = getCardDef(choice.defId);
      const cost = costOf(def, choice.upgraded);
      const desc = choice.upgraded ? def.upgradedDescription : def.description;
      const rarity = RARITY_LABELS[def.rarity] ?? "";
      return `[${rarity}] ${def.name}${choice.upgraded ? "+" : ""} 费${cost ?? "-"} · ${desc}`;
    });
    const extra = ["跳过（不拿卡）"];
    // 唱钵：可放弃卡奖励，改为 +2 最大生命。
    if (hasRelic(state, "singing_bowl")) {
      extra.push("唱钵：放弃卡牌，最大生命 +2");
    }
    return [...cards, ...extra];
  }
  if (state.screen === "rest") {
    return restActions(state).map((action) => {
      switch (action.kind) {
        case "rest":
          return `休息：回复 ${Math.floor(state.maxHp * REST_HEAL_RATIO)} 点生命`;
        case "smith": {
          const card = state.deck.find((c) => c.uid === action.uid)!;
          return `打铁：升级「${getCardDef(card.defId).name}」`;
        }
        case "lift":
          return "举重：永久获得 1 点力量";
        case "dig":
          return "挖掘：挖出一个遗物";
        case "toke":
          return "抽烟：从牌组抽去一张牌";
      }
    });
  }
  if (state.screen === "event" && state.event) {
    return getEventDef(state.event.id).choices.map((choice) => choice.label);
  }
  if (state.screen === "shop" && state.shop) {
    // 去牌子界面：列可移除的牌 + 取消。
    if (state.shop.removing) {
      const cards = state.deck.map((card) => {
        const def = getCardDef(card.defId);
        return `移除「${def.name}${card.upgraded ? "+" : ""}」`;
      });
      cards.push("取消");
      return cards;
    }
    const options = state.shop.items.map((item) => {
      const name = shopItemName(item);
      if (item.sold) {
        return `${name}（已售罄）`;
      }
      const affordable = state.gold >= item.cost ? "" : "（金币不足）";
      return `${name} — ${item.cost} 金${affordable}`;
    });
    const purge = state.shop.purgeUsed
      ? "去牌服务（已用过）"
      : `移除一张牌 — ${state.shop.purgeCost} 金${state.gold >= state.shop.purgeCost ? "" : "（金币不足）"}`;
    options.push(purge, "离开商店");
    return options;
  }
  if (state.screen === "card_select" && state.cardSelect) {
    const cs = state.cardSelect;
    const opts = cs.choices.map((c) => {
      const def = getCardDef(c.defId);
      return `${def.name}${c.upgraded ? "+" : ""}`;
    });
    if (cs.canSkip) {
      opts.push("跳过");
    }
    return opts;
  }
  return [];
}

/** 商店商品的展示名（卡/遗物/药水）。 */
function shopItemName(item: NonNullable<GameState["shop"]>["items"][number]): string {
  if (item.kind === "card") {
    return `牌·${getCardDef(item.defId).name}`;
  }
  if (item.kind === "relic") {
    return `遗物·${getRelicDef(item.id).name}`;
  }
  return `药水·${getPotionDef(item.id).name}`;
}

/** 结算一个事件结果（原地改 state）。金币/生命/牌组/遗物/药水复用既有系统。 */
function applyEventOutcome(state: GameState, outcome: EventOutcome): void {
  switch (outcome.kind) {
    case "gain_gold":
      state.gold += outcome.amount;
      break;
    case "lose_gold":
      state.gold = Math.max(0, state.gold - outcome.amount);
      break;
    case "heal":
      state.hp = Math.min(state.maxHp, state.hp + outcome.amount);
      break;
    case "lose_hp":
      // 事件不会致死：至少留 1 点生命（复刻 StS 事件不杀人）。
      state.hp = Math.max(1, state.hp - outcome.amount);
      break;
    case "gain_max_hp":
      state.maxHp += outcome.amount;
      state.hp += outcome.amount;
      break;
    case "add_card":
      addCardToDeck(state, outcome.cardId, false);
      break;
    case "gain_relic":
      grantTreasure(state);
      break;
    case "gain_potion": {
      const slot = state.potions.indexOf(null);
      if (slot >= 0) {
        state.potions[slot] = POTION_DROP_POOL[nextInt(state.rng, POTION_DROP_POOL.length)]!;
      }
      break;
    }
    case "remove_random_card": {
      // 优先移除诅咒/状态牌，否则随机移除一张牌。
      const junk = state.deck.filter((card) => {
        const type = getCardDef(card.defId).type;
        return type === "curse" || type === "status";
      });
      const pool = junk.length > 0 ? junk : state.deck;
      if (pool.length > 0) {
        const victim = pool[nextInt(state.rng, pool.length)];
        const idx = state.deck.findIndex((card) => card.uid === victim.uid);
        if (idx >= 0) {
          state.deck.splice(idx, 1);
          state.log.push(`「${getCardDef(victim.defId).name}」从牌组中移除了。`);
        }
      }
      break;
    }
    case "upgrade_random_card": {
      // 升级 count 张随机未升级的牌（攻击/技能/能力；status/curse cost=null 天然被 upgradableCards 排除）。
      const candidates = upgradableCards(state);
      for (let n = 0; n < outcome.count && candidates.length > 0; n += 1) {
        const idx = nextInt(state.rng, candidates.length);
        candidates[idx].upgraded = true;
        candidates.splice(idx, 1);
      }
      break;
    }
    case "start_combat": {
      // 事件触发战斗：进入指定遭遇；elite 则胜利后发遗物（斗兽场/神秘球等）。
      startCombat(state, outcome.encounterId, outcome.elite ?? false);
      if (outcome.elite) {
        state.pendingRelicReward = true;
      }
      break;
    }
    case "random": {
      // 命运之轮：等概率选一组子结果结算。
      const chosen = outcome.options[nextInt(state.rng, outcome.options.length)];
      for (const sub of chosen) {
        applyEventOutcome(state, sub);
      }
      break;
    }
    case "library": {
      // 图书馆：随机取 count 张不重复的牌，打开选牌屏挑 1 张加入。
      const color = getCharacterConfig(state.character).color;
      const pool = [
        ...cardPoolOf(color, "common"),
        ...cardPoolOf(color, "uncommon"),
        ...cardPoolOf(color, "rare"),
      ];
      const choices: { defId: string; upgraded: boolean }[] = [];
      const picked = new Set<string>();
      for (let i = 0; i < outcome.count && picked.size < pool.length; i += 1) {
        let defId = pool[nextInt(state.rng, pool.length)];
        while (picked.has(defId)) {
          defId = pool[nextInt(state.rng, pool.length)];
        }
        picked.add(defId);
        choices.push({ defId, upgraded: false });
      }
      state.cardSelect = { mode: "add", title: "从藏书中挑选一张带走", choices, canSkip: true };
      state.screen = "card_select";
      break;
    }
    case "duplicator": {
      // 复制器：打开选牌屏，复制牌组里的一张牌。
      openDuplicator(state);
      break;
    }
    case "nothing":
      break;
    default: {
      const _exhaustive: never = outcome;
      void _exhaustive;
    }
  }
}

function upgradableCards(state: GameState): GameState["deck"] {
  return state.deck.filter((card) => !card.upgraded && getCardDef(card.defId).cost !== null);
}

const GIRYA_MAX_LIFTS = 3;

/** 篝火菜单动作（休息 / 打铁 / 举铁 / 挖掘）。选项渲染与 choose 分发共用，避免下标错位。 */
type RestAction =
  | { kind: "rest" }
  | { kind: "smith"; uid: number }
  | { kind: "lift" } // 举重（举铁）：girya，+1 永久力量，全程至多 3 次
  | { kind: "dig" } // 挖掘：shovel，挖一个遗物
  | { kind: "toke" }; // 抽烟：peace_pipe，抽去一张牌

/** 按当前遗物构造篝火菜单：休息永远在首位，之后依次是打铁项、可用的篝火遗物动作。 */
function restActions(state: GameState): RestAction[] {
  const actions: RestAction[] = [{ kind: "rest" }];
  for (const card of upgradableCards(state)) {
    actions.push({ kind: "smith", uid: card.uid });
  }
  const girya = state.relics.find((relic) => relic.id === "girya");
  if (girya && girya.counter < GIRYA_MAX_LIFTS) {
    actions.push({ kind: "lift" });
  }
  if (hasRelic(state, "shovel")) {
    actions.push({ kind: "dig" });
  }
  if (hasRelic(state, "peace_pipe") && state.deck.length > 0) {
    actions.push({ kind: "toke" });
  }
  return actions;
}

export type ChooseResult = { ok: true } | { ok: false; reason: string };

/** 购买一件商店商品：校验售罄/金币/药水槽 → 扣金币、入库、标记售罄，留在商店屏。 */
function buyShopItem(
  state: GameState,
  item: NonNullable<GameState["shop"]>["items"][number],
): ChooseResult {
  if (item.sold) {
    return { ok: false, reason: "这件商品已经卖掉了。" };
  }
  if (state.gold < item.cost) {
    return { ok: false, reason: `金币不足：需 ${item.cost}，你只有 ${state.gold}。` };
  }
  if (item.kind === "potion" && state.potions.indexOf(null) < 0) {
    return { ok: false, reason: "药水槽已满，先用掉一瓶再买。" };
  }

  state.gold -= item.cost;
  item.sold = true;
  if (item.kind === "card") {
    addCardToDeck(state, item.defId, false);
    state.log.push(`你买下了牌「${getCardDef(item.defId).name}」。`);
  } else if (item.kind === "relic") {
    grantRelic(state, item.id);
    state.log.push(`你买下了遗物「${getRelicDef(item.id).name}」。`);
  } else {
    state.potions[state.potions.indexOf(null)] = item.id;
    state.log.push(`你买下了药水「${getPotionDef(item.id).name}」。`);
  }
  return { ok: true };
}

export function applyChoose(state: GameState, optionIndex: number): ChooseResult {
  if (state.screen === "map") {
    const options = mapNextChoices(state);
    const nodeId = options[optionIndex];
    if (nodeId === undefined) {
      return { ok: false, reason: `选项 ${optionIndex} 无效。` };
    }
    // 仙女靴：若走了正常路径之外的节点，消耗一次靴子余量。
    if (!availableNext(state.map, state.currentNodeId).includes(nodeId)) {
      const wingBoots = state.relics.find((relic) => relic.id === "wing_boots");
      if (wingBoots) {
        wingBoots.counter += 1;
        state.log.push("你踩着仙女靴，抄近道越过了岔口。");
      }
    }
    resolveNode(state, state.map.nodes[nodeId]);
    return { ok: true };
  }

  if (state.screen === "reward" && state.reward) {
    const choices = state.reward.cardChoices;
    const bowlIndex = hasRelic(state, "singing_bowl") ? choices.length + 1 : -1;
    if (optionIndex === bowlIndex) {
      // 唱钵：放弃卡牌换 +2 最大生命。
      state.maxHp += 2;
      state.hp += 2;
      state.log.push("你对着唱钵冥想，最大生命 +2。");
    } else if (optionIndex === choices.length) {
      state.log.push("你跳过了卡奖励。");
    } else if (optionIndex >= 0 && optionIndex < choices.length) {
      const pick = choices[optionIndex];
      addCardToDeck(state, pick.defId, pick.upgraded);
      state.log.push(`你获得了「${getCardDef(pick.defId).name}」。`);
    } else {
      return { ok: false, reason: `选项 ${optionIndex} 无效。` };
    }
    state.reward = null;
    backToMap(state);
    return { ok: true };
  }

  if (state.screen === "shop" && state.shop) {
    const shop = state.shop;
    // 去牌子界面：选一张牌移除，或取消。
    if (shop.removing) {
      if (optionIndex === state.deck.length) {
        shop.removing = false;
        return { ok: true };
      }
      const card = state.deck[optionIndex];
      if (!card) {
        return { ok: false, reason: `选项 ${optionIndex} 无效。` };
      }
      state.gold -= shop.purgeCost;
      state.deck.splice(optionIndex, 1);
      shop.purgeUsed = true;
      shop.removing = false;
      state.log.push(`你花 ${shop.purgeCost} 金移除了「${getCardDef(card.defId).name}」。`);
      return { ok: true };
    }
    const items = shop.items;
    if (optionIndex < items.length) {
      return buyShopItem(state, items[optionIndex]);
    }
    if (optionIndex === items.length) {
      // 去牌服务：进入选牌子界面。
      if (shop.purgeUsed) {
        return { ok: false, reason: "本店的去牌服务已经用过了。" };
      }
      if (state.gold < shop.purgeCost) {
        return { ok: false, reason: `金币不足：去牌需 ${shop.purgeCost}，你只有 ${state.gold}。` };
      }
      if (state.deck.length === 0) {
        return { ok: false, reason: "牌组里没有可移除的牌。" };
      }
      shop.removing = true;
      return { ok: true };
    }
    if (optionIndex === items.length + 1) {
      state.shop = null;
      backToMap(state);
      return { ok: true };
    }
    return { ok: false, reason: `选项 ${optionIndex} 无效。` };
  }

  if (state.screen === "event" && state.event) {
    const event = getEventDef(state.event.id);
    const choice = event.choices[optionIndex];
    if (!choice) {
      return { ok: false, reason: `选项 ${optionIndex} 无效。` };
    }
    for (const outcome of choice.outcomes) {
      applyEventOutcome(state, outcome);
    }
    state.log.push(choice.resultText);
    state.event = null;
    // 事件触发了战斗或选牌屏：交给对应界面接管，不立即回地图。
    if (state.combat !== null || state.cardSelect !== null) {
      return { ok: true };
    }
    backToMap(state);
    return { ok: true };
  }

  if (state.screen === "card_select" && state.cardSelect) {
    const cs = state.cardSelect;
    if (cs.canSkip && optionIndex === cs.choices.length) {
      state.cardSelect = null;
      backToMap(state);
      return { ok: true };
    }
    const choice = cs.choices[optionIndex];
    if (!choice) {
      return { ok: false, reason: `选项 ${optionIndex} 无效。` };
    }
    if (cs.mode === "add") {
      addCardToDeck(state, choice.defId, choice.upgraded);
      state.log.push(`你获得了「${getCardDef(choice.defId).name}」。`);
    } else if (cs.mode === "duplicate") {
      const src = state.deck.find((c) => c.uid === choice.uid);
      if (src) {
        addCardToDeck(state, src.defId, src.upgraded);
        state.log.push(`「${getCardDef(src.defId).name}」被复制了。`);
      }
    } else {
      const idx = state.deck.findIndex((c) => c.uid === choice.uid);
      if (idx >= 0) {
        state.log.push(`你抽去了「${getCardDef(state.deck[idx].defId).name}」。`);
        state.deck.splice(idx, 1);
      }
    }
    state.cardSelect = null;
    backToMap(state);
    return { ok: true };
  }

  if (state.screen === "rest") {
    const action = restActions(state)[optionIndex];
    if (!action) {
      return { ok: false, reason: `选项 ${optionIndex} 无效。` };
    }
    switch (action.kind) {
      case "rest": {
        // 富贵枕头：休息时额外回复 15 点生命；永恒羽毛：每 5 张牌额外回 3。
        const heal =
          Math.floor(state.maxHp * REST_HEAL_RATIO) +
          (hasRelic(state, "regal_pillow") ? 15 : 0) +
          (hasRelic(state, "eternal_feather") ? Math.floor(state.deck.length / 5) * 3 : 0);
        state.hp = Math.min(state.maxHp, state.hp + heal);
        state.log.push(`你休息了一会儿，回复了 ${heal} 点生命。`);
        // 古董茶具：休息后下场战斗第一回合 +2 能量（counter 作待生效标记）。
        const teaSet = state.relics.find((relic) => relic.id === "ancient_tea_set");
        if (teaSet) {
          teaSet.counter = 1;
        }
        // 织梦者：休息时额外获得一次卡奖励（复用奖励屏；选完自动回地图）。
        if (hasRelic(state, "dream_catcher")) {
          generateRestCardReward(state);
          return { ok: true };
        }
        break;
      }
      case "smith": {
        const target = state.deck.find((c) => c.uid === action.uid);
        if (!target) {
          return { ok: false, reason: `选项 ${optionIndex} 无效。` };
        }
        target.upgraded = true;
        state.log.push(`你升级了「${getCardDef(target.defId).name}」。`);
        break;
      }
      case "lift": {
        // 举重（girya）：counter 记本局已举次数，每次 +1 永久力量（战斗开始由钩子施加）。
        const girya = state.relics.find((relic) => relic.id === "girya");
        if (girya) {
          girya.counter += 1;
          state.log.push("你举起了铁球，force +1。");
        }
        break;
      }
      case "dig": {
        // 挖掘（shovel）：挖出一个遗物。
        grantRandomRelic(state);
        break;
      }
      case "toke": {
        // 抽烟（peace_pipe）：打开选牌屏抽去一张牌（选完由 card_select 分支回地图）。
        openCardRemoval(state);
        return { ok: true };
      }
    }
    backToMap(state);
    return { ok: true };
  }

  return { ok: false, reason: "当前屏幕没有可选项。" };
}
