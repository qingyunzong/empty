# 测试结果（实际运行记录）

- 日期: 2026-10-05 16:08:49 CST
- 环境: v22.22.1, tsc Version 7.0.2, Linux x86_64
- 命令: `npm test`（即 `tsc -p tsconfig.json && node --test dist/test/*.test.js`）

## 各测试文件子测试（实际输出）

### `dist/test/aggregate.test.js`
```
ok 1 - COUNT(*) counts rows, COUNT(col) ignores NULL
ok 2 - SUM/MIN/MAX ignore NULL; all-NULL yields NULL
ok 3 - AVG ignores NULL
ok 4 - aggregates over empty input
ok 5 - integer arithmetic is exact beyond 2^53
```

### `dist/test/determinism.test.js`
```
ok 1 - output order is deterministic regardless of input order
```

### `dist/test/differential.test.js`
```
ok 1 - engine matches nested-loop reference on random small inputs
```

### `dist/test/join.test.js`
```
ok 1 - inner join with projection and filter
ok 2 - NULL join keys never match
ok 3 - grouped join aggregation
ok 4 - non-equi join condition falls back correctly
ok 5 - ambiguous and unknown columns are rejected
```

### `dist/test/threevalued.test.js`
```
ok 1 - 3VL truth tables
ok 2 - NULL comparison is UNKNOWN and WHERE keeps only TRUE
```

## `npm test` 汇总（实际输出）

```
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 381.082121
```
