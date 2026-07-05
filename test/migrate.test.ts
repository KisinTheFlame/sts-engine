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
  });

  it("回填战斗内充能球 / 姿态（defect 有 3 槽）", () => {
    const migrated = migrateLoadedState({
      runId: "r",
      seed: 1,
      character: "defect",
      combat: { enemies: [] },
    });
    expect(migrated.combat?.orbs).toEqual([]);
    expect(migrated.combat?.orbSlots).toBe(3);
    expect(migrated.combat?.playerStance).toBe("none");
    expect(migrated.combat?.mantra).toBe(0);
  });

  it("回填敌人后加字段（复活 / 分裂标记）", () => {
    const migrated = migrateLoadedState({
      runId: "r",
      seed: 1,
      combat: { enemies: [{ id: "cultist", hp: 10 }] },
    });
    const enemy = migrated.combat?.enemies[0] as Record<string, unknown>;
    expect(enemy.hasRevived).toBe(false);
    expect(enemy.hasSplit).toBe(false);
    expect(enemy.powers).toEqual([]);
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
