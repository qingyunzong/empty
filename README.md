# settlement-clearance

Settlement batch authorization review for a clearing house. Reads a JSONL
policy and JSONL batch events, then emits one allow/deny decision per
settlement with its inheritance path, conflict reason and a chained audit
hash. Node.js 22, standard library only, offline.

## Usage

```sh
node cli.js policy.jsonl events.jsonl out/
# writes out/decisions.jsonl and out/audit.json
```

Exit codes: `0` success, `1` input error (a JSON
`{"error":{"code","line"}}` object is written to stderr), `2` bad CLI
usage.

Error codes: `E_PARSE` (invalid JSON line), `E_SCHEMA` (invalid record),
`E_CYCLE` (cyclic role inheritance), `E_IO` (unreadable input file).

## Input formats

`policy.jsonl` — one record per line:

```json
{"type":"role","role":"viewer"}
{"type":"inherit","role":"analyst","inherits":"viewer"}
{"type":"rule","id":"r1","role":"viewer","resource":"settlement:read","effect":"allow"}
{"type":"revoke","role":"intern","at":1700000000}
```

- `inherit`: `role` inherits all permissions of `inherits`. Edges form a
  DAG; an edge that closes a cycle fails with `E_CYCLE` at its own line.
- `rule`: `effect` is `allow` or `deny`; rule ids must be unique.
- `revoke`: the role's own rules stop applying to events with
  `ts >= at`. Events before `at` keep their historical outcome, and
  inheritance edges through the role are unaffected.

`events.jsonl` — one record per line:

```json
{"type":"authorize","id":"e1","role":"auditor","resource":"settlement:read","ts":50}
```

Timestamps may be numbers (compared numerically) or strings such as
ISO-8601 (compared lexicographically).

## Decision semantics

For an event, the applicable rules are all rules on the event's resource
whose role is the event role or one of its ancestors in the inheritance
DAG (shortest-path distance, the role itself is distance 0), excluding
roles revoked at the event time. The winner is chosen by:

1. explicit `deny` beats `allow`;
2. nearer ancestor beats farther ancestor;
3. lexicographically smaller rule id wins the tie.

With no applicable rule the decision is `deny` with reason
`DEFAULT_DENY`. Other reasons: `EXPLICIT_ALLOW`, `EXPLICIT_DENY`,
`DENY_OVERRIDES_ALLOW`.

## Output

`decisions.jsonl` — one line per event:

```json
{"id":"e1","decision":"allow","rule":"r-read","path":["auditor","analyst","viewer"],"reason":"EXPLICIT_ALLOW","candidates":1,"hash":"..."}
```

`hash` chains each decision to the previous one:
`sha256(prevHash + "\n" + canonicalJSON(decision))`, starting from 64
zeros, so history cannot be altered without breaking the chain.

`audit.json` — batch summary: counts, the chain `root`, and the SHA-256
of both input files.

## Development

```sh
node --test
```

Layout: `lib/policy.js` (JSONL parsing/validation, cycle detection),
`lib/graph.js` (DAG reachability, BFS ancestors), `lib/decide.js`
(conflict resolution), `lib/audit.js` (canonical JSON, hash chain),
`lib/cli.js` (CLI wiring), `cli.js` (entry point).
