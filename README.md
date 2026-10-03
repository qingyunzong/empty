# tx-ledger

客服可撤销转账、风控可撤销该撤销的单机离线账本库与 CLI。仅依赖 Node.js 22 标准库，测试使用 `node:test`。

## 运行

```bash
node bin/tx.js apply <cmd.json> [--state <path>]   # 应用命令到状态文件（默认 ./state.json）
node bin/tx.js verify [--state <path>]             # 校验迁移哈希链与账本不变量
npm test                                           # 等价于 node --test
```

`state.json` 不存在时自动初始化为空账本；账户通过预置 `accounts` 余额注资（如 `{"accounts":{"alice":{"available":100,"frozen":0,"locked":0}}, ...}`）。状态写回采用临时文件 + rename 的原子方式。

## 命令

所有命令为 JSON 对象，`type` 必填，`idempotencyKey` 可选：

```json
{"type":"transfer","id":"t1","from":"alice","to":"bob","amount":100,"idempotencyKey":"K1"}
{"type":"reverse","tx":"t1"}                 // amount 缺省 = 剩余可撤销额
{"type":"reverse","tx":"t1","amount":30}     // 部分撤销
{"type":"reverseReversal","tx":"t1"}
{"type":"freeze","account":"bob","amount":80}
{"type":"unfreeze","account":"bob","amount":50}
```

## 状态机

```
PENDING -> POSTED -> REVERSED -> RESTORED
```

- `transfer` 创建交易并即时过账（迁移记录 `PENDING -> POSTED`）。
- 仅 `POSTED` 可 `reverse`；仅 `REVERSED` 可 `reverseReversal`；`RESTORED` 为终态，任何再操作 exit15。
- 部分撤销 `amount <= 原额 - 已撤销额`，剩余部分保持 `POSTED`，可继续撤销；累计撤销满额后进入 `REVERSED`。
- `reverseReversal` 恢复全部已撤销额，进入终态 `RESTORED`。

## 资金与冻结语义

账户为 `{available, frozen, locked}`，恒满足 `available >= 0`、`frozen >= locked >= 0`。

- `freeze` 优先占用可用额：`available -= n; frozen += n`。
- `unfreeze` 只释放 `frozen - locked` 的部分；已被撤销补偿锁定的份额不可释放。
- `reverse` 从收款方（tx.to）回收资金：先扣 `available`，不足部分将其 `frozen` 中的等额份额标记为撤销补偿锁定（`locked += 缺口`），付款方（tx.from）按全额入账。可回收上限为 `available + (frozen - locked)`，超出即 exit16，绝不透支。
- `reverseReversal` 由付款方全额退回（不足则 exit16），收款方拿回可用部分并解除对应锁定份额。整个 撤销→恢复 周期内各方资金守恒。

## 迁移记录与审计

每次资金/状态迁移追加一条记录：`{id, seq, prevHash, command, from, to, amount, reason, fromStatus, toStatus, hash}`。`hash = sha256(规范化JSON(记录除hash外全部字段))`，`prevHash` 链至上一条记录（首条为 `GENESIS`），篡改任意历史记录都会被 `tx verify` 发现。

## 幂等

带 `idempotencyKey` 的命令其结果（成功或领域错误）记入 `state.processed`；重复提交同一 key 直接返回原结果（`replayed: true`），状态不二次变更。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功（含幂等重放成功结果） |
| 1  | 用法/IO/JSON 结构错误 |
| 15 | 非法迁移（状态机违例、交易不存在/重复、终态再操作） |
| 16 | 金额越界（amount<=0、超剩余额、余额不足、会透支） |
| 17 | 未知命令类型 |

## 测试

- `test/acceptance.test.js`：全额撤销再恢复、部分撤销边界（amount=0/超额）、终态再操作失败、冻结与撤销交织不透支、幂等重放、未知命令、金额越界。
- `test/cli.test.js`：CLI 退出码 0/1/15/16/17、状态持久化、`--state`、`verify`、幂等重放。
- `test/enumeration.test.js`：对 n<=6 的操作序列做穷举（15 个命令模板、BFS + 状态去重），每个迁移都用独立 oracle 对照库结果，并校验不变量与哈希链；失败命令不得改动资金核心，未决迁移不被当作不可满足（所有命令在每个状态上都会尝试）。

### 真实测试结果（2026-10-04，Node v22.22.1）

```
$ node --test
ok 1 - test/acceptance.test.js    # 9 个子测试全部通过
ok 2 - test/cli.test.js           # 6 个子测试全部通过
ok 3 - test/enumeration.test.js   # 1 个子测试通过
# tests 3
# pass 3
# fail 0
```

枚举测试实测输出：`enumerated depth<=6: 4380 transitions, 1709 applied, 563 unique cores, exits {"0":1709,"15":1668,"16":711,"17":292}` —— 4380 个迁移的退出码全部与独立 oracle 一致，所有到达状态均通过不变量与哈希链校验。
