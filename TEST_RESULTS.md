# 实际测试结果

- 日期: 2026-10-05 10:55:44 CST
- Node.js: v22.22.1
- npm: 9.2.0
- tsc: Version 7.0.2
- 命令: `npm test`（= `tsc -p tsconfig.json && node --test dist/test/*.test.js`）

```

> log-compaction@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/log.test.js
ok 1 - dist/test/log.test.js
  ---
  duration_ms: 625.972753
  type: 'test'
  ...
# Subtest: dist/test/registry.test.js
ok 2 - dist/test/registry.test.js
  ---
  duration_ms: 645.596844
  type: 'test'
  ...
# Subtest: dist/test/simulation.test.js
ok 3 - dist/test/simulation.test.js
  ---
  duration_ms: 1185.803299
  type: 'test'
  ...
# Subtest: dist/test/system.test.js
ok 4 - dist/test/system.test.js
  ---
  duration_ms: 683.181103
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1305.032525
```

模拟测试统计（`node dist/test/simulation.test.js` 中的 console.log，经 `node --test` 运行时会被 TAP 吞掉，此处单独展示）:

```
seed=1: 400 events, 49 compactions, 39 restarts, 5 live replicas, log [156..172]
seed=7: 400 events, 55 compactions, 33 restarts, 4 live replicas, log [107..135]
seed=42: 400 events, 71 compactions, 36 restarts, 1 live replicas, log [121..149]
# Subtest: event simulation (seed=1): remaining log recovers every live replica
ok 1 - event simulation (seed=1): remaining log recovers every live replica
# Subtest: event simulation (seed=7): remaining log recovers every live replica
ok 2 - event simulation (seed=7): remaining log recovers every live replica
# Subtest: event simulation (seed=42): remaining log recovers every live replica
ok 3 - event simulation (seed=42): remaining log recovers every live replica
```
