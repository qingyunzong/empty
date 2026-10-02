# calplan — 地球观测网传感器校准窗调度

运行时：Node.js 22，仅使用标准库（`node:crypto` / `node:fs` / `node:path`）与 `node:test`，零依赖。

为地球观测传感器网络安排校准窗：站点有时窗、电量预算、互斥下传链路；科研合同有最低校准次数（`min`）、周期配额（`period`/`quota`）与保底（`floor`）。输出调度计划、未满足原因与 Merkle 证书。

## 命令

```bash
node bin/calplan.js ingest  <scenario.json> [--state DIR]   # 校验并摄入场景，生成初始计划
node bin/calplan.js plan    [--state DIR]                   # 全量重算计划 + Merkle 证书
node bin/calplan.js correct <patch.json>   [--state DIR]    # 增量更正时窗，只重算受影响站点
node bin/calplan.js fail    --station S --from A --to B [--state DIR]   # 故障：标记不可用并抢占
node bin/calplan.js restore --failure F<id> [--state DIR]   # 恢复：重放崩溃点并证明区间外历史不变
```

状态保存在 `--state` 目录（默认 `./.calplan`，或环境变量 `CALPLAN_STATE`）：
`state.json` 为当前快照，`events.jsonl` 为追加式事件日志（ingest/plan/correct/fail/restore 各一条），
`restore` 会从事件日志重放以校验/重建状态（崩溃恢复）。

## 数据模型

```jsonc
{
  "stations": [{
    "id": "ALPHA", "link": "DOWNLINK-1",  // 同一 link 的校准时间不可重叠（互斥）
    "battery": 6,                          // 电量预算：已排窗 cost 之和不得超过
    "windows": [{"id": "A-W1", "start": 0, "end": 2, "cost": 1, "locked": true}]
  }],
  "contracts": [{
    "id": "CT-A", "station": "ALPHA",
    "min": 2,        // 全周期最低校准次数
    "floor": 1,      // 保底：防止长期被挤的站点饥饿
    "period": 8,     // 周期长度（时间单位）
    "quota": 3       // 每周期最多校准次数
  }],
  "preassigned": []  // 可选：锁定指派，摄入时校验互斥/电量
}
```

## 调度核心

- **约束**：同一 `link` 上校准区间不重叠；站点电量不为负；每合同每周期不超过 `quota`；每个时窗最多一次校准。
- **公平**：小场景（总窗数 ≤ 11）用精确搜索，目标按字典序最大化
  `[保底达成数, 满足 min 的合同数, 有效校准总数, 更少占用]`；
  大场景用贪心：先按保底轮询（anti-starvation），再**最大亏欠优先**（亏欠 = min − 已服务），
  并列按 **（亏欠降序，站点 ID，开始时刻）** 破 tie。
- **抢占**：`fail` 只撤销区间内**未锁定**窗的条目，并为每条生成撤销令牌（`rvk_…`）；
  `locked: true` 的窗不可抢占，列入 `unpreemptable`。
- **增量更正**：`correct` 关闭/新增时窗后只重算 `affected` 站点，其余站点条目作为固定约束，
  远端站点的计划哈希（`stationHashes`）不变。
- **Merkle 证书**：计划条目排序后逐叶 `sha256` 建树，输出 `merkle.root`；
  `fail` 记录故障区间外条目的 Merkle 根，`restore` 重算并比对，证明**故障区间外历史不变**。
- **恢复重放**：`restore` 先从 `events.jsonl` 重放全部事件，与磁盘快照比对（不一致或缺失则
  判定崩溃并以重放为准，`recovered: true`），再只对故障站点的故障区间做局部重排。

## 错误码

| 情形 | error | exit |
|---|---|---|
| 互斥资源上窗重叠（preassigned/锁定条目） | `mutex-overlap` | 6 |
| 电量为负 / 锁定条目能耗超过电量 | `battery-negative` | 6 |
| 恢复未知故障 ID | `unknown-failure` | 6 |
| 用法/输入错误 | `usage` 等 | 2 |

## 真实输出（examples/scenario.json）

