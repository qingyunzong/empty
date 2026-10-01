"""Command line interface: load / run / status.  All errors exit with 7."""

from __future__ import annotations

import json
import os
import sys

from .engine import Executor
from .model import PlanError, load_plan_file

EXIT_ERROR = 7
DEFAULT_STATE_FILE = ".executor_state.json"


def _state_path(args):
    if "--state" in args:
        index = args.index("--state")
        try:
            path = args[index + 1]
        except IndexError:
            raise PlanError("--state requires a path argument")
        del args[index:index + 2]
        return path
    return os.environ.get("EXECUTOR_STATE", DEFAULT_STATE_FILE)


def _load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise PlanError(f"no plan loaded (state file {path!r} not found)")
    except (OSError, json.JSONDecodeError) as exc:
        raise PlanError(f"cannot read state file {path!r}: {exc}")


def _save_state(path, state):
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2)
    except OSError as exc:
        raise PlanError(f"cannot write state file {path!r}: {exc}")


def _cmd_load(args, state_path):
    if len(args) != 1:
        raise PlanError("usage: load <plan.json>")
    root, budget = load_plan_file(args[0])
    with open(args[0], "r", encoding="utf-8") as handle:
        raw_plan = json.load(handle)
    _save_state(state_path, {"plan": raw_plan, "result": None})
    count = _count_actions(root)
    print(json.dumps({"loaded": True, "actions": count, "budget": budget}))
    return 0


def _count_actions(action):
    return 1 + sum(_count_actions(child) for child in action.children)


def _cmd_run(args, state_path):
    if args:
        raise PlanError("usage: run")
    state = _load_state(state_path)
    if state.get("plan") is None:
        raise PlanError("no plan loaded")
    from .model import parse_plan
    root, budget = parse_plan(json.dumps(state["plan"]))
    result = Executor(root, budget).run()
    state["result"] = result.to_dict()
    _save_state(state_path, state)
    print(json.dumps(result.to_dict()))
    return 0


def _cmd_status(args, state_path):
    if args:
        raise PlanError("usage: status")
    state = _load_state(state_path)
    result = state.get("result")
    if result is None:
        print(json.dumps({"status": "loaded", "result": None}))
    else:
        print(json.dumps({"status": "finished", "result": result}))
    return 0


_COMMANDS = {"load": _cmd_load, "run": _cmd_run, "status": _cmd_status}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        state_path = _state_path(argv)
        if not argv or argv[0] not in _COMMANDS:
            raise PlanError(
                "usage: python -m executor [--state PATH] <load PLAN|run|status>"
            )
        command, rest = argv[0], argv[1:]
        return _COMMANDS[command](rest, state_path)
    except PlanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
