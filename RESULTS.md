# Test Results

- Command: `node --test`
- Runtime: Node.js v22.22.1 (standard library only, no dependencies)
- Date: 2026-10-02
- Exit code: 0

## Summary

```
# tests 5        (test files)
# pass 5
# fail 0
# duration_ms ~6000
```

All 5 test files pass, covering 28 individual subtests:

| File | Subtests | Result |
| --- | --- | --- |
| test/repair.test.js | 3 | pass |
| test/door.test.js | 4 | pass |
| test/setcover.test.js | 5 | pass |
| test/engine.test.js | 11 | pass |
| test/cli.test.js | 5 | pass |

## Acceptance criteria coverage

1. **维修撤回扩大召回** — `test/repair.test.js`: a live `repair(ok=true)` dismisses
   pre-repair readings (empty recall); retracting it restores the anomaly window and
   the recall grows to `[["L1"]]`. `ok=false` establishes no trust boundary.
2. **开门解释避免误召回** — `test/door.test.js`: a `door open=true` joined to a short
   (<= 20 min) over-limit window explains it (recall `[]`); without the door event
   the same window recalls `L1`. Door-close and long windows do not explain.
3. **枚举<=4批次对照最小覆盖与并列** — `test/setcover.test.js`: 4 lots / 2 windows
   yields all 4 tied minimum covers `[A,C],[A,D],[B,C],[B,D]` in lexicographic order;
   a single lot covering all windows wins over pairs; 50 randomized instances are
   cross-checked against brute-force subset enumeration.
4. **空异常输出空集而非错误** — `test/engine.test.js` + `test/cli.test.js`: no
   anomalies (or empty input) yields `minimalSize: 0`, `solutions: [[]]`, exit code 0.

Additional verified behavior: ship windows touching anomaly endpoints are not
exposure; retracting a ship removes it from `recall.json` and `evidence.jsonl`;
retracting a door un-explains its window; late events (eventTs behind
`maxEventTs - 2min`) are dropped and logged to `late.log`; temperatures outside
`[-273.15, 100]°C` fail with `TEMP_RANGE` (exit 1); duplicate ids upsert.

## CLI smoke test (manual)

```
$ node bin/cold.js recall --in /tmp/coldtest/in --out /tmp/coldtest/out
recall complete: 1 lot(s), 1 solution(s), 1 unexplained window(s), 1 late event(s)
```

Outputs verified: `recall.json` (solutions `[["L2"]]`, watermark
`maxEventTs - 120000`), `evidence.jsonl` (1 record for lot L2),
`unexplained.jsonl` (1 window), `late.log` (1 late event).

Note: CLI tests invoke `main()` in-process with mock streams because this sandbox
swallows stdout of grandchild processes spawned via `child_process.execFile`;
the real binary was verified manually from the shell (see above).
