# maintenance-planner

设备科离线保养工单规划器。在技师班次、备件套件、设备停机窗的互相约束下，
最大化完成工单数、其次最小化加班、再次最小化切换次数。纯 Node.js 22 标准库，
无第三方依赖。

## 模型

所有时间为整数分钟，区间为半开 `[start, end)`。

```jsonc
{
  "timeStep": 15,                      // 可选，起点量化步长（默认 1 分钟）
  "orders": [
    { "id": "O1", "duration": 60, "window": [0, 60], "parts": ["pA"], "skill": "mech" }
  ],
  "techs": [
    { "id": "T1", "shifts": [[0, 240]], "skills": ["mech"] }
  ],
  "kits": [
    { "id": "KA", "qty": 1, "compatible": ["pA"] }
  ]
}
```

约束与机制：

- 工单必须整体落在自己的停机窗内；起点量化为
  `window.start + k*timeStep`，并总是包含最晚可行起点 `window.end - duration`。
- 一名技师同一时刻只能执行一张工单，且必须持有工单要求的技能。
- 工单的每个 part 在执行期间占用一件兼容套件的一个单位；套件在工单结束时
  归还，可立即被后续工单复用（占用/归还跨工单耦合，按并发峰值校验 `qty`）。
- 加班（overtime）= 工单执行时间未被所指派技师任何班次覆盖的分钟数。
- 切换（switches）= 各技师 `max(0, 完成工单数 - 1)` 之和。

目标按字典序：**完成数降序 → 加班升序 → 切换升序**。`enumerate` 模式下枚举
全部并列最优解（受 `maxOptima` 上限保护，超出时 `truncated: true`）。

## CLI

```bash
node cli.js <instance.json|-> [--require-all] [--enumerate] [--max-optima N] \
          [--node-limit N] [--lock ORDER:TECH[:START]] [--verify]
```

输出为单个 JSON 文档：

- `status`: `OPTIMAL` | `UNSAT` | `UNKNOWN`
- `objective`: `{ completed, overtime, switches }`
- `assignments`: 最优指派（`enumerate` 时另有 `optima` / `optimaCount` / `truncated`）
- `certificate` / `certificateHash`: UNSAT 时的最小冲突证书及其 SHA-256 哈希
- 输入校验失败（如窗口结束早于开始）输出
  `{"error": {"code": "ERR_WINDOW", ...}}` 且退出码为 1

示例：

```bash
node cli.js examples/nine-orders.json --enumerate
node cli.js examples/kit-shortage.json --require-all --verify
node cli.js examples/nine-orders.json --lock O1:T2:0
```

## UNSAT 证书

`--require-all` 下若无法完成全部工单且搜索完整结束，则状态为 `UNSAT` 并附带证书：

```jsonc
{
  "type": "UNSAT",
  "orders": ["O1", "O2"],                       // 最小冲突子集（删除法求得）
  "bottleneck": { "kind": "kit", "id": "KA", "have": 1, "need": 2 },
  "hash": "<sha256 of canonical JSON>"
}
```

证书声明三点，均可由 `verifyCertificate(instance, cert)` 独立复验：

1. 该工单子集不可全部完成；
2. 子集是最小的：去掉任意一张工单即可行；
3. 瓶颈资源差一：`kit`（qty+1 即可行）、`tech`（复制一名同技能同班次技师即可行）
   或 `skill`（子集中有工单无任何技师具备其技能）。

`hash` 覆盖 `{type, orders, bottleneck}` 的规范化 JSON（键排序），
`UNKNOWN`（节点上限 `--node-limit` 触发）**不**视为不可行：此时不产出证书；
证书构建/复验中遇到无法判定的检查会标记 `unverified` 而非声称不可行。

## 锁定与增量重解

```js
const { Planner } = require('./src/planner');
const planner = new Planner(instance);
const full = planner.solve();                        // 全量求解
planner.lock('O1', { tech: 'T2', start: 0 });        // 锁定一个指派
const resolved = planner.solve();                    // 增量重解（锁定约束生效）
planner.unlock('O1');                                // 撤销锁定
const restored = planner.solve();                    // 与全量求解一致
```

锁定可只固定技师（`{ tech }`）或同时固定起点（`{ tech, start }`）。
被锁定的工单必须按锁定执行；锁定导致不可行时返回 `UNSAT`。

## API

- `solve(instance, options)` → `{ status, objective, assignments, optima?, ... }`
  - options: `requireAll`, `enumerate`, `maxOptima`, `nodeLimit`, `timeStep`, `locks`, `findFirst`
- `new Planner(instance, baseOptions)`：`lock` / `unlock` / `solve`
- `buildCertificate(instance)` / `verifyCertificate(instance, cert)` /
  `solveWithCertificate(instance, options)` / `certificateHash(cert)`
- 错误码：`ERR_WINDOW`（窗口/班次结束早于开始）、`ERR_SCHEMA`、`ERR_LOCK`、
  `ERR_INPUT`、`ERR_NOT_UNSAT`

## 测试

```bash
node --test
```

验收覆盖：

1. 9 工单实例与独立的分支限界参考实现（`support/reference.js`，不共享搜索代码）
   对照：最优目标值与全部 72 个并列最优解集合完全一致；
2. 套件数量差一（`examples/kit-shortage.json`）返回最小冲突证书
   （子集 `[O1,O2]`、瓶颈 `KA have:1 need:2`），复验通过且哈希稳定；
3. 锁定一个指派后增量重解目标值不变且所有并列最优遵守锁定，解锁后与全量求解
   深度一致；
4. 窗口结束早于开始在 API 与 CLI 均报 `ERR_WINDOW`（退出码 1）。

另含：`UNKNOWN` 不视为不可行、套件占用/归还跨工单耦合、加班次优级等单测。
