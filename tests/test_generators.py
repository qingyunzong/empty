import random
import unittest

from propcore.generators import (
    GEN_VERSION,
    default_value,
    generate,
    order_key,
    shrink_candidates,
    size,
    validate_value,
)

NESTED_GEN = {
    "type": "oneof",
    "options": [
        {"type": "int", "min": -5, "max": 5},
        {"type": "list", "of": {"type": "int", "min": 0, "max": 3},
         "min_len": 0, "max_len": 3},
        {"type": "dict", "fields": {
            "a": {"type": "int", "min": 0, "max": 2},
            "b": {"type": "list", "of": {"type": "int", "min": -2, "max": 2},
                  "min_len": 1, "max_len": 2},
        }},
    ],
}


class GenerationTests(unittest.TestCase):
    def test_same_seed_same_sequence(self):
        first = [generate(NESTED_GEN, random.Random(11)) for _ in range(0)]
        rng_a = random.Random(11)
        rng_b = random.Random(11)
        seq_a = [generate(NESTED_GEN, rng_a) for _ in range(200)]
        seq_b = [generate(NESTED_GEN, rng_b) for _ in range(200)]
        self.assertEqual(seq_a, seq_b)
        self.assertEqual(first, [])

    def test_generated_values_validate(self):
        rng = random.Random(3)
        for _ in range(300):
            self.assertTrue(validate_value(NESTED_GEN, generate(NESTED_GEN, rng)))

    def test_validate_value_rejects_out_of_domain(self):
        gen = {"type": "int", "min": 0, "max": 4}
        self.assertFalse(validate_value(gen, 5))
        self.assertFalse(validate_value(gen, True))
        self.assertFalse(validate_value(gen, "1"))

    def test_default_value_is_valid_and_minimal(self):
        for gen in (
            NESTED_GEN,
            {"type": "int", "min": 3, "max": 9},
            {"type": "int", "min": -9, "max": -3},
        ):
            default = default_value(gen)
            self.assertTrue(validate_value(gen, default))
        self.assertEqual(default_value({"type": "int", "min": 3, "max": 9}), 3)
        self.assertEqual(default_value({"type": "int", "min": -9, "max": -3}), -3)
        self.assertEqual(default_value({"type": "int", "min": -9, "max": 9}), 0)

    def test_size_and_order(self):
        self.assertLess(size(0), size(-1))
        self.assertEqual(size(-2), size(2))
        self.assertLess(order_key(-2), order_key(2))  # JSON tie-break
        self.assertEqual(size([0, 0]), 2)
        self.assertEqual(size({"a": 0}), 2)

    def test_candidates_sorted_and_smaller(self):
        gen = {"type": "int", "min": -10, "max": 10}
        value = 7
        cands = shrink_candidates(gen, value)
        self.assertEqual(cands, sorted(cands, key=order_key))
        for cand in cands:
            self.assertLess(order_key(cand), order_key(value))
            self.assertTrue(validate_value(gen, cand))

    def test_generator_version_is_string(self):
        self.assertIsInstance(GEN_VERSION, str)
        self.assertTrue(GEN_VERSION)


if __name__ == "__main__":
    unittest.main()
