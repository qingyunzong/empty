"""Focused behavioral checks for the B delivery artifact."""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.getcwd())

from msdeliv.engine import DeliveryEngine
from msdeliv.frames import Frame, content_hash, message_frames
from msdeliv.log import DurableLog


def check_hash():
    with tempfile.TemporaryDirectory() as directory:
        log = DurableLog(str(Path(directory) / "events.jsonl"))
        try:
            engine = DeliveryEngine(log=log)
            original = message_frames("s", 0, 0, "original")[0]
            altered = Frame(original.stream, original.epoch, original.seq,
                            original.frag, original.frags, "changed",
                            original.hash, original.close)
            status = engine.offer(altered)["status"]
            outputs = engine.poll()
            mismatch = (len(outputs) == 1 and
                        content_hash(outputs[0]["content"]) != outputs[0]["hash"])
            if status != "accepted" or not mismatch or outputs[0]["content"] != "changed":
                raise AssertionError(f"hash flaw not reproduced: {status=}, {outputs=}")
            print(f"received={status} delivered={outputs[0]['content']} hash_valid={not mismatch}")
        finally:
            log.close()


def check_recovery():
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "events.jsonl")
        log = DurableLog(path)
        try:
            engine = DeliveryEngine(log=log)
            first = message_frames("s", 0, 0, "original")[0]
            changed = message_frames("s", 0, 0, "changed")[0]
            engine.offer(first)
            delivered = engine.poll()
            before = engine.offer(changed)["status"]
            before_count = len(engine.evidence())
        finally:
            log.close()
        recovered = DeliveryEngine.recover(path)
        try:
            after = recovered.offer(changed)["status"]
            after_count = len(recovered.evidence())
            if (len(delivered) != 1 or before != "conflict" or
                    before_count != 1 or after != "old" or after_count != 0):
                raise AssertionError("recovery flaw not reproduced: "
                                     f"{before=}, {before_count=}, {after=}, {after_count=}")
            print(f"before={before} evidence={before_count}; "
                  f"after_recovery={after} evidence={after_count}")
        finally:
            recovered.log.close()


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"hash", "recovery"}:
        raise SystemExit("usage: probe.py hash|recovery")
    {"hash": check_hash, "recovery": check_recovery}[sys.argv[1]]()
