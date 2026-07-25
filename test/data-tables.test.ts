import { describe, expect, it } from "vitest";
import { ALL_CARDS, cardPoolOf, getCardDef, rewardCardPoolOf } from "../src/engine/cards/cards.js";
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
import { ALL_EVENTS, getEventDef } from "../src/engine/events/events.js";
import { getEnemyDef, getEncounterDef } from "../src/engine/enemies/enemies.js";
import type { CharacterId } from "../src/engine/types.js";

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
