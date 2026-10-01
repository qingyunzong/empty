import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from rostersolve import Solver, brute_feasible, minimal_conflict, parse_problem

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_problem(jobs, machines, horizon):
    return parse_problem(json.dumps({
        "jobs": jobs, "machines": machines, "horizon": horizon}))


def run_cli(input_path, out_path, trace_path):
    return subprocess.run(
        [sys.executable, "-m", "rostersolve", "plan", input_path,
         "--out", out_path, "--trace", trace_path],
        cwd=ROOT, capture_output=True, text=True)


class TestA_ChainAndCapacity(unittest.TestCase):
    """Two-job dependency chain on a single machine at its capacity boundary."""

    def test_chain_respects_dependency_and_capacity(self):
        jobs = [
            {"id": "j1", "cpu": 2, "mem": 1, "duration": 2, "deadline": 6,
             "deps": [], "tags": []},
            {"id": "j2", "cpu": 2, "mem": 1, "duration": 2, "deadline": 6,
             "deps": ["j1"], "tags": []},
        ]
        machines = [{"id": "m1", "cpu": 2, "mem": 1, "tags": []}]
        problem = make_problem(jobs, machines, 6)
        placement = Solver(problem).solve()
        self.assertIsNotNone(placement)
        m1, s1 = placement["j1"]
        m2, s2 = placement["j2"]
        self.assertGreaterEqual(s2, s1 + 2, "j2 must start after j1 finishes")
        # Capacity boundary: each job uses the full machine, so no overlap.
        self.assertTrue(s1 + 2 <= s2 or s2 + 2 <= s1)

    def test_capacity_boundary_one_less_is_infeasible(self):
        jobs = [
            {"id": "j1", "cpu": 2, "mem": 1, "duration": 2, "deadline": 6,
             "deps": [], "tags": []},
            {"id": "j2", "cpu": 2, "mem": 1, "duration": 2, "deadline": 6,
             "deps": [], "tags": []},
        ]
        # horizon=2: both jobs must occupy slots 0..1. Machine cpu=2 fits
        # exactly one of them -> infeasible; cpu=4 fits both -> feasible.
        machines = [{"id": "m1", "cpu": 2, "mem": 1, "tags": []}]
        problem = make_problem(jobs, machines, 2)
        self.assertIsNone(Solver(problem).solve())
        conflict = minimal_conflict(problem)
        self.assertTrue(conflict)
        machines = [{"id": "m1", "cpu": 4, "mem": 2, "tags": []}]
        problem = make_problem(jobs, machines, 2)
        self.assertIsNotNone(Solver(problem).solve())

    def test_example_a_via_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "plan.json")
            trace_path = os.path.join(tmp, "trace.json")
            result = run_cli(os.path.join(ROOT, "examples", "a.json"),
                             out_path, trace_path)
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(out_path) as fh:
                plan = json.load(fh)
            self.assertEqual(plan["status"], "FEASIBLE")
            self.assertEqual(plan["makespan"], 4)
            slots = plan["machines"][0]["slots"]
            self.assertEqual(slots[:4], ["j1", "j1", "j2", "j2"])
            self.assertEqual(slots[4:], [None, None])


