# clearinghouse-scheduler

结算所清算通道调度器：把跨机构支付指令确定性地分配到有限的清算槽位，
支持机构配额、全局公平、饥饿老化、高优先级抢占（原子回滚 + 可重放证书）、
以及撤销已确认指令后的增量修复。纯 Node.js 22 标准库实现，无外部依赖、无网络访问。

## 运行

```bash
node --test                 # 全量测试
node src/cli.js job.json    # 从文件读取任务
cat job.json | node src/cli.js --pretty   # 从 stdin 读取
```

CLI 退出码：成功（`errors` 为空）为 `0`，任何错误（含容量/配额冲突、
无效输入、过期撤销）为 `2`。

## 输入格式

```json
{
  "config": {
    "slots": 2,                        // 清算槽数量（槽编号 1..slots）
    "capacity": 1,                     // 每槽容量（同槽互斥）
    "quotas": { "INST": 2 },           // 机构配额（缺省不限）
    "agingFactor": 1                   // 饥饿老化系数
  },
  "instructions": [
    {
      "id": "pay-1",                   // 唯一 id
      "institution": "INST",           // 机构
      "amount": 100,                   // 金额
      "priority": 5,                   // 静态优先级
      "deadline": 2,                   // 截止槽
      "deps": ["pay-0"],               // 前序依赖（须排在更早的槽）
      "age": 0                         // 初始等待年龄（可选）
    }
  ],
  "undo": [{ "id": "pay-1", "expectedVersion": 1 }]   // 可选，调度后执行
}
```

## 输出格式

`{ "version", "schedule", "waitlist", "orphans", "certificates", "errors" }`

- `schedule[]`：已确认指令（槽位、有效优先级、确认版本 `confirmedAt`）。
- `waitlist[]` / `orphans[]`：未调度 / 因依赖断裂被级联孤立的指令 id。
- `certificates[]`：完整审计日志，类型为 `CONFIRM` / `PREEMPT` / `MOVE` /
  `UNDO` / `ORPHAN` / `RESTORE`。
- `errors[]`：`{ code, id, message }`，`code ∈ CAPACITY | QUOTA | CYCLE |
  STALE_UNDO | DEP | UNKNOWN_DEP | DUPLICATE | INVALID | INVALID_INPUT`。

## 核心机制

- **约束调度**：指令只能放在 `(max(依赖槽), deadline]` 内有空余容量的槽；
  机构已确认数不得超过其配额。求解器为确定性分支限界（精确最优），
  超出节点预算时退化为同序确定性贪心。
- **目标与平局**：按字典序最大化 `(Σ有效优先级, 已调度数, Σ金额)`；
  剩余平局按金额降序、截止槽升序、id 字典序打破，最终按
  `(id, slot)` 向量定序——同输入必然同输出。
- **配额与公平**：机构配额是硬约束；有效优先级
  `= priority + agingFactor × age`，未调度指令每轮 `age + 1`（饥饿老化），
  长期等待的低优先级指令最终会击败新到的高优先级指令。
- **抢占与原子回滚**：新一轮调度使已确认指令失去位置时，该指令被原子
  回滚（整批变更在同一版本内提交），并生成 `PREEMPT` 证书。证书内嵌
  变更前快照、`replay` 操作与 `preHash`/`postHash`（SHA-256），
  `verifyCertificate(cert)` / `house.replayCertificate(id)` 可独立重放校验；
  任何篡改都会导致哈希不匹配。
- **撤销与增量修复**：`undo(id, expectedVersion)` 校验指令当前确认版本，
  不匹配或已非确认态则报 `STALE_UNDO` 且不改变任何状态。撤销后：
  依赖链断裂的已确认指令被级联标记为 `orphan` 并释放槽位与配额；
  修复阶段只把等待/被抢占/孤立的指令填入释放出的资源，
  **不移动任何无关的已确认分配**（修复到不动点为止）。

## 库 API

```js
import { ClearingHouse, verifyCertificate } from './src/engine.js';
import { solve } from './src/solver.js';            // 精确求解器
import { bruteForceSolve } from './src/bruteforce.js'; // 独立暴力枚举（对照用）

const house = new ClearingHouse({ slots: 2, capacity: 1 });
house.schedule([{ id: 'a', institution: 'A', amount: 5, priority: 2, deadline: 2 }]);
house.undo('a', 1);
house.report();                    // { version, schedule, waitlist, orphans, certificates, errors }
house.replayCertificate('cert-1'); // { ok: true, ... }
```

## 验收测试（test/）

- `test/constraints.test.js`（9 项）：容量冲突失败（`CAPACITY`）、配额上限
  （`QUOTA`）与跨机构公平、饥饿老化（静态年龄与跨轮累积）、`CYCLE` /
  自依赖 / `UNKNOWN_DEP`、依赖链严格递增槽位。
- `test/preempt-undo.test.js`（5 项）：高优先级抢占并生成可重放证书
  （含篡改检测）、撤销抢占者后增量恢复被抢占者且无关分配不动、
  `STALE_UNDO`（版本不符 / 重复撤销 / 不存在）、撤销级联 orphan 并释放配额。
- `test/solver.test.js`（3 项）：60 个随机实例（n≤8，含依赖/配额/老化）
  与独立暴力枚举的最优可行集逐一比对一致；重复求解结果一致。
- `test/cli.test.js`（7 项）：stdin / 文件输入、容量冲突退出码 2、
  无效 JSON 退出码 2、CLI 撤销与 `STALE_UNDO`、相同输入输出逐字节一致。

## 真实运行摘要

`node --test`（Node v22.22.1，2026-10-08 实测）：

```
✔ test/cli.test.js (3125.794249ms)
✔ test/constraints.test.js (519.887852ms)
✔ test/preempt-undo.test.js (489.808565ms)
✔ test/solver.test.js (494.23652ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

（4 个测试文件共 24 个断言用例，全部通过。）

`node src/cli.js examples/demo.json --pretty`（2 槽容量 1，三条指令
low/mid/high，退出码 2）摘要：

```json
{
  "version": 1,
  "schedule": [
    { "id": "high", "institution": "H", "slot": 1, "priority": 9, "effectivePriority": 9, "confirmedAt": 1 },
    { "id": "mid",  "institution": "M", "slot": 2, "priority": 5, "effectivePriority": 5, "confirmedAt": 1 }
  ],
  "waitlist": ["low"],
  "errors": [
    { "code": "CAPACITY", "id": "low", "message": "instruction low finds no free slot within deadline 2" }
  ]
}
```

`node src/cli.js examples/undo.json`（同上输入 + 撤销 high，退出码 0）摘要：

```json
{
  "version": 2,
  "schedule": [["low", 1], ["mid", 2]],
  "certTypes": ["CONFIRM:high", "CONFIRM:mid", "UNDO:high", "RESTORE:low"],
  "errors": []
}
```

容量冲突（1 槽 2 指令）实际输出（退出码 2）：

```json
{"version":1,"schedule":[{"id":"a","slot":1}],"waitlist":["b"],
 "errors":[{"code":"CAPACITY","id":"b","message":"instruction b finds no free slot within deadline 1"}]}
```
