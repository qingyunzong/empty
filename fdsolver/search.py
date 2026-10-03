"""Pausable, serialisable depth-first search with UNSAT conflict certificates.

The search is iterative with an explicit frame stack, so it can stop after a
node budget, be serialised to JSON, and be resumed later in a fresh process
with an identical outcome.

Result vocabulary:
  - "sat"     : a complete assignment (witness) was found and verified.
  - "unsat"   : the whole tree was explored; a replayable conflict tree is
                attached as the certificate.
  - "unknown" : the node budget ran out; a resumable state is attached.
"""

from __future__ import annotations

import copy

from .core import ConsistencyError, Solver, SpecError


def _pick_var(solver):
    """Smallest-domain-first, ties broken by variable name (deterministic)."""
    best = None
    for name in sorted(solver.domains):
        size = len(solver.domains[name])
        if size > 1 and (best is None or size < len(solver.domains[best])):
            best = name
    return best


class Searcher:
    """Deterministic DFS over a problem spec.  Rebuildable from JSON state."""

    def __init__(self, spec):
        self.spec = spec
        self.solver = Solver.from_spec(spec)
        self.frames = []      # [{"var": str, "candidates": [int], "current": int}]
        self.cert_stack = []  # partial certificate nodes aligned with frames
        self.root_cert = None
        self.nodes = 0

    # -- serialisation ------------------------------------------------------

    def dump_state(self):
        """JSON-able snapshot; enough to resume an identical search later."""
        return {
            "frames": copy.deepcopy(self.frames),
            "cert_stack": copy.deepcopy(self.cert_stack),
            "root_cert": copy.deepcopy(self.root_cert),
            "nodes": self.nodes,
        }

    @classmethod
    def from_state(cls, spec, state):
        """Rebuild a searcher from a dumped state.  Raises SpecError if the
        state does not replay cleanly against the given problem spec."""
        searcher = cls(spec)
        try:
            frames = state["frames"]
            if not isinstance(frames, list):
                raise SpecError("state.frames must be a list")
            for frame in frames:
                var = frame["var"]
                current = frame["current"]
                candidates = frame["candidates"]
                if not isinstance(var, str) or not isinstance(current, int):
                    raise SpecError("malformed frame")
                if not isinstance(candidates, list):
                    raise SpecError("malformed candidates")
                if var not in searcher.solver.domains:
                    raise SpecError(f"unknown variable in state: {var!r}")
                if current not in searcher.solver.domains[var]:
                    raise SpecError(f"decision {var}={current} not replayable")
                searcher.solver.push()
                searcher.solver.assign(var, current)
                searcher.frames.append(
                    {"var": var, "candidates": [int(v) for v in candidates],
                     "current": current}
                )
            searcher.cert_stack = state["cert_stack"]
            searcher.root_cert = state["root_cert"]
            searcher.nodes = int(state["nodes"])
            if searcher.nodes < 0:
                raise SpecError("negative node count")
        except (KeyError, TypeError, ValueError) as exc:
            raise SpecError(f"invalid search state: {exc}") from exc
        return searcher

    # -- main loop ------------------------------------------------------------

    def run(self, budget=None):
        """Explore until sat/unsat or until ``budget`` total nodes are used.

        ``budget`` counts propagation nodes over the searcher's whole life,
        so it composes across save/restore cycles.
        """
        while True:
            if budget is not None and self.nodes >= budget:
                return self._result("unknown")
            self.nodes += 1
            if not self.solver.propagate():
                if not self.frames:
                    self.root_cert = {"conflict": True}
                    return self._result("unsat")
                leaf_parent = self.cert_stack[-1]
                leaf_parent["children"][str(self.frames[-1]["current"])] = {
                    "conflict": True
                }
                if not self._backtrack():
                    return self._result("unsat")
                continue
            var = _pick_var(self.solver)
            if var is None:
                return self._result("sat")
            values = sorted(self.solver.domains[var])
            self.frames.append(
                {"var": var, "candidates": values[1:], "current": values[0]}
            )
            self.cert_stack.append({"var": var, "children": {}})
            self.solver.push()
            self.solver.assign(var, values[0])

    def _backtrack(self):
        while self.frames:
            self.solver.pop()
            frame = self.frames[-1]
            if frame["candidates"]:
                value = frame["candidates"].pop(0)
                frame["current"] = value
                self.solver.push()
                self.solver.assign(frame["var"], value)
                return True
            node = self.cert_stack.pop()
            self.frames.pop()
            if self.cert_stack:
                parent_value = self.frames[-1]["current"]
                self.cert_stack[-1]["children"][str(parent_value)] = node
            else:
                self.root_cert = node
        return False

    def _result(self, status):
        result = {
            "status": status,
            "witness": None,
            "certificate": None,
            "state": None,
            "stats": {"nodes": self.nodes},
        }
        if status == "sat":
            result["witness"] = {
                name: next(iter(self.solver.domains[name]))
                for name in sorted(self.solver.domains)
            }
        elif status == "unsat":
            result["certificate"] = self.root_cert
        else:
            result["state"] = self.dump_state()
        return result


