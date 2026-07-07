import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateEncounters, MonsterEncounter } from "../src/engine/sts-encounters.js";

type GoldenAct = {
  act: number;
  monsters: number[];
  elites: number[];
  boss: number;
  secondBoss: number;
};
type GoldenEnc = { seed: string; seedLong: string; acts: GoldenAct[]; counterAfter: number };

const goldenPath = fileURLToPath(new URL("./golden/encounters.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { encounters: GoldenEnc[] };

describe("sts-encounters 遭遇序列对拍 C++ 黄金向量", () => {
  for (const g of golden.encounters) {
    it(`seed "${g.seed}" 三幕怪物/精英/boss`, () => {
      const acts = generateEncounters(g.seed);
      const asNums = acts.map((a) => ({
        act: a.act,
        monsters: a.monsters.map((m) => m as number),
        elites: a.elites.map((m) => m as number),
        boss: a.boss as number,
        // 黄金里 INVALID=0 表示无第二 boss；TS 用 null，比对时归一。
        secondBoss: a.secondBoss === null ? 0 : (a.secondBoss as number),
      }));
      expect(asNums).toEqual(g.acts);
    });
  }

  it("act1 有 16 个遭遇（3 弱 + 1+12 强），其余幕 15 个", () => {
    const acts = generateEncounters(golden.encounters[0]!.seed);
    expect(acts[0]!.monsters.length).toBe(16);
    expect(acts[1]!.monsters.length).toBe(15);
    expect(acts[2]!.monsters.length).toBe(15);
    expect(acts[0]!.elites.length).toBe(10);
  });

  it("boss 落在对应幕的 boss 集合内", () => {
    const acts = generateEncounters(golden.encounters[1]!.seed);
    expect([
      MonsterEncounter.THE_GUARDIAN,
      MonsterEncounter.HEXAGHOST,
      MonsterEncounter.SLIME_BOSS,
    ]).toContain(acts[0]!.boss);
  });

  it("string 与 bigint 入参一致", () => {
    const g = golden.encounters[0]!;
    expect(generateEncounters(BigInt(g.seedLong))).toEqual(generateEncounters(g.seed));
  });
});
