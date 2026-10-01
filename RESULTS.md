# Test Results

## Final run

- Command: `python3 -m unittest discover -v`
- Working directory: repository root
- Python: 3.14.4 (code targets the 3.11 standard library)
- Exit code: 0
- Tests run: 14
- Failures: 0
- Errors: 0
- Result: OK

Raw tail of the run:

```
Ran 14 tests in 1.505s

OK
```

## History (kept for honesty)

- First run of the suite: exit code 1, 14 tests, 2 failures
  (`test_reorder_and_late`, `test_late_file_via_cli`). Root cause was wrong
  expected values in the test fixtures (`ts=100` falls in `[100,200)`, not
  `[0,100)`, under left-closed right-open semantics); the library behaved
  correctly. Fixtures were fixed and the final run above passes.

## Manual CLI smoke checks (all in /tmp/wmagg_smoke)

- `python3 -m wmagg --input events.jsonl --out out.jsonl --late late.jsonl --window 100 --lateness 10 --idle-timeout 1000`
  -> exit 0, expected window sums in `out.jsonl`, empty `late.jsonl`.
- Same command with a bad JSON line in the input
  -> exit 2, `wmagg: error: line 2: invalid JSON: ...` on stderr, no output
  files written.
