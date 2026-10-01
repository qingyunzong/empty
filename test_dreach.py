"""End-to-end and model-based tests for `python -m dreach run OPS.json`."""

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from dreach import Graph

ROOT = os.path.dirname(os.path.abspath(__file__))


def run_cli(ops, raw=None):
    """Run the CLI on the given op list (or raw file text)."""
    with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8") as fh:
        fh.write(raw if raw is not None else json.dumps(ops))
        path = fh.name
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "dreach", "run", path],
            cwd=ROOT, capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(path)
    lines = [json.loads(x) for x in proc.stdout.splitlines() if x.strip()]
    return proc.returncode, lines, proc.stderr


# ---------------------------------------------------------------------------
# Independent oracle: adjacency sets + Floyd-Warshall + DFS lex enumeration.
# ---------------------------------------------------------------------------

class Oracle:
    def __init__(self):
        self.n = 0
        self.adj = []
        self.snaps = {}
        self.next_id = 1

    def init(self, n):
        self.n = n
        self.adj = [set() for _ in range(n)]
        self.snaps = {}
        self.next_id = 1

    def insert(self, u, v):
        self.adj[u].add(v)

    def delete(self, u, v):
        self.adj[u].discard(v)

    def savepoint(self):
        sid = self.next_id
        self.next_id += 1
        self.snaps[sid] = [set(s) for s in self.adj]
        return sid

    def rollback(self, sid):
        self.adj = [set(s) for s in self.snaps[sid]]

    def _floyd(self):
        """Reachability matrix via Floyd-Warshall (independent of BFS)."""
        reach = [[False] * self.n for _ in range(self.n)]
        for i in range(self.n):
            reach[i][i] = True
            for w in self.adj[i]:
                reach[i][w] = True
        for k in range(self.n):
            rk = reach[k]
            for i in range(self.n):
                if reach[i][k]:
                    ri = reach[i]
                    for j in range(self.n):
                        if rk[j]:
                            ri[j] = True
        return reach

    def reachable(self, u, v):
        return self._floyd()[u][v]

    def witness(self, u, v):
        """Lexicographically smallest shortest path via DFS enumeration
        over the shortest-path DAG (edges sorted lexicographically)."""
        # BFS distances from v on the reversed graph.
        dist = [-1] * self.n
        dist[v] = 0
        queue = [v]
        head = 0
        while head < len(queue):
            x = queue[head]
            head += 1
            for a in range(self.n):
                if x in self.adj[a] and dist[a] < 0:
                    dist[a] = dist[x] + 1
                    queue.append(a)
        if dist[u] < 0:
            return None
        # DFS in lexicographic order; first path reaching v is the answer.
        path = [u]
        while path[-1] != v:
            x = path[-1]
            nxt = None
            for w in sorted(self.adj[x]):
                if dist[w] == dist[x] - 1:
                    nxt = w
                    break
            path.append(nxt)
        return path


# ---------------------------------------------------------------------------
# Acceptance scenarios (CLI level).
# ---------------------------------------------------------------------------

