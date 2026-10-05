# 证券交收库与 CLI

Node.js 22，仅标准库，测试使用 `node:test`。

## 用法

```
node . deliver input.json output.json
```

- 坏 JSON 或单边（方向非法）指令：退出码 1
- 余额不足：退出码 0，`output.json` 中 `status: "UNSAT"` 并附最短指令环冲突解释

## 输入格式

```json
{
  "accounts": [{"id": "A1", "cash": 10000, "securities": {"SEC1": 100}}],
  "instructions": [{"id": "B1", "side": "buy", "security": "SEC1", "price": 10, "quantity": 100}],
  "permissions": {"B1": ["A1"]},
  "cancellations": ["S2"],
  "walPath": "optional.wal"
}
```

`permissions` 为配对许可（缺省允许所有账户）；`cancellations` 触发先解冻再拆配对，随后增量重配；`walPath` 指定时先按 WAL 恢复再继续交收。

## 设计

- `lib/match.js`：传播删去不可能账户（许可外或余额/持仓不足），回溯枚举配对与交收账户（同一指令至多配对一次），UNSAT 时给出最短指令环
- `lib/ledger.js`：WAL 账本。冻结写 `pair`/`pair_done`，解冻写 `unfreeze`/`unfreeze_done`；崩溃点“配对日志已写、解冻日志未写”由 `Ledger.recover` 处理：未提交的配对回滚、未完成的解冻补齐，重放幂等不重复冻结
- `lib/engine.js`：交收引擎，`settle` / `cancel`（先解冻再拆配对）/ `rematch`（增量重配，保留既有配对）
- `index.js`：CLI 入口，导出 `main(argv)` 便于测试

## 测试

```
node --test
```
