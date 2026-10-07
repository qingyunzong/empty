#include "bruteforce.hpp"

#include <cmath>

namespace sim {

long long count_allocations(int slots, int budget, long long cap) {
    // C(budget + slots, slots) with saturation at cap.
    long double total = 1.0L;
    for (int i = 1; i <= slots; ++i) {
        total = total * (budget + i) / i;
        if (total >= static_cast<long double>(cap)) return cap;
    }
    return static_cast<long long>(std::llround(total));
}

ReferenceResult brute_force(const Scenario& sc, long long max_leaves) {
    const int n = static_cast<int>(sc.targets.size());
    const int m = sc.ammo_types;
    const int slots = n * m;

    ReferenceResult res;
    res.leaf_count = count_allocations(slots, sc.budget, max_leaves + 1);
    if (res.leaf_count > max_leaves) return res;  // ran stays false

    std::vector<int> x(slots, 0);
    long best_value = -1;
    int best_rounds = 0;
    long long leaves = 0;

    const auto dfs = [&](auto&& self, int slot, int remaining) -> void {
        if (slot == slots) {
            ++leaves;
            long value = 0;
            for (int t = 0; t < n; ++t) {
                long dmg = 0;
                for (int a = 0; a < m; ++a)
                    dmg += sc.damage[t][a][x[t * m + a]];
                if (dmg >= sc.targets[t].threshold)
                    value += sc.targets[t].value;
            }
            const int rounds = sc.budget - remaining;
            if (value > best_value ||
                (value == best_value && rounds < best_rounds)) {
                best_value = value;
                best_rounds = rounds;
            }
            return;
        }
        for (int k = 0; k <= remaining; ++k) {
            x[slot] = k;
            self(self, slot + 1, remaining - k);
        }
        x[slot] = 0;
    };
    dfs(dfs, 0, sc.budget);

    res.ran = true;
    res.leaf_count = leaves;
    res.best_value = best_value;
    res.best_rounds = best_rounds;
    return res;
}

}  // namespace sim
