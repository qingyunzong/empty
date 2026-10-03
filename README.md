# evidence-pack-scheduler

监管平台实验证据包校验 worker 调度器。纯 Node.js 22 标准库实现（`node:test` / `node:crypto` / `node:fs`），无第三方依赖。

## 功能

- **约束调度**：密级 × worker 吞吐 × deadline。小包集（n≤9）精确枚举最大按时完成数，大集合回退到"防饥饿提升优先 + EDF"贪心。
- **租户配额 + 防饥饿**：提交时校验周期配额；等待超过 `waitThreshold` 的包被提升（boost），但提升永不突破 worker 密级上限。
- **失败证据撤销**：`correct` 使旧包 superseded、下游依赖包证书失效并重验；`recall` 按撤销树层级（BFS）回滚整棵子树并释放配额。
- **可验证摘要**：每条命令输出 `digest = { rulesVersion, inputEventsHash, stateRoot, command, seq }`，其中 `inputEventsHash` 是 WAL 输入事件的规范化哈希，`stateRoot` 是状态（packs/certs/quotas/revoked/superseded/seq）的规范化哈希，恢复后可复算且一致。
- **崩溃恢复**：journal（begin/commit/fail 记录）+ 原子状态写入（tmp+rename）。`audit` 检测写状态前/后的故障点并回滚悬挂事务，保证一致。
- **并发定序**：同一命令内的事件按 `(lamport, client, hash)` 字典序应用。
- **错误语义**：哈希链断（`hash-chain-broken`）、配额伪造（`quota-forged`）、重复包（`duplicate-pack`）一律 exit 4 且状态不变（命令原子，不落盘）。

## 布局

```
bin/evpack.js     CLI（submit/verify/correct/recall/audit）
src/util.js       规范化 JSON、SHA-256、(lamport,client,hash) 定序、RULES_VERSION
src/state.js      Store：state.json 原子写 + journal.log + recover()
src/scheduler.js  调度：枚举最优（n≤9）/ 贪心回退、防饥饿提升
src/engine.js     命令执行、哈希链校验、撤销树、摘要计算
test/*.test.js    node:test 验收测试
```

## CLI 用法

```
node bin/evpack.js <submit|verify|correct|recall|audit> --state DIR [--events FILE] [--config FILE]
```

- `--state DIR`：状态目录（`state.json` + `journal.log`）。
- `--events FILE`：JSON 事件数组；每个事件含 `lamport/client/hash` 定序键。
- `--config FILE`：`{ workers: [{id, throughput, maxClassification}], waitThreshold, quotas: {tenant: limit} }`。

退出码：`0` 成功；`2` 用法错误；`4` 校验错误（哈希链断 / 配额伪造 / 重复包，状态不变）；`1` 其他内部错误。

### 事件格式

```json
{
  "lamport": 1, "client": "cli-a", "hash": "e1",
  "packId": "pack-a", "tenant": "tenant-a", "size": 4,
  "classification": 2, "chain": ["<sha256-hex>", "..."],
  "submitter": "sub-a", "deadline": 20, "dependsOn": ["pack-x"]
}
```

哈希链：`link[i] = sha256(canonical({prev: link[i-1], payload}))`，`link[-1]` 为 64 个 `0`。库函数 `engine.buildChain(payload, n)` 可生成合法链。

## 测试

```
node --test test/*.test.js
```

覆盖验收点：

1. `test/scheduler.test.js` — 小包集（n≤9）随机用例对照全枚举，调度结果等于最大按时完成数，且不超吞吐/密级。
2. `test/antistarvation.test.js` — 租户霸占容量后，等待超阈值的租户被提升（`boosted: true`），且不突破密级。
3. `test/correct.test.js` — 一条证据更正使下游包证书失效并重验，新证书哈希与 stateRoot 均改变；recall 撤销树层级回滚并释放配额。
4. `test/audit.test.js` — 故障点（写状态前 / 写状态后未提交）注入后 `audit` 恢复一致，摘要可复算。
5. `test/errors.test.js` — 哈希链断 / 配额伪造 / 重复包 exit 4 且状态不变；并发提交按 `(lamport,client,hash)` 定序。

## 真实输出（node v22.22.1）

以下输出由上述命令真实运行产生（长哈希节选显示）。

### submit —— 并发事件按 (lamport,client,hash) 定序后调度

