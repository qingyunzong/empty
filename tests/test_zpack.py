import os
import random
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import zpack


def parse_blob(blob):
    """Split a blob into (dictionary entries, token list)."""
    dict_count, offset = zpack.decode_varint(blob, 0)
    entries = []
    for _ in range(dict_count):
        length, offset = zpack.decode_varint(blob, offset)
        entries.append(blob[offset:offset + length])
        offset += length
    return entries, list(blob[offset:])


def brute_force_tokens(data, dictionary):
    """Independently compute the canonical shortest token sequence.

    Forward shortest-path relaxation over the position graph: at every
    position, exhaustively try the literal edge and every matching
    dictionary entry. Token-count ties are broken by the canonical key
    order: dictionary reference (smallest index first) before literal.
    """
    n = len(data)
    best_count = [None] * (n + 1)
    best_keys = [None] * (n + 1)
    best_count[0] = 0
    best_keys[0] = ()
    for i in range(n + 1):
        if best_count[i] is None:
            continue
        edges = []
        if i < n and data[i] < 128:
            edges.append((i + 1, (1, data[i])))
        for index, entry in enumerate(dictionary):
            if entry and data.startswith(entry, i):
                edges.append((i + len(entry), (0, index)))
        for nxt, key in edges:
            cand_count = best_count[i] + 1
            cand_keys = best_keys[i] + (key,)
            if (
                best_count[nxt] is None
                or cand_count < best_count[nxt]
                or (cand_count == best_count[nxt] and cand_keys < best_keys[nxt])
            ):
                best_count[nxt] = cand_count
                best_keys[nxt] = cand_keys
    tokens = []
    for key in best_keys[n]:
        tokens.append(key[1] if key[0] == 1 else 128 + key[1])
    return tokens


class VarintTests(unittest.TestCase):
    def test_roundtrip_boundaries(self):
        for value in (0, 1, 127, 128, 300, 16383, 16384, 2**31, 2**32 - 1):
            encoded = zpack.encode_varint(value)
            decoded, offset = zpack.decode_varint(encoded)
            self.assertEqual(decoded, value)
            self.assertEqual(offset, len(encoded))

    def test_known_encodings(self):
        self.assertEqual(zpack.encode_varint(0), b"\x00")
        self.assertEqual(zpack.encode_varint(127), b"\x7f")
        self.assertEqual(zpack.encode_varint(128), b"\x80\x01")
        self.assertEqual(zpack.encode_varint(2**32 - 1), b"\xff\xff\xff\xff\x0f")

    def test_non_shortest_rejected(self):
        for blob in (b"\x80\x00", b"\xff\x00", b"\x80\x80\x80\x80\x00"):
            with self.assertRaises(zpack.FormatError, msg=blob.hex()):
                zpack.decode_varint(blob)

    def test_fifth_byte_high_bits_rejected(self):
        with self.assertRaises(zpack.FormatError):
            zpack.decode_varint(b"\xff\xff\xff\xff\x1f")  # bit 32 set

    def test_overlong_varint_rejected(self):
        with self.assertRaises(zpack.FormatError):
            zpack.decode_varint(b"\xff\xff\xff\xff\xff\x01")  # 6th group

    def test_truncated_varint_rejected(self):
        with self.assertRaises(zpack.FormatError):
            zpack.decode_varint(b"\x80")
        with self.assertRaises(zpack.FormatError):
            zpack.decode_varint(b"")

    def test_out_of_range_value(self):
        with self.assertRaises(ValueError):
            zpack.encode_varint(2**32)
        with self.assertRaises(ValueError):
            zpack.encode_varint(-1)


class FormatTests(unittest.TestCase):
    def test_empty_input_roundtrip(self):
        blob = zpack.compress(b"")
        self.assertEqual(blob, b"\x00")  # D=0, no entries, empty token stream
        self.assertEqual(zpack.decompress(blob), b"")

    def test_repeated_abc_dictionary_hit(self):
        data = b"abc" * 20
        blob = zpack.compress(data)
        entries, tokens = parse_blob(blob)
        self.assertGreater(len(entries), 0, "expected a dictionary to be built")
        self.assertTrue(
            any(token >= 128 for token in tokens),
            "expected dictionary reference tokens",
        )
        self.assertLess(len(tokens), len(data))
        self.assertEqual(zpack.decompress(blob), data)

    def test_nonminimal_varint_header_rejected(self):
        # D encoded as 0x80 0x00 (non-shortest form of 0)
        with self.assertRaises(zpack.FormatError):
            zpack.decompress(b"\x80\x00")

    def test_dictionary_index_out_of_range(self):
        with self.assertRaises(zpack.FormatError):
            zpack.decompress(b"\x00" + bytes([128]))  # D=0, token references entry 0
        with self.assertRaises(zpack.FormatError):
            zpack.decompress(b"\x01\x01A" + bytes([129]))  # D=1, index 1 invalid

    def test_entry_length_u16_limit(self):
        blob = b"\x01" + zpack.encode_varint(0x10000)  # D=1, length 65536
        with self.assertRaises(zpack.FormatError):
            zpack.decompress(blob)

    def test_truncated_entry_rejected(self):
        with self.assertRaises(zpack.FormatError):
            zpack.decompress(b"\x01\x05ab")  # declares 5 bytes, provides 2

    def test_truncated_stream_rejected(self):
        with self.assertRaises(zpack.FormatError):
            zpack.decompress(b"")
        with self.assertRaises(zpack.FormatError):
            zpack.decompress(b"\x02")  # D=2 but no entries follow


