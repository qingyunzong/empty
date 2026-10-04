# RESULTS

## Test run

- Command: `python3 -m unittest discover -v` (environment provides `python3` only; no `python` alias)
- Interpreter: CPython 3.14.4 (code targets the Python 3.11 standard library)
- Date: 2026-10-05 (Asia/Shanghai)
- Exit code: **0**
- Result: **Ran 18 tests — OK** (0 failures, 0 errors, 0 skipped)
- Wall time: ~1.1 s

## Coverage vs. acceptance criteria

1. **n<=12 双侧全排列对照嵌套循环参考** — `PermutationVsReferenceTest`:
   exhaustive per-side permutations for n=1..5 events per side
   (incl. a bound=0 run with skews 3/5), plus 300 randomized trials with
   total n up to 12; the library (with watermark eviction) is compared
   pair-for-pair and count-for-count against an independent nested-loop
   reference that never evicts.
2. **bound 边界 ±5000 含与不含** — `BoundEdgeTest` (diff 5000 matches,
   5001 does not, both directions; bound=0 requires equal ts) and
   `CliTest.test_cli_bound_edge_5000`.
3. **重复 id 与极端乱序** — `DuplicateAndDisorderTest`: first occurrence
   wins, extreme out-of-order events dropped and counted as late, lateness
   threshold uses `max(LWM, RWM) - bound`, not-yet-due events are never
   treated as unsatisfiable.
4. **一侧空流仍 finalise** — `EmptySideTest` and
   `CliTest.test_cli_empty_right_still_finalises` (exit 0, empty output
   file, stats show the non-empty side fully processed).

Error handling: `CliTest.test_cli_bad_line_exit_2_and_no_output` verifies
exit code 2 and that neither the output file nor its temp file exists after
a bad input line.

## Full output (tail)

```
----------------------------------------------------------------------
Ran 18 tests in 1.393s

OK
```
