"""Symbolic DFA model over the alphabet 0..65535.

Transitions of a state are disjoint closed intervals [lo, hi] with a target
state.  Characters not covered by any interval of a state fall into an
implicit reject sink (represented by None).  Machines are immutable: every
update returns a new Machine with a bumped version, so a rejected update
leaves the original untouched (atomic by construction).
"""

from __future__ import annotations

from dataclasses import dataclass

MAX_CHAR = 65535


class MachineError(ValueError):
    """Raised when a machine definition or update is invalid."""


def _check_intervals(states, intervals, owner):
    prev_hi = -1
    for lo, hi, target in intervals:
        if not (0 <= lo <= hi <= MAX_CHAR):
            raise MachineError(f"{owner}: interval [{lo}, {hi}] out of range 0..{MAX_CHAR}")
        if lo <= prev_hi:
            raise MachineError(f"{owner}: overlapping interval [{lo}, {hi}]")
        if target not in states:
            raise MachineError(f"{owner}: unknown target state {target!r}")
        prev_hi = hi


@dataclass(frozen=True)
class Machine:
    states: tuple
    initial: str
    accepting: frozenset
    transitions: dict  # state -> tuple of (lo, hi, target), sorted and disjoint
    version: int = 0
    changes: tuple = ()  # (version, state, lo, hi) records, oldest first

    @classmethod
    def create(cls, states, initial, accepting, transitions=None, version=0, changes=()):
        states = tuple(states)
        if not states:
            raise MachineError("machine needs at least one state")
        if len(set(states)) != len(states):
            raise MachineError("duplicate state names")
        if initial not in states:
            raise MachineError(f"unknown initial state {initial!r}")
        accepting = frozenset(accepting)
        unknown = accepting - set(states)
        if unknown:
            raise MachineError(f"unknown accepting states: {sorted(unknown)!r}")
        state_set = set(states)
        trans = {}
        for st, ivs in (transitions or {}).items():
            if st not in state_set:
                raise MachineError(f"transitions for unknown state {st!r}")
            norm = tuple(sorted((int(lo), int(hi), str(t)) for lo, hi, t in ivs))
            _check_intervals(state_set, norm, st)
            trans[st] = norm
        return cls(states, initial, accepting, trans, int(version), tuple(changes))

    # -- queries ---------------------------------------------------------

    def intervals(self, state):
        """Sorted disjoint intervals of a state; the sink has none."""
        if state is None:
            return ()
        return self.transitions.get(state, ())

    def step(self, state, char):
        if state is None:
            return None
        for lo, hi, target in self.transitions.get(state, ()):
            if char < lo:
                break
            if lo <= char <= hi:
                return target
        return None

    def is_accepting(self, state):
        return state is not None and state in self.accepting

    def accepts(self, word):
        state = self.initial
        for char in word:
            state = self.step(state, char)
        return self.is_accepting(state)

    # -- updates (atomic: either a new Machine or an exception) ----------

    def add_transition(self, state, lo, hi, target):
        if state not in self.states:
            raise MachineError(f"unknown state {state!r}")
        if target not in self.states:
            raise MachineError(f"unknown target state {target!r}")
        if not (0 <= lo <= hi <= MAX_CHAR):
            raise MachineError(f"interval [{lo}, {hi}] out of range 0..{MAX_CHAR}")
        merged = tuple(sorted(self.intervals(state) + ((lo, hi, target),)))
        _check_intervals(set(self.states), merged, state)
        return self._bump(state, merged, lo, hi)

    def remove_transition(self, state, lo, hi):
        kept = tuple(iv for iv in self.intervals(state) if (iv[0], iv[1]) != (lo, hi))
        if len(kept) == len(self.intervals(state)):
            raise MachineError(f"{state}: no transition on [{lo}, {hi}]")
        return self._bump(state, kept, lo, hi)

    def replace_transition(self, state, old_lo, old_hi, lo, hi, target):
        if target not in self.states:
            raise MachineError(f"unknown target state {target!r}")
        if not (0 <= lo <= hi <= MAX_CHAR):
            raise MachineError(f"interval [{lo}, {hi}] out of range 0..{MAX_CHAR}")
        kept = tuple(iv for iv in self.intervals(state) if (iv[0], iv[1]) != (old_lo, old_hi))
        if len(kept) == len(self.intervals(state)):
            raise MachineError(f"{state}: no transition on [{old_lo}, {old_hi}]")
        merged = tuple(sorted(kept + ((lo, hi, target),)))
        _check_intervals(set(self.states), merged, state)
        return self._bump(state, merged, lo, hi)

    def _bump(self, state, intervals, lo, hi):
        trans = dict(self.transitions)
        trans[state] = tuple(intervals)
        change = (self.version + 1, state, lo, hi)
        return Machine(self.states, self.initial, self.accepting, trans,
                       self.version + 1, self.changes + (change,))

    # -- serialization ---------------------------------------------------

    def to_json(self):
        return {
            "states": list(self.states),
            "initial": self.initial,
            "accepting": sorted(self.accepting),
            "transitions": {
                st: [[lo, hi, t] for lo, hi, t in ivs]
                for st, ivs in self.transitions.items()
            },
            "version": self.version,
            "changes": [list(c) for c in self.changes],
        }

    @classmethod
    def from_json(cls, data):
        return cls.create(
            data["states"],
            data["initial"],
            data.get("accepting", []),
            data.get("transitions", {}),
            data.get("version", 0),
            tuple(tuple(c) for c in data.get("changes", [])),
        )
