# 组17 日终审计同步 — 实现与验收结果

环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线，无第三方依赖。

## 实现

- `lib/store.js` — 核心库：
  - `writeSnapshot`：余额分块写入 `snapshots/seq-NNNNNNNN/chunk-*.json`，每块 sha256 记入
    manifest；manifest 原子提交（写 `manifest.json.tmp` → fsync → rename → 目录 fsync）。
    恢复规则：manifest 已提交（rename 完成）则快照可信，否则只用上一快照。
  - `appendDelta`：追加式 `deltas.log`（JSONL），条目类型 `txn` / `correct`（更正）/
    `undo`（撤销），必须按位点接续（seq 空洞 code=51）；同 seq 同内容幂等，
    同 seq 不同内容判冲突（code=52）。
  - `restore`：选最近可信快照（manifest 已提交且全块哈希校验通过，坏块/缺块 code=50
    记入 warnings 并回退上一快照），再应用 baseSeq 之后的增量；快照之后的更正/撤销
    以更高 commitSeq 为准，回溯修正已折入快照的位点。
  - `check` / `verifyProof`：输出覆盖证明（各快照提交状态与块哈希、delta 连续性、
    覆盖区间、哈希链 headHash、proofHash），可被独立命令重算验证。
- `cli.js` — `node cli.js snapshot|delta|restore|check`；`check --out proof.json` 生成证明，
  `check --verify proof.json` 独立验证（exit 0/1）；StoreError 的 code 即进程退出码。
- 错误码：块缺失/损坏 `code=50`，seq 空洞 `code=51`，同 seq 不同内容冲突 `code=52`。

## 测试结果（真实输出）

`node --test test/*.test.js`，exit=0：

```
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
# Subtest: test/check.test.js
ok 2 - test/check.test.js
# Subtest: test/crash.test.js
ok 3 - test/crash.test.js
# Subtest: test/enumerate.test.js
ok 4 - test/enumerate.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 160909.378814
```

子测试合计 16/16 通过：

- `test/acceptance.test.js` 6/6 — 验收1：20 快照 × 5000 delta（每快照 250 条），
  破坏快照20 的分块后 restore 回退到快照19（warning code=50, reason=chunk-corrupt），
  重放增量后余额与全量模型一致；快照19 再坏则回退到快照18。另覆盖缺块 code=50、
  seq 空洞 code=51、同 seq 冲突 code=52、更正/撤销语义、未提交 manifest 不可信。
- `test/crash.test.js` 3/3 — 验收2：kill 在 manifest fsync 前（`afterManifestFsync`，
  tmp 已 fsync 未 rename）→ restore 只用上一快照（snapshotSeq=2，余额=快照2+delta 6..10）；
  kill 在提交后（`afterCommit`，rename+目录 fsync 完成）→ 新快照可信（snapshotSeq=3）。
  注：本运行环境禁止 node 派生子进程（spawn EPERM），崩溃以 crashHook 在精确持久化
  边界抛出模拟（writeSnapshot 无内存记账，抛出即等价于进程死亡）；CLI 的
  `SNAPSHOT_CRASH` 环境变量在真实环境以 SIGKILL 子进程复现相同两个崩溃点。
- `test/enumerate.test.js` 1/1 — 验收3：n=1..12 枚举全部 2^n 种快照+delta 组合
  （共 8190 种），每种在独立目录执行后 restore，余额逐一与内存模型对照一致。
- `test/check.test.js` 6/6 — 验收4：证明覆盖快照/增量/覆盖区间且可验证；
  JSON 落盘后再加载仍通过（独立命令路径）；篡改字段或 proofHash 被拒；
  数据在证明签发后变化则验证失败；空洞与坏块在证明中如实标注。

## CLI 演示（真实输出）

```
$ node cli.js snapshot --data demo --balances b1.json --seq 1 --base-seq 0
{"ok":true,"seq":1,"baseSeq":0,"manifestHash":"d4071cfda37bb5471834d1d9cad90240bce3469c447c0dd4e838019e1fb10966"}
$ node cli.js delta --data demo --entry '{"seq":1,"type":"txn","ops":[{"account":"alice","delta":-100},{"account":"bob","delta":100}]}'
{"ok":true,"appended":true,"seq":1}
$ node cli.js delta --data demo --entry '{"seq":2,"type":"correct","target":1,"ops":[{"account":"alice","delta":-80},{"account":"bob","delta":80}]}'
{"ok":true,"appended":true,"seq":2}
$ node cli.js delta --data demo --entry '{"seq":3,"type":"txn","ops":[{"account":"carol","delta":-50},{"account":"alice","delta":50}]}'
{"ok":true,"appended":true,"seq":3}
$ node cli.js delta --data demo --entry '{"seq":5,"type":"txn","ops":[{"account":"alice","delta":1}]}'
{"error":"seq gap: expected 4, got 5","code":51,"details":{"expected":4,"got":5}}
exit=51
$ node cli.js restore --data demo
{
  "snapshotSeq": 1,
  "baseSeq": 0,
  "headSeq": 3,
  "appliedDeltas": 2,
  "warnings": [],
  "balances": { "alice": 970, "bob": 580, "carol": 150 }
}
$ node cli.js check --data demo --out proof.json
exit=0
$ node cli.js check --data demo --verify proof.json   # 独立命令验证
{"valid":true,"mismatches":[]}
exit=0
$ node cli.js check --data demo --verify proof.tampered.json   # 篡改 coveredThrough 后
{"valid":false,"mismatches":["coverage","proofHash"]}
exit=1
```

证明样例（proof.json，节选）：

```
"trusted":  { "snapshotSeq": 1, "baseSeq": 0 },
"delta":    { "count": 3, "contiguous": true, "gaps": [],
              "headHash": "b720d8696d08d1abbf83fce2698f34ff80d5214afc0eeacf4eab5c3f2e6dee8e" },
"coverage": { "baseSeq": 0, "coveredThrough": 3, "headSeq": 3, "complete": true },
"proofHash": "bf3955cfb049b205cb279fc984f42d1af44256bfe0b150d814279b9aebfd60b4"
```
