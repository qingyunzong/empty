"""Independent, bounded behavior checks for the delivered SI engine."""

import json
import os
import sys
import threading

sys.path.insert(0, os.getcwd())

from si.engine import Engine, UnknownTransaction, WriteConflict


def report(name, **values):
    print(json.dumps({"check": name, **values}, ensure_ascii=False, sort_keys=True))


def partial_snapshot():
    reached = threading.Event()
    release = threading.Event()

    class PausingDict(dict):
        def setdefault(self, key, default=None):
            if key == "y":
                reached.set()
                if not release.wait(2):
                    raise TimeoutError("commit pause timed out")
            return super().setdefault(key, default)

    engine = Engine()
    engine._data = PausingDict()
    engine.begin("writer")
    engine.write("writer", "x", 1)
    engine.write("writer", "y", 2)
    errors = []
    observed = {}

    def commit():
        try:
            engine.commit("writer")
        except Exception as exc:
            errors.append(type(exc).__name__)

    def inspect():
        try:
            engine.begin("reader")
            observed["x"] = engine.read("reader", "x")
            observed["y"] = engine.read("reader", "y")
        except Exception as exc:
            errors.append(type(exc).__name__)

    writer = threading.Thread(target=commit, daemon=True)
    reader = threading.Thread(target=inspect, daemon=True)
    writer.start()
    if not reached.wait(1):
        release.set()
        writer.join(2)
        report("partial_snapshot", error="writer did not reach second key")
        return 1
    reader.start()
    reader.join(0.4)
    during_pause = not reader.is_alive()
    release.set()
    writer.join(2)
    reader.join(2)
    final = engine.snapshot_state()
    reproduced = (during_pause and not errors and not writer.is_alive()
                  and not reader.is_alive() and observed == {"x": 1, "y": None}
                  and final == {"x": 1, "y": 2})
    report("partial_snapshot", reproduced=reproduced, observed=observed,
           final=final, errors=errors)
    return 0 if reproduced else 1


def abort_after_conflict():
    engine = Engine()
    engine.begin("first")
    engine.begin("second")
    engine.write("first", "key", 1)
    engine.write("second", "key", 2)
    engine.commit("first")
    try:
        engine.commit("second")
    except WriteConflict:
        conflict = "WRITE_CONFLICT"
    else:
        conflict = "unexpected success"
    try:
        engine.abort("second")
    except UnknownTransaction:
        abort = "UNKNOWN_TXN"
    else:
        abort = "ok"
    engine.begin("retry")
    engine.write("retry", "key", 3)
    engine.commit("retry")
    final = engine.snapshot_state()
    reproduced = conflict == "WRITE_CONFLICT" and abort == "UNKNOWN_TXN" and final == {"key": 3}
    report("abort_after_conflict", reproduced=reproduced, conflict=conflict,
           abort=abort, retry_state=final)
    return 0 if reproduced else 1


if __name__ == "__main__":
    checks = {"partial_snapshot": partial_snapshot,
              "abort_after_conflict": abort_after_conflict}
    if len(sys.argv) != 2 or sys.argv[1] not in checks:
        raise SystemExit("usage: probe.py partial_snapshot|abort_after_conflict")
    raise SystemExit(checks[sys.argv[1]]())
