"""Incremental spreadsheet engine with minimal invalidation propagation.

Semantics:
- The reference graph must stay acyclic: a `set` that would create a cycle
  fails atomically (CycleError) and leaves the state untouched.
- After a change, only ancestors whose value may have changed are
  recomputed, in deterministic topological order; untouched cells never
  get their version bumped.
- `del` is equivalent to setting the cell to 0 and removing its out-edges.
- Re-setting the structurally identical expression is a no-op.
- Division by zero yields the fixed error value E_DIV0, which propagates.
- References to undefined cells evaluate to 0 and record a warning.
"""

import heapq
import re
from collections import defaultdict

from .parser import E_DIV0, ParseError, eval_ast, parse, refs_of

CELL_NAME_RE = re.compile(r"^[A-Za-z]+[0-9]+$")


class CycleError(Exception):
    """Raised when a set would introduce a cycle into the reference graph."""


def check_cell_name(name):
    if not CELL_NAME_RE.match(name):
        raise ParseError("invalid cell name %r" % name)


class Sheet:
    def __init__(self):
        self.ast = {}          # name -> AST or None (None == deleted/zero)
        self.src = {}          # name -> original expression source or None
        self.value = {}        # name -> int | E_DIV0 (present once defined)
        self.version = {}      # name -> number of value assignments
        self.deps = {}         # name -> set of referenced names (out-edges)
        self.dependents = defaultdict(set)  # name -> set of referring names
        self.warnings = []     # warnings produced by the last command
        self.eval_count = 0    # number of AST evaluations (for observability)

    # -- internal helpers -------------------------------------------------

    def _lookup(self, name):
        if name in self.value:
            return self.value[name]
        warning = "undefined reference to %s, using 0" % name
        if warning not in self.warnings:
            self.warnings.append(warning)
        return 0

    def _eval(self, name):
        self.eval_count += 1
        return eval_ast(self.ast[name], self._lookup)

    def _reaches(self, start, target):
        """True if `target` is reachable from `start` following dep edges."""
        stack = [start]
        seen = set()
        while stack:
            node = stack.pop()
            if node == target:
                return True
            if node in seen:
                continue
            seen.add(node)
            stack.extend(self.deps.get(node, ()))
        return False

    def _topo_order(self, affected):
        """Deterministic topological order of `affected` (deps first)."""
        indeg = {n: 0 for n in affected}
        adj = defaultdict(list)
        for n in affected:
            for d in self.deps.get(n, ()):
                if d in affected:
                    indeg[n] += 1
                    adj[d].append(n)
        heap = [n for n in affected if indeg[n] == 0]
        heapq.heapify(heap)
        order = []
        while heap:
            node = heapq.heappop(heap)
            order.append(node)
            for m in adj[node]:
                indeg[m] -= 1
                if indeg[m] == 0:
                    heapq.heappush(heap, m)
        return order

    def _propagate(self, start, start_value=None):
        """Recompute `start` and the affected ancestors, minimally."""
        affected = set()
        stack = [start]
        while stack:
            node = stack.pop()
            if node in affected:
                continue
            affected.add(node)
            stack.extend(self.dependents.get(node, ()))
        changed = set()
        for n in self._topo_order(affected):
            if n == start:
                newv = self._eval(n) if start_value is None else start_value
            elif not (self.deps.get(n, set()) & changed):
                continue
            else:
                newv = self._eval(n)
            if n not in self.value:
                # Newly defined cell: implicit old value was 0.
                self.value[n] = newv
                self.version[n] = 1
                if newv != 0:
                    changed.add(n)
            elif newv != self.value[n]:
                self.value[n] = newv
                self.version[n] += 1
                changed.add(n)

    # -- public commands --------------------------------------------------

    def set(self, name, src):
        """Set cell `name` to expression `src`. Atomic on cycle/parse error."""
        self.warnings = []
        check_cell_name(name)
        ast = parse(src)
        if self.ast.get(name) == ast:
            return  # identical expression: no propagation
        new_deps = refs_of(ast)
        for d in new_deps:
            if d == name or self._reaches(d, name):
                raise CycleError(
                    "setting %s would create a dependency cycle" % name)
        old_deps = self.deps.get(name, set())
        for d in old_deps - new_deps:
            self.dependents[d].discard(name)
        for d in new_deps - old_deps:
            self.dependents[d].add(name)
        self.deps[name] = new_deps
        self.ast[name] = ast
        self.src[name] = src
        self._propagate(name)

    def delete(self, name):
        """Delete cell `name`: value becomes 0 and its out-edges are removed."""
        self.warnings = []
        check_cell_name(name)
        if self.ast.get(name) is None:
            return  # undefined or already deleted
        for d in self.deps.get(name, ()):
            self.dependents[d].discard(name)
        self.deps[name] = set()
        self.ast[name] = None
        self.src[name] = None
        self._propagate(name, start_value=0)

    def get(self, name):
        """Return the current value of `name` (int or E_DIV0)."""
        self.warnings = []
        check_cell_name(name)
        return self._lookup(name)

    def dump(self):
        """Return sorted (name, src, value, version) rows for live cells."""
        return sorted(
            (name, self.src[name], self.value[name], self.version[name])
            for name in self.ast
            if self.ast[name] is not None
        )
