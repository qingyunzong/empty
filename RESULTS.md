# 实际测试结果

- 日期：2026-10-05（Asia/Shanghai）
- 环境：Node.js v22.22.1，npm 9.2.0，TypeScript Version 7.0.2（全局）
- 命令：`npm test`（即 `tsc -p tsconfig.json && node --test "dist/test/*.test.js"`）

## npm test 输出（TAP 摘要）

```
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 620.652257
```

## 逐测试明细（node --test-reporter=spec）

```

> change-log@1.0.0 test
> npm run build && node dist/test/change-log.test.js


> change-log@1.0.0 build
> tsc -p tsconfig.json

TAP version 13
# Subtest: insert 后 delete：两者消失
ok 1 - insert 后 delete：两者消失
  ---
  duration_ms: 11.185545
  type: 'test'
  ...
# Subtest: delete 后 insert：成为 replace 且保存原值
ok 2 - delete 后 insert：成为 replace 且保存原值
  ---
  duration_ms: 1.604483
  type: 'test'
  ...
# Subtest: 无法知道原值时报需要基线；提供基线后可解析
ok 3 - 无法知道原值时报需要基线；提供基线后可解析
  ---
  duration_ms: 1.449319
  type: 'test'
  ...
# Subtest: replace 后 delete 成为 delete、连续 replace 合并，均保留最早原值
ok 4 - replace 后 delete 成为 delete、连续 replace 合并，均保留最早原值
  ---
  duration_ms: 1.196434
  type: 'test'
  ...
# Subtest: 逆批次：顺序相反且依次应用可撤销
ok 5 - 逆批次：顺序相反且依次应用可撤销
  ---
  duration_ms: 1.978328
  type: 'test'
  ...
# Subtest: 随机操作：压缩前后结果及撤销相同
ok 6 - 随机操作：压缩前后结果及撤销相同
  ---
  duration_ms: 63.207712
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
# duration_ms 154.214923
```

7/7 通过。穷举对照 15813 个小序列（其中 13639 个存在多个最优解，
平局裁定逐一与子集枚举的唯一索引序最小选择一致）；随机对照 500 个序列
（309 个多最优）；n=2000 时 LIS 长度 79，证书验证通过。
