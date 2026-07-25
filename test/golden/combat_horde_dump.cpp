// Golden dumper for multi-monster combat + per-monster rollMove: Ironclad starter
// deck vs JAW_WORM_HORDE (three Jaw Worms, a fixed encounter that needs no miscRng).
// Companion to combat_dump.cpp (skeleton) and combat_play_dump.cpp (card play).
//
// Why this encounter: it is the cheapest way to exercise, in one fight,
//   * multi-monster init  — three interleaved monsterHpRng rolls, then three aiRng rolls
//   * per-monster turn order and targeting
//   * NON-CONSTANT aiRng consumption — Jaw Worm's getMoveForRoll adds a
//     randomBoolean(chance) in three of its branches, so a single rollMove burns
//     1 or 2 aiRng draws depending on move history (MonsterSpecific.cpp:2450).
//
// Reference details transcribed here:
//   MonsterGroup.cpp JAW_WORM_HORDE — after creating the three worms, each gets
//     +3 Strength / +5 Block (ascension 0) and moveHistory[0] is preset to a
//     non-INVALID sentinel, so the very first rollMove takes the roll branches
//     instead of firstTurn()'s unconditional CHOMP.
//   MonsterSpecific.cpp:850 — CHOMP 11 dmg; BELLOW +3 Str then +6 block;
//     THRASH 7 dmg then +5 block.
//   Actions.cpp:321 MonsterStartTurnAction -> applyPreTurnLogic zeroes monster block
//     when the monster phase begins, so the horde's opening block still absorbs the
//     player's first-turn attacks.
//   On PLAYER_LOSS executeActions breaks before running further queued actions, so
//     the killing monster's queued RollMove never fires — the sim mirrors that, since
//     a stray roll would desync aiRng's counter.
//
// Greedy policy (must match the TS driver exactly): repeatedly play the first
// affordable card in hand; attacks target the lowest-index living monster.

#include <cstdint>
#include <string>
#include <vector>
#include <iostream>
#include "game/Random.h"

using namespace sts;

// strike=0, defend=1, bash=2
static const int COST[3] = {1, 1, 2};

// move ids
enum Move { SENTINEL = 0, CHOMP, THRASH, BELLOW };
static const char *MOVE_NAME[4] = {"__preset__", "chomp", "thrash", "bellow"};

struct Worm {
    int hp = 0, block = 0, strength = 0, vuln = 0;
    bool alive = true;
    int history[2] = {SENTINEL, SENTINEL}; // history[0] = latest
    int histLen = 0;
};

struct Sim {
    Random aiRng, monsterHpRng, shuffleRng, cardRandomRng;

    int hp = 80, block = 0, energy = 0;
    std::vector<int> hand, drawPile, discardPile;
    std::vector<Worm> ms;
    int alive = 0;
    int turn = 1;
    int outcome = 0; // 0 undecided, 1 victory, 2 loss

    bool lastMove(const Worm &w, int id) const { return w.histLen >= 1 && w.history[0] == id; }
    bool lastTwo(const Worm &w, int id) const {
        return w.histLen >= 2 && w.history[0] == id && w.history[1] == id;
    }
    bool firstTurn(const Worm &w) const { return w.histLen == 0; }

    void setMove(Worm &w, int id) {
        w.history[1] = w.history[0];
        w.history[0] = id;
        if (w.histLen < 2) ++w.histLen;
    }

    // MonsterSpecific.cpp:2450 JAW_WORM
    int moveForRoll(Worm &w, int roll) {
        if (firstTurn(w)) return CHOMP;
        if (roll < 25) {
            if (lastMove(w, CHOMP)) return aiRng.randomBoolean(0.5625f) ? BELLOW : THRASH;
            return CHOMP;
        } else if (roll < 55) {
            if (lastTwo(w, THRASH)) return aiRng.randomBoolean(0.357f) ? CHOMP : BELLOW;
            return THRASH;
        } else if (lastMove(w, BELLOW)) {
            return aiRng.randomBoolean(0.416f) ? CHOMP : THRASH;
        }
        return BELLOW;
    }

    void rollMove(Worm &w) {
        int roll = aiRng.random(99);
        setMove(w, moveForRoll(w, roll));
    }

    int firstAliveIdx() const {
        for (size_t i = 0; i < ms.size(); ++i) if (ms[i].alive) return static_cast<int>(i);
        return -1;
    }

