"""Shared fixtures for the test suite."""

import os
import shutil
import tempfile
import unittest


class WorkspaceTestCase(unittest.TestCase):
    """Provides a fresh temporary directory per test."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="deltaupd-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def path(self, name):
        return os.path.join(self.dir, name)

    def write(self, name, data: bytes):
        with open(self.path(name), "wb") as fh:
            fh.write(data)
        return self.path(name)

    def read(self, name) -> bytes:
        with open(self.path(name), "rb") as fh:
            return fh.read()

    def make_state_dir(self, name="state"):
        path = self.path(name)
        os.makedirs(path, exist_ok=True)
        return path
