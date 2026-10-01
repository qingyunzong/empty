import unittest

from hmtype import (MAX_ERRORS, OccursError, TypeMismatch, UnboundVariable,
                    infer_program, infer_source, parse_program)


def infer_expr_type(src):
    return infer_source(src)


def infer_prog(src):
    return infer_program(parse_program(src))


class TestBasicInference(unittest.TestCase):
    def test_int_bool_literals(self):
        self.assertEqual(infer_expr_type("42"), "int")
        self.assertEqual(infer_expr_type("true"), "bool")

    def test_identity(self):
        self.assertEqual(infer_expr_type("fun x -> x"), "a -> a")

    def test_free_vars_named_in_order_of_appearance(self):
        self.assertEqual(infer_expr_type("fun x -> fun y -> x"), "a -> b -> a")
        self.assertEqual(infer_expr_type("fun f -> fun x -> f x"),
                         "(a -> b) -> a -> b")
        self.assertEqual(infer_expr_type("fun a -> fun b -> fun c -> (c b, a)"),
                         "a -> b -> (b -> c) -> (c * a)")

    def test_arithmetic_and_comparison(self):
        self.assertEqual(infer_expr_type("fun x -> x + 1"), "int -> int")
        self.assertEqual(infer_expr_type("fun x -> x > 0"), "int -> bool")
        self.assertEqual(infer_expr_type("1 <= 2"), "bool")

    def test_polymorphic_equality(self):
        self.assertEqual(infer_expr_type("fun x -> x == x"), "a -> bool")

    def test_if(self):
        self.assertEqual(infer_expr_type("if true then 1 else 2"), "int")

    def test_if_cond_must_be_bool(self):
        with self.assertRaises(TypeMismatch):
            infer_expr_type("if 1 then 2 else 3")

    def test_if_branches_must_agree(self):
        with self.assertRaises(TypeMismatch):
            infer_expr_type("if true then 1 else false")

    def test_tuple(self):
        self.assertEqual(infer_expr_type("(1, true)"), "(int * bool)")

    def test_fix_factorial(self):
        src = ("fix (fun self -> fun n -> "
               "if n == 0 then 1 else n * self (n - 1))")
        self.assertEqual(infer_expr_type(src), "int -> int")

    def test_unbound_variable(self):
        with self.assertRaises(UnboundVariable):
            infer_expr_type("fun x -> y")


class TestLetPolymorphism(unittest.TestCase):
    def test_acceptance_B_let_generalization(self):
        # let id = fun x -> x in (id 1, id true) must type-check.
        self.assertEqual(
            infer_expr_type("let id = fun x -> x in (id 1, id true)"),
            "(int * bool)")

    def test_value_restriction_blocks_app_rhs(self):
        # RHS is an application, so it must NOT be generalized.
        with self.assertRaises(TypeMismatch):
            infer_expr_type(
                "let r = (fun x -> x) (fun y -> y) in (r 1, r true)")

    def test_value_restriction_monomorphic_use_ok(self):
        self.assertEqual(
            infer_expr_type("let r = (fun x -> x) (fun y -> y) in r 1"), "int")

    def test_literal_rhs_generalizes(self):
        self.assertEqual(infer_expr_type("let x = 1 in x + 1"), "int")

    def test_toplevel_let_sequence(self):
        entries = infer_prog("let id = fun x -> x\nlet one = id 1\n")
        self.assertEqual(entries[0], ("id", "a -> a", None))
        self.assertEqual(entries[1], ("one", "int", None))


class TestOccursCheck(unittest.TestCase):
    def test_acceptance_C_occurs_error(self):
        with self.assertRaises(OccursError) as ctx:
            infer_expr_type("fun x -> x x")
        err = ctx.exception
        self.assertEqual(err.kind, "OccursError")
        self.assertIn("infinite type", err.message)

    def test_occurs_error_json_fields(self):
        entries = infer_prog("let f = fun x -> x x\n")
        name, ty, err = entries[0]
        self.assertEqual(name, "f")
        self.assertIsNone(ty)
        payload = err.to_json()
        self.assertEqual(payload["error"], "OccursError")
        self.assertIn("span", payload)
        self.assertIn("env_snapshot", payload)


class TestTypeErrors(unittest.TestCase):
    def test_acceptance_D_type_error_fields(self):
        entries = infer_prog("let g = (fun x -> x + 1) true\n")
        name, ty, err = entries[0]
        self.assertEqual(name, "g")
        self.assertIsNone(ty)
        self.assertIsInstance(err, TypeMismatch)
        payload = err.to_json()
        self.assertEqual(payload["error"], "TypeError")
        self.assertEqual(payload["expected"], "int")
        self.assertEqual(payload["actual"], "bool")
        self.assertEqual(len(payload["span"]), 4)
        self.assertIn("env_snapshot", payload)

    def test_error_recovery_continues_with_next_let(self):
        src = "let bad = 1 + true\nlet good = fun x -> x\n"
        entries = infer_prog(src)
        self.assertEqual(len(entries), 2)
        self.assertIsNotNone(entries[0][2])
        self.assertEqual(entries[1][1], "a -> a")

    def test_env_snapshot_contains_previous_bindings(self):
        src = "let id = fun x -> x\nlet bad = id + 1\n"
        entries = infer_prog(src)
        err = entries[1][2]
        self.assertEqual(err.env_snapshot.get("id"), "a -> a")

    def test_acceptance_D_max_five_errors(self):
        lines = [f"let e{i} = {i} + true" for i in range(7)]
        entries = infer_prog("\n".join(lines) + "\n")
        errors = [e for e in entries if e[2] is not None]
        self.assertEqual(len(errors), MAX_ERRORS)
        # Processing stops after the 5th error: only 5 entries total.
        self.assertEqual(len(entries), MAX_ERRORS)


if __name__ == "__main__":
    unittest.main()
