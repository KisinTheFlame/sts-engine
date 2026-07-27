import fs from "node:fs";

// 一个 trace 文件开头有多少行属于 variant 0。
//
// 为什么需要它：数据布局是「variant 0 冻结 + 其后每批替换」（见 tools/split-traces.mjs）。
// 所以 `tools/regen-traces.sh` 能且只能要求「开头这一段逐字节不变」，不能拿整个文件比。
// 这个行数**由文件自己说**（第一行的牌组指纹连续出现几行），不写死：
// variant 0 的种子数一改，写死的数字就会悄悄少校验一部分。
//
// 指纹与 split-traces.mjs 用的是同一个：**整副牌组的内容**（牌名序列 + 每张的升级位）。
// 不能退回「张数 + 是否升级」——两个不同 variant 张数相同就会被认成一个，段长静默算错。
//
// 用法: node tools/variant0-rows.mjs <某个 .jsonl>   # 打印行数
const [src] = process.argv.slice(2);
if (src === undefined) {
  console.error("用法: node tools/variant0-rows.mjs <trace.jsonl>");
  process.exit(2);
}

const signature = (line) => {
  const t = JSON.parse(line);
  return `${t.deck.join(",")}|${t.deckUpgraded === undefined ? "" : t.deckUpgraded.join("")}`;
};

const lines = fs.readFileSync(src, "utf8").split("\n");
let n = 0;
let first;
for (const line of lines) {
  if (line.length === 0) continue;
  const s = signature(line);
  first ??= s;
  if (s !== first) break;
  n += 1;
}
console.log(String(n));
