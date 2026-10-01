"""End-to-end tests for the dc transactional graph CLI.

Connectivity expectations are computed with an independent BFS
implemented here (not imported from dc), enumerating every node pair.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))


def independent_bfs(nodes, edges, src, dst):
    """Independent BFS used only by the tests to cross-check the CLI."""
    adjacency = {}
    for node in nodes:
        adjacency.setdefault(node, set())
    for u, v in edges:
        adjacency.setdefault(u, set()).add(v)
        adjacency.setdefault(v, set()).add(u)
    visited = {src}
    stack = [src]
    while stack:
        node = stack.pop()
        if node == dst:
            return True
        for nxt in adjacency.get(node, ()):
            if nxt not in visited:
                visited.add(nxt)
                stack.append(nxt)
    return False


def run_cli(tx_path, state_dir, fail_after=None):
    cmd = [sys.executable, "-m", "dc", "run", tx_path, "--state", state_dir]
    if fail_after is not None:
        cmd += ["--fail-after", str(fail_after)]
    return subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_ROOT)


def load_graph(state_dir):
    path = os.path.join(state_dir, "graph.json")
    if not os.path.exists(path):
        return {"nodes": [], "edges": [], "last_tx": None, "last_results": []}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


class DcTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "state")
        self.tx_counter = 0

    def write_tx(self, tx, name=None, raw=None):
        self.tx_counter += 1
        path = os.path.join(self.tmp.name, name or f"tx{self.tx_counter}.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(raw if raw is not None else json.dumps(tx))
        return path

    def assert_graph_matches(self, expected_edges, expected_nodes=None):
        """Check persisted graph equals expected_edges, and enumerate every
        node pair comparing independent BFS on the persisted graph against
        independent BFS on the expected edge set."""
        graph = load_graph(self.state)
        nodes = sorted(graph["nodes"])
        edges = sorted(tuple(sorted(e)) for e in graph["edges"])
        expected = sorted(tuple(sorted(e)) for e in expected_edges)
        if expected_nodes is None:
            expected_nodes = sorted({n for edge in expected for n in edge})
        else:
            expected_nodes = sorted(expected_nodes)
        self.assertEqual(edges, expected)
        self.assertEqual(nodes, expected_nodes)
        for u in nodes:
            for v in nodes:
                self.assertEqual(
                    independent_bfs(nodes, edges, u, v),
                    independent_bfs(expected_nodes, expected, u, v),
                    f"connectivity mismatch for pair {u!r}-{v!r}",
                )
        return graph

    def run_query_all_pairs(self, tx_id):
        """Run a transaction querying every node pair and return the
        CLI-reported results."""
        graph = load_graph(self.state)
        nodes = graph["nodes"]
        ops = [{"op": "query", "u": u, "v": v} for u in nodes for v in nodes]
        path = self.write_tx({"id": tx_id, "ops": ops})
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)["results"]

    def assert_queries_match_independent_bfs(self, tx_id):
        """Cross-check CLI query results for every node pair against the
        independent BFS run over the persisted graph."""
        graph = load_graph(self.state)
        nodes = graph["nodes"]
        edges = [tuple(e) for e in graph["edges"]]
        results = self.run_query_all_pairs(tx_id)
        self.assertEqual(len(results), len(nodes) * len(nodes))
        for result in results:
            self.assertEqual(
                result["connected"],
                independent_bfs(nodes, edges, result["u"], result["v"]),
                f"CLI query mismatch for pair {result['u']!r}-{result['v']!r}",
            )


class TestCommitAndRestart(DcTestCase):
    def test_committed_edge_survives_restart(self):
        path = self.write_tx(
            {
                "id": "tx-add",
                "ops": [
                    {"op": "add", "u": "a", "v": "b"},
                    {"op": "query", "u": "a", "v": "b"},
                ],
            }
        )
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["results"], [{"u": "a", "v": "b", "connected": True}])
        self.assert_graph_matches([("a", "b")])

        # Restart (new process, same state dir): still connected.
        path2 = self.write_tx(
            {"id": "tx-check", "ops": [{"op": "query", "u": "a", "v": "b"}]}
        )
        proc2 = run_cli(path2, self.state)
        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        self.assertEqual(
            json.loads(proc2.stdout)["results"],
            [{"u": "a", "v": "b", "connected": True}],
        )
        self.assert_graph_matches([("a", "b")])
        self.assert_queries_match_independent_bfs("tx-all-pairs")

    def test_query_sees_in_transaction_state(self):
        path = self.write_tx(
            {
                "id": "tx-visibility",
                "ops": [
                    {"op": "add", "u": "a", "v": "b"},
                    {"op": "add", "u": "b", "v": "c"},
                    {"op": "query", "u": "a", "v": "c"},
                    {"op": "remove", "u": "a", "v": "b"},
                    {"op": "query", "u": "a", "v": "c"},
                ],
            }
        )
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        results = json.loads(proc.stdout)["results"]
        self.assertEqual(
            results,
            [
                {"u": "a", "v": "c", "connected": True},
                {"u": "a", "v": "c", "connected": False},
            ],
        )
        # Node "a" stays initialized even after its last edge is removed.
        self.assert_graph_matches([("b", "c")], expected_nodes=["a", "b", "c"])
        self.assert_queries_match_independent_bfs("tx-pairs-after")


class TestRollback(DcTestCase):
    def seed_graph(self):
        path = self.write_tx(
            {
                "id": "tx-seed",
                "ops": [
                    {"op": "add", "u": "a", "v": "b"},
                    {"op": "add", "u": "b", "v": "c"},
                ],
            }
        )
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_remove_nonexistent_edge_rolls_back_whole_tx(self):
        self.seed_graph()
        before = load_graph(self.state)
        path = self.write_tx(
            {
                "id": "tx-bridge",
                "ops": [
                    {"op": "add", "u": "c", "v": "d"},  # bridge edge
                    {"op": "remove", "u": "a", "v": "c"},  # does not exist
                ],
            }
        )
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        # Whole transaction rolled back: no partial bridge edge installed.
        self.assertEqual(load_graph(self.state), before)
        self.assert_graph_matches([("a", "b"), ("b", "c")])
        self.assert_queries_match_independent_bfs("tx-pairs-rollback")

    def test_uninitialized_node_reference_rolls_back(self):
        self.seed_graph()
        before = load_graph(self.state)
        path = self.write_tx(
            {
                "id": "tx-uninit",
                "ops": [
                    {"op": "add", "u": "c", "v": "d"},
                    {"op": "query", "u": "a", "v": "zzz"},
                ],
            }
        )
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(load_graph(self.state), before)
        self.assert_graph_matches([("a", "b"), ("b", "c")])

    def test_remove_uninitialized_node_rolls_back(self):
        self.seed_graph()
        before = load_graph(self.state)
        path = self.write_tx(
            {"id": "tx-rm-uninit", "ops": [{"op": "remove", "u": "a", "v": "ghost"}]}
        )
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(load_graph(self.state), before)


class TestCrashRecovery(DcTestCase):
    def make_tx(self):
        return {
            "id": "tx-crash",
            "ops": [
                {"op": "add", "u": "a", "v": "b"},
                {"op": "add", "u": "b", "v": "c"},
                {"op": "add", "u": "c", "v": "d"},
                {"op": "query", "u": "a", "v": "d"},
            ],
        }

    def test_fail_after_exits_3_and_recovery_reruns(self):
        path = self.write_tx(self.make_tx())
        proc = run_cli(path, self.state, fail_after=2)
        self.assertEqual(proc.returncode, 3, proc.stdout)

        # No partial transaction installed: graph stays empty.
        self.assert_graph_matches([])
        wal_path = os.path.join(self.state, "wal.log")
        with open(wal_path, "r", encoding="utf-8") as f:
            self.assertEqual(len(f.read().strip().splitlines()), 2)

        # Re-run the same transaction: partial records cleared, full success.
        proc2 = run_cli(path, self.state)
        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        out = json.loads(proc2.stdout)
        self.assertEqual(out["results"], [{"u": "a", "v": "d", "connected": True}])
        self.assert_graph_matches([("a", "b"), ("b", "c"), ("c", "d")])
        self.assert_queries_match_independent_bfs("tx-pairs-recovered")

    def test_crash_preserves_previously_committed_state(self):
        seed = self.write_tx(
            {"id": "tx-seed", "ops": [{"op": "add", "u": "x", "v": "y"}]}
        )
        proc = run_cli(seed, self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        before = load_graph(self.state)

        path = self.write_tx(self.make_tx())
        proc = run_cli(path, self.state, fail_after=1)
        self.assertEqual(proc.returncode, 3, proc.stdout)
        # Committed state untouched by the crashed transaction.
        self.assertEqual(load_graph(self.state), before)
        self.assert_graph_matches([("x", "y")])

        proc2 = run_cli(path, self.state)
        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        self.assert_graph_matches(
            [("x", "y"), ("a", "b"), ("b", "c"), ("c", "d")]
        )
        self.assert_queries_match_independent_bfs("tx-pairs-post-crash")

    def test_fail_after_beyond_mutation_count_commits(self):
        path = self.write_tx(self.make_tx())
        proc = run_cli(path, self.state, fail_after=99)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assert_graph_matches([("a", "b"), ("b", "c"), ("c", "d")])

    def test_idempotent_replay_of_committed_tx(self):
        path = self.write_tx(self.make_tx())
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        first = json.loads(proc.stdout)
        committed = load_graph(self.state)

        # Same id again: returns the old results without re-applying.
        proc2 = run_cli(path, self.state)
        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        self.assertEqual(json.loads(proc2.stdout), first)
        self.assertEqual(load_graph(self.state), committed)
        self.assert_graph_matches([("a", "b"), ("b", "c"), ("c", "d")])


class TestRecoveryUnit(DcTestCase):
    def test_recover_installs_committed_but_unsaved_tx(self):
        # Simulate a crash between the commit record and the graph install.
        os.makedirs(self.state, exist_ok=True)
        from dc import core

        core.save_graph(self.state, core.empty_graph())
        core.append_wal(self.state, {"tx": "t1", "type": "add", "u": "a", "v": "b"})
        core.append_wal(
            self.state,
            {
                "tx": "t1",
                "type": "commit",
                "results": [{"u": "a", "v": "b", "connected": True}],
            },
        )
        graph = core.recover(self.state)
        self.assertEqual(graph["last_tx"], "t1")
        self.assert_graph_matches([("a", "b")])
        self.assertEqual(core.read_wal(self.state), [])

        # Idempotent replay returns the stored old results.
        results = core.run_tx(
            self.state,
            {"id": "t1", "ops": [{"op": "add", "u": "a", "v": "b"}]},
        )
        self.assertEqual(results, [{"u": "a", "v": "b", "connected": True}])
        self.assert_graph_matches([("a", "b")])


class TestBadInput(DcTestCase):
    def test_invalid_json_exits_2(self):
        path = self.write_tx(None, raw="{not valid json")
        proc = run_cli(path, self.state)
        self.assertEqual(proc.returncode, 2)

    def test_malformed_transaction_exits_2(self):
        for bad in (
            {"ops": []},  # missing id
            {"id": "t"},  # missing ops
            {"id": "t", "ops": [{"op": "explode", "u": "a", "v": "b"}]},
            {"id": "t", "ops": [{"op": "add", "u": "a"}]},
        ):
            path = self.write_tx(bad)
            proc = run_cli(path, self.state)
            self.assertEqual(proc.returncode, 2, f"expected exit 2 for {bad}")

    def test_missing_tx_file_exits_2(self):
        proc = run_cli(os.path.join(self.tmp.name, "nope.json"), self.state)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
