import time
import unittest

from symdfa import SymbolicDFA, minimize, verify_certificate


class TestLargeAlphabet(unittest.TestCase):
    def test_no_per_character_expansion(self):
        # 2^20 symbols: any per-character loop would be far too slow
        sigma = 1 << 20
        dfa = SymbolicDFA(sigma, 4, 0, [3], [
            [([(0, sigma // 2 - 1)], 1), ([(sigma // 2, sigma - 1)], 2)],
            [([(0, sigma - 1)], 3)],
            [([(0, sigma - 1)], 3)],
            [([(0, sigma - 1)], 3)],
        ])
        start = time.time()
        result = minimize(dfa)
        elapsed = time.time() - start
        self.assertLess(elapsed, 5.0)
        self.assertEqual(result["quotient"]["num_states"], 3)
        self.assertEqual(verify_certificate(dfa, result), [])


if __name__ == "__main__":
    unittest.main()
