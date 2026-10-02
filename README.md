# hash-ledger

单机离线、仅 Node.js 22 标准库的哈希链交易账本：库（`src/ledger.js`）+ CLI（`bin/ledger.js`）。

## 数据模型

- 交易字段：`id, parent, amount, account, kind(NORMAL|REVERSAL), payloadHash`。
- 每笔交易以其规范 JSON（键序固定）的 SHA-256 为链哈希，存入 `txs/<hash>.json`；
  `parent` 指向前一笔交易的哈希（创世为 `null`），`HEAD` 文件记录链尖。
- `PUBLISHED` 文件记录已锚定（已发布）前缀的锚点哈希；锚点及其祖先不可改写。
- 金额以 6 位小数微单位精确运算。

## 命令

```sh
ledger [--dir <path>] init
ledger [--dir <path>] append <tx.json>     # 校验 parent 与当前 HEAD 一致（缺省自动填充）
ledger [--dir <path>] reverse <txId>       # 只追加补偿交易 REV-<txId>，不改历史
ledger [--dir <path>] rewrite --keep-published <anchorHash>
ledger [--dir <path>] verify               # 校验哈希链并输出每账户净额
```

## reverse 语义

- 只生成补偿交易：`id=REV-<txId>`、`amount` 取反、`account` 相同、
  `payloadHash=sha256("reversal-of:<txId>")`，追加到链尖。
- 重复反转同一交易、或对 REVERSAL 再反转：exit 4。
- 已发布交易也可被冲正（补偿 entry 是撤销已发布历史的唯一手段），但锚点及其祖先本身绝不被修改。

## rewrite 语义

- `--keep-published <anchorHash>`：锚点必须存在于链上（否则 exit 3）；
  锚点不得早于已发布锚点，否则破坏已发布前缀，exit 5。成功后 `PUBLISHED` 前移（只进不退）。
- 锚点之后（未发布）后缀的重写规则：
  - 所有 REVERSAL 必须保留，且保持原有相对先后（因果序）；
  - 被后缀内冲正指向的 NORMAL 一律丢弃（冲正留作审计痕迹，通过 payloadHash 绑定原 id）；
  - 其余"自由" NORMAL 可重排/丢弃，但每个账户保留子集之和必须等于
    后缀全部 NORMAL 之和（即重写前后每账户总量不变）；
  - 在所有满足约束的方案中取保留笔数最少者，并列时优先保留较早交易（确定性输出）。
- 无法满足总量不变：exit 2（`UNSATISFIABLE`），链保持不变。

## 错误约定

stderr 输出单行 JSON：`{"error":{"code","message"}}`。

| exit | code | 含义 |
|------|------|------|
| 2 | `UNSATISFIABLE` | 重写无法保持每账户总量不变 |
| 3 | `ANCHOR_NOT_FOUND` | 锚点不在链上 |
| 4 | `DUPLICATE_REVERSAL` / `REVERSAL_CONFLICT` | 重复反转 / 反转冲正 |
| 5 | `PUBLISHED_VIOLATION` | 重写将破坏已发布哈希前缀 |
| 1 | 其他（`PARENT_MISMATCH`、`CHAIN_CORRUPT`、`INVALID_TX` 等） | 通用错误 |

## 崩溃安全

提交顺序：先写交易文件（tmp + fsync + rename），再写 `PUBLISHED`，最后写 `HEAD`
（`HEAD` 的 rename 是提交点）。`HEAD` 未更新前崩溃，旧链完整；更新后崩溃，新链完整；
交易文件按内容寻址且不可变，不会产生半链。启动时清理残留的 `*.tmp-*` 文件。

故障注入（测试用）：环境变量 `LEDGER_FAULT=tmp-write|rename|head-update`
分别在写 tmp 文件、rename、更新 HEAD 三处模拟宕机（exit 99）。

## 测试

```sh
node --test
```

包含：正常撤销恢复余额、已锚定祖先拒绝（exit 5）、锚点不存在（exit 3）、
重复反转（exit 4）、三处故障注入后 verify 一致、以及对 n≤7 未发布交易
枚举所有保留/重排组合对照账户净额与 REVERSAL 因果序的性质测试。
