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
    // 停滞槽（第二十八批，对齐 `CardManager::stasisCards`）。回填 `[null, null]` 是**无损**的：
    // 唯一的写入点是青铜球的停滞，而那只怪本批才登记——在此之前任何老档里这两格都必然是空的，
    // 参考的初值同样是两个 `CardId::INVALID`（CardManager.h:32）。
    backfill(live, "stasisCards", [null, null]);
    migrateCombatCards(live);
    migrateCombatBatch11(live, state);
    migrateMonsterMiscInfo(live);
    migratePlayerLastAttack(live);
    migratePlayerTurnCounters(live);
    migratePlayerRelicCounters(live);
    migrateCombatRelicData(live);
  }

  return state as unknown as GameState;
}

/**
 * 玩家的 `lastAttackUnblockedDamage`（第二十五批，对齐 `Player::lastAttackUnblockedDamage`）。
 *
 * 回填 0 是**无损**的：唯一的读者是带壳寄生虫的吸血攻击（`Actions::VampireAttack`），
 * 而那只怪本批才登记——在此之前任何老档里都没有东西读过这个字段，取什么值都不影响行为。
 * 参考的初值同样是 0（Player.h:86）。
 */
function migratePlayerLastAttack(combat: Record<string, unknown>): void {
  const player = asRecord(combat["player"]);
  if (player) {
    backfill(player, "lastAttackUnblockedDamage", 0);
  }
}

/**
 * 玩家的 `attacksPlayedThisTurn` / `skillsPlayedThisTurn`（第四十一批，对齐
 * `Player::attacksPlayedThisTurn` / `skillsPlayedThisTurn`，Player.h:80-81）。
 *
 * 回填 0 是**无损**的，理由与 `lastAttackUnblockedDamage` 那条同型：这两个计数器的读者
 * 只有苦无 / 装饰扇 / 手里剑 / 开信刀四颗遗物，而它们的战斗内行为**本批才转写**——
 * 在此之前这四颗遗物在战斗内是纯粹的摆设（`relics.ts` 的 `hooks` 是空的，
 * `initRelics` 三张表里也没有它们），没有任何东西读过这两个字段。
 * ⚠ 老档确实可能停在「本回合已打过两张攻击牌」的时点上，回填 0 会让那一局的计数从头算起；
 * 但那个「正确的续算值」从来就不存在——旧引擎压根没有这个字段。
 * ⚠ 顺带记一笔：`isRelicSupported` 目前**没有任何调用者**（`stsCombatCoverage` 只查编队 /
 * 牌 / 药水，不查遗物）。这是接线侧的一处缺口，不属于本批范围，已记进 TODOS。
 */
function migratePlayerTurnCounters(combat: Record<string, unknown>): void {
  const player = asRecord(combat["player"]);
  if (player) {
    backfill(player, "attacksPlayedThisTurn", 0);
    backfill(player, "skillsPlayedThisTurn", 0);
  }
}

/**
 * 墨水瓶的 `inkBottleCounter` 与橙色药丸的 `orangePelletsCardTypesPlayed`（第四十二批，
 * 对齐 `Player::inkBottleCounter` / `Player::orangePelletsCardTypesPlayed`，Player.h:67 / :82）。
 *
 * 回填 0 是**无损**的，理由与上面两条同型：这两个字段的读者只有墨水瓶与橙色药丸两颗遗物，
 * 而它们的战斗内行为**本批才转写**——在此之前两颗在战斗内是纯粹的摆设
 * （`relics.ts` 的 `hooks` 是空的，`initRelics` 三张表里也没有它们）。
 * ⚠ 老档确实可能停在「本回合已打过攻击牌与技能牌」的时点上，回填 0 会让位掩码从头算起；
 * 那个「正确的续算值」从来就不存在。
 * ⚠ 墨水瓶那个计数器在参考里是**跨战斗**的（`initRelics` 读 `r.data`、`updateRelicsOnExit`
 * 写回），我们目前每场从 0 起算——那是 run 层的缺口，不是迁移的事，已记进 TODOS。
 */
