import unittest

from sessionize import Sessionizer


def run(seq, gap=10, late=20):
    sz = Sessionizer(gap=gap, late=late)
    out = []
    for key, ts, ident in seq:
        out.extend(sz.add(key, ts, ident))
    return out


def for_key(out, key):
    res = []
    for r in out:
        if r["type"] == "RETRACT":
            sessions = [s for s in r["sessions"] if s["key"] == key]
            if sessions:
                res.append({**r, "sessions": sessions})
        elif r.get("key") == key:
            res.append(r)
    return res


class TestKeyIsolation(unittest.TestCase):
    def test_interleaved_keys_match_independent_runs(self):
        events_k1 = [("k1", 0, "a"), ("k1", 5, "b"),
                     ("k1", 100, "c"), ("k1", 1000, "d")]
        events_k2 = [("k2", 7, "p"), ("k2", 50, "q"),
                     ("k2", 60, "r"), ("k2", 5000, "s")]
        solo1 = run(events_k1)
        solo2 = run(events_k2)
        interleaved = run([
            events_k1[0], events_k2[0], events_k1[1], events_k2[1],
            events_k2[2], events_k1[2], events_k2[3], events_k1[3],
        ])
        self.assertEqual(for_key(interleaved, "k1"), solo1)
        self.assertEqual(for_key(interleaved, "k2"), solo2)

    def test_watermark_is_per_key(self):
        sz = Sessionizer(gap=10, late=20)
        sz.add("k1", 0, "a")
        sz.add("k2", 0, "p")
        out = sz.add("k1", 1000, "b")  # advances only k1's watermark
        self.assertTrue(
            any(r["type"] == "FINAL" and r["key"] == "k1" for r in out))
        self.assertFalse(any(r.get("key") == "k2" for r in out))
        self.assertEqual(sz.finals("k2"), [])


if __name__ == "__main__":
    unittest.main()
