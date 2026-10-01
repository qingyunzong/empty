"""taskq: a tiny persistent task queue with crash-recovery semantics.

Persistence rule: the db file is only ever updated by writing
``<db>.tmp``, fsyncing it, and atomically renaming it over ``<db>``.
The commit point of any state change is the moment ``os.replace`` returns.

Crash stages (fault injection points of the commit protocol):
  - before_tmp:               crash before the tmp file is written
  - after_tmp_before_rename:  crash after tmp is written+fsynced, before rename
  - after_rename:             crash after the rename (commit point reached)

Recovery: if ``<db>.tmp`` exists, the rename never completed, so the db was
not updated by the interrupted commit -> discard the tmp file and keep the db.
If no tmp exists, either the rename completed (db is the committed state) or
no commit was in flight -> keep the db as-is.
"""

import json
import os

STAGES = ("before_tmp", "after_tmp_before_rename", "after_rename")


class TaskqError(Exception):
    """User-facing error; maps to exit code 2."""


class CrashExit(Exception):
    """Simulated crash; maps to exit code 3."""

    def __init__(self, stage):
        super().__init__(stage)
        self.stage = stage


def tmp_path(db_path):
    return db_path + ".tmp"


def load_json_file(path, what):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise TaskqError(f"{what} not found: {path}")
    except json.JSONDecodeError as exc:
        raise TaskqError(f"invalid JSON in {what} {path}: {exc}")
    except OSError as exc:
        raise TaskqError(f"cannot read {what} {path}: {exc}")


def empty_db():
    return {"pending": [], "done": []}


def load_db(db_path):
    if not os.path.exists(db_path):
        return empty_db()
    data = load_json_file(db_path, "db")
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("pending"), list)
        or not isinstance(data.get("done"), list)
    ):
        raise TaskqError(f"db {db_path} must be an object with 'pending' and 'done' lists")
    return {"pending": data["pending"], "done": data["done"]}


def commit(db_path, state, crash_stage=None):
    """Persist ``state`` via tmp+fsync+rename. The rename return is the
    commit point. ``crash_stage`` injects a crash (CrashExit) at the given
    stage of the protocol."""
    tmp = tmp_path(db_path)
    if crash_stage == "before_tmp":
        raise CrashExit(crash_stage)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    if crash_stage == "after_tmp_before_rename":
        raise CrashExit(crash_stage)
    os.replace(tmp, db_path)  # commit point
    dir_fd = os.open(os.path.dirname(os.path.abspath(db_path)), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    if crash_stage == "after_rename":
        raise CrashExit(crash_stage)


def validate_dur(action, index):
    if "dur" not in action:
        return
    dur = action["dur"]
    if isinstance(dur, bool) or not isinstance(dur, (int, float)):
        raise TaskqError(f"action {index}: dur must be a number")
    if dur < 0:
        raise TaskqError(f"action {index}: negative dur {dur}")


def normalize_task(action, index):
    task = action.get("task")
    if task is None:
        task = {}
    elif isinstance(task, str):
        task = {"id": task}
    elif not isinstance(task, dict):
        raise TaskqError(f"action {index}: task must be an object or string")
    task = dict(task)
    task.setdefault("id", f"auto-{index}")
    if "dur" in action:
        task["dur"] = action["dur"]
    if "at" in action:
        task["at"] = action["at"]
    return task


def validate_stage(action, index):
    stage = action.get("stage")
    if stage not in STAGES:
        raise TaskqError(
            f"action {index}: crash stage must be one of {', '.join(STAGES)}"
        )
    return stage


def lookahead_crash_stage(actions, i):
    """If the next action is a crash, it is a fault injection into this
    action's commit; return its stage, else None."""
    nxt = actions[i + 1] if i + 1 < len(actions) else None
    if isinstance(nxt, dict) and nxt.get("op") == "crash":
        return validate_stage(nxt, i + 1)
    return None


def run_script(script_path, db_path, out_path=None, emit=print):
    script = load_json_file(script_path, "script")
    actions = script.get("actions") if isinstance(script, dict) else None
    if not isinstance(actions, list):
        raise TaskqError(f"script {script_path} must be an object with an 'actions' list")
    state = load_db(db_path)

    i = 0
    while i < len(actions):
        action = actions[i]
        if not isinstance(action, dict):
            raise TaskqError(f"action {i}: must be an object")
        op = action.get("op")
        validate_dur(action, i)
        crash_stage = lookahead_crash_stage(actions, i)

        if op == "enqueue":
            task = normalize_task(action, i)
            known = {t.get("id") for t in state["pending"]} | {
                t.get("id") for t in state["done"]
            }
            if task["id"] in known:
                raise TaskqError(f"action {i}: duplicate task id {task['id']!r}")
            state["pending"].append(task)
            commit(db_path, state, crash_stage)
            emit({"type": "action", "index": i, "op": "enqueue",
                  "status": "ok", "id": task["id"]})
        elif op == "run":
            want = action.get("task")
            if isinstance(want, dict):
                want = want.get("id")
            picked = None
            if want is None:
                if state["pending"]:
                    picked = state["pending"].pop(0)
            else:
                for k, t in enumerate(state["pending"]):
                    if t.get("id") == want:
                        picked = state["pending"].pop(k)
                        break
            if picked is None:
                emit({"type": "action", "index": i, "op": "run",
                      "status": "noop", "reason": "no pending task"})
                # no state change -> no commit; a following crash action is
                # not consumed and will checkpoint the current state itself.
            else:
                # done record is logged (in-memory) before the db commit
                # deletes the task from pending; commit point = rename return.
                state["done"].append(picked)
                commit(db_path, state, crash_stage)
                emit({"type": "action", "index": i, "op": "run",
                      "status": "ok", "id": picked.get("id")})
        elif op == "crash":
            # Unconsumed crash (no preceding committing action): checkpoint
            # the current state and crash at the requested stage.
            stage = validate_stage(action, i)
            commit(db_path, state, stage)
            raise TaskqError(f"action {i}: crash action did not crash")  # unreachable
        elif op is None:
            raise TaskqError(f"action {i}: missing 'op'")
        else:
            raise TaskqError(f"action {i}: unknown op {op!r}")
        i += 1

    summary = {"type": "summary", "pending": state["pending"], "done": state["done"]}
    if out_path is not None:
        write_atomic(out_path, summary)
    emit(summary)
    return state


def write_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def check_invariant(state):
    pend_ids = [t.get("id") for t in state["pending"]]
    done_ids = {t.get("id") for t in state["done"]}
    both = [i for i in pend_ids if i in done_ids]
    if both or len(pend_ids) != len(set(pend_ids)):
        raise TaskqError(
            f"inconsistent db: task id(s) both done and pending or duplicated: {both}"
        )


def recover_db(db_path, emit=print):
    tmp = tmp_path(db_path)
    discarded = False
    if os.path.exists(tmp):
        # tmp exists <=> the rename never completed <=> db was not updated
        # by the interrupted commit: discard the tmp, keep the db.
        os.remove(tmp)
        discarded = True
    state = load_db(db_path)
    check_invariant(state)
    emit({"type": "recover", "discarded_tmp": discarded})
    emit({"type": "summary", "pending": state["pending"], "done": state["done"]})
    return state
