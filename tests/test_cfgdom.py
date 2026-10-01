"""Tests for cfgdom: CFG construction, dominators, back edges, CLI."""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from cfgdom import CFGError, analyze, build_cfg

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def program_from_graph(num_blocks, edges):
    """One instruction per block; offsets are 4*i; no fallthrough, so every
    instruction is its own block and the CFG edges equal `edges` exactly."""
    offsets = [4 * i for i in range(num_blocks)]
    succ = {i: set() for i in range(num_blocks)}
    for u, v in edges:
        succ[u].add(v)
    instructions = []
    for i in range(num_blocks):
        instructions.append({
            "offset": offsets[i],
            "fallthrough": False,
            "targets": [offsets[v] for v in sorted(succ[i])],
        })
    return {"instructions": instructions}


def brute_force_dom(num_nodes, edges, entry=0):
    """Path-based dominance: v in dom(u) iff every path entry->u visits v.
    Unreachable nodes are vacuously dominated by everything."""
    succ = {i: set() for i in range(num_nodes)}
    for u, v in edges:
        succ[u].add(v)

    paths_to = {u: [] for u in range(num_nodes)}

    def walk(node, path):
        if node in path:
            return
        path = path + (node,)
        paths_to[node].append(path)
        for nxt in succ[node]:
            walk(nxt, path)

    walk(entry, ())
    dom = {}
    for u in range(num_nodes):
        paths = paths_to[u]
        if not paths:
            dom[u] = set(range(num_nodes))  # vacuous truth
        else:
            dom[u] = set.intersection(*(set(p) for p in paths))
    return dom


def reachable_nodes(num_nodes, edges, entry=0):
    succ = {i: set() for i in range(num_nodes)}
    for u, v in edges:
        succ[u].add(v)
    seen = {entry}
    stack = [entry]
    while stack:
        u = stack.pop()
        for v in succ[u]:
            if v not in seen:
                seen.add(v)
                stack.append(v)
    return seen


class TestRandomGraphsAgainstBruteForce(unittest.TestCase):
    """Acceptance A: 500 sampled CFGs (n<=6 blocks, <=8 edges) must agree
    with the brute-force path definition of dominance."""

    SAMPLES = 500

    def test_random_graphs(self):
        rng = random.Random(20261001)
        for case in range(self.SAMPLES):
            n = rng.randint(1, 6)
            all_edges = [(u, v) for u in range(n) for v in range(n)]
            k = rng.randint(0, min(8, len(all_edges)))
            edges = rng.sample(all_edges, k)
            with self.subTest(case=case, n=n, edges=edges):
                self._check_graph(n, edges)

    def _check_graph(self, n, edges):
        cfg = build_cfg(program_from_graph(n, edges))
        self.assertEqual(len(cfg.blocks), n)
        self.assertEqual(set(cfg.edges), set(edges))

        expected_dom = brute_force_dom(n, edges)
        reachable = reachable_nodes(n, edges)

        for block in cfg.blocks:
            self.assertEqual(block.dom, expected_dom[block.id],
                             f"dom mismatch for block {block.id}")
            self.assertEqual(block.unreachable, block.id not in reachable)

        # idom: strict dominator with the largest dom set (reachable only).
        for block in cfg.blocks:
            if block.id == 0 or block.unreachable:
                self.assertIsNone(block.idom)
                continue
            strict = expected_dom[block.id] - {block.id}
            best = max(len(expected_dom[d]) for d in strict)
            self.assertIn(block.idom, strict)
            self.assertEqual(len(expected_dom[block.idom]), best)

        # Back edges: u -> v with v dominating u, over reachable blocks.
        expected_back = sorted(
            (u, v) for u, v in set(edges)
            if u in reachable and v in reachable and v in expected_dom[u]
        )
        self.assertEqual(cfg.back_edges, expected_back)
        self.assertEqual(cfg.loop_headers,
                         sorted({v for _, v in expected_back}))


class TestUnreachableBlocks(unittest.TestCase):
    """Acceptance B: unreachable blocks must not change reachable idoms."""

    def _diamond_program(self, with_dead_block):
        instructions = [
            {"offset": 0, "fallthrough": False, "targets": [4, 8]},   # cond
            {"offset": 4, "fallthrough": False, "targets": [12]},     # then
            {"offset": 8, "fallthrough": False, "targets": [12]},     # else
            {"offset": 12, "fallthrough": False, "targets": [], "op": "RET"},
        ]
        if with_dead_block:
            instructions.append(
                {"offset": 16, "fallthrough": False, "targets": [16]})  # dead
        return {"instructions": instructions}

    def test_unreachable_block_does_not_affect_reachable_idom(self):
        clean = build_cfg(self._diamond_program(False))
        with_dead = build_cfg(self._diamond_program(True))

        self.assertEqual(len(with_dead.blocks), 5)
        dead = with_dead.blocks[4]
        self.assertTrue(dead.unreachable)
        self.assertIsNone(dead.idom)

        clean_idom = {b.id: b.idom for b in clean.blocks}
        dead_idom = {b.id: b.idom for b in with_dead.blocks[:4]}
        self.assertEqual(clean_idom, dead_idom)
        clean_dom = {b.id: b.dom for b in clean.blocks}
        dead_dom = {b.id: b.dom for b in with_dead.blocks[:4]}
        self.assertEqual(clean_dom, dead_dom)


