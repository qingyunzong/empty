import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cfgdom import CFGError, analyze_program, compute_dominators

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def brute_force_dom(n, succ, entry=0):
    """Path-definition dominators: v dominates u iff every entry->u path
    contains v, i.e. u becomes unreachable when v is removed."""

    def reach(excluded=None):
        seen = set()
        if entry == excluded:
            return seen
        seen.add(entry)
        stack = [entry]
        while stack:
            u = stack.pop()
            for v in succ[u]:
                if v != excluded and v not in seen:
                    seen.add(v)
                    stack.append(v)
        return seen

    reachable = reach()
    dom = {}
    for u in reachable:
        dom[u] = {v for v in reachable if u not in reach(excluded=v)}
    return reachable, dom


class TestValidation(unittest.TestCase):
    def test_empty_program(self):
        with self.assertRaises(CFGError):
            analyze_program([])

    def test_duplicate_offset_reports_offset(self):
        prog = [
            {"offset": 0, "fallthrough": False, "targets": []},
            {"offset": 0, "fallthrough": False, "targets": []},
        ]
        with self.assertRaises(CFGError) as ctx:
            analyze_program(prog)
        self.assertEqual(ctx.exception.offset, 0)
        self.assertIn("offset 0", str(ctx.exception))

    def test_bad_edge_reports_offset(self):
        prog = [
            {"offset": 0, "fallthrough": False, "targets": [99]},
        ]
        with self.assertRaises(CFGError) as ctx:
            analyze_program(prog)
        self.assertEqual(ctx.exception.offset, 0)
        self.assertIn("99", str(ctx.exception))

    def test_missing_offset(self):
        with self.assertRaises(CFGError):
            analyze_program([{"fallthrough": True}])


class TestExhaustiveSample(unittest.TestCase):
    """Acceptance A: 500 sampled CFGs (n<=6 blocks, <=8 edges) must match
    the brute-force path definition of domination."""

    def test_random_cfgs_match_brute_force(self):
        rng = random.Random(20261001)
        for case in range(500):
            n = rng.randint(1, 6)
            m = rng.randint(0, min(8, n * n))
            edges = set()
            while len(edges) < m:
                edges.add((rng.randrange(n), rng.randrange(n)))
            succ = [[] for _ in range(n)]
            for u, v in edges:
                succ[u].append(v)

            reachable, dom, idom = compute_dominators(n, succ)
            bf_reach, bf_dom = brute_force_dom(n, succ)

            self.assertEqual(
                {i for i in range(n) if reachable[i]},
                bf_reach,
                f"case {case}: reachable mismatch, edges={sorted(edges)}",
            )
            for u in bf_dom:
                self.assertEqual(
                    dom[u],
                    bf_dom[u],
                    f"case {case}: dom[{u}] mismatch, edges={sorted(edges)}",
                )
                if u != 0:
                    strict = bf_dom[u] - {u}
                    expected_idom = max(strict, key=lambda d: len(bf_dom[d]))
                    self.assertEqual(
                        idom[u],
                        expected_idom,
                        f"case {case}: idom[{u}] mismatch, edges={sorted(edges)}",
                    )
                else:
                    self.assertIsNone(idom[u])


class TestUnreachableBlocks(unittest.TestCase):
    """Acceptance B: unreachable blocks are kept, flagged, and do not
    affect the idom of reachable blocks."""

    PROG = [
        {"offset": 0, "fallthrough": True, "targets": [4]},
        {"offset": 2, "fallthrough": False, "targets": []},
        {"offset": 4, "fallthrough": False, "targets": []},
        {"offset": 6, "fallthrough": False, "targets": []},  # unreachable
    ]

    def test_unreachable_flagged_and_kept(self):
        result = analyze_program(self.PROG)
        self.assertEqual(len(result["blocks"]), 4)
        by_id = {b["id"]: b for b in result["blocks"]}
        self.assertFalse(by_id[3]["reachable"])
        self.assertIsNone(by_id[3]["dom"])
        self.assertIsNone(by_id[3]["idom"])
        for i in (0, 1, 2):
            self.assertTrue(by_id[i]["reachable"])

    def test_unreachable_does_not_change_reachable_idom(self):
        with_extra = analyze_program(self.PROG)
        without_extra = analyze_program(self.PROG[:3])
        idoms_with = [b["idom"] for b in with_extra["blocks"][:3]]
        idoms_without = [b["idom"] for b in without_extra["blocks"]]
        self.assertEqual(idoms_with, idoms_without)
        doms_with = [b["dom"] for b in with_extra["blocks"][:3]]
        doms_without = [b["dom"] for b in without_extra["blocks"]]
        self.assertEqual(doms_with, doms_without)


