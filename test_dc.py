import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))


def bfs_connected(edges, source, target):
    """Independent BFS reference implementation used to check every state."""
    if source == target:
        return True
    adjacency = {}
    for u, v in edges:
        adjacency.setdefault(u, set()).add(v)
        adjacency.setdefault(v, set()).add(u)
    seen = {source}
    stack = [source]
    while stack:
        node = stack.pop()
        for nxt in adjacency.get(node, ()):
            if nxt == target:
                return True
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return False


def run_cli(tx_path, state_dir, fail_after=None):
    cmd = [sys.executable, "-m", "dc", "run", tx_path, "--state", state_dir]
    if fail_after is not None:
        cmd += ["--fail-after", str(fail_after)]
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def norm_edges(edges):
    return {tuple(sorted((u, v))) for u, v in edges}


class DcTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "state")
        self._tx_counter = 0

    def write_tx(self, tx, name=None, raw=None):
        self._tx_counter += 1
        path = os.path.join(
            self.tmp.name, name or ("tx%d.json" % self._tx_counter))
        with open(path, "w", encoding="utf-8") as f:
            f.write(raw if raw is not None else json.dumps(tx))
        return path

    def committed_edges(self):
        path = os.path.join(self.state, "graph.json")
        if not os.path.exists(path):
            return set()
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return norm_edges(data["edges"])

    def assert_connectivity(self, expected_edges, pairs):
        """Check BFS results on expected edges against the committed graph."""
        actual = self.committed_edges()
        self.assertEqual(actual, norm_edges(expected_edges))
        for u, v, expected in pairs:
            self.assertEqual(
                bfs_connected(expected_edges, u, v),
                expected,
                msg="BFS reference mismatch for %r-%r" % (u, v),
            )

    def test_commit_persists_across_restart(self):
        tx1 = self.write_tx({
            "id": "t1",
            "ops": [{"op": "add", "u": "a", "v": "b"}],
        })
        res = run_cli(tx1, self.state)
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out["id"], "t1")
        self.assertEqual(out["results"], [])

        # "Restart": a brand new CLI invocation must still see the edge.
        tx2 = self.write_tx({
            "id": "t2",
            "ops": [{"op": "query", "u": "a", "v": "b"}],
        })
        res = run_cli(tx2, self.state)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["results"], [True])
        self.assert_connectivity(
            [("a", "b")],
            [("a", "b", True), ("b", "a", True), ("a", "a", True)],
        )

    def test_query_sees_in_transaction_state(self):
        tx = self.write_tx({
            "id": "t1",
            "ops": [
                {"op": "add", "u": "a", "v": "b"},
                {"op": "add", "u": "b", "v": "c"},
                {"op": "query", "u": "a", "v": "c"},
                {"op": "remove", "u": "a", "v": "b"},
                {"op": "query", "u": "a", "v": "c"},
            ],
        })
        res = run_cli(tx, self.state)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["results"], [True, False])
        self.assert_connectivity(
            [("b", "c")],
            [("a", "c", False), ("b", "c", True)],
        )

    def test_rollback_on_remove_of_nonexistent_edge(self):
        tx1 = self.write_tx({
            "id": "t1",
            "ops": [{"op": "add", "u": "a", "v": "b"}],
        })
        self.assertEqual(run_cli(tx1, self.state).returncode, 0)

        # Add a bridge edge b-c, then remove a nonexistent edge a-c:
        # the whole transaction (including the bridge) must roll back.
        tx2 = self.write_tx({
            "id": "t2",
            "ops": [
                {"op": "add", "u": "b", "v": "c"},
                {"op": "remove", "u": "a", "v": "c"},
            ],
        })
        res = run_cli(tx2, self.state)
        self.assertEqual(res.returncode, 1)
        self.assert_connectivity(
            [("a", "b")],
            [("a", "b", True), ("b", "c", False), ("a", "c", False)],
        )

    def test_rollback_on_uninitialized_node(self):
        tx1 = self.write_tx({
            "id": "t1",
            "ops": [{"op": "add", "u": "a", "v": "b"}],
        })
        self.assertEqual(run_cli(tx1, self.state).returncode, 0)

        tx2 = self.write_tx({
            "id": "t2",
            "ops": [
                {"op": "add", "u": "c", "v": "d"},
                {"op": "query", "u": "a", "v": "zzz"},
            ],
        })
        res = run_cli(tx2, self.state)
        self.assertEqual(res.returncode, 1)
        self.assert_connectivity(
            [("a", "b")],
            [("a", "b", True), ("c", "d", False)],
        )

    def test_remove_uninitialized_node_is_error(self):
        tx = self.write_tx({
            "id": "t1",
            "ops": [{"op": "remove", "u": "ghost", "v": "also-ghost"}],
        })
        res = run_cli(tx, self.state)
        self.assertEqual(res.returncode, 1)
        self.assertEqual(self.committed_edges(), set())

    def test_crash_recovery_no_partial_edges_then_rerun(self):
        tx = self.write_tx({
            "id": "t1",
            "ops": [
                {"op": "add", "u": "a", "v": "b"},
                {"op": "add", "u": "b", "v": "c"},
                {"op": "add", "u": "c", "v": "d"},
                {"op": "query", "u": "a", "v": "d"},
            ],
        })
        # Crash after 2 durable WAL records (begin + first add).
        res = run_cli(tx, self.state, fail_after=2)
        self.assertEqual(res.returncode, 3)
        # Committed graph must contain no partial edges.
        self.assertEqual(self.committed_edges(), set())

        # Recovery run: clears the partial transaction and re-runs it.
        res = run_cli(tx, self.state)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["results"], [True])
        edges = [("a", "b"), ("b", "c"), ("c", "d")]
        self.assert_connectivity(
            edges,
            [("a", "d", True), ("a", "c", True), ("b", "d", True)],
        )

    def test_crash_after_commit_record_recovers_committed(self):
        tx = self.write_tx({
            "id": "t1",
            "ops": [
                {"op": "add", "u": "x", "v": "y"},
                {"op": "query", "u": "x", "v": "y"},
            ],
        })
        # begin + add + commit = 3 records; crash right after commit record.
        res = run_cli(tx, self.state, fail_after=3)
        self.assertEqual(res.returncode, 3)
        # Replay same id: recovery installs the committed tx, idempotent reply.
        res = run_cli(tx, self.state)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["results"], [True])
        self.assert_connectivity([("x", "y")], [("x", "y", True)])

    def test_idempotent_replay_same_id(self):
        tx = self.write_tx({
            "id": "t1",
            "ops": [
                {"op": "add", "u": "a", "v": "b"},
                {"op": "query", "u": "a", "v": "b"},
            ],
        })
        res1 = run_cli(tx, self.state)
        self.assertEqual(res1.returncode, 0, res1.stderr)
        res2 = run_cli(tx, self.state)
        self.assertEqual(res2.returncode, 0, res2.stderr)
        self.assertEqual(res1.stdout, res2.stdout)
        self.assertEqual(json.loads(res2.stdout)["results"], [True])
        self.assert_connectivity([("a", "b")], [("a", "b", True)])

    def test_invalid_json_exits_2(self):
        path = self.write_tx(None, raw="{not valid json")
        res = run_cli(path, self.state)
        self.assertEqual(res.returncode, 2)

    def test_invalid_schema_exits_2(self):
        path = self.write_tx(None, raw=json.dumps({"ops": "not-a-list"}))
        res = run_cli(path, self.state)
        self.assertEqual(res.returncode, 2)
        path = self.write_tx(None, raw=json.dumps(
            {"id": "t", "ops": [{"op": "explode", "u": "a", "v": "b"}]}))
        res = run_cli(path, self.state)
        self.assertEqual(res.returncode, 2)

    def test_missing_tx_file_exits_2(self):
        res = run_cli(os.path.join(self.tmp.name, "nope.json"), self.state)
        self.assertEqual(res.returncode, 2)

    def test_multi_hop_connectivity_against_bfs(self):
        tx = self.write_tx({
            "id": "t1",
            "ops": [
                {"op": "add", "u": "a", "v": "b"},
                {"op": "add", "u": "b", "v": "c"},
                {"op": "add", "u": "c", "v": "d"},
                {"op": "add", "u": "x", "v": "y"},
                {"op": "query", "u": "a", "v": "d"},
                {"op": "query", "u": "a", "v": "y"},
                {"op": "query", "u": "d", "v": "a"},
            ],
        })
        res = run_cli(tx, self.state)
        self.assertEqual(res.returncode, 0, res.stderr)
        edges = [("a", "b"), ("b", "c"), ("c", "d"), ("x", "y")]
        expected = [
            bfs_connected(edges, "a", "d"),
            bfs_connected(edges, "a", "y"),
            bfs_connected(edges, "d", "a"),
        ]
        self.assertEqual(json.loads(res.stdout)["results"], expected)
        self.assert_connectivity(
            edges,
            [("a", "d", True), ("a", "y", False), ("x", "y", True)],
        )


if __name__ == "__main__":
    unittest.main()
