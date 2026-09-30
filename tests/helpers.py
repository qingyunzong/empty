"""Shared helpers for hierosync tests."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if WORKSPACE not in sys.path:
    sys.path.insert(0, WORKSPACE)


def run_cli(root, snap, undo=None):
    cmd = [sys.executable, "-m", "hierosync", "commit", str(root), str(snap)]
    if undo is not None:
        cmd += ["--undo", str(undo)]
    return subprocess.run(cmd, cwd=WORKSPACE, capture_output=True, text=True)


def run_ok(root, snap, undo=None):
    proc = run_cli(root, snap, undo=undo)
    assert proc.returncode == 0, f"exit={proc.returncode} stderr={proc.stderr}"
    assert proc.stderr == "", f"unexpected stderr: {proc.stderr}"
    return json.loads(proc.stdout)


class RepoTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hierosync-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = os.path.join(self.tmp, "repo")
        self.snap = os.path.join(self.repo, ".hs")
        os.makedirs(self.repo)

    def write(self, rel, data):
        full = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        mode = "wb" if isinstance(data, bytes) else "w"
        with open(full, mode) as fh:
            fh.write(data)

    def read(self, rel):
        with open(os.path.join(self.repo, rel), "rb") as fh:
            return fh.read()

    def mkdir(self, rel):
        os.makedirs(os.path.join(self.repo, rel), exist_ok=True)

    def snapshot_ids(self):
        snaps_dir = os.path.join(self.snap, "snapshots")
        if not os.path.isdir(snaps_dir):
            return []
        return sorted(os.listdir(snaps_dir))

    def head_id(self):
        with open(os.path.join(self.snap, "HEAD")) as fh:
            return fh.read().strip()

    def read_snapshot(self, snap_id):
        path = os.path.join(self.snap, "snapshots", snap_id + ".json")
        with open(path) as fh:
            return json.load(fh)
