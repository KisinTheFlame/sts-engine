// Golden dumper for STS map generation. Compiles Map.cpp standalone
// (deps: Map.h + Rooms.h + Random.h only — no GameContext).
#include <cstdint>
#include <string>
#include <vector>
#include <iostream>
#include "game/Map.h"

using namespace sts;

static std::uint64_t seedGetLong(const std::string& seed) {
    constexpr int BASE = 35;
    auto dig = [](char c) -> int {
        if (c < 'A') return c - '0';
        if (c < 'O') return c - 'A' + 10;
        return c - 'A' + 9;
    };
    std::uint64_t ret = 0;
    for (char ch : seed) { ret *= BASE; ret += dig((char)toupper(ch)); }
    return ret;
}

static void dumpMap(const std::string& seedStr, int asc, int act, bool burning) {
    std::uint64_t sl = seedGetLong(seedStr);
    Map m = Map::fromSeed(sl, asc, act, burning);
    std::cout << "{\"seed\":\"" << seedStr << "\",\"seedLong\":\"" << sl
              << "\",\"ascension\":" << asc << ",\"act\":" << act
              << ",\"burning\":" << (burning ? "true" : "false")
              << ",\"burningEliteX\":" << m.burningEliteX
              << ",\"burningEliteY\":" << m.burningEliteY
              << ",\"burningEliteBuff\":" << m.burningEliteBuff
              << ",\"nodes\":[";
    bool first = true;
    for (int y = 0; y < 15; y++) {
        for (int x = 0; x < 7; x++) {
            const MapNode& n = m.getNode(x, y);
            if (n.room == Room::NONE && n.edgeCount == 0 && n.parentCount == 0) continue;
            if (!first) std::cout << ",";
            first = false;
            std::cout << "{\"x\":" << x << ",\"y\":" << y
                      << ",\"room\":\"" << getRoomSymbol(n.room) << "\",\"edges\":[";
            for (int e = 0; e < n.edgeCount; e++) { if (e) std::cout << ","; std::cout << n.edges[e]; }
            std::cout << "]}";
        }
    }
    std::cout << "]}";
}

int main() {
    std::vector<std::string> seeds = {"1RGBGHNF7L", "SLAYTHESPIRE", "0", "3IX8N7ZPAA5", "NEOWLIVES"};
    std::cout << "{\"maps\":[";
    bool first = true;
    for (const auto& s : seeds) {
        for (int act = 1; act <= 3; act++) {
            if (!first) std::cout << ",";
            first = false;
            dumpMap(s, 0, act, false);
        }
    }
    // a burning-elite case (act 1, ascension 20)
    std::cout << ","; dumpMap("1RGBGHNF7L", 20, 1, true);
    std::cout << "]}" << std::endl;
    return 0;
}
