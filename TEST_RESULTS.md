# 测试结果（真实运行记录）

- 运行时间: 2026-10-03T13:57:28Z
- Node 版本: v22.22.1
- 命令: `node --test`

```
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
  ---
  duration_ms: 232.738404
  type: 'test'
  ...
# Subtest: test/cli.test.js
ok 2 - test/cli.test.js
  ---
  duration_ms: 212.880241
  type: 'test'
  ...
# Subtest: test/reference.test.js
ok 3 - test/reference.test.js
  ---
  duration_ms: 667.748446
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 700.062824
```

## CLI 冒烟（node src/cli.js /tmp/cmds.jsonl，含一条 UNKNOWN_ZONE 错误，退出码 1）

```
{"type":"ok","command":"defineZone","zone":"utc","segments":1}
{"type":"ok","command":"event","id":"c1","version":1,"utcMs":1767225601000,"utc":"2026-01-01T00:00:01.000Z"}
{"type":"ok","command":"event","id":"c2","version":1,"utcMs":1767225605000,"utc":"2026-01-01T00:00:05.000Z"}
{"type":"mergeResult","deviceId":"dev-cli","upToVersion":null,"observation":{"startUtcMs":1767225600000,"cutoffUtcMs":1767225610000,"startUtc":"2026-01-01T00:00:00.000Z","cutoffUtc":"2026-01-01T00:00:10.000Z"},"intervals":[{"index":0,"deviceId":"dev-cli","state":"ON","scope":"ALL","startUtcMs":1767225601000,"endUtcMs":1767225605000,"startUtc":"2026-01-01T00:00:01.000Z","endUtc":"2026-01-01T00:00:05.000Z","unclosed":false,"eventIds":["c1"],"mergedCount":1},{"index":1,"deviceId":"dev-cli","state":"OFF","scope":"ALL","startUtcMs":1767225605000,"endUtcMs":1767225610000,"startUtc":"2026-01-01T00:00:05.000Z","endUtc":"2026-01-01T00:00:10.000Z","unclosed":true,"eventIds":["c2"],"mergedCount":1}],"affectedRange":null,"certificate":{"deviceId":"dev-cli","upToVersion":null,"eventCount":2,"intervals":[{"index":0,"state":"ON","scope":"ALL","startUtcMs":1767225601000,"endUtcMs":1767225605000,"unclosed":false,"mergedEventIds":["c1"],"timeline":[{"id":"c1","utcMs":1767225601000,"utc":"2026-01-01T00:00:01.000Z","state":"ON","version":1}]},{"index":1,"state":"OFF","scope":"ALL","startUtcMs":1767225605000,"endUtcMs":1767225610000,"unclosed":true,"mergedEventIds":["c2"],"timeline":[{"id":"c2","utcMs":1767225605000,"utc":"2026-01-01T00:00:05.000Z","state":"OFF","version":1}]}],"outsideObservation":[],"changedIntervalIndexes":[0,1],"affectedRange":null}}
{"type":"error","code":"UNKNOWN_ZONE","message":"unknown zone: ghost"}
```
