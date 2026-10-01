"""One-shot fault injection driven by a JSON spec.

Spec format (faults.json):
    {"append_before": 3, "fsync_fail": [5], "crash_after_commit": 7}

Each fault point maps to a step index (or list of indices). A fault
fires at most once; after firing it is disabled.
"""

from .errors import CrashSimulation, StorageError

FAULT_POINTS = ("append_before", "append_after", "fsync_fail", "crash_after_commit")


class FaultInjector:
    def __init__(self, spec=None):
        self._armed = {}
        for name, steps in (spec or {}).items():
            if name not in FAULT_POINTS:
                raise ValueError(f"unknown fault point: {name!r}")
            if isinstance(steps, int):
                steps = [steps]
            self._armed[name] = list(steps)
        self.step = -1

    def check(self, point):
        """Raise the injected fault if `point` is armed for the current step."""
        steps = self._armed.get(point)
        if not steps or self.step not in steps:
            return
        steps.remove(self.step)  # one-shot: disable after firing
        if point == "crash_after_commit":
            raise CrashSimulation(f"injected crash after commit at step {self.step}")
        raise StorageError(f"injected fault {point} at step {self.step}")
