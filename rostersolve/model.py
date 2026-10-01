"""Input model, JSON parsing and validation for rostersolve."""

import json
from dataclasses import dataclass


class InputError(Exception):
    """Any invalid user input. The CLI maps this to exit code 2."""


def id_key(value):
    """Deterministic ordering key for job/machine ids (lexicographic)."""
    return str(value)


@dataclass(frozen=True)
class Job:
    id: object
    cpu: int
    mem: int
    duration: int
    deadline: object  # int or None (None means "horizon")
    deps: tuple
    tags: frozenset


@dataclass(frozen=True)
class Machine:
    id: object
    cpu: int
    mem: int
    tags: frozenset


@dataclass(frozen=True)
class Problem:
    jobs: tuple      # Job objects, sorted by id_key
    machines: tuple  # Machine objects, sorted by id_key
    horizon: int

    @property
    def job_map(self):
        return {job.id: job for job in self.jobs}


def _check_int(value, field, minimum=None, allow_none=False):
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputError("field '%s' must be an integer" % field)
    if minimum is not None and value < minimum:
        raise InputError("field '%s' must be >= %d (got %d)" % (field, minimum, value))
    return value


def _check_id(value, field):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise InputError("field '%s' must be a string or integer id" % field)
    return value


def _check_tags(value, field):
    if not isinstance(value, list) or any(not isinstance(t, str) for t in value):
        raise InputError("field '%s' must be a list of strings" % field)
    return frozenset(value)


def _parse_job(raw, index):
    if not isinstance(raw, dict):
        raise InputError("jobs[%d] must be an object" % index)
    for field in ("id", "cpu", "mem", "duration", "deadline", "deps", "tags"):
        if field not in raw:
            raise InputError("jobs[%d]: missing field '%s'" % (index, field))
    jid = _check_id(raw["id"], "id")
    cpu = _check_int(raw["cpu"], "cpu", minimum=0)
    mem = _check_int(raw["mem"], "mem", minimum=0)
    duration = _check_int(raw["duration"], "duration", minimum=1)
    deadline = _check_int(raw["deadline"], "deadline", minimum=0, allow_none=True)
    deps_raw = raw["deps"]
    if not isinstance(deps_raw, list):
        raise InputError("jobs[%d]: field 'deps' must be a list" % index)
    deps = tuple(_check_id(d, "deps") for d in deps_raw)
    if len(set(deps)) != len(deps):
        raise InputError("job %r: duplicate entries in 'deps'" % (jid,))
    if jid in deps:
        raise InputError("job %r: cyclic dependency (self-dependency)" % (jid,))
    tags = _check_tags(raw["tags"], "tags")
    return Job(id=jid, cpu=cpu, mem=mem, duration=duration,
               deadline=deadline, deps=deps, tags=tags)


def _parse_machine(raw, index):
    if not isinstance(raw, dict):
        raise InputError("machines[%d] must be an object" % index)
    for field in ("id", "cpu", "mem", "tags"):
        if field not in raw:
            raise InputError("machines[%d]: missing field '%s'" % (index, field))
    mid = _check_id(raw["id"], "id")
    cpu = _check_int(raw["cpu"], "cpu", minimum=0)
    mem = _check_int(raw["mem"], "mem", minimum=0)
    tags = _check_tags(raw["tags"], "tags")
    return Machine(id=mid, cpu=cpu, mem=mem, tags=tags)


def _check_cycles(jobs):
    job_map = {job.id: job for job in jobs}
    state = {}  # 0=unvisited implicit, 1=in stack, 2=done

    def visit(jid):
        state[jid] = 1
        for dep in job_map[jid].deps:
            if dep not in job_map:
                raise InputError("job %r: unknown dependency %r" % (jid, dep))
            if state.get(dep) == 1:
                raise InputError("cyclic dependency detected involving job %r" % (dep,))
            if state.get(dep, 0) == 0:
                visit(dep)
        state[jid] = 2

    for job in jobs:
        if state.get(job.id, 0) == 0:
            visit(job.id)


def parse_problem(text):
    """Parse and validate the input JSON document. Raises InputError."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise InputError("invalid JSON: %s" % exc) from exc
    if not isinstance(data, dict):
        raise InputError("top-level value must be a JSON object")
    for field in ("jobs", "machines", "horizon"):
        if field not in data:
            raise InputError("missing field '%s'" % field)
    horizon = _check_int(data["horizon"], "horizon", minimum=1)
    if not isinstance(data["jobs"], list):
        raise InputError("field 'jobs' must be a list")
    if not isinstance(data["machines"], list):
        raise InputError("field 'machines' must be a list")

    jobs = tuple(_parse_job(raw, i) for i, raw in enumerate(data["jobs"]))
    machines = tuple(_parse_machine(raw, i) for i, raw in enumerate(data["machines"]))

    job_ids = [job.id for job in jobs]
    if len(set(job_ids)) != len(job_ids):
        raise InputError("duplicate job id")
    machine_ids = [m.id for m in machines]
    if len(set(machine_ids)) != len(machine_ids):
        raise InputError("duplicate machine id")

    _check_cycles(jobs)

    jobs = tuple(sorted(jobs, key=lambda j: id_key(j.id)))
    machines = tuple(sorted(machines, key=lambda m: id_key(m.id)))
    return Problem(jobs=jobs, machines=machines, horizon=horizon)


def subproblem(problem, keep_ids):
    """Restrict the problem to a subset of jobs.

    Dependencies pointing outside the subset are dropped (treated as
    already satisfied), machines and horizon are kept unchanged.
    """
    keep = set(keep_ids)
    jobs = tuple(
        Job(id=j.id, cpu=j.cpu, mem=j.mem, duration=j.duration,
            deadline=j.deadline,
            deps=tuple(d for d in j.deps if d in keep),
            tags=j.tags)
        for j in problem.jobs if j.id in keep
    )
    return Problem(jobs=jobs, machines=problem.machines, horizon=problem.horizon)
