import tempfile
import unittest

from jsondoc import DocumentStore, loads
from jsondoc.strictjson import value_key


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = DocumentStore(self.tmp.name)
        self.addCleanup(self.store.close)

    def test_eq_exists_conjunction_order(self):
        self.store.put("d1", loads('{"name":"alpha","price":10,"tags":["a","b"]}'))
        self.store.put("d2", loads('{"name":"beta","price":2.5,"tags":["b"]}'))
        self.store.put("d3", loads('{"name":"gamma","price":10}'))
        self.store.put("d4", loads('{"price":10.0}'))
        self.store.create_index("by_price", "/price")
        self.store.create_index("by_tag", "/tags/*")
        q = lambda **kw: self.store.query(kw)
        # equality via index; integer 10 must not match decimal 10.0
        self.assertEqual(q(where=[{"eq": ["by_price", 10]}]), ["d1", "d3"])
        self.assertEqual(q(where=[{"eq": ["by_price", loads("10.0")]}]), ["d4"])
        self.assertEqual(q(where=[{"eq": ["by_price", loads("2.5")]}]), ["d2"])
        # existence
        self.assertEqual(q(where=[{"exists": "/tags"}]), ["d1", "d2"])
        self.assertEqual(q(where=[{"exists": "/tags/1"}]), ["d1"])
        self.assertEqual(q(where=[{"exists": "/missing"}]), [])
        # conjunction
        self.assertEqual(
            q(where=[{"eq": ["by_tag", "b"]}, {"exists": "/name"}]),
            ["d1", "d2"],
        )
        # order by indexed value; docs without a value sort last
        self.assertEqual(q(order_by="by_price"), ["d2", "d1", "d3", "d4"])
        self.assertEqual(q(order_by="by_tag"), ["d1", "d2", "d3", "d4"])

    def test_nested_wildcard_index(self):
        self.store.put("d1", loads(
            '{"w":{"p":{"x":{"v":1}},"q":{"x":{"v":2}}},"z":{"p":{"x":{"v":3}}}}'))
        self.store.create_index("nested", "/*/*/x/v")
        self.assertEqual(self.store.index_count("nested"), 3)
        self.assertEqual(self.store.query({"where": [{"eq": ["nested", 2]}]}), ["d1"])
        paths = sorted(path for _, path, _ in self.store.index_entries("nested"))
        self.assertEqual(paths, ["/w/p/x/v", "/w/q/x/v", "/z/p/x/v"])

    def test_array_head_insert_shifts_many_paths(self):
        self.store.put("d1", loads('{"items":[{"id":1},{"id":2},{"id":3}]}'))
        self.store.put("d2", loads('{"items":[{"id":7}]}'))
        self.store.create_index("by_id", "/items/*/id")
        before = self.store._version().indexes["by_id"]
        self.store.apply("d1", [{"op": "add", "path": "/items/0", "value": {"id": 9}}])
        entries = self.store.index_entries("by_id")
        self.assertEqual(
            entries,
            [("d1", "/items/0/id", value_key(9)),
             ("d1", "/items/1/id", value_key(1)),
             ("d1", "/items/2/id", value_key(2)),
             ("d1", "/items/3/id", value_key(3)),
             ("d2", "/items/0/id", value_key(7))],
        )
        self.assertEqual(self.store.index_count("by_id"), 5)
        self.assertEqual(self.store.query({"where": [{"eq": ["by_id", 1]}]}), ["d1"])
        # incremental: untouched document keeps the very same entry objects
        after = self.store._version().indexes["by_id"]
        self.assertIs(before.entries[value_key(7)], after.entries[value_key(7)])
        self.assertIs(before.by_doc["d2"], after.by_doc["d2"])

    def test_parent_move_updates_nested_wildcard(self):
        self.store.put("d1", loads(
            '{"top":{"src":{"a":{"v":1},"b":{"v":2}},"dst":{}}}'))
        self.store.create_index("wild", "/*/*/*/v")
        self.assertEqual(self.store.index_count("wild"), 2)
        self.store.apply("d1", [{"op": "move", "from": "/top/src", "path": "/top/dst"}])
        entries = self.store.index_entries("wild")
        self.assertEqual(
            entries,
            [("d1", "/top/dst/a/v", value_key(1)),
             ("d1", "/top/dst/b/v", value_key(2))],
        )
        self.assertEqual(self.store.query({"where": [{"eq": ["wild", 2]}]}), ["d1"])

    def test_remove_updates_index(self):
        self.store.put("d1", loads('{"items":[{"id":1},{"id":2}]}'))
        self.store.create_index("by_id", "/items/*/id")
        self.store.apply("d1", [{"op": "remove", "path": "/items/0"}])
        self.assertEqual(
            self.store.index_entries("by_id"),
            [("d1", "/items/0/id", value_key(2))],
        )

    def test_index_survives_reopen(self):
        self.store.put("d1", loads('{"n": 5}'))
        self.store.create_index("by_n", "/n")
        self.store.close()
        reopened = DocumentStore(self.tmp.name)
        self.assertEqual(reopened.query({"where": [{"eq": ["by_n", 5]}]}), ["d1"])
        reopened.close()


if __name__ == "__main__":
    unittest.main()