function migratePlayerRelicCounters(combat: Record<string, unknown>): void {
  const player = asRecord(combat["player"]);
  if (player) {
    backfill(player, "inkBottleCounter", 0);
    backfill(player, "orangePelletsCardTypesPlayed", 0);
  }
}

/**
 * 战斗内的遗物容器从 `string[]` 变成 `{ id, data }[]`，玩家多出 `relicBits` 与五个计数器
 * （第四十四批，对齐 `RelicInstance`（RelicContainer.h:10）与 `Player::relicBits0/1`）。
 *
 * 三条回填**都是无损**的：
 *  * `relics` 里的每个字符串变成 `{ id, data: 0 }`——在此之前 `bc.relics` 只有 id，
 *    没有任何东西读过 `data`，所以 0 就是当时的实际语义。
 *  * `player.relicBits` 回填成**容器里的全部 id**：清位的四处（御守 / 蜥蜴尾的
 *    `setHasRelic<X>(r.data)`、蜥蜴尾复活用掉、百年拼图触发过）本批才登记，
 *    在此之前「容器里有」与「玩家身上有」严格同解。
 *  * 五个计数器与 `haveUsedNecronomiconThisTurn` 回填 0 / false，理由与
 *    `migratePlayerRelicCounters` 那条同型：读者是本批才登记的遗物。
 */
function migrateCombatRelicData(combat: Record<string, unknown>): void {
  const relics: unknown = combat["relics"];
  if (Array.isArray(relics)) {
    const upgraded: unknown[] = [];
    for (const relic of relics as unknown[]) {
      upgraded.push(typeof relic === "string" ? { id: relic, data: 0 } : relic);
    }
    combat["relics"] = upgraded;
  }
  const player = asRecord(combat["player"]);
  if (player) {
    if (player["relicBits"] === undefined) {
      const list: unknown = combat["relics"];
      const ids: string[] = [];
      if (Array.isArray(list)) {
        for (const relic of list) {
          const id = asRecord(relic)?.["id"];
          if (typeof id === "string") {
            ids.push(id);
          }
        }
      }
      player["relicBits"] = ids;
    }
    backfill(player, "happyFlowerCounter", 0);
    backfill(player, "incenseBurnerCounter", 0);
    backfill(player, "nunchakuCounter", 0);
    backfill(player, "penNibCounter", 0);
    backfill(player, "sundialCounter", 0);
    backfill(player, "haveUsedNecronomiconThisTurn", false);
  }
}

/**
 * 怪物的 `rolledDamage` 改名为 `miscInfo`（第十六批）。
 *
 * 参考侧本来就只有**一个** `Monster::miscInfo`（Monster.h:83），含义逐怪种不同；我们早先
 * 只用到虱子那一种（整场固定的咬击伤害），就按那个用途起名叫 `rolledDamage`。第十六批给
 * 参考补上「红色奴隶主用它记 usedEntangle」之后，一个字段两种含义，名字必须回到参考的形状。
 *
 * 回填是**无损**的：老档里这个字段只可能是虱子的咬击伤害（唯一的写入点），原样搬过去即可；
 * 没有该字段的更老档（或没用到它的怪）落到 0，与当时的行为一致。
 */
