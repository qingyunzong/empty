"""Input validation and shared model helpers for rostersolve."""
from __future__ import annotations


class InputError(Exception):
    """Raised for any invalid user input (maps to CLI exit code 2)."""


def id_sort_key(value):
    """Deterministic ordering key for job/machine ids (ints before strs)."""
    if isinstance(value, bool):
        raise InputError("boolean is not a valid id")
    if isinstance(value, int):
        return (0, value, "")
    if isinstance(value, str):
        return (1, 0, value)
    raise InputError(f"id must be a string or integer, got {type(value).__name__}")


def _require_int(obj, field, owner):
    value = obj.get(field, None)
    if value is None and field not in obj:
        raise InputError(f"{owner}: missing field '{field}'")
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputError(f"{owner}: field '{field}' must be an integer")
    return value


def _require_tags(obj, owner):
    tags = obj.get("tags", [])
    if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
        raise InputError(f"{owner}: field 'tags' must be a list of strings")
    return list(tags)


def load_instance(data):
    """Validate a decoded JSON document.

    Returns (jobs, machines, horizon) where jobs/machines are lists of
    normalized dicts. Raises InputError on any violation.
    """
    if not isinstance(data, dict):
        raise InputError("top-level value must be a JSON object")
    for field in ("jobs", "machines", "horizon"):
        if field not in data:
            raise InputError(f"missing field '{field}'")
    if not isinstance(data["jobs"], list):
        raise InputError("field 'jobs' must be a list")
    if not isinstance(data["machines"], list):
        raise InputError("field 'machines' must be a list")
    horizon = data["horizon"]
    if isinstance(horizon, bool) or not isinstance(horizon, int):
        raise InputError("field 'horizon' must be an integer")
    if horizon < 0:
        raise InputError("field 'horizon' must be non-negative")

    jobs = []
    seen = set()
    for raw in data["jobs"]:
        if not isinstance(raw, dict):
            raise InputError("each job must be an object")
        jid = raw.get("id")
        id_sort_key(jid)  # validates type
        if jid in seen:
            raise InputError(f"duplicate job id {jid!r}")
        seen.add(jid)
        owner = f"job {jid!r}"
        cpu = _require_int(raw, "cpu", owner)
        mem = _require_int(raw, "mem", owner)
        deadline = _require_int(raw, "deadline", owner)
        duration = _require_int(raw, "duration", owner)
        if cpu < 0 or mem < 0:
            raise InputError(f"{owner}: negative resource requirement")
        if deadline < 0:
            raise InputError(f"{owner}: negative deadline")
        if duration < 1:
            raise InputError(f"{owner}: duration must be a positive integer")
        deps = raw.get("deps", [])
        if not isinstance(deps, list):
            raise InputError(f"{owner}: field 'deps' must be a list")
        for d in deps:
            id_sort_key(d)
        jobs.append({
            "id": jid,
            "cpu": cpu,
            "mem": mem,
            "deadline": deadline,
            "duration": duration,
            "deps": list(dict.fromkeys(deps)),
            "tags": _require_tags(raw, owner),
        })

    machines = []
    seen = set()
    for raw in data["machines"]:
        if not isinstance(raw, dict):
            raise InputError("each machine must be an object")
        mid = raw.get("id")
        id_sort_key(mid)
        if mid in seen:
            raise InputError(f"duplicate machine id {mid!r}")
        seen.add(mid)
        owner = f"machine {mid!r}"
        cpu = _require_int(raw, "cpu", owner)
        mem = _require_int(raw, "mem", owner)
        if cpu < 0 or mem < 0:
            raise InputError(f"{owner}: negative resource capacity")
        machines.append({
            "id": mid,
            "cpu": cpu,
            "mem": mem,
            "tags": _require_tags(raw, owner),
        })

    job_ids = {j["id"] for j in jobs}
    for j in jobs:
        for d in j["deps"]:
            if d not in job_ids:
                raise InputError(f"job {j['id']!r}: unknown dependency {d!r}")
    _check_cycles(jobs)
    return jobs, machines, horizon


def _check_cycles(jobs):
    by_id = {j["id"]: j for j in jobs}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {j["id"]: WHITE for j in jobs}

    def visit(node):
        color[node] = GRAY
        for dep in by_id[node]["deps"]:
            if color[dep] == GRAY:
                raise InputError(f"cyclic dependency involving job {dep!r}")
            if color[dep] == WHITE:
                visit(dep)
        color[node] = BLACK

    for jid in sorted(color, key=id_sort_key):
        if color[jid] == WHITE:
            visit(jid)


def topo_order(jobs):
    """Return jobs topologically sorted (deps first), ties broken by id."""
    by_id = {j["id"]: j for j in jobs}
    indegree = {j["id"]: 0 for j in jobs}
    dependents = {j["id"]: [] for j in jobs}
    for j in jobs:
        for d in j["deps"]:
            indegree[j["id"]] += 1
            dependents[d].append(j["id"])
    import heapq
    ready = [(id_sort_key(jid), jid) for jid, deg in indegree.items() if deg == 0]
    heapq.heapify(ready)
    ordered = []
    while ready:
        _, jid = heapq.heappop(ready)
        ordered.append(by_id[jid])
        for child in dependents[jid]:
            indegree[child] -= 1
            if indegree[child] == 0:
                heapq.heappush(ready, (id_sort_key(child), child))
    return ordered
