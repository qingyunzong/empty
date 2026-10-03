# clearing-windows

单机离线清算窗口调度器 + CLI。仅使用 Node.js 22 标准库，测试使用 `node:test`。

- **窗口调度**：每轮窗口容量 `capacity` 有限；可拆分批次（`splittable`）按余量填充，不可拆分批次整批进窗或等待。
- **原子性**：同一 `group` 的批次必须同轮全部成功，否则整体等待；任何路径都不会拆散原子组。
- **抢占回滚**：高优先级批次抢占低优先级**非原子**余量（可拆分填充量与低权重非原子占位被回滚）；已确认的原子组不可被驱逐。
- **公平老化**：等待轮数超过 `agingLimit` 后权重提升 `weight = priority * (1 + (waited - agingLimit) * agingBonus)`；权重只影响排序，容量与机构配额始终是硬约束。
- **机构配额**：每机构每轮 `quota` 上限；配额大于 0 且批次可单独入窗时保证无饥饿（有限队列在有限轮次内全部清算）。
- **持久化**：每轮写入 `rounds/round-NNNNNN/round.json` 后写 `commit.marker`。故障点定义为"写完轮次目录、未写 commit.marker 即崩溃"——该轮整体回滚；marker 存在则恢复后完整可见。每轮带 SHA-256 证明链（`proof = sha256(prevProof + canonical(round))`）。

## 调度正确性

等待队列中离散项（原子组 + 不可拆分批次）`n <= 9` 时使用**精确枚举**（子集枚举 + 可拆分填充，最大化清算权重）；`n > 9` 时退化为按权重贪心 + 低权重非原子驱逐。`test/enumeration.test.js` 用独立实现的递归暴力枚举与调度器逐实例对照（60+ 随机实例）。

## 数据模型（`input.json`）

```json
{
  "capacity": 100,
  "agingLimit": 1,
  "agingBonus": 1,
  "institutions": { "alpha": { "quota": 70 }, "beta": { "quota": 60 } },
  "batches": [
    { "id": "a1", "institution": "alpha", "amount": 40, "priority": 3, "group": "g1" },
    { "id": "a2", "institution": "beta",  "amount": 30, "priority": 3, "group": "g1" },
    { "id": "b1", "institution": "alpha", "amount": 50, "priority": 9 },
    { "id": "b2", "institution": "beta",  "amount": 80, "priority": 2, "splittable": true },
    { "id": "b3", "institution": "alpha", "amount": 20, "priority": 1, "arrival": 1 }
  ]
}
```

`arrival`（可选，默认 1）表示批次到达轮次，之前不参与调度、不计等待。

## CLI

```
node src/cli.js plan    --data DIR   # 干跑：输出 rounds / waits / proof，不写盘
node src/cli.js commit  --data DIR   # 提交下一轮（写 round.json → commit.marker → state.json）
node src/cli.js recover --data DIR   # 回滚无 commit.marker 的轮次目录，重放已提交轮次重建状态
node src/cli.js verify  --data DIR   # 校验容量/配额/原子性/证明链/state.json 一致性
```

错误码与退出码：`ATOMIC_SPLIT=2`、`WINDOW_FULL=3`、`QUOTA=4`、`PARTIAL_COMMIT=5`、`STATE_MISMATCH=6`、`INVALID_INPUT=1`。

## 真实输出（`examples/input.json`）

`plan`（节选，3 轮清算完毕；注意第 1 轮高优先级 `b1` 抢占了 `b2` 的可拆分余量，原子组 `g1` 整体等待到第 2 轮同轮成功）：

```
$ node src/cli.js plan --data /tmp/demo
{
  "command": "plan",
  "pending": 5,
  "waits": { "a1": 0, "a2": 0, "b1": 0, "b2": 0, "b3": 0 },
  "rounds": [
    { "index": 1, "allocations": [
        { "batch": "b1", "group": null, "institution": "alpha", "amount": 50 },
        { "batch": "b2", "group": null, "institution": "beta",  "amount": 30 },
        { "batch": "b3", "group": null, "institution": "alpha", "amount": 20 } ],
      "used": 100,
      "proof": "b2515e7361a33b77c4f3d07b0102bc1f969848cd3265ce82c8241c209447565d" },
    { "index": 2, "allocations": [
        { "batch": "a1", "group": "g1", "institution": "alpha", "amount": 40 },
        { "batch": "a2", "group": "g1", "institution": "beta",  "amount": 30 },
        { "batch": "b2", "group": null, "institution": "beta",  "amount": 30 } ],
      "used": 100,
      "proof": "ac7d6840cb6755ebd0e42de866157e71775a77f7b197292415fe68c83a3636ff" },
    { "index": 3, "allocations": [
        { "batch": "b2", "group": null, "institution": "beta", "amount": 20 } ],
      "used": 20,
      "proof": "1582785787cc559f64b7ad16d97b97b6d5e116af6082a7e148fe295d80006ccb" }
  ],
  "proof": "1582785787cc559f64b7ad16d97b97b6d5e116af6082a7e148fe295d80006ccb"
}
```

`commit` × 3 后 `verify`：

```
$ node src/cli.js verify --data /tmp/demo2
{
  "command": "verify",
  "ok": true,
  "rounds": 3,
  "proof": "1582785787cc559f64b7ad16d97b97b6d5e116af6082a7e148fe295d80006ccb"
}
```

崩溃恢复（`round-000002/round.json` 已写入但无 `commit.marker`）：

```
$ node src/cli.js recover --data /tmp/demo3
{
  "command": "recover",
  "ok": true,
  "code": "PARTIAL_COMMIT",
  "rolledBack": [ "round-000002" ],
  "committedRounds": 1,
  "pending": 3,
  "waits": { "a1": 1, "a2": 1, "b2": 1 },
  "proof": "b2515e7361a33b77c4f3d07b0102bc1f969848cd3265ce82c8241c209447565d"
}
$ node src/cli.js verify --data /tmp/demo3
{ "command": "verify", "ok": true, "rounds": 1,
  "proof": "b2515e7361a33b77c4f3d07b0102bc1f969848cd3265ce82c8241c209447565d" }
```

原子组拒绝拆分（组总量 12 > 容量 10）：

```
$ node src/cli.js plan --data /tmp/bad
{"error":"ATOMIC_SPLIT","message":"atomic group g (12) exceeds window capacity 10; refusing to split"}
exit=2
```

## 测试

```
$ node --test
# tests 4
# pass 4
# fail 0
```

覆盖：原子组同轮成功/整体等待、可拆分余量被抢占回滚、已确认原子组不可驱逐、公平老化反超新到高优先级批次、配额下无饥饿、commit 前后两种崩溃恢复、篡改检测、`n<=9` 与独立暴力枚举装箱对照、CLI 四个命令与全部错误码。

## 目录结构

- `src/scheduler.js` — 调度核心：精确枚举 / 贪心 + 抢占、原子组建模、公平老化、模拟
- `src/store.js` — 持久化：commit 协议、recover 回滚、replay、verify
- `src/proof.js` — 规范化序列化 + SHA-256 证明链
- `src/cli.js` — CLI（同时导出 `run()` 供进程内测试）
- `test/` — `node:test` 测试
- `examples/input.json` — 示例输入
