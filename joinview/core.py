"""Core logic for the joinview materialized-view maintenance tool.

State is a pair of bag-semantics relations:
    R(A, K)  and  S(K, B)
persisted as JSON: {"R": [[a, k], ...], "S": [[k, b], ...]}.

The materialized view groups the bag join R |x| S on K by A and reports,
per distinct A, the number of join rows and the sum of B values.
Rows whose join key K is NULL never join.
"""

from __future__ import annotations

import copy
import json
import os
import sys

RELATIONS = ("R", "S")


class SemanticError(Exception):
    """A script-level semantic error (exit code 2, committed state intact)."""


def empty_state() -> dict:
    return {"R": [], "S": []}


def _row_key(row) -> str:
    return json.dumps(row, sort_keys=True)


def _validate_row(row, context: str) -> list:
    if not isinstance(row, list) or len(row) != 2:
        raise SemanticError(f"{context}: row must be a 2-element array, got {row!r}")
    return [row[0], row[1]]


def _validate_state(data) -> dict:
    if not isinstance(data, dict):
        raise SemanticError("state file must contain a JSON object")
    state = empty_state()
    for rel in RELATIONS:
        rows = data.get(rel, [])
        if not isinstance(rows, list):
            raise SemanticError(f"state relation {rel} must be an array")
        state[rel] = [_validate_row(row, f"state relation {rel}") for row in rows]
    return state


def load_state(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return empty_state()
    return _validate_state(data)


def save_state(path: str, state: dict) -> None:
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp_path, path)


def load_script(path: str) -> list:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise SemanticError("script file must contain a JSON array of operations")
    return data


def compute_view(state: dict) -> list:
    """Compute the materialized view: per A, join-row count and sum of B."""
    groups: dict[str, dict] = {}
    for r_row in state["R"]:
        a_val, r_key = r_row[0], r_row[1]
        if r_key is None:
            continue
        for s_row in state["S"]:
            s_key, b_val = s_row[0], s_row[1]
            if s_key is None or s_key != r_key:
                continue
            entry = groups.setdefault(
                _row_key(a_val), {"A": a_val, "count": 0, "sum_b": 0}
            )
            entry["count"] += 1
            if b_val is not None:
                entry["sum_b"] += b_val
    return sorted(
        groups.values(),
        key=lambda entry: (entry["A"] is not None, _row_key(entry["A"])),
    )


def run_script(committed: dict, script: list) -> tuple[dict, bool]:
    """Execute *script* against *committed* state.

    Returns (new_committed_state, committed_anything). Raises SemanticError
    on any semantic violation; in that case the returned value is irrelevant
    and the caller must keep the original committed state (the active
    transaction, if any, is discarded, i.e. rolled back).
    """
    committed = _validate_state(committed)
    working = copy.deepcopy(committed)
    undo_log: list[tuple[str, str, list]] = []
    savepoints: list[dict] = []
    in_transaction = False
    committed_anything = False

    def require_transaction(op_name: str) -> None:
        if not in_transaction:
            raise SemanticError(f"{op_name} outside of a transaction")

    def find_savepoint(name):
        for idx in range(len(savepoints) - 1, -1, -1):
            if savepoints[idx]["name"] == name:
                return idx
        return None

    def apply_insert(rel: str, row: list) -> None:
        working[rel].append(list(row))
        undo_log.append(("insert", rel, list(row)))

    def apply_delete(rel: str, row: list) -> None:
        key = _row_key(row)
        for idx, existing in enumerate(working[rel]):
            if _row_key(existing) == key:
                del working[rel][idx]
                undo_log.append(("delete", rel, list(row)))
                return
        raise SemanticError(
            f"delete exceeds multiplicity in {rel}: {_row_key(row)}"
        )

    def undo_entry(entry) -> None:
        kind, rel, row = entry
        if kind == "insert":
            key = _row_key(row)
            for idx, existing in enumerate(working[rel]):
                if _row_key(existing) == key:
                    del working[rel][idx]
                    return
            raise AssertionError("undo of insert failed: row missing")
        working[rel].append(list(row))

    for op in script:
        if not isinstance(op, dict) or "op" not in op:
            raise SemanticError(f"invalid operation: {op!r}")
        name = op["op"]

        if name == "begin":
            if in_transaction:
                raise SemanticError("begin while a transaction is active")
            in_transaction = True
            working = copy.deepcopy(committed)
            undo_log = []
            savepoints = []
        elif name == "commit":
            require_transaction("commit")
            committed = working
            committed_anything = True
            in_transaction = False
            undo_log = []
            savepoints = []
        elif name == "rollback":
            require_transaction("rollback")
            sp_name = op.get("name")
            if sp_name is None:
                in_transaction = False
                working = copy.deepcopy(committed)
                undo_log = []
                savepoints = []
            else:
                idx = find_savepoint(sp_name)
                if idx is None:
                    raise SemanticError(f"no active savepoint named {sp_name!r}")
                pos = savepoints[idx]["log_pos"]
                for entry in reversed(undo_log[pos:]):
                    undo_entry(entry)
                del undo_log[pos:]
                del savepoints[idx + 1 :]
        elif name == "savepoint":
            require_transaction("savepoint")
            sp_name = op.get("name")
            if sp_name is None:
                raise SemanticError("savepoint requires a name")
            if find_savepoint(sp_name) is not None:
                raise SemanticError(f"duplicate active savepoint {sp_name!r}")
            savepoints.append({"name": sp_name, "log_pos": len(undo_log)})
        elif name == "release":
            require_transaction("release")
            sp_name = op.get("name")
            idx = find_savepoint(sp_name)
            if idx is None:
                raise SemanticError(f"no active savepoint named {sp_name!r}")
            del savepoints[idx:]
        elif name == "insert":
            require_transaction("insert")
            rel = op.get("rel")
            if rel not in RELATIONS:
                raise SemanticError(f"unknown relation {rel!r}")
            apply_insert(rel, _validate_row(op.get("row"), "insert"))
        elif name == "delete":
            require_transaction("delete")
            rel = op.get("rel")
            if rel not in RELATIONS:
                raise SemanticError(f"unknown relation {rel!r}")
            apply_delete(rel, _validate_row(op.get("row"), "delete"))
        else:
            raise SemanticError(f"unknown operation {name!r}")

    return committed, committed_anything


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2:
        print("usage: python -m joinview STATE_JSON SCRIPT_JSON", file=sys.stderr)
        return 2
    state_path, script_path = args
    try:
        state = load_state(state_path)
        script = load_script(script_path)
        new_state, committed_anything = run_script(state, script)
    except SemanticError as exc:
        print(f"semantic error: {exc}", file=sys.stderr)
        return 2
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if committed_anything:
        try:
            save_state(state_path, new_state)
        except OSError as exc:
            print(f"error: cannot write state: {exc}", file=sys.stderr)
            return 2
    view = compute_view(new_state)
    json.dump({"view": view}, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0
