"""Dynamic CSP solver: AC-3 with pruning justifications and incremental
constraint deletion (no full re-propagation).

Internal representation
-----------------------
- Constraints are binary and extensional (allowed pairs).
- For every (constraint, variable, value) we maintain a support count:
  the number of values in the *other* variable's current domain that
  support this value.  Counts are maintained for all values, including
  values currently pruned, so deletions can be handled incrementally.
- For every pruned value we record its "reason": the set of constraint
  ids whose support count was zero at the moment the value was pruned.

Constraint deletion
-------------------
Deleting a constraint can only enlarge domains.  The values that must
come back are the greatest fixpoint of "restorable" values over the
connected component of the deleted constraint: a pruned value is
restorable iff, under every active constraint, it has a support that is
either in a current domain or itself restorable.  Restoring exactly this
set yields the same domains as running AC-3 from the initial domains
over the remaining constraints, without re-propagating unaffected
values.
"""

from collections import deque


class ProblemError(Exception):
    """The CSP problem definition is invalid."""


class ConstraintNotFoundError(Exception):
    """The requested constraint id does not exist or is already deleted."""


class Constraint:
    """A binary extensional constraint over an ordered pair of variables."""

    __slots__ = ("cid", "scope", "pairs", "supports")

    def __init__(self, cid, scope, pairs):
        self.cid = cid
        self.scope = (scope[0], scope[1])
        self.pairs = frozenset((p[0], p[1]) for p in pairs)
        # supports[var][value] -> set of supporting values of the other var
        self.supports = {self.scope[0]: {}, self.scope[1]: {}}
        for first, second in self.pairs:
            self.supports[self.scope[0]].setdefault(first, set()).add(second)
            self.supports[self.scope[1]].setdefault(second, set()).add(first)

    def other(self, var):
        if var == self.scope[0]:
            return self.scope[1]
        return self.scope[0]


