import { describe, it, expect } from "vitest";
import {
  initCombat,
  playCard,
  drinkPotion,
  probe,
  SUPPORTED_MONSTER_IDS,
} from "../src/engine/sts-combat.js";
import { IRONCLAD_STARTER_DECK } from "../src/engine/cards/cards.js";
import { ALL_ENEMIES } from "../src/engine/enemies/enemies.js";

// trace 重放只会走合法动作（策略从参考的 isValidAction 里挑），所以**拒绝路径**
// 永远不会出现在 trace 里。这里单独钉住它们：非法输入必须被明确拒绝，且状态不动。

const battle = (potions: (string | null)[] = [null, null, null]) =>
  initCombat({
    seedLong: 138414915365391n,
    floorNum: 1,
    ascension: 0,
    encounterId: "cultist",
    deck: IRONCLAD_STARTER_DECK.map((defId) => ({ defId, upgraded: false })),
    playerHp: 80,
    playerMaxHp: 80,
    character: "ironclad",
    potions,
  });

describe("sts-combat 非法动作的拒绝路径", () => {
  it("能量不足时拒绝出牌，且状态完全不变", () => {
    const bc = battle();
    bc.player.energy = 0;
    const before = probe(bc);
    const r = playCard(bc, 0, 0);
    expect(r.ok).toBe(false);
    expect(probe(bc)).toEqual(before);
  });

  it("手牌下标越界被拒绝", () => {
    const bc = battle();
    expect(playCard(bc, 99, 0).ok).toBe(false);
  });

  it("指向性牌打向无效目标被拒绝", () => {
    const bc = battle();
    bc.monsters[0]!.alive = false;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    expect(playCard(bc, idx, 0).ok).toBe(false);
  });

  it("空药水槽被拒绝", () => {
    const bc = battle();
    expect(drinkPotion(bc, 0)).toEqual({ ok: false, reason: "药水槽 0 为空" });
  });

  it("未登记的药水被明确拒绝，而不是静默跳过", () => {
    // 静默跳过会让 potionRng 与战斗状态悄悄错位，比直接失败危险得多。
    //
    // ⚠⚠ **样本从 `snecko_oil` 换成 `essence_of_darkness`（第四十五批登记了蛇形油）**，
    //   而这一次换的是**永久样本**，与卡牌那条 `seek` 同族：
    //   ① 参考的 `Actions::EssenceOfDarkness` 直接 `return sts::Action();`
    //      （Actions.cpp:915-917）——那是一个 `actFunc` 为空的 `std::function`，
    //      `executeActions` 里那句 `a(*this)` 会抛 `std::bad_function_call`、
    //      整个 harness 当场终止。**它永远拿不到预言机。**
    //   ② 它还需要充能球模型（机器人专属），本项目没有。
    //   两条理由各自独立、都是结构性的。同族的还有 `potion_of_capacity`
    //   （`Actions::IncreaseOrbSlots` 同样是空 Action）与 `poison_potion`
    //   （`Actions::PoisonLoseHpAction` 同样是空 Action，只是延迟到怪物回合才炸）。
    const bc = battle([null, "essence_of_darkness", null]);
    const r = drinkPotion(bc, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("暂未登记药水");
    }
    expect(probe(bc).potions).toEqual([null, "essence_of_darkness", null]);
  });

  it("战斗结束后拒绝一切动作", () => {
    const bc = battle(["block_potion", null, null]);
    bc.monsters[0]!.hp = 1;
    const idx = bc.hand.findIndex((c) => c.defId === "strike");
    playCard(bc, idx, 0);
    expect(probe(bc).outcome).toBe("player_victory");
    expect(playCard(bc, 0, 0).ok).toBe(false);
    expect(drinkPotion(bc, 0).ok).toBe(false);
  });

  it("状态牌打不出来——但报的是「打不出来」而不是「暂未登记」", () => {
    // 第五批之后灼伤 / 伤口 / 眩晕真的会躺在手里。它们在 CARD_RULES 里**没有**条目
    // （参考的 canUse 就不让打），所以少了这道门会一路走到「暂未登记卡牌行为」并抛错——
    // 那个错会把「登记了但打不出来」误报成「没登记」，指错方向。
    const bc = battle();
    // cost/costForTurn 的 -2 是参考 getEnergyCost 给「打不出的状态/诅咒牌」的哨兵值
    // （见 CombatCard 注释），照建实例的规则填。
    bc.hand.push({
      uid: 900,
      defId: "wound",
      upgraded: false,
      cost: -2,
      costForTurn: -2,
      specialData: 0,
    });
    const before = probe(bc);
    const r = playCard(bc, bc.hand.length - 1, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("状态牌");
    }
    expect(probe(bc)).toEqual(before);
  });

  it("固有牌多于起手数时补抽差额（trace 牌组够不到这一支）", () => {
    // 对齐 CardManager::init 末尾的 `if (innateCount > cardDrawPerTurn) DrawCards(差额)`。
    // trace 牌组只有 2~3 张固有牌，永远走不到，所以这条分支只能在这里守。
    const bc = initCombat({
      seedLong: 138414915365391n,
      floorNum: 1,
      ascension: 0,
      encounterId: "cultist",
      // 8 张固有 + 2 张非固有：起手应该是 8 张（5 + 差额 3），且全是固有牌。
      deck: [...new Array<string>(8).fill("dramatic_entrance"), "strike", "defend"].map(
        (defId) => ({ defId, upgraded: false }),
      ),
      playerHp: 80,
      playerMaxHp: 80,
    });
    expect(bc.hand.map((c) => c.defId)).toEqual(new Array<string>(8).fill("dramatic_entrance"));
    expect(bc.drawPile).toHaveLength(2);
  });

  // ⚠⚠ **第四十七批：这条用例换了断言，因为它的样本被彻底用光了。**
  //
  //   它原先的形状是「拿一只**在 `enemies.ts` 里、却不在 `MOVE_RULES` 里**的怪去开战，
  //   断言 `initCombat` 抛错」，样本一路是 `three_sentries`（第十八批顶掉）→
  //   `giant_head`（第三十五批）→ `donu_deca`（第三十九批）→ `corrupt_heart`
  //   （第三十九批给它补了一条**只有血量、没有招式**的 def 专门当样本）。
  //
  //   第四十七批把 `MOVE_RULES` 铺满到 **65 / 65**——参考的 `MonsterId` 枚举一共就 65 项
  //   （`MonsterIds.h`），所以「在数据表里却没有出招规则」的怪**一只都不存在了**。
  //   ⚠ WORKFLOW 的「附：踩过的坑」明确禁止为此**造一只游戏里不存在的哨兵怪**：
  //     那是发明数据，而且它会混进 `enemies.ts` 的遍历型用例里。
  //
  //   所以这条用例改成断言**让那道 throw 不可达的不变量本身**，而且是双向的。
  //   它比原来那条**更强**：原来只证明「有一只没登记的会抛错」，现在证明「一只没登记的
  //   都没有」；而且它**不会再被下一批顶掉**（怪物线已经收官）。
  // ⚠ `rollMove` 里那句 throw **留着**，它守的是「参考将来加了第 66 只怪、而我们只补了
  //   `enemies.ts`」这种情况——那时这条用例会先红，throw 是第二道闸。
  // ⚠ 与它同源的另一条用例（`sts-combat-wiring.test.ts` 的「未迁移编队」）**没有**这个
  //   问题：那一条只需要一个「不在 `SUPPORTED_ENCOUNTERS` 里的字符串」，而编队还剩 6 个。
  it("enemies.ts 的每一只怪都有出招规则（65 / 65，那道 throw 因此不可达）", () => {
    const registered = new Set(SUPPORTED_MONSTER_IDS);
    const inTable = new Set(ALL_ENEMIES.map((d) => d.id));
    for (const def of ALL_ENEMIES) {
      expect(registered.has(def.id), `${def.id} 在 enemies.ts 里却没有 MOVE_RULES`).toBe(true);
    }
    // 反方向：`MOVE_RULES` 里也不许有 `enemies.ts` 没有的 id（那种 id 永远走不到，
    // 属于「预言机侧可达、产品侧不可达」那一族，与第四十三批 `bloody_idol` 同源）。
    for (const id of SUPPORTED_MONSTER_IDS) {
      expect(inTable.has(id), `${id} 有 MOVE_RULES 却不在 enemies.ts 里`).toBe(true);
    }
    // 参考的 `MonsterId` 枚举一共 65 项，两边都必须恰好是这个数。
    expect(registered.size).toBe(65);
    expect(inTable.size).toBe(65);
  });
});
