"""Validation/normalization of JSON-friendly problem specifications."""

from .core import Solver
from .errors import SolverError


def normalize_spec(spec):
    """Validate a spec dict and return a canonical copy.

    Canonical form: {"variables": {name: [sorted ints]},
                     "constraints": [{"id", "type", "vars", ("tuples")}]}
    Raises SolverError before building anything on bad input.
    """
    if not isinstance(spec, dict):
        raise SolverError("spec must be an object")
    raw_vars = spec.get("variables")
    if not isinstance(raw_vars, dict) or not raw_vars:
        raise SolverError("spec requires a non-empty 'variables' object")
    variables = {}
    for name, values in raw_vars.items():
        if not isinstance(name, str) or not name:
            raise SolverError(f"invalid variable name {name!r}")
        if not isinstance(values, (list, tuple)):
            raise SolverError(f"domain of {name!r} must be a list")
        vals = []
        for v in values:
            if isinstance(v, bool) or not isinstance(v, int):
                raise SolverError(f"domain values must be integers, got {v!r}")
            vals.append(v)
        vals = sorted(set(vals))
        if not vals:
            raise SolverError(f"empty domain for variable {name!r}")
        variables[name] = vals

    raw_cons = spec.get("constraints", [])
    if not isinstance(raw_cons, list):
        raise SolverError("'constraints' must be a list")
    constraints = []
    used_ids = set()
    auto = 0
    for entry in raw_cons:
        if not isinstance(entry, dict):
            raise SolverError("constraint must be an object")
        ctype = entry.get("type")
        if ctype not in ("allDifferent", "table"):
            raise SolverError(f"unknown constraint type {ctype!r}")
        cvars = entry.get("vars")
        if not isinstance(cvars, list) or not cvars:
            raise SolverError("constraint requires a non-empty 'vars' list")
        if len(set(cvars)) != len(cvars):
            raise SolverError(
                f"duplicate variable in constraint scope {cvars!r}")
        for v in cvars:
            if not isinstance(v, str) or v not in variables:
                raise SolverError(f"unknown variable {v!r} in constraint")
        cid = entry.get("id")
        if cid is None:
            auto += 1
            cid = f"c{auto}"
            while cid in used_ids:
                auto += 1
                cid = f"c{auto}"
        if not isinstance(cid, str):
            raise SolverError("constraint id must be a string")
        if cid in used_ids:
            raise SolverError(f"duplicate constraint id {cid!r}")
        used_ids.add(cid)
        norm = {"id": cid, "type": ctype, "vars": list(cvars)}
        if ctype == "table":
            tuples = entry.get("tuples")
            if not isinstance(tuples, list):
                raise SolverError("table constraint requires a 'tuples' list")
            norm_tuples = []
            for t in tuples:
                if not isinstance(t, (list, tuple)):
                    raise SolverError("table tuple must be a list")
                if len(t) != len(cvars):
                    raise SolverError(
                        f"tuple arity {len(t)} != scope size {len(cvars)}")
                row = []
                for x in t:
                    if isinstance(x, bool) or not isinstance(x, int):
                        raise SolverError(
                            f"tuple values must be integers, got {x!r}")
                    row.append(x)
                norm_tuples.append(row)
            norm["tuples"] = norm_tuples
        constraints.append(norm)
    return {"variables": variables, "constraints": constraints}


def build_solver(spec, decisions=()):
    """Build a fresh Solver from a spec, apply decisions, propagate."""
    norm = normalize_spec(spec)
    solver = Solver()
    for name in sorted(norm["variables"]):
        solver.add_variable(name, norm["variables"][name])
    for con in norm["constraints"]:
        solver.add_constraint(con["type"], con["vars"],
                              tuples=con.get("tuples"), cid=con["id"])
    solver.decisions = list(decisions)
    solver.recompute()
    return solver


def select_var(solver):
    """Deterministic branching variable: min domain size, then name."""
    candidates = [(len(solver.domains[v]), v)
                  for v in solver.domains if len(solver.domains[v]) > 1]
    if not candidates:
        return None
    return min(candidates)[1]
