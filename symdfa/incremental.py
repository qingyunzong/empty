"""Proof invalidation and reuse across machine updates.

Proofs are bound to machine versions.  After an update, entries whose pair
mentions a state changed since the bound version are stale (their outgoing
edges may differ); every other entry is still valid and can be reused,
which makes the corresponding product edges free during a re-check.
"""

from __future__ import annotations

from .proof import entry_edges_consistent


def changed_states_since(machine, version):
    """States whose transitions changed in (version, machine.version]."""
    if version > machine.version:
        raise ValueError(
            f"version {version} is newer than machine version {machine.version}")
    return {state for (v, state, _lo, _hi) in machine.changes
            if version < v <= machine.version}


def invalidate_proof(proof, a, b):
    """Split proof entries into (valid, stale) against current machines."""
    changed_a = changed_states_since(a, proof["version_a"])
    changed_b = changed_states_since(b, proof["version_b"])
    valid, stale = [], []
    for entry in proof["entries"]:
        pa, pb = entry["pair"]
        if pa in changed_a or pb in changed_b:
            stale.append(entry)
        else:
            valid.append(entry)
    return valid, stale


def build_reuse(valid_entries, a, b):
    """Turn still-valid entries into a reuse map for ``explore.check``.

    Each entry is re-validated locally against the current machines before
    being trusted; entries that fail are dropped.
    """
    reuse = {}
    for entry in valid_entries:
        pair = (entry["pair"][0], entry["pair"][1])
        edges = [(e["lo"], e["hi"], (e["next"][0], e["next"][1]))
                 for e in entry["edges"]]
        if not entry_edges_consistent(a, b, pair, edges):
            reuse[pair] = [(lo, hi, nxt[0], nxt[1]) for lo, hi, nxt in edges]
    return reuse
