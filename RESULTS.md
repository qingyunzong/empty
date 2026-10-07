# 实际结果记录

记录时间：2026-10-07；环境：Node.js v22.22.1，tsc 7.0.2（TypeScript native），Linux。

## `npm test` 实际输出

```console
$ npm test
> pathrule@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
  ---
  duration_ms: 477.538087
  type: 'test'
  ...
# Subtest: dist/test/crosscheck.test.js
ok 2 - dist/test/crosscheck.test.js
  ---
  duration_ms: 2634.159495
  type: 'test'
  ...
# Subtest: dist/test/match.test.js
ok 3 - dist/test/match.test.js
  ---
  duration_ms: 465.997523
  type: 'test'
  ...
# Subtest: dist/test/pattern.test.js
ok 4 - dist/test/pattern.test.js
  ---
  duration_ms: 464.89202
  type: 'test'
  ...
# Subtest: dist/test/search.test.js
ok 5 - dist/test/search.test.js
  ---
  duration_ms: 486.271816
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
# duration_ms 2684.592066
```

穷举对照明细（单独运行该测试文件可见计数）：

```console
$ node dist/test/crosscheck.test.js | grep crosscheck:
  crosscheck: 3000 cases, 1292 witnesses, 1708 empty
```

## CLI 实际运行

```console
$ node dist/src/cli.js a/* */b
WITNESS a/b
  exit=0
$ node dist/src/cli.js ** **
WITNESS (empty)
  exit=0
$ node dist/src/cli.js a b
EMPTY
  exit=1
$ node dist/src/cli.js a/** ** -x a,a/*
WITNESS a/a/a
  exit=0
$ node dist/src/cli.js * * -x a,aa,ab
WITNESS aaa
  exit=0
$ node dist/src/cli.js */x **
WITNESS a/x
  exit=0
$ node dist/src/cli.js a ** --budget 0
UNKNOWN: expansion budget 0 exhausted
  exit=2
$ node dist/src/cli.js a b --max-depth 0
UNKNOWN: depth limit 0 reached
  exit=2
$ node dist/src/cli.js a//b c
error: empty segment in pattern "a//b"
  exit=3
```
