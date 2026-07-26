import fs from "node:fs";
import path from "node:path";

// 统计每张卡在 trace 里**实际被打出**多少次，未升级 / 已升级分栏。
//
// 为什么必须有这一步：把卡加进 harness 的牌组**不等于**验证了它。策略只打手牌最左侧的
// 可打出牌，所以一张卡完全可以躺在牌组里一次没被打出。打出 0 次 = 有规则、没预言机，
// 是本项目明确不接受的状态（见 TODOS「登记了不等于有背书」）。
//
// 用法:
//   node tools/check-coverage.mjs <trace目录>                    # 只打印
//   node tools/check-coverage.mjs <trace目录> NAME1 NAME2 ...    # 断言这些牌两栏都非 0
//
// NAME 用**参考项目的枚举名**（trace 里就是这个），例如 UPPERCUT、DEMON_FORM。
// 有任一为 0 时以退出码 1 结束。
const [dir, ...required] = process.argv.slice(2);
if (dir === undefined) {
  console.error("用法: node tools/check-coverage.mjs <trace目录> [必须非零的枚举名...]");
  process.exit(2);
}

const plain = new Map();
const upgraded = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const t = JSON.parse(line);
    // 全升级牌组里打出的牌就是升级实例。牌堆快照只记名字，没有逐实例的升级标记，
    // 但 variant 级的归属就够用了——那正是区分一条规则两个分支的东西。
    const upgradedVariant = t.deckUpgraded !== undefined;
    let hand = t.initial.hand;
    for (const step of t.steps) {
      if (step.action.type === "card") {
        const name = hand[step.action.idx];
        if (name !== undefined) bump(upgradedVariant ? upgraded : plain, name);
      }
      hand = step.after.hand;
    }
  }
}

const all = [...new Set([...plain.keys(), ...upgraded.keys()])].sort();
console.log("打出次数".padEnd(24) + "未升级".padStart(8) + "已升级".padStart(10));
for (const name of all) {
  console.log(
    name.padEnd(24) +
      String(plain.get(name) ?? 0).padStart(8) +
      String(upgraded.get(name) ?? 0).padStart(10),
  );
}

if (required.length === 0) process.exit(0);

const missing = required.filter((w) => (plain.get(w) ?? 0) === 0);
const missingUp = required.filter((w) => (upgraded.get(w) ?? 0) === 0);
console.log("");
console.log(`零覆盖（未升级）: ${missing.length === 0 ? "无" : missing.join(" ")}`);
console.log(`零覆盖（已升级）: ${missingUp.length === 0 ? "无" : missingUp.join(" ")}`);
if (missing.length > 0 || missingUp.length > 0) {
  console.error("\n✗ 有卡牌已登记却没有被打出过——等于没有预言机背书，不接受。");
  console.error(
    "  可能原因：没加进 harness 的 BATCH_N；或策略永远打不到它（费用过高/条件不满足）。",
  );
  process.exit(1);
}
console.log("\n✓ 全部要求的卡牌两个分支都被打出过");
