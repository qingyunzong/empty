# 实际测试结果

日期：2026-10-05 04:10:55 CST，Node v22.22.1，tsc Version 7.0.2

## `npm test` 输出

```

> authorized-subscription@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/subscription.test.js
ok 1 - dist/test/subscription.test.js
  ---
  duration_ms: 534.050912
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
# duration_ms 568.59649
```

## 各用例明细（node dist/test/subscription.test.js）

```
# Subtest: 初始订阅仅发布授权可见数据，消息版本从 1 连续递增
ok 1 - 初始订阅仅发布授权可见数据，消息版本从 1 连续递增
# Subtest: 数据变更触发重评估：新增可见、不可见无消息、删除发 delete
ok 2 - 数据变更触发重评估：新增可见、不可见无消息、删除发 delete
# Subtest: 策略撤销：同一评估周期内先发删除再发新数据
ok 3 - 策略撤销：同一评估周期内先发删除再发新数据
# Subtest: 乱序完成：旧异步查询结果禁止发布
ok 4 - 乱序完成：旧异步查询结果禁止发布
# Subtest: 随机乱序完成与同步授权查询核对
ok 5 - 随机乱序完成与同步授权查询核对
# Subtest: 关闭会话后不再发布任何消息
ok 6 - 关闭会话后不再发布任何消息
# tests 6
# pass 6
# fail 0
```
