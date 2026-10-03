# wallet-holds

钱包资金预留库 + CLI。仅使用 Node.js 22 标准库，全程单机离线，无第三方依赖。

## 设计

- **事件溯源持久化**：数据目录下 `log.jsonl`（追加式事件日志）+ `snapshot.json`
  （压缩快照）。每条事件携带全局连续 `rev`、`prevHash`、`hash`，构成
  SHA-256 哈希链；重启加载时逐条校验 rev 连续性与哈希链完整性。
- **持有记录**：`{ id, wallet, amount, memo, rev, state }`，
  `state ∈ active | released | cancelled`。
- **乐观并发控制**：所有写命令（`deposit/freeze/release/cancel`）必须携带
  `expectedRev`，不等于当前 rev 即整体拒绝（不分配 id、不改金额、rev 不变），
  返回 `{ code: 'CONFLICT', currentRev, certificate }`，证书为当前哈希链头
  `{ algorithm, rev, hash }`。
- **余额语义**：`available = balance - held`；`freeze` 增加 `held`，
  `release`/`cancel` 释放；`cancel` 额外做逻辑删除（从索引摘除、计数墓碑）。
- **位置索引**：memo 分词（Unicode 小写）后建立 `term -> {holdId -> [positions]}`
  倒排位置索引。短语查询即窗口 `terms.length - 1` 的有序近邻；`near: K`
  表示有序命中首尾跨度 ≤ K。已删除记录默认不可见；`includeHistory: true`
  时全量枚举（含墓碑）并标注 `state`/`deleted`。
- **增量压缩**：墓碑数达到 `compactThreshold`（默认 8）后自动把存活状态折叠进
  快照并截断日志；快照记录当前 `rev` 与链头哈希，后续事件从 `rev+1` 继续，
  rev 链保持连续。

## 库 API（`src/store.js`）

```js
import { WalletStore } from './src/store.js';
const store = new WalletStore('./data', { compactThreshold: 8 });

store.deposit({ wallet: 'alice', amount: 1000, expectedRev: 0 });
const h = store.freeze({ wallet: 'alice', amount: 300, memo: 'red apple pie', expectedRev: 1 });
store.release({ id: h.id, expectedRev: 2 });
store.cancel({ id: h.id, expectedRev: 3 });
store.balance('alice');                       // { balance, held, available, rev, ... }
store.search('red apple');                    // 短语
store.search('red apple', { near: 4 });       // 有序近邻，窗口 4
store.search('red apple', { includeHistory: true }); // 含已删除，标注状态
store.compact();                              // 手动压缩
```

成功返回 `{ ok: true, rev, certificate, balance, held, available, amount, ... }`
（`amount` 即本次占用）；冲突返回 `{ ok: false, code: 'CONFLICT', currentRev,
certificate }`。

## CLI（`bin/wallet.js`）

```sh
node bin/wallet.js --data ./data deposit --wallet alice --amount 1000 --rev 0
node bin/wallet.js --data ./data freeze --wallet alice --amount 300 --memo "red apple pie" --rev 1
node bin/wallet.js --data ./data release --id hold-1 --rev 2
node bin/wallet.js --data ./data cancel --id hold-1 --rev 3
node bin/wallet.js --data ./data balance --wallet alice
node bin/wallet.js --data ./data search --query "red apple" [--near 4] [--include-history]
node bin/wallet.js --data ./data compact
```

JSON 输出到 stdout；退出码：`0` 成功，`2` 并发冲突，`1` 其他错误。

## 测试

```sh
node --test
```

覆盖三条验收标准（`test/wallet.test.js`）：

1. 串行 freeze/release/cancel 后，各钱包 `balance/held/available` 与测试内独立
   账本逐步求和一致，并与磁盘事件日志独立重放结果一致。
2. 过期 rev 的 deposit/freeze/release/cancel 全部以 `CONFLICT` 拒绝，返回当前
   rev 与哈希链证书；拒绝后 rev、余额、记录数不变，下一个合法 id 无缝衔接
   （未产生编号或金额漂移）。
3. 近邻检索（多组短语/窗口查询）在删除前与存活枚举一致；删除后默认查询与存活
   枚举一致、`includeHistory` 与全量枚举一致且标注删除状态；触发自动压缩并
   重启后结论仍成立，且 rev 链连续（下一条命令 rev = 压缩时 rev + 1）。
4. CLI 端到端：真实退出码（冲突为 2）、JSON 输出、删除可见性语义。

最近一次运行记录：`node --test` 退出码 0，4 个测试全部通过，无失败输出。
