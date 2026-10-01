"""Lazy arc-consistency propagation with minimal pruning explanations.

No allowed-value tuples are ever pregenerated: support checks are
computed on the fly from the *current* domain of the other variable.

Explanation model
-----------------
Every time a value ``v`` is pruned from the domain of variable ``x``
by a constraint ``c`` involving ``x`` and ``y``, exactly one minimal
explanation is recorded::

    {
        "variable": "x",
        "value": v,
        "constraint": "lt" | "le" | "eq" | "ne",
        "vars": ["x", "y"],          # declaration order of the constraint
        "premise": {...}             # the direct premise, nothing else
    }

The premise contains only the boundary / value of the other domain that
directly triggered the removal:

* ``lt`` / ``le`` (forward):  ``{"max": m}``  -- m = max of the other domain
* ``lt`` / ``le`` (reversed): ``{"min": m}``  -- m = min of the other domain
* ``eq``:                     ``{"domain": [...]}`` -- other domain (value absent)
* ``ne``:                     ``{"domain": [v]}``   -- other singleton domain

When propagation empties a domain, the conflict explanation is the set
of explanations of every value of that domain, i.e. the explanation set
accumulated up to (and including) the removal of the last value.  It is
directly usable as a Nogood.
"""

from collections import deque

LT = "lt"
LE = "le"
EQ = "eq"
NE = "ne"
CONSTRAINT_TYPES = (LT, LE, EQ, NE)

STATUS_CONSISTENT = "consistent"
STATUS_INCONSISTENT = "inconsistent"


class ProblemError(Exception):
    """Raised when the problem specification is invalid."""


class Conflict:
    """Explanation of a domain wipe-out, usable as a Nogood."""

    def __init__(self, variable, explanations):
        self.variable = variable
        self.explanations = list(explanations)

    def to_dict(self):
        return {
            "variable": self.variable,
            "explanations": list(self.explanations),
        }


def _has_support(ctype, value, other_domain, other_set, reversed_arc):
    """True iff ``value`` has at least one support in ``other_domain``.

    Computed directly from the current other domain; no tuple tables.
    ``reversed_arc`` is True when the pruned variable is the *second*
    variable of the declared constraint (e.g. y in x < y).
    """
    if ctype == LT:
        if reversed_arc:
            return other_domain[0] < value
        return value < other_domain[-1]
    if ctype == LE:
        if reversed_arc:
            return other_domain[0] <= value
        return value <= other_domain[-1]
    if ctype == EQ:
        return value in other_set
    if ctype == NE:
        return not (len(other_domain) == 1 and other_domain[0] == value)
    raise ProblemError("unknown constraint type: %r" % (ctype,))


def _premise(ctype, other_domain, reversed_arc):
    """Minimal direct premise for a removal caused by the other domain."""
    if ctype in (LT, LE):
        if reversed_arc:
            return {"min": other_domain[0]}
        return {"max": other_domain[-1]}
    # eq: value is absent from the other domain;
    # ne: the other domain is the singleton {value}.
    return {"domain": list(other_domain)}


class Propagator:
    """AC-3 style propagator with lazy explanation generation."""

    def __init__(self, domains, constraints):
        """
        ``domains``: dict mapping variable name -> iterable of ints.
        ``constraints``: iterable of ``(ctype, var_a, var_b)`` tuples.
        """
        for ctype, _, _ in constraints:
            if ctype not in CONSTRAINT_TYPES:
                raise ProblemError("unknown constraint type: %r" % (ctype,))
        self.domains = {name: sorted(set(values)) for name, values in domains.items()}
        for name, values in self.domains.items():
            if not values:
                raise ProblemError("domain of variable %r is empty" % (name,))
        self.constraints = [tuple(c) for c in constraints]
        # Arcs: (target, ctype, other, decl_vars, reversed_arc)
        self._arcs = []
        # _dependents[v]: arcs whose *source* (other) is v, i.e. arcs that
        # must be re-examined whenever the domain of v shrinks.
        self._dependents = {name: [] for name in self.domains}
        for ctype, var_a, var_b in self.constraints:
            decl = (var_a, var_b)
            arc_ab = (var_a, ctype, var_b, decl, False)
            arc_ba = (var_b, ctype, var_a, decl, True)
            self._arcs.extend((arc_ab, arc_ba))
            self._dependents[var_b].append(arc_ab)
            self._dependents[var_a].append(arc_ba)
        self.explanations = []
        self._explained = set()
        self._pruned_by_var = {name: [] for name in self.domains}
        self.conflict = None

    def _revise(self, arc):
        """Prune unsupported values of ``arc``'s target. Returns removed values."""
        target, ctype, other, decl_vars, reversed_arc = arc
        total_removed = []
        # A self-constraint (e.g. x < x) relates the domain to itself, so
        # a single pass is not enough: keep revising until the domain is
        # stable (or empty) to reach the true arc-consistency fixpoint.
        while True:
            other_domain = self.domains[other]
            other_set = set(other_domain)
            removed = []
            for value in self.domains[target]:
                if not _has_support(ctype, value, other_domain, other_set,
                                    reversed_arc):
                    removed.append(value)
            if not removed:
                break
            premise = _premise(ctype, other_domain, reversed_arc)
            removed_set = set(removed)
            self.domains[target] = [
                v for v in self.domains[target] if v not in removed_set
            ]
            for value in removed:
                key = (target, value)
                if key in self._explained:
                    continue
                self._explained.add(key)
                explanation = {
                    "variable": target,
                    "value": value,
                    "constraint": ctype,
                    "vars": list(decl_vars),
                    "premise": dict(premise),
                }
                self.explanations.append(explanation)
                self._pruned_by_var[target].append(explanation)
            total_removed.extend(removed)
            if target != other or not self.domains[target]:
                break
        return total_removed

    def run(self):
        """Propagate to arc consistency. Returns the status string."""
        queue = deque()
        in_queue = set()
        for arc in self._arcs:
            # The arc key must include the direction: e.g. the reversed
            # arc of lt(y, x) and the forward arc of lt(x, y) share
            # (target, ctype, other) but have opposite semantics.
            key = (arc[0], arc[1], arc[2], arc[4])
            if key not in in_queue:
                in_queue.add(key)
                queue.append(arc)
        while queue:
            arc = queue.popleft()
            in_queue.discard((arc[0], arc[1], arc[2], arc[4]))
            target, _, other, _, _ = arc
            removed = self._revise(arc)
            if not removed:
                continue
            if not self.domains[target]:
                # Conflict: the explanation set accumulated for this
                # domain up to and including its last removed value.
                self.conflict = Conflict(target, self._pruned_by_var[target])
                return STATUS_INCONSISTENT
            for re_arc in self._dependents[target]:
                # Re-examine every variable constrained with `target`,
                # except the arc whose source triggered this change.
                if re_arc[0] != other:
                    key = (re_arc[0], re_arc[1], re_arc[2], re_arc[4])
                    if key not in in_queue:
                        in_queue.add(key)
                        queue.append(re_arc)
        return STATUS_CONSISTENT


def propagate(domains, constraints):
    """Run lazy propagation and return a JSON-serialisable result dict."""
    prop = Propagator(domains, constraints)
    status = prop.run()
    result = {
        "status": status,
        "domains": {name: list(values) for name, values in prop.domains.items()},
        "explanations": list(prop.explanations),
    }
    if prop.conflict is not None:
        result["conflict"] = prop.conflict.to_dict()
    return result
