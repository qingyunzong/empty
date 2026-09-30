import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from roster.core import BAD_ROSTER, RosterError, _off_days, solve

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WEEK = ["2026-10-%02d" % d for d in range(5, 12)]  # Mon 2026-10-05 .. Sun 2026-10-11


def emp(emp_id, *skills):
    return {"id": emp_id, "skills": list(skills)}


class HierarchyRollbackTests(unittest.TestCase):
    def test_low_level_rollback_keeps_higher_levels(self):
        problem = {
            "days": ["2026-10-05", "2026-10-06"],
            "employees": [emp("e1", "a"), emp("e2", "a")],
            "demand": {},
            "levels": [
                {"name": "primary", "demand": {"2026-10-05": {"a": 2}}},
                {"name": "secondary", "demand": {"2026-10-05": {"a": 1}}},
                {"name": "tertiary", "demand": {"2026-10-06": {"a": 1}}},
            ],
        }
        result = solve(problem)
        self.assertEqual(result["status"], "ok")
        # secondary conflicts with the fixed primary level (one shift per
        # person per day): only secondary is rolled back.
        self.assertEqual(result["relaxed"], ["secondary"])
        self.assertEqual(result["unmet"], {"secondary": {"2026-10-05": {"a": 1}}})
        got = {(a["date"], a["employee"], a["level"]) for a in result["assignments"]}
        self.assertEqual(
            got,
            {
                ("2026-10-05", "e1", "primary"),
                ("2026-10-05", "e2", "primary"),
                ("2026-10-06", "e1", "tertiary"),
            },
        )

    def test_relaxed_level_leaves_no_assignments(self):
        problem = {
            "days": ["2026-10-05"],
            "employees": [emp("e1", "a")],
            "demand": {"2026-10-05": {"a": 1}},
            "levels": [{"name": "extra", "demand": {"2026-10-05": {"a": 1}}}],
        }
        result = solve(problem)
        self.assertEqual(result["relaxed"], ["extra"])
        self.assertTrue(all(a["level"] == "base" for a in result["assignments"]))


class HardConstraintTests(unittest.TestCase):
    def test_hard_infeasible_returns_status_not_exception(self):
        problem = {
            "days": ["2026-10-05"],
            "employees": [emp("e1", "a")],
            "demand": {"2026-10-05": {"a": 2}},
            "levels": [{"name": "extra", "demand": {"2026-10-05": {"a": 1}}}],
        }
        result = solve(problem)  # must not raise
        self.assertEqual(result["status"], "infeasible")
        self.assertEqual(result["assignments"], [])
        self.assertEqual(result["relaxed"], [])
        self.assertEqual(result["unmet"], {"base": {"2026-10-05": {"a": 2}}})

    def test_one_shift_per_person_per_day_with_backtracking(self):
        problem = {
            "days": ["2026-10-05"],
            "employees": [emp("e1", "a", "b"), emp("e2", "a")],
            "demand": {"2026-10-05": {"a": 1, "b": 1}},
        }
        result = solve(problem)
        self.assertEqual(result["status"], "ok")
        got = {(a["employee"], a["skill"]) for a in result["assignments"]}
        # greedy first picks e1 for 'a', must backtrack so e1 takes 'b'
        self.assertEqual(got, {("e2", "a"), ("e1", "b")})

    def test_off_sticks_to_whole_week(self):
        problem = {
            "days": WEEK,
            "employees": [emp("e1", "a"), emp("e2", "a")],
            "demand": {day: {"a": 1} for day in WEEK},
            "off": {"e1": ["2026-10-07"]},  # Wednesday -> whole ISO week
        }
        result = solve(problem)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(all(a["employee"] == "e2" for a in result["assignments"]))
        self.assertEqual(len(result["assignments"]), 7)

    def test_off_whole_week_can_make_demand_infeasible(self):
        problem = {
            "days": WEEK,
            "employees": [emp("e1", "a"), emp("e2", "a")],
            "demand": {"2026-10-09": {"a": 2}},
            "off": {"e1": ["2026-10-05"]},
        }
        result = solve(problem)
        self.assertEqual(result["status"], "infeasible")

    def test_off_expansion_helper(self):
        off = _off_days({"off": {"e1": ["2026-10-11"]}}, WEEK)
        self.assertEqual(off["e1"], frozenset(WEEK))