class TestIfElseJoin(unittest.TestCase):
    """Acceptance C: the join of an if/else has the condition block as idom."""

    def test_if_else_join_idom(self):
        program = {"instructions": [
            {"offset": 0, "fallthrough": False, "targets": [4, 8], "op": "JZ"},
            {"offset": 4, "fallthrough": False, "targets": [12], "op": "JMP"},
            {"offset": 8, "fallthrough": True, "targets": []},
            {"offset": 12, "fallthrough": False, "targets": [], "op": "RET"},
        ]}
        cfg = build_cfg(program)
        self.assertEqual(len(cfg.blocks), 4)
        by_id = {b.id: b for b in cfg.blocks}
        self.assertEqual(by_id[0].successors, [1, 2])
        self.assertEqual(by_id[1].successors, [3])
        self.assertEqual(by_id[2].successors, [3])
        self.assertEqual(by_id[3].idom, 0)
        self.assertEqual(by_id[1].idom, 0)
        self.assertEqual(by_id[2].idom, 0)
        self.assertIsNone(by_id[0].idom)
        self.assertEqual(cfg.back_edges, [])
        self.assertEqual(cfg.loop_headers, [])


class TestBackEdges(unittest.TestCase):
    """Acceptance D: self loops and cross-block back edges."""

    def test_self_loop(self):
        program = {"instructions": [
            {"offset": 0, "fallthrough": True, "targets": []},
            {"offset": 4, "fallthrough": False, "targets": [4], "op": "JNZ"},
            {"offset": 8, "fallthrough": False, "targets": [], "op": "RET"},
        ]}
        cfg = build_cfg(program)
        self.assertEqual(cfg.back_edges, [(1, 1)])
        self.assertEqual(cfg.loop_headers, [1])
        loop_block = cfg.blocks[1]
        self.assertIn(1, loop_block.dom)

    def test_cross_block_back_edge(self):
        # 0 -> 1 (header), 1 -> 2 (body) or 3 (exit), 2 -> 1 (back edge).
        program = {"instructions": [
            {"offset": 0, "fallthrough": False, "targets": [4], "op": "JMP"},
            {"offset": 4, "fallthrough": False, "targets": [8, 12], "op": "JZ"},
            {"offset": 8, "fallthrough": False, "targets": [4], "op": "JMP"},
            {"offset": 12, "fallthrough": False, "targets": [], "op": "RET"},
        ]}
        cfg = build_cfg(program)
        self.assertEqual(cfg.back_edges, [(2, 1)])
        self.assertEqual(cfg.loop_headers, [1])
        by_id = {b.id: b for b in cfg.blocks}
        self.assertEqual(by_id[1].idom, 0)
        self.assertEqual(by_id[2].idom, 1)
        self.assertEqual(by_id[3].idom, 1)

    def test_nested_loops(self):
        # 0 -> 1; 1 -> 2 / 4; 2 -> 3; 3 -> 2 (inner) and 3 -> 1 (outer); 4 halt.
        edges = [(0, 1), (1, 2), (1, 4), (2, 3), (3, 2), (3, 1)]
        cfg = build_cfg(program_from_graph(5, edges))
        self.assertEqual(cfg.back_edges, [(3, 1), (3, 2)])
        self.assertEqual(cfg.loop_headers, [1, 2])


class TestBlockSplitting(unittest.TestCase):
    def test_fallthrough_merges_into_one_block(self):
        program = {"instructions": [
            {"offset": 0, "fallthrough": True, "targets": []},
            {"offset": 4, "fallthrough": True, "targets": []},
            {"offset": 8, "fallthrough": False, "targets": [], "op": "RET"},
        ]}
        cfg = build_cfg(program)
        self.assertEqual(len(cfg.blocks), 1)
        self.assertEqual(cfg.blocks[0].offsets, [0, 4, 8])
        self.assertEqual(cfg.blocks[0].successors, [])

    def test_jump_successor_starts_new_block(self):
        # Instruction after a conditional jump is a leader even though the
        # jump also falls through.
        program = {"instructions": [
            {"offset": 0, "fallthrough": True, "targets": [8], "op": "JZ"},
            {"offset": 4, "fallthrough": True, "targets": []},
            {"offset": 8, "fallthrough": False, "targets": [], "op": "RET"},
        ]}
        cfg = build_cfg(program)
        self.assertEqual(len(cfg.blocks), 3)
        self.assertEqual(cfg.blocks[0].successors, [1, 2])
        self.assertEqual(cfg.blocks[1].successors, [2])

    def test_halt_then_code_starts_unreachable_block(self):
        program = {"instructions": [
            {"offset": 0, "fallthrough": False, "targets": [], "op": "HALT"},
            {"offset": 4, "fallthrough": False, "targets": [], "op": "RET"},
        ]}
        cfg = build_cfg(program)
        self.assertEqual(len(cfg.blocks), 2)
        self.assertFalse(cfg.blocks[0].unreachable)
        self.assertTrue(cfg.blocks[1].unreachable)

    def test_bare_list_and_defaults_accepted(self):
        cfg = build_cfg([{"offset": 0}, {"offset": 4, "fallthrough": False}])
        # fallthrough defaults to True, so both instructions merge into
        # a single block with no successors.
        self.assertEqual(len(cfg.blocks), 1)
        self.assertEqual(cfg.blocks[0].offsets, [0, 4])
        self.assertEqual(cfg.blocks[0].successors, [])


