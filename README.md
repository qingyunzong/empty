# offline-alarm-engine

Offline, single-machine alarm derivation engine for device event streams, plus a CLI.
Node.js 22, standard library only, tests use `node:test`.

## Data model

**Fact** — an observed device fact (temperature, pressure, vibration, ...):

```json
{ "id": "e1", "type": "temperature", "value": 95 }
```

`id` and `type` are required non-empty strings; any other fields are free-form
attributes that conditions can match on.

**Rule** — a conjunctive condition deriving an alarm, possibly depending on
other alarms:

```json
{
  "id": "r2",
  "when": [
    { "alarm": "hot" },
    { "fact": { "type": "pressure", "value": { "$gte": 50 } } }
  ],
  "derive": { "alarm": "critical" }
}
```

- `when` is a non-empty array of conditions. A condition is exactly one of
  `{ "fact": { ...match } }` or `{ "alarm": "<alarm-name>" }`.
- A fact match maps field names (`type`, `id`, or any attribute) to either a
  primitive (equality) or an operator object:
  `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`.
- `derive.alarm` names the conclusion. Rules with the same conclusion provide
  alternative proofs of the same alarm.

**Commands** (the event stream in `events.json`):

| Command | Shape | Effect |
| --- | --- | --- |
| `append` | `{ "cmd": "append", "fact": {...} }` | index a new fact |
| `retract` | `{ "cmd": "retract", "id": "e1" }` | remove a fact and propagate invalidation |
| `addRule` | `{ "cmd": "addRule", "rule": {...} }` | bring a rule online; history is replayed |
| `removeRule` | `{ "cmd": "removeRule", "id": "r1" }` | take a rule offline |
| `undo` | `{ "cmd": "undo" }` | revert the most recent mutation |

Rule correction is `removeRule` + `addRule` (re-using a live id is a
`DUPLICATE_ID` error).

## Semantics

- The engine maintains a fact index (insertion sequence preserved), a rule
  dependency graph (`dependencies` in the output maps each rule to the rules
  whose conclusions it consumes), and the set of derived alarm instances.
- Derivation is a deterministic least-fixpoint replay over all live facts, so
  a newly added rule is evaluated against the full history, and cyclic rule
  dependencies settle at the least fixpoint.
- Retracting a fact or removing a rule deletes exactly those alarms that lost
  **all** of their proofs; alarms with alternative proofs survive.
- Each alarm certificate lists **all minimal proofs** (minimal by fact-set
  inclusion). A proof is `{ "rule": "<ruleId>", "facts": ["<factId>", ...] }`
  with leaf fact ids in event-sequence order; chained alarms contribute the
  facts of their own minimal proofs.
- Output ordering is deterministic: alarms sort by rule id, then event
  sequence, then alarm name; proofs sort by rule id, then fact sequence.

## CLI

```
node src/cli.js alarms events.json rules.json -o out.json
```

- `rules.json`: JSON array of initial rules. `events.json`: JSON array of commands.
- `-o`/`--output` selects the output file; without it the state JSON goes to stdout.
- Exit codes: `0` success; `1` structured error (JSON `{"error": {...}}` on
  stderr, no output file written); `2` usage error.

### Error codes

`DUPLICATE_ID`, `UNKNOWN_FIELD`, `UNKNOWN_OPERATOR`, `INVALID_FACT`,
`INVALID_RULE`, `INVALID_CONDITION`, `INVALID_COMMAND`, `UNKNOWN_FACT`,
`UNKNOWN_RULE`, `EMPTY_HISTORY`, `READ_ERROR`, `INVALID_JSON`, `INVALID_INPUT`.

## Library

```js
import { Engine } from './src/engine.js';

const engine = new Engine({ rules });
const state = engine.run({ cmd: 'append', fact: { id: 'e1', type: 'temperature', value: 95 } });
// state: { alarms, facts, rules, dependencies }
```

## Tests

```
node --test
```

`test/fuzz.test.js` compares the engine against an independent naive fixpoint
enumeration (`test/reference.js`) on seeded randomized command streams.
