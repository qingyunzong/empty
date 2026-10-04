# path-cli

从起点到终点的约束简单路径 CLI：至多访问 12 个节点（可配置）、必须经过全部指定检查点、
不允许重复节点。选路目标按字典序优先级：

1. **最小化最大边费**（瓶颈 / minimax）
2. 最小化总边费
3. 路径 ID 序列最小（自然序，如 `N2 < N10`；前缀短者更小）

零运行时依赖，仅用 Node.js 内置模块（`node:test`、`node:fs` 等）。TypeScript 源码，
`tsc` 编译为 CommonJS 后运行。

## 用法

```sh
npm run build                       # tsc -p tsconfig.json -> dist/
node dist/src/cli.js input.json     # 从文件读取图规格
cat input.json | node dist/src/cli.js --compact   # 或从 stdin 读取
```

### 输入格式（JSON）

```json
{
  "start": "A",
  "end": "F",
  "checkpoints": ["D"],
  "maxNodes": 12,
  "directed": false,
  "edges": [{ "from": "A", "to": "B", "cost": 2 }]
}
```

- `start` / `end` / `edges` 必填；`checkpoints` 默认 `[]`，`maxNodes` 默认 12，`directed` 默认 `false`。
- 路径按**节点序列**计：同一有序节点对之间的平行边只保留最小费用。
- `start === end` 时，单节点路径合法（费用为 0）。

### CLI 选项

`--max-nodes N`、`--checkpoints A,B`、`--directed` / `--undirected`（覆盖输入中的对应字段）、
`--compact`（单行输出）、`-h/--help`。

### 输出（见证 / witness）

```json
{
  "found": true,
  "witness": { "path": ["A", "B", "D", "F"], "nodeCount": 4, "maxEdgeCost": 2, "totalCost": 6 },
  "stats": { "simplePaths": 3, "feasiblePaths": 2 }
}
```

退出码：`0` 找到可行路径；`1` 无可行路径（仍输出 `found:false` 的 JSON）；`2` 用法或输入错误。

### 示例

```sh
$ node dist/src/cli.js examples/sample.json --compact
{"found":true,"witness":{"path":["A","B","D","F"],"nodeCount":4,"maxEdgeCost":2,"totalCost":6},"stats":{"simplePaths":3,"feasiblePaths":2}}
```

（`A-C-F` 总费更小但跳过检查点 `D`；`A-D-F` 经过 `D` 但瓶颈边为 9，故 `A-B-D-F` 胜出。）

## 算法

`src/solver.ts` 对起点做 DFS，枚举所有不超过 `maxNodes` 个节点的简单路径（访问集保证无重复
节点），过滤出经过全部检查点的路径，再按三级比较器取最优。`src/graph.ts` 负责输入校验。

## 测试

```sh
npm test    # tsc 编译 + node --test dist/test/*.test.js
```

- `test/solver.test.ts`：比较器、瓶颈优先、检查点、节点上限、有向/无向等单元测试；
  以及**小图穷举核对**：固定种子的 400 个随机小图（2–6 节点）上，用独立的
  “节点子集排列”暴力枚举交叉验证求解器的最优见证与路径计数完全一致，并逐条校验见证合法性
  （端点、节点上限、无重复节点、检查点覆盖、逐边费用重算）。
- `test/cli.test.ts`：进程内调用 CLI（沙箱禁止派生子进程），覆盖文件/stdin 输入、
  命令行覆盖、退出码 0/1/2。

### 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
# tests 2        # 两个测试文件
# pass 2
# fail 0

solver.test.js: 14/14 通过（含 400 个随机小图穷举核对）
cli.test.js:     5/5 通过
```
