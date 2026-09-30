"""Acceptance tests for the nakproto NAK protocol simulator."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from nakproto import (  # noqa: E402
    ConfigError,
    Script,
    parse_script,
    run_simulation,
)


class ScenarioAFrame3Lost(unittest.TestCase):
    """a) Frame 3 lost: NAK at detection tick, continuous delivery after
    retransmission, matching the reference timing table."""

    @classmethod
    def setUpClass(cls):
        cls.result = run_simulation(Script(frames=10, drop=(3,)))

    def test_state_ok_and_full_delivery(self):
        self.assertEqual(self.result.state, "OK")
        self.assertEqual(self.result.delivered, list(range(1, 11)))

    def test_nak_emitted_at_detection_tick(self):
        # Frame 3 is lost at tick 3; the gap is detected when frame 4
        # arrives at tick 4 -> exactly one NAK(3) at tick 4.
        self.assertEqual(self.result.nak_log, [{"tick": 4, "seq": 3}])

    def test_reference_timing_table(self):
        # Reference table (README): deliveries happen at ticks
        # 1,2,5,5,5,6,7,8,9,10 for seqs 1..10.
        expected_ticks = [1, 2, 5, 5, 5, 6, 7, 8, 9, 10]
        self.assertEqual(self.result.delivery_ticks, expected_ticks)

    def test_continuous_delivery_after_retransmission(self):
        # At tick 5 the retransmitted 3 lands and the buffered 4 drains,
        # followed by the fresh 5: three consecutive deliveries, no gap.
        tick5 = [
            seq
            for seq, t in zip(
                self.result.delivered, self.result.delivery_ticks
            )
            if t == 5
        ]
        self.assertEqual(tick5, [3, 4, 5])

    def test_delivery_strictly_increasing_deduped(self):
        d = self.result.delivered
        self.assertEqual(d, sorted(set(d)))
        self.assertEqual(len(d), len(set(d)))


class ScenarioBDebounce(unittest.TestCase):
    """b) Same gap: at most one NAK per 20 ticks."""

    @classmethod
    def setUpClass(cls):
        # Retransmission of 3 is also lost, so the gap persists; the
        # second NAK at tick 24 finds seq 3 outside the window -> FAILED.
        cls.result = run_simulation(
            Script(frames=30, drop=(3,), drop_retx=(3,))
        )

    def test_single_nak_within_20_ticks(self):
        naks = self.result.nak_log
        self.assertEqual(naks, [{"tick": 4, "seq": 3}, {"tick": 24, "seq": 3}])
        in_window = [n for n in naks if 4 <= n["tick"] < 24]
        self.assertEqual(len(in_window), 1)

    def test_naks_exactly_debounce_apart(self):
        ticks = [n["tick"] for n in self.result.nak_log]
        for first, second in zip(ticks, ticks[1:]):
            self.assertGreaterEqual(second - first, 20)


class ScenarioCRangeErr(unittest.TestCase):
    """c) Lost frame slides out of the window: RANGE_ERR -> FAILED and
    delivery freezes."""

    @classmethod
    def setUpClass(cls):
        cls.result = run_simulation(
            Script(frames=30, drop=(3,), drop_retx=(3,))
        )

    def test_range_err_then_failed(self):
        self.assertEqual(self.result.state, "FAILED")
        kinds = [(e["tick"], e["type"]) for e in self.result.events]
        self.assertIn((24, "range_err"), kinds)
        self.assertIn((25, "failed"), kinds)

    def test_delivery_frozen(self):
        # Only seqs 1 and 2 were delivered before the gap; buffered
        # frames 4..24 are never delivered after FAILED.
        self.assertEqual(self.result.delivered, [1, 2])
        self.assertEqual(self.result.delivery_ticks, [1, 2])


class ScenarioDOutOfOrderNoGap(unittest.TestCase):
    """d) Out-of-order arrivals without a gap: zero NAKs."""

    @classmethod
    def setUpClass(cls):
        # Late duplicate copies of 2 and 3 arrive out of order (seq <
        # expected) but create no gap.
        cls.result = run_simulation(Script(frames=6, duplicate=(2, 3)))

    def test_zero_naks(self):
        self.assertEqual(self.result.nak_log, [])

    def test_delivery_deduped_in_order(self):
        self.assertEqual(self.result.state, "OK")
        self.assertEqual(self.result.delivered, [1, 2, 3, 4, 5, 6])
        self.assertEqual(self.result.delivery_ticks, [1, 2, 3, 4, 5, 6])


class SenderDuplicateNak(unittest.TestCase):
    """3) Duplicate NAKs do not disturb the sender."""

    def test_duplicate_nak_idempotent(self):
        from nakproto.sim import Sender

        sender = Sender()
        for _ in range(5):
            sender.send_new()
        self.assertEqual(sender.handle_nak(3), "RETX")
        self.assertEqual(sender.handle_nak(3), "RETX")
        self.assertEqual(sender.latest_sent, 5)
        self.assertEqual(sender.retransmissions, 2)
        self.assertEqual(sender.range_errors, 0)


class ConfigValidation(unittest.TestCase):
    """Non-increasing seq lists in the script raise ConfigError."""

    def test_non_increasing_drop(self):
        with self.assertRaises(ConfigError):
            parse_script({"frames": 10, "drop": [5, 3]})

    def test_equal_adjacent_drop(self):
        with self.assertRaises(ConfigError):
            parse_script({"frames": 10, "drop": [3, 3]})

    def test_non_increasing_drop_retx(self):
        with self.assertRaises(ConfigError):
            parse_script({"frames": 10, "drop_retx": [4, 2]})

    def test_out_of_range(self):
        with self.assertRaises(ConfigError):
            parse_script({"frames": 5, "drop": [6]})

    def test_bad_frames(self):
        with self.assertRaises(ConfigError):
            parse_script({"frames": 0})

    def test_valid_script(self):
        script = parse_script({"frames": 4, "drop": [2], "duplicate": [3]})
        self.assertEqual(script, Script(frames=4, drop=(2,), duplicate=(3,)))


class Cli(unittest.TestCase):
    def _run_cli(self, script: dict) -> subprocess.CompletedProcess:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as fh:
            json.dump(script, fh)
            path = fh.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "nakproto", "run", path],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
            )
        finally:
            Path(path).unlink(missing_ok=True)

    def test_cli_outputs_delivery_and_nak_log(self):
        proc = self._run_cli({"frames": 10, "drop": [3]})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["state"], "OK")
        self.assertEqual(out["delivered"], list(range(1, 11)))
        self.assertEqual(out["nak_log"], [{"tick": 4, "seq": 3}])

    def test_cli_config_error(self):
        proc = self._run_cli({"frames": 10, "drop": [4, 2]})
        self.assertEqual(proc.returncode, 2)
        self.assertIn("ConfigError", proc.stderr)

    def test_cli_usage_error(self):
        proc = subprocess.run(
            [sys.executable, "-m", "nakproto"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage", proc.stderr)


if __name__ == "__main__":
    unittest.main()
