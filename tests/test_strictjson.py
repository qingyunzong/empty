import unittest
from decimal import Decimal

from jsondoc.strictjson import (
    DuplicateKeyError,
    StrictJSONError,
    dumps,
    json_equal,
    loads,
    sort_key,
    type_name,
    value_key,
)


class StrictJSONTests(unittest.TestCase):
    def test_integer_vs_decimal_lexical(self):
        self.assertIs(type(loads("1")), int)
        self.assertIs(type(loads("1.0")), Decimal)
        self.assertIs(type(loads("1e2")), Decimal)
        self.assertIs(type(loads("-3")), int)
        self.assertIs(type(loads("0.5")), Decimal)

    def test_decimal_lexical_round_trip(self):
        value = loads('[1, 1.0, 1.50, 1e2]')
        again = loads(dumps(value))
        self.assertTrue(json_equal(value, again))
        self.assertEqual(dumps(loads("1.50")), "1.50")
        self.assertNotEqual(type(loads("1")), type(loads("1.0")))

    def test_bool_is_not_integer(self):
        self.assertEqual(type_name(True), "boolean")
        self.assertEqual(type_name(1), "integer")
        self.assertNotEqual(value_key(True), value_key(1))
        self.assertFalse(json_equal(True, 1))
        self.assertFalse(json_equal(1, Decimal("1")))
        self.assertFalse(json_equal(True, Decimal("1")))

    def test_duplicate_keys_rejected(self):
        with self.assertRaises(DuplicateKeyError):
            loads('{"a": 1, "a": 2}')
        with self.assertRaises(DuplicateKeyError):
            loads('{"outer": {"x": 1, "x": 2}}')
        self.assertEqual(loads('[{"a": 1}, {"a": 2}]')[1]["a"], 2)

    def test_constants_rejected(self):
        for text in ("NaN", "Infinity", "-Infinity"):
            with self.assertRaises(StrictJSONError):
                loads(text)

    def test_json_equal_containers(self):
        self.assertTrue(json_equal(loads('{"a":[1,2.5],"b":null}'),
                                   loads('{"b":null,"a":[1,2.5]}')))
        self.assertFalse(json_equal(loads("[1,2]"), loads("[1,2.0]")))
        self.assertFalse(json_equal(loads('{"a":1}'), loads('{"a":1,"b":2}')))

    def test_value_key_typing(self):
        self.assertNotEqual(value_key(1), value_key(Decimal("1")))
        self.assertEqual(value_key(Decimal("1.0")), value_key(Decimal("1.00")))
        self.assertNotEqual(value_key("1"), value_key(1))
        with self.assertRaises(StrictJSONError):
            value_key([1])
        with self.assertRaises(StrictJSONError):
            value_key({"a": 1})

    def test_sort_key_total_order(self):
        keys = [
            value_key("b"), value_key(2), value_key(Decimal("1.5")),
            value_key(None), value_key(True), value_key(False),
            value_key(1), value_key("a"), value_key(Decimal("2")),
        ]
        ordered = sorted(keys, key=sort_key)
        self.assertEqual(
            ordered,
            [value_key(None), value_key(False), value_key(True),
             value_key(1), value_key(Decimal("1.5")), value_key(2),
             value_key(Decimal("2")), value_key("a"), value_key("b")],
        )


if __name__ == "__main__":
    unittest.main()
