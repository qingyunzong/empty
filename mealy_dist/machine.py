"""Deterministic Mealy machine model with partial transitions.

An undefined transition on input ``x`` is treated as an explicit fault:
the machine emits the reserved error output and moves to a dedicated
fault state, in which every input repeats the error output.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

ERROR_OUTPUT = "__error__"
FAULT_STATE = "__fault__"


@dataclass(frozen=True)
class MealyMachine:
    states: Tuple[str, ...]
    inputs: Tuple[str, ...]
    outputs: Tuple[str, ...]
    transitions: Mapping[str, Mapping[str, Tuple[str, str]]]
    error_output: str = ERROR_OUTPUT
    fault_state: str = FAULT_STATE

    def __post_init__(self) -> None:
        if not self.states:
            raise ValueError("machine must have at least one state")
        if not self.inputs:
            raise ValueError("machine must have at least one input")
        if len(self.states) > 10:
            raise ValueError("at most 10 states are supported")
        if self.fault_state in self.states:
            raise ValueError("fault state name collides with a real state")
        if self.error_output in self.outputs:
            raise ValueError("error output name collides with a real output")
        for state, row in self.transitions.items():
            if state not in self.states:
                raise ValueError(f"transition defined for unknown state {state!r}")
            for symbol, (nxt, out) in row.items():
                if symbol not in self.inputs:
                    raise ValueError(f"transition on unknown input {symbol!r}")
                if nxt not in self.states:
                    raise ValueError(f"transition to unknown state {nxt!r}")
                if out not in self.outputs:
                    raise ValueError(f"transition emits unknown output {out!r}")

    # -- semantics ---------------------------------------------------------
    def is_defined(self, state: str, symbol: str) -> bool:
        return symbol in self.transitions.get(state, {})

    def step(self, state: str, symbol: str) -> Tuple[str, str]:
        """Return (next_state, output); fault semantics for undefined moves."""
        if state == self.fault_state:
            return self.fault_state, self.error_output
        if state not in self.states:
            raise ValueError(f"unknown state {state!r}")
        if symbol not in self.inputs:
            raise ValueError(f"unknown input {symbol!r}")
        edge = self.transitions.get(state, {}).get(symbol)
        if edge is None:
            return self.fault_state, self.error_output
        return edge

    def run(self, state: str, sequence: Sequence[str]) -> List[str]:
        outputs: List[str] = []
        current = state
        for symbol in sequence:
            current, out = self.step(current, symbol)
            outputs.append(out)
        return outputs

    def end_state(self, state: str, sequence: Sequence[str]) -> str:
        current = state
        for symbol in sequence:
            current, _ = self.step(current, symbol)
        return current

    # -- io ----------------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "states": list(self.states),
            "inputs": list(self.inputs),
            "outputs": list(self.outputs),
            "transitions": {
                state: {symbol: [edge[0], edge[1]] for symbol, edge in row.items()}
                for state, row in sorted(self.transitions.items())
            },
        }

    @classmethod
    def from_dict(cls, data: Mapping) -> "MealyMachine":
        transitions: Dict[str, Dict[str, Tuple[str, str]]] = {}
        for state, row in data.get("transitions", {}).items():
            transitions[state] = {
                symbol: (str(edge[0]), str(edge[1])) for symbol, edge in row.items()
            }
        return cls(
            states=tuple(str(s) for s in data["states"]),
            inputs=tuple(str(i) for i in data["inputs"]),
            outputs=tuple(str(o) for o in data["outputs"]),
            transitions=transitions,
        )

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True)

    @classmethod
    def from_json(cls, text: str) -> "MealyMachine":
        return cls.from_dict(json.loads(text))
