import random
import unittest

from budgetfn.planner import IDLE, InputError, _is_better, evaluate, solve


def schedule_of(plan):
    return tuple(tick["job"] for tick in plan["ticks"])


def brute_force_best(jobs, budget):
    """Exhaustively enumerate every per-tick choice and return the best
    (earned, neg_compsum, schedule) under the same lexicographic objective."""
    horizon = max((job["deadline"] for job in jobs), default=0)
    best = None

    def rec(t, spent, remaining, earned, neg_compsum, schedule):
        nonlocal best
        if t == horizon:
            candidate = (earned, neg_compsum, tuple(schedule))
            if _is_better(candidate, best):
                best = candidate
            return
        rec(t + 1, spent, remaining, earned, neg_compsum, schedule + [IDLE])
        for i, job in enumerate(jobs):
            if not (job["arrival"] <= t < job["deadline"]):
                continue
            if remaining[i] == 0:
                continue
            cost = job["cost_per_tick"]
            if spent + cost > budget:
                continue
            new_remaining = list(remaining)
            new_remaining[i] -= 1
            gain_v = job["value"] if new_remaining[i] == 0 else 0
            gain_c = -t if new_remaining[i] == 0 else 0
            rec(
                t + 1,
                spent + cost,
                tuple(new_remaining),
                earned + gain_v,
                neg_compsum + gain_c,
                schedule + [job["id"]],
            )

    rec(0, 0, tuple(job["work"] for job in jobs), 0, 0, [])
    return best


class AcceptanceScenarios(unittest.TestCase):
    def test_a_budget_exactly_covers_high_value_job(self):
        jobs = [
            {"id": "high", "arrival": 0, "deadline": 3, "work": 2,
             "cost_per_tick": 5, "value": 100},
            {"id": "low", "arrival": 0, "deadline": 3, "work": 1,
             "cost_per_tick": 5, "value": 10},
        ]
        plan = solve(jobs, 10)
        self.assertEqual(plan["earned"], 100)
        self.assertEqual(plan["spent"], 10)
        self.assertEqual(schedule_of(plan), ("high", "high", IDLE))
        self.assertEqual(plan["completed"], ["high"])

    def test_b_preempted_long_job_stopped_by_budget_earns_nothing(self):
        jobs = [
            {"id": "long", "arrival": 0, "deadline": 6, "work": 5,
             "cost_per_tick": 2, "value": 50},
        ]
        # Semantics: a schedule that runs out of budget mid-way earns 0
        # but the partial spend still counts.
        spent, earned, _ = evaluate(
            jobs, 4, ("long", "long", IDLE, IDLE, IDLE, IDLE)
        )
        self.assertEqual((spent, earned), (4, 0))
        # The optimizer therefore prefers a legal all-idle plan over
        # burning budget on a job it cannot finish.
        plan = solve(jobs, 4)
        self.assertEqual(plan["earned"], 0)
        self.assertEqual(plan["spent"], 0)
        self.assertEqual(schedule_of(plan), (IDLE,) * 6)
        self.assertEqual(plan["completed"], [])

    def test_c_tie_breaks_by_completion_time_sum_then_job_id(self):
        # Equal value, only one affordable: earlier completion wins even
        # though "z" sorts after "a".
        jobs = [
            {"id": "z", "arrival": 0, "deadline": 1, "work": 1,
             "cost_per_tick": 1, "value": 10},
            {"id": "a", "arrival": 1, "deadline": 2, "work": 1,
             "cost_per_tick": 1, "value": 10},
        ]
        plan = solve(jobs, 1)
        self.assertEqual(schedule_of(plan), ("z", IDLE))
        self.assertEqual(plan["completion_time_sum"], 0)
        # Same completion-time sum on both sides: lexicographic job id wins.
        jobs = [
            {"id": "b", "arrival": 0, "deadline": 1, "work": 1,
             "cost_per_tick": 1, "value": 10},
            {"id": "a", "arrival": 0, "deadline": 1, "work": 1,
             "cost_per_tick": 1, "value": 10},
        ]
        plan = solve(jobs, 1)
        self.assertEqual(schedule_of(plan), ("a",))

    def test_preemption_is_allowed(self):
        jobs = [
            {"id": "p", "arrival": 0, "deadline": 4, "work": 2,
             "cost_per_tick": 1, "value": 30},
            {"id": "urgent", "arrival": 1, "deadline": 2, "work": 1,
             "cost_per_tick": 1, "value": 10},
        ]
        plan = solve(jobs, 3)
        self.assertEqual(schedule_of(plan), ("p", "urgent", "p", IDLE))
        self.assertEqual(plan["earned"], 40)

    def test_all_idle_when_nothing_completable(self):
        jobs = [
            {"id": "x", "arrival": 0, "deadline": 2, "work": 3,
             "cost_per_tick": 1, "value": 5},
        ]
        plan = solve(jobs, 100)
        self.assertEqual(plan["earned"], 0)
        self.assertEqual(schedule_of(plan), (IDLE, IDLE))

    def test_empty_job_list(self):
        plan = solve([], 5)
        self.assertEqual(plan["horizon"], 0)
        self.assertEqual(plan["ticks"], [])
        self.assertEqual(plan["spent"], 0)
        self.assertEqual(plan["earned"], 0)


