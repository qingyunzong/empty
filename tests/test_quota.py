"""Acceptance tests for the quota transaction engine.

A: 3-level tree, add over limit -> output state bytes identical to input.
B: multi-op tx, 3rd op (index 2) sub goes negative -> first_error_index == 2,
   full rollback.
C: unbounded (null limit) ancestor does not relax a bounded child.
D: random trees (depth <= 4) and txs (ops <= 8) cross-checked against an
   independent recursive-copy reference implementation.
E: re-applying the same successful tx is NOT idempotent and must fail loudly.
Plus: validation errors (non-integer amount, cyclic path, missing root)
exit with code 2.
"""

import copy
import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from quota.core import apply_tx

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_cli(tx, state):
    """Run `python -m quota apply` in a temp dir. Returns (rc, stdout, stderr,
    out_bytes)."""
    tmp = tempfile.TemporaryDirectory()
    paths = {
        name: Path(tmp.name) / f"{name}.json" for name in ("tx", "state", "out")
    }
    if isinstance(state, (bytes, str)):
        paths["state"].write_bytes(
            state if isinstance(state, bytes) else state.encode()
        )
    else:
        paths["state"].write_text(json.dumps(state))
    if isinstance(tx, (bytes, str)):
        paths["tx"].write_bytes(tx if isinstance(tx, bytes) else tx.encode())
    else:
        paths["tx"].write_text(json.dumps(tx))
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "quota",
            "apply",
            str(paths["tx"]),
            "--state",
            str(paths["state"]),
            "--out",
            str(paths["out"]),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    out_bytes = paths["out"].read_bytes() if paths["out"].exists() else None
    state_bytes = paths["state"].read_bytes()
    tmp.cleanup()
    return proc.returncode, proc.stdout, proc.stderr, out_bytes, state_bytes


def three_level_state():
    return {
        "id": "root",
        "limit": 100,
        "used": 10,
        "children": [
            {
                "id": "mid",
                "limit": 50,
                "used": 5,
                "children": [
                    {"id": "leaf", "limit": 20, "used": 2, "children": []}
                ],
            }
        ],
    }


class TestA_AddOverLimitRollback(unittest.TestCase):
    def test_add_over_limit_state_bytes_identical(self):
        state = three_level_state()
        tx = {"ops": [{"op": "add", "path": ["root", "mid", "leaf"], "amount": 19}]}
        rc, _out, err, out_bytes, state_bytes = run_cli(tx, state)
        self.assertEqual(rc, 1)
        self.assertEqual(out_bytes, state_bytes)  # byte-identical rollback
        payload = json.loads(err)
        self.assertEqual(payload["first_error_index"], 0)

    def test_descendants_unchanged_on_add(self):
        state = three_level_state()
        tx = {"ops": [{"op": "add", "path": ["root", "mid"], "amount": 10}]}
        new_state, err_idx, _ = apply_tx(state, tx)
        self.assertIsNone(err_idx)
        self.assertEqual(new_state["used"], 20)
        self.assertEqual(new_state["children"][0]["used"], 15)
        # leaf is a descendant of the path tail: untouched
        self.assertEqual(new_state["children"][0]["children"][0]["used"], 2)


class TestB_MultiOpAtomicity(unittest.TestCase):
    def test_third_op_negative_sub_rolls_back(self):
        state = three_level_state()
        tx = {
            "ops": [
                {"op": "add", "path": ["root"], "amount": 5},
                {"op": "add", "path": ["root", "mid"], "amount": 5},
                {"op": "sub", "path": ["root", "mid", "leaf"], "amount": 99},
            ]
        }
        rc, _out, err, out_bytes, state_bytes = run_cli(tx, state)
        self.assertEqual(rc, 1)
        payload = json.loads(err)
        self.assertEqual(payload["first_error_index"], 2)
        self.assertEqual(out_bytes, state_bytes)  # ops 0 and 1 rolled back


class TestC_UnboundedAncestor(unittest.TestCase):
    def test_null_limit_ancestor_bounded_child(self):
        state = {
            "id": "root",
            "limit": None,
            "used": 0,
            "children": [
                {"id": "child", "limit": 10, "used": 8, "children": []}
            ],
        }
        # root is unbounded, but child caps at 10: 8 + 5 > 10 must fail
        tx = {"ops": [{"op": "add", "path": ["root", "child"], "amount": 5}]}
        new_state, err_idx, msg = apply_tx(state, tx)
        self.assertEqual(err_idx, 0)
        self.assertIsNone(new_state)
        self.assertIn("exceed limit", msg)
        # ...while a smaller amount succeeds on both
        tx_ok = {"ops": [{"op": "add", "path": ["root", "child"], "amount": 2}]}
        new_state, err_idx, _ = apply_tx(state, tx_ok)
        self.assertIsNone(err_idx)
        self.assertEqual(new_state["used"], 2)
        self.assertEqual(new_state["children"][0]["used"], 10)


# --- D: independent recursive-copy reference implementation -----------------


def ref_apply_tx(state, tx):
    """Reference: rebuilds the whole tree recursively for each op.

    Only nodes whose id-prefix lies on the op path have `used` adjusted;
    everything else is copied verbatim. Returns (state, error_index) on
    the first failing op, else (new_state, None).
    """

    def walk(node, path_prefix, op):
        used = node["used"]
        if op["path"][: len(path_prefix)] == path_prefix:
            if op["op"] == "add":
                if node["limit"] is not None and used + op["amount"] > node["limit"]:
                    raise _RefFail
                used += op["amount"]
            else:
                if used - op["amount"] < 0:
                    raise _RefFail
                used -= op["amount"]
        return {
            "id": node["id"],
            "limit": node["limit"],
            "used": used,
            "children": [
                walk(child, path_prefix + [child["id"]], op)
                for child in node["children"]
            ],
        }

    current = copy.deepcopy(state)
    for index, op in enumerate(tx["ops"]):
        if not _path_ok(current, op):
            return state, index
        try:
            current = walk(current, [current["id"]], op)
        except _RefFail:
            return state, index
    return current, None


