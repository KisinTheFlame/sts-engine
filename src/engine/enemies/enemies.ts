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
    // ⚠ 高档那一组**本批不写**：`ascCalibrated` 没置，asc>0 时 `constructMonster` 直接抛错，
    //   写了也没有预言机看着（同第十八批对地精头目 asc18 出招块的处理）。
    hpMin: 75,
    hpMax: 79,
    moves: [
      {
        // MonsterSpecific.cpp:1131-1134 `attackPlayerHelper(bc, asc2 ? 8 : 7, 3)`。
        // ⚠ **三段**，不是一下 7 点——旧近似表把它写成单段 7，数值与段数都错。
        id: "sp_chomp",
        name: "撕咬",
        effects: [{ kind: "deal_damage_multi", amount: 7, times: 3 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1136-1140：**先脆弱后虚弱**，两条都是 `addToBot(DebuffPlayer)`。
        // ⚠ 顺序照抄（旧表写反了）。两条各 2 层、都带 `isSourceMonster = true`。
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
    moves: [
      {
        // MonsterSpecific.cpp:1166-1170 `addBlock(asc17 ? 35 : 25)`。
        // ⚠ 是**同步**的裸 `addBlock`（同守卫者的蓄能），不是 `addToBot(MonsterGainBlock)`。
        id: "sg_activate",
        name: "激活",
        effects: [{ kind: "gain_block", amount: 25, sync: true }],
        intent: "defend",
      },
      {
        // MonsterSpecific.cpp:1186-1190 `attackPlayerHelper(bc, asc2 ? 11 : 10, 2)`（**两段**）。
        id: "sg_slam",
        name: "猛击",
        effects: [{ kind: "deal_damage_multi", amount: 10, times: 2 }],
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
        id: "sg_harden",
        name: "硬化",
        effects: [
          { kind: "gain_block", amount: 15 },
          { kind: "deal_damage", amount: 10 },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:1172-1177：攻击 + `addToBot(DebuffPlayer<FRAIL>(5, true))`。
        id: "sg_attack_debuff",
        name: "攻击削弱",
        effects: [
          { kind: "deal_damage", amount: 10 },
          { kind: "apply_power", power: "frail", amount: 5, on: "target" },
        ],
        intent: "attack",
      },
    ],
    // 出招规则见 sts-combat.ts 的 MOVE_RULES（恒返回激活，且只被调用一次）。
    intentRule: { scripted: [], weighted: [] },
  },
  {
    id: "centurion",
    name: "百夫长",
    hpMin: 76,
    hpMax: 80,
    moves: [
      {
        id: "cent_slash",
        name: "斩击",
        effects: [{ kind: "deal_damage", amount: 12 }],
        intent: "attack",
      },
      {
        id: "cent_fury",
        name: "狂怒连斩",
        effects: [{ kind: "deal_damage_multi", amount: 6, times: 3 }],
        intent: "attack",
      },
      {
        id: "cent_defend",
        name: "防守",
        effects: [{ kind: "gain_block", amount: 15 }],
        intent: "defend",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "cent_slash", weight: 50, maxInARow: 2 },
        { move: "cent_fury", weight: 25, maxInARow: 1 },
        { move: "cent_defend", weight: 25, maxInARow: 1 },
      ],
    },
  },

  {
    id: "shelled_parasite",
    name: "带壳寄生虫",
    hpMin: 68,
    hpMax: 72,
    moves: [
      {
        id: "double_strike",
        name: "双重打击",
        effects: [{ kind: "deal_damage_multi", amount: 6, times: 2 }],
        intent: "attack",
      },
      {
        id: "suck",
        name: "吸取",
        effects: [
          { kind: "deal_damage", amount: 10 },
          { kind: "heal_self", amount: 10 },
        ],
        intent: "attack",
      },
      {
        id: "fell",
        name: "重击",
        effects: [
          { kind: "deal_damage", amount: 18 },
          { kind: "apply_power", power: "frail", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "double_strike", weight: 45, maxInARow: 2 },
        { move: "fell", weight: 30, maxInARow: 1 },
        { move: "suck", weight: 25, maxInARow: 1 },
      ],
    },
  },
  {
    // —— 第二十三批：选民（第二幕，`CHOSEN` 单怪编队）——
    //
    // ⚠ 它是全项目**唯一**的诅咒（HEX）来源。诅咒本身的效果（玩家每打出一张非攻击牌就洗
    //   一张恍惚进抽牌堆）写在 sts-combat.ts 的三个 `onUseXxxCard` 里，不在这张表。
    id: "chosen",
    name: "选民",
    // MonsterIds.h:163 `{{95,99},{98,103}}`（普通怪阈值 asc>=7，MonsterSpecific.cpp:44）。
    // 高档那一组本批不写，理由同食蛇草。
    hpMin: 95,
    hpMax: 99,
    moves: [
      {
        // MonsterSpecific.cpp:631-634 `attackPlayerHelper(bc, asc2 ? 6 : 5, 2)`（**两段 5**）。
        // ⚠ 旧近似表写的是单段 6，段数与数值都错。
        id: "poke",
        name: "戳刺",
        effects: [{ kind: "deal_damage_multi", amount: 5, times: 2 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:636-639 `attackPlayerHelper(bc, asc2 ? 21 : 18)`。
        id: "zap",
        name: "电击",
        effects: [{ kind: "deal_damage", amount: 18 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:614-618：攻击 10 + `addToBot(DebuffPlayer<VULNERABLE>(2, true))`。
        id: "debilitate",
        name: "削弱",
        effects: [
          { kind: "deal_damage", amount: 10 },
          { kind: "apply_power", power: "vulnerable", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:620-624。⚠ 两句的**写法不同**，照抄不要统一：
        //   虚弱 3 是 `addToBot(DebuffPlayer<WEAK>(3, true))` —— 入队；
        //   力量 3 是同步的 `buff<MS::STRENGTH>(3)`         —— `on: "self"` 恒同步。
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
    id: "snecko",
    name: "史尼克",
    hpMin: 114,
    hpMax: 120,
    moves: [
      {
        id: "snecko_bite",
        name: "撕咬",
        effects: [{ kind: "deal_damage", amount: 15 }],
        intent: "attack",
      },
      {
        id: "tail_whip",
        name: "尾击",
        effects: [
          { kind: "deal_damage", amount: 8 },
          { kind: "apply_power", power: "weak", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "snecko_bite", weight: 60, maxInARow: 2 },
        { move: "tail_whip", weight: 40, maxInARow: 1 },
      ],
    },
  },
  {
    id: "mystic",
    name: "秘法师",
    hpMin: 48,
    hpMax: 56,
    moves: [
      {
        id: "mystic_heal",
        name: "治疗",
        effects: [{ kind: "heal_ally", amount: 16 }],
        intent: "buff",
      },
      {
        id: "mystic_buff",
        name: "鼓舞",
        effects: [{ kind: "apply_power", power: "strength", amount: 2, on: "all_enemies" }],
        intent: "buff",
      },
      {
        id: "mystic_attack",
        name: "法击",
        effects: [{ kind: "deal_damage", amount: 8 }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "mystic_heal", weight: 35, maxInARow: 1 },
        { move: "mystic_buff", weight: 30, maxInARow: 1 },
        { move: "mystic_attack", weight: 35, maxInARow: 2 },
      ],
    },
  },

  // —— 第二幕精英 ——
  {
    id: "gremlin_leader",
    name: "地精首领",
    hpMin: 140,
    hpMax: 148,
    moves: [
      {
        id: "summon_gremlins",
        name: "召唤地精",
        effects: [{ kind: "summon", defIds: ["mad_gremlin", "sneaky_gremlin"] }],
        intent: "unknown",
      },
      {
        id: "encourage",
        name: "鼓舞",
        effects: [{ kind: "apply_power", power: "strength", amount: 3, on: "all_enemies" }],
        intent: "buff",
      },
      {
        id: "gl_stab",
        name: "突刺",
        effects: [{ kind: "deal_damage", amount: 6 }],
        intent: "attack",
      },
    ],
    // 召唤由 sts-combat.ts 的 MOVE_RULES 登记 gremlin_leader（待迁移）（身边地精 <2 则召唤）；否则 鼓舞/突刺。
    intentRule: {
      scripted: [],
      weighted: [
        { move: "encourage", weight: 40, maxInARow: 1 },
        { move: "gl_stab", weight: 60, maxInARow: 2 },
      ],
    },
  },
  {
    id: "taskmaster",
    name: "工头",
    hpMin: 54,
    hpMax: 60,
    moves: [
      {
        id: "scouring_whip",
        name: "抽打",
        effects: [
          { kind: "deal_damage", amount: 7 },
          { kind: "add_card", cardId: "wound", pile: "discard", count: 1 },
        ],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [{ move: "scouring_whip", weight: 1, maxInARow: 99 }],
    },
  },

  // —— 第二幕精英：穿刺之书（多段攻击）——
  {
    id: "book_of_stabbing",
    name: "穿刺之书",
    hpMin: 160,
    hpMax: 162,
    moves: [
      {
        id: "multi_stab",
        name: "乱刺",
        effects: [{ kind: "deal_damage_multi", amount: 6, times: 3 }],
        intent: "attack",
      },
      {
        id: "big_stab",
        name: "重刺",
        effects: [{ kind: "deal_damage", amount: 21 }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "multi_stab", weight: 70, maxInARow: 99 },
        { move: "big_stab", weight: 30, maxInARow: 1 },
      ],
    },
  },

  // —— 第二幕 Boss：冠军（半血暴怒）——
  {
    id: "champ",
    name: "冠军",
    hpMin: 420,
    hpMax: 440,
    moves: [
      {
        id: "champ_slash",
        name: "重斩",
        effects: [{ kind: "deal_damage", amount: 16 }],
        intent: "attack",
      },
      {
        id: "face_slap",
        name: "扇脸",
        effects: [
          { kind: "deal_damage", amount: 12 },
          { kind: "apply_power", power: "weak", amount: 2, on: "target" },
          { kind: "apply_power", power: "frail", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
      {
        id: "champ_defend",
        name: "防御姿态",
        effects: [
          { kind: "gain_block", amount: 15 },
          { kind: "apply_power", power: "metallicize", amount: 5, on: "self" },
        ],
        intent: "defend",
      },
      {
        id: "execute",
        name: "处决",
        effects: [{ kind: "deal_damage_multi", amount: 10, times: 2 }],
        intent: "attack",
      },
      {
        id: "gloat",
        name: "自夸",
        effects: [{ kind: "apply_power", power: "strength", amount: 3, on: "self" }],
        intent: "buff",
      },
      {
        id: "anger",
        name: "暴怒",
        effects: [{ kind: "apply_power", power: "strength", amount: 6, on: "self" }],
        intent: "buff",
      },
    ],
    // 半血暴怒（一次性）由 sts-combat.ts 的 MOVE_RULES 登记 champ（待迁移）；其余走 weighted。
    intentRule: {
      scripted: [],
      weighted: [
        { move: "champ_slash", weight: 30, maxInARow: 2 },
        { move: "face_slap", weight: 20, maxInARow: 1 },
        { move: "champ_defend", weight: 20, maxInARow: 1 },
        { move: "execute", weight: 15, maxInARow: 1 },
        { move: "gloat", weight: 15, maxInARow: 1 },
      ],
    },
  },

  // —— 第二幕 Boss：青铜自动机（召唤青铜球 + 超射线）——
  {
    id: "bronze_automaton",
    name: "青铜自动机",
    hpMin: 300,
    hpMax: 300,
    moves: [
      {
        id: "spawn_orbs",
        name: "召唤青铜球",
        effects: [{ kind: "summon", defIds: ["bronze_orb", "bronze_orb"] }],
        intent: "unknown",
      },
      {
        id: "flail",
        name: "连枷",
        effects: [{ kind: "deal_damage_multi", amount: 7, times: 2 }],
        intent: "attack",
      },
      {
        id: "boost",
        name: "增益",
        effects: [
          { kind: "gain_block", amount: 9 },
          { kind: "apply_power", power: "strength", amount: 3, on: "self" },
        ],
        intent: "buff",
      },
      {
        id: "hyperbeam",
        name: "超射线",
        effects: [{ kind: "deal_damage", amount: 45 }],
        intent: "attack",
      },
    ],
    // 首招召唤两颗青铜球，之后 连枷/增益/超射线。
    intentRule: {
      scripted: ["spawn_orbs"],
      weighted: [
        { move: "flail", weight: 40, maxInARow: 2 },
        { move: "boost", weight: 35, maxInARow: 1 },
        { move: "hyperbeam", weight: 25, maxInARow: 1 },
      ],
    },
  },
  {
    id: "bronze_orb",
    name: "青铜球",
    hpMin: 52,
    hpMax: 52,
    moves: [
      {
        id: "orb_beam",
        name: "光束",
        effects: [{ kind: "deal_damage", amount: 8 }],
        intent: "attack",
      },
      {
        id: "orb_support",
        name: "支援",
        effects: [{ kind: "gain_block", amount: 6 }],
        intent: "defend",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "orb_beam", weight: 70, maxInARow: 2 },
        { move: "orb_support", weight: 30, maxInARow: 1 },
      ],
    },
  },

  // —— 第二幕 Boss：收藏家（召唤火把头 + 群体减益）——
  {
    id: "the_collector",
    name: "收藏家",
    hpMin: 282,
    hpMax: 300,
    moves: [
      {
        id: "spawn_torches",
        name: "召唤火把头",
        effects: [{ kind: "summon", defIds: ["torch_head", "torch_head"] }],
        intent: "unknown",
      },
      {
        id: "fireball",
        name: "火球",
        effects: [{ kind: "deal_damage", amount: 18 }],
        intent: "attack",
      },
      {
        id: "collector_buff",
        name: "增幅",
        effects: [
          { kind: "gain_block", amount: 15 },
          { kind: "apply_power", power: "strength", amount: 3, on: "self" },
        ],
        intent: "buff",
      },
      {
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
    // 首招召唤两个火把头，之后 火球/增幅/巨型削弱。
    intentRule: {
      scripted: ["spawn_torches"],
      weighted: [
        { move: "fireball", weight: 40, maxInARow: 2 },
        { move: "collector_buff", weight: 25, maxInARow: 1 },
        { move: "mega_debuff", weight: 35, maxInARow: 1 },
      ],
    },
  },
  {
    id: "torch_head",
    name: "火把头",
    hpMin: 38,
    hpMax: 40,
    moves: [
      {
        id: "torch_tackle",
        name: "冲撞",
        effects: [{ kind: "deal_damage", amount: 7 }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [{ move: "torch_tackle", weight: 1, maxInARow: 99 }],
    },
  },

  // —— 第三幕（超越）普通敌人 ——
  {
    id: "exploder",
    name: "爆破怪",
    hpMin: 30,
    hpMax: 30,
    // 亡语：死亡时爆炸，对玩家造成 30 点伤害（杀它有代价）。
    deathEffects: [{ kind: "deal_damage", amount: 30 }],
    moves: [
      {
        id: "exp_slam",
        name: "撞击",
        effects: [{ kind: "deal_damage", amount: 9 }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [{ move: "exp_slam", weight: 1, maxInARow: 99 }],
    },
  },
  {
    id: "spiker",
    name: "尖刺客",
    hpMin: 42,
    hpMax: 56,
    // 开局自带反甲 3（你每攻击它一次反弹 3；见 createEnemyState）。
    moves: [
      {
        id: "spk_cut",
        name: "切割",
        effects: [{ kind: "deal_damage", amount: 7 }],
        intent: "attack",
      },
      {
        id: "spk_spike",
        name: "增生尖刺",
        effects: [{ kind: "apply_power", power: "sharp_hide", amount: 2, on: "self" }],
        intent: "buff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "spk_cut", weight: 60, maxInARow: 2 },
        { move: "spk_spike", weight: 40, maxInARow: 1 },
      ],
    },
  },
  {
    id: "orb_walker",
    name: "球行者",
    hpMin: 90,
    hpMax: 96,
    moves: [
      {
        id: "ow_laser",
        name: "激光",
        effects: [
          { kind: "deal_damage", amount: 10 },
          { kind: "add_card", cardId: "burn", pile: "discard", count: 1 },
        ],
        intent: "attack",
      },
      {
        id: "ow_claw",
        name: "利爪",
        effects: [{ kind: "deal_damage", amount: 16 }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "ow_laser", weight: 50, maxInARow: 2 },
        { move: "ow_claw", weight: 50, maxInARow: 1 },
      ],
    },
  },

  // —— 第三幕精英：蛇法师（召唤匕首）——
  {
    id: "reptomancer",
    name: "蛇法师",
    hpMin: 180,
    hpMax: 190,
    moves: [
      {
        id: "summon_daggers",
        name: "召唤匕首",
        effects: [{ kind: "summon", defIds: ["dagger", "dagger"] }],
        intent: "unknown",
      },
      {
        id: "snake_strike",
        name: "毒牙",
        effects: [
          { kind: "deal_damage", amount: 13 },
          { kind: "apply_power", power: "weak", amount: 1, on: "target" },
        ],
        intent: "attack",
      },
      {
        id: "big_bite",
        name: "巨口",
        effects: [{ kind: "deal_damage", amount: 30 }],
        intent: "attack",
      },
    ],
    // 首招召唤匕首，之后 毒牙/巨口（身边匕首少时再召唤由 reptomancer 分支处理）。
    intentRule: {
      scripted: ["summon_daggers"],
      weighted: [
        { move: "snake_strike", weight: 60, maxInARow: 2 },
        { move: "big_bite", weight: 40, maxInARow: 1 },
      ],
    },
  },
  {
    id: "dagger",
    name: "匕首",
    hpMin: 20,
    hpMax: 25,
    moves: [
      {
        id: "dagger_stab",
        name: "突刺",
        effects: [{ kind: "deal_damage", amount: 9 }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [{ move: "dagger_stab", weight: 1, maxInARow: 99 }],
    },
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
    hpMin: 29,
    hpMax: 35,
    moves: [
      {
        id: "rep_bash",
        name: "撞击",
        effects: [{ kind: "deal_damage", amount: 11 }],
        intent: "attack",
      },
      {
        id: "repulse",
        name: "斥力",
        effects: [{ kind: "add_card", cardId: "dazed", pile: "draw", count: 1 }],
        intent: "debuff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "rep_bash", weight: 60, maxInARow: 2 },
        { move: "repulse", weight: 40, maxInARow: 1 },
      ],
    },
  },
  {
    id: "transient",
    name: "无常",
    hpMin: 88,
    hpMax: 92,
    moves: [
      {
        id: "transient_slam",
        name: "重殴",
        effects: [{ kind: "deal_damage", amount: 30 }],
        intent: "attack",
      },
      {
        id: "fade",
        name: "消散",
        effects: [{ kind: "escape" }],
        intent: "unknown",
      },
    ],
    // 出招由 sts-combat.ts 的 MOVE_RULES 登记 transient（待迁移）（重殴数回合后消散离场）。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕精英：巨型头颅（蓄势后连续重击）——
  {
    id: "giant_head",
    name: "巨型头颅",
    hpMin: 500,
    hpMax: 500,
    moves: [
      {
        id: "gh_glare",
        name: "凝视",
        effects: [{ kind: "deal_damage", amount: 10 }],
        intent: "attack",
      },
      {
        id: "it_is_time",
        name: "时候到了",
        effects: [{ kind: "deal_damage", amount: 35 }],
        intent: "attack",
      },
    ],
    // 出招由 sts-combat.ts 的 MOVE_RULES 登记 giant_head（待迁移）（前 3 回合凝视，之后每回合重击）。
    intentRule: { scripted: [], weighted: [] },
  },

  // —— 第三幕 Boss：觉醒者（死亡后复活二阶段）——
  {
    id: "awakened_one",
    name: "觉醒者",
    hpMin: 300,
    hpMax: 300,
    reviveHp: 300,
    moves: [
      {
        id: "aw_slash",
        name: "斩击",
        effects: [{ kind: "deal_damage", amount: 20 }],
        intent: "attack",
      },
      {
        id: "soul_strike",
        name: "灵魂打击",
        effects: [{ kind: "deal_damage_multi", amount: 6, times: 4 }],
        intent: "attack",
      },
      {
        id: "aw_buff",
        name: "汲取",
        effects: [{ kind: "apply_power", power: "strength", amount: 2, on: "self" }],
        intent: "buff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "aw_slash", weight: 45, maxInARow: 2 },
        { move: "soul_strike", weight: 35, maxInARow: 1 },
        { move: "aw_buff", weight: 20, maxInARow: 1 },
      ],
    },
  },

  // —— 第三幕 Boss：时间吞噬者（时间扭曲 + 半血加速）——
  {
    id: "time_eater",
    name: "时间吞噬者",
    hpMin: 456,
    hpMax: 456,
    timeWarpEvery: 12,
    moves: [
      {
        id: "te_reverberate",
        name: "混响",
        effects: [{ kind: "deal_damage_multi", amount: 7, times: 3 }],
        intent: "attack",
      },
      {
        id: "te_head_slam",
        name: "头槌",
        effects: [
          { kind: "deal_damage", amount: 26 },
          { kind: "apply_power", power: "draw_reduction", amount: 1, on: "target" },
        ],
        intent: "attack",
      },
      {
        id: "te_ripple",
        name: "涟漪",
        effects: [
          { kind: "gain_block", amount: 20 },
          { kind: "apply_power", power: "weak", amount: 1, on: "target" },
          { kind: "apply_power", power: "vulnerable", amount: 1, on: "target" },
        ],
        intent: "defend",
      },
      {
        id: "haste",
        name: "加速",
        effects: [{ kind: "boss_haste" }],
        intent: "buff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "te_reverberate", weight: 45, maxInARow: 2 },
        { move: "te_head_slam", weight: 35, maxInARow: 1 },
        { move: "te_ripple", weight: 20, maxInARow: 1 },
      ],
    },
  },

  // —— 第三幕精英：复仇魔（隔回合虚无缥缈无敌）——
  {
    id: "nemesis",
    name: "复仇魔",
    hpMin: 185,
    hpMax: 185,
    intangibleAfterMove: 2,
    moves: [
      {
        id: "nem_attack",
        name: "多重打击",
        effects: [{ kind: "deal_damage_multi", amount: 6, times: 3 }],
        intent: "attack",
      },
      {
        id: "nem_scythe",
        name: "巨镰",
        effects: [{ kind: "deal_damage", amount: 45 }],
        intent: "attack",
      },
      {
        id: "nem_debuff",
        name: "灼烧诅咒",
        effects: [{ kind: "add_card", cardId: "burn", pile: "discard", count: 3 }],
        intent: "debuff",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "nem_attack", weight: 35, maxInARow: 2 },
        { move: "nem_scythe", weight: 30, maxInARow: 1 },
        { move: "nem_debuff", weight: 35, maxInARow: 1 },
      ],
    },
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
    // ⚠ **爬升度分档本批不写**（与第二十三批那三只同理）：`ascCalibrated` 没置，
    //   `constructMonster` 在 `ascension > 0` 时直接抛错，写了也没有预言机。
    //   参考的四处分档记在各招式的注释里，留给「第二幕爬升度」那一批一次性转写。
    id: "byrd",
    name: "拜鸟",
    // MonsterIds.h:160 `{{25,31},{26,33}}`；普通怪阈值 `setRandomHp(hpRng, asc >= 7)`
    // （MonsterSpecific.cpp:42）。高档那一组本批不写，理由同上。
    hpMin: 25,
    hpMax: 31,
    moves: [
      {
        // MonsterSpecific.cpp:547-549 `attackPlayerHelper(bc, 1, asc2 ? 6 : 5)`。
        // ⚠⚠ **每击 1 点、打 5 下**，不是「1 点 × 5 = 5 点的单击」——旧近似表把段数写对了
        //   却把它当成 `deal_damage_multi(1, 5)` 的巧合；这里逐位对齐的关键是**每一击都
        //   单独走一次玩家格挡与荆棘/火焰屏障**。
        // ⚠⚠ **爬升度挂在第三个实参（段数）上，不是伤害上**——这是本项目第一次遇到
        //   `asc` 覆盖 `times`。`Effect.ascAmount` 覆盖的是 `amount`，表达不了它；
        //   第二幕铺爬升度那一批要么加 `ascTimes`、要么另想办法。本批不写（不可达）。
        id: "peck",
        name: "啄击",
        effects: [{ kind: "deal_damage_multi", amount: 1, times: 5 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:557-560 `attackPlayerHelper(bc, asc2 ? 14 : 12)`。
        id: "swoop",
        name: "俯冲",
        effects: [{ kind: "deal_damage", amount: 12 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:532-535 `buff<MS::STRENGTH>(1)`——**没有 asc 分档**，
        // 而且是同步 buff（`on: "self"` 恒同步）。
        id: "caw",
        name: "啼鸣",
        effects: [{ kind: "apply_power", power: "strength", amount: 1, on: "self" }],
        intent: "buff",
      },
      {
        // MonsterSpecific.cpp:537-540 `buff<MS::FLIGHT>(asc17 ? 4 : 3)`——重新起飞。
        // ⚠ 是 `buff`（**累加**）而不是 setStatus：这一回合开头 `applyPreTurnLogic` 刚把
        //   飞行复位成 3，所以飞完实际是 **6**。照抄，别按「回到 3」的直觉写。
        id: "fly",
        name: "起飞",
        effects: [{ kind: "apply_power", power: "flight", amount: 3, on: "self" }],
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
    // ⚠ 爬升度分档本批不写，理由同拜鸟。
    id: "mugger",
    name: "劫匪",
    // MonsterIds.h:183 `{{48,52},{50,54}}`；普通怪阈值 asc>=7（MonsterSpecific.cpp:55）。
    hpMin: 48,
    hpMax: 52,
    moves: [
      {
        // MonsterSpecific.cpp:964-982：`stealGoldFromPlayer(...)` + `attackPlayerHelper(asc2 ? 11 : 10)`。
        // ⚠ **偷金在攻击之前**（偷是同步、攻击是入队），照抄书写顺序。
        id: "mug",
        name: "抢劫",
        effects: [{ kind: "steal_gold" }, { kind: "deal_damage", amount: 10 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:956-962：`stealGoldFromPlayer(...)` + `attackPlayerHelper(asc2 ? 18 : 16)`。
        // ⚠ **不带逃跑**——旧近似表把「扑击逃窜」写成一招里又打又跑，参考里逃跑是
        //   烟雾弹之后单独的一个意图。
        id: "lunge",
        name: "猛扑",
        effects: [{ kind: "steal_gold" }, { kind: "deal_damage", amount: 16 }],
        intent: "attack",
      },
      {
        // MonsterSpecific.cpp:984-988 `addBlock(asc17 ? 17 : 11)`——**同步**加格挡
        // （与抢劫者的烟雾弹同形，数值不同），故 `sync: true`。
        id: "smoke_bomb",
        name: "烟雾弹",
        effects: [{ kind: "gain_block", amount: 11, sync: true }],
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
  {
    id: "darkling",
    name: "暗影客",
    hpMin: 48,
    hpMax: 56,
    moves: [
      {
        id: "darkling_nip",
        name: "撕咬",
        effects: [{ kind: "deal_damage", amount: 8 }],
        intent: "attack",
      },
      {
        id: "darkling_chomp",
        name: "啃食",
        effects: [{ kind: "deal_damage", amount: 9 }],
        intent: "attack",
      },
      {
        id: "darkling_harden",
        name: "硬化",
        effects: [{ kind: "gain_block", amount: 12 }],
        intent: "defend",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "darkling_nip", weight: 40, maxInARow: 2 },
        { move: "darkling_chomp", weight: 40, maxInARow: 1 },
        { move: "darkling_harden", weight: 20, maxInARow: 1 },
      ],
    },
  },
  {
    id: "spire_growth",
    name: "尖塔幼体",
    hpMin: 170,
    hpMax: 170,
    moves: [
      {
        id: "sg_quick_tackle",
        name: "急冲",
        effects: [{ kind: "deal_damage", amount: 16 }],
        intent: "attack",
      },
      {
        id: "sg_smash",
        name: "重砸",
        effects: [
          { kind: "deal_damage", amount: 22 },
          { kind: "apply_power", power: "weak", amount: 1, on: "target" },
        ],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "sg_quick_tackle", weight: 50, maxInARow: 2 },
        { move: "sg_smash", weight: 50, maxInARow: 1 },
      ],
    },
  },
  {
    id: "the_maw",
    name: "巨口",
    hpMin: 300,
    hpMax: 300,
    moves: [
      {
        id: "maw_roar",
        name: "咆哮",
        effects: [
          { kind: "apply_power", power: "weak", amount: 3, on: "target" },
          { kind: "apply_power", power: "frail", amount: 3, on: "target" },
        ],
        intent: "debuff",
      },
      {
        id: "maw_slam",
        name: "重击",
        effects: [{ kind: "deal_damage", amount: 25 }],
        intent: "attack",
      },
      {
        id: "maw_nom",
        name: "吞噬",
        effects: [{ kind: "deal_damage_multi", amount: 5, times: 3 }],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: ["maw_roar"],
      weighted: [
        { move: "maw_slam", weight: 50, maxInARow: 1 },
        { move: "maw_nom", weight: 50, maxInARow: 1 },
      ],
    },
  },
  {
    id: "writhing_mass",
    name: "蠕动之物",
    hpMin: 160,
    hpMax: 160,
    moves: [
      {
        id: "wm_multi_strike",
        name: "乱抽",
        effects: [{ kind: "deal_damage_multi", amount: 7, times: 3 }],
        intent: "attack",
      },
      {
        id: "wm_strong_strike",
        name: "重抽",
        effects: [{ kind: "deal_damage", amount: 32 }],
        intent: "attack",
      },
      {
        id: "wm_flail",
        name: "挥击",
        effects: [{ kind: "deal_damage", amount: 15 }],
        intent: "attack",
      },
      {
        id: "wm_wither",
        name: "萎缩",
        effects: [
          { kind: "deal_damage", amount: 10 },
          { kind: "apply_power", power: "weak", amount: 2, on: "target" },
        ],
        intent: "attack",
      },
    ],
    intentRule: {
      scripted: [],
      weighted: [
        { move: "wm_multi_strike", weight: 30, maxInARow: 1 },
        { move: "wm_strong_strike", weight: 20, maxInARow: 1 },
        { move: "wm_flail", weight: 25, maxInARow: 2 },
        { move: "wm_wither", weight: 25, maxInARow: 1 },
      ],
    },
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
  shelled_parasite: { id: "shelled_parasite", enemies: ["shelled_parasite"], isBoss: false },
  chosen: { id: "chosen", enemies: ["chosen"], isBoss: false },
  snecko: { id: "snecko", enemies: ["snecko"], isBoss: false },
  // 百夫长 + 秘法师：秘法师治疗/鼓舞百夫长，经典组合。
  centurion_mystic: { id: "centurion_mystic", enemies: ["centurion", "mystic"], isBoss: false },
  book_of_stabbing: { id: "book_of_stabbing", enemies: ["book_of_stabbing"], isBoss: false },
  // 地精首领带 2 只地精登场；死光了会继续召唤。
  gremlin_leader: {
    id: "gremlin_leader",
    enemies: ["mad_gremlin", "gremlin_leader", "sneaky_gremlin"],
    isBoss: false,
  },
  // 奴隶主小队：工头 + 蓝/红奴隶主。
  slavers: { id: "slavers", enemies: ["taskmaster", "blue_slaver", "red_slaver"], isBoss: false },
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
  cultist_and_chosen: {
    id: "cultist_and_chosen",
    enemies: ["cultist", "chosen"],
    isBoss: false,
  },
  three_cultists: {
    id: "three_cultists",
    enemies: ["cultist", "cultist", "cultist"],
    isBoss: false,
  },
  shelled_parasite_and_fungi: {
    id: "shelled_parasite_and_fungi",
    enemies: ["shelled_parasite", "fungi_beast"],
    isBoss: false,
  },
  sentry_and_sphere: {
    id: "sentry_and_sphere",
    enemies: ["sentry", "spheric_guardian", "sentry"],
    isBoss: false,
  },
  // —— 第三幕组合遭遇（几何体 shapes：爆破怪/斥力球/尖刺客 + 球卫/颚虫群）——
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
  three_darklings: {
    id: "three_darklings",
    enemies: ["darkling", "darkling", "darkling"],
    isBoss: false,
  },
  spire_growth: { id: "spire_growth", enemies: ["spire_growth"], isBoss: false },
  the_maw: { id: "the_maw", enemies: ["the_maw"], isBoss: false },
  writhing_mass: { id: "writhing_mass", enemies: ["writhing_mass"], isBoss: false },
  champ: { id: "champ", enemies: ["champ"], isBoss: true },
  bronze_automaton: { id: "bronze_automaton", enemies: ["bronze_automaton"], isBoss: true },
  the_collector: { id: "the_collector", enemies: ["the_collector"], isBoss: true },
  // 第三幕
  exploder: { id: "exploder", enemies: ["exploder"], isBoss: false },
  spiker: { id: "spiker", enemies: ["spiker"], isBoss: false },
  orb_walker: { id: "orb_walker", enemies: ["orb_walker"], isBoss: false },
  two_exploders: { id: "two_exploders", enemies: ["exploder", "exploder"], isBoss: false },
  reptomancer: { id: "reptomancer", enemies: ["reptomancer"], isBoss: false },
  donu_deca: { id: "donu_deca", enemies: ["deca", "donu"], isBoss: true },
  repulsor: { id: "repulsor", enemies: ["repulsor"], isBoss: false },
  transient: { id: "transient", enemies: ["transient"], isBoss: false },
  two_orb_walkers: { id: "two_orb_walkers", enemies: ["orb_walker", "orb_walker"], isBoss: false },
  giant_head: { id: "giant_head", enemies: ["giant_head"], isBoss: false },
  awakened_one: { id: "awakened_one", enemies: ["awakened_one"], isBoss: true },
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
  { id: "shelled_parasite", weight: 1 },
  { id: "chosen", weight: 1 },
  { id: "three_byrds", weight: 1 },
];

const ACT2_STRONG_POOL: readonly WeightedEncounter[] = [
  { id: "chosen", weight: 2 },
  { id: "snecko", weight: 2 },
  { id: "centurion_mystic", weight: 2 },
  { id: "shelled_parasite", weight: 2 },
  { id: "snake_plant", weight: 1 },
  { id: "two_centurions", weight: 1 },
  { id: "spheric_guardian", weight: 1 },
  { id: "cultist_and_chosen", weight: 1 },
  { id: "three_cultists", weight: 1 },
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
  { id: "the_maw", weight: 1 },
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

// Act2 Boss 池（切片：冠军；后续补 青铜自动机 / 收藏家）。
const ACT2_BOSS_POOL: readonly WeightedEncounter[] = [
  { id: "champ", weight: 1 },
  { id: "bronze_automaton", weight: 1 },
  { id: "the_collector", weight: 1 },
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
