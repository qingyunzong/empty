import hashlib
import unittest

from sessionize import Sessionizer

GAP = 30000
LATE = 5000


def feed(sz, events):
    out = []
    for key, ts, ident in events:
        out.extend(sz.add(key, ts, ident))
    return out


class TestLateMergeRetract(unittest.TestCase):
    """Retraction semantics for legal late events.

    Scenario: three sessions S1, S2, S3 are all emitted as FINAL, then one
    late event bridges two of them (a single event can bridge at most two
    existing sessions, because any two neighbouring sessions are separated
    by more than ``gap``).  The bridged sessions are retracted and replaced
    by one ADD record; the third FINAL session is untouched.
    """

    def setUp(self):
        self.sz = Sessionizer(gap=GAP, late=LATE)
        self.out = feed(self.sz, [
            ("k", 0, "a"), ("k", 1000, "b"),   # S1 = [0, 1000]
            ("k", 40000, "c"),                 # S2 = [40000, 40000]
            ("k", 150000, "d"),                # S3 = [150000, 150000]
            ("k", 200000, "z"),                # maxts=200000 -> wm=195000
        ])

    def test_three_sessions_finalized(self):
        finals = [r for r in self.out if r["type"] == "FINAL"]
        self.assertEqual(
            [(f["start"], f["end"]) for f in finals],
            [(0, 1000), (40000, 40000), (150000, 150000)])
        # the tail session [200000] is still open: 200000+30000 > 195000
        self.assertEqual(
            [(s.start, s.end) for s in self.sz.finals("k")],
            [(0, 1000), (40000, 40000), (150000, 150000)])

    def test_late_event_bridges_final_sessions(self):
        # 20000 < wm = 195000: late, but legal (merges S1 and S2).
        out = self.sz.add("k", 20000, "x")
        self.assertEqual([r["type"] for r in out], ["RETRACT", "ADD"])

        retracted = [(s["start"], s["end"]) for s in out[0]["sessions"]]
        self.assertEqual(retracted, [(0, 1000), (40000, 40000)])

        added = out[1]
        self.assertEqual(
            (added["key"], added["start"], added["end"], added["count"]),
            ("k", 0, 40000, 4))
        self.assertEqual(added["ids"], hashlib.sha256(b"abcx").hexdigest())

        # the merged session is itself final; S3 was never retracted
        self.assertEqual(
            [(s.start, s.end) for s in self.sz.finals("k")],
            [(0, 40000), (150000, 150000)])

    def test_excessively_late_event_dropped(self):
        # 100000 < wm = 195000 and merges no existing session: dropped.
        out = self.sz.add("k", 100000, "y")
        self.assertEqual([r["type"] for r in out], ["DROP"])
        self.assertEqual(out[0]["id"], "y")
        # state is unchanged
        self.assertEqual(
            [(s.start, s.end) for s in self.sz.sessions("k")],
            [(0, 1000), (40000, 40000), (150000, 150000), (200000, 200000)])

    def test_late_event_merging_open_session_needs_no_retract(self):
        # late (190000 < wm = 195000) but merges only the open tail
        # session [200000]: silent merge, no RETRACT/FINAL output.
        out = self.sz.add("k", 190000, "w")
        self.assertEqual(out, [])
        self.assertEqual(
            [(s.start, s.end) for s in self.sz.sessions("k")][-2:],
            [(150000, 150000), (190000, 200000)])


if __name__ == "__main__":
    unittest.main()
