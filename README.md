# mvbatch

Atomic batch rename CLI. Supports **swaps** (`a↔b`) and **cycles**
(`a→b→c→a`) because every source is staged to a temporary name before any
target is written. Written in TypeScript with zero runtime dependencies.

## Usage

```sh
mvbatch <src> <dst> [<src> <dst> ...]   # batch rename (swaps/cycles allowed)
mvbatch --plan plan.json                # pairs from JSON: [["src","dst"],...]
mvbatch --resume [journal ...]          # finish an interrupted batch
```

## How it works

1. **Validate** — before anything is touched, every source is `lstat`ed
   (symlinks are never followed) and its identity (`dev`+`ino`) recorded;
   every target must be free or be another source in the batch; renames
   must stay on one filesystem.
2. **Journal** — the batch intent (sources, targets, identities, staging
   names) is written to `.mvbatch-journal-<id>.json` with fsync.
3. **Stage** — each source is renamed to a unique temp name in its own
   directory (same filesystem, so the rename is atomic).
4. **Commit** — each temp is renamed to its final target. If a target is
   found occupied by a foreign file (external rename conflict), the batch
   **halts** and the journal is kept.
5. **Done** — the journal is removed.

After a power loss, `mvbatch --resume` re-derives the exact state from the
filesystem, re-verifies every tracked file's identity against the journal,
and completes the *same* batch. Files that were externally renamed, deleted
or replaced stop the resume with an identity/conflict error instead of
being overwritten. While a journal is pending, new batches in the same
directory are refused.

## Fault injection

`MVBATCH_FAIL_AT=<n>` simulates a power loss immediately before rename
step `n` (1-based; a batch of N files has 2N steps). The test suite
injects a crash at every step and verifies that no data is ever lost and
that `--resume` completes the original intent.

## Development

```sh
npm test    # typecheck (tsc --noEmit) + build (tsc) + node --test
```

Note: this Node build lacks type-stripping support, so tests run against
the compiled output in `dist/`. `types/node-shim.d.ts` provides minimal
ambient Node declarations because `@types/node` cannot be installed
offline.
