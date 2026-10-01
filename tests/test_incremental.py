import unittest

from symdfa import Minimizer, SymbolicDFA, minimize, verify_certificate
from symdfa.intervals import IntervalError


def two_chains():
    """Two parallel chains 0->1->2 and 3->4->5, finals {2, 5}."""
    return SymbolicDFA(2, 6, 0, [2, 5], [
        [([(0, 0)], 1), ([(1, 1)], 3)],
        [([(0, 0)], 2)],
        [([(0, 1)], 2)],
        [([(0, 0)], 4)],
        [([(0, 0)], 5)],
        [([(0, 1)], 5)],
    ])


class TestIncrementalFinals(unittest.TestCase):
    def test_single_final_change_cascades_and_revert_remerges(self):
        dfa = two_chains()
        minimizer = Minimizer(dfa)
        original = minimizer.result()
        # initially: {0}, {1,4}, {3}, {2,5} (four blocks)
        self.assertEqual(len({b for b in original["block_map"].values()}), 4)

        # dropping final 5 cascades: {2,5} splits, {1,4} splits, and
        # 3,4,5 become dead-equivalent and merge
        minimizer.apply_changes(finals=[2])
        changed = minimizer.result()
        self.assertEqual(changed["block_map"],
                         {"0": 0, "1": 1, "3": 2, "4": 2, "5": 2, "2": 3})
        self.assertEqual(verify_certificate(minimizer.dfa, changed), [])

        # full rebuild from the modified automaton must agree exactly
        rebuilt = minimize(SymbolicDFA(2, 6, 0, [2], dfa.transitions))
        self.assertEqual(changed, rebuilt)

        # undo: the original partition is re-established by re-merging
        minimizer.apply_changes(finals=[2, 5])
        self.assertEqual(minimizer.result(), original)
        self.assertEqual(verify_certificate(minimizer.dfa,
                                            minimizer.result()), [])

    def test_batch_final_and_transition_change(self):
        dfa = two_chains()
        minimizer = Minimizer(dfa)
        new_trans = [
            [([(0, 1)], 1)],
            [([(0, 0)], 2), ([(1, 1)], 3)],
            [([(0, 1)], 2)],
            [([(0, 0)], 4)],
            [([(0, 0)], 5)],
            [([(0, 1)], 5)],
        ]
        minimizer.apply_changes(finals=[2], transitions=new_trans)
        rebuilt = minimize(SymbolicDFA(2, 6, 0, [2], new_trans))
        self.assertEqual(minimizer.result(), rebuilt)
        self.assertEqual(verify_certificate(minimizer.dfa,
                                            minimizer.result()), [])

    def test_transition_change_updates_reachability(self):
        dfa = two_chains()
        minimizer = Minimizer(dfa)
        # cut the edge to state 3: states 3,4,5 become unreachable
        new_trans = [
            [([(0, 1)], 1)],
            [([(0, 0)], 2)],
            [([(0, 1)], 2)],
            [([(0, 0)], 4)],
            [([(0, 0)], 5)],
            [([(0, 1)], 5)],
        ]
        minimizer.apply_changes(transitions=new_trans)
        result = minimizer.result()
        self.assertEqual(set(result["block_map"]), {"0", "1", "2"})
        rebuilt = minimize(SymbolicDFA(2, 6, 0, [2, 5], new_trans))
        self.assertEqual(result, rebuilt)


class TestRollback(unittest.TestCase):
    def test_invalid_change_restores_previous_partition(self):
        dfa = two_chains()
        minimizer = Minimizer(dfa)
        original = minimizer.result()
        original_index = dict(minimizer.partition.inverse.by_target)
        # overlapping labels on state 0 -> IntervalError
        bad_trans = [row for row in dfa.transitions] + []
        bad_trans[0] = ([(0, 0)], 1), ([(0, 1)], 3)
        with self.assertRaises(IntervalError):
            minimizer.apply_changes(transitions=bad_trans)
        self.assertEqual(minimizer.result(), original)
        self.assertEqual(dict(minimizer.partition.inverse.by_target),
                         original_index)

    def test_out_of_range_final_restores(self):
        dfa = two_chains()
        minimizer = Minimizer(dfa)
        original = minimizer.result()
        with self.assertRaises(ValueError):
            minimizer.apply_changes(finals=[99])
        self.assertEqual(minimizer.result(), original)

    def test_stability_verified_on_commit(self):
        # every committed state passes the independent stability check
        dfa = two_chains()
        minimizer = Minimizer(dfa)
        self.assertEqual(minimizer.partition.verify_stability(), [])
        minimizer.apply_changes(finals=[2])
        self.assertEqual(minimizer.partition.verify_stability(), [])


class TestRandomizedIncremental(unittest.TestCase):
    def test_incremental_matches_full_rebuild(self):
        import random

        from tests.util import random_dfa

        rng = random.Random(99)
        for _ in range(40):
            sigma, n = rng.randint(1, 4), rng.randint(1, 7)
            dfa = random_dfa(rng, sigma, n)
            minimizer = Minimizer(dfa)
            cur_finals = sorted(dfa.finals)
            cur_trans = dfa.transitions
            for _ in range(3):
                if rng.random() < 0.5:
                    cur_finals = [s for s in range(n) if rng.random() < 0.35]
                    minimizer.apply_changes(finals=cur_finals)
                else:
                    cur_trans = random_dfa(rng, sigma, n).transitions
                    minimizer.apply_changes(transitions=cur_trans)
                rebuilt = minimize(
                    SymbolicDFA(sigma, n, 0, cur_finals, cur_trans))
                self.assertEqual(minimizer.result(), rebuilt)
                self.assertEqual(
                    verify_certificate(minimizer.dfa, minimizer.result()), [])


if __name__ == "__main__":
    unittest.main()
