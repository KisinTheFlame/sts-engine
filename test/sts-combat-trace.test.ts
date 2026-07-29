import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initCombat,
  endTurn,
  playCard,
  drinkPotion,
  selectCard,
  selectCards,
  type BattleContext,
} from "../src/engine/sts-combat.js";
import { StsRandom } from "../src/engine/sts-rng.js";

// ============================================================================
// 逐帧重放对拍：数据由参考项目**真实 BattleContext** 驱动产出（非手工转写）。
//
// trace 里记录了「动作序列 + 每步之后的全量状态」。本测试重放同一动作序列，
// 逐帧比对状态。因为两边消费的是同一份已记录的动作，策略本身不可能成为分歧来源——
// 只有引擎行为会。
// ============================================================================

type Snapshot = {
  turn: number;
  outcome: string;
  /**
   * 本场战斗金币的**变化量**（第十一批新增，当时只有贪婪之手的击杀奖励；
   * 第十五批起抢劫者偷金会让它变成负数）。
   *
   * harness 输出的是**增量**而不是绝对值，且只在非零时才输出——参考那边战斗内金币的入场值
   * 是 GameContext 的 99，直接 dump 绝对值会重写每一个文件的每一行（含**冻结的 variant 0**），
   * 而 `regen-traces.sh` 正是拒绝这件事的。这与 `deckUpgraded` 用的是同一招。
   *
   * ⚠ 重放侧**必须**从同一个绝对值起算，见 `HARNESS_GOLD_BASELINE`。
   */
  goldGained?: number;
  player: {
    hp: number;
    maxHp: number;
    block: number;
    energy: number;
    powers: Record<string, number>;
  };
  monsters: {
    id: string;
    hp: number;
    maxHp: number;
    block: number;
    alive: boolean;
    move: string;
    powers: Record<string, number>;
  }[];
  hand: string[];
  draw: string[];
  discard: string[];
  exhaust: string[];
  potions: string[];
  rng: {
    ai: number;
    hp: number;
    shuffle: number;
    cardRandom: number;
    misc: number;
    potion: number;
  };
};

type Step = {
  action: { type: string; idx?: number; target?: number; idxs?: number[] };
  after: Snapshot;
};

type Trace = {
  seed: string;
  relics: string[];
  potionRngSeed: string;
  seedLong: string;
  floor: number;
  encounter: string;
  character: string;
  deck: string[];
  /**
   * 与 deck 等长的 0/1，标记每张牌是否升级。
   *
   * 仅在**确有**升级牌时由 harness 输出，所以未升级的 trace 行与这个字段存在之前提交的
   * 数据逐字节一致——冻结的 variant 0 因此不必随这个字段的引入重生成。
   */
  deckUpgraded?: number[];
  /**
   * 生成这条 trace 的爬升度（第二十一批新增）。
   *
   * 与 `deckUpgraded` / `goldGained` 同一招：harness **只在非 0 时输出**，所以 asc0 的行
   * 与这个字段存在之前提交的数据逐字节一致——20 个既有编队文件因此不必随这条轴重生成
   * （管线改造那一步单独跑过一次 `--check` 证明了这一点）。
   *
   * ⚠ 缺省即 0，不要写成必填：绝大多数行没有这个字段。
   */
  ascension?: number;
  /**
   * 入场时（`BattleContext::init` **之前**）的玩家生命，第二十一批新增。
   *
   * ⚠ `initial.player.hp` 是 **init 之后**的值，而 `BattleContext::init` 里已经跑过
   * `initRelics`（BattleContext.cpp:73），血瓶的 `heal(2)` 就在里面。所以拿
   * `initial.player.hp` 当重放的入场血量会**多回一次血**。
   *
   * asc0 下发现不了：`GameContext::initPlayer` 末尾是
   * `curHp = ascension < 6 ? maxHp : round(maxHp * 0.9f)`（GameContext.cpp:522），
   * 满血入场时那 2 点被上限吃掉，前后相等。asc19 是 68/75，于是每一条relic 里带血瓶的
   * trace 都差整整 2 点——本批实测 420 例（14 编队 × 30 条，血瓶在 8 个遗物的轮换里占 1/4）。
   *
   * harness **只在它与 maxHp 不等时**输出，故 asc0 的行逐字节不变；缺省即 `maxHp`
   * ——但这里退回 `initial.player.hp` 而不是 maxHp，因为 asc0 下两者恒等，
   * 而万一以后有别的东西改 maxHp，用 initial 那份更贴近旧行为。
   */
  playerHp?: number;
  initial: Snapshot;
  steps: Step[];
};

// 按编队分文件存放（JSONL，每行一条 trace）：
//  * 新增编队 = 新增一个文件，既有文件零改动，git 历史里不会多出重写的大 blob
//  * 单个编队重生成只碰它自己那份
//  * 行结构让 git 能在版本间做增量，diff 也能看出是哪几条 trace 变了
// 生成是确定性的：同参数重跑逐字节一致，因此不会平白产生新 blob。
/**
 * harness 那边战斗**入场时**的金币绝对值。
 *
 * 来源是两处相连的事实：`GameContext.h:224` 的 `int gold = 99`（harness 从不改它，
 * `trace_dump.cpp:1265` 只传 character/seed/act），以及 `trace_dump.cpp:1327` 的
 * `s_goldBaseline = gc.gold`——快照里的 `goldGained` 就是相对它的差。
 *
 * ⚠ **第十五批之前这里是隐含的 0**，理由写在当时的注释里：「这五个编队没有一样东西读金币，
 * 差个常数不影响任何行为」。抢劫者一登记，这句话就不成立了——`stealGoldFromPlayer` 是
 * `min(player.gold, 额度)`，**按金币的绝对值钳制**。从 0 起算的话我们一分钱都偷不到，
 * 而 trace 里的 `goldGained` 是负数，当场红。所以重放侧改成与参考同起点、比对时再减掉。
 *
 * ⚠ 不把钳制删掉「修绿」：那是静默偏离参考，而且真实游戏里「玩家没钱了就偷不走」是真行为。
 *
 * 这个常数错了会不会被发现？**偏小一定会**：钳制会提前生效，偷到的金币比 trace 少，
 * 逐帧对拍当场红（下面的断言还会先给出更直白的报错）。**偏大发现不了**，而且数据里
 * 也没有能发现它的信息——variant 0 全 375 条 `exordium_thugs` 里偷得最狠的一场也才 -45，
 * 离 0 还有一倍余量，钳制从没真的咬合过。这一条记在 TODOS 的盲区里。
 */
