// Golden dumper for the sts-combat card-play path: Ironclad starter deck vs one
// Cultist, driven by a fixed greedy policy for three turns. Companion to
// combat_dump.cpp (which covers the no-play skeleton path).
//
// Greedy policy (must match the TS test driver exactly):
//   repeat { scan hand left-to-right; play the first card with cost <= energy } until none
//   attacks always target monster 0; then end turn.
//
// Mechanics transcribed from the reference:
//   damage : BattleContext::calculateCardDamage — float32 throughout, +strength,
//            *0.75f weak, *1.5f vulnerable, single truncation at the end.
//            Computed at ENQUEUE time (addToBot(AttackEnemy(t, calc(...)))), so Bash's
//            Vulnerable only affects cards played after it, not Bash's own hit.
//   block  : BattleContext::calculateCardBlock — integer, +dex, frail -> block*3/4.
//   cards  : STRIKE_RED 6 dmg (BattleContext.cpp:967), DEFEND_RED 5 block (:1203 area),
//            BASH 8 dmg + Vulnerable 2 (:980).
//   monster: Cultist INCANTATION buffs RITUAL 3 (skipFirst) then setMove(DARK_STRIKE);
//            DARK_STRIKE = attackPlayerHelper(6) = float(6+strength) truncated.
//            Ritual resolves at end of round (Monster::applyEndOfRoundPowers), skipping
//            the round it was applied.
//   draw   : top = back of pile; reshuffle when the pile is short — one extra
//            shuffleRng.randomLong() seeding a java::Random (Actions::EmptyDeckShuffle).
//
// Turn 3's draw finds the pile empty, so it exercises the reshuffle and pushes
// shuffleRng's counter from 1 to 2.

#include <cstdint>
#include <string>
#include <vector>
#include <iostream>
#include "game/Random.h"

using namespace sts;

// strike=0, defend=1, bash=2
static const int COST[3] = {1, 1, 2};

struct Sim {
    Random aiRng, monsterHpRng, shuffleRng, cardRandomRng;

    // player
    int hp = 80, block = 0, energy = 0;
    std::vector<int> hand, drawPile, discardPile;

    // monster (Cultist)
    int mHp = 0, mBlock = 0, mVuln = 0, mStrength = 0, mRitual = 0;
    bool mRitualJustApplied = false;
    bool mAlive = true;
    std::string intent;

    int turn = 1;

    // --- reference: calculateCardDamage ---
    int cardDamage(int base) const {
        float damage = static_cast<float>(base);
        damage += 0.0f; // player strength = 0 in this scenario
        if (mVuln > 0) damage *= 1.5f;
        int d = static_cast<int>(damage);
        return d < 0 ? 0 : d;
    }

    // --- reference: calculateCardBlock ---
    int cardBlock(int base) const { return base; } // dex 0, no frail

