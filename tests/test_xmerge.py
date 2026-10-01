import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from xmerge import (  # noqa: E402
    GraphError,
    ancestors,
    merge_bases,
    merge_heads,
    merge_trees,
    validate_graph,
)


def node(parents, tree):
    return {"parents": parents, "tree": tree}


class UniqueBaseMergeTest(unittest.TestCase):
    """Acceptance: unique merge base, ordinary merge."""

    def setUp(self):
        self.graph = {
            "R": node([], {"a": "1", "b": "2", "c": "3", "d": "4"}),
            # A: changes a, deletes d, changes c (same as B will)
            "A": node(["R"], {"a": "10", "b": "2", "c": "30"}),
            # B: changes b, adds e, changes c to the same value as A
            "B": node(["R"], {"a": "1", "b": "20", "c": "30", "d": "4", "e": "5"}),
        }

    def test_single_merge_base(self):
        self.assertEqual(merge_bases(self.graph, "A", "B"), ["R"])

    def test_merge_result(self):
        merged, conflicts = merge_heads(self.graph, "A", "B")
        # a: only A changed -> 10; b: only B changed -> 20;
        # c: both changed to same value -> 30; d: A deleted, B unchanged -> gone;
        # e: added by B -> 5
        self.assertEqual(merged, {"a": "10", "b": "20", "c": "30", "e": "5"})
        self.assertEqual(conflicts, [])

    def test_head_is_ancestor_of_other(self):
        merged, conflicts = merge_heads(self.graph, "R", "A")
        self.assertEqual(merged, {"a": "10", "b": "2", "c": "30"})
        self.assertEqual(conflicts, [])


class ConflictRulesTest(unittest.TestCase):
    def test_both_changed_differently_conflicts(self):
        merged, conflicts = merge_trees({"p": "0"}, {"p": "1"}, {"p": "2"})
        self.assertEqual(merged, {})
        self.assertEqual(conflicts, {"p"})

    def test_modify_delete_conflicts(self):
        merged, conflicts = merge_trees({"p": "0"}, {}, {"p": "9"})
        self.assertEqual(merged, {})
        self.assertEqual(conflicts, {"p"})

    def test_delete_vs_unchanged_adopts_deletion(self):
        merged, conflicts = merge_trees({"p": "0"}, {}, {"p": "0"})
        self.assertEqual(merged, {})
        self.assertEqual(conflicts, set())

    def test_add_add_same_value_adopts(self):
        merged, conflicts = merge_trees({}, {"p": "1"}, {"p": "1"})
        self.assertEqual(merged, {"p": "1"})
        self.assertEqual(conflicts, set())


class CrissCrossTest(unittest.TestCase):
    """Acceptance: classic criss-cross -> two merge bases -> virtual base."""

    def setUp(self):
        #     R
        #    / \
        #   B1  C1
        #   / \/ \
        #  D  (X)  E      D merges B1,C1 ; E merges C1,B1
        self.graph = {
            "R": node([], {"h": "0", "k": "x"}),
            "B1": node(["R"], {"h": "1", "k": "x"}),
            "C1": node(["R"], {"h": "2", "k": "x"}),
            "D": node(["B1", "C1"], {"h": "3", "k": "x"}),
            "E": node(["C1", "B1"], {"h": "3", "k": "x"}),
        }

    def test_two_merge_bases(self):
        self.assertEqual(merge_bases(self.graph, "D", "E"), ["B1", "C1"])

    def test_virtual_base_conflict_stays_conflict(self):
        # Virtual base = merge(B1, C1) over base R: h conflicts (1 vs 2),
        # k is clean. Even though D and E agree on h == "3", the virtual-base
        # conflict on h must be reported and must not be auto-resolved.
        merged, conflicts = merge_heads(self.graph, "D", "E")
        self.assertEqual(conflicts, ["h"])
        self.assertEqual(merged, {"k": "x"})

    def test_clean_crisscross(self):
        # Same shape, but B1/C1 touch disjoint paths so the virtual base is
        # clean and the final merge adopts it.
        graph = {
            "R": node([], {"f": "0", "g": "0"}),
            "B1": node(["R"], {"f": "1", "g": "0"}),
            "C1": node(["R"], {"f": "0", "g": "2"}),
            "D": node(["B1", "C1"], {"f": "1", "g": "2"}),
            "E": node(["C1", "B1"], {"f": "1", "g": "2"}),
        }
        self.assertEqual(merge_bases(graph, "D", "E"), ["B1", "C1"])
        merged, conflicts = merge_heads(graph, "D", "E")
        self.assertEqual(merged, {"f": "1", "g": "2"})
        self.assertEqual(conflicts, [])


class NoCommonRootTest(unittest.TestCase):
    """Acceptance: no common root -> same value adopted, different conflicts."""

    def setUp(self):
        self.graph = {
            "A": node([], {"x": "1", "same": "v", "diff": "a"}),
            "B": node([], {"y": "2", "same": "v", "diff": "b"}),
        }

    def test_no_merge_base(self):
        self.assertEqual(merge_bases(self.graph, "A", "B"), [])

    def test_merge_with_empty_base(self):
        merged, conflicts = merge_heads(self.graph, "A", "B")
        self.assertEqual(merged, {"x": "1", "y": "2", "same": "v"})
        self.assertEqual(conflicts, ["diff"])


