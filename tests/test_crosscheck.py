"""Cross-check the store against an independent reference implementation.

Small random documents are patched through both the store and a naive
reference interpreter; queries, version numbers and index entry counts
must agree at every step.
"""
import copy
import random
import tempfile
import unittest
from decimal import Decimal

from jsondoc import DocumentStore, PatchError, json_equal, pointers
from tests import reference
from tests.reference import RefPatchError

PATTERNS = {
    "by_n": "/n",
    "by_d": "/d",
    "by_id": "/items/*/id",
    "by_v": "/*/v",
}


def gen_doc(rng, i):
    return {
        "name": "doc%d" % i,
        "n": rng.randint(0, 5),
        "d": Decimal(rng.choice(["0.5", "1.5", "2.5"])),
        "flag": rng.random() < 0.5,
        "items": [{"id": rng.randint(0, 9), "v": rng.randint(0, 3)}
                  for _ in range(rng.randint(0, 3))],
        "meta": {"v": rng.randint(0, 3), "tag": rng.choice(["x", "y"])},
    }


def all_paths(node, path, out):
    out.append((path, node))
    if isinstance(node, dict):
        for key, child in node.items():
            all_paths(child, path + [key], out)
    elif isinstance(node, list):
        for i, child in enumerate(node):
            all_paths(child, path + [str(i)], out)


def gen_scalar(rng):
    return rng.choice([None, True, False, 0, 1, 7,
                       Decimal("0.5"), Decimal("1.5"), "s", "t"])


def gen_op(rng, doc):
    paths = []
    all_paths(doc, [], paths)
    non_root = [(p, v) for p, v in paths if p]
    containers = [(p, v) for p, v in paths if isinstance(v, (dict, list))]
    kinds = ["replace", "test"]
    if containers:
        kinds += ["add", "add"]
    if non_root:
        kinds += ["remove", "move"]
    kind = rng.choice(kinds)
    if kind == "add":
        parent, value = rng.choice(containers)
        if isinstance(value, dict):
            target = parent + ["k%d" % rng.randint(0, 4)]
        else:
            target = parent + [rng.choice(["-", str(rng.randint(0, len(value)))])]
        return {"op": "add", "path": pointers.format(target), "value": gen_scalar(rng)}
    if kind == "remove":
        path, _ = rng.choice(non_root)
        return {"op": "remove", "path": pointers.format(path)}
    if kind == "replace":
        path, _ = rng.choice(paths)
        return {"op": "replace", "path": pointers.format(path),
                "value": gen_scalar(rng)}
    if kind == "move":
        src, _ = rng.choice(non_root)
        parent, value = rng.choice(containers)
        if isinstance(value, dict):
            target = parent + ["m%d" % rng.randint(0, 3)]
        else:
            target = parent + [str(rng.randint(0, len(value)))]
        return {"op": "move", "from": pointers.format(src),
                "path": pointers.format(target)}
    path, value = rng.choice(paths)
    test_value = copy.deepcopy(value)
    if rng.random() < 0.4:
        test_value = gen_scalar(rng)  # usually a mismatch -> failing test
    return {"op": "test", "path": pointers.format(path), "value": test_value}


class CrosscheckTests(unittest.TestCase):
    def test_randomized_against_reference(self):
        rng = random.Random(20261006)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = DocumentStore(tmp.name)
        self.addCleanup(store.close)
        ref_patterns = {name: pointers.parse(p) for name, p in PATTERNS.items()}

        ids = []
        docs = {}
        for i in range(3):
            doc_id = "doc%d" % i
            doc = gen_doc(rng, i)
            store.put(doc_id, doc)
            docs[doc_id] = copy.deepcopy(doc)
            ids.append(doc_id)
        for name, pattern in PATTERNS.items():
            store.create_index(name, pattern)
        version = store.latest
        self.assertEqual(version, 3)

        snap = store.snapshot()
        self.addCleanup(snap.close)
        snap_docs = copy.deepcopy(docs)

        eq_values = {
            "by_n": [0, 1, 2, 3, 4, 5, 7],
            "by_d": [Decimal("0.5"), Decimal("1.5"), Decimal("2.5"), 1, True],
            "by_id": list(range(10)),
            "by_v": [0, 1, 2, 3],
        }

        for step in range(60):
            doc_id = rng.choice(ids)
            ops = [gen_op(rng, docs[doc_id]) for _ in range(rng.randint(1, 3))]
            try:
                ref_new = reference.ref_apply(docs[doc_id], ops)
            except RefPatchError:
                with self.assertRaises(PatchError, msg="ops=%r" % (ops,)):
                    store.apply(doc_id, ops)
                self.assertEqual(store.latest, version)
                continue
            new_version = store.apply(doc_id, ops)
            version += 1
            self.assertEqual(new_version, version)
            docs[doc_id] = ref_new
            self.assertTrue(json_equal(store.get(doc_id), ref_new),
                            "ops=%r" % (ops,))
            for name in PATTERNS:
                self.assertEqual(
                    store.index_count(name),
                    reference.ref_index_count(docs, ref_patterns[name]),
                    "index %s count after ops=%r" % (name, ops),
                )
            for name, values in eq_values.items():
                for value in values:
                    q = {"where": [{"eq": [name, value]}]}
                    self.assertEqual(
                        store.query(q), reference.ref_query(docs, ref_patterns, q),
                        "query %r after ops=%r" % (q, ops),
                    )
            queries = [
                {"where": [{"exists": "/meta"}]},
                {"where": [{"exists": "/items/1"}]},
                {"where": [{"eq": ["by_v", rng.randint(0, 3)]},
                            {"exists": "/meta/tag"}]},
                {"order_by": "by_n"},
                {"order_by": "by_v"},
                {"where": [{"eq": ["by_id", rng.randint(0, 9)]}],
                 "order_by": "by_id"},
            ]
            for q in queries:
                self.assertEqual(
                    store.query(q), reference.ref_query(docs, ref_patterns, q),
                    "query %r after ops=%r" % (q, ops),
                )

        # the pinned snapshot still matches the reference state at its version
        for name in PATTERNS:
            self.assertEqual(
                snap.index_count(name),
                reference.ref_index_count(snap_docs, ref_patterns[name]),
            )
        snap_queries = [
            {"where": [{"eq": ["by_v", 0]}]},
            {"where": [{"eq": ["by_n", 2]}, {"exists": "/meta"}]},
            {"order_by": "by_n"},
            {"order_by": "by_d"},
        ]
        for q in snap_queries:
            self.assertEqual(
                snap.query(q), reference.ref_query(snap_docs, ref_patterns, q),
                "snapshot query %r" % (q,),
            )


if __name__ == "__main__":
    unittest.main()

