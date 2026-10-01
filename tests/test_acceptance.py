import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from typedbc import (
    JoinError,
    TypeFault,
    VerificationFailure,
    VerifyError,
    parse,
    verify,
)
from tests.pathcheck import path_check

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CATEGORY = {
    VerifyError: "verify",
    TypeFault: "type",
    JoinError: "join",
}


def category_of(exc):
    for cls, name in CATEGORY.items():
        if type(exc) is cls:
            return name
    raise AssertionError(f"unexpected exception type {type(exc)}")


def generate_cases(count=800, seed=20261001):
    """Deterministically enumerate `count` instruction sequences of depth <= 4."""
    rng = random.Random(seed)
    weighted_ops = (
        ["CONST_INT"] * 4
        + ["CONST_BOOL"] * 3
        + ["ADD"] * 2
        + ["CMP"] * 2
        + ["NOT"] * 2
        + ["JZ"] * 2
        + ["JMP"] * 2
        + ["HALT"] * 2
    )
    cases = []
    for _ in range(count):
        n = rng.randint(1, 4)
        structured = rng.random() < 0.5  # bias towards well-formed programs
        lines = []
        for i in range(n):
            op = rng.choice(weighted_ops)
            if op == "CONST_INT":
                lines.append(f"CONST_INT {rng.randint(0, 3)}")
            elif op == "CONST_BOOL":
                lines.append(rng.choice(["CONST_BOOL true", "CONST_BOOL false"]))
            elif op in ("JZ", "JMP"):
                if structured:
                    lines.append(f"{op} {rng.randint(0, n - 1)}")
                else:
                    # target n is deliberately out of range sometimes
                    lines.append(f"{op} {rng.randint(0, n)}")
            else:
                lines.append(op)
        if structured and not lines[-1].startswith(("JMP", "HALT")):
            lines[-1] = rng.choice(["HALT", "JMP 0"])
        cases.append("\n".join(lines))
    return cases


class TestCrossValidation(unittest.TestCase):
    """Acceptance A: 800 enumerated programs, depth <= 4, cross-checked
    against an independent path-enumeration checker."""

    def test_800_cases_agree_with_path_checker(self):
        stats = {"ok": 0, "verify": 0, "type": 0, "join": 0}
        for text in generate_cases(800):
            with self.subTest(program=text):
                program = parse(text)
                path_ok, path_problems = path_check(program)
                try:
                    verify(program)
                except VerificationFailure as exc:
                    self.assertFalse(
                        path_ok, f"verifier failed but path checker passed:\n{text}"
                    )
                    cat = category_of(exc)
                    self.assertIn(
                        cat,
                        path_problems,
                        f"verifier reported {cat!r} ({exc}) but path checker "
                        f"found {path_problems}:\n{text}",
                    )
                    stats[cat] += 1
                else:
                    self.assertTrue(
                        path_ok,
                        f"path checker found {path_problems} but verifier "
                        f"passed:\n{text}",
                    )
                    stats["ok"] += 1
        # Sanity: the sample must exercise every verdict category.
        for key, value in stats.items():
            self.assertGreater(value, 0, f"category {key!r} never exercised")
        print(f"\ncross-validation stats: {stats}")


class TestAcceptanceBCD(unittest.TestCase):
    def test_b_if_arms_different_heights_join_error(self):
        text = "\n".join([
            "CONST_BOOL true",  # 0
            "JZ 5",             # 1
            "CONST_INT 7",      # 2  then-arm: pushes 2 ints
            "CONST_INT 8",      # 3
            "JMP 6",            # 4
            "CONST_INT 9",      # 5  else-arm: pushes 1 int
            "HALT",             # 6  join: height 2 vs 1
        ])
        with self.assertRaises(JoinError) as ctx:
            verify(parse(text))
        self.assertEqual(ctx.exception.pc, 6)

    def test_c_jz_on_int_type_fault(self):
        text = "\n".join([
            "CONST_INT 3",  # 0
            "JZ 3",         # 1
            "HALT",         # 2
            "HALT",         # 3
        ])
        with self.assertRaises(TypeFault) as ctx:
            verify(parse(text))
        fault = ctx.exception
        self.assertEqual((fault.pc, fault.expected, fault.actual), (1, "bool", "int"))
        self.assertEqual(fault.stack, ["int"])


class TestCLI(unittest.TestCase):
    def run_cli(self, text, *extra):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".tbc", delete=False, dir=REPO_ROOT
        ) as fh:
            fh.write(text)
            path = fh.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "typedbc", path, "--check", *extra],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
            )
        finally:
            os.unlink(path)

    def test_cli_success_outputs_blocks_json(self):
        proc = self.run_cli("CONST_INT 1\nCONST_INT 2\nADD\nHALT\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["warnings"], [])
        self.assertEqual(len(payload["blocks"]), 1)
        block = payload["blocks"][0]
        self.assertTrue(block["reachable"])
        self.assertEqual(block["entry_stack"], [])
        self.assertEqual(block["exit_stack"], ["int"])

    def test_cli_verify_error_exit_12(self):
        proc = self.run_cli("JMP 9\nHALT\n")
        self.assertEqual(proc.returncode, 12)
        self.assertIn("out of range", proc.stderr)

    def test_cli_type_fault_exit_12(self):
        proc = self.run_cli("CONST_INT 3\nJZ 3\nHALT\nHALT\n")
        self.assertEqual(proc.returncode, 12)
        self.assertIn("TypeFault", proc.stderr)

    def test_cli_join_error_exit_12(self):
        text = "\n".join([
            "CONST_BOOL true", "JZ 5", "CONST_INT 7", "CONST_INT 8",
            "JMP 6", "CONST_INT 9", "HALT",
        ])
        proc = self.run_cli(text + "\n")
        self.assertEqual(proc.returncode, 12)
        self.assertIn("JoinError", proc.stderr)

    def test_d_dead_type_warning_exit_0(self):
        text = "\n".join([
            "HALT",         # 0
            "CONST_INT 1",  # 1 dead
            "NOT",          # 2 dead: expects bool
            "HALT",         # 3 dead
        ])
        proc = self.run_cli(text + "\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("DeadType", proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(len(payload["warnings"]), 1)
        self.assertEqual(payload["warnings"][0]["kind"], "DeadType")
        self.assertEqual(payload["warnings"][0]["pc"], 2)
        reachability = [b["reachable"] for b in payload["blocks"]]
        self.assertEqual(reachability, [True, False])

    def test_cli_missing_file_exit_2(self):
        proc = subprocess.run(
            [sys.executable, "-m", "typedbc", "no-such-file.tbc", "--check"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
