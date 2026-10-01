import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import waldb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = [sys.executable, os.path.join(ROOT, "waldb.py")]


def reference_apply(state, ops):
    """Independent reference replay: apply one committed transaction."""
    for op in ops:
        if op[0] == "put":
            state[op[1]] = op[2]
        elif op[0] == "del":
            state.pop(op[1], None)


class WaldbTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "test.wal")

    def raw(self):
        with open(self.path, "rb") as f:
            return f.read()

    def truncate(self, size):
        with open(self.path, "r+b") as f:
            f.truncate(size)

    def append_raw(self, blob):
        with open(self.path, "ab") as f:
            f.write(blob)


class TestBasicOps(WaldbTestCase):
    def test_put_get_roundtrip(self):
        db = waldb.WalDB(self.path)
        db.put("hello", "world")
        db.put("utf8-key-\u952e", "utf8-value-\u503c")
        reopened = waldb.WalDB(self.path)
        self.assertEqual(reopened.get("hello"), "world")
        self.assertEqual(reopened.get("utf8-key-\u952e"), "utf8-value-\u503c")

    def test_duplicate_key_overwrites(self):
        db = waldb.WalDB(self.path)
        db.put("k", "v1")
        db.put("k", "v2")
        db.put("k", "v3")
        reopened = waldb.WalDB(self.path)
        self.assertEqual(reopened.get("k"), "v3")

    def test_delete(self):
        db = waldb.WalDB(self.path)
        db.put("k", "v")
        db.delete("k")
        db.delete("missing")
        reopened = waldb.WalDB(self.path)
        self.assertIsNone(reopened.get("k"))

    def test_multi_op_transaction(self):
        db = waldb.WalDB(self.path)
        db.commit([("put", "a", "1"), ("put", "b", "2"), ("del", "a")])
        reopened = waldb.WalDB(self.path)
        self.assertEqual(reopened.dump(), {"b": "2"})


