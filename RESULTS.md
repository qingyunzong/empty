# 实际运行结果

记录时间：2026-10-06 01:41:54 CST；Node v22.22.1；tsc 7.0.2；npm 9.2.0

## `npm test`（11/11 通过）

```

> plugin-planner@1.0.0 test
> tsc -p tsconfig.json && node dist/test/solver.test.js

TAP version 13
# Subtest: 数据集：三种方法得到一致最优成本 19
ok 1 - 数据集：三种方法得到一致最优成本 19
  ---
  duration_ms: 44.660141
  type: 'test'
  ...
# Subtest: 数据集：返回序列逐步合法且覆盖目标
ok 2 - 数据集：返回序列逐步合法且覆盖目标
  ---
  duration_ms: 17.495091
  type: 'test'
  ...
# Subtest: 循环自供：插件不能靠自身提供的能力启动
ok 3 - 循环自供：插件不能靠自身提供的能力启动
  ---
  duration_ms: 1.284479
  type: 'test'
  ...
# Subtest: 互相依赖的二元环：双方都无法启动
ok 4 - 互相依赖的二元环：双方都无法启动
  ---
  duration_ms: 1.71846
  type: 'test'
  ...
# Subtest: 环中一个插件可被外部能力点燃，另一个仍不行
ok 5 - 环中一个插件可被外部能力点燃，另一个仍不行
  ---
  duration_ms: 0.734553
  type: 'test'
  ...
# Subtest: 目标已被初始能力满足：空序列，成本 0
ok 6 - 目标已被初始能力满足：空序列，成本 0
  ---
  duration_ms: 0.668905
  type: 'test'
  ...
# Subtest: 贪心陷阱：便宜插件占位的组合并非最优
ok 7 - 贪心陷阱：便宜插件占位的组合并非最优
  ---
  duration_ms: 0.695589
  type: 'test'
  ...
# Subtest: 超过 18 个插件：校验拒绝
ok 8 - 超过 18 个插件：校验拒绝
  ---
  duration_ms: 1.368982
  type: 'test'
  ...
# Subtest: 恰好 18 个插件：可求解且与穷举一致
ok 9 - 恰好 18 个插件：可求解且与穷举一致
  ---
  duration_ms: 124.374617
  type: 'test'
  ...
# Subtest: formatPlan：逐步输出已具能力且单调增长
ok 10 - formatPlan：逐步输出已具能力且单调增长
  ---
  duration_ms: 6.251676
  type: 'test'
  ...
# Subtest: 随机实例交叉核对：Dijkstra == 子集穷举 == 全状态松弛（300 例）
ok 11 - 随机实例交叉核对：Dijkstra == 子集穷举 == 全状态松弛（300 例）
  ---
  duration_ms: 39.851977
  type: 'test'
  ...
1..11
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 289.700156
```

## `npm start`（最优序列 + 穷举核对）

```

> plugin-planner@1.0.0 start
> tsc -p tsconfig.json && node dist/src/main.js

=== 插件规划：启用目标的最低成本序列 ===
plugins: 15 (max 18)
initial: { git, node }
target:  { release }

--- 最优启用序列（Dijkstra 状态搜索） ---
step 0 (initial): held = { git, node }
step 1: enable fetcher (cost 2) | +{ source } | held = { git, node, source }
step 2: enable linter (cost 1) | +{ lint-report } | held = { git, node, source, lint-report }
step 3: enable compiler (cost 5) | +{ ast, types } | held = { git, node, source, types, ast, lint-report }
step 4: enable fast-bundler (cost 1) | +{ bundle } | held = { git, node, source, types, ast, bundle, lint-report }
step 5: enable minifier (cost 2) | +{ min-bundle } | held = { git, node, source, types, ast, bundle, min-bundle, lint-report }
step 6: enable tester (cost 3) | +{ test-report } | held = { git, node, source, types, ast, bundle, min-bundle, test-report, lint-report }
step 7: enable packager (cost 3) | +{ package } | held = { git, node, source, types, ast, bundle, min-bundle, test-report, package, lint-report }
step 8: enable publisher (cost 2) | +{ release } | held = { git, node, release, source, types, ast, bundle, min-bundle, test-report, package, lint-report }
total cost: 19

--- 穷举核对 ---
Dijkstra 最优成本:        19
子集穷举 (2^n) 最优成本:  19
全状态松弛最优成本:       19
核对结果：三种方法一致 ✔
```
