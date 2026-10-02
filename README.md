# offline-alarm-engine

Offline, single-machine alarm derivation engine for device event streams
(temperature, pressure, vibration, ...), with a batch CLI. Pure Node.js 22
standard library; tests use `node:test`.

## Features

- **Fact index** — events indexed by id, sequence number and type.
- **Rule dependency graph** — rules are conjunctive conditions over facts and
  other alarms; the alarm dependency graph is kept acyclic (checked on every
  `addRule`).
- **Alarm instances & certificates** — each active alarm lists *all minimal
  proofs*; a proof records the rule id, the leaf fact ids and the sub-alarm
  proofs it builds on.
- **Invalidation propagation** — retracting a fact or removing a rule only
  deletes alarms that lost *every* proof; alternative proofs keep the
  conclusion alive. Deletions cascade down the dependency graph.
- **Deterministic replay** — `addRule` evaluates the new rule against the
  full event history; equal inputs always produce byte-identical snapshots.
- **Undo** — every successful command pushes its inverse onto a history
  stack; `undo` applies the inverse of the most recent command.

## Data model

Event (fact):

```json
{ "id": "e1", "seq": 1, "type": "temperature", "value": 95 }
```

`id` unique string, `seq` unique integer, `type` non-empty string
(`temperature` / `pressure` / `vibration` / ...), `value` optional finite
number. Any other field is a structured `UNKNOWN_FIELD` error.

Rule:

```json
{
  "id": "r2",
  "alarm": "hot-pressurized",
  "when": [
    { "alarm": "hot" },
    { "type": "pressure", "op": ">=", "value": 100 }
  ]
}
```

A condition is either a *fact condition* `{ "type": ..., "op"?: one of
< <= > >= == !=, "value"?: number }` (without `op` it matches any event of
that type) or an *alarm condition* `{ "alarm": "name" }`. Exactly one of
`type` / `alarm` must be present. Rule ids are unique; a rule is corrected by
`removeRule` + `addRule` with the same id.

## CLI

```
node src/cli.js alarms events.json rules.json -o out.json
```

- `rules.json` — initial rule set: a JSON array of rules (or `{"rules": [...]}`).
- `events.json` — the command stream: a JSON array (or `{"ops": [...]}`).
  Entries with an `op` field are commands; anything else is treated as a
  plain event and appended. Commands:

```json
{ "op": "append",    "event": { "id": "e1", "seq": 1, "type": "temperature", "value": 95 } }
{ "op": "retract",   "id": "e1" }
{ "op": "addRule",   "rule":  { "id": "r1", "alarm": "hot", "when": [...] } }
{ "op": "removeRule","id": "r1" }
{ "op": "undo" }
```

- `-o out.json` — output file; omit to write the result to stdout.

Output (`out.json`):

```json
{
  "ok": true,
  "steps": [
    { "index": 0, "op": "append", "ok": true, "added": ["hot"], "removed": [] },
    { "index": 1, "op": "retract", "ok": false, "error": { "code": "UNKNOWN_EVENT", "message": "...", "details": { "id": "e9" } } }
  ],
  "alarms": [
    {
      "alarm": "hot",
      "proofs": [
        { "rule": "r1", "facts": ["e1"], "alarms": [] }
      ]
    }
  ]
}
```

`steps` logs every command with the alarms added/removed by it (incremental
invalidation is observable here). `alarms` is the final certificate list:
alarms sorted by name; proofs sorted by rule id, then by the event sequence
numbers of the flattened support; facts inside a proof sorted by `(seq, id)`.

Exit codes:

- `0` — stream processed. Per-command failures are reported as structured
  errors inside `steps` (`ok: false` at the top level) and processing
  continues.
- `1` — fatal structured error on stderr (bad JSON, unreadable file, invalid
  or duplicate initial rules, ...).
- `2` — usage error.

## Library

```js
import { AlarmEngine } from './src/engine.js';

const engine = new AlarmEngine();
engine.loadRules(rules);                 // initial rule set
engine.applyOp({ op: 'append', event }); // -> { op, added, removed }
engine.applyOp({ op: 'undo' });
engine.snapshot();                       // certificate list (same shape as CLI "alarms")
```

`src/reference.js` contains an independent naive fixpoint-enumeration
implementation (no indexes, no incrementality) used by the test suite to
cross-check the incremental engine on small and randomized instances.

## Structured error codes

`UNKNOWN_FIELD`, `MISSING_FIELD`, `INVALID_VALUE`, `BAD_EVENT`, `BAD_RULE`,
`BAD_CONDITION`, `BAD_OP`, `BAD_INPUT`, `BAD_JSON`, `READ_FAILED`,
`DUPLICATE_ID`, `DUPLICATE_SEQ`, `UNKNOWN_OP`, `UNKNOWN_EVENT`,
`UNKNOWN_RULE`, `RULE_CYCLE`, `NOTHING_TO_UNDO`, `USAGE`.

## Tests

```
node --test
```

Covers: three-level chained derivation with incremental deletion, alternative
proofs surviving partial invalidation, minimal-proof certificates, historical
replay on `addRule`, rule correction, `undo`, structured errors, CLI
end-to-end (exit codes, stdout/`-o`, per-command errors), and randomized
equivalence against the naive reference after every command.
