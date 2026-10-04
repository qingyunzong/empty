# mvlin — version-graph materialized views with linearizability checking

Node.js 22, standard library only (`node:test` for tests). Single-machine,
offline. Multiple analyzer processes commit observation batches to one
on-disk repository; the library maintains materialized views over a **version
DAG** (not a single chain) and checks whether the concurrent history is
linearizable.

## Data model

- **Batch** (`batch.json`): `{ id, pid, clock, deps, parent(s), view, ops }`
  - `ops`: `{op:"assert",key,value}` / `{op:"retract",key}`
  - `pid` + `clock`: process id and logical clock (process order)
  - `deps`: explicit happens-before dependencies on other batch ids
  - `parent`/`parents`: version id(s) this commit extends (fork point)
- **Happens-before**: transitive deps ∪ same-`pid` clock order ∪ the batches
  of any named parent version. Batches incomparable under this order are
  **concurrent**; concurrent batches touching the same key with different
  effects are reported as **conflicts** — never silently ordered.
- **Version certificate** (one JSON per version): `{ id, view, parents,
  batches, adds, dels, state }` — parent version set, applied batches, and
  row-level adds/deletes, plus the full materialized state.
- **Three-valued rows**: `asserted(value)` / `retracted` / `unknown` (absent).
  Three-way merge treats `unknown` as a first-class value, never as failure:
  `merge(base=unknown, left=asserted, right=unknown) = asserted`. A key
  conflicts only when base/left/right pairwise disagree.

## Crash safety

Commit write order: batch object → version certificate → journal intent →
HEAD (parent pointer) → drop journal → ack. All writes are
write-temp-fsync-rename. Opening a repo runs recovery: a leftover journal
rolls HEAD forward iff HEAD is still at the journal's base, otherwise the
intent is superseded and discarded. A crash after the HEAD update therefore
never loses an acknowledged batch, and retrying a commit is idempotent
(content-addressed ids). Commits are serialized across processes with an
advisory lockfile (stale locks of dead pids are reclaimed).

## CLI

```
mvlin [--repo DIR] <command>          # repo: --repo, $MVREPO, else ./.mvrepo
  commit <batch.json>   # -> { version, heads, conflicts[] }
  forkinfo [view]       # heads, fork points, LCAs, per-branch replay sets
  merge <a> <b> [view]  # three-way merge; E_CONFLICT on key conflicts
  view <name> [version] # materialized state at head(s) or one version
  lincheck <log>        # log: [{batch,start,end}] -> { ok, order } witness
```

`forkinfo` reports, per head, the versions/batches not explained by any
common ancestor — the minimal set to replay only divergent branches.

`lincheck` combines happens-before edges with real-time edges
(`end_i <= start_j => i before j`); the history is linearizable iff the
combined graph is acyclic (a topological order is the witness serial
execution). It also re-verifies every version certificate against serial
replay of its parents + batches.

## Error codes

| code          | raised when                                            |
|---------------|--------------------------------------------------------|
| `E_ORPHAN`    | batch depends on a batch that does not exist           |
| `E_CONFLICT`  | three-way merge finds irreconcilable key changes       |
| `E_BAD_PARENT`| parent version unknown/ambiguous, or heads > 1 and no parent named |
| `E_NONLINEAR` | no serial order satisfies HB + real-time, or a certificate fails replay |
| `E_INVALID`   | malformed batch / log / arguments                      |
| `E_LOCK`      | repo lock held by a live process                       |

## Tests

```
node --test
```

Covers the four acceptance criteria: (1) concurrent corrections of the same
key yield a detectable conflict; (2) acyclic histories up to 100 events are
cross-checked against serial enumeration of all topological orders;
(3) a crash after the parent-pointer update survives recovery without losing
acknowledged batches; (4) retracting a branch leaves sibling branches
untouched. Multi-writer concurrency is tested with worker threads racing on
the lockfile (this sandbox cannot spawn OS processes).