const HARNESS_GOLD_BASELINE = 99;

const traceDir = fileURLToPath(new URL("./golden/traces", import.meta.url));
const traces: Trace[] = readdirSync(traceDir)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()
  .flatMap((f) =>
    readFileSync(join(traceDir, f), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Trace),
  );

// —— 参考枚举名 → 我们的 id ——
const CARD: Record<string, string> = {
  STRIKE_RED: "strike",
  DEFEND_RED: "defend",
  BASH: "bash",
  ANGER: "anger",
  CLEAVE: "cleave",
  CLOTHESLINE: "clothesline",
  HEAVY_BLADE: "heavy_blade",
  IRON_WAVE: "iron_wave",
  POMMEL_STRIKE: "pommel_strike",
  SHRUG_IT_OFF: "shrug_it_off",
  THUNDERCLAP: "thunderclap",
  TWIN_STRIKE: "twin_strike",
  BODY_SLAM: "body_slam",
  INFLAME: "inflame",
  // —— 第二批 29 张 ——
  BITE: "bite",
  BLUDGEON: "bludgeon",
  DROPKICK: "dropkick",
  FEED: "feed",
  FIEND_FIRE: "fiend_fire",
  FLASH_OF_STEEL: "flash_of_steel",
  HEMOKINESIS: "hemokinesis",
  PUMMEL: "pummel",
  REAPER: "reaper",
  SEVER_SOUL: "sever_soul",
  SWORD_BOOMERANG: "sword_boomerang",
  SWIFT_STRIKE: "swift_strike",
  BANDAGE_UP: "bandage_up",
  BLIND: "blind",
  BLOODLETTING: "bloodletting",
  DEEP_BREATH: "deep_breath",
  ENTRENCH: "entrench",
  FINESSE: "finesse",
  GOOD_INSTINCTS: "good_instincts",
  IMPERVIOUS: "impervious",
  INTIMIDATE: "intimidate",
  JAX: "jax",
  MASTER_OF_STRATEGY: "master_of_strategy",
  OFFERING: "offering",
  PANACEA: "panacea",
  SECOND_WIND: "second_wind",
  SHOCKWAVE: "shockwave",
  SPOT_WEAKNESS: "spot_weakness",
  BERSERK: "berserk",
  // —— 第三批 12 张（回合边界 Power 解锁的）——
  UPPERCUT: "uppercut",
  BATTLE_TRANCE: "battle_trance",
  DISARM: "disarm",
  FLEX: "flex",
  IMPATIENCE: "impatience",
  LIMIT_BREAK: "limit_break",
  SEEING_RED: "seeing_red",
  TRIP: "trip",
  BARRICADE: "barricade",
  COMBUST: "combust",
  DEMON_FORM: "demon_form",
  METALLICIZE: "metallicize",
  // —— 第四批 10 张（选牌屏解锁的）——
  ARMAMENTS: "armaments",
  BURNING_PACT: "burning_pact",
  EXHUME: "exhume",
  HEADBUTT: "headbutt",
  PURITY: "purity",
  SECRET_TECHNIQUE: "secret_technique",
  SECRET_WEAPON: "secret_weapon",
  THINKING_AHEAD: "thinking_ahead",
  TRUE_GRIT: "true_grit",
  WARCRY: "warcry",
  // —— 第五批 11 张（牌的生命周期：消耗触发 / 状态牌生成 / 以太 / 固有归位）——
  DARK_EMBRACE: "dark_embrace",
  FEEL_NO_PAIN: "feel_no_pain",
  IMMOLATE: "immolate",
  RECKLESS_CHARGE: "reckless_charge",
  WILD_STRIKE: "wild_strike",
  POWER_THROUGH: "power_through",
  CARNAGE: "carnage",
  GHOSTLY_ARMOR: "ghostly_armor",
  DRAMATIC_ENTRANCE: "dramatic_entrance",
  MIND_BLAST: "mind_blast",
  BRUTALITY: "brutality",
  EVOLVE: "evolve",
  // —— 第六批 7 张（玩家的事件钩子）——
  FLAME_BARRIER: "flame_barrier",
  FIRE_BREATHING: "fire_breathing",
  RAGE: "rage",
  JUGGERNAUT: "juggernaut",
  RUPTURE: "rupture",
  SENTINEL: "sentinel",
  PANIC_BUTTON: "panic_button",
  // —— 第七批 6 张（卡牌实例级状态）——
  RAMPAGE: "rampage",
  SEARING_BLOW: "searing_blow",
  BLOOD_FOR_BLOOD: "blood_for_blood",
  MADNESS: "madness",
  CORRUPTION: "corruption",
  APPARITION: "apparition",
  // —— 第八批 5 张（随机卡池取牌）——
  CHRYSALIS: "chrysalis",
  METAMORPHOSIS: "metamorphosis",
  DISCOVERY: "discovery",
  JACK_OF_ALL_TRADES: "jack_of_all_trades",
  INFERNAL_BLADE: "infernal_blade",
  // 第五批凭空造出来的状态牌。三张都**不在牌组里**，只由卡效果生成，所以不进 CARD_RULES
  // （打不出来，playCard 有一道 canUse 门拦着），但会出现在牌堆快照里，必须能映射。
  BURN: "burn",
  WOUND: "wound",
  DAZED: "dazed",
  // —— 第八批：**从战斗内卡池随机取出来**、但尚未登记行为的牌 ——
  //
  // 蜕变 / 变形 / 发现 / 多面手 / 地狱之刃 会从 CardPools.h 的三个战斗内卡池里随机取牌
  // 定义，那三个池一共点名 104 张牌，其中当时有 18 张 `CARD_RULES` 里没有。它们**只会躺在
  // 牌堆快照里**（harness 的 isReplayableCard 不让策略打出未登记的牌），但既然出现在快照里
  // 就必须能映射——漏一个会在重放时报「未知卡牌」而不是静默错。
  //
  // 下面这 5 张仍属这一类（真去打它们会抛「暂未登记卡牌行为」）：`forethought` 的升级分支
  // 在参考侧整段被注释掉，剩下四张是别的机制（都不在铁甲 + 无色的范围里 / 缺别的机制）。
  // 第九~十二批的 13 张已经登记，分组列在其后。
  ENLIGHTENMENT: "enlightenment",
  FORETHOUGHT: "forethought",
  MAGNETISM: "magnetism",
  PANACHE: "panache",
  SADISTIC_NATURE: "sadistic_nature",
  // —— 第九批 4 张（出牌队列嵌套）——
  HAVOC: "havoc",
  MAYHEM: "mayhem",
  DOUBLE_TAP: "double_tap",
  DUAL_WIELD: "dual_wield",
  // —— 第十批 3 张（X 费）——
  WHIRLWIND: "whirlwind",
  TRANSMUTATION: "transmutation",
  APOTHEOSIS: "apotheosis",
  // —— 第十一批 4 张（打击计数 / 打出门槛 / 回合计时器 / 战斗内金币）——
  PERFECTED_STRIKE: "perfected_strike",
  CLASH: "clash",
  THE_BOMB: "the_bomb",
  HAND_OF_GREED: "hand_of_greed",
  // —— 第十二批 2 张（怪物回合末触发 / 从抽牌堆随机检索）——
  DARK_SHACKLES: "dark_shackles",
  VIOLENCE: "violence",
  // —— 第十三批：史莱姆塞进弃牌堆的黏液 ——
  // 与 BURN / WOUND / DAZED 不同，它**真的会被打出**（唯一不需要医疗包的状态牌），
  // 所以它进了 CARD_RULES；这里的映射既覆盖牌堆快照、也覆盖打出它的那一步。
  SLIMED: "slimed",
  // —— 第二十一批：爬升度 ≥10 起始牌组里多出来的那张诅咒 ——
  //
  // `GameContext::initPlayer`（GameContext.cpp:479-481）在**角色起始牌之前** obtain 它，
  // 所以它排在 `deck` 数组的**最前面**（重放侧照数组顺序建牌，顺序即洗牌输入）。
  // ⚠ 它是诅咒、`cardCanUse` 恒假，所以**不进 `CARD_RULES`**（与 BURN / WOUND / DAZED 同族）；
  //   但它躺在牌组与三个牌堆的快照里，映射必须有。
  // ⚠ 它是**虚无（ethereal）**：回合末没打出去就被消耗，`cards.ts:3450` 已登记该属性，
  //   asc19 的 trace 里逐帧可见（手牌 → 消耗堆）。
  ASCENDERS_BANE: "ascenders_bane",
};
const ENCOUNTER: Record<string, string> = {
  CULTIST: "cultist",
  JAW_WORM: "jaw_worm",
  JAW_WORM_HORDE: "jaw_worm_horde",
  TWO_LOUSE: "two_louse",
  THREE_LOUSE: "three_louse",
  // —— 第十三批 ——
  SMALL_SLIMES: "small_slimes",
  LOTS_OF_SLIMES: "lots_of_slimes",
  // —— 第十四批 ——
  LARGE_SLIME: "large_slime",
  // —— 第十五批 ——
  BLUE_SLAVER: "blue_slaver",
  RED_SLAVER: "red_slaver",
  LOOTER: "looter",
  EXORDIUM_THUGS: "exordium_thugs",
  // —— 第十六批 ——
  EXORDIUM_WILDLIFE: "exordium_wildlife",
  // —— 第十七批 ——
  GREMLIN_GANG: "gremlin_gang",
  // —— 第十八批：第一幕三个精英 ——
  GREMLIN_NOB: "gremlin_nob",
  LAGAVULIN: "lagavulin",
  THREE_SENTRIES: "three_sentries",
  // —— 第十九批：第一幕两个 Boss ——
  THE_GUARDIAN: "the_guardian",
  SLIME_BOSS: "slime_boss",
  // —— 第二十批：第一幕最后一个 Boss。装完这一个，harness 的 20 个编队全部有背书。
  HEXAGHOST: "hexaghost",
  // —— 第二十三批：**第二幕开张**。harness 追加了第二遍编队循环（第一幕那个一个字没动），
  // 本批装三个单怪、无召唤、无塞牌的编队。三个都只有 asc0 的背书。
  SPHERIC_GUARDIAN: "spheric_guardian",
  CHOSEN: "chosen",
  SNAKE_PLANT: "snake_plant",
  // —— 第二十四批：飞行（拜鸟）+ 劫匪。三个编队走 harness 新追加的 variant 24
  //   （牌组 = `BATCH_1` + 一张 `SPOT_WEAKNESS`，见那边的注释）。
  THREE_BYRDS: "three_byrds",
  TWO_THIEVES: "two_thieves",
  CHOSEN_AND_BYRDS: "chosen_and_byrds",
};
const MONSTER: Record<string, string> = {
  CULTIST: "cultist",
  JAW_WORM: "jaw_worm",
  RED_LOUSE: "louse",
  GREEN_LOUSE: "green_louse",
  // —— 第十三批 ——
  ACID_SLIME_M: "acid_slime_m",
  ACID_SLIME_S: "acid_slime_s",
  SPIKE_SLIME_M: "spike_slime_m",
  SPIKE_SLIME_S: "spike_slime_s",
  // —— 第十四批。分裂会让同一场战斗里的怪从 1 只变成 2 只中号，
  // 所以这张表同时覆盖 L 号与（第十三批已有的）M 号。
  ACID_SLIME_L: "acid_slime_l",
  SPIKE_SLIME_L: "spike_slime_l",
  // —— 第十五批。⚠ `EXORDIUM_THUGS` 会从六个候选里各挑一只，所以这三行之外
  // 还会真的出现邪教徒 / 红绿虱 / 两只中号史莱姆——它们前面已经有映射了。
  BLUE_SLAVER: "blue_slaver",
  RED_SLAVER: "red_slaver",
  LOOTER: "looter",
  // —— 第十六批。⚠ `EXORDIUM_WILDLIFE` 的另一半候选（颚虫 / 红绿虱 / 两只中号史莱姆）
  // 也会真的出现，它们前面都已有映射。
  FUNGI_BEAST: "fungi_beast",
  // —— 第十七批。⚠ `GREMLIN_GANG` 从 8 个候选里抽 4 只，候选表带重复
  // （狂暴/鬼祟/肥胖各 ×2），所以同一种地精会在一场仗里出现两次。
  MAD_GREMLIN: "mad_gremlin",
  SNEAKY_GREMLIN: "sneaky_gremlin",
  FAT_GREMLIN: "fat_gremlin",
  SHIELD_GREMLIN: "shield_gremlin",
  GREMLIN_WIZARD: "gremlin_wizard",
  // —— 第十八批。三个精英各自独占一个编队，`THREE_SENTRIES` 里同一种怪出现三次
  // （下标 0/2 开局出射钉、下标 1 出光束）。
  GREMLIN_NOB: "gremlin_nob",
  LAGAVULIN: "lagavulin",
  SENTRY: "sentry",
  // —— 第十九批：第一幕两个 Boss。⚠ 史莱姆王分裂出的是两只**大**史莱姆，它们再各自
  // 分裂成中号——所以 `slime_boss.jsonl` 里会出现 L 与 M 两代，那四行前面都有了。
  THE_GUARDIAN: "the_guardian",
  SLIME_BOSS: "slime_boss",
  // —— 第二十批：六火幽魂。单怪编队，全场只有它一只（不分裂、不召唤）。
  HEXAGHOST: "hexaghost",
  // —— 第二十三批：第二幕三只单怪，各自独占一个编队（都不分裂、不召唤）。
  SPHERIC_GUARDIAN: "spheric_guardian",
  CHOSEN: "chosen",
  SNAKE_PLANT: "snake_plant",
  // —— 第二十四批。⚠ `TWO_THIEVES` 是**抢劫者 + 劫匪**（LOOTER 前面已有映射），
  //   `CHOSEN_AND_BYRDS` 是**一只**拜鸟 + 选民（参考就是这么建的，见 enemies.ts 的注释）。
  BYRD: "byrd",
  MUGGER: "mugger",
  // ⚠ **分裂留下的空格**。参考的 `MonsterGroup::arr` 是定长 5 的数组，`monsterCount` 只是
  // 「dump 到第几格」；史莱姆王分裂时 `arr[0]` 与 `arr[2]` 被写、`monsterCount = 3`，
  // 于是 1 号格那只**从没被构造过**的默认 `Monster` 也被 dump 出来
  // （`monsterIdStrings[MonsterId::INVALID]` 字面量就是 `"INVALID = 0"`，MonsterIds.h:82）。
  // 我们这边用 `EMPTY_MONSTER_SLOT` 占位，字段全对齐：hp/maxHp/block 0、alive false、
  // move ""（见下面 MOVE 表里的 `INVALID`）、powers 空。
  "INVALID = 0": "__empty",
};
const MOVE: Record<string, string> = {
  CULTIST_INCANTATION: "incantation",
  CULTIST_DARK_STRIKE: "dark_strike",
  JAW_WORM_CHOMP: "chomp",
  JAW_WORM_BELLOW: "bellow",
  JAW_WORM_THRASH: "thrash",
  RED_LOUSE_BITE: "bite",
  RED_LOUSE_GROW: "grow",
  GREEN_LOUSE_BITE: "bite",
  GREEN_LOUSE_SPIT_WEB: "spit_web",
  // —— 第十三批。招式 id 在我们这边是**每只怪自己的**，重名不要紧（比对逐怪进行），
  // 所以三条「舔舐」在数据表里各叫各的名字。
  ACID_SLIME_M_CORROSIVE_SPIT: "corrosive_spit",
  ACID_SLIME_M_LICK: "lick",
  ACID_SLIME_M_TACKLE: "tackle",
  ACID_SLIME_S_LICK: "lick_weak",
  ACID_SLIME_S_TACKLE: "tackle_acid_s",
  SPIKE_SLIME_M_FLAME_TACKLE: "flame_tackle",
  SPIKE_SLIME_M_LICK: "lick_frail",
  SPIKE_SLIME_S_TACKLE: "tackle_s",
  // —— 第十四批。两条分裂在我们这边**同名**（各自怪的命名空间里都叫 `split`），
  // 与三条舔舐同理：比对是逐怪进行的，重名不要紧。
  ACID_SLIME_L_CORROSIVE_SPIT: "corrosive_spit_l",
  ACID_SLIME_L_LICK: "lick_l",
  ACID_SLIME_L_TACKLE: "tackle_l",
  ACID_SLIME_L_SPLIT: "split",
  SPIKE_SLIME_L_FLAME_TACKLE: "flame_tackle_l",
  SPIKE_SLIME_L_LICK: "lick_frail_l",
  SPIKE_SLIME_L_SPLIT: "split",
  // —— 第十五批。两位奴隶主的「刺击」在我们这边分别叫 stab / rs_stab
  // （数据表是一张平表，怪与怪之间的招式 id 不能重名）。
  BLUE_SLAVER_STAB: "stab",
  BLUE_SLAVER_RAKE: "rake",
  RED_SLAVER_STAB: "rs_stab",
  RED_SLAVER_SCRAPE: "scrape",
  RED_SLAVER_ENTANGLE: "entangle",
  LOOTER_MUG: "mug",
  LOOTER_LUNGE: "lunge",
  LOOTER_SMOKE_BOMB: "smoke_bomb",
  LOOTER_ESCAPE: "flee",
  // —— 第十六批 ——
  FUNGI_BEAST_BITE: "fungi_bite",
  FUNGI_BEAST_GROW: "fungi_grow",
  // —— 第十七批 ——
  MAD_GREMLIN_SCRATCH: "scratch",
  SNEAKY_GREMLIN_PUNCTURE: "puncture",
  FAT_GREMLIN_SMASH: "smash",
  SHIELD_GREMLIN_PROTECT: "protect",
  SHIELD_GREMLIN_SHIELD_BASH: "shield_bash",
  GREMLIN_WIZARD_CHARGING: "charging",
  GREMLIN_WIZARD_ULTIMATE_BLAST: "ultimate_blast",
  // —— 第十八批 ——
  GREMLIN_NOB_BELLOW: "bellow",
  GREMLIN_NOB_RUSH: "rush",
  GREMLIN_NOB_SKULL_BASH: "skull_bash",
  // 「重击」在数据表里叫 lag_attack：那是一张平表，招式 id 不能与别的怪重名。
  LAGAVULIN_ATTACK: "lag_attack",
  LAGAVULIN_SIPHON_SOUL: "siphon_soul",
  LAGAVULIN_SLEEP: "sleep",
  SENTRY_BEAM: "beam",
  SENTRY_BOLT: "bolt",
  // —— 第十九批：第一幕两个 Boss ——
  THE_GUARDIAN_CHARGING_UP: "charging_up",
  THE_GUARDIAN_DEFENSIVE_MODE: "defensive_mode",
  THE_GUARDIAN_FIERCE_BASH: "fierce_bash",
  THE_GUARDIAN_ROLL_ATTACK: "roll_attack",
  THE_GUARDIAN_TWIN_SLAM: "twin_slam",
  THE_GUARDIAN_VENT_STEAM: "vent_steam",
  THE_GUARDIAN_WHIRLWIND: "whirlwind",
  SLIME_BOSS_GOOP_SPRAY: "goop_spray",
  SLIME_BOSS_PREPARING: "preparing",
  SLIME_BOSS_SLAM: "slam",
  // 与两只大史莱姆的分裂同名（各自怪的命名空间里都叫 `split`），比对逐怪进行，重名不要紧。
  SLIME_BOSS_SPLIT: "split",
  // —— 第二十批：六火幽魂六条。⚠ `tackle` 与中号酸液史莱姆重名——同上，比对逐怪进行，
  // 招式 id 只需在**本只怪**的 `moves` 里唯一。
  HEXAGHOST_ACTIVATE: "activate",
  HEXAGHOST_DIVIDER: "divider",
  HEXAGHOST_INFERNO: "inferno",
  HEXAGHOST_INFLAME: "inflame",
  HEXAGHOST_SEAR: "sear",
  HEXAGHOST_TACKLE: "tackle",
  // —— 第二十三批：第二幕三只单怪 ——
  // ⚠ 球状守卫者的四条招式在我们这边全带 `sg_` 前缀（裸名 `activate` 已经被六火幽魂占了；
  //   比对虽是逐怪进行、重名不要紧，但前缀让 `MOVE_TURN_END` 的键更好读）。
  SPHERIC_GUARDIAN_ACTIVATE: "sg_activate",
  SPHERIC_GUARDIAN_SLAM: "sg_slam",
  SPHERIC_GUARDIAN_HARDEN: "sg_harden",
  SPHERIC_GUARDIAN_ATTACK_DEBUFF: "sg_attack_debuff",
  CHOSEN_POKE: "poke",
  CHOSEN_ZAP: "zap",
  CHOSEN_DEBILITATE: "debilitate",
  CHOSEN_DRAIN: "drain",
  CHOSEN_HEX: "hex",
  SNAKE_PLANT_CHOMP: "sp_chomp",
  SNAKE_PLANT_ENFEEBLING_SPORES: "sp_spores",
  // —— 第二十四批：拜鸟六条 + 劫匪四条 ——
  // ⚠ 劫匪四条与抢劫者**同名**（各自怪的命名空间里都叫 mug / lunge / smoke_bomb / flee）：
  //   比对逐怪进行，重名不要紧，而两只贼的招式一一对应、同名反而更好读。
  //   ⚠ 但它们的**数值与 RNG 消耗都不同**，见 enemies.ts / MOVE_TURN_BEGIN 的注释。
  BYRD_PECK: "peck",
  BYRD_SWOOP: "swoop",
  BYRD_CAW: "caw",
  BYRD_FLY: "fly",
  BYRD_HEADBUTT: "headbutt",
  BYRD_STUNNED: "stunned",
  MUGGER_MUG: "mug",
  MUGGER_LUNGE: "lunge",
  MUGGER_SMOKE_BOMB: "smoke_bomb",
  MUGGER_ESCAPE: "flee",
  // 分裂留下的空格：那只默认 `Monster` 的 `moveHistory[0]` 是 `MMID::INVALID`
  // （`monsterMoveStrings[0] == "INVALID"`，MonsterMoves.h:215）。我们的空占位
  // `currentMove` 是空串。⚠ 这一条只有那个空格用得到——所有真怪在 `MonsterGroup::init`
  // 里都 rollMove 过，意图不可能是 INVALID。
  INVALID: "",
};
// 药水在 trace 里是显示名。含熵酿填回来的未登记药水——它们只占槽位、不会被喝。
const POTION: Record<string, string | null> = {
  EMPTY: null,
  "Ancient Potion": "ancient_potion",
  "Attack Potion": "attack_potion",
  "Blessing Of The Forge": "blessing_of_the_forge",
  "Block Potion": "block_potion",
  "Blood Potion": "blood_potion",
  "Colorless Potion": "colorless_potion",
  "Cultist Potion": "cultist_potion",
  "Dexterity Potion": "dexterity_potion",
  "Distilled Chaos": "distilled_chaos",
  "Duplication Potion": "duplication_potion",
  "Elixir Potion": "elixir_potion",
  "Energy Potion": "energy_potion",
  "Entropic Brew": "entropic_brew",
  "Essence Of Steel": "essence_of_steel",
  "Explosive Potion": "explosive_potion",
  "Fairy Potion": "fairy_in_a_bottle",
  "Fear Potion": "fear_potion",
  "Fire Potion": "fire_potion",
  "Flex Potion": "flex_potion",
  "Fruit Juice": "fruit_juice",
  "Gamblers Brew": "gamblers_brew",
  "Heart Of Iron": "heart_of_iron_potion",
  "Liquid Bronze": "liquid_bronze",
  "Liquid Memories": "liquid_memories",
  "Power Potion": "power_potion",
  "Regen Potion": "regen_potion",
  "Skill Potion": "skill_potion",
  "Smoke Bomb": "smoke_bomb",
  "Snecko Oil": "snecko_oil",
  "Speed Potion": "speed_potion",
  "Strength Potion": "strength_potion",
  "Swift Potion": "swift_potion",
  "Weak Potion": "weak_potion",
};