class BruteForceCrossCheck(unittest.TestCase):
    def check_against_brute_force(self, jobs, budget):
        plan = solve(jobs, budget)
        schedule = schedule_of(plan)
        spent, earned, compsum = evaluate(jobs, budget, schedule)
        self.assertEqual(spent, plan["spent"])
        self.assertEqual(earned, plan["earned"])
        bf_value, bf_neg_compsum, bf_schedule = brute_force_best(jobs, budget)
        self.assertEqual(earned, bf_value)
        self.assertEqual(compsum, -bf_neg_compsum)
        self.assertEqual(schedule, bf_schedule)

    def test_d_random_small_instances_match_enumeration(self):
        rng = random.Random(20261001)
        for case in range(60):
            n = rng.randint(1, 4)
            horizon = rng.randint(1, 7)
            jobs = []
            for i in range(n):
                arrival = rng.randint(0, horizon - 1)
                deadline = rng.randint(arrival + 1, horizon)
                jobs.append({
                    "id": f"j{i}",
                    "arrival": arrival,
                    "deadline": deadline,
                    "work": rng.randint(1, 3),
                    "cost_per_tick": rng.randint(0, 3),
                    "value": rng.randint(1, 9),
                })
            budget = rng.randint(0, 8)
            with self.subTest(case=case, jobs=jobs, budget=budget):
                self.check_against_brute_force(jobs, budget)

    def test_d_eight_jobs_horizon_fifteen_disjoint_windows(self):
        # 8 jobs, horizon 15: at most one job eligible per tick keeps the
        # enumeration tractable (2^15 leaf schedules).
        jobs = []
        for i in range(8):
            start = i * 2 - (1 if i == 7 else 0)  # windows within [0, 15]
            jobs.append({
                "id": f"j{i}",
                "arrival": max(0, start),
                "deadline": min(15, max(0, start) + 2),
                "work": 1 + (i % 2),
                "cost_per_tick": 1 + (i % 3),
                "value": 2 + i,
            })
        for budget in (0, 3, 7, 20):
            with self.subTest(budget=budget):
                self.check_against_brute_force(jobs, budget)

    def test_d_overlapping_windows_horizon_fifteen(self):
        # 8 jobs, horizon 15, but each job has a 2-tick window so at most
        # two jobs are eligible at any tick (<= 3 choices per tick).
        rng = random.Random(7)
        jobs = []
        for i in range(8):
            arrival = rng.randint(0, 13)
            jobs.append({
                "id": f"k{i}",
                "arrival": arrival,
                "deadline": arrival + 2,
                "work": rng.randint(1, 2),
                "cost_per_tick": rng.randint(0, 2),
                "value": rng.randint(1, 9),
            })
        for budget in (2, 6, 12):
            with self.subTest(budget=budget):
                self.check_against_brute_force(jobs, budget)


class ValidationErrors(unittest.TestCase):
    def test_deadline_not_after_arrival(self):
        jobs = [{"id": "x", "arrival": 2, "deadline": 2, "work": 1,
                 "cost_per_tick": 1, "value": 1}]
        with self.assertRaises(InputError):
            solve(jobs, 10)
        jobs[0]["deadline"] = 1
        with self.assertRaises(InputError):
            solve(jobs, 10)

    def test_negative_budget(self):
        with self.assertRaises(InputError):
            solve([], -1)

    def test_negative_cost_per_tick(self):
        jobs = [{"id": "x", "arrival": 0, "deadline": 1, "work": 1,
                 "cost_per_tick": -1, "value": 1}]
        with self.assertRaises(InputError):
            solve(jobs, 10)

    def test_evaluate_rejects_infeasible_schedules(self):
        jobs = [{"id": "x", "arrival": 1, "deadline": 3, "work": 1,
                 "cost_per_tick": 2, "value": 5}]
        with self.assertRaises(InputError):  # runs before arrival
            evaluate(jobs, 10, ("x", IDLE, IDLE))
        with self.assertRaises(InputError):  # exceeds budget
            evaluate(jobs, 1, (IDLE, "x", IDLE))
        with self.assertRaises(InputError):  # unknown job
            evaluate(jobs, 10, (IDLE, "y", IDLE))


class Determinism(unittest.TestCase):
    def test_e_repeated_solves_are_identical(self):
        jobs = [
            {"id": f"j{i}", "arrival": i % 3, "deadline": 5 + i, "work": 2,
             "cost_per_tick": 1 + i % 2, "value": 3 * i + 1}
            for i in range(5)
        ]
        first = solve(jobs, 9)
        for _ in range(4):
            self.assertEqual(solve(jobs, 9), first)


if __name__ == "__main__":
    unittest.main()
