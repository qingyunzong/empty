import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from zpack import (BudgetError, FormatError, decode, decode_varint, encode,
                   encode_varint, optimize_tokens)

ROOT = Path(__file__).resolve().parent.parent


def build_file(dictionary, declared, tokens, declared_bytes=None):
    out = bytearray()
    out += len(dictionary).to_bytes(4, "big")
    for entry in dictionary:
        out += len(entry).to_bytes(2, "big") + entry
    out += declared_bytes if declared_bytes is not None else encode_varint(declared)
    out += bytes(tokens)
    return bytes(out)


def brute_force_min_tokens(data, dictionary):
    """Independent DP: minimum token count over all dictionary choices."""
    n = len(data)
    INF = float("inf")
    dp = [INF] * (n + 1)
    dp[n] = 0
    for i in range(n - 1, -1, -1):
        if data[i] < 128:
            dp[i] = 1 + dp[i + 1]
        for entry in dictionary:
            if entry and data.startswith(entry, i):
                dp[i] = min(dp[i], 1 + dp[i + len(entry)])
    return dp[0]


def parse_dict_and_tokens(blob):
    count = int.from_bytes(blob[0:4], "big")
    pos = 4
    dictionary = []
    for _ in range(count):
        length = int.from_bytes(blob[pos:pos + 2], "big")
        pos += 2
        dictionary.append(blob[pos:pos + length])
        pos += length
    # skip declared varint
    while True:
        byte = blob[pos]
        pos += 1
        if not byte & 0x80:
            break
    return dictionary, blob[pos:]


class RoundTripTests(unittest.TestCase):
    def test_empty_input(self):
        blob = encode(b"")
        self.assertEqual(decode(blob), b"")

    def test_empty_input_cli(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td, "empty.bin")
            enc = Path(td, "empty.zp")
            dec = Path(td, "empty.out")
            src.write_bytes(b"")
            for args in (["encode", src, enc], ["decode", enc, dec]):
                proc = subprocess.run(
                    [sys.executable, "-m", "zpack", args[0],
                     str(args[1]), str(args[2])],
                    cwd=ROOT, capture_output=True)
                self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(dec.read_bytes(), b"")

    def test_repeated_abc_dict_hit(self):
        data = b"abc" * 20
        blob = encode(data)
        dictionary, tokens = parse_dict_and_tokens(blob)
        self.assertGreater(len(dictionary), 0, "expected a dictionary entry")
        self.assertTrue(any(t >= 128 for t in tokens),
                        "expected dictionary-reference tokens")
        self.assertLess(len(tokens), len(data))
        self.assertEqual(decode(blob), data)

    def test_roundtrip_assorted(self):
        rng = random.Random(1234)
        for n in (1, 2, 7, 50, 120, 300):
            data = bytes(rng.randrange(128) for _ in range(n))
            self.assertEqual(decode(encode(data)), data)
        high = bytes(rng.randrange(256) for _ in range(200))
        self.assertEqual(decode(encode(high)), high)


class VarintTests(unittest.TestCase):
    def test_roundtrip(self):
        for value in (0, 1, 127, 128, 300, 2**32 - 1):
            decoded, pos = decode_varint(encode_varint(value))
            self.assertEqual((decoded, pos), (value, len(encode_varint(value))))

    def test_noncanonical_rejected(self):
        with self.assertRaises(FormatError):
            decode_varint(bytes([0x80, 0x00]))
        with self.assertRaises(FormatError):
            decode(build_file([], 0, [], declared_bytes=bytes([0x80, 0x00])))

    def test_fifth_byte_high_bits_rejected(self):
        with self.assertRaises(FormatError):
            decode_varint(bytes([0x80, 0x80, 0x80, 0x80, 0x10]))
        with self.assertRaises(FormatError):
            decode_varint(bytes([0x80, 0x80, 0x80, 0x80, 0x80]))

    def test_over_five_bytes_rejected(self):
        with self.assertRaises(FormatError):
            decode_varint(bytes([0x80, 0x80, 0x80, 0x80, 0x80, 0x00]))

    def test_max_u32_accepted(self):
        value, _ = decode_varint(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x0F]))
        self.assertEqual(value, 2**32 - 1)


