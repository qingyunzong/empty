"""Focused behavioral checks for the submitted ordered-delivery engine."""

import argparse
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.getcwd())

from reorder.engine import Engine
from reorder.messages import make_message_frames


def acked_conflict() -> None:
    with tempfile.TemporaryDirectory() as directory:
        engine = Engine(journal_path=str(Path(directory) / "journal.jsonl"))
        try:
            original = make_message_frames("s", 0, 0, "original")[0]
            changed = make_message_frames("s", 0, 0, "changed")[0]
            assert original.content_hash != changed.content_hash
            first = engine.receive(original)["status"]
            retry = engine.receive(changed)["status"]
            evidence = len(engine.conflicts())
            assert first == "complete", f"initial receive: {first}"
            assert retry == "dup" and evidence == 0, (
                f"defect not reproduced: retry={retry}, evidence={evidence}"
            )
            print(f"initial={first} conflicting_retransmit={retry} conflict_evidence={evidence}")
        finally:
            engine.close()


def late_epoch() -> None:
    with tempfile.TemporaryDirectory() as directory:
        engine = Engine(journal_path=str(Path(directory) / "journal.jsonl"))
        try:
            old = engine.receive(make_message_frames("s", 0, 0, "old")[0])["status"]
            new = engine.receive(make_message_frames("s", 1, 0, "new")[0])["status"]
            late = engine.receive(make_message_frames("s", 0, 1, "late")[0])["status"]
            assert old == "complete" and new == "complete", (
                f"setup failed: old={old}, new={new}"
            )
            assert late == "complete", f"defect not reproduced: late={late}"
            print(f"old_epoch={old} new_epoch={new} late_old_epoch={late}")
        finally:
            engine.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("case", choices=("acked-conflict", "late-epoch"))
    args = parser.parse_args()
    {"acked-conflict": acked_conflict, "late-epoch": late_epoch}[args.case]()
