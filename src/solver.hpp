#pragma once

#include "scenario.hpp"

namespace sim {

struct Solution {
    long total_value = 0;                 // sum of values of defeated targets
    int total_rounds = 0;                 // total rounds fired
    std::vector<std::vector<int>> rounds; // rounds[t][a] allocated to target t
    std::vector<long> target_damage;      // resulting damage on each target
    std::vector<bool> destroyed;          // damage >= threshold
};

// Exact solver. Damage per target depends only on the rounds assigned to it,
// so the problem decomposes into:
//   1. per target: minimal rounds (and the achieving allocation) to reach the
//      threshold, found by enumerating all compositions of <= budget rounds
//      into the ammo types against the discrete damage table;
//   2. a 0/1 knapsack over targets maximizing defeated value, breaking ties
//      toward fewer total rounds.
Solution solve(const Scenario& sc);

}  // namespace sim
