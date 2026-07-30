import fs from "node:fs";
import path from "node:path";

// 统计 trace 里**实际发生过**的事：卡牌被打出多少次（未升级 / 已升级分栏），
// 以及怪物招式出现 / 被执行多少次。
//
// 为什么必须有这一步：把卡加进 harness 的牌组**不等于**验证了它。策略只打手牌最左侧的
// 可打出牌，所以一张卡完全可以躺在牌组里一次没被打出。打出 0 次 = 有规则、没预言机，
// 是本项目明确不接受的状态（见 TODOS「登记了不等于有背书」）。
//
// 怪物那一侧同理，而且更容易出事：一只怪的某个招式可能因为「战斗结束得太早」而
// 一次都轮不到——例如需要连续几回合才触发的、或者血量阈值才触发的。所以分两栏：
//
//   出现  它在某一帧里是**某只怪**的当前意图（死怪也算，理由见 countMoves 的注释）。
//         验证的是**意图选择规则**（getMoveForRoll）。注意这是**帧数**不是掷出次数——
//         一个意图会在它那一回合的每一帧里重复出现，所以绝对值只用来判「是不是 0」，
//         不同招式之间不可比。
//   执行  它在某个玩家回合结束的那一帧里是某只活怪的当前意图 → 紧接着的怪物阶段执行它。
//         验证的是**招式效果**（takeTurn）。
//
// 两栏必须都非 0：只出现没执行，说明 MOVE_RULES 有背书而 takeTurn 那条效果没有。
//
// 用法:
//   node tools/check-coverage.mjs <trace目录>
//   node tools/check-coverage.mjs <trace目录> CARD... [--no-upgrade CARD...] [--moves MOVE...]
//
// 三段参数：
//   （无前缀）    普通卡，要求**未升级 / 已升级两栏都非 0**。
//   --no-upgrade  只要求未升级那栏非 0。**仅限根本没有升级形态的卡**——状态牌与诅咒牌
//                 （黏液 / 灼伤 / 恍惚 / 伤口…）的 `canUpgrade()` 恒假，harness 的
//                 全升级 variant 也不会升它们，放进普通那段就是必然失败、整批装不上。
//                 ⚠ 别拿它给「这批懒得覆盖升级分支」的普通卡开后门：那是真的少了一半背书。
//   --moves       怪物招式，要求**出现 / 执行两栏都非 0**。
//
// 名字一律用**参考项目的枚举名**（trace 里就是这个）：卡是 UPPERCUT / DEMON_FORM，
// 招式是 CULTIST_INCANTATION / RED_LOUSE_BITE（招式名自带怪物前缀，全局唯一）。
// 有任一为 0 时以退出码 1 结束。
const argv = process.argv.slice(2);
const dir = argv[0];
/** 按 `--xxx` 把参数切成若干段，段名 → 名字数组。无前缀的那段归到 "cards"。 */
const groups = { cards: [], "no-upgrade": [], moves: [] };
let cur = "cards";
for (const a of argv.slice(1)) {
  if (a.startsWith("--")) {
    cur = a.slice(2);
    if (!(cur in groups)) {
      console.error(`✗ 未知参数段: ${a}（只支持 --no-upgrade / --moves）`);
      process.exit(2);
    }
    continue;
  }
  groups[cur].push(a);
}
const required = groups.cards;
const requiredPlainOnly = groups["no-upgrade"];
const requiredMoves = groups.moves;
if (dir === undefined) {
  console.error(
    "用法: node tools/check-coverage.mjs <trace目录> [卡枚举名...] [--no-upgrade 卡枚举名...] [--moves 招式枚举名...]",
  );
  process.exit(2);
}

const plain = new Map();
const upgraded = new Map();
const appeared = new Map();
const executed = new Map();
/** 招式 → 拥有它的怪物 id，仅用于打印时给出上下文。 */
const moveOwner = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

/**
 * 记下这一帧里各只怪的当前意图。
 *
 * `aliveOnly` 的取值对两栏是**不同**的，这一点第二十六批踩过：
 *
 *  * 「出现」栏 `aliveOnly = false` —— 意图**只要进了快照就被逐帧比对**，死怪身上那个
 *    残留意图同样是 `getMoveForRoll` 真的返回过它，同样能钉住出招规则。早先这里对两栏
 *    一律跳过死怪，于是「只在死怪身上出现过的招式」被报成「出现 0 / 执行 0」，
 *    看上去像完全没有背书——而实际上它的**出招规则那一半是有背书的**。
 *    第二十六批的 `CENTURION_FURY` 就是这样：它作为意图出现 88 次，**全在一具已死的
 *    百夫长身上**（青铜鳞片的荆棘走 `addToTop`，插在百夫长自己那条入队 RollMove 之前，
 *    于是它先被打死、RollMove 在尸体上执行）。报成 0 会让下一批以为整招没背书，
 *    甚至误把 `--moves` 的断言当成「这招不可达」。
 *  * 「执行」栏 `aliveOnly = true` —— 死怪不会行动，它的意图不会被 `takeTurn` 跑到。
 */
