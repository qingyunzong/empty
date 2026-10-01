import random
import unittest

from symdfa import IncrementalMinimizer, SymbolicDFA, ValidationError
from symdfa.baseline import full_rebuild
from symdfa.serialize import dfa_to_json


def chain_dfa(length, finals=()):
    transitions = {}
    for s in range(length):
        transitions[s] = [(0, 0, min(s + 1, length - 1)), (1, 1, s)]
    return SymbolicDFA(2, 0, set(finals), transitions)


def random_dfa(rng, n, alpha):
    transitions = {}
    for s in range(n):
        cuts = sorted(rng.sample(range(1, alpha), rng.randint(0, alpha - 1)))
        bounds = [0] + cuts + [alpha]
        transitions[s] = [
            (a, b - 1, rng.randrange(n)) for a, b in zip(bounds, bounds[1:])
        ]
    finals = {s for s in range(n) if rng.random() < 0.4}
    return SymbolicDFA(alpha, 0, finals, transitions)


class TestCascadeSplitAndRemerge(unittest.TestCase):
    def test_final_change_cascades_then_undo_remerges(self):
        # All-nonfinal chain: one block.  Flipping the last state to final
        # must cascade-split every state into its own block.
        dfa = chain_dfa(5)
        minimizer = IncrementalMinimizer(dfa)
        self.assertEqual(len(minimizer.partition.blocks), 1)

        result = minimizer.apply_updates(final_changes={4: True})
        self.assertEqual(len(result.blocks), 5)
        for state in range(5):
            self.assertEqual(result.state_to_block[state], state)

        # Undo: the chain must re-merge into a single block.
        result = minimizer.apply_updates(final_changes={4: False})
        self.assertEqual(len(result.blocks), 1)
        self.assertEqual(result.blocks[0], [0, 1, 2, 3, 4])
        self.assertEqual(minimizer.partition, IncrementalMinimizer(chain_dfa(5)).partition)

    def test_partial_final_change_matches_rebuild(self):
        dfa = chain_dfa(5)
        minimizer = IncrementalMinimizer(dfa)
        result = minimizer.apply_updates(final_changes={2: True})
        rebuilt = full_rebuild(chain_dfa(5, finals={2}))
        self.assertEqual(
            dfa_to_json(result.automaton), dfa_to_json(rebuilt.automaton)
        )
        self.assertEqual(result.state_to_block, rebuilt.state_to_block)


class TestBatchUpdates(unittest.TestCase):
    def test_transition_and_final_batch(self):
        dfa = chain_dfa(4, finals={3})
        minimizer = IncrementalMinimizer(dfa)
        result = minimizer.apply_updates(
            final_changes={0: True},
            transition_changes={1: [(0, 0, 0), (1, 1, 2)]},
        )
        expected_dfa = SymbolicDFA(2, 0, {0, 3}, {
            0: [(0, 0, 1), (1, 1, 0)],
            1: [(0, 0, 0), (1, 1, 2)],
            2: [(0, 0, 3), (1, 1, 2)],
            3: [(0, 0, 3), (1, 1, 3)],
        })
        rebuilt = full_rebuild(expected_dfa)
        self.assertEqual(
            dfa_to_json(result.automaton), dfa_to_json(rebuilt.automaton)
        )
        self.assertEqual(result.state_to_block, rebuilt.state_to_block)

    def test_random_updates_match_full_rebuild(self):
        rng = random.Random(7117)
        for _ in range(60):
            n = rng.randint(2, 6)
            alpha = rng.randint(1, 3)
            dfa = random_dfa(rng, n, alpha)
            minimizer = IncrementalMinimizer(dfa)
            for _ in range(rng.randint(1, 4)):
                final_changes = {
                    s: rng.random() < 0.5
                    for s in rng.sample(range(n), rng.randint(1, n))
                }
                transition_changes = {}
                for s in rng.sample(range(n), rng.randint(0, n)):
                    cuts = sorted(
                        rng.sample(range(1, alpha), rng.randint(0, alpha - 1))
                    )
                    bounds = [0] + cuts + [alpha]
                    transition_changes[s] = [
                        (a, b - 1, rng.randrange(n))
                        for a, b in zip(bounds, bounds[1:])
                    ]
                result = minimizer.apply_updates(final_changes, transition_changes)
                rebuilt = full_rebuild(minimizer.dfa)
                self.assertEqual(
                    dfa_to_json(result.automaton), dfa_to_json(rebuilt.automaton)
                )
                self.assertEqual(result.state_to_block, rebuilt.state_to_block)


class TestRollback(unittest.TestCase):
    def test_failed_validation_restores_partition_and_index(self):
        dfa = chain_dfa(4, finals={3})
        minimizer = IncrementalMinimizer(dfa)
        old_partition = minimizer.partition
        old_by_target = {t: sorted(e) for t, e in minimizer.inv.by_target.items()}
        old_dfa = minimizer.dfa

        with self.assertRaises(ValidationError):
            minimizer.apply_updates(
                final_changes={1: True}, validator=lambda m: False
            )
        self.assertIs(minimizer.dfa, old_dfa)
        self.assertEqual(minimizer.partition, old_partition)
        self.assertEqual(
            {t: sorted(e) for t, e in minimizer.inv.by_target.items()},
            old_by_target,
        )
        # The minimizer still works afterwards.
        result = minimizer.apply_updates(final_changes={1: True})
        rebuilt = full_rebuild(chain_dfa(4, finals={1, 3}))
        self.assertEqual(result.state_to_block, rebuilt.state_to_block)

    def test_invalid_update_leaves_state_untouched(self):
        dfa = chain_dfa(3)
        minimizer = IncrementalMinimizer(dfa)
        old_dfa = minimizer.dfa
        with self.assertRaises(Exception):
            minimizer.apply_updates(
                transition_changes={0: [(0, 0, 1), (0, 1, 2)]}  # overlap
            )
        self.assertIs(minimizer.dfa, old_dfa)


if __name__ == "__main__":
    unittest.main()
