# RESULTS

日期: 2026-10-02T15:32:50Z  Node: v22.22.1

## 1. 测试套件: `node --test test/*.test.js`

```
TAP version 13
# Subtest: test/bruteforce.test.js
ok 1 - test/bruteforce.test.js
  ---
  duration_ms: 28133.476003
  type: 'test'
  ...
# Subtest: test/certificate.test.js
ok 2 - test/certificate.test.js
  ---
  duration_ms: 18162.646979
  type: 'test'
  ...
# Subtest: test/constraints.test.js
ok 3 - test/constraints.test.js
  ---
  duration_ms: 20004.208159
  type: 'test'
  ...
# Subtest: test/crash.test.js
ok 4 - test/crash.test.js
  ---
  duration_ms: 30976.917686
  type: 'test'
  ...
# Subtest: test/errors.test.js
ok 5 - test/errors.test.js
  ---
  duration_ms: 36599.295494
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
# duration_ms 37528.861753
```

## 2. CLI 会话（示例数据 obligations.json / constraints.json）

### `node cli.js optimize`

```
{
  "status": "planned",
  "stateFile": ".settlement/plan.json",
  "selected": [
    "o1",
    "o2",
    "o3",
    "o4",
    "o5",
    "o6"
  ],
  "cost": 2650,
  "volume": 60,
  "freeze": 61,
  "tiedCount": 1,
  "candidateSetHash": "f2c7fbfa50de54a28f760f6251b02b59d8dbf5256323809c84ee55dae4a76337"
}
exit=0
```

### `node cli.js emit`

```
{
  "status": "executed",
  "plan": {
    "ids": [
      "o1",
      "o2",
      "o3",
      "o4",
      "o5",
      "o6"
    ],
    "netted": [
      {
        "party": "finA",
        "amount": 30
      },
      {
        "party": "finB",
        "amount": -60
      },
      {
        "party": "finC",
        "amount": 10
      },
      {
        "party": "finD",
        "amount": 20
      }
    ],
    "gross": []
  },
  "cost": {
    "fee": 1500,
    "freezeOccupation": 610,
    "timing": 540,
    "scale": 10000
  },
  "totalCost": 2650,
  "volume": 60,
  "freeze": 61,
  "certificate": {
    "version": 1,
    "algorithm": "exhaustive-bitmask-v1",
    "obligationsHash": "b4b6652c7afa4f80a137e6b16e5efebbd230a711d2a2df341cdc01cbb963a60c",
    "constraintsHash": "15e7d5a72b30a23150d50954ecc257daf6b0d49a0d355133c74350cabf9d94ca",
    "feasibleCount": 12,
    "optimalCost": 2650,
    "tiedPlans": [
      {
        "ids": [
          "o1",
          "o2",
          "o3",
          "o4",
          "o5",
          "o6"
        ],
        "cost": 2650,
        "volume": 60,
        "freeze": 61
      }
    ],
    "candidateSetHash": "f2c7fbfa50de54a28f760f6251b02b59d8dbf5256323809c84ee55dae4a76337",
    "selectionRule": "min-cost-then-lexicographic-sorted-ids",
    "selectedKey": "o1,o2,o3,o4,o5,o6"
  },
  "executionMarker": {
    "status": "executed",
    "planHash": "9ddebbac85f926c14894c6370878a1e834db817dca6234f0b5cde9d37f3202fe",
    "candidateSetHash": "f2c7fbfa50de54a28f760f6251b02b59d8dbf5256323809c84ee55dae4a76337"
  }
}
exit=0
```

### `node cli.js explain`（前 14 行）

```
optimal cost: 2650
selected: [o1,o2,o3,o4,o5,o6]
tied optimal plans: 1
candidate set hash: f2c7fbfa50de54a28f760f6251b02b59d8dbf5256323809c84ee55dae4a76337
- [] eliminated: infeasible (daily:560>500)
- [o1] eliminated: infeasible (sign:finA)
- [o1,o2] eliminated: infeasible (sign:finA)
- [o1,o2,o3] eliminated: infeasible (sign:finA)
- [o1,o2,o3,o4] eliminated: infeasible (sign:finA)
- [o1,o2,o3,o4,o5] eliminated: infeasible (sign:finA)
- [o1,o2,o3,o4,o6] eliminated: infeasible (sign:finD)
- [o1,o2,o3,o5] eliminated: infeasible (sign:finA)
- [o1,o2,o3,o5,o6] eliminated: dominated (cost 6720 > optimal 2650)
- [o1,o2,o3,o6] eliminated: infeasible (sign:finD)
```

### `node cli.js rollback`（已执行，拒绝并生成反向方案）

```
reverse plan written to .settlement/reverse-plan.json
error: plan already executed; rollback refused, only a reverse plan can be generated
exit=72
{
  "kind": "reverse-plan",
  "reverses": [
    "o1",
    "o2",
    "o3",
    "o4",
    "o5",
    "o6"
  ],
  "netted": [
    {
      "party": "finA",
      "amount": -30
    },
    {
      "party": "finB",
      "amount": 60
    },
    {
      "party": "finC",
      "amount": -10
    },
    {
      "party": "finD",
      "amount": -20
    }
  ],
  "gross": []
}
```

## 3. 错误码演示

### code=71 未决义务按不可满足处理

```
error: 1 pending obligation(s) treated as unsatisfiable: o9
exit=71
```

### code=70 预算不可满足

```
error: no feasible netting plan: freeze/daily budgets unsatisfiable for every netting set
exit=70
```

### 未执行方案的 rollback（撤销成功）

```
{
  "status": "rolled-back",
  "revoked": [
    "o1",
    "o2",
    "o3",
    "o4",
    "o5",
    "o6"
  ]
}
exit=0
```
