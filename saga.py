#!/usr/bin/env python3
"""Saga orchestrator CLI.

A saga is defined in JSON as an ordered list of steps; each step has a
commit action and a compensate action. Instances persist their state to
disk after every event so a crashed process can be resumed with `recover`.

Commands: new, run, cancel, recover, state.
States:   RUNNING, CANCELING, CANCELED, COMPLETED, FAILED.

Semantics:
  * `cancel` persists a cancel request; a running saga observes it at step
    boundaries (cooperative checkpoints).
  * On cancellation, committed steps are compensated in reverse order and
    unstarted steps never execute.
  * `cancel` after COMPLETED exits with code 9 and leaves state unchanged.
  * Crash points are limited to: after step events, after actions, after
    compensation events. `recover` resumes the run or the cancellation
    without losing the persisted cancel flag.
  * Actions are idempotent, keyed by (request_key, step_name, action_kind).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CRASH = 3  # simulated crash (test hook only)
EXIT_CONFLICT = 9  # cancel after COMPLETED

RUNNING = "RUNNING"
CANCELING = "CANCELING"
CANCELED = "CANCELED"
COMPLETED = "COMPLETED"
FAILED = "FAILED"

STATES = (RUNNING, CANCELING, CANCELED, COMPLETED, FAILED)


class SagaError(Exception):
    pass


class CrashInjector:
    """Simulates a hard crash right after a matching event is persisted.

    Spec format: "<event_type>:<step>" or "<event_type>:<step>:<kind>".
    Only the allowed crash points may be targeted: step events
    (step_started / step_committed), actions (action), and compensation
    events (compensation_started / step_compensated).
    """

    ALLOWED = {
        "step_started",
        "step_committed",
        "action",
        "compensation_started",
        "step_compensated",
    }

    def __init__(self, spec: str | None):
        self.spec = spec
        if spec:
            event_type = spec.split(":")[0]
            if event_type not in self.ALLOWED:
                raise SagaError(
                    f"crash point {spec!r} is not an allowed crash point "
                    f"(allowed: {sorted(self.ALLOWED)})"
                )

    def matches(self, event: dict) -> bool:
        if not self.spec:
            return False
        parts = [
            event["type"],
            event.get("step") or "",
            event.get("action_kind") or "",
        ]
        spec_parts = self.spec.split(":")
        return parts[: len(spec_parts)] == spec_parts


class Saga:
    def __init__(self, state_dir: str, state: dict):
        self.state_dir = state_dir
        self.state = state

    # -- persistence -----------------------------------------------------

    @staticmethod
    def path(state_dir: str, saga_id: str) -> str:
        return os.path.join(state_dir, f"{saga_id}.json")

    @classmethod
    def load(cls, state_dir: str, saga_id: str) -> "Saga":
        path = cls.path(state_dir, saga_id)
        if not os.path.exists(path):
            raise SagaError(f"saga {saga_id!r} not found in {state_dir!r}")
        with open(path, "r", encoding="utf-8") as fh:
            return cls(state_dir, json.load(fh))

    def save(self) -> None:
        os.makedirs(self.state_dir, exist_ok=True)
        path = self.path(self.state_dir, self.state["id"])
        fd, tmp = tempfile.mkstemp(dir=self.state_dir, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(self.state, fh, indent=2, sort_keys=True)
        os.replace(tmp, path)

    # -- events ------------------------------------------------------------

    def emit(self, crash: CrashInjector | None, event_type: str,
             step: str | None = None, action_kind: str | None = None,
             **extra) -> None:
        event = {"seq": len(self.state["events"]), "type": event_type}
        if step is not None:
            event["step"] = step
        if action_kind is not None:
            event["action_kind"] = action_kind
        event.update(extra)
        self.state["events"].append(event)
        self.save()
        if crash is not None and crash.matches(event):
            # Simulated hard crash: state was persisted, no cleanup.
            os._exit(EXIT_CRASH)

    # -- actions -----------------------------------------------------------

    def perform_action(self, step_name: str, kind: str,
                       action: dict | None) -> bool:
        """Run an action idempotently. Returns True if it was executed."""
        key = f"{self.state['request_key']}:{step_name}:{kind}"
        if key in self.state["action_journal"]:
            return False
        if action:
            self._execute_effect(action)
        self.state["action_journal"].append(key)
        self.state["effects"].append(
            {"key": key, "step": step_name, "kind": kind, "action": action}
        )
        return True

    def _execute_effect(self, action: dict) -> None:
        action_type = action.get("type", "log")
        if action_type == "log":
            return
        if action_type == "write_file":
            with open(action["path"], "w", encoding="utf-8") as fh:
                fh.write(action.get("content", ""))
            return
        if action_type == "fail":
            raise SagaError(f"action failed: {action.get('message', 'fail')}")
        raise SagaError(f"unknown action type: {action_type!r}")


# -- engine -----------------------------------------------------------------


def execute_saga(saga: Saga, crash: CrashInjector | None = None,
                 max_steps: int | None = None) -> None:
    """Run remaining commit actions, or finish an ongoing cancellation."""
    st = saga.state
    if st["state"] in (CANCELED, COMPLETED):
        return
    if st["state"] == FAILED:
        raise SagaError("saga is FAILED")

    steps = st["steps"]
    if st["state"] == RUNNING and not st["cancel_requested"]:
        taken = 0
        while st["current_step"] < len(steps):
            # Step boundary: cooperative cancellation checkpoint.
            if st["cancel_requested"]:
                break
            if max_steps is not None and taken >= max_steps:
                return  # clean pause, still RUNNING
            step = steps[st["current_step"]]
            name = step["name"]
            saga.emit(crash, "step_started", step=name)
            try:
                performed = saga.perform_action(name, "commit",
                                                step.get("commit"))
            except SagaError as exc:
                st["state"] = FAILED
                saga.emit(crash, "state_changed", state=FAILED,
                          error=str(exc))
                raise
            if performed:
                saga.emit(crash, "action", step=name, action_kind="commit")
            if name not in st["completed_steps"]:
                st["completed_steps"].append(name)
            st["current_step"] += 1
            saga.emit(crash, "step_committed", step=name)
            taken += 1
        if not st["cancel_requested"] and st["current_step"] >= len(steps):
            st["state"] = COMPLETED
            saga.emit(crash, "state_changed", state=COMPLETED)
            return

    if st["cancel_requested"] or st["state"] == CANCELING:
        cancel_saga(saga, crash)


def cancel_saga(saga: Saga, crash: CrashInjector | None = None) -> None:
    """Compensate committed steps in reverse order, then mark CANCELED."""
    st = saga.state
    if st["state"] == CANCELED:
        return
    st["cancel_requested"] = True
    if st["state"] != CANCELING:
        st["state"] = CANCELING
        saga.emit(crash, "state_changed", state=CANCELING)
    steps_by_name = {s["name"]: s for s in st["steps"]}
    pending = [name for name in reversed(st["completed_steps"])
               if name not in st["compensated_steps"]]
    for name in pending:
        saga.emit(crash, "compensation_started", step=name)
        performed = saga.perform_action(
            name, "compensate", steps_by_name[name].get("compensate"))
        if performed:
            saga.emit(crash, "action", step=name, action_kind="compensate")
        st["compensated_steps"].append(name)
        saga.emit(crash, "step_compensated", step=name)
    st["state"] = CANCELED
    saga.emit(crash, "state_changed", state=CANCELED)


# -- commands ----------------------------------------------------------------


def cmd_new(args) -> int:
    with open(args.definition, "r", encoding="utf-8") as fh:
        definition = json.load(fh)
    steps = definition.get("steps", [])
    names = [s["name"] for s in steps]
    if len(names) != len(set(names)):
        raise SagaError("step names must be unique")
    path = Saga.path(args.state_dir, args.id)
    if os.path.exists(path):
        raise SagaError(f"saga {args.id!r} already exists")
    state = {
        "id": args.id,
        "name": definition.get("name", args.id),
        "request_key": args.key or args.id,
        "state": RUNNING,
        "cancel_requested": False,
        "current_step": 0,
        "completed_steps": [],
        "compensated_steps": [],
        "action_journal": [],
        "effects": [],
        "events": [],
        "steps": steps,
    }
    Saga(args.state_dir, state).save()
    print(f"created saga {args.id} (RUNNING, {len(steps)} steps)")
    return EXIT_OK


def cmd_run(args) -> int:
    saga = Saga.load(args.state_dir, args.id)
    execute_saga(saga, CrashInjector(args.crash_after),
                 max_steps=args.stop_after)
    print(f"saga {args.id}: {saga.state['state']}")
    return EXIT_OK


def cmd_cancel(args) -> int:
    saga = Saga.load(args.state_dir, args.id)
    st = saga.state
    if st["state"] == COMPLETED:
        print(f"saga {args.id}: cannot cancel, already COMPLETED",
              file=sys.stderr)
        return EXIT_CONFLICT
    if st["state"] == FAILED:
        print(f"saga {args.id}: cannot cancel, saga is FAILED",
              file=sys.stderr)
        return EXIT_ERROR
    if st["state"] == CANCELED:
        print(f"saga {args.id}: already CANCELED (idempotent no-op)")
        return EXIT_OK
    st["cancel_requested"] = True
    saga.save()  # persist the cancel request before acting on it
    cancel_saga(saga, CrashInjector(args.crash_after))
    print(f"saga {args.id}: {saga.state['state']}")
    return EXIT_OK


def cmd_recover(args) -> int:
    saga = Saga.load(args.state_dir, args.id)
    st = saga.state
    if st["state"] == RUNNING:
        execute_saga(saga)
    elif st["state"] == CANCELING:
        cancel_saga(saga)
    print(f"saga {args.id}: {saga.state['state']}")
    return EXIT_OK


def cmd_state(args) -> int:
    saga = Saga.load(args.state_dir, args.id)
    st = saga.state
    pending = [name for name in reversed(st["completed_steps"])
               if name not in st["compensated_steps"]]
    summary = {
        "id": st["id"],
        "state": st["state"],
        "cancel_requested": st["cancel_requested"],
        "current_step": st["current_step"],
        "completed_steps": st["completed_steps"],
        "compensated_steps": st["compensated_steps"],
        "pending_compensation": pending,
        "action_journal": st["action_journal"],
        "effects": st["effects"],
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="saga", description=__doc__)
    parser.add_argument("--state-dir", default=os.environ.get(
        "SAGA_STATE_DIR", ".saga"))
    sub = parser.add_subparsers(dest="command", required=True)

    p_new = sub.add_parser("new", help="create a saga from a JSON definition")
    p_new.add_argument("definition")
    p_new.add_argument("--id", required=True)
    p_new.add_argument("--key", default=None,
                       help="request key for action idempotency")
    p_new.set_defaults(func=cmd_new)

    p_run = sub.add_parser("run", help="execute remaining steps")
    p_run.add_argument("--id", required=True)
    p_run.add_argument("--stop-after", type=int, default=None,
                       help="pause cleanly after N more steps (still RUNNING)")
    p_run.add_argument("--crash-after", default=None,
                       help="simulate a crash after the matching event")
    p_run.set_defaults(func=cmd_run)

    p_cancel = sub.add_parser("cancel", help="request cancellation")
    p_cancel.add_argument("--id", required=True)
    p_cancel.add_argument("--crash-after", default=None,
                          help="simulate a crash after the matching event")
    p_cancel.set_defaults(func=cmd_cancel)

    p_recover = sub.add_parser("recover",
                               help="resume a run or cancellation")
    p_recover.add_argument("--id", required=True)
    p_recover.set_defaults(func=cmd_recover)

    p_state = sub.add_parser("state", help="print saga state as JSON")
    p_state.add_argument("--id", required=True)
    p_state.set_defaults(func=cmd_state)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except SagaError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
