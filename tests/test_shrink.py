import itertools
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shrink import case_fails, minimize_case, order_key, validate_case


def run_cli(*cli_args):
    return subprocess.run(
        [sys.executable, "-m", "shrink", *cli_args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def write_json(directory, name, payload):
    path = Path(directory) / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def triple_pattern_case(ops, **extra):
    case = {
        "ops": ops,
        "fail_when": {
            "type": "consecutive",
            "pattern": [{"name": "a"}, {"name": "b"}, {"name": "c"}],
        },
    }
    case.update(extra)
    return case


class TestAcceptanceA(unittest.TestCase):
    """Result equals the brute-force minimum over all failing subsequences."""

    def test_matches_brute_force_enumeration(self):
        noise = [
            {"name": f"noise{i}", "args": {"i": i, "payload": f"p{i}"}}
            for i in range(7)
        ]
        core = [{"name": "alpha"}, {"name": "beta"}, {"name": "gamma"}]
        raw_ops = noise[:2] + core + noise[2:]
        raw_case = {
            "ops": raw_ops,
            "fail_when": {
                "type": "consecutive",
                "pattern": [{"name": "alpha"}, {"name": "beta"}, {"name": "gamma"}],
            },
        }
        case = validate_case(raw_case)
        ops = case["ops"]

        brute_best = None
        for r in range(0, len(ops) + 1):
            for keep in itertools.combinations(range(len(ops)), r):
                sub = [ops[i] for i in keep]
                if case_fails(sub, case["fail_when"]):
                    if brute_best is None or order_key(sub) < order_key(brute_best):
                        brute_best = sub
        self.assertIsNotNone(brute_best)

        with tempfile.TemporaryDirectory() as tmp:
            case_path = write_json(tmp, "case.json", raw_case)
            out_path = str(Path(tmp) / "min.json")
            proc = run_cli("minimize", case_path, "--budget", "100000",
                           "--out", out_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(Path(out_path).read_text(encoding="utf-8"))

        self.assertEqual(result["status"], "1_MINIMAL")
        self.assertEqual(result["ops"], brute_best)
        self.assertEqual([op["name"] for op in result["ops"]],
                         ["alpha", "beta", "gamma"])
        self.assertGreater(result["checks"], 0)
        self.assertTrue(result["reason"])


class TestAcceptanceB(unittest.TestCase):
    """Predicate fails only on a specific triple; block deletion must not
    destroy the structure, and ties resolve to the lexicographic minimum."""

    def test_triple_preserved_and_tie_broken(self):
        def op(name, v):
            return {"name": name, "args": {"v": v}}

        raw_ops = (
            [{"name": "x", "args": {}}]
            + [op("a", 2), op("b", 2), op("c", 2)]
            + [{"name": "y", "args": {}}]
            + [op("a", 1), op("b", 1), op("c", 1)]
        )
        raw_case = triple_pattern_case(raw_ops)

        with tempfile.TemporaryDirectory() as tmp:
            case_path = write_json(tmp, "case.json", raw_case)
            out_path = str(Path(tmp) / "min.json")
            proc = run_cli("minimize", case_path, "--budget", "100000",
                           "--out", out_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(Path(out_path).read_text(encoding="utf-8"))

        self.assertEqual(result["status"], "1_MINIMAL")
        names = [op["name"] for op in result["ops"]]
        self.assertEqual(names, ["a", "b", "c"])
        # Tie between the two occurrences resolved to the lexicographic min.
        self.assertEqual([op["args"] for op in result["ops"]],
                         [{"v": 1}, {"v": 1}, {"v": 1}])
        # The surviving sequence still fails the original predicate.
        case = validate_case(raw_case)
        self.assertTrue(case_fails(result["ops"], case["fail_when"]))


class TestAcceptanceC(unittest.TestCase):
    """Budget of 1 must yield BUDGET_EXCEEDED, never a minimality claim."""

    def test_budget_one(self):
        raw_case = triple_pattern_case(
            [{"name": "n"}, {"name": "a"}, {"name": "b"}, {"name": "c"}]
        )
        with tempfile.TemporaryDirectory() as tmp:
            case_path = write_json(tmp, "case.json", raw_case)
            out_path = str(Path(tmp) / "min.json")
            proc = run_cli("minimize", case_path, "--budget", "1",
                           "--out", out_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(Path(out_path).read_text(encoding="utf-8"))

        self.assertEqual(result["status"], "BUDGET_EXCEEDED")
        self.assertEqual(result["checks"], 1)
        self.assertEqual(result["ops"], validate_case(raw_case)["ops"])
        self.assertIn("budget", result["reason"])


class TestAcceptanceD(unittest.TestCase):
    """Arg replacements that make the predicate raise must not be kept."""

    def test_exception_raising_replacement_rejected(self):
        raw_case = {
            "ops": [
                {"name": "a"},
                {"name": "b", "args": {"k": 1, "z": 5}},
                {"name": "c"},
            ],
            "fail_when": {
                "type": "consecutive",
                "pattern": [
                    {"name": "a"},
                    {"name": "b", "args_key": "k", "equals": 1},
                    {"name": "c"},
                ],
            },
            "arg_candidates": {
                # {"a": 0} sorts before the valid candidate but drops "k",
                # so evaluating the predicate raises KeyError -> not failing.
                "b": [{"a": 0}, {"j": 0, "k": 1}],
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            case_path = write_json(tmp, "case.json", raw_case)
            out_path = str(Path(tmp) / "min.json")
            proc = run_cli("minimize", case_path, "--budget", "100000",
                           "--out", out_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(Path(out_path).read_text(encoding="utf-8"))

        self.assertEqual(result["status"], "1_MINIMAL")
        self.assertEqual(result["ops"][1]["name"], "b")
        self.assertEqual(result["ops"][1]["args"], {"j": 0, "k": 1})
        self.assertNotEqual(result["ops"][1]["args"], {"a": 0})


class TestUnknownMinimality(unittest.TestCase):
    """Verification phase exhausting the budget yields UNKNOWN_MINIMALITY."""

    def test_unknown_minimality(self):
        raw_case = triple_pattern_case(
            [{"name": "n0"}, {"name": "n1"}, {"name": "a"},
             {"name": "b"}, {"name": "c"}, {"name": "n2"}]
        )
        case = validate_case(raw_case)
        full = minimize_case(case, 10**6)
        self.assertEqual(full["status"], "1_MINIMAL")
        final_len = len(full["ops"])
        self.assertGreater(final_len, 0)

        # Allow every check except the very last verification probe.
        tight = minimize_case(case, full["checks"] - 1)
        self.assertEqual(tight["status"], "UNKNOWN_MINIMALITY")
        self.assertEqual(tight["ops"], full["ops"])
        self.assertEqual(tight["checks"], full["checks"] - 1)


class TestInvalidInput(unittest.TestCase):
    def assert_exit_2(self, payload=None, raw_text=None, missing_file=False):
        with tempfile.TemporaryDirectory() as tmp:
            if missing_file:
                case_path = str(Path(tmp) / "nope.json")
            elif raw_text is not None:
                case_path = str(Path(tmp) / "case.json")
                Path(case_path).write_text(raw_text, encoding="utf-8")
            else:
                case_path = write_json(tmp, "case.json", payload)
            proc = run_cli("minimize", case_path, "--budget", "100")
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertTrue(proc.stderr.strip())

    def test_missing_file(self):
        self.assert_exit_2(missing_file=True)

    def test_malformed_json(self):
        self.assert_exit_2(raw_text="{not json")

    def test_missing_ops(self):
        self.assert_exit_2(payload={"fail_when": {"type": "consecutive",
                                                  "pattern": [{"name": "a"}]}})

    def test_op_without_name(self):
        self.assert_exit_2(payload=triple_pattern_case([{"args": {}}]))

    def test_missing_fail_when(self):
        self.assert_exit_2(payload={"ops": [{"name": "a"}]})

    def test_initial_case_does_not_fail(self):
        self.assert_exit_2(
            payload=triple_pattern_case([{"name": "a"}, {"name": "b"}])
        )

    def test_negative_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            case_path = write_json(tmp, "case.json", triple_pattern_case(
                [{"name": "a"}, {"name": "b"}, {"name": "c"}]))
            proc = run_cli("minimize", case_path, "--budget", "-1")
            self.assertEqual(proc.returncode, 2, proc.stderr)


if __name__ == "__main__":
    unittest.main()
