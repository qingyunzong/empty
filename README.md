# wallet-hold-store

单机离线钱包资金预留库 + CLI。仅依赖 Node.js 22 标准库，测试使用 `node:test`。

## 模型

- 持有记录：`{ id, wallet, amount, memo, rev, state }`，`state ∈ active | released | cancelled`。
- 每条写命令（`deposit` / `freeze` / `release` / `cancel`）必须携带期望 `rev`；
  不等于当前 `rev` 即并发冲突，整体拒绝，返回 `{ error: 'CONFLICT', currentRev, cert }`，
  不产生编号、金额、rev 或证书变化。
- `freeze` 减少可用额并占用；`release` 恢复可用额；`cancel` 逻辑删除并释放。
- 证书：每条被接受的命令把 `sha256(prevCert, rev, canonical(entry))` 追加到哈希链，
  成功与冲突响应都携带当前 `cert`；`verify` 可重放校验。
- 成功响应包含 `balance`（可用额）、`held`/`released`（本次占用/释放）、`rev`、`cert`。

## 持久化与压缩

- 目录下 `log.jsonl`（追加日志）+ `snapshot.json`（压缩快照，原子 rename 写入）。
- 取消（tombstone）累计到 `compactThreshold` 触发增量压缩：日志合并进快照并截断，
  墓碑记录保留在快照中供 `includeHistory` 查询；快照记录 `rev`/`cert`，
  后续日志从 `rev+1` 继续，加载时校验连续性，重启后 rev 链无缝延伸。

## 检索

- memo 按 `[\p{L}\p{N}]+` 分词建位置倒排索引。
- `search(query, { window, includeHistory })`：query 分词后要求按序出现且
  最大跨度 `last-first+1 <= window`；`window` 缺省为词数，即精确短语。
- 已取消记录默认不可见；`includeHistory: true` 时返回并标注 `state`/`deleted`。

## CLI

```
node cli.js --data DIR <command>
  deposit  --wallet W --amount N --rev R
  freeze   --wallet W --amount N --memo M --rev R [--id ID]
  release  --id ID --rev R
  cancel   --id ID --rev R
  balance  --wallet W
  search   --query Q [--window K] [--include-history]
  holds    [--include-history]
  compact
  verify
```

退出码：`0` 成功；`2` 并发冲突；`1` 其他业务错误；`64` 用法错误。
可选 `--compact-threshold N` 调整压缩阈值（默认 100）。

## 库

```js
import { openStore } from './lib/store.js';
const store = openStore(dir, { compactThreshold: 100 });
store.deposit({ wallet, amount, rev });
store.freeze({ wallet, amount, memo, rev, id? });
store.release({ id, rev });
store.cancel({ id, rev });
store.balance(wallet);
store.search(query, { window, includeHistory });
store.listHolds({ includeHistory });
store.compact();
store.verify();
```

## 测试

```
node --test
```
