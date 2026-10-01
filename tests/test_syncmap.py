"""unittest suite for syncmap."""

from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from syncmap import (
    BLOCK_SIZE,
    ApplyError,
    Manifest,
    PathError,
    apply,
    build_manifest,
    diff,
    find_block_match,
    validate_relpath,
)


def write_file(root, rel, data):
    full = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as fh:
        fh.write(data)


def snapshot(root):
    """Full-content snapshot: {relpath: sha256-of-whole-file}."""
    out = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if rel == ".manifest":
                continue
            with open(full, "rb") as fh:
                out[rel] = hashlib.sha256(fh.read()).hexdigest()
    return out


def blocks_of(data):
    return [data[i:i + BLOCK_SIZE] for i in range(0, len(data), BLOCK_SIZE)]


def brute_force_diff(src_state, dst_state):
    """Independent reference: full-content hashing, O(n^2) block matching."""
    ops = []
    src_blocks = []
    for path in sorted(src_state):
        for idx, blk in enumerate(blocks_of(src_state[path])):
            src_blocks.append((path, idx, zlib.adler32(blk),
                               hashlib.sha256(blk).hexdigest()))
    for path in sorted(set(src_state) - set(dst_state)):
        ops.append({"op": "ADD", "path": path})
    for path in sorted(set(dst_state) - set(src_state)):
        ops.append({"op": "DEL", "path": path})
    for path in sorted(set(src_state) & set(dst_state)):
        if src_state[path] == dst_state[path]:
            continue
        s_blocks = blocks_of(src_state[path])
        d_blocks = blocks_of(dst_state[path])
        changed = []
        for idx, blk in enumerate(d_blocks):
            weak = zlib.adler32(blk)
            strong = hashlib.sha256(blk).hexdigest()
            matched = any(w == weak and s == strong
                          for _p, _i, w, s in src_blocks)
            if not matched:
                changed.append(idx)
        changed.extend(range(len(d_blocks), len(s_blocks)))
        ops.append({"op": "MOD", "path": path, "blocks": sorted(changed)})
    ops.sort(key=lambda o: (o["path"], o["op"]))
    return ops


def materialize(root, state):
    for rel, data in state.items():
        write_file(root, rel, data)


