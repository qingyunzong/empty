# calsched — 地球观测网校准窗调度器

为地球观测传感器网络安排校准时窗：站点有时窗与电量约束，下传链路互斥，
科研合同有最低校准次数与周期配额。输出计划、未满足原因与 Merkle 证书。
仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

## 命令

```sh
node bin/calsched.js ingest  <scenario.json>   [--state DIR]   # 校验并载入场景（默认状态目录 .calsched）
node bin/calsched.js plan                      [--state DIR]   # 计算计划 + 未满足原因 + Merkle 证书
node bin/calsched.js correct <correction.json> [--state DIR]   # 增量更正时窗，只重算受影响站点
node bin/calsched.js fail    <fault.json>      [--state DIR]   # 故障：传感器不可用，抢占未锁定窗
node bin/calsched.js restore <faultId>         [--state DIR]   # 恢复：证明故障区间外历史不变
```

`--state` 目录内含 `scenario.json`、追加式事件日志 `events.log` 以及派生缓存
`state.json` / `plan.json`。每条命令都从场景 + 事件日志重新折叠出状态，
因此崩溃后删掉缓存文件再运行任意命令即可重放出完全一致的状态。

## 数据模型

- **站点**：`id`、`link`（下传链路，缺省为独占链路）、`battery`（电量预算）、
  `windows`（候选时窗：`id/start/end/energy`，半开区间 `[start,end)`，`locked` 为已承诺窗）。
- **合同**：`station`、`min`（最低校准次数），可选 `period` + `quota`（每周期配额上限，
  周期为 `[k*period,(k+1)*period)`，按窗开始时刻归属）。
- **互斥**：同一链路上任意两个已排时窗不得重叠；同一站点自身窗自然互斥（同链路）。
- **电量**：站点已排窗能量之和不得超过 `battery`。
- **锁定窗**：已承诺、不可抢占。锁定窗之间的互斥重叠、锁定窗能耗超预算在
  ingest/correct 时直接报错（exit 6）。锁定窗计入配额用量但自身豁免配额上限。

## 调度策略

目标按字典序最大化：`(满足合同数, 达到保底站点数, -能耗, -窗数)`。

- 候选窗 ≤ 16 时做精确子集搜索；更大规模用贪心：先**保底阶段**（每个有合同的
  站点至少排 `floor` 个窗，默认 1，避免饥饿），再**最大亏欠优先**（亏欠 =
  min − 已排）补缺口。
- 并列最优按 **（亏欠降序，站点 ID 升序，开始时刻升序）**；精确搜索的平局
  按规范序（站点、开始、窗 ID）偏好更早窗口，结果完全确定。
- 未满足合同给出原因：`downlink-contention`（链路互斥挤占）、
  `insufficient-battery`、`period-quota-cap`、`windows-unavailable-fault`、
  `insufficient-windows`、`no-available-windows`。

## 增量更正 / 故障 / 恢复

- `correct`：支持 `closeWindows` / `addWindows` / `battery`。只重算被改站点
  及其所在链路闭包；其余站点计划逐位不变（输出 `affected` / `replanned` /
  `unchanged`，可用 `stationHashes` 核对远端站点哈希不变）。
- `fail`：故障区间内该站点的未锁定已排窗被**抢占**并生成撤销令牌
  （`sha256` 内容寻址，确定性）；锁定窗不抢占（列入 `keptLocked`）。
  随后仅用剩余可用窗重排该站点。
- `restore`：解除故障，只放开故障区间内的候选窗；区间外已排历史被钉住，
  输出证明 `proof.outsideUnchanged: true` 及区间外计划哈希前后一致。
  恢复未知故障 → exit 6。

## Merkle 证书

每个已排窗生成叶子 `sha256("leaf|"+JSON)`，撤销令牌同样入叶；叶子排序后
两两哈希（奇数复制末节点）得到根。`planId` 即证书根，可用
`merkleRoot(certificate.leaves) === certificate.root` 独立验证。

## 错误与退出码

- `0` 成功；`2` 用法/模式错误（未知命令、未知站点、重复故障等）；`1` 其他异常。
- `6` 领域约束错误：**互斥重叠**（锁定窗）、**电量为负**（负能耗/负电量/
  锁定窗超预算）、**恢复未知故障**。

