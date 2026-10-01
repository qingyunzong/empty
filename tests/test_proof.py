import inspect
import unittest

from symdfa import SymbolicDFA, minimize, verify_certificate
from symdfa.verify import VerificationError
import symdfa.verify


def chain_dfa(length, finals=()):
    transitions = {}
    for s in range(length):
        transitions[s] = [(0, 0, min(s + 1, length - 1)), (1, 1, s)]
    return SymbolicDFA(2, 0, set(finals), transitions)


def brute_force_depth(dfa, p, q, limit=12):
    """Shortest distinguishing word length via BFS on the product graph."""
    frontier = {(p, q)}
    depth = 0
    seen = set(frontier)
    while frontier and depth <= limit:
        nxt = set()
        for a, b in frontier:
            if (a in dfa.finals) != (b in dfa.finals):
                return depth
            for c in range(dfa.alphabet_size):
                pair = (dfa.step(a, c), dfa.step(b, c))
                if pair not in seen:
                    seen.add(pair)
                    nxt.add(pair)
        frontier = nxt
        depth += 1
    return None


class TestProofDAG(unittest.TestCase):
    def test_certificate_verifies(self):
        dfa = chain_dfa(4, finals={3})
        result = minimize(dfa)
        self.assertTrue(verify_certificate(dfa, result.to_dict()))

    def test_empty_language_certificate_verifies(self):
        dfa = chain_dfa(3)
        result = minimize(dfa)
        self.assertEqual(result.proof.nodes, [])
        self.assertTrue(verify_certificate(dfa, result.to_dict()))

    def test_words_are_shortest(self):
        dfa = chain_dfa(5, finals={4})
        result = minimize(dfa)
        for i in range(len(result.blocks)):
            for j in range(i + 1, len(result.blocks)):
                word = result.proof.word(i, j)
                rep_i = result.blocks[i][0]
                rep_j = result.blocks[j][0]
                self.assertNotEqual(
                    dfa.accepts(word, rep_i), dfa.accepts(word, rep_j)
                )
                self.assertEqual(
                    len(word), brute_force_depth(dfa, rep_i, rep_j)
                )

    def test_dag_shares_suffix_nodes(self):
        dfa = chain_dfa(4, finals={3})
        result = minimize(dfa)
        dag = result.proof
        # word(0,1) = [0,0] must reuse the suffix nodes of (1,2) and (2,3).
        child = dag.nodes[dag.roots[(0, 1)]]["child"]
        self.assertEqual(child, dag.roots[(1, 2)])
        child2 = dag.nodes[child]["child"]
        self.assertEqual(child2, dag.roots[(2, 3)])
        self.assertEqual(dag.word(0, 1), [0, 0])

    def test_tampered_word_rejected(self):
        dfa = chain_dfa(4, finals={3})
        cert = minimize(dfa).to_dict()
        for node in cert["proof_dag"]["nodes"]:
            if node["char"] == 0:
                node["char"] = 1
                break
        with self.assertRaises(VerificationError):
            verify_certificate(dfa, cert)

    def test_merged_blocks_rejected(self):
        dfa = chain_dfa(4, finals={3})
        cert = minimize(dfa).to_dict()
        # Forcibly merge two blocks in the certificate.
        cert["blocks"][0] = sorted(cert["blocks"][0] + cert["blocks"][1])
        del cert["blocks"][1]
        cert["state_to_block"] = {
            str(s): (0 if b <= 1 else b - 1)
            for s, b in ((int(s), b) for s, b in cert["state_to_block"].items())
        }
        with self.assertRaises(VerificationError):
            verify_certificate(dfa, cert)

    def test_missing_root_rejected(self):
        dfa = chain_dfa(4, finals={3})
        cert = minimize(dfa).to_dict()
        del cert["proof_dag"]["roots"]["0,1"]
        with self.assertRaises(VerificationError):
            verify_certificate(dfa, cert)

    def test_verifier_does_not_call_minimizer(self):
        source = inspect.getsource(symdfa.verify)
        for line in source.splitlines():
            if "import" in line:
                self.assertNotIn("minimize", line)
                self.assertNotIn("incremental", line)
                self.assertNotIn("refine", line)


if __name__ == "__main__":
    unittest.main()
