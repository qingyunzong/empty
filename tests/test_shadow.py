"""Acceptance D: randomized differential test.

The Engine (per-layer overlay) is compared against a shadow model that
keeps a full snapshot of the entire state per transaction layer -- the
simplest possible interpretation of the semantics.  Random operation
sequences must produce identical get() results, identical failures, and
identical committed base state in both models.
"""

import random
import unittest

from deptx import (
    DependencyCycleError,
    Engine,
    NoTransactionError,
    UnknownSavepointError,
)


class ShadowModel:
    """Reference model: every layer holds a complete deep snapshot."""

    def __init__(self):
        self.base_kv = {}
        self.base_edges = set()
        self.stack = []  # list of [kv, edges, savepoints(dict), sp_order(list)]

    def _top(self):
        if not self.stack:
            raise NoTransactionError("no active transaction")
        return self.stack[-1]

    def _view(self):
        if self.stack:
            kv, edges = self.stack[-1][0], self.stack[-1][1]
            return dict(kv), set(edges)
        return dict(self.base_kv), set(self.base_edges)

    def begin(self):
        kv, edges = self._view()
        self.stack.append([kv, edges, {}, []])

    def commit(self):
        kv, edges, _, _ = self._top()
        self.stack.pop()
        if self.stack:
            self.stack[-1][0] = kv
            self.stack[-1][1] = edges
        else:
            self.base_kv = kv
            self.base_edges = edges

    def rollback(self):
        self._top()
        self.stack.pop()

    def savepoint(self, name):
        top = self._top()
        if name not in top[2]:
            top[3].append(name)
        top[2][name] = (dict(top[0]), set(top[1]))

    def undo(self, name):
        top = self._top()
        if name not in top[2]:
            raise UnknownSavepointError(name)
        kv, edges = top[2][name]
        top[0] = dict(kv)
        top[1] = set(edges)
        idx = top[3].index(name)
        for later in top[3][idx + 1:]:
            del top[2][later]
        del top[3][idx + 1:]

    def set(self, key, value):
        self._top()[0][key] = value

    def get(self, key):
        kv, _ = self._view()
        return kv.get(key)

    def depend(self, source, target):
        top = self._top()
        _, edges = self._view()
        if source == target or _reaches(edges, target, source):
            raise DependencyCycleError("cycle")
        top[1].add((source, target))


def _reaches(edges, start, target):
    adjacency = {}
    for src, dst in edges:
        adjacency.setdefault(src, set()).add(dst)
    stack, seen = [start], {start}
    while stack:
        node = stack.pop()
        if node == target:
            return True
        for nxt in adjacency.get(node, ()):
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return False


KEYS = ["k1", "k2", "k3", "k4"]
NODES = ["a", "b", "c", "d", "e"]
SAVEPOINTS = ["s1", "s2"]


def random_op(rng, depth):
    ops = ["set", "depend", "get", "savepoint", "undo"]
    if depth < 4:
        ops += ["begin"] * 2
    if depth > 0:
        ops += ["commit", "commit", "rollback"]
    return rng.choice(ops)


def apply(model, op, rng):
    if op == "begin":
        model.begin()
        return ("ok", None)
    if op == "commit":
        model.commit()
        return ("ok", None)
    if op == "rollback":
        model.rollback()
        return ("ok", None)
    if op == "set":
        model.set(rng.choice(KEYS), f"v{rng.randrange(5)}")
        return ("ok", None)
    if op == "depend":
        model.depend(rng.choice(NODES), rng.choice(NODES))
        return ("ok", None)
    if op == "savepoint":
        model.savepoint(rng.choice(SAVEPOINTS))
        return ("ok", None)
    if op == "undo":
        model.undo(rng.choice(SAVEPOINTS))
        return ("ok", None)
    if op == "get":
        return ("value", model.get(rng.choice(KEYS)))
    raise AssertionError(op)


def apply_tagged(model, op, rng):
    try:
        return apply(model, op, rng)
    except (NoTransactionError, UnknownSavepointError, DependencyCycleError) as exc:
        return ("error", type(exc).__name__)


class TestShadowDifferential(unittest.TestCase):
    def test_random_sequences_match_shadow(self):
        for seed in range(300):
            rng = random.Random(seed)
            engine = Engine()
            shadow = ShadowModel()
            for step in range(150):
                op = random_op(rng, engine.depth)
                # use a fresh fork of the rng per model so both draw the
                # same arguments for this operation
                arg_rng_engine = random.Random(seed * 1_000_000 + step)
                arg_rng_shadow = random.Random(seed * 1_000_000 + step)
                got_engine = apply_tagged(engine, op, arg_rng_engine)
                got_shadow = apply_tagged(shadow, op, arg_rng_shadow)
                self.assertEqual(
                    got_engine,
                    got_shadow,
                    f"seed={seed} step={step} op={op}",
                )
                self.assertEqual(engine.depth, len(shadow.stack))
            self.assertEqual(engine.committed_state(), (shadow.base_kv, shadow.base_edges))


if __name__ == "__main__":
    unittest.main()
