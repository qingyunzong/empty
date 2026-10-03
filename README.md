# repro-dag-planner

可复现实验 DAG 计划器：给定实验 DAG、有限参数域与机器/内存预算，判定是否存在可复现运行计划，并生成可离线核验的哈希链证书。纯 Node.js 22 标准库实现，无外部依赖。

## 模型

实例（JSON）：

```json
{
  "machines": 2,
  "memoryLimit": 8,
  "steps": [{"id": "a", "params": ["x", "y"], "memory": 2, "duration": 3}],
  "edges": [["a", "b"]],
  "compat": [{"between": ["a", "b"], "allow": [["x", "u"]]}]
}
```

- 节点为步骤，边为依赖（必须拓扑有序：`a` 结束后 `b` 才能开始）。
- 每步参数为有限域 `params`，资源消耗为非负整数（`memory`、`duration`）。
- `compat` 为参数兼容矩阵：`between: [a, b]` 的 `allow` 列出允许的参数对。
- 同机互斥：同一机器上作业区间不得重叠。
- 总内存峰值：任意时刻并发作业内存和不得超过 `memoryLimit`。
- 版本钉扎：`pins` 将某步参数固定为某个值。

计划目标：最小化 makespan；多个并列最优计划按规范 JSON 字典序取最小者（确定性输出）。

## CLI

```bash
node cli.mjs solve <instance.json> [--pins pins.json] [--max-nodes N] [--max-cert-bytes N] [--cert out.json]
node cli.mjs verify <cert.json>
node cli.mjs init <state.json> <instance.json>
node cli.mjs insert-job <state.json> <job.json>
node cli.mjs pin <state.json> <step> <param>
node cli.mjs unpin <state.json> <step>
node cli.mjs fork-checkpoint <state.json> <name>
node cli.mjs restore-checkpoint <state.json> <name>
node cli.mjs merge-checkpoint <state.json> <name>
```

退出码：`0` SAT/VALID/OK，`1` INVALID_INPUT，`2` UNSAT，`3` PENDING，`4` CONFLICT，`5` INVALID（证书核验失败）。错误一律以 JSON 打印到 stdout，例如：

```json
{"status": "CONFLICT", "message": "certificate chains diverge", "details": {"divergence": {"index": 3, "edge": {"from": "...", "current": {...}, "checkpoint": {...}}}}}
```

## 求解器

- 确定性分支定界：决策顺序固定（拓扑就绪步骤按 id 升序 → 参数升序 → 机器升序）。
- 传播：钉扎/决策触发兼容矩阵前向检查（依赖闭包方向逐边收缩参数域），并记录每条移除的理由。
- 资源下界：机器负载界、总工作量/机器数界、优先约束最长路径界；下界超过当前最优即剪枝。
- 回溯选择下一个未定步骤；并列最优按字典序保留规范计划。
- 预算：`--max-nodes`（决策节点数）与 `--max-cert-bytes`（证书字节数）任一耗尽即 `PENDING`，保留部分证书，绝不判 `UNSAT`。

## 证书

证书条目构成哈希链：`hash_i = sha256(hash_{i-1} + "\n" + canon(entry_i))`，`canon` 为键排序的规范 JSON。条目类型：`init / propagate / conflict / decide / bound / backtrack / solution / budget / done`，包含决策序列与传播原因。

`verify` 离线重放：校验链结构 → 以相同实例、钉扎与预算确定性重跑求解器 → 比较完整条目序列与状态 → 独立校验计划可行性（拓扑、兼容、同机互斥、内存峰值、钉扎）。全部一致才输出 `VALID`。

## 增量操作与检查点

`pin/unpin/insert-job` 作为元条目追加到状态哈希链并触发增量重解，结果与全量重算一致（见 `test/incremental.test.js`）。`fork-checkpoint` 快照当前链；`merge-checkpoint` 仅当两条链前缀一致（一条是另一条前缀）时合并为较长链，否则返回 `CONFLICT` 并给出最早分叉边（索引与两侧条目哈希）。

## 测试

```bash
node --test
```

覆盖四条验收标准：并列最优字典序确定性、pin/unpin 增量与重算一致、分叉历史 CONFLICT 定位、n≤8 与暴力拓扑枚举对照（`src/bruteforce.js`）。真实运行结果见 `RESULTS.md`。
