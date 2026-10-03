# night-qc

天文夜间观测的增量质控库及 CLI。Node.js 22，仅标准库，全程离线。

## 运行

```sh
node src/cli.js < req.json        # 见 examples/req.json
node --test                       # 运行全部测试
```

## 数据模型

- **帧 frame**：`{ id, night, instrument, signal }`，按夜晚与仪器分组。
- **标定 calibration**：每台仪器 `{ dark, flat }`（暗场 / 平场修正系数）。
- **天气 weather**：每夜 `{ status: clear|degraded|blocked, attenuation }`，缺省视为 `{ clear, 1 }`。
- **分数**：`score = (signal - dark) * flat * attenuation`。
- **标志**（边界精确定义）：
  - `blocked`：dark/flat 标定缺失，或当夜天气为 `blocked`；
  - `degraded`：`score < threshold`（严格小于；`score === threshold` 判 `usable`）；
  - `usable`：其余情况。
- **夜晚汇总**：`{ night, total, usable, degraded, blocked, status }`，
  `status` 取 `blocked > degraded > usable` 中最高严重度；无帧的夜没有汇总节点。

## 依赖图与增量传播

依赖边：标定（仪器）→ 帧；天气（夜）→ 帧；帧 → 所在夜汇总。
标定更正、天气变更、帧重新分组（`regroup`）会使相应节点失效，
引擎沿依赖图仅重算受影响的帧与夜晚汇总。

每个事务输出：

- `diffs`：标志/汇总差分（`from`/`to`，新增为 `from: null`，删除为 `to: null`）；
- `queue`：重算队列，即值发生变化的节点；帧层按 `(night, frameId)` 排序，汇总层按 `night` 排序，帧层在前；
- `certificate`：`sha256:` 前缀的内容寻址证书，覆盖 `{v, tx, op, queue, diffs, state}` 的规范化 JSON；
- `stateHash`：事务后派生状态（全部标志 + 汇总）的 sha256。

## 事务与预算

请求格式：`{ config, state, transactions: [{ op, budget }] }`。
`budget` 限制单事务内重算的派生节点数（帧 + 汇总）。超过即返回
`{ ok: false, error: "E_BUDGET", required, budget }` 并整体回滚，状态保持事务前不变。
非法操作返回 `E_INVALID`，同样不改变状态。

操作类型：`addFrame`、`removeFrame`、`regroup`（改 night/instrument）、
`setCalibration`（更正，可置 `null` 移除分量）、`removeCalibration`、`setWeather`。

## 代码结构

- `src/qc.js`：纯质控规则（分数、标志、汇总、全量派生）。
- `src/engine.js`：增量引擎（失效传播、预算、回滚、证书）。
- `src/reference.js`：全量枚举质控参考实现，用于对拍验证。
- `src/cli.js`：stdin → stdout 的命令行入口。
- `test/`：node:test 测试（对拍、重新分组隔离、边界、CLI、证书）。
