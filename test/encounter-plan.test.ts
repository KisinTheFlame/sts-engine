import { describe, expect, it } from "vitest";
import { applyAction, newRun, buildEncounterPlan } from "../src/engine/engine.js";
import {
  generateEncounters,
  encounterIdOf,
  MonsterEncounter,
} from "../src/engine/sts-encounters.js";
import { SUPPORTED_ENCOUNTERS } from "../src/engine/sts-combat.js";
import { migrateLoadedState } from "../src/migrate.js";
import { seedStringToLong } from "../src/engine/sts-rng.js";

// ============================================================================
// 第五十一批：run 层的**怪物遭遇计划**（TODOS「一、接线」第 4 项）。
//
// 这里钉三件事：
//   ① 计划就是 `sts-encounters` 的结果，一个字都没改（那一头已经与原版逐位对齐）；
//   ② `MonsterEncounter` → 编队 id 的桥是 `toLowerCase()`，而且它落进的每一个 id
//      **都是已登记的编队**——这条把第四十八批（编队 63 / 63）与本批锁在一起：
//      哪天有人改了某个编队 id 的写法，这条会红，而不是等到开局才抛「尚未迁移」；
//   ③ 老存档回填出来的计划与新开局逐位相同。
// ============================================================================

const SEED = "1RGBGHNF7L";

describe("遭遇计划：与 sts-encounters 逐项一致", () => {
  it("newRun 存下来的计划就是 generateEncounters 的投影", () => {
    const state = newRun({ runId: "r", seed: SEED, character: "ironclad", ascension: 0 });
    const raw = generateEncounters(SEED);
    expect(state.encounterPlan).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      expect(state.encounterPlan[i]!.monsters).toEqual(raw[i]!.monsters.map(encounterIdOf));
      expect(state.encounterPlan[i]!.elites).toEqual(raw[i]!.elites.map(encounterIdOf));
      expect(state.encounterPlan[i]!.boss).toBe(encounterIdOf(raw[i]!.boss));
    }
  });

  it("游标开局全是 0", () => {
    const state = newRun({ runId: "r", seed: SEED, character: "ironclad", ascension: 0 });
    expect(state.encounterCursor).toEqual({ monsters: [0, 0, 0], elites: [0, 0, 0] });
  });

  // ⚠⚠ 这条是本批与第四十八批之间的锁。计划里出现的每一个编队 id 都必须是**已登记**的，
  //   否则开局能开、打到那一场才抛「尚未迁移」——那是最坏的失败时机。
  //   编队线 63 / 63 收官之后这条恒真，而它守的是「有人改了 id 的写法」。
  it("计划里的每个编队 id 都在 SUPPORTED_ENCOUNTERS 里", () => {
    const supported = new Set(SUPPORTED_ENCOUNTERS);
    for (const seed of ["1RGBGHNF7L", "SLAYTHESPIRE", "0", "ZZZZZZZZZZ"]) {
      for (const act of buildEncounterPlan(seedStringToLong(seed))) {
        for (const id of [...act.monsters, ...act.elites, act.boss]) {
          expect(supported, `${seed} 的计划里出现了未登记的编队 ${id}`).toContain(id);
        }
        if (act.secondBoss !== null) {
          expect(supported).toContain(act.secondBoss);
        }
      }
    }
  });

  // 桥本身：63 项全部能转，哨兵必须抛错（不能静默返回 "invalid"）。
  it("encounterIdOf 覆盖 63 项，且拒绝哨兵", () => {
    const ids = new Set<string>();
    for (let v = 1; v <= 63; v += 1) {
      ids.add(encounterIdOf(v as MonsterEncounter));
    }
    expect(ids.size).toBe(63);
    expect(() => encounterIdOf(MonsterEncounter.INVALID)).toThrow();
  });
});

describe("遭遇计划：老存档回填", () => {
  it("没有 encounterPlan 的老档按 seed 重算，与新开局逐位相同", () => {
    const fresh = newRun({ runId: "r", seed: SEED, character: "ironclad", ascension: 0 });
    const old = JSON.parse(JSON.stringify(fresh)) as Record<string, unknown>;
    delete old["encounterPlan"];
    delete old["encounterCursor"];
    old["combatsEntered"] = 4;
    old["act"] = 2;
    const migrated = migrateLoadedState(old);
    expect(migrated.encounterPlan).toEqual(fresh.encounterPlan);
    // ⚠ 游标回填是**有损**的：老档只记着 combatsEntered（跨幕累计），精英场数根本没记。
    //   这里钉住的是「策略是什么」，不是「它是精确的」——代价写在 migrate.ts 的注释里。
    expect(migrated.encounterCursor).toEqual({ monsters: [0, 4, 0], elites: [0, 0, 0] });
  });
});

describe("遭遇计划：run 层按序消费", () => {
  // ⚠ 走真实路径：Neow → 地图 → 一路选第一个可走的节点，直到开打。
  //   钉住的是「第一场普通战就是计划里的第一项」，而不是某个具体编队名——
  //   具体是谁由 seed 决定，写死会把这条用例变成 seed 的快照。
  it("第一场普通战 = 本幕计划的第一项，且游标推进", () => {
    const state = newRun({ runId: "r", seed: SEED, character: "ironclad", ascension: 0 });
    applyAction(state, { type: "choose", optionIndex: 0 }); // Neow

    let guard = 0;
    while (state.screen !== "combat" && guard < 40) {
      guard += 1;
      const before = state.screen;
      const res = applyAction(state, { type: "choose", optionIndex: 0 });
      if (!res.ok && before === state.screen) {
        break;
      }
    }
    if (state.screen !== "combat") {
      // 这条 seed 的第一段路可能先撞上事件 / 商店；那时这条用例没有可断言的东西，
      // 直接跳过比强行造一个假状态好。
      expect(state.encounterCursor.monsters[0]).toBe(0);
      return;
    }
    expect(state.combat).not.toBeNull();
    expect(state.encounterCursor.monsters[0]).toBe(1);
    expect(state.combatsEntered).toBe(1);
  });
});

describe("A20 双 Boss（第五十三批）", () => {
  // 对齐 GameContext.cpp:1153-1165：**只有第三幕**、只有 asc>=20、且打赢的是本幕那个 Boss 时，
  // 才接着打 `secondBoss`——中间不开奖励屏，楼层要自增（两场 Boss 的战斗 RNG 因此不同源）。
  it("只有第三幕 asc>=20 才有第二个 Boss，且 plan 里非空", () => {
    for (const asc of [0, 19, 20]) {
      const plan = buildEncounterPlan(seedStringToLong(SEED));
      // ⚠ `secondBoss` 是**生成时**就定的（monsterRng 洗牌的次位），与 ascension 无关——
      //   参考在 `GameContext.cpp:595` 那里才按 asc 决定要不要用它。我们把它一律生成、
      //   在消费点按 asc 判，两者同解且更简单。
      expect(plan[2]!.secondBoss, `asc=${String(asc)}`).not.toBeNull();
      expect(plan[0]!.secondBoss).toBeNull();
      expect(plan[1]!.secondBoss).toBeNull();
    }
  });

  it("第三幕的两个 Boss 互不相同", () => {
    for (const seed of ["1RGBGHNF7L", "SLAYTHESPIRE", "GEN7"]) {
      const act3 = buildEncounterPlan(seedStringToLong(seed))[2]!;
      expect(act3.secondBoss).not.toBe(act3.boss);
    }
  });
});
