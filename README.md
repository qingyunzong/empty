# limit — 预授权额度账本与线性化判定

Node.js 22，仅标准库，测试用 `node:test`（`node --test`）。

## 模型

账户状态：`creditLimit` / `frozen` / `used`，可用额度
`available = creditLimit - frozen - used`。

| 操作 | 语义 |
| --- | --- |
| `open(acc, creditLimit)` | 开户（或用 CLI `--limit N` 隐式开户） |
| `freeze(authId, acc, amount, ttl)` | 冻结预授权；`amount > available` 报 `E_LIMIT` |
| `capture(authId, amount)` | 部分扣占，可多次；`amount > remaining` 报 `E_LIMIT`；扣完自动关闭 |
| `release(authId)` | 释放剩余冻结 |
| `extend(authId, ttl)` | `expiresAt += ttl` |
| `sweep(time)` | 定时扫描，到期未扣占的授权自动释放 |

错误码：`E_LIMIT`（超额度/超冻结余额）、`E_STATE`（非法状态迁移、未知
authId、重复 authId、非法参数）、`E_EXPIRED`（操作已到期的授权）。

## TTL 到期语义

- 事件时间 `t >= expiresAt`（即恰好 `freeze.time + ttl`）视为已到期，
  边界 `exactly ttl` 不可再 capture。
- 惰性到期：每个操作按其 `time` 先对所属账户做到期处理；`sweep(t)`
  定时扫描产生完全一致的可见状态（有测试保证）。
- 未决（open 未 capture）不视为失败；到期未 capture 自动释放剩余冻结。

## CLI

```sh
node bin/limit.js run ops.jsonl --explain --limit 1000
node bin/limit.js check log.jsonl --limit 100
```

- `run`：按文件顺序执行；首个 `E_LIMIT`/`E_STATE`/`E_EXPIRED` 即报错并
  `exit 1`（用法/IO/JSON 错误 `exit 2`）；超过 20000 操作拒绝执行。
  `--explain` 每个操作后输出一行 JSON 轨迹（结果 + 全量账户状态）。
- `check`：对并发交错日志做线性化判定。输出 `LINEARIZABLE` + 见证序列
  （`exit 0`）或 `NOT_LINEARIZABLE`（`exit 1`）。实时序约束：
  `end_i < start_j` 则 i 必须先于 j（相等时间戳视为并发）。

## 文件

- `src/limit.js` — 账本核心（`Ledger`、`LimitError`、`MAX_OPS = 20000`）
- `src/linearize.js` — 线性化判定（带回溯的拓扑排序搜索，含节点预算）
- `src/cli.js` / `bin/limit.js` — CLI 实现与入口
- `test/` — `node --test` 测试（验收 A/B/C/D）
- `examples/` — 示例 `ops.jsonl` 与 `log.jsonl`