## 真实输出（examples/ 演示）

```console
$ node bin/calsched.js ingest examples/scenario.json --state /tmp/demo/state
{
  "ingested": "orbital-demo",
  "stations": 3,
  "windows": 7,
  "contracts": 3,
  "scenarioHash": "8792c735fe92f6733f4ce14ebaa9610b220d9476ee4324409abf484224a66c31"
}
```

`plan`（节选，完整输出见每次运行写入的 `plan.json`）：

```json
{
  "planId": "c842bb5bd426ae8d6d41067131bbd74fe5c9c483a0fbd4fb4cb0cea0833cb0b2",
  "schedule": {
    "alpha": [ { "window": "a1", "start": 0, "end": 2, "energy": 3, "locked": false } ],
    "beta":  [ { "window": "b2", "start": 3, "end": 5, "energy": 3, "locked": false } ],
    "gamma": [ { "window": "g1", "start": 0, "end": 2, "energy": 3, "locked": true } ]
  },
  "unmet": [
    { "contract": "C-alpha", "station": "alpha", "required": 2, "scheduled": 1,
      "deficit": 1, "reason": "downlink-contention" },
    { "contract": "C-gamma", "station": "gamma", "required": 2, "scheduled": 1,
      "deficit": 1, "reason": "period-quota-cap" }
  ],
  "certificate": { "algorithm": "sha256", "leafCount": 3,
    "root": "c842bb5bd426ae8d6d41067131bbd74fe5c9c483a0fbd4fb4cb0cea0833cb0b2" }
}
```

`correct`（关闭 alpha 的 a1，只重排 down-1 链路闭包，远端 gamma 哈希不变）：

```console
$ node bin/calsched.js correct examples/correction.json --state /tmp/demo/state
{ "event": "correct", "affected": ["alpha","beta"], "replanned": ["alpha","beta"],
  "unchanged": ["gamma"], "plan": { "planId": "cff9dd1de4d6608343b6e69322326fda3fe24e0c2d96ba016b5b2fae198704ca", ... } }
# gamma 计划哈希前后均为 4f195c96e6911c6f0bccc7d83ea40948dfc3525cfb6d158baed026fe2477c8ae
```

`fail`（beta 在 [0,3) 故障，b1 被抢占并签发撤销令牌）：

```json
{ "event": "fail", "fault": "F1", "preempted": ["b1"], "keptLocked": [],
  "revocations": [ { "token": "8fded64e37eee87da93f646d7907da230b4ad8d93fb636fea78d5ccb57f64c4c",
    "faultId": "F1", "station": "beta", "window": "b1", "start": 1, "end": 3 } ],
  "replanned": ["beta"] }
```

`restore`（证明区间外历史不变；beta 的 b1 在恢复后重新排入）：

```json
{ "event": "restore", "fault": "F1",
  "proof": { "faultId": "F1", "interval": { "start": 0, "end": 3 },
    "outsideUnchanged": true, "outsideBefore": [], "outsideAfter": [],
    "outsideHashBefore": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "outsideHashAfter":  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" } }
```

错误示例：

```console
$ node bin/calsched.js ingest overlap.json --state s1
error: mutex overlap on link L: locked windows a1 and b1   # exit 6
$ node bin/calsched.js ingest neg.json --state s2
error: negative battery: window a1 has energy -1           # exit 6
$ node bin/calsched.js restore F99 --state /tmp/demo/state
error: unknown fault F99                                   # exit 6
```

## 测试

```console
$ node --test test/*.test.js
# tests 5
# pass 5
# fail 0
```

验收映射：

1. `test/scheduler.test.js` — n≤11 随机场景与穷举最优（满足合同数、保底、能耗、窗数字典序）对照。
2. `test/fairness.test.js` — 长期被挤站点在 floor=1 时必获保底窗（精确与贪心路径均验证）。
3. `test/correct.test.js` — 关窗触发链路闭包内局部重排，远端站点计划哈希逐位不变。
4. `test/restore.test.js` — 崩溃点（删除派生状态）后重放事件日志，planId 与无崩溃运行一致。
