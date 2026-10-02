"""Tests for the sessionize library and CLI.

Semantics under test (per key):
  * adjacent events with gap <= --gap belong to one session; gap+1 splits
  * watermark WM = max_ts - late; only sessions with end + gap <= WM are final
  * events with ts < max_ts - late are dropped; legal late events are inserted
    and may merge existing sessions, retracting already-finalized ones
  * session = {key, start, end, count, ids}; ids = sha256 of sorted id concat
"""

import hashlib
import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from sessionize import ids_hash, process_events, sessionize


def reference_sessions(events, gap, late):
    """Brute-force reference: filter by lateness, merge ts intervals, keep final."""
    by_key = {}
    for event in events:
        by_key.setdefault(event["key"], []).append(event)
    result = []
    for key, key_events in by_key.items():
        accepted = []
        max_ts = None
        for event in key_events:
            if max_ts is not None and event["ts"] < max_ts - late:
                continue
            max_ts = event["ts"] if max_ts is None else max(max_ts, event["ts"])
            accepted.append(event)
        accepted.sort(key=lambda e: e["ts"])
        sessions = [[accepted[0]]]
        for event in accepted[1:]:
            if event["ts"] - sessions[-1][-1]["ts"] <= gap:
                sessions[-1].append(event)
            else:
                sessions.append([event])
        watermark = max_ts - late
        for sess in sessions:
            if sess[-1]["ts"] + gap <= watermark:
                result.append({
                    "key": key,
                    "start": sess[0]["ts"],
                    "end": sess[-1]["ts"],
                    "count": len(sess),
                    "ids": ids_hash(e["id"] for e in sess),
                })
    return sorted(result, key=lambda s: (s["key"], s["start"]))


def make_events(key, pairs):
    return [{"key": key, "ts": ts, "id": eid} for ts, eid in pairs]


class TestHash(unittest.TestCase):
    def test_ids_hash_sorted_concat_sha256(self):
        self.assertEqual(
            ids_hash(["b", "a", "c"]),
            hashlib.sha256(b"abc").hexdigest(),
        )
        self.assertEqual(ids_hash([]), hashlib.sha256(b"").hexdigest())
        self.assertEqual(ids_hash(["x"]), hashlib.sha256(b"x").hexdigest())


class TestGapBoundary(unittest.TestCase):
    def test_exact_gap_merges(self):
        events = make_events("k", [(0, "a"), (10, "b"), (30, "c")])
        result = sessionize(events, gap=10, late=0)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["start"], 0)
        self.assertEqual(result[0]["end"], 10)
        self.assertEqual(result[0]["count"], 2)
        self.assertEqual(result[0]["ids"], ids_hash(["a", "b"]))

    def test_gap_plus_one_splits(self):
        events = make_events("k", [(0, "a"), (11, "b"), (22, "c")])
        result = sessionize(events, gap=10, late=0)
        self.assertEqual(
            [(s["start"], s["end"], s["count"]) for s in result],
            [(0, 0, 1), (11, 11, 1)],
        )

    def test_same_ts_multiple_events_count_individually(self):
        events = make_events("k", [(0, "a"), (0, "b"), (0, "c"), (10, "d")])
        result = sessionize(events, gap=5, late=0)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["count"], 3)
        self.assertEqual(result[0]["start"], 0)
        self.assertEqual(result[0]["end"], 0)
        self.assertEqual(result[0]["ids"], ids_hash(["a", "b", "c"]))


