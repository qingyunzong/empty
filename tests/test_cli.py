import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(script):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "rknni"],
        input=json.dumps(script),
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )
    if proc.returncode != 0:
        raise AssertionError(f"CLI failed: {proc.stderr}")
    return json.loads(proc.stdout)["results"]


INSERTS = [
    {
        "op": "insert",
        "id": i,
        "vector": [f"{(i * 7) % 11 - 5}/2", (i * 13) % 17 - 8],
        "tags": ["even"] if i % 2 == 0 else ["odd"],
        "version": 1,
    }
    for i in range(20)
]


class TestJsonCli(unittest.TestCase):
    def test_full_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "idx.json")
            out = run_cli(
                {
                    "ops": [
                        {"op": "new", "dim": 2, "capacity": 4, "fanout": 4},
                        *INSERTS,
                        {"op": "query", "vector": [0, 0], "k": 3},
                        {"op": "query", "vector": [0, 0], "k": 3,
                         "filter": {"tag": "even"}},
                        {"op": "stats"},
                        {"op": "save", "path": path},
                    ]
                }
            )
            self.assertTrue(all(o.get("ok") for o in out))
            query_all = out[1 + len(INSERTS)]["result"]
            query_even = out[2 + len(INSERTS)]["result"]
            stats = out[3 + len(INSERTS)]["stats"]
            self.assertEqual(query_all["status"], "exact")
            self.assertEqual(len(query_all["results"]), 3)
            self.assertEqual(len(query_even["results"]), 3)
            self.assertEqual(stats["points"], 20)
            self.assertEqual(stats["data_version"], 20)
            for hit in query_even["results"]:
                self.assertEqual(hit["id"] % 2, 0)
            # Second process: restore from disk, same answers, verify cert.
            out2 = run_cli(
                {
                    "ops": [
                        {"op": "new", "dim": 2},
                        {"op": "load", "path": path},
                        {"op": "query", "vector": [0, 0], "k": 3},
                        {"op": "verify", "vector": [0, 0], "k": 3,
                         "filter": None, "result": query_all},
                        {"op": "upsert", "id": 0, "vector": [9, 9],
                         "tags": [], "version": 1},
                        {"op": "upsert", "id": 0, "vector": [9, 9],
                         "tags": [], "version": 2},
                        {"op": "delete", "id": 0},
                        {"op": "delete", "id": 0},
                        {"op": "stats"},
                    ]
                }
            )
            self.assertEqual(out2[1]["size"], 20)
            self.assertEqual(out2[2]["result"], query_all)
            self.assertEqual(out2[3], {"ok": True, "valid": True})
            self.assertFalse(out2[4]["ok"])  # stale version rejected
            self.assertIn("StaleVersionError", out2[4]["error"])
            self.assertTrue(out2[5]["ok"])  # newer version accepted
            self.assertTrue(out2[6]["ok"])  # delete works
            self.assertFalse(out2[7]["ok"])  # second delete: unknown id
            self.assertEqual(out2[8]["stats"]["points"], 19)

    def test_tampered_certificate_rejected_via_cli(self):
        out = run_cli(
            {
                "ops": [
                    {"op": "new", "dim": 2, "capacity": 4},
                    *INSERTS,
                    {"op": "query", "vector": [0, 0], "k": 3},
                ]
            }
        )
        result = out[-1]["result"]
        self.assertGreater(len(result["certificate"]["entries"]), 0)
        result["certificate"]["entries"][0]["bound"] = "0"
        out2 = run_cli(
            {
                "ops": [
                    {"op": "new", "dim": 2, "capacity": 4},
                    *INSERTS,
                    {"op": "verify", "vector": [0, 0], "k": 3,
                     "filter": None, "result": result},
                ]
            }
        )
        self.assertFalse(out2[-1]["ok"])
        self.assertIn("VerificationError", out2[-1]["error"])

    def test_partial_result_via_cli(self):
        out = run_cli(
            {
                "ops": [
                    {"op": "new", "dim": 2, "capacity": 4},
                    *INSERTS,
                    {"op": "query", "vector": [0, 0], "k": 3, "budget": 0},
                ]
            }
        )
        result = out[-1]["result"]
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["complete"])
        self.assertEqual(result["results"], [])
        self.assertGreater(len(result["certificate"]["entries"]), 0)

    def test_errors_do_not_abort_script(self):
        out = run_cli(
            {
                "ops": [
                    {"op": "insert", "id": "a", "vector": [1, 2]},
                    {"op": "new", "dim": 2},
                    {"op": "insert", "id": "a", "vector": [1, 2]},
                    {"op": "insert", "id": "a", "vector": [3, 4]},
                    {"op": "query", "vector": [0, 0], "k": 1},
                ]
            }
        )
        self.assertFalse(out[0]["ok"])  # no index yet
        self.assertTrue(out[1]["ok"])
        self.assertTrue(out[2]["ok"])
        self.assertFalse(out[3]["ok"])  # duplicate id
        self.assertIn("DuplicateIdError", out[3]["error"])
        self.assertEqual(out[4]["result"]["results"][0]["id"], "a")


if __name__ == "__main__":
    unittest.main()
