import copy
import unittest

from symdfa import SymbolicDFA, minimize, verify_certificate


def sample():
    dfa = SymbolicDFA(2, 6, 0, [2, 5], [
        [([(0, 0)], 1), ([(1, 1)], 3)],
        [([(0, 0)], 2)],
        [([(0, 1)], 2)],
        [([(0, 0)], 4)],
        [([(0, 0)], 5)],
        [([(0, 1)], 5)],
    ])
    return dfa, minimize(dfa)


class TestCertificate(unittest.TestCase):
    def test_valid_certificate_passes(self):
        dfa, result = sample()
        self.assertEqual(verify_certificate(dfa, result), [])

    def test_tampered_block_map_detected(self):
        dfa, result = sample()
        bad = copy.deepcopy(result)
        bad["block_map"]["1"] = (bad["block_map"]["1"] + 1) % 4
        self.assertTrue(verify_certificate(dfa, bad))

    def test_tampered_quotient_edge_detected(self):
        dfa, result = sample()
        bad = copy.deepcopy(result)
        edge = bad["quotient"]["transitions"][1][0]
        edge["target"] = (edge["target"] + 1) % bad["quotient"]["num_states"]
        self.assertTrue(verify_certificate(dfa, bad))

    def test_tampered_dag_detected(self):
        dfa, result = sample()
        bad = copy.deepcopy(result)
        nodes = bad["proof_dag"]["nodes"]
        referenced = set(bad["proof_dag"]["pairs"].values())
        # flip the side of a referenced accept leaf reachable from a pair
        target = None
        for nid in referenced:
            seen = set()
            stack = [nid]
            while stack:
                cur = stack.pop()
                if cur in seen:
                    continue
                seen.add(cur)
                node = nodes[cur]
                if node["kind"] == "accept":
                    target = cur
                    break
                stack.append(node["child"])
            if target is not None:
                break
        self.assertIsNotNone(target)
        nodes[target]["side"] = 1 - nodes[target]["side"]
        self.assertTrue(verify_certificate(dfa, bad))

    def test_tampered_dag_char_detected(self):
        dfa, result = sample()
        bad = copy.deepcopy(result)
        nodes = bad["proof_dag"]["nodes"]
        referenced = set(bad["proof_dag"]["pairs"].values())
        for nid in referenced:
            if nodes[nid]["kind"] == "step":
                nodes[nid]["char"] = (nodes[nid]["char"] + 1) % 2
                break
        self.assertTrue(verify_certificate(dfa, bad))

    def test_missing_pair_detected(self):
        dfa, result = sample()
        bad = copy.deepcopy(result)
        bad["proof_dag"]["pairs"].popitem()
        self.assertTrue(verify_certificate(dfa, bad))

    def test_wrong_canonical_numbering_detected(self):
        dfa, result = sample()
        bad = copy.deepcopy(result)
        q = bad["quotient"]
        if q["num_states"] >= 2:
            # swap state ids 1 and 2 everywhere
            n = q["num_states"]
            def sw(x):
                return {1: 2, 2: 1}.get(x, x)
            q["transitions"] = [
                [dict(intervals=e["intervals"], target=sw(e["target"]))
                 for e in q["transitions"][sw(i) if i < n else i]]
                for i in range(n)
            ]
            q["finals"] = sorted(sw(f) for f in q["finals"])
            bad["block_map"] = {s: sw(b) for s, b in bad["block_map"].items()}
            self.assertTrue(verify_certificate(dfa, bad))

    def test_verifier_does_not_import_minimizer(self):
        import ast
        import inspect

        import symdfa.certificate as cert

        tree = ast.parse(inspect.getsource(cert))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add(node.module or "")
        self.assertFalse(any("minimizer" in m for m in imported))
        self.assertFalse(any("partition" in m for m in imported))


if __name__ == "__main__":
    unittest.main()
