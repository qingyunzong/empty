"""Deterministic Mealy machine model with partial-transition completion.

Undefined transitions are treated as an explicit error output leading to a
distinguished fault state (a sink that emits the error output on every
input).
"""
from __future__ import annotations

import json

FAULT_STATE = "__fault__"
ERROR_OUTPUT = "__error__"
MAX_STATES = 10
_RESERVED_PREFIX = "__"


class MachineError(ValueError):
    """Raised when a machine description is invalid."""


def _check_name(kind, name):
    if not isinstance(name, str) or not name:
        raise MachineError(f"{kind} names must be non-empty strings, got {name!r}")
    if name.startswith(_RESERVED_PREFIX):
        raise MachineError(f"{kind} name {name!r} uses the reserved prefix '__'")


class MealyMachine:
    """Deterministic Mealy machine.

    ``transitions`` maps ``state -> input -> (next_state, output)`` and may
    be partial.  On construction the machine is completed: every undefined
    ``(state, input)`` pair produces :data:`ERROR_OUTPUT` and enters
    :data:`FAULT_STATE`.
    """

    def __init__(self, states, inputs, transitions=None):
        if not states:
            raise MachineError("machine must have at least one state")
        if len(states) > MAX_STATES:
            raise MachineError(
                f"at most {MAX_STATES} states are supported, got {len(states)}"
            )
        if not inputs:
            raise MachineError("machine must have at least one input")
        for name in states:
            _check_name("state", name)
        if len(set(states)) != len(states):
            raise MachineError("duplicate state names")
        for name in inputs:
            _check_name("input", name)
        if len(set(inputs)) != len(inputs):
            raise MachineError("duplicate input names")

        self.user_states = list(states)
        self.inputs = list(inputs)
        self._trans = {s: {} for s in self.user_states}
        outputs = []
        for state, row in (transitions or {}).items():
            if state not in self._trans:
                raise MachineError(f"transitions defined for unknown state {state!r}")
            for inp, entry in row.items():
                if inp not in self.inputs:
                    raise MachineError(
                        f"transition of {state!r} uses unknown input {inp!r}"
                    )
                nxt, out = self._parse_entry(state, inp, entry)
                if nxt not in self._trans:
                    raise MachineError(
                        f"transition {state!r} --{inp}--> unknown state {nxt!r}"
                    )
                _check_name("output", out)
                self._trans[state][inp] = (nxt, out)
                if out not in outputs:
                    outputs.append(out)

        # Completion: undefined transitions emit the error output and enter
        # the fault state; the fault state is a sink.
        self._trans[FAULT_STATE] = {}
        for state in self.states:
            for inp in self.inputs:
                if inp not in self._trans[state]:
                    self._trans[state][inp] = (FAULT_STATE, ERROR_OUTPUT)
        self.outputs = outputs + [ERROR_OUTPUT]

    # -- basic accessors -------------------------------------------------

    @property
    def states(self):
        """All states of the completed machine (user states + fault state)."""
        return self.user_states + [FAULT_STATE]

    def output(self, state, inp):
        try:
            return self._trans[state][inp][1]
        except KeyError:
            raise MachineError(f"unknown state {state!r} or input {inp!r}") from None

    def successor(self, state, inp):
        try:
            return self._trans[state][inp][0]
        except KeyError:
            raise MachineError(f"unknown state {state!r} or input {inp!r}") from None

    def simulate_outputs(self, state, sequence):
        """Output sequence produced from ``state`` under ``sequence``."""
        outs = []
        for inp in sequence:
            nxt, out = self._trans[state][inp]
            outs.append(out)
            state = nxt
        return outs

    def run(self, state, sequence):
        """Return ``(outputs, final_state)`` for ``sequence`` from ``state``."""
        outs = self.simulate_outputs(state, sequence)
        for inp in sequence:
            state = self._trans[state][inp][0]
        return outs, state

    # -- serialisation ----------------------------------------------------

    @staticmethod
    def _parse_entry(state, inp, entry):
        if isinstance(entry, dict):
            try:
                return entry["next"], entry["output"]
            except KeyError as exc:
                raise MachineError(
                    f"transition {state!r}/{inp!r} misses key {exc}"
                ) from None
        if isinstance(entry, (list, tuple)) and len(entry) == 2:
            return entry[0], entry[1]
        raise MachineError(
            f"transition {state!r}/{inp!r} must be [next, output] or an object"
        )

    @classmethod
    def from_dict(cls, data):
        if not isinstance(data, dict):
            raise MachineError("machine description must be a JSON object")
        for field in ("states", "inputs"):
            if field not in data:
                raise MachineError(f"machine description misses field {field!r}")
        machine = cls(data["states"], data["inputs"], data.get("transitions", {}))
        declared = data.get("outputs")
        if declared is not None:
            extra = [o for o in machine.outputs if o != ERROR_OUTPUT and o not in declared]
            if extra:
                raise MachineError(f"transitions emit undeclared outputs: {extra}")
        return machine

    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))

    def to_dict(self):
        transitions = {}
        for state in self.user_states:
            row = {}
            for inp in self.inputs:
                nxt, out = self._trans[state][inp]
                if nxt == FAULT_STATE and out == ERROR_OUTPUT:
                    continue  # undefined in the user description
                row[inp] = {"next": nxt, "output": out}
            transitions[state] = row
        return {
            "states": list(self.user_states),
            "inputs": list(self.inputs),
            "outputs": [o for o in self.outputs if o != ERROR_OUTPUT],
            "transitions": transitions,
        }

    def dump(self, path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, indent=2)
            fh.write("\n")
