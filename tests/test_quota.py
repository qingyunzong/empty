"""Tests for the quota package. Run: python -m unittest discover -s tests -v"""

import copy
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from quota.core import TxError, apply_tx, validate_state, validate_tx


# ---------------------------------------------------------------------------
# Independent reference implementation (recursive, copy-on-write).
# Written separately from quota.core so test D is a genuine cross-check.
# ---------------------------------------------------------------------------

class RefFail(Exception):
    pass


def ref_apply_op(node, path, op_kind, amount):
    """Return a new subtree with the op applied, or raise RefFail."""
    if node["id"] != path[0]:
        raise RefFail("path not found")
    children = [dict(c) for c in node["children"]]
    if len(path) > 1:
        for i, child in enumerate(children):
            if child["id"] == path[1]:
                children[i] = ref_apply_op(child, path[1:], op_kind, amount)
                break
        else:
            raise RefFail("path not found")
    new_node = dict(node, children=children)
    if op_kind == "add":
        if new_node["limit"] is not None and \
                new_node["used"] + amount > new_node["limit"]:
            raise RefFail("limit exceeded")
        new_node["used"] += amount
    else:
        if new_node["used"] - amount < 0:
            raise RefFail("negative used")
        new_node["used"] -= amount
    return new_node


def ref_apply_tx(state, tx):
    current = copy.deepcopy(state)
    for index, op in enumerate(tx["ops"]):
        try:
            current = ref_apply_op(current, op["path"], op["op"], op["amount"])
        except RefFail:
            return copy.deepcopy(state), index
    return current, None


def used_map(node, prefix=()):
    """Flatten a tree into {path_tuple: used}."""
    here = prefix + (node["id"],)
    out = {here: node["used"]}
    for child in node["children"]:
        out.update(used_map(child, here))
    return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def tree():
    """Three-layer tree used by acceptance case A."""
    return {
        "id": "root", "limit": 100, "used": 10, "children": [
            {"id": "a", "limit": 40, "used": 5, "children": [
                {"id": "a1", "limit": 10, "used": 0, "children": []},
                {"id": "a2", "limit": None, "used": 3, "children": []},
            ]},
            {"id": "b", "limit": None, "used": 0, "children": [
                {"id": "b1", "limit": 8, "used": 8, "children": []},
            ]},
        ],
    }


def tx(*ops):
    return {"ops": [dict(op=k, path=p, amount=n) for k, p, n in ops]}


