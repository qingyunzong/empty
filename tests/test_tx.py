import os
import random
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from txstore import Store, TxError, _reaches

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "txcli.py")


def run_cli(script):
    proc = subprocess.run(
        [sys.executable, CLI],
        input=script,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout.splitlines(), proc.stderr


class ShadowStore:
    """Independent full-snapshot reference model.

    Each layer keeps a complete copy of the visible view (values and
    edges) instead of deltas; used to cross-check Store.
    """

    def __init__(self):
        self._committed = {}
        self._committed_edges = set()
        self._stack = []  # [view dict, edges set, savepoints dict]

    def _require_tx(self):
        if not self._stack:
            raise TxError(11, "no active transaction")
        return self._stack[-1]

    def begin(self):
        if self._stack:
            view, edges, _ = self._stack[-1]
        else:
            view, edges = self._committed, self._committed_edges
        self._stack.append([dict(view), set(edges), {}])

    def set(self, key, value):
        self._require_tx()[0][key] = value

    def depend(self, a, b):
        layer = self._require_tx()
        if _reaches(layer[1], b, a):
            raise TxError(3, "dependency cycle")
        layer[1].add((a, b))

    def commit(self):
        view, edges, _ = self._require_tx()
        self._stack.pop()
        if self._stack:
            top = self._stack[-1]
            top[0] = view
            top[1] = edges
        else:
            self._committed = view
            self._committed_edges = edges

    def rollback(self):
        self._require_tx()
        self._stack.pop()

    def savepoint(self, name):
        layer = self._require_tx()
        if name in layer[2]:
            del layer[2][name]
        layer[2][name] = (dict(layer[0]), set(layer[1]))

    def undo(self, name):
        layer = self._require_tx()
        if name not in layer[2]:
            raise TxError(10, "unknown savepoint: %s" % name)
        view, edges = layer[2][name]
        layer[0] = dict(view)
        layer[1] = set(edges)
        names = list(layer[2])
        for later in names[names.index(name) + 1:]:
            del layer[2][later]

    def get(self, key):
        self._require_tx()
        return self._stack[-1][0].get(key)


class AcceptanceTests(unittest.TestCase):
    def test_a_nested_rollback_only_current_layer(self):
        s = Store()
        s.begin()
        s.set("a", "1")
        s.begin()
        s.set("b", "2")
        s.begin()
        s.set("c", "3")
        s.rollback()  # drop innermost layer only
        self.assertEqual(s.get("a"), "1")
        self.assertEqual(s.get("b"), "2")
        self.assertIsNone(s.get("c"))
        s.commit()  # merge b into outermost
        self.assertEqual(s.get("a"), "1")
        self.assertEqual(s.get("b"), "2")
        s.rollback()  # outermost rollback wipes everything
        with self.assertRaises(TxError):
            s.get("a")

    def test_a_inner_commit_not_resurrected_by_outer_rollback(self):
        s = Store()
        s.begin()
        s.set("x", "1")
        s.begin()
        s.set("y", "2")
        s.commit()    # y merges into outer layer
        s.rollback()  # must discard both x and y
        s.begin()
        self.assertIsNone(s.get("x"))
        self.assertIsNone(s.get("y"))

    def test_b_undo_removes_later_dependencies(self):
        s = Store()
        s.begin()
        s.depend("a", "b")
        s.savepoint("s")
        s.depend("b", "c")
        s.depend("c", "d")
        s.undo("s")
        # b->c and c->d are gone; a->b survives
        s.depend("d", "a")  # would be a cycle if c->d survived... it is fine now
        with self.assertRaises(TxError) as ctx:
            s.depend("b", "d")  # b->d with d->a->b is a cycle
        self.assertEqual(ctx.exception.code, 3)

    def test_b_savepoint_is_layer_local(self):
        s = Store()
        s.begin()
        s.savepoint("s")
        s.begin()
        with self.assertRaises(TxError) as ctx:
            s.undo("s")  # not visible in inner layer
        self.assertEqual(ctx.exception.code, 10)
        s.commit()  # inner savepoints/layer gone; outer savepoint s still gone?
        # outer layer's own savepoint "s" still exists in outer layer
        s.set("k", "v")
        s.undo("s")
        self.assertIsNone(s.get("k"))

    def test_c_cycle_failure_keeps_transaction(self):
        s = Store()
        s.begin()
        s.set("k", "v")
        s.depend("a", "b")
        with self.assertRaises(TxError) as ctx:
            s.depend("b", "a")
        self.assertEqual(ctx.exception.code, 3)
        # transaction still usable
        self.assertEqual(s.get("k"), "v")
        s.depend("b", "c")
        s.set("k2", "v2")
        s.commit()
        s.begin()
        self.assertEqual(s.get("k"), "v")
        self.assertEqual(s.get("k2"), "v2")
        with self.assertRaises(TxError):
            s.depend("c", "a")  # committed edge a->b->c still visible
        self.assertEqual(ctx.exception.code, 3)

    def test_commit_visibility_only_outermost(self):
        s = Store()
        s.begin()
        s.set("k", "outer")
        s.begin()
        s.set("k", "inner")
        s.commit()  # merges into outer layer
        self.assertEqual(s.get("k"), "inner")
        s.rollback()  # outer rollback: nothing was globally committed
        s.begin()
        self.assertIsNone(s.get("k"))

    def test_no_transaction_exit_11(self):
        s = Store()
        for op in (lambda: s.set("k", "v"), lambda: s.depend("a", "b"),
                   lambda: s.commit(), lambda: s.rollback(),
                   lambda: s.savepoint("s"), lambda: s.undo("s"),
                   lambda: s.get("k")):
            with self.assertRaises(TxError) as ctx:
                op()
            self.assertEqual(ctx.exception.code, 11)

    def test_unknown_savepoint_exit_10(self):
        s = Store()
        s.begin()
        with self.assertRaises(TxError) as ctx:
            s.undo("nope")
        self.assertEqual(ctx.exception.code, 10)

    def test_self_loop_is_cycle(self):
        s = Store()
        s.begin()
        with self.assertRaises(TxError) as ctx:
            s.depend("a", "a")
        self.assertEqual(ctx.exception.code, 3)


class CliTests(unittest.TestCase):
    def test_basic_script(self):
        code, out, _ = run_cli(
            "begin\nset a 1\nget a\nbegin\nset a 2\nget a\nrollback\nget a\ncommit\n"
        )
        self.assertEqual(code, 0)
        self.assertEqual(out, ["1", "2", "1"])

    def test_get_missing_prints_null(self):
        code, out, _ = run_cli("begin\nget missing\n")
        self.assertEqual(code, 0)
        self.assertEqual(out, ["NULL"])

    def test_cycle_exit_3(self):
        code, _, err = run_cli("begin\ndepend a b\ndepend b a\n")
        self.assertEqual(code, 3)
        self.assertIn("cycle", err)

    def test_unknown_savepoint_exit_10(self):
        code, _, _ = run_cli("begin\nundo ghost\n")
        self.assertEqual(code, 10)

    def test_no_transaction_exit_11(self):
        code, _, _ = run_cli("get k\n")
        self.assertEqual(code, 11)
        code, _, _ = run_cli("commit\n")
        self.assertEqual(code, 11)

    def test_cross_layer_savepoint_exit_10(self):
        code, _, _ = run_cli("begin\nsavepoint s\nbegin\nundo s\n")
        self.assertEqual(code, 10)


class RandomShadowTests(unittest.TestCase):
    KEYS = ["a", "b", "c", "d"]
    NAMES = ["s1", "s2", "s3"]

    def gen_ops(self, rng, n):
        ops = []
        for _ in range(n):
            r = rng.random()
            if r < 0.15:
                ops.append(("begin",))
            elif r < 0.35:
                ops.append(("set", rng.choice(self.KEYS), str(rng.randint(0, 9))))
            elif r < 0.50:
                ops.append(("depend", rng.choice(self.KEYS), rng.choice(self.KEYS)))
            elif r < 0.62:
                ops.append(("commit",))
            elif r < 0.72:
                ops.append(("rollback",))
            elif r < 0.80:
                ops.append(("savepoint", rng.choice(self.NAMES)))
            elif r < 0.90:
                ops.append(("undo", rng.choice(self.NAMES + ["ghost"])))
            else:
                ops.append(("get", rng.choice(self.KEYS)))
        return ops

    def run_ops(self, model, ops):
        results = []
        for op in ops:
            try:
                results.append(("ok", getattr(model, op[0])(*op[1:])))
            except TxError as exc:
                results.append(("err", exc.code))
        return results

    def test_d_random_sequences_match_shadow(self):
        for seed in range(60):
            rng = random.Random(seed)
            ops = self.gen_ops(rng, 300)
            got = self.run_ops(Store(), ops)
            want = self.run_ops(ShadowStore(), ops)
            self.assertEqual(got, want, "seed=%d" % seed)


if __name__ == "__main__":
    unittest.main()
