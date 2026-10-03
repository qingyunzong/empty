# nightshift-gate

Offline night-shift gate interpreter for a discrete assembly plant. Planners append
`release` / `freeze` / `revoke` / `reschedule` events to `release.jsonl`; the gate
interpreter decides which work orders enter the next-day queue. Node.js 22, standard
library only, tests via `node:test`.

## Config (a directory with five JSON files)

- `calendar.json` — `{ date, shifts: [{id, start, end}] }`; a shift with `end <= start` crosses midnight.
- `capabilities.json` — `{ workCenter: { shiftId: minutes } }` (negative -> exit 6).
- `materials.json` — `{ material: stock }`; orders referencing unknown material -> exit 7.
- `policy.json` — `{ defaultPermission, permissions: {productLines, workCenters, workOrders}, actors: {name: rank}, supervisorRank }`.
- `orders.json` — `[{ id, productLine, workCenter, dueShift, minutes, materials }]`.

## Rules

- Permission inherits workOrder -> workCenter -> productLine -> default (most specific wins).
- Freeze/release conflicts resolve by (timestamp, priority, freeze-beats-release tie, seq).
- Only actors with rank >= `supervisorRank` may revoke a freeze; revoking restores material locks.
- A release that consumed material locks and is later overridden generates a `compensate`
  event in `breach.json`; the journal is append-only, history is never rewritten.
- Non-monotonic event timestamps -> exit 5.

## CLI

```
node src/cli.js run --config <dir> --events release.jsonl \
     --out schedule.out.json --breach breach.json --audit audit.jsonl
node src/cli.js replay --config <dir> --events release.jsonl --audit audit.jsonl --from N
node src/cli.js counterexample --config <dir> --events release.jsonl --order W1
```

- `run` writes `schedule.out.json` (next-day queue, unscheduled, remaining capability,
  final state hash), `breach.json` (breaches + compensation events) and `audit.jsonl`
  (per-event SHA-256 state hash).
- `replay` recomputes the state at event N from scratch and verifies it against the
  recorded audit hash, then replays to the end and verifies the final hash.
- `counterexample` BFS-searches the minimal appended event sequence that flips the given
  order from releasable to not releasable.

Exit codes: 0 ok, 5 time regression, 6 negative capability, 7 unknown material,
1 generic / replay mismatch, 64 usage.

## Tests

```
node --test
```
