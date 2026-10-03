# budget-mvcc

单机离线的预算扣减实验平台存储引擎：MVCC 事务存储 + WAL 持久化 + CLI。
仅使用 Node.js 标准库（Node 22），测试基于 `node:test`。

## 核心语义

- **快照隔离读**：事务 `begin()` 时捕获快照版本，事务内所有读（余额、占用记录）
  都作用于该快照，不受并发提交影响。账户余额与占用记录均为多版本存储。
- **写集冲突检测**：写事务提交时，若其写集（被扣减账户）中任一账户在快照之后
  产生过新的已提交版本，则提交失败并返回 `CONFLICT`（可重试）。
- **预算扣减 = 条件写**：事务内通过 `tx.debit(id, amount, usage)` 声明扣减量与
  资源占用记录；提交时基于最新已提交余额校验 `balance - amount >= 0`，
  否则整个事务返回 `BUDGET_EXCEEDED`，无任何部分生效。
- **串行化提交**：所有提交经 promise 链锁串行执行，并发扣同一账户按串行结果
  判定，不允许透支。
- **同生同灭**：一个事务的余额变更与占用记录写入**同一个 WAL 帧**，单次
  append + fsync 落盘，崩溃恢复时同有或同无。

## WAL 与崩溃恢复

帧格式：`[4B 长度][JSON payload][4B CRC32(payload)]`。

- 账户创建（`create`）与事务提交（`commit`）各占一帧；`commit` 帧同时携带
  全部扣减后的余额与全部占用记录。
- 恢复时顺序扫描帧，遇到长度越界或 CRC 不匹配（撕裂写尾部）即停止，
  并将文件截断到最后一个完好帧，保证后续追加不受影响。
- 恢复后重放所有完好帧，余额与占用记录严格对应。

## CLI

```
node cli.js create-account --db DIR --id ID --balance N
node cli.js debit          --db DIR --id ID --amount N [--resource R] [--units N]
node cli.js balance        --db DIR --id ID
node cli.js usage          --db DIR [--id ID]
node cli.js history        --db DIR [--id ID]
```

成功输出 JSON 至 stdout，退出码 0；失败输出
`{"error": CODE, "message": ..., "retryable": bool}` 至 stderr，退出码 1。

错误约定：`NO_ACCOUNT`（账户不存在）、`CONFLICT`（并发写冲突，可重试）、
`BUDGET_EXCEEDED`（余额不足，整体不生效）。

实测：

```
$ node cli.js create-account --db /tmp/demo --id team-a --balance 100
{"ok":true,"txid":1,"account":"team-a","balance":100}
$ node cli.js debit --db /tmp/demo --id team-a --amount 80 --resource gpu-h100 --units 1
{"ok":true,"txid":2,"debits":[{"account":"team-a","amount":80,"balanceAfter":20}],"usage":[...]}
$ node cli.js balance --db /tmp/demo --id team-a
{"account":"team-a","balance":20}
$ node cli.js debit --db /tmp/demo --id team-a --amount 50
{"error":"BUDGET_EXCEEDED","message":"debit of 50 exceeds balance 20 on account: team-a","retryable":false}  # exit=1
$ node cli.js balance --db /tmp/demo --id ghost
{"error":"NO_ACCOUNT","message":"no such account: ghost","retryable":false}  # exit=1
```

## 库 API

```js
const { Store } = require('./src/store');
const store = Store.open('/path/to/db');
await store.createAccount('acc', 100);

const tx = store.begin();
tx.getBalance('acc');                       // 快照读
tx.debit('acc', 80, { resource: 'gpu', units: 1 }); // 条件写：声明扣减 + 占用记录
await tx.commit();                          // 冲突 -> CONFLICT；透支 -> BUDGET_EXCEEDED
```

## 测试与验收

运行 `node --test`。真实结果（2026-10-04，Node v22.22.1）：

```
ok 1 - snapshot isolation: readers observe a stable snapshot
ok 2 - unknown account raises NO_ACCOUNT
ok 3 - write-write conflict on intersecting write sets raises retryable CONFLICT
ok 4 - BUDGET_EXCEEDED aborts the whole transaction with no partial effects
ok 5 - persistence: reopening replays accounts and usage records from WAL
ok 6 - acceptance 1: balance 100, two concurrent debits of 80 -> exactly one succeeds
ok 7 - acceptance 2: torn WAL commit frame -> account and usage records both present or both absent
ok 8 - acceptance 3: randomized concurrent debits match serial-enumeration reference
ok 9 - CLI: create-account / debit / balance / usage / history end to end
ok 10 - CLI: error conventions NO_ACCOUNT and BUDGET_EXCEEDED
# tests 10
# pass 10
# fail 0
```

三个验收场景的覆盖方式：

1. **并发扣减**：余额 100，两个并发事务各扣 80。恰一个提交成功，另一个
   `CONFLICT`；最终余额 20，占用记录恰一条（80），余额 + 占用合计 = 100。
2. **WAL 撕裂写崩溃**：先完整提交一笔（余额 100→60），再向 WAL 尾部直接
   追加半个 `commit` 帧模拟写一半时崩溃。重启恢复后：撕裂帧整体丢弃，
   余额 60 与 1 条占用记录严格对应；且截断尾部后新事务可正常提交、
   再次重启状态一致（余额 50、2 条记录）。
3. **随机并发对照串行参考**：20 个确定性随机种子，每个种子随机初始余额
   （50–200）与 5–8 笔随机扣减（10–90），并发执行（`CONFLICT` 自动重试）。
   参考实现枚举全部串行顺序（每笔在其位置可付则成功）得到可达最终余额
   集合；断言实际最终余额 ∈ 参考集合，且余额 + 占用记录合计 ≡ 初始预算、
   占用记录条数 ≡ 成功扣减笔数，并验证重开后持久化状态一致。

## 文件结构

- `src/store.js` — MVCC 存储引擎（多版本状态、事务、串行化提交、WAL 追加）
- `src/wal.js` — WAL 帧编解码、CRC32、撕裂尾恢复
- `src/errors.js` — 错误码约定
- `cli.js` — CLI（`run()` 可在进程内驱动，亦作可执行入口）
- `test/store.test.js` — 全部测试（含三个验收场景）