class CoreSemanticsTest(unittest.TestCase):

    def test_a_add_exceeds_limit_rolls_back(self):
        state = tree()
        before = copy.deepcopy(state)
        # a1 has limit 10, used 0; adding 11 violates a1 itself.
        result, err = apply_tx(state, tx(("add", ["root", "a", "a1"], 11)))
        self.assertEqual(err, 0)
        self.assertEqual(result, before)
        self.assertIs(result, state)  # untouched original object

    def test_ancestor_limit_violation_rolls_back(self):
        state = tree()
        before = copy.deepcopy(state)
        # a has limit 40, used 5; adding 36 fits a1 (limit None via a2)
        # but breaks ancestor a.
        result, err = apply_tx(state, tx(("add", ["root", "a", "a2"], 36)))
        self.assertEqual(err, 0)
        self.assertEqual(result, before)

    def test_b_multi_op_third_sub_negative(self):
        state = tree()
        before = copy.deepcopy(state)
        t = tx(
            ("add", ["root", "a", "a1"], 5),      # ok
            ("sub", ["root", "a"], 3),            # ok: a.used 5+... fine
            ("sub", ["root", "a", "a1"], 99),     # fails: a1.used=5 < 99
            ("add", ["root"], 1),                 # never reached
        )
        result, err = apply_tx(state, t)
        self.assertEqual(err, 2)
        self.assertEqual(result, before)

    def test_c_null_limit_ancestor_finite_child_still_capped(self):
        state = tree()
        before = copy.deepcopy(state)
        # b has limit None (infinite) but b1 has limit 8, used 8.
        result, err = apply_tx(state, tx(("add", ["root", "b", "b1"], 1)))
        self.assertEqual(err, 0)
        self.assertEqual(result, before)
        # ...while adding under the infinite node itself is fine
        # (root limit is 100 with used 10, so 50 fits).
        result, err = apply_tx(state, tx(("add", ["root", "b"], 50)))
        self.assertIsNone(err)
        self.assertEqual(result["children"][1]["used"], 50)

    def test_sub_success_path_only(self):
        state = tree()
        result, err = apply_tx(state, tx(("sub", ["root", "a", "a2"], 2)))
        self.assertIsNone(err)
        self.assertEqual(result["used"], 8)                       # root 10-2
        self.assertEqual(result["children"][0]["used"], 3)        # a 5-2
        self.assertEqual(result["children"][0]["children"][1]["used"], 1)
        # Untouched branches keep their used values.
        self.assertEqual(result["children"][0]["children"][0]["used"], 0)
        self.assertEqual(result["children"][1]["used"], 0)

    def test_e_reapply_same_tx_is_not_idempotent(self):
        state = tree()
        t = tx(("add", ["root", "a", "a1"], 10))  # exactly fills a1 (limit 10)
        state2, err = apply_tx(state, t)
        self.assertIsNone(err)
        _, err2 = apply_tx(state2, t)
        self.assertEqual(err2, 0)  # second apply must fail, not silently pass

    def test_path_not_found_is_op_failure(self):
        state = tree()
        before = copy.deepcopy(state)
        result, err = apply_tx(state, tx(("add", ["root", "nope"], 1)))
        self.assertEqual(err, 0)
        self.assertEqual(result, before)
        result, err = apply_tx(state, tx(("add", ["wrongroot"], 1)))
        self.assertEqual(err, 0)
        self.assertEqual(result, before)

    def test_first_error_index_counts_from_zero(self):
        state = tree()
        t = tx(
            ("add", ["root"], 1),
            ("add", ["root"], 1),
            ("add", ["root", "b", "b1"], 100),
        )
        _, err = apply_tx(state, t)
        self.assertEqual(err, 2)


class ValidationTest(unittest.TestCase):

    def test_amount_not_integer(self):
        with self.assertRaises(TxError):
            validate_tx(tx(("add", ["root"], 1.5)))
        with self.assertRaises(TxError):
            validate_tx(tx(("add", ["root"], "3")))
        with self.assertRaises(TxError):
            validate_tx(tx(("add", ["root"], True)))

    def test_cyclic_path(self):
        with self.assertRaises(TxError):
            validate_tx(tx(("add", ["root", "a", "root"], 1)))

    def test_root_missing(self):
        with self.assertRaises(TxError):
            validate_state({})
        with self.assertRaises(TxError):
            validate_state({"children": []})
        with self.assertRaises(TxError):
            validate_state(["not", "a", "node"])

    def test_bad_op_and_empty_path(self):
        with self.assertRaises(TxError):
            validate_tx({"ops": [{"op": "mul", "path": ["r"], "amount": 1}]})
        with self.assertRaises(TxError):
            validate_tx(tx(("add", [], 1)))

    def test_valid_state_and_tx_pass(self):
        validate_state(tree())
        validate_tx(tx(("add", ["root", "a"], 3), ("sub", ["root"], 0)))


