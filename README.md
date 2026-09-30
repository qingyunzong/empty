# roster

Hierarchical roster (shift scheduling) solver with per-level rollback.
Pure Python 3.11 standard library; tests use `unittest`.

## Input

A JSON object:

```json
{
  "days": ["2026-10-05", "2026-10-06"],
  "employees": [{"id": "e1", "skills": ["a", "b"]}],
  "demand": {"2026-10-05": {"a": 1}},
  "off": {"e1": ["2026-10-06"]},
  "levels": [{"name": "primary", "demand": {"2026-10-06": {"a": 1}}}]
}
```

- `demand` is the hard daily demand (`date -> skill -> count`).
- `levels` is an ordered list of soft demand layers, tried from index 0 up.
- `off` lists dates an employee is unavailable; an off entry sticks to the
  whole ISO week.

## Semantics

1. Hard constraints: skill match, never on an off day, at most one shift per
   person per day.
2. If the hard `demand` cannot be fully satisfied, the result is
   `{"status": "infeasible", ...}` (no exception).
3. Levels are attempted in order. Each level is filled by a deterministic
   search ordered by largest demand-gap date, ties broken by date, then by
   employee id (skill ties by skill name). If a level cannot be fully
   satisfied, all assignments added for it are rolled back, its name is
   appended to `relaxed`, its demand is reported under `unmet`, and deeper
   levels are attempted. Fixed higher levels are never modified.
4. Output: `assignments` (sorted by date, employee, skill), `relaxed`,
   `unmet`.

## Errors

Negative demand, unknown skills, or duplicate level names raise
`RosterError` with `code == "BAD_ROSTER"`; the CLI prints the error on
stderr and exits with code 2.

## Usage

```sh
python -m roster.cli input.json     # or '-' to read from stdin
python -m unittest discover -s tests -v
```

Library:

```python
from roster import solve, RosterError
result = solve(problem_dict)
```