    // --- reference: Monster::calculateDamageToPlayer ---
    int monsterDamage(int base) const {
        float damage = static_cast<float>(base + mStrength);
        int d = static_cast<int>(damage);
        return d < 0 ? 0 : d;
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
                shufflePile(discardPile);          // reshuffle: one shuffleRng.randomLong()
                drawPile = discardPile;
                discardPile.clear();
            }
        }
        int n = toDraw < static_cast<int>(drawPile.size()) ? toDraw : static_cast<int>(drawPile.size());
        for (int i = 0; i < n; ++i) { hand.push_back(drawPile.back()); drawPile.pop_back(); }
    }

    void attackMonster(int damage) {
        if (!mAlive) return;
        if (damage < 0) damage = 0;
        int temp = damage;
        damage -= mBlock;
        mBlock = mBlock - temp; if (mBlock < 0) mBlock = 0;
        if (damage > 0) {
            mHp -= damage;
            if (mHp <= 0) { mHp = 0; mAlive = false; }
        }
    }

    // play hand[idx]; returns nothing. Mirrors useCard ordering.
    void playCard(int idx) {
        int card = hand[idx];
        // effects are computed at enqueue time, using state BEFORE the card resolves
        int dmg = 0, blk = 0, vuln = 0;
        if (card == 0) { dmg = cardDamage(6); }
        else if (card == 1) { blk = cardBlock(5); }
        else { dmg = cardDamage(8); vuln = 2; }

        hand.erase(hand.begin() + idx);
        energy -= COST[card];

        if (card == 0 || card == 2) attackMonster(dmg);
        if (card == 1) block += blk;
        if (vuln > 0 && mAlive) mVuln += vuln;
        discardPile.push_back(card);
    }

    // greedy: play first affordable card, repeat
    std::vector<int> playGreedy() {
        std::vector<int> played;
        for (;;) {
            int pick = -1;
            for (size_t i = 0; i < hand.size(); ++i) {
                if (COST[hand[i]] <= energy) { pick = static_cast<int>(i); break; }
            }
            if (pick < 0) break;
            played.push_back(hand[pick]);
            playCard(pick);
        }
        return played;
    }

    void endTurn() {
        // discard hand
        for (int c : hand) discardPile.push_back(c);
        hand.clear();

        // monster turn
        if (mAlive) {
            if (intent == "incantation") {
                mRitual += 3; mRitualJustApplied = true;
                intent = "dark_strike";
                aiRng.random(99);              // noOpRollMove
            } else {
                int d = monsterDamage(6);
                int absorbed = d < block ? d : block;
                block -= absorbed;
                hp -= (d - absorbed);
                aiRng.random(99);              // roll next move -> dark_strike again
            }
        }

        // end of round powers
        if (mAlive && mRitual > 0) {
            if (mRitualJustApplied) mRitualJustApplied = false;
            else mStrength += mRitual;
        }

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
        {"SLAYTHESPIRE", 2665621045298406349LL, 5},
    };

    std::cout << "{\"cases\":[";
    for (size_t ci = 0; ci < cases.size(); ++ci) {
        const Case &c = cases[ci];
        if (ci) std::cout << ",";

        Sim s;
        const long long base = c.seedLong + c.floor;
        Random start(static_cast<std::uint64_t>(base));
        s.aiRng = start; s.monsterHpRng = start; s.shuffleRng = start; s.cardRandomRng = start;

        // init
        s.mHp = s.monsterHpRng.random(48, 54);
        s.aiRng.random(99);
        s.intent = "incantation";
        s.drawPile = {0,0,0,0,0,1,1,1,1,2};
        s.shufflePile(s.drawPile);
        s.energy += 3;
        s.draw(5);

        std::cout << "{\"seed\":\"" << c.seed << "\",\"seedLong\":\"" << c.seedLong
                  << "\",\"floor\":" << c.floor << ",\"turns\":[";

        for (int t = 0; t < 3; ++t) {
            if (t) std::cout << ",";
            std::vector<int> played = s.playGreedy();
            std::cout << "{\"turn\":" << s.turn << ",\"played\":";
            printArr(played);
            std::cout << ",\"monsterHp\":" << s.mHp
                      << ",\"monsterVuln\":" << s.mVuln
                      << ",\"monsterStrength\":" << s.mStrength
                      << ",\"playerHp\":" << s.hp
                      << ",\"playerBlock\":" << s.block
                      << ",\"energy\":" << s.energy
                      << ",\"handAfterPlay\":";
            printArr(s.hand);
            std::cout << ",\"discard\":";
            printArr(s.discardPile);
            std::cout << "}";
            s.endTurn();
        }

        std::cout << "],\"final\":{"
                  << "\"turn\":" << s.turn
                  << ",\"intent\":\"" << s.intent << "\""
                  << ",\"monsterHp\":" << s.mHp
                  << ",\"monsterStrength\":" << s.mStrength
                  << ",\"playerHp\":" << s.hp
                  << ",\"hand\":";
        printArr(s.hand);
        std::cout << ",\"drawPile\":";
        printArr(s.drawPile);
        std::cout << ",\"counters\":{\"aiRng\":" << s.aiRng.counter
                  << ",\"monsterHpRng\":" << s.monsterHpRng.counter
                  << ",\"shuffleRng\":" << s.shuffleRng.counter
                  << ",\"cardRandomRng\":" << s.cardRandomRng.counter << "}"
                  << "}}";
    }
    std::cout << "]}" << std::endl;
    return 0;
}
