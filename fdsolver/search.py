"""Pausable, serializable depth-first search with conflict-tree certificates.

The searcher explores exactly one node per ``step()`` call.  Its whole
state is JSON-serializable (``to_json`` / ``from_json``), so a search can
be paused, persisted, and resumed with a conclusion identical to an
uninterrupted run.  Outcomes:

* ``sat``     -- with a complete witness assignment;
* ``unsat``   -- with a branch conflict tree that can be replayed and
                 checked independently via ``verify_unsat_certificate``;
* ``unknown`` -- only when the node budget is exhausted.
"""

from .errors import SolverError
from .spec import build_solver, normalize_spec, select_var


class Searcher:
    def __init__(self, spec, budget=None, find_all=False):
        self.spec = normalize_spec(spec)
        if budget is not None and (not isinstance(budget, int) or budget < 0):
            raise SolverError("budget must be a non-negative integer or null")
        self.budget = budget
        self.find_all = bool(find_all)
        self.nodes = 0
        self.frames = []
        self.status = None      # None | "sat" | "unsat" | "unknown"
        self.witness = None
        self.witnesses = []
        self.tree = None        # conflict tree root once unsat

    # ------------------------------------------------------------------
    def decisions(self):
        return [(f["var"], f["candidates"][f["idx"]]) for f in self.frames]

    def step(self):
        """Explore exactly one node; returns final status or None."""
        if self.status is not None:
            return self.status
        if self.budget is not None and self.nodes >= self.budget:
            self.status = "unknown"
            return self.status
        self.nodes += 1
        solver = build_solver(self.spec, self.decisions())
        if solver.conflict is not None:
            self._leaf("conflict")
            self._advance()
        elif solver.all_assigned():
            witness = solver.witness()
            if not self.find_all:
                self.witness = witness
                self.status = "sat"
            else:
                self.witnesses.append(witness)
                self._leaf("solution")
                self._advance()
        else:
            var = select_var(solver)
            vals = sorted(solver.domains[var])
            self.frames.append({"var": var, "candidates": vals, "idx": 0,
                                "tree": {"var": var, "branches": []}})
        return None

    def run(self):
        while self.status is None:
            self.step()
        return self.status

    # ------------------------------------------------------------------
    def _leaf(self, outcome):
        if self.frames:
            top = self.frames[-1]
            top["tree"]["branches"].append(
                {"value": top["candidates"][top["idx"]], "child": outcome})
        elif outcome == "conflict":
            self.tree = "conflict"  # propagation alone refutes the root

    def _advance(self):
        while self.frames:
            top = self.frames[-1]
            top["idx"] += 1
            if top["idx"] < len(top["candidates"]):
                return
            finished = self.frames.pop()
            if self.frames:
                parent = self.frames[-1]
                parent["tree"]["branches"].append(
                    {"value": parent["candidates"][parent["idx"]],
                     "child": finished["tree"]})
            else:
                self.tree = finished["tree"]
                self._finish_exhausted()
                return
        self._finish_exhausted()

    def _finish_exhausted(self):
        if self.find_all and self.witnesses:
            self.status = "sat"
        else:
            self.status = "unsat"

    # ------------------------------------------------------------------
    def to_json(self):
        return {"spec": self.spec, "budget": self.budget,
                "find_all": self.find_all, "nodes": self.nodes,
                "frames": self.frames, "status": self.status,
                "witness": self.witness, "witnesses": self.witnesses,
                "tree": self.tree}

    @classmethod
    def from_json(cls, data):
        sch = cls(data["spec"], budget=data.get("budget"),
                  find_all=data.get("find_all", False))
        sch.nodes = data["nodes"]
        sch.frames = data["frames"]
        sch.status = data["status"]
        sch.witness = data["witness"]
        sch.witnesses = data.get("witnesses", [])
        sch.tree = data["tree"]
        return sch


def all_solutions(spec):
    """Enumerate all solutions using propagation-based search."""
    sch = Searcher(spec, find_all=True)
    sch.run()
    return sch.witnesses


def verify_unsat_certificate(spec, tree):
    """Independently replay a branch conflict tree.

    Re-derives every propagation and branching choice from ``spec`` alone;
    any tampering with the tree (wrong variable, missing/extra branch,
    fabricated conflict, truncated subtree) makes this return False.
    """
    try:
        norm = normalize_spec(spec)
    except SolverError:
        return False

    def replay(decisions, node):
        solver = build_solver(norm, decisions)
        if solver.conflict is not None:
            return node == "conflict"
        if solver.all_assigned():
            return False  # a real solution contradicts the claimed unsat
        if not isinstance(node, dict):
            return False
        var = select_var(solver)
        if node.get("var") != var:
            return False
        branches = node.get("branches")
        if not isinstance(branches, list):
            return False
        expected = sorted(solver.domains[var])
        seen = []
        for b in branches:
            if not isinstance(b, dict) or "value" not in b or "child" not in b:
                return False
            seen.append(b["value"])
        if seen != expected:
            return False  # every residual value must be refuted exactly once
        for b in branches:
            if not replay(decisions + [(var, b["value"])], b["child"]):
                return False
        return True

    return replay([], tree)
