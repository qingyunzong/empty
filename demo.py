"""Run samples: feasibility checks, Hall conflicts, support filtering."""

import sys

sys.path.insert(0, "src")

from all_different import check_feasible, propagate
from independent_check import (
    enumerate_solutions,
    exhaustive_supported_pairs,
    is_all_different_solution,
    supported_pairs_to_domains,
)


def show(title, domains):
    print("=" * 64)
    print(title)
    print(f"  domains: {domains}")
    result = check_feasible(domains)
    if result.feasible:
        print(f"  feasible: YES, witness matching = {result.witness}")
        valid = is_all_different_solution(result.witness, domains)
        print(f"  independent checker validates witness: {valid}")
    else:
        print("  feasible: NO")
        print(f"  Hall conflict: {result.hall_conflict}")

    prop = propagate(domains)
    if prop.feasible:
        print(f"  after support filtering: {prop.pruned_domains}")
        print(f"  removed values:         {prop.removed}")
        supported = exhaustive_supported_pairs(domains)
        expected = supported_pairs_to_domains(domains, supported)
        print(f"  exhaustive reference:   {expected}")
        print(f"  matches brute force:    {prop.pruned_domains == expected}")
    else:
        print(f"  propagation reports Hall conflict: {prop.hall_conflict}")


def main():
    show("Sample 1: three variables, all domains {1, 2} -> infeasible",
         {"x": [1, 2], "y": [1, 2], "z": [1, 2]})

    show("Sample 2: z is fixed to 1; 1 must disappear elsewhere",
         {"x": [1, 2, 3], "y": [1, 2], "z": [1]})

    show("Sample 3: pairwise-assigned check would miss a global Hall set",
         {"a": [1, 2], "b": [1, 2], "c": [1, 2, 3],
          "d": [3, 4], "e": [3, 4]})

    show("Sample 4: a plain feasible case",
         {"x": [1, 2], "y": [2, 3], "z": [3, 4]})

    print("=" * 64)
    print("Solutions of sample 4 (independent enumeration):")
    for solution in enumerate_solutions(
        {"x": [1, 2], "y": [2, 3], "z": [3, 4]}
    ):
        print(f"  {solution}")


if __name__ == "__main__":
    main()
