# depfix — 依赖修复 CLI

对至多 **18 条边**的依赖图，求**最低费用删边方案**使图无环，同时满足：

- **已锁边不可删**（`locked: true`）；若锁定边本身成环，直接判定无解并输出该**不可删环**作为证据；
- **入口→出口可达性保留**：所有 `entries × exits` 及 `preserve` 指定的关系在删边后必须仍可达，并为每个保留关系输出**路径证书**；
- **包组前置**：删除某组的任意边，必须同时删除其 `requires` 组的**全部**边；若被前置的组含锁边，则该组的边传递性地变为不可删；
- **预算**：删边总费用不得超过 `budget`。

输出剩余图的**拓扑序**与删边证明（最优性由分支定界给出，并可用**全子集枚举**独立核验，`check` 子命令会重新枚举全部子集验证最优性与全部约束）。

仅使用 TypeScript + Node.js 内置库，零 npm 依赖（`src/node-shims.d.ts` 为所用内置 API 的最小类型声明）。

## 输入格式（JSON）

```json
{
  "nodes": ["a", "b", "c"],
  "edges": [
    { "id": "ab", "from": "a", "to": "b", "cost": 2, "locked": false, "group": "core" }
  ],
  "entries": ["a"],
  "exits": ["c"],
  "preserve": [{ "from": "a", "to": "c" }],
  "budget": 10,
  "groups": { "plugin": { "requires": ["core"] } }
}
```

- `cost`：删边费用，非负整数，默认 1；`locked` 默认 `false`；`group` 可选。
- `groups.<g>.requires`：删除组 `g` 的任意边 ⇒ 必须删除每个前置组的全部边。
- 边数 > 18 直接报错。

## 命令

```bash
npm run build                                  # tsc 编译到 dist/
node dist/src/cli.js solve  in.json [--out sol.json] [--verify]
node dist/src/cli.js verify in.json [--solution sol.json]
node dist/src/cli.js check  in.json sol.json
```

- `solve`：分支定界求最优。输出 `deletedEdges`、`totalCost`、`topologicalOrder`、
  `preservedPaths`（每条保留关系的路径证书）与 `proof`（搜索统计；`--verify` 时附枚举核对结果）。
  无解时输出原因：不可删环（含环见证）、预算不足（含放宽预算后的最小费用）、或结构性不可行。
- `verify`：穷举全部 `2^m` 个删边子集（m = 可删边数），报告最优费用并与给定解比对。
- `check`：独立核验解文件——锁边/费用/预算/包组前置/无环性/拓扑序/路径证书全部重查，
  并重新枚举全部子集确认最优性。

退出码：`0` 成功/最优，`1` 无解，`2` 用法或输入错误，`3` 核验失败。

## 算法

- 可删边 ≤ 18 ⇒ 解空间 ≤ 2^18 = 262144，枚举核对为毫秒级。
- 分支定界逐边决策（保留/删除），剪枝：费用界、预算、已保留边成环、
  保留+未决超图中入口→出口不可达、包组前置冲突；贪心破圈提供初始 incumbent。
- 平局裁决确定性：费用升序 → 删边数升序 → 位掩码升序，分支定界与枚举结果一致。

## 测试

```bash
npm test    # tsc 编译 + node --test，共 27 个用例
```

覆盖：最优删边、锁边环、可达性约束、预算、包组前置（含传递不可删）、输入校验、
40 个随机种子图上分支定界 vs 枚举交叉验证、证书核验（接受/各类篡改拒绝）、CLI 端到端。
实际运行结果见 [RESULTS.md](RESULTS.md)。
