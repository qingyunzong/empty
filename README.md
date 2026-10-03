# frozen-ledger

可持久化冻结账本。Node.js 22、仅标准库、单机离线、零依赖。

## 设计

每个账户维护 `balance`（余额）/ `frozen`（冻结）/ `available = balance - frozen`（可用）。
每次提交都校验不变量：`balance >= 0`、`frozen >= 0`、`available >= 0`，违反即拒绝并持久化 abort。

**WAL 协议**（`wal.log`，JSON Lines，每条带单调 `seq` 与 sha256 校验和，append 后 fsync）：

1. 写 `intent`（完整事务描述：key/op/account/amount/target）→ fsync
2. 应用状态并写 `applied` → fsync
3. 写 `commit`（含结果）→ fsync

**三类故障点与恢复语义**（打开账本即恢复，恢复结果确定）：

| 故障点 | WAL 状态 | 恢复结果 |
|---|---|---|
| 写意图后 | 只有 `intent` | **PENDING，可重试**（同 key 重提从 apply 续作；绝不判为失败） |
| 写应用后未提交 | `intent` + `applied` | **自动回滚**：状态只按已提交事务重放，未提交效果被排除，追加 `abort` 记录 |
| 提交后未响应 | `intent` + `applied` + `commit` | **已生效**；同 key 重提返回已记录结果，重放幂等，不会重复应用 |

恢复以 WAL 为唯一事实源，按 commit 顺序重放已提交事务重建状态；`state.json` 仅为快照。
WAL 尾部撕裂（崩溃半途的部分行）在打开时截断；中间损坏报 `E_WAL`。

**操作**：`freeze`（冻结，available→frozen）、`debit`（扣占，balance/frozen 同减）、
`release`（释放，frozen→available）、`reverse`（冲正，精确反向已提交目标的效果）。
冲正只影响已提交区间：目标是 PENDING/已回滚/不存在、重复冲正、冲正冲正均被拒绝（`E_INVARIANT`）。

**幂等**：客户端为每次提交提供幂等键 `key`。同键同参数重提返回已记录结果
（`deduplicated: true`）；同键不同参数拒绝（`E_WAL`）。

**错误码**：`E_WAL`（WAL 损坏/写失败/键冲突）、`E_RECOVER`（恢复时发现 WAL 结构不一致）、
`E_INVARIANT`（不变量违反，含非法冲正）、`E_IO`（其他文件系统错误）。
故障注入本身抛 `CrashError`，模拟进程崩溃，不属于账本错误。

## 库用法

```js
import { Ledger } from './src/ledger.js';

const ledger = new Ledger('./data', {
  initBalances: { alice: 1000 },   // 仅全新 WAL 时写入 genesis 记录
  faultAfter: null,                // 'intent' | 'applied' | 'commit' 一次性故障注入
}).open();

ledger.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 200 });
ledger.submit({ key: 'k2', op: 'debit',  account: 'alice', amount: 50 });
ledger.submit({ key: 'k3', op: 'reverse', target: 'k1' });
ledger.status('k1');        // { key, txId, op, status: 'committed'|'pending'|'aborted'|'unknown' }
ledger.balance('alice');    // { account, balance, frozen, available }
ledger.list();
ledger.close();
```

## CLI

```sh
node cli.js --dir D --init alice=1000 submit --key k1 --op freeze --account alice --amount 200
node cli.js --dir D submit --key k2 --op debit --account alice --amount 50
node cli.js --dir D submit --key k3 --op reverse --target k1
node cli.js --dir D status --key k1
node cli.js --dir D balance --account alice
node cli.js --dir D list
# 故障注入演示（退出码 2 表示模拟崩溃，重开即恢复）：
node cli.js --dir D submit --key k4 --op freeze --account alice --amount 100 --fault-after intent
```

输出为 JSON；账本错误退出码 1（含 `error` 错误码），模拟崩溃退出码 2。

## 测试

```sh
npm test        # node --test test/*.test.js
```

测试全部使用 `fs.mkdtempSync` 临时目录，覆盖验收标准：

- `test/recovery.test.js` — 三类故障点注入后恢复结果确定（PENDING 可重试 / 自动回滚 / 已生效），重复恢复幂等
- `test/idempotency.test.js` — 同键重复提交幂等（含跨重启），同键不同参数拒绝
- `test/reversal.test.js` — 冲正只影响已提交区间（PENDING/已回滚目标被拒），精确反向，防重复冲正
- `test/invariant.test.js` — 余额/冻结/可用不变量每次提交校验，违反即 E_INVARIANT 且状态不变
- `test/model.test.js` — 3 个种子 × 250 步随机操作序列（含随机故障注入与重启），与内存参考状态机逐步对照
- `test/wal.test.js` — 尾部撕裂截断、中间损坏 E_WAL、WAL 不可读 E_IO

## 真实测试结果

在本机（Node v22.22.1）执行 `npm test` 的实际输出：

```
# tests 6
# pass 6
# fail 0
```

6 个测试文件共 22 个用例全部通过（recovery 4、idempotency 3、reversal 5、invariant 4、model 3、wal 3）。
