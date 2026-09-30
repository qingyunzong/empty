# roster

Layered roster scheduling library and CLI (Python 3.11+, standard library only).

## Model

- **Hard constraints**: an assignment requires a matching skill, the employee
  must not be off that day, and each employee works at most one shift per day.
- **Levels**: `levels` is a priority-ordered list of skill groups. Levels are
  solved from `levels[0]` (highest) downwards. A level is all-or-nothing: if
  its demand cannot be fully satisfied, only that level's new assignments are
  rolled back, the level index is recorded in `relaxed`, and solving continues
  with deeper levels. Assignments fixed by higher levels are never changed.
  Demand skills not listed in any level form an implicit lowest level.
- **Greedy order within a level**: pick the date with the largest remaining
  demand gap; ties break by earlier date, then by smaller employee id.
- **Off days**: `off` maps an employee id to a list of day indices (ints) or
  weekday names (`"mon"`..`"sun"`); a weekday name blocks that weekday for the
  whole horizon.

## Input (JSON)

```json
{
  "employees": [{"id": "e1", "skills": ["a", "b"]}],
  "demand": {"a": [1, 1], "b": [1, 0]},
  "off": {"e1": ["mon", 3]},
  "levels": [["a"], ["b"]]
}
```

`demand` maps a skill to per-day required counts; the list length defines the
horizon. Output contains `status` (`"ok"` or `"infeasible"`), `assignments`,
`relaxed` (level indices) and `unmet` (remaining demand of relaxed levels).

## CLI

```
python -m roster.cli [input.json]   # reads stdin when no file is given
```

Invalid input (negative demand, unknown skill in `levels`, a skill appearing
in more than one level, malformed JSON) prints
`{"error": {"code": "BAD_ROSTER", "message": ...}}` to stderr and exits 2.
Hard infeasibility is not an error: it exits 0 with `"status": "infeasible"`.

## Library

```python
from roster import solve, RosterError, BAD_ROSTER
result = solve(employees=[...], demand={...}, off={...}, levels=[...])
```

## Tests

```
python -m unittest discover -s tests -v
```
