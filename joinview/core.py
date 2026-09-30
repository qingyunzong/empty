"""Core engine: bag-semantics relations, savepoint transactions, join view.

State is a dict {"R": [{"A": a, "K": k}, ...], "S": [{"K": k, "B": b}, ...]}
where duplicate rows carry multiplicity (bag semantics) and None models NULL.
"""

from __future__ import annotations

import copy
import json
import os


class SemanticError(Exception):
    """Script semantic error: process exits 2 and committed state is unchanged."""


EMPTY_STATE = {"R": [], "S": []}

_RELATIONS = ("R", "S")
_ROW_FIELDS = {"R": ("A", "K"), "S": ("K", "B")}


def _row_key(value):
    return json.dumps(value, sort_keys=True)


def normalize_state(data):
    """Validate and normalize a decoded JSON state document."""
    if not isinstance(data, dict) or set(data) != set(_RELATIONS):
        raise ValueError("state must be an object with keys 'R' and 'S'")
    state = {}
    for rel in _RELATIONS:
        rows = data[rel]
        if not isinstance(rows, list):
            raise ValueError(f"state[{rel!r}] must be a list of rows")
        norm_rows = []
        for row in rows:
            if not isinstance(row, dict) or set(row) != set(_ROW_FIELDS[rel]):
                raise ValueError(
                    f"{rel} rows must be objects with fields {_ROW_FIELDS[rel]}"
                )
            norm_rows.append({field: row[field] for field in _ROW_FIELDS[rel]})
        state[rel] = norm_rows
    return state


def load_state(path):
    """Load committed state; a missing file means the empty state."""
    if not os.path.exists(path):
        return copy.deepcopy(EMPTY_STATE)
    with open(path, "r", encoding="utf-8") as handle:
        return normalize_state(json.load(handle))


def save_state(path, state):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
        handle.write("\n")


def load_script(path):
    with open(path, "r", encoding="utf-8") as handle:
        script = json.load(handle)
    if not isinstance(script, list):
        raise ValueError("script must be a JSON list of commands")
    return script


def compute_view(state):
    """Group R join S by A: join-row count and sum of B. NULL keys never join."""
    groups = {}
    for r_row in state["R"]:
        k_value = r_row["K"]
        if k_value is None:
            continue
        for s_row in state["S"]:
            if s_row["K"] is None or s_row["K"] != k_value:
                continue
            key = _row_key(r_row["A"])
            entry = groups.setdefault(key, {"A": r_row["A"], "count": 0, "sum": 0})
            entry["count"] += 1
            if s_row["B"] is not None:
                entry["sum"] += s_row["B"]
    return [groups[key] for key in sorted(groups)]


class Engine:
    """Executes script commands against committed state with savepoint support."""

    def __init__(self, state):
        self.committed = copy.deepcopy(state)
        self.persisted = False
        self.in_txn = False
        self.working = None
        self.savepoints = []

    def _require_txn(self, op):
        if not self.in_txn:
            raise SemanticError(f"{op}: no active transaction")

    def _find_savepoint(self, name):
        for index in range(len(self.savepoints) - 1, -1, -1):
            if self.savepoints[index][0] == name:
                return index
        raise SemanticError(f"no active savepoint named {name!r}")

    def begin(self):
        if self.in_txn:
            raise SemanticError("begin: transaction already active")
        self.in_txn = True
        self.working = copy.deepcopy(self.committed)
        self.savepoints = []

    def commit(self):
        self._require_txn("commit")
        self.committed = self.working
        self.working = None
        self.savepoints = []
        self.in_txn = False
        self.persisted = True

    def rollback(self, name=None):
        self._require_txn("rollback")
        if name is None:
            self.working = None
            self.savepoints = []
            self.in_txn = False
            return
        index = self._find_savepoint(name)
        self.working = copy.deepcopy(self.savepoints[index][1])
        del self.savepoints[index + 1 :]

    def savepoint(self, name):
        self._require_txn("savepoint")
        if any(saved == name for saved, _ in self.savepoints):
            raise SemanticError(f"duplicate active savepoint name {name!r}")
        self.savepoints.append((name, copy.deepcopy(self.working)))

    def release(self, name):
        self._require_txn("release")
        index = self._find_savepoint(name)
        del self.savepoints[index:]

    def insert(self, rel, row):
        self._require_txn("insert")
        self.working[rel].append(row)

    def delete(self, rel, row):
        self._require_txn("delete")
        rows = self.working[rel]
        for index, existing in enumerate(rows):
            if existing == row:
                del rows[index]
                return
        raise SemanticError(f"delete of {rel} row {row!r} exceeds multiplicity")


def _command_row(rel, command):
    fields = _ROW_FIELDS[rel]
    missing = [field for field in fields if field not in command]
    if missing:
        raise SemanticError(f"{rel} command missing fields {missing}")
    return {field: command[field] for field in fields}


def run_script(state, script):
    """Run a script; returns the Engine. Raises SemanticError on bad commands."""
    engine = Engine(state)
    for position, command in enumerate(script, start=1):
        if not isinstance(command, dict):
            raise SemanticError(f"command #{position} is not an object")
        op = command.get("op")
        try:
            if op == "begin":
                engine.begin()
            elif op == "commit":
                engine.commit()
            elif op == "rollback":
                engine.rollback(command.get("name"))
            elif op == "savepoint":
                engine.savepoint(_command_name(command))
            elif op == "release":
                engine.release(_command_name(command))
            elif op in ("insert", "delete"):
                rel = command.get("rel")
                if rel not in _RELATIONS:
                    raise SemanticError(f"command #{position}: unknown relation {rel!r}")
                row = _command_row(rel, command)
                if op == "insert":
                    engine.insert(rel, row)
                else:
                    engine.delete(rel, row)
            else:
                raise SemanticError(f"command #{position}: unknown op {op!r}")
        except SemanticError as error:
            raise SemanticError(f"command #{position}: {error}") from error
    return engine


def _command_name(command):
    name = command.get("name")
    if not isinstance(name, str) or not name:
        raise SemanticError("savepoint/release/rollback requires a string 'name'")
    return name
