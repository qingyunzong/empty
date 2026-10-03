# RESULTS

Date: 2026-10-04 02:13:14 CST
Interpreter: Python 3.14.4 (`python3`; the environment provides no `python` alias)
Command: `python3 -m unittest discover -v` (equivalent to `python -m unittest discover -v`)

## Unit tests (real output)

```
test_end_plus_gap_equal_watermark_is_final (tests.test_boundary.TestFinalizationBoundary.test_end_plus_gap_equal_watermark_is_final) ... ok
test_exact_gap_merges (tests.test_boundary.TestGapBoundary.test_exact_gap_merges) ... ok
test_gap_plus_one_splits (tests.test_boundary.TestGapBoundary.test_gap_plus_one_splits) ... ok
test_late_insert_at_exact_gap_merges (tests.test_boundary.TestGapBoundary.test_late_insert_at_exact_gap_merges) ... ok
test_late_insert_at_gap_plus_one_does_not_merge (tests.test_boundary.TestGapBoundary.test_late_insert_at_gap_plus_one_does_not_merge) ... ok
test_all_subsets_up_to_8_events (tests.test_bruteforce.TestBruteForce.test_all_subsets_up_to_8_events) ... ok
test_interleaved_keys_match_reference (tests.test_bruteforce.TestBruteForce.test_interleaved_keys_match_reference) ... ok
test_end_to_end (tests.test_cli.TestCli.test_end_to_end) ... ok
test_invalid_json_exits_2 (tests.test_cli.TestCli.test_invalid_json_exits_2) ... ok
test_missing_id_exits_2 (tests.test_cli.TestCli.test_missing_id_exits_2) ... ok
test_out_option (tests.test_cli.TestCli.test_out_option) ... ok
test_interleaved_keys_match_independent_runs (tests.test_keys.TestKeyIsolation.test_interleaved_keys_match_independent_runs) ... ok
test_watermark_is_per_key (tests.test_keys.TestKeyIsolation.test_watermark_is_per_key) ... ok
test_excessively_late_event_dropped (tests.test_retract.TestLateMergeRetract.test_excessively_late_event_dropped) ... ok
test_late_event_bridges_final_sessions (tests.test_retract.TestLateMergeRetract.test_late_event_bridges_final_sessions) ... ok
test_late_event_merging_open_session_needs_no_retract (tests.test_retract.TestLateMergeRetract.test_late_event_merging_open_session_needs_no_retract) ... ok
test_three_sessions_finalized (tests.test_retract.TestLateMergeRetract.test_three_sessions_finalized) ... ok
test_gap_and_late_must_be_non_negative (tests.test_session_basics.TestBasics.test_gap_and_late_must_be_non_negative) ... ok
test_same_ts_events_counted_individually (tests.test_session_basics.TestBasics.test_same_ts_events_counted_individually) ... ok
test_session_dict_shape (tests.test_session_basics.TestBasics.test_session_dict_shape) ... ok
test_known_vector (tests.test_session_basics.TestIdsHash.test_known_vector) ... ok
test_sorted_before_hashing (tests.test_session_basics.TestIdsHash.test_sorted_before_hashing) ... ok

----------------------------------------------------------------------
Ran 22 tests in 0.849s

OK
```

## CLI demo (real output)

Input `e.jsonl`:

```json
{"key":"k","ts":0,"id":"a"}
{"key":"k","ts":1000,"id":"b"}
{"key":"k","ts":40000,"id":"c"}
{"key":"k","ts":150000,"id":"d"}
{"key":"k","ts":185000,"id":"z"}
{"key":"k","ts":20000,"id":"x"}
{"key":"k","ts":100000,"id":"y"}
{"key":"k2","ts":10,"id":"q"}
```

Command: `python3 -m sessionize --in e.jsonl --gap 30000 --late 5000` (exit 0)

```json
{"type": "FINAL", "key": "k", "start": 0, "end": 1000, "count": 2, "ids": "fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603"}
{"type": "FINAL", "key": "k", "start": 40000, "end": 40000, "count": 1, "ids": "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6"}
{"type": "FINAL", "key": "k", "start": 150000, "end": 150000, "count": 1, "ids": "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4"}
{"type": "RETRACT", "sessions": [{"key": "k", "start": 0, "end": 1000, "count": 2, "ids": "fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603"}, {"key": "k", "start": 40000, "end": 40000, "count": 1, "ids": "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6"}]}
{"type": "ADD", "key": "k", "start": 0, "end": 40000, "count": 4, "ids": "7571ce1f8e21c6b13dd7ec2c5ec7c9e4dd9852e209869511853f2f1f74b17927"}
{"type": "DROP", "key": "k", "ts": 100000, "id": "y", "reason": "exceeds allowed lateness"}
```

Walkthrough (gap=30000, late=5000):

- After `z@185000`, `max_ts=185000`, `WM=180000`; sessions `[0,1000]`, `[40000]`, `[150000]` satisfy `end+gap<=WM` and are emitted as FINAL; `[185000]` stays open.
- `x@20000` is late (`20000 < WM`) but legal: it is within gap of both `[0,1000]` and `[40000]`, so the two FINAL sessions are RETRACTed and replaced by ADD `[0,40000]` (count=4, ids=sha256("abcx")). The third FINAL session `[150000]` is untouched.
- `y@100000` is late and merges no existing session, so it exceeds the allowed lateness and is DROPped.
- `q@10` belongs to key `k2` with its own watermark and produces no output; keys do not affect each other.

## Error handling (real output)

Input `{"key":"k","ts":1}` (missing `id`):

```
sessionize: error: line 1: missing or null field(s): id
exit code: 2
```
