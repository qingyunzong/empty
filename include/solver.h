#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace ammosim {

constexpr int kMaxTargets = 10;
constexpr int kMaxTypes = 4;
constexpr int kMaxBudget = 20;

// Integer ammunition allocation vector (only the first numTypes entries used).
using AmmoVec = std::array<int, kMaxTypes>;

// 8 bits per ammo type; component counts are <= kMaxBudget < 256.
std::uint32_t encode(const AmmoVec& v, int k);
AmmoVec decode(std::uint32_t key, int k);
int ammoCost(const AmmoVec& v, int k);

// Enumerate every AmmoVec of k types with component sum <= maxSum.
template <typename F>
void forEachVector(int k, int maxSum, F&& f) {
  AmmoVec v{};
  auto rec = [&](auto&& self, int pos, int remaining) -> void {
    if (pos == k) {
      f(v);
      return;
    }
    if (pos >= kMaxTypes) return;  // k is always <= kMaxTypes
    for (int x = 0; x <= remaining; ++x) {
      v[pos] = x;
      self(self, pos + 1, remaining - x);
    }
  };
  rec(rec, 0, maxSum);
}

struct Problem {
  int numTargets = 0;  // <= kMaxTargets
  int numTypes = 0;    // <= kMaxTypes
  int budget = 0;      // <= kMaxBudget
  std::vector<double> threshold;  // per target: damage needed to count as met
  std::vector<double> value;      // per target: value gained when met
  // Discrete damage tables: damage[t][encode(vec)] = damage; missing => 0.
  // No linearity/monotonicity assumption is made about these tables.
  std::vector<std::unordered_map<std::uint32_t, double>> damage;

  double damageOf(int target, const AmmoVec& v) const;
};

struct TargetPlan {
  AmmoVec allocation{};
  int ammo = 0;
  double damage = 0.0;
  bool met = false;
  double gained = 0.0;
};

struct Solution {
  double totalValue = 0.0;
  int totalAmmo = 0;
  std::vector<TargetPlan> targets;
};

// Lexicographic objective: maximize met-target value, then minimize ammo.
Solution solveDP(const Problem& p);

// Reference: full enumeration of every allocation vector for every target.
Solution solveReference(const Problem& p);

std::string renderTable(const Problem& p, const Solution& s);

}  // namespace ammosim
