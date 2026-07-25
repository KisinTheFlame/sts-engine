// Golden dumper for VARIANT encounters — the composition itself is rolled at combat
// start. Ironclad starter deck vs THREE_LOUSE, whose members are picked by miscRng.
//
// The point of this fixture is the INTERLEAVING. MonsterGroup::createMonsters calls
// getLouse(miscRng) and createMonster back to back per slot, and Monster::construct
// rolls HP and then the louse's fixed bite damage, so the stream order is
//     misc, hp, hp,  misc, hp, hp,  misc, hp, hp
// and NOT "pick all three, then roll all three". Getting this wrong still yields a
// plausible-looking fight, which is exactly why it is pinned here.
//
// After that: three aiRng rolls for the opening intents, then preBattleAction gives
// each louse Curl Up with another monsterHpRng roll — note it lands AFTER every HP
// roll and AFTER every rollMove, not next to its own monster's construction.
//
// Reference points transcribed:
//   MonsterGroup.cpp:555 getLouse   — miscRng.randomBoolean() ? RED : GREEN
//   MonsterGroup.cpp:424 THREE_LOUSE
//   Monster.cpp:109 construct       — initHp, then miscInfo = monsterHpRng.random(5,7)
//   MonsterSpecific.cpp:300         — Curl Up = monsterHpRng.random(3,7)
//   MonsterSpecific.cpp:2583/2313   — RED/GREEN getMoveForRoll (pure roll, no extra aiRng)
//   Monster.cpp:339 attackedUnblockedHelper — Curl Up queues block then clears itself,
//                                     so the triggering hit still lands in full
//   HP ranges MonsterIds.h:174/188  — GREEN {11,17}, RED {10,15}
//   Player weak/vulnerable decay    — Player::applyAtEndOfRoundPowers, decrementIfNotJustApplied;
//                                     a monster-applied debuff DOES skip its first decrement.

#include <cstdint>
#include <string>
#include <vector>
#include <iostream>
#include "game/Random.h"

using namespace sts;

static const int COST[3] = {1, 1, 2};

enum Species { RED = 0, GREEN = 1 };
enum Move { BITE = 0, GROW = 1, SPIT_WEB = 2, NONE = 3 };
static const char *MOVE_NAME[4] = {"bite", "grow", "spit_web", ""};

struct Louse {
    int species = RED;
    int hp = 0, block = 0, strength = 0, vuln = 0;
    int rolledDamage = 0, curlUp = 0;
    bool alive = true;
    int history[2] = {NONE, NONE};
    int histLen = 0;
};

struct Sim {
    Random aiRng, monsterHpRng, shuffleRng, cardRandomRng, miscRng;

    int hp = 80, block = 0, energy = 0;
    int weak = 0; bool weakJustApplied = false;
    std::vector<int> hand, drawPile, discardPile;
    std::vector<Louse> ms;
    int alive = 0, turn = 1, outcome = 0; // 0 undecided, 1 victory, 2 loss

    bool lastMove(const Louse &w, int id) const { return w.histLen >= 1 && w.history[0] == id; }
    bool lastTwo(const Louse &w, int id) const {
        return w.histLen >= 2 && w.history[0] == id && w.history[1] == id;
    }
    void setMove(Louse &w, int id) {
        w.history[1] = w.history[0]; w.history[0] = id;
        if (w.histLen < 2) ++w.histLen;
    }

    int moveForRoll(Louse &w, int roll) {
        const int buffMove = (w.species == RED) ? GROW : SPIT_WEB;
        if (roll < 25) {
            if (lastMove(w, buffMove) && lastTwo(w, buffMove)) return BITE; // asc < 17
            return buffMove;
        } else if (lastTwo(w, BITE)) {
            return buffMove;
        }
        return BITE;
    }
    void rollMove(Louse &w) { int roll = aiRng.random(99); setMove(w, moveForRoll(w, roll)); }