class _RefFail(Exception):
    pass


def _path_ok(state, op):
    node = state
    if op["path"][0] != node["id"]:
        return False
    for node_id in op["path"][1:]:
        node = next((c for c in node["children"] if c["id"] == node_id), None)
        if node is None:
            return False
    return True


def random_tree(rng, depth, max_depth, prefix="n"):
    node_id = f"{prefix}{rng.randrange(10**6)}"
    limit = rng.choice([None, rng.randrange(0, 60)])
    used = 0 if limit is None else rng.randrange(0, limit + 1)
    children = []
    if depth < max_depth:
        for _ in range(rng.randrange(0, 3)):
            children.append(random_tree(rng, depth + 1, max_depth, prefix))
    # Ensure sibling ids are unique.
    seen = set()
    for child in children:
        while child["id"] in seen:
            child["id"] += "x"
        seen.add(child["id"])
    return {"id": node_id, "limit": limit, "used": used, "children": children}


def all_paths(node, prefix=()):
    prefix = prefix + (node["id"],)
    yield list(prefix)
    for child in node["children"]:
        yield from all_paths(child, prefix)


def random_tx(rng, state):
    paths = list(all_paths(state))
    ops = []
    for _ in range(rng.randrange(1, 9)):  # ops <= 8
        path = list(rng.choice(paths))
        if rng.random() < 0.15:  # sometimes a broken path
            path = path + ["no-such-node"]
        ops.append(
            {
                "op": rng.choice(["add", "sub"]),
                "path": path,
                "amount": rng.randrange(0, 25),
            }
        )
    return {"ops": ops}


def collect_used(node, acc, prefix=()):
    prefix = prefix + (node["id"],)
    acc[prefix] = node["used"]
    for child in node["children"]:
        collect_used(child, acc, prefix)


class TestD_RandomCrossCheck(unittest.TestCase):
    def test_random_against_reference(self):
        rng = random.Random(20261001)
        for case in range(300):
            state = random_tree(rng, 0, 4)  # depth <= 4
            tx = random_tx(rng, state)
            got_state, got_idx, _ = apply_tx(state, tx)
            ref_state, ref_idx = ref_apply_tx(state, tx)
            self.assertEqual(
                got_idx, ref_idx, f"case {case}: error index mismatch"
            )
            if got_idx is None:
                got_used, ref_used = {}, {}
                collect_used(got_state, got_used)
                collect_used(ref_state, ref_used)
                self.assertEqual(
                    got_used, ref_used, f"case {case}: final used mismatch"
                )
            else:
                # Rolled back: original state untouched.
                self.assertIsNone(got_state)


class TestE_ReapplyNotIdempotent(unittest.TestCase):
    def test_reapply_same_tx_fails_loudly(self):
        state = three_level_state()
        # Fill leaf exactly to its limit (2 + 18 = 20).
        tx = {"ops": [{"op": "add", "path": ["root", "mid", "leaf"], "amount": 18}]}
        first, err_idx, _ = apply_tx(state, tx)
        self.assertIsNone(err_idx)
        # Re-applying the same tx must NOT silently succeed.
        second, err_idx, msg = apply_tx(first, tx)
        self.assertIsNone(second)
        self.assertEqual(err_idx, 0)
        self.assertIn("exceed limit", msg)
        # And via the CLI: exit code 1, state bytes preserved.
        rc, _out, err, out_bytes, _ = run_cli(tx, first)
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(err)["first_error_index"], 0)
        self.assertEqual(json.loads(out_bytes), first)


class TestValidationExitCode2(unittest.TestCase):
    def test_non_integer_amount(self):
        for bad in (1.5, "5", True, None):
            tx = {"ops": [{"op": "add", "path": ["root"], "amount": bad}]}
            rc, _out, err, out_bytes, _ = run_cli(tx, three_level_state())
            self.assertEqual(rc, 2, f"amount={bad!r}")
            self.assertIn("amount", err)
            self.assertIsNone(out_bytes)

    def test_cyclic_path(self):
        tx = {"ops": [{"op": "add", "path": ["root", "mid", "root"], "amount": 1}]}
        rc, _out, err, out_bytes, _ = run_cli(tx, three_level_state())
        self.assertEqual(rc, 2)
        self.assertIn("cyclic", err)
        self.assertIsNone(out_bytes)

    def test_missing_root(self):
        for bad_state in ("null", "{}", "[]", '"just a string"'):
            tx = {"ops": [{"op": "add", "path": ["root"], "amount": 1}]}
            rc, _out, err, out_bytes, _ = run_cli(tx, bad_state)
            self.assertEqual(rc, 2, f"state={bad_state}")
            self.assertIsNone(out_bytes)

    def test_unknown_path_is_op_error_not_crash(self):
        tx = {"ops": [{"op": "add", "path": ["root", "ghost"], "amount": 1}]}
        rc, _out, err, out_bytes, state_bytes = run_cli(tx, three_level_state())
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(err)["first_error_index"], 0)
        self.assertEqual(out_bytes, state_bytes)


if __name__ == "__main__":
    unittest.main()
