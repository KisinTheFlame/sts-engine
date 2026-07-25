// Golden dumper for the sts-combat skeleton layer: a minimal single-Cultist
// battle against an Ironclad starter deck. Transcribes BattleContext::init's RNG
// consumption order verbatim against Random.h:
//   monsters.init : monsterHpRng.random(48,54) for Cultist HP
//                   aiRng.random(99) for the initial intent roll (first = INCANTATION)
//   cards.init    : one shuffleRng.randomLong() seeds a java::Random, then
//                   java::Collections::shuffle over the deck index array
//   draw          : pop 5 from the top (= back of the pile vector)
// then one end-turn / monster-turn cycle: Cultist INCANTATION (no RNG) → rollMove
// (aiRng.random(99), next intent = DARK_STRIKE) → new turn draws 5 (exact, no reshuffle).
//
// Counters are read straight off the Random objects (bc.*Rng.counter) so the golden
// records what the reference primitives actually did, not a hand-coded assumption.
//
// Cultist HP range {48,54} (asc<7): include/constants/MonsterIds.h monsterHpRange[CULTIST].
// Cultist getMoveForRoll: no history → INCANTATION else DARK_STRIKE (MonsterSpecific.cpp:2280).
// Draw top = back of pile: CardManager::popFromDrawPile = drawPile.back()+pop_back().

#include <cstdint>
#include <string>
#include <vector>
#include <iostream>
#include "game/Random.h"

using namespace sts;

// Ironclad starter deck, obtain order: 5 Strike, 4 Defend, 1 Bash.
// Encoded strike=0, defend=1, bash=2 (all strikes/defends are shuffle-identical).
static std::vector<int> starterDeck() {
    return {0, 0, 0, 0, 0, 1, 1, 1, 1, 2};
}

struct Case {
    const char *seed;
    long long seedLong;
    int floor;
};

static void printIntArr(const std::vector<int> &v) {
    std::cout << "[";
    for (size_t i = 0; i < v.size(); ++i) {
        if (i) std::cout << ",";
        std::cout << v[i];
    }
    std::cout << "]";
}

int main() {
    std::vector<Case> cases = {
        {"1RGBGHNF7L", 138414915365391LL, 1},
        {"SLAYTHESPIRE", 2665621045298406349LL, 1},
        {"0", 0LL, 1},
        {"3IX8N7ZPAA5", 9766940983340980LL, 1},
        {"NEOWLIVES", 52737824750267LL, 1},
        {"SLAYTHESPIRE", 2665621045298406349LL, 5},
    };

    std::cout << "{\"cases\":[";
    for (size_t ci = 0; ci < cases.size(); ++ci) {
        const Case &c = cases[ci];
        if (ci) std::cout << ",";

        const long long base = c.seedLong + c.floor;
        Random start(static_cast<std::uint64_t>(base));
        // Four combat streams re-seeded per battle as byte-copies of startRandom.
        Random aiRng = start;
        Random monsterHpRng = start;
        Random shuffleRng = start;
        Random cardRandomRng = start;

        // --- monsters.init ---
        const int hp = monsterHpRng.random(48, 54); // Cultist HP
        aiRng.random(99);                            // initial intent roll (INCANTATION)
        const std::string intent0 = "incantation";

        // --- cards.init ---
        std::vector<int> pile = starterDeck();
        java::Collections::shuffle(pile.begin(), pile.end(),
                                   java::Random(shuffleRng.randomLong()));

        // --- draw 5 (top = back) ---
        std::vector<int> hand;
        for (int i = 0; i < 5; ++i) {
            hand.push_back(pile.back());
            pile.pop_back();
        }
        std::vector<int> draw = pile;              // remaining [0..5) in natural order
        const std::vector<int> drawAfterInit = draw; // snapshot before the turn mutates `draw`

        const int aiAfterInit = aiRng.counter;
        const int hpAfterInit = monsterHpRng.counter;
        const int shufAfterInit = shuffleRng.counter;
        const int cardAfterInit = cardRandomRng.counter;

        // --- end turn → Cultist takes turn (INCANTATION, no RNG) → rollMove next intent ---
        aiRng.random(99); // next intent roll (DARK_STRIKE)
        const std::string intent1 = "dark_strike";
        // new turn: draw 5, drawPile has exactly 5 → no reshuffle
        std::vector<int> hand2;
        for (int i = 0; i < 5; ++i) {
            hand2.push_back(draw.back());
            draw.pop_back();
        }

        std::cout << "{"
                  << "\"seed\":\"" << c.seed << "\","
                  << "\"seedLong\":\"" << c.seedLong << "\","
                  << "\"floor\":" << c.floor << ","
                  << "\"afterInit\":{"
                  << "\"hp\":" << hp << ","
                  << "\"intent\":\"" << intent0 << "\","
                  << "\"hand\":";
        printIntArr(hand);
        std::cout << ",\"draw\":";
        printIntArr(drawAfterInit);
        std::cout << ",\"counters\":{"
                  << "\"aiRng\":" << aiAfterInit << ","
                  << "\"monsterHpRng\":" << hpAfterInit << ","
                  << "\"shuffleRng\":" << shufAfterInit << ","
                  << "\"cardRandomRng\":" << cardAfterInit << "},"
                  << "\"turn\":1"
                  << "},"
                  << "\"afterTurn1\":{"
                  << "\"intent\":\"" << intent1 << "\","
                  << "\"hand\":";
        printIntArr(hand2);
        std::cout << ",\"counters\":{"
                  << "\"aiRng\":" << aiRng.counter << ","
                  << "\"monsterHpRng\":" << monsterHpRng.counter << ","
                  << "\"shuffleRng\":" << shuffleRng.counter << ","
                  << "\"cardRandomRng\":" << cardRandomRng.counter << "},"
                  << "\"turn\":2"
                  << "}"
                  << "}";
    }
    std::cout << "]}" << std::endl;
    return 0;
}