const POWER: Record<string, string> = {
  RITUAL: "ritual",
  VULNERABLE: "vulnerable",
  WEAK: "weak",
  CURL_UP: "curl_up",
  STRENGTH: "strength",
  DEXTERITY: "dexterity",
  ARTIFACT: "artifact",
  THORNS: "thorns",
  VIGOR: "vigor",
  // —— 回合边界 Power（第三批）——
  METALLICIZE: "metallicize",
  COMBUST: "combust",
  DEMON_FORM: "demon_form",
  // 灵活的「回合末归还力量」标记，打出灵活那一帧就可见。
  LOSE_STRENGTH: "lose_strength",
  // 战斗恍惚的封抽牌标记，同上。
  NO_DRAW: "no_draw",
  // 纯 bool 状态：参考只置 bit、从不写 statusMap，harness 按 1 输出（见 trace_dump 的
  // playerStatusValue），我们这边也存 1。
  BARRICADE: "barricade",
  // —— 牌生命周期 Power（第五批）——
  BRUTALITY: "brutality",
  DARK_EMBRACE: "dark_embrace",
  EVOLVE: "evolve",
  FEEL_NO_PAIN: "feel_no_pain",
  // —— 事件钩子 Power（第六批）——
  FLAME_BARRIER: "flame_barrier",
  FIRE_BREATHING: "fire_breathing",
  JUGGERNAUT: "juggernaut",
  RAGE: "rage",
  RUPTURE: "rupture",
  // 应急按钮的「无法从牌获得格挡」。参考的枚举名是 NO_BLOCK，我们的 PowerId 叫
  // no_card_block（types.ts 早就这么定了，名字更准：拦的只有牌产生的格挡）。
  NO_BLOCK: "no_card_block",
  // —— 第七批 ——
  // 虚无缥缈：真的有层数（走 statusMap）。
  INTANGIBLE: "intangible",
  // 腐化：与壁垒同族的纯 bool 状态，harness 按 1 输出，我们也存 1 层。
  CORRUPTION: "corruption",
  // —— 第九批：从牌堆打出 / 复制打出 ——
  // 二连击：层数就是「还能额外结算几张攻击牌」，每触发一次递减一层。
  DOUBLE_TAP: "double_tap",
  // 混乱：层数就是「每回合开始打几张」，两张混乱叠成 2。
  MAYHEM: "mayhem",
  // —— 第十二批：怪物回合末触发 ——
  // 束缚：黑暗镣铐临时拿走的力量记在这里，怪物回合末（applyEndOfTurnTriggers）归还并清除。
  SHACKLED: "shackled",
  // —— 第十三批：尖刺史莱姆的舔舐 ——
  // 脆弱：获得的格挡 ×0.75。计算侧（calculateCardBlock）与回合末递减早就实现了，
  // 缺的只是这条映射——在此之前没有任何已登记的怪会施加它。
  FRAIL: "frail",
  // —— 第十五批 ——
  // 缠绕：玩家身上，封住攻击牌一个回合。
  ENTANGLED: "entangled",
  // 偷窃：**怪物身上**，抢劫者开局自带的 15 层，就是它每次抢劫偷走的上限。
  // 它一直挂在快照的 monsters[].powers 里，不映射会当场抛「未映射的 power」。
  THIEVERY: "thievery",
  // —— 第十六批 ——
  // 孢子云：**怪物身上**，真菌兽开局自带的 2 层（层数从不被读，只是「有没有」的标记）。
  // 与 THIEVERY 同理，它全程挂在 monsters[].powers 快照里。
  SPORE_CLOUD: "spore_cloud",
  // —— 第十七批 ——
  // 狂怒：**怪物身上**，狂暴地精开局自带的 1 层。与 SPORE_CLOUD / THIEVERY 不同的是
  // 它的层数**真的被读**——每次挨攻击就照这个层数涨力量（连打在格挡上也算）。
  ANGRY: "angry",
  // —— 第十八批 ——
  // 沉睡：**怪物身上**的纯 bool 标记（`isBooleanPower` 为真），harness 的
  // `getStatusInternal` 对这一族 `return true`，所以快照里恒是 `ASLEEP: 1`。
  // 被未被格挡的伤害打断时整条摘掉。
  ASLEEP: "asleep",
  // 激怒：**怪物身上**，地精头目咆哮之后才有（不是开局自带）。玩家每打出一张技能牌
  // 就照层数涨力量，层数本身不消耗。
  ENRAGE: "enrage",
  // ⚠ ARTIFACT / METALLICIZE 早就在表里（玩家侧的古代药水 / 金属化能力牌），
  // 本批是它们第一次出现在**怪物**身上：哨卫开局 `ARTIFACT: 1`、
  // 睡着的拉加维林 `METALLICIZE: 8`。同一个映射直接复用。
  // —— 第十九批 ——
  // 形态切换倒计时：**怪物身上**，守卫者开局自带（asc0 是 30 层）。每次掉血按未被格挡的
  // 伤害递减，归零时摘掉自己、把意图改成防御形态。双重猛击之后按新阈值（+10）重新挂上，
  // 所以它在快照里会**消失又出现**，值一路 30 → 40 → 50。
  MODE_SHIFT: "mode_shift",
  // 尖锐外壳：**怪物身上**，守卫者进防御形态时上 3 层、双重猛击打完摘掉。
  // 玩家每打出一张**攻击牌**就吃 3 点过格挡的伤害。
  SHARP_HIDE: "sharp_hide",
  // —— 第二十三批：第二幕开张 ——
  // 易塑：**怪物身上**，食蛇草开局自带 3 层。层数真的被读——每挨一次未被格挡的攻击就
  // 入队加 = 层数的格挡并 +1，回合末复位回 3。所以它在快照里会 3 → 4 → 5 → …回到 3。
  MALLEABLE: "malleable",
  // 诅咒：**玩家身上**，选民的诅咒上的纯 bool 状态（`Player::debuff` 对它走
  // `setHasStatus(true)` 而不写 statusMap，harness 因此按 1 输出，恒是 `HEX: 1`）。
  // 与壁垒 / 腐化同族。整场不递减。
  HEX: "hex",
  // ⚠ BARRICADE 早就在表里（玩家侧的壁垒能力牌），本批是它第一次出现在**怪物**身上：
  //   球状守卫者开局 `BARRICADE: 1`（格挡从此不在怪物回合开始清空）。
  //   ARTIFACT 同理，第十八批哨卫是 1 层，本批球状守卫者是 3 层。两个映射直接复用。
  // —— 第二十四批 ——
  // 飞行：**怪物身上**，拜鸟开局自带 3 层。受到未被格挡的攻击伤害就 -1，
  // 归零那一击摔下来（意图改成 `BYRD_STUNNED`），自己回合开始复位回 3，起飞再 **+3**。
  // ⚠ **层数会变成负数**：参考清层数走的是裸的 `setStatus(flight-1)`，不清 statusBits，
  //   所以摔下来之后继续挨打会一路减成 -1、-2……而 harness 的 `getStatusInternal` 照样
  //   输出（只有恰好 0 那一刻会因 `v == 0` 被折叠掉）。快照里因此能看到
  //   `FLIGHT: 3 → 2 → 1 →（消失）→ -1`。
  FLIGHT: "flight",
};

