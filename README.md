# CNC 离线进给规划库与 CLI

单机离线、零依赖的 Node.js 22 进给规划器。每段速度为有理系数多项式
`v(t)`（次数 <= 5），时间窗为有理区间 `[a, b]`；位置增量由精确反导数
（BigInt 有理数运算）计算，并在固定有理时隙边界 `n * slot` 上按
`10^-k` 量化（四舍五入、半值向上，即向 +inf 取半）。

## 结构

- `src/rational.js` — 基于 BigInt 的精确有理数（解析、四则、floor、比较）
- `src/poly.js` — 有理系数多项式：反导数/定积分、Yun 无平方分解、
  Sturm 序列开区间根计数、闭区间负速度精确判定
- `src/planner.js` — `FeedPlanner`：事务编辑、量化、误差界、undo/redo、证书
- `cli.js` — stdin 读 JSON，stdout 输出单行 JSON
- `test/` — node:test 测试套件

## 误差模型

- 每个时隙：精确积分 `exact`，量化值 `quantized`，严格误差界
  `-u/2 < err <= u/2`（`u = 10^-k`，半值向上）
- 每段累计绝对误差 `sum |err_i|` 必须 `<= segmentTolerance`（等于也算通过）
- 跨段累计绝对误差必须 `<= totalTolerance`
- 违反时返回 `E_TOLERANCE`，事务整体回滚，不生成任何轨迹

## 事务与历史

`beginEdit` / `addSegment` / `setParams` / `commit` / `rollback`。
任一段出现负速度（`E_NEGATIVE_VELOCITY`）、`a >= b`
（`E_INVALID_INTERVAL`）、次数 > 5（`E_DEGREE`）或量化参数非法
（`E_INVALID_QUANTUM` / `E_INVALID_PARAMS`）时整体回滚，已提交状态不变。
提交历史支持 `undo()` / `redo()`；撤销后证书完全恢复。

## CLI 协议

stdin 为 JSON：`{"commands": [...]}`（或单个命令对象）。命令：
`init`、`beginEdit`、`addSegment`、`setParams`、`edit`（原子事务便捷操作）、
`commit`、`rollback`、`undo`、`redo`、`certificate`。
stdout 为单行 JSON：`{"ok": bool, "results": [...]}`；输入无法解析时
退出码为 1 并返回 `E_PARSE`。

```sh
echo '{"commands":[{"op":"init","quantumExp":2,"slot":"1/2","segmentTolerance":"1/10","totalTolerance":"1/2"},{"op":"edit","segments":[{"coeffs":["1","1/2"],"a":"0","b":"1"}]}]}' | node cli.js
```

有理数在 JSON 中以字符串表示（`"3/20"`、`"2"`、`"0.15"`），证书中的
有理数同样以约分后的字符串输出。

## 测试

```sh
node --test
```
