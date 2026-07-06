import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateMap, getRoomSymbol, Room, type GameMap } from "../src/engine/sts-map.js";

type GoldenNode = { x: number; y: number; room: string; edges: number[] };
type GoldenMap = {
  seed: string;
  seedLong: string;
  ascension: number;
  act: number;
  burning: boolean;
  burningEliteX: number;
  burningEliteY: number;
  burningEliteBuff: number;
  nodes: GoldenNode[];
};

const goldenPath = fileURLToPath(new URL("./golden/maps.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { maps: GoldenMap[] };

/** 把 GameMap 压成与 C++ dump 相同的「活跃节点」表示，逐位对拍。 */
function toGoldenNodes(map: GameMap): GoldenNode[] {
  const out: GoldenNode[] = [];
  for (let y = 0; y < 15; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const n = map.nodes[y]![x]!;
      // C++ dump 跳过：room==NONE && edges==0 && parents==0
      if (n.room === Room.NONE && n.edges.length === 0 && n.parents.length === 0) {
        continue;
      }
      out.push({ x, y, room: getRoomSymbol(n.room), edges: [...n.edges] });
    }
  }
  return out;
}

describe("sts-map 地图生成对拍 C++ 黄金向量", () => {
  for (const g of golden.maps) {
    const label = `seed "${g.seed}" act${g.act} asc${g.ascension}${g.burning ? " burning" : ""}`;
    it(label, () => {
      const map = generateMap(g.seed, g.ascension, g.act, g.burning);
      // 种子换算一致
      expect(map).toBeDefined();
      // 节点网格逐位相等
      expect(toGoldenNodes(map)).toEqual(g.nodes);
      // 燃烧精英
      expect(map.burningEliteX).toBe(g.burningEliteX);
      expect(map.burningEliteY).toBe(g.burningEliteY);
      expect(map.burningEliteBuff).toBe(g.burningEliteBuff);
    });
  }

  it("接受 base-35 种子串与 int64 bigint 两种入参", () => {
    const g = golden.maps[0]!;
    const byStr = generateMap(g.seed, g.ascension, g.act, g.burning);
    const byLong = generateMap(BigInt(g.seedLong), g.ascension, g.act, g.burning);
    expect(toGoldenNodes(byLong)).toEqual(toGoldenNodes(byStr));
  });
});
