// Header-only golden dumper for sts::Random / java::Random primitives.
// Compiles against sts_lightspeed/include/game/Random.h only.
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <string>
#include <vector>
#include <iostream>
#include "game/Random.h"

// base-35 seed helper, transcribed from src/game/Game.cpp
static constexpr int SEED_BASE = 35;
static int getDigitValue(char c) {
    if (c < 'A') return c - '0';
    if (c < 'O') return c - 'A' + 10;
    return c - 'A' + 9;
}
static std::uint64_t seedGetLong(const std::string& seed) {
    std::uint64_t ret = 0;
    for (char ch : seed) { ret *= SEED_BASE; ret += getDigitValue((char)toupper(ch)); }
    return ret;
}
static std::string seedGetString(std::uint64_t seed) {
    const char* chars = "0123456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    std::uint64_t u = seed; std::string s;
    do { s += chars[u % SEED_BASE]; u /= SEED_BASE; } while (u != 0);
    for (size_t i = 0; i < s.size()/2; i++) std::swap(s[i], s[s.size()-1-i]);
    return s;
}

static void arrI(const char* k, const std::vector<long long>& v) {
    std::cout << "\"" << k << "\":[";
    for (size_t i=0;i<v.size();i++){ if(i) std::cout<<","; std::cout<<v[i]; }
    std::cout << "]";
}
static void arrS(const char* k, const std::vector<std::string>& v) {
    std::cout << "\"" << k << "\":[";
    for (size_t i=0;i<v.size();i++){ if(i) std::cout<<","; std::cout<<"\""<<v[i]<<"\""; }
    std::cout << "]";
}

int main() {
    std::vector<std::string> seeds = {"1RGBGHNF7L","0","SLAYTHESPIRE","3IX8N7ZPAA5","ZZZZZ"};
    std::cout << "{\"primitives\":{";
    for (size_t si=0; si<seeds.size(); si++) {
        std::uint64_t sl = seedGetLong(seeds[si]);
        if (si) std::cout << ",";
        std::cout << "\"" << seeds[si] << "\":{";
        std::cout << "\"seedLong\":\"" << sl << "\",";
        std::cout << "\"roundtrip\":\"" << seedGetString(sl) << "\",";
        // random(99) x100
        { sts::Random r(sl); std::vector<long long> v; for(int i=0;i<100;i++) v.push_back(r.random(99)); arrI("random99", v); std::cout<<","; std::cout<<"\"counterAfter\":"<<r.counter<<","; }
        // randomLong x100 (as unsigned decimal)
        { sts::Random r(sl); std::vector<std::string> v; for(int i=0;i<100;i++){ std::uint64_t x=(std::uint64_t)r.randomLong(); v.push_back(std::to_string(x)); } arrS("randomLong", v); std::cout<<","; }
        // nextFloat x100 as uint32 bits
        { sts::Random r(sl); std::vector<long long> v; for(int i=0;i<100;i++){ float f=r.random(); std::uint32_t b; std::memcpy(&b,&f,4); v.push_back((long long)b); } arrI("nextFloatBits", v); std::cout<<","; }
        // random(0,5) x50, random(a,b) inclusive semantics
        { sts::Random r(sl); std::vector<long long> v; for(int i=0;i<50;i++) v.push_back(r.random(0,5)); arrI("random0to5", v); std::cout<<","; }
        // randomBoolean(0.33) x50
        { sts::Random r(sl); std::vector<long long> v; for(int i=0;i<50;i++) v.push_back(r.randomBoolean(0.33f)?1:0); arrI("randBool33", v); std::cout<<","; }
        // Random(seed, counter) replay: build to counter=37, compare vs 37 sequential random(99) then next value
        { sts::Random a(sl); for(int i=0;i<37;i++) a.random(99); sts::Random b(sl,37); std::cout<<"\"replayMatch\":"<<((a.seed0==b.seed0&&a.seed1==b.seed1&&a.counter==b.counter)?"true":"false")<<","; }
        // java shuffle of 0..19 seeded from a randomLong
        { sts::Random r(sl); std::int64_t js=r.randomLong(); java::Random jr((std::uint64_t)js); std::vector<int> a(20); for(int i=0;i<20;i++)a[i]=i; java::Collections::shuffle(a.begin(),a.end(),jr); std::vector<long long> v(a.begin(),a.end()); arrI("javaShuffle20FromFirstLong", v); std::cout<<","; std::cout<<"\"javaSeedLong\":\""<<(std::uint64_t)js<<"\","; }
        // java nextInt(large non-power-of-2 bound) x30 — exercises int32 overflow rejection
        { java::Random jr(sl); std::vector<long long> v; for(int i=0;i<30;i++) v.push_back(jr.nextInt(1073741825)); arrI("javaNextIntLargeBound", v); std::cout<<","; }
        // random(float range) x20 as float bits
        { sts::Random r(sl); std::vector<long long> v; for(int i=0;i<20;i++){ float f=r.random(0.9f); std::uint32_t b; std::memcpy(&b,&f,4); v.push_back((long long)b);} arrI("randomFloatRange09Bits", v); std::cout<<","; }
        // random(float start, float end) x20 as float bits
        { sts::Random r(sl); std::vector<long long> v; for(int i=0;i<20;i++){ float f=r.random(0.9f,1.1f); std::uint32_t b; std::memcpy(&b,&f,4); v.push_back((long long)b);} arrI("randomFloatBetweenBits", v); std::cout<<","; }
        // randomLong signed int64 x20
        { sts::Random r(sl); std::vector<std::string> v; for(int i=0;i<20;i++){ std::int64_t x=r.randomLong(); v.push_back(std::to_string(x)); } arrS("randomLongSigned", v); }
        std::cout << "}";
    }
    std::cout << "}}" << std::endl;
    return 0;
}
