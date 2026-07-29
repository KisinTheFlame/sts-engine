import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  cardPoolOf,
  etherealOf,
  exhaustsOf,
  getCardDef,
  rewardCardPoolOf,
  targetedOf,
} from "../src/engine/cards/cards.js";
import {
  ALL_RELICS,
  bossRelicPool,
  getRelicDef,
  rewardRelicPool,
  shopRelicPool,
} from "../src/engine/relics/relics.js";
import {
  ALL_POTIONS,
  getPotionDef,
  potionPoolOfRarity,
  shopPotionPool,
} from "../src/engine/potions/potions.js";
import { REGISTERED_CARD_IDS } from "../src/engine/sts-combat.js";
import { ALL_EVENTS, getEventDef } from "../src/engine/events/events.js";
import { ALL_ENEMIES, getEnemyDef, getEncounterDef } from "../src/engine/enemies/enemies.js";
import type { CardDef, CharacterId } from "../src/engine/types.js";

// ============================================================================
// 数据表不变量。
//
// 近似战斗（连同断言它行为的 115 个测试文件）删掉之后，数据表的守卫也一起没了——
// 而数据表是两代战斗实现**共用**的东西，它出错时游戏级实现会照着错的数值逐位复现。
// 曾经出过 3 处药水稀有度错误而无测试守着（见 TODOS.md），所以这里按 TODOS
// 「纯数据 → 永久保留，且应加强」把不依赖任何战斗实现的不变量钉住。
// ============================================================================

const CHARACTERS: CharacterId[] = ["ironclad", "silent", "defect", "watcher"];

