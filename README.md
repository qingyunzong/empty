# csp_restart

Offline, single-machine CSP solving library and CLI built on the Python
standard library only (Python 3.11+). A backtracking CSP solver is
extended with conflict-count-triggered restarts and global nogood
learning, strictly distinguishing undecided (`timeout`) from
unsatisfiable (`unsat`) states.

## Usage

```
python -m csp_restart run --input <problem.json> \
    --restart-threshold <non-negative int> --total-budget <non-negative int>
```

Output is JSON on stdout with the fields `status` (`sat` / `unsat` /
`timeout`), `solution`, `nogoods`, `restart_count` (plus an extra
`stats` object). Exit code is non-zero when the threshold/budget is
negative or the problem file is invalid.

## Problem format

```json
{
  "variables": [{"name": "x", "domain": [1, 2, 3]}],
  "constraints": [
    {"type": "neq", "vars": ["x", "y"]},
    {"type": "eq", "vars": ["x", "y"]},
    {"type": "all_different", "vars": ["x", "y", "z"]},
    {"type": "table", "vars": ["x", "y"], "allowed": [[1, 2], [2, 1]]}
  ]
}
```

## Semantics

- Each domain wipeout during search counts as exactly one conflict.
- When the conflicts since the last restart reach the restart threshold,
  a restart happens immediately: all learned nogoods are kept (they are
  globally valid), every decision above level 0 is undone, domains are
  restored to their initial state, the decision counter is cleared and
  no temporary propagation state is retained. A threshold of 0 restarts
  on every conflict.
- When the total conflict budget is exhausted the search stops at once
  with status `timeout` (undecided) -- never `unsat` -- unless a
  contradiction at decision level 0 has already been derived.
- A contradiction derived by propagation at level 0 returns `unsat`
  immediately, without triggering a restart.

## Tests

```
python -m unittest discover -v
```

The suite includes a naive backtracking reference implementation
(`csp_restart/reference.py`) used for cross-checking. See `result.txt`
for the recorded output of the last full test run.
