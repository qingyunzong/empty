# 退款/额度冻结事件溯源库（组 17）

仅 Node.js 22 标准库，单机离线，无第三方依赖。

## 模型

每账户维护 `balance`（余额）与 `frozen`（冻结），不变式 `0 <= frozen <= balance`，金额为整数（分）。

| 事件 | 效果 | 前置条件 |
| --- | --- | --- |
| `sale` | `balance += amt; frozen += amt`（货款到账即冻结） | `id` 唯一 |
| `freeze` | `frozen += amt` | `balance - frozen >= amt`，否则 code=32 |
| `unfreeze` | `frozen -= amt` | `frozen >= amt`，否则 code=32 |
| `refund` | `balance -= amt; frozen -= amt`（联动解冻，同事务） | 见下 |
| `refundVoid` | `balance += amt; frozen += amt`（撤销退款） | 只能撤销该账户最近一笔未消费（未撤销）退款 |

`refund` 规则：
- 引用的 `saleId` 必须存在且属于该账户，否则 code=30（悬空引用）；
- 退款 `id` 复用、或累计有效退款（撤销的不计）超过原交易额，code=31（重复退款）；
- 联动解冻时 `frozen < amt`，code=32，整个事务回滚（余额与冻结两侧都不落盘）。

并发：对同一 `sale` 的两路 `refund` 若总额超过原交易，判冲突（code=31），不自动拆分。
`Store.commit(events, {expectedHash})` 提供乐观并发控制，基准哈希变化即返回冲突证书。

## 错误码

| code | 含义 |
| --- | --- |
| 30 | 悬空引用（未知 sale / refund） |
| 31 | 重复退款 / 超退 / 并发冲突 |
| 32 | 冻结不足（freeze/unfreeze/refund 联动解冻失败，整体回滚） |
| 33 | refundVoid 目标不是最近未消费退款 |

## 用法

```sh
node cli.js project events.jsonl            # 输出每账户 {balance, frozen}
node cli.js guard events.jsonl '<event-json>'   # 应用前验证；拒绝时退出码 1 并输出证书
node cli.js cert events.jsonl               # 输出每账户终态哈希 + 总体哈希（可离线重算）
```

库接口：`src/model.js`（`applyEvent/project/guard/certify/hashState`，纯函数），
`src/store.js`（带 WAL 日志的事务存储，`commit`/`recover`，崩溃后双侧一致回滚）。

## 测试

```sh
node --test test/*.test.js
```
