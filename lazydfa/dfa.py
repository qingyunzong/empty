"""Lazy NFA -> DFA subset construction with budgets and checkpointing.

The DFA is expanded on demand, one subset state at a time.  Symbol
transitions are computed by splitting the integer line at the endpoints
of the NFA interval edges reachable from the subset, so the character
domain is never enumerated.

Budgets bound how much of the machine may be materialized.  Anything
not constructed is reported as ``UNKNOWN`` and is never treated as a
rejecting answer.

Checkpoints capture the discovered subsets, the expansion frontier and
the canonical state numbering, so a run restored (possibly several
times) produces exactly the machine of a single uninterrupted run.

NFA mutations invalidate only the DFA states whose closure or subset
dependencies include the changed edge (plus their ancestors, whose
transitions would dangle).
"""
from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field

from .closure import ClosureIndex
from .nfa import NFA

FORMAT_VERSION = 1

ACCEPT = "accept"
REJECT = "reject"
UNKNOWN = "unknown"

STATUS_PENDING = "pending"
STATUS_EXPANDED = "expanded"
STATUS_PARTIAL = "partial"


class CheckpointError(Exception):
    """Raised when a checkpoint cannot be restored (e.g. version skew)."""


@dataclass
class Transition:
    lo: int
    hi: int
    target: int | None          # None => unknown (budget-blocked)
    witnesses: tuple[int, ...]  # ids of the contributing NFA edges

    def to_dict(self) -> dict:
        return {"lo": self.lo, "hi": self.hi, "target": self.target,
                "witnesses": list(self.witnesses)}

    @staticmethod
    def from_dict(d: dict) -> "Transition":
        return Transition(lo=d["lo"], hi=d["hi"], target=d["target"],
                          witnesses=tuple(d["witnesses"]))


@dataclass
class StateRec:
    id: int
    subset: frozenset[int]
    status: str = STATUS_PENDING
    transitions: list[Transition] = field(default_factory=list)
    deps: set[int] = field(default_factory=set)


