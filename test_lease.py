"""End-to-end tests for the lease CLI (lease.py) via subprocess."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lease import (  # noqa: E402
    EXIT_CANCELED,
    EXIT_NOT_HELD,
    EXIT_OK,
    EXIT_STALE_TOKEN,
    State,
)

LEASE_PY = Path(__file__).resolve().parent / "lease.py"


class LeaseCLITest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.env = dict(os.environ, LEASE_TTL_SECONDS="3600")

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(LEASE_PY), "--dir", self.dir, *args],
            capture_output=True, text=True, env=self.env,
        )

    def acquire(self, key):
        res = self.run_cli("acquire", key)
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        return int(res.stdout.strip())

    def state(self):
        res = self.run_cli("state")
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        return json.loads(res.stdout)

    # --- reference enumerations -------------------------------------------

    def test_state_enum_reference(self):
        self.assertEqual(
            {s.value for s in State},
            {"FREE", "HELD", "CANCELED", "RELEASED"},
        )

    def test_initial_state_is_free(self):
        st = self.state()
        self.assertEqual(st["state"], State.FREE.value)
        self.assertEqual(st["token"], 0)

    # --- acquire / fence token semantics ----------------------------------

    def test_same_key_acquire_returns_same_token(self):
        t1 = self.acquire("alice")
        t2 = self.acquire("alice")
        self.assertEqual(t1, t2)

    def test_new_owner_gets_larger_token(self):
        reference = self.acquire("alice")
        self.assertEqual(reference, 1)  # reference token for the first lease
        t2 = self.acquire("bob")
        t3 = self.acquire("carol")
        self.assertGreater(t2, reference)
        self.assertGreater(t3, t2)  # strictly monotonic fence tokens

    # --- write fencing -----------------------------------------------------

    def test_stale_token_rejected_new_token_accepted(self):
        old = self.acquire("alice")
        new = self.acquire("bob")
        res = self.run_cli("write", str(old), "op-1", "v1")
        self.assertEqual(res.returncode, EXIT_STALE_TOKEN)
        self.assertEqual(EXIT_STALE_TOKEN, 9)  # required exit code
        res = self.run_cli("write", str(new), "op-1", "v1")
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertEqual(self.state()["applied"], {"op-1": "v1"})

    def test_duplicate_write_is_idempotent(self):
        token = self.acquire("alice")
        self.assertEqual(self.run_cli("write", str(token), "op-1", "v1").returncode,
                         EXIT_OK)
        res = self.run_cli("write", str(token), "op-1", "v1")
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertIn("duplicate", res.stdout)
        st = self.state()
        self.assertEqual(st["applied"], {"op-1": "v1"})  # effect applied once
        self.assertEqual(st["order"], ["op-1"])

    # --- cancel ------------------------------------------------------------

    def test_cancel_blocks_writes_and_state_is_canceled(self):
        token = self.acquire("alice")
        res = self.run_cli("cancel")
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertEqual(res.stdout.strip(), State.CANCELED.value)
        res = self.run_cli("write", str(token), "op-1", "v1")
        self.assertEqual(res.returncode, EXIT_CANCELED)
        st = self.state()  # holder observes cancellation at the checkpoint
        self.assertEqual(st["state"], State.CANCELED.value)

    # --- release -----------------------------------------------------------

    def test_release_undoes_effects_in_reverse_order(self):
        token = self.acquire("alice")
        for opid in ("op-1", "op-2", "op-3"):
            self.assertEqual(
                self.run_cli("write", str(token), opid, "v").returncode, EXIT_OK)
        res = self.run_cli("release")
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertIn("effects=op-3,op-2,op-1", res.stdout)  # reverse order
        st = self.state()
        self.assertEqual(st["state"], State.RELEASED.value)
        self.assertEqual(st["applied"], {})

    def test_write_after_release_fails(self):
        token = self.acquire("alice")
        self.assertEqual(self.run_cli("write", str(token), "op-1", "v1").returncode,
                         EXIT_OK)
        self.assertEqual(self.run_cli("release").returncode, EXIT_OK)
        res = self.run_cli("write", str(token), "op-2", "v2")
        self.assertEqual(res.returncode, EXIT_NOT_HELD)
        self.assertNotEqual(res.returncode, EXIT_OK)

    # --- renew -------------------------------------------------------------

    def test_renew_extends_lease(self):
        self.acquire("alice")
        before = self.state()["expiry"]
        res = self.run_cli("renew")
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertGreaterEqual(self.state()["expiry"], before)

    # --- crash / recover ---------------------------------------------------

    def test_crash_after_acquire_recover_returns_same_token(self):
        token = self.acquire("alice")
        self.assertEqual(self.run_cli("crash", "--at", "acquire").returncode,
                         EXIT_OK)
        res = self.run_cli("recover")
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        recovered = json.loads(res.stdout)
        self.assertEqual(recovered["state"], State.HELD.value)
        self.assertEqual(recovered["token"], token)
        self.assertEqual(self.acquire("alice"), token)  # same KEY, same token

    def test_crash_after_write_recover_dedups_opid(self):
        token = self.acquire("alice")
        self.assertEqual(self.run_cli("write", str(token), "op-1", "v1").returncode,
                         EXIT_OK)
        self.assertEqual(self.run_cli("crash", "--at", "write").returncode, EXIT_OK)
        self.assertEqual(self.run_cli("recover").returncode, EXIT_OK)
        res = self.run_cli("write", str(token), "op-1", "v1")  # replayed write
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        st = self.state()
        self.assertEqual(st["applied"], {"op-1": "v1"})  # single effect
        self.assertEqual(st["order"], ["op-1"])

    def test_crash_after_release_recover_keeps_released_state(self):
        token = self.acquire("alice")
        self.assertEqual(self.run_cli("write", str(token), "op-1", "v1").returncode,
                         EXIT_OK)
        self.assertEqual(self.run_cli("release").returncode, EXIT_OK)
        self.assertEqual(self.run_cli("crash", "--at", "release").returncode,
                         EXIT_OK)
        self.assertEqual(self.run_cli("recover").returncode, EXIT_OK)
        st = self.state()
        self.assertEqual(st["state"], State.RELEASED.value)
        self.assertEqual(st["applied"], {})
        res = self.run_cli("write", str(token), "op-2", "v2")
        self.assertNotEqual(res.returncode, EXIT_OK)


if __name__ == "__main__":
    unittest.main()