    // BattleContext::calculateCardDamage — player strength 0 here; Vulnerable is the
    // only modifier in play, and it is a flat *1.5f regardless of its stack count.
    int cardDamage(int base, int targetIdx) const {
        float d = static_cast<float>(base);
        if (targetIdx >= 0 && ms[targetIdx].vuln > 0) d *= 1.5f;
        int r = static_cast<int>(d);
        return r < 0 ? 0 : r;
    }
    int monsterDamage(const Worm &w, int base) const {
        float d = static_cast<float>(base + w.strength);
        int r = static_cast<int>(d);
        return r < 0 ? 0 : r;
    }

    void shufflePile(std::vector<int> &v) {
        java::Collections::shuffle(v.begin(), v.end(), java::Random(shuffleRng.randomLong()));
    }

    void draw(int count) {
        int toDraw = count;
        if (static_cast<int>(drawPile.size()) < toDraw) {
            int before = static_cast<int>(drawPile.size());
            for (int i = 0; i < before; ++i) { hand.push_back(drawPile.back()); drawPile.pop_back(); }
            toDraw -= before;
            if (!discardPile.empty()) {
                shufflePile(discardPile);
                drawPile = discardPile;
                discardPile.clear();
            }
        }
        int n = toDraw < static_cast<int>(drawPile.size()) ? toDraw : static_cast<int>(drawPile.size());
        for (int i = 0; i < n; ++i) { hand.push_back(drawPile.back()); drawPile.pop_back(); }
    }

    void attackMonster(int idx, int damage) {
        if (idx < 0 || !ms[idx].alive) return;
        if (damage < 0) damage = 0;
        Worm &w = ms[idx];
        int temp = damage;
        damage -= w.block;
        w.block -= temp; if (w.block < 0) w.block = 0;
        if (damage > 0) {
            w.hp -= damage;
            if (w.hp <= 0) {
                w.hp = 0; w.alive = false; --alive;
                if (alive == 0) outcome = 1;
            }
        }
    }

    void playCard(int handIdx) {
        int card = hand[handIdx];
        int target = firstAliveIdx();
        // damage/block are computed at ENQUEUE time, before the card resolves
        int dmg = 0, blk = 0;
        if (card == 0) dmg = cardDamage(6, target);
        else if (card == 1) blk = 5;
        else dmg = cardDamage(8, target);

        hand.erase(hand.begin() + handIdx);
        energy -= COST[card];

        if (card == 0 || card == 2) attackMonster(target, dmg);
        if (card == 1) block += blk;
        // Bash's Vulnerable lands after its own hit, and only if the target survived.
        if (card == 2 && target >= 0 && ms[target].alive) ms[target].vuln += 2;
        discardPile.push_back(card);
    }

    std::vector<int> playGreedy() {
        std::vector<int> played;
        if (outcome) return played;
        for (;;) {
            int pick = -1;
            for (size_t i = 0; i < hand.size(); ++i)
                if (COST[hand[i]] <= energy) { pick = static_cast<int>(i); break; }
            if (pick < 0) break;
            played.push_back(hand[pick]);
            playCard(pick);
            if (outcome) break;
        }
        return played;
    }

    void takeTurn(Worm &w) {
        int move = w.history[0];
        if (move == CHOMP) {
            int d = monsterDamage(w, 11);
            int abs = d < block ? d : block;
            block -= abs; hp -= (d - abs);
            if (hp <= 0) { hp = 0; outcome = 2; }
        } else if (move == THRASH) {
            int d = monsterDamage(w, 7);
            int abs = d < block ? d : block;
            block -= abs; hp -= (d - abs);
            if (hp <= 0) { hp = 0; outcome = 2; return; }
            w.block += 5;
        } else if (move == BELLOW) {
            w.strength += 3;
            if (outcome) return;
            w.block += 6;
        }
    }

    void endTurn() {
        for (int c : hand) discardPile.push_back(c);
        hand.clear();

        // monster phase begins: block cleared for every living monster
        for (auto &w : ms) if (w.alive) w.block = 0;

        for (size_t i = 0; i < ms.size(); ++i) {
            if (outcome) break;
            if (!ms[i].alive) continue;
            takeTurn(ms[i]);
            if (outcome) break;   // PLAYER_LOSS: queued RollMove never runs
            rollMove(ms[i]);
        }
        if (outcome) return;

        // end of round powers: player-applied Vulnerable decays (no justApplied skip)
        for (auto &w : ms) if (w.alive && w.vuln > 0) --w.vuln;

        ++turn;
        block = 0;
        draw(5);
        energy = 3;
    }
};

