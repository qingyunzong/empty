"""Adaptive distinguishing tree synthesis.

Exact branch-and-bound over adaptive experiments.  A subproblem is the
set of *current* states the black box may be in (the uncertainty set).
Applying an input is only allowed when it keeps the candidate mapping
injective: two candidates that emit the same output must not move to the
same successor, otherwise their futures merge and no continuation can
ever tell them apart.  Inputs that do not split the uncertainty set are
still considered, because moving without splitting can be necessary
(e.g. a pair whose shortest separating sequence only diverges at the
end).

Lower bounds used for pruning:
  * information bound ceil(log_fanout(|S|)) with the best valid fanout;
  * pairwise bound: the shortest preset witness of the hardest pair of
    current states bounds any adaptive continuation.

When the node budget or time limit is exhausted the best complete tree
found so far is returned together with the lower bound, without
claiming optimality.  A previous status can be carried into a new run
to resume the search with its memo table and bound cache.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Dict, FrozenSet, List, Optional, Sequence, Tuple

from .machine import MealyMachine
from .pairs import PairAnalysis
from .tree import TreeNode, label_leaves

StateSet = FrozenSet[str]
IMPOSSIBLE = 10**9


@dataclass
class SolveStatus:
    machine: MealyMachine
    pair_analysis: PairAnalysis
    root_states: Tuple[str, ...]
    best: Optional[TreeNode] = None
    best_height: Optional[int] = None
    lower_bound: int = 0
    optimal: bool = False
    possible: bool = True
    exhausted: bool = False
    nodes_expanded: int = 0
    budget: int = 100_000
    time_limit: Optional[float] = None
    _start: float = field(default=0.0, repr=False)
    _memo: Dict[StateSet, Optional[Tuple[TreeNode, int]]] = field(default_factory=dict, repr=False)
    _active: set = field(default_factory=set, repr=False)
    _partial: Dict[StateSet, TreeNode] = field(default_factory=dict, repr=False)
    _lb_cache: Dict[StateSet, int] = field(default_factory=dict, repr=False)

    def tick(self) -> None:
        self.nodes_expanded += 1
        if self.nodes_expanded > self.budget:
            raise BudgetExhausted
        if self.time_limit is not None and time.monotonic() - self._start > self.time_limit:
            raise BudgetExhausted

    def current_tree(self) -> Optional[TreeNode]:
        tree = self.best if self.best is not None else self._partial.get(frozenset(self.root_states))
        if tree is not None:
            # Memoised subtrees are shared (the search graph is a DAG);
            # materialise an unshared copy so every leaf can carry the
            # unique initial state whose trace ends there.
            tree = TreeNode.from_dict(tree.to_dict())
            label_leaves(self.machine, tree, self.root_states)
        return tree

    def to_dict(self) -> dict:
        tree = self.current_tree()
        data = {
            "status": "optimal" if self.optimal else ("impossible" if not self.possible else "partial"),
            "possible": self.possible,
            "optimal": self.optimal,
            "height": None if tree is None else tree.height(),
            "lower_bound": self.lower_bound,
            "nodes_expanded": self.nodes_expanded,
            "tree": None if tree is None else tree.to_dict(),
        }
        if not self.possible:
            data["indistinguishable"] = self.indistinguishable_report()
        return data

    def indistinguishable_report(self) -> dict:
        """Maximal indistinguishable subsets plus closure evidence.

        For every state of each non-trivial class and every input, the
        emitted output and the class containing the successor are
        recorded; two states of a class emit identical outputs and their
        successors stay inside common classes, which is exactly the
        closure argument proving that no experiment can separate them.
        """
        machine = self.machine
        classes = self.pair_analysis.equivalence_classes()
        non_trivial = [c for c in classes if len(c) > 1]

        def class_of(state: str) -> List[str]:
            for group in classes:
                if state in group:
                    return list(group)
            return [state]

        evidence = []
        for group in non_trivial:
            closure = []
            for state in group:
                for symbol in machine.inputs:
                    nxt, out = machine.step(state, symbol)
                    closure.append(
                        {
                            "state": state,
                            "input": symbol,
                            "output": out,
                            "next": nxt,
                            "next_class": class_of(nxt),
                        }
                    )
            evidence.append({"states": list(group), "closure": closure})
        return {"classes": [list(c) for c in non_trivial], "evidence": evidence}


class BudgetExhausted(Exception):
    pass


class DistinguishingTreeSolver:
    def __init__(self, machine: MealyMachine, pair_analysis: Optional[PairAnalysis] = None) -> None:
        self.machine = machine
        self.pairs = pair_analysis or PairAnalysis(machine)
        self._pair_dist: Dict[StateSet, int] = {}
        for a, b in self.pairs.distinguishable_pairs():
            witness = self.pairs.witness(a, b)
            self._pair_dist[frozenset((a, b))] = len(witness)
        self._status: Optional[SolveStatus] = None

    # -- semantics ---------------------------------------------------------
    def _components(self, states: StateSet, symbol: str) -> Optional[Dict[str, StateSet]]:
        """Successor sets per output, or None if the input merges candidates."""
        groups: Dict[str, set] = {}
        for state in states:
            nxt, out = self.machine.step(state, symbol)
            group = groups.setdefault(out, set())
            if nxt in group:
                return None  # two candidates converge: futures become identical
            group.add(nxt)
        return {out: frozenset(group) for out, group in groups.items()}

    # -- lower bounds ------------------------------------------------------
    def _pairwise_bound(self, states: StateSet) -> int:
        bound = 1
        listing = sorted(states)
        for i in range(len(listing)):
            for j in range(i + 1, len(listing)):
                dist = self._pair_dist.get(frozenset((listing[i], listing[j])))
                if dist is None:
                    return IMPOSSIBLE
                if dist > bound:
                    bound = dist
        return bound

    def _lower_bound(self, states: StateSet) -> int:
        status = self._status
        if status is not None and states in status._lb_cache:
            return status._lb_cache[states]
        bound = self._pairwise_bound(states)
        best_fanout = 1
        for symbol in self.machine.inputs:
            part = self._components(states, symbol)
            if part is not None and len(part) > best_fanout:
                best_fanout = len(part)
        if best_fanout > 1:
            bound = max(bound, math.ceil(math.log(len(states), best_fanout)))
        if status is not None:
            status._lb_cache[states] = bound
        return bound

    # -- main entry --------------------------------------------------------
    def solve(
        self,
        states: Optional[Sequence[str]] = None,
        budget: int = 100_000,
        time_limit: Optional[float] = None,
        carry: Optional[SolveStatus] = None,
    ) -> SolveStatus:
        root = tuple(states) if states is not None else self.machine.states
        status = SolveStatus(
            machine=self.machine,
            pair_analysis=self.pairs,
            root_states=tuple(root),
            budget=budget,
            time_limit=time_limit,
        )
        status._start = time.monotonic()
        self._status = status
        if carry is not None:
            status._memo.update(carry._memo)
            status._lb_cache.update(carry._lb_cache)
        root_set = frozenset(root)

        if len(root_set) <= 1:
            status.best = TreeNode.leaf(root[0]) if root else None
            status.best_height = 0
            status.optimal = True
            return status
        status.lower_bound = self._lower_bound(root_set)
        if status.lower_bound >= IMPOSSIBLE:
            status.possible = False
            return status

        try:
            result = self._solve_subset(root_set, status)
        except BudgetExhausted:
            status.exhausted = True
            return status
        if result is None:
            status.possible = False
            return status
        status.best, status.best_height = result
        status.optimal = True
        return status

    # -- branch and bound --------------------------------------------------
    def _solve_subset(self, states: StateSet, status: SolveStatus) -> Optional[Tuple[TreeNode, int]]:
        if len(states) <= 1:
            only = next(iter(states), None)
            return (TreeNode.leaf(only), 0) if only is not None else None
        if states in status._memo:
            return status._memo[states]
        if states in status._active:
            return None  # cyclic move: an optimal tree never revisits a subset
        status.tick()
        status._active.add(states)
        try:
            result = self._expand(states, status)
        finally:
            status._active.discard(states)
        status._memo[states] = result
        return result

    def _expand(self, states: StateSet, status: SolveStatus) -> Optional[Tuple[TreeNode, int]]:
        best_tree: Optional[TreeNode] = None
        best_height: Optional[int] = None
        lower = self._lower_bound(states)
        if lower >= IMPOSSIBLE:
            return None

        options = []
        for symbol in self.machine.inputs:
            part = self._components(states, symbol)
            if part is None:
                continue
            worst = max(len(group) for group in part.values())
            options.append((symbol, part, worst, -len(part)))
        # Prefer inputs that split well and leave small components.
        options.sort(key=lambda item: (item[2], item[3]))

        for symbol, part, _worst, _neg_fanout in options:
            components = sorted(part.items(), key=lambda kv: -len(kv[1]))
            if best_height is not None:
                optimistic = 1 + max(
                    self._lower_bound(group) if len(group) > 1 else 0
                    for _, group in components
                )
                if optimistic >= best_height:
                    continue
            children: Dict[str, TreeNode] = {}
            worst_height = 0
            failed = False
            for out, group in components:
                child = self._solve_subset(group, status)
                if child is None:
                    failed = True
                    break
                child_tree, child_height = child
                if best_height is not None and 1 + max(worst_height, child_height) >= best_height:
                    failed = True
                    break
                children[out] = child_tree
                worst_height = max(worst_height, child_height)
            if failed:
                continue
            height = 1 + worst_height
            if best_height is None or height < best_height:
                best_height = height
                best_tree = TreeNode.node(tuple(sorted(states)), symbol, dict(children))
                status._partial[states] = best_tree
                if height <= lower:
                    break  # matches the lower bound: cannot do better
        if best_tree is None:
            return None
        return best_tree, best_height
