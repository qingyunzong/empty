# dag-boundary-bisect

在版本 DAG 上定位**边界坏版本**（自身为 bad 且全部 parent 均为 good 的版本）的诊断库。
允许非单调检测结果（坏版本的子版本可以是好的），检测器异常记为 `pending`（未决），
支持查询预算、保留未测集合、输出查询证据，并与全 DAG 检测交叉核对。
仅使用 Node.js 内置模块，无运行时依赖。

## 概念

- **版本 DAG**：节点为版本，有向边 `parent -> child` 表示派生关系；`buildDag` 校验重复节点、自环与环。
- **检测适配器（Oracle）**：`test(version) => "good" | "bad"`，可同步或异步；抛异常时该版本记为 `pending`。
- **边界坏版本**：`status(v) === "bad"` 且所有 parent 均已测且为 `good`。
- **非单调**：不做单调性剪枝，按拓扑序逐个检测，已测集合始终是前缀封闭的。
- **预算**：最多消耗 `budget` 次查询（含异常查询）；预算耗尽时输出 `untested` 未测集合。
- **查询证据**：每次查询记录 `{ seq, version, outcome, error? }`，顺序与拓扑序一致。
- **交叉核对**：`scanFullDag` 不计预算测完全 DAG 得到基准边界，`crossCheck` 校验：
  - 已测版本状态与全量扫描一致（`status-mismatch`）；
  - 预算内确认的边界无假阳性（`false-positive`）；
  - 基准边界中的遗漏均可由预算/未决解释（`unexplained-miss`）。

## API

```ts
import { buildDag, fromMap, findBoundary, scanFullDag, crossCheck } from "dag-boundary-bisect";

const dag = buildDag({ edges: [["a", "b"], ["b", "c"]] });
const oracle = fromMap({ a: "good", b: "bad", c: "error" }); // "error" 会抛异常 -> pending
const bounded = await findBoundary(dag, oracle, /* budget */ 10);
const full = await scanFullDag(dag, oracle);
const check = crossCheck(dag, bounded, full);
```

`findBoundary` 返回 `BoundaryReport`：

| 字段 | 含义 |
| --- | --- |
| `confirmedBoundary` | 确认的边界坏版本（父全部实测为 good） |
| `unresolvedBoundary` | 自身 bad 但存在 parent 未测或 pending，无法确认 |
| `untested` | 预算内未测的版本集合 |
| `status` | 已测版本状态：`good` / `bad` / `pending` |
| `evidence` | 查询证据序列 |
| `complete` | 全部测完且无 pending 时为 `true` |

## CLI

```sh
node dist/src/cli.js examples/non-monotonic.json --budget 4
```

输入 JSON：`{ "nodes": [...], "edges": [[parent, child], ...], "oracle": { "v": "good" | "bad" | "error" } }`。
输出包含预算内报告、全量基准边界与交叉核对结果；核对失败时退出码为 1。

## 测试

```sh
npm test   # tsc 编译 + node --test
```

实际测试结果见 [RESULTS.md](RESULTS.md)。