const mapPotion = (p: string): string | null => (p in POTION ? POTION[p]! : p);

const mapPowers = (p: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === 0) {
      continue;
    }
    const id = POWER[k];
    // 未映射的 power 必须**报错**，不能静默丢掉：丢掉的话「参考施加了某个我们没实现的
    // power」两边都是空对象，测试反而变绿——正是这类静默通过最危险。
    if (id === undefined) {
      throw new Error(`trace 里出现未映射的 power: ${k}=${String(v)}（请补进 POWER 映射表）`);
    }
    out[id] = v;
  }
  return out;
};

/** 把我方 BattleContext 折成与 trace 同构的形状，便于逐字段 diff。 */
function shape(bc: BattleContext): Record<string, unknown> {
  const powersOf = (ps: { id: string; amount: number }[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const p of ps) {
      if (p.amount !== 0) {
        out[p.id] = p.amount;
      }
    }
    return out;
  };
  return {
    turn: bc.turn,
    outcome: bc.outcome,
    // `start()` 传的是 HARNESS_GOLD_BASELINE，减回去就是「本场变化了多少」，
    // 与 harness 的 goldGained 同形。
    goldGained: bc.player.gold - HARNESS_GOLD_BASELINE,
    player: {
      hp: bc.player.hp,
      maxHp: bc.player.maxHp,
      block: bc.player.block,
      energy: bc.player.energy,
      powers: powersOf(bc.player.powers),
    },
    monsters: bc.monsters.map((m) => ({
      id: m.defId,
      hp: m.hp,
      maxHp: m.maxHp,
      block: m.block,
      alive: m.alive,
      move: m.currentMove,
      powers: powersOf(m.powers),
    })),
    hand: bc.hand.map((c) => c.defId),
    draw: bc.drawPile.map((c) => c.defId),
    discard: bc.discardPile.map((c) => c.defId),
    exhaust: bc.exhaustPile.map((c) => c.defId),
    potions: [...bc.potions],
    rng: {
      ai: bc.rng.aiRng.counter,
      hp: bc.rng.monsterHpRng.counter,
      shuffle: bc.rng.shuffleRng.counter,
      cardRandom: bc.rng.cardRandomRng.counter,
      misc: bc.rng.miscRng.counter,
      potion: bc.rng.potionRng.counter,
    },
  };
}

