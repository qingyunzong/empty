# Replicated Log Simulator (Raft-like, ≤ 5 nodes)

Pure Python 3.11+ standard library. Log entries carry `term, index, key,
value` (indexes start at 1). A command-line JSON-lines interface drives the
cluster; tests use `unittest`.

## Layout

- `raft_sim/core.py` — `Cluster` / `Node` / `Entry`, all protocol semantics
- `raft_sim/cli.py` — JSON-lines CLI (`python3 -m raft_sim.cli`)
- `raft_cli.py` — convenience entry point (`python3 raft_cli.py`)
- `tests/` — acceptance tests A–D plus CLI integration tests

## Semantics

1. **append / ack** — `append` is accepted only from the live leader of the
   current term. `ack` (AppendEntries) returns `REJECT` with
   `conflictIndex`/`conflictTerm` when the follower's log is not a prefix of
   the leader's (prevLog mismatch); otherwise it durably appends the missing
   suffix and propagates the leader's commit index.
2. **commitIndex** — the maximum index `N` stored by a majority of live
   cluster members (quorum of the full cluster size) whose entry at `N` has
   `term ==` the leader's current term. Never decreases.
3. **old-term entries** — an entry from an older term stored on a majority is
   *not* committed directly; it is committed only indirectly as a prefix of
   a current-term commit.
4. **crash / recover** — durable state: `currentTerm`, `votedFor`, `log`,
   `commitIndex`. Volatile: `role`, `alive`. Log appends are durable
   immediately; votes (term + votedFor) persist atomically. The fault point
   `before_vote_persist` crashes a node after log append but before its vote
   is persisted: the vote is lost, the node cannot be elected on it, and on
   recovery the node comes back with exactly its durable term/vote (no
   illegal term rollback).
5. **repair** — anti-entropy from the majority-authoritative log (the live
   leader's log): every live follower's log is made identical to it,
   truncating minority forks. Deleting a committed entry is refused
   (`ProtocolError` → CLI exit 11).

## CLI

One JSON command per line on stdin, one JSON result per line on stdout.
Command errors print `{"ok": false, "error": ...}` to stderr and exit with
status **11**. Protocol-level negatives (e.g. an ack `REJECT`) are normal
results and exit 0.

```
{"cmd":"init","nodes":3}
{"cmd":"elect","candidate":"n1","term":1,
 "fault":{"node":"n2","point":"before_vote_persist"}}   # fault optional
{"cmd":"append","key":"k","value":1,"leader":"n1"}      # leader optional
{"cmd":"ack","follower":"n2","leader":"n1"}             # leader optional
{"cmd":"commit","leader":"n1"}                          # leader optional
{"cmd":"crash","node":"n2"}
{"cmd":"recover","node":"n2"}
{"cmd":"repair","leader":"n1"}                          # leader optional
{"cmd":"state"}
```

Example: `printf '%s\n' '{"cmd":"init","nodes":3}' '{"cmd":"elect","candidate":"n1","term":1}' '{"cmd":"append","key":"a","value":1}' '{"cmd":"ack","follower":"n2"}' '{"cmd":"commit"}' | python3 -m raft_sim.cli`

## Tests

Acceptance mapping:

- **A** `tests/test_commit_enumeration.py` — enumerates majority-commit
  configurations for ≤ 4 nodes / ≤ 12 entries and compares `Cluster.commit`
  against an independent reference state machine (exhaustive ≤ 5 total
  entries, seeded-random 6–12 incl. crashed-node masks; > 100 000 cases).
- **B** `tests/test_fork_repair.py` — fork repair truncates the minority
  fork, preserves the committed prefix, and refuses to delete committed
  entries.
- **C** `tests/test_old_term_commit.py` — old-term majority entries are not
  committed directly, only indirectly with a current-term entry.
- **D** `tests/test_crash_recovery.py` — crash before vote persist: the
  unpersisted vote does not elect anyone, recovery shows exactly the durable
  term (no illegal rollback), and the node cannot act as leader.
- CLI integration: `tests/test_cli.py` (JSON lines, exit code 11 on errors).

### Recorded result (this workspace, 2026-10-01)

`python` is not on PATH in this environment (`python -m unittest discover
-s tests -v` → exit **127**, `command not found`); the interpreter is
`python3` (Python 3.14.4). The equivalent acceptance command:

```
$ python3 -m unittest discover -s tests -v
...
----------------------------------------------------------------------
Ran 17 tests in 14.515s

OK
```

Real exit code: **0** — 17 tests, all OK.
