"""Adaptive distinguishing tree synthesis.

A strategy tree applies an input at each internal node and branches on the
observed output, so the next input may depend on all previous outputs.  The
solver searches the space of candidate-state subsets with lower-bound
pruning to minimise the worst-case test length (tree depth).

Search budget exhaustion is not a proof of infeasibility: a partial result
returns the best tree found so far together with a certified lower bound.
Non-existence of a distinguishing tree is proved exactly over the finite
graph of reachable configurations (a minimum-depth tree never repeats a
configuration along a branch), and is backed by closure evidence: the
undistinguishable candidate subsets and, for each of them and every input,
either a merge of candidates or a successor configuration that is again
undistinguishable.
"""
from __future__ import annotations

import math
import sys
from collections import deque

from .pairs import PairAnalysis

LEAF = "leaf"
NODE = "node"


class BudgetExhausted(Exception):
    """Internal signal: the node expansion budget ran out."""


def make_leaf(state):
    return (LEAF, state)


def make_node(inp, children):
    return (NODE, inp, children)


def tree_depth(tree):
    if tree[0] == LEAF:
        return 0
    return 1 + max(tree_depth(child) for child in tree[2].values())


def count_nodes(tree):
    if tree[0] == LEAF:
        return 1
    return 1 + sum(count_nodes(child) for child in tree[2].values())


def count_unique_subtrees(tree):
    seen = set()

    def visit(node):
        seen.add(id(node))
        if node[0] == NODE:
            for child in node[2].values():
                visit(child)

    visit(tree)
    return len(seen)


def tree_to_json(tree):
    if tree[0] == LEAF:
        return {"type": "leaf", "state": tree[1]}
    return {
        "type": "node",
        "input": tree[1],
        "children": {out: tree_to_json(child) for out, child in tree[2].items()},
    }


def tree_from_json(data):
    if not isinstance(data, dict) or "type" not in data:
        raise ValueError("tree node must be an object with a 'type' field")
    if data["type"] == "leaf":
        return (LEAF, data["state"])
    if data["type"] == "node":
        return (
            NODE,
            data["input"],
            {out: tree_from_json(child) for out, child in data["children"].items()},
        )
    raise ValueError(f"unknown tree node type {data['type']!r}")


