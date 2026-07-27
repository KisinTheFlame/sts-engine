import { describe, expect, it } from "vitest";
import { migrateLoadedState } from "../src/migrate.js";

// migrateLoadedState 的纯单测：只验证回填逻辑本身（不依赖 SaveStore / toScreenView / 契约，
// 那条端到端集成路径由 kagami 侧 save-migrate.test 覆盖）。
describe("migrateLoadedState", () => {
  it("回填顶层后加字段的默认值", () => {
    const migrated = migrateLoadedState({ runId: "r", seed: 1 });
    expect(migrated.character).toBe("ironclad");
    expect(migrated.ascension).toBe(0);
    expect(migrated.act).toBe(1);
    expect(migrated.potions).toEqual([null, null, null]);
    expect(migrated.combatsEntered).toBe(0);
    expect(migrated.pendingRelicReward).toBe(false);
    expect(migrated.floorNum).toBe(0);
    expect(migrated.combat).toBeNull();
    expect(migrated.stsPotionRng).toBeNull();
  });

  it("种子从 number 升为 int64 十进制字符串", () => {
    expect(migrateLoadedState({ runId: "r", seed: 12345 }).seed).toBe("12345");
    expect(migrateLoadedState({ runId: "r", seed: "999" }).seed).toBe("999");
  });

  it("0.16.0 的档：游戏级战斗从 stsCombat 平移到 combat", () => {
    const snapshot = { encounterId: "cultist", turn: 2 };
    const migrated = migrateLoadedState({
      runId: "r",
      seed: 1,
      screen: "combat",
      combatEngine: "sts",
      combat: null,
      stsCombat: snapshot,
    }) as unknown as Record<string, unknown>;
    expect(migrated["combat"]).toEqual(snapshot);
    expect(migrated["screen"]).toBe("combat");
    // 二选一的开关随近似实现一起删了，不该留在档里。
    expect(migrated["combatEngine"]).toBeUndefined();
    expect(migrated["stsCombat"]).toBeUndefined();
  });

  it("近似战斗的老档：那一场作废，回到地图继续爬", () => {
    // 近似战斗的形状（enemies/playerPowers…）与游戏级快照不兼容，无法平移。
    const migrated = migrateLoadedState({
      runId: "r",
      seed: 1,
      screen: "combat",
      combat: { enemies: [{ id: "cultist", hp: 10 }], playerBlock: 5 },
    });
    expect(migrated.combat).toBeNull();
    expect(migrated.screen).toBe("map");
  });

  it("战斗中的老档回填选牌屏三字段（老档必然停在 player_normal 且队列为空）", () => {
    const migrated = migrateLoadedState({
      runId: "r",
      seed: 1,
      screen: "combat",
      combat: { encounterId: "cultist", turn: 2, hand: [] },
    });
    expect(migrated.combat).toMatchObject({
      inputState: "player_normal",
      cardSelect: null,
      pendingActions: [],
    });
  });

  it("已经停在选牌屏的档不被回填覆盖", () => {
    const cardSelect = { task: "exhaust_one", pickCount: 1 };
    const pendingActions = [{ kind: "draw_cards", count: 2 }];
    const migrated = migrateLoadedState({
      runId: "r",
      seed: 1,
      screen: "combat",
      combat: { encounterId: "cultist", inputState: "card_select", cardSelect, pendingActions },
    });
    expect(migrated.combat).toMatchObject({
      inputState: "card_select",
      cardSelect,
      pendingActions,
    });
  });

  it("战斗中的老档回填卡牌实例级状态（cost / costForTurn / specialData）", () => {
    // 第七批加的三个逐实例字段。回填是无损的：能改写它们的牌（血债血偿 / 疯狂 / 腐化 /
    // 暴走 / 灼热之刃）当时一张都没登记，所以老档里每张牌都还是数据表播种的初值。
    const migrated = migrateLoadedState({
      runId: "r",
      seed: 1,
      screen: "combat",
      combat: {
        encounterId: "cultist",
        hand: [{ uid: 1, defId: "strike", upgraded: false }],
        // 状态牌的 -2 哨兵（参考 getEnergyCost 对 WOUND 就是 -2）不能被规整成 0，
        // 否则腐化/疯狂会去动一张伤口的费用。
        drawPile: [{ uid: 2, defId: "wound", upgraded: false }],
        // 升级降费的牌必须回填**升级后**的费用。
        discardPile: [{ uid: 3, defId: "seeing_red", upgraded: true }],
        exhaustPile: [],
        pendingActions: [
          {
            kind: "after_use_card",
            card: { uid: 4, defId: "burning_pact", upgraded: false },
            exhaustOnUse: false,
          },
        ],
      },
    });
    const combat = migrated.combat!;
    expect(combat.hand[0]).toEqual({
      uid: 1,
      defId: "strike",
      upgraded: false,
      cost: 1,
      costForTurn: 1,
      specialData: 0,
    });
    expect(combat.drawPile[0]).toMatchObject({ cost: -2, costForTurn: -2 });
    expect(combat.discardPile[0]).toMatchObject({ cost: 0, costForTurn: 0 });
    expect(combat.pendingActions[0]).toMatchObject({
      card: { uid: 4, cost: 1, costForTurn: 1, specialData: 0 },
    });
  });

  it("不在战斗中的老档不动 screen", () => {
    const migrated = migrateLoadedState({ runId: "r", seed: 1, screen: "shop", combat: null });
    expect(migrated.screen).toBe("shop");
  });

  it("不覆盖已有值（只在 undefined 时填）", () => {
    const migrated = migrateLoadedState({ runId: "r", seed: 1, act: 3, ascension: 15 });
    expect(migrated.act).toBe(3);
    expect(migrated.ascension).toBe(15);
  });

  it("坏档（非对象）原样交回上层", () => {
    expect(migrateLoadedState(null)).toBeNull();
    expect(migrateLoadedState(42)).toBe(42);
  });
});
