"""Core finite-domain solver.

Variables hold integer finite domains.  Two constraint kinds are supported:
allowed-tuple table constraints (GAC via valid-tuple support tracking) and
allDifferent (GAC via Regin's bipartite-matching / SCC filtering).

All mutations are recorded on a trail so that nested push/pop can restore
domains, tuple-support information, added variables and added constraints.
"""

from __future__ import annotations


class SpecError(ValueError):
    """Raised when a problem specification or update is invalid."""


class ConsistencyError(ValueError):
    """Raised when an assignment is incompatible with the current domains."""


def _check_name(name):
    if not isinstance(name, str) or not name:
        raise SpecError(f"invalid variable name: {name!r}")


def _check_int(value):
    if not isinstance(value, int) or isinstance(value, bool):
        raise SpecError(f"invalid domain value: {value!r}")


class TableConstraint:
    """Allowed-tuples constraint with valid-tuple support tracking."""

    __slots__ = ("cid", "scope", "tuples", "valid")

    def __init__(self, cid, scope, tuples):
        self.cid = cid
        self.scope = list(scope)
        self.tuples = [tuple(t) for t in tuples]
        self.valid = set(range(len(self.tuples)))

    def propagate(self, solver):
        # Invalidate tuples whose values left the domains (trailed for undo).
        dead = []
        for i in self.valid:
            row = self.tuples[i]
            for k, name in enumerate(self.scope):
                if row[k] not in solver.domains[name]:
                    dead.append(i)
                    break
        if dead:
            solver._trail.append(("tup", self.cid, tuple(dead)))
            self.valid.difference_update(dead)
        # Revise domains: every remaining value needs a valid supporting tuple.
        for k, name in enumerate(self.scope):
            dom = solver.domains[name]
            supported = set()
            for i in self.valid:
                supported.add(self.tuples[i][k])
            for value in sorted(dom):
                if value not in supported and not solver._remove_value(name, value):
                    return False
        return True

    def to_json(self):
        return {
            "type": "table",
            "scope": list(self.scope),
            "tuples": [list(t) for t in self.tuples],
        }


def _augment(name, doms, match_of_value, seen):
    for value in sorted(doms[name]):
        if value in seen:
            continue
        seen.add(value)
        if value not in match_of_value or _augment(
            match_of_value[value], doms, match_of_value, seen
        ):
            match_of_value[value] = name
            return True
    return False