class RandomCrossCheckTest(unittest.TestCase):
    """Acceptance D: random trees (depth<=4) and txs (ops<=8) checked
    against the independent recursive reference implementation."""

    def random_tree(self, rng, depth):
        limit = rng.choice([None] + [rng.randint(0, 40) for _ in range(3)])
        used = rng.randint(0, 20) if limit is None else rng.randint(0, limit)
        node = {
            "id": f"n{self._next_id}",
            "limit": limit,
            "used": used,
            "children": [],
        }
        self._next_id += 1
        if depth < 4:
            for _ in range(rng.randint(0, 3)):
                node["children"].append(self.random_tree(rng, depth + 1))
        return node

    def all_paths(self, node, prefix=()):
        here = prefix + (node["id"],)
        paths = [here]
        for child in node["children"]:
            paths.extend(self.all_paths(child, here))
        return paths

    def test_random_against_reference(self):
        for seed in range(300):
            rng = random.Random(seed)
            self._next_id = 0
            state = self.random_tree(rng, 1)
            paths = self.all_paths(state)
            ops = []
            for _ in range(rng.randint(1, 8)):
                if rng.random() < 0.15:  # sometimes an invalid path
                    path = [f"bogus{rng.randint(0, 5)}"]
                else:
                    path = list(rng.choice(paths))
                ops.append({
                    "op": rng.choice(["add", "sub"]),
                    "path": path,
                    "amount": rng.randint(0, 30),
                })
            t = {"ops": ops}
            validate_state(state)
            validate_tx(t)
            got_state, got_err = apply_tx(state, t)
            ref_state, ref_err = ref_apply_tx(state, t)
            self.assertEqual(got_err, ref_err, f"seed={seed}")
            self.assertEqual(used_map(got_state), used_map(ref_state),
                             f"seed={seed}")
            if got_err is not None:
                self.assertEqual(got_state, state, f"seed={seed}")


class CliTest(unittest.TestCase):

    def run_cli(self, tx_obj, state_obj, state_raw=None):
        tmp = tempfile.mkdtemp()
        tx_path = os.path.join(tmp, "tx.json")
        state_path = os.path.join(tmp, "state.json")
        out_path = os.path.join(tmp, "out.json")
        with open(tx_path, "w") as fh:
            json.dump(tx_obj, fh)
        raw = state_raw if state_raw is not None else json.dumps(state_obj)
        with open(state_path, "w") as fh:
            fh.write(raw)
        proc = subprocess.run(
            [sys.executable, "-m", "quota", "apply", tx_path,
             "--state", state_path, "--out", out_path],
            capture_output=True, text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        out_bytes = None
        if os.path.exists(out_path):
            with open(out_path, "rb") as fh:
                out_bytes = fh.read()
        return proc, out_bytes

    def test_cli_success_exit_0(self):
        proc, out = self.run_cli(tx(("add", ["root", "a", "a1"], 4)), tree())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        new_state = json.loads(out)
        self.assertEqual(new_state["children"][0]["children"][0]["used"], 4)

    def test_cli_failure_exit_1_and_byte_identical_state(self):
        state = tree()
        raw = json.dumps(state, indent=3, sort_keys=True)  # unusual formatting
        proc, out = self.run_cli(
            tx(("add", ["root"], 1), ("sub", ["root", "a", "a1"], 50)),
            state, state_raw=raw)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(out, raw.encode())  # acceptance A: bytes identical
        payload = json.loads(proc.stderr)
        self.assertEqual(payload["first_error_index"], 1)

    def test_cli_validation_errors_exit_2(self):
        bad_amount = {"ops": [{"op": "add", "path": ["root"], "amount": 1.2}]}
        proc, _ = self.run_cli(bad_amount, tree())
        self.assertEqual(proc.returncode, 2)
        cyclic = {"ops": [{"op": "add", "path": ["r", "r"], "amount": 1}]}
        proc, _ = self.run_cli(cyclic, tree())
        self.assertEqual(proc.returncode, 2)
        proc, _ = self.run_cli(tx(("add", ["root"], 1)), {"children": []})
        self.assertEqual(proc.returncode, 2)

    def test_cli_missing_state_file_exit_2(self):
        tmp = tempfile.mkdtemp()
        tx_path = os.path.join(tmp, "tx.json")
        with open(tx_path, "w") as fh:
            json.dump(tx(("add", ["root"], 1)), fh)
        proc = subprocess.run(
            [sys.executable, "-m", "quota", "apply", tx_path,
             "--state", os.path.join(tmp, "absent.json"),
             "--out", os.path.join(tmp, "out.json")],
            capture_output=True, text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
