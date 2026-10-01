"""JSON (de)serialization for symbolic DFAs."""
from __future__ import annotations

from .dfa import SymbolicDFA


def dfa_from_json(obj):
    return SymbolicDFA(
        obj["alphabet_size"],
        obj["start"],
        obj.get("finals", []),
        obj["transitions"],
    )


def dfa_to_json(dfa):
    return {
        "alphabet_size": dfa.alphabet_size,
        "start": dfa.start,
        "finals": sorted(dfa.finals),
        "transitions": {
            str(s): [[lo, hi, t] for lo, hi, t in dfa.transitions[s]]
            for s in sorted(dfa.states)
        },
    }


def updates_from_json(obj):
    """Parse an incremental update batch.

    Format: ``{"finals": {"<state>": true/false, ...},
               "transitions": {"<state>": [[lo, hi, target], ...], ...}}``
    """
    final_changes = {int(s): bool(v) for s, v in obj.get("finals", {}).items()}
    transition_changes = {
        int(s): [tuple(row) for row in rows]
        for s, rows in obj.get("transitions", {}).items()
    }
    return final_changes, transition_changes
