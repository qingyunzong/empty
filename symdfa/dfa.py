"""Symbolic DFA over the alphabet 0..65535.

Transitions are disjoint closed intervals [lo, hi] per state.  Characters
with no outgoing transition fall into an implicit reject sink.
"""

from __future__ import annotations

CHAR_MIN = 0
CHAR_MAX = 65535


class DFAError(ValueError):
    """Raised for malformed DFAs or illegal transition updates."""


def _check_interval(lo: int, hi: int) -> None:
    if not (CHAR_MIN <= lo <= hi <= CHAR_MAX):
        raise DFAError(f"interval [{lo}, {hi}] outside [{CHAR_MIN}, {CHAR_MAX}]")


class DFA:
    """A symbolic DFA.

    ``transitions`` maps a state to a list of ``(lo, hi, dst)`` tuples.
    Intervals of a state must be disjoint; they are kept sorted.
    ``version`` identifies the machine revision: it is incremented by every
    successful mutation, and proofs are bound to it.
    """

    def __init__(self, num_states, start=0, accepting=(), transitions=None):
        if num_states < 1:
            raise DFAError("num_states must be >= 1")
        self.num_states = int(num_states)
        self.start = int(start)
        self.accepting = frozenset(int(s) for s in accepting)
        self.transitions: dict[int, list[tuple[int, int, int]]] = {}
        for state, intervals in (transitions or {}).items():
            self.transitions[int(state)] = self._checked_intervals(
                int(state), intervals
            )
        self._validate()
        self.version = 0

    # -- validation ------------------------------------------------------

    def _validate(self):
        if not 0 <= self.start < self.num_states:
            raise DFAError(f"start state {self.start} out of range")
        for s in self.accepting:
            if not 0 <= s < self.num_states:
                raise DFAError(f"accepting state {s} out of range")
        for s, ivs in self.transitions.items():
            if not 0 <= s < self.num_states:
                raise DFAError(f"transition source {s} out of range")
            for lo, hi, dst in ivs:
                if not 0 <= dst < self.num_states:
                    raise DFAError(f"transition target {dst} out of range")

    @staticmethod
    def _checked_intervals(state, intervals):
        ivs = sorted((int(lo), int(hi), int(dst)) for lo, hi, dst in intervals)
        for lo, hi, _ in ivs:
            _check_interval(lo, hi)
        for i in range(1, len(ivs)):
            if ivs[i][0] <= ivs[i - 1][1]:
                raise DFAError(
                    f"overlapping intervals on state {state}: "
                    f"[{ivs[i-1][0]}, {ivs[i-1][1]}] and [{ivs[i][0]}, {ivs[i][1]}]"
                )
        return ivs

    # -- semantics ---------------------------------------------------------

    def step(self, state, char):
        """Successor of ``state`` under ``char`` or None (implicit sink)."""
        for lo, hi, dst in self.transitions.get(state, ()):
            if lo <= char <= hi:
                return dst
        return None

    def accepts(self, word):
        state = self.start
        for char in word:
            if state is None:
                return False
            state = self.step(state, char)
        return state is not None and state in self.accepting

    def is_accepting(self, state):
        return state is not None and state in self.accepting

    # -- mutation ------------------------------------------------------------

    def set_transition(self, state, lo, hi, dst):
        """Atomically install a single transition ``[lo, hi] -> dst``.

        The new interval must be disjoint from every existing interval of
        ``state``, except that it may exactly replace an interval with the
        same endpoints.  Any other overlap raises DFAError and leaves the
        machine untouched (atomic rejection).
        """
        lo, hi, dst = int(lo), int(hi), int(dst)
        _check_interval(lo, hi)
        if not 0 <= state < self.num_states:
            raise DFAError(f"state {state} out of range")
        if not 0 <= dst < self.num_states:
            raise DFAError(f"transition target {dst} out of range")
        old = self.transitions.get(state, [])
        kept = []
        replaced = False
        for elo, ehi, edst in old:
            if ehi < lo or elo > hi:
                kept.append((elo, ehi, edst))
            elif elo == lo and ehi == hi:
                replaced = True  # exact replacement, dropped below
            else:
                raise DFAError(
                    f"update [{lo}, {hi}] overlaps existing [{elo}, {ehi}] "
                    f"on state {state}; rejected atomically"
                )
        kept.append((lo, hi, dst))
        new_intervals = self._checked_intervals(state, kept)
        # commit only after every check passed
        self.transitions[state] = new_intervals
        self.version += 1
        return replaced

    # -- serialisation -------------------------------------------------------

    def to_json(self):
        return {
            "num_states": self.num_states,
            "start": self.start,
            "accepting": sorted(self.accepting),
            "transitions": {
                str(s): [list(iv) for iv in ivs]
                for s, ivs in sorted(self.transitions.items())
            },
            "version": self.version,
        }

    @classmethod
    def from_json(cls, data):
        dfa = cls(
            num_states=data["num_states"],
            start=data.get("start", 0),
            accepting=data.get("accepting", []),
            transitions={
                int(s): [tuple(iv) for iv in ivs]
                for s, ivs in data.get("transitions", {}).items()
            },
        )
        dfa.version = int(data.get("version", 0))
        return dfa
