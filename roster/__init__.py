"""Layered roster scheduling.

Given employees with skills, per-day demand per skill, employee days off and
a priority list of soft-constraint levels, assign shifts level by level.
Higher levels are fixed once satisfied; if a level cannot be fully satisfied,
only that level's new assignments are rolled back and the level is marked as
relaxed before moving on to deeper levels.
"""

__all__ = ["BAD_ROSTER", "RosterError", "solve"]

BAD_ROSTER = "BAD_ROSTER"

_WEEKDAYS = {
    "mon": 0,
    "tue": 1,
    "wed": 2,
    "thu": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
}


class RosterError(ValueError):
    """Raised for invalid roster input. ``code`` is always ``BAD_ROSTER``."""

    code = BAD_ROSTER


def _normalize_demand(demand):
    if not isinstance(demand, dict):
        raise RosterError("demand must be an object mapping skill to per-day counts")
    normalized = {}
    num_days = None
    for skill, counts in demand.items():
        if not isinstance(skill, str):
            raise RosterError("demand skills must be strings")
        if not isinstance(counts, (list, tuple)):
            raise RosterError("demand for skill %r must be a list of counts" % skill)
        row = []
        for value in counts:
            if isinstance(value, bool) or not isinstance(value, int):
                raise RosterError("demand for skill %r must be integers" % skill)
            if value < 0:
                raise RosterError("demand for skill %r is negative" % skill)
            row.append(value)
        if num_days is None:
            num_days = len(row)
        elif len(row) != num_days:
            raise RosterError("demand rows must all have the same number of days")
        normalized[skill] = row
    return normalized, (num_days or 0)


def _normalize_employees(employees):
    if employees is None:
        return []
    if not isinstance(employees, (list, tuple)):
        raise RosterError("employees must be a list")
    staff = []
    seen = set()
    for entry in employees:
        if not isinstance(entry, dict) or "id" not in entry:
            raise RosterError("each employee must be an object with an 'id'")
        emp_id = entry["id"]
        if emp_id in seen:
            raise RosterError("duplicate employee id %r" % (emp_id,))
        seen.add(emp_id)
        skills = entry.get("skills", [])
        if not isinstance(skills, (list, tuple)):
            raise RosterError("skills of employee %r must be a list" % (emp_id,))
        staff.append((emp_id, set(skills)))
    staff.sort(key=lambda item: str(item[0]))
    return staff


def _expand_off(off, employee_ids, num_days):
    blocked = set()
    if not off:
        return blocked
    if not isinstance(off, dict):
        raise RosterError("off must be an object mapping employee id to day specs")
    for emp_id, specs in off.items():
        if emp_id not in employee_ids:
            continue
        if not isinstance(specs, (list, tuple)):
            raise RosterError("off entries for %r must be a list" % (emp_id,))
        for spec in specs:
            if isinstance(spec, str):
                key = spec.strip().lower()[:3]
                if key not in _WEEKDAYS:
                    raise RosterError("unknown weekday %r in off" % (spec,))
                weekday = _WEEKDAYS[key]
                # A weekday name blocks that weekday for the whole horizon.
                for day in range(num_days):
                    if day % 7 == weekday:
                        blocked.add((emp_id, day))
            elif isinstance(spec, int) and not isinstance(spec, bool):
                if 0 <= spec < num_days:
                    blocked.add((emp_id, spec))
            else:
                raise RosterError("invalid off day spec %r" % (spec,))
    return blocked


def _normalize_levels(levels, skills):
    if levels is None:
        levels = []
    if not isinstance(levels, (list, tuple)):
        raise RosterError("levels must be a list of skill lists")
    groups = []
    seen = set()
    for level in levels:
        if not isinstance(level, (list, tuple)):
            raise RosterError("each level must be a list of skills")
        group = []
        for skill in level:
            if skill not in skills:
                raise RosterError("unknown skill %r in levels" % (skill,))
            if skill in seen:
                raise RosterError("skill %r appears in more than one level" % (skill,))
            seen.add(skill)
            group.append(skill)
        groups.append(group)
    # Demand skills not listed in any level form an implicit lowest level.
    rest = sorted(skill for skill in skills if skill not in seen)
    if rest:
        groups.append(rest)
    return groups


def solve(employees, demand, off=None, levels=None, days=None):
    """Solve the layered roster problem.

    Returns a dict with keys ``status`` (``"ok"`` or ``"infeasible"``),
    ``assignments``, ``relaxed`` and ``unmet``. Never raises for hard
    infeasibility; raises :class:`RosterError` only for invalid input.
    """
    demand, num_days = _normalize_demand(demand)
    if not demand:
        if days is None:
            num_days = 0
        else:
            if isinstance(days, bool) or not isinstance(days, int) or days < 0:
                raise RosterError("days must be a non-negative integer")
            num_days = days
    staff = _normalize_employees(employees)
    employee_ids = {emp_id for emp_id, _ in staff}
    blocked = _expand_off(off, employee_ids, num_days)
    groups = _normalize_levels(levels, set(demand))

    remaining = {}
    for skill, row in demand.items():
        for day, count in enumerate(row):
            if count:
                remaining[(skill, day)] = count

    assigned_day = set()  # (employee, day) -> one shift per person per day
    assignments = []
    relaxed = []
    unmet = []

    for index, group in enumerate(groups):
        if not group:
            continue
        level_assignments = []
        while True:
            # Pick the date with the largest remaining demand gap; ties by date.
            best_day = None
            best_gap = 0
            for day in range(num_days):
                gap = sum(remaining.get((skill, day), 0) for skill in group)
                if gap > best_gap:
                    best_gap = gap
                    best_day = day
            if best_day is None:
                break  # level fully satisfied
            # Pick a feasible employee; ties by employee id (staff is sorted).
            chosen = None
            for emp_id, emp_skills in staff:
                if (emp_id, best_day) in assigned_day:
                    continue
                if (emp_id, best_day) in blocked:
                    continue
                options = [
                    skill
                    for skill in group
                    if skill in emp_skills and remaining.get((skill, best_day), 0) > 0
                ]
                if options:
                    chosen = (emp_id, options)
                    break
            if chosen is None:
                break  # no feasible assignment left for this level
            emp_id, options = chosen
            # Deterministic skill choice: largest gap, then skill name.
            skill = min(options, key=lambda s: (-remaining[(s, best_day)], s))
            remaining[(skill, best_day)] -= 1
            assigned_day.add((emp_id, best_day))
            level_assignments.append(
                {"day": best_day, "employee": emp_id, "skill": skill}
            )

        satisfied = all(
            remaining.get((skill, day), 0) == 0
            for skill in group
            for day in range(num_days)
        )
        if satisfied:
            assignments.extend(level_assignments)
        else:
            # Roll back only this level's new assignments; higher levels stay.
            for entry in level_assignments:
                assigned_day.discard((entry["employee"], entry["day"]))
                remaining[(entry["skill"], entry["day"])] += 1
            relaxed.append(index)
            for skill in group:
                for day in range(num_days):
                    count = remaining.get((skill, day), 0)
                    if count:
                        unmet.append({"day": day, "skill": skill, "count": count})

    assignments.sort(key=lambda e: (e["day"], str(e["employee"]), e["skill"]))
    unmet.sort(key=lambda e: (e["day"], e["skill"]))

    total_demand = sum(sum(row) for row in demand.values())
    status = "ok" if assignments or total_demand == 0 else "infeasible"
    return {
        "status": status,
        "assignments": assignments,
        "relaxed": relaxed,
        "unmet": unmet,
    }
