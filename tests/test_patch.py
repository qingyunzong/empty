import unittest

from jsondoc.patch import PatchError, affected_roots, apply_patch
from jsondoc.strictjson import loads


class PatchTests(unittest.TestCase):
    def test_add_object_key_and_replace_existing(self):
        doc = loads('{"a": 1}')
        out = apply_patch(doc, [{"op": "add", "path": "/b", "value": 2}])
        self.assertEqual(out, {"a": 1, "b": 2})
        out = apply_patch(out, [{"op": "add", "path": "/a", "value": 9}])
        self.assertEqual(out, {"a": 9, "b": 2})
        self.assertEqual(doc, {"a": 1})  # input untouched

    def test_add_array_insert_and_dash_append(self):
        doc = loads('[1, 2, 3]')
        out = apply_patch(doc, [{"op": "add", "path": "/1", "value": 9}])
        self.assertEqual(out, [1, 9, 2, 3])
        out = apply_patch(out, [{"op": "add", "path": "/-", "value": 4}])
        self.assertEqual(out, [1, 9, 2, 3, 4])

    def test_remove_and_replace(self):
        doc = loads('{"a": {"b": [1, 2]}}')
        out = apply_patch(doc, [{"op": "remove", "path": "/a/b/0"}])
        self.assertEqual(out, {"a": {"b": [2]}})
        out = apply_patch(out, [{"op": "replace", "path": "/a/b/0", "value": 7}])
        self.assertEqual(out, {"a": {"b": [7]}})
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "replace", "path": "/missing", "value": 1}])
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "remove", "path": "/missing"}])

    def test_move_basic(self):
        doc = loads('{"a": {"x": 1}, "b": {}}')
        out = apply_patch(doc, [{"op": "move", "from": "/a/x", "path": "/b/y"}])
        self.assertEqual(out, {"a": {}, "b": {"y": 1}})

    def test_move_into_own_subtree_rejected(self):
        doc = loads('{"a": {"b": {"c": 1}}}')
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "move", "from": "/a", "path": "/a/b/c"}])
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "move", "from": "/a/b", "path": "/a/b/c/d"}])
        # moving to the same location is a no-op, not an error
        out = apply_patch(doc, [{"op": "move", "from": "/a", "path": "/a"}])
        self.assertEqual(out, {"a": {"b": {"c": 1}}})

    def test_move_array_element(self):
        doc = loads('{"xs": [1, 2, 3]}')
        out = apply_patch(doc, [{"op": "move", "from": "/xs/0", "path": "/xs/2"}])
        self.assertEqual(out, {"xs": [2, 3, 1]})

    def test_test_op(self):
        doc = loads('{"n": 1, "d": 1.0, "f": true}')
        apply_patch(doc, [{"op": "test", "path": "/n", "value": 1}])
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "test", "path": "/n", "value": 2}])
        # typed equality: 1 != 1.0 != true
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "test", "path": "/n", "value": loads("1.0")}])
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "test", "path": "/f", "value": 1}])

    def test_batch_all_or_nothing(self):
        doc = loads('{"a": 1}')
        ops = [
            {"op": "add", "path": "/b", "value": 2},
            {"op": "test", "path": "/a", "value": 999},
        ]
        with self.assertRaises(PatchError):
            apply_patch(doc, ops)
        self.assertEqual(doc, {"a": 1})

    def test_pointer_escaping(self):
        doc = loads('{"a/b": 1, "x~y": 2}')
        out = apply_patch(doc, [
            {"op": "replace", "path": "/a~1b", "value": 10},
            {"op": "replace", "path": "/x~0y", "value": 20},
        ])
        self.assertEqual(out, {"a/b": 10, "x~y": 20})

    def test_bad_index_rejected(self):
        doc = loads('[1, 2]')
        for path in ("/01", "/x", "/5"):
            with self.assertRaises(PatchError):
                apply_patch(doc, [{"op": "replace", "path": path, "value": 0}])
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "remove", "path": "/-"}])

    def test_affected_roots(self):
        roots = affected_roots([
            {"op": "add", "path": "/a/b/0"},
            {"op": "replace", "path": "/c"},
            {"op": "move", "from": "/d/e", "path": "/f/g"},
            {"op": "test", "path": "/g", "value": 1},
        ])
        self.assertEqual(sorted(roots), ["/a/b", "/c", "/d", "/f"])
        # a root-level move target subsumes narrower roots
        roots = affected_roots([
            {"op": "add", "path": "/a/b"},
            {"op": "move", "from": "/c", "path": "/d"},
        ])
        self.assertEqual(roots, [""])


if __name__ == "__main__":
    unittest.main()
