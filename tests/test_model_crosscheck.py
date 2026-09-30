"""Operation-by-operation cross-check of the persistent interval tree
against the independent finite-coordinate scanline model."""
import random
import unittest
from fractions import Fraction

from intervalmap import IntervalMap, Workspace, check_canonical, verify_threshold
from intervalmap.model import ScanlineModel


def norm(segments):
    return [(lo, hi, dict(sorted(src.items()))) for lo, hi, src in segments]


class TestRandomizedCrossCheck(unittest.TestCase):
    def run_sequence(self, seed, steps=300):
        rng = random.Random(seed)
        ws = Workspace()
        model = ScanlineModel()
        sources = ["s1", "s2", "s3", "s4"]
        snapshots = {}
        tx_models = []

        def rand_bound():
            return Fraction(rng.randint(-20, 20), rng.choice([1, 1, 2, 3, 4]))

        for step in range(steps):
            action = rng.randrange(10)
            if action < 4:
                lo, hi = sorted([rand_bound(), rand_bound()])
                src = rng.choice(sources)
                count = rng.choice([1, 1, 2])
                ws.add(lo, hi, src, count)
                model.add(lo, hi, src, count)
            elif action < 6:
                src = rng.choice(sources)
                count = rng.choice([None, None, 1])
                ws.revoke(src, count)
                model.revoke(src, count)
            elif action < 8:
                # binary op against a random small map
                other = IntervalMap()
                other_model = ScanlineModel()
                for _ in range(rng.randint(1, 3)):
                    lo, hi = sorted([rand_bound(), rand_bound()])
                    src = rng.choice(sources)
                    other = other.add(lo, hi, src)
                    other_model.add(lo, hi, src)
                op = rng.choice(["union", "intersection", "difference"])
                getattr(ws, op)(other)
                model = getattr(model, op)(other_model)
            elif action == 8:
                if ws.transaction_depth == 0 or rng.random() < 0.4:
                    ws.begin()
                    tx_models.append(ScanlineModel(list(model.atoms)))
                elif rng.random() < 0.5:
                    ws.rollback()
                    model = tx_models.pop()
                else:
                    ws.commit()
                    tx_models.pop()
            else:
                name = rng.choice(["a", "b", "c"])
                if rng.random() < 0.5 or name not in snapshots:
                    ws.snapshot(name)
                    snapshots[name] = ScanlineModel(list(model.atoms))
                else:
                    ws.restore(name)
                    model = ScanlineModel(list(snapshots[name].atoms))

            # per-operation comparison
            got = norm(ws.current.segments())
            want = norm(model.atoms)
            self.assertEqual(got, want, f"seed={seed} step={step}")
            self.assertEqual(ws.current.total_length, model.total_length)
            self.assertEqual(check_canonical(ws.current), [])
            for k in (1, 2, 3):
                res = ws.current.covered_by_at_least(k)
                self.assertEqual(norm(res), norm(model.covered_by_at_least(k)),
                                 f"threshold k={k} seed={seed} step={step}")
                self.assertEqual(verify_threshold(ws.current, k, res), [])

    def test_seeds(self):
        for seed in range(8):
            with self.subTest(seed=seed):
                self.run_sequence(seed)

    def test_transaction_failure_branching(self):
        # splits inside a transaction that then fails must leave no trace
        rng = random.Random(99)
        ws = Workspace()
        model = ScanlineModel()
        for i in range(50):
            lo = Fraction(rng.randint(-10, 0))
            hi = Fraction(rng.randint(1, 10))
            ws.add(lo, hi, f"s{i % 3}")
            model.add(lo, hi, f"s{i % 3}")
        for round_ in range(20):
            ops = []
            for _ in range(rng.randint(1, 5)):
                lo = Fraction(rng.randint(-10, 5))
                ops.append((lo, lo + Fraction(rng.randint(1, 5))))
            abort = rng.random() < 0.6
            try:
                with ws.transaction():
                    for lo, hi in ops:
                        ws.add(lo, hi, "tx")
                    if abort:
                        raise RuntimeError("abort")
            except RuntimeError:
                pass
            if not abort:
                for lo, hi in ops:
                    model.add(lo, hi, "tx")
            self.assertEqual(norm(ws.current.segments()), norm(model.atoms),
                             f"round={round_}")
            self.assertEqual(check_canonical(ws.current), [])


if __name__ == "__main__":
    unittest.main()
