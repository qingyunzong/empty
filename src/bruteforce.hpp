#pragma once

#include "scenario.hpp"

namespace sim {

struct ReferenceResult {
    bool ran = false;          // false when enumeration was refused (too large)
    long long leaf_count = 0;  // allocation vectors examined
    long best_value = 0;
    int best_rounds = 0;
};

// Number of non-negative integer vectors of length `slots` with sum <=
// `budget`, i.e. C(budget + slots, slots), capped at `cap`.
long long count_allocations(int slots, int budget, long long cap);

// Independent reference: enumerate every allocation vector x[t][a] with
// total <= budget, evaluate it directly against the damage table, and keep
// the best by (value desc, rounds asc). Refuses when the vector count
// exceeds max_leaves (sets ran=false).
ReferenceResult brute_force(const Scenario& sc, long long max_leaves);

}  // namespace sim
