"""Independent deep-copy reference solver used to cross-check the trail solver.

Instead of a trail, every decision level keeps a full deep copy of the domain
state. Backtracking restores the stored snapshot for the target level.
"""

from __future__ import annotations

from collections import deque


def _ac3(problem, domains, queue):
    removed = 0
    while queue:
        xi, xj, allowed = queue.popleft()
        doomed = {
            a
            for a in domains[xi]
            if not any((a, b) in allowed for b in domains[xj])
        }
        if not doomed:
            continue
        domains[xi] -= doomed
        removed += len(doomed)
        if not domains[xi]:
            return False, removed
        for xk, allowed_ki in problem.dependent[xi]:
            if xk != xj:
                queue.append((xk, xi, allowed_ki))
    return True, removed


def ac3_full(problem, domains):
    queue = deque()
    for xi, arcs in problem.arcs_to.items():
        for xj, allowed in arcs:
            queue.append((xi, xj, allowed))
    return _ac3(problem, domains, queue)


def ac3_from(problem, domains, var):
    queue = deque((xk, var, allowed) for xk, allowed in problem.dependent[var])
    return _ac3(problem, domains, queue)


class ReferenceSolver:
    """Full deep-copy snapshot per decision level."""

    def __init__(self, problem):
        self.problem = problem
        self.level = 0
        domains = {var: set(values) for var, values in problem.domains.items()}
        ok, removed = ac3_full(problem, domains)
        self.states = [domains]  # states[i] == domain state at level i
        self.status = "ok" if ok else "unsat"
        self.removed_total = removed

    @property
    def domains(self):
        return self.states[self.level]

    def assign(self, var, value):
        domains = {v: set(d) for v, d in self.states[self.level].items()}
        new_level = self.level + 1
        if value in domains[var]:
            assigned_removals = len(domains[var]) - 1
            domains[var] = {value}
            ok, removed = ac3_from(self.problem, domains, var)
            removed += assigned_removals
        else:
            ok, removed = False, 0
        if ok:
            self.level = new_level
            self.states[new_level:] = [domains]
            self.status = "ok"
            self.removed_total += removed
        else:
            self.status = "conflict"
        return ok

    def backtrack(self, level):
        assert 0 <= level <= self.level
        self.level = level
        if self.status != "unsat":
            self.status = "ok"