    int firstAliveIdx() const {
        for (size_t i = 0; i < ms.size(); ++i) if (ms[i].alive) return static_cast<int>(i);
        return -1;
    }

    // BattleContext::calculateCardDamage
    int cardDamage(int base, int targetIdx) const {
        float d = static_cast<float>(base);   // player strength 0
        if (weak > 0) d *= 0.75f;
        if (targetIdx >= 0 && ms[targetIdx].vuln > 0) d *= 1.5f;
        int r = static_cast<int>(d);
        return r < 0 ? 0 : r;
    }
    int monsterDamage(const Louse &w, int base) const {
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
                drawPile = discardPile; discardPile.clear();
            }
        }
        int n = toDraw < static_cast<int>(drawPile.size()) ? toDraw : static_cast<int>(drawPile.size());
        for (int i = 0; i < n; ++i) { hand.push_back(drawPile.back()); drawPile.pop_back(); }
    }

    void attackMonster(int idx, int damage) {
        if (idx < 0 || !ms[idx].alive) return;
        if (damage < 0) damage = 0;
        Louse &w = ms[idx];
        int temp = damage;
        damage -= w.block;
        w.block -= temp; if (w.block < 0) w.block = 0;
        if (damage <= 0) return;

        // Curl Up: block is queued (addToBot) and the status clears, so this very hit
        // still goes through undiminished.
        int curl = 0;
        if (w.curlUp > 0) { curl = w.curlUp; w.curlUp = 0; }

        w.hp -= damage;
        if (w.hp <= 0) {
            w.hp = 0; w.alive = false; --alive;
            if (alive == 0) outcome = 1;
        }
        if (curl > 0 && w.alive) w.block += curl;
    }

    void playCard(int handIdx) {
        int card = hand[handIdx];
        int target = firstAliveIdx();
        int dmg = 0, blk = 0;
        if (card == 0) dmg = cardDamage(6, target);
        else if (card == 1) blk = 5;
        else dmg = cardDamage(8, target);

        hand.erase(hand.begin() + handIdx);
        energy -= COST[card];

        if (card == 0 || card == 2) attackMonster(target, dmg);
        if (card == 1) block += blk;
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

    void takeTurn(Louse &w) {
        int move = w.history[0];
        if (move == BITE) {
            int d = monsterDamage(w, w.rolledDamage);
            int abs = d < block ? d : block;
            block -= abs; hp -= (d - abs);
            if (hp <= 0) { hp = 0; outcome = 2; }
        } else if (move == GROW) {
            w.strength += 3;
        } else if (move == SPIT_WEB) {
            weak += 2; weakJustApplied = true;   // isSourceMonster => skips first decay
        }
    }

    void endTurn() {
        for (int c : hand) discardPile.push_back(c);
        hand.clear();

        for (auto &w : ms) if (w.alive) w.block = 0;   // applyPreTurnLogic

        for (size_t i = 0; i < ms.size(); ++i) {
            if (outcome) break;
            if (!ms[i].alive) continue;
            takeTurn(ms[i]);
            if (outcome) break;
            rollMove(ms[i]);
        }
        if (outcome) return;

        // end of round: player debuffs first, then monster ones
        if (weak > 0) {
            if (weakJustApplied) weakJustApplied = false;
            else --weak;
        }
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
        {"SLAYTHESPIRE", 2665621045298406349LL, 3},
    };

    std::cout << "{\"cases\":[";
    for (size_t ci = 0; ci < cases.size(); ++ci) {
        const Case &c = cases[ci];
        if (ci) std::cout << ",";

        Sim s;
        Random start(static_cast<std::uint64_t>(c.seedLong + c.floor));
        s.aiRng = start; s.monsterHpRng = start; s.shuffleRng = start; s.cardRandomRng = start;
        // miscRng is reseeded per floor to Random(seed+floorNum) as well
        // (GameContext::transitionToMapNode), so it starts from the same state.
        s.miscRng = start;

        // --- createMonsters: pick and build one at a time (misc, hp, hp) x3 ---
        s.ms.resize(3);
        for (int i = 0; i < 3; ++i) {
            s.ms[i].species = s.miscRng.randomBoolean() ? RED : GREEN;
            if (s.ms[i].species == RED) s.ms[i].hp = s.monsterHpRng.random(10, 15);
            else                        s.ms[i].hp = s.monsterHpRng.random(11, 17);
            s.ms[i].rolledDamage = s.monsterHpRng.random(5, 7);
        }
        s.alive = 3;
        // --- opening intents ---
        for (int i = 0; i < 3; ++i) s.rollMove(s.ms[i]);
        // --- preBattleAction: Curl Up, after every HP roll and every rollMove ---
        for (int i = 0; i < 3; ++i) s.ms[i].curlUp = s.monsterHpRng.random(3, 7);

        s.drawPile = {0,0,0,0,0,1,1,1,1,2};
        s.shufflePile(s.drawPile);
        s.energy += 3;
        s.draw(5);

        std::vector<int> species, hps, rolled, curls;
        for (auto &w : s.ms) { species.push_back(w.species); hps.push_back(w.hp); rolled.push_back(w.rolledDamage); curls.push_back(w.curlUp); }

        std::cout << "{\"seed\":\"" << c.seed << "\",\"seedLong\":\"" << c.seedLong
                  << "\",\"floor\":" << c.floor << ",\"species\":";
        printArr(species);
        std::cout << ",\"initHps\":"; printArr(hps);
        std::cout << ",\"rolledDamage\":"; printArr(rolled);
        std::cout << ",\"curlUp\":"; printArr(curls);
        std::cout << ",\"initIntents\":[";
        for (int i = 0; i < 3; ++i) { if (i) std::cout << ","; std::cout << "\"" << MOVE_NAME[s.ms[i].history[0]] << "\""; }
        std::cout << "],\"initCounters\":{\"aiRng\":" << s.aiRng.counter
                  << ",\"monsterHpRng\":" << s.monsterHpRng.counter
                  << ",\"miscRng\":" << s.miscRng.counter
                  << ",\"shuffleRng\":" << s.shuffleRng.counter << "},\"turns\":[";

        for (int t = 0; t < 5; ++t) {
            if (t) std::cout << ",";
            std::vector<int> played = s.playGreedy();
            std::vector<int> thp, tblk, tstr;
            for (auto &w : s.ms) { thp.push_back(w.alive ? w.hp : 0); tblk.push_back(w.block); tstr.push_back(w.strength); }
            std::cout << "{\"turn\":" << s.turn << ",\"played\":"; printArr(played);
            std::cout << ",\"monsterHps\":"; printArr(thp);
            std::cout << ",\"monsterBlocks\":"; printArr(tblk);
            std::cout << ",\"monsterStrengths\":"; printArr(tstr);
            std::cout << ",\"playerHp\":" << s.hp
                      << ",\"playerBlock\":" << s.block
                      << ",\"playerWeak\":" << s.weak
                      << ",\"alive\":" << s.alive
                      << ",\"aiRng\":" << s.aiRng.counter
                      << ",\"outcome\":" << s.outcome << "}";
            s.endTurn();
        }

        std::cout << "],\"final\":{\"turn\":" << s.turn
                  << ",\"playerHp\":" << s.hp
                  << ",\"outcome\":" << s.outcome
                  << ",\"counters\":{\"aiRng\":" << s.aiRng.counter
                  << ",\"monsterHpRng\":" << s.monsterHpRng.counter
                  << ",\"miscRng\":" << s.miscRng.counter
                  << ",\"shuffleRng\":" << s.shuffleRng.counter
                  << ",\"cardRandomRng\":" << s.cardRandomRng.counter << "}}}";
    }
    std::cout << "]}" << std::endl;
    return 0;
}
