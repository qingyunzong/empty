import json
import os
import tempfile
import unittest

from bareiss import Factorization, LinearSystem
from bareiss import reference, verify


class TestIncrementalUpdates(unittest.TestCase):
    def setUp(self):
        self.A = [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]]
        self.system = LinearSystem(self.A)

    def test_prefix_reuse_on_row_replace(self):
        updated = self.system.updated(replace_rows={2: [-2, 1, 5]})
        steps = updated.factorization.steps
        self.assertTrue(steps[0]["reused"])
        self.assertEqual(updated.rank, 3)
        self.assertEqual(updated.determinant(),
                         reference.determinant([[2, 1, -1],
                                                [-3, -1, 2], [-2, 1, 5]]))

    def test_rank_goes_up_when_adding_row(self):
        rank_def = LinearSystem([[1, 2], [2, 4]])
        self.assertEqual(rank_def.rank, 1)
        bigger = rank_def.updated(add_rows=[[1, 1]])
        self.assertEqual(bigger.rank, 2)
        with self.assertRaises(ValueError):  # 3x2 is not square
            bigger.determinant()
        # old snapshot still queryable
        self.assertEqual(rank_def.rank, 1)
        self.assertEqual(rank_def.null_space(), [[2, -1]])

    def test_rank_goes_down_when_replacing_row(self):
        smaller = self.system.updated(replace_rows={2: [-4, -2, 2]})
        self.assertEqual(smaller.rank, 2)
        self.assertEqual(smaller.determinant(), 0)
        self.assertEqual(self.system.rank, 3)  # snapshot untouched
        self.assertEqual(self.system.determinant(), -1)

    def test_added_row_makes_rectangular_full_rank(self):
        wide = LinearSystem([[1, 0, 2], [0, 1, 1]])
        updated = wide.updated(add_rows=[[1, 1, 1]])
        self.assertEqual(updated.rank, 3)
        self.assertEqual(updated.determinant(),
                         reference.determinant([[1, 0, 2], [0, 1, 1], [1, 1, 1]]))

    def test_pivot_vanishes_triggers_recompute(self):
        # Replacing a row so the recorded pivot entry becomes zero forces
        # a fallback; results must still be exact.
        system = LinearSystem([[5, 1], [1, 1]])
        updated = system.updated(replace_rows={0: [0, 1]})
        self.assertTrue(any("became zero" in note
                            for note in updated.factorization.notes))
        self.assertEqual(updated.rank, 2)
        self.assertEqual(updated.determinant(),
                         reference.determinant([[0, 1], [1, 1]]))

    def test_stale_cache_is_rejected_and_recomputed(self):
        # Corrupt a checkpoint on disk: the update must detect the stale
        # cached pivot, roll back, and still produce exact results.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "checkpoint.json")
            self.system.save_checkpoint(path)
            with open(path) as fh:
                data = json.load(fh)
            data["steps"][0]["pivot_value"] += 1  # corrupt the cache
            with open(path, "w") as fh:
                json.dump(data, fh)
            corrupt = LinearSystem.load_checkpoint(path)
            updated = corrupt.updated(replace_rows={2: [-2, 1, 5]})
        fresh = LinearSystem([[2, 1, -1], [-3, -1, 2], [-2, 1, 5]])
        self.assertEqual(updated.rank, fresh.rank)
        self.assertEqual(updated.determinant(), fresh.determinant())
        self.assertTrue(any("stale" in note or "recomputing" in note
                            for note in updated.factorization.notes))

    def test_invalid_update_rolls_back(self):
        before = self.system.factorization.to_dict()
        with self.assertRaises(ValueError):
            self.system.updated(replace_rows={0: [1, 2]})  # wrong length
        with self.assertRaises(ValueError):
            self.system.updated(replace_rows={9: [1, 2, 3]})  # out of range
        with self.assertRaises(ValueError):
            self.system.updated(add_rows=[[1, 2]])
        self.assertEqual(self.system.factorization.to_dict(), before)

    def test_old_snapshots_remain_queryable(self):
        b = [8, -11, -3]
        sol_before = self.system.solve([b])[0]
        updated = self.system.updated(replace_rows={0: [1, 1, 1]})
        self.assertEqual(self.system.solve([b])[0], sol_before)
        self.assertEqual(self.system.determinant(), -1)
        self.assertNotEqual(updated.factorization.to_dict(),
                            self.system.factorization.to_dict())

    def test_chain_of_updates(self):
        system = self.system
        system = system.updated(add_rows=[[1, 1, 1]])
        system = system.updated(replace_rows={3: [0, 0, 7]})
        system = system.updated(add_rows=[[3, 2, 1]])
        expected = [[2, 1, -1], [-3, -1, 2], [-2, 1, 2], [0, 0, 7], [3, 2, 1]]
        self.assertEqual(system.matrix, expected)
        self.assertEqual(system.rank, reference.rank(expected))

    def test_checkpoint_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cp.json")
            rhs = [[8, -11, -3], [1, 2, 3]]
            before = self.system.solve(rhs)
            self.system.save_checkpoint(path)
            loaded = LinearSystem.load_checkpoint(path)
            self.assertEqual(loaded.rank, self.system.rank)
            self.assertEqual(loaded.determinant(), self.system.determinant())
            self.assertEqual(loaded.solve(rhs), before)
            self.assertEqual(loaded.factorization.to_dict(),
                             self.system.factorization.to_dict())
            # updates continue to work from a reloaded checkpoint
            continued = loaded.updated(add_rows=[[4, 0, 1]])
            fresh = LinearSystem(self.A + [[4, 0, 1]])
            self.assertEqual(continued.rank, fresh.rank)


if __name__ == "__main__":
    unittest.main()
