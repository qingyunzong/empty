#include <cmath>
#include <iostream>
#include <map>
#include <random>
#include <string>

#include "solver.h"

namespace {

int g_failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      ++g_failures;                                              \
      std::cerr << "CHECK failed: " << #cond << " (line "        \
                << __LINE__ << ")\n";                            \
    }                                                            \
  } while (0)

void setDamage(ammosim::Problem& p, int t, ammosim::AmmoVec v, double d) {
  p.damage[t][ammosim::encode(v, p.numTypes)] = d;
}

ammosim::Problem makeProblem(int T, int K, int B) {
  ammosim::Problem p;
  p.numTargets = T;
  p.numTypes = K;
  p.budget = B;
  p.threshold.assign(T, 0.0);
  p.value.assign(T, 0.0);
  p.damage.resize(T);
  return p;
}

// Two targets, one ammo type: spend exactly the budget to meet both.
bool testLinearBasic() {
  auto p = makeProblem(2, 1, 3);
  p.threshold = {5, 7};
  p.value = {10, 8};
  setDamage(p, 0, {1, 0, 0, 0}, 5);
  setDamage(p, 0, {2, 0, 0, 0}, 9);
  setDamage(p, 1, {2, 0, 0, 0}, 7);
  setDamage(p, 1, {3, 0, 0, 0}, 8);
  const auto s = ammosim::solveDP(p);
  CHECK(s.totalValue == 18);
  CHECK(s.totalAmmo == 3);
  CHECK(s.targets[0].met && s.targets[0].ammo == 1);
  CHECK(s.targets[1].met && s.targets[1].ammo == 2);
  return g_failures == 0;
}

// Damage table is nonlinear: only the 1+1 mix works, pure stacks do not.
// A solver assuming linearity/monotonicity would get this wrong.
bool testNonlinearSynergy() {
  auto p = makeProblem(1, 2, 4);
  p.threshold = {8};
  p.value = {100};
  setDamage(p, 0, {1, 1, 0, 0}, 10);  // synergy
  setDamage(p, 0, {2, 0, 0, 0}, 0);
  setDamage(p, 0, {0, 2, 0, 0}, 0);
  setDamage(p, 0, {4, 0, 0, 0}, 0);
  setDamage(p, 0, {0, 4, 0, 0}, 0);
  setDamage(p, 0, {3, 1, 0, 0}, 4);  // more ammo, less damage
  const auto s = ammosim::solveDP(p);
  CHECK(s.totalValue == 100);
  CHECK(s.totalAmmo == 2);
  CHECK(s.targets[0].allocation[0] == 1 && s.targets[0].allocation[1] == 1);
  return g_failures == 0;
}

// Same value reachable with 2 or 5 ammo: must pick the cheaper one.
bool testTieBreakAmmo() {
  auto p = makeProblem(1, 1, 5);
  p.threshold = {10};
  p.value = {50};
  setDamage(p, 0, {2, 0, 0, 0}, 10);
  setDamage(p, 0, {5, 0, 0, 0}, 10);
  const auto s = ammosim::solveDP(p);
  CHECK(s.totalValue == 50);
  CHECK(s.totalAmmo == 2);
  return g_failures == 0;
}

// Budget only covers one of two targets: pick the more valuable one.
bool testBudgetLimit() {
  auto p = makeProblem(2, 1, 4);
  p.threshold = {6, 6};
  p.value = {10, 6};
  setDamage(p, 0, {3, 0, 0, 0}, 6);
  setDamage(p, 1, {3, 0, 0, 0}, 6);
  const auto s = ammosim::solveDP(p);
  CHECK(s.totalValue == 10);
  CHECK(s.totalAmmo == 3);
  CHECK(s.targets[0].met && !s.targets[1].met);
  return g_failures == 0;
}

// A target that can never reach its threshold gets zero ammo.
bool testUnreachableThreshold() {
  auto p = makeProblem(2, 1, 4);
  p.threshold = {100, 4};
  p.value = {1000, 7};
  setDamage(p, 0, {4, 0, 0, 0}, 50);
  setDamage(p, 1, {2, 0, 0, 0}, 4);
  const auto s = ammosim::solveDP(p);
  CHECK(s.totalValue == 7);
  CHECK(s.totalAmmo == 2);
  CHECK(!s.targets[0].met && s.targets[0].ammo == 0);
  return g_failures == 0;
}

// Zero budget: nothing can be allocated.
bool testZeroBudget() {
  auto p = makeProblem(2, 2, 0);
  p.threshold = {1, 1};
  p.value = {5, 5};
  const auto s = ammosim::solveDP(p);
  CHECK(s.totalValue == 0);
  CHECK(s.totalAmmo == 0);
  return g_failures == 0;
}

