#include <cstdlib>
#include <iostream>
#include <string>

#include "solver.h"

namespace {

void usage(const char* prog) {
  std::cerr
      << "Usage: " << prog << " [--reference|--check] < input.txt\n"
      << "\n"
      << "Input format (whitespace separated):\n"
      << "  T K B                 targets(<=10) ammo-types(<=4) budget(<=20)\n"
      << "  threshold_1 .. thr_T  damage threshold per target\n"
      << "  value_1 .. value_T    value per target\n"
      << "  E                     number of damage-table entries\n"
      << "  t a_1 .. a_K damage   (E lines) discrete damage table, missing => 0\n";
}

}  // namespace

int main(int argc, char** argv) {
  bool useReference = false;
  bool check = false;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--reference") {
      useReference = true;
    } else if (arg == "--check") {
      check = true;
    } else {
      usage(argv[0]);
      return 2;
    }
  }

  ammosim::Problem p;
  if (!(std::cin >> p.numTargets >> p.numTypes >> p.budget)) {
    usage(argv[0]);
    return 2;
  }
  if (p.numTargets < 1 || p.numTargets > ammosim::kMaxTargets || p.numTypes < 1 ||
      p.numTypes > ammosim::kMaxTypes || p.budget < 0 || p.budget > ammosim::kMaxBudget) {
    std::cerr << "error: limits are targets<=" << ammosim::kMaxTargets
              << " types<=" << ammosim::kMaxTypes << " budget<=" << ammosim::kMaxBudget
              << '\n';
    return 2;
  }
  p.threshold.resize(p.numTargets);
  p.value.resize(p.numTargets);
  p.damage.resize(p.numTargets);
  for (auto& x : p.threshold) std::cin >> x;
  for (auto& x : p.value) std::cin >> x;
  int entries = 0;
  std::cin >> entries;
  for (int e = 0; e < entries; ++e) {
    int t = 0;
    ammosim::AmmoVec v{};
    double d = 0.0;
    std::cin >> t;
    for (int i = 0; i < p.numTypes; ++i) std::cin >> v[i];
    std::cin >> d;
    if (t < 0 || t >= p.numTargets || ammosim::ammoCost(v, p.numTypes) > p.budget) {
      std::cerr << "error: bad table entry " << e << '\n';
      return 2;
    }
    p.damage[t][ammosim::encode(v, p.numTypes)] = d;
  }
  if (!std::cin) {
    std::cerr << "error: malformed input\n";
    return 2;
  }

  if (check) {
    const ammosim::Solution fast = ammosim::solveDP(p);
    const ammosim::Solution ref = ammosim::solveReference(p);
    std::cout << ammosim::renderTable(p, fast);
    if (fast.totalValue == ref.totalValue && fast.totalAmmo == ref.totalAmmo) {
      std::cout << "CHECK PASS: DP == reference (value=" << ref.totalValue
                << " ammo=" << ref.totalAmmo << ")\n";
      return 0;
    }
    std::cout << "CHECK FAIL: DP(value=" << fast.totalValue << " ammo=" << fast.totalAmmo
              << ") != reference(value=" << ref.totalValue << " ammo=" << ref.totalAmmo
              << ")\n";
    return 1;
  }

  const ammosim::Solution sol = useReference ? ammosim::solveReference(p) : ammosim::solveDP(p);
  std::cout << ammosim::renderTable(p, sol);
  return 0;
}
