# 实际测试运行记录

日期: 2026-10-05 15:24:10 CST
环境: v22.22.1, npm 9.2.0, tsc Version 7.0.2

## `npm test` 输出

```

> upgrade-plan@1.0.0 test
> npm run build && node --test dist/test/*.test.js


> upgrade-plan@1.0.0 build
> tsc -p tsconfig.json

TAP version 13
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
  ---
  duration_ms: 200.867917
  type: 'test'
  ...
# Subtest: dist/test/crosscheck.test.js
ok 2 - dist/test/crosscheck.test.js
  ---
  duration_ms: 198.345563
  type: 'test'
  ...
# Subtest: dist/test/solver.test.js
ok 3 - dist/test/solver.test.js
  ---
  duration_ms: 197.170497
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
# duration_ms 218.381268
```

## 各测试文件明细（直接运行 TAP 输出）

```
== dist/test/cli.test.js ==
ok 1 - CLI: 基本链路输出证书与枚举对照
ok 2 - CLI: 字典序并列打破
ok 3 - CLI: 空间限制排除过大的边
ok 4 - CLI: 无可行方案退出码为 2
ok 5 - CLI: 标准输入与 --json
ok 6 - CLI: 非法输入退出码为 1
ok 7 - CLI: --no-enumerate 跳过对照
ok 8 - CLI: --help 退出码 0
# tests 8
# pass 8
# fail 0
== dist/test/crosscheck.test.js ==
ok 1 - 随机小图: 求解器与枚举对照一致 (300 例)
ok 2 - 枚举: 手工小图逐一对照
# tests 2
# pass 2
# fail 0
== dist/test/solver.test.js ==
ok 1 - compareSeq: 字典序与前缀规则
ok 2 - edgeFits: bytes+peak 不超过上限才可行
ok 3 - 求解: 选总下载量最小的路径
ok 4 - 求解: 同费用时取包 ID 序列字典序最小
ok 5 - 求解: 字典序并列由后续元素决定
ok 6 - 求解: 空间不足的单条边被排除
ok 7 - 求解: 全部路径不可行时报告原因
ok 8 - 求解: 起点即终点时为空方案
ok 9 - 证书: 下载/峰值/清理逐步核算
ok 10 - 证书: 超限步骤被标记
ok 11 - parseProblem: 拒绝超过 18 个包
ok 12 - parseProblem: 拒绝重复 ID / 非正 bytes / 缺字段
# tests 12
# pass 12
# fail 0
```
