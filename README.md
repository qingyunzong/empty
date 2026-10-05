# photo-rename

Batch photo-renaming CLI. TypeScript + Node.js built-in modules only (`fs`, `path`, `crypto`); no runtime dependencies.

## Usage

```
npm run build          # tsc -> dist/
node dist/src/cli.js plan    mapping.json [--dir D] [--case-fold]   # preflight + dry-run plan
node dist/src/cli.js apply   mapping.json [--dir D] [--case-fold]   # preflight, journal, execute
node dist/src/cli.js recover [--dir D]                              # resume an interrupted batch
node dist/src/cli.js undo    [--dir D]                              # apply the inverse plan
node dist/src/cli.js verify  mapping.json [--dir D] [--case-fold]   # check final state
```

Mapping file:

```json
{ "caseFold": true, "renames": [ { "from": "a.jpg", "to": "b.jpg" } ] }
```

## Design

- **Case folding per input rule** — names are compared with `toLowerCase()` folding when the
  mapping sets `"caseFold": true` (or `--case-fold` is passed), byte-exact otherwise. Source
  lookup, duplicate detection and target-collision checks all follow this rule.
- **Preflight rejects the whole batch** (`src/plan.ts`) — duplicate sources/targets (folded),
  missing sources, or a target occupied by a file that is not part of the batch raise
  `PreflightError` before anything on disk is touched.
- **Cycles via temporary names** — the rename graph decomposes into chains (executed
  back-to-front) and cycles; each cycle is broken by moving one file to a unique
  `.photo-rename.tmp.*` name, then closing the loop.
- **Journaled, interruptible execution** (`src/journal.ts`, `src/execute.ts`) — the plan and
  every completed step are appended to `.photo-rename.journal.jsonl` with `fsync`, so the
  process may be killed at any step. Renames use hard-link + unlink so a destination can
  never be overwritten. `recover` reconciles each pending step: source gone + destination
  present means the step landed but its journal write was lost (recorded as recovered, not
  redone); an unexpected file at a destination aborts recovery instead of overwriting it.
  Recovery is idempotent — a second run reports `already-complete`.
- **Inverse plan** (`undo`) — the inverse mapping is re-planned against current disk state
  (reusing cycle breaking and preflight validation), journaled as `undo-plan`/`undo-step`/
  `undo-done`, and restores the original names.

## Tests

`npm test` (compiles with `tsc`, then runs `node --test`). Recorded actual result
(2026-10-05, Node v22.22.1, tsc 7.0.2):

```
ok 1 - simple batch rename applies and verifies
ok 2 - cyclic swap is executed via temporary names
ok 3 - case-folded duplicate targets reject the whole batch
ok 4 - same targets are allowed without case folding
ok 5 - target occupied by an unknown file rejects the whole batch
ok 6 - missing source rejects the batch
ok 7 - interruption mid-batch recovers, and recovery is idempotent (run twice)
ok 8 - step applied but journal write lost is reconciled, not redone
ok 9 - recovery refuses to overwrite an unknown file
ok 10 - inverse plan restores the original names (including cycles)
ok 11 - case-fold source resolution matches on-disk names per input rule
ok 12 - case-only rename works under case folding
ok 13 - CLI: plan, apply, verify end to end
# tests 13
# pass 13
# fail 0
```

Note: `types/node.d.ts` contains minimal hand-written declarations for the Node built-ins
used, because the offline environment cannot fetch `@types/node`. Runtime code uses only
Node.js built-in modules.
