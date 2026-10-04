# param-sync

Offline parameter pack/feedback sync for controllers. Node.js 22 standard
library only, no dependencies. Tests use `node:test`.

Scenario: an engineer packs parameter changes and ships them to an offline
controller (`pack` -> `apply`); the controller's actual values are captured
back (`feedback`); both libraries are merged deterministically (`sync`).
Dangerous states roll back to a committed safe set (`rollback`).

## Parameter model

```json
[{ "key": "temp", "type": "number", "min": 0, "max": 100, "safetyCritical": true,
   "interlock": "pressure > 2 || temp < 50" }]
```

- `type`: `number` | `boolean` | `string`
- `min` / `max`: inclusive range for numbers
- `interlock`: expression over other params (`&& || ! < <= > >= == !=`, parentheses)
- `safetyCritical`: conflicts never auto-resolve; safe-set override applies

Change capture ops: `set` / `lock` / `unlock` (plus `cert` issue). Locked
params reject `set`. Every violation raises `SyncError` code `VALIDATION`.

## Sync

Each change entry carries a version vector. `mergeLibraries(a, b, registry)`:

- causally dominated entries lose;
- concurrent entries on the same key resolve by a total deterministic order
  (canonical vector, node, value) — identical on every machine;
- concurrent entries on a `safetyCritical` key go to `pending` instead and
  the CLI exits 11.

## Rollback layers

Strict order, persisted across restarts; any out-of-order phase raises
`ROLLBACK` (exit 3):

1. `unlocked` — clear all locks
2. `params-reverted` — restore safe-set values
3. `certs-cleared` — clear certificates

## Persistence & fault points

Store directory: `delta.log` (append-only batches), `active.json` (tmp write +
atomic rename), `safe-set.json` manifest. Fault injection via
`PARAM_SYNC_FAULT_AT` or `new Store(dir, reg, { faultAt })`:

- `before-delta-append` — nothing applied after recovery
- `after-delta-append` — full batch replayed, never half-applied
- `before-active-rename` — snapshot rebuilt from the log
- `after-safe-commit` — dangerous values overridden by the safe set

Recovery (`Store.load`) = snapshot + log replay + safe-set enforcement.

## CLI

```
param-sync pack     --def defs.json [--changes c.json | --set k=v ...] [--node id] [--out pack.json]
param-sync apply    --def defs.json --store DIR --pack pack.json [--safe-set safe.json]
param-sync feedback --def defs.json --store DIR [--out fb.json]
param-sync sync     --def defs.json --a libA.json --b libB.json [--out merged.json]
param-sync rollback --def defs.json --store DIR [--phase unlock|params|certs]
param-sync cert     --def defs.json --store DIR (--issue KEY [--value V] | --list)
```

Errors are JSON on stderr: `{"error":"VALIDATION|ROLLBACK|CONFLICT","message":...}`.
Exit codes: `2` validation, `3` rollback order, `11` safety-critical conflict
pending, `1` anything else.

## Test

```
node --test
```
