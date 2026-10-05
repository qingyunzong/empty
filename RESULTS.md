# 实际测试结果记录

环境：Node.js v22.22.1，tsc Version 7.0.2，日期 2026-10-06。

## `npm test` 完整输出

```

> bitplanner@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/bfs.test.js
ok 1 - dist/test/bfs.test.js
  ---
  duration_ms: 1056.39328
  type: 'test'
  ...
# Subtest: dist/test/cli.test.js
ok 2 - dist/test/cli.test.js
  ---
  duration_ms: 953.124517
  type: 'test'
  ...
# Subtest: dist/test/frontier.test.js
ok 3 - dist/test/frontier.test.js
  ---
  duration_ms: 1082.81869
  type: 'test'
  ...
# Subtest: dist/test/heuristic.test.js
ok 4 - dist/test/heuristic.test.js
  ---
  duration_ms: 1058.157953
  type: 'test'
  ...
# Subtest: dist/test/iddfs.test.js
ok 5 - dist/test/iddfs.test.js
  ---
  duration_ms: 942.362169
  type: 'test'
  ...
# Subtest: dist/test/model.test.js
ok 6 - dist/test/model.test.js
  ---
  duration_ms: 1359.618148
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1527.545206
```

## 各测试文件子测试统计（`node <file>` 单独运行）

```
dist/test/bfs.test.js: # tests 4 # pass 4 # fail 0 
dist/test/cli.test.js: # tests 7 # pass 7 # fail 0 
dist/test/frontier.test.js: # tests 3 # pass 3 # fail 0 
dist/test/heuristic.test.js: # tests 7 # pass 7 # fail 0 
dist/test/iddfs.test.js: # tests 4 # pass 4 # fail 0 
dist/test/model.test.js: # tests 8 # pass 8 # fail 0 
```