describe("卡表", () => {
  it("id 唯一", () => {
    const ids = ALL_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每张牌都能按 id 取回，且名称/描述非空", () => {
    for (const card of ALL_CARDS) {
      expect(getCardDef(card.id)).toBe(card);
      expect(card.name.length).toBeGreaterThan(0);
      expect(card.description.length).toBeGreaterThan(0);
      expect(card.upgradedDescription.length).toBeGreaterThan(0);
    }
  });

  it("费用合法：0..5；status/curse 才允许 null（不可打出）", () => {
    for (const card of ALL_CARDS) {
      if (card.cost === null) {
        // cost: null 就是「无法打出」的标记（废牌、诅咒，以及急智那类不可打出的技能牌）。
        // 真正要防的是「本该能打的牌漏写了费用」——那种牌会带着 effects。
        expect(card.effects, `${card.id} 无法打出却带着 effects`).toEqual([]);
        expect(card.upgradedEffects, `${card.id} 无法打出却带着 upgradedEffects`).toEqual([]);
        continue;
      }
      expect(card.cost, `${card.id} 费用越界`).toBeGreaterThanOrEqual(0);
      // 原版最贵的是 5 费（陨星打击），4 费只有时之沙一张。
      expect(card.cost, `${card.id} 费用越界`).toBeLessThanOrEqual(5);
      if (card.upgradedCost !== undefined) {
        expect(card.upgradedCost, `${card.id} 升级费用越界`).toBeGreaterThanOrEqual(0);
        expect(card.upgradedCost, `${card.id} 升级费用不应变贵`).toBeLessThanOrEqual(card.cost);
      }
    }
  });

  it("颜色与类型自洽：status/curse 色即 status/curse 类", () => {
    for (const card of ALL_CARDS) {
      if (card.color === "status") {
        expect(card.type, card.id).toBe("status");
      }
      if (card.color === "curse") {
        expect(card.type, card.id).toBe("curse");
      }
    }
  });

  it("奖励池：不含 starter/special，不含废牌，且无重复", () => {
    for (const color of ["red", "green", "blue", "purple", "colorless"] as const) {
      const pool = rewardCardPoolOf(color);
      expect(new Set(pool).size, `${color} 池有重复`).toBe(pool.length);
      for (const id of pool) {
        const def = getCardDef(id);
        expect(def.color, `${id} 不该在 ${color} 池`).toBe(color);
        expect(["common", "uncommon", "rare"], `${id} 稀有度不该进奖励池`).toContain(def.rarity);
      }
    }
  });

  it("每种颜色的三档池都非空", () => {
    for (const color of ["red", "green", "blue", "purple", "colorless"] as const) {
      for (const rarity of ["common", "uncommon", "rare"] as const) {
        expect(cardPoolOf(color, rarity).length, `${color}/${rarity} 池为空`).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================================
// 「颜色归属」不变量。
//
// `color` 决定一张牌进哪个角色的奖励池，改一处就改变同种子 run 的卡牌奖励。但它在数据表里
// 基本是**孤证**：`cardPoolOf` 直接按 `color` 过滤派生，所以「池里的牌颜色对不对」是
// 恒真的，上面那条奖励池不变量真正挡住的只有重复定义。权威名单在参考的 `CardPools.h`，
// 那是 C++、本仓库读不到。
//
// 代价已经付过一次：哨兵是铁甲（红）牌，却被记成 `"blue"`——于是它进了机器人的奖励池、
// 铁甲的红池少一张，而**没有任何测试守着**（第六批靠逐张对参考才发现）。
//
// 能在本仓库内自洽的第二数据源只有一个：`sts-combat.ts` 的登记表。那张表的范围就是
// **铁甲 + 无色**（TODOS「二、内容铺量」：范围先限定铁甲 + 无色），所以「这张牌已登记」
// 本身就是一次独立的角色归属声明。两处一冲突必有一处错，而且冲突时先信登记表——
// 它的每一条都有 trace 背书，数据表的 `color` 没有。
//
// ⚠ 这条不变量的**射程**（不要以为它守住了整张卡表）：
//   * 挡得住：已登记的牌被记成 green / blue / purple（哨兵那一类）；以及已登记的牌
//     因 rarity 被记成 starter / special 而整个掉出奖励池。
//   * 挡不住：**尚未登记的 275 张牌**的 `color` 全无背书；已登记的牌在 red ↔ colorless
//     之间记错；common / uncommon / rare 三档之间记错。
//   随铺量推进，登记表越长这条的射程越大——全部铺完时它就覆盖了铁甲 + 无色全部 115 张。
//
// ⚠ 第十三批起登记表里出现了**不属于任何角色**的牌：状态牌黏液（`color: "status"`）。
//   状态/诅咒牌不进任何角色的奖励池，`color` 对它们不是「角色归属」而是分类标签，
//   所以这条不变量按 `type` 把它们排除在外——把 `"status"` / `"curse"` 直接并进允许集合
//   是不对的，那会让一张真的记错颜色的**角色牌**从此蒙混过关。
// ============================================================================

describe("卡表 · 颜色归属", () => {
  it("已登记游戏级行为的角色牌只能是 red 或 colorless", () => {
    for (const id of REGISTERED_CARD_IDS) {
      const def = getCardDef(id);
      // 状态牌 / 诅咒牌没有角色归属（黏液是唯一一张进了登记表的）。
      if (def.type === "status" || def.type === "curse") {
        expect(["status", "curse"], `${id} 是 ${def.type} 牌却记成 color=${def.color}`).toContain(
          def.color,
        );
        continue;
      }
      expect(
        ["red", "colorless"],
        `${id} 已在 sts-combat.ts 登记（迁移范围=铁甲+无色）却记成 color=${def.color}`,
      ).toContain(def.color);
    }
  });

  it("已登记的牌真的在自己颜色的奖励池里（starter / special 除外）", () => {
    // 与上一条互为夹逼：上一条挡「颜色落到范围外」，这一条挡「颜色在范围内、但 rarity
    // 把它踢出了奖励池」——那种错法颜色看着没问题，红池却照样少一张。
    for (const id of REGISTERED_CARD_IDS) {
      const def = getCardDef(id);
      // starter（打击/防御/猛击）与 special（撕咬 / 杰克斯 那类不可获得的牌）本就不进池。
      if (def.rarity === "starter" || def.rarity === "special") {
        continue;
      }
      expect(rewardCardPoolOf(def.color), `${id} 不在 ${def.color} 奖励池里`).toContain(id);
    }
  });
});

// ============================================================================
// 「升级会改变的属性」不变量。
//
// 参考项目把费用/消耗/指向性/固有全做成 f(id, upgraded)，我们的数据表则是「恒定字段
// + upgradedXxx 覆盖」。这组不变量守的是覆盖字段本身填错——它没有第二处数据可以对拍，
// 一旦填反（或该填而没填）就会被两代实现照着复现。
//
// 今天正是靠逐张对参考才发现：上勾拳费用 1（应为 2）、心灵冲击漏了固有、炸弹被标成消耗、
// 秘密武器/秘密技巧凭空多了保留、混乱/神化漏了升级降费、残暴漏了升级固有。
// ============================================================================

describe("卡表 · 升级相关属性", () => {
  /** 可升级判据取自参考 CardInstance::canUpgrade：status / curse 不可升级。 */
  const canUpgrade = (card: CardDef): boolean => card.type !== "status" && card.type !== "curse";

  it("升级相关字段只出现在可升级的牌上", () => {
    const upgradeOnly = [
      "upgradedCost",
      "upgradedExhausts",
      "upgradedTargeted",
      "upgradedInnate",
      "upgradedEthereal",
      "upgradedOnDiscard",
      "upgradedOnExhaust",
    ] as const;
    for (const card of ALL_CARDS) {
      if (canUpgrade(card)) {
        continue;
      }
      for (const field of upgradeOnly) {
        expect(card[field], `${card.id} 是 ${card.type} 却带着 ${field}`).toBeUndefined();
      }
    }
  });

  it("upgradedXxx 必须真的改变属性（同值即填错）", () => {
    for (const card of ALL_CARDS) {
      if (card.upgradedCost !== undefined) {
        expect(card.upgradedCost, `${card.id} 的 upgradedCost 与 cost 同值`).not.toBe(card.cost);
      }
      if (card.upgradedExhausts !== undefined) {
        expect(card.upgradedExhausts, `${card.id} 的 upgradedExhausts 与 exhausts 同值`).not.toBe(
          card.exhausts,
        );
      }
      if (card.upgradedTargeted !== undefined) {
        expect(card.upgradedTargeted, `${card.id} 的 upgradedTargeted 与 targeted 同值`).not.toBe(
          card.targeted,
        );
      }
      if (card.upgradedEthereal !== undefined) {
        expect(card.upgradedEthereal, `${card.id} 的 upgradedEthereal 与 ethereal 同值`).not.toBe(
          card.ethereal === true,
        );
      }
      if (card.upgradedInnate === true) {
        expect(card.innate, `${card.id} 本就固有，upgradedInnate 是多余的`).not.toBe(true);
      }
      // Effect[] 型的两个覆盖字段：结构相同即等于没填（同族的标量字段在上面逐个查过了）。
      for (const [over, base] of [
        ["upgradedOnDiscard", "onDiscard"],
        ["upgradedOnExhaust", "onExhaust"],
      ] as const) {
        if (card[over] === undefined) {
          continue;
        }
        expect(card[base], `${card.id} 有 ${over} 却没有 ${base}`).toBeDefined();
        expect(JSON.stringify(card[over]), `${card.id} 的 ${over} 与 ${base} 同值`).not.toBe(
          JSON.stringify(card[base]),
        );
      }
    }
  });

  it("upgradedTargeted 为 false 时，原形态必须需要目标", () => {
    // 致盲+/绊摔+ 那类「升级后改为对所有敌人」。原形态本就不指向的话这个字段没有意义。
    for (const card of ALL_CARDS) {
      if (card.upgradedTargeted === false) {
        expect(card.targeted, `${card.id} 升级后取消指向，但原形态也不指向`).toBe(true);
      }
    }
  });

  it("升级后效果从 target 变成 all_enemies 的牌，必须填 upgradedTargeted: false", () => {
    // 致盲 / 绊摔就是这一形状：漏填这个字段会让升级态还要求选一个活着的目标。
    const hasScope = (effects: readonly CardDef["effects"][number][], on: string): boolean =>
      effects.some((effect) => "on" in effect && effect.on === on);
    for (const card of ALL_CARDS) {
      const widened =
        hasScope(card.effects, "target") &&
        !hasScope(card.upgradedEffects, "target") &&
        hasScope(card.upgradedEffects, "all_enemies");
      if (widened) {
        expect(card.upgradedTargeted, `${card.id} 升级后改为全体，却没填 upgradedTargeted`).toBe(
          false,
        );
      }
    }
  });

  it('effects 里出现 on:"target" 的形态必须是指向性的', () => {
    // 与上一条互为夹逼：若把 upgradedTargeted 填成 false 却忘了把 upgradedEffects
    // 从 target 改成 all_enemies（或反之），这里当场失败。
    for (const card of ALL_CARDS) {
      for (const upgraded of [false, true]) {
        const effects = upgraded ? card.upgradedEffects : card.effects;
        if (!effects.some((effect) => "on" in effect && effect.on === "target")) {
          continue;
        }
        expect(
          targetedOf(card, upgraded),
          `${card.id}（升级=${String(upgraded)}）效果指向 target 却不是指向性牌`,
        ).toBe(true);
      }
    }
  });

  it("固有牌不是状态牌；诅咒里只有「扭曲」是固有的", () => {
    // 原版唯一的固有诅咒是扭曲（Writhe），参考 isCardInnate 也把 WRITHE 列为 true。
    const INNATE_CURSES = new Set(["writhe"]);
    for (const card of ALL_CARDS) {
      if (card.innate !== true && card.upgradedInnate !== true) {
        continue;
      }
      expect(card.type, `${card.id} 是状态牌却标了固有`).not.toBe("status");
      if (card.type === "curse") {
        expect(INNATE_CURSES, `${card.id} 是诅咒却标了固有`).toContain(card.id);
      }
    }
  });

  it("「固有」文案与 innate / upgradedInnate 双向一致", () => {
    // 心灵冲击漏 innate 正是文案里也没写「固有」——两边一起漏，所以这条只能挡住单侧漏填；
    // 真正的对拍在参考项目那边（isCardInnate），这里挡的是「改了一处忘改另一处」。
    const mentionsInnate = (text: string): boolean => /(^|。)固有(。|——)/.test(text);
    for (const card of ALL_CARDS) {
      expect(mentionsInnate(card.description), `${card.id} 卡面与 innate 不符`).toBe(
        card.innate === true,
      );
      expect(mentionsInnate(card.upgradedDescription), `${card.id} 升级卡面与固有不符`).toBe(
        card.innate === true || card.upgradedInnate === true,
      );
    }
  });

  it("升级文案写了「费用降为 N」就必须有对应的 upgradedCost", () => {
    for (const card of ALL_CARDS) {
      const matched = /^费用降为 (\d+)。/.exec(card.upgradedDescription);
      if (matched === null) {
        continue;
      }
      expect(card.upgradedCost, `${card.id} 文案写了降费却没有 upgradedCost`).toBe(
        Number(matched[1]),
      );
    }
  });

  it("描述写了「无法打出」的牌，cost 必须是 null", () => {
    for (const card of ALL_CARDS) {
      if (card.description.includes("无法打出")) {
        expect(card.cost, `${card.id} 文案说无法打出却有费用`).toBeNull();
      }
    }
  });

  // 卡面关键词 ↔ 布尔字段的夹逼。范围限定 red + colorless：这是 TODOS 里铺量的范围，
  // 也是本轮逐张对过参考的范围。其余颜色目前有 4 处已知不符（尚未审计，不在本轮范围）：
  //   deva_form（升级卡面写「消耗（升级）」，且 exhausts 疑为「虚无」误标）、
  //   slimed（原版是 1 费可打出的消耗牌，我们记成不可打出）、
  //   worship（原版是升级后才「保留」，缺 upgradedRetain 字段无法表达）、
  //   storm（原版没有「保留」）。
  // 审计到那些颜色时把 AUDITED_COLORS 放开即可。
  const AUDITED_COLORS = new Set<CardDef["color"]>(["red", "colorless"]);
  const auditedCards = ALL_CARDS.filter((card) => AUDITED_COLORS.has(card.color));

  it("「消耗」文案与实际消耗与否一致（含升级后不再消耗）", () => {
    // 本轮抓到的：炸弹凭空多了「消耗」，极限爆发+/发现+/未雨绸缪+/秘密武器+/秘密技巧+
    // 升级后不再消耗但卡面还写着「消耗」。
    for (const card of auditedCards) {
      const trailing = (text: string): boolean => /(^|。)消耗。$/.test(text);
      expect(trailing(card.description), `${card.id} 卡面与 exhausts 不符`).toBe(
        exhaustsOf(card, false),
      );
      expect(trailing(card.upgradedDescription), `${card.id} 升级卡面与消耗与否不符`).toBe(
        exhaustsOf(card, true),
      );
    }
  });

  it("「虚无」文案与 ethereal 一致（含升级后不再虚无）", () => {
    // 幻影+ 正是这一形状：加 upgradedEthereal 时忘了改升级卡面，这条当场失败。
    // ⚠ 只认句首的「虚无。」/「虚无——」，不能裸 /虚无/ ——「虚无缥缈」（INTANGIBLE）
    // 是另一个词，幻影自己的卡面里就有。
    const mentionsEthereal = (text: string): boolean => /(^|。)虚无(。|——)/.test(text);
    for (const card of auditedCards) {
      expect(mentionsEthereal(card.description), `${card.id} 卡面与 ethereal 不符`).toBe(
        etherealOf(card, false),
      );
      expect(mentionsEthereal(card.upgradedDescription), `${card.id} 升级卡面与虚无与否不符`).toBe(
        etherealOf(card, true),
      );
    }
  });

  it("「保留」文案与 retain 一致", () => {
    // 本轮抓到的：秘密武器 / 秘密技巧凭空多了「保留」（原版两张都没有）。
    const mentionsRetain = (text: string): boolean => /(^|。)保留。/.test(text);
    for (const card of auditedCards) {
      for (const text of [card.description, card.upgradedDescription]) {
        expect(mentionsRetain(text), `${card.id} 卡面与 retain 不符：${text}`).toBe(
          card.retain === true,
        );
      }
    }
  });

  it("取值器按 upgraded 走覆盖字段", () => {
    // sts-combat 的 useCard / playCard 就是靠这两个取值器读表的；它们要是退回读恒定字段，
    // 极限爆发+ 会被错误消耗、致盲+ 会被要求选一个活着的目标。
    expect(exhaustsOf(getCardDef("limit_break"), false)).toBe(true);
    expect(exhaustsOf(getCardDef("limit_break"), true)).toBe(false);
    expect(exhaustsOf(getCardDef("shiv"), true)).toBe(true); // 无覆盖字段 → 沿用 exhausts
    expect(targetedOf(getCardDef("blind"), false)).toBe(true);
    expect(targetedOf(getCardDef("blind"), true)).toBe(false);
    expect(targetedOf(getCardDef("trip"), true)).toBe(false);
    expect(targetedOf(getCardDef("strike"), true)).toBe(true); // 无覆盖字段 → 沿用 targeted
    expect(etherealOf(getCardDef("apparition"), false)).toBe(true);
    expect(etherealOf(getCardDef("apparition"), true)).toBe(false);
    expect(etherealOf(getCardDef("carnage"), true)).toBe(true); // 无覆盖字段 → 沿用 ethereal
    expect(etherealOf(getCardDef("strike"), false)).toBe(false); // 没有 ethereal 位 → false
  });

  it("effects 与 upgradedEffects 的「空 / 非空」一致", () => {
    // 有 effects 却漏写 upgradedEffects 的牌升级后会变成空牌。
    for (const card of ALL_CARDS) {
      expect(
        card.upgradedEffects.length === 0,
        `${card.id} 的 effects 与 upgradedEffects 一个空一个非空`,
      ).toBe(card.effects.length === 0);
    }
  });
});

describe("遗物表", () => {
  it("id 唯一，名称/描述非空", () => {
    const ids = ALL_RELICS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const relic of ALL_RELICS) {
      expect(getRelicDef(relic.id)).toBe(relic);
      expect(relic.name.length).toBeGreaterThan(0);
      expect(relic.description.length).toBeGreaterThan(0);
    }
  });

  it("各池非空、无重复，且 rarity 与池归属一致", () => {
    for (const character of CHARACTERS) {
      for (const [label, pool, allowed] of [
        ["奖励", rewardRelicPool(character), ["common", "uncommon", "rare"]],
        ["商店", shopRelicPool(character), ["common", "uncommon", "rare", "shop"]],
        ["首领", bossRelicPool(character), ["boss"]],
      ] as const) {
        expect(pool.length, `${character} 的${label}池为空`).toBeGreaterThan(0);
        expect(new Set(pool).size, `${character} 的${label}池有重复`).toBe(pool.length);
        for (const id of pool) {
          const def = getRelicDef(id);
          expect(allowed, `${id} 不该进${label}池`).toContain(def.rarity);
          // 角色专属遗物不该出现在别人的池里。
          if (def.characterLock !== undefined) {
            expect(def.characterLock, `${id} 串进了 ${character} 的${label}池`).toBe(character);
          }
        }
      }
    }
  });

  it("starter 遗物不进任何掉落池", () => {
    for (const character of CHARACTERS) {
      const pools = [
        ...rewardRelicPool(character),
        ...shopRelicPool(character),
        ...bossRelicPool(character),
      ];
      for (const id of pools) {
        expect(getRelicDef(id).rarity, `${id} 是起始遗物却在池里`).not.toBe("starter");
      }
    }
  });
});

describe("药水表", () => {
  it("id 唯一，名称/描述非空", () => {
    const ids = ALL_POTIONS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const potion of ALL_POTIONS) {
      expect(getPotionDef(potion.id)).toBe(potion);
      expect(potion.name.length).toBeGreaterThan(0);
      expect(potion.description.length).toBeGreaterThan(0);
    }
  });

  it("稀有度分池：三档都非空、无重复，且档位与定义一致", () => {
    // 这一条正是当年 3 处稀有度写错却没人发现的地方。
    for (const rarity of ["common", "uncommon", "rare"] as const) {
      for (const character of CHARACTERS) {
        const pool = potionPoolOfRarity(rarity, character);
        expect(pool.length, `${character} 的 ${rarity} 药水池为空`).toBeGreaterThan(0);
        expect(new Set(pool).size, `${character} 的 ${rarity} 药水池有重复`).toBe(pool.length);
        for (const id of pool) {
          expect(getPotionDef(id).rarity, `${id} 档位不符`).toBe(rarity);
        }
      }
    }
  });

  it("角色专属药水不串池", () => {
    for (const character of CHARACTERS) {
      for (const id of shopPotionPool(character)) {
        const lock = getPotionDef(id).characterLock;
        if (lock !== undefined) {
          expect(lock, `${id} 串进了 ${character} 的商店池`).toBe(character);
        }
      }
    }
  });

  it("指向性药水必然只在战斗内可用", () => {
    for (const potion of ALL_POTIONS) {
      if (potion.targeted) {
        expect(potion.combatOnly, `${potion.id} 需要目标却允许战斗外使用`).toBe(true);
      }
    }
  });
});

describe("敌人与编队表", () => {
  it("编队引用的敌人都存在，HP 区间合法，且至少一招", () => {
    // 编队表是 sts-combat 建怪的输入：hpMin/hpMax 写错会让 monsterHpRng 抽出错的血量，
    // 逐位对齐当场失效。
    for (const id of ["cultist", "jaw_worm", "two_louse", "three_louse", "jaw_worm_horde"]) {
      const encounter = getEncounterDef(id);
      expect(encounter.enemies.length, `${id} 没有成员`).toBeGreaterThan(0);
      for (const defId of encounter.enemies) {
        const def = getEnemyDef(defId);
        expect(def.hpMin, `${defId} HP 下限非正`).toBeGreaterThan(0);
        expect(def.hpMax, `${defId} HP 区间反了`).toBeGreaterThanOrEqual(def.hpMin);
        expect(def.moves.length, `${defId} 没有招式`).toBeGreaterThan(0);
      }
    }
  });

  // 第二十一批：爬升度分档。这两条守的是「半填」——`ascCalibrated` 与 `hpHigh` 必须同进同退，
  // 只填一个会让 `constructMonster` 放行一只其实没校准的怪（或反过来，抛掉一只已校准的）。
  //
  // ⚠ 第二十二批把值从「一律 7」改成**逐怪的期望阈值**：`Monster::initHp`
  //（MonsterSpecific.cpp:26-128）里普通怪是 `asc>=7`、精英 `asc>=8`、Boss `asc>=9`，
  //   三档在同一个 switch 里并排写着。写死 7 的话，精英/Boss 抄错阈值不会被任何东西发现。
  const ASC_CALIBRATED: Record<string, number> = {
    cultist: 7,
    jaw_worm: 7,
    louse: 7,
    green_louse: 7,
    acid_slime_s: 7,
    acid_slime_m: 7,
    acid_slime_l: 7,
    spike_slime_s: 7,
    spike_slime_m: 7,
    spike_slime_l: 7,
    blue_slaver: 7,
    red_slaver: 7,
    looter: 7,
    fungi_beast: 7,
    mad_gremlin: 7,
    sneaky_gremlin: 7,
    fat_gremlin: 7,
    shield_gremlin: 7,
    gremlin_wizard: 7,
    // —— 第二十二批：三个精英（MonsterSpecific.cpp:91-102）——
    gremlin_nob: 8,
    lagavulin: 8,
    sentry: 8,
    // —— 第二十二批：三个 Boss（MonsterSpecific.cpp:76-89）——
    the_guardian: 9,
    slime_boss: 9,
    hexaghost: 9,
  };

  it("已校准爬升度的敌人都带第二组血量区间，且区间合法", () => {
    for (const [id, atLeast] of Object.entries(ASC_CALIBRATED)) {
      const def = getEnemyDef(id);
      expect(def.ascCalibrated, `${id} 没有标 ascCalibrated`).toBe(true);
      const high = def.hpHigh;
      expect(high, `${id} 标了 ascCalibrated 却没有 hpHigh`).toBeDefined();
      if (high === undefined) continue;
      // 阈值只可能是 7 / 8 / 9（Monster::initHp 的三档），逐怪对表。
      expect(high.atLeast, `${id} 的 hpHigh.atLeast 抄错了档`).toBe(atLeast);
      expect(high.hpMin, `${id} 的高档 HP 下限非正`).toBeGreaterThan(0);
      expect(high.hpMax, `${id} 的高档 HP 区间反了`).toBeGreaterThanOrEqual(high.hpMin);
      // 参考的第二组恒不低于第一组（爬升度只会让怪更硬）。
      expect(high.hpMin, `${id} 的高档下限比低档还低`).toBeGreaterThanOrEqual(def.hpMin);
      expect(high.hpMax, `${id} 的高档上限比低档还低`).toBeGreaterThanOrEqual(def.hpMax);
    }
  });

  it("没标 ascCalibrated 的敌人不许带 hpHigh（半填会静默放行）", () => {
    // 抽查几只**第一幕之外**、按 WORKFLOW 短期内不会被校准的：harness 的 20 个编队跑满了
    // 第一幕，第二 / 三幕的怪要等 harness 追加一遍循环才有预言机。
    // ⚠ 别再拿三精英 / 三 Boss 当样本——第二十二批把它们全校准了。
    for (const id of [
      "centurion",
      "book_of_stabbing",
      "byrd",
      "snecko",
      "champ",
      "the_collector",
    ]) {
      expect(ASC_CALIBRATED[id], `${id} 不该在已校准名单里`).toBeUndefined();
      const def = getEnemyDef(id);
      expect(def.ascCalibrated ?? false, `${id} 不该标 ascCalibrated`).toBe(false);
      expect(def.hpHigh, `${id} 没标 ascCalibrated 却带了 hpHigh`).toBeUndefined();
    }
  });

  // 第二十三批：`hpNoRoll`。它是**不掷 monsterHpRng** 的开关，写错的代价是此后每一次
  // monsterHpRng 取值整体错位（不是「血量差一点」）。参考里只有三只怪走那条 case
  //（`Monster::initHp`，MonsterSpecific.cpp:119-124）：球状守卫者 / 大嘴 / 复形怪。
  // ⚠ 反方向同样要守：`{240,240}` 的守卫者**照样掷一次**，所以「上下界相同」不是判据。
  const HP_NO_ROLL = new Set(["spheric_guardian"]);

  it("只有 initHp 里那条不掷 RNG 的怪才带 hpNoRoll", () => {
    for (const def of ALL_ENEMIES) {
      const expected = HP_NO_ROLL.has(def.id);
      expect(def.hpNoRoll ?? false, `${def.id} 的 hpNoRoll 与名单不符`).toBe(expected);
      if (expected) {
        // 那条 case 取的是 `monsterHpRange[id][0][0]`，即区间下界；上下界相同才说明
        // 数据表里那个「区间」其实只是一个定值。
        expect(def.hpMax, `${def.id} 不掷 RNG 却有一个真区间`).toBe(def.hpMin);
        // 它也不看爬升度，所以第二组区间没有意义。
        expect(def.hpHigh, `${def.id} 不掷 RNG，hpHigh 没有意义`).toBeUndefined();
      }
    }
    // 守卫者是那条「上下界相同但照样掷一次」的反例，必须**不**在名单里。
    expect(HP_NO_ROLL.has("the_guardian")).toBe(false);
    expect(getEnemyDef("the_guardian").hpMin).toBe(getEnemyDef("the_guardian").hpMax);
  });

  it("意图规则只引用本敌人有的招式", () => {
    for (const id of ["cultist", "jaw_worm", "louse", "green_louse"]) {
      const def = getEnemyDef(id);
      const moveIds = new Set(def.moves.map((m) => m.id));
      for (const move of def.intentRule.scripted) {
        expect(moveIds, `${id} 的脚本招式 ${move} 不存在`).toContain(move);
      }
      for (const entry of def.intentRule.weighted) {
        expect(moveIds, `${id} 的加权招式 ${entry.move} 不存在`).toContain(entry.move);
      }
    }
  });
});

describe("事件表", () => {
  it("id 唯一，每个事件都有选项且文案非空", () => {
    const ids = ALL_EVENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const event of ALL_EVENTS) {
      expect(getEventDef(event.id)).toBe(event);
      expect(event.choices.length, `${event.id} 没有选项`).toBeGreaterThan(0);
      for (const choice of event.choices) {
        expect(choice.label.length, `${event.id} 有空标签`).toBeGreaterThan(0);
      }
    }
  });
});
