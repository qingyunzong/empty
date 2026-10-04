"""Exhaustive enumeration (n <= 9) against an independent brute-force reference."""

import itertools
import random
import unittest

from asofjoin import Dim, Fact, join


def reference_join(facts, dims, tol):
    """Brute-force reference: direct transcription of the spec."""
    # Dimension arrivals: later arrival overrides only with strictly higher ts.
    live = {}  # did -> (key, ts, attr)
    dwm = None
    for d in dims:
        dwm = d.ts if dwm is None else max(dwm, d.ts)
        prev = live.get(d.did)
        if prev is None or d.ts > prev[1]:
            live[d.did] = (d.key, d.ts, d.attr)

    out = []
    fwm = None
    for f in facts:
        if fwm is not None and f.ts < fwm:
            continue
        fwm = f.ts if fwm is None else max(fwm, f.ts)
        if dwm is None or dwm <= f.ts - tol:
            continue
        usable = [d for d in live.values() if d[0] == f.key and d[1] <= f.ts]
        fresh = [d for d in usable if f.ts - d[1] <= tol]
        if fresh:
            best_ts = max(d[1] for d in fresh)
            tied = sorted(d for d in fresh if d[1] == best_ts)  # by did via live key
            # recover did: live maps did->record; find smallest did among ties
            best_did = min(did for did, rec in live.items()
                           if rec[0] == f.key and rec[1] == best_ts
                           and f.ts - rec[1] <= tol)
            attr = live[best_did][2]
            out.append((f.fid, f.ts, best_did, attr, None))
        else:
            reason = "stale" if usable else "no_dim"
            out.append((f.fid, f.ts, None, None, reason))
    out.sort(key=lambda r: (r[1], r[0]))
    return out


def actual_join(facts, dims, tol):
    return [(r.fid, r.ts, r.did, r.attr, r.reason)
            for r in join(facts, dims, tol)]


DID_POOL = ["d1", "d2", "d3"]
KEY_POOL = ["k1", "k2"]
TS_POOL = [0, 1, 2]
ATTR_POOL = ["A", "B"]

ALL_DIMS = [Dim(did=d, key=k, ts=t, attr=a)
            for d in DID_POOL for k in KEY_POOL for t in TS_POOL for a in ATTR_POOL]
ALL_FACTS = [Fact(fid=f, key=k, ts=t)
             for f in ["f1", "f2"] for k in KEY_POOL for t in TS_POOL]


class TestExhaustiveSmall(unittest.TestCase):
    def test_all_sequences_up_to_len2(self):
        # 36 dims, 12 facts: 1 + 36 + 36^2 = 1333 dim seqs, 1 + 12 + 12^2 = 157 fact seqs
        dim_seqs = [()] + [(d,) for d in ALL_DIMS] + list(itertools.product(ALL_DIMS, repeat=2))
        fact_seqs = [()] + [(f,) for f in ALL_FACTS] + list(itertools.product(ALL_FACTS, repeat=2))
        cases = 0
        for tol in (0, 1, 2):
            for ds in dim_seqs:
                for fs in fact_seqs:
                    self.assertEqual(actual_join(fs, ds, tol), reference_join(fs, ds, tol),
                                     f"tol={tol} dims={ds} facts={fs}")
                    cases += 1
        self.assertGreater(cases, 500_000)


class TestRandomized(unittest.TestCase):
    def test_random_cases_up_to_9_records(self):
        rng = random.Random(20261004)
        dids = ["d1", "d2", "d3", "d4"]
        keys = ["k1", "k2", "k3"]
        for trial in range(3000):
            n_dims = rng.randint(0, 9)
            n_facts = rng.randint(0, 9)
            ds = [Dim(did=rng.choice(dids), key=rng.choice(keys),
                      ts=rng.randint(0, 12), attr=f"a{rng.randint(0, 3)}")
                  for _ in range(n_dims)]
            fs = [Fact(fid=f"f{i}", key=rng.choice(keys), ts=rng.randint(0, 12))
                  for i in range(n_facts)]
            tol = rng.choice([0, 1, 2, 5, 20])
            self.assertEqual(actual_join(fs, ds, tol), reference_join(fs, ds, tol),
                             f"trial={trial} tol={tol} dims={ds} facts={fs}")


if __name__ == "__main__":
    unittest.main()
