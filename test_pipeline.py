"""Unittest suite for pipeline.py using inline reference enumeration."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zlib

PIPELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pipeline.py")

# --- Inline reference: 10 normal records, per-record expected state ---------
NORMAL_RECORDS = [
    {"id": "rec-00", "name": "Alice"},
    {"id": "rec-01", "name": "Bob"},
    {"id": "rec-02", "name": "Carol"},
    {"id": "rec-03", "name": "Dave"},
    {"id": "rec-04", "name": "Eve"},
    {"id": "rec-05", "name": "Frank"},
    {"id": "rec-06", "name": "Grace"},
    {"id": "rec-07", "name": "Heidi"},
    {"id": "rec-08", "name": "Ivan"},
    {"id": "rec-09", "name": "Judy"},
]

EXPECTED_NORMAL = [
    {
        "seq": seq,
        "id": record["id"],
        "outcome": "written",
        "output": {
            "id": record["id"],
            "seq": seq,
            "name_length": len(record["name"]),
            "checksum": zlib.crc32(record["name"].encode("utf-8")),
        },
    }
    for seq, record in enumerate(NORMAL_RECORDS)
]

# Inline reference: bad-record scenario (missing name at seq 1).
BAD_RECORDS = [
    {"id": "ok-a", "name": "Alpha"},
    {"id": "bad-1"},                      # seq 1: missing name -> dead letter
    {"id": "ok-b", "name": "Beta"},
]
EXPECTED_BAD = [
    {"seq": 0, "id": "ok-a", "outcome": "written"},
    {"seq": 1, "id": "bad-1", "outcome": "dead-letter", "attempts": 3},
    {"seq": 2, "id": "ok-b", "outcome": "written"},
]

# Inline reference: duplicate-id scenario (first occurrence wins).
DUP_RECORDS = [
    {"id": "dup", "name": "First"},
    {"id": "uniq", "name": "Solo"},
    {"id": "dup", "name": "SecondNameIsLonger"},
]
EXPECTED_DUP = [
    {"seq": 0, "id": "dup", "outcome": "written"},
    {"seq": 1, "id": "uniq", "outcome": "written"},
    {"seq": 2, "id": "dup", "outcome": "duplicate"},
]

CRASH_POINTS = ("AFTER_READ", "AFTER_WRITE", "AFTER_CHECKPOINT")
CRASH_SEQ = 4


def run_cli(*args):
    return subprocess.run(
        [sys.executable, PIPELINE, *args],
        capture_output=True, text=True,
    )


class PipelineTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.input_path = os.path.join(self.tmp.name, "input.jsonl")
        self.outdir = os.path.join(self.tmp.name, "out")

    def write_input(self, records):
        with open(self.input_path, "w", encoding="utf-8") as handle:
            for record in records:
                if isinstance(record, str):
                    handle.write(record + "\n")
                else:
                    handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def read_state(self):
        with open(os.path.join(self.outdir, "state.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def read_output(self, rid):
        with open(os.path.join(self.outdir, rid + ".json"), encoding="utf-8") as fh:
            return json.load(fh)

    def output_ids(self):
        return {
            name[:-5]
            for name in os.listdir(self.outdir)
            if name.endswith(".json") and name != "state.json"
        }

    def assert_matches_reference(self, expected=EXPECTED_NORMAL):
        """Every reference row must match reality, with no extra outputs."""
        written = {row["id"] for row in expected if row["outcome"] == "written"}
        self.assertEqual(self.output_ids(), written)
        for row in expected:
            if row["outcome"] == "written":
                self.assertEqual(self.read_output(row["id"]), row["output"])

    def test_ten_records_order_and_content(self):
        self.write_input(NORMAL_RECORDS)
        result = run_cli("process", "--input", self.input_path,
                         "--outdir", self.outdir)
        self.assertEqual(result.returncode, 0, result.stderr)

        state = self.read_state()
        self.assertEqual(state["state"], "COMPLETED")
        self.assertEqual(state["checkpoint"], len(NORMAL_RECORDS) - 1)
        self.assertEqual(state["duplicates"], [])
        self.assertIsNone(state["error"])

        # Content matches the inline reference, and each output's stored seq
        # proves records were processed in input order.
        self.assert_matches_reference()
        seqs = [self.read_output(row["id"])["seq"] for row in EXPECTED_NORMAL]
        self.assertEqual(seqs, list(range(len(NORMAL_RECORDS))))

        # `state` command agrees with the state file.
        shown = run_cli("state", "--outdir", self.outdir)
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertEqual(json.loads(shown.stdout), state)

    def test_recover_from_each_crash_point(self):
        for point in CRASH_POINTS:
            with self.subTest(point=point):
                tmp = tempfile.TemporaryDirectory()
                self.addCleanup(tmp.cleanup)
                input_path = os.path.join(tmp.name, "input.jsonl")
                outdir = os.path.join(tmp.name, "out")
                with open(input_path, "w", encoding="utf-8") as handle:
                    for record in NORMAL_RECORDS:
                        handle.write(json.dumps(record) + "\n")

                crashed = run_cli("crash", "--at", point, "--seq", str(CRASH_SEQ),
                                  "--input", input_path, "--outdir", outdir)
                self.assertEqual(crashed.returncode, 2, crashed.stderr)
                self.assertIn(point, crashed.stderr)

                with open(os.path.join(outdir, "state.json"),
                          encoding="utf-8") as fh:
                    mid_state = json.load(fh)
                self.assertEqual(mid_state["state"], "RUNNING")

                target_path = os.path.join(
                    outdir, NORMAL_RECORDS[CRASH_SEQ]["id"] + ".json")
                if point == "AFTER_READ":
                    # Crashed before writing: no output, nothing checkpointed.
                    self.assertFalse(os.path.exists(target_path))
                    self.assertEqual(mid_state["checkpoint"], CRASH_SEQ - 1)
                elif point == "AFTER_WRITE":
                    # Output committed, checkpoint not yet advanced.
                    self.assertTrue(os.path.exists(target_path))
                    self.assertEqual(mid_state["checkpoint"], CRASH_SEQ - 1)
                    inode_before = os.stat(target_path).st_ino
                else:  # AFTER_CHECKPOINT
                    self.assertTrue(os.path.exists(target_path))
                    self.assertEqual(mid_state["checkpoint"], CRASH_SEQ)

                recovered = run_cli("recover", "--input", input_path,
                                    "--outdir", outdir)
                self.assertEqual(recovered.returncode, 0, recovered.stderr)

                with open(os.path.join(outdir, "state.json"),
                          encoding="utf-8") as fh:
                    final_state = json.load(fh)
                self.assertEqual(final_state["state"], "COMPLETED")
                self.assertEqual(final_state["checkpoint"],
                                 len(NORMAL_RECORDS) - 1)

                # Outputs identical to the clean-run reference.
                ids = {name[:-5] for name in os.listdir(outdir)
                       if name.endswith(".json") and name != "state.json"}
                self.assertEqual(ids, {r["id"] for r in NORMAL_RECORDS})
                for row in EXPECTED_NORMAL:
                    with open(os.path.join(outdir, row["id"] + ".json"),
                              encoding="utf-8") as fh:
                        self.assertEqual(json.load(fh), row["output"])

                if point == "AFTER_WRITE":
                    # Recovery must NOT rewrite the already-committed output.
                    self.assertEqual(os.stat(target_path).st_ino, inode_before)

    def test_bad_record_dead_letter_then_continue(self):
        self.write_input(BAD_RECORDS)
        result = run_cli("process", "--input", self.input_path,
                         "--outdir", self.outdir)
        self.assertEqual(result.returncode, 0, result.stderr)

        state = self.read_state()
        self.assertEqual(state["state"], "COMPLETED")
        self.assertEqual(state["checkpoint"], len(BAD_RECORDS) - 1)

        # Bad record produced no output; later records were still processed.
        self.assertEqual(self.output_ids(), {"ok-a", "ok-b"})
        self.assertEqual(self.read_output("ok-b"),
                         {"id": "ok-b", "seq": 2, "name_length": 4,
                          "checksum": zlib.crc32("Beta".encode("utf-8"))})

        shown = run_cli("dead-letters", "--outdir", self.outdir)
        self.assertEqual(shown.returncode, 0, shown.stderr)
        dead = json.loads(shown.stdout)
        self.assertEqual(len(dead), 1)
        self.assertEqual(dead[0]["seq"], 1)
        self.assertEqual(dead[0]["attempts"], 3)
        self.assertIn("name", dead[0]["reason"])

    def test_duplicate_id_does_not_overwrite(self):
        self.write_input(DUP_RECORDS)
        result = run_cli("process", "--input", self.input_path,
                         "--outdir", self.outdir)
        self.assertEqual(result.returncode, 0, result.stderr)

        # First occurrence wins: output reflects "First", not the later name.
        self.assertEqual(self.read_output("dup"),
                         {"id": "dup", "seq": 0, "name_length": 5,
                          "checksum": zlib.crc32("First".encode("utf-8"))})
        state = self.read_state()
        self.assertEqual(state["duplicates"], [{"seq": 2, "id": "dup"}])
        self.assertEqual(state["state"], "COMPLETED")
        self.assertEqual(state["checkpoint"], 2)

    def test_empty_input_completes(self):
        self.write_input([])
        result = run_cli("process", "--input", self.input_path,
                         "--outdir", self.outdir)
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.read_state()
        self.assertEqual(state["state"], "COMPLETED")
        self.assertEqual(state["checkpoint"], -1)
        self.assertEqual(self.output_ids(), set())

    def test_duplicate_detected_across_recovery(self):
        # Crash AFTER_WRITE on seq 2, then recover: the duplicate at seq 3
        # must still be logged (not mistaken for a crash leftover).
        records = [
            {"id": "a", "name": "Alice"},
            {"id": "b"},  # dead letter
            {"id": "c", "name": "Cy"},
            {"id": "a", "name": "Again"},
        ]
        self.write_input(records)
        crashed = run_cli("crash", "--at", "AFTER_WRITE", "--seq", "2",
                          "--input", self.input_path, "--outdir", self.outdir)
        self.assertEqual(crashed.returncode, 2, crashed.stderr)
        recovered = run_cli("recover", "--input", self.input_path,
                            "--outdir", self.outdir)
        self.assertEqual(recovered.returncode, 0, recovered.stderr)

        state = self.read_state()
        self.assertEqual(state["state"], "COMPLETED")
        self.assertEqual(state["checkpoint"], 3)
        self.assertEqual(state["duplicates"], [{"seq": 3, "id": "a"}])
        # First occurrence of "a" still owns the output.
        self.assertEqual(self.read_output("a"),
                         {"id": "a", "seq": 0, "name_length": 5,
                          "checksum": zlib.crc32("Alice".encode("utf-8"))})
        self.assertEqual(self.output_ids(), {"a", "c"})

    def test_missing_input_is_explicit_error(self):
        result = run_cli("process",
                         "--input", os.path.join(self.tmp.name, "nope.jsonl"),
                         "--outdir", self.outdir)
        self.assertEqual(result.returncode, 1)
        self.assertIn("input file not found", result.stderr)
        state = self.read_state()
        self.assertEqual(state["state"], "FAILED")
        self.assertIn("input file not found", state["error"])

    def test_recover_without_state_is_explicit_error(self):
        self.write_input(NORMAL_RECORDS)
        os.makedirs(self.outdir)
        result = run_cli("recover", "--input", self.input_path,
                         "--outdir", self.outdir)
        self.assertEqual(result.returncode, 1)
        self.assertIn("nothing to recover", result.stderr)


if __name__ == "__main__":
    unittest.main()
