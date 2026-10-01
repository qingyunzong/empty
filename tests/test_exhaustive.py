"""Exhaustive comparison against a reference serializability oracle.

For every pair of transactions with at most three operations each (reads and
writes over keys {x, y}), and for both commit orders, the SSI engine's abort
decision for the second committer is compared against a reference checker
that decides serializability by enumerating all serial orders of the two
transactions.

Expected outcomes for the second committer:
  * WRITE_CONFLICT        - both transactions write the same key
                            (first-committer-wins);
  * SERIALIZATION_FAILURE - the both-committed execution is not serializable
                            per the reference oracle;
  * OK                    - otherwise.
"""

import itertools
import unittest

from ssi import Engine, SerializationFailure, WriteConflict

INITIAL = {"x": 0, "y": 0}
OPS = [("r", "x"), ("r", "y"), ("w", "x", 1), ("w", "y", 1)]
MAX_OPS = 3


def all_programs(max_len=MAX_OPS):
    programs = []
    for length in range(max_len + 1):
        programs.extend(itertools.product(OPS, repeat=length))
    return programs


def writes_of(program):
    return {op[1] for op in program if op[0] == "w"}


def final_db(programs):
    """Committed state if every transaction commits (write sets disjoint)."""
    db = dict(INITIAL)
    for program in programs:
        for op in program:
            if op[0] == "w":
                db[op[1]] = op[2]
    return db


def is_serializable(programs, observed_reads, db_after):
    """Reference oracle: True iff some serial order of the transactions
    reproduces every observed read and the final committed state."""
    for perm in itertools.permutations(range(len(programs))):
        db = dict(INITIAL)
        ok = True
        for idx in perm:
            reads = iter(observed_reads[idx])
            for op in programs[idx]:
                if op[0] == "r":
                    if db.get(op[1]) != next(reads):
                        ok = False
                        break
                else:
                    db[op[1]] = op[2]
            if not ok:
                break
        if ok and db == db_after:
            return True
    return False


def run_engine(p1, p2, commit_order):
    """Execute both programs concurrently; return (first, second) commit
    outcomes as 'OK' / 'WRITE_CONFLICT' / 'SERIALIZATION_FAILURE'."""
    engine = Engine(INITIAL)
    tids = [engine.begin(), engine.begin()]
    for tid, program in zip(tids, (p1, p2)):
        for op in program:
            if op[0] == "r":
                engine.read(tid, op[1])
            else:
                engine.write(tid, op[1], op[2])
    outcomes = {}
    for pos in commit_order:
        try:
            engine.commit(tids[pos])
            outcomes[pos] = "OK"
        except WriteConflict:
            outcomes[pos] = "WRITE_CONFLICT"
        except SerializationFailure:
            outcomes[pos] = "SERIALIZATION_FAILURE"
    return outcomes


def observed_reads(program, begin_ts, committed):
    """Reads a transaction would observe under snapshot isolation."""
    writes = {}
    reads = []
    for op in program:
        if op[0] == "r":
            key = op[1]
            if key in writes:
                reads.append(writes[key])
            else:
                value = INITIAL.get(key)
                for ts, k, v in committed:
                    if k == key and ts <= begin_ts:
                        value = v
                reads.append(value)
        else:
            writes[op[1]] = op[2]
    return reads


class ExhaustiveTest(unittest.TestCase):
    def test_all_small_programs_match_oracle(self):
        programs = all_programs()
        checked = 0
        for p1 in programs:
            for p2 in programs:
                for commit_order in ((0, 1), (1, 0)):
                    self._check_case(p1, p2, commit_order)
                    checked += 1
        self.assertGreater(checked, 10000)

    def _check_case(self, p1, p2, commit_order):
        first, second = commit_order
        programs = (p1, p2)
        outcomes = run_engine(p1, p2, commit_order)
        label = f"p1={p1} p2={p2} order={commit_order}"

        # The first committer faces no committed concurrent transaction in a
        # fresh engine, so it must always succeed.
        self.assertEqual(outcomes[first], "OK", label)

        shared_writes = writes_of(programs[first]) & writes_of(programs[second])
        if shared_writes:
            self.assertEqual(outcomes[second], "WRITE_CONFLICT", label)
            return

        # Reconstruct the reads each transaction observed under SI.
        committed = []  # (commit_ts, key, value) committed before either began
        reads = [observed_reads(programs[0], 0, committed),
                 observed_reads(programs[1], 0, committed)]
        serializable = is_serializable(programs, reads, final_db(programs))

        expected = "OK" if serializable else "SERIALIZATION_FAILURE"
        self.assertEqual(outcomes[second], expected, label)


if __name__ == "__main__":
    unittest.main()
