# RESULTS

Baseline: Node.js v22.22.1, standard library only, `node:test`, offline, single machine.
Recorded: 2026-10-05T22:46:34Z (real outputs of the commands below, exit codes included).

## `node --test`

Exit code: 0

```
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
  ---
  duration_ms: 1076.498495
  type: 'test'
  ...
# Subtest: test/cli.test.js
ok 2 - test/cli.test.js
  ---
  duration_ms: 1064.766285
  type: 'test'
  ...
# Subtest: test/engine.test.js
ok 3 - test/engine.test.js
  ---
  duration_ms: 1259.757594
  type: 'test'
  ...
# Subtest: test/enumeration.test.js
ok 4 - test/enumeration.test.js
  ---
  duration_ms: 4053.519175
  type: 'test'
  ...
# Subtest: test/perf.test.js
ok 5 - test/perf.test.js
  ---
  duration_ms: 4264.881032
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
# duration_ms 4443.274927
```

## `node cli.js exec examples/ops.jsonl --budget day=1000`

Exit code: 0

```
{"step":1,"input":{"op":"batchBegin","id":"b1"},"status":"ok","error":null,"undoPlan":null,"state":{"accounts":{},"budget":{"day":1000}},"undoDepth":0}
{"step":2,"input":{"op":"deposit","account":"alice","amount":200},"status":"ok","error":null,"undoPlan":null,"state":{"accounts":{"alice":{"balance":200,"frozen":0}},"budget":{"day":800}},"undoDepth":0}
{"step":3,"input":{"op":"transfer","from":"alice","to":"bob","amount":50},"status":"ok","error":null,"undoPlan":null,"state":{"accounts":{"alice":{"balance":150,"frozen":0},"bob":{"balance":50,"frozen":0}},"budget":{"day":750}},"undoDepth":0}
{"step":4,"input":{"op":"freeze","account":"alice","amount":30},"status":"ok","error":null,"undoPlan":null,"state":{"accounts":{"alice":{"balance":150,"frozen":30},"bob":{"balance":50,"frozen":0}},"budget":{"day":750}},"undoDepth":0}
{"step":5,"input":{"op":"batchEnd","id":"b1"},"status":"ok","error":null,"undoPlan":null,"state":{"accounts":{"alice":{"balance":150,"frozen":30},"bob":{"balance":50,"frozen":0}},"budget":{"day":750}},"undoDepth":1}
{"step":6,"input":{"op":"deposit","account":"carol","amount":80},"status":"ok","error":null,"undoPlan":null,"state":{"accounts":{"alice":{"balance":150,"frozen":30},"bob":{"balance":50,"frozen":0},"carol":{"balance":80,"frozen":0}},"budget":{"day":670}},"undoDepth":2}
{"step":7,"input":{"op":"undo","batch":"b1"},"status":"error","error":{"code":"AMBIGUOUS_UNDO","message":"2 equally preferred undo plans for b1"},"undoPlan":{"target":"b1","ambiguous":true,"candidates":[[{"op":"withdraw","amount":80,"event":2,"account":"carol"},{"op":"transfer","amount":50,"event":1,"from":"bob","to":"alice"},{"op":"unfreeze","amount":30,"event":1,"account":"alice"},{"op":"withdraw","amount":200,"event":1,"account":"alice"}],[{"op":"withdraw","amount":80,"event":2,"account":"carol"},{"op":"unfreeze","amount":30,"event":1,"account":"alice"},{"op":"transfer","amount":50,"event":1,"from":"bob","to":"alice"},{"op":"withdraw","amount":200,"event":1,"account":"alice"}]]},"state":{"accounts":{"alice":{"balance":150,"frozen":30},"bob":{"balance":50,"frozen":0},"carol":{"balance":80,"frozen":0}},"budget":{"day":670}},"undoDepth":2}
{"step":8,"input":{"op":"undo"},"status":"ok","error":null,"undoPlan":{"target":"u2","steps":[{"op":"withdraw","amount":80,"event":2,"account":"carol"}]},"state":{"accounts":{"alice":{"balance":150,"frozen":30},"bob":{"balance":50,"frozen":0}},"budget":{"day":750}},"undoDepth":1}
```

## Acceptance mapping

- A (transfer+freeze combo commits): `test/acceptance.test.js` → "A: transfer + freeze combination commits successfully" — pass.
- B (insufficient funds abort whole batch, no partial effect): "B: insufficient funds abort the whole batch with no partial effect" — pass.
- C (nested batch inner failure does not affect committed outer): "C: nested batchBegin fails but the outer batch still commits" — pass.
- D (enumerate all sequences, <=10 ops, 2 accounts, cross-checked): `test/enumeration.test.js` → "D1: exhaustive money-op sequences (len <= 4, 2 accounts) match reference" (11,111 sequences vs naive reference) and "D2: random sequences (len <= 10) keep invariants and undo restores state" (400 seeded sequences with batches/undo) — pass.
- E (two equal-length, same-account plans trigger AMBIGUOUS_UNDO): "E: two equal-length, same-account, same-time plans trigger AMBIGUOUS_UNDO" — pass.
- Scale (50k ops): `test/perf.test.js` → "scale: 50k ops stay correct and fast" — pass.
