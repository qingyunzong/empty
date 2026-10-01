# audit-voucher

离线审计调整凭证库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 用法

```sh
node . audit input.json output.json
node --test
```

## 输入

```json
{
  "voucherNo": "ADJ-001",
  "entries": [{ "account": "1001", "direction": "debit", "amount": 500 }],
  "accountGroups": { "1001": "asset" },
  "reviewers": [{ "id": "R1", "groups": ["asset", "revenue"] }],
  "periods": [{ "id": "2026-09", "status": "closed", "adjustmentPeriod": "2026-10" }],
  "requestedPeriod": "2026-09",
  "approvalLayers": [{ "id": "L1" }, { "id": "L2" }],
  "revocations": ["L2"],
  "budget": 100
}
```

## 约束与行为

- 借贷总额必须相等，否则 UNSAT 并给出 `balance:` 冲突核心。
- 复核人只能进入授权科目组：每层审批人的权限域须覆盖凭证全部科目组（域传播）。
- 关闭期间只能改道至其开放的调整期间；无开放调整期间则 UNSAT。
- 任一层驳回后，该层及其下层预留全部释放（分层回滚），轨迹记为 `rejected`/`released`。
- 搜索预算耗尽而未定案时输出 `PENDING` 及待定凭证，不判 UNSAT；预算内枚举完毕仍无解才判 UNSAT。
- 未知科目、未知方向、未知期间或驳回不存在层级：退出码 1。

## 输出

`voucherNo`、`status`（`APPROVED`/`REJECTED`/`PENDING`/`UNSAT`）、`requestedPeriod`/`period`/`rerouted`、
`assignment`、`approvalTrail`、`occupied`/`released`（各层占用/释放金额）、`conflictCore`。
