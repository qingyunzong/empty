import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from roster import BAD_ROSTER, RosterError, solve


def level_groups(demand, levels):
    groups = [list(group) for group in levels]
    covered = {skill for group in groups for skill in group}
    rest = sorted(skill for skill in demand if skill not in covered)
    if rest:
        groups.append(rest)
    return groups


def satisfied_vector(result, demand, levels):
    unmet = {}
    for entry in result["unmet"]:
        unmet[(entry["skill"], entry["day"])] = entry["count"]
    vector = []
    for group in level_groups(demand, levels):
        total = 0
        for skill in group:
            for day, count in enumerate(demand[skill]):
                total += count - unmet.get((skill, day), 0)
        vector.append(total)
    return vector


def brute_force_best(employees, demand, off, levels, num_days):
    """Exhaustively enumerate all valid assignments and return the
    lexicographically best per-level satisfied-demand vector."""
    groups = level_groups(demand, levels)
    candidates = []
    for emp in employees:
        for day in range(num_days):
            if day in off.get(emp["id"], ()):
                continue
            for skill in emp["skills"]:
                if skill in demand and demand[skill][day] > 0:
                    candidates.append((emp["id"], day, skill))
    best = None
    for mask in range(1 << len(candidates)):
        used = set()
        counts = {}
        valid = True
        for bit, (emp_id, day, skill) in enumerate(candidates):
            if not (mask >> bit) & 1:
                continue
            if (emp_id, day) in used:
                valid = False
                break
            if counts.get((skill, day), 0) >= demand[skill][day]:
                valid = False
                break
            used.add((emp_id, day))
            counts[(skill, day)] = counts.get((skill, day), 0) + 1
        if not valid:
            continue
        vector = []
        for group in groups:
            total = 0
            for skill in group:
                for day in range(num_days):
                    total += min(counts.get((skill, day), 0), demand[skill][day])
            vector.append(total)
        if best is None or vector > best:
            best = vector
    return best


