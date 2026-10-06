# mvx — crash-safe batch rename CLI

Renames multiple files as one atomic-intent batch. Supports **swaps**
(`a=b b=a`) and **cycles** (`a=b b=c c=a`) by staging every source to a
unique temporary name before moving anything to its final name.

## Usage

```sh
npm run build          # compile to dist/
node dist/src/mvx.js [--dir DIR] OLD=NEW [OLD2=NEW2 ...]
node dist/src/mvx.js [--dir DIR] --recover
```

## Guarantees

- **Validate first**: all sources must exist, destinations must be free or
  be batch sources themselves, no duplicates, same filesystem. Any problem
  aborts before a single rename. File identities (`dev`+`ino` from `lstat`)
  are recorded for the whole batch.
- **Staging phase**: the intent (pairs + identities + per-step progress) is
  written to `.mvx-journal.json` (fsync + atomic rename) before any
  mutation.
- **Crash recovery**: after a power loss, `mvx --recover` finishes exactly
  the same batch. Each step re-verifies identities, so a crash between a
  rename and its journal write resumes cleanly.
- **External conflicts stop the batch**: if a destination was created
  externally while the batch was interrupted, recovery halts with exit
  code 2, keeps the journal, and loses nothing.
- **Symlinks are never followed**: inspection uses `lstat` and `rename(2)`
  moves the link itself.

## Exit codes

- `0` success
- `1` usage/validation error (nothing was modified)
- `2` external interference detected mid-batch (stopped, journal kept)
- `75` simulated crash (fault injection, see below)

## Fault injection (for tests)

- `MVX_FAIL_AT=k` — crash right after the k-th data rename, before the
  journal update.
- `MVX_FAIL_STAGING=1` — crash right after the journal is staged.

## Tests

```sh
npm test
```

Compiles with `tsc` and runs `node --test` over `dist/test/`, including a
per-rename fault-injection matrix that verifies no data is ever lost.
