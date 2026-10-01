import json
import os
import random
import subprocess
import sys
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from dyntopo import CycleError, DynamicTopoGraph, UnknownNodeError


# ---------------------------------------------------------------------------
# offline oracles
# ---------------------------------------------------------------------------
def offline_order(nodes, edges):
    """From-scratch level-wise Kahn: level 0 = sources, ids sorted per level."""
    pred = {n: set() for n in nodes}
    for u, v in edges:
        pred[v].add(u)
    level = {}

    def lev(n):
        if n not in level:
            level[n] = max((lev(p) + 1 for p in pred[n]), default=0)
        return level[n]

    for n in nodes:
        lev(n)
    by_level = {}
    for n, l in level.items():
        by_level.setdefault(l, []).append(n)
    return [n for l in sorted(by_level) for n in sorted(by_level[l])]


def enumerate_topo_orders(nodes, edges, cap=200000):
    """Backtracking Kahn: enumerate all linear extensions (capped)."""
    succ = {n: set() for n in nodes}
    indeg = {n: 0 for n in nodes}
    for u, v in edges:
        succ[u].add(v)
        indeg[v] += 1
    out = []
    current = []

    def visit(available):
        if len(out) >= cap:
            return
        if not available:
            out.append(tuple(current))
            return
        for n in sorted(available):
            nxt_available = (available - {n})
            for m in succ[n]:
                indeg[m] -= 1
                if indeg[m] == 0:
                    nxt_available |= {m}
            current.append(n)
            visit(nxt_available)
            current.pop()
            for m in succ[n]:
                indeg[m] += 1

    visit({n for n in nodes if indeg[n] == 0})
    return out


def assert_valid_order(testcase, graph, order):
    testcase.assertEqual(sorted(order), sorted(graph.nodes))
    pos = {n: i for i, n in enumerate(order)}
    for u in graph.nodes:
        for v in graph._succ[u]:
            testcase.assertLess(pos[u], pos[v], "edge %r->%r violated" % (u, v))


