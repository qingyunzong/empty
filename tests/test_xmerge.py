import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from xmerge import Graph, GraphError, Merger, three_way_merge

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def merge(nodes, a, b):
    return Merger(Graph(nodes)).merge_commits(a, b)


def node(parents, tree):
    return {"parents": parents, "tree": tree}


class UniqueBaseTests(unittest.TestCase):
    def test_unique_base_clean_merge(self):
        nodes = {
            "base": node([], {"a": "1", "b": "1", "c": "1"}),
            "ours": node(["base"], {"a": "2", "b": "1", "c": "1"}),
            "theirs": node(["base"], {"a": "1", "b": "2"}),
        }
        tree, conflicts = merge(nodes, "ours", "theirs")
        self.assertEqual(tree, {"a": "2", "b": "2"})  # c deleted by theirs
        self.assertEqual(conflicts, set())

    def test_both_same_change_adopted(self):
        nodes = {
            "base": node([], {"a": "1"}),
            "ours": node(["base"], {"a": "2", "n": "x"}),
            "theirs": node(["base"], {"a": "2", "n": "x"}),
        }
        tree, conflicts = merge(nodes, "ours", "theirs")
        self.assertEqual(tree, {"a": "2", "n": "x"})
        self.assertEqual(conflicts, set())

    def test_both_different_values_conflict(self):
        nodes = {
            "base": node([], {"a": "1"}),
            "ours": node(["base"], {"a": "2"}),
            "theirs": node(["base"], {"a": "3"}),
        }
        tree, conflicts = merge(nodes, "ours", "theirs")
        self.assertEqual(tree, {})
        self.assertEqual(conflicts, {"a"})

    def test_modify_delete_conflict(self):
        nodes = {
            "base": node([], {"f": "1", "g": "1"}),
            "ours": node(["base"], {"g": "1"}),           # deleted f
            "theirs": node(["base"], {"f": "2", "g": "1"}),  # modified f
        }
        tree, conflicts = merge(nodes, "ours", "theirs")
        self.assertEqual(tree, {"g": "1"})
        self.assertEqual(conflicts, {"f"})

    def test_delete_vs_unchanged_is_clean(self):
        nodes = {
            "base": node([], {"f": "1"}),
            "ours": node(["base"], {}),
            "theirs": node(["base"], {"f": "1"}),
        }
        tree, conflicts = merge(nodes, "ours", "theirs")
        self.assertEqual(tree, {})
        self.assertEqual(conflicts, set())


class CrissCrossTests(unittest.TestCase):
    def setUp(self):
        # Classic criss-cross: M1 and M2 both have A1 and B1 as parents.
        # Merge bases of (M1, M2) are {A1, B1}; path "c" conflicts while
        # building the virtual base and must stay conflicted even though
        # M1 and M2 agree on it.
        self.nodes = {
            "O": node([], {"f": "0", "g": "0", "c": "0"}),
            "A1": node(["O"], {"f": "a", "g": "0", "c": "1"}),
            "B1": node(["O"], {"f": "0", "g": "b", "c": "2"}),
            "M1": node(["A1", "B1"], {"f": "a", "g": "b", "c": "3"}),
            "M2": node(["B1", "A1"], {"f": "a", "g": "b", "c": "3"}),
        }

    def test_two_merge_bases(self):
        graph = Graph(self.nodes)
        self.assertEqual(graph.merge_bases("M1", "M2"), ["A1", "B1"])

    def test_virtual_base_conflict_propagates(self):
        tree, conflicts = merge(self.nodes, "M1", "M2")
        # Virtual base = merge(A1, B1) over O: f->a, g->b, c conflicts
        # (1 vs 2) so it is poisoned. Final merge must report c as a
        # conflict despite both heads holding the same value "3".
        self.assertEqual(tree, {"f": "a", "g": "b"})
        self.assertEqual(conflicts, {"c"})

    def test_criss_cross_clean_paths_merge(self):
        nodes = dict(self.nodes)
        nodes["M1"] = node(["A1", "B1"], {"f": "a", "g": "b", "c": "3", "h": "from-m1"})
        nodes["M2"] = node(["B1", "A1"], {"f": "a", "g": "b", "c": "3"})
        tree, conflicts = merge(nodes, "M1", "M2")
        self.assertEqual(tree, {"f": "a", "g": "b", "h": "from-m1"})
        self.assertEqual(conflicts, {"c"})


class NoCommonRootTests(unittest.TestCase):
    def test_disjoint_roots(self):
        nodes = {
            "A": node([], {"same": "x", "diff": "1", "only-a": "a"}),
            "B": node([], {"same": "x", "diff": "2", "only-b": "b"}),
        }
        graph = Graph(nodes)
        self.assertEqual(graph.merge_bases("A", "B"), [])
        tree, conflicts = merge(nodes, "A", "B")
        self.assertEqual(tree, {"same": "x", "only-a": "a", "only-b": "b"})
        self.assertEqual(conflicts, {"diff"})


