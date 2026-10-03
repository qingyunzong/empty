# 验收结果（真实输出）

运行环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线。

## 1. 测试套件：`node --test test/*.test.js`

```
ok 1 - test/ledger.test.js
ok 2 - test/scale.test.js
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 106550.400961
```

`test/ledger.test.js` 10 个用例全部通过：

```
ok 1 - append and verify a clean chain
ok 2 - correction must point to an existing entry with same bizKey
ok 3 - latest businessTime wins among multiple corrections
ok 4 - concurrent corrections on same business key keep conflict certificate
ok 5 - tombstone deletes on-chain entry from view
ok 6 - tampered middle byte: verify exits 4 and reports offset
ok 7 - time window violation is rejected
ok 8 - crash after index write but before log write: dangling index discarded
ok 9 - proof verifies independently via verify-proof subcommand
ok 10 - cli log/view end to end
```

`test/scale.test.js`（验收 1：3 万条、5% 更正，view 与 n≤15 枚举应用序对照）：

```
checked 5000 business keys, 100 accounts, 21 conflicts
ok 1 - 30k entries with 5% corrections: view matches n<=15 enumeration of application orders
```

5000 个业务键（每组 ≤15 条）的全部合法应用序（supersedes 偏序的线性扩展）
被逐一枚举，结果与 `view` 的确定性规则（业务时间最新者生效、并发同键留冲突
证书）完全一致；100 个账户余额逐一比对相等，21 个强制并发冲突的证书候选
集合与枚举结果一致。

## 2. CLI 演示：log / verify / view / proof / verify-proof

```
$ node cli.js log --op credit 100 to alice (k1)
{"seq":0,"prevHash":"0000000000000000000000000000000000000000000000000000000000000000","op":{"type":"credit","account":"alice","amount":100,"bizKey":"k1"},"supersedes":null,"businessTime":1700000000000,"logTime":1700000000000,"hash":"06c7aa6321723fa37dc9f884c867142f3610c56c7a6c27fcd8b93d5a5ac76d23"}
$ node cli.js log --op debit 40 alice (k2)
{"seq":1,"prevHash":"06c7aa6321723fa37dc9f884c867142f3610c56c7a6c27fcd8b93d5a5ac76d23","op":{"type":"debit","account":"alice","amount":40,"bizKey":"k2"},"supersedes":null,"businessTime":1700000001000,"logTime":1700000001000,"hash":"569259846254fdd7c78085a8e433c132b02eaf67be5d9be5857e81809d70844e"}
$ node cli.js log --op correction: credit 150 supersedes 0 (k1)
{"seq":2,"prevHash":"569259846254fdd7c78085a8e433c132b02eaf67be5d9be5857e81809d70844e","op":{"type":"credit","account":"alice","amount":150,"bizKey":"k1"},"supersedes":0,"businessTime":1700000002000,"logTime":1700000002000,"hash":"d7acfd5abeaf97526f29baa4887b91792f2b6309ce6b5ee35ec08979c45df472"}
$ node cli.js log --op tombstone supersedes 1 (k2)
{"seq":3,"prevHash":"d7acfd5abeaf97526f29baa4887b91792f2b6309ce6b5ee35ec08979c45df472","op":{"type":"tombstone","account":"alice","bizKey":"k2"},"supersedes":1,"businessTime":1700000003000,"logTime":1700000003000,"hash":"fd5a80cf185bc775583f16d2c576b83f58030bd7e0105b4c4d1a30c30d73682f"}
$ node cli.js verify
OK 4 entries verified, tip fd5a80cf185bc775583f16d2c576b83f58030bd7e0105b4c4d1a30c30d73682f
exit=0
$ node cli.js view --account alice
{"account":"alice","balance":150,"conflicts":[]}
$ node cli.js proof --account alice --out proof.json
proof written to proof.json (4 entries, 0 ancestors)
$ node cli.js verify-proof
OK proof for alice: 4 entries, 0 ancestors recomputed
exit=0
```

说明：k1 的更正（credit 150, supersedes 0）按业务时间生效，k2 被 tombstone
删除，因此 alice 当前余额 = 150（旧证据 entry 0/1 仍在链上可验）。

## 3. 验收 2：篡改中间字节 → verify 退出码 4 并报告 offset

```
$ tamper one byte in the middle of entry 2, then verify
flipped byte at offset 630
FAIL entry 2 offset 600: prevHash mismatch
exit=4
```

日志不被截断（测试断言篡改后 `readLog` 仍返回全部条目），首个坏 entry 的
序号与字节偏移被精确定位。

## 4. 验收 3：崩溃在写 index 后未写 log → 恢复丢弃悬空索引

```
$ rebuild clean 4-entry log
OK 4 entries verified, tip 5702a36fc1b8a896eb0db784a6aac6f2686021e8d28a19ae5afa53743974bc85
exit=0
$ simulate crash: index written, log not written
dangling index appended; idx lines now: 5
$ node cli.js verify (recovers first)
OK 4 entries verified, tip 5702a36fc1b8a896eb0db784a6aac6f2686021e8d28a19ae5afa53743974bc85
exit=0
idx lines after recovery: 4
log entries after recovery: 4
```

## 5. 验收 4：proof 可被独立 verify-proof 重算

见第 2 节末尾：`proof` 输出账户的全部链上路径（seq/offset/hash）与更正祖先
闭包，并以链尖（tipSeq/tipHash）锚定；`verify-proof` 独立重算全链 HMAC 哈希、
校验证明中每个条目与祖先的哈希及祖先闭包完整性。篡改证明文件后退出码 5：

```
not ok 路径（test/ledger.test.js 用例 9 内断言）：
verify-proof 对被篡改的 proof 输出 FAIL 并以退出码 5 终止
```
