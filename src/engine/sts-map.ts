// === 游戏级地图生成：逐行复刻《杀戮尖塔》本体的地图生成（issue #1）===
//
// 逐行移植 sts_lightspeed/src/game/Map.cpp。给定游戏种子字符串即可产出与游戏
// 完全一致的地图（节点连接 + 房型 + 燃烧精英）。地图用局部 `StsRandom(seed+offset)`，
// 与全局命名流无关，故可独立复刻。
//
// 黄金对拍：test/golden/maps.json（由 Map.cpp 定向编译 dump 生成）。

import { StsRandom, seedStringToLong } from "./sts-rng.js";

const MAP_HEIGHT = 15;
const MAP_WIDTH = 7;
const PATH_DENSITY = 6;
const ROW_END_NODE = MAP_WIDTH - 1;

const SHOP_ROOM_CHANCE = 0.05;
const REST_ROOM_CHANCE = 0.12;
const TREASURE_ROOM_CHANCE = 0.0;
const EVENT_ROOM_CHANCE = 0.22;
const ELITE_ROOM_CHANCE_A0 = 0.08;
const ELITE_ROOM_CHANCE_A1 = ELITE_ROOM_CHANCE_A0 * 1.6;

/** Room 枚举值，与 C++ constants/Rooms.h 一致（bitmask 依赖数值）。 */
export enum Room {
  SHOP = 0,
  REST = 1,
  EVENT = 2,
  ELITE = 3,
  MONSTER = 4,
  TREASURE = 5,
  BOSS = 6,
  BOSS_TREASURE = 7,
  NONE = 8,
  INVALID = 9,
}

export function getRoomSymbol(room: Room): string {
  switch (room) {
    case Room.NONE:
      return "N";
    case Room.EVENT:
      return "?";
    case Room.MONSTER:
      return "M";
    case Room.ELITE:
      return "E";
    case Room.REST:
      return "R";
    case Room.SHOP:
      return "$";
    case Room.TREASURE:
      return "T";
    case Room.BOSS:
      return "B";
    default:
      return "I";
  }
}

export type MapNode = {
  x: number;
  y: number;
  room: Room;
  edges: number[]; // 有序去重（对齐 addEdge）
  parents: number[]; // 追加（对齐 addParent）
};

export type GameMap = {
  nodes: MapNode[][]; // [15][7]
  burningEliteX: number;
  burningEliteY: number;
  burningEliteBuff: number;
};

// === MapNode 操作（对齐 C++ 语义）===

/** 有序插入、去重（对齐 MapNode::addEdge + insertEdge）。 */
function addEdge(node: MapNode, edge: number): void {
  let cur = 0;
  const e = node.edges;
  for (;;) {
    if (cur === e.length) {
      e.push(edge);
      return;
    }
    if (edge === e[cur]) {
      return;
    }
    if (edge < e[cur]) {
      e.splice(cur, 0, edge);
      return;
    }
    cur += 1;
  }
}

function addParent(node: MapNode, parent: number): void {
  node.parents.push(parent);
}

function getMaxEdge(node: MapNode): number {
  return node.edges[node.edges.length - 1];
}
function getMinEdge(node: MapNode): number {
  return node.edges[0];
}
function getMaxXParent(node: MapNode): number {
  return Math.max(...node.parents);
}
function getMinXParent(node: MapNode): number {
  return Math.min(...node.parents);
}

/** 从 parents 里移除所有等于 parent 的项（对齐 removeParent）。 */
function removeParent(node: MapNode, parent: number): void {
  node.parents = node.parents.filter((p) => p !== parent);
}

// === RNG 辅助 ===

/** randRange(rng, min, max) = rng.random(max-min) + min，含端 [min, max]。 */
function randRange(rng: StsRandom, min: number, max: number): number {
  return rng.random(max - min) + min;
}

// === 建图 ===

function newNode(x: number, y: number): MapNode {
  return { x, y, room: Room.NONE, edges: [], parents: [] };
}

function initNodes(): MapNode[][] {
  const nodes: MapNode[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    const row: MapNode[] = [];
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      row.push(newNode(x, y));
    }
    nodes.push(row);
  }
  return nodes;
}

function getCommonAncestor(nodes: MapNode[][], x1: number, x2: number, y: number): number {
  if (y < 0) {
    return -1;
  }
  let lNode: number;
  let rNode: number;
  if (x1 < y) {
    lNode = x1;
    rNode = x2;
  } else {
    lNode = x2;
    rNode = x1;
  }
  if (nodes[y][lNode].parents.length === 0 || nodes[y][rNode].parents.length === 0) {
    return -1;
  }
  const leftX = getMaxXParent(nodes[y][lNode]);
  if (leftX === getMinXParent(nodes[y][rNode])) {
    return leftX;
  }
  return -1;
}

