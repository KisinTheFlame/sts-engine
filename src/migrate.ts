import { initialCardCost } from "./engine/sts-combat.js";
import type { GameState } from "./engine/types.js";

// === 存档迁移 ===
//
// 引擎的 GameState 形状会随里程碑增长（C3 加充能球 orbs/orbSlots、C4 加姿态 playerStance、
// 三幕加 act/enemy.hasRevived、药水加 potions…）。老版本二进制存下的 save.json 会缺这些后加字段；
// 新二进制读回后若直接序列化，registerJsonRoute 的 output.parse 会因缺字段 500（表现为
// 「orbs / stance required」），把小镜的对局卡死。
//
// 迁移策略：读盘后回填**缺失**字段的默认值（只在 undefined 时填，不覆盖已有值），让老存档能继续，
// 而不是整局作废。加新字段时，若老存档缺了会崩，就在这里补一行默认值。

function backfill(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (obj[key] === undefined) {
    obj[key] = value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** 回填老存档缺失的后加字段，就地改并返回同一对象（类型收敛回 GameState）。 */
export function migrateLoadedState(raw: unknown): GameState {
  const state = asRecord(raw);
  if (!state) {
    // 不是对象（极端坏档）——交回上层，load 会当作无档处理。
    return raw as GameState;
  }
  // 顶层后加字段。
  backfill(state, "character", "ironclad");
  backfill(state, "ascension", 0);
  backfill(state, "act", 1);
  backfill(state, "potions", [null, null, null]);
  backfill(state, "potionDropBonus", 0);
  backfill(state, "combatsEntered", 0);
  backfill(state, "pendingRelicReward", false);
  backfill(state, "floorNum", 0); // 楼层号——老档没有。
  // 种子从 number 升为 int64 十进制字符串：老档存的是 number，原样转字符串即可
  //（老档的种子本就在 2^53 内，不存在精度损失）。
  if (typeof state["seed"] === "number") {
    state["seed"] = String(state["seed"]);
  }
  backfill(state, "cardSelect", null); // 选牌子界面（图书馆/复制器/和平烟斗）——老档没有。
  backfill(state, "stsPotionRng", null); // run 级持久 potionRng——老档没有。
  // 一度存在过的 combatEngine 开关（近似/游戏级二选一）随近似实现一起删了。
  delete state["combatEngine"];

  // 战斗字段换代：
  //  * 0.16.0 的档把游戏级战斗放在 stsCombat，combat 留给近似战斗 → 平移到 combat。
  //  * 更老的档 combat 里是近似战斗的形状（enemies/playerPowers…），与游戏级快照不兼容，
  //    无法平移，只能作废这一场、回地图继续爬。
  const sts = asRecord(state["stsCombat"]);
  delete state["stsCombat"];
  if (sts) {
    state["combat"] = sts;
  }
  const combat = asRecord(state["combat"]);
  if (combat && combat["enemies"] !== undefined) {
    state["combat"] = null;
    if (state["screen"] === "combat") {
      state["screen"] = "map";
    }
  }
  backfill(state, "combat", null);

  // 战斗内选牌屏（第四批）的三个后加字段。老档只可能停在当时唯一的可操作态
  // player_normal，且那时动作队列必空——所以这三条回填是**无损**的，不是猜测。
  const live = asRecord(state["combat"]);
  if (live) {
    backfill(live, "inputState", "player_normal");
    backfill(live, "cardSelect", null);
    backfill(live, "pendingActions", []);
    // 出牌队列残留（第九批）。同样**无损**：让它非空的只有嵌套出牌（二连击的复制项、
    // 混乱排的第二张牌），而那三张牌是第九批才登记的——在此之前出牌队列在任何可取档
    // 时点都必空，当时的 exportState 甚至会为此显式抛错。
    backfill(live, "pendingCardQueue", []);
    migrateCombatCards(live);
  }

  return state as unknown as GameState;
}

/**
 * 卡牌实例级状态（第七批）的三个后加字段：`cost` / `costForTurn` / `specialData`。
 *
 * 回填同样是**无损**的，理由是「能改写它们的牌当时一张都没登记」：血债血偿 / 疯狂 /
 * 腐化 / 暴走 / 灼热之刃都是本批才进 CARD_RULES 的，在它们之前任何一张牌的实例状态都
 * 恒等于「建实例时由数据表播种的初值」——正是 `initialCardCost` / 灼热之刃那条给出的值。
 */
function migrateCombatCards(combat: Record<string, unknown>): void {
  const fix = (raw: unknown): void => {
    const card = asRecord(raw);
    if (!card || typeof card["defId"] !== "string") {
      return;
    }
    const cost = initialCardCost(card["defId"], card["upgraded"] === true);
    backfill(card, "cost", cost);
    backfill(card, "costForTurn", cost);
    backfill(
      card,
      "specialData",
      card["defId"] === "searing_blow" && card["upgraded"] === true ? 1 : 0,
    );
  };
  for (const pile of ["hand", "drawPile", "discardPile", "exhaustPile"]) {
    const cards: unknown = combat[pile];
    if (Array.isArray(cards)) {
      cards.forEach(fix);
    }
  }
  // 选牌屏上取的档里，队列残留的 after_use_card 也带着一张牌实例。
  const pending: unknown = combat["pendingActions"];
  if (Array.isArray(pending)) {
    for (const raw of pending) {
      const desc = asRecord(raw);
      if (desc?.["kind"] === "after_use_card") {
        fix(desc["card"]);
      }
    }
  }
  // 出牌队列残留项同理（第九批起可能非空）。
  const queued: unknown = combat["pendingCardQueue"];
  if (Array.isArray(queued)) {
    for (const raw of queued) {
      const item = asRecord(raw);
      fix(item?.["card"]);
      if (item) {
        // `ignoreEnergyTotal`（第十批新增）。回填是**无损**的：唯一置真的地方是
        // `queuePurgeCard`（二连击的复制项），所以「purgeOnUse 为真 ⟺ 它为真」在
        // 第九批的档里恒成立。
        backfill(item, "ignoreEnergyTotal", item["purgeOnUse"] === true);
      }
    }
  }
}
