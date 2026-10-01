"""Core logic for taskq.

Persistence protocol (the only way the db is ever written):
    1. serialize state to <db>.tmp
    2. fsync(<db>.tmp)
    3. os.replace(<db>.tmp, <db>)   <-- atomic commit point
    4. fsync(directory)

Recovery rule:
    - If <db>.tmp exists, the rename never completed, so the tmp holds an
      uncommitted state: discard it and keep <db> as-is.
    - If the rename completed, <db> already is the committed state: keep it.
    - Invariant: no task id may appear in both `pending` and `done`.

Exit codes:
    0  success
    2  usage/validation error (bad JSON, unknown op, negative dur,
       duplicate enqueue id, ...)
    3  simulated crash (the `crash` action)
"""
import argparse
import json
import os
import sys
import time

STAGES = ("before_tmp", "after_tmp_before_rename", "after_rename")
OPS = ("enqueue", "run", "crash")


class UsageError(Exception):
    """Exit code 2."""


class CrashSimulated(Exception):
    """Exit code 3."""


# ---------------------------------------------------------------- persistence

def tmp_path(db_path):
    return db_path + ".tmp"


def _write_tmp(db_path, state):
    with open(tmp_path(db_path), "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())


def _fsync_dir(path):
    fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def commit(db_path, state):
    """Atomically replace db with state. Returns after the commit point."""
    _write_tmp(db_path, state)
    os.replace(tmp_path(db_path), db_path)  # commit point: rename returns
    _fsync_dir(db_path)


def load_db(db_path):
    if not os.path.exists(db_path):
        return {"pending": [], "done": []}
    try:
        with open(db_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise UsageError(f"cannot load db {db_path}: {exc}")
    if (not isinstance(data, dict)
            or not isinstance(data.get("pending"), list)
            or not isinstance(data.get("done"), list)):
        raise UsageError(f"db {db_path} has invalid shape")
    return data


# ------------------------------------------------------------------ validation

def _valid_dur(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0


def load_script(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise UsageError(f"cannot load script {path}: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("actions"), list):
        raise UsageError("script must be an object with an 'actions' list")
    seen_ids = set()
    for idx, action in enumerate(data["actions"]):
        where = f"action[{idx}]"
        if not isinstance(action, dict):
            raise UsageError(f"{where}: not an object")
        op = action.get("op")
        if op not in OPS:
            raise UsageError(f"{where}: unknown op {op!r}")
        if "dur" in action and not _valid_dur(action["dur"]):
            raise UsageError(f"{where}: negative or invalid dur {action['dur']!r}")
        if op in ("enqueue", "run"):
            task = action.get("task")
            if not isinstance(task, str) or not task:
                raise UsageError(f"{where}: missing or invalid 'task' id")
            if op == "enqueue":
                if task in seen_ids:
                    raise UsageError(f"{where}: duplicate enqueue id {task!r}")
                seen_ids.add(task)
        if op == "crash":
            if action.get("stage") not in STAGES:
                raise UsageError(f"{where}: invalid stage {action.get('stage')!r}")
    return data["actions"]


# -------------------------------------------------------------------- actions

def _simulate_crash(db_path, state, stage):
    if stage == "before_tmp":
        raise CrashSimulated
    _write_tmp(db_path, state)
    if stage == "after_tmp_before_rename":
        raise CrashSimulated
    os.replace(tmp_path(db_path), db_path)  # rename completed
    _fsync_dir(db_path)
    raise CrashSimulated


def cmd_run(args):
    actions = load_script(args.script)
    state = load_db(args.db)

    # Conflict check up front so a duplicate id never mutates the db.
    known = {t["id"] for t in state["pending"]} | {t["id"] for t in state["done"]}
    for action in actions:
        if action["op"] == "enqueue" and action["task"] in known:
            raise UsageError(f"duplicate enqueue id {action['task']!r}: already in db")

    results = []
    done_log = []  # in-memory done log, written before each commit
    for idx, action in enumerate(actions):
        op = action["op"]
        if op == "enqueue":
            task = {"id": action["task"]}
            if "at" in action:
                task["at"] = action["at"]
            if "dur" in action:
                task["dur"] = action["dur"]
            state["pending"].append(task)
            commit(args.db, state)
            results.append({"action": idx, "op": op, "task": task["id"],
                            "status": "enqueued"})
        elif op == "run":
            tid = action["task"]
            match = next((t for t in state["pending"] if t["id"] == tid), None)
            if match is None:
                raise UsageError(f"action[{idx}]: task {tid!r} is not pending")
            dur = action.get("dur", match.get("dur", 0))
            if dur:
                time.sleep(dur)
            record = {"id": tid, "dur": dur}
            done_log.append(record)  # done record hits the memory log first
            state["pending"] = [t for t in state["pending"] if t["id"] != tid]
            state["done"].append(record)
            commit(args.db, state)  # commit point: rename returns
            results.append({"action": idx, "op": op, "task": tid,
                            "status": "done"})
        else:  # crash
            results.append({"action": idx, "op": op, "stage": action["stage"],
                            "status": "crashed"})
            _simulate_crash(args.db, state, action["stage"])

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"done": state["done"]}, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(json.dumps({"actions": results,
                      "pending": state["pending"],
                      "done": state["done"]}, indent=2, sort_keys=True))


def cmd_recover(args):
    discarded = False
    if os.path.exists(tmp_path(args.db)):
        # rename never completed -> tmp is uncommitted garbage
        os.remove(tmp_path(args.db))
        _fsync_dir(args.db)
        discarded = True
    state = load_db(args.db)
    both = ({t["id"] for t in state["pending"]}
            & {t["id"] for t in state["done"]})
    if both:
        raise UsageError(f"invariant violated: both done and pending: {sorted(both)}")
    print(json.dumps({"pending": state["pending"],
                      "done": state["done"],
                      "tmp_discarded": discarded}, indent=2, sort_keys=True))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="taskq")
    sub = parser.add_subparsers(dest="command", required=True)
    p_run = sub.add_parser("run", help="execute a script of actions")
    p_run.add_argument("script")
    p_run.add_argument("--db", required=True)
    p_run.add_argument("--out", required=True)
    p_rec = sub.add_parser("recover", help="recover the db after a crash")
    p_rec.add_argument("--db", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "run":
            cmd_run(args)
        else:
            cmd_recover(args)
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except CrashSimulated:
        print("crash simulated", file=sys.stderr)
        return 3
    return 0
