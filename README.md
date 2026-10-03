# recon — 财务对账差异簇引擎

内部流水（internal ledger）与银行回单（external receipt）的增量对账库与 CLI。
Node.js 22，仅标准库，单机离线。

## 模型

二分依赖图：内部行 ↔ 外部行（时间窗内互为候选边）→ 匹配（全序贪心 + 子集和分组）
→ 差异簇（连通分量，内容哈希稳定簇 ID）→ 调整建议。

- 匹配冲突全序：金额差 → 时间差 → 内部 ID → 外部 ID，确定性。
- 规则版本：`v1`（容差 0、24h 窗、拒绝一对多）、`v2`（容差 5 元、72h 窗、允许一对多分组）。
  规则切换级联重算：失效匹配释放行并传播到同簇。
- 撤销外部回单：释放内部行，历史匹配保留在 `history`（`REVOKED_MATCH`）。
- 待人工项状态为 `UNRESOLVED`（含 `ONE_TO_MANY_REJECTED` / `MATCH_CONFLICT` 原因），
  永不视为不可满足。

## 运行

```sh
node --test                                   # 全部测试
node bin/recon.js [--rules v1|v2] [--state DIR] [events.jsonl]   # 缺省读 stdin
```

输入 JSONL 事件：

```json
{"type":"internal","id":"I1","amount":60,"ts":"2026-01-01T10:00:00Z"}
{"type":"external","id":"E1","amount":100,"ts":"2026-01-01T12:00:00Z"}
{"type":"revoke","id":"E1"}
{"type":"correct","id":"E1","amount":99.5,"side":"external"}
{"type":"rule","version":"v2"}
{"type":"emit"}
```

输出 JSONL：`cluster`（差异簇，含成员状态/原因/建议）、`suggestion`、
末尾一条 `certificate`（事件+规则+簇+建议的 sha256 证书）。
错误写 stderr，退出码 9。

## 持久化与崩溃恢复

`--state DIR` 下：`journal.jsonl`（逐事件追加）、`snapshot.json`（原子写）、
`clusters.json`（派生簇索引，故障点）、`manifest.json`（代际校验）。
簇索引写中途崩溃留下部分 `.tmp`：重启时 manifest 代际不符 → 从快照+日志确定性重建，
簇 ID 为成员内容哈希，不会重复。

## 布局

- `src/rules.js` 规则版本注册表
- `src/matcher.js` 候选边、全序、贪心匹配、子集和分组
- `src/clusters.js` 簇构建、稳定簇 ID、建议生成
- `src/engine.js` 增量引擎（脏集传播、失效级联、历史）
- `src/persist.js` 日志/快照/原子写/恢复
- `src/certificate.js` 确定性证书
- `src/cli.js` + `bin/recon.js` CLI
- `test/` 验收测试；`test-support/` 暴力枚举对照实现
