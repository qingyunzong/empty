"""Unit tests for the lock manager, covering acceptance criteria a-c."""

import unittest

from lockmgr import LockManager, LockMode, RequestStatus

S = LockMode.S
X = LockMode.X
GRANTED = RequestStatus.GRANTED
WAITING = RequestStatus.WAITING
ERROR = RequestStatus.ERROR


class TestBasicLocks(unittest.TestCase):
    def test_shared_locks_are_compatible(self):
        lm = LockManager()
        self.assertIs(lm.lock(1, "A", S), GRANTED)
        self.assertIs(lm.lock(2, "A", S), GRANTED)
        self.assertEqual(lm.holders("A"), {1: S, 2: S})

    def test_exclusive_blocks_and_wakes_on_commit(self):
        lm = LockManager()
        self.assertIs(lm.lock(1, "A", X), GRANTED)
        self.assertIs(lm.lock(2, "A", X), WAITING)
        self.assertIs(lm.lock(3, "A", S), WAITING)
        lm.commit(1)
        # FIFO: txn 2's X is granted first; txn 3's S stays queued behind it.
        self.assertEqual(lm.holders("A"), {2: X})
        self.assertEqual(lm.waiters("A"), [(3, S)])
        lm.commit(2)
        self.assertEqual(lm.holders("A"), {3: S})

    def test_shared_grant_skips_queue_head_only_when_grantable(self):
        lm = LockManager()
        lm.lock(1, "A", S)
        lm.lock(2, "A", X)  # waits behind S holder
        lm.lock(3, "A", S)  # must queue behind waiting X (FIFO fairness)
        self.assertEqual(lm.waiters("A"), [(2, X), (3, S)])
        lm.commit(1)
        self.assertEqual(lm.holders("A"), {2: X})
        lm.commit(2)
        self.assertEqual(lm.holders("A"), {3: S})

    def test_fifo_wakeup_of_multiple_shared_waiters(self):
        lm = LockManager()
        lm.lock(1, "A", X)
        lm.lock(2, "A", S)
        lm.lock(3, "A", S)
        lm.commit(1)
        self.assertEqual(lm.holders("A"), {2: S, 3: S})
        self.assertEqual(lm.waiters("A"), [])

    def test_relock_same_mode_is_idempotent(self):
        lm = LockManager()
        lm.lock(1, "A", S)
        self.assertIs(lm.lock(1, "A", S), GRANTED)
        lm.lock(2, "A", X)  # queue non-empty now
        # X holder re-request still granted even with a non-empty queue
        lm.lock(3, "B", X)
        self.assertIs(lm.lock(3, "B", S), GRANTED)

    def test_ops_on_finished_txn_are_errors(self):
        lm = LockManager()
        lm.lock(1, "A", X)
        lm.commit(1)
        self.assertIs(lm.lock(1, "B", S), ERROR)
        self.assertIs(lm.commit(1), ERROR)
        self.assertIs(lm.abort(1), ERROR)

    def test_abort_releases_locks(self):
        lm = LockManager()
        lm.lock(1, "A", X)
        lm.lock(2, "A", S)
        lm.abort(1)
        self.assertEqual(lm.holders("A"), {2: S})


class TestUpgrade(unittest.TestCase):
    def test_uncontended_upgrade(self):
        lm = LockManager()
        lm.lock(1, "A", S)
        self.assertIs(lm.lock(1, "A", X), GRANTED)
        self.assertEqual(lm.holders("A"), {1: X})

    def test_upgrade_blocked_by_other_shared_holder(self):
        lm = LockManager()
        lm.lock(1, "A", S)
        lm.lock(2, "A", S)
        self.assertIs(lm.lock(1, "A", X), WAITING)
        # txn 1 keeps its S lock while waiting for the upgrade
        self.assertEqual(lm.holders("A"), {1: S, 2: S})
        lm.commit(2)
        self.assertEqual(lm.holders("A"), {1: X})

    def test_upgrade_jump_queue_and_wake(self):
        lm = LockManager()
        lm.lock(1, "A", S)
        lm.lock(2, "A", S)
        lm.lock(3, "A", X)  # queued behind the two S holders
        lm.lock(1, "A", X)  # upgrade: jumps ahead of txn 3
        lm.commit(2)
        self.assertEqual(lm.holders("A"), {1: X})
        self.assertEqual(lm.waiters("A"), [(3, X)])


