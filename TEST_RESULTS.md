# 实际测试结果记录

- 记录时间（UTC）: 2026-10-05 13:32:59
- Node.js: v22.22.1
- TypeScript: Version 7.0.2
- 平台: Linux 6.6.114.1-microsoft-standard-WSL2 x86_64

## `npm test` 输出

```

> rowauth-query@1.0.0 test
> tsc && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/engine.test.js
ok 1 - dist/test/engine.test.js
  ---
  duration_ms: 719.120776
  type: 'test'
  ...
# Subtest: dist/test/equivalence.test.js
ok 2 - dist/test/equivalence.test.js
  ---
  duration_ms: 846.529176
  type: 'test'
  ...
# Subtest: dist/test/expr.test.js
ok 3 - dist/test/expr.test.js
  ---
  duration_ms: 691.148052
  type: 'test'
  ...
# Subtest: dist/test/policy.test.js
ok 4 - dist/test/policy.test.js
  ---
  duration_ms: 695.960132
  type: 'test'
  ...
# Subtest: dist/test/threeval.test.js
ok 5 - dist/test/threeval.test.js
  ---
  duration_ms: 701.128489
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 931.927931
```

## 各测试文件子测试汇总（直接运行编译产物）

```
== dist/test/engine.test.js
# tests 12
# suites 0
# pass 12
# fail 0
# cancelled 0
# skipped 0
# todo 0
== dist/test/equivalence.test.js
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
== dist/test/expr.test.js
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
== dist/test/policy.test.js
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
== dist/test/threeval.test.js
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## `npm run typecheck` 输出

```

> rowauth-query@1.0.0 typecheck
> tsc --noEmit

exit=0
```