function choosePathParentLoopRandomizer(
  nodes: MapNode[][],
  rng: StsRandom,
  curX: number,
  curY: number,
  newXIn: number,
): number {
  let newX = newXIn;
  const newEdgeDest = nodes[curY + 1][newX];
  for (let i = 0; i < newEdgeDest.parents.length; i += 1) {
    const parentX = newEdgeDest.parents[i];
    if (curX === parentX) {
      continue;
    }
    if (getCommonAncestor(nodes, parentX, curX, curY) === -1) {
      continue;
    }
    if (newX > curX) {
      newX = curX + randRange(rng, -1, 0);
      if (newX < 0) {
        newX = curX;
      }
    } else if (newX === curX) {
      newX = curX + randRange(rng, -1, 1);
      if (newX > ROW_END_NODE) {
        newX = curX - 1;
      } else if (newX < 0) {
        newX = curX + 1;
      }
    } else {
      newX = curX + randRange(rng, 0, 1);
      if (newX > ROW_END_NODE) {
        newX = curX;
      }
    }
  }
  return newX;
}

function choosePathAdjustNewX(
  nodes: MapNode[][],
  curX: number,
  curY: number,
  newEdgeXIn: number,
): number {
  let newEdgeX = newEdgeXIn;
  if (curX !== 0) {
    const rightNode = nodes[curY][curX - 1];
    if (rightNode.edges.length > 0) {
      const leftEdge = getMaxEdge(rightNode);
      if (leftEdge > newEdgeX) {
        newEdgeX = leftEdge;
      }
    }
  }
  if (curX < ROW_END_NODE) {
    const rightNode = nodes[curY][curX + 1];
    if (rightNode.edges.length > 0) {
      const leftEdge = getMinEdge(rightNode);
      if (leftEdge < newEdgeX) {
        newEdgeX = leftEdge;
      }
    }
  }
  return newEdgeX;
}

function chooseNewPath(nodes: MapNode[][], rng: StsRandom, curX: number, curY: number): number {
  let min: number;
  let max: number;
  if (curX === 0) {
    min = 0;
    max = 1;
  } else if (curX === ROW_END_NODE) {
    min = -1;
    max = 0;
  } else {
    min = -1;
    max = 1;
  }
  let newEdgeX = curX + randRange(rng, min, max);
  newEdgeX = choosePathParentLoopRandomizer(nodes, rng, curX, curY, newEdgeX);
  newEdgeX = choosePathAdjustNewX(nodes, curX, curY, newEdgeX);
  return newEdgeX;
}

function createPathsIteration(nodes: MapNode[][], rng: StsRandom, startX: number): void {
  let curX = startX;
  for (let curY = 0; curY < MAP_HEIGHT - 1; curY += 1) {
    const newX = chooseNewPath(nodes, rng, curX, curY);
    addEdge(nodes[curY][curX], newX);
    addParent(nodes[curY + 1][newX], curX);
    curX = newX;
  }
  addEdge(nodes[14][curX], 3);
}

function createPaths(nodes: MapNode[][], rng: StsRandom): void {
  const firstStartX = randRange(rng, 0, MAP_WIDTH - 1);
  createPathsIteration(nodes, rng, firstStartX);
  for (let i = 1; i < PATH_DENSITY; i += 1) {
    let startX = randRange(rng, 0, MAP_WIDTH - 1);
    while (startX === firstStartX && i === 1) {
      startX = randRange(rng, 0, MAP_WIDTH - 1);
    }
    createPathsIteration(nodes, rng, startX);
  }
}

function filterRedundantEdgesFromFirstRow(nodes: MapNode[][]): void {
  const visited = new Array<boolean>(7).fill(false);
  for (let srcX = 0; srcX < 7; srcX += 1) {
    const node = nodes[0][srcX];
    for (let i = node.edges.length - 1; i >= 0; i -= 1) {
      const destX = node.edges[i];
      if (visited[destX]) {
        removeParent(nodes[1][destX], srcX);
        node.edges.splice(i, 1);
      } else {
        visited[destX] = true;
      }
    }
  }
}

// === 房间分配 ===

type RoomCounts = { total: number; unassigned: number };