class LazyDFA:
    def __init__(self, nfa: NFA, state_budget: int | None = None,
                 transition_budget: int | None = None):
        self.nfa = nfa
        self.closure_index = ClosureIndex(nfa)
        self.state_budget = state_budget
        self.transition_budget = transition_budget
        self._states: dict[int, StateRec] = {}
        self._subset_to_id: dict[frozenset[int], int] = {}
        self._frontier: deque[int] = deque()
        self._next_id = 0
        self._trans_count = 0
        self._edge_to_states: dict[int, set[int]] = defaultdict(set)
        self._parents: dict[int, set[int]] = defaultdict(set)
        self.start_id = self._new_state(
            self.closure_index.closure({nfa.start}))
        nfa.add_listener(self)

    # -- state management ---------------------------------------------
    def _new_state(self, subset: frozenset[int]) -> int:
        sid = self._next_id
        self._next_id += 1
        self._states[sid] = StateRec(id=sid, subset=subset)
        self._subset_to_id[subset] = sid
        self._frontier.append(sid)
        return sid

    # -- inspection -----------------------------------------------------
    def state_ids(self) -> list[int]:
        return sorted(self._states)

    def subset_of(self, sid: int) -> frozenset[int]:
        return self._states[sid].subset

    def status_of(self, sid: int) -> str:
        return self._states[sid].status

    def transitions_of(self, sid: int) -> list[Transition]:
        return list(self._states[sid].transitions)

    def num_states(self) -> int:
        return len(self._states)

    def num_transitions(self) -> int:
        return self._trans_count

    def pending_count(self) -> int:
        return sum(1 for r in self._states.values()
                   if r.status == STATUS_PENDING)

    def is_complete(self) -> bool:
        return all(
            r.status == STATUS_EXPANDED
            and all(t.target is not None for t in r.transitions)
            for r in self._states.values())

    # -- expansion ------------------------------------------------------
    def expand(self, max_states: int | None = None) -> int:
        """Expand up to ``max_states`` pending states (all if None)."""
        done = 0
        while self._frontier and (max_states is None or done < max_states):
            sid = self._frontier.popleft()
            rec = self._states.get(sid)
            if rec is None or rec.status != STATUS_PENDING:
                continue
            self._expand_state(rec)
            done += 1
        return done

    def expand_all(self) -> None:
        self.expand(None)

    def _expand_state(self, rec: StateRec) -> None:
        nfa = self.nfa
        subset = rec.subset
        sym_edges = []
        for s in sorted(subset):
            sym_edges.extend(nfa.symbol_edges(s))
        sym_edges.sort(key=lambda e: (e.lo, e.hi, e.src, e.dst, e.id))

        deps = set(self.closure_index.eps_deps(subset))
        deps.update(e.id for e in sym_edges)

        boundaries = sorted({e.lo for e in sym_edges}
                            | {e.hi + 1 for e in sym_edges})
        transitions: list[Transition] = []
        partial = False
        for a, b in zip(boundaries, boundaries[1:]):
            covering = [e for e in sym_edges
                        if e.lo <= a and e.hi >= b - 1]
            if not covering:
                continue
            move = {e.dst for e in covering}
            target_subset = self.closure_index.closure(move)
            deps.update(self.closure_index.eps_deps(move))
            if (self.transition_budget is not None
                    and self._trans_count >= self.transition_budget):
                partial = True
                break
            tid = self._subset_to_id.get(target_subset)
            if tid is None:
                if (self.state_budget is not None
                        and len(self._states) >= self.state_budget):
                    tid = None  # unknown target: budget exhausted
                else:
                    tid = self._new_state(target_subset)
            if tid is not None:
                self._parents[tid].add(rec.id)
            transitions.append(Transition(
                lo=a, hi=b - 1, target=tid,
                witnesses=tuple(sorted(e.id for e in covering))))
            self._trans_count += 1

        rec.transitions = transitions
        rec.deps = deps
        for d in deps:
            self._edge_to_states[d].add(rec.id)
        rec.status = STATUS_PARTIAL if partial else STATUS_EXPANDED

    # -- querying ---------------------------------------------------------
    def query(self, symbols) -> str:
        """Run the lazy DFA; returns ACCEPT / REJECT / UNKNOWN.

        ``symbols`` is an iterable of ints; a plain string is mapped
        through ``ord`` per character.
        """
        if isinstance(symbols, str):
            symbols = [ord(c) for c in symbols]
        rec = self._states[self.start_id]
        for sym in symbols:
            if rec.status == STATUS_PENDING:
                return UNKNOWN
            tr = None
            for t in rec.transitions:
                if t.lo <= sym <= t.hi:
                    tr = t
                    break
            if tr is None:
                # Fully expanded states reject on uncovered symbols;
                # partially expanded states may simply be missing them.
                return UNKNOWN if rec.status == STATUS_PARTIAL else REJECT
            if tr.target is None:
                return UNKNOWN
            nxt = self._states.get(tr.target)
            if nxt is None:
                return UNKNOWN
            rec = nxt
        return ACCEPT if rec.subset & self.nfa.finals else REJECT

    # -- invalidation (NFA mutation listener) ---------------------------
    def edge_added(self, edge) -> None:
        affected = {sid for sid, rec in self._states.items()
                    if edge.src in rec.subset}
        self._invalidate(affected)

    def edge_removed(self, edge) -> None:
        affected = set(self._edge_to_states.get(edge.id, ()))
        self._invalidate(affected)

    def _invalidate(self, roots) -> None:
        if not roots:
            return
        doomed: set[int] = set()
        stack = [s for s in roots if s in self._states]
        while stack:
            sid = stack.pop()
            if sid in doomed or sid not in self._states:
                continue
            doomed.add(sid)
            stack.extend(self._parents.get(sid, ()))
        for sid in sorted(doomed):
            self._remove_state(sid)
        if self.start_id in doomed:
            self.start_id = self._new_state(
                self.closure_index.closure({self.nfa.start}))

    def _remove_state(self, sid: int) -> None:
        rec = self._states.pop(sid, None)
        if rec is None:
            return
        self._subset_to_id.pop(rec.subset, None)
        self._trans_count -= len(rec.transitions)
        for tr in rec.transitions:
            if tr.target is not None:
                ps = self._parents.get(tr.target)
                if ps is not None:
                    ps.discard(sid)
        for d in rec.deps:
            s = self._edge_to_states.get(d)
            if s is not None:
                s.discard(sid)
        self._parents.pop(sid, None)

    # -- checkpointing ----------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "format_version": FORMAT_VERSION,
            "nfa": self.nfa.to_dict(),
            "budgets": {"states": self.state_budget,
                        "transitions": self.transition_budget},
            "next_id": self._next_id,
            "start_id": self.start_id,
            "states": [
                {"id": rec.id,
                 "subset": sorted(rec.subset),
                 "status": rec.status,
                 "transitions": [t.to_dict() for t in rec.transitions],
                 "deps": sorted(rec.deps)}
                for rec in sorted(self._states.values(),
                                  key=lambda r: r.id)
            ],
            "frontier": [sid for sid in self._frontier
                         if sid in self._states],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LazyDFA":
        if data.get("format_version") != FORMAT_VERSION:
            raise CheckpointError(
                "unsupported checkpoint format version: "
                "%r (expected %r)" % (data.get("format_version"),
                                      FORMAT_VERSION))
        nfa = NFA.from_dict(data["nfa"])
        dfa = cls.__new__(cls)
        dfa.nfa = nfa
        dfa.closure_index = ClosureIndex(nfa)
        budgets = data["budgets"]
        dfa.state_budget = budgets["states"]
        dfa.transition_budget = budgets["transitions"]
        dfa._states = {}
        dfa._subset_to_id = {}
        dfa._frontier = deque(data["frontier"])
        dfa._next_id = data["next_id"]
        dfa._trans_count = 0
        dfa._edge_to_states = defaultdict(set)
        dfa._parents = defaultdict(set)
        dfa.start_id = data["start_id"]
        for sd in data["states"]:
            rec = StateRec(
                id=sd["id"],
                subset=frozenset(sd["subset"]),
                status=sd["status"],
                transitions=[Transition.from_dict(t)
                             for t in sd["transitions"]],
                deps=set(sd["deps"]),
            )
            dfa._states[rec.id] = rec
            dfa._subset_to_id[rec.subset] = rec.id
            dfa._trans_count += len(rec.transitions)
            for d in rec.deps:
                dfa._edge_to_states[d].add(rec.id)
            for t in rec.transitions:
                if t.target is not None:
                    dfa._parents[t.target].add(rec.id)
        nfa.add_listener(dfa)
        return dfa
