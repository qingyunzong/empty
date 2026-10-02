# clearing-window

单机车清算窗口调度库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 核心机制

- **窗口调度**：每轮清算窗口容量有限（`capacity`），每机构每轮有硬配额（`institutions.<name>.quota`）。非原子批次（fluid）可任意拆分，跨轮续传。
- **原子性**：`atomic: true` 或共享 `group` 的批次构成原子组，必须同轮整体成功，否则整体等待。组总量超过窗口容量在 `plan` 阶段即以 `ATOMIC_SPLIT` 拒绝。
- **抢占回滚**：轮内按到达顺序（FIFO）考虑候选；放不下的高权重候选可抢占本轮已 tentative 放置的**严格更低权重**的非原子余量（部分回滚，被抢金额退回等待池）。已确认的原子组永不被拆散或抢占。抢占失败时 tentative 分配整体回滚（snapshot/restore）。
- **公平老化**：批次/原子组每空等一轮（到达但未获任何分配）等待计数 +1；等待超过 `agingLimit` 后有效权重 = `priority + (waited - agingLimit)`。老化只提升抢占/排序权重，**永不突破硬容量与配额**。
- **崩溃安全持久化**：每轮写入 `rounds/round-XXXX/allocations.json`（tmp+rename+fsync）后，才写 `commit.marker`（内容为该轮 proof）。故障点定义为"写了轮次目录但未写 commit.marker"：恢复时该轮目录整体回滚删除；marker 存在的轮次恢复后必须完整可见，且 marker 与 allocations 内容校验一致。

## 场景文件

```json
{
  "capacity": 10,
  "agingLimit": 2,
  "institutions": { "A": { "quota": 7 }, "B": { "quota": 6 } },
  "batches": [
    { "id": "a1", "institution": "A", "priority": 3, "amount": 9 },
    { "id": "g1a", "institution": "B", "priority": 2, "amount": 3, "group": "g1" },
    { "id": "g1b", "institution": "B", "priority": 2, "amount": 3, "group": "g1" }
  ]
}
```

字段：`priority`（默认 0）、`arrivalRound`（默认 1）、`group`（原子组 id）、`atomic: true`（单批次原子组）、`agingLimit: null` 表示禁用老化。

## CLI

```
node bin/clearing.js plan    --input scenario.json --state <dir> [--max-rounds N]
node bin/clearing.js commit  --state <dir> [--rounds K] [--crash-after-write]
node bin/clearing.js recover --state <dir>
node bin/clearing.js verify  --state <dir>
```

每个命令输出 `rounds`、`waits`、`proof`（对 scenario+rounds+waits 的规范化 JSON 做 SHA-256）。`commit --crash-after-write` 在写完最后一个目标轮次目录后、写 `commit.marker` 前以退出码 3 模拟崩溃。

错误码（退出码）：`ATOMIC_SPLIT`(10)、`WINDOW_FULL`(11)、`QUOTA`(12)、`PARTIAL_COMMIT`(13)，崩溃模拟退出码 3。

## 真实输出（examples/demo.json）

`plan`（3 轮：第 2 轮中原子组 g1 抢占 a2 的 3 单位余量后整体进入）：

```
$ node bin/clearing.js plan --input examples/demo.json --state /tmp/demo/state
{
  "rounds": [
    { "round": 1, "used": 10, "allocations": [
      { "batch": "a1", "institution": "A", "amount": 7 },
      { "batch": "b2", "institution": "B", "amount": 3 } ] },
    { "round": 2, "used": 10, "allocations": [
      { "batch": "a1", "institution": "A", "amount": 2 },
      { "batch": "a2", "institution": "A", "amount": 2 },
      { "batch": "g1a", "institution": "B", "amount": 3, "group": "g1" },
      { "batch": "g1b", "institution": "B", "amount": 3, "group": "g1" } ] },
    { "round": 3, "used": 8, "allocations": [
      { "batch": "a2", "institution": "A", "amount": 3 },
      { "batch": "b2", "institution": "B", "amount": 5 } ] }
  ],
  "waits": { "a1": 0, "a2": 1, "b2": 1, "g1a": 1, "g1b": 1 },
  "proof": "sha256:1d53d9a761351aadc6d3234205227ec20bc6fb4bf54c3a45372cb3efb0a95946"
}
```

崩溃注入与恢复：

```
$ node bin/clearing.js commit --state /tmp/demo/state --rounds 2 --crash-after-write
{ "crashed": true, "round": 2, "committed": 1 }        # exit=3，round-0002 无 commit.marker

$ node bin/clearing.js verify --state /tmp/demo/state
{"error":"PARTIAL_COMMIT","message":"round directories without commit.marker: round-0002"}   # exit=13

$ node bin/clearing.js recover --state /tmp/demo/state
  ... "rolledBack": [ "round-0002" ], 1 轮可见, proof sha256:250d7c52...   # exit=0

$ node bin/clearing.js commit --state /tmp/demo/state && node bin/clearing.js verify --state /tmp/demo/state
  ... "proof": "sha256:1d53d9a761351aadc6d3234205227ec20bc6fb4bf54c3a45372cb3efb0a95946"   # 与 plan 一致
```

原子组拒绝拆分：

```
$ node bin/clearing.js plan --input bad-atomic.json --state /tmp/bad
{"error":"ATOMIC_SPLIT","message":"atomic group \"atomic:g1\" total 6 exceeds window capacity 5"}   # exit=10
```

## 测试

```
node --test
```

覆盖：原子组拒绝拆分（`test/atomic.test.js`）、commit 前/后崩溃恢复（`test/crash.test.js`）、配额下无饥饿与老化（`test/aging.test.js`）、verify 四类错误码（`test/verify.test.js`）、n<=9 与枚举轮次装箱对照（`test/enumerate.test.js`，300 个随机实例：调度轮数 >= 枚举最优下界且 <= 下界+1；另用 2000 实例验证 1997 个精确等于最优、3 个 +1）。

最近一次运行：

```
# tests 6
# pass 6
# fail 0
```

## 布局

- `src/scenario.js` — 场景校验与规范化（含 ATOMIC_SPLIT/QUOTA 前置检查）
- `src/scheduler.js` — 窗口调度、原子性、抢占回滚、公平老化、轮次校验
- `src/store.js` — plan/commit/recover/verify 的崩溃安全文件持久化
- `src/enumerate.js` — n<=9 精确枚举最小轮数（对照用）
- `src/proof.js` — 规范化 JSON + SHA-256 proof
- `bin/clearing.js` — CLI（`run`/`runSafe` 可编程接口 + 可执行入口）
