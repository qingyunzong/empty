# crash-ledger

可崩溃的额度冻结账本库与 CLI。事件以 JSON Lines 顺序追加，链式 SHA-256 哈希保证完整性，
任何故障后重启恢复结果唯一。

## 事件格式

每行一个 JSON 事件：

```json
{"seq":0,"eventId":"r1","type":"reserve","account":"alice","amount":100,"prevHash":"000...000","hash":"..."}
```

- `seq`：从 0 开始的连续序号
- `eventId`：幂等键，重复 eventId 不会重复入账
- `type`：`reserve` | `commit` | `release` | `freeze`
- `prevHash`：上一事件的哈希（创世为 64 个 `0`）
- `hash`：对 `{seq,eventId,type,account,amount,prevHash}` 的 sha256

## 业务语义

- `reserve`：持有 +amount，可用 -amount；账户冻结后拒绝新增 reserve
- `commit`：持有 -amount，额度 limit 永久 -amount
- `release`：仅释放未 commit 的持有（持有 -amount，可用 +amount）
- `freeze`：冻结账户（已存在的持有仍可 commit/release）

## 崩溃点与恢复

故障点仅 `beforeAppend` 与 `afterAppend`：

- `beforeAppend`：崩溃后事件不存在（退出码 1），日志无任何部分写入
- `afterAppend`：事件已写入并 fsync 后以退出码 42 退出，事件必然已持久化

重启时从开头校验链式哈希（JSON 解析、字段、seq 连续性、prevHash 链接、自身 hash），
遇到首条损坏记录即把该记录及后续内容物理截断，再重放得到有效状态；
恢复报告含截断字节位置 `byteOffset` 与行号 `line`。

## CLI

```bash
node bin/ledger.js reserve alice 100 --file log.jsonl --event-id r1
node bin/ledger.js commit  alice 100 --file log.jsonl --event-id c1
node bin/ledger.js release alice  50 --file log.jsonl --event-id r2
node bin/ledger.js freeze  alice       --file log.jsonl --event-id f1
node bin/ledger.js status              --file log.jsonl
# 崩溃注入（用于故障演练）
node bin/ledger.js reserve alice 100 --file log.jsonl --crash afterAppend   # 退出码 42
node bin/ledger.js reserve alice 100 --file log.jsonl --crash beforeAppend  # 退出码 1
```

## 库

```js
import { Ledger } from './src/ledger.js';
const ledger = Ledger.open('log.jsonl', { defaultLimit: 1000 });
ledger.reserve('alice', 100, 'r1');
ledger.recovery; // { truncated, byteOffset, line, reason, eventsReplayed }
```

崩溃注入：`Ledger.open(file, { crash: { phase: 'afterAppend', at: 0 }, exitOnCrash: true })`；
`exitOnCrash: false` 时抛 `CrashError`（测试用）。

## 测试

```bash
node --test
```

- `test/acceptance.test.js`：三条验收场景（afterAppend 崩溃后持有保留可 commit；
  beforeAppend 无部分写入且重复 eventId 不重复扣款；篡改末行后截断并报告位置）。
  沙箱禁止 node 派生子进程，测试通过拦截 `process.exit` 捕获真实退出码 42/1，
  崩溃语义（fsync 前后）与真实进程崩溃完全一致；真实进程退出码另见
  `test-result.txt` 末尾的 bash 实录。
- `test/model.test.js`：≤5 事件序列 × 每个故障点（无崩溃 + 每次追加的
  beforeAppend/afterAppend），与独立顺序参考模型逐一对比最终状态、
  已应用事件集合与哈希链。