class GraphValidationTests(unittest.TestCase):
    def test_cycle_rejected(self):
        nodes = {
            "a": node(["b"], {}),
            "b": node(["a"], {}),
        }
        with self.assertRaises(GraphError):
            Graph(nodes)

    def test_self_loop_rejected(self):
        with self.assertRaises(GraphError):
            Graph({"a": node(["a"], {})})

    def test_unknown_parent_rejected(self):
        with self.assertRaises(GraphError):
            Graph({"a": node(["ghost"], {})})


class MergeBaseCrossCheckTests(unittest.TestCase):
    """Cross-check ancestor-set merge bases against an independent
    descendant-map computation on random DAGs of <= 10 nodes."""

    @staticmethod
    def independent_merge_bases(nodes, a, b):
        children = {nid: [] for nid in nodes}
        for nid, nd in nodes.items():
            for parent in nd["parents"]:
                children[parent].append(nid)

        def descendants_inclusive(x):
            seen, stack = set(), [x]
            while stack:
                cur = stack.pop()
                if cur in seen:
                    continue
                seen.add(cur)
                stack.extend(children[cur])
            return seen

        common = [
            nid
            for nid in nodes
            if a in descendants_inclusive(nid) and b in descendants_inclusive(nid)
        ]
        return sorted(
            c
            for c in common
            if not any(o != c and o in descendants_inclusive(c) for o in common)
        )

    def test_random_dags_up_to_10_nodes(self):
        rng = random.Random(20261001)
        for trial in range(500):
            n = rng.randint(1, 10)
            nodes = {}
            for i in range(n):
                parents = [str(j) for j in range(i) if rng.random() < 0.4]
                nodes[str(i)] = node(parents, {})
            a, b = rng.sample(list(nodes), 2) if n >= 2 else ("0", "0")
            graph = Graph(nodes)
            self.assertEqual(
                graph.merge_bases(a, b),
                self.independent_merge_bases(nodes, a, b),
                f"trial {trial}: heads {a},{b} graph {nodes}",
            )


class CliTests(unittest.TestCase):
    def run_cli(self, graph_obj_or_text, ours, theirs, use_output=True):
        with tempfile.TemporaryDirectory() as tmp:
            graph_path = os.path.join(tmp, "graph.json")
            if isinstance(graph_obj_or_text, str):
                text = graph_obj_or_text
            else:
                text = json.dumps(graph_obj_or_text)
            with open(graph_path, "w", encoding="utf-8") as fh:
                fh.write(text)
            out_path = os.path.join(tmp, "result.json")
            cmd = [sys.executable, "-m", "xmerge", graph_path, ours, theirs]
            if use_output:
                cmd += ["-o", out_path]
            proc = subprocess.run(
                cmd, cwd=ROOT, capture_output=True, text=True
            )
            result = None
            if os.path.exists(out_path):
                with open(out_path, encoding="utf-8") as fh:
                    result = json.load(fh)
            return proc, result

    def test_cli_clean_merge_exit_0(self):
        nodes = {
            "base": node([], {"a": "1"}),
            "A": node(["base"], {"a": "2"}),
            "B": node(["base"], {"a": "1", "b": "3"}),
        }
        proc, result = self.run_cli(nodes, "A", "B")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {"a": "2", "b": "3"})
        self.assertEqual(result, {"a": "2", "b": "3"})
        self.assertEqual(proc.stderr, "")

    def test_cli_conflict_exit_1(self):
        nodes = {
            "base": node([], {"a": "1"}),
            "A": node(["base"], {"a": "2"}),
            "B": node(["base"], {"a": "3"}),
        }
        proc, result = self.run_cli(nodes, "A", "B")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(json.loads(proc.stdout), {})
        self.assertEqual(result, {})
        self.assertEqual(proc.stderr.strip(), "a")

    def test_cli_unknown_head_exit_2(self):
        proc, _ = self.run_cli({"A": node([], {})}, "A", "ZZZ")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("unknown head", proc.stderr)

    def test_cli_cycle_exit_2(self):
        nodes = {"A": node(["B"], {}), "B": node(["A"], {})}
        proc, _ = self.run_cli(nodes, "A", "B")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("cycle", proc.stderr)

    def test_cli_duplicate_node_exit_2(self):
        text = '{"A": {"parents": [], "tree": {}}, "A": {"parents": [], "tree": {}}}'
        proc, _ = self.run_cli(text, "A", "A")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("duplicate", proc.stderr)


if __name__ == "__main__":
    unittest.main()