class TestLateness(unittest.TestCase):
    def test_beyond_lateness_dropped(self):
        events = make_events(
            "k", [(100, "a"), (89, "dropped"), (90, "b"), (200, "c")]
        )
        result = sessionize(events, gap=5, late=10)
        # 89 < 100 - 10 -> dropped; 90 >= 90 -> accepted
        spans = sorted((s["start"], s["end"], s["count"]) for s in result)
        self.assertEqual(spans, [(90, 90, 1), (100, 100, 1)])
        for sess in result:
            self.assertNotIn(hashlib.sha256(b"dropped").hexdigest(), sess["ids"])

    def test_late_bridge_retracts_final_session(self):
        # One legal late event bridges three segments (final session, itself,
        # open session); the already-final session is retracted and the merged
        # session is re-added once final.
        events = make_events(
            "k", [(0, "a"), (15, "b"), (30, "c"), (10, "x"), (45, "d")]
        )
        outputs = process_events(events, gap=10, late=20)
        types = [o["type"] for o in outputs]
        self.assertEqual(types, ["ADD", "RETRACT", "ADD"])

        first_add, retract, second_add = outputs
        # finalized [0,0] once watermark reaches 10 (max_ts=30, late=20)
        self.assertEqual(
            first_add["session"],
            {"key": "k", "start": 0, "end": 0, "count": 1,
             "ids": ids_hash(["a"])},
        )
        # late event ts=10 >= 30-20 bridges final [0,0] and open [15,15]
        self.assertEqual(retract["session"], first_add["session"])
        # merged session re-emitted once final (watermark 45-20=25 >= 15+10)
        self.assertEqual(
            second_add["session"],
            {"key": "k", "start": 0, "end": 15, "count": 3,
             "ids": ids_hash(["a", "b", "x"])},
        )
        # net live set is just the merged session
        self.assertEqual(sessionize(events, gap=10, late=20),
                         [second_add["session"]])

    def test_late_event_extends_final_session(self):
        events = make_events("k", [(0, "a"), (20, "b"), (10, "x"), (100, "c")])
        outputs = process_events(events, gap=10, late=10)
        types = [o["type"] for o in outputs]
        self.assertEqual(types, ["ADD", "RETRACT", "ADD"])
        self.assertEqual(outputs[0]["session"], outputs[1]["session"])
        self.assertEqual(outputs[2]["session"]["start"], 0)
        self.assertEqual(outputs[2]["session"]["end"], 20)
        self.assertEqual(outputs[2]["session"]["count"], 3)


class TestKeyIndependence(unittest.TestCase):
    def test_keys_do_not_interfere(self):
        events = (
            make_events("a", [(10000, "a1")])
            + make_events("b", [(0, "b1"), (5, "b2"), (100, "b3")])
            + make_events("a", [(10005, "a2"), (20000, "a3")])
        )
        # interleave to make it interesting
        interleaved = [events[0], events[1], events[4], events[2],
                       events[5], events[3]]
        result = sessionize(interleaved, gap=10, late=0)
        by_key = {}
        for sess in result:
            by_key.setdefault(sess["key"], []).append(sess)
        # key b: watermark 100 -> session [0,5] final, count 2
        self.assertEqual(
            [(s["start"], s["end"], s["count"]) for s in by_key["b"]],
            [(0, 5, 2)],
        )
        # key a: watermark 20000 -> [10000,10005] final
        self.assertEqual(
            [(s["start"], s["end"], s["count"]) for s in by_key["a"]],
            [(10000, 10005, 2)],
        )
        # per-key processing of the interleaved stream equals separate runs
        for key in ("a", "b"):
            separate = sessionize(
                [e for e in interleaved if e["key"] == key], gap=10, late=0
            )
            self.assertEqual(by_key[key], separate)


class TestExhaustiveSmallDomain(unittest.TestCase):
    """n <= 5 events per key over a tiny ts domain: compare against the
    brute-force interval-merge reference for every possible event sequence."""

    def check_domain(self, ts_domain, max_len, gap, late):
        cases = 0
        for length in range(1, max_len + 1):
            for seq in itertools.product(ts_domain, repeat=length):
                events = make_events("k", [(ts, f"e{i}") for i, ts in enumerate(seq)])
                self.assertEqual(
                    sessionize(events, gap, late),
                    reference_sessions(events, gap, late),
                    msg=f"gap={gap} late={late} seq={seq}",
                )
                cases += 1
        return cases

    def test_domain_gap2_late1(self):
        cases = self.check_domain([0, 1, 2, 3], 5, gap=2, late=1)
        self.assertEqual(cases, 4 + 16 + 64 + 256 + 1024)

    def test_domain_gap3_late2(self):
        self.check_domain([0, 1, 2, 3], 4, gap=3, late=2)