function getRoomCountsAndAssignFixed(nodes: MapNode[][]): RoomCounts {
  const monsterRow = 0;
  const treasureRow = 8;
  const restRow = MAP_HEIGHT - 1; // 14
  const restRowBug = MAP_HEIGHT - 2; // 13
  const counts: RoomCounts = { total: 0, unassigned: 0 };
  for (let row = 0; row < MAP_HEIGHT; row += 1) {
    for (const node of nodes[row]) {
      if (node.edges.length <= 0) {
        continue;
      }
      switch (row) {
        case monsterRow:
          node.room = Room.MONSTER;
          counts.total += 1;
          break;
        case treasureRow:
          node.room = Room.TREASURE;
          counts.total += 1;
          break;
        case restRow:
          node.room = Room.REST;
          counts.total += 1;
          break;
        case restRowBug:
          counts.unassigned += 1;
          break;
        default:
          counts.unassigned += 1;
          counts.total += 1;
      }
    }
  }
  return counts;
}

function fillRoomArray(counts: RoomCounts, eliteRoomChance: number): Room[] {
  const arr = new Array<Room>(counts.unassigned).fill(Room.MONSTER);
  const shopCount = Math.round(counts.total * SHOP_ROOM_CHANCE);
  const restCount = Math.round(counts.total * REST_ROOM_CHANCE);
  const treasureCount = Math.round(counts.total * TREASURE_ROOM_CHANCE);
  const eliteCount = Math.round(counts.total * eliteRoomChance);
  const eventCount = Math.round(counts.total * EVENT_ROOM_CHANCE);

  let i = 0;
  let end = shopCount;
  for (; i < shopCount; i += 1) arr[i] = Room.SHOP;
  end += restCount;
  for (; i < end; i += 1) arr[i] = Room.REST;
  end += treasureCount;
  for (; i < end; i += 1) arr[i] = Room.TREASURE;
  end += eliteCount;
  for (; i < end; i += 1) arr[i] = Room.ELITE;
  end += eventCount;
  for (; i < end; i += 1) arr[i] = Room.EVENT;
  // 其余为 MONSTER（数组已初始化为 MONSTER）。对齐 C++ 的 `for(; i<unassigned) arr[i]=MONSTER`。
  return arr;
}

// RoomConstructorData：64-bit 掩码用 BigInt。
const ROOM_MASKS: bigint[] = [
  0x0101010101010101n,
  0x0202020202020202n,
  0x0404040404040404n,
  0x0808080808080808n,
  0x1010101010101010n,
  0x2020202020202020n,
  0x4040404040404040n,
];

class RoomConstructorData {
  rooms: Room[];
  roomCount: number;
  offset = 0;
  rowData = 0n;
  prevRowData = 0n;
  siblingMasks: bigint[] = new Array<bigint>(MAP_WIDTH).fill(0n);
  nextSiblingMasks: bigint[] = new Array<bigint>(MAP_WIDTH).fill(0n);
  parentMasks: bigint[] = new Array<bigint>(MAP_WIDTH).fill(0n);
  nextParentMasks: bigint[] = new Array<bigint>(MAP_WIDTH).fill(0n);

  constructor(rooms: Room[], roomCount: number) {
    this.rooms = rooms;
    this.roomCount = roomCount;
  }

  setData(node: MapNode): void {
    if (node.edges.length === 1) {
      for (const edge of node.edges) {
        this.nextParentMasks[edge] = this.nextParentMasks[edge] | (0xffn << BigInt(node.x * 8));
      }
    } else {
      let siblingMask = 0n;
      for (const edge of node.edges) {
        siblingMask |= 0xffn << BigInt(edge * 8);
        this.nextSiblingMasks[edge] = this.nextSiblingMasks[edge] | siblingMask;
        this.nextParentMasks[edge] = this.nextParentMasks[edge] | (0xffn << BigInt(node.x * 8));
      }
    }
  }

  setCurDataOnly(node: MapNode): void {
    this.rowData |= 1n << BigInt(node.room + node.x * 8);
  }

  setNextDataOnly(node: MapNode): void {
    // 与 setData 同体（C++ 里两者实现相同）。
    this.setData(node);
  }

  removeElement(idx: number): void {
    for (let i = idx; i > this.offset; i -= 1) {
      this.rooms[i] = this.rooms[i - 1]!;
    }
    this.offset += 1;
  }

  nextRow(): void {
    this.prevRowData = this.rowData;
    this.rowData = 0n;
    for (let i = 0; i < MAP_WIDTH; i += 1) {
      this.siblingMasks[i] = this.nextSiblingMasks[i]!;
      this.nextSiblingMasks[i] = 0n;
      this.parentMasks[i] = this.nextParentMasks[i]!;
      this.nextParentMasks[i] = 0n;
    }
  }
}

