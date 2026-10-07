import json
import os
import random
import tempfile
import unittest

from deltaup import applier, encoder, reference
from deltaup.applier import Applier, EventLimitReached
from deltaup.errors import (
    BaselineMismatchError,
    ResumeError,
    TempOutputMismatchError,
)

from helpers import read_file, write_file


def make_case():
    rng = random.Random(2024)
    baseline = rng.randbytes(4096)
    instrs = [
        ("copy_base", 0, 700),
        ("add", b"inserted-literal-" * 40),
        ("copy_out", 0, 300),          # cross-window copy (window=64 in tests)
        ("copy_base", 1000, 1500),
        ("copy_out", 100, 900),        # overlapping / nested reuse
        ("add", b"tail"),
        ("copy_out", 0, 2000),
        ("copy_base", 3000, 1096),
    ]
    target = reference.interpret(baseline, instrs)
    blocks = encoder.chunk_instructions(instrs, 1024)
    stream = encoder.encode_instructions(baseline, target, blocks)
    return baseline, stream, target


class ResumeEnumerationTest(unittest.TestCase):
    """Interrupt at every checkpointable boundary; resume must match one-shot."""

    @classmethod
    def setUpClass(cls):
        cls.baseline, cls.stream, cls.target = make_case()

    def _paths(self, root):
        return (
            os.path.join(root, "baseline.bin"),
            os.path.join(root, "delta.bin"),
            os.path.join(root, "target.bin"),
        )

    def _setup_dir(self, root):
        os.makedirs(root, exist_ok=True)
        baseline_path, delta_path, _ = self._paths(root)
        write_file(baseline_path, self.baseline)
        write_file(delta_path, self.stream)
        return self._paths(root)

    def _count_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path, delta_path, target_path = self._setup_dir(tmp)
            ap = Applier(baseline_path, target_path, window_size=64)
            try:
                with open(delta_path, "rb") as fh:
                    ap.feed(fh.read())
                ap.finish()
                return ap.event_count
            finally:
                ap.close()

    def test_one_shot(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path, delta_path, target_path = self._setup_dir(tmp)
            applier.apply_delta(baseline_path, delta_path, target_path,
                                window_size=64)
            self.assertEqual(read_file(target_path), self.target)

    def test_resume_from_every_interruption_point(self):
        total_events = self._count_events()
        self.assertGreater(total_events, 8)  # sanity: many boundaries
        for limit in range(1, total_events + 1):
            with self.subTest(interrupt_after=limit):
                with tempfile.TemporaryDirectory() as tmp:
                    baseline_path, delta_path, target_path = self._setup_dir(tmp)
                    with self.assertRaises(EventLimitReached):
                        applier.apply_delta(
                            baseline_path, delta_path, target_path,
                            window_size=64, event_limit=limit,
                        )
                    checkpoint = os.path.join(tmp, ".target.bin.ckpt")
                    self.assertTrue(os.path.exists(checkpoint))
                    applier.resume_delta(
                        baseline_path, delta_path, target_path, checkpoint
                    )
                    self.assertEqual(read_file(target_path), self.target)
                    self.assertFalse(os.path.exists(checkpoint))

    def test_resume_with_split_feeds(self):
        # Resume and feed the remaining stream in tiny slices.
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path, delta_path, target_path = self._setup_dir(tmp)
            with self.assertRaises(EventLimitReached):
                applier.apply_delta(baseline_path, delta_path, target_path,
                                    window_size=64, event_limit=3)
            checkpoint = os.path.join(tmp, ".target.bin.ckpt")
            ap = Applier.resume(baseline_path, target_path, checkpoint)
            try:
                with open(delta_path, "rb") as fh:
                    fh.seek(ap.input_offset)
                    while True:
                        piece = fh.read(7)
                        if not piece:
                            break
                        ap.feed(piece)
                ap.finish()
            finally:
                ap.close()
            self.assertEqual(read_file(target_path), self.target)


class ResumeTamperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline, cls.stream, cls.target = make_case()

    def _crash(self, tmp, limit=4, preexisting=b"original-target"):
        baseline_path = os.path.join(tmp, "baseline.bin")
        delta_path = os.path.join(tmp, "delta.bin")
        target_path = os.path.join(tmp, "target.bin")
        write_file(baseline_path, self.baseline)
        write_file(delta_path, self.stream)
        write_file(target_path, preexisting)
        with self.assertRaises(EventLimitReached):
            applier.apply_delta(baseline_path, delta_path, target_path,
                                window_size=64, event_limit=limit)
        return baseline_path, delta_path, target_path

    def test_tampered_baseline_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path, delta_path, target_path = self._crash(tmp)
            data = bytearray(read_file(baseline_path))
            data[10] ^= 0xFF
            write_file(baseline_path, bytes(data))
            checkpoint = os.path.join(tmp, ".target.bin.ckpt")
            with self.assertRaises(BaselineMismatchError):
                applier.resume_delta(baseline_path, delta_path, target_path,
                                     checkpoint)
            self.assertEqual(read_file(target_path), b"original-target")

    def test_tampered_temp_output_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path, delta_path, target_path = self._crash(tmp)
            temp_path = os.path.join(tmp, ".target.bin.part")
            data = bytearray(read_file(temp_path))
            data[0] ^= 0xFF
            write_file(temp_path, bytes(data))
            checkpoint = os.path.join(tmp, ".target.bin.ckpt")
            with self.assertRaises(TempOutputMismatchError):
                applier.resume_delta(baseline_path, delta_path, target_path,
                                     checkpoint)
            self.assertEqual(read_file(target_path), b"original-target")

    def test_truncated_temp_output_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path, delta_path, target_path = self._crash(tmp)
            temp_path = os.path.join(tmp, ".target.bin.part")
            with open(temp_path, "r+b") as fh:
                fh.truncate(3)
            checkpoint = os.path.join(tmp, ".target.bin.ckpt")
            with self.assertRaises(TempOutputMismatchError):
                applier.resume_delta(baseline_path, delta_path, target_path,
                                     checkpoint)
            self.assertEqual(read_file(target_path), b"original-target")

    def test_missing_checkpoint_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path, delta_path, target_path = self._crash(tmp)
            with self.assertRaises(ResumeError):
                applier.resume_delta(baseline_path, delta_path, target_path,
                                     os.path.join(tmp, "nope.ckpt"))

    def test_checkpoint_records_required_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._crash(tmp)
            checkpoint = os.path.join(tmp, ".target.bin.ckpt")
            with open(checkpoint, "r", encoding="utf-8") as fh:
                state = json.load(fh)
            for key in ("input_offset", "out_len", "crc32", "decoder",
                        "temp_path", "block_out_remaining"):
                self.assertIn(key, state)
            self.assertIn(
                state["decoder"]["phase"],
                ("instructions", "block_header", "trailer"),
            )


if __name__ == "__main__":
    unittest.main()