class TestExhaustiveSubsetsN8(unittest.TestCase):
    """All 2^8 subsets of an 8-event pool, each in several arrival orders."""

    POOL_TS = [0, 2, 5, 9, 14, 20, 27, 35]

    def test_all_subsets_and_orders(self):
        gap, late = 4, 3
        pool = make_events("k", list(zip(self.POOL_TS, [f"e{i}" for i in range(8)])))
        rng = random.Random(42)
        cases = 0
        for mask in range(1, 1 << 8):
            subset = [pool[i] for i in range(8) if mask & (1 << i)]
            orders = [subset, list(reversed(subset))]
            for _ in range(2):
                shuffled = subset[:]
                rng.shuffle(shuffled)
                orders.append(shuffled)
            for events in orders:
                self.assertEqual(
                    sessionize(events, gap, late),
                    reference_sessions(events, gap, late),
                    msg=f"mask={mask} events={events}",
                )
                cases += 1
        self.assertEqual(cases, 255 * 4)


class TestRandomizedMultiKey(unittest.TestCase):
    def test_random_streams_match_reference(self):
        rng = random.Random(2024)
        for trial in range(300):
            keys = [f"k{i}" for i in range(rng.randint(1, 3))]
            gap = rng.randint(0, 6)
            late = rng.randint(0, 6)
            events = [
                {"key": rng.choice(keys), "ts": rng.randint(0, 30), "id": f"id{j}"}
                for j in range(rng.randint(1, 12))
            ]
            self.assertEqual(
                sessionize(events, gap, late),
                reference_sessions(events, gap, late),
                msg=f"trial={trial} gap={gap} late={late} events={events}",
            )


class TestCli(unittest.TestCase):
    def run_cli(self, args, cwd=None):
        return subprocess.run(
            [sys.executable, "-m", "sessionize"] + args,
            capture_output=True,
            text=True,
            cwd=cwd,
        )

    def write_jsonl(self, directory, name, records):
        path = os.path.join(directory, name)
        with open(path, "w", encoding="utf-8") as handle:
            for record in records:
                if isinstance(record, str):
                    handle.write(record + "\n")
                else:
                    handle.write(json.dumps(record) + "\n")
        return path

    def test_cli_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = self.write_jsonl(tmp, "e.jsonl", [
                {"key": "k", "ts": 0, "id": "a"},
                {"key": "k", "ts": 15, "id": "b"},
                {"key": "k", "ts": 30, "id": "c"},
                {"key": "k", "ts": 10, "id": "x"},
                {"key": "k", "ts": 45, "id": "d"},
            ])
            proc = self.run_cli(["--in", src, "--gap", "10", "--late", "20"])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            records = [json.loads(line) for line in proc.stdout.splitlines()]
            self.assertEqual([r["type"] for r in records],
                             ["ADD", "RETRACT", "ADD"])
            self.assertEqual(records[0]["session"], records[1]["session"])
            self.assertEqual(records[2]["session"]["count"], 3)
            self.assertEqual(records[2]["session"]["ids"],
                             ids_hash(["a", "b", "x"]))

    def test_cli_out_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = self.write_jsonl(tmp, "e.jsonl",
                                   [{"key": "k", "ts": 0, "id": "a"}])
            out = os.path.join(tmp, "out.jsonl")
            proc = self.run_cli(["--in", src, "--gap", "1", "--late", "0",
                                 "--out", out])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout, "")
            with open(out, encoding="utf-8") as handle:
                self.assertEqual(len(handle.readlines()), 0)  # nothing final yet

    def test_cli_missing_id_exit2(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = self.write_jsonl(tmp, "bad.jsonl",
                                   [{"key": "k", "ts": 0}])
            proc = self.run_cli(["--in", src, "--gap", "10", "--late", "0"])
            self.assertEqual(proc.returncode, 2)
            self.assertIn("'id'", proc.stderr)

    def test_cli_invalid_json_exit2(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = self.write_jsonl(tmp, "bad.jsonl", ["{not json"])
            proc = self.run_cli(["--in", src, "--gap", "10", "--late", "0"])
            self.assertEqual(proc.returncode, 2)

    def test_cli_missing_file_exit1(self):
        proc = self.run_cli(["--in", "/nonexistent/e.jsonl",
                             "--gap", "10", "--late", "0"])
        self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
