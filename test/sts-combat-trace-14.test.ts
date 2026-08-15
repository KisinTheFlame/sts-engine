import { defineTraceSuite } from "./helpers/trace-replay.js";
import { SLICES } from "./helpers/trace-slices.js";

// 对拍语料的第 14 片。**这个文件里没有任何逻辑**——机器在 `helpers/trace-replay.ts`、
// 这一片认领哪些 jsonl 由 `helpers/trace-slices.ts` 的谓词决定（见那两个文件的注释）。
// ⚠ 语料再长时**加片**（改 SLICE_COUNT + 照本文件新建一个），不要把某一片撑大。
defineTraceSuite(SLICES[14]!);
