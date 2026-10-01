"""Core finite-domain solver: variables, constraints, propagation, undo."""

from collections import defaultdict, deque

from .alldiff import AllDifferentConstraint
from .errors import Conflict, SolverError


def _check_value(value):
    if isinstance(value, bool) or not isinstance(value, int):
        raise SolverError(f"domain values must be integers, got {value!r}")
    return value


class TableConstraint:
    """Allowed-tuples constraint maintaining valid-tuple support info."""

    type = "table"

    def __init__(self, cid, variables, tuples):
        self.id = cid
        self.variables = list(variables)
        seen = set()
        uniq = []
        for t in tuples:
            tt = tuple(t)
            if tt not in seen:
                seen.add(tt)
                uniq.append(tt)
        self.tuples = uniq
        # Support info: tuples currently valid w.r.t. the live domains.
        self.valid_tuples = list(self.tuples)

    def revise(self, domains):
        supports = {v: set() for v in self.variables}
        valid = []
        arity = len(self.variables)
        for t in self.tuples:
            if all(t[i] in domains[self.variables[i]] for i in range(arity)):
                valid.append(t)
                for i, v in enumerate(self.variables):
                    supports[v].add(t[i])
        self.valid_tuples = valid
        removals = []
        for v in self.variables:
            for val in sorted(domains[v]):
                if val not in supports[v]:
                    removals.append((v, val))
        return removals

    def to_spec(self):
        return {"type": "table", "id": self.id,
                "vars": list(self.variables),
                "tuples": [list(t) for t in self.tuples]}


class Solver:
    """Mutable solver with nested push/pop and constraint removal.

    The propagated state (domains, per-constraint support info) is a pure
    function of (base domains, active constraints, pending decisions), so
    undo operations restore it exactly by recomputation -- nothing is
    approximated by merely clearing queues.
    """

    def __init__(self):
        self.base_domains = {}
        self.domains = {}
        self.constraints = {}
        self._var_constraints = defaultdict(list)
        self.decisions = []
        self._snapshots = []
        self.conflict = None
        self.removal_log = []
        self._cid_counter = 0

    # ------------------------------------------------------------------
    # construction (all validation happens before any mutation: atomic)
    # ------------------------------------------------------------------
    def add_variable(self, name, values):
        if not isinstance(name, str) or not name:
            raise SolverError(f"invalid variable name {name!r}")
        if name in self.base_domains:
            raise SolverError(f"duplicate variable {name!r}")
        vals = sorted({_check_value(v) for v in values})
        if not vals:
            raise SolverError(f"empty domain for variable {name!r}")
        self.base_domains[name] = frozenset(vals)
        self.recompute()
        return name

    def add_constraint(self, ctype, variables, tuples=None, cid=None):
        variables = list(variables)
        if not variables:
            raise SolverError("constraint scope must not be empty")
        if len(set(variables)) != len(variables):
            raise SolverError(
                f"duplicate variable in constraint scope {variables!r}")
        for v in variables:
            if v not in self.base_domains:
                raise SolverError(f"unknown variable {v!r} in constraint")
        if cid is None:
            self._cid_counter += 1
            cid = f"c{self._cid_counter}"
        if cid in self.constraints:
            raise SolverError(f"duplicate constraint id {cid!r}")
        if ctype == "allDifferent":
            con = AllDifferentConstraint(cid, variables)
        elif ctype == "table":
            if tuples is None:
                raise SolverError("table constraint requires 'tuples'")
            checked = []
            for t in tuples:
                t = list(t)
                if len(t) != len(variables):
                    raise SolverError(
                        f"tuple arity {len(t)} != scope size {len(variables)}")
                checked.append([_check_value(x) for x in t])
            con = TableConstraint(cid, variables, checked)
        else:
            raise SolverError(f"unknown constraint type {ctype!r}")
        # validation complete; only now mutate
        self.constraints[cid] = con
        for v in variables:
            self._var_constraints[v].append(con)
        self.recompute()
        return cid

    def remove_constraint(self, cid):
        if cid not in self.constraints:
            raise SolverError(f"unknown constraint {cid!r}")
        con = self.constraints.pop(cid)
        for v in con.variables:
            self._var_constraints[v] = [
                c for c in self._var_constraints[v] if c.id != cid]
        # Recomputing from base domains restores every value and every
        # support that was removed because of this constraint.
        self.recompute()

    # ------------------------------------------------------------------
    # nested undo
    # ------------------------------------------------------------------
    def push(self):
        self._snapshots.append((list(self.decisions),
                                list(self.constraints.keys())))

    def pop(self):
        if not self._snapshots:
            raise SolverError("pop on empty push stack")
        decisions, cids = self._snapshots.pop()
        keep = set(cids)
        self.constraints = {i: c for i, c in self.constraints.items()
                            if i in keep}
        self._var_constraints = defaultdict(list)
        for c in self.constraints.values():
            for v in c.variables:
                self._var_constraints[v].append(c)
        self.decisions = decisions
        self.recompute()

    # ------------------------------------------------------------------
    # search decisions
    # ------------------------------------------------------------------
    def assign(self, var, value):
        if var not in self.base_domains:
            raise SolverError(f"unknown variable {var!r}")
        _check_value(value)
        self.decisions.append((var, value))
        self.recompute()

    def clear_decisions(self):
        self.decisions = []
        self.recompute()

    # ------------------------------------------------------------------
    # propagation
    # ------------------------------------------------------------------
    def recompute(self):
        self.domains = {k: set(v) for k, v in self.base_domains.items()}
        self.conflict = None
        self.removal_log = []
        try:
            for var, val in self.decisions:
                if val not in self.domains.get(var, ()):
                    raise Conflict(variable=var)
                for other in sorted(self.domains[var]):
                    if other != val:
                        self.removal_log.append(
                            {"var": var, "value": other,
                             "constraint": "<decision>"})
                self.domains[var] = {val}
            self._propagate()
        except Conflict as c:
            self.conflict = {"variable": c.variable, "constraint": c.constraint}

    def _propagate(self):
        """Revise constraints to a common fixpoint (queue based AC)."""
        queue = deque(self.constraints.values())
        in_queue = {c.id for c in queue}
        while queue:
            con = queue.popleft()
            in_queue.discard(con.id)
            for var, val in con.revise(self.domains):
                if val not in self.domains[var]:
                    continue
                self.domains[var].discard(val)
                self.removal_log.append(
                    {"var": var, "value": val, "constraint": con.id})
                if not self.domains[var]:
                    raise Conflict(variable=var, constraint=con.id)
                for other in self._var_constraints[var]:
                    if other.id != con.id and other.id not in in_queue:
                        in_queue.add(other.id)
                        queue.append(other)

    # ------------------------------------------------------------------
    # inspection
    # ------------------------------------------------------------------
    def all_assigned(self):
        return all(len(d) == 1 for d in self.domains.values())

    def witness(self):
        if not self.all_assigned():
            raise SolverError("not all variables are assigned")
        return {k: next(iter(v)) for k, v in sorted(self.domains.items())}

    def ok(self):
        return self.conflict is None
