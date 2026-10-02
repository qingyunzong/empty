# RESULTS

## Environment

- Python: 3.14.4 (code targets the Python 3.11 standard library only; no third-party deps)
- Date: 2026-10-02
- Command: `python -m unittest discover -v`

## Test run (real output)

```
test_cli_end_to_end (tests.test_sessionize.TestCli.test_cli_end_to_end) ... ok
test_cli_invalid_json_exit2 (tests.test_sessionize.TestCli.test_cli_invalid_json_exit2) ... ok
test_cli_missing_file_exit1 (tests.test_sessionize.TestCli.test_cli_missing_file_exit1) ... ok
test_cli_missing_id_exit2 (tests.test_sessionize.TestCli.test_cli_missing_id_exit2) ... ok
test_cli_out_file (tests.test_sessionize.TestCli.test_cli_out_file) ... ok
test_domain_gap2_late1 (tests.test_sessionize.TestExhaustiveSmallDomain.test_domain_gap2_late1) ... ok
test_domain_gap3_late2 (tests.test_sessionize.TestExhaustiveSmallDomain.test_domain_gap3_late2) ... ok
test_all_subsets_and_orders (tests.test_sessionize.TestExhaustiveSubsetsN8.test_all_subsets_and_orders) ... ok
test_exact_gap_merges (tests.test_sessionize.TestGapBoundary.test_exact_gap_merges) ... ok
test_gap_plus_one_splits (tests.test_sessionize.TestGapBoundary.test_gap_plus_one_splits) ... ok
test_same_ts_multiple_events_count_individually (tests.test_sessionize.TestGapBoundary.test_same_ts_multiple_events_count_individually) ... ok
test_ids_hash_sorted_concat_sha256 (tests.test_sessionize.TestHash.test_ids_hash_sorted_concat_sha256) ... ok
test_keys_do_not_interfere (tests.test_sessionize.TestKeyIndependence.test_keys_do_not_interfere) ... ok
test_beyond_lateness_dropped (tests.test_sessionize.TestLateness.test_beyond_lateness_dropped) ... ok
test_late_bridge_retracts_final_session (tests.test_sessionize.TestLateness.test_late_bridge_retracts_final_session) ... ok
test_late_event_extends_final_session (tests.test_sessionize.TestLateness.test_late_event_extends_final_session) ... ok
test_random_streams_match_reference (tests.test_sessionize.TestRandomizedMultiKey.test_random_streams_match_reference) ... ok

----------------------------------------------------------------------
Ran 17 tests in 2.244s

OK
```

**Result: 17/17 tests pass.**

## Acceptance criteria coverage

1. **n<=8 exhaustive vs. brute-force interval-merge reference**
   - `test_domain_gap2_late1`: all 1364 event sequences of length 1..5 over
     ts in {0,1,2,3} (gap=2, late=1) compared against the reference.
   - `test_domain_gap3_late2`: all 340 sequences of length 1..4 (gap=3, late=2).
   - `test_all_subsets_and_orders`: all 2^8-1=255 non-empty subsets of an
     8-event pool, each in 4 arrival orders (sorted, reversed, 2 seeded
     shuffles) = 1020 cases (gap=4, late=3).
   - `test_random_streams_match_reference`: 300 random multi-key streams
     (1-3 keys, random gap/late in 0..6, up to 12 events).
2. **gap / gap+1 boundary**: `test_exact_gap_merges` (gap exactly merges),
   `test_gap_plus_one_splits` (gap+1 splits),
   `test_same_ts_multiple_events_count_individually` (same-ts events count
   individually).
3. **Late-event retraction of finalized sessions**:
   `test_late_bridge_retracts_final_session` and
   `test_late_event_extends_final_session` assert the exact output stream
   `ADD -> RETRACT -> ADD`: a legal late event merges an already-final
   session with neighboring segments, the old final session is retracted
   (RETRACT payload identical to the earlier ADD), and the merged session is
   re-emitted once it is final again. See the design note below on why one
   event can retract at most one finalized session.
4. **Key independence**: `test_keys_do_not_interfere` interleaves two keys
   (one 10000ms ahead) and asserts per-key results equal separate runs;
   randomized multi-key tests also compare against the per-key reference.
5. **Error handling**: `test_cli_missing_id_exit2` (missing `id` -> exit 2),
   `test_cli_invalid_json_exit2`, `test_cli_missing_file_exit1` (exit 1),
   `test_cli_end_to_end`, `test_cli_out_file`.

## CLI smoke test (real output)

```
$ python -m sessionize --in e.jsonl --gap 30000 --late 5000
{"type": "ADD", "session": {"key": "u1", "start": 0, "end": 20000, "count": 2, "ids": "fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603"}}
{"type": "ADD", "session": {"key": "u1", "start": 70000, "end": 70000, "count": 1, "ids": "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6"}}
{"type": "ADD", "session": {"key": "u2", "start": 5000, "end": 5000, "count": 1, "ids": "148de9c5a7a44d19e56cd9ae1a554bf67847afb0c58f6e12fa29ac7ddfca9940"}}
(exit 0)

$ python -m sessionize --in bad.jsonl --gap 1 --late 0   # {"key":"k","ts":1} (no id)
sessionize: error: line 1: missing required field 'id'
(exit 2)
```

## Semantics implemented

- Per key, adjacent events (sorted by ts) with gap `<= gap` share a session;
  `gap + 1` splits. Same-ts events of one key each count toward `count`.
- Watermark `WM = max_ts - late`; a session is emitted (`ADD`) only when
  `end + gap <= WM`.
- An event with `ts < max_ts - late` is dropped; a legal late event is
  inserted and merges every session (open or finalized) within `gap`,
  emitting `RETRACT` for each affected finalized session; the merged session
  is `ADD`ed once final.
- `ids` = sha256 hex of the sorted ids concatenated (UTF-8).

## Design note: how many finals can one late event retract?

Under the specified rules, sessions of a key are always pairwise separated
by more than `gap`, so a single point event can merge at most **two**
pre-existing sessions (three would require spanning more than `2*gap`).
Furthermore, a legal late event satisfies `ts >= WM` while every finalized
session satisfies `end + gap <= WM`, so it can touch a finalized session
only at the exact boundary `ts = WM = end + gap` — at most **one** finalized
session per event (the most recent one). The retraction tests therefore use
a late event that bridges three *segments* (final session + the event itself
+ an open session), retracting the finalized one — the strongest retraction
scenario consistent with the specified watermark/lateness rules. The
exhaustive tests (which include many retraction-producing sequences) confirm
the streaming implementation matches the brute-force reference exactly.
