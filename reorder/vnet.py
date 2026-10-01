"""Virtual network + exhaustive short-schedule checker.

A schedule is a list of actions:
  ["deliver", i]  - deliver the i-th in-flight frame to the receiver
  ["crash"]       - kill the engine and recover it from its journal

``find_failing_schedule`` enumerates schedules breadth-first (shortest
first), cross-checking the engine's business output against the
independent unbounded ReferenceModel after every action.  The first
mismatch found is therefore already a shortest failing schedule; it is
returned as replayable JSON together with both outputs.
"""
from __future__ import annotations

import os
import tempfile
from collections import deque

from .engine import Engine
from .messages import Frame
from .refmodel import ReferenceModel


class VirtualNetwork:
    """Holds frames in flight; delivery order is chosen by the schedule."""

    def __init__(self):
        self.inflight: list[Frame] = []

    def inject(self, frame: Frame, copies: int = 1) -> None:
        for _ in range(copies):
            self.inflight.append(frame)

    def clone(self) -> "VirtualNetwork":
        dup = VirtualNetwork()
        dup.inflight = list(self.inflight)
        return dup


def run_schedule(schedule: list, frames: list[tuple[Frame, int]],
                 modulus: int, window: int, journal_dir: str,
                 engine_factory=None):
    """Replay one schedule; return (engine_output, reference_output)."""
    factory = engine_factory or (lambda: Engine(
        modulus, window,
        journal_path=os.path.join(journal_dir, "wal.jsonl"), sync=False))
    engine = factory()
    reference = ReferenceModel(modulus, window)
    net = VirtualNetwork()
    for frame, copies in frames:
        net.inject(frame, copies)
    engine_out: list[dict] = []
    reference_out: list[dict] = []
    for action in schedule:
        if action[0] == "deliver":
            frame = net.inflight.pop(action[1])
            engine.receive(frame)
            reference.receive(frame)
        elif action[0] == "crash":
            engine.crash()
            engine.recover()
            reference.crash()
        else:
            raise ValueError(f"unknown action {action!r}")
        engine_out.extend(engine.poll())
        reference_out.extend(reference.poll())
    return engine_out, reference_out


def _outputs_equal(engine_out: list[dict], reference_out: list[dict]) -> bool:
    def norm(records):
        return [(r["stream_id"], r["epoch"], r["seq"], r["kind"], r["content"])
                for r in records]
    return norm(engine_out) == norm(reference_out)


def find_failing_schedule(frames: list[tuple[Frame, int]], modulus: int,
                          window: int, max_depth: int,
                          allow_crash: bool = True,
                          engine_factory=None) -> dict | None:
    """BFS over short schedules; returns the shortest failing one, or None."""
    queue = deque([[]])
    while queue:
        schedule = queue.popleft()
        with tempfile.TemporaryDirectory() as tmp:
            engine_out, reference_out = run_schedule(
                schedule, frames, modulus, window, tmp, engine_factory)
        if not _outputs_equal(engine_out, reference_out):
            return {
                "schedule": [list(a) for a in schedule],
                "engine_output": engine_out,
                "reference_output": reference_out,
            }
        if len(schedule) >= max_depth:
            continue
        # Recompute the in-flight set after this prefix to enumerate actions.
        inflight = list(range(sum(c for _, c in frames)))
        for action in schedule:
            if action[0] == "deliver":
                inflight.pop(action[1])
        for index in range(len(inflight)):
            queue.append(schedule + [["deliver", index]])
        if allow_crash and (not schedule or schedule[-1][0] != "crash"):
            queue.append(schedule + [["crash"]])
    return None


def minimize_schedule(schedule: list, is_failure) -> list:
    """Greedy 1-minimization: drop any action while the failure persists."""
    minimized = list(schedule)
    changed = True
    while changed:
        changed = False
        for i in range(len(minimized)):
            candidate = minimized[:i] + minimized[i + 1:]
            if candidate and is_failure(candidate):
                minimized = candidate
                changed = True
                break
    return minimized