def solve(spec, budget=None):
    """One-shot convenience wrapper around :class:`Searcher`."""
    return Searcher(spec).run(budget)


def enumerate_solutions(spec, limit=None):
    """All solutions of ``spec`` (up to ``limit``), in deterministic order."""
    solver = Solver.from_spec(spec)
    solutions = []

    def visit():
        if limit is not None and len(solutions) >= limit:
            return
        if not solver.propagate():
            return
        var = _pick_var(solver)
        if var is None:
            solutions.append(
                {n: next(iter(solver.domains[n])) for n in sorted(solver.domains)}
            )
            return
        for value in sorted(solver.domains[var]):
            solver.push()
            solver.assign(var, value)
            visit()
            solver.pop()

    visit()
    return solutions


def check_witness(spec, witness):
    """True iff ``witness`` is a complete assignment satisfying every
    constraint of ``spec``."""
    try:
        variables = spec["variables"]
        constraints = spec.get("constraints", [])
        if not isinstance(witness, dict) or set(witness) != set(variables):
            return False
        for name, value in witness.items():
            if value not in variables[name]:
                return False
        for constraint in constraints:
            kind = constraint["type"]
            scope = constraint["scope"]
            if kind == "table":
                row = [witness[name] for name in scope]
                if row not in [list(t) for t in constraint["tuples"]]:
                    return False
            elif kind == "alldifferent":
                values = [witness[name] for name in scope]
                if len(set(values)) != len(values):
                    return False
            else:
                return False
        return True
    except (KeyError, TypeError):
        return False


def verify_unsat(spec, certificate):
    """Independently replay an UNSAT conflict tree against a fresh solver.

    At every internal node the certificate must branch on exactly the values
    of the variable's propagated domain; every leaf must replay to a real
    propagation conflict.  Any tampering breaks one of these checks.
    """
    try:
        solver = Solver.from_spec(spec)
    except (SpecError, ConsistencyError):
        return False

    def replay(node):
        if not isinstance(node, dict):
            return False
        if set(node) == {"conflict"}:
            return node["conflict"] is True and not solver.propagate()
        if set(node) != {"var", "children"}:
            return False
        var = node["var"]
        children = node["children"]
        if not isinstance(var, str) or var not in solver.domains:
            return False
        if not isinstance(children, dict) or not children:
            return False
        if not solver.propagate():
            return False
        values = []
        for key in children:
            try:
                value = int(key)
            except (TypeError, ValueError):
                return False
            if str(value) != key:  # canonical integer keys only
                return False
            values.append(value)
        if set(values) != solver.domains[var]:
            return False
        for key in sorted(children, key=int):
            solver.push()
            try:
                solver.assign(var, int(key))
            except ConsistencyError:
                solver.pop()
                return False
            ok = replay(children[key])
            solver.pop()
            if not ok:
                return False
        return True

    try:
        return replay(certificate)
    except (SpecError, ConsistencyError, RecursionError):
        return False