class FormatAndBudgetTests(unittest.TestCase):
    def test_dict_index_out_of_range(self):
        blob = build_file([b"ab"], 2, [129])
        with self.assertRaises(FormatError):
            decode(blob)

    def test_declared_limit_exceeded_no_output(self):
        # declared 10 but tokens produce 11 bytes
        blob = build_file([], 10, list(range(11)))
        with self.assertRaises(BudgetError):
            decode(blob)

    def test_declared_limit_exceeded_cli_atomic(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td, "bad.zp")
            out = Path(td, "out.bin")
            src.write_bytes(build_file([], 10, list(range(11))))
            proc = subprocess.run(
                [sys.executable, "-m", "zpack", "decode", str(src), str(out)],
                cwd=ROOT, capture_output=True)
            self.assertEqual(proc.returncode, 6)
            self.assertFalse(out.exists(), "no output file may be created")
            self.assertEqual(os.listdir(td), ["bad.zp"])

    def test_budget_checked_before_decode(self):
        blob = build_file([], 1000, [])
        with self.assertRaises(BudgetError):
            decode(blob, max_output=10)

    def test_size_mismatch_rejected(self):
        blob = build_file([], 5, [1, 2])
        with self.assertRaises(FormatError):
            decode(blob)

    def test_truncated_inputs(self):
        with self.assertRaises(FormatError):
            decode(b"\x00\x00")
        with self.assertRaises(FormatError):
            decode((1).to_bytes(4, "big") + b"\x00")  # truncated entry len


class OptimalityTests(unittest.TestCase):
    def test_tie_break_smallest_index(self):
        # duplicate entries tie at equal cost -> smallest index wins
        tokens = optimize_tokens(b"ab", [b"ab", b"ab"])
        self.assertEqual(tokens, bytes([128]))
        # dict reference preferred over literal on a tie
        tokens = optimize_tokens(b"a", [b"a"])
        self.assertEqual(tokens, bytes([128]))

    def test_random_samples_match_brute_force(self):
        rng = random.Random(20261001)
        for trial in range(60):
            n = rng.randrange(0, 121)
            if trial % 3 == 0:
                data = bytes(rng.randrange(128) for _ in range(n))
            elif trial % 3 == 1:
                data = bytes(rng.choice(b"abcde") for _ in range(n))
            else:
                data = bytes(rng.randrange(256) for _ in range(n))
            blob = encode(data)
            dictionary, tokens = parse_dict_and_tokens(blob)
            expected = brute_force_min_tokens(data, dictionary)
            self.assertEqual(len(tokens), expected,
                             f"trial {trial}: not optimal for {data!r}")
            self.assertEqual(decode(blob), data)


class CliRoundTripTests(unittest.TestCase):
    def test_roundtrip_atomic_write(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td, "in.bin")
            enc = Path(td, "in.zp")
            dec = Path(td, "out.bin")
            payload = (b"hello world " * 50) + bytes(range(256))
            src.write_bytes(payload)
            for args in (["encode", src, enc], ["decode", enc, dec]):
                proc = subprocess.run(
                    [sys.executable, "-m", "zpack", args[0],
                     str(args[1]), str(args[2])],
                    cwd=ROOT, capture_output=True)
                self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(dec.read_bytes(), payload)

    def test_missing_input_exit_6(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td, "out.bin")
            proc = subprocess.run(
                [sys.executable, "-m", "zpack", "encode",
                 str(Path(td, "nope")), str(out)],
                cwd=ROOT, capture_output=True)
            self.assertEqual(proc.returncode, 6)
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
