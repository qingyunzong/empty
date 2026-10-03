# 结算审计日志（追加式更正）

仅 Node.js 22 标准库，单机离线。结算审计日志不可改写，上游补发更正时以
追加式更正（supersedes）保持旧证据可验，同时让当前视图正确。

## 机制

- **链式结构**：每条 entry 为 `{seq, prevHash, op, supersedes, businessTime, logTime, hash}`，
  JSONL 追加写入 `ledger.log`；`hash` 为对规范化 entry 的 HMAC-SHA256（签名式哈希，
  密钥在 `ledger.log.key`，首次写入时生成，0600 权限）。
- **更正**：`supersedes` 只能指向已存在的 entry，且 `bizKey` 必须与目标一致；
  不能更正 tombstone。链上删除用 `op.type = "tombstone"`。
- **生效规则**：同一业务键（bizKey）下，被更正的 entry 退出候选；剩余头部中
  业务时间（businessTime）最新者生效。多个头部业务时间相同（并发同业务键）时，
  该键不计入余额，输出冲突证书（candidates 含 seq/hash/op）等待人工裁决。
- **时间窗**：`logTime` 单调不减；`businessTime` 必须落在 `logTime ± 7 天` 内。
- **校验**：`verify` 重算全链哈希、prevHash 链接、时间窗与 supersedes 合法性；
  失败不截断日志，报告首个坏 entry 的序号与字节偏移，退出码 4。
- **崩溃恢复**：index（`ledger.log.idx`）在 log 之后写入。任何命令运行前先
  `recover`：丢弃超出 log 末尾的悬空索引行；log 比 index 长则重建索引。
  log 本身永不被修改。
- **证明**：`proof` 输出账户的全部链上路径（seq/offset/hash）与更正祖先闭包，
  以链尖锚定；`verify-proof` 独立重算全链并校验证明，失败退出码 5。

## 命令

```sh
node cli.js log --log ledger.log --op '{"type":"credit","account":"a","amount":100,"bizKey":"k1"}' \
    [--business-time MS] [--log-time MS] [--supersedes SEQ]
node cli.js verify --log ledger.log          # 退出码 0 正常 / 4 链损坏
node cli.js view --log ledger.log [--account a]
node cli.js proof --log ledger.log --account a --out proof.json
node cli.js verify-proof --log ledger.log --proof proof.json   # 退出码 0 / 5
```

op 类型：`credit` / `debit`（需 account、bizKey、正数 amount）、`tombstone`
（需 account、bizKey、supersedes）。

## 测试

```sh
node --test test/*.test.js
```

- `test/ledger.test.js`：链校验、更正规则、冲突证书、tombstone、时间窗、
  篡改定位（退出码 4 + offset）、崩溃恢复、proof/verify-proof、CLI 端到端。
- `test/scale.test.js`：3 万条、5% 更正，5000 个业务键（≤15 条/键）的全部
  合法应用序枚举与 `view` 对照，余额逐一比对。

真实输出见 `RESULTS.md`。
