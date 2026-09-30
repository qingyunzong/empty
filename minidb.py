#!/usr/bin/env python3
"""minidb: a tiny WAL-backed transactional store (Python 3.11 stdlib only).

State directory contents:
    state.json   checkpointed base tables R(A, K), S(K, B), the materialized
                 join-count view grouped by A, and the last checkpointed LSN.
    wal.log      append-only write-ahead log; every record is fsynced before
                 the operation proceeds.

View semantics:
    view[a] = |{(r, s) : r in R, s in S, r.K = s.K, r.A = a}|   (a > 0 count only)

Commands:
    apply TX_JSON [--fail pre_commit|post_commit|post_checkpoint] [--state-dir DIR]
    recover [--state-dir DIR]

Exit codes:
    0    success
    2    semantic error (no COMMIT record is written)
    137  simulated crash at the requested failure point
"""

import argparse
import json
import os
import sys

EXIT_OK = 0
EXIT_SEMANTIC_ERROR = 2
EXIT_SIMULATED_CRASH = 137

TABLES = ("R", "S")
FAIL_POINTS = ("pre_commit", "post_commit", "post_checkpoint")


class SemanticError(Exception):
    """A transaction violates table semantics (duplicate/missing tuple, etc.)."""


def empty_state():
    return {"R": [], "S": [], "view": {}, "last_lsn": 0}


def state_file(directory):
    return os.path.join(directory, "state.json")


def wal_file(directory):
    return os.path.join(directory, "wal.log")


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def load_state(directory):
    try:
        with open(state_file(directory), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return empty_state()


def checkpoint(directory, state):
    """Atomically persist the state, then reset the WAL. Everything fsynced."""
    tmp = state_file(directory) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, sort_keys=True)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, state_file(directory))
    fsync_dir(directory)
    with open(wal_file(directory), "w", encoding="utf-8") as fh:
        fh.flush()
        os.fsync(fh.fileno())
    fsync_dir(directory)


def wal_append(directory, record):
    """Append one WAL record; fsync before returning (record is durable)."""
    with open(wal_file(directory), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def read_wal(directory):
    records = []
    try:
        with open(wal_file(directory), "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    break  # tolerate a torn tail left by a crash
    except FileNotFoundError:
        pass
    return records


def _decr(view, a, n):
    new = view.get(a, 0) - n
    if new <= 0:
        view.pop(a, None)
    else:
        view[a] = new


def apply_op(state, op):
    """Validate and apply one op to base tables, maintaining the view.

    Raises SemanticError on any violation; used identically by `apply`
    (live execution) and `recover` (redo), so both paths stay consistent.
    """
    table = op.get("table")
    action = op.get("op")
    tup = op.get("tuple")
    if table not in TABLES:
        raise SemanticError("unknown table: %r" % (table,))
    if action not in ("insert", "delete"):
        raise SemanticError("unknown op: %r" % (action,))
    if not isinstance(tup, list) or len(tup) != 2:
        raise SemanticError("bad tuple: %r" % (tup,))

    rows = state[table]
    view = state["view"]

    if action == "insert":
        if tup in rows:
            raise SemanticError("duplicate tuple %r in %s" % (tup, table))
        rows.append(tup)
        rows.sort()
        if table == "R":
            a, k = tup
            delta = sum(1 for s in state["S"] if s[0] == k)
            if delta:
                view[a] = view.get(a, 0) + delta
        else:
            k, _ = tup
            for r in state["R"]:
                if r[1] == k:
                    view[r[0]] = view.get(r[0], 0) + 1
    else:  # delete
        if tup not in rows:
            raise SemanticError("missing tuple %r in %s" % (tup, table))
        rows.remove(tup)
        if table == "R":
            a, k = tup
            delta = sum(1 for s in state["S"] if s[0] == k)
            if delta:
                _decr(view, a, delta)
        else:
            k, _ = tup
            for r in state["R"]:
                if r[1] == k:
                    _decr(view, r[0], 1)


def cmd_apply(args):
    directory = args.state_dir
    os.makedirs(directory, exist_ok=True)
    with open(args.tx, "r", encoding="utf-8") as fh:
        tx = json.load(fh)
    ops = tx.get("ops")
    if not isinstance(ops, list):
        print("semantic error: tx file must contain an 'ops' list", file=sys.stderr)
        return EXIT_SEMANTIC_ERROR

    state = load_state(directory)
    records = read_wal(directory)
    lsn = max([state["last_lsn"]] + [r.get("lsn", 0) for r in records]) + 1
    txid = "tx-%d" % lsn

    wal_append(directory, {"lsn": lsn, "type": "begin", "txid": txid})
    for op in ops:
        lsn += 1
        try:
            apply_op(state, op)
        except SemanticError as exc:
            # No COMMIT record is written; recover will roll this txn back.
            print("semantic error: %s" % exc, file=sys.stderr)
            return EXIT_SEMANTIC_ERROR
        wal_append(directory, {"lsn": lsn, "type": "op", "txid": txid, "op": op})

    if args.fail == "pre_commit":
        os._exit(EXIT_SIMULATED_CRASH)  # crash before the COMMIT record

    lsn += 1
    commit_lsn = lsn
    wal_append(directory, {"lsn": commit_lsn, "type": "commit", "txid": txid})
    state["last_lsn"] = commit_lsn

    if args.fail == "post_commit":
        os._exit(EXIT_SIMULATED_CRASH)  # crash after COMMIT fsync, before checkpoint

    checkpoint(directory, state)

    if args.fail == "post_checkpoint":
        os._exit(EXIT_SIMULATED_CRASH)  # crash after checkpoint is durable

    return EXIT_OK


def cmd_recover(args):
    directory = args.state_dir
    os.makedirs(directory, exist_ok=True)
    state = load_state(directory)
    records = read_wal(directory)

    pending = {}    # txid -> [op, ...] for txns seen since BEGIN
    committed = []  # (commit_lsn, txid) in WAL order
    for rec in records:
        rtype = rec.get("type")
        txid = rec.get("txid")
        if rtype == "begin":
            pending[txid] = []
        elif rtype == "op" and txid in pending:
            pending[txid].append(rec["op"])
        elif rtype == "commit" and txid in pending:
            committed.append((rec["lsn"], txid))

    redone = 0
    for commit_lsn, txid in committed:
        if commit_lsn <= state["last_lsn"]:
            continue  # already in the checkpoint: never re-apply
        for op in pending[txid]:
            apply_op(state, op)
        state["last_lsn"] = commit_lsn
        redone += 1
    # Txns without a COMMIT record are discarded here: checkpointing the
    # state and truncating the WAL rolls them back completely.
    checkpoint(directory, state)
    print("recover: redone=%d last_lsn=%d" % (redone, state["last_lsn"]))
    return EXIT_OK


def main(argv=None):
    parser = argparse.ArgumentParser(prog="minidb", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    pa = sub.add_parser("apply", help="apply a transaction file")
    pa.add_argument("tx", help="path to tx.json")
    pa.add_argument("--fail", choices=FAIL_POINTS, default=None,
                    help="simulate a crash at the given point")
    pa.add_argument("--state-dir", default="./dbstate")

    pr = sub.add_parser("recover", help="recover from the WAL")
    pr.add_argument("--state-dir", default="./dbstate")

    args = parser.parse_args(argv)
    if args.command == "apply":
        return cmd_apply(args)
    return cmd_recover(args)


if __name__ == "__main__":
    sys.exit(main())