class LayeredRollbackTests(unittest.TestCase):
    def test_lower_level_rollback_keeps_higher_level(self):
        # One employee with both skills; one shift per day means level 1
        # conflicts with the already-fixed level 0 assignment.
        result = solve(
            employees=[{"id": "e1", "skills": ["a", "b"]}],
            demand={"a": [1], "b": [1]},
            off={},
            levels=[["a"], ["b"]],
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(
            result["assignments"], [{"day": 0, "employee": "e1", "skill": "a"}]
        )
        self.assertEqual(result["relaxed"], [1])
        self.assertEqual(result["unmet"], [{"day": 0, "skill": "b", "count": 1}])

    def test_partial_level_is_fully_rolled_back(self):
        # Level 1 can be partially filled but not fully: everything from
        # that level is undone, level 0 stays untouched.
        result = solve(
            employees=[
                {"id": "e1", "skills": ["a", "b"]},
                {"id": "e2", "skills": ["b"]},
            ],
            demand={"a": [1], "b": [2]},
            off={},
            levels=[["a"], ["b"]],
        )
        self.assertEqual(
            result["assignments"], [{"day": 0, "employee": "e1", "skill": "a"}]
        )
        self.assertEqual(result["relaxed"], [1])
        self.assertEqual(result["unmet"], [{"day": 0, "skill": "b", "count": 2}])

    def test_deeper_level_still_runs_after_relaxation(self):
        result = solve(
            employees=[{"id": "e1", "skills": ["a", "c"]}],
            demand={"a": [1, 0], "b": [1, 0], "c": [0, 1]},
            off={},
            levels=[["a"], ["b"], ["c"]],
        )
        self.assertEqual(result["relaxed"], [1])
        self.assertEqual(
            result["assignments"],
            [
                {"day": 0, "employee": "e1", "skill": "a"},
                {"day": 1, "employee": "e1", "skill": "c"},
            ],
        )
        self.assertEqual(
            result["unmet"], [{"day": 0, "skill": "b", "count": 1}]
        )


class HardConstraintTests(unittest.TestCase):
    def test_fully_infeasible_returns_status_not_exception(self):
        result = solve(
            employees=[],
            demand={"a": [1, 2]},
            off={},
            levels=[["a"]],
        )
        self.assertEqual(result["status"], "infeasible")
        self.assertEqual(result["assignments"], [])
        self.assertEqual(result["relaxed"], [0])
        self.assertEqual(
            result["unmet"],
            [
                {"day": 0, "skill": "a", "count": 1},
                {"day": 1, "skill": "a", "count": 2},
            ],
        )

    def test_skill_mismatch_is_hard(self):
        result = solve(
            employees=[{"id": "e1", "skills": ["x"]}],
            demand={"a": [1]},
            off={},
            levels=[["a"]],
        )
        self.assertEqual(result["status"], "infeasible")
        self.assertEqual(result["assignments"], [])

    def test_off_blocks_assignment(self):
        result = solve(
            employees=[{"id": "e1", "skills": ["a"]}],
            demand={"a": [1]},
            off={"e1": [0]},
            levels=[["a"]],
        )
        self.assertEqual(result["assignments"], [])
        self.assertEqual(result["relaxed"], [0])

    def test_off_weekday_applies_to_whole_horizon(self):
        # "mon" blocks every Monday (day 0, 7, ...) of the two-week horizon.
        result = solve(
            employees=[
                {"id": "e1", "skills": ["a"]},
                {"id": "e2", "skills": ["a"]},
            ],
            demand={"a": [1] * 14},
            off={"e1": ["mon"]},
            levels=[["a"]],
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["relaxed"], [])
        self.assertEqual(len(result["assignments"]), 14)
        mondays = [a for a in result["assignments"] if a["day"] % 7 == 0]
        self.assertEqual(len(mondays), 2)
        self.assertTrue(all(a["employee"] == "e2" for a in mondays))
        self.assertFalse(
            any(a["employee"] == "e1" and a["day"] % 7 == 0 for a in result["assignments"])
        )

    def test_one_shift_per_person_per_day(self):
        result = solve(
            employees=[{"id": "e1", "skills": ["a", "b"]}],
            demand={"a": [2], "b": [2]},
            off={},
            levels=[["a", "b"]],
        )
        days = [a["day"] for a in result["assignments"]]
        self.assertEqual(len(days), len(set(days)))


class DeterminismTests(unittest.TestCase):
    def test_ties_break_by_date_then_employee_id(self):
        # Largest gap first (day 1 with gap 2), then earliest date,
        # then smallest employee id.
        result = solve(
            employees=[
                {"id": "e2", "skills": ["a"]},
                {"id": "e1", "skills": ["a"]},
            ],
            demand={"a": [1, 2]},
            off={},
            levels=[["a"]],
        )
        self.assertEqual(
            result["assignments"],
            [
                {"day": 0, "employee": "e1", "skill": "a"},
                {"day": 1, "employee": "e1", "skill": "a"},
                {"day": 1, "employee": "e2", "skill": "a"},
            ],
        )

    def test_repeated_runs_are_identical(self):
        kwargs = dict(
            employees=[
                {"id": "e3", "skills": ["a", "b"]},
                {"id": "e1", "skills": ["a"]},
                {"id": "e2", "skills": ["b"]},
            ],
            demand={"a": [1, 2, 1], "b": [2, 0, 1]},
            off={"e2": [1]},
            levels=[["a"], ["b"]],
        )
        first = solve(**kwargs)
        second = solve(**kwargs)
        self.assertEqual(first, second)


class ValidationTests(unittest.TestCase):
    def assert_bad_roster(self, **kwargs):
        with self.assertRaises(RosterError) as ctx:
            solve(**kwargs)
        self.assertEqual(ctx.exception.code, BAD_ROSTER)

    def test_negative_demand(self):
        self.assert_bad_roster(
            employees=[], demand={"a": [-1]}, off={}, levels=[["a"]]
        )

    def test_unknown_skill_in_levels(self):
        self.assert_bad_roster(
            employees=[], demand={"a": [1]}, off={}, levels=[["a", "zzz"]]
        )

    def test_duplicate_skill_across_levels(self):
        self.assert_bad_roster(
            employees=[], demand={"a": [1]}, off={}, levels=[["a"], ["a"]]
        )

    def test_error_code_constant(self):
        self.assertEqual(BAD_ROSTER, "BAD_ROSTER")


class ExhaustiveCrossCheckTests(unittest.TestCase):
    CASES = [
        dict(
            employees=[{"id": "e1", "skills": ["a", "b"]}, {"id": "e2", "skills": ["b"]}],
            demand={"a": [1, 0], "b": [1, 1]},
            off={},
            levels=[["a"], ["b"]],
        ),
        dict(
            employees=[{"id": "e1", "skills": ["a"]}, {"id": "e2", "skills": ["a", "b"]}],
            demand={"a": [1, 1], "b": [0, 1]},
            off={},
            levels=[["a"], ["b"]],
        ),
        dict(
            employees=[{"id": "e1", "skills": ["a", "b"]}],
            demand={"a": [1], "b": [1]},
            off={},
            levels=[["a"], ["b"]],
        ),
        dict(
            employees=[{"id": "e1", "skills": ["a", "b"]}, {"id": "e2", "skills": ["a"]}],
            demand={"a": [1, 1], "b": [1, 0]},
            off={"e1": [1]},
            levels=[["b"], ["a"]],
        ),
    ]

    def test_matches_exhaustive_optimum(self):
        for case in self.CASES:
            with self.subTest(case=case):
                num_days = len(next(iter(case["demand"].values())))
                result = solve(**case)
                got = satisfied_vector(result, case["demand"], case["levels"])
                want = brute_force_best(
                    case["employees"], case["demand"], case["off"], case["levels"], num_days
                )
                self.assertEqual(got, want)


class CliTests(unittest.TestCase):
    def run_cli(self, payload):
        return subprocess.run(
            [sys.executable, "-m", "roster.cli"],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            cwd=ROOT,
        )

    def test_cli_solves_from_stdin(self):
        proc = self.run_cli(
            {
                "employees": [{"id": "e1", "skills": ["a"]}],
                "demand": {"a": [1]},
                "off": {},
                "levels": [["a"]],
            }
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(
            result["assignments"], [{"day": 0, "employee": "e1", "skill": "a"}]
        )

    def test_cli_negative_demand_exits_2(self):
        proc = self.run_cli(
            {"employees": [], "demand": {"a": [-3]}, "off": {}, "levels": [["a"]]}
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "BAD_ROSTER")

    def test_cli_unknown_skill_exits_2(self):
        proc = self.run_cli(
            {"employees": [], "demand": {"a": [1]}, "off": {}, "levels": [["nope"]]}
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "BAD_ROSTER")

    def test_cli_duplicate_level_exits_2(self):
        proc = self.run_cli(
            {"employees": [], "demand": {"a": [1]}, "off": {}, "levels": [["a"], ["a"]]}
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "BAD_ROSTER")

    def test_cli_infeasible_is_not_an_error(self):
        proc = self.run_cli(
            {"employees": [], "demand": {"a": [1]}, "off": {}, "levels": [["a"]]}
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], "infeasible")


if __name__ == "__main__":
    unittest.main()
