// Golden dumper for the in-combat potion path, and for the only stream the earlier
// fixtures never touched: potionRng.
//
// The interesting one is ENTROPIC_BREW. returnRandomPotion is a rejection sampler, so
// the number of potionRng draws per potion is data-dependent, not fixed:
//
//   roll = potionRng.random(0,99)            -> rarity bucket (65/25/10 split)
//   temp = getRandomPotion()                 -> potionRng.random(32)
//   while (rarity(temp) != target || spamCheck) { ... temp = getRandomPotion(); }
//
// with `limited=true` (which Entropic Brew passes) spamCheck starts true, so the loop
// ALWAYS runs at least one extra draw, and keeps going while it keeps rolling Fruit
// Juice. Net effect: limited mode excludes Fruit Juice and burns an irregular number of
// draws. A "roll once per potion" implementation produces perfectly plausible potions
// and a completely different stream — hence this fixture.
//
// Reference transcribed:
//   Game.cpp:294 returnRandomPotion / :309 returnRandomPotionOfRarity / :322 getRandomPotion
//   Potions.h:243 PotionPool (33 per class; first 3 class-specific, next 30 shared)
//   Potions.h potionRarities
//   BattleContext.cpp:2217 obtainPotion / :2234 discardPotion / :2240 drinkPotion
//     (drinkPotion empties the slot BEFORE resolving, so Entropic Brew refills the very
//      slot it was drunk from)
//
// Scenario: Ironclad vs one Cultist, three potions in hand: block, fire, entropic brew.

#include <cstdint>
#include <string>
#include <vector>
#include <iostream>
#include "game/Random.h"

using namespace sts;

// Ironclad pool, in reference order. Index is what getRandomPotion maps onto.
static const char *POOL[33] = {
    "blood_potion", "elixir_potion", "heart_of_iron_potion",
    "block_potion", "dexterity_potion", "energy_potion", "explosive_potion", "fire_potion",
    "strength_potion", "swift_potion", "weak_potion", "fear_potion", "attack_potion",
    "skill_potion", "power_potion", "colorless_potion", "flex_potion", "speed_potion",
    "blessing_of_the_forge", "regen_potion", "ancient_potion", "liquid_bronze",
    "gamblers_brew", "essence_of_steel", "duplication_potion", "distilled_chaos",
    "liquid_memories", "cultist_potion", "fruit_juice", "snecko_oil", "fairy_in_a_bottle",
    "smoke_bomb", "entropic_brew",
};
// 0 common, 1 uncommon, 2 rare — aligned index-for-index with POOL above.
static const int RARITY[33] = {
    0, 1, 2,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 1, 1, 1,
    1, 1, 1, 1,
    1, 2, 2, 2, 2,
    2, 2,
};

struct Sim {
    Random potionRng;

    int getRandomPotionIdx() { return potionRng.random(32); }

    int returnRandomPotionOfRarity(int rarity, bool limited) {
        int temp = getRandomPotionIdx();
        bool spamCheck = limited;
        while (RARITY[temp] != rarity || spamCheck) {
            spamCheck = limited;
            temp = getRandomPotionIdx();
            if (std::string(POOL[temp]) != "fruit_juice") spamCheck = false;
        }
        return temp;
    }

    int returnRandomPotion(bool limited) {
        int roll = potionRng.random(0, 99);
        int rarity = roll < 65 ? 0 : (roll < 90 ? 1 : 2);
        return returnRandomPotionOfRarity(rarity, limited);
    }
};

struct Case { const char *seed; long long seedLong; int floor; };

int main() {
    std::vector<Case> cases = {
        {"1RGBGHNF7L", 138414915365391LL, 1},
        {"SLAYTHESPIRE", 2665621045298406349LL, 1},
        {"0", 0LL, 1},
        {"3IX8N7ZPAA5", 9766940983340980LL, 1},
        {"NEOWLIVES", 52737824750267LL, 1},
        {"SLAYTHESPIRE", 2665621045298406349LL, 9},
    };

    std::cout << "{\"cases\":[";
    for (size_t ci = 0; ci < cases.size(); ++ci) {
        const Case &c = cases[ci];
        if (ci) std::cout << ",";

        Sim s;
        s.potionRng = Random(static_cast<std::uint64_t>(c.seedLong + c.floor));

        // Entropic Brew was drunk from slot 2, so all three slots are empty and get
        // refilled: potionCapacity draws, each with its own rejection loop.
        std::vector<std::string> filled;
        std::vector<int> counterAfterEach;
        for (int i = 0; i < 3; ++i) {
            filled.push_back(POOL[s.returnRandomPotion(true)]);
            counterAfterEach.push_back(s.potionRng.counter);
        }

        std::cout << "{\"seed\":\"" << c.seed << "\",\"seedLong\":\"" << c.seedLong
                  << "\",\"floor\":" << c.floor << ",\"brewFilled\":[";
        for (size_t i = 0; i < filled.size(); ++i) {
            if (i) std::cout << ",";
            std::cout << "\"" << filled[i] << "\"";
        }
        std::cout << "],\"potionRngAfterEach\":[";
        for (size_t i = 0; i < counterAfterEach.size(); ++i) {
            if (i) std::cout << ",";
            std::cout << counterAfterEach[i];
        }
        std::cout << "],\"potionRngFinal\":" << s.potionRng.counter << "}";
    }
    std::cout << "]}" << std::endl;
    return 0;
}
