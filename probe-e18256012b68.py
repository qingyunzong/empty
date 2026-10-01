"""Independent, bounded behavior probes for the delivered si package."""

import json
import os
import subprocess
import sys
import threading

sys.path.insert(0, os.getcwd())
from si.engine import Engine


def cli(commands):
    result = subprocess.run(
        [sys.executable, "-m", "si"],
        input="".join(json.dumps(command) + "\n" for command in commands),
        text=True,
        capture_output=True,
        timeout=3,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert result.returncode == 0, result.stderr
    responses = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(responses) == len(commands), (responses, result.stderr)
    return responses


def paused_commit(check):
    engine = Engine()
    engine.begin("reader")
    engine.begin("writer")
    engine.write("writer", "x", 1)
    entered = threading.Event()
    release = threading.Event()

    class PausingList(list):
        def append(self, item):
            entered.set()
            assert release.wait(2), "commit pause timed out"
            super().append(item)

    engine._versions["x"] = PausingList()
    errors = []

    def commit():
        try:
            engine.commit("writer")
        except Exception as exc:
            errors.append(exc)

    worker = threading.Thread(target=commit)
    worker.start()
    try:
        assert entered.wait(1), "commit did not reach version append"
        check(engine)
    finally:
        release.set()
        worker.join(2)
    assert not worker.is_alive(), "commit did not finish"
    assert not errors, errors


def read_blocks():
    def check(engine):
        started = threading.Event()
        done = threading.Event()
        outcome = {}

        def read():
            started.set()
            try:
                outcome["value"] = engine.read("reader", "x")
            except Exception as exc:
                outcome["error"] = repr(exc)
            done.set()

        thread = threading.Thread(target=read)
        thread.start()
        assert started.wait(1), "read did not start"
        waited = not done.wait(0.15)
        print(f"read_waited_during_commit={waited}")
        assert waited, "read completed while commit was paused"
        outcome["done"] = done
        outcome["thread"] = thread
        check.outcome = outcome

    paused_commit(check)
    outcome = check.outcome
    assert outcome["done"].wait(1), "read did not finish after commit"
    outcome["thread"].join(1)
    assert outcome.get("value") is None and "error" not in outcome, outcome
    print("snapshot_read_after_commit=null")


def null_dump():
    responses = cli([
        {"cmd": "begin", "txn": "t"},
        {"cmd": "write", "txn": "t", "key": "nullable", "value": None},
        {"cmd": "commit", "txn": "t"},
        {"cmd": "dump"},
    ])
    assert responses[1].get("ok") is True and responses[2].get("ok") is True, responses
    state = responses[3].get("state")
    print("dump_state=" + json.dumps(state, sort_keys=True))
    assert state == {}, responses[3]


def missing_value():
    responses = cli([
        {"cmd": "begin", "txn": "t"},
        {"cmd": "write", "txn": "t", "key": "x"},
        {"cmd": "commit", "txn": "t"},
        {"cmd": "dump"},
    ])
    print("missing_value_write=" + json.dumps(responses[1], sort_keys=True))
    assert responses[1] == {"ok": True}, responses[1]
    assert responses[2].get("ok") is True and responses[3].get("state") == {}, responses


def abort_after_conflict():
    responses = cli([
        {"cmd": "begin", "txn": "a"},
        {"cmd": "begin", "txn": "b"},
        {"cmd": "write", "txn": "a", "key": "x", "value": 1},
        {"cmd": "write", "txn": "b", "key": "x", "value": 2},
        {"cmd": "commit", "txn": "a"},
        {"cmd": "commit", "txn": "b"},
        {"cmd": "abort", "txn": "b"},
        {"cmd": "begin", "txn": "retry"},
        {"cmd": "write", "txn": "retry", "key": "x", "value": 2},
        {"cmd": "commit", "txn": "retry"},
        {"cmd": "dump"},
    ])
    conflict = responses[5].get("error")
    abort = responses[6].get("error")
    state = responses[10].get("state")
    print(f"conflict={conflict} abort={abort} retry_state={json.dumps(state, sort_keys=True)}")
    assert (conflict, abort, state) == ("WRITE_CONFLICT", "UNKNOWN_TXN", {"x": 2}), responses


def consistent_snapshot():
    engine = Engine()
    engine.begin("writer")
    engine.write("writer", "x", 1)
    engine.write("writer", "y", 2)
    entered = threading.Event()
    release = threading.Event()

    class PausingList(list):
        def append(self, item):
            entered.set()
            assert release.wait(2), "commit pause timed out"
            super().append(item)

    engine._versions["y"] = PausingList()
    errors = []

    def commit():
        try:
            engine.commit("writer")
        except Exception as exc:
            errors.append(exc)

    writer = threading.Thread(target=commit)
    writer.start()
    try:
        assert entered.wait(1), "commit did not reach second key"
        started = threading.Event()
        done = threading.Event()
        result = {}

        def snapshot():
            started.set()
            try:
                engine.begin("reader")
                result["values"] = [engine.read("reader", key) for key in ("x", "y")]
            except Exception as exc:
                result["error"] = repr(exc)
            done.set()

        reader = threading.Thread(target=snapshot)
        reader.start()
        assert started.wait(1), "begin did not start"
        assert not done.wait(0.05), "begin completed inside a paused commit"
    finally:
        release.set()
        writer.join(2)
    assert done.wait(1), "snapshot did not finish"
    reader.join(1)
    assert not errors and result.get("values") == [1, 2], (errors, result)
    print("new_snapshot_values=" + json.dumps(result["values"]))


if __name__ == "__main__":
    cases = {
        "read_blocks": read_blocks,
        "null_dump": null_dump,
        "missing_value": missing_value,
        "abort_after_conflict": abort_after_conflict,
        "consistent_snapshot": consistent_snapshot,
    }
    cases[sys.argv[1]]()
