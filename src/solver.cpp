#include "solver.hpp"

#include <limits>

namespace sim {
namespace {

constexpr int kInf = std::numeric_limits<int>::max();

// Enumerate all round vectors (k_0..k_{m-1}) with sum <= budget for target t
// in lexicographic order; keep the cheapest vector reaching the threshold
// (first one wins among equal costs, giving a deterministic result).
void best_target_allocation(const Scenario& sc, int t, std::vector<int>& best,
                            int& best_cost) {
    const int m = sc.ammo_types;
    best_cost = kInf;
    best.assign(m, 0);
    std::vector<int> cur(m, 0);
    const auto dfs = [&](auto&& self, int a, int remaining, int cost,
                         long dmg) -> void {
        if (cost >= best_cost) return;  // extra rounds can only cost more
        if (a == m) {
            if (dmg >= sc.targets[t].threshold) {
                best_cost = cost;
                best = cur;
            }
            return;
        }
        for (int k = 0; k <= remaining; ++k) {
            cur[a] = k;
            self(self, a + 1, remaining - k, cost + k,
                 dmg + sc.damage[t][a][k]);
        }
        cur[a] = 0;
    };
    dfs(dfs, 0, sc.budget, 0, 0);
}

}  // namespace

Solution solve(const Scenario& sc) {
    const int n = static_cast<int>(sc.targets.size());
    const int budget = sc.budget;

    std::vector<int> min_cost(n, kInf);
    std::vector<std::vector<int>> alloc(n);
    for (int t = 0; t < n; ++t)
        best_target_allocation(sc, t, alloc[t], min_cost[t]);

    struct Val {
        long value;
        int rounds;
    };
    const auto better = [](const Val& x, const Val& y) {
        return x.value > y.value ||
               (x.value == y.value && x.rounds < y.rounds);
    };

    // dp[i][c] = best (value, rounds) using targets [0, i) with capacity c.
    std::vector<std::vector<Val>> dp(n + 1,
                                     std::vector<Val>(budget + 1, {0, 0}));
    std::vector<std::vector<char>> take(n + 1,
                                        std::vector<char>(budget + 1, 0));
    for (int i = 1; i <= n; ++i) {
        for (int c = 0; c <= budget; ++c) {
            Val best = dp[i - 1][c];
            char tk = 0;
            const int w = min_cost[i - 1];
            if (w != kInf && c >= w) {
                const Val cand{dp[i - 1][c - w].value + sc.targets[i - 1].value,
                               dp[i - 1][c - w].rounds + w};
                if (better(cand, best)) {
                    best = cand;
                    tk = 1;
                }
            }
            dp[i][c] = best;
            take[i][c] = tk;
        }
    }

    Solution sol;
    sol.total_value = dp[n][budget].value;
    sol.total_rounds = dp[n][budget].rounds;
    sol.rounds.assign(n, std::vector<int>(sc.ammo_types, 0));
    int c = budget;
    for (int i = n; i >= 1; --i) {
        if (take[i][c]) {
            sol.rounds[i - 1] = alloc[i - 1];
            c -= min_cost[i - 1];
        }
    }

    sol.target_damage.assign(n, 0);
    sol.destroyed.assign(n, false);
    for (int t = 0; t < n; ++t) {
        long dmg = 0;
        for (int a = 0; a < sc.ammo_types; ++a)
            dmg += sc.damage[t][a][sol.rounds[t][a]];
        sol.target_damage[t] = dmg;
        sol.destroyed[t] = dmg >= sc.targets[t].threshold;
    }
    return sol;
}

}  // namespace sim
