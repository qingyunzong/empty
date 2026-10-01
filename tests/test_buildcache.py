import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from buildcache import core  # noqa: E402


def write_file(root, relpath, content):
    path = os.path.join(root, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def write_manifest(root, targets):
    write_file(root, "manifest.json", json.dumps({"targets": targets}))


def read_file(root, relpath):
    with open(os.path.join(root, relpath), "r", encoding="utf-8") as fh:
        return fh.read()


def run_cli(*args, env_extra=None):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, "-m", "buildcache", *args],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


class BuildCacheTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name
        os.environ.pop(core.FAULT_ENV, None)
        self.addCleanup(os.environ.pop, core.FAULT_ENV, None)

    def make_chain_project(self):
        """base <- mid <- top dependency chain."""
        write_manifest(self.dir, {
            "base": {"src": ["src/base.txt"], "cmd": "echo"},
            "mid": {"src": ["src/mid.txt"], "deps": ["base"], "cmd": "echo"},
            "top": {"src": ["src/top.txt"], "deps": ["mid"], "cmd": "echo"},
        })
        write_file(self.dir, "src/base.txt", "BASE\n")
        write_file(self.dir, "src/mid.txt", "MID\n")
        write_file(self.dir, "src/top.txt", "TOP\n")

    def state(self):
        with open(os.path.join(self.dir, ".buildcache", "state.json")) as fh:
            return json.load(fh)


class TestIncremental(BuildCacheTestCase):
    def test_unrelated_change_does_not_rebuild(self):
        self.make_chain_project()
        write_file(self.dir, "docs/notes.md", "v1")
        first = core.build(self.dir)
        self.assertEqual(set(first.values()), {"BUILT"})
        # Pin output mtimes so any rewrite is observable.
        for name in ("base", "mid", "top"):
            os.utime(os.path.join(self.dir, name), (1_000_000, 1_000_000))
        write_file(self.dir, "docs/notes.md", "v2 - unrelated edit")
        second = core.build(self.dir)
        self.assertEqual(set(second.values()), {"OK"})
        for name in ("base", "mid", "top"):
            stat = os.stat(os.path.join(self.dir, name))
            self.assertEqual(stat.st_mtime, 1_000_000, f"{name} was rewritten")

    def test_mtime_touch_without_content_change_does_not_rebuild(self):
        self.make_chain_project()
        core.build(self.dir)
        # mtime is untrusted: touching a source must not trigger a rebuild.
        os.utime(os.path.join(self.dir, "src/base.txt"), None)
        results = core.build(self.dir)
        self.assertEqual(set(results.values()), {"OK"})

    def test_deep_dependency_change_cascades(self):
        self.make_chain_project()
        core.build(self.dir)
        write_file(self.dir, "src/base.txt", "BASE-v2\n")
        results = core.build(self.dir)
        self.assertEqual(results, {"base": "BUILT", "mid": "BUILT", "top": "BUILT"})
        self.assertEqual(read_file(self.dir, "top"), "BASE-v2\nMID\nTOP\n")

    def test_leaf_change_rebuilds_only_dependents(self):
        self.make_chain_project()
        core.build(self.dir)
        write_file(self.dir, "src/mid.txt", "MID-v2\n")
        results = core.build(self.dir)
        self.assertEqual(results, {"base": "OK", "mid": "BUILT", "top": "BUILT"})

    def test_missing_source_marks_stale_and_keeps_old_output(self):
        self.make_chain_project()
        core.build(self.dir)
        old_top = read_file(self.dir, "top")
        os.unlink(os.path.join(self.dir, "src/base.txt"))
        results = core.build(self.dir)
        self.assertEqual(results["base"], "STALE")
        # Old artifacts are preserved, nothing is deleted or half-written.
        self.assertEqual(read_file(self.dir, "base"), "BASE\n")
        self.assertEqual(read_file(self.dir, "top"), old_top)
        report = core.scan(self.dir)
        self.assertEqual(report["base"]["status"], "STALE")
        self.assertEqual(report["base"]["missing"], ["src/base.txt"])


