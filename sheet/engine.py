"""Incremental spreadsheet engine.

Semantics:
- The reference graph must stay acyclic. A `set` that would close a cycle
  raises CycleError and leaves the whole state untouched (atomic failure).
- After a change, only affected ancestors whose value may change are
  recomputed; untouched cells keep their version numbers.
- `delete` is equivalent to setting the cell to 0 and dropping its
  outgoing (dependency) edges.
- Re-setting the identical expression is a no-op: no propagation at all.
- Division by zero yields the sticky error value E_DIV0.
- Undefined references evaluate to 0 and produce a warning.
"""

import heapq

E_DIV0 = "E_DIV0"


class CycleError(Exception):
    """Raised when a set operation would introduce a reference cycle."""


def _refs_of(node):
    kind = node[0]
    if kind == "ref":
        return {node[1]}
    out = set()
    for child in node[1:]:
        if isinstance(child, tuple):
            out |= _refs_of(child)
    return out


class Sheet:
    def __init__(self):
        self.exprs = {}     # cell -> AST
        self.values = {}    # cell -> int | E_DIV0
        self.versions = {}  # cell -> monotonic recompute counter
        self.deps = {}      # cell -> set of cells it references (out-edges)
        self.rdeps = {}     # cell -> set of cells referencing it (in-edges)
        self.recomputes = 0  # total number of cell recomputations
        self.warn = None     # optional callable(str) for warnings

    # ------------------------------------------------------------------ API

    def set(self, cell, ast):
        """Set cell to expression AST. No-op if the expression is identical.

        Raises CycleError atomically if the new edges would close a cycle.
        """
        if cell in self.exprs and self.exprs[cell] == ast:
            return  # rule: identical expression must not trigger propagation
        refs = _refs_of(ast)
        for ref in sorted(refs):
            if ref == cell or self._reachable(ref, cell):
                raise CycleError(
                    "cycle detected: setting %s would create a reference cycle" % cell
                )
        for ref in sorted(refs):
            if ref not in self.values:
                self._emit("undefined reference to %s, treated as 0" % ref)

        for old in self.deps.get(cell, ()):
            self.rdeps[old].discard(cell)
        self.deps[cell] = set(refs)
        for ref in refs:
            self.rdeps.setdefault(ref, set()).add(cell)
        self.exprs[cell] = ast

        old_value = self.values.get(cell, 0)
        new_value = self._eval(ast)
        self.recomputes += 1
        self.values[cell] = new_value
        self.versions[cell] = self.versions.get(cell, 0) + 1
        if new_value != old_value:
            self._propagate({cell})

    def delete(self, cell):
        """Delete a cell: equivalent to setting it to 0 and removing out-edges."""
        if cell not in self.exprs:
            return
        old_value = self.values.pop(cell)
        del self.exprs[cell]
        for ref in self.deps.pop(cell, ()):
            self.rdeps[ref].discard(cell)
        if old_value != 0:
            self._propagate({cell})

    def get(self, cell):
        if cell not in self.values:
            self._emit("undefined reference to %s, treated as 0" % cell)
            return 0
        return self.values[cell]

    def dump(self):
        """All defined cells as (name, value) pairs, sorted by cell name."""
        return [(name, self.values[name]) for name in sorted(self.values)]

    # -------------------------------------------------------------- internals

    def _emit(self, message):
        if self.warn is not None:
            self.warn(message)

    def _reachable(self, start, target):
        """True if target is reachable from start following dependency edges."""
        seen = set()
        stack = [start]
        while stack:
            node = stack.pop()
            if node == target:
                return True
            if node in seen:
                continue
            seen.add(node)
            stack.extend(self.deps.get(node, ()))
        return False

    def _propagate(self, changed_roots):
        """Recompute exactly the dependents whose inputs actually changed.

        Each affected cell is recomputed at most once, in deterministic
        topological order (dependencies before dependents, ties broken by
        cell name). Only recomputed cells get their version bumped.
        """
        affected = set()
        stack = list(changed_roots)
        while stack:
            node = stack.pop()
            for dependent in self.rdeps.get(node, ()):
                if dependent not in affected:
                    affected.add(dependent)
                    stack.append(dependent)
        if not affected:
            return

        indegree = {
            node: sum(1 for dep in self.deps.get(node, ()) if dep in affected)
            for node in affected
        }
        ready = [node for node, deg in indegree.items() if deg == 0]
        heapq.heapify(ready)
        order = []
        while ready:
            node = heapq.heappop(ready)
            order.append(node)
            for dependent in self.rdeps.get(node, ()):
                if dependent in indegree:
                    indegree[dependent] -= 1
                    if indegree[dependent] == 0:
                        heapq.heappush(ready, dependent)

        changed = set(changed_roots)
        for node in order:
            if node not in self.exprs:
                continue
            if not any(dep in changed for dep in self.deps.get(node, ())):
                continue  # inputs unchanged: value cannot change, skip
            new_value = self._eval(self.exprs[node])
            self.recomputes += 1
            self.versions[node] = self.versions.get(node, 0) + 1
            if self.values.get(node) != new_value:
                self.values[node] = new_value
                changed.add(node)

    def _eval(self, node):
        kind = node[0]
        if kind == "num":
            return node[1]
        if kind == "ref":
            return self.values.get(node[1], 0)
        if kind == "neg":
            value = self._eval(node[1])
            return E_DIV0 if value == E_DIV0 else -value
        left = self._eval(node[1])
        right = self._eval(node[2])
        if left == E_DIV0 or right == E_DIV0:
            return E_DIV0
        if kind == "add":
            return left + right
        if kind == "sub":
            return left - right
        if kind == "mul":
            return left * right
        if kind == "div":
            if right == 0:
                return E_DIV0
            quotient = abs(left) // abs(right)
            return -quotient if (left < 0) != (right < 0) else quotient
        raise ValueError("unknown AST node: %r" % (node,))
