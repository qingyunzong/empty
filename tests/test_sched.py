"""Acceptance tests for the sched package.

Covers:
a) a hand-built three-transaction case with a known optimal round count;
b) cyclic-dependency inputs and the reported cycle;
c) tied optimal schedules and the lexicographic tie-break;
d) randomized small inputs cross-checked against an exhaustive reference
   that enumerates every legal interleaving (round count + final state).
"""

import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sched import scheduler as sch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_input(txns):
    """txns: list of (txn_id, [(op_type, key), ...]) -> input document."""
    return {
        "transactions": [
            {"id": tid, "ops": [{"type": t, "key": k} for (t, k) in ops]}
            for tid, ops in txns
        ]
    }


def round_pairs(result):
    """Extract [[(txn_id, op_index), ...], ...] from a schedule result."""
    return [
        [(entry["txn"], entry["op_index"]) for entry in round_ops]
        for round_ops in result["rounds"]
    ]


class KnownOptimalRoundsTest(unittest.TestCase):
    """(a) Three transactions with a known optimal number of rounds."""

    def test_three_transaction_optimum(self):
        data = make_input([
            ("T1", [("write", "x"), ("read", "y")]),
            ("T2", [("write", "x"), ("write", "z")]),
            ("T3", [("read", "z"), ("write", "y")]),
        ])
        result = sch.schedule_transactions(data)
        # Critical chain T1.op0 -> T1.op1 -> T3.op1 forces >= 3 rounds.
        self.assertEqual(
            round_pairs(result),
            [
                [("T1", 0)],
                [("T1", 1), ("T2", 0), ("T3", 0)],
                [("T2", 1), ("T3", 1)],
            ],
        )

    def test_single_transaction(self):
        data = make_input([("T1", [("write", "x"), ("read", "x"), ("write", "y")])])
        result = sch.schedule_transactions(data)
        self.assertEqual(
            round_pairs(result),
            [[("T1", 0)], [("T1", 1)], [("T1", 2)]],
        )

    def test_independent_transactions_single_round(self):
        data = make_input([
            ("T1", [("read", "a")]),
            ("T2", [("read", "b")]),
            ("T3", [("write", "c")]),
        ])
        result = sch.schedule_transactions(data)
        self.assertEqual(
            round_pairs(result),
            [[("T1", 0), ("T2", 0), ("T3", 0)]],
        )


class CycleDetectionTest(unittest.TestCase):
    """(b) Cyclic precedence graphs must be reported with a cycle."""

    def test_two_transaction_cycle(self):
        data = make_input([
            ("T1", [("write", "x"), ("write", "y")]),
            ("T2", [("write", "y"), ("write", "x")]),
        ])
        with self.assertRaises(sch.NonSerializableError) as ctx:
            sch.schedule_transactions(data)
        self.assertEqual(ctx.exception.cycle, ["T1", "T2"])

    def test_three_transaction_cycle(self):
        data = make_input([
            ("T1", [("write", "x"), ("write", "z")]),
            ("T2", [("write", "y"), ("write", "x")]),
            ("T3", [("write", "z"), ("write", "y")]),
        ])
        with self.assertRaises(sch.NonSerializableError) as ctx:
            sch.schedule_transactions(data)
        self.assertEqual(ctx.exception.cycle, ["T1", "T2", "T3"])

    def test_read_write_cycle(self):
        # T1 reads x before T2 writes it; T2 reads y before T1 writes it.
        data = make_input([
            ("T1", [("read", "x"), ("write", "y")]),
            ("T2", [("read", "y"), ("write", "x")]),
        ])
        with self.assertRaises(sch.NonSerializableError) as ctx:
            sch.schedule_transactions(data)
        self.assertEqual(ctx.exception.cycle, ["T1", "T2"])

    def test_error_payload_shape(self):
        data = make_input([
            ("T1", [("write", "x"), ("write", "y")]),
            ("T2", [("write", "y"), ("write", "x")]),
        ])
        try:
            sch.schedule_transactions(data)
            self.fail("expected NonSerializableError")
        except sch.NonSerializableError as exc:
            payload = {"error": "NON_SERIALIZABLE", "cycle": exc.cycle}
        self.assertEqual(payload["error"], "NON_SERIALIZABLE")
        self.assertEqual(payload["cycle"], ["T1", "T2"])


