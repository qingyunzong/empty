import os
import random
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from genstore import (  # noqa: E402
    GenStore,
    OP_DEL,
    OP_SET,
    PageCorruptError,
    SimulatedCrash,
    StoreError,
    set_fault,
)
from genstore import store as store_mod  # noqa: E402


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "store.gs")
        set_fault(None)

    def tearDown(self):
        set_fault(None)

    # -- helpers --

    def run_cli(self, *args, fault=None):
        env = dict(os.environ)
        env["GENSTORE_PATH"] = self.path
        env["PYTHONPATH"] = REPO_ROOT
        if fault:
            env["GENSTORE_FAULT"] = fault
        return subprocess.run(
            [sys.executable, "-m", "genstore", *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=REPO_ROOT,
        )

    def cli_get(self, key):
        return self.run_cli("get", key)

    def cli_gen(self):
        result = self.run_cli("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        return int(result.stdout.strip().split("=")[1])

    @staticmethod
    def corrupt(path, offset, nbytes=8):
        with open(path, "r+b") as fh:
            fh.seek(offset)
            fh.write(b"\xAA" * nbytes)


class TestBasicFlow(StoreTestCase):
    def test_cli_txn_commit_get_status(self):
        self.assertEqual(self.run_cli("txn", "set", "a", "1").returncode, 0)
        result = self.run_cli("commit")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("G=1", result.stdout)
        result = self.cli_get("a")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "1")
        self.assertEqual(self.cli_gen(), 1)

    def test_uncommitted_txn_is_invisible(self):
        with GenStore(self.path) as store:
            store.txn_op(OP_SET, b"k", b"v")
            self.assertIsNone(store.get(b"k"))  # tail not yet applied
            self.assertEqual(store.G, 0)

    def test_multiple_keys_and_delete(self):
        with GenStore(self.path) as store:
            for i in range(50):
                store.txn_op(OP_SET, f"key{i}".encode(), f"val{i}".encode())
            store.commit()
            store.txn_op(OP_DEL, b"key7")
            store.txn_op(OP_SET, b"key3", b"updated")
            store.commit()
            self.assertEqual(store.G, 2)
            self.assertIsNone(store.get(b"key7"))
            self.assertEqual(store.get(b"key3"), b"updated")
            self.assertEqual(store.get(b"key49"), b"val49")
            self.assertEqual(len(store.dump()), 49)


class TestFaultPoints(StoreTestCase):
    def test_fault_A_get_returns_old_value(self):
        self.run_cli("txn", "set", "k", "old")
        self.run_cli("commit")
        self.assertEqual(self.cli_gen(), 1)
        # Power loss in the middle of writing the redo record.
        crashed = self.run_cli("txn", "set", "k", "new", fault="A")
        self.assertNotEqual(crashed.returncode, 0)
        self.assertEqual(self.run_cli("recover").returncode, 0)
        result = self.cli_get("k")
        self.assertEqual(result.stdout.strip(), "old")
        self.assertEqual(self.cli_gen(), 1)  # G unchanged

    def test_fault_B_get_returns_old_value(self):
        self.run_cli("txn", "set", "k", "old")
        self.run_cli("commit")
        self.run_cli("txn", "set", "k", "new")
        # Power loss after the redo, before the commit marker.
        crashed = self.run_cli("commit", fault="B")
        self.assertNotEqual(crashed.returncode, 0)
        self.assertEqual(self.run_cli("recover").returncode, 0)
        result = self.cli_get("k")
        self.assertEqual(result.stdout.strip(), "old")
        self.assertEqual(self.cli_gen(), 1)

    def test_fault_C_new_value_visible_and_G_not_duplicated(self):
        self.run_cli("txn", "set", "k", "old")
        self.run_cli("commit")
        self.run_cli("txn", "set", "k", "new")
        # Power loss after the commit marker, before the header update.
        crashed = self.run_cli("commit", fault="C")
        self.assertNotEqual(crashed.returncode, 0)
        self.assertEqual(self.run_cli("recover").returncode, 0)
        result = self.cli_get("k")
        self.assertEqual(result.stdout.strip(), "new")
        self.assertEqual(self.cli_gen(), 2)
        # Recovery is idempotent: G must not be bumped twice.
        self.assertEqual(self.run_cli("recover").returncode, 0)
        self.assertEqual(self.cli_gen(), 2)
        result = self.cli_get("k")
        self.assertEqual(result.stdout.strip(), "new")

    def test_fault_D_equivalent_to_normal_commit(self):
        # Reference: normal commit.
        self.run_cli("txn", "set", "k", "v1")
        self.run_cli("txn", "set", "x", "y")
        self.run_cli("commit")
        normal_dump = self.run_cli("dump").stdout
        normal_gen = self.cli_gen()
        # Crashed run: same operations, power loss after the header update.
        path2 = os.path.join(self.tmp.name, "store2.gs")
        env = dict(os.environ)
        env["GENSTORE_PATH"] = path2
        env["PYTHONPATH"] = REPO_ROOT

        def run2(*args, fault=None):
            e = dict(env)
            if fault:
                e["GENSTORE_FAULT"] = fault
            return subprocess.run(
                [sys.executable, "-m", "genstore", *args],
                capture_output=True, text=True, env=e, cwd=REPO_ROOT,
            )

        run2("txn", "set", "k", "v1")
        run2("txn", "set", "x", "y")
        crashed = run2("commit", fault="D")
        self.assertNotEqual(crashed.returncode, 0)
        self.assertEqual(run2("recover").returncode, 0)
        self.assertEqual(run2("dump").stdout, normal_dump)
        self.assertEqual(run2("status").stdout.strip(), f"G={normal_gen}")


class TestRollback(StoreTestCase):
    def test_rollback_discards_uncommitted_tail(self):
        with GenStore(self.path) as store:
            store.txn_op(OP_SET, b"k", b"committed")
            store.commit()
            store.txn_op(OP_SET, b"k", b"dirty")
            self.assertTrue(store.rollback())
            self.assertEqual(store.get(b"k"), b"committed")
            self.assertEqual(store.G, 1)
            self.assertFalse(store.rollback())  # nothing left to roll back

    def test_rollback_refused_after_commit_marker(self):
        store = GenStore(self.path)
        store.txn_op(OP_SET, b"k", b"v")
        set_fault("C")
        with self.assertRaises(SimulatedCrash):
            store.commit()  # commit marker durable, header not updated
        store.close()
        # Reopen without recovery: the committed tail must not be rollable.
        store = GenStore(self.path, recover=False)
        with self.assertRaises(StoreError):
            store.rollback()
        store.close()
        # Recovery still completes the committed transaction.
        with GenStore(self.path) as store:
            self.assertEqual(store.get(b"k"), b"v")
            self.assertEqual(store.G, 1)

    def test_committed_generations_cannot_be_rolled_back(self):
        with GenStore(self.path) as store:
            store.txn_op(OP_SET, b"k", b"v")
            store.commit()
            self.assertFalse(store.rollback())  # journal already clean
            self.assertEqual(store.get(b"k"), b"v")
            self.assertEqual(store.G, 1)


class TestCorruption(StoreTestCase):
    def test_page_crc_error_locates_page_number(self):
        with GenStore(self.path) as store:
            store.txn_op(OP_SET, b"alpha", b"1")
            store.commit()
        # First commit allocates leaf=page 66, middle=67, root=68.
        leaf_page = store_mod.FIRST_DATA_PAGE
        self.corrupt(self.path, leaf_page * store_mod.PAGE_SIZE + 100)
        with GenStore(self.path) as store:
            with self.assertRaises(PageCorruptError) as ctx:
                store.get(b"alpha")
            self.assertEqual(ctx.exception.page_no, leaf_page)
            self.assertIn(str(leaf_page), str(ctx.exception))

    def test_root_corrupt_falls_back_to_backup_header(self):
        with GenStore(self.path) as store:
            store.txn_op(OP_SET, b"k", b"v")
            store.commit()  # G=1, root at page 68, backup header G=0
        root_page = store_mod.FIRST_DATA_PAGE + 2
        self.corrupt(self.path, root_page * store_mod.PAGE_SIZE + 10)
        with GenStore(self.path) as store:
            self.assertFalse(store.recovered_empty)
            self.assertEqual(store.G, 0)  # previous generation still valid
            self.assertIsNone(store.get(b"k"))

    def test_root_corrupt_no_valid_backup_gives_empty_store(self):
        with GenStore(self.path) as store:
            store.txn_op(OP_SET, b"k", b"v")
            store.commit()
        root_page = store_mod.FIRST_DATA_PAGE + 2
        self.corrupt(self.path, root_page * store_mod.PAGE_SIZE + 10)
        self.corrupt(self.path, 0, 16)  # destroy the backup header (slot 0)
        result = self.run_cli("recover")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("EmptyStore", result.stdout)
        self.assertEqual(self.cli_gen(), 0)
        self.assertEqual(self.cli_get("k").returncode, 1)

    def test_both_headers_corrupt_gives_empty_store(self):
        with GenStore(self.path) as store:
            store.txn_op(OP_SET, b"k", b"v")
            store.commit()
        self.corrupt(self.path, 0, 16)
        self.corrupt(self.path, store_mod.PAGE_SIZE, 16)
        with GenStore(self.path) as store:
            self.assertTrue(store.recovered_empty)
            self.assertEqual(store.G, 0)
            self.assertEqual(store.dump(), {})


class TestRandomFaultInjection(StoreTestCase):
    def test_random_200_transactions_vs_reference_model(self):
        rng = random.Random(20261008)
        keys = [f"k{i}".encode() for i in range(12)]
        model = {}
        gen = 0
        store = GenStore(self.path)
        try:
            for txn_no in range(200):
                ops = []
                for _ in range(rng.randint(1, 3)):
                    key = rng.choice(keys)
                    if rng.random() < 0.7:
                        ops.append((OP_SET, key, f"v{txn_no}".encode()))
                    else:
                        ops.append((OP_DEL, key, b""))
                fault = rng.choice([None, "A", "B", "C", "D"])

                if fault is None and rng.random() < 0.15:
                    # Rollback of an uncommitted tail.
                    for op, key, value in ops:
                        store.txn_op(op, key, value)
                    store.rollback()
                    store.close()
                    store = GenStore(self.path)
                    self.assertEqual(store.G, gen, f"txn {txn_no}: rollback")
                    self.assertEqual(store.dump(), model, f"txn {txn_no}")
                    continue

                crashed = None
                if fault == "A":
                    crash_at = rng.randrange(len(ops))
                    for j, (op, key, value) in enumerate(ops):
                        if j == crash_at:
                            set_fault("A")
                        try:
                            store.txn_op(op, key, value)
                        except SimulatedCrash:
                            crashed = "A"
                            break
                        finally:
                            set_fault(None)
                else:
                    for op, key, value in ops:
                        store.txn_op(op, key, value)

                if crashed != "A":
                    if fault in ("B", "C", "D"):
                        set_fault(fault)
                    try:
                        store.commit()
                    except SimulatedCrash:
                        crashed = fault
                    finally:
                        set_fault(None)

                store.close()
                store = GenStore(self.path)  # reopen: runs recovery

                # Reference state machine per the log rules:
                #   A/B -> transaction discarded, G unchanged
                #   C/D/normal -> transaction applied, G += 1
                if crashed not in ("A", "B"):
                    for op, key, value in ops:
                        if op == OP_SET:
                            model[key] = value
                        else:
                            model.pop(key, None)
                    gen += 1

                self.assertEqual(
                    store.G, gen, f"txn {txn_no}: fault={fault} crashed={crashed}"
                )
                self.assertEqual(
                    store.dump(),
                    model,
                    f"txn {txn_no}: fault={fault} crashed={crashed}",
                )
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
