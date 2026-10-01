"""Arc-consistency propagation with lazy minimal explanations.

Support checks are computed on the fly from the current domains; no
allowed value-pair tuples are ever pre-generated.

Explanation model
-----------------
Every removed domain value gets exactly one explanation, recorded at the
moment of removal.  An explanation contains only the direct premises of
the removal: the constraint type (as a directed relation) and the
bound/value of the other variable's domain that made the value
unsupported:

* lt / le : premise {"var": y, "max": m}   (y <= m)
* gt / ge : premise {"var": y, "min": m}   (y >= m)
* eq      : premise {"var": y, "values": [...]}  (y in {...})
* ne      : premise {"var": y, "value": w}  (y == w, singleton domain)

When propagation empties a domain, the conflict explanation is the set
of explanations of the values removed by the revision that emptied the
domain (the last value-removal event); it can be used directly as a
Nogood.
"""

from collections import deque

INVERSE_OP = {"lt": "gt", "le": "ge", "gt": "lt", "ge": "le", "eq": "eq", "ne": "ne"}


def _is_supported(op, value, other_domain, other_members):
    """Check on the fly whether `value <op> w` holds for some w in other_domain."""
    if op == "lt":
        return value < other_domain[-1]
    if op == "le":
        return value <= other_domain[-1]
    if op == "gt":
        return value > other_domain[0]
    if op == "ge":
        return value >= other_domain[0]
    if op == "eq":
        return value in other_members
    if op == "ne":
        return not (len(other_domain) == 1 and other_domain[0] == value)
    raise ValueError(f"unknown op {op!r}")


def _direct_premise(op, value, other_var, other_domain):
    """Minimal direct premise (other side's bound/value) for a removal."""
    if op in ("lt", "le"):
        return {"var": other_var, "max": other_domain[-1]}
    if op in ("gt", "ge"):
        return {"var": other_var, "min": other_domain[0]}
    if op == "eq":
        return {"var": other_var, "values": list(other_domain)}
    if op == "ne":
        return {"var": other_var, "value": other_domain[0]}
    raise ValueError(f"unknown op {op!r}")


class Propagator:
    """Queue-based arc consistency over lt/le/eq/ne constraints."""

    def __init__(self, variables, constraints):
        # domains are kept as sorted lists; membership sets mirror them
        self.domains = {name: sorted(set(d)) for name, d in variables.items()}
        self._members = {name: set(d) for name, d in self.domains.items()}
        self.constraints = list(constraints)  # (cid, op, a, b)
        self.explanations = {}  # (var, value) -> explanation dict
        self.conflict_var = None
        self.conflict = None  # list of explanation dicts

    # -- internal helpers -------------------------------------------------

    def _arcs_into(self, var):
        """All directed arcs (cid, op, x, y) whose 'other' side y is `var`."""
        arcs = []
        for cid, op, a, b in self.constraints:
            if b == var:
                arcs.append((cid, op, a, b))
            if a == var and not (a == var and b == var):
                arcs.append((cid, INVERSE_OP[op], b, a))
        return arcs

    def _revise(self, cid, op, x, y):
        """Remove unsupported values of x w.r.t. arc x <op> y.

        Returns the list of removed values (in ascending order).
        """
        other = self.domains[y]
        other_members = self._members[y]
        removed = []
        for value in self.domains[x]:
            if not _is_supported(op, value, other, other_members):
                self.explanations[(x, value)] = {
                    "var": x,
                    "value": value,
                    "constraint": op,
                    "constraint_id": cid,
                    "other_var": y,
                    "premise": _direct_premise(op, value, y, other),
                }
                removed.append(value)
        if removed:
            dropped = set(removed)
            self.domains[x] = [v for v in self.domains[x] if v not in dropped]
            self._members[x] -= dropped
        return removed

    # -- public API -------------------------------------------------------

    def propagate(self):
        """Run arc consistency. Returns True if no domain is empty."""
        for name, domain in self.domains.items():
            if not domain:
                self.conflict_var = name
                self.conflict = []
                return False

        queue = deque()
        in_queue = set()
        for cid, op, a, b in self.constraints:
            for arc in ((cid, op, a, b), (cid, INVERSE_OP[op], b, a)):
                if arc not in in_queue:
                    queue.append(arc)
                    in_queue.add(arc)

        while queue:
            cid, op, x, y = queue.popleft()
            in_queue.discard((cid, op, x, y))
            removed = self._revise(cid, op, x, y)
            if not removed:
                continue
            if not self.domains[x]:
                # conflict: explanations of the last value-removal event
                self.conflict_var = x
                self.conflict = [self.explanations[(x, v)] for v in removed]
                return False
            for arc in self._arcs_into(x):
                if arc == (cid, INVERSE_OP[op], y, x):
                    continue  # skip the reverse of the arc just processed
                if arc not in in_queue:
                    queue.append(arc)
                    in_queue.add(arc)
        return True

    def sorted_domains(self):
        return {name: list(domain) for name, domain in self.domains.items()}

    def explanation_report(self):
        """Explanations grouped per variable, sorted by removed value."""
        report = {}
        for (var, _value), expl in sorted(self.explanations.items()):
            report.setdefault(var, []).append(expl)
        return report

    def conflict_report(self):
        if self.conflict is None:
            return None
        return {"var": self.conflict_var, "explanations": self.conflict}
