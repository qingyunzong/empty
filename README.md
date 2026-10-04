# event-merger

History-branching event merger for offline maintenance terminals. Merges
`base`/`local`/`remote` event archives three-way, preserves withdrawal
(`deleted`) traces, explains causal conflicts, and commits immutable,
content-addressed snapshots. Node.js 22 standard library only; tests use
`node:test`.

## Event model

An event is immutable and identified by `id`:

```json
{"id":"A","ts":12,"source":"terminal-1","type":"ack","ackBy":"op-1","note":"...","deleted":false,"dependsOn":["B"]}
```

- `dependsOn`: `D in E.dependsOn` means `D` must causally precede `E`.
  Timestamps never constrain causality (a legal chain may go back in time).
- Every input branch must validate: all references exist, dependency graph
  acyclic. Deleted events keep metadata and edges.
- Execution projection shows only non-deleted events; a non-deleted event
  depending on a deleted one yields a `BLOCKED` report. Dependencies are
  never silently removed.

## Merge semantics (`src/merge.js`)

- Per event id, per field three-way merge. Different fields combine; the same
  scalar edited differently on both sides is a `FIELD` conflict.
- `dependsOn` merges per edge by three-way existence.
- One side flipping `deleted` false→true while the other side edits other
  fields or dependencies is a `DELETE_UPDATE` conflict; double withdrawal
  merges cleanly.
- Individually legal branches may merge into a cycle: one verifiable directed
  cycle is reported, with the branches each cycle edge came from.
- Acyclic merges get a replayable Kahn topo certificate: each round picks the
  minimal available event by `(ts, id)` and records the full candidate set.

## Sessions & resolution (`src/session.js`)

- `resolve({conflictId, expectLocal, expectRemote, pick})` applies an explicit
  field choice only if both source versions still match; it incrementally
  refreshes the affected dependency region, blocked state and the topo
  certificate while leaving other conflicts unresolved.
- `updateBranch()` re-merges after a source branch changed: resolutions whose
  preconditions still hold carry over, the rest become `STALE_RESOLUTION`.
- `commit()` (mergeCommit) writes only when every conflict is resolved and
  the graph is valid: a new immutable snapshot with parent versions.

## Snapshots, diffs (`src/store.js`)

Content-addressed immutable snapshots. `diff(old, new)` yields a forward diff
and `invert()` the inverse diff. `applyInverse` verifies the post-image
events hash before writing; on mismatch nothing changes (history and HEAD
untouched).

## Independent checker (`src/checker.js`)

Replays certificates (all events covered, every edge ordered, exact candidate
sets, minimal `(ts,id)` choice) and recomputes conflicts per field, blocked
state and cycle-edge provenance from the three source branches.

## JSONL CLI (`bin/cli.js`)

Reads JSON commands per line from stdin (or `--input file`), writes one JSON
response per line. Store dir via `--store` (default `.emstore`).

Commands: `validate`, `load`, `merge`, `resolve`, `updateBranch`, `commit`,
`diff`, `applyInverse`, `projection`, `check`, `head`.

```sh
node bin/cli.js --store .emstore --input script.jsonl
```

## Tests

```sh
node --test
```

Covers: time-regressing legal causal chains, cross-branch cycles with edge
provenance, DELETE_UPDATE vs field edits, blocked reports and unblocked net
diffs, stale resolutions, inverse-diff failure atomicity, exhaustive
enumeration of all topo orders for n≤7 against the deterministic Kahn order,
and incremental updates cross-checked against full per-field recomputation.