class DeterminismTests(unittest.TestCase):
    def test_tie_breaks_by_date_then_employee_id(self):
        problem = {
            "days": ["2026-10-05", "2026-10-06"],
            "employees": [emp("e2", "a"), emp("e1", "a")],  # unordered on purpose
            "demand": {"2026-10-05": {"a": 1}, "2026-10-06": {"a": 1}},
        }
        first = solve(problem)
        second = solve(problem)
        self.assertEqual(first, second)
        self.assertEqual(
            [(a["date"], a["employee"]) for a in first["assignments"]],
            [("2026-10-05", "e1"), ("2026-10-06", "e1")],
        )

    def test_largest_gap_date_wins(self):
        problem = {
            "days": ["2026-10-05", "2026-10-06"],
            "employees": [emp("e1", "a"), emp("e2", "a"), emp("e3", "a")],
            "demand": {"2026-10-05": {"a": 1}, "2026-10-06": {"a": 2}},
        }
        result = solve(problem)
        # 2026-10-06 has the larger gap, so it is filled first (e1, e2).
        got = {(a["date"], a["employee"]) for a in result["assignments"]}
        self.assertEqual(
            got,
            {
                ("2026-10-06", "e1"),
                ("2026-10-06", "e2"),
                ("2026-10-05", "e1"),
            },
        )


class ValidationTests(unittest.TestCase):
    def assert_bad_roster(self, problem):
        with self.assertRaises(RosterError) as ctx:
            solve(problem)
        self.assertEqual(ctx.exception.code, BAD_ROSTER)

    def test_negative_demand(self):
        self.assert_bad_roster(
            {"employees": [emp("e1", "a")], "demand": {"2026-10-05": {"a": -1}}}
        )

    def test_negative_level_demand(self):
        self.assert_bad_roster(
            {
                "employees": [emp("e1", "a")],
                "levels": [{"name": "x", "demand": {"2026-10-05": {"a": -2}}}],
            }
        )

    def test_unknown_skill_in_demand(self):
        self.assert_bad_roster(
            {"employees": [emp("e1", "a")], "demand": {"2026-10-05": {"zzz": 1}}}
        )

    def test_unknown_skill_in_level(self):
        self.assert_bad_roster(
            {
                "employees": [emp("e1", "a")],
                "levels": [{"name": "x", "demand": {"2026-10-05": {"q": 1}}}],
            }
        )

    def test_duplicate_level_names(self):
        self.assert_bad_roster(
            {
                "employees": [emp("e1", "a")],
                "levels": [{"name": "x", "demand": {}}, {"name": "x", "demand": {}}],
            }
        )


class CliTests(unittest.TestCase):
    def run_cli(self, payload):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as fh:
            json.dump(payload, fh)
            path = fh.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "roster.cli", path],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
            )
        finally:
            os.unlink(path)

    def test_cli_ok(self):
        proc = self.run_cli(
            {
                "days": ["2026-10-05"],
                "employees": [emp("e1", "a")],
                "demand": {"2026-10-05": {"a": 1}},
            }
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["assignments"][0]["employee"], "e1")
        self.assertEqual(result["relaxed"], [])

    def test_cli_bad_roster_exit_2(self):
        proc = self.run_cli(
            {
                "employees": [emp("e1", "a")],
                "levels": [{"name": "x", "demand": {}}, {"name": "x", "demand": {}}],
            }
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn(BAD_ROSTER, proc.stderr)

    def test_cli_infeasible_is_not_an_error(self):
        proc = self.run_cli(
            {
                "days": ["2026-10-05"],
                "employees": [],
                "demand": {"2026-10-05": {"a": 1}},
            }
        )
        # no employee has skill 'a' -> unknown skill -> BAD_ROSTER
        self.assertEqual(proc.returncode, 2)
        proc = self.run_cli(
            {
                "days": ["2026-10-05"],
                "employees": [emp("e1", "a")],
                "demand": {"2026-10-05": {"a": 5}},
            }
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], "infeasible")


