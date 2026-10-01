import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from dpcore import COPY_COST, compute_ops, make_patch

HERE = os.path.dirname(os.path.abspath(__file__))
DELTA = os.path.join(HERE, "delta.py")
PATCH = os.path.join(HERE, "patch.py")


def run_cli(script, *args):
    return subprocess.run(
        [sys.executable, script, *args],
        capture_output=True,
        text=True,
    )


def ops_cost(ops):
    return sum(len(op[1]) if op[0] == "lit" else COPY_COST for op in ops)


def brute_force_ops(source, target):
    """Independent enumeration of every edge sequence rebuilding target.

    Edges: a single literal byte (cost 1), or a copy of any length >= 1
    whose bytes occur in source (cost COPY_COST, smallest source offset).
    Returns (ops, cost) with ops merged like compute_ops, choosing the
    sequence that is minimal under: total cost, then edge keys compared
    from the last edge backwards (literal < copy, then smaller source
    offset, then longer copy).
    """
    n = len(target)
    best_key = None
    best_edges = None

    def edge_key(edge):
        if edge[0] == "lit":
            return (0,)
        return (1, edge[1], -edge[2])

    def rec(i, cost, edges):
        nonlocal best_key, best_edges
        if best_key is not None and cost > best_key[0]:
            return
        if i == n:
            key = (cost, tuple(edge_key(edge) for edge in reversed(edges)))
            if best_key is None or key < best_key:
                best_key = key
                best_edges = list(edges)
            return
        rec(i + 1, cost + 1, edges + [("lit", target[i : i + 1])])
        for j in range(i + 1, n + 1):
            segment = target[i:j]
            offset = source.find(segment)
            if offset >= 0:
                rec(j, cost + COPY_COST, edges + [("copy", offset, j - i)])

    rec(0, 0, [])
    merged = []
    for edge in best_edges:
        if edge[0] == "lit" and merged and merged[-1][0] == "lit":
            merged[-1] = ("lit", merged[-1][1] + edge[1])
        else:
            merged.append(edge)
    return merged, best_key[0]


