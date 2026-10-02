# budget-freeze-settle

预算冻结与批量结算分块选择库及 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 模型

- 账户：`{ budget, frozen, used }`，可用预算 = `budget - used - frozen`。
- 支付状态机：`queued -> frozen -> settled -> refunded`，另可 `cancelled`。
- 冻结只影响可用预算（`frozen`），`used` 仅由 settle/refund 改变。
- 同一支付 ID 重复 `enqueue`（账户与金额一致）为幂等空操作；数据冲突为用法错误。
- 撤销（cancel）排队/冻结支付立即释放其冻结；已结算支付不能撤销，只能
  `refund` 生成反向块并恢复预算，反向块通过 `refHash` 引用原结算块哈希。

## 选择算法

`settle` 时：已冻结支付已被其冻结额覆盖，自动入选；排队支付在每账户可用
预算约束下竞争。目标为可全额结算的**最大数量**集合；数量并列时选择支付
ID 字典序最小的集合（`src/selection.js`）。测试中以独立的全子集枚举
（n <= 12）对照验证，重点覆盖同数量、同金额的并列场景。

## 块链存储

数据目录（默认 `./.budget`，可用 `--dir` 或 `BUDGET_DIR` 覆盖）：

- `state.json`：账户与支付状态（临时文件 + rename 原子写入）。
- `batches.log`：块序列，每块为 `[len(4)][body JSON][crc32(body)(4)]`，
  块哈希 = 整条记录的 SHA-256；body 含批次号 `seq`、`prevHash`、类型
  （`settle`/`refund`）、入选增量 `selected`、落选项 `rejected`。
- `batches.idx`：JSONL 索引（`seq/offset/length/hash`）。

写序：先落状态，再写块体，最后补索引。崩溃若发生在块体已写、索引未更新
之间，`recover` 校验后承认该批次并补索引；若 CRC 失败，该批次及后续链上
批次保持不可用，已确认前缀的预算不变。`decodeNext` 支持增量解码下一批。

## CLI

```
node cli.js <command> [args] [--dir <path>]

account <id> <budget>      创建账户（幂等）
enqueue <account> <payment> <amount>
freeze <payment>
cancel <payment>
settle
refund <payment>
batch                      列出已索引批次
batch <n>                  经索引解码第 n 批
batch next                 增量解码已索引批次之后的下一批
verify                     校验块体 CRC、哈希链与索引一致性
recover                    承认有效未索引批次；坏尾保持不可用
status                     输出当前状态
```

退出码：`0` 成功，`1` 业务/链失败（预算不足、状态非法、链损坏等），
`2` 用法错误（参数缺失、金额非法、幂等冲突等）。

## 测试

```
node --test > result.txt 2>&1; echo $? >> result.txt
```
