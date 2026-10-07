#include "solver.h"

#include <iomanip>
#include <limits>
#include <sstream>

namespace ammosim {

std::uint32_t encode(const AmmoVec& v, int k) {
  std::uint32_t key = 0;
  for (int i = 0; i < k; ++i)
    key |= static_cast<std::uint32_t>(v[i]) << (8 * i);
  return key;
}

AmmoVec decode(std::uint32_t key, int k) {
  AmmoVec v{};
  for (int i = 0; i < k; ++i) v[i] = static_cast<int>((key >> (8 * i)) & 0xff);
  return v;
}

int ammoCost(const AmmoVec& v, int k) {
  int cost = 0;
  for (int i = 0; i < k; ++i) cost += v[i];
  return cost;
}

double Problem::damageOf(int target, const AmmoVec& v) const {
  const auto it = damage[target].find(encode(v, numTypes));
  return it == damage[target].end() ? 0.0 : it->second;
}

namespace {

struct Objective {
  double value;
  int ammo;
};

// Lexicographic: higher value wins; ties broken by lower ammo.
bool better(const Objective& a, const Objective& b) {
  if (a.value != b.value) return a.value > b.value;
  return a.ammo < b.ammo;
}

}  // namespace

Solution solveDP(const Problem& p) {
  const int T = p.numTargets;
  const int K = p.numTypes;
  const int B = p.budget;

  // Reduce each target's discrete table to best damage per ammo cost by
  // enumerating every allocation vector (the table is arbitrary, so a full
  // scan is the only safe reduction).
  const double kNegInf = -std::numeric_limits<double>::infinity();
  std::vector<std::vector<double>> bestDmg(T, std::vector<double>(B + 1, kNegInf));
  std::vector<std::vector<std::uint32_t>> bestKey(
      T, std::vector<std::uint32_t>(B + 1, UINT32_MAX));
  for (int t = 0; t < T; ++t) {
    forEachVector(K, B, [&](const AmmoVec& v) {
      const int cost = ammoCost(v, K);
      const double d = p.damageOf(t, v);
      const std::uint32_t key = encode(v, K);
      if (d > bestDmg[t][cost] || (d == bestDmg[t][cost] && key < bestKey[t][cost])) {
        bestDmg[t][cost] = d;
        bestKey[t][cost] = key;
      }
    });
  }

  // dp[i][b]: best objective using targets [0, i) with at most b ammo.
  const Objective kInvalid{kNegInf, std::numeric_limits<int>::max()};
  std::vector<std::vector<Objective>> dp(T + 1, std::vector<Objective>(B + 1, kInvalid));
  std::vector<std::vector<int>> choice(T + 1, std::vector<int>(B + 1, -1));
  for (int b = 0; b <= B; ++b) dp[0][b] = {0.0, 0};
  for (int i = 1; i <= T; ++i) {
    for (int b = 0; b <= B; ++b) {
      for (int c = 0; c <= b; ++c) {
        if (dp[i - 1][b - c].ammo == std::numeric_limits<int>::max()) continue;
        const bool met = bestDmg[i - 1][c] >= p.threshold[i - 1];
        const double gain = met ? p.value[i - 1] : 0.0;
        const Objective cand{dp[i - 1][b - c].value + gain, dp[i - 1][b - c].ammo + c};
        if (better(cand, dp[i][b])) {
          dp[i][b] = cand;
          choice[i][b] = c;
        }
      }
    }
  }

  Solution sol;
  sol.targets.resize(T);
  sol.totalValue = dp[T][B].value;
  sol.totalAmmo = dp[T][B].ammo;
  int b = B;
  for (int i = T; i >= 1; --i) {
    const int c = choice[i][b];
    TargetPlan plan;
    plan.allocation = decode(bestKey[i - 1][c], K);
    plan.ammo = c;
    plan.damage = bestDmg[i - 1][c];
    plan.met = plan.damage >= p.threshold[i - 1];
    plan.gained = plan.met ? p.value[i - 1] : 0.0;
    sol.targets[i - 1] = plan;
    b -= c;
  }
  return sol;
}

Solution solveReference(const Problem& p) {
  const int T = p.numTargets;
  const int K = p.numTypes;
  const int B = p.budget;

  Solution best;
  best.targets.resize(T);
  Objective bestObj{-std::numeric_limits<double>::infinity(),
                    std::numeric_limits<int>::max()};
  std::vector<TargetPlan> cur(T);

  auto dfs = [&](auto&& self, int t, int remaining, double val, int ammo) -> void {
    if (t == T) {
      const Objective o{val, ammo};
      if (better(o, bestObj)) {
        bestObj = o;
        best.targets = cur;
        best.totalValue = val;
        best.totalAmmo = ammo;
      }
      return;
    }
    forEachVector(K, remaining, [&](const AmmoVec& v) {
      const int cost = ammoCost(v, K);
      const double d = p.damageOf(t, v);
      const bool met = d >= p.threshold[t];
      cur[t] = TargetPlan{v, cost, d, met, met ? p.value[t] : 0.0};
      self(self, t + 1, remaining - cost, val + cur[t].gained, ammo + cost);
    });
  };
  dfs(dfs, 0, B, 0.0, 0);
  return best;
}

std::string renderTable(const Problem& p, const Solution& s) {
  std::ostringstream out;
  out << "Target | Allocation | Ammo | Damage | Threshold | Met | Value\n";
  out << "-------+------------+------+--------+-----------+-----+-------\n";
  for (int t = 0; t < p.numTargets; ++t) {
    const TargetPlan& plan = s.targets[t];
    std::ostringstream alloc;
    alloc << '(';
    for (int i = 0; i < p.numTypes; ++i) {
      if (i) alloc << ',';
      alloc << plan.allocation[i];
    }
    alloc << ')';
    out << std::setw(6) << t << " | " << std::setw(10) << alloc.str() << " | "
        << std::setw(4) << plan.ammo << " | " << std::setw(6) << plan.damage << " | "
        << std::setw(9) << p.threshold[t] << " | " << (plan.met ? "yes" : "no ")
        << " | " << plan.gained << '\n';
  }
  out << "-------+------------+------+--------+-----------+-----+-------\n";
  out << "TOTAL  | value=" << s.totalValue << " ammo=" << s.totalAmmo << '/'
      << p.budget << '\n';
  return out.str();
}

}  // namespace ammosim
