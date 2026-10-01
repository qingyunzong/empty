"""End-to-end tests for the buildcache CLI (run via subprocess)."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="bc-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = self.tmp / "proj"
        self.root.mkdir()

    # -- helpers -----------------------------------------------------------

    def run_cli(self, *args, env_extra=None):
        env = dict(os.environ)
        env["PYTHONPATH"] = str(REPO_ROOT)
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "buildcache", *args],
            capture_output=True, text=True, env=env,
        )

    def write_manifest(self, targets):
        (self.root / "manifest.json").write_text(json.dumps(targets))

    def write_file(self, rel, content):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def read(self, rel):
        return (self.root / rel).read_text()

    def mtime_ns(self, rel):
        return (self.root / rel).stat().st_mtime_ns

    def state(self):
        return json.loads((self.root / ".buildcache" / "state.json").read_text())

    def build_ok(self):
        r = self.run_cli("build", str(self.root))
        self.assertEqual(r.returncode, 0, r.stderr)
        return r


class TestBasicBuild(CliTestCase):
    def test_build_produces_concatenated_artifacts(self):
        self.write_file("a.txt", "hello ")
        self.write_file("b.txt", "world")
        self.write_manifest({
            "out/gen.txt": {"src": ["a.txt", "b.txt"], "cmd": "echo gen"},
            "out/top.txt": {"src": ["out/gen.txt", "b.txt"], "cmd": "echo top"},
        })
        r = self.build_ok()
        self.assertIn("BUILD out/gen.txt", r.stdout)
        self.assertIn("BUILD out/top.txt", r.stdout)
        self.assertEqual(self.read("out/gen.txt"), "hello world")
        self.assertEqual(self.read("out/top.txt"), "hello worldworld")
        st = self.state()
        self.assertEqual(st["out/gen.txt"]["status"], "OK")
        self.assertEqual(st["out/top.txt"]["status"], "OK")

    def test_scan_reports_dirty_then_up_to_date(self):
        self.write_file("a.txt", "x")
        self.write_manifest({"out.txt": {"src": ["a.txt"], "cmd": "echo"}})
        r = self.run_cli("scan", str(self.root))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("out.txt\tOK\tdirty", r.stdout)
        self.build_ok()
        r = self.run_cli("scan", str(self.root))
        self.assertIn("out.txt\tOK\tup-to-date", r.stdout)


class TestAcceptanceA_UnrelatedChange(CliTestCase):
    def test_unrelated_file_and_mtime_change_do_not_rebuild(self):
        self.write_file("src/in.txt", "data")
        self.write_file("unrelated.txt", "noise")
        self.write_manifest({"out.txt": {"src": ["src/in.txt"], "cmd": "echo"}})
        self.build_ok()
        artifact_mtime = self.mtime_ns("out.txt")
        fingerprint = self.state()["out.txt"]["fingerprint"]

        # Change an unrelated file and only touch the real input's mtime.
        self.write_file("unrelated.txt", "different noise")
        os.utime(self.root / "src/in.txt", (1_700_000_000, 1_700_000_000))

        r = self.build_ok()
        self.assertIn("UP-TO-DATE out.txt", r.stdout)
        self.assertNotIn("BUILD out.txt", r.stdout)
        self.assertEqual(self.mtime_ns("out.txt"), artifact_mtime)
        self.assertEqual(self.state()["out.txt"]["fingerprint"], fingerprint)


class TestAcceptanceB_DeepDependencyCascade(CliTestCase):
    def make_chain(self):
        self.write_file("deep/leaf.txt", "v1")
        self.write_manifest({
            "l1.txt": {"src": ["deep/leaf.txt"], "cmd": "echo l1"},
            "l2.txt": {"src": ["l1.txt"], "cmd": "echo l2"},
            "l3.txt": {"src": ["l2.txt"], "cmd": "echo l3"},
        })

    def test_deep_change_cascades(self):
        self.make_chain()
        self.build_ok()
        self.assertEqual(self.read("l3.txt"), "v1")
        mtimes = {n: self.mtime_ns(n) for n in ("l1.txt", "l2.txt", "l3.txt")}

        self.write_file("deep/leaf.txt", "v2")
        r = self.build_ok()
        for n in ("l1.txt", "l2.txt", "l3.txt"):
            self.assertIn(f"BUILD {n}", r.stdout)
            self.assertNotEqual(self.mtime_ns(n), mtimes[n])
        self.assertEqual(self.read("l3.txt"), "v2")

        # A no-op rebuild afterwards: nothing changes.
        r = self.build_ok()
        self.assertNotIn("BUILD", r.stdout.replace("UP-TO-DATE", ""))


class TestAcceptanceC_CrashRecovery(CliTestCase):
    def setUp(self):
        super().setUp()
        self.write_file("in.txt", "payload")
        self.write_manifest({"out.txt": {"src": ["in.txt"], "cmd": "echo"}})

    def test_crash_before_rename_rolls_back_tmp(self):
        r = self.run_cli("build", str(self.root),
                         env_extra={"BUILDCACHE_CRASH_AT": "before_rename"})
        self.assertNotEqual(r.returncode, 0)
        # Crash left tmp written, artifact absent, journal pending.
        self.assertTrue((self.root / "out.txt.tmp").is_file())
        self.assertFalse((self.root / "out.txt").exists())

        r = self.build_ok()
        self.assertIn("recovered: rolled back tmp for out.txt", r.stdout)
        self.assertIn("BUILD out.txt", r.stdout)
        self.assertEqual(self.read("out.txt"), "payload")
        self.assertFalse((self.root / "out.txt.tmp").exists())
        self.assertFalse((self.root / ".buildcache" / "journal.json").exists())

    def test_crash_after_rename_backfills_state(self):
        r = self.run_cli("build", str(self.root),
                         env_extra={"BUILDCACHE_CRASH_AT": "after_rename"})
        self.assertNotEqual(r.returncode, 0)
        # Crash left the artifact renamed into place, state not updated.
        self.assertEqual(self.read("out.txt"), "payload")
        self.assertFalse((self.root / ".buildcache" / "state.json").exists())

        r = self.build_ok()
        self.assertIn("recovered: back-filled state for out.txt", r.stdout)
        # Recovery completes the record; the target must NOT be rebuilt.
        self.assertNotIn("BUILD out.txt", r.stdout)
        self.assertEqual(self.state()["out.txt"]["status"], "OK")
        self.assertFalse((self.root / ".buildcache" / "journal.json").exists())

        # A further build is a no-op: recovery was fully consistent.
        r = self.build_ok()
        self.assertIn("UP-TO-DATE out.txt", r.stdout)

    def test_recovery_result_matches_clean_rebuild(self):
        for point in ("before_rename", "after_rename"):
            self.run_cli("build", str(self.root),
                         env_extra={"BUILDCACHE_CRASH_AT": point})
            self.build_ok()
            recovered = self.read("out.txt")
            recovered_fp = self.state()["out.txt"]["fingerprint"]
            self.run_cli("clean", str(self.root))
            self.build_ok()
            self.assertEqual(self.read("out.txt"), recovered)
            self.assertEqual(self.state()["out.txt"]["fingerprint"], recovered_fp)
            self.run_cli("clean", str(self.root))


class TestAcceptanceD_IncrementalVsFullRebuild(CliTestCase):
    def test_incremental_results_equal_full_rebuild(self):
        self.write_file("src/a.txt", "A1")
        self.write_file("src/b.txt", "B1")
        self.write_manifest({
            "gen/mid.txt": {"src": ["src/a.txt"], "cmd": "echo mid"},
            "gen/top.txt": {"src": ["gen/mid.txt", "src/b.txt"], "cmd": "echo top"},
        })
        self.build_ok()
        # Incremental path: change a deep input, rebuild only what is dirty.
        self.write_file("src/a.txt", "A2")
        self.build_ok()
        incremental = {n: self.read(n) for n in ("gen/mid.txt", "gen/top.txt")}

        # Full rebuild from scratch in a pristine copy of the same sources.
        full = self.tmp / "full"
        shutil.copytree(self.root, full,
                        ignore=shutil.ignore_patterns(".buildcache", "gen"))
        r = self.run_cli("build", str(full))
        self.assertEqual(r.returncode, 0, r.stderr)
        for name, content in incremental.items():
            self.assertEqual((full / name).read_text(), content)


class TestStaleOnMissingSource(CliTestCase):
    def test_missing_source_marks_stale_and_keeps_old_artifact(self):
        self.write_file("in.txt", "old-data")
        self.write_manifest({"out.txt": {"src": ["in.txt"], "cmd": "echo"}})
        self.build_ok()

        (self.root / "in.txt").unlink()
        r = self.build_ok()
        self.assertIn("STALE out.txt", r.stdout)
        self.assertEqual(self.read("out.txt"), "old-data")  # old artifact kept
        self.assertEqual(self.state()["out.txt"]["status"], "STALE")

        r = self.run_cli("scan", str(self.root))
        self.assertIn("out.txt\tSTALE\tstale (old artifact kept)", r.stdout)

        # Source returns with new content -> target rebuilds.
        self.write_file("in.txt", "new-data")
        r = self.build_ok()
        self.assertIn("BUILD out.txt", r.stdout)
        self.assertEqual(self.read("out.txt"), "new-data")


class TestClean(CliTestCase):
    def test_clean_removes_only_manifest_artifacts(self):
        self.write_file("in.txt", "x")
        self.write_file("keep.txt", "precious")
        self.write_manifest({
            "out/a.txt": {"src": ["in.txt"], "cmd": "echo a"},
            "out/b.txt": {"src": ["out/a.txt"], "cmd": "echo b"},
        })
        self.build_ok()
        r = self.run_cli("clean", str(self.root))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.root / "out" / "a.txt").exists())
        self.assertFalse((self.root / "out" / "b.txt").exists())
        self.assertFalse((self.root / ".buildcache").exists())
        # Untracked files and sources survive.
        self.assertEqual(self.read("keep.txt"), "precious")
        self.assertEqual(self.read("in.txt"), "x")


class TestErrorExitCodes(CliTestCase):
    def test_bad_manifest_exit_2(self):
        (self.root / "manifest.json").write_text("{not json")
        for cmd in ("scan", "build", "clean"):
            r = self.run_cli(cmd, str(self.root))
            self.assertEqual(r.returncode, 2, (cmd, r.stdout, r.stderr))
            self.assertIn("error:", r.stderr)

    def test_missing_manifest_exit_2(self):
        r = self.run_cli("build", str(self.root))
        self.assertEqual(r.returncode, 2)

    def test_invalid_manifest_shape_exit_2(self):
        (self.root / "manifest.json").write_text(json.dumps({"t": {"src": "oops"}}))
        r = self.run_cli("build", str(self.root))
        self.assertEqual(r.returncode, 2)

    def test_cycle_exit_3(self):
        self.write_manifest({
            "a.txt": {"src": ["b.txt"], "cmd": "echo a"},
            "b.txt": {"src": ["a.txt"], "cmd": "echo b"},
        })
        r = self.run_cli("build", str(self.root))
        self.assertEqual(r.returncode, 3)
        self.assertIn("cycle", r.stderr.lower())

    def test_self_cycle_exit_3(self):
        self.write_manifest({"a.txt": {"src": ["a.txt"], "cmd": "echo a"}})
        r = self.run_cli("scan", str(self.root))
        self.assertEqual(r.returncode, 3)

    def test_write_failure_exit_7(self):
        self.write_file("in.txt", "x")
        # Artifact path is an existing directory -> rename must fail.
        (self.root / "out.txt").mkdir()
        self.write_manifest({"out.txt": {"src": ["in.txt"], "cmd": "echo"}})
        r = self.run_cli("build", str(self.root))
        self.assertEqual(r.returncode, 7, (r.stdout, r.stderr))
        self.assertIn("error:", r.stderr)


if __name__ == "__main__":
    unittest.main()
