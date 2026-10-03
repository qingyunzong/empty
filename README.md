# 追加式更正结算审计日志（组 17）

仅使用 Node.js 22 标准库与 `node:test`，单机离线运行。

## 机制

- **追加式日志**：`ledger.log` 为 NDJSON，每行一个 entry：
  `{v, seq, prevHash, ts, bizTime, op, hash}`，
  `op = {type: post|correct|tombstone, account, bizKey, amount?, supersedes?}`。
- **签名式哈希**：`hash = HMAC-SHA256(key, canonical(body))`，密钥在
  `ledger.log.key`（首次创建时生成，0600）。`prevHash` 构成哈希链。
- **更正**：`correct`/`tombstone` 的 `supersedes` 必须指向已存在 entry；
  删除用 `tombstone`，旧证据全部保留在链上。
- **生效规则**：同一业务键（supersedes 树的根）下，业务时间 `bizTime`
  最大者生效；平局时后代优先于祖先、再按 seq 小者胜。并发的同业务键
  更正（bizTime 相同的不可比分支）在视图中保留**冲突证书**。
- **校验**：`verify` 检查链式 prevHash、HMAC、seq 连续性、时间窗
  （ts 单调、不超未来偏移、bizTime 不晚于写入时间）、op 形态与
  supersedes 存在性。失败时报告**首个**坏 entry 的 `seq` 与字节
  `offset`，退出码 4，绝不截断日志。
- **崩溃恢复**：打开时调和 `ledger.log.index` 与日志——索引指向日志
  末尾之外的悬空行（先写索引后写日志的崩溃）被丢弃；日志尾部未索引
  的行被重建索引。
- **证明**：`proof` 输出账户的全部 entry、哈希链路径（seq→hash）、
  更正祖先链与账户视图；`verify-proof` 用密钥独立重算哈希、链包含
  关系、祖先链与视图，可选与活日志头交叉核对。

## 命令

```
node cli.js log          --file L [--type post|correct|tombstone] --account A \
                         [--amount N] [--biz-key K] [--supersedes H] [--ts MS] [--biz-time MS]
node cli.js verify       --file L                # 退出码 0=通过, 4=首个坏 entry
node cli.js view         --file L [--account A]
node cli.js proof        --file L --account A [--out proof.json]
node cli.js verify-proof --proof proof.json [--file L | --key KEYFILE]
```

## 测试

```
node --test test/*.test.js
```

真实输出见 [RESULTS.md](RESULTS.md)。
