#pragma once

#include <iosfwd>
#include <string>
#include <vector>

namespace sim {

inline constexpr int kMaxTargets = 10;
inline constexpr int kMaxAmmoTypes = 4;
inline constexpr int kMaxBudget = 20;

struct Target {
    std::string name;
    long value = 0;
    long threshold = 0;  // damage required to count the target as defeated
};

struct Scenario {
    int budget = 0;      // total rounds available across all ammo types
    int ammo_types = 0;  // number of ammunition types (1..kMaxAmmoTypes)
    std::vector<Target> targets;
    // damage[t][a][k] = damage dealt to target t by k rounds of ammo type a.
    // Discrete input table; no linearity (or monotonicity) is assumed.
    std::vector<std::vector<std::vector<long>>> damage;
};

// Text format, one directive per line ('#' starts a comment):
//   budget <0..20>
//   ammo <1..4>
//   target <value> <threshold> [name...]
//   damage <target_idx> <ammo_idx> <rounds> <damage>
// Unspecified damage entries default to 0. Throws std::runtime_error on
// malformed input.
Scenario parse_scenario(std::istream& input, const std::string& source_name);
Scenario load_scenario(const std::string& path);

}  // namespace sim
