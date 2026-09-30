#!/usr/bin/env python3
"""Mini transactional store: base tables R(A,K), S(K,B) and a join-count
view grouped by A, maintained in a state directory.

Durability model:
  - Every WAL record is fsync'd before the next step proceeds.
  - A transaction's effects reach the base tables only via checkpoint.
  - recover() redoes committed transactions that are not yet checkpointed
    and discards uncommitted ones; txids make redo idempotent.

Exit codes: 0 ok, 2 semantic error (nothing committed), 137 simulated crash.
"""

import argparse
import json
import os
import sys

TABLES_FILE = "tables.json"
WAL_FILE = "wal.log"

EXIT_OK = 0
EXIT_SEMANTIC_ERROR = 2
EXIT_CRASH = 137


class SemanticError(Exception):
    pass


def _fsync_file(f):
    f.flush()
    os.fsync(f.fileno())


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def initial_state():
    return {"next_txid": 1, "last_committed": 0, "R": [], "S": [], "view": {}}


def load_state(state_dir):
    path = os.path.join(state_dir, TABLES_FILE)
    if not os.path.exists(path):
        return initial_state()
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def compute_view(rows_r, rows_s):
    """Join-count view grouped by A: for each A, number of (R,S) pairs
    with R.K = S.K. Computed with a plain nested loop."""
    view = {}
    for r in rows_r:
        for s in rows_s:
            if r["k"] == s["k"]:
                view[r["a"]] = view.get(r["a"], 0) + 1
    return view


def write_checkpoint(state_dir, state):
    """Persist base tables + derived view atomically (tmp file, fsync,
    rename, dir fsync)."""
    state["view"] = compute_view(state["R"], state["S"])
    tmp_path = os.path.join(state_dir, TABLES_FILE + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
        _fsync_file(f)
    os.replace(tmp_path, os.path.join(state_dir, TABLES_FILE))
    _fsync_dir(state_dir)


def wal_append(state_dir, record):
    """Append one WAL record and fsync before returning."""
    path = os.path.join(state_dir, WAL_FILE)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True) + "\n")
        _fsync_file(f)


def wal_read(state_dir):
    path = os.path.join(state_dir, WAL_FILE)
    records = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    return records


def wal_truncate(state_dir):
    path = os.path.join(state_dir, WAL_FILE)
    with open(path, "w", encoding="utf-8") as f:
        _fsync_file(f)
    _fsync_dir(state_dir)


def validate_ops(ops, state):
    """Check a transaction's ops against current committed state.
    Raises SemanticError on any violation; nothing is written on error."""
    if not isinstance(ops, list):
        raise SemanticError("transaction must contain an 'ops' list")
    keys_r = {(r["a"], r["k"]) for r in state["R"]}
    keys_s = {s["k"] for s in state["S"]}
    for i, op in enumerate(ops):
        kind = op.get("op")
        table = op.get("table")
        if kind not in ("insert", "delete"):
            raise SemanticError(f"op {i}: unknown op {kind!r}")
        if table not in ("R", "S"):
            raise SemanticError(f"op {i}: unknown table {table!r}")
        if table == "R":
            a, k = op.get("a"), op.get("k")
            if a is None or k is None:
                raise SemanticError(f"op {i}: R row requires 'a' and 'k'")
            if kind == "insert":
                if (a, k) in keys_r:
                    raise SemanticError(f"op {i}: duplicate R row (a={a!r}, k={k!r})")
                keys_r.add((a, k))
            else:
                if (a, k) not in keys_r:
                    raise SemanticError(f"op {i}: cannot delete missing R row (a={a!r}, k={k!r})")
                keys_r.discard((a, k))
        else:
            k = op.get("k")
            if k is None:
                raise SemanticError(f"op {i}: S row requires 'k'")
            if kind == "insert":
                if op.get("b") is None:
                    raise SemanticError(f"op {i}: S insert requires 'b'")
                if k in keys_s:
                    raise SemanticError(f"op {i}: duplicate S row (k={k!r})")
                keys_s.add(k)
            else:
                if k not in keys_s:
                    raise SemanticError(f"op {i}: cannot delete missing S row (k={k!r})")
                keys_s.discard(k)


