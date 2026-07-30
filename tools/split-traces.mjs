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
// ⚠ **不能把整个文件读成一个 JS 字符串**：harness 的输出从第八批起超过了 512MB
// （V8 的字符串上限 0x1fffffe8 ≈ 512MB），`fs.readFileSync(src, "utf8")` 会直接抛
// `ERR_STRING_TOO_LONG`。所以这里读成 **Buffer**（上限以 GB 计），按顶层 trace 边界切片，
// 每条单独 `JSON.parse`。切完就丢，峰值内存只有 Buffer 本身。
//
// 边界用字节序列 `,{"seed":"` 找：harness 把每条 trace 都以 `{"seed":"…` 开头、以 `,` 相连，
// 而 `seed` 这个 key 每条只出现一次，卡名/药水名/遗物名里也不可能出现这个序列。
//
// 用法: node tools/split-traces.mjs <traces.json> <输出目录>
const [src, outDir] = process.argv.slice(2);
if (src === undefined || outDir === undefined) {
  console.error("用法: node tools/split-traces.mjs <traces.json> <输出目录>");
  process.exit(2);
}

const buf = fs.readFileSync(src);
const TRACE_HEAD = Buffer.from('{"seed":"');
const TRACE_SEP = Buffer.from(',{"seed":"');
// 每条 trace 的头部字段（排序要用的那几个）都排在 `"initial"` 之前，所以只解析这一小段，
// 不为了排序把 630MB 全部解析成对象。
const HEAD_END = Buffer.from(',"initial":');

/** 顶层 trace 的字节区间 [start, end)，按 harness 的输出顺序。 */
const spans = [];
{
  let start = buf.indexOf(TRACE_HEAD);
  if (start === -1) {
    console.error("✗ 输入里一条 trace 都没有——harness 输出格式变了？");
    process.exit(1);
  }
  while (start !== -1) {
    const next = buf.indexOf(TRACE_SEP, start + 1);
    // 最后一条的收尾是 `]}` + 换行；前面的都以 `,` 与下一条相接。
    const end = next === -1 ? buf.lastIndexOf(0x5d /* ] */) : next;
    spans.push([start, end]);
    start = next === -1 ? -1 : next + 1;
  }
}

const head = (i) => {
  const [start, end] = spans[i];
  const cut = buf.indexOf(HEAD_END, start);
  if (cut === -1 || cut >= end) {
    throw new Error(`第 ${String(i)} 条 trace 里找不到 "initial" 分界`);
  }
  return JSON.parse(buf.toString("utf8", start, cut) + "}");
};

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
  `${t.deck.join(",")}|${t.deckUpgraded === undefined ? "" : t.deckUpgraded.join("")}` +
  `|${t.ascension === undefined ? "" : String(t.ascension)}` +
  `|${t.targetPolicy === undefined ? "" : String(t.targetPolicy)}`;

// 分组键 = 编队 × 爬升度 × 目标策略。后两维各是一个**后缀**，非默认值时才拼上去：
//
//   <编队>[@asc<N>][@tgt<N>]      例如 cultist / cultist@asc19 / centurion_and_healer@tgt1
//
// ⚠⚠ **拼接顺序固定为「先 asc 后 tgt」**，而且不许改：文件名就是冻结数据的身份，
// 顺序一换等于给已提交的文件改名，`regen-traces.sh` 会当场报「没有生成」。
// 两维同时非默认时得到 `<编队>@asc19@tgt1`（本批没有这种组合——目标策略这一批只做 asc0，
// 见 TODOS「目标策略轴」；但键的形状先定死，以后叠加不用再改这里）。
//
// 为什么两维都用「非默认才拼」：
//  * 默认值那一侧的分组键一个字不改（harness 也只在非默认时输出对应字段），所以既有文件名
//    与内容都不动，`regen-traces.sh --check` 仍然逐字节比得上——这是「新轴对旧数据是空操作」
//    的凭证，加轴时**必须先单独跑一次**。
//  * 一份文件里只有一个 (爬升度, 目标策略) 组合，于是 `variant0-rows.mjs` 会返回整份长度，
//    `ENC_V0` 策略下整份冻结，正是我们要的。
const groupKey = (t) => {
  const asc = t.ascension === undefined || t.ascension === 0 ? "" : `@asc${String(t.ascension)}`;
  const tgt =
    t.targetPolicy === undefined || t.targetPolicy === 0 ? "" : `@tgt${String(t.targetPolicy)}`;
  return `${t.encounter}${asc}${tgt}`;
};

const variantRank = new Map();
const by = {};
for (let i = 0; i < spans.length; i += 1) {
  const t = head(i);
  const s = signature(t);
  if (!variantRank.has(s)) variantRank.set(s, variantRank.size);
  (by[groupKey(t)] ||= []).push({ i, rank: variantRank.get(s), seed: t.seed, floor: t.floor });
}

const key = ({ rank, seed, floor, i }) => [rank, seed, floor, i];
const cmp = (a, b) => {
  const ka = key(a);
  const kb = key(b);
  for (let j = 0; j < ka.length; j += 1) {
    if (ka[j] !== kb[j]) return ka[j] < kb[j] ? -1 : 1;
  }
  return 0;
};

fs.mkdirSync(outDir, { recursive: true });
for (const [enc, list] of Object.entries(by)) {
  list.sort(cmp);
  const fd = fs.openSync(path.join(outDir, `${enc.toLowerCase()}.jsonl`), "w");
  try {
    for (const { i } of list) {
      const [start, end] = spans[i];
      // 逐条 parse → stringify（而不是直接写原始切片）：输出因此与「整份 parse 之后
      // 逐条 stringify」逐字节等价，换成流式读取不会悄悄改变已提交数据的字节。
      fs.writeSync(fd, JSON.stringify(JSON.parse(buf.toString("utf8", start, end))) + "\n");
    }
  } finally {
    fs.closeSync(fd);
  }
}
console.log(
  `拆出 ${String(Object.keys(by).length)} 个编队: ` +
    Object.entries(by)
      .map(([k, v]) => `${k}=${String(v.length)}`)
      .join(" "),
);
