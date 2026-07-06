// Golden dumper for Neow::getOptions. The function is self-contained (only uses
// sts::Random + the Bonus/Drawback enums), so it is transcribed verbatim from
// src/game/Neow.cpp — compiling the exact source lines against Random.h.
#include <cstdint>
#include <string>
#include <vector>
#include <array>
#include <iostream>
#include "game/Random.h"

using namespace sts;

enum class Bonus {
    THREE_CARDS=0, ONE_RANDOM_RARE_CARD, REMOVE_CARD, UPGRADE_CARD, TRANSFORM_CARD, RANDOM_COLORLESS,
    THREE_SMALL_POTIONS, RANDOM_COMMON_RELIC, TEN_PERCENT_HP_BONUS, THREE_ENEMY_KILL, HUNDRED_GOLD,
    RANDOM_COLORLESS_2, REMOVE_TWO, ONE_RARE_RELIC, THREE_RARE_CARDS, TWO_FIFTY_GOLD, TRANSFORM_TWO_CARDS, TWENTY_PERCENT_HP_BONUS,
    BOSS_RELIC, INVALID,
};
enum class Drawback {
    INVALID=0, NONE, TEN_PERCENT_HP_LOSS, NO_GOLD, CURSE, PERCENT_DAMAGE, LOSE_STARTER_RELIC,
};
struct Option { Bonus r; Drawback d; };

// --- verbatim from Neow.cpp ---
std::array<Option, 4> getOptions(Random &r) {
    std::array<Option, 4> rewards {};
    rewards[0].r = static_cast<Bonus>(r.random(0, 5));
    rewards[0].d = Drawback::NONE;
    rewards[1].r = static_cast<Bonus>(6 + r.random(0, 4));
    rewards[1].d = Drawback::NONE;
    rewards[2].d = static_cast<Drawback>(2 + r.random(0, 3));
    switch (rewards[2].d) {
        case Drawback::TEN_PERCENT_HP_LOSS: {
            static constexpr Bonus myRewards[]{ Bonus::RANDOM_COLORLESS_2, Bonus::REMOVE_TWO, Bonus::ONE_RARE_RELIC, Bonus::THREE_RARE_CARDS, Bonus::TWO_FIFTY_GOLD, Bonus::TRANSFORM_TWO_CARDS, };
            rewards[2].r = myRewards[r.random(0, 5)]; break;
        }
        case Drawback::NO_GOLD: {
            static constexpr Bonus myRewards[]{ Bonus::RANDOM_COLORLESS_2, Bonus::REMOVE_TWO, Bonus::ONE_RARE_RELIC, Bonus::THREE_RARE_CARDS, Bonus::TRANSFORM_TWO_CARDS, Bonus::TWENTY_PERCENT_HP_BONUS, };
            rewards[2].r = myRewards[r.random(0, 5)]; break;
        }
        case Drawback::CURSE: {
            static constexpr Bonus myRewards[]{ Bonus::RANDOM_COLORLESS_2, Bonus::ONE_RARE_RELIC, Bonus::THREE_RARE_CARDS, Bonus::TWO_FIFTY_GOLD, Bonus::TRANSFORM_TWO_CARDS, Bonus::TWENTY_PERCENT_HP_BONUS, };
            rewards[2].r = myRewards[r.random(0, 5)]; break;
        }
        case Drawback::PERCENT_DAMAGE:
            rewards[2].r = static_cast<Bonus>(11 + r.random(0, 6)); break;
        default: break;
    }
    rewards[3].r = Bonus::BOSS_RELIC;
    rewards[3].d = Drawback::LOSE_STARTER_RELIC;
    r.random(0, 0);
    return rewards;
}
// --- end verbatim ---

static std::uint64_t seedGetLong(const std::string& s) {
    constexpr int BASE = 35;
    auto dig = [](char c)->int{ if(c<'A')return c-'0'; if(c<'O')return c-'A'+10; return c-'A'+9; };
    std::uint64_t r=0; for(char c:s){ r*=BASE; r+=dig((char)toupper(c)); } return r;
}

int main() {
    std::vector<std::string> seeds = {"1RGBGHNF7L","SLAYTHESPIRE","0","3IX8N7ZPAA5","NEOWLIVES","ZZZ","ABCDEF"};
    std::cout << "{\"neow\":[";
    bool first=true;
    for (auto& s : seeds) {
        std::uint64_t sl = seedGetLong(s);
        Random r(sl);
        auto opts = getOptions(r);
        if(!first) std::cout<<","; first=false;
        std::cout << "{\"seed\":\"" << s << "\",\"seedLong\":\"" << sl << "\",\"options\":[";
        for (int i=0;i<4;i++){ if(i)std::cout<<","; std::cout<<"{\"bonus\":"<<(int)opts[i].r<<",\"drawback\":"<<(int)opts[i].d<<"}"; }
        std::cout << "],\"counterAfter\":" << r.counter << "}";
    }
    std::cout << "]}" << std::endl;
    return 0;
}