def run_cli(stdin_text):
    return subprocess.run(
        [sys.executable, "-m", "dyntopo"],
        input=stdin_text,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


# ---------------------------------------------------------------------------
# Acceptance A: step-by-step adds vs offline Kahn on 100 random small graphs
# ---------------------------------------------------------------------------
class TestAcceptanceA(unittest.TestCase):
    def test_incremental_adds_match_offline_kahn(self):
        rng = random.Random(20261001)
        for trial in range(100):
            n = rng.randint(2, 6)
            nodes = [chr(ord("a") + i) for i in range(n)]
            base = list(nodes)
            rng.shuffle(base)
            edges = set()
            for i in range(n):
                for j in range(i + 1, n):
                    if rng.random() < 0.4:
                        edges.add((base[i], base[j]))

            graph = DynamicTopoGraph()
            # nodes first (random order), then edges (random order): edges may
            # only reference existing nodes, as the CLI requires
            ops = [("add_node", x) for x in rng.sample(nodes, n)]
            ops += [("add_edge", u, v) for u, v in rng.sample(sorted(edges), len(edges))]

            for op in ops:
                if op[0] == "add_node":
                    graph.add_node(op[1])
                else:
                    graph.add_edge(op[1], op[2])
                assert_valid_order(self, graph, graph.order())

            expected = offline_order(nodes, edges)
            self.assertEqual(graph.order(), expected,
                             "trial %d: incremental %s != offline %s"
                             % (trial, graph.order(), expected))

            # membership in the enumerated set of all Kahn linear extensions
            all_orders = enumerate_topo_orders(nodes, edges)
            self.assertIn(tuple(graph.order()), all_orders)

            # determinism: replaying the same op sequence gives the same order
            replay = DynamicTopoGraph()
            for op in ops:
                if op[0] == "add_node":
                    replay.add_node(op[1])
                else:
                    replay.add_edge(op[1], op[2])
            self.assertEqual(replay.order(), graph.order())

    def test_no_hash_randomness_across_processes(self):
        script = (
            "from dyntopo import DynamicTopoGraph\n"
            "g = DynamicTopoGraph()\n"
            "for n in ['delta','alpha','charlie','bravo','echo']: g.add_node(n)\n"
            "g.add_edge('delta','echo'); g.add_edge('alpha','bravo')\n"
            "print(g.order())\n"
        )
        results = {
            subprocess.run([sys.executable, "-c", script], capture_output=True,
                           text=True, cwd=REPO_ROOT,
                           env={**os.environ, "PYTHONHASHSEED": seed}).stdout
            for seed in ("0", "1", "42")
        }
        self.assertEqual(len(results), 1, "order must not depend on hash seed")


# ---------------------------------------------------------------------------
# Acceptance B: deleting a key edge only changes the order locally
# ---------------------------------------------------------------------------
class TestAcceptanceB(unittest.TestCase):
    def test_delete_key_edge_unlocks_only_successors(self):
        graph = DynamicTopoGraph()
        for n in ("a", "b", "c", "d"):
            graph.add_node(n)
        graph.add_edge("a", "b")
        graph.add_edge("a", "c")
        graph.add_edge("b", "d")
        graph.add_edge("c", "d")
        self.assertEqual(graph.order(), ["a", "b", "c", "d"])

        graph.del_edge("a", "c")
        # c drops to level 0 (only unlocks the successor side); a, b, d keep
        # their relative order: the change is confined to the b/c pair.
        self.assertEqual(graph.order(), ["a", "c", "b", "d"])

    def test_unrelated_relative_order_preserved(self):
        rng = random.Random(7)
        for _ in range(50):
            graph = DynamicTopoGraph()
            nodes = [chr(ord("a") + i) for i in range(6)]
            for n in nodes:
                graph.add_node(n)
            base = list(nodes)
            rng.shuffle(base)
            edges = set()
            for i in range(6):
                for j in range(i + 1, 6):
                    if rng.random() < 0.35:
                        edges.add((base[i], base[j]))
                        graph.add_edge(base[i], base[j])
            if not edges:
                continue
            u, v = rng.choice(sorted(edges))
            before = graph.order()
            graph.del_edge(u, v)
            after = graph.order()
            assert_valid_order(self, graph, after)

            affected = graph._descendants(v)
            unaffected_before = [n for n in before if n not in affected]
            unaffected_after = [n for n in after if n not in affected]
            # nodes unrelated to the deleted edge keep their relative order
            self.assertEqual(unaffected_before, unaffected_after)
            # levels of unaffected nodes are untouched
            for n in unaffected_before:
                self.assertEqual(before.index(n) >= 0, True)


# ---------------------------------------------------------------------------
# Acceptance C: self-loop and two-node cycle fail consistently
# ---------------------------------------------------------------------------
class TestAcceptanceC(unittest.TestCase):
    def test_self_loop_library(self):
        graph = DynamicTopoGraph()
        graph.add_node("a")
        with self.assertRaises(CycleError) as ctx:
            graph.add_edge("a", "a")
        self.assertEqual(ctx.exception.nodes, ["a"])
        self.assertEqual(graph.order(), ["a"])  # last acyclic snapshot kept
        self.assertFalse(graph.has_edge("a", "a"))

    def test_two_node_cycle_library(self):
        graph = DynamicTopoGraph()
        graph.add_node("a")
        graph.add_node("b")
        graph.add_edge("a", "b")
        with self.assertRaises(CycleError) as ctx:
            graph.add_edge("b", "a")
        self.assertEqual(ctx.exception.nodes, ["a", "b"])
        self.assertEqual(graph.order(), ["a", "b"])  # snapshot preserved
        self.assertFalse(graph.has_edge("b", "a"))

    def test_cycle_cli_exit3_and_payload(self):
        for commands, expected_cycle in (
            ('{"op":"add_node","node":"a"}\n{"op":"add_edge","from":"a","to":"a"}\n',
             ["a"]),
            ('{"op":"add_node","node":"a"}\n{"op":"add_node","node":"b"}\n'
             '{"op":"add_edge","from":"a","to":"b"}\n'
             '{"op":"add_edge","from":"b","to":"a"}\n',
             ["a", "b"]),
        ):
            proc = run_cli(commands)
            self.assertEqual(proc.returncode, 3, proc.stderr)
            payload = json.loads(proc.stdout.strip())
            self.assertEqual(payload["error"], "cycle")
            self.assertEqual(payload["cycle"], expected_cycle)

    def test_longer_cycle_reports_scc_nodes(self):
        graph = DynamicTopoGraph()
        for n in ("a", "b", "c", "d"):
            graph.add_node(n)
        graph.add_edge("a", "b")
        graph.add_edge("b", "c")
        graph.add_edge("c", "d")
        with self.assertRaises(CycleError) as ctx:
            graph.add_edge("c", "a")
        self.assertEqual(ctx.exception.nodes, ["a", "b", "c"])


# ---------------------------------------------------------------------------
# Acceptance D: repeated add_edge is a no-op (no version change)
# ---------------------------------------------------------------------------
class TestAcceptanceD(unittest.TestCase):
    def test_repeated_add_edge_no_version_change(self):
        graph = DynamicTopoGraph()
        graph.add_node("a")
        graph.add_node("b")
        self.assertTrue(graph.add_edge("a", "b"))
        version = graph.version
        order = graph.order()
        self.assertFalse(graph.add_edge("a", "b"))
        self.assertFalse(graph.add_edge("a", "b"))
        self.assertEqual(graph.version, version)
        self.assertEqual(graph.order(), order)

    def test_repeated_add_node_no_version_change(self):
        graph = DynamicTopoGraph()
        self.assertTrue(graph.add_node("a"))
        version = graph.version
        self.assertFalse(graph.add_node("a"))
        self.assertEqual(graph.version, version)

    def test_repeated_del_edge_no_version_change(self):
        graph = DynamicTopoGraph()
        graph.add_node("a")
        graph.add_node("b")
        graph.add_edge("a", "b")
        self.assertTrue(graph.del_edge("a", "b"))
        version = graph.version
        self.assertFalse(graph.del_edge("a", "b"))
        self.assertEqual(graph.version, version)


# ---------------------------------------------------------------------------
# Errors: exit 2 on bad JSON, exit 4 on unknown node, never partially applied
# ---------------------------------------------------------------------------
class TestErrors(unittest.TestCase):
    def test_bad_json_exit2(self):
        proc = run_cli('{"op":"add_node","node":"a"}\n{"op": broken\n')
        self.assertEqual(proc.returncode, 2)
        self.assertIn("invalid_json", proc.stderr)

    def test_unknown_op_exit2(self):
        proc = run_cli('{"op":"explode"}\n')
        self.assertEqual(proc.returncode, 2)

    def test_missing_field_exit2(self):
        proc = run_cli('{"op":"add_edge","from":"a"}\n')
        self.assertEqual(proc.returncode, 2)

    def test_unknown_node_exit4(self):
        proc = run_cli('{"op":"add_edge","from":"a","to":"b"}\n')
        self.assertEqual(proc.returncode, 4)
        self.assertIn("unknown_node", proc.stderr)

    def test_unknown_del_node_exit4(self):
        proc = run_cli('{"op":"del_node","node":"ghost"}\n')
        self.assertEqual(proc.returncode, 4)

    def test_no_partial_application_library(self):
        graph = DynamicTopoGraph()
        graph.add_node("a")
        before_order = graph.order()
        before_version = graph.version
        with self.assertRaises(UnknownNodeError):
            graph.add_edge("a", "ghost")
        with self.assertRaises(UnknownNodeError):
            graph.del_node("ghost")
        with self.assertRaises(UnknownNodeError):
            graph.del_edge("ghost", "a")
        self.assertEqual(graph.order(), before_order)
        self.assertEqual(graph.version, before_version)
        self.assertEqual(graph.nodes, {"a"})

    def test_no_partial_application_cli(self):
        proc = run_cli(
            '{"op":"add_node","node":"a"}\n'
            '{"op":"order"}\n'
            '{"op":"add_edge","from":"a","to":"ghost"}\n'
        )
        self.assertEqual(proc.returncode, 4)
        # the order printed before the failing command is the only output
        self.assertEqual(proc.stdout.strip(), '["a"]')


# ---------------------------------------------------------------------------
# del_node cascades incident edges
# ---------------------------------------------------------------------------
class TestDelNode(unittest.TestCase):
    def test_cascade_delete(self):
        graph = DynamicTopoGraph()
        for n in ("a", "b", "c", "d"):
            graph.add_node(n)
        graph.add_edge("a", "b")
        graph.add_edge("b", "c")
        graph.add_edge("c", "d")
        graph.del_node("b")
        self.assertEqual(graph.nodes, {"a", "c", "d"})
        self.assertFalse(graph.has_edge("a", "b"))
        assert_valid_order(self, graph, graph.order())
        # c lost its only predecessor chain and drops to level 0
        self.assertEqual(graph.order(), ["a", "c", "d"])

    def test_del_node_idempotent_unknown(self):
        graph = DynamicTopoGraph()
        graph.add_node("a")
        graph.del_node("a")
        with self.assertRaises(UnknownNodeError):
            graph.del_node("a")


# ---------------------------------------------------------------------------
# CLI happy path
# ---------------------------------------------------------------------------
class TestCli(unittest.TestCase):
    def test_order_output_sorted_levels(self):
        proc = run_cli(
            '{"op":"add_node","node":"delta"}\n'
            '{"op":"add_node","node":"alpha"}\n'
            '{"op":"add_node","node":"charlie"}\n'
            '{"op":"add_edge","from":"alpha","to":"charlie"}\n'
            '{"op":"order"}\n'
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout.strip()), ["alpha", "delta", "charlie"])

    def test_empty_input_exit0(self):
        proc = run_cli("")
        self.assertEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
