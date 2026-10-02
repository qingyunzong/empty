# Results

Environment: Node.js v22.22.1, standard library only, `node:test`, offline single machine.

## Test run: `node --test`

```
TAP version 13
# Subtest: test/log.test.js
ok 1 - test/log.test.js
  ---
  duration_ms: 3281.414783
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
# duration_ms 3594.837539
```

Per-test detail (`node test/log.test.js`):

```
# Subtest: random op sequence matches in-memory reference model
ok 1 - random op sequence matches in-memory reference model
# Subtest: tampering with an old OBS value is detected by the chain
ok 2 - tampering with an old OBS value is detected by the chain
# Subtest: two frames with same id and ts order deterministically by seq
ok 3 - two frames with same id and ts order deterministically by seq
# Subtest: flag after invalidate fails with ERR_STALE
ok 4 - flag after invalidate fails with ERR_STALE
# Subtest: querying an unknown id fails with ERR_NOTFOUND
ok 5 - querying an unknown id fails with ERR_NOTFOUND
# Subtest: cli: append/current/history/verify and JSON errors on stderr
ok 6 - cli: append/current/history/verify and JSON errors on stderr
```

## CLI session (real output)

```
$ node cli.js append demo.log obs7 10 42
{"seq":0,"type":"OBS","id":"obs7","ts":10,"value":42,"quality":"ok","ref":null,"prevHash":"0000000000000000000000000000000000000000000000000000000000000000","crc":"33d90cb3","hash":"dca63243e8eeb858c86c9dc914efdfc9bfb92bf0a26b8f4426c08b38a4a29c23"}
$ node cli.js flag demo.log obs7 reviewed 11
{"seq":1,"type":"FLAG","id":"obs7","ts":11,"value":null,"quality":"reviewed","ref":"dca63243e8eeb858c86c9dc914efdfc9bfb92bf0a26b8f4426c08b38a4a29c23","prevHash":"dca63243e8eeb858c86c9dc914efdfc9bfb92bf0a26b8f4426c08b38a4a29c23","crc":"e2f648ef","hash":"b31c4958c7ff95221ee7cdd613c80e227f0271deb95312a6ce01eef78beb6dd1"}
$ node cli.js current demo.log obs7
{"id":"obs7","value":42,"quality":"reviewed","ts":10}
$ node cli.js history demo.log obs7
[{"seq":0,"type":"OBS","ts":10,"value":42,"quality":"ok","ref":null},{"seq":1,"type":"FLAG","ts":11,"value":null,"quality":"reviewed","ref":"dca63243e8eeb858c86c9dc914efdfc9bfb92bf0a26b8f4426c08b38a4a29c23"}]
$ node cli.js verify demo.log
{"ok":true,"frames":2}
$ node cli.js invalidate demo.log obs7 12
{"seq":2,"type":"TOMB","id":"obs7","ts":12,"value":null,"quality":null,"ref":"b31c4958c7ff95221ee7cdd613c80e227f0271deb95312a6ce01eef78beb6dd1","prevHash":"b31c4958c7ff95221ee7cdd613c80e227f0271deb95312a6ce01eef78beb6dd1","crc":"42bf3ff2","hash":"e914c7909b45df64ca087285f0e0e1888a4217a6ef9a606a4cb2109f5a364ff4"}
$ node cli.js flag demo.log obs7 good 13
{"error":"ERR_STALE"}
exit=1
$ node cli.js current demo.log ghost
{"error":"ERR_NOTFOUND"}
exit=1
```
