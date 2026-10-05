# npm test 实际结果

```
$ npm test


> amount-parse-edit@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/acceptance.test.js
ok 1 - dist/test/acceptance.test.js
  ---
  duration_ms: 2355.783565
  type: 'test'
  ...
# Subtest: dist/test/document.test.js
ok 2 - dist/test/document.test.js
  ---
  duration_ms: 1627.026911
  type: 'test'
  ...
# Subtest: dist/test/format.test.js
ok 3 - dist/test/format.test.js
  ---
  duration_ms: 1856.19608
  type: 'test'
  ...
# Subtest: dist/test/fuzz.test.js
ok 4 - dist/test/fuzz.test.js
  ---
  duration_ms: 1848.964526
  type: 'test'
  ...
# Subtest: dist/test/parse.test.js
ok 5 - dist/test/parse.test.js
  ---
  duration_ms: 1884.863517
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
# duration_ms 2421.639271
```

记录时间: 2026-10-06 05:34:18 CST，Node v22.22.1，tsc Version 7.0.2。

汇总：5 个测试文件、35 个测试全部通过（acceptance 10 / document 7 / format 4 / fuzz 3 / parse 11），
其中穷举验收约 8000 合法组合 + 全组合非法串，fuzz 为 3 种子 × 400 步随机编辑逐位核对。
