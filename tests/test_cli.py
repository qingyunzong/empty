"""End-to-end test of the JSON-lines CLI (python -m rational_hull)."""

import json
import subprocess
import sys
import unittest


SCRIPT = [
    {"op": "insert", "id": "a", "x": 0, "y": 0},
    {"op": "insert", "id": "b", "x": 4, "y": 0},
    {"op": "insert", "id": "c", "x": 2, "y": 3},
    {"op": "insert", "id": "d", "x": "3/2", "y": "1/2"},
    {"op": "hull"},
    {"op": "extreme", "dx": 1, "dy": 1},
    {"op": "tangent", "x": 5, "y": 1},
    {"op": "contains_point", "x": "3/2", "y": "1/2"},
    {"op": "snapshot"},
    {"op": "delete", "id": "c"},
    {"op": "hull"},
    {"op": "restore", "version": 1},
    {"op": "hull"},
    {"op": "verify"},
    {"op": "count"},
    {"op": "insert", "id": "bad", "x": 0.5, "y": 0},
    {"op": "stats"},
]


class TestCli(unittest.TestCase):
    def test_session(self):
        payload = "\n".join(json.dumps(line) for line in SCRIPT) + "\n"
        proc = subprocess.run(
            [sys.executable, "-m", "rational_hull"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        responses = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(len(responses), len(SCRIPT))

        for resp in responses[:4]:
            self.assertTrue(resp["ok"], resp)

        hull1 = responses[4]["result"]
        self.assertEqual([v["id"] for v in hull1["vertices"]], ["a", "b", "c"])
        self.assertEqual(
            [(e["a"], e["b"], e["c"]) for e in hull1["edges"]],
            [(0, 1, 0), (-3, -2, 12), (3, -2, 0)],
        )

        self.assertEqual(responses[5]["result"]["id"], "c")
        tangent = responses[6]["result"]
        self.assertEqual((tangent["left"]["id"], tangent["right"]["id"]), ("c", "b"))
        self.assertEqual(
            responses[7]["result"]["classification"], "inside"
        )
        self.assertEqual(responses[8]["result"], {"version": 1})
        self.assertTrue(responses[9]["ok"])
        hull2 = responses[10]["result"]
        self.assertEqual([v["id"] for v in hull2["vertices"]], ["a", "b", "d"])
        self.assertTrue(responses[11]["ok"])
        hull3 = responses[12]["result"]
        self.assertEqual([v["id"] for v in hull3["vertices"]], ["a", "b", "c"])
        self.assertEqual(responses[13]["result"], {"valid": True})
        self.assertEqual(responses[14]["result"], {"count": 4})
        # JSON floats are rejected to protect exactness.
        self.assertFalse(responses[15]["ok"])
        self.assertIn("error", responses[15])
        stats = responses[16]["result"]
        self.assertEqual(stats["size"], 4)
        self.assertGreater(stats["stats"]["updates"], 0)


if __name__ == "__main__":
    unittest.main()