def apply_ops_to_state(state, ops):
    for op in ops:
        if op["table"] == "R":
            if op["op"] == "insert":
                state["R"].append({"a": op["a"], "k": op["k"]})
            else:
                state["R"] = [
                    r for r in state["R"]
                    if not (r["a"] == op["a"] and r["k"] == op["k"])
                ]
        else:
            if op["op"] == "insert":
                state["S"].append({"k": op["k"], "b": op["b"]})
            else:
                state["S"] = [s for s in state["S"] if s["k"] != op["k"]]


def _crash(point):
    print(f"simulated crash at {point}", file=sys.stderr, flush=True)
    os._exit(EXIT_CRASH)


def cmd_apply(args):
    state_dir = args.state
    os.makedirs(state_dir, exist_ok=True)

    try:
        with open(args.txfile, "r", encoding="utf-8") as f:
            tx = json.load(f)
        ops = tx["ops"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        print(f"error: bad transaction file: {exc}", file=sys.stderr)
        return EXIT_SEMANTIC_ERROR

    state = load_state(state_dir)

    # Semantic validation happens before any WAL write: a bad transaction
    # leaves no trace and cannot affect committed state.
    try:
        validate_ops(ops, state)
    except SemanticError as exc:
        print(f"semantic error: {exc}", file=sys.stderr)
        return EXIT_SEMANTIC_ERROR

    txid = state["next_txid"]

    wal_append(state_dir, {"type": "BEGIN", "txid": txid})
    for op in ops:
        record = {"type": "OP", "txid": txid, "op": op["op"], "table": op["table"]}
        for field in ("a", "k", "b"):
            if field in op:
                record[field] = op[field]
        wal_append(state_dir, record)

    if args.fail == "pre_commit":
        _crash("pre_commit")

    wal_append(state_dir, {"type": "COMMIT", "txid": txid})

    if args.fail == "post_commit":
        _crash("post_commit")

    apply_ops_to_state(state, ops)
    state["next_txid"] = txid + 1
    state["last_committed"] = txid
    write_checkpoint(state_dir, state)
    wal_append(state_dir, {"type": "CHECKPOINT", "txid": txid})
    wal_truncate(state_dir)

    if args.fail == "post_checkpoint":
        _crash("post_checkpoint")

    print(f"tx {txid} committed and checkpointed")
    return EXIT_OK


def cmd_recover(args):
    state_dir = args.state
    os.makedirs(state_dir, exist_ok=True)
    state = load_state(state_dir)
    records = wal_read(state_dir)

    pending = {}    # txid -> list of ops (not yet known committed)
    committed = []  # txids with a COMMIT record, in order
    for rec in records:
        rtype = rec["type"]
        if rtype == "BEGIN":
            pending[rec["txid"]] = []
        elif rtype == "OP":
            op = {"op": rec["op"], "table": rec["table"]}
            for field in ("a", "k", "b"):
                if field in rec:
                    op[field] = rec[field]
            pending.setdefault(rec["txid"], []).append(op)
        elif rtype == "COMMIT":
            committed.append(rec["txid"])
        elif rtype == "CHECKPOINT":
            # Everything up to here is already durable in tables.json.
            pending.clear()
            committed.clear()

    redone, discarded = [], []
    for txid in committed:
        if txid <= state["last_committed"]:
            continue  # already checkpointed: do not re-apply
        apply_ops_to_state(state, pending[txid])
        state["last_committed"] = txid
        state["next_txid"] = max(state["next_txid"], txid + 1)
        redone.append(txid)
    for txid in pending:
        if txid not in committed and txid > state["last_committed"]:
            discarded.append(txid)  # no COMMIT record: rolled back

    write_checkpoint(state_dir, state)
    wal_truncate(state_dir)

    print(f"recovery complete: redone={redone} rolled_back={discarded}")
    return EXIT_OK


def main(argv=None):
    parser = argparse.ArgumentParser(prog="minidb")
    sub = parser.add_subparsers(dest="command", required=True)

    p_apply = sub.add_parser("apply", help="apply a transaction file")
    p_apply.add_argument("txfile", help="path to tx.json")
    p_apply.add_argument("--state", default="state", help="state directory")
    p_apply.add_argument(
        "--fail",
        choices=["pre_commit", "post_commit", "post_checkpoint"],
        default=None,
        help="simulate a crash at the given point",
    )

    p_recover = sub.add_parser("recover", help="recover from the WAL")
    p_recover.add_argument("--state", default="state", help="state directory")

    args = parser.parse_args(argv)
    if args.command == "apply":
        return cmd_apply(args)
    return cmd_recover(args)


if __name__ == "__main__":
    sys.exit(main())
