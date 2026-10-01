"""Independent brute-force feasibility checker used by the test suite.

Deliberately implemented separately from solver.Solver: jobs are assigned
in plain id order (not topological), dependency constraints are verified
on the complete assignment, and the leaf check rebuilds all resource
usage from scratch. Used to cross-check Solver on random small cases.
"""


def brute_feasible(problem):
    jobs = list(problem.jobs)
    machines = list(problem.machines)
    horizon = problem.horizon
    job_map = problem.job_map
    assign = {}

    cpu_used = {m.id: [0] * horizon for m in machines}
    mem_used = {m.id: [0] * horizon for m in machines}

    def leaf_ok():
        # Full, from-scratch verification of the complete assignment.
        usage = {m.id: [[0, 0] for _ in range(horizon)] for m in machines}
        mmap = {m.id: m for m in machines}
        for job in jobs:
            if job.id not in assign:
                return False
            mid, start = assign[job.id]
            machine = mmap[mid]
            if not job.tags <= machine.tags:
                return False
            deadline = job.deadline if job.deadline is not None else horizon
            if start < 0 or start + job.duration > horizon:
                return False
            if start + job.duration > deadline:
                return False
            for t in range(start, start + job.duration):
                usage[mid][t][0] += job.cpu
                usage[mid][t][1] += job.mem
        for machine in machines:
            for t in range(horizon):
                if usage[machine.id][t][0] > machine.cpu:
                    return False
                if usage[machine.id][t][1] > machine.mem:
                    return False
        for job in jobs:
            _, start = assign[job.id]
            for dep in job.deps:
                dep_job = job_map[dep]
                _, dep_start = assign[dep]
                if dep_start + dep_job.duration > start:
                    return False
        return True

    def rec(index):
        if index == len(jobs):
            return leaf_ok()
        job = jobs[index]
        deadline = job.deadline if job.deadline is not None else horizon
        latest = min(horizon, deadline) - job.duration
        for machine in machines:
            if job.cpu > machine.cpu or job.mem > machine.mem:
                continue
            if not job.tags <= machine.tags:
                continue
            for start in range(0, latest + 1):
                # Partial dependency pruning against already assigned jobs.
                ok = True
                for dep in job.deps:
                    if dep in assign:
                        dep_job = job_map[dep]
                        if assign[dep][1] + dep_job.duration > start:
                            ok = False
                            break
                if ok:
                    for other_id, other in assign.items():
                        other_job = job_map[other_id]
                        if job.id in other_job.deps and start + job.duration > other[1]:
                            ok = False
                            break
                if not ok:
                    continue
                # Incremental resource check.
                cpu_row = cpu_used[machine.id]
                mem_row = mem_used[machine.id]
                fits = True
                for t in range(start, start + job.duration):
                    if cpu_row[t] + job.cpu > machine.cpu or mem_row[t] + job.mem > machine.mem:
                        fits = False
                        break
                if not fits:
                    continue
                for t in range(start, start + job.duration):
                    cpu_row[t] += job.cpu
                    mem_row[t] += job.mem
                assign[job.id] = (machine.id, start)
                if rec(index + 1):
                    return True
                del assign[job.id]
                for t in range(start, start + job.duration):
                    cpu_row[t] -= job.cpu
                    mem_row[t] -= job.mem
        return False

    return rec(0)
