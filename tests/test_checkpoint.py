import unittest

from lazydfa import ACCEPT, CheckpointError, LazyDFA, NFA


def sample_nfa():
    # Epsilon cycle plus overlapping intervals: non-trivial subsets.
    nfa = NFA(5, start=0, finals=[3, 4])
    nfa.add_edge(0, 1)
    nfa.add_edge(1, 0)
    nfa.add_edge(1, 2, lo=0, hi=5)
    nfa.add_edge(0, 3, lo=3, hi=9)
    nfa.add_edge(2, 4, lo=4, hi=6)
    nfa.add_edge(3, 1)
    return nfa


def machine_view(dfa):
    """The canonical, checkpoint-relevant view of a machine."""
    data = dfa.to_dict()
    return {k: data[k] for k in ("next_id", "start_id", "states",
                                 "frontier")}


class CheckpointTest(unittest.TestCase):
    def test_resume_equals_single_run(self):
        one_shot = LazyDFA(sample_nfa())
        one_shot.expand_all()

        resumed = LazyDFA(sample_nfa())
        resumed.expand(1)
        restored = LazyDFA.from_dict(resumed.to_dict())
        restored.expand(2)
        restored = LazyDFA.from_dict(restored.to_dict())
        restored.expand_all()

        self.assertEqual(machine_view(restored), machine_view(one_shot))
        self.assertTrue(restored.is_complete())

    def test_many_restore_cycles(self):
        one_shot = LazyDFA(sample_nfa())
        one_shot.expand_all()

        dfa = LazyDFA(sample_nfa())
        for _ in range(6):
            dfa.expand(1)
            dfa = LazyDFA.from_dict(dfa.to_dict())
        dfa.expand_all()
        self.assertEqual(machine_view(dfa), machine_view(one_shot))

    def test_queries_agree_after_restore(self):
        nfa = sample_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand(2)
        restored = LazyDFA.from_dict(dfa.to_dict())
        for s in ([], [0], [3], [4], [9], [0, 4], [3, 5], [2, 6, 1]):
            self.assertEqual(dfa.query(s), restored.query(s))
        restored.expand_all()
        self.assertEqual(restored.query([0, 4]), ACCEPT)

    def test_budgets_survive_checkpoint(self):
        dfa = LazyDFA(sample_nfa(), state_budget=3, transition_budget=4)
        dfa.expand(1)
        restored = LazyDFA.from_dict(dfa.to_dict())
        restored.expand_all()
        self.assertLessEqual(restored.num_states(), 3)
        self.assertLessEqual(restored.num_transitions(), 4)

    def test_format_version_mismatch_rejected(self):
        dfa = LazyDFA(sample_nfa())
        data = dfa.to_dict()
        data["format_version"] = 999
        with self.assertRaises(CheckpointError):
            LazyDFA.from_dict(data)
        data["format_version"] = 0
        with self.assertRaises(CheckpointError):
            LazyDFA.from_dict(data)
        del data["format_version"]
        with self.assertRaises(CheckpointError):
            LazyDFA.from_dict(data)

    def test_restored_machine_keeps_invalidation_hooks(self):
        nfa = sample_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand_all()
        restored = LazyDFA.from_dict(dfa.to_dict())
        # Mutating the restored NFA after a checkpoint round trip must
        # still invalidate the dependent DFA states (listener kept).
        edge_id = next(e.id for e in restored.nfa.edges.values()
                       if not e.is_epsilon)
        restored.nfa.remove_edge(edge_id)
        restored.expand_all()
        self.assertEqual(restored.query([0, 4]), "reject")


if __name__ == "__main__":
    unittest.main()
