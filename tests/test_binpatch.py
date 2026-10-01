import hashlib
import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from functools import lru_cache

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from binpatch.core import (  # noqa: E402
    COPY_COST,
    apply_patch,
    compute_ops,
    dumps_patch,
    sha256_hex,
)

DELTA = os.path.join(ROOT, "delta")
PATCH = os.path.join(ROOT, "patch")


def run_cli(script, *args):
    return subprocess.run(
        [sys.executable, script, *args],
        capture_output=True,
        text=True,
    )


def op_key(op):
    if op[0] == "lit":
        return (0,)
    return (1, op[1], -op[2])


def seq_key(ops):
    return tuple(op_key(op) for op in reversed(ops))


def enumerate_best(source, target):
    """Independent cross-check: enumerate every split of the target into
    literal/copy ops and keep the best by (cost, deterministic tie key).
    Only practical for tiny targets (used here for <= 10 bytes)."""

    @lru_cache(maxsize=None)
    def best(i):
        if i == 0:
            return (0, ())
        prev_cost, prev_ops = best(i - 1)
        result = (prev_cost + 1, prev_ops + (("lit", target[i - 1]),))
        result_key = (result[0], seq_key(result[1]))
        length = 1
        while length <= i:
            segment = target[i - length:i]
            offset = source.find(segment)
            if offset == -1:
                break
            while offset != -1:
                sub_cost, sub_ops = best(i - length)
                cand = (sub_cost + COPY_COST, sub_ops + (("copy", offset, length),))
                cand_key = (cand[0], seq_key(cand[1]))
                if cand_key < result_key:
                    result, result_key = cand, cand_key
                offset = source.find(segment, offset + 1)
            length += 1
        return result

    return best(len(target))


def json_cost(patch_obj):
    cost = 0
    for op in patch_obj["ops"]:
        cost += 1 if "lit" in op else COPY_COST
    return cost


class DeltaCostTests(unittest.TestCase):
    def test_repeated_long_string_generates_copy_and_beats_literal(self):
        block = bytes((i * 37 + 11) % 256 for i in range(256))
        source = block * 4
        target = block * 10
        ops, cost = compute_ops(source, target)
        self.assertTrue(any(op[0] == "copy" for op in ops))
        self.assertLess(cost, len(target))
        self.assertEqual(cost, 6)
        self.assertEqual(
            ops,
            [("copy", 0, 512), ("copy", 0, 1024), ("copy", 0, 1024)],
        )
        text = dumps_patch(source, target, ops)
        self.assertEqual(apply_patch(source, text), target)

    def test_short_unique_string_uses_no_unprofitable_copy(self):
        source = b"the quick brown fox jumps"
        for target in (b"t", b"qu", b"xy", b"qk"):
            ops, cost = compute_ops(source, target)
            self.assertEqual(cost, len(target), target)
            self.assertEqual(ops, [("lit", b) for b in target], target)

    def test_profitable_copy_used_even_when_substring_occurs_once(self):
        source = b"the quick brown fox jumps"
        ops, cost = compute_ops(source, b"qui")
        self.assertEqual(ops, [("copy", 4, 3)])
        self.assertEqual(cost, 2)

    def test_tie_break_prefers_earlier_source_offset(self):
        ops, cost = compute_ops(b"abcXabc", b"abc")
        self.assertEqual(ops, [("copy", 0, 3)])
        self.assertEqual(cost, 2)

    def test_tie_break_prefers_literal_over_break_even_copy(self):
        ops, cost = compute_ops(b"ab", b"ab")
        self.assertEqual(ops, [("lit", ord("a")), ("lit", ord("b"))])
        self.assertEqual(cost, 2)

    def test_empty_target(self):
        ops, cost = compute_ops(b"source", b"")
        self.assertEqual(ops, [])
        self.assertEqual(cost, 0)


class EnumerationCrossCheckTests(unittest.TestCase):
    def check(self, source, target):
        ops, cost = compute_ops(source, target)
        enum_cost, enum_ops = enumerate_best(source, target)
        self.assertEqual(cost, enum_cost, (source, target))
        self.assertEqual(tuple(ops), enum_ops, (source, target))

    def test_exhaustive_binary_alphabet(self):
        sources = [
            bytes(bits)
            for n in range(0, 5)
            for bits in itertools.product(b"ab", repeat=n)
        ]
        targets = [
            bytes(bits)
            for n in range(0, 8)
            for bits in itertools.product(b"ab", repeat=n)
        ]
        for source in sources:
            for target in targets:
                self.check(source, target)

    def test_random_targets_up_to_ten_bytes(self):
        rng = random.Random(20261001)
        for _ in range(300):
            source = bytes(rng.choice(b"abc") for _ in range(rng.randrange(0, 13)))
            target = bytes(rng.choice(b"abc") for _ in range(rng.randrange(0, 11)))
            self.check(source, target)

    def test_random_binary_targets_exactly_ten_bytes(self):
        rng = random.Random(7)
        for _ in range(200):
            source = bytes(rng.choice(b"ab") for _ in range(rng.randrange(0, 13)))
            target = bytes(rng.choice(b"ab") for _ in range(10))
            self.check(source, target)


class PatchValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name
        self.source = b"hello world, hello world, hello"
        self.target = b"hello hello world!"
        self.source_path = self._write("source.bin", self.source)
        self.out_path = os.path.join(self.dir, "out.bin")

    def _write(self, name, data):
        path = os.path.join(self.dir, name)
        mode = "wb" if isinstance(data, bytes) else "w"
        with open(path, mode) as fh:
            fh.write(data)
        return path

    def _valid_patch_text(self):
        ops, _ = compute_ops(self.source, self.target)
        return dumps_patch(self.source, self.target, ops)

    def _run_patch(self, patch_text):
        patch_path = self._write("patch.json", patch_text)
        return run_cli(PATCH, self.source_path, patch_path, self.out_path)

    def _assert_rejected(self, result):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(os.path.exists(self.out_path))

    def test_successful_apply_exit_zero(self):
        result = self._run_patch(self._valid_patch_text())
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.out_path, "rb") as fh:
            self.assertEqual(fh.read(), self.target)

    def test_target_hash_mismatch_rejected_and_output_removed(self):
        obj = json.loads(self._valid_patch_text())
        obj["target_sha256"] = hashlib.sha256(b"something else").hexdigest()
        self._write("out.bin", b"pre-existing junk")
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)

    def test_source_hash_mismatch_rejected(self):
        obj = json.loads(self._valid_patch_text())
        obj["source_sha256"] = hashlib.sha256(b"other source").hexdigest()
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)

    def test_invalid_json_rejected(self):
        result = self._run_patch("{not valid json")
        self._assert_rejected(result)

    def test_non_object_json_rejected(self):
        result = self._run_patch("[1, 2, 3]")
        self._assert_rejected(result)

    def test_unknown_op_type_rejected(self):
        obj = json.loads(self._valid_patch_text())
        obj["ops"] = [{"move": [0, 1]}]
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)

    def test_copy_out_of_bounds_rejected(self):
        obj = json.loads(self._valid_patch_text())
        obj["ops"] = [{"copy": [0, len(self.source) + 1]}]
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)

    def test_copy_zero_length_rejected(self):
        obj = json.loads(self._valid_patch_text())
        obj["ops"] = [{"copy": [0, 0]}]
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)

    def test_copy_negative_offset_rejected(self):
        obj = json.loads(self._valid_patch_text())
        obj["ops"] = [{"copy": [-1, 2]}]
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)

    def test_invalid_base64_rejected(self):
        obj = json.loads(self._valid_patch_text())
        obj["ops"] = [{"lit": "!!!not-base64!!!"}]
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)

    def test_empty_literal_rejected(self):
        obj = json.loads(self._valid_patch_text())
        obj["ops"] = [{"lit": ""}]
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)

    def test_op_with_multiple_keys_rejected(self):
        obj = json.loads(self._valid_patch_text())
        obj["ops"] = [{"lit": "aQ==", "copy": [0, 1]}]
        result = self._run_patch(json.dumps(obj))
        self._assert_rejected(result)


class CliEndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def _write(self, name, data):
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def test_delta_then_patch_roundtrip(self):
        block = bytes((i * 37 + 11) % 256 for i in range(256))
        source = block * 4
        target = block * 10
        source_path = self._write("source.bin", source)
        target_path = self._write("target.bin", target)
        patch_path = os.path.join(self.dir, "patch.json")
        out_path = os.path.join(self.dir, "out.bin")

        result = run_cli(DELTA, source_path, target_path, patch_path)
        self.assertEqual(result.returncode, 0, result.stderr)

        with open(patch_path, "r", encoding="utf-8") as fh:
            obj = json.load(fh)
        self.assertEqual(obj["source_sha256"], sha256_hex(source))
        self.assertEqual(obj["target_sha256"], sha256_hex(target))
        self.assertTrue(any("copy" in op for op in obj["ops"]))
        self.assertLess(json_cost(obj), len(target))

        result = run_cli(PATCH, source_path, patch_path, out_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(out_path, "rb") as fh:
            self.assertEqual(fh.read(), target)

    def test_roundtrip_empty_files(self):
        source_path = self._write("source.bin", b"")
        target_path = self._write("target.bin", b"")
        patch_path = os.path.join(self.dir, "patch.json")
        out_path = os.path.join(self.dir, "out.bin")
        self.assertEqual(run_cli(DELTA, source_path, target_path, patch_path).returncode, 0)
        self.assertEqual(run_cli(PATCH, source_path, patch_path, out_path).returncode, 0)
        with open(out_path, "rb") as fh:
            self.assertEqual(fh.read(), b"")

    def test_roundtrip_random_binary(self):
        rng = random.Random(99)
        source = bytes(rng.randrange(256) for _ in range(3000))
        target = source[100:1500] + bytes(rng.randrange(256) for _ in range(50)) + source
        source_path = self._write("source.bin", source)
        target_path = self._write("target.bin", target)
        patch_path = os.path.join(self.dir, "patch.json")
        out_path = os.path.join(self.dir, "out.bin")
        self.assertEqual(run_cli(DELTA, source_path, target_path, patch_path).returncode, 0)
        result = run_cli(PATCH, source_path, patch_path, out_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(out_path, "rb") as fh:
            self.assertEqual(fh.read(), target)

    def test_delta_wrong_arg_count_exit_2(self):
        self.assertEqual(run_cli(DELTA, "a", "b").returncode, 2)

    def test_patch_wrong_arg_count_exit_2(self):
        self.assertEqual(run_cli(PATCH, "a").returncode, 2)

    def test_delta_missing_input_exit_2(self):
        missing = os.path.join(self.dir, "missing.bin")
        target_path = self._write("target.bin", b"x")
        patch_path = os.path.join(self.dir, "patch.json")
        result = run_cli(DELTA, missing, target_path, patch_path)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(os.path.exists(patch_path))


if __name__ == "__main__":
    unittest.main()