def brute_force_feasible(employees, horizon, off, demands):
    """Independent exhaustive feasibility check used as an oracle."""
    total = {}
    for demand in demands:
        for day, skills in demand.items():
            for skill, count in skills.items():
                total.setdefault(day, {}).setdefault(skill, 0)
                total[day][skill] += count
    slots = [
        (day, skill)
        for day in sorted(total)
        for skill in sorted(total[day])
        for _ in range(total[day][skill])
    ]
    used = set()

    def rec(index):
        if index == len(slots):
            return True
        day, skill = slots[index]
        for employee in employees:
            emp_id = employee["id"]
            if (
                skill in employee["skills"]
                and (day, emp_id) not in used
                and day not in off.get(emp_id, ())
            ):
                used.add((day, emp_id))
                if rec(index + 1):
                    return True
                used.discard((day, emp_id))
        return False

    return rec(0)


def check_assignments_valid(testcase, problem, result):
    employees = {e["id"]: set(e["skills"]) for e in problem.get("employees", [])}
    horizon = sorted(
        set(problem.get("days") or [])
        | set((problem.get("demand") or {}).keys())
        | {d for lvl in problem.get("levels") or [] for d in (lvl.get("demand") or {})}
    )
    off = _off_days(problem, horizon)
    seen = set()
    per_level = {}
    for assignment in result["assignments"]:
        day, emp_id = assignment["date"], assignment["employee"]
        skill, level = assignment["skill"], assignment["level"]
        testcase.assertIn(skill, employees[emp_id])
        testcase.assertNotIn(day, off.get(emp_id, frozenset()))
        testcase.assertNotIn((day, emp_id), seen)  # one shift per day
        seen.add((day, emp_id))
        per_level.setdefault(level, {}).setdefault(day, {}).setdefault(skill, 0)
        per_level[level][day][skill] += 1
    demands = {"base": problem.get("demand") or {}}
    demands.update({lvl["name"]: lvl.get("demand") or {} for lvl in problem.get("levels") or []})
    satisfied = {"base"} | {
        lvl["name"] for lvl in problem.get("levels") or [] if lvl["name"] not in result["relaxed"]
    }
    for level in satisfied:
        expected = {}
        for day, skills in demands[level].items():
            for skill, count in skills.items():
                if count:
                    expected.setdefault(day, {}).setdefault(skill, 0)
                    expected[day][skill] += count
        got = {d: dict(s) for d, s in per_level.get(level, {}).items()}
        testcase.assertEqual(got, expected, "level %r not fully satisfied" % level)


class ExhaustiveComparisonTests(unittest.TestCase):
    """Small random cases checked against an exhaustive-search oracle."""

    def test_against_brute_force(self):
        rng = random.Random(20261005)
        days = WEEK[:4]
        for case in range(40):
            employees = []
            for i in range(3):
                skills = rng.sample(["a", "b"], rng.randint(1, 2))
                employees.append({"id": "e%d" % i, "skills": sorted(skills)})

            def random_demand(max_count):
                demand = {}
                for day in days:
                    for skill in ("a", "b"):
                        count = rng.randint(0, max_count)
                        if count:
                            demand.setdefault(day, {})[skill] = count
                return demand

            problem = {
                "days": days,
                "employees": employees,
                "demand": random_demand(1),
                "levels": [
                    {"name": "L0", "demand": random_demand(2)},
                    {"name": "L1", "demand": random_demand(2)},
                ],
            }
            if rng.random() < 0.4:
                problem["off"] = {
                    rng.choice(employees)["id"]: [rng.choice(days)]
                }
            off = _off_days(problem, days)
            base = problem["demand"]
            levels = problem["levels"]

            result = solve(problem)
            hard_ok = brute_force_feasible(employees, days, off, [base])
            if not hard_ok:
                self.assertEqual(result["status"], "infeasible", "case %d" % case)
                continue
            self.assertEqual(result["status"], "ok", "case %d" % case)

            # lexicographically optimal satisfiable level set via oracle
            kept = []
            for level in levels:
                if brute_force_feasible(
                    employees, days, off, [base] + [l["demand"] for l in kept] + [level["demand"]]
                ):
                    kept.append(level)
            expected_relaxed = [l["name"] for l in levels if l not in kept]
            self.assertEqual(result["relaxed"], expected_relaxed, "case %d" % case)
            check_assignments_valid(self, problem, result)


if __name__ == "__main__":
    unittest.main()