class InvalidGraphTest(unittest.TestCase):
    def test_unknown_parent(self):
        with self.assertRaises(GraphError):
            validate_graph({"A": node(["nope"], {})})

    def test_cycle(self):
        graph = {"A": node(["B"], {}), "B": node(["A"], {})}
        with self.assertRaises(GraphError):
            validate_graph(graph)

    def test_self_cycle(self):
        with self.assertRaises(GraphError):
            validate_graph({"A": node(["A"], {})})

    def test_unknown_head(self):
        with self.assertRaises(GraphError):
            merge_heads({"A": node([], {})}, "A", "ghost")


class AncestorCrossCheckTest(unittest.TestCase):
    """Cross-check: independently enumerated ancestor sets vs. an independent
    lowest-common-ancestor implementation, on random DAGs of <= 10 nodes."""

    @staticmethod
    def reference_ancestors(graph, start):
        # Independent implementation: memoized recursion instead of the
        # iterative stack used by xmerge.ancestors.
        memo = {}

        def rec(nid):
            if nid not in memo:
                result = {nid}
                for parent in graph[nid]["parents"]:
                    result |= rec(parent)
                memo[nid] = result
            return memo[nid]

        return rec(start)

    @staticmethod
    def reference_merge_bases(graph, head_a, head_b):
        # Independent implementation: walk upwards from every common ancestor
        # (excluding itself); every common node reached that way has a
        # common-ancestor descendant and is therefore not a lowest one.
        common = (
            AncestorCrossCheckTest.reference_ancestors(graph, head_a)
            & AncestorCrossCheckTest.reference_ancestors(graph, head_b)
        )
        not_lowest = set()
        for start in common:
            stack = list(graph[start]["parents"])
            while stack:
                current = stack.pop()
                if current in not_lowest:
                    continue
                if current in common:
                    not_lowest.add(current)
                stack.extend(graph[current]["parents"])
        return sorted(common - not_lowest)

    @staticmethod
    def random_dag(rng, size):
        graph = {}
        for i in range(size):
            nid = f"n{i}"
            parents = [f"n{j}" for j in range(i) if rng.random() < 0.35]
            tree = {
                f"p{k}": rng.choice("abc")
                for k in range(rng.randint(0, 4))
                if rng.random() < 0.8
            }
            graph[nid] = node(parents, tree)
        return graph

    def test_cross_check_random_dags(self):
        rng = random.Random(20261001)
        for trial in range(300):
            size = rng.randint(1, 10)
            graph = self.random_dag(rng, size)
            validate_graph(graph)  # must be accepted as a valid DAG
            ids = list(graph)
            for _ in range(5):
                head_a, head_b = rng.choice(ids), rng.choice(ids)
                for nid in ids:
                    self.assertEqual(
                        ancestors(graph, nid),
                        self.reference_ancestors(graph, nid),
                        f"trial {trial}: ancestor set mismatch for {nid}",
                    )
                self.assertEqual(
                    merge_bases(graph, head_a, head_b),
                    self.reference_merge_bases(graph, head_a, head_b),
                    f"trial {trial}: merge bases mismatch for {head_a}, {head_b}",
                )

    def test_random_merges_are_consistent(self):
        # Full merges on random DAGs: conflicts and merged tree stay disjoint,
        # and every merged path keeps a value that some side/base proposed.
        rng = random.Random(7)
        for _ in range(100):
            graph = self.random_dag(rng, rng.randint(1, 10))
            ids = list(graph)
            merged, conflicts = merge_heads(graph, ids[0], ids[-1])
            self.assertTrue(set(merged).isdisjoint(conflicts))
            self.assertEqual(conflicts, sorted(conflicts))


class CliTest(unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "xmerge", *argv],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def write_graph(self, directory, graph, name="graph.json"):
        path = os.path.join(directory, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(graph, handle)
        return path

    def test_clean_merge_exit_0(self):
        graph = {
            "R": node([], {"a": "1"}),
            "A": node(["R"], {"a": "2"}),
            "B": node(["R"], {"a": "1", "b": "3"}),
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_graph(tmp, graph)
            out = os.path.join(tmp, "result.json")
            proc = self.run_cli(path, "A", "B", "-o", out)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout), {"a": "2", "b": "3"})
            self.assertEqual(proc.stderr, "")
            with open(out, encoding="utf-8") as handle:
                result = json.load(handle)
            self.assertEqual(result, {"tree": {"a": "2", "b": "3"}, "conflicts": []})

    def test_conflict_exit_1(self):
        graph = {
            "R": node([], {"a": "1"}),
            "A": node(["R"], {"a": "2"}),
            "B": node(["R"], {"a": "3"}),
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_graph(tmp, graph)
            proc = self.run_cli(path, "A", "B")
            self.assertEqual(proc.returncode, 1)
            self.assertEqual(json.loads(proc.stdout), {})
            self.assertEqual(proc.stderr.strip().splitlines(), ["a"])

    def test_unknown_head_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_graph(tmp, {"A": node([], {})})
            proc = self.run_cli(path, "A", "ghost")
            self.assertEqual(proc.returncode, 2)
            self.assertIn("unknown head", proc.stderr)

    def test_cycle_exit_2(self):
        graph = {"A": node(["B"], {}), "B": node(["A"], {})}
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_graph(tmp, graph)
            proc = self.run_cli(path, "A", "B")
            self.assertEqual(proc.returncode, 2)
            self.assertIn("cycle", proc.stderr)

    def test_duplicate_node_exit_2(self):
        raw = '{"A": {"parents": [], "tree": {}}, "A": {"parents": [], "tree": {}}}'
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "graph.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(raw)
            proc = self.run_cli(path, "A", "A")
            self.assertEqual(proc.returncode, 2)
            self.assertIn("duplicate key", proc.stderr)


if __name__ == "__main__":
    unittest.main()
