# budget-ledger

离线预算结算库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 语义

- 每个预算类别有周期上限（`setBudget`）。
- 结算单写入后占用金额，`cancel` 撤销后释放金额。
- 普通键：快照隔离 + 首提交者胜（写-写冲突返回 `E_CONFLICT`）。
- 谓词冲突检查：事务依据某类别预算余额决定插入/撤销，若快照之后该类别
  已有他人提交的结算/撤销，提交时返回 `E_PRED_CONFLICT`，可在新快照上重试。
- 提交时重新校验类别合计，超限返回 `E_BUDGET`。
- 维护 `(category, status)` 二级索引；`usedByCategoryScan` 为全表 sum 参考算法，
  测试断言二者一致。

## CLI

```sh
node cli.js setbudget --category food --cap 100 [--db FILE]
node cli.js settle --category food --amount 60 [--db FILE]
node cli.js cancel --id 1 [--db FILE]
node cli.js available food [--db FILE]
```

成功时 stdout 输出 JSON 且退出码为 0；失败时 stderr 输出
`{"error":{"code","message"}}` 且退出码非零。数据库文件默认为 `./budget.json`，
也可用环境变量 `BUDGET_DB` 指定。

## 测试

```sh
node --test   # 结果已保存于 result.txt
```
