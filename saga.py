#!/usr/bin/env python3
"""Saga orchestration CLI.

A saga is defined by a JSON file with ordered steps; each step has a commit
action and a compensate action. State is persisted to a JSON state file so
that crashes (at well-defined points) can be recovered without losing the
cancel flag or re-executing actions.

Commands: new, run, cancel, recover, state.
States:   RUNNING, CANCELING, CANCELED, COMPLETED, FAILED.

Exit codes:
  0  success
  2  usage / saga error
  9  conflict (e.g. cancel after COMPLETED); state is left unchanged
  99 simulated crash (only when SAGA_CRASH_AFTER is set)

Crash injection (for testing recovery): set SAGA_CRASH_AFTER to a
comma-separated list of tokens. Crash points are limited to:
  event:<name>            after a step/compensation event is persisted
                          (step_started:X, step_committed:X, compensated:X)
  action:commit:X         after step X's commit action is persisted
  action:compensate:X     after step X's compensate action is persisted
"""
import argparse
import json
import os
import sys
import tempfile

EXIT_OK = 0
EXIT_ERROR = 2
EXIT_CONFLICT = 9
EXIT_CRASH = 99


class Status:
    RUNNING = "RUNNING"
    CANCELING = "CANCELING"
    CANCELED = "CANCELED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


TERMINAL_STATES = (Status.CANCELED, Status.COMPLETED, Status.FAILED)


class SagaError(Exception):
    pass


class ActionFailed(Exception):
    pass


# ---------------------------------------------------------------- persistence

def state_path(state_dir, saga_id):
    return os.path.join(state_dir, saga_id + ".json")


def effects_path(state_dir, saga_id):
    return os.path.join(state_dir, saga_id + ".effects.log")


