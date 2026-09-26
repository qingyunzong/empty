"""Independent reference checker (brute force), separate from the matcher.

These routines enumerate assignments directly from the *original* domains
and know nothing about augmenting paths or Dulmage-Mendelsohn theory, so
they can independently validate every positive claim made by
``all_different``.
"""

from __future__ import annotations

from itertools import product
from typing import Mapping


def is_all_different_solution(assignment: Mapping, domains: Mapping) -> bool:
    """Verify an assignment against the original constraint and domains."""
    if set(assignment) != set(domains):
        return False
    for name, value in assignment.items():
        if value not in domains[name]:
            return False
    return len(set(assignment.values())) == len(assignment)


def enumerate_solutions(domains: Mapping):
    """Yield every allDifferent solution by exhaustive Cartesian product."""
    names = list(domains)
    for combo in product(*(domains[name] for name in names)):
        assignment = dict(zip(names, combo))
        if is_all_different_solution(assignment, domains):
            yield assignment


def has_solution(domains: Mapping) -> bool:
    return next(enumerate_solutions(domains), None) is not None


def exhaustive_supported_pairs(domains: Mapping) -> set:
    """Every (variable, value) pair that occurs in at least one solution."""
    supported: set = set()
    for assignment in enumerate_solutions(domains):
        for name, value in assignment.items():
            supported.add((name, value))
    return supported


def supported_pairs_to_domains(domains: Mapping, supported: set) -> dict:
    return {
        name: [value for value in domains[name] if (name, value) in supported]
        for name in domains
    }
