import fs from "node:fs";
import path from "node:path";

// 把 harness 输出的单个 traces.json 拆成「每编队一个 JSONL」，即本仓库 test/golden/traces 的布局。
//
// 排序是 **variant 优先的全序**，两点都是必需的：
//
//  * variant 优先 —— variant 只会把牌组变大，所以按（牌组张数, 是否升级）排序能让每个更早的
//    variant 的行连续待在文件开头。于是新增一批就是**字面意义的追加**，
//    `head -n <旧行数>` 仍与旧文件逐字节一致。改成按种子交错会让全文件的行位置都动，毫无收益。
//  * 全序（而非仅「稳定」）—— 多个 variant 共享同一个 (seed, floor)，靠 V8 排序的稳定性来
//    决定先后，会把「重跑逐字节一致」变成实现细节而不是性质。
//
// 用法: node tools/split-traces.mjs <traces.json> <输出目录>
const [src, outDir] = process.argv.slice(2);
if (src === undefined || outDir === undefined) {
  console.error("用法: node tools/split-traces.mjs <traces.json> <输出目录>");
  process.exit(2);
}

const key = (t) => [t.deck.length, t.deckUpgraded === undefined ? 0 : 1, t.seed, t.floor];
const cmp = (a, b) => {
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
};

const by = {};
for (const t of JSON.parse(fs.readFileSync(src, "utf8")).traces) (by[t.encounter] ||= []).push(t);

fs.mkdirSync(outDir, { recursive: true });
for (const [enc, list] of Object.entries(by)) {
  list.sort(cmp);
  fs.writeFileSync(
    path.join(outDir, `${enc.toLowerCase()}.jsonl`),
    list.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );
}
console.log(
  `拆出 ${String(Object.keys(by).length)} 个编队: ` +
    Object.entries(by)
      .map(([k, v]) => `${k}=${String(v.length)}`)
      .join(" "),
);