class TestIfElseJoin(unittest.TestCase):
    """Acceptance C: the join of an if-else diamond is immediately
    dominated by the condition block."""

    PROG = [
        {"offset": 0, "fallthrough": True, "targets": [4]},   # if cond goto 4
        {"offset": 2, "fallthrough": False, "targets": [6]},  # then: goto 6
        {"offset": 4, "fallthrough": False, "targets": [6]},  # else: goto 6
        {"offset": 6, "fallthrough": False, "targets": []},   # join: halt
    ]

    def test_join_idom_is_condition_block(self):
        result = analyze_program(self.PROG)
        by_id = {b["id"]: b for b in result["blocks"]}
        self.assertEqual(len(by_id), 4)
        self.assertIsNone(by_id[0]["idom"])
        self.assertEqual(by_id[1]["idom"], 0)
        self.assertEqual(by_id[2]["idom"], 0)
        self.assertEqual(by_id[3]["idom"], 0)  # join's idom = condition block
        self.assertEqual(by_id[3]["dom"], [0, 3])
        self.assertEqual(result["back_edges"], [])
        self.assertEqual(result["loop_headers"], [])


class TestBackEdges(unittest.TestCase):
    """Acceptance D: self-loops and cross-block back edges are detected;
    loop headers are the back-edge targets."""

    def test_self_loop(self):
        prog = [{"offset": 0, "fallthrough": True, "targets": [0]}]
        result = analyze_program(prog)
        self.assertEqual(result["edges"], [[0, 0]])
        self.assertEqual(result["back_edges"], [[0, 0]])
        self.assertEqual(result["loop_headers"], [0])

    def test_cross_block_back_edge(self):
        prog = [
            {"offset": 0, "fallthrough": True, "targets": []},   # B0 -> B1
            {"offset": 2, "fallthrough": True, "targets": [6]},  # B1 -> B2/B3
            {"offset": 4, "fallthrough": False, "targets": [2]}, # B2 -> B1 (back)
            {"offset": 6, "fallthrough": False, "targets": []},  # B3 halt
        ]
        result = analyze_program(prog)
        self.assertEqual(result["back_edges"], [[2, 1]])
        self.assertEqual(result["loop_headers"], [1])
        by_id = {b["id"]: b for b in result["blocks"]}
        self.assertEqual(by_id[1]["dom"], [0, 1])
        self.assertEqual(by_id[2]["idom"], 1)

    def test_forward_edge_is_not_back_edge(self):
        prog = [
            {"offset": 0, "fallthrough": True, "targets": [4]},
            {"offset": 2, "fallthrough": True, "targets": []},
            {"offset": 4, "fallthrough": False, "targets": []},
        ]
        result = analyze_program(prog)
        self.assertEqual(result["back_edges"], [])


class TestCLI(unittest.TestCase):
    def run_cli(self, args, cwd):
        return subprocess.run(
            [sys.executable, "-m", "cfgdom"] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
        )

    def test_success_writes_dom_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            prog = [
                {"offset": 0, "fallthrough": True, "targets": [4]},
                {"offset": 2, "fallthrough": False, "targets": [6]},
                {"offset": 4, "fallthrough": False, "targets": [6]},
                {"offset": 6, "fallthrough": False, "targets": []},
            ]
            prog_path = os.path.join(tmp, "prog.json")
            dom_path = os.path.join(tmp, "dom.json")
            with open(prog_path, "w") as fh:
                json.dump(prog, fh)
            proc = self.run_cli([prog_path, "--emit", dom_path], REPO_ROOT)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(dom_path) as fh:
                result = json.load(fh)
            self.assertEqual(result["blocks"][3]["idom"], 0)

    def test_error_exit_code_8_and_no_output_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            prog_path = os.path.join(tmp, "prog.json")
            dom_path = os.path.join(tmp, "dom.json")
            with open(prog_path, "w") as fh:
                json.dump([{"offset": 0, "fallthrough": False, "targets": [42]}], fh)
            proc = self.run_cli([prog_path, "--emit", dom_path], REPO_ROOT)
            self.assertEqual(proc.returncode, 8)
            self.assertIn("CFGError", proc.stderr)
            self.assertIn("offset 0", proc.stderr)
            self.assertFalse(os.path.exists(dom_path))

    def test_empty_program_exit_code_8(self):
        with tempfile.TemporaryDirectory() as tmp:
            prog_path = os.path.join(tmp, "prog.json")
            dom_path = os.path.join(tmp, "dom.json")
            with open(prog_path, "w") as fh:
                json.dump([], fh)
            proc = self.run_cli([prog_path, "--emit", dom_path], REPO_ROOT)
            self.assertEqual(proc.returncode, 8)
            self.assertFalse(os.path.exists(dom_path))


if __name__ == "__main__":
    unittest.main()
