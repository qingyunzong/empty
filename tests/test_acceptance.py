"""Acceptance tests A-D for tenantq."""

import unittest

from tenantq.core import (
    E_CONFIG,
    E_CONFLICT,
    E_QUOTA,
    E_STATE,
    Engine,
    PolicyError,
)


def build_chain():
    """root(5) <- mid(8) <- leaf(5) for resource 'cpu'."""
    engine = Engine()
    engine.add_tenant("root")
    engine.add_tenant("mid", parent="root")
    engine.add_tenant("leaf", parent="mid")
    engine.set_quota("root", "cpu", 5)
    engine.set_quota("mid", "cpu", 8)
    engine.set_quota("leaf", "cpu", 5)
    return engine


def pending(engine, tid, resource="cpu"):
    return engine.tenants[tid]["pending"].get(resource, 0)


def used(engine, tid, resource="cpu"):
    return engine.tenants[tid]["used"].get(resource, 0)


class TestRollbackOnParentShortage(unittest.TestCase):
    """A: insufficient quota at a parent rolls back the whole chain."""

    def test_parent_shortage_rolls_back_all_levels(self):
        engine = build_chain()
        engine.reserve("leaf", "cpu", 3, key="k1")
        self.assertEqual([pending(engine, t) for t in ("leaf", "mid", "root")], [3, 3, 3])

        # leaf has 2 free, mid has 5 free, root has only 2 free -> ask for 4.
        before = engine.to_dict()
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("leaf", "cpu", 4, key="k2")
        self.assertEqual(ctx.exception.code, E_QUOTA)

        # Every level's pending/used is back to the pre-operation values.
        self.assertEqual([pending(engine, t) for t in ("leaf", "mid", "root")], [3, 3, 3])
        self.assertEqual([used(engine, t) for t in ("leaf", "mid", "root")], [0, 0, 0])
        after = engine.to_dict()
        self.assertEqual(before["tenants"], after["tenants"])

    def test_mid_level_shortage_rolls_back_deeper_levels(self):
        engine = Engine()
        engine.add_tenant("root")
        engine.add_tenant("mid", parent="root")
        engine.add_tenant("leaf", parent="mid")
        engine.set_quota("root", "cpu", 100)
        engine.set_quota("mid", "cpu", 2)
        engine.set_quota("leaf", "cpu", 100)
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("leaf", "cpu", 5, key="k1")
        self.assertEqual(ctx.exception.code, E_QUOTA)
        # leaf was incremented before mid failed; it must be rolled back.
        self.assertEqual([pending(engine, t) for t in ("leaf", "mid", "root")], [0, 0, 0])

    def test_failed_reserve_records_failed_reservation(self):
        engine = build_chain()
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("leaf", "cpu", 99, key="k1")
        rid = ctx.exception.reservation_id
        self.assertIsNotNone(rid)
        self.assertEqual(engine.reservations[rid]["state"], "failed")


class TestIdempotentRetry(unittest.TestCase):
    """B: retrying a successful reserve with the same key is idempotent."""

    def test_same_key_returns_original_result_without_double_charge(self):
        engine = build_chain()
        first = engine.reserve("leaf", "cpu", 2, key="retry-key")
        second = engine.reserve("leaf", "cpu", 2, key="retry-key")
        self.assertEqual(first, second)
        self.assertEqual(first["reservation_id"], second["reservation_id"])
        # Charged exactly once along the whole chain.
        self.assertEqual([pending(engine, t) for t in ("leaf", "mid", "root")], [2, 2, 2])

    def test_same_key_different_payload_conflicts(self):
        engine = build_chain()
        engine.reserve("leaf", "cpu", 2, key="k")
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("leaf", "cpu", 3, key="k")
        self.assertEqual(ctx.exception.code, E_CONFLICT)
        self.assertEqual(pending(engine, "leaf"), 2)

    def test_failed_reserve_is_not_cached_and_can_be_retried(self):
        engine = build_chain()
        with self.assertRaises(PolicyError):
            engine.reserve("leaf", "cpu", 99, key="k")
        ok = engine.reserve("leaf", "cpu", 1, key="k")
        self.assertEqual(ok["state"], "pending")
        self.assertEqual(pending(engine, "leaf"), 1)


