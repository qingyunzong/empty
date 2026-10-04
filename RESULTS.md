# 实际测试结果

环境：Node.js v22.22.1，tsc 7.0.2，npm 9.2.0（Linux x86_64）。

## npm test（默认 500 种子）

```
$ npm test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/differential.test.js
ok 1 - dist/test/differential.test.js
# Subtest: dist/test/txstate.test.js
ok 2 - dist/test/txstate.test.js
1..2
# tests 2
# pass 2
# fail 0
# duration_ms ~250
```

- `txstate.test.js`：13 个单元测试（嵌套保存点、内层回滚隔离、根提交发布、异常捕获、嵌套 capture、预算终止全撤、预算异常不被捕获、非整数拒绝）。
- `differential.test.js`：500 个种子的随机程序，TxState（撤销日志实现）与 ModelState（复制栈模型）逐轨迹比对，全部一致。

## 加大规模复跑

```
$ SEEDS=2000 npm test
# tests 2
# pass 2
# fail 0
# duration_ms ~303
```

2000 个随机程序（含有限预算触发全撤、嵌套 capture、顶层异常）全部与复制栈模型一致。

## 变异 sanity check

将 `TxState.rollback` 的撤销逻辑注释掉后重跑：`# pass 0 / # fail 2`，差分测试按预期报出分歧（已恢复源码）。
