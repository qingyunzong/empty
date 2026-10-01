import unittest

from docstore import strictjson
from docstore.errors import DuplicateKeyError
from docstore.values import json_equal, type_tag, value_key


class TestStrictJson(unittest.TestCase):
    def test_duplicate_keys_rejected(self):
        with self.assertRaises(DuplicateKeyError):
            strictjson.loads('{"a": 1, "a": 2}')

    def test_nested_duplicate_keys_rejected(self):
        with self.assertRaises(DuplicateKeyError):
            strictjson.loads('{"a": {"b": 1, "b": 2}}')

    def test_non_json_constants_rejected(self):
        for bad in ("NaN", "Infinity", "-Infinity"):
            with self.assertRaises(ValueError):
                strictjson.loads(bad)

    def test_normal_document_ok(self):
        doc = strictjson.loads('{"a": [1, 1.5, true, null, "x"], "b": {}}')
        self.assertEqual(doc["a"][0], 1)


class TestValueTyping(unittest.TestCase):
    def test_int_float_bool_distinct(self):
        self.assertEqual(type_tag(1), "i")
        self.assertEqual(type_tag(1.0), "f")
        self.assertEqual(type_tag(True), "b")
        self.assertNotEqual(value_key(1), value_key(1.0))
        self.assertNotEqual(value_key(1), value_key(True))
        self.assertNotEqual(value_key(True), value_key(1.0))

    def test_json_equal_strict(self):
        self.assertTrue(json_equal(1, 1))
        self.assertFalse(json_equal(1, 1.0))
        self.assertFalse(json_equal(True, 1))
        self.assertFalse(json_equal(False, 0))
        self.assertTrue(json_equal({"a": [1, "x"]}, {"a": [1, "x"]}))
        self.assertFalse(json_equal({"a": 1}, {"a": 1.0}))
        self.assertFalse(json_equal([1], [1, 2]))


if __name__ == "__main__":
    unittest.main()