class TestRecovery(WaldbTestCase):
    def committed_file(self, txns):
        waldb.WalDB(self.path)
        for ops in txns:
            self.append_raw(waldb.encode_ops(ops) + waldb.encode_commit())

    def test_truncate_mid_put_frame(self):
        self.committed_file([[("put", "stable", "1")]])
        frame = waldb.encode_ops([("put", "doomed", "x")])
        self.append_raw(frame[: len(frame) // 2])
        size_before = os.path.getsize(self.path)

        waldb.recover(self.path)

        db = waldb.WalDB(self.path)
        self.assertEqual(db.dump(), {"stable": "1"})
        self.assertLess(os.path.getsize(self.path), size_before)
        db.put("after", "recovery")
        self.assertEqual(waldb.WalDB(self.path).get("after"), "recovery")

    def test_truncate_after_commit_no_effect(self):
        self.committed_file([
            [("put", "a", "1")],
            [("put", "b", "2"), ("del", "a")],
        ])
        waldb.recover(self.path)
        db = waldb.WalDB(self.path)
        self.assertEqual(db.dump(), {"b": "2"})

    def test_uncommitted_transaction_dropped(self):
        self.committed_file([[("put", "kept", "1")]])
        self.append_raw(waldb.encode_ops([("put", "lost", "2"), ("del", "kept")]))
        waldb.recover(self.path)
        db = waldb.WalDB(self.path)
        self.assertEqual(db.dump(), {"kept": "1"})
        expected = (waldb.HEADER_SIZE
                    + len(waldb.encode_ops([("put", "kept", "1")]))
                    + len(waldb.encode_commit()))
        self.assertEqual(os.path.getsize(self.path), expected)

    def test_crc_corruption_truncates(self):
        self.committed_file([[("put", "good", "1")], [("put", "bad", "2")]])
        data = bytearray(self.raw())
        first_txn_len = (len(waldb.encode_ops([("put", "good", "1")]))
                         + len(waldb.encode_commit()))
        flip_at = waldb.HEADER_SIZE + first_txn_len + waldb.FRAME_HEADER_SIZE + 3
        data[flip_at] ^= 0xFF
        with open(self.path, "wb") as f:
            f.write(data)
        waldb.recover(self.path)
        db = waldb.WalDB(self.path)
        self.assertEqual(db.dump(), {"good": "1"})
        self.assertEqual(os.path.getsize(self.path),
                         waldb.HEADER_SIZE + first_txn_len)

    def test_header_corruption_resets_to_empty(self):
        self.committed_file([[("put", "k", "v")]])
        self.truncate(3)
        waldb.recover(self.path)
        db = waldb.WalDB(self.path)
        self.assertEqual(db.dump(), {})
        db.put("new", "value")
        self.assertEqual(waldb.WalDB(self.path).get("new"), "value")

    def test_recover_missing_file_creates_empty_db(self):
        waldb.recover(self.path)
        self.assertEqual(waldb.WalDB(self.path).dump(), {})

    def test_recover_bumps_generation(self):
        self.committed_file([[("put", "k", "v")]])
        gen_before = waldb.HEADER_STRUCT.unpack_from(self.raw(), 0)[0]
        gen_after = waldb.recover(self.path)
        self.assertEqual(gen_after, gen_before + 1)
        self.assertEqual(
            waldb.HEADER_STRUCT.unpack_from(self.raw(), 0)[0], gen_after)

    def test_random_fault_injection_100_transactions(self):
        rng = random.Random(20261001)
        waldb.WalDB(self.path)
        reference = {}
        fault_points = ["mid_frame", "before_commit", "after_commit"]
        counts = dict.fromkeys(fault_points, 0)

        for i in range(100):
            n_ops = rng.randrange(1, 4)
            ops = []
            for _ in range(n_ops):
                key = f"key{rng.randrange(20)}"
                if rng.random() < 0.25:
                    ops.append(("del", key))
                else:
                    ops.append(("put", key, f"val{i}"))

            frames = waldb.encode_ops(ops)
            commit = waldb.encode_commit()
            fault = rng.choice(fault_points)
            counts[fault] += 1

            if fault == "mid_frame":
                blob = frames + commit
                cut = rng.randrange(1, len(blob))
                self.append_raw(blob[:cut])
                committed = False
            elif fault == "before_commit":
                self.append_raw(frames)
                committed = False
            else:
                self.append_raw(frames + commit)
                committed = True

            waldb.recover(self.path)
            if committed:
                reference_apply(reference, ops)

            db = waldb.WalDB(self.path)
            self.assertEqual(db.dump(), reference,
                             f"mismatch at txn {i} (fault={fault})")

        for point in fault_points:
            self.assertGreater(counts[point], 0, f"{point} never injected")


class TestCli(WaldbTestCase):
    def run_cli(self, *args):
        return subprocess.run(
            CLI + list(args) + ["--db", self.path],
            capture_output=True, text=True)

    def test_put_get_del_dump_flow(self):
        r = self.run_cli("put", "alpha", "1")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.run_cli("put", "beta", "2")
        self.assertEqual(r.returncode, 0, r.stderr)

        r = self.run_cli("get", "alpha")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "1")

        r = self.run_cli("del", "alpha")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.run_cli("get", "alpha")
        self.assertEqual(r.returncode, 5)

        r = self.run_cli("dump")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "beta=2")

    def test_get_missing_key_exit_5(self):
        r = self.run_cli("get", "nope")
        self.assertEqual(r.returncode, 5)
        self.assertIn("not found", r.stderr)

    def test_cli_recover_after_torn_write(self):
        r = self.run_cli("put", "k", "v")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.append_raw(waldb.encode_ops([("put", "torn", "x")])[:7])
        r = self.run_cli("recover")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.run_cli("dump")
        self.assertEqual(r.stdout.strip(), "k=v")

    def test_cli_corrupt_header_requires_recover(self):
        self.run_cli("put", "k", "v")
        self.truncate(2)
        r = self.run_cli("get", "k")
        self.assertEqual(r.returncode, 5)
        r = self.run_cli("recover")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.run_cli("dump")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_cli_usage_error_exit_5(self):
        r = subprocess.run(CLI + ["put", "onlykey", "--db", self.path],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 5)


if __name__ == "__main__":
    unittest.main()
