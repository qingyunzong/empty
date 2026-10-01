"""Acceptance (d): randomized small workloads cross-checked against an
exhaustive reference implementation (tests/reference.py).

For every generated workload we verify, independently of sched internals:

* the round count equals the brute-force minimum over all legal round
  assignments;
* the schedule is a partition of all operations, preserves every
  transaction's internal order, and never places conflicting operations
  in the same round;
* the schedule follows the canonical tie-break (earliest feasible round,
  lexicographic listing);
* the final key/value state equals the final state of *every* legal
  serial interleaving (enumerated exhaustively);
* for workloads with a cyclic precedence graph, the reported cycle is a
  genuine loop in the transaction precedence graph.
"""

from __future__ import annotations

import random
import unittest

from sched import NON_SERIALIZABLE, schedule_transactions

from tests.reference import (
    all_topological_orders,
    build_predecessors,
    exhaustive_min_rounds,
    get_op,
    op_list,
    ops_conflict,
    parallel_final_state,
    serial_final_state,
    txn_precedence_edges,
)

KEYS = ("x", "y", "z")


def random_transactions(rng):
    n_txns = rng.randint(1, 3)
    transactions = []
    for t in range(n_txns):
        ops = []
        for _ in range(rng.randint(1, 3)):
            op = {"type": rng.choice(["read", "write"]), "key": rng.choice(KEYS)}
            if op["type"] == "write":
                op["value"] = rng.randint(0, 99)
            ops.append(op)
        transactions.append({"id": f"T{t + 1}", "ops": ops})
    return transactions


def random_order(rng, transactions):
    # A random interleaving that preserves every transaction's internal
    # operation order (a legal serial schedule of the workload).
    pools = [
        [(txn["id"], i) for i in range(len(txn["ops"]))] for txn in transactions
    ]
    pools = [pool for pool in pools if pool]
    order = []
    while pools:
        pool = rng.choice(pools)
        order.append([*pool.pop(0)])
        if not pool:
            pools.remove(pool)
    return order


class RandomizedCrossCheckTest(unittest.TestCase):
    CASES_PER_MODE = 1000

    def check_valid_schedule(self, transactions, order, result):
        preds = build_predecessors(transactions, order)
        rounds = result["rounds"]

        # Partition: every operation scheduled exactly once.
        scheduled = sorted((t, i) for rnd in rounds for t, i in rnd)
        self.assertEqual(scheduled, sorted(op_list(transactions)))

        round_of = {}
        for rnd, ops in enumerate(rounds):
            for ref in ops:
                round_of[tuple(ref)] = rnd

        # Every precedence edge goes to a strictly later round.  This
        # covers intra-transaction order and conflict separation.
        for ref, before in preds.items():
            for other in before:
                self.assertLess(round_of[other], round_of[ref])

        # Same-round operations are pairwise non-conflicting.
        for rnd in rounds:
            for i, first in enumerate(rnd):
                for second in rnd[i + 1:]:
                    self.assertFalse(
                        ops_conflict(
                            get_op(transactions, tuple(first)),
                            get_op(transactions, tuple(second)),
                        )
                    )

        # Canonical tie-break: earliest feasible round per operation and
        # lexicographic (txn_id, op_index) listing inside each round.
        for ref, before in preds.items():
            expected = 0 if not before else max(round_of[p] for p in before) + 1
            self.assertEqual(round_of[ref], expected)
        for rnd in rounds:
            self.assertEqual(rnd, sorted(rnd, key=lambda r: (r[0], r[1])))

        # Minimal rounds vs. exhaustive search over all assignments.
        self.assertEqual(result["num_rounds"], exhaustive_min_rounds(preds))

        # Final state equals the reference serial execution and every
        # legal interleaving (conflict-equivalence check).
        produced = parallel_final_state(transactions, rounds)
        self.assertEqual(produced, serial_final_state(transactions, order))
        for topo in all_topological_orders(preds):
            state = {}
            for ref in topo:
                op = get_op(transactions, ref)
                if op["type"] == "write":
                    state[op["key"]] = op.get("value")
            self.assertEqual(state, produced)

    def check_cycle(self, transactions, order, result):
        edges = txn_precedence_edges(transactions, order)
        cycle = result["cycle"]
        self.assertGreaterEqual(len(cycle), 2)
        self.assertEqual(len(set(cycle)), len(cycle))
        for before, after in zip(cycle, cycle[1:] + cycle[:1]):
            self.assertIn((before, after), edges)

    def run_cases(self, seed, use_explicit_order):
        rng = random.Random(seed)
        for case in range(self.CASES_PER_MODE):
            transactions = random_transactions(rng)
            order = random_order(rng, transactions) if use_explicit_order else None
            result = schedule_transactions(transactions, order=order)
            with self.subTest(seed=seed, case=case, order=order):
                if result.get("error") == NON_SERIALIZABLE:
                    self.assertTrue(use_explicit_order)
                    self.check_cycle(transactions, order, result)
                else:
                    self.check_valid_schedule(transactions, order, result)

    def test_default_serial_reference_order(self):
        self.run_cases(seed=20261001, use_explicit_order=False)

    def test_random_explicit_reference_orders(self):
        self.run_cases(seed=20261002, use_explicit_order=True)


if __name__ == "__main__":
    unittest.main()
