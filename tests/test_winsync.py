import json
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from winsync.core import RECORD_HEADER, pull

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def encode_record(payload: bytes, corrupt: bool = False) -> bytes:
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    if corrupt:
        crc ^= 0xDEADBEEF
    return RECORD_HEADER.pack(crc, len(payload)) + payload


def write_seg(path, payloads, corrupt_indexes=()):
    with open(path, "wb") as fh:
        for i, p in enumerate(payloads):
            fh.write(encode_record(p, corrupt=i in corrupt_indexes))


def read_dst(path):
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def serial_reference(src):
    """Independent serial reference: no window, plain sequential scan."""
    committed = []
    quarantined = []
    seq = 0
    for name in sorted(n for n in os.listdir(src) if n.endswith(".seg")):
        with open(os.path.join(src, name), "rb") as fh:
            data = fh.read()
        offset = 0
        bad = False
        while offset < len(data):
            if offset + RECORD_HEADER.size > len(data):
                bad = True
                break
            crc, length = RECORD_HEADER.unpack_from(data, offset)
            offset += RECORD_HEADER.size
            if offset + length > len(data):
                bad = True
                break
            payload = data[offset:offset + length]
            offset += length
            if (zlib.crc32(payload) & 0xFFFFFFFF) != crc:
                bad = True
                break
            committed.append({"seq": seq, "segment": name, "payload": payload})
            seq += 1
        if bad:
            quarantined.append(name)
            break
    return committed, quarantined


class WinsyncTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="winsync-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def path(self, *parts):
        return os.path.join(self.tmp, *parts)

    def make_layout(self):
        src = self.path("src")
        os.makedirs(src, exist_ok=True)
        return src, self.path("dst.jsonl"), self.path("ack.json")


