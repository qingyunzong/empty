import json
import unittest

from lazydfa import NFA, LazyDFA, ACCEPT


def build_nfa():
    # Branching NFA so expansion has a non-trivial queue.
    nfa = NFA(5, 0, accepting=[3, 4])
    nfa.add_epsilon(0, 1)
    nfa.add_symbol_edge(1, 2, 0, 2)
    nfa.add_symbol_edge(1, 3, 1, 3)
    nfa.add_symbol_edge(2, 4, 0, 9)
    nfa.add_symbol_edge(3, 4, 2, 5)
    return nfa


def machine_signature(dfa):
    out = dfa.to_json()
    sig_states = [(s["subset"], s["status"]) for s in out["states"]]
    sig_trans = [(t["src"], t["lo"], t["hi"], t["dst"],
                  tuple(w["id"] for w in t["witness"]))
                 for t in out["transitions"]]
    return sig_states, sig_trans


class CheckpointTest(unittest.TestCase):
    def test_restore_continues_identically_to_one_shot(self):
        # One-shot run.
        nfa_a = build_nfa()
        full = LazyDFA(nfa_a)
        full.expand()

        # Partial run, checkpoint, restore, finish.
        nfa_b = build_nfa()
        part = LazyDFA(nfa_b, state_budget=2)
        part.expand()
        self.assertTrue(part.budget_exhausted)
        data = json.loads(json.dumps(part.save_checkpoint()))  # JSON round-trip
        restored = LazyDFA.restore(nfa_b, data)
        restored.expand()

        self.assertEqual(machine_signature(full), machine_signature(restored))

    def test_multiple_restores_from_same_checkpoint_agree(self):
        nfa = build_nfa()
        part = LazyDFA(nfa, state_budget=2)
        part.expand()
        data = part.save_checkpoint()
        runs = []
        for _ in range(3):
            r = LazyDFA.restore(build_nfa(), data)
            r.expand()
            runs.append(machine_signature(r))
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(runs[1], runs[2])

    def test_staged_checkpoints_match_one_shot(self):
        # Expand one budget step at a time, checkpointing between stages.
        nfa = build_nfa()
        dfa = LazyDFA(nfa, state_budget=1)
        for stage in range(1, 8):
            dfa.state_budget = stage
            dfa.expand()
            data = json.loads(json.dumps(dfa.save_checkpoint()))
            dfa = LazyDFA.restore(nfa, data, state_budget=stage + 1)
        dfa.state_budget = None
        dfa.expand()
        full = LazyDFA(build_nfa())
        full.expand()
        self.assertEqual(machine_signature(full), machine_signature(dfa))

    def test_version_mismatch_rejected(self):
        nfa = build_nfa()
        dfa = LazyDFA(nfa)
        dfa.expand()
        data = dfa.save_checkpoint()
        nfa.add_symbol_edge(0, 4, 7, 7)  # bumps NFA version
        with self.assertRaises(ValueError):
            LazyDFA.restore(nfa, data)

    def test_format_mismatch_rejected(self):
        nfa = build_nfa()
        dfa = LazyDFA(nfa)
        data = dfa.save_checkpoint()
        data["format"] = 999
        with self.assertRaises(ValueError):
            LazyDFA.restore(nfa, data)

    def test_checkpoint_preserves_language(self):
        nfa = build_nfa()
        part = LazyDFA(nfa, state_budget=2)
        part.expand()
        restored = LazyDFA.restore(nfa, part.save_checkpoint())
        restored.expand()
        full = LazyDFA(build_nfa())
        full.expand()
        for s in ([], [0], [1], [0, 0], [1, 2], [2, 5], [9], [1, 3, 2]):
            self.assertEqual(full.match(s), restored.match(s))
        self.assertEqual(restored.match([0, 0]), ACCEPT)


if __name__ == "__main__":
    unittest.main()
