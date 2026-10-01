import unittest

from docstore.index import Index
from docstore.paths import parse_pattern
from docstore.values import value_key

from tests.reference import full_scan


def build(name, pattern, doc):
    return Index.build(name, parse_pattern(pattern), pattern, doc)


class TestIndex(unittest.TestCase):
    def test_build_and_wildcards(self):
        doc = {"a": [{"b": [1, 2]}, {"b": [3]}], "c": 1}
        idx = build("i", "/a/*/b/*", doc)
        expected = full_scan(doc, "/a/*/b/*")
        self.assertEqual(idx.as_map(), expected)
        self.assertEqual(idx.entry_count(), 3)

    def test_type_discrimination(self):
        doc = {"v": [1, 1.0, True, "1", None]}
        idx = build("i", "/v/*", doc)
        keys = set(idx.entries)
        want = {value_key(1), value_key(1.0), value_key(True),
                value_key("1"), value_key(None)}
        self.assertEqual(keys, want)
        self.assertEqual(idx.entries[value_key(1)], {("v", 0)})
        self.assertEqual(idx.entries[value_key(1.0)], {("v", 1)})
        self.assertEqual(idx.entries[value_key(True)], {("v", 2)})

    def test_numeric_segment_matches_index_and_key(self):
        doc = {"arr": ["x"], "obj": {"0": "y"}}
        idx = build("i", "/*/0", doc)
        self.assertEqual(idx.as_map(), {"/arr/0": "x", "/obj/0": "y"})

    def test_incremental_remove_under(self):
        doc = {"a": {"x": 1, "y": 2}, "b": {"x": 3}}
        idx = build("i", "/*/x", doc)
        idx.remove_under(("a",))
        self.assertEqual(idx.as_map(), {"/b/x": 3})

    def test_copy_is_independent(self):
        doc = {"a": 1}
        idx = build("i", "/a", doc)
        clone = idx.copy()
        clone.remove_under(())
        self.assertEqual(idx.entry_count(), 1)
        self.assertEqual(clone.entry_count(), 0)


if __name__ == "__main__":
    unittest.main()
