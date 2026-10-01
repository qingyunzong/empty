import unittest
from copy import deepcopy

from docstore import engine
from docstore.errors import PatchError


def run(doc, op):
    return engine.apply_op(doc, op)


class TestEngineOps(unittest.TestCase):
    def test_add_reports_array_prefix_on_insert(self):
        doc = {"arr": [1, 2, 3]}
        doc, aff = run(doc, {"op": "add", "path": "/arr/0", "value": 9})
        self.assertEqual(doc, {"arr": [9, 1, 2, 3]})
        self.assertEqual(aff.removals, [("arr",)])
        self.assertEqual(aff.additions, [("arr",)])

    def test_remove_reports_array_prefix(self):
        doc = {"arr": [1, 2, 3]}
        doc, aff = run(doc, {"op": "remove", "path": "/arr/1"})
        self.assertEqual(doc, {"arr": [1, 3]})
        self.assertEqual(aff.removals, [("arr",)])
        self.assertEqual(aff.additions, [("arr",)])

    def test_replace_reports_leaf_only(self):
        doc = {"arr": [1, 2]}
        doc, aff = run(doc, {"op": "replace", "path": "/arr/1", "value": 5})
        self.assertEqual(aff.removals, [("arr", 1)])
        self.assertEqual(aff.additions, [("arr", 1)])

    def test_object_key_reports_leaf(self):
        doc = {"a": {"b": 1}}
        doc, aff = run(doc, {"op": "add", "path": "/a/c", "value": 2})
        self.assertEqual(aff.removals, [("a", "c")])
        self.assertEqual(aff.additions, [("a", "c")])

    def test_move_reports_both_sides(self):
        doc = {"a": {"x": 1}, "b": {}}
        doc, aff = run(doc, {"op": "move", "from": "/a/x", "path": "/b/y"})
        self.assertEqual(doc, {"a": {}, "b": {"y": 1}})
        self.assertEqual(aff.removals, [("a", "x"), ("b", "y")])
        self.assertEqual(aff.additions, [("b", "y")])

    def test_move_into_own_subtree_rejected(self):
        doc = {"a": {"b": {"c": 1}}}
        for dst in ("/a/b/c/d", "/a/b", "/a"):
            with self.assertRaises(PatchError):
                run(deepcopy(doc),
                    {"op": "move", "from": "/a", "path": dst})

    def test_move_missing_destination_parent_restores_source(self):
        doc = {"a": {"x": 1}}
        with self.assertRaises(PatchError):
            run(doc, {"op": "move", "from": "/a/x", "path": "/nope/deep/y"})
        self.assertEqual(doc, {"a": {"x": 1}})

    def test_root_replace(self):
        doc, aff = run({"a": 1}, {"op": "replace", "path": "", "value": [1]})
        self.assertEqual(doc, [1])
        self.assertEqual(aff.removals, [()])
        self.assertEqual(aff.additions, [()])

    def test_remove_root_rejected(self):
        with self.assertRaises(PatchError):
            run({"a": 1}, {"op": "remove", "path": ""})

    def test_test_op_type_strict(self):
        doc = {"i": 1, "f": 1.0, "b": True}
        run(doc, {"op": "test", "path": "/i", "value": 1})
        with self.assertRaises(PatchError):
            run(doc, {"op": "test", "path": "/i", "value": 1.0})
        with self.assertRaises(PatchError):
            run(doc, {"op": "test", "path": "/i", "value": True})
        with self.assertRaises(PatchError):
            run(doc, {"op": "test", "path": "/b", "value": 1})

    def test_append_dash(self):
        doc = {"arr": [1]}
        doc, _ = run(doc, {"op": "add", "path": "/arr/-", "value": 2})
        self.assertEqual(doc, {"arr": [1, 2]})

    def test_out_of_range(self):
        with self.assertRaises(PatchError):
            run({"arr": [1]}, {"op": "add", "path": "/arr/5", "value": 2})
        with self.assertRaises(PatchError):
            run({"arr": [1]}, {"op": "remove", "path": "/arr/1"})

    def test_copy(self):
        doc = {"a": {"x": [1]}, "b": {}}
        doc, _ = run(doc, {"op": "copy", "from": "/a/x", "path": "/b/y"})
        self.assertEqual(doc["b"]["y"], [1])
        doc["a"]["x"].append(2)
        self.assertEqual(doc["b"]["y"], [1])


if __name__ == "__main__":
    unittest.main()
