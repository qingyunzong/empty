"""End-to-end tests for the walwin CLI (subprocess + FAULT_AT injection)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIN = 60000


def run_cli(input_path, state_dir, win=WIN, fault=None):
    env = dict(os.environ)
    env.pop("FAULT_AT", None)
    if fault:
        env["FAULT_AT"] = fault
    return subprocess.run(
        [sys.executable, "-m", "walwin",
         "--in", str(input_path), "--dir", str(state_dir), "--win", str(win)],
        capture_output=True, text=True, env=env, cwd=REPO)


def write_events(path, events):
    with open(path, "w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")


def ev(seq, ts, delta, key="k"):
    return {"seq": seq, "key": key, "ts": ts, "delta": delta}


# ts spread over 120s; with win=60000 the final window is (60000, 120000].
BASE_EVENTS = [
    ev(1, 10_000, 1),
    ev(2, 30_000, 2),
    ev(3, 70_000, 4),
    ev(4, 90_000, 8),
    ev(5, 120_000, 16),
]
# window sum = 4 + 8 + 16 = 28, max_ts = 120000


class WalwinTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def make_input(self, events, name="e.jsonl"):
        p = self.path(name)
        write_events(p, events)
        return p

    def reference_output(self, events, name="ref"):
        inp = self.make_input(events, name + ".jsonl")
        res = run_cli(inp, self.path(name))
        self.assertEqual(res.returncode, 0, res.stderr)
        return res.stdout

    # ------------------------------------------------------------------
    # Acceptance 1: fault injection at P1..P4 matches the no-fault reference
    # ------------------------------------------------------------------
    def test_fault_points_p1_to_p4(self):
        expected = self.reference_output(BASE_EVENTS)
        for point in ("P1", "P2", "P3", "P4"):
            with self.subTest(fault=point):
                state = self.path("state_" + point)
                inp = self.make_input(BASE_EVENTS, "in_" + point + ".jsonl")
                crashed = run_cli(inp, state, fault=point)
                self.assertNotEqual(crashed.returncode, 0,
                                    "fault injection should crash the process")
                recovered = run_cli(inp, state)
                self.assertEqual(recovered.returncode, 0, recovered.stderr)
                self.assertEqual(recovered.stdout, expected)

    def test_p4_does_not_double_count_on_resend(self):
        state = self.path("state_p4x")
        inp = self.make_input(BASE_EVENTS, "p4x.jsonl")
        run_cli(inp, state, fault="P4")          # crash before output
        again = run_cli(inp, state)              # full re-run, output re-sent
        self.assertEqual(again.returncode, 0, again.stderr)
        out = json.loads(again.stdout)
        self.assertEqual(out["window_sum"], 28)
        self.assertEqual(out["applied"], 5)

    # ------------------------------------------------------------------
    # Acceptance 2: corrupt CRC tail is truncated
    # ------------------------------------------------------------------
    def test_crc_bad_tail_truncated(self):
        from walwin.core import encode_entry

        state = self.path("state_crc")
        os.makedirs(state)
        # WAL with two committed records, then a corrupt tail.
        wal_path = os.path.join(state, "wal.log")
        with open(wal_path, "wb") as fh:
            fh.write(encode_entry({"type": "rec", **ev(1, 70_000, 4)}))
            fh.write(encode_entry({"type": "commit", "seq": 1}))
            fh.write(encode_entry({"type": "rec", **ev(2, 90_000, 8)}))
            fh.write(encode_entry({"type": "commit", "seq": 2}))
            fh.write(b'{"type":"rec","seq":3,"key":"k","ts":95000,'
                     b'"delta":999,"crc":0}\n')   # bad CRC
            fh.write(b'{"type":"commit","seq":3')  # torn write
        inp = self.make_input([ev(3, 120_000, 16)], "crc.jsonl")
        res = run_cli(inp, state)
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out["window_sum"], 4 + 8 + 16)
        self.assertEqual(out["applied"], 3)
        # Corrupt tail physically removed; remaining WAL re-verifies cleanly.
        from walwin.core import decode_entry
        with open(wal_path, "rb") as fh:
            for line in fh:
                if line.strip():
                    decode_entry(line.strip())  # must not raise

    # ------------------------------------------------------------------
    # Acceptance 3: duplicate seqs mixed in are applied exactly once
    # ------------------------------------------------------------------
    def test_duplicate_seq_idempotent(self):
        dup_events = [
            ev(1, 10_000, 1),
            ev(2, 30_000, 2),
            ev(2, 30_000, 2),   # duplicate
            ev(3, 70_000, 4),
            ev(1, 10_000, 1),   # duplicate, out of order
            ev(4, 90_000, 8),
            ev(5, 120_000, 16),
            ev(4, 90_000, 8),   # duplicate
        ]
        expected = self.reference_output(BASE_EVENTS, "ref_dup")
        inp = self.make_input(dup_events, "dup.jsonl")
        res = run_cli(inp, self.path("state_dup"))
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stdout, expected)

    # ------------------------------------------------------------------
    # Acceptance 4: cold start with an empty / nonexistent state directory
    # ------------------------------------------------------------------
    def test_cold_start_empty_dir(self):
        state = self.path("fresh", "state")  # does not exist yet
        inp = self.make_input(BASE_EVENTS, "cold.jsonl")
        res = run_cli(inp, state)
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out["window_sum"], 28)
        self.assertEqual(out["max_ts"], 120_000)
        self.assertTrue(os.path.exists(os.path.join(state, "wal.log")))
        self.assertTrue(os.path.exists(os.path.join(state, "snapshot.json")))
        # Second run over the same state is idempotent.
        res2 = run_cli(inp, state)
        self.assertEqual(res2.stdout, res.stdout)

    # ------------------------------------------------------------------
    # Extras
    # ------------------------------------------------------------------
    def test_unwritable_state_dir_exit3(self):
        blocker = self.path("blocker")
        with open(blocker, "w") as fh:
            fh.write("not a directory")
        inp = self.make_input(BASE_EVENTS, "exit3.jsonl")
        res = run_cli(inp, os.path.join(blocker, "state"))
        self.assertEqual(res.returncode, 3)

    def test_pending_gap_not_unsatisfiable(self):
        # seq 4 committed while seq 3 is missing: pending, no error, not applied.
        state = self.path("state_gap")
        inp = self.make_input([ev(1, 70_000, 4), ev(2, 90_000, 8),
                               ev(4, 120_000, 100)], "gap.jsonl")
        res = run_cli(inp, state)
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out["applied"], 2)
        self.assertEqual(out["window_sum"], 4 + 8)
        # Gap filled later: pending seq 4 becomes visible, nothing double-counted.
        inp2 = self.make_input([ev(3, 100_000, 16)], "gap2.jsonl")
        res2 = run_cli(inp2, state)
        self.assertEqual(res2.returncode, 0, res2.stderr)
        out2 = json.loads(res2.stdout)
        self.assertEqual(out2["applied"], 4)
        self.assertEqual(out2["window_sum"], 4 + 8 + 16 + 100)


if __name__ == "__main__":
    unittest.main()
