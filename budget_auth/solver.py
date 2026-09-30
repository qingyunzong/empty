"""Constraint solver: decide a legal split of a request amount across the
eligible budgets of a nested budget forest.

Feasibility constraints (all integer):
  * sum of the allocation == requested amount
  * for every budget node u on any ancestor chain of an eligible budget,
    the sum of allocations in u's subtree stays within u's remaining quota
    (a shared parent is charged once per allocated unit, never twice)
  * each allocation to budget b stays within b's per-request cap (derived
    from the matching rules' remaining limits)

Optimisation: fewest occupied budgets first, then deterministic preference
for smaller budget ids (combinations in lexicographic id order, then the
canonical assignment that loads smaller ids first).

On infeasibility the solver returns a minimal unsatisfiable constraint
subset (an irreducible core) together with the numbers needed to verify it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations
from math import inf

from .model import Budget, ancestor_chain

INF = inf


@dataclass
class Constraint:
    """One capacity constraint referenced by an unsat core."""
    kind: str            # "capacity" | "rule_cap"
    budget: str
    quota: int | None    # None for rule_cap
    held: int | None     # None for rule_cap
    remaining: int       # the bound that matters (capacity remaining or cap)

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "budget": self.budget,
            "quota": self.quota,
            "held": self.held,
            "remaining": self.remaining,
        }


@dataclass
class UnsatCore:
    amount: int
    eligible: list[str]
    constraints: list[Constraint]
    max_allocatable: int

    def as_dict(self) -> dict:
        return {
            "amount": self.amount,
            "eligible": list(self.eligible),
            "max_allocatable": self.max_allocatable,
            "constraints": [c.as_dict() for c in self.constraints],
        }


class AllocationRejected(Exception):
    def __init__(self, core: UnsatCore, reason: str = "insufficient budget"):
        super().__init__(reason)
        self.core = core
        self.reason = reason


class _Problem:
    """Solver view over a forest with per-node remaining capacities."""

    def __init__(self, budgets: dict[str, Budget], held: dict[str, int],
                 caps: dict[str, int | float]):
        self.budgets = budgets
        self.caps = dict(caps)                      # eligible budget -> cap
        self.children: dict[str, list[str]] = {b: [] for b in budgets}
        self.roots: list[str] = []
        for bid, b in budgets.items():
            if b.parent is not None and b.parent in budgets:
                self.children[b.parent].append(bid)
            else:
                self.roots.append(bid)
        # relevant nodes: eligible budgets and all their ancestors
        self.relevant: set[str] = set()
        for bid in caps:
            self.relevant.update(ancestor_chain(budgets, bid))
        self.remaining: dict[str, int | float] = {}
        for node in self.relevant:
            self.remaining[node] = budgets[node].quota - held.get(node, 0)

    # -- feasibility ----------------------------------------------------
    def max_alloc(self, active: set | None = None) -> int:
        """Maximum allocatable total under the given active constraints.

        ``active`` is a set of constraint keys; inactive constraints are
        relaxed to infinity.  Keys: ("capacity", node) / ("rule_cap", node).
        """
        def on(kind: str, node: str) -> bool:
            return active is None or (kind, node) in active

        memo: dict[str, int | float] = {}

        def rec(node: str) -> int | float:
            if node in memo:
                return memo[node]
            total = 0.0
            if node in self.caps and on("rule_cap", node):
                total += self.caps[node]
            elif node in self.caps:
                total += INF
            for child in self.children[node]:
                if child in self.relevant:
                    total += rec(child)
            if on("capacity", node):
                total = min(total, self.remaining[node])
            memo[node] = total
            return total

        total = 0.0
        for root in self.roots:
            if root in self.relevant:
                total += rec(root)
        return total if total != INF else (1 << 62)

    def feasible(self, amount: int, active: set | None = None) -> bool:
        return self.max_alloc(active) >= amount

    # -- enumeration ----------------------------------------------------
    def enumerate_all(self, amount: int):
        """Yield every legal allocation {budget: amt} (amt > 0)."""
        bids = sorted(self.caps)
        chains = {b: ancestor_chain(self.budgets, b) for b in bids}
        used: dict[str, int] = {n: 0 for n in self.relevant}

        def rec(i: int, left: int, current: dict[str, int]):
            if left == 0:
                yield dict(current)
                return
            if i == len(bids):
                return
            # prune: even the relaxed subtree capacity must cover `left`
            b = bids[i]
            upper = min(left, self.caps[b])
            for node in chains[b]:
                upper = min(upper, self.remaining[node] - used[node])
            for x in range(int(upper), -1, -1):
                if x:
                    for node in chains[b]:
                        used[node] += x
                    current[b] = x
                yield from rec(i + 1, left - x, current)
                if x:
                    del current[b]
                    for node in chains[b]:
                        used[node] -= x

        yield from rec(0, amount, {})

    # -- optimum --------------------------------------------------------
    def solve(self, amount: int) -> dict[str, int]:
        """Deterministic optimum: fewest budgets, then id order."""
        bids = sorted(self.caps)
        for k in range(1, len(bids) + 1):
            for combo in combinations(bids, k):
                sub = _SubProblem(self, combo)
                alloc = sub.canonical(amount)
                if alloc is not None:
                    return alloc
        raise AllocationRejected(self.unsat_core(amount))

    # -- unsat core -----------------------------------------------------
    def all_constraints(self) -> list[Constraint]:
        cons = []
        for node in sorted(self.relevant):
            rem = self.remaining[node]
            cons.append(Constraint("capacity", node,
                                   self.budgets[node].quota,
                                   self.budgets[node].quota - int(rem),
                                   int(rem)))
        for b in sorted(self.caps):
            if self.caps[b] != INF:
                cons.append(Constraint("rule_cap", b, None, None,
                                       int(self.caps[b])))
        return cons

    def unsat_core(self, amount: int) -> UnsatCore:
        cons = self.all_constraints()
        keys = [(c.kind, c.budget) for c in cons]
        active = set(keys)
        # greedy irreducibility: drop every constraint whose removal keeps
        # the instance infeasible
        for key in keys:
            trial = active - {key}
            if not self.feasible(amount, trial):
                active = trial
        core = [c for c, k in zip(cons, keys) if k in active]
        return UnsatCore(amount, sorted(self.caps), core,
                         int(self.max_alloc(active)))

    def verify_core(self, amount: int, core: UnsatCore) -> bool:
        """Independent check that the core is unsatisfiable and minimal."""
        keys = {(c.kind, c.budget) for c in core.constraints}
        if self.feasible(amount, keys):
            return False
        for key in keys:
            if not self.feasible(amount, keys - {key}):
                return False
        return True


class _SubProblem:
    """Feasibility / canonical assignment restricted to a chosen subset."""

    def __init__(self, prob: _Problem, combo: tuple[str, ...]):
        self.prob = prob
        self.combo = combo
        self.chains = {b: ancestor_chain(prob.budgets, b) for b in combo}

    def _feasible(self, used: dict[str, int], bids: tuple[str, ...],
                  left: int) -> bool:
        """Can `left` still be placed on `bids` given `used` per node?"""
        prob = self.prob
        caps = {b: prob.caps[b] for b in bids}
        sub = _Problem(prob.budgets,
                       {n: prob.budgets[n].quota - int(prob.remaining[n])
                        + used.get(n, 0) for n in prob.relevant},
                       caps)
        return sub.feasible(left)

    def canonical(self, amount: int) -> dict[str, int] | None:
        """Lexicographic-max assignment in id order; exact via feasibility
        re-checks (plain greedy can fail on shared parents)."""
        prob = self.prob
        used: dict[str, int] = {n: 0 for n in prob.relevant}
        if not self._feasible(used, self.combo, amount):
            return None
        alloc: dict[str, int] = {}
        left = amount
        for i, b in enumerate(self.combo):
            upper = int(min(left, prob.caps[b],
                            *[prob.remaining[n] - used[n]
                              for n in self.chains[b]]))
            # largest x that keeps the remainder feasible; feasibility in
            # x is not monotone (shared parents), so scan linearly
            lo = 0
            for x in range(upper, 0, -1):
                for n in self.chains[b]:
                    used[n] += x
                ok = self._feasible(used, self.combo[i + 1:], left - x)
                for n in self.chains[b]:
                    used[n] -= x
                if ok:
                    lo = x
                    break
            if lo:
                alloc[b] = lo
                for n in self.chains[b]:
                    used[n] += lo
                left -= lo
        return alloc if left == 0 else None


def build_problem(budgets: dict[str, Budget], held: dict[str, int],
                  caps: dict[str, int | float]) -> _Problem:
    return _Problem(budgets, held, caps)
