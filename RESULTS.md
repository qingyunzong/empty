# 实际测试记录

环境：Node.js v22.22.1，TypeScript 7.0.2（`tsc` 严格模式编译），Linux x86_64。
命令：`npm test`（= `tsc -p tsconfig.json && node --test dist/test/*.test.js`）。

## `npm test` 输出（2026-10-05 实跑）

```
# Subtest: dist/test/cert.test.js
ok 1 - dist/test/cert.test.js
# Subtest: dist/test/cli.test.js
ok 2 - dist/test/cli.test.js
# Subtest: dist/test/solver.test.js
ok 3 - dist/test/solver.test.js
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 408.01403
```

逐文件用例数：`solver.test.js` 12 通过、`cert.test.js` 8 通过、`cli.test.js` 7 通过，共 **27/27 通过，0 失败**。

## 示例实跑

`node dist/src/cli.js solve examples/app.json --verify`（9 边、含锁边/包组/预算 10/入口 main→出口 report）：

- 最优删除 `e4`(1) + `e6`(1) + `e9`(2)，总费用 **4**（≤ 预算 10）；
- 拓扑序 `main, auth, core, store, report, legacy`；
- 路径证书 `main → auth → core → store → report`；
- 枚举核对：256 个子集，最优 4，`matches: true`；分支定界仅探索 17 个节点（剪枝 8）。

`node dist/src/cli.js solve examples/locked-cycle.json`：退出码 1，输出不可删环 `x → y → z → x`。

`node dist/src/cli.js verify examples/app.json`：`subsetsChecked=256, optimalCost=4`。

## 18 边上界压力测试

10 节点 18 边（9 个双向环，费用 0–9）：分支定界探索 1449 节点，枚举全部
262144 个子集核对一致（`matches: true`），总耗时 **253ms**。
