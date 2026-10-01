"""Unit tests for the HM inferencer: let-polymorphism, value restriction,
occurs check, error shape and the 5-error recovery boundary."""
import unittest

from hmtype.infer import MAX_ERRORS, infer_program
from hmtype.parser import parse_program


def infer(src):
    return infer_program(parse_program(src))


class TestLetPolymorphism(unittest.TestCase):
    def test_acceptance_B_polymorphic_id(self):
        results, errors = infer(
            "let id = fun x -> x\n"
            "let both = (id 1, id true)\n"
        )
        self.assertEqual(errors, [])
        self.assertEqual(results, [("id", "a -> a"), ("both", "(int, bool)")])

    def test_free_vars_named_in_appearance_order(self):
        results, errors = infer("let const = fun x -> fun y -> x\n")
        self.assertEqual(errors, [])
        self.assertEqual(results, [("const", "a -> b -> a")])

    def test_fix_factorial(self):
        results, errors = infer(
            "let fact = fix f -> fun n -> if n = 0 then 1 else n * f (n - 1)\n"
        )
        self.assertEqual(errors, [])
        self.assertEqual(results, [("fact", "int -> int")])

    def test_if_branches_must_agree(self):
        _, errors = infer("let x = if true then 1 else false\n")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["kind"], "TypeError")
        self.assertEqual(errors[0]["expected"], "int")
        self.assertEqual(errors[0]["actual"], "bool")


class TestValueRestriction(unittest.TestCase):
    def test_lambda_is_generalised(self):
        _, errors = infer(
            "let r = fun y -> y\n"
            "let ok = (r 1, r true)\n"
        )
        self.assertEqual(errors, [])

    def test_app_rhs_is_not_generalised(self):
        results, errors = infer(
            "let r = (fun x -> x) (fun y -> y)\n"
            "let bad = (r 1, r true)\n"
        )
        self.assertNotEqual(errors, [])
        self.assertEqual(errors[0]["kind"], "TypeError")

    def test_literal_rhs_is_generalised(self):
        _, errors = infer("let n = 42\nlet m = n + 1\n")
        self.assertEqual(errors, [])


class TestOccursCheck(unittest.TestCase):
    def test_acceptance_C_self_application(self):
        _, errors = infer("let f = fun x -> x x\n")
        self.assertEqual(len(errors), 1)
        err = errors[0]
        self.assertEqual(err["kind"], "OccursError")
        self.assertEqual(err["expected"], "a")
        self.assertEqual(err["actual"], "a -> b")
        self.assertIn("span", err)
        self.assertIn("env_snapshot", err)

    def test_fix_divergence_is_rejected(self):
        _, errors = infer("let omega = fix f -> f f\n")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["kind"], "OccursError")


class TestErrorShape(unittest.TestCase):
    def test_acceptance_D_type_error_fields(self):
        _, errors = infer("let g = (fun x -> x + 1) true\n")
        self.assertEqual(len(errors), 1)
        err = errors[0]
        self.assertEqual(err["kind"], "TypeError")
        self.assertEqual(err["expected"], "int")
        self.assertEqual(err["actual"], "bool")
        span = err["span"]
        for key in ("line", "col", "end_line", "end_col"):
            self.assertIn(key, span)
        self.assertEqual(span["line"], 1)
        self.assertIsInstance(err["env_snapshot"], dict)

    def test_env_snapshot_captures_scope(self):
        _, errors = infer(
            "let id = fun x -> x\n"
            "let g = (fun x -> x + 1) true\n"
        )
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["env_snapshot"], {"id": "a -> a"})


class TestErrorRecoveryBoundary(unittest.TestCase):
    def test_recovers_and_reports_multiple_errors(self):
        src = "".join(
            f"let e{i} = (fun x -> x + 1) true\n" for i in range(3)
        )
        results, errors = infer(src)
        self.assertEqual(len(errors), 3)
        self.assertEqual([name for name, _ in results], ["e0", "e1", "e2"])

    def test_stops_after_max_errors(self):
        src = "".join(
            f"let e{i} = (fun x -> x + 1) true\n" for i in range(8)
        )
        results, errors = infer(src)
        self.assertEqual(len(errors), MAX_ERRORS)
        self.assertTrue(all(e["kind"] == "TypeError" for e in errors))
        # inference aborts mid-file: the 5th declaration is not completed
        self.assertEqual(len(results), MAX_ERRORS - 1)

    def test_deterministic_output(self):
        src = "".join(
            f"let e{i} = (fun x -> x + 1) true\n" for i in range(8)
        )
        first = infer(src)
        second = infer(src)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
