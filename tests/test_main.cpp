#include <iostream>
#include <random>
#include <sstream>
#include <string>

#include "bruteforce.hpp"
#include "scenario.hpp"
#include "solver.hpp"

namespace {

int failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << "  "   \
                      << #cond << "\n";                                   \
            ++failures;                                                   \
        }                                                                 \
    } while (0)

// Hand-computed case (also exercises the "fewer rounds" tie-break):
//   T0: value 100, thr 10, D(*,0)=[0,4,9,15], D(*,1)=[0,6,7]  -> min 2 rounds (1,1)
//   T1: value  60, thr  8, D(*,0)=[0,3,8],    D(*,1)=[0,5,9]  -> min 2 rounds
//   T2: value  60, thr  4, D(*,0)=[0,5],      D(*,1)=[0,2]    -> min 1 round
// Budget 4: T0+T1 and T0+T2 both give value 160; T0+T2 uses 3 rounds and wins.
sim::Scenario hand_scenario() {
    const std::string text = R"(
budget 4
ammo 2
target 100 10 T0
target 60 8 T1
target 60 4 T2
damage 0 0 1 4
damage 0 0 2 9
damage 0 0 3 15
damage 0 1 1 6
damage 0 1 2 7
damage 1 0 1 3
damage 1 0 2 8
damage 1 1 1 5
damage 1 1 2 9
damage 2 0 1 5
damage 2 1 1 2
)";
    std::istringstream in(text);
    return sim::parse_scenario(in, "hand");
}

void test_hand_case() {
    const sim::Scenario sc = hand_scenario();
    const sim::Solution sol = sim::solve(sc);
    CHECK(sol.total_value == 160);
    CHECK(sol.total_rounds == 3);
    CHECK(sol.destroyed[0] && !sol.destroyed[1] && sol.destroyed[2]);
    CHECK(sol.rounds[0] == (std::vector<int>{1, 1}));
    CHECK(sol.rounds[1] == (std::vector<int>{0, 0}));
    CHECK(sol.rounds[2] == (std::vector<int>{1, 0}));
    CHECK(sol.target_damage[0] == 10);
    CHECK(sol.target_damage[2] == 5);

    const sim::ReferenceResult ref = sim::brute_force(sc, 1000000);
    CHECK(ref.ran);
    CHECK(ref.leaf_count == 210);  // C(4 + 6, 6)
    CHECK(ref.best_value == sol.total_value);
    CHECK(ref.best_rounds == sol.total_rounds);
}

void test_parser() {
    const sim::Scenario sc = hand_scenario();
    CHECK(sc.budget == 4);
    CHECK(sc.ammo_types == 2);
    CHECK(sc.targets.size() == 3);
    CHECK(sc.targets[0].name == "T0");
    CHECK(sc.targets[0].value == 100);
    CHECK(sc.targets[0].threshold == 10);
    CHECK(sc.damage[0][0][0] == 0);   // unspecified entries default to 0
    CHECK(sc.damage[0][0][4] == 0);
    CHECK(sc.damage[0][0][3] == 15);
    CHECK(sc.damage[2][1][1] == 2);

    const auto expect_throw = [](const std::string& text) {
        try {
            std::istringstream in(text);
            sim::parse_scenario(in, "bad");
        } catch (const std::runtime_error&) {
            return true;
        }
        return false;
    };
    CHECK(expect_throw("budget 4\n"));                       // missing ammo/target
    CHECK(expect_throw("budget 21\nammo 1\ntarget 1 1\n"));  // budget too large
    CHECK(expect_throw("budget 4\nammo 5\ntarget 1 1\n"));   // too many ammo types
    CHECK(expect_throw("budget 4\nammo 1\ntarget 1 1\ndamage 0 0 1 2\ndamage 0 0 1 3\n"));  // duplicate
    CHECK(expect_throw("budget 4\nammo 1\ntarget 1 1\ndamage 1 0 1 2\n"));   // bad target idx
    CHECK(expect_throw("budget 4\nammo 1\ntarget 1 1\ndamage 0 0 5 2\n"));   // rounds > budget
    CHECK(expect_throw("budget 4\nammo 1\ntarget 1 1\ndamage 0 0 1 -2\n"));  // negative damage
    CHECK(expect_throw("budget 4\nammo 1\ntarget 1 1\nfly 1 2 3\n"));        // unknown directive

    // Too many targets.
    {
        std::string text = "budget 4\nammo 1\n";
        for (int i = 0; i < 11; ++i) text += "target 1 1\n";
        CHECK(expect_throw(text));
    }
}

