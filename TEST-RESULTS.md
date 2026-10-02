# 测试结果（node --test）

- 日期: 2026-10-02 13:08:42 UTC
- Node: v22.22.1
- 命令: `node --test`

```
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
# Subtest: test/index.test.js
ok 2 - test/index.test.js
# Subtest: test/store.test.js
ok 3 - test/store.test.js
# Subtest: test/tokenize.test.js
ok 4 - test/tokenize.test.js
# Subtest: test/varint.test.js
ok 5 - test/varint.test.js
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2573.072918
```

各文件用例数（直接执行 TAP 汇总）：cli 6/6, index 6/6, store 12/12, tokenize 4/4, varint 5/5，合计 33/33 通过。