class DynamicCSP:
    """A CSP maintaining arc consistency across constraint deletions."""

    def __init__(self, variables, domains, constraints):
        self.variables = list(variables)
        self.initial_domains = {v: list(domains[v]) for v in self.variables}
        self.constraints = {c.cid: c for c in constraints}
        self.active = set(self.constraints)

        self.incident = {v: [] for v in self.variables}
        for c in constraints:
            for var in c.scope:
                self.incident[var].append(c)

        # Support counts for every (constraint, variable, initial value).
        self.counts = {}
        for c in constraints:
            per_var = {}
            for var in c.scope:
                other = c.other(var)
                other_domain = set(self.initial_domains[other])
                per_var[var] = {
                    value: len(c.supports[var].get(value, set()) & other_domain)
                    for value in self.initial_domains[var]
                }
            self.counts[c.cid] = per_var

        self.domains = {v: set(self.initial_domains[v]) for v in self.variables}
        self.reasons = {}  # (var, value) -> set of constraint ids

        # Initial AC-3 propagation: seed with every value that already
        # has a zero support count.
        queue = deque()
        for var in self.variables:
            for value in self.initial_domains[var]:
                if any(self.counts[c.cid][var][value] == 0 for c in self.incident[var]):
                    queue.append((var, value))
        self._propagate(queue)

    # ------------------------------------------------------------------
    # propagation
    # ------------------------------------------------------------------
    def _propagate(self, queue):
        """Incremental AC-3: remove queued values until a fixpoint."""
        while queue:
            var, value = queue.popleft()
            if value not in self.domains[var]:
                continue
            # Record the pruning justification: every active constraint
            # under which this value currently has no support.
            self.reasons[(var, value)] = {
                c.cid
                for c in self.incident[var]
                if c.cid in self.active and self.counts[c.cid][var][value] == 0
            }
            self.domains[var].discard(value)
            for c in self.incident[var]:
                if c.cid not in self.active:
                    continue
                other = c.other(var)
                for supported in c.supports[var].get(value, ()):
                    if supported not in self.initial_domains[other]:
                        continue
                    self.counts[c.cid][other][supported] -= 1
                    if (
                        self.counts[c.cid][other][supported] == 0
                        and supported in self.domains[other]
                    ):
                        queue.append((other, supported))

    # ------------------------------------------------------------------
    # constraint deletion
    # ------------------------------------------------------------------
    def delete_constraint(self, cid):
        """Delete a constraint and restore exactly the values whose
        pruning is no longer justified, then re-propagate incrementally.

        Returns a dict mapping variable name -> sorted list of restored
        values (net values that are back in the domain after deletion).
        Raises ConstraintNotFoundError without touching the state if the
        constraint does not exist or was already deleted.
        """
        if cid not in self.constraints or cid not in self.active:
            raise ConstraintNotFoundError(cid)

        constraint = self.constraints[cid]
        self.active.discard(cid)
        before = {v: set(self.domains[v]) for v in self.variables}

        # Step 1: candidate restorations are the pruned values in the
        # connected component of the deleted constraint.  Values outside
        # that component cannot be affected by the deletion.
        affected = self._component_variables(constraint)
        candidates = {
            (var, value)
            for var in affected
            for value in self.initial_domains[var]
            if value not in self.domains[var]
        }

        # Step 2: greatest fixpoint of restorable values.  A candidate
        # survives iff every active constraint still gives it a support
        # that is in a current domain or itself a surviving candidate.
        # Values whose pruning reason involves only the deleted
        # constraint survive immediately; the recursion below restores
        # exactly the values whose justifications collapse with them.
        worklist = deque(candidates)
        queued = set(candidates)
        while worklist:
            var, value = worklist.popleft()
            queued.discard((var, value))
            if (var, value) not in candidates:
                continue
            if not self._restorable(var, value, candidates):
                candidates.discard((var, value))
                # Values supported by (var, value) may depend on it and
                # must be re-examined.
                for c in self.incident[var]:
                    if c.cid not in self.active:
                        continue
                    other = c.other(var)
                    for supported in c.supports[var].get(value, ()):
                        key = (other, supported)
                        if key in candidates and key not in queued:
                            worklist.append(key)
                            queued.add(key)

        # Step 3: restore the surviving candidates and update the
        # support counts incrementally.
        for var, value in candidates:
            self.domains[var].add(value)
            self.reasons.pop((var, value), None)
        for var, value in candidates:
            for c in self.incident[var]:
                if c.cid not in self.active:
                    continue
                other = c.other(var)
                for supported in c.supports[var].get(value, ()):
                    if supported in self.initial_domains[other]:
                        self.counts[c.cid][other][supported] += 1

        # Step 4: incremental AC-3 to a fixpoint.  After restoring the
        # greatest fixpoint the state is already arc consistent, so this
        # only prunes if a restored value still lacks support somewhere.
        prune_queue = deque(
            (var, value)
            for var, value in candidates
            if not self._fully_supported(var, value)
        )
        self._propagate(prune_queue)

        restored = {}
        for var in self.variables:
            restored[var] = sorted(
                self.domains[var] - before[var], key=_json_sort_key
            )
        return restored

    def _restorable(self, var, value, candidates):
        for c in self.incident[var]:
            if c.cid not in self.active:
                continue
            other = c.other(var)
            if not any(
                supported in self.domains[other]
                or (other, supported) in candidates
                for supported in c.supports[var].get(value, ())
            ):
                return False
        return True

    def _component_variables(self, constraint):
        """Variables connected to the deleted constraint via active ones."""
        seen = set(constraint.scope)
        stack = list(constraint.scope)
        while stack:
            var = stack.pop()
            for c in self.incident[var]:
                if c.cid not in self.active:
                    continue
                for neighbour in c.scope:
                    if neighbour not in seen:
                        seen.add(neighbour)
                        stack.append(neighbour)
        return seen

    def _fully_supported(self, var, value):
        return all(
            self.counts[c.cid][var][value] > 0
            for c in self.incident[var]
            if c.cid in self.active
        )

    # ------------------------------------------------------------------
    # accessors
    # ------------------------------------------------------------------
    def sorted_domains(self):
        return {
            var: sorted(self.domains[var], key=_json_sort_key)
            for var in self.variables
        }


def _json_sort_key(value):
    import json

    return json.dumps(value, sort_keys=True)