class TestCrashRecovery(BuildCacheTestCase):
    def test_fault_before_rename_rolls_back_tmp(self):
        self.make_chain_project()
        os.environ[core.FAULT_ENV] = "before_rename:base"
        with self.assertRaises(core.CrashFault):
            core.build(self.dir)
        # Crash left a tmp file behind; no output, no state record.
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "base.tmp")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "base")))
        del os.environ[core.FAULT_ENV]
        results = core.build(self.dir)
        self.assertEqual(results, {"base": "BUILT", "mid": "BUILT", "top": "BUILT"})
        # tmp rolled back, final artifacts complete.
        self.assertFalse(os.path.exists(os.path.join(self.dir, "base.tmp")))
        self.assertEqual(read_file(self.dir, "top"), "BASE\nMID\nTOP\n")
        report = core.scan(self.dir)
        self.assertTrue(all(i["status"] == "OK" for i in report.values()))

    def test_fault_after_rename_repairs_state(self):
        self.make_chain_project()
        os.environ[core.FAULT_ENV] = "after_rename:mid"
        with self.assertRaises(core.CrashFault):
            core.build(self.dir)
        # base fully recorded; mid renamed but missing from the state.
        state = self.state()
        self.assertIn("base", state["targets"])
        self.assertNotIn("mid", state["targets"])
        self.assertEqual(read_file(self.dir, "mid"), "BASE\nMID\n")
        self.assertFalse(os.path.exists(os.path.join(self.dir, "top")))
        del os.environ[core.FAULT_ENV]
        # Restart: mid's verified output is adopted (state re-recorded),
        # top builds normally; no half-finished target remains.
        results = core.build(self.dir)
        self.assertEqual(results, {"base": "OK", "mid": "RECOVERED", "top": "BUILT"})
        state = self.state()
        self.assertIn("mid", state["targets"])
        self.assertEqual(read_file(self.dir, "top"), "BASE\nMID\nTOP\n")
        report = core.scan(self.dir)
        self.assertTrue(all(i["status"] == "OK" for i in report.values()))
        # A further build is a pure no-op: recovery converged.
        again = core.build(self.dir)
        self.assertEqual(set(again.values()), {"OK"})

    def test_crash_recovery_matches_clean_rebuild(self):
        self.make_chain_project()
        os.environ[core.FAULT_ENV] = "after_rename:top"
        with self.assertRaises(core.CrashFault):
            core.build(self.dir)
        del os.environ[core.FAULT_ENV]
        core.build(self.dir)
        recovered = {n: read_file(self.dir, n) for n in ("base", "mid", "top")}
        core.clean(self.dir)
        core.build(self.dir)
        rebuilt = {n: read_file(self.dir, n) for n in ("base", "mid", "top")}
        self.assertEqual(recovered, rebuilt)


class TestFullRebuildEquivalence(BuildCacheTestCase):
    def test_incremental_outputs_match_full_rebuild(self):
        self.make_chain_project()
        core.build(self.dir)
        write_file(self.dir, "src/base.txt", "BASE-v2\n")
        write_file(self.dir, "src/top.txt", "TOP-v2\n")
        core.build(self.dir)
        write_file(self.dir, "src/mid.txt", "MID-v2\n")
        incremental = core.build(self.dir)
        self.assertEqual(incremental["base"], "OK")
        outputs_incremental = {n: read_file(self.dir, n) for n in ("base", "mid", "top")}
        core.clean(self.dir)
        full = core.build(self.dir)
        self.assertEqual(set(full.values()), {"BUILT"})
        outputs_full = {n: read_file(self.dir, n) for n in ("base", "mid", "top")}
        self.assertEqual(outputs_incremental, outputs_full)
        self.assertEqual(outputs_full["top"], "BASE-v2\nMID-v2\nTOP-v2\n")


class TestClean(BuildCacheTestCase):
    def test_clean_removes_only_manifest_artifacts(self):
        self.make_chain_project()
        core.build(self.dir)
        write_file(self.dir, "stray.bin", "do not touch")
        removed = core.clean(self.dir)
        for name in ("base", "mid", "top"):
            self.assertFalse(os.path.exists(os.path.join(self.dir, name)))
            self.assertIn(name, removed)
        # Sources, manifest and unrelated files survive.
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "stray.bin")))
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "src/base.txt")))
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "manifest.json")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, ".buildcache")))


class TestCliExitCodes(BuildCacheTestCase):
    def test_scan_build_clean_roundtrip(self):
        self.make_chain_project()
        result = run_cli("scan", self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("UNBUILT", result.stdout)
        result = run_cli("build", self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("top: BUILT", result.stdout)
        result = run_cli("scan", self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("top: OK", result.stdout)
        result = run_cli("clean", self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "top")))

    def test_broken_manifest_exits_2(self):
        write_file(self.dir, "manifest.json", "{not json")
        for command in ("scan", "build"):
            result = run_cli(command, self.dir)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("error:", result.stderr)

    def test_missing_manifest_exits_2(self):
        result = run_cli("build", self.dir)
        self.assertEqual(result.returncode, 2)

    def test_unknown_dependency_exits_2(self):
        write_manifest(self.dir, {"a": {"deps": ["ghost"], "cmd": "echo"}})
        result = run_cli("build", self.dir)
        self.assertEqual(result.returncode, 2)

    def test_cycle_exits_3(self):
        write_manifest(self.dir, {
            "a": {"deps": ["b"], "cmd": "echo"},
            "b": {"deps": ["a"], "cmd": "echo"},
        })
        result = run_cli("build", self.dir)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("cycle", result.stderr.lower())

    def test_write_failure_exits_7(self):
        write_manifest(self.dir, {"out": {"src": ["in.txt"], "cmd": "echo"}})
        write_file(self.dir, "in.txt", "data")
        # A directory sitting at the output path makes the rename fail.
        os.mkdir(os.path.join(self.dir, "out"))
        result = run_cli("build", self.dir)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertIn("error:", result.stderr)

    def test_cli_fault_injection_exit_75_then_recovers(self):
        self.make_chain_project()
        result = run_cli("build", self.dir,
                         env_extra={core.FAULT_ENV: "before_rename:mid"})
        self.assertEqual(result.returncode, 75)
        result = run_cli("build", self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(read_file(self.dir, "top"), "BASE\nMID\nTOP\n")


if __name__ == "__main__":
    unittest.main()
