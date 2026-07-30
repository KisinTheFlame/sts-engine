import type { EnemyDef, RngState } from "../types.js";
import { nextFloat } from "../rng.js";

// === 敌人定义数据表（第一幕切片）===
//
// 血量区间、出招数值为功能性游戏规则；意图选择规则显式、可被种子 RNG 驱动（issue #234 C8）。
// 出招名称为原创中文。精确权重 / 连续限制 / 守卫者阈值待真机 ground truth 校准（见设计文档 Assignment）。

// === 爬升度分档（第二十一批开轴，第二十二批补上精英与 Boss）===
//
// 每条 `ascAmount` / `hpHigh` 都是 `MonsterSpecific.cpp` / `MonsterIds.h` 的逐位转写，
// 行号标在各自的招式上。四条通用规则，读的时候记住就不必逐条重复：
//
//  * **`hpHigh.atLeast` 逐怪不同**：`Monster::initHp`（MonsterSpecific.cpp:26-128）
//    普通怪 `asc>=7`、精英 `asc>=8`（:91-102）、Boss `asc>=9`（:76-89）。
//    照抄时不要以为它是常数——三档在同一个 switch 里并排写着。
//  * **数值分档也跟着「怪的层级」换阈值**，而且与血量那一档**不是同一个数**：
//    走廊小怪 `getTriIdx(asc, 2, 17)`、精英 `getTriIdx(asc, 3, 18)`、
//    Boss `getTriIdx(asc, 4, 19)`（三个变量并排声明在 `takeTurn` 顶部，:337-348）。
//    所以精英的伤害档是 **asc3 / asc18**、Boss 是 **asc4 / asc19**，
//    照抄邻居那只怪的 `atLeast: 2 / 17` 必错。
//  * **`{a,b,c}[getTriIdx(asc, 2, 17)]` 展开成两条 tier**：`[{17,c},{2,b}]` + 基础 `a`。
//  * **只有 asc19 一档预言机。** 现有 trace 是 asc0 与 asc19 两个档，所以每条
//    `asc >= N` 的**两个方向**都有背书，但「阈值恰好是 N 而不是 N±1」没有——
//    那要成对档位（asc16/17 之类），记在 TODOS 的盲区里。
const ENEMY_LIST: EnemyDef[] = [
  {
    id: "cultist",
    name: "邪教徒",
    hpMin: 48,
    hpMax: 54,
    // MonsterIds.h:164 `{{48,54},{50,56}}`；`setRandomHp(hpRng, asc >= 7)`（MonsterSpecific.cpp:44）。
    hpHigh: { atLeast: 7, hpMin: 50, hpMax: 56 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:681-684 `ritualAmount[] = {3,4,5}`、下标 `hallwayIdx`。
        id: "incantation",
        name: "仪式咏唱",
        effects: [
          {
            kind: "apply_power",
            power: "ritual",
            amount: 3,
            on: "self",
            ascAmount: [
              { atLeast: 17, amount: 5 },
              { atLeast: 2, amount: 4 },
            ],
          },
        ],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:676 `attackPlayerHelper(bc, 6)`——**没有 asc 分档**
        // （MonsterMoveDamage.cpp:58 同样是裸的 `{6}`）。所以邪教徒在 asc19 下变强的
        // 只有血量与仪式层数，暗袭还是 6。
        id: "dark_strike",
        name: "暗袭",
        effects: [{ kind: "deal_damage", amount: 6 }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: ["incantation"],
      weighted: [{ move: "dark_strike", weight: 1, maxInARow: 99 }],
    },
  },
  {
    id: "jaw_worm",
    name: "颚虫",
    hpMin: 40,
    hpMax: 44,
    // MonsterIds.h:178 `{{40,44},{42,46}}`；`setRandomHp(hpRng, asc >= 7)`。
    hpHigh: { atLeast: 7, hpMin: 42, hpMax: 46 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:850 `attackPlayerHelper(bc, asc2 ? 12 : 11)`。
        id: "chomp",
        name: "撕咬",
        effects: [{ kind: "deal_damage", amount: 11, ascAmount: [{ atLeast: 2, amount: 12 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:863-865 `attackPlayerHelper(bc, 7)` + `MonsterGainBlock(idx, 5)`
        // ——两个数**都没有 asc 分档**。
        id: "thrash",
        name: "猛击",
        effects: [
          { kind: "deal_damage", amount: 7 },
          { kind: "gain_block", amount: 5 },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:855-859 `strengthBuff[] = {3,4,5}`（下标 `hallwayIdx`）
        //   + `MonsterGainBlock(idx, asc17 ? 9 : 6)`。
        // ⚠ 两个数的分档**不同宽**：力量是 2/17 两级，格挡只有 17 一级。
        id: "bellow",
        name: "咆哮",
        effects: [
          {
            kind: "apply_power",
            power: "strength",
            amount: 3,
            on: "self",
            ascAmount: [
              { atLeast: 17, amount: 5 },
              { atLeast: 2, amount: 4 },
            ],
          },
          { kind: "gain_block", amount: 6, ascAmount: [{ atLeast: 17, amount: 9 }] },
        ],
        intent: "buff",
      },
    ],
    intentRule: {
      scripted: ["chomp"],
      weighted: [
        { move: "bellow", weight: 45, maxInARow: 1 },
        { move: "thrash", weight: 30, maxInARow: 2 },
        { move: "chomp", weight: 25, maxInARow: 1 },
      ],
    },
  },
  {
    id: "louse",
    name: "红虱",
    hpMin: 10,
    hpMax: 15,
    // MonsterIds.h:187 `{{10,15},{11,16}}`；`setRandomHp(hpRng, asc >= 7)`。
    hpHigh: { atLeast: 7, hpMin: 11, hpMax: 16 },
    ascCalibrated: true,
    moves: [
      {
        id: "bite",
        // 咬击基础伤害在出生时掷定、整场固定，见 sts-combat.ts 的 constructMonster。
        // ⚠ **区间本身带 asc 分档**：`Monster.cpp:116-121` 是 `asc2 ? random(6,8) : random(5,7)`，
        //   那一档写在 constructMonster 里（它消耗 monsterHpRng，属于建怪而不是招式）。
        name: "啃咬",
        effects: [{ kind: "deal_damage_rolled" }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1011 `buff<MS::STRENGTH>(asc17 ? 4 : 3)`。
        id: "grow",
        name: "强化",
        effects: [
          {
            kind: "apply_power",
            power: "strength",
            amount: 3,
            on: "self",
            ascAmount: [{ atLeast: 17, amount: 4 }],
          },
        ],
        intent: "buff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "bite", weight: 75, maxInARow: 2 },
        { move: "grow", weight: 25, maxInARow: 2 },
      ],
    },
  },
  {
    id: "green_louse",
    name: "绿虱",
    hpMin: 11,
    hpMax: 17,
    // MonsterIds.h:173 `{{11,17},{12,18}}`；`setRandomHp(hpRng, asc >= 7)`。
    hpHigh: { atLeast: 7, hpMin: 12, hpMax: 18 },
    ascCalibrated: true,
    moves: [
      {
        id: "bite",
        // 与红虱同理：咬击基础伤害出生时掷定、整场固定，区间的 asc2 分档在 constructMonster。
        name: "啃咬",
        effects: [{ kind: "deal_damage_rolled" }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:750 `addToBot(DebuffPlayer<WEAK>(2))`——**没有 asc 分档**
        // （与红虱的强化不对称：那条有 asc17）。
        id: "spit_web",
        name: "吐丝",
        effects: [{ kind: "apply_power", power: "weak", amount: 2, on: "target" }],
        intent: "debuff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "bite", weight: 75, maxInARow: 2 },
        { move: "spit_web", weight: 25, maxInARow: 2 },
      ],
    },
  },
  // —— 史莱姆四只（第十三批校准）——
  //
  // 血量取自 `MonsterIds.h:150 monsterHpRange` 的**第一组**（`Monster::initHp` 对这四只都是
  // `setRandomHp(hpRng, ascension >= 7)`，见 `MonsterSpecific.cpp:37/68`）；招式数值取自
  // `MonsterSpecific.cpp` 的 `Monster::takeTurn`，行号逐条标在招式上。
  // ⚠ 与参考逐字比对过，八条招式与四段血量区间**一条都没有出入**，本批未改任何数值。
  // ⚠ 四只怪都**没有** `Monster::construct` 的怪种特例（`Monster.cpp:23` 的 switch 只有
  //   虱子与暗黑爬虫），也**没有** `preBattleAction`（`MonsterSpecific.cpp:141` 的 switch
  //   里没有它们），所以建怪只掷一次 monsterHpRng。
  // ⚠ `intentRule` 是**旧近似战斗的遗留数据**，游戏级实现不读它（出招走 sts-combat.ts 的
  //   `MOVE_RULES.getMoveForRoll`，那才是逐位对齐参考的那份）。留着只为 data-tables 的
  //   自洽性用例，权重/连续限制仍是估算值，不要拿它当权威。
  {
    id: "acid_slime_m",
    name: "酸液史莱姆（中）",
    // MonsterIds.h:153 `{{28,32},{29,34}}`（asc<7 取前者）。
    hpMin: 28,
    hpMax: 32,
    hpHigh: { atLeast: 7, hpMin: 29, hpMax: 34 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:373 `attackPlayerHelper(asc2 ? 8 : 7)`
        //   + `addToBot(MakeTempCardInDiscard(SLIMED))`。
        // ⚠ 黏液**张数没有 asc 分档**（只有史莱姆王的黏液喷射才有 asc19 的 5:3）。
        id: "corrosive_spit",
        name: "腐蚀喷吐",
        effects: [
          { kind: "deal_damage", amount: 7, ascAmount: [{ atLeast: 2, amount: 8 }] },
          { kind: "add_card", cardId: "slimed", pile: "discard", count: 1 },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:381 `addToBot(DebuffPlayer<WEAK>(1, true))`——没有 asc 分档。
        id: "lick",
        name: "舔舐",
        effects: [{ kind: "apply_power", power: "weak", amount: 1, on: "target" }],
        intent: "debuff",
      },
      {
        // MonsterSpecific.cpp:386 `attackPlayerHelper(asc2 ? 12 : 10)`。
        id: "tackle",
        name: "冲撞",
        effects: [{ kind: "deal_damage", amount: 10, ascAmount: [{ atLeast: 2, amount: 12 }] }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "corrosive_spit", weight: 30, maxInARow: 2 },
        { move: "tackle", weight: 40, maxInARow: 1 },
        { move: "lick", weight: 30, maxInARow: 2 },
      ],
    },
  },

  {
    id: "spike_slime_m",
    name: "尖刺史莱姆（中）",
    // MonsterIds.h:203 `{{28,32},{29,34}}`。
    hpMin: 28,
    hpMax: 32,
    hpHigh: { atLeast: 7, hpMin: 29, hpMax: 34 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1178 `attackPlayerHelper(asc2 ? 10 : 8)`
        //   + `addToBot(MakeTempCardInDiscard(CardInstance(SLIMED)))`。
        id: "flame_tackle",
        name: "扑击",
        effects: [
          { kind: "deal_damage", amount: 8, ascAmount: [{ atLeast: 2, amount: 10 }] },
          { kind: "add_card", cardId: "slimed", pile: "discard", count: 1 },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1172 `addToBot(DebuffPlayer<FRAIL>(1))`——**没有 asc 分档**。
        // ⚠ 与 L 号的舔舐不对称：那条是 `asc17 ? 3 : 2`。
        // ⚠ 这一条**没有显式传** isSourceMonster，但 `Actions.h:35` 的默认值就是 true，
        //   与同族三条显式传 true 的舔舐行为一致（施加当回合不递减）。
        id: "lick_frail",
        name: "舔舐",
        effects: [{ kind: "apply_power", power: "frail", amount: 1, on: "target" }],
        intent: "debuff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "flame_tackle", weight: 30, maxInARow: 2 },
        { move: "lick_frail", weight: 70, maxInARow: 2 },
      ],
    },
  },
  {
    id: "spike_slime_s",
    name: "尖刺史莱姆（小）",
    // MonsterIds.h:204 `{{10,14},{11,15}}`。
    hpMin: 10,
    hpMax: 14,
    hpHigh: { atLeast: 7, hpMin: 11, hpMax: 15 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1204 `attackPlayerHelper(asc2 ? 6 : 5)`。
        id: "tackle_s",
        name: "冲撞",
        effects: [{ kind: "deal_damage", amount: 5, ascAmount: [{ atLeast: 2, amount: 6 }] }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [{ move: "tackle_s", weight: 1, maxInARow: 99 }],
    },
  },
  {
    id: "acid_slime_s",
    name: "酸液史莱姆（小）",
    // MonsterIds.h:154 `{{8,12},{9,13}}`。
    hpMin: 8,
    hpMax: 12,
    hpHigh: { atLeast: 7, hpMin: 9, hpMax: 13 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:398 `attackPlayerHelper(asc2 ? 4 : 3)`。
        id: "tackle_acid_s",
        name: "冲撞",
        effects: [{ kind: "deal_damage", amount: 3, ascAmount: [{ atLeast: 2, amount: 4 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:393 `addToBot(DebuffPlayer<WEAK>(1, true))`——没有 asc 分档。
        id: "lick_weak",
        name: "舔舐",
        effects: [{ kind: "apply_power", power: "weak", amount: 1, on: "target" }],
        intent: "debuff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "tackle_acid_s", weight: 50, maxInARow: 1 },
        { move: "lick_weak", weight: 50, maxInARow: 1 },
      ],
    },
  },
  {
    id: "blue_slaver",
    name: "蓝色奴隶主",
    // MonsterIds.h:157 `{{46,50},{48,52}}`（asc<7 取前者）。
    hpMin: 46,
    hpMax: 50,
    hpHigh: { atLeast: 7, hpMin: 48, hpMax: 52 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:450 `attackPlayerHelper(asc2 ? 13 : 12)`。
        id: "stab",
        name: "刺击",
        effects: [{ kind: "deal_damage", amount: 12, ascAmount: [{ atLeast: 2, amount: 13 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:443 `attackPlayerHelper(asc2 ? 8 : 7)`
        //   + `addToBot(DebuffPlayer<WEAK>(asc17 ? 2 : 1, true))`。
        // ⚠ 两个数分档**不同宽**（伤害 asc2、虚弱 asc17），照抄不要统一。
        id: "rake",
        name: "耙击",
        effects: [
          { kind: "deal_damage", amount: 7, ascAmount: [{ atLeast: 2, amount: 8 }] },
          {
            kind: "apply_power",
            power: "weak",
            amount: 1,
            on: "target",
            ascAmount: [{ atLeast: 17, amount: 2 }],
          },
        ],
        intent: "attack",
      },
    ],
    // asc0：roll>=40→刺击、否则耙击；两招各最多连两次（sts_lightspeed lastTwoMoves）。
    intentRule: {
      scripted: [],
      weighted: [
        { move: "stab", weight: 60, maxInARow: 2 },
        { move: "rake", weight: 40, maxInARow: 2 },
      ],
    },
  },

  {
    id: "fungi_beast",
    name: "真菌兽",
    // MonsterIds.h:172 `{{22,28},{24,28}}`（asc<7 取前者）。
    hpMin: 22,
    hpMax: 28,
    hpHigh: { atLeast: 7, hpMin: 24, hpMax: 28 },
    ascCalibrated: true,
    // ⚠ **孢子云不写在这里。** 参考把它建模成一个 Power：`preBattleAction` 里
    // `buff<MS::SPORE_CLOUD>(2)`（MonsterSpecific.cpp:182-184，参考自注「the value here
    // isn't used. it is always 2」），死亡时由 `Monster::die` 读 `hasStatus<SPORE_CLOUD>()`
    // 决定放不放易伤（Monster.cpp:299-301）。两个理由让它不能退回数据表的 `deathEffects`：
    //   ① 那个 Power **会出现在 trace 的怪物快照里**（`SPORE_CLOUD: 2`），不建模就对不上；
    //   ② 易伤的层数 2 与 isSourceMonster 都是 `die` 里硬写的，写进数据表就是两份真相
    //      （与第十五批 `steal_gold` 去掉 `amount` 同一条理由）。
    // 见 sts-combat.ts 的 `PRE_BATTLE_ACTION.fungi_beast` 与 `monsterDie`。
    moves: [
      {
        // MonsterSpecific.cpp:691 `attackPlayerHelper(bc, 6)`——**没有 asc 分档**
        // （MonsterMoveDamage.cpp:72 同样是裸的 `{6}`）。
        id: "fungi_bite",
        name: "撕咬",
        effects: [{ kind: "deal_damage", amount: 6 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:696-700 `buff<MS::STRENGTH>(strengthBuff[hallwayIdx])`，
        // `strengthBuff[] = {3,4,5}`、`hallwayIdx = getTriIdx(asc, 2, 17)`，故 asc0 是 3。
        // ⚠ 是**同步** buff（不是 addToBot），与颚虫的咆哮同形。
        id: "fungi_grow",
        name: "成长",
        effects: [
          {
            kind: "apply_power",
            power: "strength",
            amount: 3,
            on: "self",
            ascAmount: [
              { atLeast: 17, amount: 5 },
              { atLeast: 2, amount: 4 },
            ],
          },
        ],
        intent: "buff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（roll<60 那段带「连两次撕咬就成长」的连续限制，
    // 否则「刚成长完就撕咬」）。⚠ `MonsterMoves.h:455` 的攻击白名单里只有 FUNGI_BEAST_BITE，
    // FUNGI_BEAST_GROW **不在**，与上面的 attack / buff 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 地精帮（狂暴/鬼祟/肥胖/护盾/巫师，第十七批）——
  //
  // 五只怪的 `getMoveForRoll` 全部**不看 roll**、恒返回同一招（MonsterSpecific.cpp:2311 /
  // :2458 / :2527 / :2719 / :2767），真正决定「下回合出什么」的都在 takeTurn 的 case 尾部
  // ——见 sts-combat.ts 的 `MOVE_TURN_END`。所以这里的 intentRule 一律留空。
  {
    id: "mad_gremlin",
    name: "狂暴地精",
    // MonsterIds.h:182 `{{20,24},{21,25}}`（asc<7 取前者）。
    hpMin: 20,
    hpMax: 24,
    hpHigh: { atLeast: 7, hpMin: 21, hpMax: 25 },
    ascCalibrated: true,
    // ⚠ **狂怒（ANGRY）不写在这里**：参考在 `preBattleAction` 里 `buff<MS::ANGRY>(asc17 ? 2 : 1)`
    // （MonsterSpecific.cpp:156-158），受击时由 `Monster::attacked` 读它加力量
    // （Monster.cpp:424-426）。理由与真菌兽的孢子云同：它会出现在 trace 的怪物快照里
    // （`ANGRY: 1`），且触发时点（**格挡吸收之前**、连打空的攻击也算）是引擎侧的事，
    // 数据表表达不了。见 sts-combat.ts 的 `PRE_BATTLE_ACTION.mad_gremlin` 与 `monsterAttacked`。
    moves: [
      {
        // MonsterSpecific.cpp:659 `attackPlayerHelper(bc, asc2 ? 5 : 4)`。
        id: "scratch",
        name: "抓挠",
        effects: [{ kind: "deal_damage", amount: 4, ascAmount: [{ atLeast: 2, amount: 5 }] }],
        intent: "attack",
      },
    ],
    intentRule: { scripted: [], weighted: [] },
  },
  {
    id: "sneaky_gremlin",
    name: "鬼祟地精",
    // MonsterIds.h:198 `{{10,14},{11,15}}`（asc<7 取前者）。
    hpMin: 10,
    hpMax: 14,
    hpHigh: { atLeast: 7, hpMin: 11, hpMax: 15 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:669 `attackPlayerHelper(bc, asc2 ? 10 : 9)`。
        id: "puncture",
        name: "穿刺",
        effects: [{ kind: "deal_damage", amount: 9, ascAmount: [{ atLeast: 2, amount: 10 }] }],
        intent: "attack",
      },
    ],
    intentRule: { scripted: [], weighted: [] },
  },
  {
    id: "fat_gremlin",
    name: "肥胖地精",
    // MonsterIds.h:171 `{{13,17},{14,18}}`（asc<7 取前者）。
    hpMin: 13,
    hpMax: 17,
    hpHigh: { atLeast: 7, hpMin: 14, hpMax: 18 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:643-648 `attackPlayerHelper(bc, asc2 ? 5 : 4)`
        //   + `addToBot(DebuffPlayer<WEAK>(1, true))`
        //   + `if (asc17) addToBot(DebuffPlayer<FRAIL>(1, true))`。
        // ⚠ 虚弱层数**没有 asc 分档**（恒 1）；asc17 是**多出来一整条效果**（脆弱 1），
        //   不是把某个数换掉——这是 `minAscension` 存在的唯一理由，见 types.ts。
        // ⚠ 脆弱排在虚弱**之后**（入队顺序 = 书写顺序），照抄不要提前。
        id: "smash",
        name: "猛击",
        effects: [
          { kind: "deal_damage", amount: 4, ascAmount: [{ atLeast: 2, amount: 5 }] },
          { kind: "apply_power", power: "weak", amount: 1, on: "target" },
          { kind: "apply_power", power: "frail", amount: 1, on: "target", minAscension: 17 },
        ],
        intent: "attack",
      },
    ],
    intentRule: { scripted: [], weighted: [] },
  },
  {
    id: "shield_gremlin",
    name: "护盾地精",
    // MonsterIds.h:195 `{{12,15},{13,17}}`（asc<7 取前者）。
    hpMin: 12,
    hpMax: 15,
    hpHigh: { atLeast: 7, hpMin: 13, hpMax: 17 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1095-1099 `blockAmounts[] = {7,8,11}`、
        // `getTriIdx(asc, 7, 17)` → asc0 取 7，然后 `addToBot(GainBlockRandomEnemy(idx, ...))`。
        // ⚠⚠ **这条的分档阈值是 7/17，不是 2/17**——`getTriIdx(asc, 7, 17)` 与走廊小怪那个
        //   `hallwayIdx = getTriIdx(asc, 2, 17)` 长得几乎一样，全项目只有这一处用 7。
        //   照抄别顺手写成 2。
        // ⚠ 目标是**随机一名友军**（排除自己、排除已死的），只剩自己时才给自己
        // ——那一支**不掷 aiRng**。见 sts-combat.ts 的 `gainBlockRandomEnemy`。
        id: "protect",
        name: "保护",
        effects: [
          {
            kind: "gain_block_ally",
            amount: 7,
            ascAmount: [
              { atLeast: 17, amount: 11 },
              { atLeast: 7, amount: 8 },
            ],
          },
        ],
        intent: "defend",
      },
      {
        // MonsterSpecific.cpp:1105-1107 `attackPlayerHelper(bc, asc2 ? 8 : 6)`。
        // ⚠ 这一招只在**场上只剩它自己**时才会被选中（保护那条 case 的尾部判定），
        //   所以它是本批覆盖最薄的一条。
        id: "shield_bash",
        name: "盾击",
        effects: [{ kind: "deal_damage", amount: 6, ascAmount: [{ atLeast: 2, amount: 8 }] }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts：`MOVE_RULES.shield_gremlin` 恒返回保护，
    // 「只剩自己就改成盾击」在 `MOVE_TURN_END["shield_gremlin/protect"]`。
    // ⚠ `MonsterMoves.h:493` 的攻击白名单里只有 SHIELD_GREMLIN_SHIELD_BASH，
    // SHIELD_GREMLIN_PROTECT **不在**，与上面的 attack / defend 一致。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    id: "gremlin_wizard",
    name: "地精巫师",
    // MonsterIds.h:177 `{{21,25},{22,26}}`（asc<7 取前者）。
    hpMin: 21,
    hpMax: 25,
    hpHigh: { atLeast: 7, hpMin: 22, hpMax: 26 },
    ascCalibrated: true,
    moves: [
      // MonsterSpecific.cpp:774-780：整条 case **没有任何效果**，只有 `++miscInfo`
      // 与「攒够 3 次就改出大招」。两句都是引擎侧记账，分别落在 sts-combat.ts 的
      // `MOVE_TURN_BEGIN` / `MOVE_TURN_END`。
      { id: "charging", name: "蓄力", effects: [], intent: "unknown" },
      {
        // MonsterSpecific.cpp:782-789 `attackPlayerHelper(bc, asc2 ? 30 : 25)`。
        // ⚠ 同一条 case 的**收尾**也带 asc 分档（`if (!asc17) { miscInfo = 0; setMove(蓄力); }`）
        //   ——asc17 起大招之后意图**不回蓄力**，于是它每回合都放。那一半在
        //   sts-combat.ts 的 `MOVE_TURN_END["gremlin_wizard/ultimate_blast"]`。
        id: "ultimate_blast",
        name: "终极爆发",
        effects: [{ kind: "deal_damage", amount: 25, ascAmount: [{ atLeast: 2, amount: 30 }] }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts：`MOVE_RULES.gremlin_wizard` 恒返回蓄力**并把 miscInfo 置 1**，
    // 蓄力计数与循环在 `MOVE_TURN_BEGIN` / `MOVE_TURN_END`。
    // ⚠ `MonsterMoves.h:462` 的攻击白名单里只有 GREMLIN_WIZARD_ULTIMATE_BLAST，
    // GREMLIN_WIZARD_CHARGING **不在**，与上面的 attack / unknown 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  {
    id: "looter",
    name: "拾荒者",
    // MonsterIds.h:181 `{{44,48},{46,50}}`（asc<7 取前者）。
    hpMin: 44,
    hpMax: 48,
    hpHigh: { atLeast: 7, hpMin: 46, hpMax: 50 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:918 `stealGoldFromPlayer(bc, getStatus<MS::THIEVERY>())`
        //   + `attackPlayerHelper(asc2 ? 11 : 10)`。
        // ⚠ **偷金在攻击之前**（偷是同步、攻击是入队），照抄书写顺序。
        // ⚠ 这条 case 的首尾还有两处只能写进代码的东西，见 sts-combat.ts 的
        //   `MOVE_TURN_BEGIN` / `MOVE_TURN_END`（首回合白掷一次 aiRng 的对白、
        //   以及「下一招是什么」那个带 aiRng 的分支）。
        // ⚠ 偷金额度本身也有 asc 分档（`buff<THIEVERY>(asc17 ? 20 : 15)`），但那是
        //   preBattleAction 里的 Power 层数，不是招式数值，写在 sts-combat.ts。
        id: "mug",
        name: "抢劫",
        effects: [
          { kind: "steal_gold" },
          { kind: "deal_damage", amount: 10, ascAmount: [{ atLeast: 2, amount: 11 }] },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:911 `stealGoldFromPlayer(...)` + `attackPlayerHelper(asc2 ? 14 : 12)`。
        // ⚠ asc0 是 **12**，不是与 MUG 同族的 11——参考这两行的 asc2 差值不同（+2 / +1）。
        id: "lunge",
        name: "猛扑",
        effects: [
          { kind: "steal_gold" },
          { kind: "deal_damage", amount: 12, ascAmount: [{ atLeast: 2, amount: 14 }] },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:937 `addBlock(6)`——**同步**加格挡，不是
        // `addToBot(MonsterGainBlock)`（颚虫才是入队的那种），故 `sync: true`。
        // **没有 asc 分档**（恒 6）。
        id: "smoke_bomb",
        name: "烟雾弹",
        effects: [{ kind: "gain_block", amount: 6, sync: true }],
        intent: "defend",
      },
      {
        // MonsterSpecific.cpp:899 `isEscapingB = true; --monstersAlive;`（并在归零时判胜）。
        // ⚠ `MonsterMoves.h` 的攻击白名单里**没有** LOOTER_ESCAPE / LOOTER_SMOKE_BOMB，
        //   与这里的 unknown / defend 一致。
        id: "flee",
        name: "逃跑",
        effects: [{ kind: "escape" }],
        intent: "unknown",
      },
    ],
    // 出招全部由 takeTurn 的同步 setMove 锁定（抢劫 → 抢劫 → 猛扑/烟雾弹 → … → 逃跑），
    // `getMoveForRoll` 只在开局被调用一次且恒返回抢劫，见 sts-combat.ts 的 MOVE_RULES。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    id: "red_slaver",
    name: "红色奴隶主",
    // MonsterIds.h:189 `{{46,50},{48,52}}`（asc<7 取前者）。
    hpMin: 46,
    hpMax: 50,
    hpHigh: { atLeast: 7, hpMin: 48, hpMax: 52 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1029 `attackPlayerHelper(asc2 ? 14 : 13)`。
        id: "rs_stab",
        name: "刺击",
        effects: [{ kind: "deal_damage", amount: 13, ascAmount: [{ atLeast: 2, amount: 14 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1023 `attackPlayerHelper(asc2 ? 9 : 8)`
        //   + `addToBot(DebuffPlayer<VULNERABLE>(asc17 ? 2 : 1))`。
        // ⚠ 这一条**没有显式传** isSourceMonster，但 `Actions.h:35` 的默认值就是 true
        //   （与蓝奴隶主耙击显式传 true 一致），故施加当回合不递减。
        id: "scrape",
        name: "刮擦",
        effects: [
          { kind: "deal_damage", amount: 8, ascAmount: [{ atLeast: 2, amount: 9 }] },
          {
            kind: "apply_power",
            power: "vulnerable",
            amount: 1,
            on: "target",
            ascAmount: [{ atLeast: 17, amount: 2 }],
          },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1017 那条 case：`addToBot(DebuffPlayer<PS::ENTANGLED>(1))`。
        // ⚠ 同一条 case 里还有一句**第十六批给参考补上的** `miscInfo = 1`（置 usedEntangle），
        //   它不是效果、是引擎侧记账，写在 sts-combat.ts 的 `MOVE_TURN_BEGIN`。
        id: "entangle",
        name: "缠绕",
        effects: [{ kind: "apply_power", power: "entangled", amount: 1, on: "target" }],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（首招刺击；「缠绕一场只放一次」自第十六批的
    // 参考侧补丁起真的生效，随之复活的 `roll >= 50` 那段阈值**未经验证**，见那里的注释）。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第二幕（城市）普通敌人 ——
  //
  // ⚠ 第二十三批开了第二幕，但**只有本批这三只**（食蛇草 / 球状守卫者 / 选民）经过
  //   trace 校准。同文件里其余的第二 / 三幕怪仍是旧近似数据，未登记、开战即抛错。
  {
    // —— 第二十三批：食蛇草（第二幕，`SNAKE_PLANT` 单怪编队）——
    //
    // ⚠ 全项目只有它与蠕动血块带**易塑**（MALLEABLE）。开局 3 层写在 `PRE_BATTLE_ACTION`，
    //   受击成长与回合末复位写在 sts-combat.ts，不在这张表里（同真菌兽的孢子云）。
    id: "snake_plant",
    name: "食蛇草",
    // MonsterIds.h:197 `{{75,79},{78,82}}`（普通怪阈值 asc>=7，MonsterSpecific.cpp:64）。
    hpMin: 75,
    hpMax: 79,
    hpHigh: { atLeast: 7, hpMin: 78, hpMax: 82 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1131-1134 `attackPlayerHelper(bc, asc2 ? 8 : 7, 3)`。
        // ⚠ **三段**，不是一下 7 点——旧近似表把它写成单段 7，数值与段数都错。
        // ⚠ 分档挂在**每击伤害**上（第一个实参），段数恒 3。
        id: "sp_chomp",
        name: "撕咬",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 7,
            times: 3,
            ascAmount: [{ atLeast: 2, amount: 8 }],
          },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1136-1140：**先脆弱后虚弱**，两条都是 `addToBot(DebuffPlayer)`。
        // ⚠ 顺序照抄（旧表写反了）。两条各 2 层、都带 `isSourceMonster = true`。
        // ⚠ **两条都没有 asc 分档**（第三十批逐条确认，不是漏了）。
        id: "sp_spores",
        name: "散播孢子",
        effects: [
          { kind: "apply_power", power: "frail", amount: 2, on: "target" },
          { kind: "apply_power", power: "weak", amount: 2, on: "target" },
        ],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES。
    // ⚠ 攻击白名单里只有 `SNAKE_PLANT_CHOMP`（`MonsterMoves.h:495`），
    //   `SNAKE_PLANT_ENFEEBLING_SPORES` **不在**——与这里的 attack / debuff 一致。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    // —— 第二十三批：球状守卫者（第二幕，`SPHERIC_GUARDIAN` 单怪编队）——
    //
    // ⚠ 三样东西都不写在这张表里（写在这里就是第二份真相）：
    //   * 神器 3 层 / **壁垒** / 开局 40 点格挡 → `PRE_BATTLE_ACTION.spheric_guardian`；
    //   * 四条招式的「下一招是谁」全是 case 尾部的**同步 setMove + 同步 noOpRollMove**
    //     → `MOVE_TURN_END`（于是它的 `getMoveForRoll` 整场只被调用一次）。
    // ⚠ 它是**怪物侧第一次出现壁垒**：格挡从此不在怪物回合开始清空，见 `applyPreTurnLogic`。
    id: "spheric_guardian",
    name: "球状守卫者",
    // MonsterIds.h:200 `{{20,20},{20,20}}`。
    // ⚠⚠ `hpNoRoll`：这只怪走的是 `Monster::initHp` 里**不掷 RNG** 的那条 case
    //   （MonsterSpecific.cpp:119-124，直接 `curHp = monsterHpRange[id][0][0]`）。
    //   与守卫者的 `{240,240}`「上下界相同但照掷一次」完全不同——写错会让此后每一次
    //   monsterHpRng 取值整体错位。详见 `EnemyDef.hpNoRoll` 的注释。
    hpMin: 20,
    hpMax: 20,
    hpNoRoll: true,
    // 第三十批：招式数值的 asc 分档已校准。
    // ⚠⚠ **它是唯一「标了 `ascCalibrated` 却没有 `hpHigh`」的怪**：`hpNoRoll` 那条 case
    //   （MonsterSpecific.cpp:119-124）压根不看 ascension，两组区间也都是 `{20,20}`。
    //   `data-tables.test.ts` 的 `ASC_CALIBRATED` 因此给它记的是 `null`（= 校准了但没有第二组）。
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1166-1170 `addBlock(asc17 ? 35 : 25)`。
        // ⚠ 是**同步**的裸 `addBlock`（同守卫者的蓄能），不是 `addToBot(MonsterGainBlock)`。
        id: "sg_activate",
        name: "激活",
        effects: [
          { kind: "gain_block", amount: 25, sync: true, ascAmount: [{ atLeast: 17, amount: 35 }] },
        ],
        intent: "defend",
      },
      {
        // MonsterSpecific.cpp:1186-1190 `attackPlayerHelper(bc, asc2 ? 11 : 10, 2)`（**两段**）。
        id: "sg_slam",
        name: "猛击",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 10,
            times: 2,
            ascAmount: [{ atLeast: 2, amount: 11 }],
          },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1179-1184。⚠ **加格挡排在攻击之前**，而且是
        //   `addToBot(MonsterGainBlock(idx, 15))` ——**入队**（与激活那条的同步 addBlock
        //   不同，同一只怪身上两种写法并存，照抄不要统一）。所以这 15 点格挡在队列里
        //   排在自己这一击之前，玩家看到的是「先鼓起来再打」。
        // ⚠⚠ **它就是 `isMoveAttack` 白名单里那个「带伤害却也加格挡」的反例**
        //   （`MonsterMoves.h:500`）：招式名与效果都像防御，白名单却把它算作攻击。
        //   见 sts-combat.ts 的 `MONSTER_ATTACK_MOVES`。
        // ⚠ 那 15 点格挡**没有** asc 分档（第三十批逐条确认），只有伤害有。
        id: "sg_harden",
        name: "硬化",
        effects: [
          { kind: "gain_block", amount: 15 },
          { kind: "deal_damage", amount: 10, ascAmount: [{ atLeast: 2, amount: 11 }] },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1172-1177：攻击 + `addToBot(DebuffPlayer<FRAIL>(5, true))`。
        // ⚠ 脆弱 5 层**没有** asc 分档（第三十批逐条确认）。
        id: "sg_attack_debuff",
        name: "攻击削弱",
        effects: [
          { kind: "deal_damage", amount: 10, ascAmount: [{ atLeast: 2, amount: 11 }] },
          { kind: "apply_power", power: "frail", amount: 5, on: "target" },
        ],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（恒返回激活，且只被调用一次）。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    // —— 第二十六批：百夫长（第二幕，`CENTURION_AND_HEALER`）——
    //
    // ✅ **第三十批校准了爬升度分档**（`ascCalibrated`），此前只有 asc0 的背书。
    id: "centurion",
    name: "百夫长",
    // MonsterIds.h:161 `{{76,80},{76,83}}`；普通怪阈值 `setRandomHp(hpRng, asc >= 7)`
    // （MonsterSpecific.cpp:43）。
    // ⚠ 高档的下界与低档**相同**（76）、只有上界变宽，抄的时候别顺手写成 78。
    hpMin: 76,
    hpMax: 80,
    hpHigh: { atLeast: 7, hpMin: 76, hpMax: 83 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:576-578 `attackPlayerHelper(bc, asc2 ? 14 : 12)`。
        id: "cent_slash",
        name: "斩击",
        effects: [{ kind: "deal_damage", amount: 12, ascAmount: [{ atLeast: 2, amount: 14 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:571-574 `attackPlayerHelper(bc, asc2 ? 7 : 6, 3)`（**三段 6**）。
        // ⚠⚠ **这一招的效果曾是第二十六~三十批最大的一条盲区（0 例）**，因为要让活着的
        //   百夫长出它得让秘法师先死，而 harness 的策略当时恒打 0 号位、百夫长恒在 0 号位。
        //   ✅ **第三十一批的目标策略轴关掉了**（`centurion_and_healer@tgt1`）：
        //   每击伤害 6→7 红 **91 例**、段数 3→2 红 **96 例**、收尾红 **88 例**。
        //   ⚠ **只剩下面那条 `ascAmount` 的 asc2 档还是 0**——`@tgt1` 只做了 asc0，
        //   关门条件是 `asc19 × tgt1` 那个组合。详见 sts-combat.ts 的 `MOVE_RULES.centurion`。
        id: "cent_fury",
        name: "狂怒连斩",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 6,
            times: 3,
            ascAmount: [{ atLeast: 2, amount: 7 }],
          },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:562-569：
        //   `if (getAliveCount() > 1) { auto &mystic = arr[1]; mystic.addBlock(asc17?20:15); }`
        // ⚠⚠ **格挡给的是 1 号位的秘法师，百夫长自己一点都不加**——旧近似表写的是
        //   「自己 +15 格挡」，那是错的。它与出招规则配套：秘法师死了之后
        //   `getMoveForRoll` 就不再返回防守（改出狂怒连斩），所以「只剩自己还出防守」
        //   这个局面在参考的内容集合里压根不存在。详见 `Effect.gain_block_ally_fixed`。
        // ⚠ 这一招的收尾是**同步的真 rollMove**，不是默认的入队 RollMove，
        //   见 `MOVE_TURN_END["centurion/cent_defend"]`。
        id: "cent_defend",
        name: "防守",
        effects: [
          { kind: "gain_block_ally_fixed", amount: 15, ascAmount: [{ atLeast: 17, amount: 20 }] },
        ],
        intent: "defend",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.centurion`（65 那道阈值 + 两条 `lastTwoMoves`，
    // 且「秘法师还活着吗」决定防守/狂怒二选一）。**不追加任何 aiRng。**
    // ⚠ 攻击白名单里是 `CENTURION_SLASH` / `CENTURION_FURY`（`MonsterMoves.h:439-440`），
    //   `CENTURION_DEFEND` **不在**——与这里的 attack / attack / defend 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  {
    // —— 第二十五批：带壳寄生虫（第二幕，`SHELL_PARASITE` / `SHELLED_PARASITE_AND_FUNGI`）——
    //
    // ⚠ **镀甲（PLATED_ARMOR）整条不写在这张表里**，写在 sts-combat.ts 的两处：
    //   `PRE_BATTLE_ACTION.shelled_parasite`（开局 14 层 + 14 点格挡）与
    //   `monsterDamageUnblocked` 的 else-if 链（受击 -1，归零改出 `stunned`），
    //   回合末加格挡在 `applyMonsterEndOfTurnTriggers`。数据表只描述招式。
    // ✅ **第三十批校准了爬升度分档**（`ascCalibrated`），此前只有 asc0 的背书。
    // ⚠ 镀甲的 14 层 / 14 点格挡**没有** asc 分档（MonsterSpecific.cpp:242-247，逐条确认）。
    id: "shelled_parasite",
    name: "带壳寄生虫",
    // MonsterIds.h:193 `{{68,72},{70,75}}`；普通怪阈值 `setRandomHp(hpRng, asc >= 7)`
    // （MonsterSpecific.cpp:62）。
    hpMin: 68,
    hpMax: 72,
    hpHigh: { atLeast: 7, hpMin: 70, hpMax: 75 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1072-1075 `attackPlayerHelper(bc, asc2 ? 7 : 6, 2)`。
        id: "double_strike",
        name: "双重打击",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 6,
            times: 2,
            ascAmount: [{ atLeast: 2, amount: 7 }],
          },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1088-1091 `addToBot(VampireAttack(calculateDamageToPlayer(bc,
        // asc2 ? 12 : 10)))`。
        // ⚠⚠ **不是「攻击 + 回固定血」**：回血量是 `min(伤害, 这一击未被格挡的部分)`，
        //   所以格挡挡住多少就少回多少、全挡住一点不回。旧近似表写的是
        //   「10 点伤害 + 固定回 10」，两处都错（那个 `heal_self` 效果原语本批一并删掉了，
        //   留着就是关于这只怪的第二份、且是错的真相）。详见 `Effect.vampire_attack`。
        id: "suck",
        name: "吸取",
        effects: [{ kind: "vampire_attack", amount: 10, ascAmount: [{ atLeast: 2, amount: 12 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1077-1081：`attackPlayerHelper(bc, asc2 ? 21 : 18)` +
        // `addToBot(DebuffPlayer<PS::FRAIL>(2, true))`。⚠ 脆弱是**入队**，排在伤害之后。
        // ⚠ 脆弱 2 层**没有** asc 分档（第三十批逐条确认）。
        id: "fell",
        name: "重击",
        effects: [
          { kind: "deal_damage", amount: 18, ascAmount: [{ atLeast: 2, amount: 21 }] },
          { kind: "apply_power", power: "frail", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1083-1086：整条 case 只有 `setMove(FELL); rollMove(bc);`
        // ——**一个效果都没有**（壳被打破那一回合什么也不做）。两句都在 `MOVE_TURN_END`。
        // ⚠ 这个意图不是 `getMoveForRoll` 掷出来的，而是**受击时**由
        //   `attackedUnblockedHelper` 在镀甲层数归零那一刻直接 `setMove` 写进去的。
        // ⚠ id 与拜鸟的 `stunned` 同名：招式 id 只需在**本只怪**的 moves 里唯一，
        //   比对逐怪进行，重名不要紧（`MOVE_TURN_END` 的键带怪物前缀）。
        id: "stunned",
        name: "眩晕",
        effects: [],
        intent: "unknown",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.shelled_parasite`
    //（首回合 50/50 双重打击或吸取；之后 20 / 60 两道阈值，且带一次会被短路吃掉的 roll2）。
    // ⚠ 攻击白名单里是 `SHELLED_PARASITE_DOUBLE_STRIKE` / `_SUCK` / `_FELL`
    //   （`MonsterMoves.h:490-492`），`_STUNNED` **不在**——与这里的 attack ×3 / unknown 一致。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    // —— 第二十三批：选民（第二幕，`CHOSEN` 单怪编队）——
    //
    // ⚠ 它是全项目**唯一**的诅咒（HEX）来源。诅咒本身的效果（玩家每打出一张非攻击牌就洗
    //   一张恍惚进抽牌堆）写在 sts-combat.ts 的三个 `onUseXxxCard` 里，不在这张表。
    id: "chosen",
    name: "选民",
    // MonsterIds.h:163 `{{95,99},{98,103}}`（普通怪阈值 asc>=7，MonsterSpecific.cpp:44）。
    // ✅ **第三十批校准了爬升度分档**（含 `getMoveForRoll` 里 asc17 那一整块）。
    hpMin: 95,
    hpMax: 99,
    hpHigh: { atLeast: 7, hpMin: 98, hpMax: 103 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:631-634 `attackPlayerHelper(bc, asc2 ? 6 : 5, 2)`（**两段 5**）。
        // ⚠ 旧近似表写的是单段 6，段数与数值都错。
        id: "poke",
        name: "戳刺",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 5,
            times: 2,
            ascAmount: [{ atLeast: 2, amount: 6 }],
          },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:636-639 `attackPlayerHelper(bc, asc2 ? 21 : 18)`。
        id: "zap",
        name: "电击",
        effects: [{ kind: "deal_damage", amount: 18, ascAmount: [{ atLeast: 2, amount: 21 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:614-618：攻击 10 + `addToBot(DebuffPlayer<VULNERABLE>(2, true))`。
        // ⚠ 易伤 2 层**没有** asc 分档（第三十批逐条确认）。
        id: "debilitate",
        name: "削弱",
        effects: [
          { kind: "deal_damage", amount: 10, ascAmount: [{ atLeast: 2, amount: 12 }] },
          { kind: "apply_power", power: "vulnerable", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:620-624。⚠ 两句的**写法不同**，照抄不要统一：
        //   虚弱 3 是 `addToBot(DebuffPlayer<WEAK>(3, true))` —— 入队；
        //   力量 3 是同步的 `buff<MS::STRENGTH>(3)`         —— `on: "self"` 省略即同步。
        // ⚠ **两条都没有 asc 分档**（第三十批逐条确认）。
        id: "drain",
        name: "汲取",
        effects: [
          { kind: "apply_power", power: "weak", amount: 3, on: "target" },
          { kind: "apply_power", power: "strength", amount: 3, on: "self" },
        ],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:626-629 `addToBot(DebuffPlayer<PS::HEX>(1))`。
        // ⚠ **没有第二个实参**，取默认的 `isSourceMonster = true`（Actions.h:35）；
        //   诅咒是纯 bool 状态，所以那个 1 只是形式上的层数，再上一次也还是 1。
        id: "hex",
        name: "诅咒",
        effects: [{ kind: "apply_power", power: "hex", amount: 1, on: "target" }],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（首招戳刺、第二招诅咒，之后 roll）。
    // ⚠ 攻击白名单里有 `CHOSEN_POKE` / `CHOSEN_ZAP` / `CHOSEN_DEBILITATE`
    //   （`MonsterMoves.h:441-443`），**不在**的是 `CHOSEN_DRAIN` 与 `CHOSEN_HEX`
    //   ——与这里的 attack / attack / attack / buff / debuff 一致。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    // —— 第二十五批：史尼克（第二幕，`SNECKO` 单怪编队）——
    //
    // ⚠ 它是全项目**唯一**会施加困惑（CONFUSED）的怪（另一个来源是遗物蛇眼，
    //   `BattleContext.cpp:216`，遗物没登记）。困惑本身的效果**不在这张表里**：
    //   它整条住在 `CardManager::draw`（CardManager.cpp:403-412），见 sts-combat.ts 的
    //   `drawOneCard`。这里只有「施加它」这一下。
    // ✅ **第三十批校准了爬升度分档**（含尾击 asc17 那条多出来的虚弱）。
    id: "snecko",
    name: "史尼克",
    // MonsterIds.h:198 `{{114,120},{120,125}}`；普通怪阈值 asc>=7（MonsterSpecific.cpp:66）。
    hpMin: 114,
    hpMax: 120,
    hpHigh: { atLeast: 7, hpMin: 120, hpMax: 125 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1150-1153 `addToBot(DebuffPlayer<PS::CONFUSED>())`。
        // ⚠ **两个实参都省略了**，取默认的 `amount = 1` 与 `isSourceMonster = true`
        //   （Actions.h:35）；困惑是纯 bool，那个 1 只是形式上的层数（`Player::debuff`
        //   对它走 `setHasStatus(true); return;`，再上一次也还是 1）。
        // ⚠ 它是**入队**的，所以与同回合别的动作的先后看得见。
        id: "perplexing_glare",
        name: "惑目",
        effects: [{ kind: "apply_power", power: "confused", amount: 1, on: "target" }],
        intent: "debuff",
      },
      {
        // MonsterSpecific.cpp:1145-1148 `attackPlayerHelper(bc, asc2 ? 18 : 15)`。
        id: "snecko_bite",
        name: "撕咬",
        effects: [{ kind: "deal_damage", amount: 15, ascAmount: [{ atLeast: 2, amount: 18 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1155-1163：`attackPlayerHelper(bc, asc2 ? 10 : 8)` +
        // `addToBot(DebuffPlayer<VULNERABLE>(2, true))` + asc17 时**再多一条**
        // `addToBot(DebuffPlayer<WEAK>(2, true))`。
        // ⚠ 旧近似表把易伤写成了虚弱——参考这一招上的是**易伤**，虚弱是 asc17 才追加的
        //   第二条。⚠ 那第二条是 `minAscension` 那一族（**整条效果**多出来），
        //   **不是**「同一个数换个值」——第三十批转写，同族先例是肥胖地精的 asc17 脆弱。
        // ⚠ 易伤 2 层本身**没有** asc 分档，只有伤害有。
        id: "tail_whip",
        name: "尾击",
        effects: [
          { kind: "deal_damage", amount: 8, ascAmount: [{ atLeast: 2, amount: 10 }] },
          { kind: "apply_power", power: "vulnerable", amount: 2, on: "target" },
          { kind: "apply_power", power: "weak", amount: 2, on: "target", minAscension: 17 },
        ],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.snecko`（首回合必惑目，之后 40 那道阈值
    // 加一条连续限制）。**不追加任何 aiRng**。
    // ⚠ 攻击白名单里是 `SNECKO_TAIL_WHIP` / `SNECKO_BITE`（`MonsterMoves.h:497-498`），
    //   `SNECKO_PERPLEXING_GLARE` **不在**——与这里的 debuff / attack / attack 一致。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    // —— 第二十六批：秘法师（第二幕，`CENTURION_AND_HEALER`）——
    //
    // ⚠ 它是全项目**唯一**给友军治疗 / 加力量的怪，两条效果原语（`heal_ally` /
    //   `buff_ally`）都是为它加的。三招里有两招都是「照顾 0 号位 + 照顾自己」，
    //   目标写死、一次 RNG 都不掷——**不要按护盾地精那条「随机友军」照搬**。
    // ✅ **第三十批校准了爬升度分档**（治疗量 / 鼓舞的三档 / 法击伤害，以及出招规则里
    //   那两处 asc17——缺血阈值 21 与「连续限制从 `lastTwoMoves` 收紧成 `lastMove`」）。
    id: "mystic",
    name: "秘法师",
    // MonsterIds.h:183 `{{48,56},{50,58}}`；普通怪阈值 `setRandomHp(hpRng, asc >= 7)`
    // （MonsterSpecific.cpp:56）。
    hpMin: 48,
    hpMax: 56,
    hpHigh: { atLeast: 7, hpMin: 50, hpMax: 58 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:600-608：`healAmt = asc17 ? 20 : 16`，
        //   `if (monstersAlive > 1) arr[0].heal(healAmt);` 然后 `heal(healAmt);`
        // ⚠ **两只都回**（同伴活着时），不是「二选一」；且目标写死 0 号位、不看谁受伤。
        // ⚠ 出招规则里的「缺血阈值」是 **21**（asc17）/ 16，与这里的**治疗量** 20 / 16
        //   **不是同一个数**——asc17 下阈值 21 > 治疗量 20，照抄别对齐成一个常量。
        id: "mystic_heal",
        name: "治疗",
        effects: [{ kind: "heal_ally", amount: 16, ascAmount: [{ atLeast: 17, amount: 20 }] }],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:588-598：`strAmts[] {2,3,4}` + `hallwayIdx = getTriIdx(asc,2,17)`，
        //   `if (monstersAlive > 1) arr[0].buff<MS::STRENGTH>(n);` 然后 `buff<MS::STRENGTH>(n);`
        // ⚠ 旧近似表写的是 `apply_power on: "all_enemies"`——在两只怪的编队里恰好同解，
        //   但语义不同（那个是「场上每一只」，这个是「0 号位与自己」）。
        // ⚠ 分档是**走廊小怪**那一族（`getTriIdx(asc, 2, 17)`），不是精英的 3 / 18
        //   ——秘法师虽然出现在精英编队里，`takeTurn` 里读的却是 `hallwayIdx`。
        //   ⚠⚠ 中间那一档（asc2 的 3）在 `{0, 19}` 这对档位下**不可达**，见 TODOS 盲区表。
        id: "mystic_buff",
        name: "鼓舞",
        effects: [
          {
            kind: "buff_ally",
            power: "strength",
            amount: 2,
            ascAmount: [
              { atLeast: 2, amount: 3 },
              { atLeast: 17, amount: 4 },
            ],
          },
        ],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:581-586：`attackPlayerHelper(bc, asc2 ? 9 : 8)` +
        // `addToBot(DebuffPlayer<PS::FRAIL>(2, true))`。⚠ 脆弱是**入队**，排在伤害之后
        // （与带壳寄生虫的重击同形）。
        // ⚠ 脆弱 2 层**没有** asc 分档（第三十批逐条确认）。
        id: "mystic_attack",
        name: "法击",
        effects: [
          { kind: "deal_damage", amount: 8, ascAmount: [{ atLeast: 2, amount: 9 }] },
          { kind: "apply_power", power: "frail", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.mystic`（缺血就强制治疗 → 40 那道阈值 →
    // 连续限制）。**不追加任何 aiRng。**
    // ⚠ 攻击白名单里只有 `MYSTIC_ATTACK_DEBUFF`（`MonsterMoves.h:475`），
    //   `MYSTIC_HEAL` / `MYSTIC_BUFF` **都不在**——与这里的 buff / buff / attack 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第二幕精英 ——
  // 地精首领（第二十七批）：`monsterHpRange[GREMLIN_LEADER] = {{140,148},{145,155}}`
  //（MonsterIds.h:175），走 `setRandomHp(hpRng, asc >= 8)` 的**精英**那一支
  //（MonsterSpecific.cpp:90-101，与地精头目 / 拉加维林 / 刺穿之书同一条 case）。
  // ⚠ 它恒在 **3 号位**，0/1/2 三格是「随从位」：`MonsterGroup` 建 1/2 两只随机小鬼、
  //   `monsterCount = 4` 而 0 号位**从没被构造过**（见 `ENCOUNTER_BUILDERS.gremlin_leader`）。
  // ✅ **第三十批校准了爬升度分档**（`hpHigh` 走精英档 asc>=8；鼓舞那两个分档此前就写好了，
  //   本批第一次有预言机看着它们）。
  {
    id: "gremlin_leader",
    name: "地精首领",
    hpMin: 140,
    hpMax: 148,
    hpHigh: { atLeast: 8, hpMin: 145, hpMax: 155 },
    ascCalibrated: true,
    moves: [
      // 集结：召唤两只小鬼填进空位（MonsterSpecific.cpp:729-734）。
      // ⚠ 参考的枚举名是 `GREMLIN_LEADER_RALLY`，不是「召唤地精」——招式 id 跟着行为走。
      // ⚠ 它**不在** `isMoveAttack` 白名单里（MonsterMoves.h 只有 `GREMLIN_LEADER_STAB`）。
      {
        id: "rally",
        name: "集结",
        effects: [{ kind: "summon_gremlins" }],
        intent: "unknown",
      },
      // 鼓舞：给 0/1/2 三格里没死的各 +3 力量 +6 格挡，然后自己 +3 力量（**不加格挡**）。
      // 对齐 MonsterSpecific.cpp:710-727，逐条见 `buff_minions` 的注释。
      // ⚠ 力量档是 `{3,4,5}[eliteDiffIdx]`（阈值 3 / 18，**精英**那一组），
      //   格挡档是 `asc3 ? 10 : 6`——两个独立分档。当前 asc0 取 3 / 6。
      // ⚠ 效果之前还白掷一次 `aiRng.random(0,2)`（游戏里的对白），见 `MOVE_TURN_BEGIN`。
      {
        id: "encourage",
        name: "鼓舞",
        effects: [
          {
            kind: "buff_minions",
            power: "strength",
            amount: 3,
            ascAmount: [
              { atLeast: 3, amount: 4 },
              { atLeast: 18, amount: 5 },
            ],
            block: 6,
            blockAscAmount: [{ atLeast: 3, amount: 10 }],
          },
        ],
        intent: "buff",
      },
      // 突刺：`attackPlayerHelper(bc, 6, 3)` —— **三段各 6 点**，不是一次 6 点
      //（MonsterSpecific.cpp:736-740）。多段的伤害只算一次快照，见 takeTurn 的注释。
      // ⚠ **没有 asc 分档**（那两个实参都是字面量）。
      {
        id: "gl_stab",
        name: "突刺",
        effects: [{ kind: "deal_damage_multi", amount: 6, times: 3 }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.gremlin_leader`——它按**活着的小鬼数**
    // （0 / 1 / >1）分成三整块，其中「1 只」那块还会追加一次 aiRng。**不能用权重表达。**
    intentRule: { scripted: [], weighted: [] },
  },
  // 工头（第二十七批）：`monsterHpRange[TASKMASTER] = {{54,60},{57,64}}`（MonsterIds.h:208）。
  // ⚠⚠ 它走的是 `Monster::initHp` 里「**先白掷一次再掷**」那一族
  //   （MonsterSpecific.cpp:114-117）：`hpRng.random(54,60); setRandomHp(hpRng, asc >= 8);`
  //   ——一次建怪消耗 **2 次** monsterHpRng。见 `hpDiscardRoll`。
  // ✅ **第三十批校准了爬升度分档**（`hpHigh` 走精英档 asc>=8），并**补上了 asc18 那条
  //   多出来的入队自身 buff**——第二十七批挂的那笔账，见下。
  {
    id: "taskmaster",
    name: "工头",
    hpMin: 54,
    hpMax: 60,
    hpHigh: { atLeast: 8, hpMin: 57, hpMax: 64 },
    hpDiscardRoll: { min: 54, max: 60 },
    ascCalibrated: true,
    moves: [
      {
        id: "scouring_whip",
        name: "抽打",
        // 对齐 MonsterSpecific.cpp:1234-1247，整条 case 是：
        //   `attackPlayerHelper(bc, 7);`
        //   `if (asc18)      { addToBot(BuffEnemy<STRENGTH>(idx, 1)); addToBot(MakeTempCard(WOUND, 3)); }`
        //   `else if (asc3)  { addToBot(MakeTempCard(WOUND, 2)); }`
        //   `else            { addToBot(MakeTempCard(WOUND)); }`
        //   `bc.noOpRollMove();`
        // ⚠ 伤害 7 是**字面量**，没有分档；张数三档：`asc18 ? 3 : asc3 ? 2 : 1`
        //（分档挂在 `count` 上，与哨卫射钉 / 史莱姆王黏液同族）。
        // ⚠⚠ **asc18 多出一整条效果**（不是「换个数」）：`addToBot(BuffEnemy<STRENGTH>(idx, 1))`
        //   ——**入队**的自身 buff，排在伤害之后、塞伤口之前。第二十七批把它跳过了，理由是
        //   我们的 `apply_power on: "self"` 恒同步、表达不了；第三十批给那一族加了 `sync` 位
        //   （**省略仍是同步**，故已登记的 40 余处自身 buff 一位都不用回填），这里写 `sync: false`。
        //   ⚠ 「入队」是可观察的：那 1 点力量要等动作出队才落，本回合这一鞭的伤害吃不到它
        //   （伤害在 `attackPlayerHelper` 里已经算好了）。⚠ 顺序也照抄——力量在伤口**之前**入队。
        // ⚠ 伤口**打不出**（`CardInstance.cpp:329` 的例外只放行黏液），所以它不在
        //   `CARD_RULES` 里、也不能进 `check-coverage.mjs` 的 `--no-upgrade` 段，
        //   但**照样有背书**：它躺在弃牌堆快照里被逐帧比对。
        effects: [
          { kind: "deal_damage", amount: 7 },
          {
            kind: "apply_power",
            power: "strength",
            amount: 1,
            on: "self",
            sync: false,
            minAscension: 18,
          },
          {
            kind: "add_card",
            cardId: "wound",
            pile: "discard",
            count: 1,
            ascAmount: [
              { atLeast: 3, amount: 2 },
              { atLeast: 18, amount: 3 },
            ],
          },
        ],
        intent: "attack",
      },
    ],
    // 只有一招，`getMoveForRoll` 恒返回它（MonsterSpecific.cpp:2887-2890），
    // roll 照掷但被丢掉。见 `MOVE_RULES.taskmaster`。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第二幕精英：突刺之书（第二十八批）——
  //
  // `monsterHpRange[BOOK_OF_STABBING] = {{160,164},{168,172}}`（MonsterIds.h:158）。
  // ⚠ 旧近似表写的 `160~162` 与参考不符（上界差 2），本批校正。
  // ⚠ 阈值是**精英档 asc>=8**（MonsterSpecific.cpp:91-102 那一组 case），不是普通怪的 7。
  //
  // ⚠⚠ 开局 Power 是 `PAINFUL_STABS` + `++miscInfo`（MonsterSpecific.cpp:177-180），
  //   两句都在 `PRE_BATTLE_ACTION.book_of_stabbing`。`miscInfo` 就是乱刺的**段数**。
  //   ⚠ 两句都**没有** asc 分档（第三十批逐条确认）。
  // ✅ **第三十批校准了爬升度分档**。⚠ 出招规则里那两处 asc18 的 `++stabCount` 是**死代码**
  //   （排在 `return` 之后，第二十八批裁定不补），本批的 asc19 语料给「as-built 的行为
  //   （不自增）」上了背书——但「参考本该自增吗」仍然没有答案，见 TODOS 待裁定。
  {
    id: "book_of_stabbing",
    name: "突刺之书",
    hpMin: 160,
    hpMax: 164,
    hpHigh: { atLeast: 8, hpMin: 168, hpMax: 172 },
    ascCalibrated: true,
    moves: [
      {
        // 乱刺：`attackPlayerHelper(bc, asc3 ? 7 : 6, miscInfo)`（MonsterSpecific.cpp:457-460）。
        // ⚠⚠ **段数是 `miscInfo`，不是字面量**——本项目第一条「段数由状态决定」的多段攻击。
        //   `times: "miscInfo"` 表达它；`ascAmount` 覆盖的仍是**每一击的伤害**。
        // ⚠ 每一段各自触发 `PAINFUL_STABS`（伤口在 `Player::attacked` 里按「这一击有没有
        //   打穿格挡」逐段判，见 `MONSTER_ATTACK_WOUND` 那段注释），所以 3 段可以塞 0~3 张伤口。
        id: "multi_stab",
        name: "乱刺",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 6,
            times: "miscInfo",
            ascAmount: [{ atLeast: 3, amount: 7 }],
          },
        ],
        intent: "attack",
      },
      {
        // 重刺：`attackPlayerHelper(bc, asc3 ? 24 : 21)`（MonsterSpecific.cpp:462-465）。
        // ⚠ 旧近似表只有 21，没有 asc3 那一档。
        id: "big_stab",
        name: "重刺",
        effects: [{ kind: "deal_damage", amount: 21, ascAmount: [{ atLeast: 3, amount: 24 }] }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.book_of_stabbing`——阈值 15、连续限制靠
    // `lastTwoMoves(MULTI_STAB)`，而且**规则本身会改 `miscInfo`**（每发一次乱刺就 +1）。
    // 旧近似表那份 70/30 加权与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第二幕 Boss：冠军（第二十九批）——
  //
  // `monsterHpRange[THE_CHAMP] = {{420,420},{440,440}}`（MonsterIds.h:209）。
  // ⚠ 旧近似表写的是 `420~440`——那是把**两组**区间当成一个区间了，低档其实是 `{420,420}`。
  //   同族的错法在第二十八批的青铜自动机上也出现过一次，本批校正。
  // ⚠ 上下界相同**照样掷一次** monsterHpRng（`Random::random(420,420)` 无条件 `++counter`），
  //   所以它**不**带 `hpNoRoll`。阈值是 **Boss 档 asc>=9**（MonsterSpecific.cpp:76-89）。
  // ✅ **第三十批校准了爬升度分档**（招式那七条第二十九批就照抄了，本批第一次有预言机；
  //   `hpHigh` 与 `ascCalibrated` 本批补上）。⚠ 防御姿态那族阈值（`getTriIdx(asc, 9, 19)`）
  //   在 asc19 下与 `bossDiffIdx`（4 / 19）**同解**，所以「阈值到底是 9 还是 4」本批仍未分辨
  //   ——关门条件是一个落在 `[4, 9)` 的档位，见 TODOS。
  //
  // ⚠⚠ **它的二阶段是「血量阈值锁存」，而且不在 `Monster::onHpLost` 里**——那个 switch
  //   **压根没有 `THE_CHAMP` 这一格**（Monster.cpp:499-535 只有三种大史莱姆 + 守卫者）。
  //   锁存整条住在 `getMoveForRoll`（MonsterSpecific.cpp:2900-2918），见
  //   `MOVE_RULES.champ`。于是「掉到半血以下」这件事只在**下一次 rollMove** 才被发现，
  //   不像守卫者的模式切换那样在挨打那一瞬间改意图。
  // ⚠ `miscInfo` 在这只怪身上**一个字段两种用途**（参考 Monster.h:73 那行注释就叫
  //   `champ phase2`）：bit 0~1 是防御姿态的**已用次数**（上限 2）、bit 2 是二阶段标志。
  {
    id: "champ",
    name: "冠军",
    hpMin: 420,
    hpMax: 420,
    hpHigh: { atLeast: 9, hpMin: 440, hpMax: 440 },
    ascCalibrated: true,
    moves: [
      {
        // 重斩：`attackPlayerHelper(bc, asc4 ? 18 : 16)`（MonsterSpecific.cpp:1295-1299）。
        // 收尾是入队的 `addToBot(Actions::RollMove(idx))` = `MOVE_TURN_END` 的默认值。
        id: "champ_slash",
        name: "重斩",
        effects: [{ kind: "deal_damage", amount: 16, ascAmount: [{ atLeast: 4, amount: 18 }] }],
        intent: "attack",
      },
      {
        // 扇脸：`attackPlayerHelper(bc, asc4 ? 14 : 12)` 之后**先脆弱再易伤**，两条都入队
        //（MonsterSpecific.cpp:1280-1286）。
        // ⚠ 旧近似表写的是「虚弱 + 脆弱」——**虚弱是错的**（参考给的是易伤），本批校正。
        // ⚠ 顺序照抄（脆弱在前）：两条都是 `addToBot`，谁先入队谁先落地。
        id: "face_slap",
        name: "扇脸",
        effects: [
          { kind: "deal_damage", amount: 12, ascAmount: [{ atLeast: 4, amount: 14 }] },
          { kind: "apply_power", power: "frail", amount: 2, on: "target" },
          { kind: "apply_power", power: "vulnerable", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
      {
        // 防御姿态：`addBlock(blockAmts[buffIdx])` + `buff<METALLICIZE>(metallicizeAmts[buffIdx])`
        //（MonsterSpecific.cpp:1259-1272）。两句都是**同步**的成员调用，故格挡带 `sync: true`。
        // ⚠⚠ **分档索引是 `getTriIdx(bc.ascension, 9, 19)`，不是 takeTurn 顶部那个
        //   `bossDiffIdx`（4 / 19）**。同一只怪身上并存两族阈值，照抄邻居必错。
        // ⚠ 它的**次数上限 2** 由出招规则里的 `miscInfo & 0x3` 管，不是数据。
        id: "champ_defend",
        name: "防御姿态",
        effects: [
          {
            kind: "gain_block",
            amount: 15,
            sync: true,
            ascAmount: [
              { atLeast: 9, amount: 18 },
              { atLeast: 19, amount: 20 },
            ],
          },
          {
            kind: "apply_power",
            power: "metallicize",
            amount: 5,
            on: "self",
            ascAmount: [
              { atLeast: 9, amount: 6 },
              { atLeast: 19, amount: 7 },
            ],
          },
        ],
        intent: "defend",
      },
      {
        // 处决：`attackPlayerHelper(bc, 10, 2)`（MonsterSpecific.cpp:1274-1278）。
        // **没有 asc 分档**（两个实参都是字面量）。
        id: "execute",
        name: "处决",
        effects: [{ kind: "deal_damage_multi", amount: 10, times: 2 }],
        intent: "attack",
      },
      {
        // 自夸：`buff<STRENGTH>(strAmts[bossDiffIdx])`，`{3,4,5}`（MonsterSpecific.cpp:1288-1293）。
        // ⚠ 分档索引是 `bossDiffIdx` = `getTriIdx(asc, 4, 19)`，与防御姿态那条的 9 / 19 不同。
        id: "gloat",
        name: "自夸",
        effects: [
          {
            kind: "apply_power",
            power: "strength",
            amount: 3,
            on: "self",
            ascAmount: [
              { atLeast: 4, amount: 4 },
              { atLeast: 19, amount: 5 },
            ],
          },
        ],
        intent: "buff",
      },
      {
        // 暴怒（二阶段的开场招）：`removeDebuffs(); buff<STRENGTH>(strAmts[bossDiffIdx]);`
        //（MonsterSpecific.cpp:1251-1257），`{6,9,12}`。两句都同步、**顺序照抄**
        // （先清减益再加力量——当前不可分辨，因为清的那几条里没有力量的正值项，
        //  但 `removeDebuffs` 会把**负**力量抬回 0，所以顺序在有黑暗镣铐时是可观察的）。
        id: "anger",
        name: "暴怒",
        effects: [
          { kind: "remove_debuffs" },
          {
            kind: "apply_power",
            power: "strength",
            amount: 6,
            on: "self",
            ascAmount: [
              { atLeast: 4, amount: 9 },
              { atLeast: 19, amount: 12 },
            ],
          },
        ],
        intent: "buff",
      },
      {
        // 嘲讽（旧近似表**压根没有这一招**，本批补）：
        //   `bc.player.debuff<PS::WEAK>(2, true); bc.player.debuff<PS::VULNERABLE>(2, true);`
        //（MonsterSpecific.cpp:1301-1307）
        // ⚠⚠ 两句都是**同步的** `player.debuff`，不是 `addToBot(Actions::DebuffPlayer)`
        //   ——这是本项目第一只「同步给玩家上减益」的怪（拉加维林的吸魂是
        //   `.actFunc(bc)`，形状相同但写法不同）。故两条都带 `sync: true`。
        // ⚠ 第二个实参 `true` 就是 `isSourceMonster`，与入队那族一致（跳过首次递减）。
        id: "taunt",
        name: "嘲讽",
        effects: [
          { kind: "apply_power", power: "weak", amount: 2, on: "target", sync: true },
          { kind: "apply_power", power: "vulnerable", amount: 2, on: "target", sync: true },
        ],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.champ`（MonsterSpecific.cpp:2892-2946）。
    // 旧近似表那份加权（重斩 30 / 扇脸 20 / 防御 20 / 处决 15 / 自夸 15）与参考完全不同，
    // 本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第二幕 Boss：青铜自动机（第二十八批）——
  //
  // `monsterHpRange[BRONZE_AUTOMATON] = {{300,300},{320,320}}`（MonsterIds.h:159）。
  // ⚠ 上下界相同**照样掷一次** monsterHpRng（`Random::random(300,300)` 无条件 `++counter`）
  //   ——所以它**不**带 `hpNoRoll`，判据见 `EnemyDef.hpNoRoll` 的注释（守卫者同族）。
  // ⚠ 阈值是 **Boss 档 asc>=9**（MonsterSpecific.cpp:76-89）。
  // ✅ **第三十批校准了爬升度分档**。⚠ asc19 有一处**结构性后果**：超射线的收尾从「进眩晕」
  //   变成「直接回增益」（`MOVE_TURN_END` 里那句 `asc19 ? "boost" : "stunned"`），
  //   于是**眩晕这一招在 asc19 下压根出不来**——它的 0 例是「不可达」而不是「抄错了没人管」，
  //   判据同第二十二批地精头目的碎颅击。低档的背书在 asc0 那 375 条里。
  //
  // ⚠⚠ 它的意图链**一次 roll 都不看**：`getMoveForRoll` 无条件返回召唤青铜球
  //   （MonsterSpecific.cpp:2101-2104），其后五条 case 全是「同步 setMove + 同步
  //   noOpRollMove」（:471-511）。分岔靠 `miscInfo`（参考在那里起名 `lastBoostWasFlail`）：
  //     召唤 → 连枷 → 增益(miscInfo:0→1, 出连枷) → 连枷 → 增益(1→0, 出超射线)
  //           → 超射线 → 眩晕 → 连枷 → …
  //   ——即「连枷、增益」两轮之后来一发超射线，然后**自己进眩晕**（asc19 直接回增益）。
  {
    id: "bronze_automaton",
    name: "青铜自动机",
    hpMin: 300,
    hpMax: 300,
    hpHigh: { atLeast: 9, hpMin: 320, hpMax: 320 },
    ascCalibrated: true,
    moves: [
      {
        // 召唤青铜球：`spawnBronzeOrbs(bc)`（MonsterSpecific.cpp:502-506）——**同步**调用。
        // ⚠ 与地精首领的集结**不是同一条路径**（那条是 `addToBot(Actions::SummonGremlins())`）。
        //   逐条差别见 `spawnBronzeOrbs` 的注释与 `Effect` 里 `summon_bronze_orbs` 的说明。
        id: "spawn_orbs",
        name: "召唤青铜球",
        effects: [{ kind: "summon_bronze_orbs" }],
        intent: "unknown",
      },
      {
        // 连枷：`attackPlayerHelper(bc, asc4 ? 8 : 7, 2)`（MonsterSpecific.cpp:486-490）
        // ——两段各 7 点，段数是字面量 2（与突刺之书那条的 `miscInfo` 不同）。
        id: "flail",
        name: "连枷",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 7,
            times: 2,
            ascAmount: [{ atLeast: 4, amount: 8 }],
          },
        ],
        intent: "attack",
      },
      {
        // 增益：`buff<STRENGTH>(asc4 ? 4 : 3)` **同步**，`addBlock(asc9 ? 12 : 9)` **也同步**
        //（MonsterSpecific.cpp:471-484）。⚠ 两处照抄：
        //  ① 顺序是**先力量再格挡**（旧近似表写反了）；
        //  ② 格挡是**裸的 `addBlock`**，不是 `addToBot(MonsterGainBlock)` → `sync: true`；
        //  ③ 两个数是**两个独立的 asc 分档**（力量 asc4、格挡 asc9），别合成一个。
        // ⚠ `miscInfo` 的翻转与 setMove 都在 `MOVE_TURN_END`，不是效果。
        id: "boost",
        name: "增益",
        effects: [
          {
            kind: "apply_power",
            power: "strength",
            amount: 3,
            on: "self",
            ascAmount: [{ atLeast: 4, amount: 4 }],
          },
          { kind: "gain_block", amount: 9, sync: true, ascAmount: [{ atLeast: 9, amount: 12 }] },
        ],
        intent: "buff",
      },
      {
        // 超射线：`attackPlayerHelper(bc, asc4 ? 50 : 45)`（MonsterSpecific.cpp:492-500）。
        id: "hyperbeam",
        name: "超射线",
        effects: [{ kind: "deal_damage", amount: 45, ascAmount: [{ atLeast: 4, amount: 50 }] }],
        intent: "attack",
      },
      {
        // 眩晕：整条 case 只有 `setMove(FLAIL); bc.noOpRollMove();`（MonsterSpecific.cpp:508-511）
        // ——**一个效果都没有**（超射线之后它自己歇一回合）。两句都在 `MOVE_TURN_END`。
        // ⚠ 与拜鸟 / 带壳寄生虫那两个 `stunned` 不同：那两个是**受击时**被写进去的，
        //   这一个是**上一招的收尾**自己 setMove 出来的（asc<19 那一支）。
        id: "stunned",
        name: "眩晕",
        effects: [],
        intent: "unknown",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.bronze_automaton`——恒返回召唤，
    // 且「第二次被调用就抛错」（整场只在开局的 `MonsterGroup::init` 里跑一次）。
    // 旧近似表那份 scripted + 加权与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
  // 青铜球（第二十八批）：`monsterHpRange[BRONZE_ORB] = {{52,58},{54,60}}`（MonsterIds.h:160）。
  // ⚠⚠ 它走 `Monster::initHp` 里「**先白掷一次再掷**」那一族（MonsterSpecific.cpp:109-112）：
  //   `hpRng.random(52,58); setRandomHp(hpRng, asc >= 9);` ——一次建怪消耗 **2 次** monsterHpRng。
  //   见 `hpDiscardRoll`。⚠ 白掷那次的上下界恒是**低档**那一组，与正式那次在 asc>=9 时不同。
  // ⚠ 它不在 `MonsterGroup.cpp` 的任何建怪列表里——唯一来源是青铜自动机的召唤。
  // ✅ **第三十批校准了爬升度分档**。⚠ 它的**三条招式一个 asc 分档都没有**（8 / 12 / 停滞
  //   全是字面量，逐条确认过），所以它在这条轴上唯一变的东西就是血量区间——
  //   而那一档正是「白掷用低档、正式用高档」这件事第一次真的分岔的地方（asc19 下
  //   先掷 `(52,58)` 再按 `{54,60}` 取值）。
  {
    id: "bronze_orb",
    name: "青铜球",
    hpMin: 52,
    hpMax: 58,
    hpHigh: { atLeast: 9, hpMin: 54, hpMax: 60 },
    hpDiscardRoll: { min: 52, max: 58 },
    ascCalibrated: true,
    moves: [
      {
        // 光束：`attackPlayerHelper(bc, 8)`（MonsterSpecific.cpp:513-516）。**没有 asc 分档。**
        // ⚠ 收尾是**入队**的 `addToBot(Actions::RollMove(idx))`（这只怪三条 case 里唯一一条），
        //   另两条是同步的真 rollMove。见 `MOVE_TURN_END`。
        id: "orb_beam",
        name: "光束",
        effects: [{ kind: "deal_damage", amount: 8 }],
        intent: "attack",
      },
      {
        // 支援光束：`bc.monsters.arr[1].addBlock(12)`（MonsterSpecific.cpp:524-527）。
        // ⚠⚠ **目标写死 1 号位**（青铜自动机恒在那一格），而且它自己**一点格挡都不加**
        //   ——与百夫长的防守（`gain_block_ally_fixed`）逐字同形，故复用那个原语。
        // ⚠ 旧近似表写的「获得 6 点格挡」两处都错（数值 6 vs 12、给自己 vs 给 1 号位）。
        // ⚠ 参考在这里**没有** `monstersAlive > 1` 那道门（百夫长那条有），
        //   所以要 `noAliveGate: true`。抄成带门的会在自动机已死时少加一次格挡。
        id: "orb_support",
        name: "支援光束",
        effects: [{ kind: "gain_block_ally_fixed", amount: 12, noAliveGate: true }],
        intent: "defend",
      },
      {
        // 停滞：`stasisAction(bc); miscInfo = 1; rollMove(bc);`（MonsterSpecific.cpp:518-522）。
        // ⚠ 只有第一句是效果，后两句在 `MOVE_TURN_END`（`miscInfo = 1` 是「已经用过停滞」，
        //   出招规则读它；`rollMove` 是**同步的真 rollMove**）。
        id: "stasis",
        name: "停滞",
        effects: [{ kind: "stasis" }],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.bronze_orb`（MonsterSpecific.cpp:2106-2124）。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第二幕 Boss：收藏家（第二十九批）——
  //
  // `monsterHpRange[THE_COLLECTOR] = {{282,282},{300,300}}`（MonsterIds.h:210）。
  // ⚠ 旧近似表写的 `282~300` 同样是把两组区间当成一个（与冠军同一处错法），本批校正。
  // ⚠ 阈值是 **Boss 档 asc>=9**。✅ **第三十批校准了爬升度分档**（招式那几条第二十九批
  //   就照抄了，本批第一次有预言机；`hpHigh` 与 `ascCalibrated` 本批补上）。
  // ⚠ 开局 Power 是 `MINION_LEADER`（MonsterSpecific.cpp:272-274）——它的**第三个宿主**
  //   （前两个是地精首领与青铜自动机），于是收藏家一死**当场判胜**，火炬头还站着也算赢
  //   （`Monster::die`，Monster.cpp:293-297）。见 `PRE_BATTLE_ACTION.the_collector`。
  {
    id: "the_collector",
    name: "收藏家",
    hpMin: 282,
    hpMax: 282,
    hpHigh: { atLeast: 9, hpMin: 300, hpMax: 300 },
    ascCalibrated: true,
    moves: [
      {
        // 召唤火炬头：`addToBot(Actions::SpawnTorchHeads())`（MonsterSpecific.cpp:1339-1342）
        // ——**入队**（与地精首领的集结同侧、与青铜自动机的同步召唤相反）。
        // ⚠ 这是本项目**第三条召唤路径**，与前两条八处形状不同，逐条见 sts-combat.ts 的
        //   `summonTorchHeads`。旧近似表那个通用 `summon` kind 到此废弃。
        id: "spawn_torches",
        name: "召唤火炬头",
        effects: [{ kind: "summon_torch_heads" }],
        intent: "unknown",
      },
      {
        // 火球：`attackPlayerHelper(bc, asc4 ? 21 : 18)`（MonsterSpecific.cpp:1327-1330）。
        id: "fireball",
        name: "火球",
        effects: [{ kind: "deal_damage", amount: 18, ascAmount: [{ atLeast: 4, amount: 21 }] }],
        intent: "attack",
      },
      {
        // 增幅：`MonsterSpecific.cpp:1310-1325` 三句，全部**同步**、顺序照抄：
        //   ① `for (i = 0; i < 2; ++i) if (!arr[i].isDying()) arr[i].buff<STRENGTH>(str);`
        //      ——只给**前两格**（火炬头的两个位置）加力量，**不加格挡**；
        //   ② `buff<MS::STRENGTH>(str);`   自己也加同样的力量（无条件）；
        //   ③ `addBlock(block);`           自己加格挡（**只有自己有**）。
        // ⚠ 与地精首领的鼓舞（`buff_minions`）**不是同一族**：那条遍历 0..**2** 三格、
        //   给随从**加格挡**、自己**不加格挡**。范围与谁拿格挡两处都不同，故单开一个 kind。
        // ⚠ 两个数都走 `bossDiffIdx`（`getTriIdx(asc, 4, 19)`）：力量 `{3,4,5}`、
        //   格挡 `{15,18,23}`——注意格挡的第三档是 **23**（不是 20），别按等差补。
        // ⚠ 旧近似表把顺序写成「先格挡后力量」且没有给随从那一段，本批全部校正。
        id: "collector_buff",
        name: "增幅",
        effects: [
          {
            kind: "buff_torch_heads",
            power: "strength",
            amount: 3,
            ascAmount: [
              { atLeast: 4, amount: 4 },
              { atLeast: 19, amount: 5 },
            ],
          },
          {
            kind: "apply_power",
            power: "strength",
            amount: 3,
            on: "self",
            ascAmount: [
              { atLeast: 4, amount: 4 },
              { atLeast: 19, amount: 5 },
            ],
          },
          {
            kind: "gain_block",
            amount: 15,
            sync: true,
            ascAmount: [
              { atLeast: 4, amount: 18 },
              { atLeast: 19, amount: 23 },
            ],
          },
        ],
        intent: "buff",
      },
      {
        // 巨型削弱：三条 `addToBot(Actions::DebuffPlayer<...>(3, true))`，顺序是
        // **虚弱 → 易伤 → 脆弱**（MonsterSpecific.cpp:1332-1337）。旧近似表的顺序恰好一致。
        id: "mega_debuff",
        name: "巨型削弱",
        effects: [
          { kind: "apply_power", power: "weak", amount: 3, on: "target" },
          { kind: "apply_power", power: "vulnerable", amount: 3, on: "target" },
          { kind: "apply_power", power: "frail", amount: 3, on: "target" },
        ],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.the_collector`（MonsterSpecific.cpp:2948-2986）。
    // 旧近似表那份 `scripted: ["spawn_torches"]` + 加权（40/25/35）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
  // 火炬头（第二十九批）：`monsterHpRange[TORCH_HEAD] = {{38,40},{40,45}}`（MonsterIds.h:214）。
  // ⚠ 它**不在 `MonsterGroup.cpp` 的任何建怪列表里**——唯一来源是收藏家的
  //   `Actions::SpawnTorchHeads`（青铜球同族）。
  // ⚠⚠ 它的血量阈值是 **Boss 档 asc>=9**（`MonsterSpecific.cpp:76-89` 那一组 case 里真的
  //   有 `TORCH_HEAD`），尽管它是个随从。别按「随从 = 普通怪 asc>=7」猜。
  // ⚠⚠ **一次召唤消耗两次 monsterHpRng**：`SpawnTorchHeads` 在 `construct`（内部已经
  //   `initHp` 过一次）之后**又显式调了一次** `torchHead.initHp(...)`，参考在那行注了
  //   `// bug somewhere in game`（Actions.cpp:513）。**保留的是第二次的取值。**
  //   ⚠ 这与 `hpDiscardRoll` **不是一族**：那一族的白掷在 `initHp` **内部**、且恒用低档区间，
  //     这里是整个 `initHp` 跑两遍（asc>=9 时两次都用高档区间）。所以不能拿
  //     `hpDiscardRoll` 顶替，实现写在 `summonTorchHeads` 里。
  // ✅ **第三十批校准了爬升度分档**。⚠ 它唯一的招式（冲撞 7 点）没有 asc 分档，所以这只怪
  //   在这条轴上只有血量在变——但**它是「两次 initHp 都用高档」这件事唯一的预言机**：
  //   asc19 下两次都按 `{40,45}` 掷，抄成「第一次低档第二次高档」会当场错位。
  {
    id: "torch_head",
    name: "火炬头",
    hpMin: 38,
    hpMax: 40,
    hpHigh: { atLeast: 9, hpMin: 40, hpMax: 45 },
    ascCalibrated: true,
    moves: [
      {
        // 冲撞：整条 case 就是 `attackPlayerHelper(bc, 7);` 然后 `break`
        //（MonsterSpecific.cpp:1388-1390）——**没有任何收尾语句**，也没有 asc 分档。
        // 于是它一辈子只出这一招、`aiRng` 一次都不再消耗（`MOVE_TURN_END` 记作 `"none"`，
        // 与分裂 / 鬼祟地精 / 抢劫者逃跑同为第四形态）。
        id: "torch_tackle",
        name: "冲撞",
        effects: [{ kind: "deal_damage", amount: 7 }],
        intent: "attack",
      },
    ],
    // ⚠ 参考的 `getMoveForRoll` 对 `TORCH_HEAD` 落在 `default` 上、返回 `INVALID`
    //   （MonsterSpecific.cpp:3364 那行注着 `// setting in collector spawn move`）
    //   ——它的意图**只由 `setMove` 写入**，`rollMove` 一次都不会被调用。
    //   见 `MOVE_RULES.torch_head`：被调用就是我们哪条收尾抄错了，直接抛错。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕（超越）普通敌人 ——
  //
  // ⚠ 三只「形状怪」（爆破怪 / 斥力怪 / 尖刺客）第三十二批按参考逐位校准。它们由
  //   `MonsterGroup::createShapes`（6 项池、不放回）或 `getAncientShape`（3 项表、有放回）
  //   抽出来，见 sts-combat.ts 的 `ENCOUNTER_BUILDERS.three_shapes` 等三条。
  {
    id: "exploder",
    name: "爆破怪",
    // MonsterIds.h:170 `{{30,30},{30,35}}`（asc<7 取前者）。⚠ **两组**，不是一个 `30~35`
    // 的区间——旧近似表写成 30/30 只是碰巧对上了低档。走普通的 `setRandomHp`（掷一次）。
    hpMin: 30,
    hpMax: 30,
    // ⚠⚠ **爆炸不是亡语**（旧近似表的 `deathEffects` 本批删掉了）。参考把它建模成一条
    //   **招式**：撞击的收尾在「已经连撞两次」时同步 `setMove(EXPLODER_EXPLODE)`，
    //   于是第三个怪物回合它出自爆（MonsterSpecific.cpp:1400-1408）。
    //   ⚠ 差别是可观察的：**被玩家打死的爆破怪一点伤害都不造成**，只有它自己活到第三回合
    //   放出自爆才会炸；而 `Monster::die` 的亡语链（孢子云 / 重生 / 停滞）里根本没有它。
    // ⚠ `preBattleAction` 里它那一格是**空的**（`case MonsterId::EXPLODER: break;`，
    //   MonsterSpecific.cpp:160-161，参考注了 `// game adds explosive power`）——真实游戏
    //   的「爆炸倒计时」是个 Power，参考改用意图链表达，所以**没有**开局 Power 进快照。
    moves: [
      {
        // 撞击：`attackPlayerHelper(bc, asc2 ? 11 : 9)`（MonsterSpecific.cpp:1401）。
        id: "exp_slam",
        name: "撞击",
        effects: [{ kind: "deal_damage", amount: 9, ascAmount: [{ atLeast: 2, amount: 11 }] }],
        intent: "attack",
      },
      {
        // 自爆：两条**入队**效果，顺序照抄（MonsterSpecific.cpp:1394-1397）：
        //     bc.addToBot( Actions::DamagePlayer(30) );
        //     bc.addToBot( Actions::SuicideAction(idx, true) );
        // ⚠ 三处照抄：
        //  ① 伤害走 `DamagePlayer` = **非攻击伤害**：不吃力量与易伤（30 恒是 30）、
        //     不触发玩家的荆棘 / 火焰屏障，但**照样被格挡吸收**。用 `damage_player_non_attack`
        //     而不是 `deal_damage`。
        //  ② **没有 asc 分档**（参考那里就是裸的 30）。
        //  ③ 顺序：先打人、后自杀。若这 30 点打死了玩家，主循环跳出，**自杀那条永远轮不到**
        //     ——所以「谁排在前面」是可观察的。
        // ⚠ intent 记 `attack` 是按**真实游戏**显示的意图；而参考的 `isMoveAttack` 白名单里
        //   **没有** `EXPLODER_EXPLODE`（判据是「有没有走 attackPlayerHelper」）。
        //   两者分歧如实记在 TODOS「待裁定」，引擎侧照抄参考（`MONSTER_ATTACK_MOVES` 不收它）。
        id: "exp_explode",
        name: "自爆",
        effects: [{ kind: "damage_player_non_attack", amount: 30 }, { kind: "suicide" }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.exploder`（MonsterSpecific.cpp:3012-3015）：
    // 恒返回撞击、`roll` 一眼都不看。真正决定意图链的是 `MOVE_TURN_END`。
    // 旧近似表那份 `weight: 1 / maxInARow: 99` 与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    id: "spiker",
    name: "尖刺客",
    // MonsterIds.h:201 `{{42,56},{44,60}}`（asc<7 取前者）。走普通的 `setRandomHp`（掷一次）。
    hpMin: 42,
    hpMax: 56,
    // ⚠ 开局的 **THORNS**（不是 `sharp_hide`！）在 `PRE_BATTLE_ACTION.spiker` 里：
    //   `const int thorns[] {3,4,7}; buff<MS::THORNS>(thorns[getTriIdx(asc,2,17)]);`
    //   （MonsterSpecific.cpp:204-208）。它会进 trace 的怪物快照（`THORNS: 3`）。
    moves: [
      {
        // 切割：`attackPlayerHelper(bc, asc2 ? 9 : 7)`（MonsterSpecific.cpp:1421）。
        id: "spk_cut",
        name: "切割",
        effects: [{ kind: "deal_damage", amount: 7, ascAmount: [{ atLeast: 2, amount: 9 }] }],
        intent: "attack",
      },
      {
        // 增生尖刺：`++miscInfo; buff<MS::THORNS>(2); rollMove(bc);`
        //（MonsterSpecific.cpp:1425-1429）。三句分落三处：
        //   `++miscInfo` → `MOVE_TURN_BEGIN`（它是「已经放过几次」，出招规则读 `> 5`）
        //   `buff<THORNS>(2)` → 这里（`on: "self"` 省略 `sync` = **同步**，与参考一致）
        //   `rollMove(bc)` → `MOVE_TURN_END`（同步的真 rollMove）
        // ⚠⚠ 旧近似表写的是 `sharp_hide`，那是**守卫者的尖锐外壳**、时点完全不同
        //   （打出攻击牌就触发 vs 被攻击且破了格挡才触发），本批校正成 `thorns`。
        // ⚠ **没有 asc 分档**（参考那里是裸的 2，只有开局那次分三档）。
        id: "spk_spike",
        name: "增生尖刺",
        effects: [{ kind: "apply_power", power: "thorns", amount: 2, on: "self" }],
        intent: "buff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.spiker`（MonsterSpecific.cpp:3026-3032）。
    // 旧近似表那份加权（60/40）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
  // 暗球游荡者（第三十三批按参考逐位校准）。
  {
    id: "orb_walker",
    name: "球行者",
    // MonsterIds.h:186 `{{90,96},{92,102}}`（asc<7 取前者）。
    hpMin: 90,
    hpMax: 96,
    // ⚠⚠ **它是 `hpDiscardRoll` 的正主**：`Monster::initHp` 里那条 case 是
    //     hpRng.random(90, 96);                 // 参考只在这里注了
    //     setRandomHp(hpRng, ascension >= 7);   // "first call is discarded by game"
    //   （MonsterSpecific.cpp:32-35）——一次建怪消耗 **2 次** monsterHpRng。
    //   白掷那次的上下界恒是低档那一组（90~96），与正式那次在 asc<7 时恰好相同；
    //   asc>=7 时正式那次用的是 `{92,102}`，两次就真的不同了。
    //   ⚠ 白掷那次的**取值**永远验证不了（第二十七批实测 0 例：取值被丢弃，而
    //     `Random::nextLong(n)` 的前进步数与 n 无关），有背书的只是**次数**。
    hpDiscardRoll: { min: 90, max: 96 },
    // ⚠ 开局的 **GENERIC_STRENGTH_UP** 在 `PRE_BATTLE_ACTION.orb_walker` 里
    //   （`buff<MS::GENERIC_STRENGTH_UP>(asc17 ? 5 : 3)`，MonsterSpecific.cpp:200-202）：
    //   全参考项目**只有它一个宿主**，效果是**每个回合末 +3 力量**且自己一层不掉。
    //   它会进 trace 的怪物快照（`GENERIC_STRENGTH_UP: 3`）。
    moves: [
      {
        // 激光：`attackPlayerHelper(bc, asc2 ? 11 : 10)` + **两条塞牌**
        //（MonsterSpecific.cpp:995-1001）：
        //     bc.addToBot( Actions::ShuffleTempCardIntoDrawPile(CardId::BURN, 1) );
        //     bc.addToBot( Actions::MakeTempCardInDiscard({CardId::BURN}) );
        // ⚠ 三处照抄：
        //  ① **两张灼伤去的是两个不同的牌堆**（先抽牌堆、后弃牌堆），不是同一堆两张；
        //  ② 洗进抽牌堆那张**掷一次 `cardRandomRng`** 选插入位（抽牌堆为空时 idx=0、不掷），
        //     进弃牌堆那张**不掷**；
        //  ③ 三条效果全是 `addToBot`（省略 `sync`），顺序就是这里的书写顺序。
        // ⚠ 灼伤**打不出**，但它会被抽进手牌 → 回合末结算 2 点自伤（`useNoTriggerCard`），
        //   所以「洗进抽牌堆」这一路是真的可观察的，不只是牌堆快照。
        id: "ow_laser",
        name: "激光",
        effects: [
          { kind: "deal_damage", amount: 10, ascAmount: [{ atLeast: 2, amount: 11 }] },
          { kind: "add_card", cardId: "burn", pile: "draw", count: 1 },
          { kind: "add_card", cardId: "burn", pile: "discard", count: 1 },
        ],
        intent: "attack",
      },
      {
        // 利爪：`attackPlayerHelper(bc, asc2 ? 16 : 15)`（MonsterSpecific.cpp:991）。
        // ⚠ 旧近似表写的 16 是**高档**那个数，asc0 应当是 15。
        id: "ow_claw",
        name: "利爪",
        effects: [{ kind: "deal_damage", amount: 15, ascAmount: [{ atLeast: 2, amount: 16 }] }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.orb_walker`（MonsterSpecific.cpp:2609-2620）。
    // 两条 case 的收尾都是裸的 `addToBot(Actions::RollMove(idx))`，即 `MOVE_TURN_END` 的默认值。
    // 旧近似表那份加权（50/50）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕精英：蜥蜴法师（召唤的第四族，第三十六批按参考逐位校准）——
  {
    id: "reptomancer",
    name: "蜥蜴法师",
    // MonsterIds.h:189 `{{180,190},{190,200}}`；`setRandomHp(hpRng, asc >= 8)`
    //（MonsterSpecific.cpp:104-107，**精英**那一档）。
    hpMin: 180,
    hpMax: 190,
    // ⚠⚠ **先白掷一次再取**（`hpDiscardRoll`）：参考那条 case 是
    //     hpRng.random(180, 190);                 // ← 取值丢弃
    //     setRandomHp(hpRng, ascension >= 8);
    //   所以建一只法师消耗 **2 次** monsterHpRng。它是这一族四个宿主里最后一个被登记的
    //   （前三个：暗球游荡者 / 青铜球 / 工头）。白掷那次恒用**低档**区间。
    hpDiscardRoll: { min: 180, max: 190 },
    // preBattleAction 见 sts-combat.ts 的 `PRE_BATTLE_ACTION.reptomancer`：
    //   `buff<MS::MINION_LEADER>()`（MonsterSpecific.cpp:238-240）。
    // ⚠ 它给 `Monster::die` 加了第二条判胜路径：法师一死当场判胜，匕首还站着也算赢。
    moves: [
      {
        // 召唤匕首（MonsterSpecific.cpp:1620-1623）：
        //     reptomancerSummon(bc, asc18 ? 2 : 1);   // ← **同步**，不是 addToBot
        //     rollMove(bc);                           // ← **同步的真 rollMove**（见 MOVE_TURN_END）
        // ⚠ 召几只由爬升度决定，是全参考项目唯一这么写的召唤（地精/青铜球恒 2、
        //   收藏家是 `3 - monstersAlive`）。asc0 下恒 1 只。逐条形状见 `reptomancerSummon`。
        id: "summon_daggers",
        name: "召唤匕首",
        effects: [{ kind: "summon_daggers", count: 1, ascAmount: [{ atLeast: 18, amount: 2 }] }],
        intent: "unknown",
      },
      {
        // 毒牙（MonsterSpecific.cpp:1614-1618）：
        //     attackPlayerHelper(bc, asc3 ? 16 : 13, 2);
        //     bc.addToBot( Actions::DebuffPlayer<PS::WEAK>(1, true) );
        //     bc.addToBot( Actions::RollMove(idx) );
        // ⚠ 三处照抄：① 两段、每段 13（asc3 是 16）——分档挂在**第一个**实参上，段数恒 2；
        //   ② 虚弱是**入队**的（`addToBot`），排在两段伤害之后；③ 收尾是默认的 `"roll"`。
        // ⚠ 旧近似表写的是单段 13 + 虚弱，段数漏了一半。
        id: "snake_strike",
        name: "毒牙",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 13,
            times: 2,
            ascAmount: [{ atLeast: 3, amount: 16 }],
          },
          { kind: "apply_power", power: "weak", amount: 1, on: "target" },
        ],
        intent: "attack",
      },
      {
        // 巨口（MonsterSpecific.cpp:1609-1612）：`attackPlayerHelper(bc, asc3 ? 34 : 30);`
        // 收尾是默认的 `"roll"`。⚠ 分档是 **asc3**（精英那一族 `getTriIdx(asc, 3, 18)`
        // 的低阈值），不是走廊小怪的 asc2——照搬邻居必错。
        id: "big_bite",
        name: "巨口",
        effects: [{ kind: "deal_damage", amount: 30, ascAmount: [{ atLeast: 3, amount: 34 }] }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.reptomancer`（MonsterSpecific.cpp:2641-2677）。
    intentRule: { scripted: [], weighted: [] },
  },
  // —— 匕首（第三十六批按参考逐位校准）——
  //
  // ⚠ 它有**两个来源**：`REPTOMANCER` 编队开局就建两只（1 / 4 号位），法师的召唤再往
  //   空位里填。青铜球 / 火炬头都只有召唤这一个来源，匕首是第一个「既预置又召唤」的怪。
  {
    id: "dagger",
    name: "匕首",
    // MonsterIds.h:165 `{{20,25},{20,25}}`——两组**完全相同**，但照样走
    // `setRandomHp(hpRng, asc >= 8)`（MonsterSpecific.cpp:91-102 那一族，精英档）。
    // ⚠ 「上下界相同」与「两组相同」都**不是** `hpNoRoll` 的判据：这一只照样掷一次。
    hpMin: 20,
    hpMax: 25,
    // preBattleAction 见 sts-combat.ts 的 `PRE_BATTLE_ACTION.dagger`：
    //   `buff<MS::MINION>()`（MonsterSpecific.cpp:148-150）。
    // ⚠ 召唤出来的那些**不重跑** preBattleAction，但 `reptomancerSummon` 自己手写了一句
    //   同样的 `buff<MS::MINION>()`——在**参考里**两者净效果相同，所以这只怪身上
    //   「不重跑」这条没有判别力（探针无效，理由与火炬头那条不同）。
    //   ⚠ 详见 sts-combat.ts 的 `PRE_BATTLE_ACTION.dagger`：我们这边 `addPower` 会累加，
    //   所以那个探针红 120 例量的是**我们的建模差异**、不是参考的语义。
    moves: [
      {
        // 突刺（MonsterSpecific.cpp:1625-1630）：
        //     attackPlayerHelper(bc, 9);
        //     bc.addToBot( Actions::MakeTempCardInDiscard(CardId::WOUND) );
        //     setMove(MMID::DAGGER_EXPLODE);   // ← 同步
        //     bc.noOpRollMove();               // ← **同步**
        // ⚠ 参考这里**一个 `asc? :` 都没有**——匕首整只怪在任何爬升度下都是这些数。
        // ⚠ 收尾是「同步 setMove + 同步 noOpRollMove」（球状守卫者那一族），见 MOVE_TURN_END。
        id: "dagger_stab",
        name: "突刺",
        effects: [
          { kind: "deal_damage", amount: 9 },
          { kind: "add_card", cardId: "wound", pile: "discard", count: 1 },
        ],
        intent: "attack",
      },
      {
        // 自爆（MonsterSpecific.cpp:1632-1636）：
        //     attackPlayerHelper(bc, 25);
        //     bc.addToBot( Actions::SuicideAction(idx, true) );
        //     bc.noOpRollMove();               // ← **同步**
        // ⚠⚠ **它与爆破怪的自爆是同一条判据的两个方向**：形状几乎一样（打人 + `SuicideAction`），
        //   但这一条走 `attackPlayerHelper` → **在** `isMoveAttack` 白名单里；
        //   爆破怪那条走 `Actions::DamagePlayer` → 不在。判据是**用了哪个函数**，不是伤害量。
        // ⚠ `SuicideAction(idx, **true**)` 走正常的非攻击伤害路径 `Monster::damage`，
        //   死亡链照常触发（与复形怪那条 `false` 相反）。
        id: "dagger_explode",
        name: "自爆",
        effects: [{ kind: "deal_damage", amount: 25 }, { kind: "suicide" }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.dagger`（MonsterSpecific.cpp:2679-2681）：
    // 恒返回突刺，一条分支都没有。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕 Boss：铎努与迪卡（双子，互相增益）——
  {
    id: "deca",
    name: "迪卡",
    hpMin: 250,
    hpMax: 250,
    moves: [
      {
        id: "deca_beam",
        name: "光束",
        effects: [{ kind: "deal_damage_multi", amount: 10, times: 2 }],
        intent: "attack",
      },
      {
        id: "deca_protect",
        name: "守护",
        effects: [{ kind: "gain_block", amount: 16 }],
        intent: "defend",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "deca_beam", weight: 50, maxInARow: 1 },
        { move: "deca_protect", weight: 50, maxInARow: 1 },
      ],
    },
  },
  {
    id: "donu",
    name: "铎努",
    hpMin: 250,
    hpMax: 250,
    moves: [
      {
        id: "donu_beam",
        name: "光束",
        effects: [{ kind: "deal_damage_multi", amount: 10, times: 2 }],
        intent: "attack",
      },
      {
        id: "donu_power",
        name: "赋能",
        effects: [{ kind: "apply_power", power: "strength", amount: 3, on: "all_enemies" }],
        intent: "buff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "donu_beam", weight: 50, maxInARow: 1 },
        { move: "donu_power", weight: 50, maxInARow: 1 },
      ],
    },
  },

  {
    id: "repulsor",
    name: "斥力怪",
    // MonsterIds.h:191 `{{29,35},{31,38}}`（asc<7 取前者）。走普通的 `setRandomHp`（掷一次）。
    hpMin: 29,
    hpMax: 35,
    // ⚠ 它**没有** preBattleAction（`Monster::preBattleAction` 的 switch 里压根没有它的 case），
    //   所以开局身上一个 Power 都没有——别按「形状怪」把尖刺客那条荆棘也给它。
    moves: [
      {
        // 撞击：`attackPlayerHelper(bc, asc2 ? 13 : 11)`（MonsterSpecific.cpp:1411）。
        id: "rep_bash",
        name: "撞击",
        effects: [{ kind: "deal_damage", amount: 11, ascAmount: [{ atLeast: 2, amount: 13 }] }],
        intent: "attack",
      },
      {
        // 斥力：`Actions::ShuffleTempCardIntoDrawPile(CardId::DAZED, 2).actFunc(bc);`
        //（MonsterSpecific.cpp:1416）。⚠ 四处照抄：
        //  ① **两张**，不是一张（旧近似表写的 1 是错的）；
        //  ② 洗进**抽牌堆**（`pile: "draw"`），**每张各掷一次 `cardRandomRng`** 选插入位；
        //     抽牌堆为空时 `idx = 0` 且不掷。这是数据表里第一条 `pile: "draw"`。
        //  ③ `.actFunc(bc)` = **同步**（`sync: true`），所以两张恍惚在同一条 case 里紧接着的
        //     同步 `rollMove` 之前就已经进了抽牌堆；
        //  ④ **没有 asc 分档**（参考那里是裸的 2）。
        // ⚠ 恍惚**打不出**（`cardCanUse` 恒假），所以它不进 `CARD_RULES`，只躺在牌堆快照里
        //   ——与伤口 / 灼伤同族。它早就在 `CARD` 映射里（诅咒 HEX 带进来的）。
        id: "repulse",
        name: "斥力",
        effects: [{ kind: "add_card", cardId: "dazed", pile: "draw", count: 2, sync: true }],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.repulsor`（MonsterSpecific.cpp:3017-3023）。
    // 旧近似表那份加权（60/40）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
  // 复形怪（第三十四批按参考逐位校准）。
  {
    id: "transient",
    name: "无常",
    // MonsterIds.h:215 `{{999,999},{999,999}}`。
    // ⚠⚠ 它是 `hpNoRoll` 的**第三个也是最后一个宿主**（`Monster::initHp` 的
    //   `curHp = monsterHpRange[id][0][0];`，MonsterSpecific.cpp:119-124，与球状守卫者、
    //   大嘴同一条 case）——**一次 monsterHpRng 都不掷**。
    //   旧近似表写的 88~92 是凭印象编的，两处都错（数值错、掷法也错）。
    hpMin: 999,
    hpMax: 999,
    hpNoRoll: true,
    // ⚠ 开局 `preBattleAction` 一次上**两个** Power（MonsterSpecific.cpp:171-175，
    //   参考只在那行注了 `// game adds ShiftingPower`）：
    //     buff<MS::SHIFTING>();              // 纯 bool，快照里是 SHIFTING: 1
    //     buff<MS::FADING>(asc17 ? 6 : 5);   // 层数 = 还能出手几次
    //   两条都在 `PRE_BATTLE_ACTION.transient` 里，顺序照抄。
    moves: [
      {
        // 重殴（MonsterSpecific.cpp:1520-1530，整只怪只有这一招）：
        //     const auto damage = (asc2 ? 40 : 30) + 10*(bc.getMonsterTurnNumber()-1);
        //     attackPlayerHelper(bc, damage);
        //     if (getStatus<MS::FADING>() == 1) { addToBot(SuicideAction(idx, false)); }
        //     bc.noOpRollMove();          // ← 同步
        //     decrementStatus<MS::FADING>();  // ← 同步，排在 noOpRollMove **之后**
        // ⚠ 四处照抄：
        //  ① 伤害**按全局回合线性成长**（30 / 40 / 50 / 60 / 70），`perMonsterTurn: 10`；
        //     `asc2 ? 40 : 30` 只覆盖起点，步长 10 是常数。
        //  ② 自杀那条走 `SuicideAction(idx, **false**)` = `Monster::suicideAction`
        //     ——**不走死亡链**（见 `suicide` 的 `triggerRelics`）。
        //  ③ 门读的是**递减之前**的层数（`== 1`），所以最后一次出手当场自杀。
        //  ④ 收尾两句在 `MOVE_TURN_END`：同步 noOpRollMove（掷一次 aiRng 丢掉）
        //     **然后**才递减消逝。
        id: "transient_slam",
        name: "重殴",
        effects: [
          {
            kind: "deal_damage",
            amount: 30,
            ascAmount: [{ atLeast: 2, amount: 40 }],
            perMonsterTurn: 10,
          },
          {
            kind: "suicide",
            triggerRelics: false,
            onlyIfSelfPower: { power: "fading", equals: 1 },
          },
        ],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.transient`：`return TRANSIENT_ATTACK;`
    //（MonsterSpecific.cpp:3115-3117）——roll 照掷但一眼都不看。
    // ⚠ 旧近似表那条「消散离场」的招式是编的：参考里复形怪**不逃跑**，它靠消逝层数归零时
    //   那条 `SuicideAction` 自己消失，`MMID` 里也只有 `TRANSIENT_ATTACK` 一条。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕精英：巨型头颅（第三十五批按参考逐位校准）——
  {
    id: "giant_head",
    name: "巨型头颅",
    // MonsterIds.h:173 `{{500,500},{520,520}}`；`setRandomHp(hpRng, asc >= 8)`
    //（MonsterSpecific.cpp:91-102，**精英**那一档，不是普通怪的 7）。
    hpMin: 500,
    hpMax: 500,
    // preBattleAction 见 sts-combat.ts 的 `PRE_BATTLE_ACTION.giant_head`：
    //   `setHasStatus<MS::SLOW>(true); setStatus<MS::SLOW>(0);`（MonsterSpecific.cpp:163-165）
    // ⚠ **不是 `buff(n)`**：bit 置上、层数是 0，所以缓慢平时不出现在快照里。
    moves: [
      {
        // 数数：`attackPlayerHelper(bc, 13)`（MonsterSpecific.cpp:1567-1569）。
        // ⚠ 参考那里**一个 `asc? :` 都没有**（`MonsterMoveDamage.cpp:74` 同样是裸的 `{13}`），
        //   所以巨头在高爬升度下变强的只有血量与「时候到了」的起点。
        // ⚠ 旧近似表**根本没有这一招**（只列了凝视与「时候到了」），本批补上。
        id: "gh_count",
        name: "数数",
        effects: [{ kind: "deal_damage", amount: 13 }],
        intent: "attack",
      },
      {
        // 凝视：`bc.player.debuff<PS::WEAK>(1, true);`（MonsterSpecific.cpp:1572-1575）——
        // **裸的 `player.debuff`**，即第二十九批冠军嘲讽那一族（与
        // `Actions::DebuffPlayer<...>(n).actFunc(bc)` 逐位等价），用同一个 `sync: true` 表达。
        // ⚠ 三处照抄：① `sync: true`（不入队，紧随其后那次同步 `rollMove` 执行时已生效）；
        //   ② 显式传了 `true`（`isSourceMonster`），所以虚弱走 justApplied、施加那个回合末不递减；
        //   ③ **没有任何伤害**——旧近似表把它写成「10 点攻击」，与参考完全无关。
        id: "gh_glare",
        name: "凝视",
        effects: [{ kind: "apply_power", power: "weak", amount: 1, on: "target", sync: true }],
        intent: "debuff",
      },
      {
        // 时候到了（MonsterSpecific.cpp:1577-1583）：
        //     const auto t = std::min(bc.getMonsterTurnNumber()-5, 6) * 5;
        //     const auto damage = (asc3 ? 40 : 30) + t;
        //     attackPlayerHelper(bc, damage);   // 参考在这行注了 `// todo this can be done immediately`
        //     bc.noOpRollMove();
        // ⚠ 四处照抄：
        //  ① 成长是**封顶**的（`monsterTurnRamp`），不是复形怪那种无上限线性；
        //  ②⚠⚠ **`t` 可以为负**：出招规则的门是 `getMonsterTurnNumber() >= 4`，所以第一次
        //     出这一招时 `min(4-5, 6)*5 = -5`，伤害是 **25**，比下一回合的 30 还低。
        //     写成 `max(0, …)` 会让第一击多打 5 点。
        //  ③ 分档是 **asc3**（**精英**那一族 `getTriIdx(asc, 3, 18)` 的低阈值），
        //     不是走廊小怪的 asc2——照搬邻居必错。
        //  ④ 旧近似表写死 35，与参考的 25/30/35/…/60 序列完全无关。
        id: "gh_it_is_time",
        name: "时候到了",
        effects: [
          {
            kind: "deal_damage",
            amount: 30,
            ascAmount: [{ atLeast: 3, amount: 40 }],
            monsterTurnRamp: { subtract: 5, cap: 6, scale: 5 },
          },
        ],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.giant_head`（MonsterSpecific.cpp:3207-3229）。
    // 三条 case 的收尾**三种形态并存**，见 `MOVE_TURN_END`。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕 Boss：觉醒者（两阶段 / 假死，第三十七批按参考逐位校准）——
  {
    id: "awakened_one",
    name: "觉醒者",
    // MonsterIds.h:155 `{{300,300},{300,320}}`；`setRandomHp(hpRng, asc >= 9)`
    //（MonsterSpecific.cpp:76-89，**Boss** 那一档）。
    // ⚠ 上下界相同**照样掷一次**（`Random::random(int,int)` 无条件 `++counter`）——
    //   与守卫者的 `{240,240}` 同族，不是 `hpNoRoll`。
    // ⚠ 二阶段的血量**不读这张表**：复活那条 case 写死 `maxHp = asc9 ? 320 : 300`
    //   （MonsterSpecific.cpp:1712），是与这里并列的**第二个字面量**。旧近似表那个
    //   `reviveHp` 字段第三十七批起就没有任何读者，**第三十八批把它从 `EnemyDef` 里删掉了**。
    hpMin: 300,
    hpMax: 300,
    // preBattleAction 见 sts-combat.ts 的 `PRE_BATTLE_ACTION.awakened_one`
    //（MonsterSpecific.cpp:186-193）：asc4 才有的 +2 力量、CURIOSITY 1（asc19 是 2）、
    // REGEN 10（asc19 是 15）。⚠ 参考在那里注着 `// buff minion leader only in stage 2`
    // ——`MINION_LEADER` 是**复活那条 case** 才上的，开局没有。
    moves: [
      {
        // 斩击（MonsterSpecific.cpp:1724-1731）：`attackPlayerHelper(bc, 20)`。
        // ⚠ **一阶段专属**，参考没有任何 asc 分档（20 是写死的）。
        // 收尾是裸的 `addToBot(Actions::RollMove(idx))`，即 `MOVE_TURN_END` 的默认值。
        id: "aw_slash",
        name: "斩击",
        effects: [{ kind: "deal_damage", amount: 20 }],
        intent: "attack",
      },
      {
        // 灵魂打击（MonsterSpecific.cpp:1743-1750）：`attackPlayerHelper(bc, 6, 4)`
        // ——四段、每段 6。**一阶段专属**，同样没有 asc 分档。收尾默认。
        id: "soul_strike",
        name: "灵魂打击",
        effects: [{ kind: "deal_damage_multi", amount: 6, times: 4 }],
        intent: "attack",
      },
      {
        // 重生（MonsterSpecific.cpp:1711-1722）：**假死之后的复活**，七句状态机 + 两句收尾。
        // ⚠ 它**几乎从来不由 roll 掷出来**：`Monster::die` 的第一个分支
        //   `setMove(MMID::AWAKENED_ONE_REBIRTH)` 写进去（Monster.cpp:290）。出招规则里
        //   `if (halfDead) return REBIRTH;` 那一支只在「觉醒者死在怪物阶段」时被用到
        //   （它自己攻击排的 `RollMove` 在青铜鳞片荆棘把它打进假死之后才出队），
        //   实测 46 条假死里只有 **2 条**走这条路，见 `MOVE_RULES.awakened_one` 的 ①。
        // ⚠ 它**不在** `isMoveAttack` 白名单里（MonsterMoves.h:422-426 只收另外五条）。
        // ⚠ 意图 `unknown`：真实游戏这一格显示的是「昏迷」，与暗影客的重生/复活同族。
        id: "rebirth",
        name: "重生",
        effects: [{ kind: "awakened_rebirth" }],
        intent: "unknown",
      },
      {
        // 黑暗回响（MonsterSpecific.cpp:1702-1709）：`attackPlayerHelper(bc, 40)`。
        // ⚠ **二阶段的开场必出招**——复活那条 case 的收尾是同步 `setMove(DARK_ECHO)`，
        //   所以复活之后紧接着的那个怪物回合恒是它。收尾默认（`addToBot(RollMove)`）。
        id: "dark_echo",
        name: "黑暗回响",
        effects: [{ kind: "deal_damage", amount: 40 }],
        intent: "attack",
      },
      {
        // 污泥（MonsterSpecific.cpp:1733-1741）：
        //     attackPlayerHelper(bc, 18);
        //     bc.addToBot( Actions::ShuffleTempCardIntoDrawPile(CardId::VOID) );
        //     bc.addToBot( Actions::RollMove(idx) );
        // ⚠ 三处照抄：
        //  ① 塞牌是**入队**的（不是 `.actFunc(bc)`），排在伤害之后、收尾之前；
        //  ② 去向是**抽牌堆**，`count` 默认 1 → 抽牌堆非空时**掷一次 cardRandomRng** 选插入位
        //     （与斥力怪那两张恍惚同一条原语）；
        //  ③ 塞的是**虚无（VOID）**，本项目第一张「抽到时有效果」的状态牌
        //     （`CardManager::draw` 里 `bc.player.energy = std::max(0, energy-1)`，
        //     CardManager.cpp:426-429）。它打不出（费用哨兵 -2）、是虚无牌（回合末消耗）。
        id: "sludge",
        name: "污泥",
        effects: [
          { kind: "deal_damage", amount: 18 },
          { kind: "add_card", cardId: "void", pile: "draw", count: 1 },
        ],
        // ⚠ `intent` 只管渲染（真实游戏这一格是「攻击 + debuff」双意图，而我们的
        //   `EnemyIntentKind` 五个值互斥）。**攻击分类走 `MONSTER_ATTACK_MOVES` 白名单**，
        //   与这个字段无关——同族的先例是球状守卫者的「攻击削弱」。
        intent: "attack",
      },
      {
        // 冲撞（MonsterSpecific.cpp:1752-1759）：`attackPlayerHelper(bc, 10, 3)`
        // ——三段、每段 10。**二阶段专属**，没有 asc 分档。收尾默认。
        id: "aw_tackle",
        name: "冲撞",
        effects: [{ kind: "deal_damage_multi", amount: 10, times: 3 }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.awakened_one`（MonsterSpecific.cpp:3280-3328）。
    // 旧近似表那份加权（45/35/20，还带一条参考里根本不存在的「汲取」）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕 Boss：时间吞噬者（第三十八批按参考逐位校准）——
  {
    id: "time_eater",
    name: "时间吞噬者",
    // MonsterIds.h:213 `{{456,456},{480,480}}`；`setRandomHp(hpRng, asc >= 9)`
    //（MonsterSpecific.cpp:76-89，**Boss** 那一档）。
    // ⚠ 上下界相同**照样掷一次**（`Random::random(int,int)` 无条件 `++counter`）——
    //   与守卫者的 `{240,240}` 同族，不是 `hpNoRoll`。
    hpMin: 456,
    hpMax: 456,
    // preBattleAction 见 sts-combat.ts 的 `PRE_BATTLE_ACTION.time_eater`
    //（MonsterSpecific.cpp:223-226）：整条只有一句 `buff<MS::TIME_WARP>(0)`。
    // ⚠ 那是「位置上、层数 0」的第三种写法（与蠕动血块的反应、巨头的缓慢同族），
    //   所以开局快照里**看不到** TIME_WARP——它要等玩家打出第一张牌才现身。
    // ⚠ 旧近似表那个 `timeWarpEvery: 12` 字段本批删掉：真相是
    //   `onAfterUseCard` 里写死的 `timeWarp == 11`，不是一个可配置的周期。
    moves: [
      {
        // 混响（MonsterSpecific.cpp:1657-1660）：`attackPlayerHelper(bc, asc4 ? 8 : 7, 3)`
        // ——三段、每段 7（asc4 是 8）。分档挂在**第一个**实参上，段数恒 3
        //（`MonsterMoveDamage.cpp:189` 那张表写的也是 `{asc4 ? 8 : 7, 3}`）。
        // ⚠ 分档是 **asc4**（**Boss** 那一族 `getTriIdx(asc, 4, 19)` 的低阈值），
        //   不是走廊小怪的 asc2、也不是精英的 asc3——照搬邻居必错。
        // 收尾是裸的 `addToBot(Actions::RollMove(idx))`，即 `MOVE_TURN_END` 的默认值。
        id: "te_reverberate",
        name: "混响",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 7,
            times: 3,
            ascAmount: [{ atLeast: 4, amount: 8 }],
          },
        ],
        intent: "attack",
      },
      {
        // 头槌（MonsterSpecific.cpp:1648-1655）：
        //     attackPlayerHelper(bc, asc4 ? 32 : 26);
        //     bc.addToBot( Actions::DebuffPlayer<PS::DRAW_REDUCTION>(1, true) );
        //     if (asc19) { bc.addToBot( Actions::MakeTempCardInDiscard(CardId::SLIMED, 2) ); }
        //     bc.addToBot( Actions::RollMove(idx) );
        // ⚠ 三处照抄：
        //  ① 抽牌削减是**入队**的（不是 `.actFunc(bc)`），排在伤害之后、收尾之前；
        //  ② 那个 `1` 其实被参考丢掉了——`Player::debuff<DRAW_REDUCTION>` 无视 amount、
        //     恒 `--cardDrawPerTurn`（Player.h:385-390）。写 1 是为了与参考的实参一致；
        //  ③ asc19 那两张黏液是**多出来的一整条效果**（`minAscension`），不是「换个数」。
        //     黏液是唯一不需要医疗包就能打出的状态牌，所以它进 `CARD_RULES`——但 asc0
        //     走不到这一支。
        id: "te_head_slam",
        name: "头槌",
        effects: [
          { kind: "deal_damage", amount: 26, ascAmount: [{ atLeast: 4, amount: 32 }] },
          { kind: "apply_power", power: "draw_reduction", amount: 1, on: "target" },
          { kind: "add_card", cardId: "slimed", pile: "discard", count: 2, minAscension: 19 },
        ],
        // ⚠ `intent` 只管渲染（真实游戏这一格是「攻击 + debuff」双意图，而我们的
        //   `EnemyIntentKind` 五个值互斥）。**攻击分类走 `MONSTER_ATTACK_MOVES` 白名单**。
        intent: "attack",
      },
      {
        // 涟漪（MonsterSpecific.cpp:1662-1671）：
        //     addBlock(20);
        //     bc.player.debuff<PS::WEAK>(1, true);
        //     bc.player.debuff<PS::VULNERABLE>(1, true);
        //     if (asc19) { bc.player.debuff<PS::FRAIL>(1, true); }
        //     rollMove(bc);
        // ⚠ 四处照抄：
        //  ① 加格挡是**同步** `addBlock`（`sync: true`），不是 `addToBot(MonsterGainBlock)`；
        //  ② 三条减益是**裸的** `bc.player.debuff<...>(n, true)`（第三种写法，与冠军的嘲讽
        //     同族），同样同步 → 全部 `sync: true`；
        //  ③ 脆弱那条是 asc19 才有的**多出来的一整条效果**（`minAscension`）；
        //  ④ 收尾是**同步的真 rollMove**（第六形态），见 `MOVE_TURN_END`。
        // ⚠ 这一整招**不在** `isMoveAttack` 白名单里（它一点伤害都不带）。
        id: "te_ripple",
        name: "涟漪",
        effects: [
          { kind: "gain_block", amount: 20, sync: true },
          { kind: "apply_power", power: "weak", amount: 1, on: "target", sync: true },
          { kind: "apply_power", power: "vulnerable", amount: 1, on: "target", sync: true },
          {
            kind: "apply_power",
            power: "frail",
            amount: 1,
            on: "target",
            sync: true,
            minAscension: 19,
          },
        ],
        intent: "defend",
      },
      {
        // 加速（MonsterSpecific.cpp:1638-1646）：
        //     miscInfo = true;        // set have used haste true
        //     curHp = maxHp / 2;
        //     if (asc19) { addBlock(32); }
        //     removeDebuffs();        // also removes shackled here
        //     rollMove(bc);
        // ⚠ 五处照抄：
        //  ① `miscInfo` 是**一次性锁存位**——出招规则的门是 `!usedHaste && curHp < maxHp/2`，
        //     所以一场仗最多加速一次；
        //  ② `curHp = maxHp / 2` 是**赋值**（整数除法），不是 `heal`，见 `set_hp_half_max`；
        //  ③ asc19 的 32 点格挡是**多出来的一整条语句**（`minAscension`），同步 `addBlock`；
        //  ④ `removeDebuffs()` 与冠军的暴怒是同一个函数（`Monster::removeDebuffs`）；
        //  ⑤ 收尾是**同步的真 rollMove**（第六形态），而它读的正是刚被置起的 `miscInfo`
        //     与刚被抬到半血的 `curHp`——所以加速之后**绝不会**再滚出加速。
        // ⚠ 顺序也照抄：`set_misc_info` 必须排在 `set_hp_half_max` 之前吗？参考是先置位
        //   再改血，两句互不相干（门读的是收尾那次 rollMove 时的值，那时两句都跑完了）。
        //   照抄书写顺序即可。
        // ⚠ 这一招**不在** `isMoveAttack` 白名单里。
        id: "haste",
        name: "加速",
        effects: [
          { kind: "set_misc_info", amount: 1 },
          { kind: "set_hp_half_max" },
          { kind: "gain_block", amount: 32, sync: true, minAscension: 19 },
          { kind: "remove_debuffs" },
        ],
        intent: "buff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.time_eater`（MonsterSpecific.cpp:3231-3270）。
    // 旧近似表那份加权（45/35/20 + maxInARow）与参考的四段式规则完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕精英：复仇魔（隔回合虚无缥缈，第三十六批按参考逐位校准）——
  {
    id: "nemesis",
    name: "复仇魔",
    // MonsterIds.h:184 `{{185,185},{200,200}}`；`setRandomHp(hpRng, asc >= 8)`
    //（MonsterSpecific.cpp:91-102，**精英**那一档）。
    // ⚠ 上下界相同**照样掷一次**（`Random::random(int,int)` 无条件 `++counter`）——
    //   与守卫者的 `{240,240}` 同族，不是 `hpNoRoll`。
    hpMin: 185,
    hpMax: 185,
    // ⚠ 它**没有** `preBattleAction`（`Monster::preBattleAction` 的 switch 里没有
    //   `NEMESIS` 这一格），虚无缥缈全靠三条招式自己在 `takeTurn` 里补，见 MOVE_TURN_END。
    moves: [
      {
        // 多重打击（MonsterSpecific.cpp:1585-1591）：`attackPlayerHelper(bc, asc3 ? 7 : 6, 3)`
        // ——三段、每段 6（asc3 是 7）。分档挂在**第一个**实参上，段数恒 3。
        // ⚠ 收尾与虚无缥缈那条 `if` 见 MOVE_TURN_END（两条都是入队的，且**排在效果之后**）。
        id: "nem_attack",
        name: "多重打击",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 6,
            times: 3,
            ascAmount: [{ atLeast: 3, amount: 7 }],
          },
        ],
        intent: "attack",
      },
      {
        // 巨镰（MonsterSpecific.cpp:1601-1607）：`attackPlayerHelper(bc, 45)`。
        // ⚠ 参考这里**没有 `asc? :`**——45 是写死的，与多重打击不同族。
        id: "nem_scythe",
        name: "巨镰",
        effects: [{ kind: "deal_damage", amount: 45 }],
        intent: "attack",
      },
      {
        // 灼烧诅咒（MonsterSpecific.cpp:1593-1599）：
        //     Actions::MakeTempCardInDiscard({CardId::BURN}, asc3 ? 5 : 3).actFunc(bc);
        // ⚠ 三处照抄：
        //  ① `.actFunc(bc)` = **同步**（不是 addToBot），所以三张灼烧在紧随其后那次
        //     **同步** rollMove 之前就已经进了弃牌堆；
        //  ② 张数分档是 **asc3**（精英那一族），不是走廊小怪的 asc2；
        //  ③ 塞的是**未升级**的灼烧（`{CardId::BURN}` 的单参构造），与六火幽魂那条
        //     `CardInstance(BURN, bc.turn > 8)` 不同——这里没有那个第二实参。
        id: "nem_debuff",
        name: "灼烧诅咒",
        effects: [
          {
            kind: "add_card",
            cardId: "burn",
            pile: "discard",
            count: 3,
            ascAmount: [{ atLeast: 3, amount: 5 }],
            sync: true,
          },
        ],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.nemesis`（MonsterSpecific.cpp:2554-2607）。
    // 旧近似表那份加权（35/30/35）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 精英：地精头目（第十八批）——
  //
  // ⚠ **激怒（ENRAGE）不写在这里以外的地方**：它由咆哮那一招施加（`buff<MS::ENRAGE>`，
  // MonsterSpecific.cpp:757），不是 `preBattleAction`——与狂暴地精的狂怒（开局自带）不同。
  // 触发点在**玩家打出技能牌**时（`BattleContext::onUseSkillCard` 末尾，:1847-1849），
  // 见 sts-combat.ts 的 `onUseSkillCard`。
  {
    id: "gremlin_nob",
    name: "地精头目",
    // MonsterIds.h:175 `{{82,86},{85,90}}`。⚠ **精英的血量阈值是 asc>=8**，不是走廊小怪的 7
    //（MonsterSpecific.cpp:91-102 那一组 case 走 `setRandomHp(hpRng, ascension >= 8)`）。
    hpMin: 82,
    hpMax: 86,
    hpHigh: { atLeast: 8, hpMin: 85, hpMax: 90 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:756-758 `buff<MS::ENRAGE>(asc18 ? 3 : 2)`——**同步** buff。
        // ⚠ 分档是 **asc18**（不是常见的 17）：精英走 `getTriIdx(asc, 3, 18)` 那一档。
        id: "bellow",
        name: "咆哮",
        effects: [
          {
            kind: "apply_power",
            power: "enrage",
            amount: 2,
            on: "self",
            ascAmount: [{ atLeast: 18, amount: 3 }],
          },
        ],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:761-763 `attackPlayerHelper(bc, asc3 ? 16 : 14)`。
        // ⚠ 精英的伤害分档是 **asc3**（走廊小怪是 asc2）。
        id: "rush",
        name: "猛冲",
        effects: [{ kind: "deal_damage", amount: 14, ascAmount: [{ atLeast: 3, amount: 16 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:766-769：伤害 `asc3 ? 8 : 6`，随后
        // `addToBot(DebuffPlayer<VULNERABLE>(2, true))`——第二个参数是 isSourceMonster。
        // ⚠ 易伤那 2 层**没有**分档，只有伤害有。
        id: "skull_bash",
        name: "碎颅击",
        effects: [
          { kind: "deal_damage", amount: 6, ascAmount: [{ atLeast: 3, amount: 8 }] },
          { kind: "apply_power", power: "vulnerable", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（首招必咆哮，之后 roll<33 或连两次猛冲 → 碎颅击）。
    // ⚠ `MonsterMoves.h` 的攻击白名单里有 `GREMLIN_NOB_RUSH`(:460) 与
    //   `GREMLIN_NOB_SKULL_BASH`(:461)，`GREMLIN_NOB_BELLOW` **不在**——与上面的
    //   attack / attack / buff 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 精英：拉加维林（第十八批：沉睡 / 苏醒 + 金属化）——
  //
  // ⚠ 沉睡（ASLEEP）与金属化 8 层都**不写在这里**，理由与真菌兽的孢子云同族：
  //   * `ASLEEP` 由**编队**给（`MonsterGroup.cpp:295` 的 `setHasStatus<MS::ASLEEP>(true)`，
  //     只有 `LAGAVULIN` 这个编队有，事件版 `LAGAVULIN_EVENT` 没有），见 `ENCOUNTER_SETUP`；
  //   * `METALLICIZE(8)` + `addBlock(8)` 由 `preBattleAction` 给，而且**以睡着为前提**
  //     （MonsterSpecific.cpp:286-291），见 `PRE_BATTLE_ACTION`。
  // 两者都会出现在 trace 的怪物快照里（`ASLEEP: 1` / `METALLICIZE: 8`）。
  {
    id: "lagavulin",
    name: "拉加维林",
    // MonsterIds.h:179 `{{109,111},{112,115}}`。⚠ 精英阈值 **asc>=8**（MonsterSpecific.cpp:96）。
    hpMin: 109,
    hpMax: 111,
    hpHigh: { atLeast: 8, hpMin: 112, hpMax: 115 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:888-894：整条 case **没有任何效果**，只有收尾
        //（判断醒没醒 / 是不是第 3 个回合）。见 MOVE_TURN_END["lagavulin/sleep"]。
        id: "sleep",
        name: "沉睡",
        effects: [],
        intent: "unknown",
      },
      {
        // MonsterSpecific.cpp:871 `attackPlayerHelper(bc, asc3 ? 20 : 18)`（精英档 asc3）。
        id: "lag_attack",
        name: "重击",
        effects: [{ kind: "deal_damage", amount: 18, ascAmount: [{ atLeast: 3, amount: 20 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:882-883。⚠ 两处逐位对齐点：
        //  ① **顺序是敏捷在前、力量在后**（照抄，别按「力量优先」的直觉写）；
        //  ② 两条都是 `.actFunc(bc)` —— **同步**执行，不是 addToBot。这是全项目
        //     唯一一处「怪物给玩家上减益却不入队」，故加 `sync: true`。
        // 数值 `asc18 ? -2 : -1`，asc0 取 -1。⚠ 分档在**负数**上：asc18 起是 -2，
        //   `ascAmount` 只管「换个数」，符号是数据自己的一部分。
        id: "siphon_soul",
        name: "吸取灵魂",
        effects: [
          {
            kind: "apply_power",
            power: "dexterity",
            amount: -1,
            on: "target",
            sync: true,
            ascAmount: [{ atLeast: 18, amount: -2 }],
          },
          {
            kind: "apply_power",
            power: "strength",
            amount: -1,
            on: "target",
            sync: true,
            ascAmount: [{ atLeast: 18, amount: -2 }],
          },
        ],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（只在开局调一次：睡着出沉睡、否则出吸取灵魂）。
    // ⚠ 攻击白名单里只有 `LAGAVULIN_ATTACK`(`MonsterMoves.h:469`)，`LAGAVULIN_SLEEP` 与
    //   `LAGAVULIN_SIPHON_SOUL` **都不在**——与上面的 unknown / attack / debuff 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 精英：哨卫（第十八批：本项目第一只带**神器**的怪）——
  //
  // ⚠ 神器（ARTIFACT 1 层）由 `preBattleAction` 给（MonsterSpecific.cpp:311-313），
  // 不写在这里；它会出现在快照里（`ARTIFACT: 1`），并且真的会吃掉玩家的第一个减益
  //（`BattleContext::debuffEnemy` 的那道拦截，BattleContext.h:284-287）。
  {
    id: "sentry",
    name: "哨卫",
    // MonsterIds.h:192 `{{38,42},{39,45}}`。⚠ 精英阈值 **asc>=8**（MonsterSpecific.cpp:98）。
    hpMin: 38,
    hpMax: 42,
    hpHigh: { atLeast: 8, hpMin: 39, hpMax: 45 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1057-1061 `attackPlayerHelper(bc, asc3 ? 10 : 9)`（精英档 asc3）。
        id: "beam",
        name: "光束",
        effects: [{ kind: "deal_damage", amount: 9, ascAmount: [{ atLeast: 3, amount: 10 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1063-1067
        // `addToBot(MakeTempCardInDiscard({CardId::DAZED}, asc18 ? 3 : 2))`。
        // ⚠ **是弃牌堆不是抽牌堆**（洗入抽牌堆那一路要掷 cardRandomRng，这里一次都不掷），
        //   与史莱姆的黏液走的是同一条路。asc0 是 2 张、asc18 起 3 张。
        // ⚠ 分档挂在 `count` 上（`add_card.ascAmount` 的语义就是张数），不是别的字段。
        id: "bolt",
        name: "射钉",
        effects: [
          {
            kind: "add_card",
            cardId: "dazed",
            pile: "discard",
            count: 2,
            ascAmount: [{ atLeast: 18, amount: 3 }],
          },
        ],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（**按下标奇偶**定首招，之后严格交替）。
    // ⚠ 攻击白名单里只有 `SENTRY_BEAM`(`MonsterMoves.h:489`)，`SENTRY_BOLT` **不在**
    //   ——与上面的 attack / debuff 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— Boss：守卫者（第十九批：形态切换 + 尖锐外壳）——
  //
  // ⚠ 三样东西**都不写在这里**，理由与真菌兽的孢子云 / 拉加维林的沉睡同族
  //（写在数据表里就是第二份真相）：
  //   * `MODE_SHIFT` 的初值（asc19 ? 40 : asc9 ? 35 : 30）由 `preBattleAction` 给，
  //     同一个数还要写进 `miscInfo` 当「下次的阈值」，见 `PRE_BATTLE_ACTION.the_guardian`；
  //   * 攒够伤害 → 进防御形态那一整套（读 MODE_SHIFT 层数、归零时 `setMove` +
  //     `addToBot(MonsterGainBlock(20))`）在 `MONSTER_ON_HP_LOST.the_guardian`；
  //   * 七条招式的「下一招是谁」全是 case 尾部的**同步 `setMove`**，在 `MOVE_TURN_END`。
  //     双重猛击的尾部还有三句（清尖锐外壳 / `miscInfo += 10` / `addToBot(BuffEnemy
  //     <MODE_SHIFT>(idx, miscInfo))`），一并写在那里。
  // ⚠ 于是这只怪的 `getMoveForRoll` **一场仗只被调用一次**（开局那次，恒返回蓄能）。
  {
    id: "the_guardian",
    name: "守卫者",
    // MonsterIds.h:211 `{{240,240},{250,250}}`（Boss 走 `setRandomHp(hpRng, asc>=9)`，
    // MonsterSpecific.cpp:85-88）。⚠ 上下界相同**照样掷一次** monsterHpRng
    //（`Random::random(int,int)` 无条件 `++counter`，Random.h:159）——高档那一组同理。
    // ⚠ **Boss 的阈值是 9**，精英是 8、走廊小怪是 7，三档各写各的。
    hpMin: 240,
    hpMax: 240,
    hpHigh: { atLeast: 9, hpMin: 250, hpMax: 250 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:1347 `addBlock(9)`。⚠ 是**同步**的裸 `addBlock`，
        // 不是 `addToBot(MonsterGainBlock)`，故 `sync: true`。
        id: "charging_up",
        name: "蓄能",
        effects: [{ kind: "gain_block", amount: 9, sync: true }],
        intent: "defend",
      },
      {
        // MonsterSpecific.cpp:1352 `buff<MS::SHARP_HIDE>(asc19 ? 4 : 3)`（同步自 buff）。
        // 尖锐外壳 = 玩家每打出一张**攻击牌**就吃 3 点无视格挡伤害，触发点在
        // `BattleContext::onUseAttackCard` 的最末（BattleContext.cpp:1756-1759）。
        // ⚠ 分档是 **asc19**（Boss 走 `getTriIdx(asc, 4, 19)` 那一档），asc19 起 4 点。
        id: "defensive_mode",
        name: "防御形态",
        effects: [
          {
            kind: "apply_power",
            power: "sharp_hide",
            amount: 3,
            on: "self",
            ascAmount: [{ atLeast: 19, amount: 4 }],
          },
        ],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:1362 `attackPlayerHelper(bc, asc4 ? 10 : 9)`（Boss 档 asc4）。
        id: "roll_attack",
        name: "滚压",
        effects: [{ kind: "deal_damage", amount: 9, ascAmount: [{ atLeast: 4, amount: 10 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1357 `attackPlayerHelper(bc, asc4 ? 36 : 32)`（Boss 档 asc4）。
        id: "fierce_bash",
        name: "重砸",
        effects: [{ kind: "deal_damage", amount: 32, ascAmount: [{ atLeast: 4, amount: 36 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1375-1376。⚠ **顺序是易伤在前、虚弱在后**——照抄，
        //   别按「虚弱更常见」的直觉写。方向是可观察的：玩家带神器（古代药水）时，
        //   被吃掉的是**排在前面**的那一条。两条都是 `addToBot(DebuffPlayer<…>(2, true))`。
        id: "vent_steam",
        name: "泄气",
        effects: [
          { kind: "apply_power", power: "vulnerable", amount: 2, on: "target" },
          { kind: "apply_power", power: "weak", amount: 2, on: "target" },
        ],
        intent: "debuff",
      },
      {
        // MonsterSpecific.cpp:1381 `attackPlayerHelper(bc, 5, 4)`。⚠ 没有 asc 分档。
        // 多段攻击的伤害**只算一次**（`attackPlayerHelper` 先 `calculateDamageToPlayer`
        // 再循环 `addToBot`，Monster.cpp:601-607），所以四段吃的是同一个易伤/虚弱快照。
        id: "whirlwind",
        name: "旋风",
        effects: [{ kind: "deal_damage_multi", amount: 5, times: 4 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1367 `attackPlayerHelper(bc, 8, 2)`。同上，无 asc 分档。
        // ⚠ 这条 case 的尾部还有三句（清尖锐外壳 / 抬阈值 / 重新挂 MODE_SHIFT），
        //   见 `MOVE_TURN_END["the_guardian/twin_slam"]`。
        id: "twin_slam",
        name: "双重猛击",
        effects: [{ kind: "deal_damage_multi", amount: 8, times: 2 }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（恒返回蓄能，只在开局被调用一次）。
    // ⚠ 攻击白名单（MonsterMoves.h:518-521）里只有 `THE_GUARDIAN_FIERCE_BASH` /
    //   `_WHIRLWIND` / `_ROLL_ATTACK` / `_TWIN_SLAM`，`_CHARGING_UP` / `_DEFENSIVE_MODE` /
    //   `_VENT_STEAM` **都不在**——与上面的 defend / buff / debuff 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— Boss：六火幽魂（第二十批：激活锁伤 → 分割 6 连 → 固定七招循环）——
  //
  // ⚠ 三样东西**都不写在这里**（写进数据表就是第二份真相，与守卫者 / 拉加维林同族）：
  //   * 「分割每击打多少」由**激活**那一回合按玩家当时的生命算定，存进 `miscInfo`
  //     （`store_hp_scaled_damage`），分割自己读 `deal_damage_rolled`；
  //   * 「下一招是谁」全部是 case 尾部的语句，六条都在 `MOVE_TURN_END`——而且它们读写的
  //     `uniquePower0`（六焰计数）是**另一个字段**，不是 `miscInfo`；
  //   * 灼烧塞的是灼伤+还是灼伤，由 `bc.turn > 8` 在**排队那一刻**决定（`upgradedAfterTurn`）。
  // ⚠ 于是这只怪的 `getMoveForRoll` **一场仗只被调用一次**（开局那次，恒返回激活），
  //   与守卫者 / 史莱姆王同形。
  {
    id: "hexaghost",
    name: "六火幽魂",
    // MonsterIds.h:178 `{{250,250},{264,264}}`（Boss 走 `setRandomHp(hpRng, asc>=9)`，
    // MonsterSpecific.cpp:81-89）。⚠ 上下界相同**照样掷一次** monsterHpRng
    //（`Random::random(int,int)` 无条件 `++counter`，Random.h:159）——高档那一组同理。
    // ⚠ 它**没有** `Monster::construct` 的怪种特例（Monster.cpp:109 的 switch 只有虱子与
    //   暗黑爬虫），也**没有** `preBattleAction`（MonsterSpecific.cpp:140 的 switch 里没有它），
    //   所以建怪只掷一次 monsterHpRng、开局身上一个 Power 都没有。
    hpMin: 250,
    hpMax: 250,
    hpHigh: { atLeast: 9, hpMin: 264, hpMax: 264 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:793-798。case 里**只有**一句 `miscInfo = bc.player.curHp / 12 + 1;`
        // ——是 C++ 的整数除法（向零截断），且**只在这一刻**算，此后玩家掉多少血都不再变。
        // 收尾（同步 setMove + 同步 noOpRollMove）在 MOVE_TURN_END。
        // ⚠ 攻击白名单（MonsterMoves.h:463-466）里**没有** `HEXAGHOST_ACTIVATE`，与 unknown 一致。
        id: "activate",
        name: "激活",
        effects: [{ kind: "store_hp_scaled_damage", divisor: 12, add: 1 }],
        intent: "unknown",
      },
      {
        // MonsterSpecific.cpp:801 `attackPlayerHelper(bc, miscInfo, 6)`——每击的伤害取
        // 激活那一刻存下的 `miscInfo`，六段共用同一次 `calculateDamageToPlayer`
        // （多段攻击伤害只算一次，Monster.cpp:601-607）。
        id: "divider",
        name: "六重打击",
        effects: [{ kind: "deal_damage_rolled", times: 6 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:823-826：`attackPlayerHelper(bc, 6)` 之后
        // `addToBot(MakeTempCardInDiscard(CardInstance(BURN, bc.turn > 8), asc19 ? 2 : 1))`。
        // ⚠ 两个分档是**独立**的：张数按 asc19（asc0 恒 1 张、asc19 起 2 张），
        //   升不升级按 `bc.turn > 8`——`bc.turn` 从 0 起、在 `afterMonsterTurns` 里才自增，
        //   所以第 10 个怪物回合起塞的是灼伤+（回合末 4 点）。asc0 也走得到，
        //   见 `upgradedAfterTurn`。⚠ **伤害那 6 点没有分档**，只有张数有。
        id: "sear",
        name: "灼烧",
        effects: [
          { kind: "deal_damage", amount: 6 },
          {
            kind: "add_card",
            cardId: "burn",
            pile: "discard",
            count: 1,
            upgradedAfterTurn: 8,
            ascAmount: [{ atLeast: 19, amount: 2 }],
          },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:841 `attackPlayerHelper(bc, asc4 ? 6 : 5, 2)`。
        // ⚠ 分档挂在**每一击**的伤害上，段数 2 恒定（第二个实参）。
        id: "tackle",
        name: "冲撞",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 5,
            times: 2,
            ascAmount: [{ atLeast: 4, amount: 6 }],
          },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:815-816：`addBlock(12)` 然后 `buff<MS::STRENGTH>(asc19 ? 3 : 2)`。
        // ⚠ `addBlock` 是**同步**的裸调用（不是 `addToBot(MonsterGainBlock)`），故 `sync: true`
        //   ——与守卫者的蓄能同族；两句都同步，所以书写顺序就是结算顺序。
        // ⚠ 攻击白名单里**没有** `HEXAGHOST_INFLAME`，与 buff 一致。
        // ⚠ **格挡那 12 点没有分档**，只有力量有（asc19 起 3）。
        id: "inflame",
        name: "燃焰",
        effects: [
          { kind: "gain_block", amount: 12, sync: true },
          {
            kind: "apply_power",
            power: "strength",
            amount: 2,
            on: "self",
            ascAmount: [{ atLeast: 19, amount: 3 }],
          },
        ],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:808 `attackPlayerHelper(bc, asc4 ? 3 : 2, 6)`（Boss 档 asc4）。
        // ⚠ **参考的地狱之火只有伤害**：真实游戏里它还会把牌堆里已有的灼伤全部升级，
        //   而参考全项目没有任何「升级灼伤」的代码（`grep BURN` 只有生成那几处）。
        //   本批照抄参考、不打补丁，理由与关门条件记在 TODOS「已确认但尚未打补丁」。
        id: "inferno",
        name: "地狱之火",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 2,
            times: 6,
            ascAmount: [{ atLeast: 4, amount: 3 }],
          },
        ],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（恒返回激活，只在开局被调用一次）。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 大史莱姆两只（第十四批校准）——
  //
  // 血量取自 `MonsterIds.h:152 / :202 monsterHpRange` 的**第一组**（两只都走
  // `setRandomHp(hpRng, ascension >= 7)`，见 `MonsterSpecific.cpp:37 / :68`）；招式数值取自
  // `MonsterSpecific.cpp` 的 `Monster::takeTurn`，行号逐条标在招式上。
  // ⚠ 与参考逐字比对过，五条已有招式与两段血量区间**一条都没有出入**，本批只**新增**了分裂。
  // ⚠ 两只都**没有** `Monster::construct` 的怪种特例（`Monster.cpp:109` 的 switch 只有虱子与
  //   暗黑爬虫），也**没有** `preBattleAction`（`MonsterSpecific.cpp:140` 的 switch 里没有它们），
  //   所以建怪只掷一次 monsterHpRng。
  // ⚠ 它们也**没有易塑**（MALLEABLE）：参考全项目只有蛇草与蠕动血块 buff 它
  //   （`MonsterSpecific.cpp:213 / :249`）。TODOS 早先记的「L 号与史莱姆王有易塑」是错的，
  //   本批已改正。
  // ⚠ `intentRule` 同 M/S 号：**旧近似战斗的遗留数据**，游戏级实现不读它。
  {
    id: "acid_slime_l",
    name: "酸液史莱姆（大）",
    // MonsterIds.h:152 `{{65,69},{68,72}}`（asc<7 取前者）。
    hpMin: 65,
    hpMax: 69,
    hpHigh: { atLeast: 7, hpMin: 68, hpMax: 72 },
    ascCalibrated: true,
    splitInto: ["acid_slime_m", "acid_slime_m"],
    moves: [
      {
        // MonsterSpecific.cpp:353 `attackPlayerHelper(asc2 ? 12 : 11)`
        //   + `addToBot(MakeTempCardInDiscard({SLIMED}, 2))`。
        id: "corrosive_spit_l",
        name: "腐蚀喷吐",
        effects: [
          { kind: "deal_damage", amount: 11, ascAmount: [{ atLeast: 2, amount: 12 }] },
          { kind: "add_card", cardId: "slimed", pile: "discard", count: 2 },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:368 `attackPlayerHelper(asc2 ? 18 : 16)`。
        id: "tackle_l",
        name: "冲撞",
        effects: [{ kind: "deal_damage", amount: 16, ascAmount: [{ atLeast: 2, amount: 18 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:359 `addToBot(DebuffPlayer<WEAK>(2, true))`——**没有 asc 分档**
        // （与尖刺 L 的舔舐不对称：那条脆弱是 `asc17 ? 3 : 2`）。
        id: "lick_l",
        name: "舔舐",
        effects: [{ kind: "apply_power", power: "weak", amount: 2, on: "target" }],
        intent: "debuff",
      },
      {
        // 分裂（MonsterSpecific.cpp:364 → `largeSlimeSplit(bc, ACID_SLIME_M, idx, curHp)`）。
        // ⚠ 它**不由 getMoveForRoll 掷出**：`Monster::onHpLost`（Monster.cpp:502）在掉到
        //   `curHp <= maxHp/2` 时**直接改写** `moveHistory[0]`。整套时点与 RNG 消耗写在
        //   sts-combat.ts 的 `splitMonster`，这里只登记「这是一招、意图不是攻击」。
        // ⚠ 意图必须**不是** attack：`MonsterMoves.h:416` 的 `isMoveAttack` 白名单里
        //   只有 `ACID_SLIME_L_CORROSIVE_SPIT` / `ACID_SLIME_L_TACKLE`（:417-418），
        //   `ACID_SLIME_L_SPLIT` 与 `ACID_SLIME_L_LICK` 都不在。
        id: "split",
        name: "分裂",
        effects: [{ kind: "split" }],
        intent: "unknown",
      },
    ],
    // 权重近似（对齐中酸液史莱姆的手感，L 精确权重待校准）。
    intentRule: {
      scripted: [],
      weighted: [
        { move: "corrosive_spit_l", weight: 30, maxInARow: 2 },
        { move: "tackle_l", weight: 40, maxInARow: 1 },
        { move: "lick_l", weight: 30, maxInARow: 2 },
      ],
    },
  },
  {
    id: "spike_slime_l",
    name: "尖刺史莱姆（大）",
    // MonsterIds.h:202 `{{64,70},{67,73}}`。
    hpMin: 64,
    hpMax: 70,
    hpHigh: { atLeast: 7, hpMin: 67, hpMax: 73 },
    ascCalibrated: true,
    splitInto: ["spike_slime_m", "spike_slime_m"],
    moves: [
      {
        // MonsterSpecific.cpp:1187 `attackPlayerHelper(asc2 ? 18 : 16)`
        //   + `addToBot(MakeTempCardInDiscard({SLIMED}, 2))`。
        id: "flame_tackle_l",
        name: "火焰冲撞",
        effects: [
          { kind: "deal_damage", amount: 16, ascAmount: [{ atLeast: 2, amount: 18 }] },
          { kind: "add_card", cardId: "slimed", pile: "discard", count: 2 },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1193 `addToBot(DebuffPlayer<FRAIL>(asc17 ? 3 : 2, true))`。
        id: "lick_frail_l",
        name: "舔舐",
        effects: [
          {
            kind: "apply_power",
            power: "frail",
            amount: 2,
            on: "target",
            ascAmount: [{ atLeast: 17, amount: 3 }],
          },
        ],
        intent: "debuff",
      },
      {
        // 分裂（MonsterSpecific.cpp:1198 → `largeSlimeSplit(bc, SPIKE_SLIME_M, idx, curHp)`）。
        // 触发与酸液大号完全同源（`Monster::onHpLost`，Monster.cpp:514）。
        // 白名单里只有 `SPIKE_SLIME_L_FLAME_TACKLE`（`MonsterMoves.h:503`），
        // `SPIKE_SLIME_L_SPLIT` / `SPIKE_SLIME_L_LICK` 都不在 → 意图不是攻击。
        id: "split",
        name: "分裂",
        effects: [{ kind: "split" }],
        intent: "unknown",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "flame_tackle_l", weight: 70, maxInARow: 2 },
        { move: "lick_frail_l", weight: 30, maxInARow: 2 },
      ],
    },
  },

  // —— Boss：史莱姆王（第十九批：3 回合循环 + 半血分裂成两只**大**史莱姆）——
  //
  // ⚠ 它**没有** `preBattleAction`、也没有 `Monster::construct` 的怪种特例，
  //   所以建怪只掷一次 monsterHpRng。
  // ⚠ 分裂不由 `getMoveForRoll` 掷出：`Monster::onHpLost`（Monster.cpp:507-511）在掉到
  //   `curHp <= maxHp/2` 时**直接改写** `moveHistory[0]`（不是 setMove、不前移历史），
  //   与两只大史莱姆逐字同构。
  {
    id: "slime_boss",
    name: "史莱姆王",
    // MonsterIds.h:196 `{{140,140},{150,150}}`（Boss 走 `setRandomHp(hpRng, asc>=9)`）。
    // ⚠ 上下界相同照样掷一次 monsterHpRng，同守卫者。
    // ⚠ 分裂出来的两只大史莱姆继承**分裂那一刻的当前生命**、不重掷血量，所以
    //   150 血这一档只改母体的起点；两只 L 号自己的 `hpHigh`（阈值 7）在这条路上用不上。
    hpMin: 140,
    hpMax: 140,
    hpHigh: { atLeast: 9, hpMin: 150, hpMax: 150 },
    ascCalibrated: true,
    // 分裂去向（MonsterSpecific.cpp:3400-3404）：**下标 0 是尖刺大、下标 2 是酸液大**。
    // ⚠ 顺序绑定，不是随机——与 `small_slimes` / `large_slime` 那种 randomBoolean 不同族。
    splitInto: ["spike_slime_l", "acid_slime_l"],
    moves: [
      {
        // MonsterSpecific.cpp:1112
        // `Actions::MakeTempCardInDiscard({SLIMED}, asc19 ? 5 : 3).actFunc(bc)`。
        // ⚠ 是 `.actFunc(bc)` —— **同步**执行，与史莱姆们的 `addToBot(...)` 不同，故 sync: true。
        // ⚠ 进的是**弃牌堆**，一次 RNG 都不掷（洗入抽牌堆那一路才要 cardRandomRng）。
        // ⚠ 张数分档是 **asc19**（3 → 5），与哨卫射钉的 asc18 不同档，逐条对参考别照抄邻居。
        id: "goop_spray",
        name: "黏液喷射",
        effects: [
          {
            kind: "add_card",
            cardId: "slimed",
            pile: "discard",
            count: 3,
            sync: true,
            ascAmount: [{ atLeast: 19, amount: 5 }],
          },
        ],
        intent: "debuff",
      },
      {
        // MonsterSpecific.cpp:1116-1118：整条 case **没有任何效果**，只有收尾 setMove(SLAM)。
        id: "preparing",
        name: "蓄力",
        effects: [],
        intent: "unknown",
      },
      {
        // MonsterSpecific.cpp:1121 `attackPlayerHelper(bc, asc4 ? 38 : 35)`（Boss 档 asc4）。
        // ⚠ 参考在收尾那行注了 `// the attack is executed after, which is critical`：
        //   `setMove(GOOP_SPRAY)` 是**同步**的，而伤害是 `addToBot`，所以快照里意图先变、
        //   伤害后落。照抄这个顺序。
        id: "slam",
        name: "猛砸",
        effects: [{ kind: "deal_damage", amount: 35, ascAmount: [{ atLeast: 4, amount: 38 }] }],
        intent: "attack",
      },
      {
        // 分裂（MonsterSpecific.cpp:1125-1127 → `slimeBossSplit(bc, curHp)`）。
        // ⚠ 用的是 `split_boss` 而**不是** `split`：两者是参考里两个不同的函数，
        //   形状差五处，见 `Effect` 的注释与 sts-combat.ts 的 `slimeBossSplit`。
        // ⚠ 意图必须**不是** attack：白名单（MonsterMoves.h:494）里只有 `SLIME_BOSS_SLAM`。
        id: "split",
        name: "分裂",
        effects: [{ kind: "split_boss" }],
        intent: "unknown",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（首回合必黏液喷射，之后整场再不调用它——
    // 三条 case 的收尾全是同步 setMove，分裂那条压根没有收尾）。
    // ⚠ 攻击白名单里只有 `SLIME_BOSS_SLAM`（MonsterMoves.h:494），`_GOOP_SPRAY` /
    //   `_PREPARING` / `_SPLIT` 都不在——与上面的 debuff / unknown / unknown 一致。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 补全敌人：填平各幕遭遇缺口（HP/伤害对齐 sts_lightspeed asc0；飞行/反应/复生等异形机制近似为加权出招）——
  {
    // —— 第二十四批：拜鸟（第二幕，`THREE_BYRDS` / `CHOSEN_AND_BYRDS`）——
    //
    // ⚠ **飞行（FLIGHT）整条不写在这张表里**，写在 sts-combat.ts 的三处：
    //   `PRE_BATTLE_ACTION.byrd`（开局 3 层）、`monsterDamageUnblocked` 的 else-if 链
    //   （受击 -1，减到 0 就摔下来改出 `stunned`）、`applyPreTurnLogic`（回合开始复位回 3）。
    //   减半伤害那一处在 `calculateCardDamage`。数据表只描述招式。
    id: "byrd",
    name: "拜鸟",
    // MonsterIds.h:160 `{{25,31},{26,33}}`；普通怪阈值 `setRandomHp(hpRng, asc >= 7)`
    // （MonsterSpecific.cpp:42）。
    // ✅ **第三十批校准了爬升度分档**（含开局 / 回合开始那两处飞行层数 `asc17 ? 4 : 3`，
    //   它们分别在 `PRE_BATTLE_ACTION.byrd` 与 `applyPreTurnLogic` 里，不在这张表）。
    hpMin: 25,
    hpMax: 31,
    hpHigh: { atLeast: 7, hpMin: 26, hpMax: 33 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:547-549 `attackPlayerHelper(bc, 1, asc2 ? 6 : 5)`。
        // ⚠⚠ **每击 1 点、打 5 下**，不是「1 点 × 5 = 5 点的单击」——旧近似表把段数写对了
        //   却把它当成 `deal_damage_multi(1, 5)` 的巧合；这里逐位对齐的关键是**每一击都
        //   单独走一次玩家格挡与荆棘/火焰屏障**。
        // ⚠⚠ **爬升度挂在第三个实参（段数）上，不是伤害上**——全参考项目只有三处这样写，
        //   第二幕里只有这一处。第三十批为它加了 `ascTimes`（与 `ascAmount` 正交），
        //   判据只有一条：**看参考把 `asc? :` 写在哪个实参位上**。每击伤害恒是 1。
        id: "peck",
        name: "啄击",
        effects: [
          { kind: "deal_damage_multi", amount: 1, times: 5, ascTimes: [{ atLeast: 2, amount: 6 }] },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:557-560 `attackPlayerHelper(bc, asc2 ? 14 : 12)`。
        id: "swoop",
        name: "俯冲",
        effects: [{ kind: "deal_damage", amount: 12, ascAmount: [{ atLeast: 2, amount: 14 }] }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:532-535 `buff<MS::STRENGTH>(1)`——**没有 asc 分档**，
        // 而且是同步 buff（`on: "self"` 省略 `sync` 即同步）。
        id: "caw",
        name: "啼鸣",
        effects: [{ kind: "apply_power", power: "strength", amount: 1, on: "self" }],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:537-540 `buff<MS::FLIGHT>(asc17 ? 4 : 3)`——重新起飞。
        // ⚠ 是 `buff`（**累加**）而不是 setStatus：这一回合开头 `applyPreTurnLogic` 刚把
        //   飞行复位成 3，所以飞完实际是 **6**。照抄，别按「回到 3」的直觉写。
        // ⚠ asc17 那一档是 4（第三十批补），于是高档飞完是 **8**。
        id: "fly",
        name: "起飞",
        effects: [
          {
            kind: "apply_power",
            power: "flight",
            amount: 3,
            on: "self",
            ascAmount: [{ atLeast: 17, amount: 4 }],
          },
        ],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:542-545 `attackPlayerHelper(bc, 3)` + 同步 `setMove(BYRD_FLY)`。
        // ⚠ **没有 asc 分档**（3 点是常数），与俯冲/啄击不同。收尾见 `MOVE_TURN_END`。
        id: "headbutt",
        name: "头槌",
        effects: [{ kind: "deal_damage", amount: 3 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:552-555：整条 case 只有 `bc.noOpRollMove(); setMove(HEADBUTT);`
        // ——**一个效果都没有**（摔在地上的那一回合什么也不做）。两句都在 `MOVE_TURN_END`。
        // ⚠ 这个意图不是 `getMoveForRoll` 掷出来的，而是**受击时**由
        //   `attackedUnblockedHelper` 直接 `setMove` 写进去的（飞行层数归零那一刻）。
        id: "stunned",
        name: "眩晕",
        effects: [],
        intent: "unknown",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.byrd`（首回合 37.5% 啼鸣、否则啄击；
    // 之后三段 roll，每段都可能**追加**一次 aiRng）。
    // ⚠ 攻击白名单里是 `BYRD_PECK` / `BYRD_SWOOP` / `BYRD_HEADBUTT`（`MonsterMoves.h:436-438`），
    //   `BYRD_CAW` / `BYRD_FLY` / `BYRD_STUNNED` **不在**——与这里的 attack ×3 / buff ×2 /
    //   unknown 一致。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    // —— 第二十四批：劫匪（第二幕，`TWO_THIEVES` 里与抢劫者同场）——
    //
    // ⚠ 与抢劫者**同族但不同数**，四处差别逐条对着 `MonsterSpecific.cpp` 抄，别照搬邻居：
    //   ① 抢劫 10（asc2 11）与抢劫者相同，但**猛扑 16**（asc2 18）而抢劫者是 12（14）；
    //   ② 烟雾弹 **11**（asc17 17）而抢劫者是恒定的 6；
    //   ③ 抢劫者的对白 RNG 在**第 1 个**怪物回合，劫匪在**第 2 个**；
    //   ④ 劫匪的抢劫与猛扑各**额外**白掷一次 `aiRng.random(2)`（抢劫者一次都没有）。
    //   ③④ 都是纯计数器差异，写在 sts-combat.ts 的 `MOVE_TURN_BEGIN` / `MOVE_TURN_END`。
    // ⚠ 偷金额度来自 `thievery` Power（`preBattleAction` 与抢劫者**共用同一条 case**，
    //   MonsterSpecific.cpp:233-235：`buff<MS::THIEVERY>(asc17 ? 20 : 15)`），不是招式常数。
    // ✅ **第三十批校准了爬升度分档**（含偷金额度 `asc17 ? 20 : 15`，它在
    //   `PRE_BATTLE_ACTION.mugger` 里、不在这张表；那条 case 与抢劫者共用）。
    id: "mugger",
    name: "劫匪",
    // MonsterIds.h:183 `{{48,52},{50,54}}`；普通怪阈值 asc>=7（MonsterSpecific.cpp:55）。
    hpMin: 48,
    hpMax: 52,
    hpHigh: { atLeast: 7, hpMin: 50, hpMax: 54 },
    ascCalibrated: true,
    moves: [
      {
        // MonsterSpecific.cpp:964-982：`stealGoldFromPlayer(...)` + `attackPlayerHelper(asc2 ? 11 : 10)`。
        // ⚠ **偷金在攻击之前**（偷是同步、攻击是入队），照抄书写顺序。
        id: "mug",
        name: "抢劫",
        effects: [
          { kind: "steal_gold" },
          { kind: "deal_damage", amount: 10, ascAmount: [{ atLeast: 2, amount: 11 }] },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:956-962：`stealGoldFromPlayer(...)` + `attackPlayerHelper(asc2 ? 18 : 16)`。
        // ⚠ **不带逃跑**——旧近似表把「扑击逃窜」写成一招里又打又跑，参考里逃跑是
        //   烟雾弹之后单独的一个意图。
        id: "lunge",
        name: "猛扑",
        effects: [
          { kind: "steal_gold" },
          { kind: "deal_damage", amount: 16, ascAmount: [{ atLeast: 2, amount: 18 }] },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:984-988 `addBlock(asc17 ? 17 : 11)`——**同步**加格挡
        // （与抢劫者的烟雾弹同形，数值不同），故 `sync: true`。
        // ⚠ 抢劫者那条是**恒定的 6**、没有分档；这条有 asc17。别照搬邻居。
        id: "smoke_bomb",
        name: "烟雾弹",
        effects: [
          { kind: "gain_block", amount: 11, sync: true, ascAmount: [{ atLeast: 17, amount: 17 }] },
        ],
        intent: "defend",
      },
      {
        // MonsterSpecific.cpp:944-954：与 `LOOTER_ESCAPE` **逐字相同**
        // （`isEscapingB = true; --monstersAlive;` 并在归零时判胜）。
        id: "flee",
        name: "逃跑",
        effects: [{ kind: "escape" }],
        intent: "unknown",
      },
    ],
    // 出招全部由 takeTurn 的同步 setMove 锁定（抢劫 → 抢劫 → 猛扑/烟雾弹 → … → 逃跑），
    // `getMoveForRoll` 只在开局被调用一次且恒返回抢劫（MonsterSpecific.cpp:2550-2551
    // 那行也注着 `// called first turn only`）。
    // ⚠ 攻击白名单里是 `MUGGER_MUG` / `MUGGER_LUNGE`（`MonsterMoves.h:473-474`），
    //   `MUGGER_SMOKE_BOMB` / `MUGGER_ESCAPE` **不在**——与这里的 attack / attack /
    //   defend / unknown 一致。
    intentRule: { scripted: [], weighted: [] },
  },
  // 暗影客（第三十四批按参考逐位校准）。
  {
    id: "darkling",
    name: "暗影客",
    // MonsterIds.h:167 `{{48,56},{50,59}}`（asc<7 取前者）。⚠ **两组**，不是一个区间。
    hpMin: 48,
    hpMax: 56,
    // ⚠⚠ 它是**第二个** `Monster::construct` 里带怪种特例的怪（第一个是虱子）：
    //     case MonsterId::DARKLING:
    //         if (asc >= 2) miscInfo = monsterHpRng.random(9, 13);
    //         else          miscInfo = monsterHpRng.random(7, 11);
    //   （Monster.cpp:124-130）——**建怪时再掷一次 monsterHpRng**，掷出来的数就是
    //   「撕咬」的每击伤害，整场固定。漏掉这一次不会静默：`rng.hp` 计数器当场对不上。
    //   实现在 sts-combat.ts 的 `constructMonster`（与虱子并排）。
    // ⚠ 开局 `preBattleAction` 上 **REGROW**（`buff<MS::REGROW>()`，MonsterSpecific.cpp:152-154，
    //   参考在那行注了 `// game adds regrow power`），纯 bool、进怪物快照（`REGROW: 1`）。
    moves: [
      {
        // 撕咬：`const auto damage = miscInfo + (asc2 ? 2 : 0);`（MonsterSpecific.cpp:1474-1479）。
        // ⚠ 伤害是**出生时掷定**的（见上方 `construct` 那条），不是字面量——所以走
        //   `deal_damage_rolled`（与虱子的咬击同一条原语），asc2 那 +2 走 `ascAdd`（**加**不是覆盖）。
        // ⚠ 参考在那行自注 `// todo maybe make d part of the miscInfo at prebattle`。
        // 收尾是裸的 `addToBot(Actions::RollMove(idx))`，即 `MOVE_TURN_END` 的默认值。
        id: "darkling_nip",
        name: "撕咬",
        effects: [{ kind: "deal_damage_rolled", ascAdd: [{ atLeast: 2, amount: 2 }] }],
        intent: "attack",
      },
      {
        // 啃食：`attackPlayerHelper(bc, asc2 ? 9 : 8)`（MonsterSpecific.cpp:1461-1464）。
        // ⚠ 旧近似表把 9 当成了 asc0 的值，那是**高档**那个数。
        // 收尾同样是默认的 `addToBot(RollMove)`。
        id: "darkling_chomp",
        name: "啃食",
        effects: [{ kind: "deal_damage", amount: 8, ascAmount: [{ atLeast: 2, amount: 9 }] }],
        intent: "attack",
      },
      {
        // 硬化：`addBlock(12); if (asc17) buff<MS::STRENGTH>(2); rollMove(bc);`
        //（MonsterSpecific.cpp:1466-1472）。
        // ⚠ 三处照抄：
        //  ① 加格挡是**同步**的裸 `addBlock(12)`，不是 `addToBot(MonsterGainBlock)`
        //     ——所以 `sync: true`（与抢劫者的烟雾弹同族）。
        //  ② asc17 那层力量是**多出来的一整条效果**（`minAscension`），不是换个数。
        //  ③ 收尾是**同步的真 `rollMove`**（第六形态），见 `MOVE_TURN_END`。
        id: "darkling_harden",
        name: "硬化",
        effects: [
          { kind: "gain_block", amount: 12, sync: true },
          { kind: "apply_power", power: "strength", amount: 2, on: "self", minAscension: 17 },
        ],
        intent: "defend",
      },
      {
        // 重生：`// do nothing` + `rollMove(bc);`（MonsterSpecific.cpp:1481-1484）。
        // ⚠ **效果是空的**——这一招唯一做的事就是收尾那次同步 rollMove，而 `getMoveForRoll`
        //   看到 `halfDead` 为真就返回「复活」。它是 `Monster::die` 的 REGROW 分支
        //   `setMove(MMID::DARKLING_REGROW)` 写进去的，从来不由 roll 掷出来。
        // ⚠ 它也是颚虫军团那个「预置哨兵」用的那个枚举值（MonsterGroup.cpp:285，
        //   参考在那注了「只要不是 INVALID 就行」）——两处无关，别串。
        id: "darkling_regrow",
        name: "重生",
        effects: [],
        intent: "unknown",
      },
      {
        // 复活：五句全同步 + 同步 rollMove（MonsterSpecific.cpp:1486-1499），见 `reincarnate`。
        id: "darkling_reincarnate",
        name: "复生",
        effects: [{ kind: "reincarnate" }],
        intent: "unknown",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.darkling`（MonsterSpecific.cpp:3052-3093）。
    // 旧近似表那份加权（40/40/20）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
  // 尖塔增生（第三十三批按参考逐位校准）。
  {
    id: "spire_growth",
    name: "尖塔幼体",
    // MonsterIds.h:206 `{{170,170},{190,190}}`（asc<7 取前者）。⚠ **两组**，不是一个区间。
    // 走普通的 `setRandomHp`（掷一次）——上下界相同**照样掷**，别与 `hpNoRoll` 混。
    hpMin: 170,
    hpMax: 170,
    // ⚠ 它**没有** preBattleAction（`Monster::preBattleAction` 的 switch 里没有它的 case），
    //   开局身上一个 Power 都没有。
    moves: [
      {
        // 急冲：`attackPlayerHelper(bc, asc2 ? 18 : 16)`（MonsterSpecific.cpp:1504）。
        id: "sg_quick_tackle",
        name: "急冲",
        effects: [{ kind: "deal_damage", amount: 16, ascAmount: [{ atLeast: 2, amount: 18 }] }],
        intent: "attack",
      },
      {
        // 重砸：`attackPlayerHelper(bc, asc2 ? 25 : 22)`（MonsterSpecific.cpp:1509）。
        // ⚠ 旧近似表在这里多挂了一层虚弱——参考那条 case **只有攻击一句**，本批删掉。
        id: "sg_smash",
        name: "重砸",
        effects: [{ kind: "deal_damage", amount: 22, ascAmount: [{ atLeast: 2, amount: 25 }] }],
        intent: "attack",
      },
      {
        // 缠绕：`bc.player.debuff<PS::CONSTRICTED>(asc17 ? 12 : 10);`
        //（MonsterSpecific.cpp:1514）——**裸的 `player.debuff`**，即第二十九批冠军嘲讽
        //  那一族的写法：与 `Actions::DebuffPlayer<...>(n).actFunc(bc)` 逐位等价，
        //  用同一个 `sync: true` 表达。
        // ⚠ 三处照抄：
        //  ① `sync: true`——它不入队，紧随其后那条 `addToBot(RollMove)` 执行时已经生效；
        //  ② **没有第二个实参**，取默认 `isSourceMonster = true`（对束缚无影响，
        //     那道 justApplied 只对虚弱/易伤/脆弱/抽牌削减生效）；
        //  ③ 分档是 **asc17**（走廊小怪那一族的高档），不是 asc2。
        // ⚠ 束缚**不递减也不摘除**，而出招规则里有一道 `!player.hasStatus<CONSTRICTED>()`
        //   的门 → **这一招一场仗最多出一次**。
        id: "sg_constrict",
        name: "缠绕",
        effects: [
          {
            kind: "apply_power",
            power: "constricted",
            amount: 10,
            on: "target",
            sync: true,
            ascAmount: [{ atLeast: 17, amount: 12 }],
          },
        ],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.spire_growth`（MonsterSpecific.cpp:3097-3112）。
    // 三条 case 的收尾都是裸的 `addToBot(Actions::RollMove(idx))`，即 `MOVE_TURN_END` 的默认值。
    // 旧近似表那份加权（50/50、只有两招）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
  // 大嘴（第三十三批按参考逐位校准）。
  {
    id: "the_maw",
    name: "巨口",
    // MonsterIds.h:216 `{{300,300},{300,300}}`。
    hpMin: 300,
    hpMax: 300,
    // ⚠⚠ **`hpNoRoll` 的第二个宿主**（第一个是第二十三批的球状守卫者）：`Monster::initHp`
    //   给它的是 `curHp = monsterHpRange[id][0][0];`，**连 `setRandomHp` 都不调**
    //   （MonsterSpecific.cpp:119-124）。写成「上下界相同的普通怪」会多掷一次 monsterHpRng，
    //   此后每一次取值整体错位。⚠ 反例就在隔壁：守卫者的 `{240,240}` 照样掷一次。
    hpNoRoll: true,
    // ⚠ 它**没有** preBattleAction（switch 里没有 `THE_MAW`）。
    moves: [
      {
        // 咆哮：两句**裸的** `bc.player.debuff<...>(asc17 ? 5 : 3, true)`
        //（MonsterSpecific.cpp:1448-1449），与尖塔增生的缠绕同族 → `sync: true`。
        // ⚠ 这里**显式**传了第二个实参 `true`（`isSourceMonster`），所以虚弱与脆弱都走
        //   justApplied：**施加的那个回合末不递减**。
        // ⚠ 顺序照抄：先虚弱、后脆弱。
        id: "maw_roar",
        name: "咆哮",
        effects: [
          {
            kind: "apply_power",
            power: "weak",
            amount: 3,
            on: "target",
            sync: true,
            ascAmount: [{ atLeast: 17, amount: 5 }],
          },
          {
            kind: "apply_power",
            power: "frail",
            amount: 3,
            on: "target",
            sync: true,
            ascAmount: [{ atLeast: 17, amount: 5 }],
          },
        ],
        intent: "debuff",
      },
      {
        // 流涎：`buff<MS::STRENGTH>(asc17 ? 5 : 3);`（MonsterSpecific.cpp:1435）——
        // **同步**的自身 buff（`on: "self"` 省略 `sync` 即同步，与参考一致）。
        // ⚠ 旧近似表**根本没有这一招**（只列了咆哮 / 重击 / 吞噬），本批补上。
        //   它由吞噬的收尾 `setMove(THE_MAW_DROOL)` 强制排定，见 `MOVE_TURN_END`。
        id: "maw_drool",
        name: "流涎",
        effects: [
          {
            kind: "apply_power",
            power: "strength",
            amount: 3,
            on: "self",
            ascAmount: [{ atLeast: 17, amount: 5 }],
          },
        ],
        intent: "buff",
      },
      {
        // 重击：`attackPlayerHelper(bc, asc2 ? 30 : 25)`（MonsterSpecific.cpp:1455）。
        // 收尾是裸的 `addToBot(Actions::RollMove(idx))`，即默认值。
        id: "maw_slam",
        name: "重击",
        effects: [{ kind: "deal_damage", amount: 25, ascAmount: [{ atLeast: 2, amount: 30 }] }],
        intent: "attack",
      },
      {
        // 吞噬：`const auto t = (bc.getMonsterTurnNumber() + 1) / 2;
        //        attackPlayerHelper(bc, 5, t);`（MonsterSpecific.cpp:1440-1441）。
        // ⚠⚠ **段数由回合数算出来**，是本项目第一条这样的多段攻击（`times:
        //   "monsterTurnHalf"`）：1,1,2,2,3,3,… 随怪物回合单调不减。
        // ⚠ 每击伤害是**裸的 5**，参考那里一个 `asc? :` 都没有——别按邻居补分档。
        // ⚠ 旧近似表写死 3 段，与参考无关。
        id: "maw_nom",
        name: "吞噬",
        effects: [{ kind: "deal_damage_multi", amount: 5, times: "monsterTurnHalf" }],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.the_maw`（MonsterSpecific.cpp:3035-3049）。
    // 四条 case 的收尾**三种形态并存**，见 `MOVE_TURN_END`。
    // 旧近似表那份 `scripted: ["maw_roar"] + 50/50` 与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
  // 蠕动血块（第三十五批按参考逐位校准）。
  {
    id: "writhing_mass",
    name: "蠕动之物",
    // MonsterIds.h:216 `{{160,160},{175,175}}`；`setRandomHp(hpRng, asc >= 7)`
    //（MonsterSpecific.cpp:72-74，与史莱姆 / 食蛇草 / 尖塔增生同一组 case）。
    // ⚠ **两组**，不是一个区间；走普通的 `setRandomHp`（掷一次），上下界相同**照样掷**。
    hpMin: 160,
    hpMax: 160,
    // preBattleAction 见 sts-combat.ts 的 `PRE_BATTLE_ACTION.writhing_mass`：
    //   `setHasStatus<REACTIVE>(true); setStatus<REACTIVE>(0); buff<MALLEABLE>(3);`
    // ⚠ 它是**全参考项目唯一同时带易塑与反应的怪**，也正因为如此，
    //   `attackedUnblockedHelper` 那一格（两者共用）的形状只有它能钉住。
    moves: [
      {
        // 重抽：`attackPlayerHelper(bc, asc2 ? 38 : 32)`（MonsterSpecific.cpp:1555）。
        id: "wm_strong_strike",
        name: "重抽",
        effects: [{ kind: "deal_damage", amount: 32, ascAmount: [{ atLeast: 2, amount: 38 }] }],
        intent: "attack",
      },
      {
        // 乱抽：`attackPlayerHelper(bc, asc2 ? 9 : 7, 3)`（MonsterSpecific.cpp:1550）。
        // ⚠ 段数是第二个实参、**恒 3**；`asc? :` 落在每击伤害上（见 `ascTimes` 的对照）。
        id: "wm_multi_strike",
        name: "乱抽",
        effects: [
          {
            kind: "deal_damage_multi",
            amount: 7,
            times: 3,
            ascAmount: [{ atLeast: 2, amount: 9 }],
          },
        ],
        intent: "attack",
      },
      {
        // 挥击：`attackPlayerHelper(bc, asc2 ? 16 : 15)`
        //     + `addToBot(Actions::MonsterGainBlock(idx, asc2 ? 18 : 16))`
        //（MonsterSpecific.cpp:1534-1536）。
        // ⚠ 两个数**各有各的分档**（15/16 与 16/18），别当成同一个数。
        // ⚠ 格挡是 `addToBot`（省略 `sync` 即入队），与颚虫的猛击同族——所以它排在
        //   本次攻击**之后**结算，触发它的那一击不被自己挡下。
        // ⚠ 旧近似表只有伤害 15、**漏了格挡**，本批补上。
        id: "wm_flail",
        name: "挥击",
        effects: [
          { kind: "deal_damage", amount: 15, ascAmount: [{ atLeast: 2, amount: 16 }] },
          { kind: "gain_block", amount: 16, ascAmount: [{ atLeast: 2, amount: 18 }] },
        ],
        intent: "attack",
      },
      {
        // 萎缩：`attackPlayerHelper(bc, asc2 ? 12 : 10)`
        //     + `addToBot(Actions::DebuffPlayer<PS::WEAK>(2, true))`
        //     + `addToBot(Actions::DebuffPlayer<PS::VULNERABLE>(2, true))`
        //（MonsterSpecific.cpp:1560-1564）。
        // ⚠ 三处照抄：① 伤害带 asc2 分档（10 → 12），旧近似表写死 10；
        //   ② **两条减益都是入队的**（省略 `sync`），顺序是先虚弱、后易伤；
        //   ③ 旧近似表**漏了易伤**那一条。
        // ⚠⚠ 它走 `attackPlayerHelper` 却**不在**参考的 `isMoveAttack` 白名单里
        //   （MonsterMoves.h:527-529 只收挥击 / 乱抽 / 重抽）。这与第三十二批爆破怪那条
        //   正好是同一判据的两个方向，疑似参考笔误——**照抄参考、不打补丁**，
        //   见 TODOS「待裁定」。
        id: "wm_wither",
        name: "萎缩",
        effects: [
          { kind: "deal_damage", amount: 10, ascAmount: [{ atLeast: 2, amount: 12 }] },
          { kind: "apply_power", power: "weak", amount: 2, on: "target" },
          { kind: "apply_power", power: "vulnerable", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
      {
        // 植入（MonsterSpecific.cpp:1540-1547）：
        //     miscInfo = true;
        //     if (!bc.player.hasRelic<R::OMAMORI>()) {
        //         if (bc.player.hasRelic<R::DARKSTONE_PERIAPT>()) { bc.player.increaseMaxHp(6); }
        //     }
        //     rollMove(bc);
        // ⚠ 参考**不建模那张寄生虫诅咒**（真实游戏是往牌组里塞一张，属于 run 层），
        //   战斗内只剩「标记已植入」这一句 + 两个遗物的副作用。
        // ⚠ 两个遗物（御守 / 暗石护符）**都不在 harness 的八个轮换里**，所以那一支
        //   结构性不可达，留 TODO 不实现（同贤者之石那一族）。见 sts-combat.ts。
        // ⚠ 收尾是**同步的真 `rollMove`**（第六形态），不是 `addToBot(RollMove)`——
        //   而且必须排在 `miscInfo = true` **之后**，否则出招规则会再选一次植入。
        // ⚠ 旧近似表**根本没有这一招**（只列了四条攻击），本批补上。
        id: "wm_implant",
        name: "植入",
        effects: [{ kind: "set_misc_info", amount: 1 }],
        intent: "debuff",
      },
    ],
    // 出招规则见 sts-combat.ts 的 `MOVE_RULES.writhing_mass`（MonsterSpecific.cpp:3119-3202）。
    // 旧近似表那份加权（30/20/25/25）与参考完全不同，本批弃用。
    intentRule: { scripted: [], weighted: [] },
  },
];

/**
 * 全部敌人定义（与 `ALL_EVENTS` 同族的只读视图）。
 *
 * 用途是让数据表测试能做**全表**断言而不是抽查——例如「只有 `initHp` 里那条不掷 RNG 的怪
 * 才带 `hpNoRoll`」：抽查放过一个写错的条目就会让 monsterHpRng 整体错位。
 */
export const ALL_ENEMIES: readonly EnemyDef[] = ENEMY_LIST;

const ENEMY_MAP: ReadonlyMap<string, EnemyDef> = new Map(
  ENEMY_LIST.map((enemy) => [enemy.id, enemy]),
);

export function getEnemyDef(id: string): EnemyDef {
  const def = ENEMY_MAP.get(id);
  if (!def) {
    throw new Error(`未知敌人 id: ${id}`);
  }
  return def;
}

/** 敌人组：一个战斗节点里出现的一到多个敌人。 */
export type EncounterDef = { id: string; enemies: string[]; isBoss: boolean };

const ENCOUNTERS: Record<string, EncounterDef> = {
  cultist: { id: "cultist", enemies: ["cultist"], isBoss: false },
  jaw_worm: { id: "jaw_worm", enemies: ["jaw_worm"], isBoss: false },
  two_louse: { id: "two_louse", enemies: ["louse", "louse"], isBoss: false },
  // 小史莱姆组（游戏级）：成员在**战斗开始时**由 miscRng 掷定，见 sts-combat.ts 的
  // `ENCOUNTER_BUILDERS.small_slimes`（对齐 MonsterGroup.cpp:126）。
  // 这里的 `enemies` 只是占位——有 builder 时 `initCombat` 根本不读它。
  small_slimes: {
    id: "small_slimes",
    enemies: ["spike_slime_s", "acid_slime_m"],
    isBoss: false,
  },
  // ⚠ 下面两个是**旧的近似实现**留下的静态展开（run 层 `pickEncounter` 用玩具 rng 50/50
  // 选一个）。游戏级的编队 id 是上面的 `small_slimes`，接 `sts-encounters`（TODOS 一.4）
  // 时这两个应当一并删掉。
  small_slimes_a: {
    id: "small_slimes_a",
    enemies: ["spike_slime_s", "acid_slime_m"],
    isBoss: false,
  },
  small_slimes_b: {
    id: "small_slimes_b",
    enemies: ["acid_slime_s", "spike_slime_m"],
    isBoss: false,
  },
  three_louse: { id: "three_louse", enemies: ["louse", "louse", "louse"], isBoss: false },
  blue_slaver: { id: "blue_slaver", enemies: ["blue_slaver"], isBoss: false },
  // 史莱姆群：成员集合固定（3 尖刺小 + 2 酸液小），但**出场顺序**由 miscRng 的 5 次抽样
  // 掷定，见 sts-combat.ts 的 `ENCOUNTER_BUILDERS.lots_of_slimes`（对齐 MonsterGroup.cpp:137）。
  // 这里的 `enemies` 只是占位——有 builder 时 `initCombat` 根本不读它。
  lots_of_slimes: {
    id: "lots_of_slimes",
    enemies: ["spike_slime_s", "spike_slime_s", "spike_slime_s", "acid_slime_s", "acid_slime_s"],
    isBoss: false,
  },
  gremlin_nob: { id: "gremlin_nob", enemies: ["gremlin_nob"], isBoss: false },
  lagavulin: { id: "lagavulin", enemies: ["lagavulin"], isBoss: false },
  three_sentries: { id: "three_sentries", enemies: ["sentry", "sentry", "sentry"], isBoss: false },
  // 大史莱姆（游戏级）：种类在**战斗开始时**由一次 miscRng.randomBoolean 掷定，见
  // sts-combat.ts 的 `ENCOUNTER_BUILDERS.large_slime`（对齐 MonsterGroup.cpp:157）。
  // 这里的 `enemies` 只是占位——有 builder 时 `initCombat` 根本不读它。
  large_slime: { id: "large_slime", enemies: ["acid_slime_l"], isBoss: false },
  // ⚠ 下面两个是**旧的近似实现**留下的静态展开（run 层 `pickEncounter` 用玩具 rng 50/50
  // 选一个），与上面的 `small_slimes_a/b` 同族。游戏级的编队 id 是上面的 `large_slime`，
  // 接 `sts-encounters`（TODOS 一.4）时这两个应当一并删掉。
  large_slime_acid: { id: "large_slime_acid", enemies: ["acid_slime_l"], isBoss: false },
  large_slime_spike: { id: "large_slime_spike", enemies: ["spike_slime_l"], isBoss: false },
  two_fungi_beasts: {
    id: "two_fungi_beasts",
    enemies: ["fungi_beast", "fungi_beast"],
    isBoss: false,
  },
  // 地精帮：固定代表性 4 只（含护盾/巫师/狂暴，展示各机制；StS 为随机组成）。
  gremlin_gang: {
    id: "gremlin_gang",
    enemies: ["mad_gremlin", "sneaky_gremlin", "shield_gremlin", "gremlin_wizard"],
    isBoss: false,
  },
  looter: { id: "looter", enemies: ["looter"], isBoss: false },
  red_slaver: { id: "red_slaver", enemies: ["red_slaver"], isBoss: false },
  // 恶棍二人组：一只「弱野生动物」+ 一只「强人形」，两只都是**先把候选全部造出来再挑一个**
  // （`createWeakWildlife` / `createStrongHumanoid`，MonsterGroup.cpp:477/:497），
  // 见 sts-combat.ts 的 `ENCOUNTER_BUILDERS.exordium_thugs`。
  // 这里的 `enemies` 只是占位——有 builder 时 `initCombat` 根本不读它。
  exordium_thugs: {
    id: "exordium_thugs",
    enemies: ["acid_slime_m", "looter"],
    isBoss: false,
  },
  // 荒野二人组：一只「强野生动物」+ 一只「弱野生动物」，同样是「先把候选全部造出来再挑一个」
  // （`createStrongWildlife` / `createWeakWildlife`，MonsterGroup.cpp:487/:497）。
  // ⚠ 顺序与恶棍二人组**相反**：这里是先 strong 后 weak（MonsterGroup.cpp:168-170）。
  // 见 sts-combat.ts 的 `ENCOUNTER_BUILDERS.exordium_wildlife`。
  // 这里的 `enemies` 只是占位——有 builder 时 `initCombat` 根本不读它。
  exordium_wildlife: {
    id: "exordium_wildlife",
    enemies: ["fungi_beast", "acid_slime_m"],
    isBoss: false,
  },
  // 第二幕
  snake_plant: { id: "snake_plant", enemies: ["snake_plant"], isBoss: false },
  spheric_guardian: { id: "spheric_guardian", enemies: ["spheric_guardian"], isBoss: false },
  centurion: { id: "centurion", enemies: ["centurion"], isBoss: false },
  two_centurions: { id: "two_centurions", enemies: ["centurion", "centurion"], isBoss: false },
  // ⚠ 编队 id 是 `shell_parasite`（**没有 ED**），怪物 id 才是 `shelled_parasite`——
  //   参考的枚举就是这么不对称的：`MonsterEncounter::SHELL_PARASITE` 建的是
  //   `MonsterId::SHELLED_PARASITE`（MonsterGroup.cpp:352-354）。第二十五批把我们这边
  //   原先的 `shelled_parasite` 改成了参考的名字：trace 文件名由参考枚举名小写而来
  //   （`split-traces.mjs`），而 `sts-combat-wiring.test.ts` 要求
  //   `SUPPORTED_ENCOUNTERS` 与文件名一一对应，不改就装不上。
  shell_parasite: { id: "shell_parasite", enemies: ["shelled_parasite"], isBoss: false },
  chosen: { id: "chosen", enemies: ["chosen"], isBoss: false },
  snecko: { id: "snecko", enemies: ["snecko"], isBoss: false },
  // 百夫长 + 秘法师：秘法师治疗 / 鼓舞百夫长，百夫长给秘法师加格挡。
  // ⚠ 编队 id 用的是**参考的枚举名** `CENTURION_AND_HEALER`（不是 `centurion_mystic`）：
  //   trace 文件名由参考枚举名小写而来（`split-traces.mjs`），而
  //   `sts-combat-wiring.test.ts` 要求 `SUPPORTED_ENCOUNTERS` 与文件名一一对应。
  //   第二十六批把原先的 `centurion_mystic` 改成了这个名字，与第二十五批那次
  //   `shelled_parasite` → `shell_parasite` 同因。
  // ⚠ **建怪顺序有语义**：百夫长在 0 号位、秘法师在 1 号位（MonsterGroup.cpp:193-196）。
  //   百夫长的防守写死给 `arr[1]`、秘法师的治疗与鼓舞写死给 `arr[0]`，换个顺序两招全打空。
  centurion_and_healer: {
    id: "centurion_and_healer",
    enemies: ["centurion", "mystic"],
    isBoss: false,
  },
  book_of_stabbing: { id: "book_of_stabbing", enemies: ["book_of_stabbing"], isBoss: false },
  // 地精首领（第二幕精英，第二十七批）：两只**随机**小鬼在 1/2 号位、首领在 3 号位，
  // 而 0 号位是**开局预留的空位**（`monsterCount = 4` / `monstersAlive = 3`，
  // MonsterGroup.cpp:248-259）。
  // ⚠ 这里的 `enemies` 只是给旧近似战斗用的占位——成员由 `miscRng` 掷定，
  //   真相在 `ENCOUNTER_BUILDERS.gremlin_leader`（与史莱姆组 / 地精帮同理）。
  gremlin_leader: {
    id: "gremlin_leader",
    enemies: ["mad_gremlin", "gremlin_leader", "sneaky_gremlin"],
    isBoss: false,
  },
  // 奴隶主小队（第二幕精英，第二十七批）：**蓝奴隶主 / 工头 / 红奴隶主**
  //（MonsterGroup.cpp:366-370）。
  // ⚠⚠ **顺序是承重的，工头在中间。** 第二十七批之前这里写的是
  //   `["taskmaster","blue_slaver","red_slaver"]`——照抄了旧近似表，与参考不符。
  //   下标错了不只是快照顺序错：`getRandomMonsterIdx`、群伤的遍历顺序、
  //   harness 策略打的「最左侧活怪」全都跟着变。
  slavers: { id: "slavers", enemies: ["blue_slaver", "taskmaster", "red_slaver"], isBoss: false },
  // —— 事件触发的战斗遭遇 ——
  // 斗兽场：工头 + 地精头目，事件触发的硬仗（胜利发遗物）。
  colosseum: { id: "colosseum", enemies: ["taskmaster", "gremlin_nob"], isBoss: false },
  // 蒙面强盗：3 名劫掠者（会偷金币、烟雾弹逃跑）。
  masked_bandits: { id: "masked_bandits", enemies: ["mugger", "mugger", "looter"], isBoss: false },
  // 神秘球：2 只暗球游荡者（事件触发，胜利发遗物）。
  mysterious_sphere: {
    id: "mysterious_sphere",
    enemies: ["orb_walker", "orb_walker"],
    isBoss: false,
  },
  // —— 第二幕组合遭遇（既有敌人拼装）——
  // 邪教徒 + 选民（MonsterGroup.cpp:230-233）：邪教徒 0 号位、选民 1 号位。
  cultist_and_chosen: {
    id: "cultist_and_chosen",
    enemies: ["cultist", "chosen"],
    isBoss: false,
  },
  // 三邪教徒（MonsterGroup.cpp:412-416）。
  // ⚠ id 是 `three_cultist`（**单数**）——参考的枚举就是 `MonsterEncounter::THREE_CULTIST`，
  //   与 `THREE_BYRDS` / `THREE_SENTRIES` 那种复数不一致，但 trace 文件名跟着枚举名走。
  //   第二十六批把原先的 `three_cultists` 改成了这个名字。
  three_cultist: {
    id: "three_cultist",
    enemies: ["cultist", "cultist", "cultist"],
    isBoss: false,
  },
  shelled_parasite_and_fungi: {
    id: "shelled_parasite_and_fungi",
    enemies: ["shelled_parasite", "fungi_beast"],
    isBoss: false,
  },
  // 哨卫 + 球状守卫者（MonsterGroup.cpp:347-350）：**只有两只**，哨卫 0 号位。
  // ⚠ 第二十六批修正：原先写的是 `["sentry", "spheric_guardian", "sentry"]`（三只、哨卫夹
  //   球卫），那是凭印象写的。参考就是两句 `createMonster`，多一只会让 monsterHpRng 多掷
  //   一次、整条流错位。
  // ⚠ 哨卫的首招按**自己的下标**定（`idx % 2 == 0` 出射钉），所以「哨卫在 0 号位」是有
  //   语义的：这里它固定先出射钉。
  sentry_and_sphere: {
    id: "sentry_and_sphere",
    enemies: ["sentry", "spheric_guardian"],
    isBoss: false,
  },
  // —— 第三幕组合遭遇（形状怪：爆破怪 / 斥力怪 / 尖刺客，第三十二批）——
  //
  // ⚠ 这三条的 `enemies` 只是旧近似战斗的占位（成员由 miscRng 掷定，静态列表表达不了），
  //   真相在 sts-combat.ts 的 `ENCOUNTER_BUILDERS`：
  //     `three_shapes` / `four_shapes` → `createShapes(bc, 3 / 4)`，**6 项池、不放回**
  //       （MonsterGroup.cpp:437-439 / :240-242 / :508-530）；
  //     `sphere_and_two_shapes`        → 两次 `getAncientShape(bc.miscRng)` + 球状守卫者，
  //       **3 项表、有放回**（MonsterGroup.cpp:384-388 / :532-539）。
  // ⚠ 两条路径的候选表**项数、重复度、书写顺序全都不同**，照搬彼此必错。
  three_shapes: {
    id: "three_shapes",
    enemies: ["spiker", "exploder", "repulsor"],
    isBoss: false,
  },
  four_shapes: {
    id: "four_shapes",
    enemies: ["spiker", "exploder", "repulsor", "exploder"],
    isBoss: false,
  },
  // ⚠ 球状守卫者排在**最后**（2 号位），两只形状怪在 0 / 1 号位——参考的三句就是这个顺序。
  sphere_and_two_shapes: {
    id: "sphere_and_two_shapes",
    enemies: ["exploder", "spheric_guardian", "repulsor"],
    isBoss: false,
  },
  jaw_worm_horde: {
    id: "jaw_worm_horde",
    enemies: ["jaw_worm", "jaw_worm", "jaw_worm"],
    isBoss: false,
  },
  // —— 新敌人遭遇 ——
  // 三拜鸟：对齐 MonsterGroup.cpp:406-410（三次 `createMonster(BYRD)`，无 RNG 特例）。
  three_byrds: { id: "three_byrds", enemies: ["byrd", "byrd", "byrd"], isBoss: false },
  // 选民与拜鸟：⚠⚠ **参考只造一只拜鸟**，而且**拜鸟在前**
  //（MonsterGroup.cpp:221-224：`createMonster(BYRD); createMonster(CHOSEN);`）。
  // 第二十四批把这里从旧近似表的 `["chosen","byrd","byrd"]` 改成参考的形状——顺序错了
  // 建怪的 monsterHpRng 取值就整体错位，只数一数怪的种类是发现不了的。
  // ⚠ 编队名是复数（Byrd**s**），真实游戏那一场大概率是三只鸟 + 选民，所以这**可能**是
  //   参考的笔误。但「到底几只」在参考里读不出来（判据③「修法唯一」不成立），
  //   **本批不打补丁、照抄参考**，并记进 TODOS 的「已确认但尚未打补丁」。
  chosen_and_byrds: {
    id: "chosen_and_byrds",
    enemies: ["byrd", "chosen"],
    isBoss: false,
  },
  // 二盗贼：⚠ 是**抢劫者 + 劫匪**，不是两只劫匪
  //（MonsterGroup.cpp:460-463：`createMonster(LOOTER); createMonster(MUGGER);`）。
  // 旧近似表写的 `["mugger","mugger"]` 与参考不符，第二十四批改正。
  two_thieves: { id: "two_thieves", enemies: ["looter", "mugger"], isBoss: false },
  // 三暗影客（MonsterGroup.cpp:418-421）：三只固定的暗影客，不掷任何 miscRng。
  // ⚠ 它是**唯一**同时出现在第三幕「弱」池与「强」池里的编队（MonsterEncounters.h:162 / :174）。
  three_darklings: {
    id: "three_darklings",
    enemies: ["darkling", "darkling", "darkling"],
    isBoss: false,
  },
  // 尖塔增生（MonsterGroup.cpp:380-382）：单怪。
  spire_growth: { id: "spire_growth", enemies: ["spire_growth"], isBoss: false },
  // ⚠ 第三十三批把它从 `the_maw` 改名成 `maw`：编队 id 必须与参考的
  //   `MonsterEncounter::MAW` 同名（trace 文件名就是它，`SUPPORTED_ENCOUNTERS` 与
  //   wiring 测试按文件名双向对齐）。**怪**的 id 仍然是 `the_maw`
  //   （对齐 `MonsterId::THE_MAW`）。同族的先例：第二十五批 `shell_parasite`、
  //   第二十八批 `automaton`、第二十九批 `collector`。
  maw: { id: "maw", enemies: ["the_maw"], isBoss: false },
  writhing_mass: { id: "writhing_mass", enemies: ["writhing_mass"], isBoss: false },
  champ: { id: "champ", enemies: ["champ"], isBoss: true },
  // ⚠ 第二十八批把它从 `bronze_automaton` 改名成 `automaton`：编队 id 必须与参考的
  //   `MonsterEncounter::AUTOMATON` 同名（trace 文件名就是它，`SUPPORTED_ENCOUNTERS`
  //   与 wiring 测试按文件名双向对齐）。**怪**的 id 仍然是 `bronze_automaton`
  //   （对齐 `MonsterId::BRONZE_AUTOMATON`）——编队与怪同名只是别的编队的巧合。
  //   同族的先例：第十九批 `guardian`→`the_guardian`、第二十五批 `shell_parasite`。
  automaton: { id: "automaton", enemies: ["bronze_automaton"], isBoss: true },
  // ⚠ 第二十九批把它从 `the_collector` 改名成 `collector`：编队 id 必须与参考的
  //   `MonsterEncounter::COLLECTOR` 同名（trace 文件名就是它，`SUPPORTED_ENCOUNTERS`
  //   与 wiring 测试按文件名双向对齐）。**怪**的 id 仍然是 `the_collector`
  //   （对齐 `MonsterId::THE_COLLECTOR`）。同族的先例：第二十五批 `shell_parasite`、
  //   第二十八批 `automaton`。
  // ⚠ `enemies` 这一栏只是旧近似战斗的占位——真相在 `ENCOUNTER_BUILDERS.collector`：
  //   参考写的是 `monsterCount = 2; createMonster(THE_COLLECTOR);`（MonsterGroup.cpp:198-201），
  //   所以 0 号位与 1 号位都是**预留空位**、收藏家在**2 号位**。
  collector: { id: "collector", enemies: ["the_collector"], isBoss: true },
  // 第三幕
  exploder: { id: "exploder", enemies: ["exploder"], isBoss: false },
  spiker: { id: "spiker", enemies: ["spiker"], isBoss: false },
  orb_walker: { id: "orb_walker", enemies: ["orb_walker"], isBoss: false },
  two_exploders: { id: "two_exploders", enemies: ["exploder", "exploder"], isBoss: false },
  reptomancer: { id: "reptomancer", enemies: ["reptomancer"], isBoss: false },
  donu_deca: { id: "donu_deca", enemies: ["deca", "donu"], isBoss: true },
  repulsor: { id: "repulsor", enemies: ["repulsor"], isBoss: false },
  // 复形怪（MonsterGroup.cpp:445-447）：单怪。
  transient: { id: "transient", enemies: ["transient"], isBoss: false },
  two_orb_walkers: { id: "two_orb_walkers", enemies: ["orb_walker", "orb_walker"], isBoss: false },
  giant_head: { id: "giant_head", enemies: ["giant_head"], isBoss: false },
  // 觉醒者（MonsterGroup.cpp:179-184，第三十七批）：**三只**——两只邪教徒 + 觉醒者，
  // 而且觉醒者在 **2 号位**（最后一格）。
  // ⚠ 旧近似表写的是单怪，那是错的：邪教徒每回合 +3 力量的仪式正是这场仗的时间压力来源，
  //   而觉醒者排在最后一格意味着 harness 默认的 `firstAliveMonster` 会先啃两只邪教徒。
  awakened_one: {
    id: "awakened_one",
    enemies: ["cultist", "cultist", "awakened_one"],
    isBoss: true,
  },
  time_eater: { id: "time_eater", enemies: ["time_eater"], isBoss: true },
  nemesis: { id: "nemesis", enemies: ["nemesis"], isBoss: false },
  // ⚠ 第十九批把它从 `guardian` 改名成 `the_guardian`：编队 id 必须与参考的
  //   `MonsterEncounter::THE_GUARDIAN` 同名（trace 文件名就是它，`SUPPORTED_ENCOUNTERS`
  //   与 `test/golden/traces/*.jsonl` 是双向对齐的）。
  the_guardian: { id: "the_guardian", enemies: ["the_guardian"], isBoss: true },
  hexaghost: { id: "hexaghost", enemies: ["hexaghost"], isBoss: true },
  slime_boss: { id: "slime_boss", enemies: ["slime_boss"], isBoss: true },
};

export function getEncounterDef(id: string): EncounterDef {
  const def = ENCOUNTERS[id];
  if (!def) {
    throw new Error(`未知敌人组 id: ${id}`);
  }
  return def;
}

// === Act1 普通战斗池（复刻 StS：前 WEAK_COMBAT_COUNT 场抽 weak 池，其余抽 strong 池）===
//
// 权重对齐 sts_lightspeed（MonsterEncounters.h，asc0）。
// weak 池四组各 25%。strong 池原表分母 16，此处只含**已实现怪物**的子集
// （blue_slaver 2 : three_louse 2 : lots_of_slimes 1，保留原相对权重）；
// gremlin_gang / red_slaver / looter / large_slime / fungi / exordium 待其怪物在后续里程碑加入。

type WeightedEncounter = { id: string; weight: number };

const WEAK_COMBAT_COUNT = 3;

const WEAK_ENCOUNTER_POOL: readonly WeightedEncounter[] = [
  { id: "cultist", weight: 1 },
  { id: "jaw_worm", weight: 1 },
  { id: "two_louse", weight: 1 },
  { id: "small_slimes", weight: 1 }, // 选中后再 50/50 展开为 _a / _b 两种组成
];

const STRONG_ENCOUNTER_POOL: readonly WeightedEncounter[] = [
  { id: "blue_slaver", weight: 2 },
  { id: "three_louse", weight: 2 },
  { id: "large_slime", weight: 2 }, // 选中后 50/50 展开为 酸液大 / 尖刺大
  { id: "two_fungi_beasts", weight: 2 },
  { id: "looter", weight: 2 },
  { id: "gremlin_gang", weight: 1 },
  { id: "red_slaver", weight: 1 },
  { id: "lots_of_slimes", weight: 1 },
];

function weightedPick(rng: RngState, pool: readonly WeightedEncounter[]): string {
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = nextFloat(rng) * total;
  for (const entry of pool) {
    roll -= entry.weight;
    if (roll < 0) {
      return entry.id;
    }
  }
  return pool[pool.length - 1].id;
}

// —— 第二幕（城市）战斗池（切片：3 普通 + 1 精英 + 1 Boss；后续里程碑补齐 6 火之灵/自动机/收藏家等）——
const ACT2_WEAK_POOL: readonly WeightedEncounter[] = [
  { id: "spheric_guardian", weight: 1 },
  { id: "snake_plant", weight: 1 },
  { id: "centurion", weight: 1 },
  { id: "shell_parasite", weight: 1 },
  { id: "chosen", weight: 1 },
  { id: "three_byrds", weight: 1 },
];

const ACT2_STRONG_POOL: readonly WeightedEncounter[] = [
  { id: "chosen", weight: 2 },
  { id: "snecko", weight: 2 },
  { id: "centurion_and_healer", weight: 2 },
  { id: "shell_parasite", weight: 2 },
  { id: "snake_plant", weight: 1 },
  { id: "two_centurions", weight: 1 },
  { id: "spheric_guardian", weight: 1 },
  { id: "cultist_and_chosen", weight: 1 },
  { id: "three_cultist", weight: 1 },
  { id: "shelled_parasite_and_fungi", weight: 1 },
  { id: "sentry_and_sphere", weight: 1 },
  { id: "chosen_and_byrds", weight: 1 },
  { id: "two_thieves", weight: 1 },
];

// —— 第三幕（超越）战斗池（切片）——
const ACT3_WEAK_POOL: readonly WeightedEncounter[] = [
  { id: "spiker", weight: 1 },
  { id: "orb_walker", weight: 1 },
  { id: "exploder", weight: 1 },
  { id: "repulsor", weight: 1 },
];

const ACT3_STRONG_POOL: readonly WeightedEncounter[] = [
  { id: "orb_walker", weight: 2 },
  { id: "spiker", weight: 2 },
  { id: "transient", weight: 2 },
  { id: "repulsor", weight: 1 },
  { id: "two_exploders", weight: 1 },
  { id: "two_orb_walkers", weight: 1 },
  { id: "three_shapes", weight: 2 },
  { id: "four_shapes", weight: 1 },
  { id: "sphere_and_two_shapes", weight: 1 },
  { id: "jaw_worm_horde", weight: 1 },
  { id: "three_darklings", weight: 2 },
  { id: "spire_growth", weight: 1 },
  { id: "maw", weight: 1 },
  { id: "writhing_mass", weight: 1 },
];

function actWeakPool(act: number): readonly WeightedEncounter[] {
  if (act >= 3) return ACT3_WEAK_POOL;
  if (act >= 2) return ACT2_WEAK_POOL;
  return WEAK_ENCOUNTER_POOL;
}
function actStrongPool(act: number): readonly WeightedEncounter[] {
  if (act >= 3) return ACT3_STRONG_POOL;
  if (act >= 2) return ACT2_STRONG_POOL;
  return STRONG_ENCOUNTER_POOL;
}

/** 按已进入的普通战斗数选池 + 加权随机挑一个 encounter id（按幕选池）。 */
export function pickNormalEncounter(rng: RngState, combatsEntered: number, act = 1): string {
  const pool = combatsEntered < WEAK_COMBAT_COUNT ? actWeakPool(act) : actStrongPool(act);
  const picked = weightedPick(rng, pool);
  if (picked === "small_slimes") {
    // 小史莱姆组的两种组成 50/50。
    return nextFloat(rng) < 0.5 ? "small_slimes_a" : "small_slimes_b";
  }
  if (picked === "large_slime") {
    // 大史莱姆 50/50 酸液 / 尖刺。
    return nextFloat(rng) < 0.5 ? "large_slime_acid" : "large_slime_spike";
  }
  return picked;
}

// Act1 精英池（等权重，不重复限制由 StS 的洗牌保证；此处简化为等权随机）。
const ELITE_ENCOUNTER_POOL: readonly WeightedEncounter[] = [
  { id: "gremlin_nob", weight: 1 },
  { id: "lagavulin", weight: 1 },
  { id: "three_sentries", weight: 1 },
];

// Act2 精英池：穿刺之书 / 地精首领 / 奴隶主小队。
const ACT2_ELITE_POOL: readonly WeightedEncounter[] = [
  { id: "book_of_stabbing", weight: 1 },
  { id: "gremlin_leader", weight: 1 },
  { id: "slavers", weight: 1 },
];

// Act3 精英池（切片：蛇法师；后续补 巨型头颅 / 复仇者）。
const ACT3_ELITE_POOL: readonly WeightedEncounter[] = [
  { id: "reptomancer", weight: 1 },
  { id: "giant_head", weight: 1 },
  { id: "nemesis", weight: 1 },
];

/** 精英节点：从精英池挑一个 encounter id（按幕选池）。 */
export function pickEliteEncounter(rng: RngState, act = 1): string {
  if (act >= 3) return weightedPick(rng, ACT3_ELITE_POOL);
  return weightedPick(rng, act >= 2 ? ACT2_ELITE_POOL : ELITE_ENCOUNTER_POOL);
}

// Act1 Boss 池（等权重随机）。
const BOSS_ENCOUNTER_POOL: readonly WeightedEncounter[] = [
  { id: "the_guardian", weight: 1 },
  { id: "hexaghost", weight: 1 },
  { id: "slime_boss", weight: 1 },
];

// Act2 Boss 池：冠军 / 青铜自动机 / 收藏家（三个都已登记，第二十九批收官）。
const ACT2_BOSS_POOL: readonly WeightedEncounter[] = [
  { id: "champ", weight: 1 },
  { id: "automaton", weight: 1 },
  { id: "collector", weight: 1 },
];

// Act3 Boss 池（切片：铎努与迪卡；后续补 觉醒者 / 时间吞噬者）。
const ACT3_BOSS_POOL: readonly WeightedEncounter[] = [
  { id: "donu_deca", weight: 1 },
  { id: "time_eater", weight: 1 },
  { id: "awakened_one", weight: 1 },
];

/** Boss 节点：随机挑一个 Boss encounter id（按幕选池）。 */
export function pickBossEncounter(rng: RngState, act = 1): string {
  if (act >= 3) return weightedPick(rng, ACT3_BOSS_POOL);
  return weightedPick(rng, act >= 2 ? ACT2_BOSS_POOL : BOSS_ENCOUNTER_POOL);
}
