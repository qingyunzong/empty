"""Hierarchical roster solver.

Semantics
---------
Hard constraints (always enforced):
  1. an employee may only fill a shift matching one of their skills;
  2. an employee never works on an off day (off sticks to the whole ISO week);
  3. an employee works at most one shift per day.

The base ``demand`` is hard: if it cannot be fully satisfied the result is
``status == "infeasible"`` (no exception is raised).

``levels`` is an ordered list of soft demand layers.  Levels are attempted
from index 0 upwards.  Each level is solved with a deterministic search
ordered by: largest demand-gap date first, ties broken by date, then by
employee id (skill ties broken by skill name).  If a level cannot be fully
satisfied, every assignment added for that level is rolled back, the level
name is appended to ``relaxed`` and its demand is reported under ``unmet``;
deeper levels are then attempted against the unchanged higher-level
assignments.  Already fixed higher levels are never modified.
"""

from __future__ import annotations

from datetime import date

BAD_ROSTER = "BAD_ROSTER"


class RosterError(Exception):
    """Validation error carrying a machine readable ``code``."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _parse_day(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise RosterError(BAD_ROSTER, "invalid date: %r" % (value,))


def _check_demand(demand, known_skills, where):
    if not isinstance(demand, dict):
        raise RosterError(BAD_ROSTER, "demand must be an object in %s" % where)
    for day, skills in demand.items():
        _parse_day(day)
        if not isinstance(skills, dict):
            raise RosterError(BAD_ROSTER, "demand for %s must be an object in %s" % (day, where))
        for skill, count in skills.items():
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise RosterError(
                    BAD_ROSTER, "negative demand for skill %r on %s in %s" % (skill, day, where)
                )
            if skill not in known_skills:
                raise RosterError(BAD_ROSTER, "unknown skill %r in %s" % (skill, where))


def _validate(problem):
    if not isinstance(problem, dict):
        raise RosterError(BAD_ROSTER, "problem must be a JSON object")
    employees = problem.get("employees") or []
    known_skills = set()
    for emp in employees:
        if not isinstance(emp, dict) or "id" not in emp:
            raise RosterError(BAD_ROSTER, "each employee needs an 'id'")
        known_skills.update(emp.get("skills") or [])
    _check_demand(problem.get("demand") or {}, known_skills, "demand")
    levels = problem.get("levels") or []
    names = []
    for level in levels:
        if not isinstance(level, dict) or not level.get("name"):
            raise RosterError(BAD_ROSTER, "each level needs a 'name'")
        names.append(level["name"])
        _check_demand(level.get("demand") or {}, known_skills, "level %r" % level["name"])
    if len(set(names)) != len(names):
        raise RosterError(BAD_ROSTER, "duplicate level names")
    return employees, levels


def _horizon(problem, levels):
    days = set(problem.get("days") or [])
    days.update((problem.get("demand") or {}).keys())
    for level in levels:
        days.update((level.get("demand") or {}).keys())
    for day in days:
        _parse_day(day)
    return sorted(days)


def _off_days(problem, horizon):
    """Expand off dates to their whole ISO week within the horizon."""
    week_of = {day: _parse_day(day).isocalendar()[:2] for day in horizon}
    off = {}
    for emp_id, dates in (problem.get("off") or {}).items():
        weeks = {_parse_day(day).isocalendar()[:2] for day in dates}
        off[emp_id] = frozenset(day for day in horizon if week_of[day] in weeks)
    return off


def _positive(demand):
    """Keep only strictly positive demand entries, sorted for determinism."""
    out = {}
    for day in sorted(demand):
        skills = {s: c for s, c in sorted(demand[day].items()) if c > 0}
        if skills:
            out[day] = skills
    return out


class _Solver:
    def __init__(self, employees, horizon, off):
        self.employees = sorted(employees, key=lambda e: e["id"])
        self.skills_of = {e["id"]: set(e.get("skills") or []) for e in self.employees}
        self.horizon = horizon
        self.off = off
        self.assigned = set()  # (day, employee_id) already working that day
        self.assignments = []  # (day, employee_id, skill, level) in fill order

    def _candidates(self, day, skill):
        return [
            e["id"]
            for e in self.employees
            if skill in self.skills_of[e["id"]]
            and (day, e["id"]) not in self.assigned
            and day not in self.off.get(e["id"], frozenset())
        ]

    def fill(self, remaining, level_name):
        """Assign ``remaining`` demand; True on full success.

        On failure every assignment made inside this call is undone, so the
        caller's state is exactly restored (per-level rollback).
        """
        best_day, best_gap = None, 0
        for day in self.horizon:
            gap = sum(remaining.get(day, {}).values())
            if gap > best_gap:  # strict: ties keep the earliest date
                best_day, best_gap = day, gap
        if best_day is None:
            return True
        skills = remaining[best_day]
        # skill with the largest gap; ties broken by skill name
        skill = max(sorted(skills), key=lambda s: skills[s])
        available = [
            e["id"]
            for e in self.employees
            if (best_day, e["id"]) not in self.assigned
            and best_day not in self.off.get(e["id"], frozenset())
        ]
        if best_gap > len(available):
            return False
        candidates = self._candidates(best_day, skill)
        if skills[skill] > len(candidates):
            return False
        for emp_id in candidates:
            self.assigned.add((best_day, emp_id))
            self.assignments.append((best_day, emp_id, skill, level_name))
            skills[skill] -= 1
            if skills[skill] == 0:
                del skills[skill]
            if self.fill(remaining, level_name):
                return True
            skills[skill] = skills.get(skill, 0) + 1
            self.assignments.pop()
            self.assigned.discard((best_day, emp_id))
        return False


def solve(problem):
    """Solve a roster problem; see the module docstring for the semantics."""
    employees, levels = _validate(problem)
    horizon = _horizon(problem, levels)
    off = _off_days(problem, horizon)
    solver = _Solver(employees, horizon, off)

    base_demand = problem.get("demand") or {}
    if not solver.fill(_positive(base_demand), "base"):
        return {
            "status": "infeasible",
            "assignments": [],
            "relaxed": [],
            "unmet": {"base": _positive(base_demand)},
        }

    relaxed = []
    unmet = {}
    for level in levels:
        name = level["name"]
        demand = level.get("demand") or {}
        if solver.fill(_positive(demand), name):
            continue
        # infeasible level: fill() already rolled back its own assignments
        relaxed.append(name)
        unmet[name] = _positive(demand)

    assignments = [
        {"date": day, "employee": emp, "skill": skill, "level": level}
        for day, emp, skill, level in sorted(solver.assignments)
    ]
    return {
        "status": "ok",
        "assignments": assignments,
        "relaxed": relaxed,
        "unmet": unmet,
    }
