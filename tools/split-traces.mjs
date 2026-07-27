import fs from "node:fs";
import path from "node:path";

// 把 harness 输出的单个 traces.json 拆成「每编队一个 JSONL」，即本仓库 test/golden/traces 的布局。
//
// 排序是 **variant 优先的全序**，三点都是必需的：
//
//  * variant 优先 —— 每个 variant 的行连续成块，且 variant 0 那块永远在文件开头。
//    数据布局是「variant 0 冻结 + 其后每批用当前全牌组重生成」，所以 variant 0 的那几百行
//    必须原地不动、逐字节可复现（`traceIdx` 驱动遗物/药水轮换，位置一动它们全部失效）。
//    改成按种子交错会让每个 variant 的行散布全文件，variant 0 就再也切不出来了。
//  * variant 的先后取 **harness 输出里的首次出现顺序**（harness 的最外层循环就是 variant，
//    所以那就是声明顺序）。⚠ 早先这里按「牌组张数升序」推断先后，那是**在推断 harness 的
//    声明顺序**，多一层不必要的假设：只要哪一批的牌组比前一批小（换更聚焦的牌组、
//    或临时砍掉几张），张数排序就会把它插到 variant 0 中间去。首次出现顺序与牌组大小无关，
//    是 harness 真正的输出顺序，所以更稳。
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

// variant 的指纹：**整副牌组的内容**（牌名序列 + 每张的升级位）。只用来把同一个 variant
// 的行认出来，不参与先后比较——先后由首次出现顺序决定。
//
// ⚠ 早先这里只用「张数 + 是否升级」。那是个哑弹：两个不同 variant 只要张数相同就会被认成
// 同一个，于是它们的行被排到一块、`variant0-rows.mjs` 数出来的段长也跟着错，而**不会有
// 任何报错**——已提交数据被静默错位是这个项目最不能容忍的失败模式。第七批差点踩到：
// 新加的聚焦牌组本来正好也是 23 张，与 variant 3/4 撞号。
// 同一个 variant 内部各行的牌组是逐字节相同的（harness 按固定顺序 obtain，与种子无关），
// 所以换成内容指纹不会把一个 variant 拆开——换之前在已提交数据上验证过分组完全不变。
const signature = (t) =>
  `${t.deck.join(",")}|${t.deckUpgraded === undefined ? "" : t.deckUpgraded.join("")}`;
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