class TestConfirmStateErrors(unittest.TestCase):
    """C: confirming a missing or failed reservation raises E_STATE."""

    def test_confirm_failed_reservation(self):
        engine = build_chain()
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("leaf", "cpu", 99, key="k")
        rid = ctx.exception.reservation_id
        before = engine.to_dict()
        with self.assertRaises(PolicyError) as ctx2:
            engine.confirm(rid)
        self.assertEqual(ctx2.exception.code, E_STATE)
        # State must not silently change.
        self.assertEqual(engine.reservations[rid]["state"], "failed")
        self.assertEqual(before["tenants"], engine.to_dict()["tenants"])

    def test_confirm_unknown_reservation(self):
        engine = build_chain()
        with self.assertRaises(PolicyError) as ctx:
            engine.confirm("rsv-99999999")
        self.assertEqual(ctx.exception.code, E_STATE)

    def test_illegal_transitions_all_raise_e_state(self):
        engine = build_chain()
        rsv = engine.reserve("leaf", "cpu", 2, key="k")
        rid = rsv["reservation_id"]
        # release of a pending reservation
        with self.assertRaises(PolicyError) as ctx:
            engine.release(rid)
        self.assertEqual(ctx.exception.code, E_STATE)
        engine.confirm(rid)
        # double confirm
        with self.assertRaises(PolicyError) as ctx:
            engine.confirm(rid)
        self.assertEqual(ctx.exception.code, E_STATE)
        engine.release(rid)
        # confirm after release, double release
        for op in (engine.confirm, engine.release):
            with self.assertRaises(PolicyError) as ctx:
                op(rid)
            self.assertEqual(ctx.exception.code, E_STATE)
        self.assertEqual(engine.reservations[rid]["state"], "released")

    def test_confirm_then_release_moves_pending_to_used_to_zero(self):
        engine = build_chain()
        rid = engine.reserve("leaf", "cpu", 2, key="k")["reservation_id"]
        engine.confirm(rid)
        self.assertEqual([pending(engine, t) for t in ("leaf", "mid", "root")], [0, 0, 0])
        self.assertEqual([used(engine, t) for t in ("leaf", "mid", "root")], [2, 2, 2])
        engine.release(rid)
        self.assertEqual([used(engine, t) for t in ("leaf", "mid", "root")], [0, 0, 0])


class TestZeroAndMissingQuota(unittest.TestCase):
    """D: quota 0 forbids; missing quota node is E_CONFIG, not infinity."""

    def test_zero_quota_rejects_any_reservation(self):
        engine = Engine()
        engine.add_tenant("t")
        engine.set_quota("t", "cpu", 0)
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("t", "cpu", 1, key="k")
        self.assertEqual(ctx.exception.code, E_QUOTA)
        self.assertEqual(pending(engine, "t"), 0)

    def test_missing_quota_node_raises_e_config(self):
        engine = build_chain()
        # 'gpu' is not configured anywhere in the chain.
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("leaf", "gpu", 1, key="k")
        self.assertEqual(ctx.exception.code, E_CONFIG)

    def test_missing_quota_mid_chain_raises_e_config_and_rolls_back(self):
        engine = Engine()
        engine.add_tenant("root")
        engine.add_tenant("leaf", parent="root")
        engine.set_quota("leaf", "cpu", 10)
        # root has no 'cpu' quota node -> E_CONFIG, leaf pending rolled back.
        with self.assertRaises(PolicyError) as ctx:
            engine.reserve("leaf", "cpu", 1, key="k")
        self.assertEqual(ctx.exception.code, E_CONFIG)
        self.assertEqual(pending(engine, "leaf"), 0)


if __name__ == "__main__":
    unittest.main()
