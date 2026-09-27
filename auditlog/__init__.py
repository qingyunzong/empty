"""Append-only audit log with SHA256 hash chain, snapshots, recovery and replay."""

from .core import (
    GENESIS_HASH,
    PolicyError,
    SimulatedCrash,
    append,
    latest_snapshot,
    read_head,
    recover,
    replay,
    snapshot,
    verify,
)

__all__ = [
    "GENESIS_HASH",
    "PolicyError",
    "SimulatedCrash",
    "append",
    "latest_snapshot",
    "read_head",
    "recover",
    "replay",
]
