// Golden dumper for monster encounter generation. Pool tables from
// MonsterEncounters.h; generate* functions transcribed verbatim from
// GameContext.cpp. One persistent monsterRng across acts (as the game does).
#include <cstdint>
#include <string>
#include <vector>
#include <utility>
#include <iostream>
#include "game/Random.h"
#include "constants/MonsterEncounters.h"

using namespace sts;
using ME = MonsterEncounter;

static std::vector<ME> monsterList;
static std::vector<ME> eliteMonsterList;

int rollWeightedIdx(float roll, const float *weights, int weightSize) {
    float curWeight = 0.0f;
    for (int i = 0; i < weightSize; ++i) {
        curWeight += weights[i];
        if (roll < curWeight) return i;
    }
    return weightSize - 1;
}

void populateMonsterList(Random &monsterRng, const ME monsters[], const float weights[], int monstersSize, int numMonsters) {
    for (int i = 0; i < numMonsters; ++i) {
        if (monsterList.empty()) {
            int idx = rollWeightedIdx(monsterRng.random(), weights, monstersSize);
            monsterList.push_back(monsters[idx]);
        } else {
            int idx = rollWeightedIdx(monsterRng.random(), weights, monstersSize);
            ME toAdd = monsters[idx];
            if (toAdd != monsterList.back() &&
                (monsterList.size() < 2 || toAdd != monsterList[monsterList.size()-2])) {
                monsterList.push_back(toAdd);
            } else {
                --i;
            }
        }
    }
}

void populateFirstStrongEnemy(Random &monsterRng, const ME monsters[], const float weights[], int monstersSize) {
    auto lastMonster = monsterList.back();
    while (true) {
        int idx = rollWeightedIdx(monsterRng.random(), weights, monstersSize);
        auto toAdd = monsters[idx];
        switch (toAdd) {
            case ME::LARGE_SLIME:
            case ME::LOTS_OF_SLIMES:
                if (lastMonster == ME::SMALL_SLIMES) continue;
                break;
            case ME::THREE_LOUSE:
                if (lastMonster == ME::TWO_LOUSE) continue;
                break;
            default: break;
        }
        monsterList.push_back(toAdd);
        return;
    }
}

int rollElite(Random &monsterRng) {
    float roll = monsterRng.random();
    if (roll < 1.0f/3) return 0;
    if (roll < 2.0f/3) return 1;
    return 2;
}

// returns {firstBoss, secondBoss(act3 indices[1] else INVALID)}
std::pair<ME,ME> generateBoss(Random &monsterRng, int act) {
    static const ME bosses[3][3] = {
        { ME::THE_GUARDIAN, ME::HEXAGHOST, ME::SLIME_BOSS },
        { ME::AUTOMATON, ME::COLLECTOR, ME::CHAMP },
        { ME::AWAKENED_ONE, ME::TIME_EATER, ME::DONU_AND_DECA },
    };
    int indices[3] = {0,1,2};
    java::Collections::shuffle(indices, indices+3, java::Random(monsterRng.randomLong()));
    ME second = (act==3) ? bosses[act-1][indices[1]] : ME::INVALID;
    return { bosses[act-1][indices[0]], second };
}

void generateAct(Random &monsterRng, int act) {
    monsterList.clear();
    eliteMonsterList.clear();
    // weak
    populateMonsterList(monsterRng, MonsterEncounterPool::weakEnemies[act-1], MonsterEncounterPool::weakWeights[act-1], MonsterEncounterPool::weakCount[act-1], act==1?3:2);
    // strong
    populateFirstStrongEnemy(monsterRng, MonsterEncounterPool::strongEnemies[act-1], MonsterEncounterPool::strongWeights[act-1], MonsterEncounterPool::strongCount[act-1]);
    populateMonsterList(monsterRng, MonsterEncounterPool::strongEnemies[act-1], MonsterEncounterPool::strongWeights[act-1], MonsterEncounterPool::strongCount[act-1], 12);
    // elites
    for (int i = 0; i < 10; ++i) {
        if (eliteMonsterList.empty()) {
            eliteMonsterList.push_back(MonsterEncounterPool::elites[act-1][rollElite(monsterRng)]);
        } else {
            auto toAdd = MonsterEncounterPool::elites[act-1][rollElite(monsterRng)];
            if (toAdd != eliteMonsterList.back()) eliteMonsterList.push_back(toAdd);
            else --i;
        }
    }
}

static std::uint64_t seedGetLong(const std::string& s) {
    constexpr int BASE = 35;
    auto dig = [](char c)->int{ if(c<'A')return c-'0'; if(c<'O')return c-'A'+10; return c-'A'+9; };
    std::uint64_t r=0; for(char c:s){ r*=BASE; r+=dig((char)toupper(c)); } return r;
}
static void arr(const char* k, const std::vector<ME>& v){
    std::cout<<"\""<<k<<"\":[";
    for(size_t i=0;i<v.size();i++){ if(i)std::cout<<","; std::cout<<(int)v[i]; }
    std::cout<<"]";
}

int main() {
    std::vector<std::string> seeds = {"1RGBGHNF7L","SLAYTHESPIRE","0","3IX8N7ZPAA5","NEOWLIVES"};
    std::cout<<"{\"encounters\":[";
    bool first=true;
    for(auto&s:seeds){
        std::uint64_t sl=seedGetLong(s);
        Random monsterRng(sl); // 单条持久流，跨幕续 counter
        if(!first)std::cout<<","; first=false;
        std::cout<<"{\"seed\":\""<<s<<"\",\"seedLong\":\""<<sl<<"\",\"acts\":[";
        for(int act=1;act<=3;act++){
            generateAct(monsterRng, act);
            auto bosses = generateBoss(monsterRng, act);
            if(act>1)std::cout<<",";
            std::cout<<"{\"act\":"<<act<<",";
            arr("monsters", monsterList); std::cout<<",";
            arr("elites", eliteMonsterList); std::cout<<",";
            std::cout<<"\"boss\":"<<(int)bosses.first<<",\"secondBoss\":"<<(int)bosses.second<<"}";
        }
        std::cout<<"],\"counterAfter\":"<<monsterRng.counter<<"}";
    }
    std::cout<<"]}"<<std::endl;
    return 0;
}