/** 把 trace 快照折成同构形状。 */
function shapeExpected(s: Snapshot): Record<string, unknown> {
  return {
    turn: s.turn,
    outcome: s.outcome,
    // harness 只在非零时输出这个字段（见 Snapshot.goldGained），缺省即 0。
    goldGained: s.goldGained ?? 0,
    player: {
      hp: s.player.hp,
      maxHp: s.player.maxHp,
      block: s.player.block,
      energy: s.player.energy,
      powers: mapPowers(s.player.powers),
    },
    monsters: s.monsters.map((m) => ({
      id: MONSTER[m.id] ?? m.id,
      hp: m.hp,
      maxHp: m.maxHp,
      block: m.block,
      alive: m.alive,
      move: MOVE[m.move] ?? m.move,
      powers: mapPowers(m.powers),
    })),
    hand: s.hand.map((c) => CARD[c] ?? c),
    draw: s.draw.map((c) => CARD[c] ?? c),
    discard: s.discard.map((c) => CARD[c] ?? c),
    exhaust: s.exhaust.map((c) => CARD[c] ?? c),
    potions: s.potions.map(mapPotion),
    rng: s.rng,
  };
}

const start = (t: Trace): BattleContext =>
  initCombat({
    seedLong: BigInt(t.seedLong),
    floorNum: t.floor,
    // 从 trace 读，不再写死 0：爬升度那条轴（第二十一批）就是靠这里点亮的。
    ascension: t.ascension ?? 0,
    encounterId: ENCOUNTER[t.encounter]!,
    deck: t.deck.map((c, i) => ({
      defId: CARD[c] ?? c,
      upgraded: (t.deckUpgraded?.[i] ?? 0) === 1,
    })),
    // 见 Trace.playerHp：`initial` 是 init **之后**的快照，血瓶已经加过血了。
    playerHp: t.playerHp ?? t.initial.player.hp,
    playerMaxHp: t.initial.player.maxHp,
    // 见 HARNESS_GOLD_BASELINE：偷金按绝对值钳制，起点必须与 harness 一致。
    gold: HARNESS_GOLD_BASELINE,
    character: "ironclad",
    relics: t.relics,
    potions: t.initial.potions.map(mapPotion),
    // harness 的快照按 `bc.potionCapacity` 输出药水槽，而 asc≥11 是 2 槽而不是 3
    // （GameContext.cpp:66）。不跟着传的话重放侧的 capacity 恒为 3，
    // 熵酿之类按 capacity 遍历槽位的地方会读到不存在的第 3 格。
    potionCapacity: t.initial.potions.length,
    // potionRng 是 run 级持久流，harness 明确把它钉在 Random(seed)。
    potionRng: new StsRandom(BigInt(t.potionRngSeed)),
  });

