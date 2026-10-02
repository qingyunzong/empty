# RESULTS

环境：Node.js v22.22.1，仅标准库，测试框架 `node:test`。
运行命令：`node --test`（全部测试真实执行，以下为真实输出摘要）。

## 测试总览（`node --test`）

```
ok 1 - test/chain.test.js
ok 2 - test/cli.test.js
ok 3 - test/merkle.test.js
ok 4 - test/snapshot.test.js
# tests 4
# pass 4
# fail 0
```

逐条子测试（各文件单独 `node <file>` 的真实输出）：

```
== test/chain.test.js
ok 1 - revoke keeps history verifiable, marks old events restricted, rejects new use
ok 2 - tampering with any event breaks verification and locates the event
ok 3 - deleting an event from the middle breaks the chain
ok 4 - revoke requires a reason and unknown types are rejected
== test/cli.test.js
ok 1 - CLI end-to-end: event/revoke/challenge/verify/snapshot
ok 2 - CLI reports BROKEN_CHAIN with the tampered seq
ok 3 - CLI challenge on empty store and bad index gives NO_PROOF
== test/merkle.test.js
ok 1 - proofs match brute-force recomputation for many chain sizes and indices
ok 2 - corrupted proofs fail verification
ok 3 - challenge errors: empty chain and out-of-range index give NO_PROOF
== test/snapshot.test.js
ok 1 - snapshot writes manifest; reopen keeps head consistent with manifest
ok 2 - appends after a snapshot keep verifying; manifest covers a prefix
ok 3 - crash mid-snapshot (tmp left behind) recovers to old head, no half snapshot
ok 4 - crash mid-snapshot with prior manifest keeps the old manifest head
ok 5 - torn trailing event line is truncated during recovery
ok 6 - corrupt manifest.json is detected as BROKEN_CHAIN, never silently half-applied
ok 7 - manifest inconsistent with log is rejected
ok 8 - snapshot of empty chain gives NO_PROOF
```

## 验收标准对照

### 1) 撤销前后历史可验证且新用途被拒

覆盖：`test/chain.test.js` 第 1 条、`test/cli.test.js` 第 1 条。

真实 CLI 会话（3 个事件 + 快照后撤销 C1）：

```
$ node bin/cli.js event --store D --type analyze --actor lab --sample S1 --consent C1
ERROR REVOKED_CONSENT: consent C1 has been revoked
{"consentId":"C1","type":"analyze"}        # exit=1

$ node bin/cli.js verify --store D
{
  "ok": true,
  "eventCount": 4,                          # 撤销事件本身也在链上
  "restricted": [0, 1],                     # 撤销前的历史事件保留并标受限
  "revokedConsents": ["C1"],
  "manifest": { "seq": 2, "leafCount": 3, ... }   # 旧快照仍与前缀一致
}
```

### 2) 改任一事件 verify 失败并定位

覆盖：`test/chain.test.js` 第 2、3 条（篡改 seq 0/3/5 的字段、篡改 prevHash、
删除中间事件，均抛出 `BROKEN_CHAIN` 且 `details.seq` 指向首个不一致事件）。

真实 CLI 会话（篡改 seq 0 的 actor 字段）：

```
$ node bin/cli.js verify --store D
ERROR BROKEN_CHAIN: event hash mismatch at seq 0
{"seq":0}                                  # exit=1
```

### 3) 故障注入恢复无半快照

覆盖：`test/snapshot.test.js` 第 3–6 条。

- 崩溃留下 `manifest.json.tmp`（rename 前）→ 恢复后忽略并清除 tmp，
  链头保持旧头（无 manifest 时）或旧 manifest（已有时），链验证通过；
- 末尾撕裂事件行（无换行的部分 JSON）→ 恢复时截断，链头回到最后完整事件，
  之后可继续追加；
- `manifest.json` 内容损坏或与日志不一致 → `BROKEN_CHAIN`，绝不静默半应用。

### 4) 证明与暴力重算参考一致

覆盖：`test/merkle.test.js` 第 1 条。测试内实现了独立的暴力参考（直接从
`events.jsonl` 原始行重算事件哈希、叶哈希、逐层重算 Merkle 根，不共享库的
哈希/建树代码），对链长 n=1..40、每个 n 取多个叶索引（首/尾/随机）：

- `challenge` 返回的根 == 暴力重算根；
- 叶哈希 == 暴力重算叶；
- 证明路径逐步重算（参考实现）== 根；
- 路径长度 == ceil(log2 n)。

另：第 2 条验证篡改叶/路径/根后证明验证失败；第 3 条验证空链与越界索引
返回 `NO_PROOF`。

## 备注

- CLI 测试通过 `bin/cli.js` 导出的 `run(argv, io)` 在进程内执行（与命令行
  入口完全同一代码路径），因为本沙箱禁止派生子进程；命令行入口另以上述
  真实 shell 会话验证。