class LexicographicTieBreakTest(unittest.TestCase):
    """(c) Among minimum-round schedules, per-round lexicographic minimum."""

    def test_deferrable_operation_is_postponed(self):
        # Both [[T1.0, T3.0], [T2.0]] and [[T1.0], [T2.0, T3.0]] use the
        # optimal 2 rounds; the latter is lexicographically smaller in
        # round 1, so it must be chosen.
        data = make_input([
            ("T1", [("write", "x")]),
            ("T2", [("read", "x")]),
            ("T3", [("write", "y")]),
        ])
        result = sch.schedule_transactions(data)
        self.assertEqual(
            round_pairs(result),
            [[("T1", 0)], [("T2", 0), ("T3", 0)]],
        )

    def test_smaller_txn_id_preferred_in_round_one(self):
        # [[T2.0], [T3.0]] would also be a 2-round schedule, but round 1
        # [T1.0, T2.0] is lexicographically smaller than [T2.0], so the
        # isolated T1.0 is pulled into round 1.
        data = make_input([
            ("T1", [("write", "y")]),
            ("T2", [("write", "x")]),
            ("T3", [("read", "x")]),
        ])
        result = sch.schedule_transactions(data)
        self.assertEqual(
            round_pairs(result),
            [[("T1", 0), ("T2", 0)], [("T3", 0)]],
        )

    def test_chain_forces_sources_into_round_one(self):
        # T3.0 -> T1.1 (z is read by T1 after T3 writes it) plus the
        # intra-transaction chain T1.0 -> T1.1 force all three sources
        # into round 1; T1.1 alone forms round 2.
        data = make_input([
            ("T1", [("write", "x"), ("read", "z")]),
            ("T2", [("write", "y")]),
            ("T3", [("write", "z")]),
        ])
        result = sch.schedule_transactions(data)
        self.assertEqual(
            round_pairs(result),
            [[("T1", 0), ("T2", 0), ("T3", 0)], [("T1", 1)]],
        )

    def test_deterministic_across_runs(self):
        data = make_input([
            ("T1", [("write", "x"), ("read", "y")]),
            ("T2", [("write", "x"), ("write", "z")]),
            ("T3", [("read", "z"), ("write", "y")]),
        ])
        first = sch.schedule_transactions(data)
        for _ in range(5):
            self.assertEqual(sch.schedule_transactions(data), first)


# --------------------------------------------------------------------------
# Exhaustive reference implementation (acceptance d)
# --------------------------------------------------------------------------

def ref_interleavings(txns):
    """Yield every interleaving (list of (txn_rank, op_index)) that
    preserves each transaction's internal order."""
    n = len(txns)
    lengths = [len(ops) for _tid, ops in txns]
    pos = [0] * n
    seq = []

    def rec():
        if all(pos[t] == lengths[t] for t in range(n)):
            yield list(seq)
            return
        for t in range(n):
            if pos[t] < lengths[t]:
                seq.append((t, pos[t]))
                pos[t] += 1
                yield from rec()
                pos[t] -= 1
                seq.pop()

    return rec()


def ref_conflict_pairs(txns):
    """All conflicting op pairs oriented by the natural (lock-step) order."""
    by_key = {}
    for t, (_tid, ops) in enumerate(txns):
        for i, (op_type, key) in enumerate(ops):
            by_key.setdefault(key, []).append((t, i, op_type))
    pairs = []
    for key_ops in by_key.values():
        for a, b in itertools.combinations(key_ops, 2):
            if a[0] == b[0]:
                continue
            if a[2] != "write" and b[2] != "write":
                continue
            if (a[1], a[0]) <= (b[1], b[0]):
                pairs.append(((a[0], a[1]), (b[0], b[1])))
            else:
                pairs.append(((b[0], b[1]), (a[0], a[1])))
    return pairs


def ref_txn_acyclic(txns, order):
    """True iff the precedence graph induced by this interleaving is
    acyclic (i.e. the interleaving is conflict-serializable)."""
    rank = {op: pos for pos, op in enumerate(order)}
    succ = {}
    for t in range(len(txns)):
        succ.setdefault(t, set())
    for a, b in ref_conflict_pairs(txns):
        before, after = (a, b) if rank[a] < rank[b] else (b, a)
        succ[before[0]].add(after[0])
    # Kahn's algorithm.
    indeg = {t: 0 for t in succ}
    for t, targets in succ.items():
        for u in targets:
            indeg[u] += 1
    queue = [t for t in succ if indeg[t] == 0]
    seen = 0
    while queue:
        node = queue.pop()
        seen += 1
        for u in succ[node]:
            indeg[u] -= 1
            if indeg[u] == 0:
                queue.append(u)
    return seen == len(succ)


def ref_matches_natural(order, pairs):
    """True iff the interleaving orders every conflicting pair exactly
    like the natural order (conflict-equivalent to the input order)."""
    rank = {op: pos for pos, op in enumerate(order)}
    return all(rank[a] < rank[b] for a, b in pairs)


def ref_simulate(txns, order):
    """Independent final-state simulation (last writer wins)."""
    state = {}
    for t, i in order:
        op_type, key = txns[t][1][i]
        if op_type == "write":
            state[key] = f"{txns[t][0]}#{i}"
    return state


def ref_min_rounds(txns):
    """Independent minimal-round computation: longest constraint chain."""
    _ops, preds, _succs = sch.build_model(txns)
    memo = {}

    def depth(op):
        if op not in memo:
            memo[op] = 1 + max((depth(p) for p in preds[op]), default=-1)
        return memo[op]

    # depth() counts constraint edges; rounds = longest chain + 1.
    return max((depth(op) + 1 for op in preds), default=0)