// 分组 = 编队 × 爬升度，与 `tools/split-traces.mjs` 的分文件键同形。
// 混在一个 describe 里的话，失败时看不出翻的是 asc0 还是 asc19 那一侧。
const byEncounter = new Map<string, Trace[]>();
for (const t of traces) {
  const key = t.ascension ? `${t.encounter}@asc${String(t.ascension)}` : t.encounter;
  const list = byEncounter.get(key) ?? [];
  list.push(t);
  byEncounter.set(key, list);
}

describe("trace 数据自身的不变量", () => {
  // HARNESS_GOLD_BASELINE 偏小时给一条比「第 N 步状态不符」直白得多的诊断：
  // 参考的金币不会为负（`stealGoldFromPlayer` 按 `min(gold, 额度)` 钳制、`gainGold` 只加），
  // 所以任何一条 `goldGained` 都不可能比入场值还负。
  // ⚠ 反方向（常数偏大）**测不出来**，数据里没有那份信息，见 HARNESS_GOLD_BASELINE 的注释。
  it(`每条快照的 goldGained 都不低于 -${HARNESS_GOLD_BASELINE}（金币不会为负）`, () => {
    let worst = 0;
    let where = "";
    for (const t of traces) {
      for (const s of [t.initial, ...t.steps.map((step) => step.after)]) {
        const d = s.goldGained ?? 0;
        if (d < worst) {
          worst = d;
          where = `${t.encounter} seed ${t.seed} @floor ${t.floor}`;
        }
      }
    }
    expect(
      worst,
      `最深的一次金币变化是 ${worst}（${where}）。它比 -HARNESS_GOLD_BASELINE 还低，` +
        `说明重放侧的入场金币常数比 harness 的小——偷金的钳制会提前生效，见 HARNESS_GOLD_BASELINE。`,
    ).toBeGreaterThanOrEqual(-HARNESS_GOLD_BASELINE);
  });
});

