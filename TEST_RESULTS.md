# 实际测试结果

记录时间：2026-10-05 04:17:57 CST
环境：Node.js v22.22.1，tsc Version 7.0.2，npm 9.2.0

## `npm test` 输出（原文记录）

```

> json-mask-pointer@0.1.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/masker.test.js
ok 1 - dist/test/masker.test.js
  ---
  duration_ms: 441.301259
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
# duration_ms 470.123906
```

## 测试文件内 27 个用例明细（`node dist/test/masker.test.js`）

```
ok 1 - masks a target value and preserves every other byte
ok 2 - number lexemes are preserved verbatim for non-target values
ok 3 - non-target string escape forms are preserved byte-for-byte
ok 4 - rejects identical duplicate keys
ok 5 - rejects duplicate decoded keys (escape vs literal)
ok 6 - rejects duplicate keys in nested objects and reports the pointer
ok 7 - rejects duplicates even inside a masked subtree, before producing output
ok 8 - rejects duplicates formed by surrogate-pair escapes vs literal emoji
ok 9 - same key in different objects is allowed
ok 10 - masks nested values via multi-segment pointers and array indices
ok 11 - supports RFC 6901 escaped pointer segments
ok 12 - masks an entire subtree as one span
ok 13 - empty pointer masks the whole document
ok 14 - custom replacement is spliced in raw
ok 15 - invalid replacement is rejected up front
ok 16 - invalid pointers are rejected up front
ok 17 - masked output is valid JSON and parses to the expected value
ok 18 - cross-chunk escape: key split mid-\\u still detects duplicates
ok 19 - cross-chunk escape: backslash at chunk boundary inside a string
ok 20 - cross-chunk surrogate pair split across feeds decodes to one key
ok 21 - byte-by-byte feeding matches one-shot masking
ok 22 - rejects invalid JSON: unterminated string
ok 23 - rejects invalid JSON: bad numbers
ok 24 - rejects invalid JSON: trailing comma and trailing garbage
ok 25 - rejects invalid JSON: bad literal and control char in string
ok 26 - rejects empty input and truncated containers
ok 27 - root scalars can be masked
# tests 27
# suites 0
# pass 27
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 89.965603
```