// Randomized cross-validation of the DP against full vector enumeration.
// Four ammo types: exercises the full-width enumeration path.
bool testFourTypes() {
  auto p = makeProblem(2, 4, 6);
  p.threshold = {9, 5};
  p.value = {40, 25};
  setDamage(p, 0, {1, 1, 1, 1}, 9);   // only the full mix works
  setDamage(p, 0, {4, 0, 0, 0}, 3);
  setDamage(p, 1, {0, 0, 0, 2}, 5);
  const auto s = ammosim::solveDP(p);
  CHECK(s.totalValue == 65);
  CHECK(s.totalAmmo == 6);
  CHECK((s.targets[0].allocation == ammosim::AmmoVec{1, 1, 1, 1}));
  CHECK((s.targets[1].allocation == ammosim::AmmoVec{0, 0, 0, 2}));
  return g_failures == 0;
}

bool testCrossCheckRandom() {
  std::mt19937_64 rng(20261007);
  for (int iter = 0; iter < 300; ++iter) {
    std::uniform_int_distribution<int> tDist(1, 4), kDist(1, 3), bDist(0, 7);
    const int T = tDist(rng), K = kDist(rng), B = bDist(rng);
    auto p = makeProblem(T, K, B);
    std::uniform_real_distribution<double> dmgDist(0, 10), thrDist(0, 10),
        valDist(0, 20), coin(0, 1);
    for (int t = 0; t < T; ++t) {
      p.threshold[t] = thrDist(rng);
      p.value[t] = valDist(rng);
      ammosim::forEachVector(K, B, [&](const ammosim::AmmoVec& v) {
        if (coin(rng) < 0.35) setDamage(p, t, v, dmgDist(rng));
      });
    }
    const auto fast = ammosim::solveDP(p);
    const auto ref = ammosim::solveReference(p);
    CHECK(fast.totalValue == ref.totalValue);
    CHECK(fast.totalAmmo == ref.totalAmmo);
    CHECK(fast.totalAmmo <= B);
    int planAmmo = 0;
    double planValue = 0.0;
    for (int t = 0; t < T; ++t) {
      planAmmo += fast.targets[t].ammo;
      planValue += fast.targets[t].gained;
      CHECK(fast.targets[t].damage == p.damageOf(t, fast.targets[t].allocation));
    }
    CHECK(planAmmo == fast.totalAmmo);
    CHECK(planValue == fast.totalValue);
    if (g_failures > 0) {
      std::cerr << "cross-check failed at iter " << iter << " (T=" << T
                << " K=" << K << " B=" << B << ")\n";
      return false;
    }
  }
  return true;
}

// Same cross-check on the maximum 4-ammo-type width (smaller sizes).
bool testCrossCheckFourTypes() {
  std::mt19937_64 rng(424242);
  for (int iter = 0; iter < 150; ++iter) {
    std::uniform_int_distribution<int> tDist(1, 3), bDist(0, 6);
    const int T = tDist(rng), K = 4, B = bDist(rng);
    auto p = makeProblem(T, K, B);
    std::uniform_real_distribution<double> dmgDist(0, 10), thrDist(0, 10),
        valDist(0, 20), coin(0, 1);
    for (int t = 0; t < T; ++t) {
      p.threshold[t] = thrDist(rng);
      p.value[t] = valDist(rng);
      ammosim::forEachVector(K, B, [&](const ammosim::AmmoVec& v) {
        if (coin(rng) < 0.3) setDamage(p, t, v, dmgDist(rng));
      });
    }
    const auto fast = ammosim::solveDP(p);
    const auto ref = ammosim::solveReference(p);
    CHECK(fast.totalValue == ref.totalValue);
    CHECK(fast.totalAmmo == ref.totalAmmo);
    if (g_failures > 0) {
      std::cerr << "4-type cross-check failed at iter " << iter << " (T=" << T
                << " B=" << B << ")\n";
      return false;
    }
  }
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  const std::map<std::string, bool (*)()> tests = {
      {"linear_basic", testLinearBasic},
      {"nonlinear_synergy", testNonlinearSynergy},
      {"tie_break_ammo", testTieBreakAmmo},
      {"budget_limit", testBudgetLimit},
      {"unreachable_threshold", testUnreachableThreshold},
      {"zero_budget", testZeroBudget},
      {"four_types", testFourTypes},
      {"cross_check_random", testCrossCheckRandom},
      {"cross_check_four_types", testCrossCheckFourTypes},
  };
  if (argc != 2 || tests.count(argv[1]) == 0) {
    std::cerr << "usage: " << argv[0] << " <test-name>\navailable:";
    for (const auto& [name, fn] : tests) std::cerr << ' ' << name;
    std::cerr << '\n';
    return 2;
  }
  const bool ok = tests.at(argv[1])() && g_failures == 0;
  std::cout << argv[1] << (ok ? " PASS" : " FAIL") << '\n';
  return ok ? 0 : 1;
}
// Four ammo types: exercises the full-width enumeration path.