class TempDirsMixin(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="syncmap-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = os.path.join(self.tmp, "src")
        self.dst = os.path.join(self.tmp, "dst")
        os.makedirs(self.src)
        os.makedirs(self.dst)


class AdlerCollisionTest(TempDirsMixin):
    """Two 64 KiB blocks with equal adler32 but different sha256."""

    @staticmethod
    def colliding_blocks():
        # adler32 state: a = 1 + sum(bytes), b accumulates a per byte.
        # All-zero 65536-byte block: a=1, b=65536.
        # block_a flips byte 0, block_b flips byte 65521: both give
        # a=2 and b=65551 (mod 65521) -> same adler32, different sha256.
        block_a = bytearray(BLOCK_SIZE)
        block_a[0] = 1
        block_b = bytearray(BLOCK_SIZE)
        block_b[65521] = 1
        assert zlib.adler32(bytes(block_a)) == zlib.adler32(bytes(block_b))
        assert hashlib.sha256(bytes(block_a)).digest() != \
            hashlib.sha256(bytes(block_b)).digest()
        return bytes(block_a), bytes(block_b)

    def test_adler32_collision_not_misjudged(self):
        block_a, block_b = self.colliding_blocks()
        write_file(self.src, "f", block_b)
        write_file(self.dst, "f", block_a)
        ops = diff(build_manifest(self.src), build_manifest(self.dst))
        # weak checksums collide; strong check must still flag the block
        self.assertEqual(ops, [{"op": "MOD", "path": "f", "blocks": [0]}])

    def test_identical_content_no_ops(self):
        block_a, _ = self.colliding_blocks()
        write_file(self.src, "f", block_a)
        write_file(self.dst, "f", block_a)
        ops = diff(build_manifest(self.src), build_manifest(self.dst))
        self.assertEqual(ops, [])


class TieBreakTest(TempDirsMixin):
    def test_same_content_prefers_lexicographic_path_then_index(self):
        content = b"shared-block-content" * 100
        write_file(self.src, "a/x", content)
        write_file(self.src, "b/y", content)
        manifest = build_manifest(self.src)
        weak = zlib.adler32(content)
        strong = hashlib.sha256(content).hexdigest()
        self.assertEqual(find_block_match(manifest, weak, strong), ("a/x", 0))

    def test_tie_breaks_on_block_index_within_file(self):
        blk = b"z" * BLOCK_SIZE
        write_file(self.src, "a/x", blk + blk)  # same content at index 0 and 1
        manifest = build_manifest(self.src)
        match = find_block_match(manifest, zlib.adler32(blk),
                                 hashlib.sha256(blk).hexdigest())
        self.assertEqual(match, ("a/x", 0))

    def test_no_match_returns_none(self):
        write_file(self.src, "a/x", b"hello")
        manifest = build_manifest(self.src)
        other = b"goodbye"
        self.assertIsNone(find_block_match(
            manifest, zlib.adler32(other), hashlib.sha256(other).hexdigest()))


class DeleteApplyTest(TempDirsMixin):
    def test_delete_source_file_diffs_del_and_apply_converges(self):
        write_file(self.src, "keep", b"keep me")
        write_file(self.src, "gone", b"to be deleted")
        write_file(self.dst, "keep", b"keep me")
        write_file(self.dst, "gone", b"to be deleted")
        os.remove(os.path.join(self.src, "gone"))

        src_manifest = build_manifest(self.src)
        ops = diff(src_manifest, build_manifest(self.dst))
        self.assertEqual(ops, [{"op": "DEL", "path": "gone"}])

        apply(src_manifest, self.src, self.dst)
        self.assertEqual(snapshot(self.dst), snapshot(self.src))
        self.assertFalse(os.path.exists(os.path.join(self.dst, "gone")))
        # target manifest now identical to source manifest
        self.assertEqual(build_manifest(self.dst).to_dict(),
                         src_manifest.to_dict())


class EmptyFileTest(TempDirsMixin):
    def test_empty_file_has_zero_blocks(self):
        write_file(self.src, "empty", b"")
        manifest = build_manifest(self.src)
        entry = manifest.files["empty"]
        self.assertEqual(entry.size, 0)
        self.assertEqual(entry.blocks, ())

    def test_empty_file_roundtrip_apply(self):
        write_file(self.src, "empty", b"")
        src_manifest = build_manifest(self.src)
        ops = diff(src_manifest, build_manifest(self.dst))
        self.assertEqual(ops, [{"op": "ADD", "path": "empty"}])
        apply(src_manifest, self.src, self.dst)
        self.assertEqual(snapshot(self.dst), snapshot(self.src))


class PathErrorTest(unittest.TestCase):
    def test_absolute_path_rejected(self):
        with self.assertRaises(PathError):
            validate_relpath("/etc/passwd")

    def test_dotdot_escape_rejected(self):
        for bad in ("../x", "a/../../b", "..", "a/b/../../../c"):
            with self.assertRaises(PathError, msg=bad):
                validate_relpath(bad)

    def test_non_utf8_rejected(self):
        with self.assertRaises(PathError):
            validate_relpath("bad\udcffname")

    def test_manifest_with_illegal_path_rejected(self):
        data = {
            "format": "syncmap-manifest",
            "version": 1,
            "block_size": BLOCK_SIZE,
            "files": [{"path": "../evil", "size": 0, "mtime_ns": 0,
                       "blocks": []}],
        }
        with self.assertRaises(PathError):
            Manifest.from_dict(data)

    def test_valid_paths_normalized(self):
        self.assertEqual(validate_relpath("a//b/./c"), "a/b/c")
        self.assertEqual(validate_relpath("a/b"), "a/b")


class ModBlocksTest(TempDirsMixin):
    def test_mod_lists_only_changed_blocks(self):
        blk = lambda tag: (tag * BLOCK_SIZE)[:BLOCK_SIZE]
        write_file(self.src, "f", blk(b"a") + blk(b"B") + blk(b"c"))
        write_file(self.dst, "f", blk(b"a") + blk(b"b") + blk(b"c"))
        ops = diff(build_manifest(self.src), build_manifest(self.dst))
        self.assertEqual(ops, [{"op": "MOD", "path": "f", "blocks": [1]}])

    def test_mod_growth_lists_new_block_numbers(self):
        blk = lambda tag: (tag * BLOCK_SIZE)[:BLOCK_SIZE]
        write_file(self.src, "f", blk(b"a") + blk(b"b"))
        write_file(self.dst, "f", blk(b"a"))
        ops = diff(build_manifest(self.src), build_manifest(self.dst))
        self.assertEqual(ops, [{"op": "MOD", "path": "f", "blocks": [1]}])

    def test_mod_shrink_lists_dropped_block_numbers(self):
        blk = lambda tag: (tag * BLOCK_SIZE)[:BLOCK_SIZE]
        write_file(self.src, "f", blk(b"a"))
        write_file(self.dst, "f", blk(b"a") + blk(b"b"))
        ops = diff(build_manifest(self.src), build_manifest(self.dst))
        self.assertEqual(ops, [{"op": "MOD", "path": "f", "blocks": [1]}])


class ApplyAtomicityTest(TempDirsMixin):
    def test_failed_apply_leaves_target_untouched(self):
        write_file(self.src, "f", b"new content")
        write_file(self.dst, "f", b"old content")
        write_file(self.dst, "extra", b"stays")
        manifest = build_manifest(self.src)
        before = snapshot(self.dst)
        # corrupt the source after the manifest was built
        write_file(self.src, "f", b"tampered content")
        with self.assertRaises(ApplyError):
            apply(manifest, self.src, self.dst)
        self.assertEqual(snapshot(self.dst), before)
        # no staging directories left behind
        leftovers = [n for n in os.listdir(self.dst) if n.startswith(".syncmap-tmp-")]
        self.assertEqual(leftovers, [])

    def test_apply_is_idempotent(self):
        write_file(self.src, "d/f", b"data" * 1000)
        manifest = build_manifest(self.src)
        apply(manifest, self.src, self.dst)
        first = snapshot(self.dst)
        apply(manifest, self.src, self.dst)
        self.assertEqual(snapshot(self.dst), first)
        self.assertEqual(diff(manifest, build_manifest(self.dst)), [])


class BruteForceReferenceTest(TempDirsMixin):
    """Random workloads (<=20 files, <=5 blocks each) vs brute-force reference."""

    def make_random_state(self, rng, block_pool, n_files):
        state = {}
        dirs = ["", "a", "b", "a/x", "b/y", "c/d/e"]
        for i in range(rng.randint(0, n_files)):
            d = rng.choice(dirs)
            name = f"f{rng.randint(0, 8)}"
            rel = f"{d}/{name}" if d else name
            n_blocks = rng.randint(0, 5)
            parts = []
            for _ in range(n_blocks):
                blk = bytearray(rng.choice(block_pool))
                if rng.random() < 0.3:  # partial last block
                    blk = blk[:rng.randint(1, BLOCK_SIZE)]
                parts.append(bytes(blk))
            state[rel] = b"".join(parts)
        return state

    def mutate(self, rng, state, block_pool):
        state = dict(state)
        for _ in range(rng.randint(1, 4)):
            action = rng.choice(["del", "add", "mod", "shuffle"])
            if action == "del" and state:
                del state[rng.choice(list(state))]
            elif action == "add":
                state[f"new{rng.randint(0, 5)}"] = rng.choice(block_pool)
            elif action == "mod" and state:
                path = rng.choice(list(state))
                blocks = blocks_of(state[path])
                if blocks:
                    idx = rng.randrange(len(blocks))
                    blocks[idx] = rng.choice(block_pool)
                    state[path] = b"".join(blocks)
            elif action == "shuffle" and state:
                path = rng.choice(list(state))
                blocks = blocks_of(state[path])
                rng.shuffle(blocks)
                state[path] = b"".join(blocks)
        return state

    def test_against_brute_force_reference(self):
        rng = random.Random(20261001)
        block_pool = [
            bytes(rng.getrandbits(8) for _ in range(BLOCK_SIZE))
            for _ in range(6)
        ]
        block_pool.append(b"\x00" * BLOCK_SIZE)
        for round_no in range(8):
            with self.subTest(round=round_no):
                src_state = self.make_random_state(rng, block_pool, 20)
                dst_state = self.mutate(rng, src_state, block_pool)
                dst_state = self.mutate(rng, dst_state, block_pool)
                shutil.rmtree(self.src)
                shutil.rmtree(self.dst)
                os.makedirs(self.src)
                os.makedirs(self.dst)
                materialize(self.src, src_state)
                materialize(self.dst, dst_state)

                src_manifest = build_manifest(self.src)
                ops = diff(src_manifest, build_manifest(self.dst))
                expected = brute_force_diff(src_state, dst_state)
                self.assertEqual(ops, expected)

                apply(src_manifest, self.src, self.dst)
                self.assertEqual(snapshot(self.dst), snapshot(self.src))
                self.assertEqual(
                    {p: hashlib.sha256(b).hexdigest()
                     for p, b in sorted(src_state.items())},
                    snapshot(self.dst),
                )


class ManifestRoundTripTest(TempDirsMixin):
    def test_json_roundtrip(self):
        write_file(self.src, "a/x", b"payload" * 10000)
        write_file(self.src, "empty", b"")
        manifest = build_manifest(self.src)
        clone = Manifest.from_json(manifest.to_json())
        self.assertEqual(clone.to_dict(), manifest.to_dict())
        entry = clone.files["a/x"]
        self.assertIsInstance(entry.mtime_ns, int)
        self.assertEqual(len(entry.blocks), 2)  # 70000 bytes -> 2 blocks


class CliTest(TempDirsMixin):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "syncmap", *argv],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            capture_output=True, text=True,
        )

    def test_manifest_diff_apply_flow(self):
        write_file(self.src, "a/x", b"hello" * 20000)
        write_file(self.dst, "a/x", b"hello" * 20000)
        write_file(self.dst, "old", b"obsolete")

        result = self.run_cli("manifest", self.src)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.src, ".manifest")))

        result = self.run_cli("diff", self.src, self.dst)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DEL old", result.stdout)

        result = self.run_cli(
            "apply", os.path.join(self.src, ".manifest"), self.src, self.dst)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(snapshot(self.dst), snapshot(self.src))

    def test_diff_json_output(self):
        write_file(self.src, "f", b"x")
        result = self.run_cli("diff", "--json", self.src, self.dst)
        # argparse: --json must come after subcommand args? both work; check
        if result.returncode != 0:
            result = self.run_cli("diff", self.src, self.dst, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        ops = json.loads(result.stdout)
        self.assertEqual(ops, [{"op": "ADD", "path": "f"}])


if __name__ == "__main__":
    unittest.main()
