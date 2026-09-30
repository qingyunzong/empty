"""Acceptance tests with inline per-record reference enumerations."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jsonl_processor import core  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]

NORMAL_RECORDS = [
    {"id": "rec-00", "name": "alpha"},
    {"id": "rec-01", "name": "bravo"},
    {"id": "rec-02", "name": "charlie"},
    {"id": "rec-03", "name": "delta"},
    {"id": "rec-04", "name": "echo"},
    {"id": "rec-05", "name": "foxtrot"},
    {"id": "rec-06", "name": "golf"},
    {"id": "rec-07", "name": "hotel-india"},
    {"id": "rec-08", "name": "juliett"},
    {"id": "rec-09", "name": "kilo-名字"},
]

CRASH_RECORDS = NORMAL_RECORDS[:6]
  # 6 records, crash at seq 3


def line_of(record):
    return json.dumps(record, ensure_ascii=False)


def checksum_of(record):
    return f"{zlib.crc32(line_of(record).encode('utf-8')) & 0xFFFFFFFF:08x}"


def expected_output(record, seq):
    return {
        "id": record["id"],
        "name_length": len(record["name"]),
        "checksum": checksum_of(record),
        "seq": seq,
    }


class ProcessorTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.input_path = self.root / "input.jsonl"
        self.workdir = self.root / "work"

    def write_input(self, lines):
        self.input_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")

    def write_records_input(self, records):
        self.write_input([line_of(r) for r in records])

    def read_output(self, record_id):
        return json.loads((self.workdir / "outputs" / f"{record_id}.json").read_text(encoding="utf-8"))

    def output_ids(self):
        outputs = self.workdir / "outputs"
        if not outputs.is_dir():
            return set()
        return {p.name[:-5] for p in outputs.iterdir() if p.suffix == ".json"}

    def checkpoint(self):
        return json.loads((self.workdir / "checkpoint.json").read_text(encoding="utf-8"))["max_seq"]

    def state(self):
        return json.loads((self.workdir / "state.json").read_text(encoding="utf-8"))["state"]

    def statuses(self, results):
        return [(r.seq, r.record_id, r.status) for r in results]

    def assert_reference_outputs(self, records):
        self.assertEqual(self.output_ids(), {r["id"] for r in records})
        for seq, record in enumerate(records):
            self.assertEqual(self.read_output(record["id"]), expected_output(record, seq))

    # 1. Ten normal records: order and content match the inline reference.
    def test_normal_run_ten_records(self):
        self.write_records_input(NORMAL_RECORDS)
        results = core.run(self.input_path, self.workdir)
        expected_statuses = [(i, r["id"], "written") for i, r in enumerate(NORMAL_RECORDS)]
        self.assertEqual(self.statuses(results), expected_statuses)
        self.assertTrue(all(r.attempts == 1 for r in results))
        self.assert_reference_outputs(NORMAL_RECORDS)
        self.assertEqual(self.checkpoint(), 9)
        self.assertEqual(self.state(), core.STATE_COMPLETED)

    # 2a. Crash AFTER_READ: record at crash seq is re-run on recovery.
    def test_crash_after_read_then_recover(self):
        self.write_records_input(CRASH_RECORDS)
        with self.assertRaises(core.SimulatedCrash):
            core.run(self.input_path, self.workdir,
                     crash_point=core.CRASH_AFTER_READ, crash_seq=3)
        self.assertEqual(self.output_ids(), {"rec-00", "rec-01", "rec-02"})
        self.assertEqual(self.checkpoint(), 2)
        self.assertEqual(self.state(), core.STATE_RUNNING)  # stale, as after a real kill

        results = core.run(self.input_path, self.workdir, recover=True)
        expected = [(0, "rec-00", "skipped_checkpoint"),
                    (1, "rec-01", "skipped_checkpoint"),
                    (2, "rec-02", "skipped_checkpoint"),
                    (3, "rec-03", "written"),   # re-run after AFTER_READ crash
                    (4, "rec-04", "written"),
                    (5, "rec-05", "written")]
        self.assertEqual(self.statuses(results), expected)
        self.assert_reference_outputs(CRASH_RECORDS)
        self.assertEqual(self.checkpoint(), 5)
        self.assertEqual(self.state(), core.STATE_COMPLETED)

    # 2b. Crash AFTER_WRITE: existing output is not rewritten on recovery.
    def test_crash_after_write_then_recover(self):
        self.write_records_input(CRASH_RECORDS)
        with self.assertRaises(core.SimulatedCrash):
            core.run(self.input_path, self.workdir,
                     crash_point=core.CRASH_AFTER_WRITE, crash_seq=3)
        self.assertEqual(self.output_ids(), {"rec-00", "rec-01", "rec-02", "rec-03"})
        self.assertEqual(self.checkpoint(), 2)  # checkpoint not yet advanced
        out_path = self.workdir / "outputs" / "rec-03.json"
        inode_before = os.stat(out_path).st_ino
        bytes_before = out_path.read_bytes()

        results = core.run(self.input_path, self.workdir, recover=True)
        expected = [(0, "rec-00", "skipped_checkpoint"),
                    (1, "rec-01", "skipped_checkpoint"),
                    (2, "rec-02", "skipped_checkpoint"),
                    (3, "rec-03", "skipped_existing"),  # not rewritten
                    (4, "rec-04", "written"),
                    (5, "rec-05", "written")]
        self.assertEqual(self.statuses(results), expected)
        self.assertEqual(os.stat(out_path).st_ino, inode_before)  # same file, no os.replace
        self.assertEqual(out_path.read_bytes(), bytes_before)
        self.assert_reference_outputs(CRASH_RECORDS)
        self.assertEqual(self.checkpoint(), 5)
        self.assertEqual(self.state(), core.STATE_COMPLETED)

    # 2c. Crash AFTER_CHECKPOINT: record is skipped via checkpoint on recovery.
    def test_crash_after_checkpoint_then_recover(self):
        self.write_records_input(CRASH_RECORDS)
        with self.assertRaises(core.SimulatedCrash):
            core.run(self.input_path, self.workdir,
                     crash_point=core.CRASH_AFTER_CHECKPOINT, crash_seq=3)
        self.assertEqual(self.output_ids(), {"rec-00", "rec-01", "rec-02", "rec-03"})
        self.assertEqual(self.checkpoint(), 3)

        results = core.run(self.input_path, self.workdir, recover=True)
        expected = [(0, "rec-00", "skipped_checkpoint"),
                    (1, "rec-01", "skipped_checkpoint"),
                    (2, "rec-02", "skipped_checkpoint"),
                    (3, "rec-03", "skipped_checkpoint"),
                    (4, "rec-04", "written"),
                    (5, "rec-05", "written")]
        self.assertEqual(self.statuses(results), expected)
        self.assert_reference_outputs(CRASH_RECORDS)
        self.assertEqual(self.checkpoint(), 5)
        self.assertEqual(self.state(), core.STATE_COMPLETED)

    # 3. Bad record (missing name): retried 3 times, dead-lettered, run continues.
    def test_bad_record_dead_letter_and_continue(self):
        records = [
            {"id": "ok-0", "name": "good-one"},
            {"id": "bad-1"},                      # missing name
            {"id": "ok-2", "name": "good-two"},
            "this is not json",                   # unparseable line
            {"id": "ok-4", "name": "good-three"},
        ]
        self.write_input([line_of(r) if isinstance(r, dict) else r for r in records])
        results = core.run(self.input_path, self.workdir)
        expected = [(0, "ok-0", "written"),
                    (1, "bad-1", "dead_letter"),
                    (2, "ok-2", "written"),
                    (3, None, "dead_letter"),
                    (4, "ok-4", "written")]
        self.assertEqual(self.statuses(results), expected)
        self.assertEqual(results[1].attempts, core.MAX_ATTEMPTS)  # retried 3 times
        self.assertEqual(results[3].attempts, core.MAX_ATTEMPTS)

        dead_path = self.workdir / "dead_letters.jsonl"
        entries = [json.loads(l) for l in dead_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["id"], "bad-1")
        self.assertEqual(entries[0]["reason"], "missing 'name'")
        self.assertEqual(entries[0]["attempts"], core.MAX_ATTEMPTS)
        self.assertEqual(entries[0]["seq"], 1)
        self.assertIsNone(entries[1]["id"])
        self.assertIn("invalid JSON", entries[1]["reason"])

        self.assertEqual(self.output_ids(), {"ok-0", "ok-2", "ok-4"})
        self.assertEqual(self.checkpoint(), 4)
        self.assertEqual(self.state(), core.STATE_COMPLETED)

    # 4. Duplicate id: first wins, later occurrences recorded, no overwrite.
    def test_duplicate_id_not_overwritten(self):
        first = {"id": "dup", "name": "first"}
        second = {"id": "dup", "name": "second-much-longer"}
        third = {"id": "uniq", "name": "unique"}
        self.write_records_input([first, second, third])
        results = core.run(self.input_path, self.workdir)
        expected = [(0, "dup", "written"),
                    (1, "dup", "duplicate"),
                    (2, "uniq", "written")]
        self.assertEqual(self.statuses(results), expected)
        self.assertEqual(self.read_output("dup"), expected_output(first, 0))  # first wins
        self.assertEqual(self.read_output("uniq"), expected_output(third, 2))
        dup_path = self.workdir / "duplicates.jsonl"
        entries = [json.loads(l) for l in dup_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["seq"], 1)
        self.assertEqual(entries[0]["id"], "dup")
        self.assertEqual(self.state(), core.STATE_COMPLETED)

    # 5. Empty input completes cleanly.
    def test_empty_input_completes(self):
        self.write_input([])
        results = core.run(self.input_path, self.workdir)
        self.assertEqual(results, [])
        self.assertEqual(self.output_ids(), set())
        self.assertEqual(self.checkpoint(), -1)
        self.assertEqual(self.state(), core.STATE_COMPLETED)

    # 6. Explicit errors on invalid paths/states.
    def test_explicit_errors(self):
        self.write_records_input(NORMAL_RECORDS[:2])
        with self.assertRaisesRegex(core.ProcessorError, "input file not found"):
            core.run(self.root / "missing.jsonl", self.root / "w1")

        core.run(self.input_path, self.workdir)
        with self.assertRaisesRegex(core.ProcessorError, "already initialized"):
            core.run(self.input_path, self.workdir)  # second process on same workdir
        with self.assertRaisesRegex(core.ProcessorError, "already COMPLETED"):
            core.run(self.input_path, self.workdir, recover=True)
        with self.assertRaisesRegex(core.ProcessorError, "nothing to recover"):
            core.run(self.input_path, self.root / "fresh", recover=True)
        with self.assertRaisesRegex(core.ProcessorError, "unknown crash point"):
            core.run(self.input_path, self.root / "w2", crash_point="NOWHERE", crash_seq=0)
        with self.assertRaisesRegex(core.ProcessorError, "never reached"):
            core.run(self.input_path, self.root / "w3",
                     crash_point=core.CRASH_AFTER_READ, crash_seq=99)
        self.assertEqual(json.loads((self.root / "w3" / "state.json").read_text())["state"],
                         core.STATE_FAILED)

    # 7. Checkpoint inconsistency is detected explicitly during recovery.
    def test_recovery_detects_checkpoint_inconsistency(self):
        self.write_records_input(CRASH_RECORDS)
        with self.assertRaises(core.SimulatedCrash):
            core.run(self.input_path, self.workdir,
                     crash_point=core.CRASH_AFTER_CHECKPOINT, crash_seq=3)
        os.unlink(self.workdir / "outputs" / "rec-01.json")  # tamper with evidence
        with self.assertRaisesRegex(core.ProcessorError, "checkpoint inconsistency"):
            core.run(self.input_path, self.workdir, recover=True)
        self.assertEqual(self.state(), core.STATE_FAILED)

    # 8. CLI end-to-end: process, state, crash, recover, dead-letters.
    def test_cli_end_to_end(self):
        env = dict(os.environ, PYTHONPATH=str(REPO_ROOT))
        records = [{"id": "cli-0", "name": "zero"}, {"id": "cli-1"}, {"id": "cli-2", "name": "two"}]
        self.write_records_input(records)

        def cli(*argv):
            return subprocess.run(
                [sys.executable, "-m", "jsonl_processor", *argv],
                capture_output=True, text=True, env=env, cwd=REPO_ROOT)

        proc = cli("process", "--input", str(self.input_path), "--workdir", str(self.workdir))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = json.loads(proc.stdout)
        self.assertEqual(summary["by_status"], {"written": 2, "dead_letter": 1})

        state = cli("state", "--workdir", str(self.workdir))
        self.assertEqual(json.loads(state.stdout), {"state": "COMPLETED", "max_seq": 2})

        dead = cli("dead-letters", "--workdir", str(self.workdir))
        payload = json.loads(dead.stdout)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["dead_letters"][0]["id"], "cli-1")

        crash_dir = self.root / "crash-work"
        crash = cli("crash", "--at", "AFTER_WRITE", "--seq", "2",
                    "--input", str(self.input_path), "--workdir", str(crash_dir))
        self.assertEqual(crash.returncode, 3, crash.stderr)
        self.assertIn("AFTER_WRITE", crash.stderr)
        self.assertEqual(json.loads((crash_dir / "state.json").read_text())["state"], "RUNNING")

        rec = cli("recover", "--input", str(self.input_path), "--workdir", str(crash_dir))
        self.assertEqual(rec.returncode, 0, rec.stderr)
        state2 = cli("state", "--workdir", str(crash_dir))
        self.assertEqual(json.loads(state2.stdout), {"state": "COMPLETED", "max_seq": 2})

        missing = cli("process", "--input", str(self.root / "nope.jsonl"),
                      "--workdir", str(self.root / "w9"))
        self.assertEqual(missing.returncode, 2)
        self.assertIn("input file not found", missing.stderr)


if __name__ == "__main__":
    unittest.main()