describe("sts-combat 逐帧重放参考项目真实战斗 trace", () => {
  for (const [encounter, list] of byEncounter) {
    describe(encounter, () => {
      for (const t of list) {
        // 牌组规格进标题：同一 (seed, floor) 现在有多条 trace（不同 deck variant），
        // 不标出来失败时看不出是哪一副牌组翻的。
        const variant = `${t.deck.length}张${t.deckUpgraded === undefined ? "" : "·升级"}`;
        it(`seed "${t.seed}" @floor ${t.floor} [${variant}]（${t.steps.length} 步）`, () => {
          const bc = start(t);
          expect(shape(bc)).toEqual(shapeExpected(t.initial));

          t.steps.forEach((step, i) => {
            if (step.action.type === "card") {
              const r = playCard(bc, step.action.idx!, step.action.target!);
              expect(r, `第 ${i + 1} 步出牌被拒: ${JSON.stringify(step.action)}`).toEqual({
                ok: true,
              });
            } else if (step.action.type === "potion") {
              const r = drinkPotion(bc, step.action.idx!, step.action.target!);
              expect(r, `第 ${i + 1} 步喝药水被拒: ${JSON.stringify(step.action)}`).toEqual({
                ok: true,
              });
            } else if (step.action.type === "select_card") {
              // 选牌屏单选。被拒**同样是失败**：说明我们这边压根没开屏、或开的是另一块屏、
              // 或候选集算错了——静默跳过会让整块机制看着是绿的。
              const r = selectCard(bc, step.action.idx!);
              expect(r, `第 ${i + 1} 步选牌被拒: ${JSON.stringify(step.action)}`).toEqual({
                ok: true,
              });
            } else if (step.action.type === "select_cards") {
              const r = selectCards(bc, step.action.idxs!);
              expect(r, `第 ${i + 1} 步多选被拒: ${JSON.stringify(step.action)}`).toEqual({
                ok: true,
              });
            } else {
              const r = endTurn(bc);
              expect(r, `第 ${i + 1} 步结束回合被拒`).toEqual({ ok: true });
            }
            expect(
              shape(bc),
              `第 ${i + 1} 步后状态不符（动作 ${JSON.stringify(step.action)}）`,
            ).toEqual(shapeExpected(step.after));
          });
        });
      }
    });
  }
});
