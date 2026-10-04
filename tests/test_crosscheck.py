import random
import unittest
from fractions import Fraction

from bareiss import LinearSystem
from bareiss import reference, verify


def random_matrix(rng, rows, cols, lo=-5, hi=5):
    return [[rng.randint(lo, hi) for _ in range(cols)] for _ in range(rows)]


class TestCrossCheckSmallMatrices(unittest.TestCase):
    """Bareiss engine vs. independent Fraction Gaussian elimination."""

    def test_random_rank_and_determinant(self):
        rng = random.Random(20261004)
        for trial in range(200):
            rows = rng.randint(1, 5)
            cols = rng.randint(1, 5)
            A = random_matrix(rng, rows, cols)
            if trial % 3 == 0 and rows > 1:  # force rank deficiency
                A[-1] = [2 * v for v in A[0]]
            system = LinearSystem(A)
            self.assertEqual(system.rank, reference.rank(A), A)
            if rows == cols:
                self.assertEqual(system.determinant(),
                                 reference.determinant(A), A)

    def test_random_solves_all_statuses(self):
        rng = random.Random(7)
        seen = set()
        for _ in range(300):
            rows = rng.randint(1, 4)
            cols = rng.randint(1, 4)
            A = random_matrix(rng, rows, cols, -4, 4)
            if rng.random() < 0.4 and rows > 1:
                A[-1] = A[0][:]  # rank deficiency
            b = [rng.randint(-6, 6) for _ in range(rows)]
            system = LinearSystem(A)
            sol = system.solve([b])[0]
            seen.add(sol["status"])
            ref_status, ref_part, ref_basis = reference.solve(A, b)
            self.assertEqual(sol["status"], ref_status, (A, b))
            checks = verify.verify_solutions(A, [b], [sol], system.rank)[0]
            for key, ok in checks.items():
                if key != "status":
                    self.assertTrue(ok, (A, b, checks))
            if sol["status"] != "inconsistent":
                # same affine solution set as the reference
                self.assertEqual(len(sol["null_basis"]), len(ref_basis))
                self.assertTrue(
                    verify.verify_solution(A, sol["particular"], b))
                self.assertTrue(
                    verify.verify_solution(A, ref_part, b))
        self.assertEqual(seen, {"unique", "infinite", "inconsistent"})

    def test_random_null_space(self):
        rng = random.Random(99)
        for _ in range(150):
            rows = rng.randint(1, 4)
            cols = rng.randint(1, 5)
            A = random_matrix(rng, rows, cols, -3, 3)
            system = LinearSystem(A)
            basis = system.null_space()
            self.assertEqual(len(basis), cols - system.rank)
            for v in basis:
                self.assertTrue(verify.verify_null_vector(A, v))
            self.assertTrue(verify.fraction_rank(basis) == len(basis))

    def test_huge_common_factor_random(self):
        rng = random.Random(4242)
        for _ in range(20):
            n = rng.randint(1, 4)
            A0 = random_matrix(rng, n, n, -9, 9)
            g = rng.randint(10**15, 10**18) * (10**20 + 7)
            A = [[g * v for v in row] for row in A0]
            system = LinearSystem(A)
            self.assertEqual(system.determinant(),
                             g ** n * reference.determinant(A0))
            self.assertEqual(system.rank, reference.rank(A0))

    def test_updates_match_fresh_factorization(self):
        rng = random.Random(31337)
        for _ in range(100):
            rows = rng.randint(2, 5)
            cols = rng.randint(2, 5)
            A = random_matrix(rng, rows, cols, -4, 4)
            system = LinearSystem(A)
            idx = rng.randrange(rows)
            new_row = [rng.randint(-4, 4) for _ in range(cols)]
            extra = [rng.randint(-4, 4) for _ in range(cols)]
            updated = system.updated(replace_rows={idx: new_row},
                                     add_rows=[extra])
            new_matrix = [row[:] for row in A]
            new_matrix[idx] = new_row
            new_matrix.append(extra)
            fresh = LinearSystem(new_matrix)
            self.assertEqual(updated.rank, fresh.rank)
            self.assertEqual(updated.rank, reference.rank(new_matrix))
            rhs = [[rng.randint(-5, 5) for _ in range(rows + 1)]
                   for _ in range(3)]
            got = updated.solve(rhs)
            want = fresh.solve(rhs)
            # statuses must match exactly; certificates/particulars may
            # legitimately differ across pivot paths, so verify them
            self.assertEqual([s["status"] for s in got],
                             [s["status"] for s in want])
            checks = verify.verify_solutions(new_matrix, rhs, got,
                                             updated.rank)
            for check in checks:
                for key, ok in check.items():
                    if key != "status":
                        self.assertTrue(ok, (new_matrix, rhs, check))
            if updated.factorization.rows == updated.factorization.cols:
                self.assertEqual(updated.determinant(), fresh.determinant())


if __name__ == "__main__":
    unittest.main()
