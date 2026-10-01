"""Acceptance case A: 800 enumerated programs of depth <= 4 instructions,
cross-checked against the independent path-enumeration checker."""

import random
import unittest

from typedbc import JoinError, TypeFault, VerifyError, verify
from typedbc.isa import Instruction

from reference_checker import check as reference_check

SEED = 20261001
NUM_CASES = 800

_REDUCED_ALPHABET = [
    ("CONST_INT", 0),
    ("CONST_BOOL", True),
    ("ADD", None),
    ("CMP", None),
    ("NOT", None),
    ("HALT", None),
    ("JZ", 0),
    ("JZ", 1),
    ("JMP", 0),
    ("JMP", 1),
]


def _random_program(rng):
    n = rng.choice((3, 4))
    prog = []
    for _ in range(n):
        r = rng.random()
        if r < 0.25:
            prog.append(("CONST_INT", rng.randint(0, 3)))
        elif r < 0.40:
            prog.append(("CONST_BOOL", rng.random() < 0.5))
        elif r < 0.60:
            prog.append((rng.choice(["ADD", "CMP", "NOT"]), None))
        elif r < 0.80:
            # Targets range past the end on purpose to exercise VerifyError.
            prog.append((rng.choice(["JZ", "JMP"]), rng.randint(0, n + 1)))
        else:
            prog.append(("HALT", None))
    return prog


def generate_cases():
    cases = []
    # Systematic part: every 1- and 2-instruction program over a reduced
    # alphabet (10 + 100 cases).
    for a in _REDUCED_ALPHABET:
        cases.append([a])
    for a in _REDUCED_ALPHABET:
        for b in _REDUCED_ALPHABET:
            cases.append([a, b])
    # Random part: 3- and 4-instruction programs over the full alphabet.
    rng = random.Random(SEED)
    while len(cases) < NUM_CASES:
        cases.append(_random_program(rng))
    return cases


def to_program(raw):
    return [Instruction(op=op, arg=arg, pc=i) for i, (op, arg) in enumerate(raw)]


class DifferentialFuzzTest(unittest.TestCase):
    def test_800_programs_agree_with_reference(self):
        cases = generate_cases()
        self.assertEqual(len(cases), NUM_CASES)
        mismatches = []
        verdicts = {"ok": 0, "VerifyError": 0, "TypeFault": 0, "JoinError": 0}
        for index, raw in enumerate(cases):
            prog = to_program(raw)
            expected_errors = reference_check(prog)
            try:
                verify(prog)
            except (TypeFault, JoinError) as exc:
                got = (type(exc).__name__, exc.pc)
                verdicts[type(exc).__name__] += 1
                if got not in expected_errors:
                    mismatches.append((index, raw, expected_errors, got))
            except VerifyError as exc:
                verdicts["VerifyError"] += 1
                if not any(cat == "VerifyError" for cat, _ in expected_errors):
                    mismatches.append(
                        (index, raw, expected_errors, ("VerifyError", exc.pc))
                    )
            else:
                verdicts["ok"] += 1
                if expected_errors:
                    mismatches.append((index, raw, expected_errors, "ok"))
        self.assertEqual(
            mismatches,
            [],
            "verifier disagrees with reference checker: %r" % (mismatches[:5],),
        )
        # Sanity: the corpus must actually exercise every verdict class.
        for category, count in verdicts.items():
            self.assertGreater(count, 0, "corpus never triggers %s" % category)


if __name__ == "__main__":
    unittest.main()
