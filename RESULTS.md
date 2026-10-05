# 实际运行结果

记录时间: 2026-10-05 21:50:24 CST，环境: node v22.22.1，tsc Version 7.0.2

## `npm test`

```

> policy-diff@1.0.0 test
> npm run build && node --test "dist/test/*.test.js"


> policy-diff@1.0.0 build
> tsc -p tsconfig.json

TAP version 13
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
  ---
  duration_ms: 1960.186981
  type: 'test'
  ...
# Subtest: dist/test/enumerate.test.js
ok 2 - dist/test/enumerate.test.js
  ---
  duration_ms: 561.46923
  type: 'test'
  ...
# Subtest: dist/test/model.test.js
ok 3 - dist/test/model.test.js
  ---
  duration_ms: 570.410804
  type: 'test'
  ...
# Subtest: dist/test/solve.test.js
ok 4 - dist/test/solve.test.js
  ---
  duration_ms: 552.054498
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1991.425291
```

## 示例运行

### examples/diff.json

```
结论: DIFFERENT — 找到最小差异赋值（已指定字段 2 个）
  mfa = off
  role = admin
  策略 A 决议: permit
  策略 B 决议: deny
统计: 已求值 8 / 空间 9（预算 1000000），枚举核对 ok，求值核对 ok
{
  "verdict": "DIFFERENT",
  "witness": {
    "assignment": {
      "mfa": "off",
      "role": "admin"
    },
    "specifiedFields": 2,
    "decisions": {
      "A": "permit",
      "B": "deny"
    }
  },
  "evaluated": 8,
  "spaceSize": "9",
  "budget": 1000000,
  "crossCheck": {
    "enumeration": "ok",
    "evaluation": "ok"
  }
}
退出码: 0
```

### examples/equivalent.json

```
结论: EQUIVALENT — 已穷尽全部属性赋值，两策略决议始终一致
统计: 已求值 9 / 空间 9（预算 1000000），枚举核对 ok，求值核对 ok
{
  "verdict": "EQUIVALENT",
  "witness": null,
  "evaluated": 9,
  "spaceSize": "9",
  "budget": 1000000,
  "crossCheck": {
    "enumeration": "ok",
    "evaluation": "ok"
  }
}
退出码: 0
```

### examples/undecided.json

```
结论: UNDECIDED — 预算耗尽，尚未找到差异也未穷尽空间
统计: 已求值 1000 / 空间 214358881（预算 1000），枚举核对 ok，求值核对 skipped
{
  "verdict": "UNDECIDED",
  "witness": null,
  "evaluated": 1000,
  "spaceSize": "214358881",
  "budget": 1000,
  "crossCheck": {
    "enumeration": "ok",
    "evaluation": "skipped"
  }
}
退出码: 3
```