```bash
$ node bin/calplan.js ingest examples/scenario.json --state /tmp/demo/st2
```
```json
{
  "seq": 1,
  "plan": {
    "entries": [
      {"station": "ALPHA",   "window": "A-W1", "start": 0, "end": 2, "cost": 1, "contract": "CT-A", "locked": true},
      {"station": "ALPHA",   "window": "A-W4", "start": 6, "end": 8, "cost": 1, "contract": "CT-A", "locked": false},
      {"station": "BRAVO",   "window": "B-W2", "start": 2, "end": 4, "cost": 1, "contract": "CT-B", "locked": false},
      {"station": "BRAVO",   "window": "B-W3", "start": 4, "end": 6, "cost": 1, "contract": "CT-B", "locked": false},
      {"station": "CHARLIE", "window": "C-W1", "start": 1, "end": 3, "cost": 1, "contract": "CT-C", "locked": false},
      {"station": "CHARLIE", "window": "C-W2", "start": 5, "end": 7, "cost": 1, "contract": "CT-C", "locked": false}
    ],
    "served": {"CT-A": 2, "CT-B": 2, "CT-C": 2},
    "unmet": [{"contract": "CT-C", "served": 2, "min": 3, "reason": "quota-cap"}],
    "stationHashes": {
      "ALPHA": "006f712eaf2b2846b5350657ea46186f79d1a0efbb02b56009d7b2cb79b670de",
      "BRAVO": "1d78d15faf6b4407d573ea8952b6413a40af7055d5a639b9a0c79f3e11f83074",
      "CHARLIE": "230c85629098634e718ed6ce1fac23d62bdfaf5e272cbcaaba38dade4c75494c"
    },
    "merkle": {"algorithm": "sha256", "leaves": 6,
               "root": "b1594d9ae7dd846d6704052ddd40dd29558b928ad5522d82f4193506f69edd7e"}
  }
}
```

更正（关闭 A-W2、新增 A-W5，只重算 ALPHA）：

```bash
$ node bin/calplan.js correct examples/patch.json --state /tmp/demo/st2
```
```json
{"seq": 2, "affected": ["ALPHA"], "plan": { … "served": {"CT-A": 2, "CT-B": 2, "CT-C": 2} … }}
```

故障（锁定窗 A-W1 不可抢占，A-W4 被撤销并生成令牌）：

```bash
$ node bin/calplan.js fail --station ALPHA --from 1 --to 7 --state /tmp/demo/st2
```
```json
{
  "seq": 3,
  "failure": {
    "id": "F3", "station": "ALPHA", "from": 1, "to": 7, "restored": false,
    "revocations": ["rvk_c4b589363b26f1b3"],
    "unpreemptable": ["A-W1"],
    "outsideRoot": "89ef4778fc84b2dd5e9d6c60a09a14f3e35ed4a80f3dfbbb454c334945ab009d"
  }
}
```

恢复（区间外 Merkle 根一致，历史不变得证）：

```bash
$ node bin/calplan.js restore --failure F3 --state /tmp/demo/st2
```
```json
{
  "seq": 4,
  "certificate": {
    "failure": "F3", "station": "ALPHA", "interval": {"from": 1, "to": 7},
    "outsideRootBefore": "89ef4778fc84b2dd5e9d6c60a09a14f3e35ed4a80f3dfbbb454c334945ab009d",
    "outsideRootAfter":  "89ef4778fc84b2dd5e9d6c60a09a14f3e35ed4a80f3dfbbb454c334945ab009d",
    "unchanged": true,
    "revocations": ["rvk_c4b589363b26f1b3"]
  },
  "recovered": false
}
```

恢复未知故障（exit 6）：

```bash
$ node bin/calplan.js restore --failure F99 --state /tmp/demo/st2 ; echo "exit=$?"
```
```json
{"error":"unknown-failure","message":"failure F99 not found"}
```
```
exit=6
```

## 测试

```bash
node --test test/*.test.js    # 或 npm test
```

真实运行结果：

```
ok 1 - test/correct.test.js
ok 2 - test/errors.test.js
ok 3 - test/exhaustive.test.js
ok 4 - test/fairness.test.js
ok 5 - test/merkle.test.js
ok 6 - test/restore.test.js
# tests 6
# pass 6
# fail 0
```

覆盖验收标准：

1. `test/exhaustive.test.js` — 120 个随机场景（总窗数 ≤ 11），与穷举最大满足合同数逐一比对，并校验互斥/电量/配额不变式。
2. `test/fairness.test.js` — 精确与贪心两条路径上，长期被挤站点均获得保底；对照无保底时饥饿为 0。
3. `test/correct.test.js` — 关闭窗口引发局部重排（WA1→WA2），远端站点条目与计划哈希逐字节不变。
4. `test/restore.test.js` — 崩溃（删除 `state.json`）后 `restore` 从事件日志重放，最终计划与未崩溃路径完全一致；证书证明区间外历史不变。

## 代码结构

- `src/scheduler.js` — 调度核心：精确搜索（n≤11）+ 保底/最大亏欠贪心，未满足原因诊断
- `src/domain.js` — 场景校验、计划计算、correct/fail/restore 状态迁移
- `src/merkle.js` — Merkle 树、包含证明与验证
- `src/store.js` — 状态快照与事件日志重放
- `src/cli.js` / `bin/calplan.js` — 命令行入口