class BudgetTests(unittest.TestCase):
    def test_declared_limit_exceeded(self):
        blob = zpack.compress(b"hello world")  # 11 literal bytes, no dictionary
        _, tokens = parse_blob(blob)
        self.assertEqual(len(tokens), 11)
        with self.assertRaises(zpack.BudgetError):
            zpack.decompress(blob, max_output=10)
        self.assertEqual(zpack.decompress(blob, max_output=11), b"hello world")

    def test_bomb_aborts_before_writing(self):
        # tiny input, huge expansion: one 100-byte entry referenced 50 times
        entry = b"x" * 100
        blob = b"\x01" + zpack.encode_varint(len(entry)) + entry + bytes([128] * 50)
        self.assertEqual(zpack.decompress(blob, max_output=5000), entry * 50)
        with self.assertRaises(zpack.BudgetError):
            zpack.decompress(blob, max_output=4999)

    def test_budget_error_carries_no_output(self):
        blob = zpack.compress(b"hello world")
        try:
            zpack.decompress(blob, max_output=10)
        except zpack.BudgetError:
            pass
        else:
            self.fail("expected BudgetError")
        # decompress returned nothing; nothing to write


class OptimalParseTests(unittest.TestCase):
    def test_random_samples_against_brute_force(self):
        rng = random.Random(20261001)
        for trial in range(300):
            n = rng.randrange(0, 121)
            alphabet = rng.choice((2, 3, 4, 16, 256))
            data = bytes(rng.randrange(alphabet) for _ in range(n))
            blob = zpack.compress(data)
            entries, tokens = parse_blob(blob)
            expected = brute_force_tokens(data, entries)
            self.assertEqual(
                tokens,
                expected,
                "trial %d: token sequence is not the canonical shortest one"
                % trial,
            )
            self.assertEqual(zpack.decompress(blob), data)

    def test_structured_samples_against_brute_force(self):
        samples = [
            b"a" * 120,
            b"ab" * 60,
            b"abc" * 40,
            b"the quick brown fox jumps over the lazy dog" * 2,
            bytes(range(120)),
            b"\x00" * 120,
        ]
        for data in samples:
            blob = zpack.compress(data)
            entries, tokens = parse_blob(blob)
            self.assertEqual(tokens, brute_force_tokens(data, entries))
            self.assertEqual(zpack.decompress(blob), data)

    def test_tie_break_prefers_smallest_index(self):
        # "aa" and "ab" both optimal at position 0 of "aab"; the reference
        # with the smaller dictionary index must win.
        data = b"aab" * 30
        blob = zpack.compress(data)
        entries, tokens = parse_blob(blob)
        self.assertEqual(tokens, brute_force_tokens(data, entries))
        self.assertEqual(zpack.decompress(blob), data)

    def test_high_bytes_encoded_via_dictionary(self):
        # literal tokens only cover 0..127; bytes >= 128 must be encoded
        # through (single-byte) dictionary entries
        data = bytes(range(256))
        blob = zpack.compress(data)
        entries, tokens = parse_blob(blob)
        self.assertEqual(zpack.decompress(blob), data)
        high = {b for b in data if b >= 128}
        self.assertTrue({e[0] for e in entries if len(e) == 1} >= high)
        self.assertEqual(tokens, brute_force_tokens(data, entries))


class CliTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "zpack", *args],
            cwd=ROOT,
            capture_output=True,
        )

    def test_cli_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.bin")
            packed = os.path.join(tmp, "out.zp")
            back = os.path.join(tmp, "back.bin")
            payload = (b"abc" * 500) + os.urandom(1000)
            with open(src, "wb") as handle:
                handle.write(payload)
            result = self.run_cli("compress", src, packed)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = self.run_cli("decompress", packed, back)
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(back, "rb") as handle:
                self.assertEqual(handle.read(), payload)

    def test_cli_roundtrip_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "empty.bin")
            packed = os.path.join(tmp, "empty.zp")
            back = os.path.join(tmp, "empty.out")
            open(src, "wb").close()
            self.assertEqual(self.run_cli("compress", src, packed).returncode, 0)
            self.assertEqual(self.run_cli("decompress", packed, back).returncode, 0)
            self.assertEqual(os.path.getsize(back), 0)

    def test_cli_budget_failure_exit6_no_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            packed = os.path.join(tmp, "in.zp")
            out = os.path.join(tmp, "out.bin")
            with open(packed, "wb") as handle:
                handle.write(zpack.compress(b"hello world"))  # 11 bytes decoded
            result = self.run_cli("decompress", "--max-size", "10", packed, out)
            self.assertEqual(result.returncode, 6, result.stderr)
            self.assertFalse(os.path.exists(out), "no output file may be written")

    def test_cli_format_failure_exit6_no_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            packed = os.path.join(tmp, "bad.zp")
            out = os.path.join(tmp, "out.bin")
            with open(packed, "wb") as handle:
                handle.write(b"\x80\x00")  # non-canonical varint
            result = self.run_cli("decompress", packed, out)
            self.assertEqual(result.returncode, 6, result.stderr)
            self.assertFalse(os.path.exists(out))

    def test_cli_missing_input_exit6(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.bin")
            result = self.run_cli("compress", os.path.join(tmp, "nope"), out)
            self.assertEqual(result.returncode, 6)
            self.assertFalse(os.path.exists(out))


if __name__ == "__main__":
    unittest.main()
