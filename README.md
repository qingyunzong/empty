# tx-ledger

可撤销转账账本：客服可撤销（reverse），风控可撤销该撤销（reverseReversal），
并保证资金、冻结与审计哈希链因果一致。Node.js 22，仅标准库，测试用 `node:test`，单机离线。

## 用法

```sh
node bin/tx.js apply <cmd.json> [--state state.json]   # 应用一条命令（state.json 缺省时自动初始化）
node bin/tx.js verify [--state state.json]             # 校验审计哈希链与余额不变量
npm test                                               # node --test 全量
```

命令（JSON）：`transfer`、`reverse`、`reverseReversal`、`freeze`、`unfreeze`，均可带
`idempotencyKey` 与 `reason`。

```json
{"type":"transfer","id":"t1","from":"A","to":"B","amount":200,"idempotencyKey":"k1"}
{"type":"reverse","txId":"t1","amount":50}
{"type":"reverseReversal","txId":"t1"}
{"type":"freeze","account":"B","amount":100,"reason":"reversal-compensation"}
{"type":"unfreeze","account":"B","amount":40}
```

## 状态机

`PENDING -> POSTED -> REVERSED -> RESTORED`

- `transfer` 创建交易并落账（记录迁移 `PENDING->POSTED`）。
- 仅 `POSTED` 可 `reverse`；`reverse` 可带 `amount <= 剩余可撤额`，部分撤销后剩余保持
  `POSTED`，累计撤满才迁移到 `REVERSED`。
- 仅 `REVERSED` 可 `reverseReversal`，迁移到 `RESTORED`。
- `RESTORED` 为终态：再 `reverse` / `reverseReversal` 一律 exit 15。

## 资金与冻结语义

- 账户余额：`available`、`frozen`、`frozenLocked`（撤销补偿锁定份额，`frozenLocked <= frozen`）。
- 扣款顺序：`available` -> 未锁定 `frozen` -> 锁定 `frozenLocked`，任何情况下不透支（不为负）。
- `freeze` 只占用 `available`；`reason="reversal-compensation"`（或 `locked:true`）的冻结计入
  `frozenLocked`。
- `unfreeze` 最多释放 `frozen - frozenLocked`，不得释放已被撤销补偿锁定的份额。
- `reverseReversal` 按原撤销的结算构成精确回补（available/frozen/locked 各归其位）。
- 全程资金守恒：`sum(available + frozen)` 不变。

## 审计

每次迁移写一条记录 `{seq, id, from, to, amount, reason, hash}`，`hash` 为
`sha256(prevHash + "\n" + canonicalJSON)` 的链式哈希，创世为 64 个 `0`。
`tx verify` 重放整条链并检查余额不变量。

## 幂等

相同 `idempotencyKey` 的命令（无论成功或失败）只应用一次；重复提交返回原结果并带
`replayed: true`，不重复记账。失败命令的幂等记录同样持久化。

## 退出码

| code | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 用法/IO 错误 |
| 15 | 非法迁移（状态机不允许、交易不存在或已存在、终态再操作） |
| 16 | 金额越界（amount<=0、超额、余额/可释放额不足） |
| 17 | 未知命令类型 |

## 测试

- `test/machine.test.js`：全额撤销再恢复；部分撤销边界（amount=0/超额/累计撤满）；
  终态再操作失败；冻结与撤销交织不透支；锁定份额保护；恢复精确回补；幂等；哈希链防篡改。
- `test/cli.test.js`：CLI 退出码 0/15/16/17、状态文件持久化、幂等重放、`verify`。
- `test/enumeration.test.js`：对 6 个操作组成的字母表枚举全部长度 n<=6 的序列
  （共 55,986 条、324,726 步），逐步对照独立 oracle 实现的退出码与账户/交易状态，
  并检查资金守恒与哈希链完整。失败命令不剪枝（未决迁移不当作不可满足），序列继续执行。

真实结果（`node --test`，Node v22.22.1）：

```
✔ test/cli.test.js (1794ms)
✔ test/enumeration.test.js (42449ms)
✔ test/machine.test.js (1762ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
ℹ duration_ms 43026
```

共 14 个断言测试全部通过（machine 9、cli 4、enumeration 1）。