def _strongly_connected(nodes, adj):
    """Iterative Tarjan SCC.  Returns {node: component_id}."""
    index = {}
    lowlink = {}
    on_stack = set()
    stack = []
    comp = {}
    counter = 0
    for root in nodes:
        if root in index:
            continue
        index[root] = lowlink[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        work = [(root, iter(sorted(adj.get(root, ()))))]
        while work:
            node, it = work[-1]
            descended = False
            for nxt in it:
                if nxt not in index:
                    index[nxt] = lowlink[nxt] = counter
                    counter += 1
                    stack.append(nxt)
                    on_stack.add(nxt)
                    work.append((nxt, iter(sorted(adj.get(nxt, ())))))
                    descended = True
                    break
                if nxt in on_stack:
                    lowlink[node] = min(lowlink[node], index[nxt])
            if descended:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                lowlink[parent] = min(lowlink[parent], lowlink[node])
            if lowlink[node] == index[node]:
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp[w] = index[node]
                    if w == node:
                        break
    return comp


class AllDifferentConstraint:
    """allDifferent with Regin's GAC filtering (matching + alternating
    paths + strongly connected components)."""

    __slots__ = ("cid", "scope")

    def __init__(self, cid, scope):
        self.cid = cid
        self.scope = list(scope)

    def propagate(self, solver):
        scope = self.scope
        doms = {name: solver.domains[name] for name in scope}
        values = sorted({v for name in scope for v in doms[name]})

        # Maximum bipartite matching (deterministic augmenting paths).
        match_of_value = {}
        for name in scope:
            if not _augment(name, doms, match_of_value, set()):
                return False  # Hall set violation: no complete matching.

        # Directed alternating graph: matched edges var->value, unmatched
        # edges value->var, so alternating paths from free value vertices
        # traverse a non-matching edge first, then a matching edge, etc.
        adj = {}

        def link(a, b):
            adj.setdefault(a, set()).add(b)

        for name in scope:
            for value in doms[name]:
                x_node = ("x", name)
                v_node = ("v", value)
                if match_of_value.get(value) == name:
                    link(x_node, v_node)
                else:
                    link(v_node, x_node)

        # Nodes reachable from free (unmatched) value vertices.
        reachable = set()
        queue = [("v", v) for v in values if v not in match_of_value]
        for node in queue:
            reachable.add(node)
        while queue:
            node = queue.pop()
            for nxt in adj.get(node, ()):
                if nxt not in reachable:
                    reachable.add(nxt)
                    queue.append(nxt)

        nodes = [("x", n) for n in scope] + [("v", v) for v in values]
        comp = _strongly_connected(nodes, adj)

        # An edge (x, v) belongs to some maximum matching iff it is matched,
        # or v is reachable from a free value, or x and v share an SCC.
        for name in scope:
            for value in sorted(doms[name]):
                if match_of_value.get(value) == name:
                    continue
                if ("v", value) in reachable:
                    continue
                if comp[("x", name)] == comp[("v", value)]:
                    continue
                if not solver._remove_value(name, value):
                    return False
        return True

    def to_json(self):
        return {"type": "alldifferent", "scope": list(self.scope)}


class Solver:
    """Finite-domain CSP solver with nested push/pop and fixpoint propagation."""

    def __init__(self):
        self.domains = {}
        self.constraints = []
        self._by_var = {}
        self._trail = []
        self._marks = []
        self._queue = set()

    # -- construction -----------------------------------------------------

    def add_variable(self, name, values):
        """Add a variable.  Atomic: invalid input raises before any mutation."""
        _check_name(name)
        if name in self.domains:
            raise SpecError(f"duplicate variable: {name!r}")
        if not isinstance(values, (list, tuple)) or not values:
            raise SpecError(f"domain of {name!r} must be a non-empty list")
        for v in values:
            _check_int(v)
        if len(set(values)) != len(values):
            raise SpecError(f"domain of {name!r} has duplicate values")
        self.domains[name] = set(values)
        self._by_var[name] = set()
        self._trail.append(("var", name))
        return name

    def _check_scope(self, scope):
        if not isinstance(scope, (list, tuple)) or not scope:
            raise SpecError("constraint scope must be a non-empty list")
        for name in scope:
            _check_name(name)
            if name not in self.domains:
                raise SpecError(f"unknown variable in scope: {name!r}")
        if len(set(scope)) != len(scope):
            raise SpecError(f"duplicate variable in scope: {list(scope)!r}")
        return list(scope)

    def _install(self, constraint):
        cid = len(self.constraints)
        constraint.cid = cid
        self.constraints.append(constraint)
        for name in constraint.scope:
            self._by_var[name].add(cid)
        self._trail.append(("con",))
        self._queue.add(cid)
        return cid

    def add_table(self, scope, tuples):
        """Add an allowed-tuples table constraint (atomic on bad input)."""
        scope = self._check_scope(scope)
        if not isinstance(tuples, (list, tuple)):
            raise SpecError("tuples must be a list of tuples")
        rows = []
        seen = set()
        for row in tuples:
            if not isinstance(row, (list, tuple)) or len(row) != len(scope):
                raise SpecError(f"bad tuple arity: {row!r}")
            for v in row:
                _check_int(v)
            key = tuple(row)
            if key not in seen:
                seen.add(key)
                rows.append(list(row))
        return self._install(TableConstraint(-1, scope, rows))

    def add_alldifferent(self, scope):
        """Add an allDifferent constraint (atomic on bad input)."""
        scope = self._check_scope(scope)
        if len(scope) < 2:
            raise SpecError("alldifferent needs at least two variables")
        return self._install(AllDifferentConstraint(-1, scope))

    # -- trail / undo ------------------------------------------------------

    def push(self):
        """Open a new undo level.  Levels nest."""
        self._marks.append(len(self._trail))

    def pop(self):
        """Undo everything since the matching push: removed values, invalidated
        tuple supports, added constraints and added variables are restored."""
        if not self._marks:
            raise SpecError("pop without matching push")
        mark = self._marks.pop()
        trail = self._trail
        while len(trail) > mark:
            entry = trail.pop()
            kind = entry[0]
            if kind == "dom":
                self.domains[entry[1]].add(entry[2])
            elif kind == "tup":
                self.constraints[entry[1]].valid.update(entry[2])
            elif kind == "con":
                constraint = self.constraints.pop()
                for name in constraint.scope:
                    self._by_var[name].discard(constraint.cid)
            elif kind == "var":
                name = entry[1]
                del self.domains[name]
                del self._by_var[name]
        # Propagation is idempotent; re-examine everything still present.
        self._queue = set(range(len(self.constraints)))

    # -- propagation --------------------------------------------------------

    def _remove_value(self, name, value):
        dom = self.domains[name]
        if value not in dom:
            return True
        self._trail.append(("dom", name, value))
        dom.discard(value)
        if not dom:
            return False
        self._queue.update(self._by_var[name])
        return True

    def assign(self, name, value):
        """Restrict a variable to a single value (trailed)."""
        if name not in self.domains:
            raise ConsistencyError(f"unknown variable: {name!r}")
        if value not in self.domains[name]:
            raise ConsistencyError(f"value {value!r} not in domain of {name!r}")
        for v in sorted(self.domains[name]):
            if v != value and not self._remove_value(name, v):
                raise ConsistencyError(f"assigning {name}={value} wipes out domain")

    def propagate(self):
        """Run queued constraints to a common fixpoint.

        Returns False iff some domain became empty (inconsistency proved).
        True only means "not refuted"; it does not imply satisfiability.
        """
        while self._queue:
            cid = min(self._queue)
            self._queue.discard(cid)
            if cid >= len(self.constraints):
                continue
            if not self.constraints[cid].propagate(self):
                self._queue.clear()
                return False
        return True

    # -- inspection ----------------------------------------------------------

    def is_solved(self):
        return all(len(d) == 1 for d in self.domains.values())

    def snapshot(self):
        return {name: sorted(dom) for name, dom in sorted(self.domains.items())}

    def to_spec(self):
        return {
            "variables": {n: sorted(d) for n, d in self.domains.items()},
            "constraints": [c.to_json() for c in self.constraints],
        }

    @classmethod
    def from_spec(cls, spec):
        """Build a solver from a JSON-able problem spec.  Atomic: any schema
        error raises SpecError and no partially built solver escapes."""
        if not isinstance(spec, dict):
            raise SpecError("spec must be an object")
        variables = spec.get("variables")
        constraints = spec.get("constraints", [])
        if not isinstance(variables, dict):
            raise SpecError("'variables' must be an object")
        if not isinstance(constraints, list):
            raise SpecError("'constraints' must be a list")
        solver = cls()
        for name in sorted(variables):
            solver.add_variable(name, variables[name])
        for c in constraints:
            if not isinstance(c, dict):
                raise SpecError(f"constraint must be an object: {c!r}")
            kind = c.get("type")
            if kind == "table":
                solver.add_table(c.get("scope"), c.get("tuples"))
            elif kind == "alldifferent":
                solver.add_alldifferent(c.get("scope"))
            else:
                raise SpecError(f"unknown constraint type: {kind!r}")
        return solver
