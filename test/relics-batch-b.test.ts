import { describe, expect, it } from "vitest";
import { newRun } from "../src/engine/engine.js";
import { startCombat } from "../src/engine/combat/combat.js";
import { grantRelic } from "../src/engine/relics/relics.js";
import { getPower } from "../src/engine/powers/powers.js";
import {
  generateReward,
  currentOptions,
  applyChoose,
  openTreasureChest,
} from "../src/engine/run/run.js";
import type { CharacterId, GameState } from "../src/engine/types.js";

// 补全批次 B：奖励 / 篝火 / 宝箱时点遗物。

function run(character: CharacterId = "ironclad"): GameState {
  return newRun({ runId: "bb", seed: 7, character });
}

describe("问号卡 / 祈祷之轮：额外卡奖励", () => {
  it("问号卡：普通战奖励 4 张", () => {
    const s = run();
    grantRelic(s, "question_card");
    s.screen = "combat";
    generateReward(s);
    expect(s.reward!.cardChoices.length).toBe(4);
  });
  it("祈祷之轮：普通战 +1，精英战不加", () => {
    const s = run();
    grantRelic(s, "prayer_wheel");
    s.screen = "combat";
    generateReward(s);
    expect(s.reward!.cardChoices.length).toBe(4);
    const s2 = run();
    grantRelic(s2, "prayer_wheel");
    s2.screen = "combat";
    s2.pendingRelicReward = true; // 精英
    generateReward(s2);
    expect(s2.reward!.cardChoices.length).toBe(3);
  });
});

describe("唱钵：放弃卡换 +2 最大生命", () => {
  it("奖励屏出现唱钵选项，选择后 +2 最大生命", () => {
    const s = run();
    grantRelic(s, "singing_bowl");
    s.screen = "combat";
    generateReward(s);
    const opts = currentOptions(s);
    const bowlIdx = opts.findIndex((o) => o.includes("唱钵"));
    expect(bowlIdx).toBeGreaterThan(0);
    const maxHp0 = s.maxHp;
    expect(applyChoose(s, bowlIdx).ok).toBe(true);
    expect(s.maxHp).toBe(maxHp0 + 2);
  });
});

describe("白兽雕像：药水必掉", () => {
  it("空槽必得药水", () => {
    const s = run();
    grantRelic(s, "white_beast_statue");
    s.potions = [null, null, null];
    s.screen = "combat";
    generateReward(s);
    expect(s.potions.some((p) => p !== null)).toBe(true);
  });
});

describe("黑洞之星：精英掉 2 遗物", () => {
  it("精英奖励发 2 个遗物", () => {
    const s = run();
    grantRelic(s, "black_star");
    const relicCount0 = s.relics.length;
    s.screen = "combat";
    s.pendingRelicReward = true;
    generateReward(s);
    // 黑洞之星本身 + 2 个新遗物；至少 +2
    expect(s.relics.length).toBeGreaterThanOrEqual(relicCount0 + 2);
  });
});

describe("壮力手环：篝火举重 + 战斗施加力量", () => {
  it("举重 1 次 → 战斗开始 +1 力量", () => {
    const s = run();
    grantRelic(s, "girya");
    s.screen = "rest";
    const opts = currentOptions(s);
    const liftIdx = opts.findIndex((o) => o.includes("举重"));
    expect(liftIdx).toBeGreaterThan(0);
    expect(applyChoose(s, liftIdx).ok).toBe(true);
    startCombat(s, "cultist");
    expect(getPower(s.combat!.playerPowers, "strength")).toBe(1);
  });
  it("至多举 3 次，第 4 次无该选项", () => {
    const s = run();
    grantRelic(s, "girya");
    const girya = s.relics.find((r) => r.id === "girya")!;
    girya.counter = 3;
    s.screen = "rest";
    expect(currentOptions(s).some((o) => o.includes("举重"))).toBe(false);
  });
});

describe("铁铲：篝火挖遗物", () => {
  it("挖掘获得一个遗物", () => {
    const s = run();
    grantRelic(s, "shovel");
    const n0 = s.relics.length;
    s.screen = "rest";
    const digIdx = currentOptions(s).findIndex((o) => o.includes("挖掘"));
    expect(digIdx).toBeGreaterThan(0);
    expect(applyChoose(s, digIdx).ok).toBe(true);
    expect(s.relics.length).toBe(n0 + 1);
  });
});

describe("织梦者：休息附带卡奖励", () => {
  it("休息后进入奖励屏", () => {
    const s = run();
    grantRelic(s, "dream_catcher");
    s.screen = "rest";
    s.hp = 1;
    expect(applyChoose(s, 0).ok).toBe(true); // 休息
    expect(s.screen).toBe("reward");
    expect(s.reward!.cardChoices.length).toBeGreaterThan(0);
  });
});

describe("古董茶具：休息后战斗首回合 +2 能量", () => {
  it("休息 → 下场战斗 +2 能量", () => {
    const s = run();
    grantRelic(s, "ancient_tea_set");
    s.screen = "rest";
    applyChoose(s, 0); // 休息，设置 counter
    startCombat(s, "cultist");
    expect(s.combat!.energy).toBe(5); // 基础 3 + 2
  });
  it("未休息则不加", () => {
    const s = run();
    grantRelic(s, "ancient_tea_set");
    startCombat(s, "cultist");
    expect(s.combat!.energy).toBe(3);
  });
});

describe("俄罗斯套娃：前 2 个宝箱各额外 1 遗物", () => {
  it("开箱额外发遗物，2 次后耗尽", () => {
    const s = run();
    grantRelic(s, "matryoshka");
    const m = s.relics.find((r) => r.id === "matryoshka")!;
    expect(m.counter).toBe(2);
    const n0 = s.relics.length;
    openTreasureChest(s);
    // 宝箱本体 1 + 套娃额外 1 = +2
    expect(s.relics.length).toBe(n0 + 2);
    expect(m.counter).toBe(1);
    openTreasureChest(s);
    expect(m.counter).toBe(0);
    const n2 = s.relics.length;
    openTreasureChest(s);
    // 第 3 箱只给本体 +1
    expect(s.relics.length).toBe(n2 + 1);
  });
});
