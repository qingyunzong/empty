# RESULTS

- 环境：Node.js v22.22.1，仅标准库，单机离线
- 命令：`node --test`
- 时间（UTC）：2026-10-02T13:42Z
- 结果：**5/5 测试文件通过，16/16 子测试通过，0 失败**

## 真实运行输出（`node --test` 末尾摘要）

```
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3273.434171
```

## 各文件明细（`node --test --test-reporter=spec`）

```
✔ test/cip-rebind.test.js
✔ test/cli.test.js
✔ test/density.test.js
✔ test/enumerate.test.js
✔ test/lab-retract.test.js
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

## 子测试计数（逐文件 `node <file>`）

| 文件 | 子测试 | 通过 | 验收点 |
| --- | --- | --- | --- |
| test/lab-retract.test.js | 4 | 4 | 1) lab 撤回安全回滚（RELEASE→HOLD + comp.jsonl，迟到 lab 可再放行） |
| test/cip-rebind.test.js | 4 | 4 | 2) CIP 撤回使跨清洗边界 fill 重新归属；未决 ≠ 不可满足 |
| test/enumerate.test.js | 1 | 1 | 3) ≤6 事件全枚举 1956 条序列对照参考状态机 + 单调/补偿不变量 |
| test/density.test.js | 4 | 4 | 4) 重量体积矛盾 REJECT 不被 lab 翻转；vol<=0 报 VOL_INVALID |
| test/cli.test.js | 3 | 3 | CLI 端到端：batches/transitions/comp/late 四个输出 |

枚举测试说明：从 6 事件池（ok CIP、正常 fill、密度异常 fill、lab pass、
撤回 CIP、撤回 lab）枚举全部长度 1..6 的无重复序列共 1956 条，逐条断言
最终状态与独立参考状态机一致、版本号单调递增、无 REJECT 出边、
每次 RELEASE→HOLD 都有对应补偿记录。
