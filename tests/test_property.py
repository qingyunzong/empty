"""Differential tests: enumerate small bag databases and short
transaction sequences, and check every published output and multiplicity
against the independent full-relation interpreter.
"""
import os
import random
import tempfile
import unittest

from bagra import (
    Cmp,
    Engine,
    And,
    distinct,
    evaluate,
    except_all,
    filter_,
    intersect_all,
    join,
    project,
    scan,
    union_all,
)

DOMAIN = [None, 0, 1]
TABLES = {"R": 2, "S": 2, "T": 3}  # table name -> arity


def gen_base(rng, arity):
    """A plan of exactly `arity` columns (or any arity if None) built
    from scans, projections, and joins."""
    if arity is None:
        table = rng.choice(list(TABLES))
        return scan(table), TABLES[table]
    widest = max(TABLES.values())
    if arity <= widest:
        wide = [t for t, a in TABLES.items() if a >= arity]
        table = rng.choice(wide)
        plan = scan(table)
        if TABLES[table] != arity:
            plan = project(plan, tuple(range(arity)))
        return plan, arity
    left_arity = rng.randint(1, arity - 1)
    left, _ = gen_base(rng, left_arity)
    right, _ = gen_base(rng, arity - left_arity)
    return join(left, right, [0], [0]), arity


def gen_plan(rng, depth, arity=None):
    """Generate a random plan; returns (plan, output_arity)."""
    plan, actual = _gen_plan(rng, depth)
    if arity is not None and actual != arity:
        if actual > arity:
            plan = project(plan, tuple(range(arity)))
        else:
            extra, _ = gen_base(rng, arity - actual)
            plan = join(plan, extra, [0], [0])
        actual = arity
    return plan, actual


def _gen_plan(rng, depth):
    if depth == 0:
        return gen_base(rng, None)
    op = rng.choice(["filter", "project", "join", "union_all",
                     "intersect_all", "except_all", "distinct"])
    if op == "filter":
        child, a = gen_plan(rng, depth - 1)
        pred = rng.choice([
            Cmp("eq", rng.randrange(a), rng.choice(DOMAIN)),
            Cmp("ne", rng.randrange(a), rng.choice(DOMAIN)),
            Cmp("is_null", rng.randrange(a)),
            Cmp("not_null", rng.randrange(a)),
            And((Cmp("ge", rng.randrange(a), rng.choice([0, 1])),
                 Cmp("le", rng.randrange(a), rng.choice([0, 1])))),
        ])
        return filter_(child, pred), a
    if op == "project":
        child, a = gen_plan(rng, depth - 1)
        k = rng.randint(1, min(2, a))
        cols = tuple(sorted(rng.sample(range(a), k)))
        return project(child, cols), k
    if op == "join":
        left, la = gen_plan(rng, depth - 1)
        right, ra = gen_plan(rng, depth - 1)
        return (join(left, right, [rng.randrange(la)], [rng.randrange(ra)]),
                la + ra)
    if op in ("union_all", "intersect_all", "except_all"):
        left, a = gen_plan(rng, depth - 1)
        right, _ = gen_plan(rng, depth - 1, a)
        node = {"union_all": union_all,
                "intersect_all": intersect_all,
                "except_all": except_all}[op]
        return node(left, right), a
    child, a = gen_plan(rng, depth - 1)
    return distinct(child), a


def random_row(rng, arity):
    return tuple(rng.choice(DOMAIN) for _ in range(arity))


def gen_batch(rng, tables):
    """A short transaction: inserts of fresh rows and deletes of
    committed rows, so committed multiplicities stay non-negative."""
    changes = []
    pending = {}
    for _ in range(rng.randint(1, 3)):
        table = rng.choice(list(TABLES))
        committed = list(tables.get(table, {}).items())
        if committed and rng.random() < 0.5:
            row, mult = rng.choice(committed)
            already = pending.get((table, row), 0)
            if already < mult:
                delta = rng.randint(1, mult - already)
                pending[(table, row)] = already + delta
                changes.append((table, row, -delta))
        else:
            changes.append((table, random_row(rng, TABLES[table]),
                            rng.randint(1, 2)))
    return changes


def fold(records):
    bag = {}
    for rec in records:
        row = tuple(rec["row"])
        bag[row] = bag.get(row, 0) + rec["delta"]
        if bag[row] == 0:
            del bag[row]
    return bag


class PropertyTest(unittest.TestCase):
    def run_trial(self, seed):
        rng = random.Random(seed)
        eng = Engine()

        # Three outputs, two of them sharing a large subexpression.
        shared, sa = gen_plan(rng, 2)
        keep = tuple(range(min(2, sa)))
        plans = {
            "shared_a": distinct(project(shared, keep)),
            "shared_b": except_all(project(shared, keep),
                                   project(shared, keep[:1] + keep[:0])),
            "random": gen_plan(rng, 3)[0],
        }
        accumulated = {}
        for sid, plan in plans.items():
            accumulated[sid] = fold(eng.add_subscription(sid, plan))

        def apply_and_fold(changes, batch_id):
            pubs = eng.apply_batch(changes, batch_id=batch_id)
            for rec in pubs:
                row = tuple(rec["row"])
                acc = accumulated[rec["subscription"]]
                acc[row] = acc.get(row, 0) + rec["delta"]
                if acc[row] == 0:
                    del acc[row]
            return pubs

        # Random initial contents, then a short transaction sequence.
        for table, arity in TABLES.items():
            init = [(table, random_row(rng, arity), rng.randint(1, 2))
                    for _ in range(rng.randint(0, 3))]
            apply_and_fold(init, ("init", table))

        state_path = None
        recovered_at = rng.randint(2, 5)
        with tempfile.TemporaryDirectory() as tmp:
            state_path = os.path.join(tmp, "state.json")
            for step in range(8):
                batch = gen_batch(rng, eng.tables)
                apply_and_fold(batch, ("txn", seed, step))

                # Every output, after every batch, equals the independent
                # full re-evaluation over the committed tables.
                for sid, plan in plans.items():
                    self.assertEqual(
                        accumulated[sid], evaluate(plan, eng.tables),
                        f"seed={seed} step={step} sid={sid}")

                if step == recovered_at:
                    # Crash and recover mid-sequence.
                    eng.save(state_path)
                    before_log = list(eng.publish_log)
                    eng = Engine.load(state_path)
                    self.assertEqual(eng.publish_log, before_log)
                    # Replaying the just-committed batch must not
                    # republish or change anything.
                    self.assertEqual(
                        eng.apply_batch(batch, batch_id=("txn", seed, step)),
                        [])
                    self.assertEqual(eng.publish_log, before_log)

        # Publish records carry strictly ordered versions per output.
        for sid in plans:
            versions = [r["version"] for r in eng.publish_log
                        if r["subscription"] == sid]
            self.assertEqual(versions, sorted(versions))

    def test_differential_against_interpreter(self):
        for seed in range(100):
            with self.subTest(seed=seed):
                self.run_trial(seed)


if __name__ == "__main__":
    unittest.main()