class Solver:
    """Synthesises minimum worst-case-depth adaptive distinguishing trees."""

    def __init__(self, machine, analysis=None):
        self.machine = machine
        self.analysis = analysis if analysis is not None else PairAnalysis(machine)
        self.memo_ok = {}    # config key -> (tree, depth), always sound to reuse
        self.memo_fail = {}  # config key -> max depth proven infeasible (context free)
        self.nodes = 0       # budgeted expansions (iterative deepening)
        self.ub_nodes = 0    # unbudgeted expansions (upper-bound computation)
        self.memo_hits = 0
        self.budget = 0
        self._unbudgeted = False
        self._next_depth = 0

    # -- configurations ---------------------------------------------------

    @staticmethod
    def root_config(initials):
        """A configuration maps each candidate initial state to its current state."""
        return tuple(sorted((s, s) for s in initials))

    def _partition(self, key, inp):
        """Split a configuration by the output observed for ``inp``.

        Returns ``{output: sub-config}`` or ``None`` when two candidates
        merge into the same successor state (they could never be separated
        again, so this input is useless here).
        """
        machine = self.machine
        blocks = {}
        for init, cur in key:
            out = machine.output(cur, inp)
            nxt = machine.successor(cur, inp)
            block = blocks.setdefault(out, [])
            if any(nxt == other for _, other in block):
                return None
            block.append((init, nxt))
        return {out: tuple(sorted(members)) for out, members in sorted(blocks.items())}

    def _feasible(self, key):
        curs = [cur for _, cur in key]
        for i in range(len(curs)):
            for j in range(i + 1, len(curs)):
                if not self.analysis.distinguishable(curs[i], curs[j]):
                    return False
        return True

    def _lower_bound(self, key):
        """Admissible lower bound on the depth of any tree for ``key``.

        Combines the information-theoretic bound with pairwise shortest
        witness lengths (a tree separates a pair only after replaying a
        preset witness for it along a shared path).
        """
        n = len(key)
        if n <= 1:
            return 0
        bound = 1
        curs = [cur for _, cur in key]
        for i in range(n):
            for j in range(i + 1, n):
                dist = self.analysis.distance(curs[i], curs[j])
                if dist is not None and dist > bound:
                    bound = dist
        fanout = len(self.machine.outputs)
        if fanout > 1:
            bound = max(bound, math.ceil(math.log(n, fanout)))
        return bound

    # -- depth-bounded search ---------------------------------------------

    def _solve(self, key, depth, ancestors):
        """Return ``(tree, depth, tainted)``; ``tree`` is ``None`` on failure.

        ``tainted`` marks results that depended on cutting a no-progress
        cycle (an ancestor configuration); such failures are context
        dependent and must not be cached.
        """
        if len(key) == 1:
            return (make_leaf(key[0][0]), 0, False)
        hit = self.memo_ok.get(key)
        if hit is not None and hit[1] <= depth:
            self.memo_hits += 1
            return (hit[0], hit[1], False)
        failed = self.memo_fail.get(key)
        if failed is not None and failed >= depth:
            self.memo_hits += 1
            return (None, 0, False)
        if self._unbudgeted:
            self.ub_nodes += 1
        else:
            if self.nodes >= self.budget:
                raise BudgetExhausted
            self.nodes += 1
        bound = self._lower_bound(key)
        if bound > depth:
            # Context-free infeasibility: safe to cache.
            self.memo_fail[key] = max(self.memo_fail.get(key, -1), bound - 1)
            return (None, 0, False)
        if key in ancestors:
            return (None, 0, True)
        if not self._feasible(key):
            # Context-free infeasibility: safe to cache with infinite depth.
            self.memo_fail[key] = 10 ** 9
            return (None, 0, False)
        ancestors = ancestors | {key}
        tainted = False
        for inp in self.machine.inputs:
            blocks = self._partition(key, inp)
            if blocks is None:
                continue
            if any(block in ancestors for block in blocks.values()):
                # No-progress cycle; a minimum-depth tree never repeats a
                # configuration along a path, so skipping is complete, but
                # the outcome depends on the call context.
                tainted = True
                continue
            children = {}
            worst = 0
            feasible = True
            for out, block in blocks.items():
                sub, sub_depth, sub_tainted = self._solve(block, depth - 1, ancestors)
                tainted = tainted or sub_tainted
                if sub is None:
                    feasible = False
                    break
                children[out] = sub
                worst = max(worst, sub_depth)
            if feasible:
                tree = make_node(inp, children)
                result = (tree, 1 + worst)
                current = self.memo_ok.get(key)
                if current is None or result[1] < current[1]:
                    self.memo_ok[key] = result
                return (result[0], result[1], tainted)
        if not tainted:
            self.memo_fail[key] = max(self.memo_fail.get(key, -1), depth)
        return (None, 0, tainted)

    # -- exact feasibility over the reachable configuration graph -----------

    def _reachable_configs(self, key):
        """All configurations reachable from ``key`` via merge-free splits."""
        seen = {key}
        queue = deque([key])
        while queue:
            config = queue.popleft()
            if len(config) <= 1:
                continue
            for inp in self.machine.inputs:
                blocks = self._partition(config, inp)
                if blocks is None:
                    continue
                for block in blocks.values():
                    if block not in seen:
                        seen.add(block)
                        queue.append(block)
        return seen

    def _unsolvable_configs(self, configs):
        """Configs from which no distinguishing tree exists (exact fixpoint).

        A configuration is solvable iff it is a singleton or some input
        splits it (without merges) into solvable blocks.  Everything else
        is unsolvable; the unsolvable set is closed in the sense that for
        each of its configurations and each input, candidates either merge
        or some successor block is again unsolvable.
        """
        winning = {config for config in configs if len(config) == 1}
        changed = True
        while changed:
            changed = False
            for config in configs:
                if config in winning:
                    continue
                for inp in self.machine.inputs:
                    blocks = self._partition(config, inp)
                    if blocks is None:
                        continue
                    if all(block in winning for block in blocks.values()):
                        winning.add(config)
                        changed = True
                        break
        return set(configs) - winning

    def _closure_evidence(self, unsolvable):
        """Per-configuration, per-input evidence of undistinguishability."""
        entries = []
        for config in sorted(unsolvable):
            inputs_info = []
            for inp in self.machine.inputs:
                blocks = self._partition(config, inp)
                if blocks is None:
                    collisions = []
                    seen_next = {}
                    for init, cur in config:
                        probe = (
                            self.machine.output(cur, inp),
                            self.machine.successor(cur, inp),
                        )
                        if probe in seen_next:
                            collisions.append(
                                [seen_next[probe], init, probe[1]]
                            )
                        else:
                            seen_next[probe] = init
                    inputs_info.append(
                        {"input": inp, "reason": "merge", "collisions": collisions}
                    )
                else:
                    bad = [b for b in blocks.values() if b in unsolvable]
                    inputs_info.append(
                        {
                            "input": inp,
                            "reason": "unsolvable-successor",
                            "successors": [[list(pair) for pair in b] for b in bad],
                        }
                    )
            entries.append(
                {
                    "config": [list(pair) for pair in config],
                    "inputs": inputs_info,
                }
            )
        return entries

    @staticmethod
    def _maximal_subsets(unsolvable):
        """Inclusion-maximal candidate subsets that cannot be told apart."""
        init_sets = {frozenset(init for init, _ in config) for config in unsolvable}
        maximal = [s for s in init_sets if not any(s < other for other in init_sets)]
        return sorted((sorted(s) for s in maximal), key=lambda l: (-len(l), l))

    # -- top level ----------------------------------------------------------

    def solve(self, initials=None, budget=100000, resume=None):
        """Search for a minimum worst-case-depth tree for ``initials``.

        ``budget`` bounds the number of configuration expansions of this
        call.  ``resume`` accepts a state dictionary from an earlier partial
        result and continues the search where it stopped.
        """
        if initials is None:
            initials = list(self.machine.user_states)
        initials = list(initials)
        if not initials:
            raise ValueError("initial state set must not be empty")
        unknown = [s for s in initials if s not in self.machine.states]
        if unknown:
            raise ValueError(f"unknown initial states: {unknown}")
        if len(set(initials)) != len(initials):
            raise ValueError("duplicate initial states")
        key = self.root_config(initials)
        if resume is not None:
            self._load_state(resume, initials)
        self.budget = self.nodes + budget

        # Exact feasibility: a minimum-depth tree never repeats a
        # configuration along a branch, so any feasible configuration admits
        # a tree shallower than the number of reachable configurations.
        configs = self._reachable_configs(key)
        self._reachable_count = len(configs)
        if len(configs) + 100 > sys.getrecursionlimit():
            sys.setrecursionlimit(len(configs) + 1000)
        # Computed outside the budget so that feasibility is always decided
        # exactly and a partial result always carries a valid tree.
        self._unbudgeted = True
        try:
            ub = self._solve(key, len(configs), frozenset())
        finally:
            self._unbudgeted = False
        if ub is None or ub[0] is None:
            return self._infeasible_result(initials, configs)
        ub_tree, ub_depth = ub[0], ub[1]

        lower = self._lower_bound(key)
        start = max(lower, self._next_depth)
        try:
            for depth in range(start, ub_depth + 1):
                self._next_depth = depth
                tree, found, _ = self._solve(key, depth, frozenset())
                if tree is not None:
                    return {
                        "status": "optimal",
                        "optimal": True,
                        "depth": found,
                        "lower_bound": found,
                        "upper_bound": found,
                        "tree": tree,
                        "initials": initials,
                        "stats": self._stats(budget),
                        "resume_state": None,
                    }
            raise AssertionError("unreachable: upper bound is feasible")
        except BudgetExhausted:
            return {
                "status": "partial",
                "optimal": False,
                "depth": ub_depth,
                "lower_bound": self._next_depth,
                "upper_bound": ub_depth,
                "tree": ub_tree,
                "initials": initials,
                "stats": self._stats(budget),
                "resume_state": self._dump_state(initials),
            }

    def _infeasible_result(self, initials, configs):
        unsolvable = self._unsolvable_configs(configs)
        eq_pairs = self.analysis.equivalent_pairs(initials)
        return {
            "status": "infeasible",
            "optimal": False,
            "depth": None,
            "lower_bound": None,
            "upper_bound": None,
            "tree": None,
            "initials": list(initials),
            "equivalent_pairs": [list(pair) for pair in eq_pairs],
            "equivalent_classes": self.analysis.equivalent_classes(initials),
            "undistinguishable_subsets": self._maximal_subsets(unsolvable),
            "evidence": self._closure_evidence(unsolvable),
            "stats": self._stats(0),
            "resume_state": None,
        }

    def _stats(self, budget):
        return {
            "nodes": self.nodes,
            "ub_nodes": self.ub_nodes,
            "memo_hits": self.memo_hits,
            "cached_subproblems": len(self.memo_ok),
            "reachable_configs": getattr(self, "_reachable_count", 0),
            "budget": budget,
        }

    # -- pause / resume -----------------------------------------------------

    def _dump_state(self, initials):
        return {
            "version": 1,
            "initials": list(initials),
            "nodes": self.nodes,
            "next_depth": self._next_depth,
            "memo_ok": [
                [[list(pair) for pair in key], tree_to_json(tree), depth]
                for key, (tree, depth) in sorted(self.memo_ok.items())
            ],
            "memo_fail": [
                [[list(pair) for pair in key], depth]
                for key, depth in sorted(self.memo_fail.items())
            ],
        }

    def _load_state(self, state, initials):
        if state.get("version") != 1:
            raise ValueError("unsupported resume state version")
        if list(state.get("initials", [])) != list(initials):
            raise ValueError("resume state was created for different initials")
        self.nodes = int(state.get("nodes", 0))
        self._next_depth = int(state.get("next_depth", 0))
        for raw_key, raw_tree, depth in state.get("memo_ok", []):
            key = tuple(tuple(pair) for pair in raw_key)
            self.memo_ok[key] = (tree_from_json(raw_tree), int(depth))
        for raw_key, depth in state.get("memo_fail", []):
            key = tuple(tuple(pair) for pair in raw_key)
            self.memo_fail[key] = int(depth)
