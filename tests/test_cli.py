import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(state, *args, input_text=None):
    return subprocess.run(
        [sys.executable, "-m", "mvview", "--state", state, *args],
        input=input_text, capture_output=True, text=True, cwd=ROOT)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mvview-cli-")

    def test_apply_view_rank_select(self):
        batch = [
            {"op": "insert_cust", "customer": "c1", "group": "A"},
            {"op": "insert_cust", "customer": "c2", "group": "A"},
            {"op": "insert_tx", "txid": "t1", "customer": "c1", "value": 10},
            {"op": "insert_tx", "txid": "t2", "customer": "c2",
             "value": {"num": 7, "den": 2}},
        ]
        res = run_cli(self.dir, "apply", "-", input_text=json.dumps(batch))
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertTrue(out["ok"])
        self.assertEqual(out["version"], 1)

        res = run_cli(self.dir, "view")
        view = json.loads(res.stdout)
        self.assertEqual(view["version"], 1)
        (group_a,) = view["groups"]
        self.assertEqual(group_a["group"], "A")
        self.assertEqual(group_a["count"], 2)
        self.assertEqual(group_a["sum"], {"num": 27, "den": 2})
        self.assertEqual(group_a["median"], {"num": 27, "den": 4})

        res = run_cli(self.dir, "rank", "A", "5")
        self.assertEqual(json.loads(res.stdout)["rank"], 1)
        res = run_cli(self.dir, "select", "A", "1")
        self.assertEqual(json.loads(res.stdout)["value"], 10)

    def test_illegal_batch_is_atomic(self):
        batch = [
            {"op": "insert_cust", "customer": "c1", "group": "A"},
            {"op": "insert_tx", "txid": "t1", "customer": "c1", "value": 3},
        ]
        res = run_cli(self.dir, "apply", "-", input_text=json.dumps(batch))
        self.assertEqual(res.returncode, 0, res.stderr)
        bad = [
            {"op": "insert_tx", "txid": "t2", "customer": "c1", "value": 5},
            {"op": "retract_tx", "txid": "missing"},
        ]
        res = run_cli(self.dir, "apply", "-", input_text=json.dumps(bad))
        self.assertEqual(res.returncode, 1)
        out = json.loads(res.stdout)
        self.assertFalse(out["ok"])
        self.assertIn("missing", out["error"])
        res = run_cli(self.dir, "view")
        view = json.loads(res.stdout)
        self.assertEqual(view["version"], 1)
        (group_a,) = view["groups"]
        self.assertEqual(group_a["count"], 1)
        self.assertEqual(group_a["sum"], 3)

    def test_checkpoint_and_recover(self):
        batches = [
            [
                {"op": "insert_cust", "customer": "c1", "group": "A"},
                {"op": "insert_tx", "txid": "t1", "customer": "c1",
                 "value": 10},
            ],
            [
                {"op": "insert_cust", "customer": "c2", "group": "B"},
                {"op": "insert_tx", "txid": "t2", "customer": "c2",
                 "value": 20},
                {"op": "migrate", "customer": "c1", "from": "A", "to": "B"},
            ],
        ]
        run_cli(self.dir, "apply", "-", input_text=json.dumps(batches[0]))
        res = run_cli(self.dir, "checkpoint")
        self.assertTrue(json.loads(res.stdout)["ok"])
        run_cli(self.dir, "apply", "-", input_text=json.dumps(batches[1]))
        res = run_cli(self.dir, "recover")
        self.assertEqual(json.loads(res.stdout)["version"], 2)
        res = run_cli(self.dir, "view")
        view = json.loads(res.stdout)
        groups = {g["group"]: g for g in view["groups"]}
        self.assertNotIn("A", groups)
        self.assertEqual(groups["B"]["count"], 2)
        self.assertEqual(groups["B"]["sum"], 30)

    def test_apply_from_file(self):
        path = os.path.join(self.dir, "ops.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"ops": [
                {"op": "insert_cust", "customer": "c", "group": "G"},
                {"op": "insert_tx", "txid": "t", "customer": "c", "value": 1},
            ]}, fh)
        res = run_cli(self.dir, "apply", path)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["version"], 1)


if __name__ == "__main__":
    unittest.main()
