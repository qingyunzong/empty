# repro-planner

可复现实验计划判定器：给定实验 DAG、有限参数域与机器预算，判定是否存在可复现运行计划，
并生成可离线核验的哈希链证书。Node.js 22，仅标准库，测试使用 `node:test`。

## 问题模型

- **节点 = 步骤**：`{id, params[], memory, duration}`；参数为有限域（版本），内存/时长为非负/正整数。
- **边 = 依赖**：`edges: [[from, to]]`，必须无环；`to` 的开始时间不早于 `from` 的结束时间。
- **参数兼容矩阵**：`compat: {"from>to": {paramU: [paramV, ...]}}`，缺省为全兼容。
- **同机互斥**：机器数为 `machines`，同一机器上的步骤时间不得重叠；
  另有 `mutex: [[a, b]]` 强制两步在任意机器上都不得重叠。
- **总内存峰值**：任一时刻运行中步骤的内存和 `<= memoryLimit`。
- **版本钉扎**：`pin(step, param)` 把步骤域收缩为单例；`unpin` 恢复。

目标：最小化 makespan（最大结束时刻）。并列最优计划按规范编码的**字典序**输出：
步骤按 id 升序，每步元组 `[start, machine, param]` 依次数值/码点比较。求解器按
(id 顺序决策, start→machine→param 升序取值) 首次命中即字典序最小计划，结果完全确定
（无时间戳、无随机源）。

## 求解器

- 下界：关键路径、机器负载 `ceil(Σdur/M)`、内存能量 `ceil(Σ(mem·dur)/L)`、
  内存互斥团（贪心）序列化下界；`T` 从下界递增至 `Σdur`。
- 传播（每搜索节点）：依赖闭包 EST/LST 时间窗、AC-3 参数弧一致性、
  剩余内存能量/机位容量检查；机器对称破缺（按序启用新机器，保留字典序最小计划）。
- 回溯：按 id 序选择未定步骤，按 `(start, machine, param)` 字典序尝试取值。

## 证书（repro-cert/1）

```
{ format, specHash, entries: [...], head, result }
```

- `entries`：`bound`（尝试的 makespan 上界）、`decision`（赋值）、`backtrack`（撤销）、
  `propagate`（传播冲突及原因）四类条目，含序号 `i` 与 `hash`。
- 哈希链：`h0 = sha256("repro-cert/1:" + specHash)`，
  `h_i = sha256(h_{i-1} + ":" + canon(entry_i))`，`head` 为链头；
  `canon` 为键序确定的规范化 JSON。
- `verify` 重放全部条目（检查赋值合法性与传播冲突可复现）、重算哈希链、
  独立校验最终计划可行性与 makespan 一致性；UNSAT/PENDING 做结构校验，
  且若轨迹以完整计划收尾却声称 UNSAT/PENDING 则判 INVALID。

## 预算

- `maxNodes`：决策尝试次数上限；`maxCertBytes`：证书条目字节预算（近似，按条目增量计）。
- 任一耗尽 → `PENDING`，保留部分证书，**绝不** 判 `UNSAT`。

## 会话操作（分叉/合并）

会话状态（`init` 创建）含 spec、`pins` 与按分支的哈希链操作日志
（`pin`/`unpin`/`insert_job`/`solve` 均追加条目）。

- `fork_checkpoint(name, from)`：复制分支链。
- `merge_checkpoint(src, dst)`：两链前缀一致（一方为另一方前缀）→ 快进合并；
  否则返回 `CONFLICT` 并给出**最早分叉边**（首个哈希不同的条目下标及双方条目）。

## CLI

```
node bin/repro.js solve   --spec F [--max-nodes N] [--max-cert-bytes N] [--cert F]
node bin/repro.js verify  --spec F --cert F
node bin/repro.js init    --spec F --state F
node bin/repro.js run     --state F [--branch B] [--max-nodes N] [--max-cert-bytes N] [--cert F]
node bin/repro.js pin     --state F --step S --param P [--branch B]
node bin/repro.js unpin   --state F --step S [--branch B]
node bin/repro.js insert-job --state F --job JSON [--edge from>to]...
node bin/repro.js fork    --state F --name B [--from B]
node bin/repro.js merge   --state F --src B --dst B
```

退出码：`0` SAT/VERIFIED/OK，`2` INVALID_INPUT，`3` UNSAT，`4` PENDING，
`5` CONFLICT，`6` INVALID（核验失败）。所有结果（含错误）均为 stdout 上的单行 JSON。

## 库 API

- `solve(spec, {maxNodes, maxCertBytes})` → `{status, makespan?, plan?, certificate, stats}`
- `verify(spec, certificate)` → `{status: "VERIFIED"|"INVALID", ...}`
- `bruteForce(spec)` → 无传播的拓扑枚举对照求解器（测试交叉验证用）
- `checkPlan(norm, plan)` / `comparePlans(a, b)` / `planEncoding(plan)`
- 会话：`initState / loadState / pin / unpin / insertJob / forkCheckpoint / mergeCheckpoint / sessionSolve / effectiveSpec`

## 测试

```
node --test
```

覆盖：字典序并列最优确定性、pin/unpin 增量与重算一致、分叉注入 CONFLICT 定位、
n≤8 与暴力拓扑枚举对照（56 个确定性随机实例，SAT/UNSAT 混合）、
证书重放/篡改检测、预算耗尽 PENDING、CLI 端到端与全部错误码。
