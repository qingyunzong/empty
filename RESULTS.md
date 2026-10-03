# Test Results

- Date: 2026-10-03 17:32 UTC
- Node: v22.22.1
- Command: `node --test` (exit code 0)

## Summary

```
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## test/analyze.test.js (9/9 pass)

```
ok 1 - acceptance 1: retracting an ok repair invalidates trusted readings and expands the recall
ok 2 - acceptance 2: a short excursion overlapping a door opening is explained and avoids false recall
ok 3 - acceptance 3: enumerates all minimum covers with ties over 4 lots
ok 4 - acceptance 4: no excursions yields an empty recall set, not an error
ok 5 - temp outside physical range throws TEMP_RANGE
ok 6 - ship window touching excursion endpoints does not count as exposure
ok 7 - retracting a ship removes it from recall and evidence
ok 8 - late events are logged against the watermark but still processed
ok 9 - minimumCovers handles empty universe and infeasible cases
```

## test/cli.test.js (4/4 pass)

```
ok 1 - CLI recall writes recall.json, evidence.jsonl, unexplained.jsonl, late.log
ok 2 - CLI empty anomalies produce an empty recall set, not an error
ok 3 - CLI reports TEMP_RANGE for physically impossible temperatures
ok 4 - CLI late events land in late.log
```

## Acceptance mapping

1. 维修撤回扩大召回 — `acceptance 1`: retracting `repair(ok=true)` drops
   the trusted normal reading, the excursion window extends past the
   short-window threshold, recall grows from `[[]]` to `[['L1']]`.
2. 开门解释避免误召回 — `acceptance 2`: short excursion overlapping a
   door-open interval is explained (recall empty); without the door events
   the same data recalls `[['L1']]`.
3. 枚举 ≤4 批次最小覆盖与并列 — `acceptance 3`: 4 lots, 3 windows,
   minimum cover size 2 with ties
   `[[L1,L3],[L2,L3],[L2,L4]]`, lexicographically ordered.
4. 空异常输出空集 — `acceptance 4` (library + CLI): no excursions yields
   `solutions: [[]]`, `minimumSize: 0`, exit code 0.

Also covered: `TEMP_RANGE` physical-range errors, endpoint-touching ship
windows not counting as exposure, ship retraction syncing recall/evidence,
and late-event logging against the watermark.
