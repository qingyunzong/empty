"""Durable JSON state store.

Each CLI operation loads the state, applies one linearized mutation, and
atomically rewrites the state file (tmp + rename) *before* the response
is produced. If the process crashes after the write but before the
response reaches the caller, the caller simply retries: idempotent
replay returns the recorded result with no double effect.
"""
from __future__ import annotations

import json
import os

from .model import GateState

FORMAT_VERSION = 1


def load_state(path: str) -> GateState:
    if not os.path.exists(path):
        return GateState()
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    if doc.get("format_version") != FORMAT_VERSION:
        raise ValueError(f"unsupported state format in {path!r}")
    return GateState.from_dict(doc["state"])


def save_state(state: GateState, path: str) -> None:
    doc = {"format_version": FORMAT_VERSION, "state": state.to_dict()}
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
