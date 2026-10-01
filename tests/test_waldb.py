import os
import random
import string
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import waldb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = [sys.executable, os.path.join(ROOT, "waldb.py")]


class WaldbTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "test.wal")

    def tearDown(self):
        self.tmp.cleanup()

    def size(self):
        return os.path.getsize(self.db)

    def truncate(self, offset):
        with open(self.db, "r+b") as f:
            f.truncate(offset)


class TestBasicOps(WaldbTestBase):
    def test_put_get_overwrite_duplicate_key(self):
        waldb.cmd_put(self.db, "k", "v1")
        waldb.cmd_put(self.db, "k", "v2")
        waldb.cmd_put(self.db, "k", "v3")
        self.assertEqual(waldb.recover(self.db), {"k": "v3"})

    def test_del_removes_key(self):
        waldb.cmd_put(self.db, "a", "1")
        waldb.cmd_put(self.db, "b", "2")
        waldb.cmd_del(self.db, "a")
        self.assertEqual(waldb.recover(self.db), {"b": "2"})

    def test_utf8_keys_values(self):
        waldb.cmd_put(self.db, "键", "值€")
        self.assertEqual(waldb.recover(self.db), {"键": "值€"})

    def test_uncommitted_txn_not_replayed(self):
        waldb.cmd_put(self.db, "a", "1")
        with open(self.db, "ab") as f:
            f.write(waldb.encode_put("b", "2"))
        self.assertEqual(waldb.recover(self.db), {"a": "1"})
        waldb.cmd_put(self.db, "c", "3")
        self.assertEqual(waldb.recover(self.db), {"a": "1", "c": "3"})

    def test_corrupt_header_gives_empty_db(self):
        waldb.cmd_put(self.db, "a", "1")
        self.truncate(4)
        self.assertEqual(waldb.recover(self.db), {})
        waldb.cmd_put(self.db, "x", "y")
        self.assertEqual(waldb.recover(self.db), {"x": "y"})

    def test_crc_corruption_truncates(self):
        waldb.cmd_put(self.db, "a", "1")
        good_end = self.size()
        waldb.cmd_put(self.db, "b", "2")
        with open(self.db, "r+b") as f:
            f.seek(good_end + 8)
            byte = f.read(1)
            f.seek(good_end + 8)
            f.write(bytes([byte[0] ^ 0xFF]))
        self.assertEqual(waldb.recover(self.db), {"a": "1"})
        self.assertEqual(self.size(), good_end)


class TestCrashRecovery(WaldbTestBase):
    def test_truncate_mid_put_frame_txn_gone_and_writable(self):
        waldb.cmd_put(self.db, "stable", "0")
        committed_end = self.size()
        waldb.cmd_put(self.db, "victim", "x" * 100)
        full = self.size()
        cut = committed_end + (full - committed_end) // 3
        self.truncate(cut)
        self.assertEqual(waldb.recover(self.db), {"stable": "0"})
        self.assertEqual(self.size(), committed_end)
        waldb.cmd_put(self.db, "after", "ok")
        self.assertEqual(waldb.recover(self.db), {"stable": "0", "after": "ok"})

    def test_truncate_after_commit_no_effect(self):
        waldb.cmd_put(self.db, "a", "1")
        waldb.cmd_put(self.db, "b", "2")
        end = self.size()
        self.truncate(end)
        self.assertEqual(waldb.recover(self.db), {"a": "1", "b": "2"})

    def test_truncate_before_commit_drops_last_txn(self):
        waldb.cmd_put(self.db, "a", "1")
        waldb.cmd_put(self.db, "b", "2")
        commit_len = len(waldb.encode_commit())
        self.truncate(self.size() - commit_len)
        self.assertEqual(waldb.recover(self.db), {"a": "1"})

    def test_random_fault_injection_100_txns(self):
        rng = random.Random(20261001)
        alphabet = string.ascii_lowercase
        for round_no in range(20):
            with self.subTest(round=round_no):
                db = os.path.join(self.tmp.name, "fuzz%d.wal" % round_no)
                waldb.init_db(db)
                txn_commits = []
                for _ in range(100):
                    data_start = os.path.getsize(db)
                    ops = []
                    for _ in range(rng.randint(1, 3)):
                        key = "".join(rng.choices(alphabet, k=rng.randint(1, 4)))
                        if rng.random() < 0.25:
                            ops.append(("del", key))
                        else:
                            val = "".join(rng.choices(alphabet, k=4))
                            ops.append(("put", key, val))
                    waldb.append_txn(db, ops)
                    commit_len = len(waldb.encode_commit())
                    commit_end = os.path.getsize(db)
                    txn_commits.append(
                        (data_start, commit_end - commit_len, commit_end, ops))

                txn_idx = rng.randrange(len(txn_commits))
                data_start, commit_start, commit_end, _ = txn_commits[txn_idx]
                fault = rng.choice(["within_frame", "before_commit",
                                    "after_commit"])
                if fault == "within_frame":
                    cut = rng.randint(data_start + 1, commit_end - 1)
                elif fault == "before_commit":
                    cut = commit_start
                else:
                    cut = commit_end
                with open(db, "r+b") as f:
                    f.truncate(cut)

                expected = {}
                for _, _, cend, ops in txn_commits:
                    if cend > cut:
                        break
                    for op in ops:
                        if op[0] == "put":
                            expected[op[1]] = op[2]
                        else:
                            expected.pop(op[1], None)

                self.assertEqual(waldb.recover(db), expected)
                waldb.append_txn(db, [("put", "post", "crash")])
                expected["post"] = "crash"
                self.assertEqual(waldb.recover(db), expected)


class TestCli(WaldbTestBase):
    def run_cli(self, *args):
        return subprocess.run(CLI + list(args), capture_output=True, text=True)

    def test_cli_roundtrip(self):
        self.assertEqual(self.run_cli("put", self.db, "k", "v").returncode, 0)
        proc = self.run_cli("get", self.db, "k")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "v")
        self.assertEqual(self.run_cli("del", self.db, "k").returncode, 0)
        self.assertEqual(self.run_cli("get", self.db, "k").returncode, 5)

    def test_cli_dump_and_recover(self):
        self.run_cli("put", self.db, "b", "2")
        self.run_cli("put", self.db, "a", "1")
        proc = self.run_cli("dump", self.db)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "a=1\nb=2\n")
        self.assertEqual(self.run_cli("recover", self.db).returncode, 0)

    def test_cli_errors_exit_5(self):
        self.assertEqual(self.run_cli("get", self.db, "missing").returncode, 5)
        self.assertEqual(self.run_cli("bogus", self.db).returncode, 5)
        self.assertEqual(self.run_cli("put", self.db, "onlykey").returncode, 5)


if __name__ == "__main__":
    unittest.main()