```
$ node bin/evpack.js submit --state st --events submit.json --config config.json
{
  "ok": true,
  "command": "submit",
  "results": [
    { "packId": "pack-a",
      "chainTip": "202dfabeae830a76cb03373fd0556943dfdf68c09d78392b6df4db5a9a9e4898",
      "schedule": { "assignments": [
        { "packId": "pack-a", "tenant": "tenant-a", "workerId": "w-hi", "boosted": false, "waited": 0 }
      ], "deferred": [], "optimal": true, "maxOnTime": 1 } },
    { "packId": "pack-b",
      "chainTip": "5d16264f6df98470fc3a0c4f908392e5318f851e9e34397436efe1a1070ca744",
      "schedule": { "assignments": [
        { "packId": "pack-b", "tenant": "tenant-b", "workerId": "w-lo", "boosted": false, "waited": 0 }
      ], "deferred": [], "optimal": true, "maxOnTime": 1 } }
  ],
  "digest": {
    "rulesVersion": "evidence-pack-rules/1.0.0",
    "inputEventsHash": "f9fd8416fab27d1e4b8b038540946ad1cb045ce9f2ac2fd7341afa7693937f1c",
    "stateRoot": "54c342870316ebcb1edd9ab1d66d5b20943de0f26c4782821c78588b16f58486",
    "command": "submit", "seq": 1
  }
}
exit=0
```

（事件文件里 pack-b 的 lamport=2 排在 pack-a 的 lamport=1 之前，输出顺序证明定序生效；pack-b 依赖 pack-a，因定序后 pack-a 已存在而被接受。）

### verify —— 签发证书

```
$ node bin/evpack.js verify --state st --events verify.json --config config.json
{ "ok": true, "command": "verify",
  "results": [
    { "packId": "pack-a", "status": "verified",
      "cert": { "packId": "pack-a", "chainTip": "202dfabe...", "chainLength": 3,
                "workerId": "w-hi", "verifiedAtSeq": 2,
                "rulesVersion": "evidence-pack-rules/1.0.0",
                "certHash": "cdb4e8e6c30a585de723be0219a7779641e4ed23cfc6830163dd7d7016ebc641" } },
    { "packId": "pack-b", "status": "verified",
      "cert": { "certHash": "0e9208e560c407f6c4dc5b7916fec62f74f3f9dad557584d1a5a94662cc94a93", "...": "..." } }
  ],
  "digest": { "stateRoot": "ad2480567965c0a051dbee74c9b84115c358671127120796d843ee336685b3c8", "...": "..." } }
exit=0
```

### correct —— 下游失效并重排

```
$ node bin/evpack.js correct --state st --events correct.json --config config.json
{ "ok": true, "command": "correct",
  "results": [ {
    "oldPackId": "pack-a", "newPackId": "pack-a#c1",
    "chainTip": "4284609c5424d9de...",
    "invalidated": [ "pack-b" ], "hadCert": true,
    "schedule": { "assignments": [
      { "packId": "pack-b",   "tenant": "tenant-b", "workerId": "w-hi", "boosted": false, "waited": 0 },
      { "packId": "pack-a#c1","tenant": "tenant-a", "workerId": "w-hi", "boosted": false, "waited": 0 }
    ], "deferred": [], "optimal": true, "maxOnTime": 2 } } ],
  "digest": { "stateRoot": "fb72f00f23d0242fd2016005074ac9f7c2014d3a40e9f3ded00731f5da5fcdf9", "...": "..." } }
exit=0
```

### recall —— 撤销树回滚

```
$ node bin/evpack.js recall --state st --events recall.json --config config.json
{ "ok": true, "command": "recall",
  "results": [ { "root": "pack-b", "rolledBack": [ "pack-b" ] } ],
  "digest": { "stateRoot": "2e3c95c602ab9f9fa6ad5254bc6a6a53a3954564ec9cd03e0bb55b23cf6212af", "...": "..." } }
exit=0
```

### audit —— 干净日志

```
$ node bin/evpack.js audit --state st --config config.json
{ "recovery": { "recovered": false, "reason": "clean" }, "ok": true,
  "digest": { "rulesVersion": "evidence-pack-rules/1.0.0",
              "inputEventsHash": "f71e5235f16b3a081134ae6f138dbb2cfdafb9687a13fe35a4ba8b085a9a8e35",
              "stateRoot": "2e3c95c602ab9f9fa6ad5254bc6a6a53a3954564ec9cd03e0bb55b23cf6212af",
              "command": "audit", "seq": 4 },
  "packs": 3, "certs": 0, "revoked": 1 }
exit=0
```

### audit —— 故障点恢复（写状态前崩溃，journal 留有悬挂 begin）

```
$ node bin/evpack.js audit --state st --config config.json
{ "recovery": { "recovered": true, "rolledBackSeq": 5, "command": "submit" }, "ok": true,
  "digest": { "stateRoot": "2e3c95c602ab9f9fa6ad5254bc6a6a53a3954564ec9cd03e0bb55b23cf6212af", "...": "..." },
  "packs": 3, "certs": 0, "revoked": 1 }
exit=0
```

恢复后 `stateRoot` 与故障前完全一致（`2e3c95c6…`），摘要可复算。

### 校验错误 —— exit 4 且状态不变

```
$ node bin/evpack.js submit --state st --events bad.json --config config.json
{ "ok": false,
  "error": { "code": "hash-chain-broken",
             "message": "hash chain broken at link 000000000000" } }
exit=4
```