def load_state(state_dir, saga_id):
    path = state_path(state_dir, saga_id)
    if not os.path.exists(path):
        raise SagaError("saga not found: %s" % saga_id)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_state(state_dir, state):
    os.makedirs(state_dir, exist_ok=True)
    path = state_path(state_dir, state["id"])
    fd, tmp = tempfile.mkstemp(dir=state_dir, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ------------------------------------------------------------------- crashing

def _crash_tokens():
    raw = os.environ.get("SAGA_CRASH_AFTER", "")
    return set(token for token in raw.split(",") if token)


def maybe_crash(token):
    if token in _crash_tokens():
        print("simulated crash at %s" % token, file=sys.stderr, flush=True)
        os._exit(EXIT_CRASH)


# --------------------------------------------------------------------- engine

def emit_event(state_dir, state, name):
    """Persist a lifecycle event, then hit a potential crash point."""
    state["events"].append(name)
    save_state(state_dir, state)
    maybe_crash("event:%s" % name)


def execute_action(state_dir, state, step, action_type):
    """Execute a step action idempotently, keyed by request key + step name."""
    step_name = step["name"]
    ledger_key = "%s:%s:%s" % (state["request_key"], step_name, action_type)
    if ledger_key in state["action_ledger"]:
        return  # already executed for this request key and step: skip
    spec = step.get(action_type) or {"op": "log"}
    op = spec.get("op", "log")
    if op == "fail":
        raise ActionFailed("action failed: %s:%s" % (step_name, action_type))
    if op != "log":
        raise SagaError("unknown action op: %r" % op)
    with open(effects_path(state_dir, state["id"]), "a", encoding="utf-8") as fh:
        fh.write("%s %s %s\n" % (state["request_key"], step_name, action_type))
    state["action_ledger"].append(ledger_key)
    save_state(state_dir, state)
    maybe_crash("action:%s:%s" % (action_type, step_name))


def compensate_all(state_dir, state):
    """Compensate committed steps in reverse order, then mark CANCELED."""
    state["status"] = Status.CANCELING
    save_state(state_dir, state)
    steps_by_name = {s["name"]: s for s in state["steps"]}
    for name in reversed(state["completed_steps"]):
        if name in state["compensated_steps"]:
            continue
        try:
            execute_action(state_dir, state, steps_by_name[name], "compensate")
        except ActionFailed as exc:
            state["status"] = Status.FAILED
            state["error"] = str(exc)
            save_state(state_dir, state)
            raise
        state["compensated_steps"].append(name)
        emit_event(state_dir, state, "compensated:%s" % name)
    state["status"] = Status.CANCELED
    save_state(state_dir, state)


def continue_run(state_dir, state):
    """Execute remaining steps, observing cancel at each step boundary."""
    steps = state["steps"]
    while state["current_step_index"] < len(steps):
        if state["cancel_requested"]:
            compensate_all(state_dir, state)
            return
        step = steps[state["current_step_index"]]
        emit_event(state_dir, state, "step_started:%s" % step["name"])
        try:
            execute_action(state_dir, state, step, "commit")
        except ActionFailed as exc:
            state["status"] = Status.FAILED
            state["error"] = str(exc)
            save_state(state_dir, state)
            raise
        state["completed_steps"].append(step["name"])
        state["current_step_index"] += 1
        emit_event(state_dir, state, "step_committed:%s" % step["name"])
    if state["cancel_requested"]:
        compensate_all(state_dir, state)
        return
    state["status"] = Status.COMPLETED
    save_state(state_dir, state)


# ------------------------------------------------------------------ commands

def cmd_new(args):
    path = state_path(args.state_dir, args.id)
    if os.path.exists(path):
        existing = load_state(args.state_dir, args.id)
        if existing["request_key"] == args.key:
            print("saga %s already exists (id=%s, key=%s)"
                  % (args.id, args.id, args.key))
            return EXIT_OK
        raise SagaError("saga %s already exists with a different request key"
                        % args.id)
    with open(args.definition, "r", encoding="utf-8") as fh:
        definition = json.load(fh)
    steps = definition.get("steps")
    if not isinstance(steps, list) or not steps:
        raise SagaError("definition must contain a non-empty 'steps' list")
    names = [s.get("name") for s in steps]
    if any(not n for n in names) or len(set(names)) != len(names):
        raise SagaError("step names must be non-empty and unique")
    state = {
        "id": args.id,
        "request_key": args.key,
        "status": Status.RUNNING,
        "cancel_requested": False,
        "current_step_index": 0,
        "completed_steps": [],
        "compensated_steps": [],
        "steps": steps,
        "events": [],
        "action_ledger": [],
    }
    save_state(args.state_dir, state)
    print("created saga %s (status=%s, steps=%d)"
          % (args.id, Status.RUNNING, len(steps)))
    return EXIT_OK


def cmd_run(args):
    state = load_state(args.state_dir, args.id)
    if state["status"] in TERMINAL_STATES:
        print("saga %s is %s; nothing to run" % (args.id, state["status"]))
        return EXIT_OK
    if state["status"] == Status.CANCELING or state["cancel_requested"]:
        compensate_all(args.state_dir, state)
    else:
        continue_run(args.state_dir, state)
    print("saga %s -> %s" % (args.id, load_state(args.state_dir, args.id)["status"]))
    return EXIT_OK


def cmd_cancel(args):
    state = load_state(args.state_dir, args.id)
    if state["status"] == Status.COMPLETED:
        print("conflict: saga %s is COMPLETED; cancel rejected" % args.id,
              file=sys.stderr)
        return EXIT_CONFLICT
    if state["status"] == Status.CANCELED:
        print("saga %s is already CANCELED" % args.id)
        return EXIT_OK
    # Persist the cancel request first so it survives a crash.
    state["cancel_requested"] = True
    save_state(args.state_dir, state)
    compensate_all(args.state_dir, state)
    print("saga %s -> CANCELED" % args.id)
    return EXIT_OK


def cmd_recover(args):
    state = load_state(args.state_dir, args.id)
    if state["status"] in TERMINAL_STATES:
        print("saga %s is %s; nothing to recover" % (args.id, state["status"]))
        return EXIT_OK
    if state["status"] == Status.CANCELING or state["cancel_requested"]:
        compensate_all(args.state_dir, state)
    else:
        continue_run(args.state_dir, state)
    print("saga %s recovered -> %s"
          % (args.id, load_state(args.state_dir, args.id)["status"]))
    return EXIT_OK


def cmd_state(args):
    state = load_state(args.state_dir, args.id)
    pending = [n for n in reversed(state["completed_steps"])
               if n not in state["compensated_steps"]]
    summary = {
        "id": state["id"],
        "status": state["status"],
        "cancel_requested": state["cancel_requested"],
        "completed_steps": state["completed_steps"],
        "compensated_steps": state["compensated_steps"],
        "pending_compensations": pending,
        "current_step_index": state["current_step_index"],
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return EXIT_OK


# ----------------------------------------------------------------------- main

def build_parser():
    parser = argparse.ArgumentParser(prog="saga", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("--state-dir", default=".saga")
        p.add_argument("--id", required=True, help="saga id")

    p_new = sub.add_parser("new", help="create a saga from a JSON definition")
    common(p_new)
    p_new.add_argument("--def", dest="definition", required=True,
                       help="path to JSON step definition")
    p_new.add_argument("--key", required=True, help="idempotency request key")
    p_new.set_defaults(func=cmd_new)

    for name, func, help_text in (
        ("run", cmd_run, "execute remaining steps"),
        ("cancel", cmd_cancel, "request cancellation and compensate"),
        ("recover", cmd_recover, "resume after a crash"),
        ("state", cmd_state, "print saga state summary"),
    ):
        p = sub.add_parser(name, help=help_text)
        common(p)
        p.set_defaults(func=func)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (SagaError, ActionFailed) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
