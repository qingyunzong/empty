import json
import subprocess
import sys
import unittest


def run_cli(lines, args=None):
    proc = subprocess.run(
        [sys.executable, "-m", "mvcc", *(args or [])],
        input="\n".join(lines) + "\n",
        capture_output=True,
        text=True,
    )
    responses = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    return proc, responses


class TestCLI(unittest.TestCase):
    def test_happy_path_session(self):
        proc, resp = run_cli([
            json.dumps({"op": "configure", "replicas": 2}),
            json.dumps({"op": "begin", "txn": "t1", "replica": 0}),
            json.dumps({"op": "write", "txn": "t1", "key": "a", "value": 1}),
            json.dumps({"op": "commit", "txn": "t1"}),
            json.dumps({"op": "begin", "txn": "t2", "ctx": [1, 0]}),
            json.dumps({"op": "read", "txn": "t2", "key": "a"}),
            json.dumps({"op": "gc"}),
        ])
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(resp[0], {"ok": True, "replicas": 2})
        self.assertEqual(resp[1]["ctx"], [0, 0])
        self.assertEqual(resp[3]["ctx"], [1, 0])
        self.assertEqual(resp[5]["value"], 1)
        self.assertTrue(resp[5]["found"])
        self.assertEqual(resp[6]["collected"], 0)
        self.assertEqual(resp[6]["watermark"], [1, 0])  # t2 still active

    def test_write_skew_is_json_error_not_exit(self):
        proc, resp = run_cli([
            json.dumps({"op": "configure", "replicas": 2}),
            json.dumps({"op": "begin", "txn": "seed", "replica": 1}),
            json.dumps({"op": "write", "txn": "seed", "key": "o", "value": 0}),
            json.dumps({"op": "commit", "txn": "seed"}),
            json.dumps({"op": "begin", "txn": "t1", "replica": 0}),
            json.dumps({"op": "begin", "txn": "t2", "replica": 1, "ctx": [0, 1]}),
            json.dumps({"op": "write", "txn": "t1", "key": "k", "value": "x"}),
            json.dumps({"op": "commit", "txn": "t1"}),
            json.dumps({"op": "write", "txn": "t2", "key": "k", "value": "y"}),
            json.dumps({"op": "abort", "txn": "t2"}),
        ])
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(resp[8]["ok"], False)
        self.assertEqual(resp[8]["error"], "WRITE_SKEW")
        self.assertEqual(resp[9]["ok"], True)  # session continues

    def test_gc_watermark_and_collection(self):
        proc, resp = run_cli([
            json.dumps({"op": "begin", "txn": "w1"}),
            json.dumps({"op": "write", "txn": "w1", "key": "k", "value": 1}),
            json.dumps({"op": "commit", "txn": "w1"}),
            json.dumps({"op": "begin", "txn": "w2", "ctx": [1, 0, 0]}),
            json.dumps({"op": "write", "txn": "w2", "key": "k", "value": 2}),
            json.dumps({"op": "commit", "txn": "w2"}),
            json.dumps({"op": "begin", "txn": "r", "ctx": [1, 0, 0]}),
            json.dumps({"op": "gc"}),
            json.dumps({"op": "abort", "txn": "r"}),
            json.dumps({"op": "gc"}),
        ])
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(resp[7]["watermark"], [1, 0, 0])
        self.assertEqual(resp[7]["collected"], 0)  # pinned by reader
        self.assertIsNone(resp[9]["watermark"])
        self.assertEqual(resp[9]["collected"], 1)  # old version collected

    def test_bad_json_exits_10(self):
        proc, resp = run_cli(["this is not json"])
        self.assertEqual(proc.returncode, 10)
        self.assertEqual(resp[0]["error"], "BAD_JSON")

    def test_unknown_op_exits_10(self):
        proc, resp = run_cli([json.dumps({"op": "nope"})])
        self.assertEqual(proc.returncode, 10)
        self.assertEqual(resp[0]["error"], "PROTOCOL")

    def test_missing_field_exits_10(self):
        proc, resp = run_cli([json.dumps({"op": "read", "txn": "t1"})])
        self.assertEqual(proc.returncode, 10)

    def test_txn_state_and_timeout(self):
        proc, resp = run_cli([
            json.dumps({"op": "begin", "txn": "t1", "timeout_ms": 1}),
            json.dumps({"op": "txn_state", "txn": "t1"}),
        ])
        # 1ms timeout: by the time we ask, it may or may not have expired;
        # just require a well-formed response.
        self.assertTrue(resp[1]["ok"])
        self.assertIn(resp[1]["state"], ("active", "aborted"))


if __name__ == "__main__":
    unittest.main()
