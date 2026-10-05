# 实际测试与运行结果记录

记录时间: 2026-10-06 04:14:35 CST，环境: node v22.22.1, tsc Version 7.0.2

## npm test

```

> fsm-failure-minimizer@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/minimize.test.js
ok 1 - dist/test/minimize.test.js
  ---
  duration_ms: 1502.984249
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1574.754947
npm test exit=0
```

## 逐测试明细（node dist/test/minimize.test.js）

```
ok 1 - simulate classifies fail / pass / invalid
ok 2 - validateMachine rejects dangling references
ok 3 - counter example reduces to [tick tick tick] and is 1-minimal
ok 4 - guard example: invalid histories are never accepted as failures
ok 5 - non-failing input is rejected, not minimized
ok 6 - reduction is deterministic across runs
ok 7 - trace replay reproduces every judgment and confirms 1-minimality
ok 8 - replay detects a tampered verdict
# tests 8
# pass 8
# fail 0
```

## CLI 示例运行

```
$ node dist/src/cli.js run examples/counter.json --trace /tmp/trace-counter.jsonl
input:    [x tick y tick x tick y] (7 events)
reduced:  [tick tick tick] (3 events)
verdicts: 39 judgments, 4 deletions accepted
1-minimal: yes (3 single-event deletions re-checked)
trace:    /tmp/trace-counter.jsonl

$ node dist/src/cli.js replay /tmp/trace-counter.jsonl
replay ok: 39 judgments reproduced
reduced:   [tick tick tick] (1-minimal: true)

$ node dist/src/cli.js run examples/guard.json --trace /tmp/trace-guard.jsonl
input:    [ping arm ping fire ping] (5 events)
reduced:  [arm fire] (2 events)
verdicts: 19 judgments, 3 deletions accepted
1-minimal: yes (2 single-event deletions re-checked)
trace:    /tmp/trace-guard.jsonl

$ node dist/src/cli.js replay /tmp/trace-guard.jsonl
replay ok: 19 judgments reproduced
reduced:   [arm fire] (1-minimal: true)

$ node dist/src/cli.js run /tmp/nofail.json  # 输入本身不失败
input sequence verdict is "pass", expected "fail"; nothing to minimize (trace: /tmp/t.jsonl)
exit code: 2
```
