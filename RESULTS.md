# RESULTS

Generated: 2026-10-02T21:52:48Z on v22.22.1

## `node --test`

```
TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
  ---
  duration_ms: 2756.847449
  type: 'test'
  ...
# Subtest: test/enumeration.test.js
ok 2 - test/enumeration.test.js
  ---
  duration_ms: 3168.8824
  type: 'test'
  ...
# Subtest: test/graph.test.js
ok 3 - test/graph.test.js
  ---
  duration_ms: 4724.502293
  type: 'test'
  ...
# Subtest: test/helpers.js
ok 4 - test/helpers.js
  ---
  duration_ms: 1352.202578
  type: 'test'
  ...
# Subtest: test/merge.test.js
ok 5 - test/merge.test.js
  ---
  duration_ms: 2405.94011
  type: 'test'
  ...
# Subtest: test/parse.test.js
ok 6 - test/parse.test.js
  ---
  duration_ms: 4289.572458
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5935.009322
```

## CLI: three-device merge (acceptance 1)

$ node bin/eco-merge.js --config examples/config.json examples/devA.jsonl examples/devB.jsonl examples/devC.jsonl
```
{
  "verdict": "CONCURRENT_OK",
  "matrix": {
    "Q1": {
      "FES": 3,
      "POA": 1,
      "ROS": 1
    },
    "Q2": {
      "FES": 1,
      "POA": 2
    }
  },
  "linearization": [
    "A#1",
    "A#2",
    "A#3",
    "B#1",
    "B#2",
    "A#4",
    "B#3",
    "B#4",
    "C#1",
    "C#2",
    "B#5"
  ],
  "order": [
    "A#1",
    "A#2",
    "A#3",
    "B#1",
    "B#2",
    "A#4",
    "B#3",
    "B#4",
    "C#1",
    "C#2",
    "B#5"
  ]
}
exit code: 0
```

## CLI: causal cycle (acceptance 2)

$ node bin/eco-merge.js --config examples/config.json examples/cycle/devA.jsonl examples/cycle/devB.jsonl
```
{
  "verdict": "CONFLICT",
  "reason": "CAUSAL_CYCLE",
  "cycle": [
    "A#3",
    "A#4",
    "B#3",
    "B#4"
  ]
}
exit code: 6
```

## CLI: budget exhausted (acceptance 3)

$ node bin/eco-merge.js --config examples/config.json --budget 5 /tmp/big.jsonl   # 100-op chain
```
{
  "verdict": "PENDING",
  "reason": "BUDGET_EXHAUSTED"
}
exit code: 4
```

## CLI: invalid history

$ node bin/eco-merge.js --config examples/config.json /tmp/bad.jsonl   # non-monotonic time
```
{
  "error": "INVALID_HISTORY",
  "details": [
    {
      "source": "/tmp/bad.jsonl",
      "line": 2,
      "message": "non-monotonic time 1 after 2"
    }
  ]
}
exit code: 2
```