class TestDeadlock(unittest.TestCase):
    def test_two_txn_cycle_aborts_larger_id(self):
        """Acceptance (a): two-txn cycle, larger txn_id is aborted."""
        lm = LockManager()
        lm.lock(1, "A", X)
        lm.lock(2, "B", X)
        lm.lock(1, "B", X)  # 1 waits for 2
        self.assertIs(lm.lock(2, "A", X), WAITING)  # 2 waits for 1 -> cycle
        self.assertTrue(lm.is_aborted(2))
        self.assertFalse(lm.is_aborted(1))
        # victim's locks released: txn 1's waiting request is now granted
        self.assertEqual(lm.holders("B"), {1: X})
        self.assertEqual(lm.holders("A"), {1: X})

    def test_three_txn_cycle_with_upgrade(self):
        """Acceptance (b): three-txn cycle involving an S->X upgrade."""
        lm = LockManager()
        lm.lock(1, "D", S)
        lm.lock(3, "D", S)
        lm.lock(2, "B", X)
        lm.lock(3, "C", X)
        lm.lock(1, "B", X)   # 1 waits for 2
        lm.lock(2, "C", X)   # 2 waits for 3
        # 3 upgrades D: blocked by 1's S -> 3 waits for 1, closing 1->2->3->1
        self.assertIs(lm.lock(3, "D", X), WAITING)
        self.assertTrue(lm.is_aborted(3))
        self.assertFalse(lm.is_aborted(1))
        self.assertFalse(lm.is_aborted(2))
        # victim's locks released: txn 2 is woken on C, txn 1 still waits
        self.assertEqual(lm.holders("C"), {2: X})
        self.assertEqual(lm.waiters("B"), [(1, X)])

    def test_three_txn_upgrade_cycle_all_three(self):
        """Cycle 1->2->3->1 where one edge comes from an upgrade."""
        lm = LockManager()
        lm.lock(1, "A", S)
        lm.lock(2, "A", S)
        lm.lock(2, "B", X)
        lm.lock(3, "C", X)
        lm.lock(1, "C", X)  # 1 waits for 3
        lm.lock(3, "B", X)  # 3 waits for 2
        lm.lock(2, "A", X)  # upgrade: 2 waits for 1 -> cycle 1->3->2->1
        self.assertTrue(lm.is_aborted(3))  # max id on the cycle
        self.assertFalse(lm.is_aborted(1))
        self.assertFalse(lm.is_aborted(2))

    def test_long_wait_chain_no_false_deadlock(self):
        """Acceptance (c): a long wait chain without a cycle is fine."""
        lm = LockManager()
        n = 10
        lm.lock(1, "R0", X)
        for txn in range(2, n + 1):
            lm.lock(txn, f"R{txn - 1}", X)  # each txn holds one resource
            status = lm.lock(txn, f"R{txn - 2}", X)  # and waits on previous
            self.assertIs(status, WAITING)
            self.assertFalse(lm.is_aborted(txn))
        # resolve the chain from the head
        for txn in range(1, n + 1):
            lm.commit(txn)
        for txn in range(1, n + 1):
            self.assertTrue(lm.is_committed(txn))
            self.assertFalse(lm.is_aborted(txn))

    def test_victim_releases_all_locks_and_wakes_waiters(self):
        lm = LockManager()
        lm.lock(1, "A", X)
        lm.lock(2, "B", X)
        lm.lock(2, "C", X)
        lm.lock(3, "C", S)   # 3 waits for 2
        lm.lock(1, "B", X)   # 1 waits for 2
        lm.lock(2, "A", X)   # cycle 1<->2, victim = 2
        self.assertTrue(lm.is_aborted(2))
        # both of txn 2's locks are gone; waiters woken in FIFO order
        self.assertEqual(lm.holders("B"), {1: X})
        self.assertEqual(lm.holders("C"), {3: S})

    def test_aborted_txn_requests_error_afterwards(self):
        lm = LockManager()
        lm.lock(1, "A", X)
        lm.lock(2, "B", X)
        lm.lock(1, "B", X)
        lm.lock(2, "A", X)  # kills txn 2
        self.assertIs(lm.lock(2, "C", S), ERROR)
        self.assertIs(lm.commit(2), ERROR)


if __name__ == "__main__":
    unittest.main()
