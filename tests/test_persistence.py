import json
import os
import tempfile
import unittest

from bagra import Engine


def as_map(result_list):
    return {tuple(row): count for row, count in result_list}


NODE_SPECS = [
    {"id": "r", "type": "scan", "table": "R"},
    {"id": "d", "type": "distinct", "inputs": ["r"]},
    {"id": "p", "type": "project", "inputs": ["d"], "columns": [0]},
]


def make_engine():
    eng = Engine()
    eng.add_table("R")
    for spec in NODE_SPECS:
        eng.add_node(spec)
    return eng


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "state.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_recovery_continues_version_without_republishing(self):
        eng = make_engine()
        eng.subscribe("p")
        eng.apply_batch({"R": [((1, "a"), 1), ((2, "b"), 1)]})
        eng.apply_batch({"R": [((1, "a"), -1)]})
        eng.save(self.path)
        log_before = list(eng.publish_log)

        restored = Engine.load(self.path)
        self.assertEqual(restored.version, eng.version)
        self.assertEqual(restored.publish_log, log_before)
        self.assertEqual(as_map(restored.result("p")), as_map(eng.result("p")))
        self.assertEqual(as_map(restored.result("d")), as_map(eng.result("d")))

        # new batches continue the version sequence; no record is re-published
        records = restored.apply_batch({"R": [((3, "c"), 1)]})
        self.assertEqual(restored.version, eng.version + 1)
        self.assertTrue(all(rec["version"] == restored.version for rec in records))
        versions = [rec["version"] for rec in restored.publish_log]
        self.assertEqual(versions, sorted(versions))
        seqs = [rec["seq"] for rec in restored.publish_log]
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))
        self.assertEqual(
            restored.publish_log[: len(log_before)], log_before,
            "replay must not duplicate or alter already-published records",
        )

    def test_recovery_preserves_subscriptions(self):
        eng = make_engine()
        sid = eng.subscribe("d")
        eng.apply_batch({"R": [((7,), 1)]})
        eng.save(self.path)
        restored = Engine.load(self.path)
        self.assertEqual(restored.subscriptions, {sid: "d"})
        records = restored.apply_batch({"R": [((8,), 1)]})
        self.assertEqual([rec["subscription"] for rec in records], [sid])

    def test_recovery_is_deterministic(self):
        eng = make_engine()
        eng.subscribe("p")
        eng.apply_batch({"R": [((2,), 1), ((1,), 1), ((1,), 1)]})
        eng.save(self.path)
        first = Engine.load(self.path)
        second = Engine.load(self.path)
        self.assertEqual(first.publish_log, second.publish_log)
        self.assertEqual(first.result("p"), second.result("p"))
        rec1 = first.apply_batch({"R": [((1,), -1)]})
        rec2 = second.apply_batch({"R": [((1,), -1)]})
        self.assertEqual(rec1, rec2)

    def test_save_is_atomic_json(self):
        eng = make_engine()
        eng.apply_batch({"R": [((1,), 1)]})
        eng.save(self.path)
        with open(self.path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        self.assertEqual(data["format"], 1)
        self.assertEqual(data["version"], 1)


if __name__ == "__main__":
    unittest.main()
