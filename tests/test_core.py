import itertools
import unittest

from bareiss import BareissIntegralityError, Factorization, LinearSystem
from bareiss import reference, verify


def brute_det(A):
    """Determinant by the Leibniz formula (independent oracle)."""
    n = len(A)
    total = 0
    for perm in itertools.permutations(range(n)):
        inversions = sum(1 for i in range(n) for j in range(i + 1, n)
                         if perm[i] > perm[j])
        prod = 1
        for i in range(n):
            prod *= A[i][perm[i]]
        total += ((-1) ** inversions) * prod
    return total


class TestRankAndDeterminant(unittest.TestCase):
    def test_sign_after_many_row_and_col_swaps(self):
        # Anti-diagonal matrix: complete pivoting is forced into many
        # row and column swaps; the determinant sign must track them.
        A = [[1, 0, 0, 0],
             [0, 0, 0, 2],
             [0, 0, 3, 0],
             [0, 4, 0, 0]]
        system = LinearSystem(A)
        fact = system.factorization
        self.assertGreaterEqual(fact.row_swaps, 2)
        self.assertGreaterEqual(fact.col_swaps, 3)
        self.assertEqual(system.determinant(), brute_det(A))
        self.assertEqual(system.determinant(), -24)
        self.assertEqual(system.determinant(), reference.determinant(A))

    def test_odd_permutation_matrix(self):
        A = [[0, 1, 0], [0, 0, 1], [1, 0, 0]]  # cyclic, even
        self.assertEqual(LinearSystem(A).determinant(), 1)
        B = [[0, 1, 0], [1, 0, 0], [0, 0, 1]]  # transposition, odd
        self.assertEqual(LinearSystem(B).determinant(), -1)

    def test_singular_pivot_continues(self):
        # Zero diagonal everywhere, but the matrix is nonsingular: a naive
        # "pivot is zero => rest is zero" rule would misreport the rank.
        A = [[0, 1], [1, 0]]
        system = LinearSystem(A)
        self.assertEqual(system.rank, 2)
        self.assertEqual(system.determinant(), -1)

    def test_zero_remaining_block_stops_cleanly(self):
        A = [[0, 1, 2], [0, 0, 0], [0, 2, 4]]
        system = LinearSystem(A)
        self.assertEqual(system.rank, 1)
        self.assertEqual(system.determinant(), 0)
        self.assertTrue(any("exactly zero" in note
                            for note in system.factorization.notes))

    def test_rank_deficient_rectangular(self):
        A = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
        system = LinearSystem(A)
        self.assertEqual(system.rank, 2)
        self.assertEqual(system.determinant(), 0)
        self.assertEqual(len(system.null_space()), 1)

    def test_huge_common_factor(self):
        g = 10**40 * 3**17
        A0 = [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]]
        A = [[g * v for v in row] for row in A0]
        system = LinearSystem(A)
        self.assertEqual(system.determinant(),
                         g ** 3 * reference.determinant(A0))
        sol_big = system.solve([[g * 8, g * -11, g * -3]])[0]
        sol_ref = LinearSystem(A0).solve([[8, -11, -3]])[0]
        self.assertEqual(sol_big["particular"], sol_ref["particular"])
        self.assertEqual(sol_big["null_basis"], sol_ref["null_basis"])

    def test_permutations_are_recorded(self):
        A = [[0, 0, 5], [0, 3, 0], [7, 0, 0]]
        fact = LinearSystem(A).factorization
        self.assertEqual(sorted(fact.row_perm), [0, 1, 2])
        self.assertEqual(sorted(fact.col_perm), [0, 1, 2])
        self.assertEqual(len(fact.steps), 3)
        for k, step in enumerate(fact.steps):
            self.assertEqual(step["step"], k)
            self.assertIn("pivot_value", step)
            self.assertIn("prev_pivot", step)


class TestSolving(unittest.TestCase):
    def test_unique_solution(self):
        A = [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]]
        b = [8, -11, -3]
        sol = LinearSystem(A).solve([b])[0]
        self.assertEqual(sol["status"], "unique")
        self.assertEqual(sol["null_basis"], [])
        self.assertTrue(verify.verify_solution(A, sol["particular"], b))

    def test_infinite_solution_with_null_basis(self):
        A = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
        b = [6, 15, 24]
        system = LinearSystem(A)
        sol = system.solve([b])[0]
        self.assertEqual(sol["status"], "infinite")
        self.assertEqual(len(sol["null_basis"]), 1)
        checks = verify.verify_solutions(A, [b], [sol], system.rank)[0]
        self.assertTrue(all(v for k, v in checks.items() if k != "status"))

    def test_rank_deficient_mixed_rhs(self):
        # Same rank-deficient A; one RHS in the column space, one not.
        A = [[1, 2], [2, 4], [3, 6]]
        system = LinearSystem(A)
        sol_ok, sol_bad = system.solve([[1, 2, 3], [1, 2, 4]])
        self.assertEqual(sol_ok["status"], "infinite")
        self.assertEqual(sol_bad["status"], "inconsistent")
        checks = verify.verify_solutions(
            A, [[1, 2, 3], [1, 2, 4]], [sol_ok, sol_bad], system.rank)
        for check in checks:
            self.assertTrue(all(v for k, v in check.items() if k != "status"))

    def test_inconsistency_certificate(self):
        A = [[1, 2], [2, 4]]
        b = [3, 7]
        sol = LinearSystem(A).solve([b])[0]
        self.assertEqual(sol["status"], "inconsistent")
        y = sol["certificate"]
        self.assertTrue(verify.verify_certificate(A, b, y))
        self.assertTrue(all(isinstance(v, int) for v in y))

    def test_integrality_is_checked_not_truncated(self):
        # Corrupt a recorded elimination column, then a forward replay
        # must raise instead of silently truncating the division.
        fact = Factorization.compute([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]])
        fact.steps[1]["column"][0] += 1  # corrupt the recorded elimination
        with self.assertRaises(BareissIntegralityError):
            fact.forward([[1], [1], [1]])

    def test_multi_rhs_single_factorization(self):
        A = [[1, 2], [3, 4]]
        system = LinearSystem(A)
        rhs = [[1, 1], [0, 1], [5, 11]]
        sols = system.solve(rhs)
        self.assertEqual([s["status"] for s in sols], ["unique"] * 3)
        checks = verify.verify_solutions(A, rhs, sols, system.rank)
        for check in checks:
            self.assertTrue(check["particular_valid"])


if __name__ == "__main__":
    unittest.main()
