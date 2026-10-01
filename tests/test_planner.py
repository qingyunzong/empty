"""Acceptance tests A-D for the budgetfn planner core."""

import random
import unittest

from budgetfn.core import JobError, plan, validate_budget, validate_jobs


def brute_force(jobs, budget):
    """Independent exhaustive enumeration of every per-tick choice.

    Returns (earned, spent, schedule) for the optimal plan under the
    same ordering as the planner: maximize earned, then minimize the
    sum of completion times, then the lexicographically smallest
    schedule (work before idle, then by job id as string).
    """
    horizon = max((job["deadline"] for job in jobs), default=0)
    n = len(jobs)
    best = {"key": None, "result": None}

    def tick_key(j):
        return (1, "") if j is None else (0, str(jobs[j]["id"]))

    def rec(t, rem, spent, comp, sched):
        if t == horizon:
            earned = sum(jobs[j]["value"] for j in range(n) if rem[j] == 0)
            key = (-earned, comp, tuple(tick_key(s) for s in sched))
            if best["key"] is None or key < best["key"]:
                best["key"] = key
                best["result"] = (earned, spent, list(sched))
            return
        # idle is always legal
        rec(t + 1, rem, spent, comp, sched + [None])
        for j in range(n):
            job = jobs[j]
            if rem[j] <= 0:
                continue
            if not (job["arrival"] <= t < job["deadline"]):
                continue
            if spent + job["cost_per_tick"] > budget:
                continue
            rem2 = list(rem)
            rem2[j] -= 1
            comp2 = comp + (t + 1 if rem2[j] == 0 else 0)
            rec(t + 1, tuple(rem2), spent + job["cost_per_tick"],
                comp2, sched + [j])

    rec(0, tuple(job["work"] for job in jobs), 0, 0, [])
    return best["result"]


def make_jobs(specs):
    return [dict(id=s[0], arrival=s[1], deadline=s[2], work=s[3],
                 cost_per_tick=s[4], value=s[5]) for s in specs]


class AcceptanceA(unittest.TestCase):
    """Budget exactly covers one high-value job; the low-value job is dropped."""

    def test_high_value_job_wins(self):
        jobs = make_jobs([
            ("high", 0, 5, 3, 2, 100),
            ("low", 0, 5, 2, 2, 10),
        ])
        result = plan(jobs, 6)
        self.assertEqual(result["earned"], 100)
        self.assertEqual(result["spent"], 6)
        self.assertEqual(result["completed"], ["high"])
        self.assertEqual(result["schedule"],
                         ["high", "high", "high", "idle", "idle"])


class AcceptanceB(unittest.TestCase):
    """Preemptable long job stops halfway when the budget runs out: value 0."""

    def test_partial_work_earns_nothing_but_costs(self):
        jobs = make_jobs([
            ("long", 0, 20, 10, 1, 50),
        ])
        result = plan(jobs, 4)
        self.assertEqual(result["earned"], 0)
        self.assertEqual(result["spent"], 4)
        self.assertEqual(result["completed"], [])
        self.assertEqual(result["schedule"][:4], ["long"] * 4)
        self.assertEqual(result["schedule"][4:], ["idle"] * 16)

    def test_preemption_respects_arrival_window(self):
        jobs = make_jobs([
            ("a", 0, 2, 2, 1, 5),   # can only run on ticks 0,1
            ("b", 2, 6, 3, 1, 9),   # can only run on ticks 2..5
        ])
        result = plan(jobs, 5)
        self.assertEqual(result["earned"], 14)
        self.assertEqual(result["spent"], 5)
        self.assertEqual(result["schedule"],
                         ["a", "a", "b", "b", "b", "idle"])


class AcceptanceC(unittest.TestCase):
    """Tie on optimal value: prefer the smaller sum of completion times."""

    def test_tie_breaks_by_completion_time(self):
        jobs = make_jobs([
            ("x", 0, 10, 2, 1, 10),  # completes at t=2, costs 2
            ("y", 0, 10, 4, 1, 10),  # completes at t=4, costs 4
        ])
        # Budget 4: either x (spent 2) or y (spent 4), never both (2+4>4).
        # Equal earned value, so the plan completing x (completion time 2
        # instead of 4) wins.  The leftover budget is still spent on y
        # (working beats idling in the final tie-break, same semantics as
        # acceptance test B), but y never completes and earns nothing.
        result = plan(jobs, 4)
        self.assertEqual(result["earned"], 10)
        self.assertEqual(result["completed"], ["x"])
        self.assertEqual(result["completion_times"], {"x": 2})
        self.assertEqual(result["spent"], 4)
        self.assertEqual(result["schedule"],
                         ["x", "x", "y", "y"] + ["idle"] * 6)

    def test_tie_breaks_by_job_id(self):
        jobs = make_jobs([
            ("beta", 0, 4, 1, 1, 7),
            ("alpha", 0, 4, 1, 1, 7),
        ])
        # Budget 1: exactly one job completes; identical value and
        # completion time, so the lexicographically smaller id wins.
        result = plan(jobs, 1)
        self.assertEqual(result["earned"], 7)
        self.assertEqual(result["completed"], ["alpha"])
        self.assertEqual(result["schedule"], ["alpha", "idle", "idle", "idle"])