class AcceptanceTests(unittest.TestCase):
    def test_snapshot_then_insert_then_rollback_loses_reachability(self):
        ops = [
            {"op": "init", "n": 3},
            {"op": "savepoint"},                      # id 1
            {"op": "insert", "u": 0, "v": 1},
            {"op": "insert", "u": 1, "v": 2},
            {"op": "reachable", "u": 0, "v": 2},      # True before rollback
            {"op": "rollback", "id": 1},
            {"op": "reachable", "u": 0, "v": 2},      # False after rollback
            {"op": "witness", "u": 0, "v": 2},        # null
        ]
        code, out, _ = run_cli(ops)
        self.assertEqual(code, 0)
        self.assertEqual(out, [1, True, False, None])

    def test_delete_critical_edge_then_rollback_restores_path(self):
        ops = [
            {"op": "init", "n": 3},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "insert", "u": 1, "v": 2},
            {"op": "savepoint"},                      # id 1
            {"op": "delete", "u": 1, "v": 2},         # cut the only bridge
            {"op": "reachable", "u": 0, "v": 2},      # False
            {"op": "rollback", "id": 1},
            {"op": "reachable", "u": 0, "v": 2},      # True again
            {"op": "witness", "u": 0, "v": 2},        # [0, 1, 2]
        ]
        code, out, _ = run_cli(ops)
        self.assertEqual(code, 0)
        self.assertEqual(out, [1, False, True, [0, 1, 2]])

    def test_rollback_unknown_id_exit1_and_state_unchanged(self):
        ops = [
            {"op": "init", "n": 2},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "savepoint"},                      # id 1
            {"op": "reachable", "u": 0, "v": 1},      # True
            {"op": "rollback", "id": 999},            # does not exist
        ]
        code, out, _ = run_cli(ops)
        self.assertEqual(code, 1)
        self.assertEqual(out, [1, True])  # results before the failure intact
        # Core level: failed rollback must not mutate the graph.
        g = Graph()
        g.init(2)
        g.insert(0, 1)
        g.savepoint()
        with self.assertRaises(KeyError):
            g.rollback(999)
        self.assertTrue(g.reachable(0, 1))
        self.assertEqual(g.next_id, 2)

    def test_unreachable_witness_is_null(self):
        ops = [
            {"op": "init", "n": 4},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "reachable", "u": 1, "v": 3},
            {"op": "witness", "u": 1, "v": 3},
        ]
        code, out, _ = run_cli(ops)
        self.assertEqual(code, 0)
        self.assertEqual(out, [False, None])

    def test_json_error_exit2(self):
        code, _, _ = run_cli(None, raw="{not valid json")
        self.assertEqual(code, 2)
        code, _, _ = run_cli(None, raw='{"op": "init"}')  # not a list
        self.assertEqual(code, 2)
        code, _, _ = run_cli([{"op": "bogus"}])           # unknown op
        self.assertEqual(code, 2)
        code, _, _ = run_cli([{"op": "init", "n": 2},
                              {"op": "insert", "u": 0, "v": 7}])  # bad node
        self.assertEqual(code, 2)

    def test_duplicate_insert_is_idempotent(self):
        ops = [
            {"op": "init", "n": 2},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "delete", "u": 0, "v": 1},
            {"op": "reachable", "u": 0, "v": 1},
        ]
        code, out, _ = run_cli(ops)
        self.assertEqual(code, 0)
        self.assertEqual(out, [False])

    def test_savepoint_ids_monotonic(self):
        ops = [{"op": "init", "n": 1}]
        ops += [{"op": "savepoint"} for _ in range(5)]
        code, out, _ = run_cli(ops)
        self.assertEqual(code, 0)
        self.assertEqual(out, [1, 2, 3, 4, 5])

    def test_lexicographically_smallest_witness(self):
        # Shortest paths 0->4: [0,1,3,4] and [0,2,3,4]; pick lexicographic min.
        ops = [
            {"op": "init", "n": 5},
            {"op": "insert", "u": 0, "v": 2},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "insert", "u": 1, "v": 3},
            {"op": "insert", "u": 2, "v": 3},
            {"op": "insert", "u": 3, "v": 4},
            {"op": "witness", "u": 0, "v": 4},
        ]
        code, out, _ = run_cli(ops)
        self.assertEqual(code, 0)
        self.assertEqual(out, [[0, 1, 3, 4]])

    def test_witness_self_path(self):
        code, out, _ = run_cli([
            {"op": "init", "n": 2},
            {"op": "reachable", "u": 1, "v": 1},
            {"op": "witness", "u": 1, "v": 1},
        ])
        self.assertEqual(code, 0)
        self.assertEqual(out, [True, [1]])


# ---------------------------------------------------------------------------
# Randomized model-based comparison, n <= 16.
# ---------------------------------------------------------------------------

class RandomModelTests(unittest.TestCase):
    def _one_trace(self, rng):
        n = rng.randint(1, 16)
        ops = [{"op": "init", "n": n}]
        live_ids = []
        for _ in range(rng.randint(20, 60)):
            kind = rng.choices(
                ["insert", "delete", "savepoint", "rollback",
                 "reachable", "witness"],
                weights=[30, 20, 10, 8, 16, 16])[0]
            if kind in ("insert", "delete", "reachable", "witness"):
                op = {"op": kind, "u": rng.randrange(n), "v": rng.randrange(n)}
            elif kind == "savepoint":
                op = {"op": "savepoint"}
            else:
                if not live_ids:
                    continue
                op = {"op": "rollback", "id": rng.choice(live_ids)}
            ops.append(op)
            if kind == "savepoint":
                live_ids.append(len(live_ids) + 1)  # ids are 1..k in order
        return ops

    def test_random_traces_match_oracle(self):
        for seed in range(30):
            rng = random.Random(seed)
            ops = self._one_trace(rng)
            code, out, err = run_cli(ops)
            self.assertEqual(code, 0, f"seed={seed} stderr={err}")

            oracle = Oracle()
            expected = []
            for op in ops:
                kind = op["op"]
                if kind == "init":
                    oracle.init(op["n"])
                elif kind == "insert":
                    oracle.insert(op["u"], op["v"])
                elif kind == "delete":
                    oracle.delete(op["u"], op["v"])
                elif kind == "savepoint":
                    expected.append(oracle.savepoint())
                elif kind == "rollback":
                    oracle.rollback(op["id"])
                elif kind == "reachable":
                    expected.append(oracle.reachable(op["u"], op["v"]))
                elif kind == "witness":
                    expected.append(oracle.witness(op["u"], op["v"]))

            self.assertEqual(out, expected,
                             f"seed={seed}\nops={json.dumps(ops)}")

            # Extra structural check on every witness path actually emitted.
            oracle2 = Oracle()
            idx = 0
            for op in ops:
                kind = op["op"]
                if kind == "init":
                    oracle2.init(op["n"])
                elif kind == "insert":
                    oracle2.insert(op["u"], op["v"])
                elif kind == "delete":
                    oracle2.delete(op["u"], op["v"])
                elif kind == "savepoint":
                    oracle2.savepoint()
                elif kind == "rollback":
                    oracle2.rollback(op["id"])
                elif kind == "witness":
                    path = out[idx]
                    if path is not None:
                        self.assertEqual(path[0], op["u"])
                        self.assertEqual(path[-1], op["v"])
                        for a, b in zip(path, path[1:]):
                            self.assertIn(b, oracle2.adj[a])
                if kind in ("savepoint", "reachable", "witness"):
                    idx += 1


if __name__ == "__main__":
    unittest.main()