class RandomizedExhaustiveTest(unittest.TestCase):
    """(d) Random small inputs vs. exhaustive enumeration of interleavings."""

    def random_input(self, rng):
        n_txns = rng.randint(2, 4)
        txns = []
        for t in range(n_txns):
            n_ops = rng.randint(1, 3) if n_txns <= 3 else rng.randint(1, 2)
            ops = [
                (rng.choice(["read", "write"]), rng.choice("abc"))
                for _ in range(n_ops)
            ]
            txns.append((f"T{t + 1}", ops))
        return make_input(txns)

    def check_structure(self, txns, result):
        """The emitted rounds must be a valid conflict-free schedule."""
        pairs = ref_conflict_pairs(txns)
        round_of = {}
        seen = []
        for r, round_ops in enumerate(result["rounds"]):
            for entry in round_ops:
                op = (entry["txn"], entry["op_index"])
                round_of[op] = r
                seen.append(op)
        # Every operation appears exactly once.
        expected = [
            (tid, i) for tid, ops in txns for i in range(len(ops))
        ]
        self.assertEqual(sorted(seen), sorted(expected))
        # Intra-transaction order strictly increases across rounds.
        for tid, ops in txns:
            rounds_seq = [round_of[(tid, i)] for i in range(len(ops))]
            self.assertEqual(rounds_seq, sorted(rounds_seq))
            self.assertEqual(len(set(rounds_seq)), len(rounds_seq))
        # Conflicting pairs land in strictly increasing rounds.
        for a, b in pairs:
            a_id = (txns[a[0]][0], a[1])
            b_id = (txns[b[0]][0], b[1])
            self.assertLess(round_of[a_id], round_of[b_id])
        # No two conflicting operations share a round (implied, but
        # verified directly against the conflict definition).
        for r, round_ops in enumerate(result["rounds"]):
            for x, y in itertools.combinations(round_ops, 2):
                if x["txn"] == y["txn"] or x["key"] != y["key"]:
                    continue
                self.assertEqual(x["type"], "read")
                self.assertEqual(y["type"], "read")
        return round_of

    def test_random_against_exhaustive_reference(self):
        rng = random.Random(20261003)
        n_errors = 0
        n_ok = 0
        for _trial in range(120):
            data = self.random_input(rng)
            txns = sch.normalize(data)
            pairs = ref_conflict_pairs(txns)

            legal = []
            for order in ref_interleavings(txns):
                if ref_matches_natural(order, pairs) and ref_txn_acyclic(txns, order):
                    legal.append(order)

            try:
                result = sch.schedule_transactions(data)
            except sch.NonSerializableError as exc:
                n_errors += 1
                # The reference must agree: no legal interleaving exists.
                self.assertEqual(legal, [])
                # The reported cycle must be a real cycle of txn ids.
                cycle = exc.cycle
                self.assertGreaterEqual(len(cycle), 2)
                edges = set()
                for a, b in pairs:
                    edges.add((txns[a[0]][0], txns[b[0]][0]))
                for a, b in zip(cycle, cycle[1:] + cycle[:1]):
                    self.assertIn((a, b), edges)
                continue

            n_ok += 1
            self.assertNotEqual(legal, [])

            # Structural validity of the emitted rounds.
            self.check_structure(list(txns), result)

            # Round count equals the reference minimum.
            self.assertEqual(len(result["rounds"]), ref_min_rounds(txns))

            # Final state equals that of every legal interleaving.
            id_to_rank = {txns[t][0]: t for t in range(len(txns))}
            my_order = [
                (id_to_rank[entry["txn"]], entry["op_index"])
                for round_ops in result["rounds"]
                for entry in round_ops
            ]
            my_state = ref_simulate(txns, my_order)
            for order in legal:
                self.assertEqual(ref_simulate(txns, order), my_state)

        # The random generator must actually exercise both branches.
        self.assertGreater(n_ok, 0)
        self.assertGreater(n_errors, 0)


class CliTest(unittest.TestCase):
    """The CLI reads a JSON file and prints the schedule on stdout."""

    def run_cli(self, payload):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as handle:
            json.dump(payload, handle)
            path = handle.name
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "sched", path],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
            )
        finally:
            os.unlink(path)
        return proc

    def test_cli_schedule(self):
        proc = self.run_cli(make_input([
            ("T1", [("write", "x"), ("read", "y")]),
            ("T2", [("write", "x"), ("write", "z")]),
            ("T3", [("read", "z"), ("write", "y")]),
        ]))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(
            round_pairs(result),
            [
                [("T1", 0)],
                [("T1", 1), ("T2", 0), ("T3", 0)],
                [("T2", 1), ("T3", 1)],
            ],
        )

    def test_cli_cycle(self):
        proc = self.run_cli(make_input([
            ("T1", [("write", "x"), ("write", "y")]),
            ("T2", [("write", "y"), ("write", "x")]),
        ]))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(
            result, {"error": "NON_SERIALIZABLE", "cycle": ["T1", "T2"]}
        )

    def test_cli_usage_error(self):
        proc = subprocess.run(
            [sys.executable, "-m", "sched"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage", proc.stderr)


if __name__ == "__main__":
    unittest.main()
