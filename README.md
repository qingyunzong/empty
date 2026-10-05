# 风控额度并发判定（组17）

仅 Node.js 22 标准库 + `node:test`，单机离线。

## 模型

- `history.ndjson`：只追加的操作日志。操作：`{opId, account, type, amount, freezeId?, day, ts, deps[], compensates?}`，
  `type ∈ freeze|hold|release|unhold`，`deps` 声明 happens-before（同账户前驱 opId）。
- **judge**：按账户把日志建成因果 DAG，枚举线性化做贪心判定（接受/拒绝），取
  「成功冻结总额 → 成功释放总额 → 成功操作数」字典序最优的结果集；同分并列（同额并列最优）
  全部列出，按规范化签名稳定排序。实现为带记忆化的精确 DFS（`src/judge.js`），
  与暴力枚举（`src/brute.js`）在 n≤8 上对照一致。
- **repair**：对错误已提交（被接受）的操作生成补偿记录追加到日志，不改史：
  freeze→release 剩余额度；release→同额 freeze（计入新一天预算）；hold↔unhold。
  补偿记录带 `compensates` 字段，重跑/崩溃恢复保证恰好一次。

## 错误码

| code | 含义 |
|---|---|
| 10 | 释放多于冻结（RELEASE_EXCEEDS_FROZEN） |
| 11 | 负可用（NEGATIVE_AVAILABLE） |
| 12 | 重复 opId（DUPLICATE_OP_ID，按日志文件序判定首次） |
| 13 | 超出账户日冻结上限（DAILY_BUDGET_EXCEEDED，整单拒绝、无部分生效） |
| 14 | 非法依赖（INVALID_DEPENDENCY：引用缺失/被拒 freeze，或超出未释放/已持有额） |

## 用法

```sh
node cli.js append --history history.ndjson --data '{"opId":"f1","account":"acc1","type":"freeze","amount":50,"ts":1,"day":0,"deps":[]}'
node cli.js judge  --history history.ndjson --config accounts.json [--pretty]
node cli.js repair --history history.ndjson --config accounts.json --op f1 [--op f2 ...]
node --test test/*.test.js
```

`accounts.json` 形如 `{ "acc1": { "creditLimit": 1000, "dailyFreezeCap": 500 } }`。

崩溃演练（repair）：环境变量 `REPAIR_CRASH_BEFORE_WRITE=1`（写补偿前崩溃）、
`REPAIR_CRASH_MID_WRITE=1`（写入半截记录后崩溃），恢复后重跑即恰好一次。
