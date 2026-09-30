# RESULTS

Date: 2026-09-30 22:30:31 CST  |  Python: Python 3.14.4

All outputs below are real, captured from the commands shown.

## Test suite

```
$ python3 -m unittest discover -s tests -v
test_basic_script_ok (test_snapidx.TestCli.test_basic_script_ok) ... ok
test_rollback_without_transaction_exit3 (test_snapidx.TestCli.test_rollback_without_transaction_exit3) ... ok
test_unknown_snapshot_exit3 (test_snapidx.TestCli.test_unknown_snapshot_exit3) ... ok
test_clean_recovery (test_snapidx.TestLogRecovery.test_clean_recovery) ... ok
test_torn_commit_record_ignored (test_snapidx.TestLogRecovery.test_torn_commit_record_ignored) ... ok
test_truncate_at_record_boundary (test_snapidx.TestLogRecovery.test_truncate_at_record_boundary) ... ok
test_truncate_inside_record (test_snapidx.TestLogRecovery.test_truncate_inside_record) ... ok
test_enumeration (test_snapidx.TestModelEnumeration.test_enumeration) ... ok
test_empty_commit_keeps_seq (test_snapidx.TestNestedRollback.test_empty_commit_keeps_seq) ... ok
test_rollback_without_transaction_exit (test_snapidx.TestNestedRollback.test_rollback_without_transaction_exit) ... ok
test_three_level_rollback (test_snapidx.TestNestedRollback.test_three_level_rollback) ... ok
test_interleaved_add_commit_keeps_old_snapshots (test_snapidx.TestSnapshotIsolation.test_interleaved_add_commit_keeps_old_snapshots) ... ok
test_unknown_snapshot_raises (test_snapidx.TestSnapshotIsolation.test_unknown_snapshot_raises) ... ok

----------------------------------------------------------------------
Ran 13 tests in 2.142s

OK
```

## A: enumeration of small operation sequences vs. a model

`TestModelEnumeration` enumerates **all** operation sequences of length 1-5
over an 8-op alphabet (`begin`, `commit`, `rollback`, `add a x`,
`add b x y`, `add a y` overwrite, `del a`, `del zz` no-op) — 19,608
sequences. After every step it compares `SnapIdx` against an independent
naive model (full-copy layers instead of delta layers): current-view and
per-snapshot search results for several terms, commit sequence number,
transaction depth, and raised error types. Result: `ok` (see test suite
output above).

## B: three-level nested rollback

Script (`scripts/demo_b_nested.txt`):
```
# B: three-level nested transactions, rollback undoes only the current layer
begin
add a x
begin
add b x
begin
add c x
search x
rollback
search x
rollback
search x
add d x
commit
search x
search x --snapshot 1
search x --snapshot 0
```
Output:
```
$ python3 -m snapidx scripts/demo_b_nested.txt
ok begin depth=1
ok add a
ok begin depth=2
ok add b
ok begin depth=3
ok add c
a b c
ok rollback depth=2
a b
ok rollback depth=1
a
ok add d
ok commit seq=1
a d
a d
(none)
```

Rollback at depth 3 removes only `c`; rollback at depth 2 removes only
`b`; the outer layer continues, `add d` + `commit` produces snapshot 1
with `a d`.

## C: snapshots keep old results under interleaved add/commit

Script (`scripts/demo_c_snapshot.txt`):
```
# C: snapshots keep old results under interleaved add/commit
begin
add d1 x
commit
search x --snapshot 1
begin
add d2 x
search x --snapshot 1
search x
commit
search x --snapshot 1
search x --snapshot 2
begin
del d1
add d2 y
commit
search x --snapshot 1
search x --snapshot 2
search x --snapshot 3
search y --snapshot 3
```
Output:
```
$ python3 -m snapidx scripts/demo_c_snapshot.txt
ok begin depth=1
ok add d1
ok commit seq=1
d1
ok begin depth=1
ok add d2
d1
d1 d2
ok commit seq=2
d1
d1 d2
ok begin depth=1
ok del d1
ok add d2
ok commit seq=3
d1
d1 d2
(none)
d2
```

Uncommitted `d2` is invisible to snapshot 1; after commit, snapshot 1
still returns `d1` while snapshot 2 returns `d1 d2`; later del/overwrite
only affects snapshot 3.

## D: persistence and crash recovery

### D0: write two commits, recover in a fresh process

```
$ python3 -m snapidx --log /tmp/snapidx_results.log -
ok begin depth=1
ok add a
ok commit seq=1
ok begin depth=1
ok add b
ok commit seq=2

$ cat /tmp/snapidx_results.log
SNAPIDX1 37 5fecfc623e8bb6395b675ebab17b9ebcdfe5e77c48dfd2762fc30b32511e7dae {"ops":[["a","a",["x","y"]]],"seq":1}
SNAPIDX1 33 712b23bab3243612400d9ab62885a45f9f3f337c3d05994c20c1bc389b00507f {"ops":[["a","b",["x"]]],"seq":2}

$ python3 -m snapidx --log /tmp/snapidx_results.log -   # fresh process
seq=2
a b
a
a b
```

Log has 2 records (226 bytes; record 1 = 115 bytes).

### D1: truncate at a record boundary (keep record 1 only)

```
$ python3 -c "import os; os.truncate(log, 115)"
$ python3 -m snapidx --log /tmp/snapidx_results_boundary.log -
seq=1
a
a
```

Recovers cleanly to commit 1, no warning (clean record boundary).

### D2: truncate inside record 2 (half record)

```
$ python3 -c "import os; os.truncate(log, 115 + (226 - 115)//2)"
$ python3 -m snapidx --log /tmp/snapidx_results_half.log -
warning: log truncated inside record at offset 115; discarding 55 trailing byte(s)
seq=1
a
a

$ cat /tmp/snapidx_results_half.log   # torn tail removed at recovery
SNAPIDX1 37 5fecfc623e8bb6395b675ebab17b9ebcdfe5e77c48dfd2762fc30b32511e7dae {"ops":[["a","a",["x","y"]]],"seq":1}
```

The half record is discarded with a warning; recovery lands on the last
complete commit (seq=1) and the torn tail is truncated from the file.

## Misc semantics: empty commit, del no-op, overwrite

```
$ python3 -m snapidx scripts/demo_misc.txt
ok begin depth=1
ok commit empty seq=0
seq=0
ok begin depth=1
ok add a
ok add a
ok del ghost
ok commit seq=1
(none)
a
seq=1
```

Empty commit leaves `seq=0`; `add a y` overwrites `add a x`; `del ghost`
is a no-op; the commit then advances to `seq=1`.

## Error cases (exit code 3)

```
$ printf 'begin\nadd a x\ncommit\nsearch x --snapshot 7\n' | python3 -m snapidx
error: unknown snapshot 7 (valid range: 0..1)
ok begin depth=1
ok add a
ok commit seq=1
exit=3

$ printf 'rollback\n' | python3 -m snapidx
error: rollback without an active transaction
exit=3
```
