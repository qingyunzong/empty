# 实际测试结果

- 日期: 2026-10-06 06:32:17 CST
- 环境: v22.22.1, npm 9.2.0, tsc Version 7.0.2
- 命令: `npm test`（tsc 编译后 node --test）

## npm test 输出

```

> delta-merge-library@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/merge-library.test.js
ok 1 - dist/test/merge-library.test.js
  ---
  duration_ms: 1041.318854
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
# duration_ms 1139.277732
```

## 测试明细（TAP）

```
TAP version 13
# Subtest: 父缺失时缓冲，父到达后自动落图（含孙代递归冲刷）
ok 1 - 父缺失时缓冲，父到达后自动落图（含孙代递归冲刷）
  ---
  duration_ms: 30.342623
  type: 'test'
  ...
# Subtest: 多分支不强行线性化，查询必须指定分支头
ok 2 - 多分支不强行线性化，查询必须指定分支头
  ---
  duration_ms: 18.422804
  type: 'test'
  ...
# Subtest: 坏摘要被隔离，其后继（含乱序补到的）一并隔离
ok 3 - 坏摘要被隔离，其后继（含乱序补到的）一并隔离
  ---
  duration_ms: 8.231651
  type: 'test'
  ...
# Subtest: 乱序重放与完整版本图构建结果等价（多种子对照）
ok 4 - 乱序重放与完整版本图构建结果等价（多种子对照）
  ---
  duration_ms: 8.705368
  type: 'test'
  ...
# Subtest: 重复接收同一差量为幂等空操作
ok 5 - 重复接收同一差量为幂等空操作
  ---
  duration_ms: 1.54849
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
# duration_ms 227.954058
```
