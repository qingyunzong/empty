# audit-ledger

防篡改金融凭证账本：哈希链 + 依赖图，支持动态拓扑（补录插入中间）、差分余额维护、
失效级联传播与确定性重算。Node.js 22，仅标准库，单机离线。

## 模型

- **哈希链（仅追加）**：每张凭证提交 `prevHash`（追加序）与自身规范内容
  （id、分录、依赖、pos、lamport、ref、basis），任何历史篡改都会断链。
- **依赖图**：凭证依赖 = 显式 `deps` + 科目余额基址（`basis`，创建时记录的每科目
  最后一张有效凭证哈希）+ 汇率快照（分录级 `snapshot`）。
- **重放顺序**：`(pos, lamport, id)`。`lamport = 1 + max(依赖的 lamport)`；
  并列 Lamport 时间戳按 id 字典序决胜。`pos` 默认
  `max(lamport, 依赖的最大 pos + 1)`，补录可显式指定（如 `3.5`）插入中间。
- **失效传播**（确定性派生，不改旧账）：
  1. 显式依赖的凭证失效 → 级联失效；
  2. 重放时科目基址与创建时记录的 `basis` 不一致 → 失效（补录插入的效果）；
  3. 冲销：反向凭证 `R` 冲销 `T` 后，所有在 `R` 之前创建且 `basis` 引用 `T` 的
     凭证标记失效（失效区间 `[T, R]`），原始凭证保留在链上，仅被排除出有效集。
- **差分维护**：每个重放位置保存余额/基址检查点；纯追加 O(1)，结构性变更
  （中间插入、冲销）仅从最早受影响索引重算。
- **根哈希**：有效凭证哈希（重放序）的 Merkle 根；证明路径 = Merkle 兄弟路径。
- **快照**：`entry.currency` 必须配 `entry.snapshot`；快照缺失报
  `MISSING_SNAPSHOT`（未决依赖如实报告，绝不当作不可满足）。快照幂等，
  同 id 不同值报 `SNAPSHOT_CONFLICT`。

## 错误码（stderr JSON，退出码 3）

`MISSING_SNAPSHOT`、`MISSING_DEPENDENCY`、`DUPLICATE_ID`、`ALREADY_REVERTED`、
`INVALID_TARGET`、`SNAPSHOT_CONFLICT`、`BROKEN_CHAIN`、`VOUCHER_NOT_FOUND`、
`BAD_INPUT`、`BAD_JSON`、`VERIFY_FAILED`。

## CLI

```bash
node src/cli.js [--state DIR] [input.jsonl]   # 无 input.jsonl 时读 stdin
```

输入 JSONL，每行一个 op：

```json
{"op":"snapshot","id":"fx1","pair":"USD/CNY","rate":7.1}
{"op":"voucher","id":"v1","entries":[{"account":"cash","amount":100},{"account":"rev","amount":-100}]}
{"op":"voucher","id":"v2","entries":[{"account":"cash","amount":5,"currency":"USD","snapshot":"fx1"}],"deps":["v1"]}
{"op":"voucher","id":"bx","entries":[{"account":"cash","amount":7}],"pos":1.5}
{"op":"reverse","id":"r1","target":"v1"}
{"op":"proof","id":"v2"}
{"op":"root"}
{"op":"verify","cert":"/path/cert.json"}
{"op":"certificate","file":"/path/cert.json"}
{"op":"recover"}
```

每个 op 输出一行 JSON：`step`、`root`（该步根哈希）、`invalid`（当前失效集）、
`proof`（Merkle 证明路径）等。`--state DIR` 将操作追加持久化到
`DIR/log.jsonl`，重启自动重放并校验链完整性；断链时变更类 op 拒绝执行
（`BROKEN_CHAIN`），`recover` 重算哈希并修复日志。

证书写入崩溃安全：先写 `cert.json.tmp` + fsync，再 rename；崩溃残留 tmp 时
`verify` 报 `certificate:"incomplete"`，重写证书自动恢复（`recovered:true`）。
可用 `LEDGER_CRASH_AFTER=tmp` 模拟写证书中途崩溃。

## 测试

```bash
node --test
```

- `test/cascade.test.js` — 中间插入引发级联失效、确定性重算、更正重录
- `test/chain.test.js` — 断链检测（哈希/内容篡改定位）与恢复
- `test/bruteforce.test.js` — 随机小账本与独立暴力参考实现全量对照
  （root、失效集、余额、证明路径）
- `test/crash.test.js` — 写证书中途崩溃后重启校验与恢复（库级 + CLI 级）
- `test/cli.test.js` — CLI 端到端：JSONL 输入、每步输出、错误码与退出码 3
- `test/ledger.test.js` — Lamport 并发排序、快照缺失、冲销区间等单元测试