class AcceptanceD(unittest.TestCase):
    """Cross-check the DP planner against exhaustive enumeration."""

    def check_against_brute_force(self, jobs, budget):
        result = plan(jobs, budget)
        earned, spent, sched = brute_force(jobs, budget)
        expected_schedule = [
            "idle" if s is None else jobs[s]["id"] for s in sched]
        self.assertEqual(result["earned"], earned)
        self.assertEqual(result["spent"], spent)
        self.assertEqual(result["schedule"], expected_schedule)

    def test_random_small_instances(self):
        rng = random.Random(20261001)
        for case in range(25):
            n = rng.randint(1, 4)
            jobs = []
            for i in range(n):
                deadline = rng.randint(1, 7)
                arrival = rng.randint(0, deadline - 1)
                jobs.append({
                    "id": f"j{i}",
                    "arrival": arrival,
                    "deadline": deadline,
                    "work": rng.randint(1, 5),
                    "cost_per_tick": rng.randint(0, 3),
                    "value": rng.randint(0, 20),
                })
            budget = rng.randint(0, 10)
            with self.subTest(case=case, jobs=jobs, budget=budget):
                self.check_against_brute_force(jobs, budget)

    def test_eight_jobs_horizon_fifteen(self):
        # 8 jobs, horizon 15, tight budget keeps enumeration tractable.
        rng = random.Random(7)
        jobs = []
        for i in range(8):
            deadline = rng.randint(8, 15)
            jobs.append({
                "id": f"job{i}",
                "arrival": rng.randint(0, 3),
                "deadline": deadline,
                "work": rng.randint(1, 4),
                "cost_per_tick": rng.randint(1, 2),
                "value": rng.randint(1, 30),
            })
        self.check_against_brute_force(jobs, budget=3)

    def test_zero_cost_jobs(self):
        jobs = make_jobs([
            ("free", 0, 3, 2, 0, 5),
            ("paid", 0, 3, 2, 1, 9),
        ])
        self.check_against_brute_force(jobs, 1)


class Validation(unittest.TestCase):
    def test_deadline_not_after_arrival_rejected(self):
        with self.assertRaises(JobError):
            validate_jobs([{"id": "x", "arrival": 3, "deadline": 3,
                            "work": 1, "cost_per_tick": 1, "value": 1}])
        with self.assertRaises(JobError):
            validate_jobs([{"id": "x", "arrival": 4, "deadline": 3,
                            "work": 1, "cost_per_tick": 1, "value": 1}])

    def test_negative_budget_rejected(self):
        with self.assertRaises(JobError):
            validate_budget(-1)

    def test_negative_cost_rejected(self):
        with self.assertRaises(JobError):
            validate_jobs([{"id": "x", "arrival": 0, "deadline": 2,
                            "work": 1, "cost_per_tick": -1, "value": 1}])

    def test_missing_field_rejected(self):
        with self.assertRaises(JobError):
            validate_jobs([{"id": "x", "arrival": 0, "deadline": 2,
                            "work": 1, "value": 1}])


class EdgeCases(unittest.TestCase):
    def test_empty_job_list(self):
        result = plan([], 5)
        self.assertEqual(result["earned"], 0)
        self.assertEqual(result["spent"], 0)
        self.assertEqual(result["schedule"], [])
        self.assertEqual(result["horizon"], 0)

    def test_zero_budget_all_idle(self):
        jobs = make_jobs([("a", 0, 3, 2, 1, 10)])
        result = plan(jobs, 0)
        self.assertEqual(result["earned"], 0)
        self.assertEqual(result["spent"], 0)
        self.assertEqual(result["schedule"], ["idle", "idle", "idle"])

    def test_infeasible_still_returns_legal_plan(self):
        # Job needs 5 ticks inside a 2-tick window: can never complete.
        jobs = make_jobs([("a", 0, 2, 5, 1, 10)])
        result = plan(jobs, 100)
        self.assertEqual(result["earned"], 0)
        self.assertEqual(result["completed"], [])
        self.assertLessEqual(result["spent"], 100)


if __name__ == "__main__":
    unittest.main()