function doesSiblingMatch(data: RoomConstructorData, nodeX: number, room: Room): boolean {
  return (data.rowData & data.siblingMasks[nodeX] & ROOM_MASKS[room]) !== 0n;
}

function doesParentMatch(data: RoomConstructorData, nodeX: number, room: Room): boolean {
  return (data.prevRowData & data.parentMasks[nodeX] & ROOM_MASKS[room]) !== 0n;
}

function assignRoomToNode(node: MapNode, data: RoomConstructorData): void {
  const tried = new Array<boolean>(5).fill(false);
  for (let i = data.offset; i < data.roomCount; i += 1) {
    const room = data.rooms[i];
    if (tried[room]) {
      continue;
    }
    tried[room] = true;

    switch (room) {
      case Room.SHOP:
        break;
      case Room.ELITE:
        if (node.y <= 4) continue;
        break;
      case Room.REST:
        if (node.y <= 4) continue;
        if (node.y >= 13) continue;
        break;
      case Room.EVENT:
        if (doesSiblingMatch(data, node.x, room)) {
          continue;
        }
        node.room = Room.EVENT;
        data.rowData |= 1n << BigInt(Room.EVENT + node.x * 8);
        data.removeElement(i);
        return;
      case Room.MONSTER:
        if (doesSiblingMatch(data, node.x, room)) {
          continue;
        }
        node.room = Room.MONSTER;
        data.rowData |= 1n << BigInt(Room.MONSTER + node.x * 8);
        data.removeElement(i);
        return;
      default:
        break;
    }

    const canSet = !doesParentMatch(data, node.x, room) && !doesSiblingMatch(data, node.x, room);
    if (canSet) {
      node.room = room;
      data.rowData |= 1n << BigInt(node.room + node.x * 8);
      data.removeElement(i);
      return;
    }
  }
  node.room = Room.MONSTER;
}

function assignRoomsRow(nodes: MapNode[][], data: RoomConstructorData, row: number): void {
  for (const node of nodes[row]) {
    if (node.edges.length <= 0) {
      continue;
    }
    if (row === 0 || row === 8) {
      data.setNextDataOnly(node);
    } else if (row === 7 || row === 13) {
      assignRoomToNode(node, data);
      data.setCurDataOnly(node);
    } else {
      assignRoomToNode(node, data);
      data.setData(node);
    }
  }
  data.nextRow();
}

function assignRooms(nodes: MapNode[][], rng: StsRandom, ascension: number): void {
  const counts = getRoomCountsAndAssignFixed(nodes);
  const rooms = fillRoomArray(counts, ascension > 0 ? ELITE_ROOM_CHANCE_A1 : ELITE_ROOM_CHANCE_A0);
  // 地图洗牌用 sts::Random::nextInt（非 random 家族，不自增 counter）。
  for (let i = counts.unassigned; i > 1; i -= 1) {
    const j = rng.nextInt(i);
    const tmp = rooms[i - 1];
    rooms[i - 1] = rooms[j]!;
    rooms[j] = tmp;
  }
  const data = new RoomConstructorData(rooms, counts.unassigned);
  for (let row = 0; row < MAP_HEIGHT - 1; row += 1) {
    assignRoomsRow(nodes, data, row);
  }
}

function assignBurningElite(map: GameMap, rng: StsRandom): void {
  const eliteRooms: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 15; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      if (map.nodes[row][col].room === Room.ELITE) {
        eliteRooms.push({ x: col, y: row });
      }
    }
  }
  const idx = rng.random(eliteRooms.length - 1);
  map.burningEliteX = eliteRooms[idx].x;
  map.burningEliteY = eliteRooms[idx].y;
}

/**
 * 从游戏种子生成地图（逐位对齐 Map::fromSeed）。
 * @param seed 游戏种子字符串（base-35）或 int64 bigint。
 */
export function generateMap(
  seed: string | bigint,
  ascension = 0,
  act = 1,
  setBurning = false,
): GameMap {
  const seedLong = typeof seed === "bigint" ? seed : seedStringToLong(seed);
  const offset = act === 1 ? 1 : act * (100 * (act - 1));
  const rng = new StsRandom(seedLong + BigInt(offset));
  const nodes = initNodes();
  const map: GameMap = { nodes, burningEliteX: -1, burningEliteY: -1, burningEliteBuff: -1 };
  createPaths(nodes, rng);
  filterRedundantEdgesFromFirstRow(nodes);
  assignRooms(nodes, rng, ascension);
  if (setBurning) {
    assignBurningElite(map, rng);
    map.burningEliteBuff = rng.random(0, 3);
  }
  return map;
}