function migrateMonsterMiscInfo(combat: Record<string, unknown>): void {
  const monsters: unknown = combat["monsters"];
  if (!Array.isArray(monsters)) {
    return;
  }
  for (const raw of monsters) {
    const m = asRecord(raw);
    if (!m) {
      continue;
    }
    const old: unknown = m["rolledDamage"];
    delete m["rolledDamage"];
    backfill(m, "miscInfo", typeof old === "number" ? old : 0);
    // 怪物侧的**第二个**通用整数字段（第二十批新增，对齐 `Monster::uniquePower0`）。
    // 回填 0 是**无损**的：唯一的使用者是六火幽魂的六焰计数，而它本批才登记
    // ——在此之前任何老档里都不可能有一只怪用到它。
    backfill(m, "uniquePower0", 0);
    // 半死位（第三十四批新增，对齐 `Monster::halfDead`）。
    // 回填 false 是**无损**的：能置起它的只有 `Monster::die` 的 REGROW 分支（暗影客）
    // 与觉醒者的假死，两者在本批之前都没登记——老档里任何一只怪都不可能是半死态。
    backfill(m, "halfDead", false);
  }
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

/**
 * 第十一批新增的战斗字段：`strikeCount`、`player.bomb1/2/3`、`player.gold`。
 *
 * 三组的回填理由各不相同：
 *
 *  * **`bomb1/2/3` 一律 0** —— 无损。唯一能让它们非零的是炸弹（`the_bomb`），本批才登记；
 *    在此之前任何一场战斗里这三格恒为 0。
 *  * **`player.gold` 取 run 级的 `state.gold`** —— 无损，而且正是参考的入场值
 *    （`player.gold = gc.gold`）。战斗内唯一的增点是贪婪之手（本批才登记），唯一的减点是
 *    盗贼/劫掠者偷钱（那两只怪还没登记），所以老档的战斗内金币恒等于 run 级金币。
 *  * **`strikeCount` 要真的数一遍** —— 这一条**不是**常量回填。老档的战斗里可以有
 *    完美打击（变形/发现/多面手能从卡池里把它造出来躺在牌堆里），读回来之后玩家真的可能
 *    打出它，所以数值得对。数的范围与 `notifyAddCardToCombat` 的语义一致：
 *    手牌 + 抽牌堆 + 弃牌堆（**消耗堆不算**），再加上「已离开手牌、还在飞」的那些牌——
 *    即残留动作里的 `after_use_card`、以及出牌队列里的项。
 *    ⚠ 两处都要排除 `purgeOnUse`：二连击的复制项是按值拷贝、从来没进过计数器。
 */
function migrateCombatBatch11(
  combat: Record<string, unknown>,
  state: Record<string, unknown>,
): void {
  const player = asRecord(combat["player"]);
  if (player) {
    backfill(player, "bomb1", 0);
    backfill(player, "bomb2", 0);
    backfill(player, "bomb3", 0);
    backfill(player, "gold", typeof state["gold"] === "number" ? state["gold"] : 0);
  }
  if (combat["strikeCount"] !== undefined) {
    return;
  }
  // 与 sts-combat.ts 的 isStrikeCard 同源。这里独立列一份是故意的：migrate 不该依赖
  // 战斗实现的内部函数（那个谓词不导出），而且这份名单是「老档当时可能出现的牌」，
  // 将来即使 isStrikeCard 因新角色而扩表，老档的语义也不该跟着变。
  const strikeIds = new Set([
    "meteor_strike",
    "perfected_strike",
    "pommel_strike",
    "sneaky_strike",
    "strike",
    "strike_blue",
    "strike_green",
    "strike_purple",
    "swift_strike",
    "thunder_strike",
    "twin_strike",
    "wild_strike",
    "windmill_strike",
  ]);
  const isStrike = (raw: unknown): boolean => {
    const card = asRecord(raw);
    return card !== null && typeof card["defId"] === "string" && strikeIds.has(card["defId"]);
  };
  let count = 0;
  for (const pile of ["hand", "drawPile", "discardPile"]) {
    const cards: unknown = combat[pile];
    if (Array.isArray(cards)) {
      count += cards.filter(isStrike).length;
    }
  }
  const pending: unknown = combat["pendingActions"];
  if (Array.isArray(pending)) {
    for (const raw of pending) {
      const desc = asRecord(raw);
      if (
        desc?.["kind"] === "after_use_card" &&
        desc["purgeOnUse"] !== true &&
        isStrike(desc["card"])
      ) {
        count += 1;
      }
    }
  }
  const queued: unknown = combat["pendingCardQueue"];
  if (Array.isArray(queued)) {
    for (const raw of queued) {
      const item = asRecord(raw);
      if (item && item["purgeOnUse"] !== true && isStrike(item["card"])) {
        count += 1;
      }
    }
  }
  combat["strikeCount"] = count;
}
