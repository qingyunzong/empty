# rbacx

A small RBAC engine over a **role DAG that may contain cycles**, with
epoch-ordered revocation events. Pure Python 3.11+ standard library, no
dependencies.

## Semantics

1. **Cycles are legal.** Permissions propagate along every reachable
   inheritance edge. Evaluation is a least fixed point over role
   reachability, so cycles and self-loops terminate.
2. **Revocations apply monotonically by epoch.** Events are sorted by
   `(epoch, file order)` before being applied. Revoking a role cascades:
   permissions reachable *only* through that role disappear, permissions
   reachable via other paths survive. Revocations of already-missing
   targets are idempotent no-ops.
3. **Explicit deny wins** over any number of allows.
4. **All sources are recorded.** A permission granted via several roles
   keeps every source; it is removed only when its source set is empty.
5. **Undetermined is not deny-by-source.** Unknown users, unknown
   permissions, or unassigned subjects yield a default `deny` decision
   with *empty* sources — no fabricated deny source is recorded.

## Database format (`db.json`)

```json
{
  "roles": {
    "admin":  {"inherits": ["editor"], "allow": ["deploy"], "deny": []},
    "editor": {"inherits": ["viewer"], "allow": ["edit"]},
    "viewer": {"allow": ["read"]}
  },
  "users": {"alice": ["admin"]},
  "revocations": [
    {"epoch": 1, "type": "edge",   "role": "editor", "target": "viewer"},
    {"epoch": 2, "type": "role",   "role": "viewer"},
    {"epoch": 3, "type": "allow",  "role": "admin",  "perm": "deploy"},
    {"epoch": 4, "type": "deny",   "role": "admin",  "perm": "deploy"},
    {"epoch": 5, "type": "assign", "user": "alice",  "role": "admin"}
  ]
}
```

All sections are optional. `inherits`/`allow`/`deny` default to empty.
Inheritance edges to unknown roles are a schema error (`unknown_role`);
unknown roles in user assignments are ignored (undetermined, rule 5).

## CLI

```sh
python -m rbacx check --db db.json --user alice --perm read
```

Output (JSON, exit code 0):

```json
{"decision": "allow", "epoch": 5, "sources": {"allow": ["viewer"], "deny": []}}
```

- `decision`: `allow` iff at least one allow source and no deny source;
  otherwise `deny`.
- `sources`: every role that grants (`allow`) or explicitly denies the
  permission for this subject after all revocations.
- `epoch`: highest revocation epoch applied (`0` if none).

Errors raise `PolicyError(code=...)`; the CLI prints
`{"error": code, "message": ...}` to stderr and exits with code **2**.
Error codes: `invalid_json`, `invalid_schema`, `invalid_epoch`,
`unknown_role`, `db_unreadable`.

## Layout

- `rbacx/core.py` — validation, revocation application, fixed-point evaluation
- `rbacx/cli.py` — `check` subcommand
- `tests/test_core.py` — acceptance cases A–D + semantics (epochs, cascade, sources, errors)
- `tests/test_cli.py` — CLI output and exit codes
- `tests/test_random.py` — acceptance E: 300 random graphs (n ≤ 8, cycles
  included) compared against an independent reference that enumerates all
  simple paths

## Test results

Command: `python3 -m unittest discover -s tests -v`
(Python 3.14.4, run 2026-10-01)

```
Ran 37 tests in 0.481s

OK
```

All 37 tests pass, including:

- **A** diamond inheritance: permission survives revocation of one edge/role
  (`TestDiamondRevocation`)
- **B** revocation inside a cycle terminates (`TestCyclicInheritance`)
- **C** one explicit deny overrides three allows (`TestDenyOverrides`)
- **D** empty DB → `deny` with empty sources (`TestEmptyAndUndetermined`)
- **E** 300 random graphs × all users × all permissions match the
  path-enumeration reference (`TestRandomizedDifferential`)