static void printArr(const std::vector<int> &v) {
    std::cout << "[";
    for (size_t i = 0; i < v.size(); ++i) { if (i) std::cout << ","; std::cout << v[i]; }
    std::cout << "]";
}

struct Case { const char *seed; long long seedLong; int floor; };

int main() {
    std::vector<Case> cases = {
        {"1RGBGHNF7L", 138414915365391LL, 1},
        {"SLAYTHESPIRE", 2665621045298406349LL, 1},
        {"0", 0LL, 1},
        {"3IX8N7ZPAA5", 9766940983340980LL, 1},
        {"NEOWLIVES", 52737824750267LL, 1},
        {"SLAYTHESPIRE", 2665621045298406349LL, 7},
    };

    std::cout << "{\"cases\":[";
    for (size_t ci = 0; ci < cases.size(); ++ci) {
        const Case &c = cases[ci];
        if (ci) std::cout << ",";

        Sim s;
        Random start(static_cast<std::uint64_t>(c.seedLong + c.floor));
        s.aiRng = start; s.monsterHpRng = start; s.shuffleRng = start; s.cardRandomRng = start;

        // --- monsters.init: three HP rolls, then horde setup, then three rollMoves ---
        s.ms.resize(3);
        for (int i = 0; i < 3; ++i) s.ms[i].hp = s.monsterHpRng.random(40, 44);
        s.alive = 3;
        for (int i = 0; i < 3; ++i) {
            s.ms[i].strength += 3;
            s.ms[i].block += 5;
            s.ms[i].history[0] = SENTINEL;
            s.ms[i].histLen = 1;      // preset sentinel => firstTurn() is false
        }
        for (int i = 0; i < 3; ++i) s.rollMove(s.ms[i]);

        // --- cards.init + opening draw ---
        s.drawPile = {0,0,0,0,0,1,1,1,1,2};
        s.shufflePile(s.drawPile);
        s.energy += 3;
        s.draw(5);

        std::cout << "{\"seed\":\"" << c.seed << "\",\"seedLong\":\"" << c.seedLong
                  << "\",\"floor\":" << c.floor << ",\"initHps\":";
        {
            std::vector<int> hps; for (auto &w : s.ms) hps.push_back(w.hp);
            printArr(hps);
        }
        std::cout << ",\"initIntents\":[";
        for (int i = 0; i < 3; ++i) {
            if (i) std::cout << ",";
            std::cout << "\"" << MOVE_NAME[s.ms[i].history[0]] << "\"";
        }
        std::cout << "],\"aiRngAfterInit\":" << s.aiRng.counter << ",\"turns\":[";

        for (int t = 0; t < 4; ++t) {
            if (t) std::cout << ",";
            std::vector<int> played = s.playGreedy();
            std::vector<int> hps, blocks, strs;
            for (auto &w : s.ms) { hps.push_back(w.alive ? w.hp : 0); blocks.push_back(w.block); strs.push_back(w.strength); }
            std::cout << "{\"turn\":" << s.turn << ",\"played\":";
            printArr(played);
            std::cout << ",\"monsterHps\":"; printArr(hps);
            std::cout << ",\"monsterBlocks\":"; printArr(blocks);
            std::cout << ",\"monsterStrengths\":"; printArr(strs);
            std::cout << ",\"playerHp\":" << s.hp
                      << ",\"playerBlock\":" << s.block
                      << ",\"aiRng\":" << s.aiRng.counter
                      << ",\"outcome\":" << s.outcome << "}";
            s.endTurn();
        }

        std::cout << "],\"final\":{\"turn\":" << s.turn
                  << ",\"playerHp\":" << s.hp
                  << ",\"outcome\":" << s.outcome
                  << ",\"intents\":[";
        for (int i = 0; i < 3; ++i) {
            if (i) std::cout << ",";
            std::cout << "\"" << MOVE_NAME[s.ms[i].history[0]] << "\"";
        }
        std::cout << "],\"counters\":{\"aiRng\":" << s.aiRng.counter
                  << ",\"monsterHpRng\":" << s.monsterHpRng.counter
                  << ",\"shuffleRng\":" << s.shuffleRng.counter
                  << ",\"cardRandomRng\":" << s.cardRandomRng.counter << "}}}";
    }
    std::cout << "]}" << std::endl;
    return 0;
}
