# auditdb — 双时态稽核回溯库与 CLI

仅 Node.js 22 标准库。事件追加式写入，更正不改旧版本，删除只生成 tombstone，全程可审计。

## 事件模型

```json
{ "id": "e1", "account": "acc", "txSeq": 1,
  "validFrom": "2024-01-01T00:00:00Z", "validTo": null,
  "payload": { "amount": 100, "limit": 20 }, "supersedes": null }
```

- `validTo: null` 表示当前有效，可被后续更正（`supersedes`）或 tombstone 关闭；边界为 `validFrom` 含、`validTo` 不含。
- tombstone（删除请求）：`{ "account", "txSeq", "tombstone": true, "supersedes": "<id>" }`，只追加、可审计。
- `txSeq` 全库严格递增（事务时间）。

## 双时态过滤（关系代数）

`visible = σ_asOf ⋉̸ σ_superseded`：选择 `validFrom <= T < validTo ∧ txSeq <= N`，再与「txSeq <= N 的更正集」做反连接。旧版本从不被修改，关闭语义完全由反连接导出。

## 聚合

`sum` 忽略 NULL `amount`/`limit`；`count`（versions）计版本数。

## 索引

`AuditStore` 按账户维护版本链（`byAccount: Map<account, Event[]>`，txSeq 有序），`asOf` 只扫描该账户链，绝不全表扫（`store.stats.scanned` 可观测）。

## CLI

```
node bin/auditdb.js load f.jsonl [--db auditdb.json]
node bin/auditdb.js query acc --valid 2024-06-01T00:00:00Z --tx 2 [--db auditdb.json]
```

错误码 `E_TIME_ORDER`（validTo ≤ validFrom）、`E_TOMBSTONE`（非法删除请求）、`E_TX_SEQ`、`E_SUPERSEDES`、`E_DUP_ID`、`E_SCHEMA`，均 exit 1 并输出 `error: <CODE>: ...` 到 stderr。

## 测试

```
node --test
```

结果见 RESULTS.md。
