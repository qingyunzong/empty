import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from syncmap import (  # noqa: E402
    BLOCK_SIZE,
    MANIFEST_NAME,
    ApplyError,
    Manifest,
    PathError,
    SourceIndex,
    apply,
    build_manifest,
    diff,
    hash_block,
    load_manifest,
    validate_relpath,
    write_manifest,
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def chunks(data: bytes):
    return [data[i : i + BLOCK_SIZE] for i in range(0, len(data), BLOCK_SIZE)]


def write_tree(root: Path, tree: dict) -> None:
    for rel, data in tree.items():
        full = root.joinpath(*rel.split("/"))
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(data)


def snapshot(root: Path) -> dict:
    out = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = Path(dirpath) / name
            rel = full.relative_to(root).as_posix()
            out[rel] = sha(full.read_bytes())
    return out


def ref_diff(src: dict, tgt: dict):
    """Brute-force reference: full-content hashing, no weak checksums."""
    src_sha_locs = {}
    for path in sorted(src):
        for idx, chunk in enumerate(chunks(src[path])):
            src_sha_locs.setdefault(sha(chunk), []).append((path, idx))

    adds = sorted(set(src) - set(tgt))
    dels = sorted(set(tgt) - set(src))
    mods = {}
    for path in sorted(set(src) & set(tgt)):
        if src[path] == tgt[path]:
            continue
        changed, matched = [], {}
        for idx, chunk in enumerate(chunks(tgt[path])):
            locs = src_sha_locs.get(sha(chunk))
            if locs is None:
                changed.append(idx)
            else:
                matched[idx] = min(locs)
        mods[path] = (changed, matched)
    return adds, dels, mods


class TestPathValidation(unittest.TestCase):
    def test_valid_paths(self):
        for path in ["a", "a/b/c", "a b/é.txt", "x" * 64, ".hidden/f"]:
            self.assertEqual(validate_relpath(path), path)

    def test_invalid_paths(self):
        for bad in [
            "",
            "/abs/path",
            "../escape",
            "a/../../b",
            "a/..",
            "a//b",
            "a/./b",
            "a/",
            "/",
            "nul\x00byte",
            None,
            123,
        ]:
            with self.assertRaises(PathError, msg=repr(bad)):
                validate_relpath(bad)

    def test_manifest_with_bad_path_raises(self):
        data = {
            "version": 1,
            "block_size": BLOCK_SIZE,
            "files": {"../evil": {"size": 0, "mtime_ns": 0, "blocks": []}},
        }
        with self.assertRaises(PathError):
            Manifest.from_dict(data)
        data["files"] = {"/abs": {"size": 0, "mtime_ns": 0, "blocks": []}}
        with self.assertRaises(PathError):
            Manifest.from_dict(data)


class TestManifest(unittest.TestCase):
    def test_empty_file_has_zero_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "empty").write_bytes(b"")
            (root / "one").write_bytes(b"x")
            manifest = build_manifest(root)
            self.assertEqual(manifest.files["empty"].blocks, ())
            self.assertEqual(manifest.files["empty"].size, 0)
            self.assertEqual(len(manifest.files["one"].blocks), 1)

    def test_block_boundaries(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            data = os.urandom(2 * BLOCK_SIZE + 1)
            (root / "f").write_bytes(data)
            manifest = build_manifest(root)
            entry = manifest.files["f"]
            self.assertEqual(len(entry.blocks), 3)
            for idx, chunk in enumerate(chunks(data)):
                self.assertEqual(entry.blocks[idx].adler32, zlib.adler32(chunk))
                self.assertEqual(entry.blocks[idx].sha256, sha(chunk))

    def test_roundtrip_and_manifest_excluded(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            write_tree(root, {"a/x": b"hello", "b": b""})
            manifest = build_manifest(root)
            write_manifest(manifest, root / MANIFEST_NAME)
            loaded = load_manifest(root / MANIFEST_NAME)
            self.assertEqual(manifest.to_dict(), loaded.to_dict())
            again = build_manifest(root)
            self.assertNotIn(MANIFEST_NAME, again.files)
            self.assertEqual(set(again.files), {"a/x", "b"})


class TestWeakCollision(unittest.TestCase):
    """Two distinct 64 KiB blocks with identical adler32."""

    @classmethod
    def setUpClass(cls):
        cls.block_a = b"\x00" * 65521 + b"\x01" + b"\x00" * 14
        cls.block_b = b"\x01" + b"\x00" * 65535
        assert len(cls.block_a) == len(cls.block_b) == BLOCK_SIZE

    def test_construction_is_a_real_adler32_collision(self):
        self.assertEqual(zlib.adler32(self.block_a), zlib.adler32(self.block_b))
        self.assertNotEqual(sha(self.block_a), sha(self.block_b))

    def test_collision_not_misjudged(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            src, tgt = base / "src", base / "tgt"
            src.mkdir(), tgt.mkdir()
            (src / "f").write_bytes(self.block_b)
            (tgt / "f").write_bytes(self.block_a)
            ops = diff(build_manifest(src), build_manifest(tgt))
            self.assertEqual(len(ops), 1)
            op = ops[0]
            self.assertEqual(op.kind, "MOD")
            self.assertEqual(op.path, "f")
            # Weak checksums collide; the strong check must still flag block 0.
            self.assertEqual(op.changed_blocks, (0,))
            self.assertEqual(op.matched, {})

    def test_match_requires_strong_equality(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td)
            (src / "f").write_bytes(self.block_b)
            index = SourceIndex(build_manifest(src))
            self.assertIsNone(index.match(hash_block(self.block_a)))
            self.assertEqual(index.match(hash_block(self.block_b)), ("f", 0))


class TestTieBreak(unittest.TestCase):
    def test_equal_strong_blocks_pick_smallest_path_then_index(self):
        shared = os.urandom(BLOCK_SIZE)
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            src, tgt = base / "src", base / "tgt"
            write_tree(
                src,
                {
                    "b/y": shared + b"tail-b",
                    "a/x": shared,  # same block content, smaller path
                    "c/z": shared + b"src-tail",
                },
            )
            write_tree(tgt, {"c/z": shared + b"tgt-tail"})
            ops = diff(build_manifest(src), build_manifest(tgt))
            mod = [op for op in ops if op.kind == "MOD" and op.path == "c/z"]
            self.assertEqual(len(mod), 1)
            # Block 0 of c/z matches a/x, b/y and c/z in the source; a/x wins.
            self.assertEqual(mod[0].matched[0], ("a/x", 0))
            self.assertEqual(mod[0].changed_blocks, (1,))

    def test_tie_on_path_picks_smallest_block_index(self):
        shared = os.urandom(BLOCK_SIZE)
        with tempfile.TemporaryDirectory() as td:
            src = Path(td)
            (src / "f").write_bytes(shared + shared)
            index = SourceIndex(build_manifest(src))
            self.assertEqual(index.match(hash_block(shared)), ("f", 0))


class TestDeleteAndApply(unittest.TestCase):
    def test_delete_source_file_diff_and_apply(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            src, tgt = base / "src", base / "tgt"
            tree = {"f1": b"one", "dir/f2": os.urandom(BLOCK_SIZE + 7)}
            write_tree(src, tree)
            write_tree(tgt, {**tree, "f3": b"deleted from source"})

            ops = diff(build_manifest(src), build_manifest(tgt))
            kinds = {(op.kind, op.path) for op in ops}
            self.assertIn(("DEL", "f3"), kinds)

            write_manifest(build_manifest(src), src / MANIFEST_NAME)
            apply(src, tgt)
            self.assertEqual(snapshot(src), snapshot(tgt))
            self.assertFalse((tgt / "f3").exists())

    def test_failed_apply_leaves_target_untouched(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            src, tgt = base / "src", base / "tgt"
            write_tree(src, {"f1": b"new content"})
            write_tree(tgt, {"old": b"keep me", "f1": b"old content"})
            before = snapshot(tgt)
            write_manifest(build_manifest(src), src / MANIFEST_NAME)
            # Corrupt the source after the manifest was generated.
            (src / "f1").write_bytes(b"tampered!")
            with self.assertRaises(ApplyError):
                apply(src, tgt)
            self.assertEqual(snapshot(tgt), before)

    def test_apply_into_missing_target(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            src, tgt = base / "src", base / "tgt"
            write_tree(src, {"a/b": b"data", "e": b""})
            write_manifest(build_manifest(src), src / MANIFEST_NAME)
            apply(src, tgt)
            self.assertEqual(snapshot(src), snapshot(tgt))


class TestRandomizedVsReference(unittest.TestCase):
    def _gen_tree(self, rng, max_files=20):
        tree = {}
        for _ in range(rng.randint(0, max_files)):
            depth = rng.randint(0, 2)
            parts = [rng.choice("abcd") for _ in range(depth)]
            parts.append(rng.choice("wxyz") + str(rng.randint(0, 3)))
            path = "/".join(parts)
            size = rng.choice(
                [0, 1, BLOCK_SIZE - 1, BLOCK_SIZE, BLOCK_SIZE + 1,
                 rng.randint(0, 5 * BLOCK_SIZE)]
            )
            tree[path] = rng.randbytes(size)
        return tree

    def _mutate(self, rng, tree):
        tree = dict(tree)
        for path in list(tree):
            roll = rng.random()
            if roll < 0.2:
                del tree[path]
            elif roll < 0.5:
                data = bytearray(tree[path])
                for _ in range(rng.randint(1, 8)):
                    if data:
                        data[rng.randrange(len(data))] = rng.randrange(256)
                if rng.random() < 0.5:
                    del data[rng.randrange(len(data) + 1) :]
                else:
                    data += rng.randbytes(rng.randint(0, BLOCK_SIZE))
                tree[path] = bytes(data[: 5 * BLOCK_SIZE])
        for _ in range(rng.randint(0, 5)):
            if len(tree) >= 20:
                break
            tree.update(self._gen_tree(rng, max_files=2))
        # Occasionally duplicate a block across files to exercise ties.
        if len(tree) < 20 and tree and rng.random() < 0.7:
            donor = rng.choice(list(tree.values()))
            if donor:
                block = chunks(donor)[rng.randrange(len(chunks(donor)))]
                tree["tie/" + rng.choice("mn")] = block + rng.randbytes(10)
        return tree

    def test_against_brute_force_reference(self):
        for seed in range(30):
            rng = random.Random(seed)
            src_tree = self._gen_tree(rng)
            tgt_tree = self._mutate(rng, src_tree)
            self.assertLessEqual(len(src_tree), 20)
            self.assertLessEqual(len(tgt_tree), 20)
            for data in list(src_tree.values()) + list(tgt_tree.values()):
                self.assertLessEqual(len(chunks(data)), 5)

            with tempfile.TemporaryDirectory() as td:
                base = Path(td)
                src, tgt = base / "src", base / "tgt"
                src.mkdir(), tgt.mkdir()
                write_tree(src, src_tree)
                write_tree(tgt, tgt_tree)

                ops = diff(build_manifest(src), build_manifest(tgt))
                adds, dels, mods = ref_diff(src_tree, tgt_tree)

                got_adds = sorted(op.path for op in ops if op.kind == "ADD")
                got_dels = sorted(op.path for op in ops if op.kind == "DEL")
                got_mods = {
                    op.path: (list(op.changed_blocks), op.matched)
                    for op in ops
                    if op.kind == "MOD"
                }
                self.assertEqual(got_adds, adds, f"seed={seed}")
                self.assertEqual(got_dels, dels, f"seed={seed}")
                self.assertEqual(sorted(got_mods), sorted(mods), f"seed={seed}")
                for path, (changed, matched) in mods.items():
                    got_changed, got_matched = got_mods[path]
                    self.assertEqual(got_changed, changed, f"seed={seed} {path}")
                    self.assertEqual(got_matched, matched, f"seed={seed} {path}")

                write_manifest(build_manifest(src), src / MANIFEST_NAME)
                apply(src, tgt)
                self.assertEqual(snapshot(src), snapshot(tgt), f"seed={seed}")


class TestCli(unittest.TestCase):
    def run_cli(self, *args, cwd=None):
        return subprocess.run(
            [sys.executable, "-m", "syncmap", *args],
            capture_output=True,
            text=True,
            cwd=cwd or REPO_ROOT,
        )

    def test_manifest_diff_apply_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            src, tgt = base / "src", base / "tgt"
            write_tree(src, {"keep": b"k", "mod": b"new", "sub/add": b"a"})
            write_tree(tgt, {"keep": b"k", "mod": b"old", "gone": b"g"})

            res = self.run_cli("manifest", str(src))
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertTrue((src / MANIFEST_NAME).is_file())

            res = self.run_cli("diff", str(src), str(tgt))
            self.assertEqual(res.returncode, 0, res.stderr)
            lines = res.stdout.strip().splitlines()
            self.assertIn("ADD sub/add", lines)
            self.assertIn("DEL gone", lines)
            self.assertIn("MOD mod 0", lines)

            res = self.run_cli("apply", str(src), str(tgt))
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(snapshot(src), snapshot(tgt))

            res = self.run_cli("diff", "--exit-code", str(src), str(tgt))
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(res.stdout.strip(), "")

    def test_diff_exit_code_and_bad_dir(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            src, tgt = base / "src", base / "tgt"
            write_tree(src, {"f": b"1"})
            write_tree(tgt, {"f": b"2"})
            res = self.run_cli("diff", "--exit-code", str(src), str(tgt))
            self.assertEqual(res.returncode, 1)
            res = self.run_cli("diff", str(src), str(base / "missing"))
            self.assertEqual(res.returncode, 2)


if __name__ == "__main__":
    unittest.main()
