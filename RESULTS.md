# 实际测试结果

命令：`npm test`

环境：Node.js v22.22.1，tsc Version 7.0.2

```

> offline-sync@1.0.0 test
> npm run build && node --test-reporter=spec dist/test/sync.test.js


> offline-sync@1.0.0 build
> tsc -p tsconfig.json

✔ commits changes and cursor in one batch (3.187297ms)
✔ page replay is idempotent, even after later pages applied (0.414571ms)
✔ same id with different content rejects the whole page (0.54995ms)
✔ duplicate id with different content inside one page rejects the page (0.262956ms)
✔ crash and restart at every write boundary matches sequential application (12.102928ms)
✔ repeated crashes never skip records and converge to the reference (1.525387ms)
✔ conflicting page during recovery still rejects and preserves state (0.524753ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 29.455126
```
