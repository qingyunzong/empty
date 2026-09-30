"""Incremental integer difference-constraint engine.

Maintains constraints of the form  x_v - x_u <= c  over integer variables
and a potential function ``pi`` that is a feasible solution while the system
is consistent.  Adding an edge triggers shortest-path style tightening from
its head; reaching a vertex already on the propagation path exposes a
negative cycle, which is returned as a replayable certificate.

Undo is trail based: every potential update is recorded, and ``pop()``
restores potentials *and* the conflict flag to the state at the matching
``push()`` -- it never merely deletes edges.
"""

from __future__ import annotations

from .errors import InputError, InconsistentStateError


class NegativeCycle(Exception):
    """Raised internally when propagation closes a negative cycle."""

    def __init__(self, certificate):
        super().__init__("negative cycle detected")
        self.certificate = certificate


class RelaxBudgetExhausted(Exception):
    """Raised when the relaxation-step budget runs out mid-operation."""


class _Edge:
    __slots__ = ("u", "v", "c", "uid")

    def __init__(self, u, v, c, uid):
        self.u = u
        self.v = v
        self.c = c
        self.uid = uid


def _check_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputError(f"{name} must be an int, got {value!r}")
    return value


class DifferenceConstraints:
    """Incremental system of integer difference constraints with undo."""

    def __init__(self, n_vars):
        _check_int(n_vars, "n_vars")
        if n_vars <= 0:
            raise InputError("n_vars must be positive")
        self.n = n_vars
        self.pi = [0] * n_vars
        self.edges = []                      # _Edge, append-only within a level
        self.out = [[] for _ in range(n_vars)]
        self.trail = []                      # ("pot", var, old_value)
        self.levels = []                     # (trail_len, edges_len, conflict)
        self.conflict = None                 # certificate dict or None
        self.parent = [-1] * n_vars          # scratch for cycle extraction
        self.relax_steps = 0                 # lifetime statistic
        self._budget = None                  # mutable [remaining] or None

    # ------------------------------------------------------------------ budget

    def set_budget(self, budget_cell):
        """Attach a mutable one-element list holding the remaining relax
        budget, or None for unlimited."""
        self._budget = budget_cell

    def _spend(self):
        if self._budget is not None:
            if self._budget[0] <= 0:
                raise RelaxBudgetExhausted()
            self._budget[0] -= 1
        self.relax_steps += 1

    # ------------------------------------------------------------------ levels

    def push(self):
        """Open a new undo level.  Levels nest."""
        self.levels.append((len(self.trail), len(self.edges), self.conflict))

    def pop(self):
        """Undo everything since the matching push: edge additions, potential
        tightenings and any conflict that depended on them."""
        if not self.levels:
            raise InputError("pop without matching push")
        trail_len, edges_len, conflict = self.levels.pop()
        while len(self.trail) > trail_len:
            _, var, old = self.trail.pop()
            self.pi[var] = old
        while len(self.edges) > edges_len:
            edge = self.edges.pop()
            self.out[edge.u].pop()
        self.conflict = conflict

    @property
    def level(self):
        return len(self.levels)

    def is_consistent(self):
        return self.conflict is None

    # ------------------------------------------------------------------ edges

    def _validate(self, u, v, c, uid):
        _check_int(u, "u")
        _check_int(v, "v")
        _check_int(c, "c")
        if not (0 <= u < self.n):
            raise InputError(f"variable index u={u} out of range [0,{self.n})")
        if not (0 <= v < self.n):
            raise InputError(f"variable index v={v} out of range [0,{self.n})")
        if not isinstance(uid, str) or not uid:
            raise InputError(f"uid must be a non-empty string, got {uid!r}")

    def add_edge(self, u, v, c, uid):
        """Add constraint  x_v - x_u <= c  with identifier ``uid``.

        Returns None if the system stays consistent, otherwise the negative
        cycle certificate (also stored in ``self.conflict``).  Invalid input
        raises InputError and leaves the engine untouched.  If the relax
        budget runs out mid-add, every partial effect is rolled back and
        RelaxBudgetExhausted propagates.
        """
        self._validate(u, v, c, uid)  # validate before any mutation
        if self.conflict is not None:
            raise InconsistentStateError(
                "cannot add an edge while inconsistent; pop the offending level first"
            )
        eid = len(self.edges)
        self.edges.append(_Edge(u, v, c, uid))
        self.out[u].append(eid)
        if self.pi[v] <= self.pi[u] + c:
            return None
        trail_mark = len(self.trail)
        try:
            self.parent[v] = eid
            self._set_pot(v, self.pi[u] + c)
            self._propagate(v)
        except NegativeCycle as exc:
            self._undo_trail(trail_mark)
            # The edge stays (it is a fact at this level); the level is now
            # inconsistent and carries the certificate as its conflict.
            self.conflict = exc.certificate
            return self.conflict
        except RelaxBudgetExhausted:
            # Roll back the whole add: potentials *and* the edge itself.
            self._undo_trail(trail_mark)
            self.edges.pop()
            self.out[u].pop()
            raise
        return None

    # ------------------------------------------------------------- internals

    def _undo_trail(self, mark):
        while len(self.trail) > mark:
            _, var, old = self.trail.pop()
            self.pi[var] = old

    def _set_pot(self, var, value):
        self._spend()  # raises before mutating when the budget is spent
        self.trail.append(("pot", var, self.pi[var]))
        self.pi[var] = value

    def _propagate(self, start):
        """Lower potentials reachable from ``start``; raise NegativeCycle if
        the tightening walks back onto its own path."""
        on_path = {start}
        stack = [(start, iter(self.out[start]))]
        while stack:
            x, it = stack[-1]
            descended = False
            for eid in it:
                edge = self.edges[eid]
                if self.pi[edge.v] > self.pi[x] + edge.c:
                    if edge.v in on_path:
                        raise NegativeCycle(self._build_cycle(edge.v, x, eid))
                    self.parent[edge.v] = eid
                    self._set_pot(edge.v, self.pi[x] + edge.c)
                    on_path.add(edge.v)
                    stack.append((edge.v, iter(self.out[edge.v])))
                    descended = True
                    break
            if not descended:
                stack.pop()
                on_path.discard(x)

    def _build_cycle(self, target, x, eid):
        """Assemble the certificate for the cycle  target ~> x -> target."""
        chain = [eid]
        cur = x
        while cur != target:
            peid = self.parent[cur]
            chain.append(peid)
            cur = self.edges[peid].u
        chain.reverse()
        edges = [self.edges[i] for i in chain]
        return {
            "type": "negative_cycle",
            "edges": [
                {"uid": e.uid, "u": e.u, "v": e.v, "c": e.c} for e in edges
            ],
            "weight": sum(e.c for e in edges),
        }