class DeltaEncodingTests(unittest.TestCase):
    def test_repeated_long_string_uses_copy_and_beats_literals(self):
        block = b"abc123" * 40
        source = b"\x00HEADER" + block + b"\xffTAIL"
        target = block
        ops, cost = compute_ops(source, target)
        self.assertTrue(any(op[0] == "copy" for op in ops))
        self.assertLess(cost, len(target))
        self.assertEqual(ops_cost(ops), cost)

    def test_short_unique_string_uses_no_copy(self):
        for source, target in [
            (b"z", b"z"),
            (b"ab", b"ab"),
            (b"xy", b"x"),
            (b"hello world", b"lo"),
        ]:
            ops, cost = compute_ops(source, target)
            self.assertEqual(ops, [("lit", target)])
            self.assertEqual(cost, len(target))

    def test_empty_target(self):
        ops, cost = compute_ops(b"anything", b"")
        self.assertEqual(ops, [])
        self.assertEqual(cost, 0)

    def test_tiebreak_prefers_earlier_offset_then_longer_copy(self):
        # "aaaa" occurs at offsets 0,1,2; copy must pick offset 0.
        ops, cost = compute_ops(b"aaaa", b"aaaa")
        self.assertEqual(ops, [("copy", 0, 4)])
        self.assertEqual(cost, COPY_COST)
        # Two equal-cost copies of different lengths ending at the same
        # position: the longer one wins (offset tie).
        source = b"abcabc"
        target = b"abcabc"
        ops, cost = compute_ops(source, target)
        self.assertEqual(ops, [("copy", 0, 6)])

    def test_bruteforce_small_targets(self):
        cases = [
            (b"", b""),
            (b"", b"abc"),
            (b"a", b"a"),
            (b"ab", b"ab"),
            (b"ababab", b"abab"),
            (b"abcabc", b"abcabcab"),
            (b"\x00\x01\x02\x00\x01\x02", b"\x00\x01\x02\x00"),
            (b"mississippi", b"issip"),
        ]
        rng = random.Random(20261001)
        for _ in range(40):
            alphabet = bytes(range(rng.randint(1, 3)))
            source = bytes(rng.choice(alphabet) for _ in range(rng.randint(0, 12)))
            target = bytes(rng.choice(alphabet) for _ in range(rng.randint(0, 10)))
            cases.append((source, target))
        for source, target in cases:
            self.assertLessEqual(len(target), 10)
            with self.subTest(source=source, target=target):
                expected_ops, expected_cost = brute_force_ops(source, target)
                ops, cost = compute_ops(source, target)
                self.assertEqual(cost, expected_cost)
                self.assertEqual(ops, expected_ops)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.source_path = os.path.join(self.dir, "source.bin")
        self.target_path = os.path.join(self.dir, "target.bin")
        self.patch_path = os.path.join(self.dir, "patch.json")
        self.out_path = os.path.join(self.dir, "out.bin")
        self.source = b"\x00prefix" + b"the quick brown fox " * 8 + b"suffix\xff"
        self.target = b"the quick brown fox " * 4 + b"NEW!" + b"the quick brown fox " * 4
        with open(self.source_path, "wb") as fh:
            fh.write(self.source)
        with open(self.target_path, "wb") as fh:
            fh.write(self.target)

    def tearDown(self):
        self.tmp.cleanup()

    def make_patch_file(self, patch_doc=None):
        if patch_doc is None:
            result = run_cli(DELTA, self.source_path, self.target_path, self.patch_path)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            with open(self.patch_path, "w", encoding="utf-8") as fh:
                fh.write(patch_doc if isinstance(patch_doc, str) else json.dumps(patch_doc))
        with open(self.patch_path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def write_patch(self, doc):
        with open(self.patch_path, "w", encoding="utf-8") as fh:
            fh.write(doc if isinstance(doc, str) else json.dumps(doc))

    def assert_rejected(self):
        with open(self.out_path, "wb") as fh:
            fh.write(b"stale output")
        result = run_cli(PATCH, self.source_path, self.patch_path, self.out_path)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(os.path.exists(self.out_path))

    def test_roundtrip(self):
        patch_doc = self.make_patch_file()
        self.assertTrue(any("copy" in op for op in patch_doc["ops"]))
        literal_cost = len(self.target)
        patch_cost = sum(
            len(__import__("base64").b64decode(op["lit"])) if "lit" in op else 2
            for op in patch_doc["ops"]
        )
        self.assertLess(patch_cost, literal_cost)
        result = run_cli(PATCH, self.source_path, self.patch_path, self.out_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.out_path, "rb") as fh:
            self.assertEqual(fh.read(), self.target)

    def test_wrong_target_hash_rejected(self):
        patch_doc = self.make_patch_file()
        patch_doc["target_sha256"] = "0" * 64
        self.write_patch(patch_doc)
        self.assert_rejected()

    def test_wrong_source_hash_rejected(self):
        patch_doc = self.make_patch_file()
        patch_doc["source_sha256"] = "f" * 64
        self.write_patch(patch_doc)
        self.assert_rejected()

    def test_invalid_json_rejected(self):
        self.write_patch("{not valid json")
        self.assert_rejected()

    def test_unknown_op_type_rejected(self):
        patch_doc = self.make_patch_file()
        patch_doc["ops"] = [{"jump": [0, 1]}]
        self.write_patch(patch_doc)
        self.assert_rejected()

    def test_copy_out_of_bounds_rejected(self):
        patch_doc = self.make_patch_file()
        patch_doc["ops"] = [{"copy": [len(self.source) - 1, 2]}]
        self.write_patch(patch_doc)
        self.assert_rejected()

    def test_copy_bad_shape_rejected(self):
        patch_doc = self.make_patch_file()
        patch_doc["ops"] = [{"copy": [0]}]
        self.write_patch(patch_doc)
        self.assert_rejected()

    def test_bad_base64_rejected(self):
        patch_doc = self.make_patch_file()
        patch_doc["ops"] = [{"lit": "!!!not-base64!!!"}]
        self.write_patch(patch_doc)
        self.assert_rejected()

    def test_tampered_ops_fail_target_hash(self):
        patch_doc = self.make_patch_file()
        patch_doc["ops"] = [{"lit": "QQ=="}]  # b"A", hashes no longer match
        self.write_patch(patch_doc)
        self.assert_rejected()


if __name__ == "__main__":
    unittest.main()
