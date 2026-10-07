"""Randomized batch-by-batch comparison against an independent
join-then-sort reference model, bounded to <=5 customers and <=12
transactions as required."""

import random
import unittest

from mvview import Engine
from model import check_engine_vs_model

CUSTOMERS = ["c0", "c1", "c2", "c3", "c4", None]  # 5 customers + NULL key
GROUPS = ["g0", "g1", "g2"]
MAX_TXN = 12


def random_value(rng):
    r = rng.random()
    if r < 0.2:
        return None
    if r < 0.6:
        return rng.randint(-20, 20)
    return f"{rng.randint(-40, 40)}/{rng.randint(1, 9)}"


def random_batch(rng, engine):
    batch = {}
    live_ids = sorted(engine.left, key=str)
    free_ids = [i for i in range(1, MAX_TXN + 1) if i not in engine.left]

    for _ in range(rng.randint(0, 3)):
        if not free_ids:
            break
        tid = rng.choice(free_ids)
        free_ids.remove(tid)
        batch.setdefault("left_insert", []).append(
            {"id": tid, "cid": rng.choice(CUSTOMERS), "value": random_value(rng)})

    for _ in range(rng.randint(0, 2)):
        if not live_ids:
            break
        tid = rng.choice(live_ids)
        live_ids.remove(tid)
        if rng.random() < 0.5:
            batch.setdefault("left_retract", []).append(tid)
        else:
            batch.setdefault("left_replace", []).append(
                {"id": tid, "cid": rng.choice(CUSTOMERS), "value": random_value(rng)})

    for _ in range(rng.randint(0, 2)):
        batch.setdefault("right_insert", []).append(
            {"cid": rng.choice(CUSTOMERS), "group": rng.choice(GROUPS),
             "count": rng.randint(1, 2)})

    remaining = dict(engine.right)  # multiplicity still available in this batch
    for _ in range(rng.randint(0, 2)):
        rows = [(cid, grp) for (cid, grp), m in remaining.items() if m > 0]
        if not rows:
            break
        cid, grp = rows[rng.randrange(len(rows))]
        count = rng.randint(1, remaining[(cid, grp)])
        remaining[(cid, grp)] -= count
        batch.setdefault("right_retract", []).append(
            {"cid": cid, "group": grp, "count": count})

    for _ in range(rng.randint(0, 2)):
        members = [(cid, grp) for (cid, grp), m in remaining.items()
                   if m > 0 and grp in GROUPS]
        if not members:
            break
        cid, src = members[rng.randrange(len(members))]
        dst = rng.choice([g for g in GROUPS if g != src])
        count = rng.randint(1, remaining[(cid, src)])
        remaining[(cid, src)] -= count
        batch.setdefault("migrate", []).append(
            {"cid": cid, "from": src, "to": dst, "count": count})

    return batch


class TestRandomizedModel(unittest.TestCase):
    def test_random_batches_match_model(self):
        for seed in (7, 1234, 20261008):
            rng = random.Random(seed)
            engine = Engine()
            for step in range(250):
                batch = random_batch(rng, engine)
                if batch:
                    engine.apply_batch(batch)
                check_engine_vs_model(self, engine)
            # drain everything: view must become empty
            remaining = sorted(engine.left, key=str)
            if remaining:
                engine.apply_batch({"left_retract": remaining})
            for (cid, grp), mult in list(engine.right.items()):
                engine.apply_batch(
                    {"right_retract": [{"cid": cid, "group": grp, "count": mult}]})
            self.assertEqual(engine.view(), {})
            self.assertEqual(engine.left, {})
            self.assertEqual(engine.right, {})
            self.assertEqual(engine.left_by_cid, {})
            self.assertEqual(engine.right_by_cid, {})

    def test_same_batch_two_table_churn(self):
        # focused: every batch touches both tables at once
        rng = random.Random(99)
        engine = Engine()
        for _ in range(150):
            batch = {}
            free = [i for i in range(1, MAX_TXN + 1) if i not in engine.left]
            if free:
                tid = rng.choice(free)
                batch["left_insert"] = [
                    {"id": tid, "cid": rng.choice(CUSTOMERS), "value": random_value(rng)}]
            live = sorted(engine.left, key=str)
            if live and rng.random() < 0.5:
                batch["left_retract"] = [rng.choice(live)]
            if rng.random() < 0.5:
                batch["right_insert"] = [
                    {"cid": rng.choice(CUSTOMERS), "group": rng.choice(GROUPS)}]
            rows = list(engine.right.items())
            if rows and rng.random() < 0.5:
                (cid, grp), _m = rng.choice(rows)
                batch["right_retract"] = [{"cid": cid, "group": grp}]
            if batch:
                engine.apply_batch(batch)
            check_engine_vs_model(self, engine)


if __name__ == "__main__":
    unittest.main()
