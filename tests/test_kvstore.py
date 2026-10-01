import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from kvstore import (  # noqa: E402
    CorruptError,
    CrashFault,
    StorageError,
    Store,
    TxnError,
)
from kvstore.store import MAGIC, _encode_record  # noqa: E402


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "test.db")

    def recover_view(self):
        with Store.recover(self.db) as store:
            return store.view()


class TestNestedTransactions(StoreTestCase):
    def test_acceptance_a_three_level_rollback_middle(self):
        """3-level nesting; rolling back the middle layer keeps only T1."""
        store = Store.create(self.db)
        store.begin()
        store.put("a", 1)
        store.begin()
        store.put("b", 2)
        store.begin()
        store.put("c", 3)
        store.commit()  # T3 merges into T2
        self.assertEqual(store.view(), {"a": 1, "b": 2, "c": 3})
        store.rollback()  # T2 aborts: b and c (incl. merged T3) vanish
        reference = {"a": 1}  # manual reference view
        self.assertEqual(store.view(), reference)
        store.commit()  # T1 persists
        store.close()
        self.assertEqual(self.recover_view(), reference)

    def test_inner_commit_visible_then_outer_rollback_hides(self):
        store = Store.create(self.db)
        store.begin()
        store.put("x", "outer")
        store.begin()
        store.put("y", "inner")
        store.commit()
        self.assertEqual(store.view(), {"x": "outer", "y": "inner"})
        store.rollback()
        self.assertEqual(store.view(), {})
        store.close()
        self.assertEqual(self.recover_view(), {})

    def test_max_depth_three(self):
        store = Store.create(self.db)
        for _ in range(3):
            store.begin()
        with self.assertRaises(TxnError) as ctx:
            store.begin()
        self.assertEqual(ctx.exception.code, "E_TXN")
        store.close()

    def test_txn_errors(self):
        store = Store.create(self.db)
        for action in (store.commit, store.rollback):
            with self.assertRaises(TxnError) as ctx:
                action()
            self.assertEqual(ctx.exception.code, "E_TXN")
        with self.assertRaises(TxnError):
            store.put("k", 1)
        with self.assertRaises(TxnError):
            store.delete("k")
        store.close()

    def test_delete_semantics(self):
        store = Store.create(self.db)
        store.begin()
        store.put("k", "v1")
        store.commit()
        store.begin()
        store.delete("k")
        self.assertEqual(store.view(), {})
        store.rollback()
        self.assertEqual(store.view(), {"k": "v1"})
        store.begin()
        store.delete("k")
        store.commit()
        store.close()
        self.assertEqual(self.recover_view(), {})


class TestFaultInjection(StoreTestCase):
    def _commit(self, store, key, value):
        store.begin()
        store.put(key, value)
        store.commit()

    def test_acceptance_b_fsync_fail_keeps_old_value(self):
        store = Store.create(self.db)
        self._commit(store, "k", "old")
        store.faults.add("fsync_fail")
        store.begin()
        store.put("k", "new")
        with self.assertRaises(StorageError) as ctx:
            store.commit()
        self.assertEqual(ctx.exception.code, "E_IO")
        # Whole txn aborted: no partial visibility, old value intact.
        self.assertEqual(store.view(), {"k": "old"})
        store.close()
        self.assertEqual(self.recover_view(), {"k": "old"})

    def test_fsync_fail_is_one_shot(self):
        store = Store.create(self.db, faults={"fsync_fail"})
        store.begin()
        store.put("k", 1)
        with self.assertRaises(StorageError):
            store.commit()
        self._commit(store, "k", 2)  # fault consumed; retry succeeds
        store.close()
        self.assertEqual(self.recover_view(), {"k": 2})

    def test_append_before_fault_aborts(self):
        store = Store.create(self.db, faults={"append_before"})
        store.begin()
        store.put("k", "v")
        with self.assertRaises(StorageError) as ctx:
            store.commit()
        self.assertEqual(ctx.exception.code, "E_IO")
        self.assertEqual(store.view(), {})
        store.close()
        self.assertEqual(self.recover_view(), {})

    def test_append_after_crash_not_visible(self):
        store = Store.create(self.db)
        self._commit(store, "base", 1)
        store.faults.add("append_after")
        store.begin()
        store.put("k", "v")
        with self.assertRaises(CrashFault) as ctx:
            store.commit()
        self.assertEqual(ctx.exception.point, "append_after")
        store.close()
        # Data records may be on disk but there is no COMMIT record.
        self.assertEqual(self.recover_view(), {"base": 1})

    def test_acceptance_c_crash_after_commit_replay_visible(self):
        store = Store.create(self.db, faults={"crash_after_commit"})
        store.begin()
        store.put("k1", "v1")
        store.put("k2", "v2")
        with self.assertRaises(CrashFault) as ctx:
            store.commit()
        self.assertEqual(ctx.exception.point, "crash_after_commit")
        store.close()
        # After restart the committed transaction is fully visible.
        self.assertEqual(self.recover_view(), {"k1": "v1", "k2": "v2"})

    def test_unknown_fault_point_rejected(self):
        with self.assertRaises(StorageError):
            Store.create(self.db, faults={"not_a_fault"})


