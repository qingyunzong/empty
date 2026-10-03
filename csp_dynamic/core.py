"""Dynamic CSP solver with justification-tracked incremental AC-3.

For every value currently absent from its domain, ``justifications[(var,
value)]`` records the id of an active constraint that currently has no
support for it (its removal "reason").  A value is present in its domain
iff its reason set is empty.

Deleting a constraint ``c`` never re-propagates from scratch:

1.  ``c`` is dropped from every reason set.
2.  The restoration set is computed as the *greatest fixpoint* over the
    removed values of the affected constraint-graph component: a removed
    value is restorable iff every active constraint on its variable
    supports it w.r.t. the current domains plus the restorable set.
    This is exactly the set of values whose removal is no longer
    supported by any active constraint once ``c`` is gone - recursively
    so - and it coincides with (greatest arc-consistent fixpoint of the
    remaining constraints) minus (current domains).  Values removed
    solely because of ``c`` are precisely the ones whose reason set
    contained only ``c``; everything restorable traces back to them.
3.  Restored values then trigger an incremental AC-3 removal pass to a
    fixpoint (a no-op safety net given step 2 is exact), and the reasons
    of still-removed values are re-validated so future deletions stay
    incremental.
"""

from collections import defaultdict, deque


class ProblemError(ValueError):
    """Raised when the input CSP problem is malformed."""


class ConstraintNotFound(KeyError):
    """Raised when deleting a constraint id that does not exist."""


class Constraint:
    __slots__ = ("id", "scope", "positions", "allowed")

    def __init__(self, cid, scope, allowed):
        self.id = cid
        self.scope = tuple(scope)
        self.positions = {name: idx for idx, name in enumerate(self.scope)}
        self.allowed = frozenset(tuple(t) for t in allowed)


