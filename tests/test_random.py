import random
import unittest

from secidx import Store
from reference import RefStore

EMAILS = ["a@x", "b@x", "c@x", "d@x", "e@x", "f@x"]
AGES = [18, 21, 25, 30, 33, 41, 55, 60]
PKS = ["u%d" % i for i in range(12)]


def make_pair():
    real = Store()
    real.create_index("by_email", "email", unique=True)
    real.create_index("by_age", "age", unique=False)
    ref = RefStore()
    ref.create_index("by_email", "email", unique=True)
    ref.create_index("by_age", "age", unique=False)
    return real, ref


def run_random(seed, steps=600):
    rng = random.Random(seed)
    real, ref = make_pair()
    open_txns = []       # labels of live txns
    txns = {"real": {}, "ref": {}}
    log = []

    def both(fn_real, fn_ref):
        """Run op on both; return comparable (ok, payload) pair."""
        try:
            r = ("ok", fn_real())
        except Exception as exc:
            r = ("err", getattr(exc, "code", type(exc).__name__))
        try:
            f = ("ok", fn_ref())
        except Exception as exc:
            f = ("err", getattr(exc, "code", type(exc).__name__))
        return r, f

    for i in range(steps):
        choice = rng.random()
        if not open_txns or choice < 0.15:
            label = "t%d" % i
            txns["real"][label] = real.begin()
            txns["ref"][label] = ref.begin()
            open_txns.append(label)
            continue
        label = rng.choice(open_txns)
        rt, ft = txns["real"][label], txns["ref"][label]
        if choice < 0.45:
            pk = rng.choice(PKS)
            fields = {"email": rng.choice(EMAILS), "age": rng.choice(AGES)}
            res = both(lambda: real.insert(rt, pk, fields),
                       lambda: ref.insert(ft, pk, fields))
            log.append(("insert", label, pk, fields, res))
        elif choice < 0.58:
            pk = rng.choice(PKS)
            fields = {"email": rng.choice(EMAILS), "age": rng.choice(AGES)}
            res = both(lambda: real.update(rt, pk, fields),
                       lambda: ref.update(ft, pk, fields))
            log.append(("update", label, pk, fields, res))
        elif choice < 0.68:
            pk = rng.choice(PKS)
            res = both(lambda: real.delete(rt, pk),
                       lambda: ref.delete(ft, pk))
            log.append(("delete", label, pk, res))
        elif choice < 0.82:
            res = both(lambda: real.commit(rt), lambda: ref.commit(ft))
            log.append(("commit", label, res))
            open_txns.remove(label)
        elif choice < 0.88:
            res = both(lambda: real.abort(rt), lambda: ref.abort(ft))
            log.append(("abort", label, res))
            open_txns.remove(label)
        elif choice < 0.96:
            key = rng.choice(EMAILS)
            res = both(
                lambda: [(r["pk"], r["fields"])
                         for r in real.find(rt, "by_email", key)],
                lambda: [(r["pk"], r["fields"])
                         for r in ref.find(ft, "by_email", key)])
            log.append(("find", label, key, res))
        else:
            lo, hi = sorted(rng.sample(AGES, 2))
            res = both(
                lambda: [(r["pk"], r["fields"])
                         for r in real.scan(rt, "by_age", lo, hi)],
                lambda: [(r["pk"], r["fields"])
                         for r in ref.scan(ft, "by_age", lo, hi)])
            log.append(("scan", label, lo, hi, res))
        last = log[-1][-1]
        if last[0] != last[1]:
            return log, ("diverge", i)
    return log, ("ok", real, ref)


class RandomDifferentialTest(unittest.TestCase):
    def test_random_ops_match_brute_force_reference(self):
        # acceptance (e): random workloads vs brute-force reference
        for seed in (1, 7, 42, 1337, 20261001):
            with self.subTest(seed=seed):
                log, result = run_random(seed)
                self.assertEqual(result[0], "ok",
                                 msg="seed=%d step=%r log tail=%r"
                                     % (seed, result[1:] if result[0] != "ok"
                                        else None, log[-5:]))
                _, real, ref = result
                # final committed state identical
                self.assertEqual(real.rows, ref.rows)
                # index invariant: indexes == rescan of committed rows
                for name, idx in real.indexes.items():
                    rebuilt = {}
                    for pk, fields in real.rows.items():
                        key = idx.key_of(fields)
                        if key is not None:
                            rebuilt.setdefault(key, set()).add(pk)
                    self.assertEqual(idx.map, rebuilt,
                                     "index %s diverged (seed=%d)" % (name, seed))


if __name__ == "__main__":
    unittest.main()
