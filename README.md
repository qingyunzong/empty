# snapidx

In-memory term index with snapshots, nested transactions, and optional
commit-log persistence. Python 3.11 standard library only.

## Layout

- `snapidx/core.py` — `SnapIdx` engine (delta-layer transactions, immutable
  committed snapshots, WAL recovery)
- `snapidx/cli.py` — command line interface (`python -m snapidx`)
- `tests/test_snapidx.py` — acceptance tests A–D plus CLI exit-code tests
- `scripts/` — demo scripts used in `RESULTS.md`

## Semantics

- `add ID TERM...` overwrites any existing document with the same id;
  `del ID` of a missing id is a no-op.
- `begin`/`commit`/`rollback` nest. A child commit merges its delta into the
  parent layer; `rollback` discards only the innermost layer, outer layers
  continue.
- Only a non-empty outermost commit advances the commit sequence number and
  creates a snapshot. Committing an empty transaction is legal and leaves
  the sequence number unchanged. ("Empty" = no add/del operations happened
  anywhere in the transaction tree.)
- `search TERM` reads the current view (committed state + open
  transactions). `search TERM --snapshot S` reads the immutable committed
  state at the end of commit `S`; uncommitted changes are invisible to every
  snapshot, and a commit only affects later snapshots.
- Persistence (`--log PATH`): a length+SHA256-checksummed record is appended
  and fsynced only on a non-empty outermost commit. Recovery replays
  complete records and stops at the first incomplete/corrupt one: the torn
  tail is discarded with a warning and truncated from the file, so recovery
  always lands on the last complete commit. Torn (never-committed) log
  records are ignored.

## Exit codes

- `0` ok
- `2` usage error
- `3` state error: unknown snapshot; rollback/commit/add/del without an
  active transaction

## Usage

```
python3 -m snapidx [--log PATH] [SCRIPT]     # SCRIPT defaults to stdin ("-" ok)
python3 -m unittest discover -s tests -v     # run the test suite
```

Commands: `begin`, `add ID TERM...`, `del ID`, `commit`, `rollback`,
`search TERM [--snapshot S]`, `seq`. Blank lines and `#` comments are
ignored.
