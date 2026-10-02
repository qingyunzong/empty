# events-authz-gateway

Offline, single-machine gateway library + CLI for PLC event visibility:
tenant-group inheritance, device-tag grants, event-level exceptions,
deny-over-allow with a `safety-public` downtime break, immutable derived
statistics, and a full audit trail. Node.js 22, standard library only.

## Layout

- `src/cli.js` — `query` / `stats` / `mark-fp` commands (also exports `run(argv, io)`)
- `src/policy.js` — policy loading/validation, tenant-group closure (cycle -> exit 4)
- `src/evaluate.js` — main evaluator + independent reference evaluator
- `src/store.js` — `events.jsonl` loading, reorder window check (exit 8)
- `test/` — acceptance tests A–D plus exit-code tests (`node --test`)

## Policy (JSON)

```json
{
  "tenants": [{ "id": "t1", "parents": ["g1"] }],
  "groups": [{ "id": "g1", "parents": [] }],
  "tags": ["line-a", "safety-public"],
  "devices": [{ "id": "d1", "tags": ["line-a"] }],
  "rules": [
    { "id": "r1", "effect": "allow", "subject": "g1", "tag": "line-a",
      "actions": ["read", "modify", "mark_false_positive"], "revokedAt": null },
    { "id": "r2", "effect": "deny", "subject": "t2", "tag": "line-a", "actions": ["read"] },
    { "id": "r3", "effect": "allow", "subject": "t2", "event": "e7", "actions": ["read"] }
  ]
}
```

Rules with `event` are event-level exceptions and coexist with tag rules.
Deny beats allow, except: a `read` on a `downtime` event of a
`safety-public`-tagged device breaks the deny when an allow also matches —
the break is recorded in `audit.jsonl` with the reason. `revokedAt` makes a
rule inapplicable for queries at/after that instant; already-written stats
snapshots are never rewritten.

## Events (`events.jsonl`)

One JSON object per line: `{"seq":1,"ts":"...","eventId":"e1","deviceId":"d1","type":"downtime","payload":{...}}`.
Sequence numbers may be reordered within a window of 100; beyond that the CLI
exits 8. `mark-fp` appends `{"seq":N,"type":"fp_mark","eventId":"e1",...}`.

## CLI

```sh
node src/cli.js query   --policy policy.json --events events.jsonl --tenant t1 \
     --action read --at 2026-01-10T00:00:00Z --audit audit.jsonl
node src/cli.js stats   --policy policy.json --events events.jsonl --tenant t1 \
     --at 2026-01-10T00:00:00Z --out stats.jsonl
node src/cli.js mark-fp --policy policy.json --events events.jsonl --tenant t1 \
     --event e1 --at 2026-01-10T00:00:00Z --audit audit.jsonl
```

`query` prints one JSON line per event (`visible`, `falsePositive`, plus
`brokenDeny` or a minimal `counterexample` for denials) and a final visibility
bitmap line. Every decision is appended to `audit.jsonl`.

## Exit codes

- `0` success · `2` usage/data error · `3` unauthorized `mark-fp`
- `4` tenant/group inheritance cycle
- `8` events out of order beyond the reorder window
- `9` unknown tag (device or rule)

## Tests

```sh
node --test
```