class TestB_TagMismatch(unittest.TestCase):
    """A job whose tags no machine provides must be INFEASIBLE with a
    non-empty minimal conflict subset."""

    def test_tag_mismatch_infeasible_with_conflict(self):
        jobs = [
            {"id": "needs-gpu", "cpu": 1, "mem": 1, "duration": 1,
             "deadline": 4, "deps": [], "tags": ["gpu"]},
            {"id": "plain", "cpu": 1, "mem": 1, "duration": 1,
             "deadline": 4, "deps": [], "tags": []},
        ]
        machines = [{"id": "m1", "cpu": 4, "mem": 4, "tags": ["cpu-only"]}]
        problem = make_problem(jobs, machines, 4)
        self.assertIsNone(Solver(problem).solve())
        conflict = minimal_conflict(problem)
        self.assertEqual(conflict, ["needs-gpu"])

    def test_tag_mismatch_via_cli(self):
        doc = {
            "horizon": 4,
            "jobs": [{"id": "x", "cpu": 1, "mem": 1, "duration": 1,
                      "deadline": 4, "deps": [], "tags": ["gpu"]}],
            "machines": [{"id": "m1", "cpu": 1, "mem": 1, "tags": []}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            in_path = os.path.join(tmp, "in.json")
            out_path = os.path.join(tmp, "out.json")
            trace_path = os.path.join(tmp, "trace.json")
            with open(in_path, "w") as fh:
                json.dump(doc, fh)
            result = run_cli(in_path, out_path, trace_path)
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(out_path) as fh:
                plan = json.load(fh)
            self.assertEqual(plan["status"], "INFEASIBLE")
            self.assertTrue(plan["conflict"], "conflict subset must be non-empty")


def random_case(rng):
    n = rng.randint(1, 8)
    horizon = rng.randint(1, 12)
    n_machines = rng.randint(1, 3)
    tag_pool = ["gpu", "ssd", "big"]
    jobs = []
    for i in range(n):
        jid = "j%d" % i
        duration = rng.randint(1, min(3, horizon))
        deps = ["j%d" % k for k in range(i) if rng.random() < 0.25]
        deadline = rng.choice([None, rng.randint(duration, horizon)])
        jobs.append({
            "id": jid,
            "cpu": rng.randint(0, 3),
            "mem": rng.randint(0, 3),
            "duration": duration,
            "deadline": deadline,
            "deps": deps,
            "tags": [t for t in tag_pool if rng.random() < 0.3],
        })
    machines = []
    for i in range(n_machines):
        machines.append({
            "id": "m%d" % i,
            "cpu": rng.randint(1, 4),
            "mem": rng.randint(1, 4),
            "tags": [t for t in tag_pool if rng.random() < 0.5],
        })
    return {"jobs": jobs, "machines": machines, "horizon": horizon}


class TestC_BruteForceCrossCheck(unittest.TestCase):
    """Random small cases (n<=8, horizon<=12): Solver feasibility must match
    an independent brute-force enumeration of all schedules."""

    def test_random_cases_match_brute_force(self):
        rng = random.Random(20261001)
        cases = 300
        feasible_count = 0
        for case_no in range(cases):
            doc = random_case(rng)
            problem = parse_problem(json.dumps(doc))
            expected = brute_feasible(problem)
            got = Solver(problem).solve() is not None
            if expected:
                feasible_count += 1
            self.assertEqual(
                got, expected,
                "case %d mismatch (brute=%s): %s" % (case_no, expected, doc))
        # Sanity: the random suite must exercise both outcomes.
        self.assertGreater(feasible_count, 0)
        self.assertGreater(cases - feasible_count, 0)


class TestD_DeterministicTrace(unittest.TestCase):
    """Same input, 5 consecutive runs: trace (and plan) bytes identical."""

    def test_trace_is_byte_identical_across_runs(self):
        doc = {
            "horizon": 8,
            "jobs": [
                {"id": "a", "cpu": 1, "mem": 1, "duration": 2, "deadline": 8,
                 "deps": [], "tags": []},
                {"id": "b", "cpu": 2, "mem": 1, "duration": 3, "deadline": 8,
                 "deps": ["a"], "tags": ["x"]},
                {"id": "c", "cpu": 1, "mem": 2, "duration": 1, "deadline": 6,
                 "deps": [], "tags": ["x"]},
            ],
            "machines": [
                {"id": "m1", "cpu": 2, "mem": 2, "tags": ["x"]},
                {"id": "m2", "cpu": 3, "mem": 1, "tags": []},
            ],
        }
        traces = []
        plans = []
        with tempfile.TemporaryDirectory() as tmp:
            in_path = os.path.join(tmp, "in.json")
            with open(in_path, "w") as fh:
                json.dump(doc, fh)
            for run in range(5):
                out_path = os.path.join(tmp, "out%d.json" % run)
                trace_path = os.path.join(tmp, "trace%d.json" % run)
                result = run_cli(in_path, out_path, trace_path)
                self.assertEqual(result.returncode, 0, result.stderr)
                with open(trace_path, "rb") as fh:
                    traces.append(fh.read())
                with open(out_path, "rb") as fh:
                    plans.append(fh.read())
        for run in range(1, 5):
            self.assertEqual(traces[0], traces[run],
                             "trace bytes differ on run %d" % run)
            self.assertEqual(plans[0], plans[run],
                             "plan bytes differ on run %d" % run)


if __name__ == "__main__":
    unittest.main()
