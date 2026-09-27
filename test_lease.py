import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

from lease import (
    EXIT_CANCELED,
    EXIT_NOT_HELD,
    EXIT_OK,
    EXIT_STALE_TOKEN,
    State,
)

REPO = os.path.dirname(os.path.abspath(__file__))

# Reference fencing tokens: the monotonic counter starts at 1.
FIRST_TOKEN = 1
SECOND_TOKEN = 2
THIRD_TOKEN = 3


class LeaseCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "lease_state.json")

    def run_cli(self, *args, ttl=None):
        cmd = [sys.executable, os.path.join(REPO, "lease.py"),
               "--db", self.db]
        if ttl is not None:
            cmd += ["--ttl", str(ttl)]
        cmd += list(args)
        return subprocess.run(
            cmd, capture_output=True, text=True, cwd=REPO
        )

    def acquire(self, key, ttl=None):
        result = self.run_cli("acquire", key, ttl=ttl)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        return int(result.stdout.strip())

    def write(self, token, opid, value):
        return self.run_cli("write", str(token), opid, value)

    def state(self):
        result = self.run_cli("state")
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        return json.loads(result.stdout)

    def writes(self, snap):
        return [e for e in snap["op_log"] if e["op"] == "write"]

    def test_state_enum_reference(self):
        self.assertEqual(
            [s.value for s in State],
            ["FREE", "HELD", "CANCELED", "RELEASED"],
        )

    def test_initial_state_is_free_with_token_zero(self):
        snap = self.state()
        self.assertEqual(snap["state"], State.FREE.value)
        self.assertEqual(snap["token"], 0)
        self.assertEqual(snap["max_token"], 0)

    def test_same_key_returns_same_token_while_lease_valid(self):
        token1 = self.acquire("alpha")
        token2 = self.acquire("alpha")
        self.assertEqual(token1, FIRST_TOKEN)
        self.assertEqual(token2, FIRST_TOKEN)
        snap = self.state()
        self.assertEqual(snap["state"], State.HELD.value)
        self.assertEqual(snap["token"], FIRST_TOKEN)
        self.assertEqual(snap["key"], "alpha")

    def test_new_owner_gets_strictly_larger_token(self):
        token_old = self.acquire("alpha")
        self.assertEqual(token_old, FIRST_TOKEN)
        self.assertEqual(self.run_cli("release").returncode, EXIT_OK)
        token_new = self.acquire("beta")
        self.assertEqual(token_new, SECOND_TOKEN)
        self.assertGreater(token_new, token_old)

    def test_other_key_rejected_while_lease_held(self):
        self.acquire("alpha")
        result = self.run_cli("acquire", "beta")
        self.assertEqual(result.returncode, EXIT_NOT_HELD)
        snap = self.state()
        self.assertEqual(snap["token"], FIRST_TOKEN)

    def test_stale_token_write_exit_9_and_new_token_writable(self):
        old_token = self.acquire("alpha")
        self.assertEqual(old_token, FIRST_TOKEN)
        self.run_cli("release")
        new_token = self.acquire("beta")
        self.assertEqual(new_token, SECOND_TOKEN)

        stale = self.write(old_token, "op-1", "v")
        self.assertEqual(stale.returncode, EXIT_STALE_TOKEN)
        self.assertIn("stale token", stale.stderr)

        fresh = self.write(new_token, "op-1", "v")
        self.assertEqual(fresh.returncode, EXIT_OK)
        snap = self.state()
        self.assertEqual(len(self.writes(snap)), 1)
        self.assertEqual(snap["max_token"], SECOND_TOKEN)

    def test_cancel_rejects_writes_and_is_observable_at_checkpoint(self):
        token = self.acquire("alpha")
        self.assertEqual(token, FIRST_TOKEN)
        self.assertEqual(self.run_cli("cancel").returncode, EXIT_OK)

        result = self.write(token, "op-1", "v")
        self.assertEqual(result.returncode, EXIT_CANCELED)
        snap = self.state()
        self.assertEqual(snap["state"], State.CANCELED.value)
        self.assertEqual(snap["token"], FIRST_TOKEN)
        self.assertEqual(snap["op_log"], [])

    def test_duplicate_write_same_token_opid_is_idempotent(self):
        token = self.acquire("alpha")
        first = self.write(token, "op-1", "hello")
        second = self.write(token, "op-1", "hello")
        self.assertEqual(first.returncode, EXIT_OK)
        self.assertEqual(second.returncode, EXIT_OK)
        self.assertIn("duplicate", second.stdout)
        snap = self.state()
        writes = self.writes(snap)
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]["value"], "hello")
        self.assertEqual(len(snap["effects"]), 1)

    def test_different_opid_produces_separate_effects(self):
        token = self.acquire("alpha")
        self.assertEqual(self.write(token, "op-1", "a").returncode, EXIT_OK)
        self.assertEqual(self.write(token, "op-2", "b").returncode, EXIT_OK)
        snap = self.state()
        self.assertEqual(len(self.writes(snap)), 2)
        self.assertEqual(len(snap["effects"]), 2)

    def test_release_undoes_effects_in_reverse_order(self):
        token = self.acquire("alpha")
        for opid in ("a", "b", "c"):
            self.assertEqual(
                self.write(token, opid, opid.upper()).returncode, EXIT_OK
            )
        result = self.run_cli("release")
        self.assertEqual(result.returncode, EXIT_OK)
        self.assertIn("c, b, a", result.stdout)

        snap = self.state()
        self.assertEqual(snap["state"], State.RELEASED.value)
        self.assertEqual(snap["effects"], [])
        undos = [e for e in snap["op_log"] if e["op"] == "undo"]
        self.assertEqual([e["opid"] for e in undos], ["c", "b", "a"])

    def test_write_after_release_errors(self):
        token = self.acquire("alpha")
        self.assertEqual(self.write(token, "op-1", "v").returncode, EXIT_OK)
        self.assertEqual(self.run_cli("release").returncode, EXIT_OK)
        result = self.write(token, "op-2", "v")
        self.assertNotEqual(result.returncode, EXIT_OK)
        self.assertEqual(result.returncode, EXIT_NOT_HELD)
        snap = self.state()
        self.assertEqual(snap["state"], State.RELEASED.value)

    def test_crash_after_acquire_recover_returns_original_token(self):
        token = self.acquire("alpha")
        self.assertEqual(token, FIRST_TOKEN)
        self.assertEqual(
            self.run_cli("crash", "--at", "after-acquire").returncode, EXIT_OK
        )

        blocked = self.run_cli("acquire", "alpha")
        self.assertNotEqual(blocked.returncode, EXIT_OK)

        recovered = self.run_cli("recover")
        self.assertEqual(recovered.returncode, EXIT_OK)
        snap = self.state()
        self.assertEqual(snap["state"], State.HELD.value)

        same_token = self.acquire("alpha")
        self.assertEqual(same_token, FIRST_TOKEN)

    def test_crash_after_write_recovers_effect_and_opid_dedups(self):
        token = self.acquire("alpha")
        self.assertEqual(self.write(token, "op-1", "v").returncode, EXIT_OK)
        self.assertEqual(
            self.run_cli("crash", "--at", "after-write").returncode, EXIT_OK
        )
        self.assertEqual(self.run_cli("recover").returncode, EXIT_OK)

        snap = self.state()
        self.assertEqual(snap["state"], State.HELD.value)
        self.assertEqual(snap["token"], FIRST_TOKEN)
        self.assertEqual(len(self.writes(snap)), 1)

        retry = self.write(token, "op-1", "v")
        self.assertEqual(retry.returncode, EXIT_OK)
        self.assertIn("duplicate", retry.stdout)
        self.assertEqual(len(self.writes(self.state())), 1)

    def test_crash_after_release_recovers_released_state(self):
        token = self.acquire("alpha")
        self.assertEqual(self.write(token, "op-1", "v").returncode, EXIT_OK)
        self.assertEqual(self.run_cli("release").returncode, EXIT_OK)
        self.assertEqual(
            self.run_cli("crash", "--at", "after-release").returncode, EXIT_OK
        )
        self.assertEqual(self.run_cli("recover").returncode, EXIT_OK)

        snap = self.state()
        self.assertEqual(snap["state"], State.RELEASED.value)
        self.assertEqual(
            [e["op"] for e in snap["op_log"]], ["write", "undo"]
        )
        self.assertNotEqual(self.write(token, "op-2", "v").returncode, EXIT_OK)

    def test_crash_after_write_discards_later_events(self):
        token = self.acquire("alpha")
        self.write(token, "op-1", "v1")
        self.write(token, "op-2", "v2")
        self.run_cli("release")
        self.assertEqual(
            self.run_cli("crash", "--at", "after-write").returncode, EXIT_OK
        )
        self.run_cli("recover")
        snap = self.state()
        self.assertEqual(snap["state"], State.HELD.value)
        self.assertEqual(len(self.writes(snap)), 2)
        self.assertEqual(snap["effects"][-1]["opid"], "op-2")

    def test_expired_lease_issues_new_token_to_same_key(self):
        token = self.acquire("alpha", ttl=0.2)
        self.assertEqual(token, FIRST_TOKEN)
        time.sleep(0.3)
        new_token = self.acquire("alpha", ttl=0.2)
        self.assertEqual(new_token, SECOND_TOKEN)
        self.assertGreater(new_token, token)

    def test_renew_extends_expiry_and_recover_keeps_it(self):
        token = self.acquire("alpha", ttl=0.2)
        self.assertEqual(token, FIRST_TOKEN)
        before = self.state()["expires_at"]
        time.sleep(0.1)
        self.assertEqual(self.run_cli("renew").returncode, EXIT_OK)
        after = self.state()["expires_at"]
        self.assertGreater(after, before)
        time.sleep(0.15)
        self.assertEqual(self.acquire("alpha", ttl=0.2), FIRST_TOKEN)

    def test_crash_without_matching_event_is_error(self):
        result = self.run_cli("crash", "--at", "after-write")
        self.assertNotEqual(result.returncode, EXIT_OK)

    def test_full_lifecycle_token_monotonicity(self):
        t1 = self.acquire("alpha")
        self.assertEqual(t1, FIRST_TOKEN)
        self.write(t1, "op-1", "v")
        self.run_cli("cancel")
        t2 = self.acquire("alpha")
        self.assertEqual(t2, SECOND_TOKEN)
        self.assertEqual(self.write(t2, "op-1", "v").returncode, EXIT_OK)
        self.run_cli("release")
        t3 = self.acquire("beta")
        self.assertEqual(t3, THIRD_TOKEN)
        self.assertEqual(self.write(t3, "op-9", "v").returncode, EXIT_OK)
        self.assertEqual(self.write(FIRST_TOKEN, "x", "y").returncode,
                         EXIT_STALE_TOKEN)
        self.assertEqual(self.write(SECOND_TOKEN, "x", "y").returncode,
                         EXIT_STALE_TOKEN)


if __name__ == "__main__":
    unittest.main()
