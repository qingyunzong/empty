"""Independent brute-force verification for small machines.

Two independent enumerations:
  * preset sequences of increasing length, checking whether the output
    map separates all states;
  * adaptive strategy trees of increasing depth, built by enumerating
    every input at every node and every combination of child strategies.

Both return the minimal length/depth or ``None`` when impossible, and
are used to cross-check the branch-and-bound solver.
"""

from __future__ import annotations

from itertools import product
from typing import Dict, FrozenSet, List, Optional, Sequence, Tuple

from .machine import MealyMachine
from .pairs import PairAnalysis
from .tree import TreeNode

MAX_STATES = 10
MAX_DEPTH = 8
MAX_PRESET_DEPTH = 12


def _check_limits(machine: MealyMachine, max_depth: int, cap: int = MAX_DEPTH) -> None:
    if len(machine.states) > MAX_STATES:
        raise ValueError("brute force is limited to machines with at most 10 states")
    if max_depth > cap:
        raise ValueError(f"brute force depth is capped at {cap}")


def optimal_preset_length(machine: MealyMachine, states: Optional[Sequence[str]] = None,
                        max_depth: int = MAX_PRESET_DEPTH) -> Optional[int]:
    """Minimal L such that some preset sequence of length L separates all states."""
    _check_limits(machine, max_depth, cap=MAX_PRESET_DEPTH)
    target = list(states) if states is not None else list(machine.states)
    if len(target) <= 1:
        return 0
    for length in range(1, max_depth + 1):
        for seq in product(machine.inputs, repeat=length):
            seen = set()
            ok = True
            for state in target:
                signature = tuple(machine.run(state, seq))
                if signature in seen:
                    ok = False
                    break
                seen.add(signature)
            if ok:
                return length
    return None


def _strategies(machine: MealyMachine, states: FrozenSet[str], depth: int,
                memo: Dict[Tuple[FrozenSet[str], int], List[TreeNode]]) -> List[TreeNode]:
    """All strategy trees of height <= depth for the candidate set."""
    key = (states, depth)
    if key in memo:
        return memo[key]
    if len(states) <= 1:
        only = next(iter(states), None)
        return [TreeNode.leaf(only)] if only is not None else []
    if depth == 0:
        memo[key] = []
        return []
    results: List[TreeNode] = []
    for symbol in machine.inputs:
        groups: Dict[str, List[str]] = {}
        merges = False
        for state in states:
            nxt, out = machine.step(state, symbol)
            group = groups.setdefault(out, [])
            if nxt in group:
                merges = True  # candidates converge: futures identical
                break
            group.append(nxt)
        if merges:
            continue
        child_options: List[List[Tuple[str, TreeNode]]] = []
        for out, group in sorted(groups.items()):
            sub = _strategies(machine, frozenset(group), depth - 1, memo)
            if not sub:
                child_options = []
                break
            child_options.append([(out, tree) for tree in sub])
        if not child_options:
            continue
        for combo in product(*child_options):
            children = {out: tree for out, tree in combo}
            results.append(TreeNode.node(tuple(sorted(states)), symbol, children))
    memo[key] = results
    return results


def optimal_adaptive_depth(machine: MealyMachine, states: Optional[Sequence[str]] = None,
                           max_depth: int = MAX_DEPTH) -> Optional[int]:
    """Minimal worst-case depth of any adaptive strategy, by enumeration."""
    _check_limits(machine, max_depth)
    target = frozenset(states) if states is not None else frozenset(machine.states)
    if len(target) <= 1:
        return 0
    memo: Dict[Tuple[FrozenSet[str], int], List[TreeNode]] = {}
    for depth in range(1, max_depth + 1):
        if _strategies(machine, target, depth, memo):
            return depth
    return None


def exhaustive_check(machine: MealyMachine, solver_height: Optional[int],
                     max_depth: int = MAX_DEPTH) -> dict:
    """Cross-check a solver result against both brute-force enumerations."""
    adaptive = optimal_adaptive_depth(machine, max_depth=max_depth)
    preset = optimal_preset_length(machine, max_depth=max_depth)
    pairs = PairAnalysis(machine)
    pairwise_ok = not pairs.indistinguishable_pairs()
    return {
        "adaptive_optimal": adaptive,
        "preset_optimal": preset,
        "solver_height": solver_height,
        "pairwise_distinguishable": pairwise_ok,
        "consistent": (solver_height == adaptive) and (pairwise_ok == (adaptive is not None)),
    }
