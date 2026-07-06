# @kisinwen/sts-engine

杀戮尖塔（Slay the Spire）规则的**纯计算引擎**：零 IO、零外部运行时依赖、自带可种子化 PRNG。给对局逻辑一个可独立演进、可复用、可测试的家。

> 免责声明：本项目是对商业游戏《杀戮尖塔》规则的粉丝向复刻，仅供学习与个人使用，与 Mega Crit 无任何关联。

## 安装

```sh
npm install @kisinwen/sts-engine
```

## 用法

```ts
import { newRun, applyAction } from "@kisinwen/sts-engine";

const state = newRun({ runId: "run-1", seed: 42, character: "ironclad", ascension: 0 });
const result = applyAction(state, { type: "choose", optionIndex: 0 });
// state 被原地推进；result.ok 表示动作是否合法
```

完整 API 走子路径导入（前缀 `@kisinwen/sts-engine/`）：

| 子路径                   | 内容                                                      |
| ------------------------ | --------------------------------------------------------- |
| `engine/engine`          | `newRun` / `applyAction` / `GameAction`                   |
| `engine/types`           | `GameState` / `CharacterId` / `EnemyState` / `RngState` … |
| `engine/cards/cards`     | `ALL_CARDS` / `getCardDef` / `costOf`                     |
| `engine/relics/relics`   | `ALL_RELICS` / `getRelicDef`                              |
| `engine/potions/potions` | `ALL_POTIONS` / `getPotionDef`                            |
| `engine/enemies/enemies` | `getEnemyDef`                                             |
| `engine/powers/powers`   | `computeAttackDamage`                                     |
| `engine/events/events`   | `getEventDef`                                             |
| `engine/run/run`         | `currentOptions`                                          |
| `engine/map/map`         | `availableNext`                                           |
| `engine/rng`             | `seedRng` / `nextInt`                                     |
| `engine/sts-rng`         | `StsRandom` / `JavaRandom` / `seedStringToLong`（游戏级 RNG，接受原版种子字符串） |
| `engine/sts-map`         | `generateMap`（游戏级地图生成：同种子复现原版地图，逐位对齐） |
| `engine/sts-neow`        | `generateNeowOptions`（游戏级 Neow 开局四选项，同种子复现，逐位对齐） |
| `engine/sts-encounters`  | `generateEncounters`（游戏级三幕怪物遭遇序列：怪物/精英/boss，同种子复现） |
| `engine/glossary`        | `GLOSSARY`                                                |
| `sim/policy`             | `GreedyPolicy`（自动对局策略，测试用）                    |
| `migrate`                | `migrateLoadedState`（老存档字段回填）                    |

## 设计约束

- **纯计算**：引擎不碰文件、网络、时钟、`Math.random`。随机性全部经 `rng.ts` 的可导出 PRNG，同一 seed 完全可复现。
- **状态原地推进**：`applyAction` 就地修改传入的 `GameState`，持久化 / 版本自增由调用方负责。

## 开发

```sh
pnpm install
pnpm build       # tsc → dist（含 .d.ts）
pnpm test        # vitest
pnpm typecheck
pnpm lint
pnpm format
pnpm sim         # 跑自动对局模拟（需先 build）
```