const countMoves = (snap, target, aliveOnly) => {
  for (const m of snap.monsters) {
    if (aliveOnly && !m.alive) continue;
    // 参考给某些编队预置的哨兵意图（如颚虫军团借用的 DARKLING_REGROW）不是真招式。
    if (m.move === "INVALID") continue;
    bump(target, m.move);
    moveOwner.set(m.move, m.id);
  }
};

for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const t = JSON.parse(line);
    // 全升级牌组里打出的牌就是升级实例。牌堆快照只记名字，没有逐实例的升级标记，
    // 但 variant 级的归属就够用了——那正是区分一条规则两个分支的东西。
    const upgradedVariant = t.deckUpgraded !== undefined;
    let hand = t.initial.hand;
    countMoves(t.initial, appeared, false);
    let prev = t.initial;
    for (const step of t.steps) {
      if (step.action.type === "card") {
        const name = hand[step.action.idx];
        if (name !== undefined) bump(upgradedVariant ? upgraded : plain, name);
      }
      // 「执行」看的是**结束回合那一刻**的意图：紧跟其后的就是怪物阶段。
      // 用动作**之前**的快照，因为 end_turn 之后的快照里意图已经滚成下一个了。
      if (step.action.type === "end_turn") countMoves(prev, executed, true);
      countMoves(step.after, appeared, false);
      hand = step.after.hand;
      prev = step.after;
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

const allMoves = [...new Set([...appeared.keys(), ...executed.keys()])].sort();
if (allMoves.length > 0) {
  console.log("");
  console.log("怪物".padEnd(18) + "招式".padEnd(30) + "出现".padStart(9) + "执行".padStart(10));
  for (const name of allMoves) {
    console.log(
      (moveOwner.get(name) ?? "?").padEnd(18) +
        name.padEnd(30) +
        String(appeared.get(name) ?? 0).padStart(9) +
        String(executed.get(name) ?? 0).padStart(10),
    );
  }
}

let bad = false;

if (required.length > 0) {
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
    bad = true;
  } else {
    console.log("✓ 全部要求的卡牌两个分支都被打出过");
  }
}

if (requiredPlainOnly.length > 0) {
  const missing = requiredPlainOnly.filter((w) => (plain.get(w) ?? 0) === 0);
  console.log("");
  console.log(`零覆盖（无升级形态的卡）: ${missing.length === 0 ? "无" : missing.join(" ")}`);
  if (missing.length > 0) {
    console.error("\n✗ 有卡已登记却没有被打出过——等于没有预言机背书，不接受。");
    bad = true;
  } else {
    console.log("✓ 全部要求的无升级形态卡都被打出过");
  }
}

if (requiredMoves.length > 0) {
  const noRoll = requiredMoves.filter((w) => (appeared.get(w) ?? 0) === 0);
  const noExec = requiredMoves.filter((w) => (executed.get(w) ?? 0) === 0);
  console.log("");
  console.log(`零覆盖（出现）: ${noRoll.length === 0 ? "无" : noRoll.join(" ")}`);
  console.log(`零覆盖（执行）: ${noExec.length === 0 ? "无" : noExec.join(" ")}`);
  if (noRoll.length > 0 || noExec.length > 0) {
    console.error("\n✗ 有怪物招式已登记却没有出现过——等于没有预言机背书，不接受。");
    console.error("  出现为 0：这个编队没进策略表（ENC_V0），或 getMoveForRoll 那条分支不可达。");
    console.error("  只有出现、执行为 0：意图选出来了但从没轮到执行——多半是战斗提前结束");
    console.error("  （玩家死得太快 / 怪被秒，或那只怪只在死后才滚到这个意图），");
    console.error("  招式效果那段代码因此没有背书，但出招规则那一半是有的。");
    bad = true;
  } else {
    console.log("✓ 全部要求的怪物招式都出现且执行过");
  }
}

if (bad) process.exit(1);
