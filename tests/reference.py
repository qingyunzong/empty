"""Independent deep-copy reference CSP implementation used only by tests.

State management is deliberately different from TrailCSP: every decision
level stores a full deep copy of the domains, and backtracking restores a
snapshot. No trail is kept.
"""

from __future__ import annotations

import copy


class ReferenceCSP:
    def __init__(self, variables, constraints):
        self.domains = {name: set(values) for name, values in variables.items()}
        self.neighbors = {name: [] for name in variables}
        for var1, var2, allowed in constraints:
            forward = set(allowed)
            self.neighbors[var1].append((var2, forward))
            self.neighbors[var2].append((var1, {(b, a) for a, b in forward}))
        self.current_level = 0
        self.status = "ok"
        self.removal_count = 0
        queue = [
            (var, other)
            for var in self.domains
            for other, _ in self.neighbors[var]
        ]
        if not self._ac3(queue):
            self.status = "unsat"
        # snapshots[level] = deep copy of domains at that level
        self.snapshots = [copy.deepcopy(self.domains)]

    def _allowed(self, var, other):
        for other_var, allowed in self.neighbors[var]:
            if other_var == other:
                return allowed
        return None

    def _ac3(self, queue):
        while queue:
            var, other = queue.pop()
            allowed = self._allowed(var, other)
            if allowed is None:
                continue
            revised = False
            for value in list(self.domains[var]):
                if not any((value, b) in allowed for b in self.domains[other]):
                    self.domains[var].discard(value)
                    self.removal_count += 1
                    revised = True
            if revised:
                if not self.domains[var]:
                    return False
                for neighbor, _ in self.neighbors[var]:
                    if neighbor != other:
                        queue.append((neighbor, var))
        return True

    def assign(self, var, value):
        if var not in self.domains:
            raise KeyError(var)
        if value not in self.domains[var]:
            raise ValueError(value)
        self.current_level += 1
        self.domains = copy.deepcopy(self.domains)
        self.removal_count += len(self.domains[var]) - 1
        self.domains[var] = {value}
        queue = [(neighbor, var) for neighbor, _ in self.neighbors[var]]
        if not self._ac3(queue):
            # conflict: restore the previous level's snapshot
            self.current_level -= 1
            self.domains = copy.deepcopy(self.snapshots[self.current_level])
            return "conflict"
        self.snapshots.append(copy.deepcopy(self.domains))
        return "ok"

    def backtrack(self, level):
        if level < 0 or level > self.current_level:
            raise IndexError(level)
        self.current_level = level
        self.domains = copy.deepcopy(self.snapshots[level])
        del self.snapshots[level + 1:]

    def snapshot(self):
        return {name: sorted(values) for name, values in self.domains.items()}
