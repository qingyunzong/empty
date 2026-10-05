# 实际测试结果

- 日期: 2026-10-05 21:33:38 CST
- Node: v22.22.1
- TypeScript: Version 7.0.2
- 命令: `npm test`

```

> safe-export@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/exporter.test.js
ok 1 - dist/test/exporter.test.js
  ---
  duration_ms: 781.65992
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
# duration_ms 832.565976
```

## 单文件明细（node dist/test/exporter.test.js）

```
# Subtest: publishes snapshot content when all permission epochs still match
ok 1 - publishes snapshot content when all permission epochs still match
# Subtest: snapshot is fixed at export start: later source mutations are not exported
ok 2 - snapshot is fixed at export start: later source mutations are not exported
# Subtest: mid-export revocation withholds the whole file and leaves the old file unchanged
ok 3 - mid-export revocation withholds the whole file and leaves the old file unchanged
# Subtest: epoch change without revocation also withholds the whole file
ok 4 - epoch change without revocation also withholds the whole file
# Subtest: publish failure leaves the old file unchanged and cleans staging
ok 5 - publish failure leaves the old file unchanged and cleans staging
# Subtest: intermediate staging is not readable (dir 0700, file 0600)
ok 6 - intermediate staging is not readable (dir 0700, file 0600)
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 99.260265
```
