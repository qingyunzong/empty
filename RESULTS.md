# RESULTS

Date: 2026-10-01 14:08:02 CST
Python: Python 3.14.4
Command: `python -m unittest discover -v`
Exit code: 0

```
test_cli_bad_line_exit_2 (tests.test_retractop.TestCli.test_cli_bad_line_exit_2) ... ok
test_cli_happy_path (tests.test_retractop.TestCli.test_cli_happy_path) ... ok
test_cli_unknown_op_does_not_abort (tests.test_retractop.TestCli.test_cli_unknown_op_does_not_abort) ... ok
test_deterministic_replay (tests.test_retractop.TestDifferential.test_deterministic_replay) ... ok
test_random_small_sequences (tests.test_retractop.TestDifferential.test_random_small_sequences) ... ok
test_invalid_retracts (tests.test_retractop.TestInvalid.test_invalid_retracts) ... ok
test_retract_nonexistent_does_not_crash (tests.test_retractop.TestInvalid.test_retract_nonexistent_does_not_crash) ... ok
test_late_retract_correction_and_drop (tests.test_retractop.TestLateness.test_late_retract_correction_and_drop) ... ok
test_watermark_never_regresses (tests.test_retractop.TestLateness.test_watermark_never_regresses) ... ok
test_zero_lateness_drops_immediately (tests.test_retractop.TestLateness.test_zero_lateness_drops_immediately) ... ok
test_bad_lines_raise (tests.test_retractop.TestParse.test_bad_lines_raise) ... ok
test_unknown_op_parses_but_counts_invalid (tests.test_retractop.TestParse.test_unknown_op_parses_but_counts_invalid) ... ok
test_fewer_than_k_outputs_actual (tests.test_retractop.TestTies.test_fewer_than_k_outputs_actual) ... ok
test_score_desc_primary (tests.test_retractop.TestTies.test_score_desc_primary) ... ok
test_tie_break_by_id (tests.test_retractop.TestTies.test_tie_break_by_id) ... ok

----------------------------------------------------------------------
Ran 15 tests in 1.639s

OK
```

## Acceptance mapping

1. Random n<=8 add/retract sequences vs brute-force reference, all final diffs compared:
   `TestDifferential.test_random_small_sequences` (400 seeded trials, incl. unknown ops) + `test_deterministic_replay` — OK
2. Tie order same score / same key / different id (score desc, key asc, id asc):
   `TestTies.test_tie_break_by_id`, `test_score_desc_primary`, `test_fewer_than_k_outputs_actual` — OK
3. Late correction within allowed_lateness and drop beyond it:
   `TestLateness.test_late_retract_correction_and_drop`, `test_zero_lateness_drops_immediately`, `test_watermark_never_regresses` — OK
4. Invalid retract / duplicate add / unknown op counting:
   `TestInvalid.test_invalid_retracts` (invalid=6), `test_retract_nonexistent_does_not_crash` — OK

CLI checks (manual, real runs):
- `python -m retractop --in ops.jsonl --k 3 --win 60000 --allowed-lateness 5000` -> exit 0, late retract emitted `-` correction, stderr `{"invalid": 3, "dropped": 0}`
- malformed line -> exit 2 with `error: line 2: ...`
- two identical runs -> byte-identical stdout (deterministic replay)
