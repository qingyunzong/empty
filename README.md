# 证据校验调度器（evidence-verify）

监管平台为实验证据包分配校验 worker。纯 Node.js 22 标准库实现，无第三方依赖，
测试使用 `node:test`。

## 模型

- **证据包**：哈希链（按提交方串联 `prevHash`）、大小、密级、提交方、deadline。
- **worker**：吞吐（字节/tick）与密级上限；证据包只能派给 `maxLevel >= level` 的 worker。
- **租户**：周期配额（字节/周期）。配额内优先调度；等待超过 `boostThreshold` 的包被
  提升（boost），可绕过配额但**不突破密级约束**。
- **并发定序**：批量/并发提交按 `(lamport, client, hash)` 全序排序后应用。
- **可验证摘要**：每次命令输出 `{ rulesVersion, seq, eventsHash, stateRoot }`，
  其中 `eventsHash` 是输入事件哈希链头，`stateRoot` 是规范化状态的 SHA-256。
- **撤销与重验**：`recall` 对撤销树层级回滚（后代按深度逐级回滚、证书吊销）；
  `correct` 更正失败/已撤销证据，触发下游依赖包重验并换发证书。
- **崩溃恢复**：事件先写日志（journal）再写状态快照；`audit` 在写状态前/后两类
  故障点恢复到一致，摘要可由日志重放复算。

## 调度器

- 候选数 `n <= 12` 时使用**精确调度**（按 `(已放置集合, 各 worker 已用时间)` 记忆化
  搜索），目标字典序：提升包调度数 → 按时完成数 → 总完成时间；验收标准 1 即
  与独立暴力枚举对照（`test/scheduler.test.js`，n<=9 全部一致）。
- 更大批量退化为确定性贪心列表调度。

## 命令

```bash
node src/cli.js init    --dir D --config config.json
node src/cli.js submit  --dir D --id P --tenant T --submitter S --size N --level L \
                        --deadline N --prev-hash H --evidence-hash H --client C \
                        --lamport N --quota-proof P [--now N]
node src/cli.js submit  --dir D --batch batch.json   # 并发提交按 (lamport,client,hash) 定序
node src/cli.js verify  --dir D [--now N] [--fail id1,id2]
node src/cli.js correct --dir D --pkg P --size N --evidence-hash H [--deadline N] [--now N]
node src/cli.js recall  --dir D --pkg P [--now N]
node src/cli.js audit   --dir D
```

退出码：`0` 成功；`2` 用法错误；`3` 日志损坏（需 `audit`）；`4` 校验错误
（哈希链断 `hash-chain-broken`、配额伪造 `quota-forgery`、重复包
`duplicate-package` 等），**状态不变**（事件未落盘）。

`--quota-proof` 为 `sha256("quota:<tenant>:<quotaLimit>:<rulesVersion>")`，
用夸大的配额计算即构成配额伪造。

## 测试

```bash
node --test test/*.test.js
```

真实输出（Node v22.22.1）：

```
# tests 6
# suites 0
# pass 6
# fail 0
```

覆盖验收标准：

1. `test/scheduler.test.js` — n<=9 与独立暴力枚举对照最大按时完成数（含提升目标）。
2. `test/quota-boost.test.js` — 租户 A 占满配额后其超额包被延期；等待超阈值的 B1
   被提升调度，且提升不突破密级。
3. `test/correct-recall.test.js` — 更正 p1 使下游 p2/p3 重验且证书全部变更；
   recall 层级回滚（depth 0/1），恢复后摘要可重放复算。
4. `test/audit.test.js` — 模拟写状态前/后崩溃及日志损坏，audit 均恢复一致。
5. `test/errors.test.js` — 三类校验错误 exit 4 且日志/快照字节不变。
6. `test/ordering.test.js` — 并发提交定序与摘要确定性。

## 真实运行记录

`config.json`：两个 worker（w-fast 吞吐 4/密级 3，w-slow 吞吐 1/密级 1），
两租户配额各 24 字节/周期，提升阈值 3。

提交三个包后 `verify --now 0`（输出节选，真实运行）：

```json
{
  "ok": true,
  "command": "verify",
  "schedule": [
    { "pkgId": "b1", "workerId": "w-fast", "start": 0, "finish": 1, "onTime": true },
    { "pkgId": "a1", "workerId": "w-fast", "start": 1, "finish": 3, "onTime": true },
    { "pkgId": "a2", "workerId": "w-fast", "start": 3, "finish": 5, "onTime": true }
  ],
  "digest": {
    "rulesVersion": "1.0.0",
    "seq": 5,
    "eventsHash": "70041f1717c9251240b27aca5dfdbd7efc5f1dee3253bb1fc9448155c3e5b713",
    "stateRoot": "336633a19b033964df17e34f6efc23df32faccfeea20a4fce13b440e3420c522"
  }
}
```

失败→更正→重验：`verify --fail a1` 后 `correct --pkg a1` 输出
`"version": 2, "stale": ["a2"]`；再次 `verify` 后 a1/a2 证书全部换发。

撤销树回滚：`recall --pkg a1` 输出
`"rolledBack": [{"id":"a1","depth":0},{"id":"a2","depth":1}]`。

审计：`audit` 输出 `"snapshot": "ok"`，且 `eventsHash`/`stateRoot` 与上一命令
摘要一致（可由日志重放复算）。

哈希链断（真实输出，退出码 4，状态不变）：

```
{"ok":false,"error":{"code":"hash-chain-broken","message":"prevHash mismatch for submitter alice: expected 04919c07…, got deadbeef"}}
exit=4
```

## 存储布局（`--dir`）

- `journal.jsonl` — 追加式事件日志，每行 `{seq, lamport, now, type, payload,
  prevEventHash, eventHash}`，事件哈希链即摘要中的 `eventsHash`。
- `state.json` — 状态快照 `{seq, stateRoot, state}`，仅为缓存；日志是事实源，
  任何分歧由 `audit` 以日志为准修复。