class TestRecovery(StoreTestCase):
    def _seed_committed(self):
        store = Store.create(self.db)
        store.begin()
        store.put("k1", 1)
        store.commit()
        store.begin()
        store.put("k2", 2)
        store.delete("k1")
        store.commit()
        store.close()
        return {"k2": 2}  # reference enumeration of committed state

    def test_acceptance_d_torn_tail_truncated(self):
        reference = self._seed_committed()
        size_before = os.path.getsize(self.db)
        # Simulate a half-written record at the tail.
        with open(self.db, "ab") as handle:
            handle.write(b"\x00\x00\x00\x40{\"op\": \"put\", \"k\":")
        with Store.recover(self.db) as store:
            self.assertEqual(sorted(store.view().items()), sorted(reference.items()))
        # Tail truncated; previously committed records preserved.
        self.assertEqual(os.path.getsize(self.db), size_before)
        # Store still accepts new commits after truncation.
        store = Store.recover(self.db)
        store.begin()
        store.put("k3", 3)
        store.commit()
        store.close()
        self.assertEqual(self.recover_view(), {"k2": 2, "k3": 3})

    def test_crc_mismatch_tail_truncated(self):
        reference = self._seed_committed()
        size_before = os.path.getsize(self.db)
        record = bytearray(_encode_record({"op": "put", "k": "bad", "v": 1}))
        record[-1] ^= 0xFF  # corrupt the CRC
        record += _encode_record({"op": "commit"})
        with open(self.db, "ab") as handle:
            handle.write(bytes(record))
        self.assertEqual(self.recover_view(), reference)
        self.assertEqual(os.path.getsize(self.db), size_before)

    def test_uncommitted_records_without_commit_discarded(self):
        reference = self._seed_committed()
        with open(self.db, "ab") as handle:
            handle.write(_encode_record({"op": "put", "k": "ghost", "v": 9}))
        self.assertEqual(self.recover_view(), reference)

    def test_bad_header_is_e_corrupt(self):
        with open(self.db, "wb") as handle:
            handle.write(b"NOTAKVLOG" + b"\x00" * 32)
        with self.assertRaises(CorruptError) as ctx:
            Store.recover(self.db)
        self.assertEqual(ctx.exception.code, "E_CORRUPT")

    def test_magic_written_on_create(self):
        Store.create(self.db).close()
        with open(self.db, "rb") as handle:
            self.assertEqual(handle.read(len(MAGIC)), MAGIC)


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "cli.db")
        self.script = os.path.join(self.tmp.name, "script.json")
        self.faults = os.path.join(self.tmp.name, "faults.json")

    def _write(self, path, data):
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle)

    def _run_cli(self, *extra_args):
        env = dict(os.environ, PYTHONPATH=ROOT)
        return subprocess.run(
            [sys.executable, "-m", "kvstore", "run", self.script,
             "--db", self.db, *extra_args],
            capture_output=True, text=True, cwd=self.tmp.name, env=env,
        )

    def _lines(self, proc):
        return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]

    def test_cli_script_views_and_exit_zero(self):
        self._write(self.script, [
            {"op": "begin"},
            {"op": "put", "key": "a", "value": 1},
            {"op": "begin"},
            {"op": "put", "key": "b", "value": 2},
            {"op": "rollback"},
            {"op": "commit"},
            {"op": "view"},
        ])
        proc = self._run_cli()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self._lines(proc)
        self.assertEqual(len(lines), 7)
        self.assertTrue(all(line["status"] == "ok" for line in lines))
        self.assertEqual(lines[1]["view"], {"a": 1})
        self.assertEqual(lines[3]["view"], {"a": 1, "b": 2})
        self.assertEqual(lines[4]["view"], {"a": 1})
        self.assertEqual(lines[-1]["view"], {"a": 1})

    def test_cli_step_error_reported_and_run_continues(self):
        self._write(self.script, [
            {"op": "commit"},  # no active txn -> E_TXN
            {"op": "begin"},
            {"op": "put", "key": "x", "value": 1},
            {"op": "commit"},
        ])
        proc = self._run_cli()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self._lines(proc)
        self.assertEqual(lines[0]["status"], "error")
        self.assertEqual(lines[0]["code"], "E_TXN")
        self.assertEqual(lines[-1]["view"], {"x": 1})

    def test_cli_fsync_fail_then_replay(self):
        self._write(self.script, [
            {"op": "begin"},
            {"op": "put", "key": "k", "value": "old"},
            {"op": "commit"},
        ])
        self.assertEqual(self._run_cli().returncode, 0)
        self._write(self.faults, ["fsync_fail"])
        self._write(self.script, [
            {"op": "begin"},
            {"op": "put", "key": "k", "value": "new"},
            {"op": "commit"},
            {"op": "view"},
        ])
        proc = self._run_cli("--inject", self.faults, "--replay")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self._lines(proc)
        self.assertEqual(lines[2]["status"], "error")
        self.assertEqual(lines[2]["code"], "E_IO")
        self.assertEqual(lines[3]["view"], {"k": "old"})

    def test_cli_crash_after_commit_exit3_then_replay(self):
        self._write(self.faults, ["crash_after_commit"])
        self._write(self.script, [
            {"op": "begin"},
            {"op": "put", "key": "k", "value": "new"},
            {"op": "commit"},
        ])
        proc = self._run_cli("--inject", self.faults)
        self.assertEqual(proc.returncode, 3)
        lines = self._lines(proc)
        self.assertEqual(lines[-1]["status"], "crash")
        self.assertEqual(lines[-1]["point"], "crash_after_commit")
        # Restart with --replay: committed txn fully visible.
        self._write(self.script, [{"op": "view"}])
        proc = self._run_cli("--replay")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self._lines(proc)[-1]["view"], {"k": "new"})

    def test_cli_corrupt_log_exit3(self):
        with open(self.db, "wb") as handle:
            handle.write(b"GARBAGE HEADER")
        self._write(self.script, [{"op": "view"}])
        proc = self._run_cli("--replay")
        self.assertEqual(proc.returncode, 3)
        lines = self._lines(proc)
        self.assertEqual(lines[0]["code"], "E_CORRUPT")

    def test_cli_torn_tail_replay(self):
        self._write(self.script, [
            {"op": "begin"},
            {"op": "put", "key": "k1", "value": 1},
            {"op": "commit"},
        ])
        self.assertEqual(self._run_cli().returncode, 0)
        with open(self.db, "ab") as handle:
            handle.write(b"\x00\x00\x00\x10{\"op\":")
        self._write(self.script, [{"op": "view"}])
        proc = self._run_cli("--replay")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self._lines(proc)[-1]["view"], {"k1": 1})


if __name__ == "__main__":
    unittest.main()
