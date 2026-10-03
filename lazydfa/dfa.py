"""Lazy NFA -> DFA determinisation.

DFA states are epsilon-closed subsets of NFA states, discovered on
demand.  Symbol moves are computed by splitting the integer symbol
domain at the endpoints of the outgoing interval edges of the subset
(atomic intervals), never by enumerating the character domain.

Budgets bound how many states / transitions may be materialised.  A
state that has not been expanded is explicitly *unknown*: matching that
reaches it yields UNKNOWN, never REJECT.

Checkpoints capture discovered subsets, the expansion queue, canonical
state numbering and transitions, so a run restored (possibly several
times) from checkpoints produces exactly the machine a single
uninterrupted run would have produced.
"""

from __future__ import annotations

from collections import deque
from typing import Dict, FrozenSet, List, Optional, Tuple

from .closure import ClosureIndex
from .nfa import NFA

ACCEPT = "accept"
REJECT = "reject"
UNKNOWN = "unknown"

CHECKPOINT_FORMAT = 1


class LazyDFA:
    def __init__(self, nfa: NFA,
                 state_budget: Optional[int] = None,
                 transition_budget: Optional[int] = None):
        self._nfa = nfa
        self._closure = ClosureIndex(nfa)
        self.state_budget = state_budget
        self.transition_budget = transition_budget
        self._seen_changes = len(nfa.change_log)
        self._reset()

    # ------------------------------------------------------------------
    # construction helpers
    # ------------------------------------------------------------------
    def _reset(self) -> None:
        self._states: List[FrozenSet[int]] = []
        self._state_ids: Dict[FrozenSet[int], int] = {}
        self._transitions: Dict[int, List[Tuple[int, int, int]]] = {}
        self._witnesses: Dict[int, List[Tuple[int, int, int, Tuple[int, ...]]]] = {}
        self._expanded: set = set()
        self._queue: deque = deque()
        self._queued: set = set()
        self._num_transitions = 0
        self.budget_exhausted = False
        start = self._closure.closure({self._nfa.start})
        self._add_state(start)

    def _add_state(self, subset: FrozenSet[int]) -> int:
        sid = self._state_ids.get(subset)
        if sid is None:
            sid = len(self._states)
            self._states.append(subset)
            self._state_ids[subset] = sid
            self._queue.append(sid)
            self._queued.add(sid)
        return sid

    # ------------------------------------------------------------------
    # invalidation
    # ------------------------------------------------------------------
    def _sync(self) -> None:
        log = self._nfa.change_log
        if self._seen_changes == len(log):
            return
        pending = log[self._seen_changes:]
        self._seen_changes = len(log)
        if any(kind == "eps" for kind, _, _ in pending):
            # Closures are a global dependency: rebuild everything.
            self._reset()
            return
        dirty = set()
        for _, _, states in pending:
            dirty |= states
        for sid, subset in enumerate(self._states):
            if sid in self._expanded and subset & dirty:
                self._unexpand(sid)

    def _unexpand(self, sid: int) -> None:
        self._num_transitions -= len(self._transitions.get(sid, ()))
        self._transitions.pop(sid, None)
        self._witnesses.pop(sid, None)
        self._expanded.discard(sid)
        if sid not in self._queued:
            self._queue.append(sid)
            self._queued.add(sid)

    # ------------------------------------------------------------------
    # move computation over atomic intervals
    # ------------------------------------------------------------------
    def _compute_moves(self, subset: FrozenSet[int]):
        """Return [(lo, hi, target_generator_states, witness_edge_ids)]."""
        edges = []
        for s in sorted(subset):
            edges.extend(self._nfa.symbol_edges_from(s))
        if not edges:
            return []
        endpoints = sorted({e.lo for e in edges} | {e.hi + 1 for e in edges})
        moves = []
        run_lo = run_hi = None
        run_targets = run_wit = None
        for i in range(len(endpoints) - 1):
            a, b = endpoints[i], endpoints[i + 1] - 1
            covering = [e for e in edges if e.lo <= a and e.hi >= b]
            if covering:
                targets = frozenset(e.dst for e in covering)
                wit = tuple(sorted(e.id for e in covering))
            else:
                targets, wit = None, None
            if targets is not None and targets == run_targets and wit == run_wit \
                    and run_hi is not None and a == run_hi + 1:
                run_hi = b
                continue
            if run_targets is not None:
                moves.append((run_lo, run_hi, run_targets, run_wit))
            run_lo, run_hi, run_targets, run_wit = a, b, targets, wit
        if run_targets is not None:
            moves.append((run_lo, run_hi, run_targets, run_wit))
        return moves

    # ------------------------------------------------------------------
    # expansion
    # ------------------------------------------------------------------
    def expand(self) -> None:
        """Expand queued states until the worklist drains or a budget
        would be exceeded.  Expansion of a single state is atomic: if it
        does not fit within the remaining budget it is left unexpanded."""
        self._sync()
        while self._queue:
            sid = self._queue[0]
            moves = self._compute_moves(self._states[sid])
            closed = [(lo, hi, self._closure.closure(targets), wit)
                      for lo, hi, targets, wit in moves]
            new_states = len({sub for _, _, sub, _ in closed}
                             - self._state_ids.keys())
            if self.state_budget is not None and \
                    len(self._states) + new_states > self.state_budget:
                self.budget_exhausted = True
                return
            if self.transition_budget is not None and \
                    self._num_transitions + len(closed) > self.transition_budget:
                self.budget_exhausted = True
                return
            self._queue.popleft()
            self._queued.discard(sid)
            trans = []
            wits = []
            for lo, hi, sub, wit in closed:
                dst = self._add_state(sub)
                trans.append((lo, hi, dst))
                wits.append((lo, hi, dst, wit))
                self._num_transitions += 1
            self._transitions[sid] = trans
            self._witnesses[sid] = wits
            self._expanded.add(sid)

    # ------------------------------------------------------------------
    # matching
    # ------------------------------------------------------------------
    def match(self, string) -> str:
        """Match an iterable of integer symbols -> ACCEPT/REJECT/UNKNOWN."""
        self._sync()
        sid = 0
        for ch in string:
            if sid not in self._expanded:
                return UNKNOWN
            nxt = None
            for lo, hi, dst in self._transitions[sid]:
                if lo <= ch <= hi:
                    nxt = dst
                    break
            if nxt is None:
                return REJECT
            sid = nxt
        if self._states[sid] & self._nfa.accepting:
            return ACCEPT
        return REJECT

    # ------------------------------------------------------------------
    # introspection
    # ------------------------------------------------------------------
    @property
    def num_states(self) -> int:
        return len(self._states)

    @property
    def num_transitions(self) -> int:
        return self._num_transitions

    def is_expanded(self, sid: int) -> bool:
        return sid in self._expanded

    def unknown_states(self) -> List[int]:
        return [i for i in range(len(self._states)) if i not in self._expanded]

    def state_subset(self, sid: int) -> FrozenSet[int]:
        return self._states[sid]

    def witness(self, sid: int):
        """Witness NFA edges for every outgoing DFA transition of a state."""
        return list(self._witnesses.get(sid, ()))

    def to_json(self) -> dict:
        states = []
        for sid, subset in enumerate(self._states):
            states.append({
                "id": sid,
                "subset": sorted(subset),
                "accepting": bool(subset & self._nfa.accepting),
                "status": "known" if sid in self._expanded else "unknown",
            })
        transitions = []
        for sid in sorted(self._witnesses):
            for lo, hi, dst, wit in self._witnesses[sid]:
                transitions.append({
                    "src": sid, "lo": lo, "hi": hi, "dst": dst,
                    "witness": [self._nfa.edge(e).to_json() for e in wit],
                })
        return {
            "states": states,
            "transitions": transitions,
            "budgets": {
                "state_budget": self.state_budget,
                "transition_budget": self.transition_budget,
                "states_used": len(self._states),
                "transitions_used": self._num_transitions,
                "exhausted": self.budget_exhausted,
            },
        }

    # ------------------------------------------------------------------
    # checkpoints
    # ------------------------------------------------------------------
    def save_checkpoint(self) -> dict:
        self._sync()
        return {
            "format": CHECKPOINT_FORMAT,
            "nfa_version": self._nfa.version,
            "states": [sorted(s) for s in self._states],
            "expanded": sorted(self._expanded),
            "queue": list(self._queue),
            "transitions": [
                {"src": sid, "lo": lo, "hi": hi, "dst": dst,
                 "witness": list(wit)}
                for sid in sorted(self._witnesses)
                for lo, hi, dst, wit in self._witnesses[sid]
            ],
            "budget_exhausted": self.budget_exhausted,
        }

    @classmethod
    def restore(cls, nfa: NFA, data: dict,
                state_budget: Optional[int] = None,
                transition_budget: Optional[int] = None) -> "LazyDFA":
        if data.get("format") != CHECKPOINT_FORMAT:
            raise ValueError("unsupported checkpoint format version")
        if data.get("nfa_version") != nfa.version:
            raise ValueError(
                "checkpoint NFA version mismatch: "
                f"checkpoint={data.get('nfa_version')} nfa={nfa.version}")
        dfa = cls(nfa, state_budget, transition_budget)
        dfa._states = [frozenset(s) for s in data["states"]]
        dfa._state_ids = {s: i for i, s in enumerate(dfa._states)}
        dfa._expanded = set(data["expanded"])
        dfa._queue = deque(data["queue"])
        dfa._queued = set(data["queue"])
        dfa._transitions = {}
        dfa._witnesses = {}
        dfa._num_transitions = 0
        for t in data["transitions"]:
            dfa._transitions.setdefault(t["src"], []).append(
                (t["lo"], t["hi"], t["dst"]))
            dfa._witnesses.setdefault(t["src"], []).append(
                (t["lo"], t["hi"], t["dst"], tuple(t["witness"])))
            dfa._num_transitions += 1
        dfa.budget_exhausted = data.get("budget_exhausted", False)
        return dfa