class DynamicCSP:
    def __init__(self, variables, constraints):
        """variables: {name: [values]}, constraints: iterable of Constraint."""
        if not variables:
            raise ProblemError("problem must define at least one variable")
        self.initial_domains = {name: list(vals) for name, vals in variables.items()}
        self.domains = {name: set(vals) for name, vals in variables.items()}
        self.constraints = {}
        self._by_var = defaultdict(set)
        self.justifications = {}
        for name in variables:
            for value in self.initial_domains[name]:
                self.justifications[(name, value)] = set()
        for constraint in constraints:
            self._register(constraint)
        queue = deque()
        for constraint in self.constraints.values():
            for name in constraint.scope:
                queue.append((name, constraint.id))
        self._removal_closure(queue)

    # ------------------------------------------------------------------ setup

    def _register(self, constraint):
        if constraint.id in self.constraints:
            raise ProblemError(f"duplicate constraint id: {constraint.id}")
        for name in constraint.scope:
            if name not in self.initial_domains:
                raise ProblemError(
                    f"constraint {constraint.id} references unknown variable {name!r}"
                )
        self.constraints[constraint.id] = constraint
        for name in constraint.scope:
            self._by_var[name].add(constraint.id)

    # ----------------------------------------------------------------- support

    def _has_support(self, constraint, var, value, extra=frozenset()):
        """True if `constraint` supports `value` of `var` w.r.t. the current
        domains union the `(var, value)` pairs in `extra`."""
        pos = constraint.positions[var]
        others = []
        for name in constraint.scope:
            if name != var:
                others.append((constraint.positions[name], name))
        domains = self.domains
        for tup in constraint.allowed:
            if tup[pos] != value:
                continue
            if all(
                tup[p] in domains[name] or (name, tup[p]) in extra
                for p, name in others
            ):
                return True
        return False

    def _neighbour_vars(self, var):
        for cid in self._by_var[var]:
            if cid not in self.constraints:
                continue
            for name in self.constraints[cid].scope:
                if name != var:
                    yield name

    def _arcs_of(self, var):
        for cid in self._by_var[var]:
            if cid not in self.constraints:
                continue
            for name in self.constraints[cid].scope:
                yield (name, cid)

    # ---------------------------------------------------------- removal phase

    def _removal_closure(self, queue):
        """Standard incremental AC-3: only removes unsupported values and
        records the removing constraint as each value's reason."""
        enqueued = set(queue)
        queue = deque(queue)
        while queue:
            var, cid = queue.popleft()
            enqueued.discard((var, cid))
            if cid not in self.constraints:
                continue
            constraint = self.constraints[cid]
            domain = self.domains[var]
            changed = False
            for value in self.initial_domains[var]:
                if value in domain and not self._has_support(constraint, var, value):
                    domain.discard(value)
                    just = self.justifications[(var, value)]
                    just.clear()
                    just.add(cid)
                    changed = True
            if changed:
                for name in self._neighbour_vars(var):
                    for arc in self._arcs_of(name):
                        if arc not in enqueued:
                            queue.append(arc)
                            enqueued.add(arc)

    # ------------------------------------------------------- restoration phase

    def _component_of(self, seed_vars):
        """Variables connected to `seed_vars` via shared constraints."""
        seen = set(seed_vars)
        queue = deque(seed_vars)
        while queue:
            var = queue.popleft()
            for name in self._neighbour_vars(var):
                if name not in seen:
                    seen.add(name)
                    queue.append(name)
        return seen

    def _restorable_fixpoint(self, candidate_vars):
        """Greatest set of removed (var, value) pairs within
        `candidate_vars` that are supported by every active constraint
        w.r.t. the current domains union the set itself."""
        candidates = set()
        for var in candidate_vars:
            domain = self.domains[var]
            for value in self.initial_domains[var]:
                if value not in domain:
                    candidates.add((var, value))
        queue = deque(candidate_vars)
        enqueued = set(candidate_vars)
        while queue:
            var = queue.popleft()
            enqueued.discard(var)
            dropped = False
            for value in self.initial_domains[var]:
                key = (var, value)
                if key not in candidates:
                    continue
                for cid in self._by_var[var]:
                    if cid not in self.constraints:
                        continue
                    constraint = self.constraints[cid]
                    if not self._has_support(constraint, var, value, candidates):
                        candidates.discard(key)
                        dropped = True
                        break
            if dropped:
                for name in self._neighbour_vars(var):
                    if name not in enqueued:
                        queue.append(name)
                        enqueued.add(name)
        return candidates

    def _repair_reasons(self, vars_):
        """Revalidate reasons of still-removed values: each must name an
        active constraint that currently has no support for the value."""
        for var in vars_:
            domain = self.domains[var]
            for value in self.initial_domains[var]:
                if value in domain:
                    continue
                just = self.justifications[(var, value)]
                if just:
                    reason = next(iter(just))
                    if reason in self.constraints and not self._has_support(
                        self.constraints[reason], var, value
                    ):
                        continue
                just.clear()
                for cid in self._by_var[var]:
                    if cid not in self.constraints:
                        continue
                    if not self._has_support(self.constraints[cid], var, value):
                        just.add(cid)
                        break

    # --------------------------------------------------------------- deletion

    def delete_constraint(self, cid):
        """Delete constraint `cid` and incrementally restore/re-propagate.

        Returns a sorted list of (variable, value) pairs present
        afterwards that were absent before the deletion.
        """
        if cid not in self.constraints:
            raise ConstraintNotFound(f"no constraint with id {cid}")
        before = {name: set(dom) for name, dom in self.domains.items()}

        constraint = self.constraints.pop(cid)
        for name in constraint.scope:
            self._by_var[name].discard(cid)
        for just in self.justifications.values():
            just.discard(cid)

        affected = self._component_of(constraint.scope)
        restorable = self._restorable_fixpoint(affected)
        changed_vars = set()
        for var, value in restorable:
            self.domains[var].add(value)
            self.justifications[(var, value)].clear()
            changed_vars.add(var)

        queue = deque()
        for var in changed_vars:
            queue.extend(self._arcs_of(var))
        self._removal_closure(queue)

        self._repair_reasons(affected)

        restored = sorted(
            (name, value)
            for name, dom in self.domains.items()
            for value in dom - before[name]
        )
        return restored

    # ----------------------------------------------------------------- output

    def status(self):
        if all(self.domains[name] for name in self.domains):
            return "ok"
        return "unsatisfiable"

    def sorted_domains(self):
        return {name: _sorted_values(dom) for name, dom in self.domains.items()}


def _sorted_values(values):
    try:
        return sorted(values)
    except TypeError:
        return sorted(values, key=repr)