class TestErrors(unittest.TestCase):
    def test_empty_program(self):
        with self.assertRaises(CFGError):
            build_cfg({"instructions": []})
        with self.assertRaises(CFGError):
            build_cfg([])

    def test_duplicate_offset(self):
        program = {"instructions": [
            {"offset": 0, "fallthrough": False, "targets": []},
            {"offset": 0, "fallthrough": False, "targets": []},
        ]}
        with self.assertRaises(CFGError) as ctx:
            build_cfg(program)
        self.assertEqual(ctx.exception.offset, 0)
        self.assertIn("offset=0", str(ctx.exception))

    def test_bad_edge(self):
        program = {"instructions": [
            {"offset": 0, "fallthrough": False, "targets": [44]},
        ]}
        with self.assertRaises(CFGError) as ctx:
            build_cfg(program)
        self.assertEqual(ctx.exception.offset, 0)
        self.assertIn("44", str(ctx.exception))

    def test_bad_edge_in_later_instruction(self):
        program = {"instructions": [
            {"offset": 0, "fallthrough": True, "targets": []},
            {"offset": 4, "fallthrough": False, "targets": [99]},
        ]}
        with self.assertRaises(CFGError) as ctx:
            build_cfg(program)
        self.assertEqual(ctx.exception.offset, 4)

    def test_missing_offset(self):
        with self.assertRaises(CFGError):
            build_cfg({"instructions": [{"fallthrough": True}]})

    def test_not_a_program(self):
        with self.assertRaises(CFGError):
            build_cfg(42)


class TestCLI(unittest.TestCase):
    def run_cli(self, *args, cwd=None):
        return subprocess.run(
            [sys.executable, "-m", "cfgdom", *args],
            cwd=cwd or REPO_ROOT, capture_output=True, text=True)

    def test_success_writes_dom_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            prog = os.path.join(tmp, "prog.json")
            dom = os.path.join(tmp, "dom.json")
            with open(prog, "w") as fh:
                json.dump({"instructions": [
                    {"offset": 0, "fallthrough": False, "targets": [4, 8]},
                    {"offset": 4, "fallthrough": False, "targets": [12]},
                    {"offset": 8, "fallthrough": False, "targets": [12]},
                    {"offset": 12, "fallthrough": False, "targets": [],
                     "op": "RET"},
                ]}, fh)
            proc = self.run_cli(prog, "--emit", dom)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(dom) as fh:
                result = json.load(fh)
            self.assertEqual(result["blocks"][3]["idom"], 0)
            self.assertEqual(result["back_edges"], [])

    def assert_cfg_error(self, program_obj, needle):
        with tempfile.TemporaryDirectory() as tmp:
            prog = os.path.join(tmp, "prog.json")
            dom = os.path.join(tmp, "dom.json")
            with open(prog, "w") as fh:
                json.dump(program_obj, fh)
            proc = self.run_cli(prog, "--emit", dom)
            self.assertEqual(proc.returncode, 8, proc.stderr)
            self.assertIn("CFGError", proc.stderr)
            self.assertIn(needle, proc.stderr)
            self.assertFalse(os.path.exists(dom),
                             "dom.json must not be written on CFGError")

    def test_exit_8_on_bad_edge(self):
        self.assert_cfg_error(
            {"instructions": [{"offset": 0, "fallthrough": False,
                               "targets": [7]}]}, "offset=0")

    def test_exit_8_on_duplicate_offset(self):
        self.assert_cfg_error(
            {"instructions": [{"offset": 0}, {"offset": 0}]}, "offset=0")

    def test_exit_8_on_empty_program(self):
        self.assert_cfg_error({"instructions": []}, "empty program")

    def test_exit_8_on_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            prog = os.path.join(tmp, "prog.json")
            dom = os.path.join(tmp, "dom.json")
            with open(prog, "w") as fh:
                fh.write("{not json")
            proc = self.run_cli(prog, "--emit", dom)
            self.assertEqual(proc.returncode, 8)
            self.assertFalse(os.path.exists(dom))


if __name__ == "__main__":
    unittest.main()