void test_edge_cases() {
    // Threshold 0: defeated for free.
    {
        std::istringstream in("budget 3\nammo 1\ntarget 50 0 Free\n");
        const sim::Solution sol = sim::solve(sim::parse_scenario(in, "edge"));
        CHECK(sol.total_value == 50);
        CHECK(sol.total_rounds == 0);
        CHECK(sol.destroyed[0]);
    }
    // Unreachable threshold: target excluded, nothing fired.
    {
        std::istringstream in(
            "budget 2\nammo 1\ntarget 10 100 No\n"
            "damage 0 0 1 5\ndamage 0 0 2 9\n");
        const sim::Solution sol = sim::solve(sim::parse_scenario(in, "edge"));
        CHECK(sol.total_value == 0);
        CHECK(sol.total_rounds == 0);
        CHECK(!sol.destroyed[0]);
    }
    // Budget 0.
    {
        std::istringstream in("budget 0\nammo 2\ntarget 10 1 A\ntarget 7 0 B\n");
        const sim::Solution sol = sim::solve(sim::parse_scenario(in, "edge"));
        CHECK(sol.total_value == 7);
        CHECK(sol.total_rounds == 0);
    }
    // Non-monotonic damage table is honored as-is (more rounds can hurt).
    {
        std::istringstream in(
            "budget 2\nammo 1\ntarget 10 5 A\n"
            "damage 0 0 1 6\ndamage 0 0 2 1\n");
        const sim::Solution sol = sim::solve(sim::parse_scenario(in, "edge"));
        CHECK(sol.total_value == 10);
        CHECK(sol.total_rounds == 1);
    }
}

// Cross-check the DP solver against full enumeration of every allocation
// vector on randomized small scenarios (non-linear, non-monotonic tables).
void test_randomized_against_reference() {
    std::mt19937_64 rng(20261008);
    for (int iter = 0; iter < 400; ++iter) {
        const int n = 1 + static_cast<int>(rng() % 3);  // 1..3 targets
        const int m = 1 + static_cast<int>(rng() % 2);  // 1..2 ammo types
        const int budget = static_cast<int>(rng() % 7); // 0..6

        sim::Scenario sc;
        sc.budget = budget;
        sc.ammo_types = m;
        sc.targets.resize(n);
        sc.damage.assign(n, std::vector<std::vector<long>>(
                                m, std::vector<long>(budget + 1, 0)));
        for (int t = 0; t < n; ++t) {
            sc.targets[t].name = "T" + std::to_string(t);
            sc.targets[t].value = static_cast<long>(rng() % 51);
            sc.targets[t].threshold = static_cast<long>(rng() % 41);
            for (int a = 0; a < m; ++a)
                for (int k = 0; k <= budget; ++k)
                    sc.damage[t][a][k] = static_cast<long>(rng() % 16);
        }

        const sim::Solution sol = sim::solve(sc);
        const sim::ReferenceResult ref = sim::brute_force(sc, 1000000);
        CHECK(ref.ran);
        CHECK(sol.total_value == ref.best_value);
        CHECK(sol.total_rounds == ref.best_rounds);

        // Structural validation of the returned plan.
        int rounds_sum = 0;
        long value_sum = 0;
        for (int t = 0; t < n; ++t) {
            long dmg = 0;
            for (int a = 0; a < m; ++a) {
                CHECK(sol.rounds[t][a] >= 0);
                rounds_sum += sol.rounds[t][a];
                dmg += sc.damage[t][a][sol.rounds[t][a]];
            }
            CHECK(dmg == sol.target_damage[t]);
            CHECK(sol.destroyed[t] == (dmg >= sc.targets[t].threshold));
            if (sol.destroyed[t]) value_sum += sc.targets[t].value;
        }
        CHECK(rounds_sum == sol.total_rounds);
        CHECK(rounds_sum <= budget);
        CHECK(value_sum == sol.total_value);
    }
}

}  // namespace

int main() {
    test_hand_case();
    test_parser();
    test_edge_cases();
    test_randomized_against_reference();
    if (failures == 0) {
        std::cout << "all tests passed\n";
        return 0;
    }
    std::cerr << failures << " check(s) failed\n";
    return 1;
}