class TestRandomizedVsReference(WinsyncTestCase):
    """Acceptance A: random drop/dup/corrupt segment sets (n<=500) vs serial reference."""

    def test_randomized(self):
        rng = random.Random(20261001)
        for trial in range(30):
            with self.subTest(trial=trial):
                trial_dir = self.path(f"t{trial}")
                src = os.path.join(trial_dir, "src")
                os.makedirs(src)
                dst = os.path.join(trial_dir, "dst.jsonl")
                ack = os.path.join(trial_dir, "ack.json")

                # canonical segments
                n_segments = rng.randint(1, 8)
                canonical = []
                total = 0
                for s in range(n_segments):
                    n_records = rng.randint(0, 500 // max(1, n_segments))
                    total += n_records
                    payloads = [
                        f"t{trial}-s{s}-r{r}-{'x' * rng.randint(0, 20)}".encode()
                        for r in range(n_records)
                    ]
                    canonical.append(payloads)
                self.assertLessEqual(total, 500)

                # materialize with random drop / duplicate / corrupt
                file_index = 0
                for s, payloads in enumerate(canonical):
                    if rng.random() < 0.2:
                        continue  # dropped segment
                    corrupt = set()
                    if rng.random() < 0.3 and payloads:
                        corrupt = {rng.randrange(len(payloads))}
                    name = f"seg{file_index:03d}.seg"
                    write_seg(os.path.join(src, name), payloads, corrupt)
                    file_index += 1
                    if rng.random() < 0.25:  # duplicated segment content
                        dup = f"seg{file_index:03d}.seg"
                        write_seg(os.path.join(src, dup), payloads, corrupt)
                        file_index += 1

                window = rng.choice([1, 2, 3, 8, 16])
                result = pull(src, dst, ack, window=window)

                expected_records, expected_quarantined = serial_reference(src)
                actual = read_dst(dst)

                self.assertEqual(len(actual), len(expected_records))
                for got, want in zip(actual, expected_records):
                    self.assertEqual(got["seq"], want["seq"])
                    self.assertEqual(got["segment"], want["segment"])
                    self.assertEqual(got["payload"], want["payload"].decode())
                self.assertEqual(result["high_watermark"], len(expected_records))
                self.assertEqual(result["quarantined"], expected_quarantined)


class TestCrashRecovery(WinsyncTestCase):
    """Acceptance B: crash after DST write, before ACK write -> no duplicates."""

    def test_crash_between_dst_and_ack(self):
        src, dst, ack = self.make_layout()
        write_seg(self.path("src", "a.seg"), [b"r0", b"r1", b"r2"])
        write_seg(self.path("src", "b.seg"), [b"r3", b"r4"])

        class SimulatedCrash(Exception):
            pass

        calls = {"n": 0}

        def crash_hook():
            calls["n"] += 1
            if calls["n"] == 2:  # crash on the second committed record
                raise SimulatedCrash()

        with self.assertRaises(SimulatedCrash):
            pull(src, dst, ack, window=4, crash_hook=crash_hook)

        # DST has 2 records, ACK only knows about 1.
        self.assertEqual(len(read_dst(dst)), 2)
        with open(ack, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["high_watermark"], 1)

        result = pull(src, dst, ack, window=4)
        entries = read_dst(dst)
        seqs = [e["seq"] for e in entries]
        self.assertEqual(seqs, [0, 1, 2, 3, 4])  # no duplicates, no gaps
        self.assertEqual([e["payload"] for e in entries],
                         ["r0", "r1", "r2", "r3", "r4"])
        self.assertEqual(result["high_watermark"], 5)
        self.assertEqual(result["quarantined"], [])

    def test_duplicate_ack_no_regress_no_skip(self):
        src, dst, ack = self.make_layout()
        write_seg(self.path("src", "a.seg"), [b"r0", b"r1"])
        write_seg(self.path("src", "b.seg"), [b"r2", b"r3"])

        result = pull(src, dst, ack, window=2)
        self.assertEqual(result["high_watermark"], 4)

        # Rewrite the ACK file several times with the same (duplicate) value.
        for _ in range(3):
            with open(ack, "w", encoding="utf-8") as fh:
                json.dump({"high_watermark": 4, "quarantined": []}, fh)
        # And once with a stale, lower watermark (must not regress).
        with open(ack, "w", encoding="utf-8") as fh:
            json.dump({"high_watermark": 1, "quarantined": []}, fh)

        result = pull(src, dst, ack, window=2)
        entries = read_dst(dst)
        self.assertEqual([e["seq"] for e in entries], [0, 1, 2, 3])
        self.assertEqual(result["high_watermark"], 4)
        with open(ack, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["high_watermark"], 4)

    def test_idempotent_rerun(self):
        src, dst, ack = self.make_layout()
        write_seg(self.path("src", "a.seg"), [b"x", b"y"])
        pull(src, dst, ack, window=8)
        before = read_dst(dst)
        result = pull(src, dst, ack, window=8)
        self.assertEqual(read_dst(dst), before)
        self.assertEqual(result["high_watermark"], 2)


class TestWindowEquivalence(WinsyncTestCase):
    """Acceptance C: W=1 and W=8 produce identical results."""

    def test_window_1_vs_8(self):
        src = self.path("src")
        os.makedirs(src)
        rng = random.Random(7)
        for s in range(6):
            payloads = [f"seg{s}-rec{r}".encode() for r in range(rng.randint(1, 40))]
            corrupt = {len(payloads) - 1} if s == 4 else set()
            write_seg(self.path("src", f"s{s}.seg"), payloads, corrupt)

        results = {}
        for window in (1, 8):
            dst = self.path(f"dst{window}.jsonl")
            ack = self.path(f"ack{window}.json")
            results[window] = (pull(src, dst, ack, window=window), read_dst(dst))

        self.assertEqual(results[1][0], results[8][0])
        self.assertEqual(results[1][1], results[8][1])
        self.assertEqual(results[1][0]["quarantined"], ["s4.seg"])


class TestFirstSegmentCorrupt(WinsyncTestCase):
    """Acceptance D: first segment corrupt -> empty DST, exit code 7."""

    def run_cli(self, *argv):
        env = dict(os.environ, PYTHONPATH=REPO_ROOT)
        return subprocess.run(
            [sys.executable, "-m", "winsync", *argv],
            capture_output=True, text=True, cwd=REPO_ROOT, env=env,
        )

    def test_first_segment_corrupt(self):
        src, dst, ack = self.make_layout()
        write_seg(self.path("src", "000.seg"), [b"bad1", b"bad2"], corrupt_indexes={0})
        write_seg(self.path("src", "001.seg"), [b"good"])

        proc = self.run_cli("pull", src, dst, "--win", "4", "--ack", ack)
        self.assertEqual(proc.returncode, 7, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["high_watermark"], 0)
        self.assertEqual(report["quarantined"], ["000.seg"])
        # DST is empty (or absent).
        self.assertTrue(not os.path.exists(dst) or os.path.getsize(dst) == 0)

    def test_cli_clean_run_exit_0(self):
        src, dst, ack = self.make_layout()
        write_seg(self.path("src", "000.seg"), [b"a", b"b"])
        proc = self.run_cli("pull", src, dst, "--win", "1", "--ack", ack)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["high_watermark"], 2)
        self.assertEqual(report["quarantined"], [])
        self.assertEqual(proc.stderr, "")

    def test_cli_missing_src_error(self):
        _, dst, ack = self.make_layout()
        proc = self.run_cli("pull", self.path("nope"), dst, "--win", "1", "--ack", ack)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", proc.stderr.lower())
        self.assertEqual(proc.stdout, "")


class TestQuarantineStopsCommits(WinsyncTestCase):
    def test_commits_before_corruption_are_kept(self):
        src, dst, ack = self.make_layout()
        write_seg(self.path("src", "a.seg"), [b"ok0", b"ok1"])
        write_seg(self.path("src", "b.seg"), [b"ok2", b"bad"], corrupt_indexes={1})
        write_seg(self.path("src", "c.seg"), [b"never"])

        result = pull(src, dst, ack, window=8)
        entries = read_dst(dst)
        self.assertEqual([e["payload"] for e in entries], ["ok0", "ok1", "ok2"])
        self.assertEqual(result["high_watermark"], 3)
        self.assertEqual(result["quarantined"], ["b.seg"])

        # Restart: quarantine state persists, still no further commits.
        result = pull(src, dst, ack, window=8)
        self.assertEqual(read_dst(dst), entries)
        self.assertEqual(result["quarantined"], ["b.seg"])


if __name__ == "__main__":
    unittest.main()
