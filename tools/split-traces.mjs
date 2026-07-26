import fs from "node:fs";
import path from "node:path";

// 把 harness 输出的单个 traces.json 拆成「每编队一个 JSONL」，即本仓库 test/golden/traces 的布局。
//
// 排序是 **variant 优先的全序**，三点都是必需的：
//
//  * variant 优先 —— 每个更早的 variant 的行连续待在文件开头，于是新增一批就是**字面意义的
//    追加**，`head -n <旧行数>` 仍与旧文件逐字节一致。改成按种子交错会让全文件的行位置都动。
//  * variant 的先后取 **harness 输出里的首次出现顺序**（harness 的最外层循环就是 variant，
//    所以那就是声明顺序）。⚠ 早先这里按「牌组张数升序」推断 variant 先后，前提是
//    「后一个 variant 的牌组更大」。那个前提已经不成立：CardManager 的三个牌堆是
//    `fixed_list<CardInstance, 64>` 且**无越界检查**，牌组超过 64 张直接写坏内存，
//    所以新 variant 只能用更小的牌组。张数一小于旧 variant，它就会被排到文件中间，
//    把「追加」变成「插入」，既有的上千例背书全部错位。
//  * 全序（而非仅「稳定」）—— 末位用输入下标兜底，不靠 V8 排序的稳定性，
//    否则「重跑逐字节一致」就成了实现细节而不是性质。
//
// 用法: node tools/split-traces.mjs <traces.json> <输出目录>
const [src, outDir] = process.argv.slice(2);
if (src === undefined || outDir === undefined) {
  console.error("用法: node tools/split-traces.mjs <traces.json> <输出目录>");
  process.exit(2);
}

const all = JSON.parse(fs.readFileSync(src, "utf8")).traces;

// variant 的指纹：（牌组张数, 是否升级）。只用来把同一个 variant 的行认出来，
// 不参与先后比较——先后由首次出现顺序决定。
const signature = (t) => `${t.deck.length}|${t.deckUpgraded === undefined ? 0 : 1}`;
const variantRank = new Map();
for (const t of all) {
  const s = signature(t);
  if (!variantRank.has(s)) variantRank.set(s, variantRank.size);
}

const key = ({ t, i }) => [variantRank.get(signature(t)), t.seed, t.floor, i];
const cmp = (a, b) => {
  const ka = key(a);
  const kb = key(b);
  for (let j = 0; j < ka.length; j += 1) {
    if (ka[j] !== kb[j]) return ka[j] < kb[j] ? -1 : 1;
  }
  return 0;
};

const by = {};
all.forEach((t, i) => (by[t.encounter] ||= []).push({ t, i }));

fs.mkdirSync(outDir, { recursive: true });
for (const [enc, list] of Object.entries(by)) {
  list.sort(cmp);
  fs.writeFileSync(
    path.join(outDir, `${enc.toLowerCase()}.jsonl`),
    list.map(({ t }) => JSON.stringify(t)).join("\n") + "\n",
  );
}
console.log(
  `拆出 ${String(Object.keys(by).length)} 个编队: ` +
    Object.entries(by)
      .map(([k, v]) => `${k}=${String(v.length)}`)
      .join(" "),
);
