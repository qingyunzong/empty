# symbol-impact-review

审查库：按符号引用图把改动映射到公开入口，并为每个受影响入口返回最短影响链。
纯 TypeScript + Node.js 内置库，零运行时依赖，输入图完全在内存中构建，不读网络、不读文件。

## 语义

- 图为有向引用图：边 `A -> B` 表示 "A 引用 B"，因此改动 B 会影响所有（传递）引用 B 的符号。
- 公开入口：构建图时以 `{ public: true }` 标记的符号。
- 改动集 `ChangeSet`：
  - `changed`：修改/新增符号，在**新图**上解析影响；
  - `deleted`：删除符号，在**旧图**上解析影响（新图中已不存在，仍保留旧图影响）。
- 报告为旧、新两图结果的**并集**：每个入口只保留一条最短链；
  长度并列时优先新图，再按链的字典序取最小，结果确定可复现。
- 影响链方向为 `entry -> ... -> trigger`（从入口到被改符号）。

## API

```ts
import { SymbolGraph, analyzeImpact, verifyReportByEnumeration } from "./src/index.js";

const oldGraph = new SymbolGraph();
oldGraph.addSymbol("main", { public: true });
oldGraph.addReference("main", "core");
oldGraph.addReference("core", "legacy");

const newGraph = new SymbolGraph();
newGraph.addSymbol("main", { public: true });
newGraph.addReference("main", "core");
newGraph.addReference("core", "fresh");

const report = analyzeImpact(oldGraph, newGraph, {
  changed: ["fresh"],
  deleted: ["legacy"],
});
// report.entries:
// [ { entry: "main", trigger: "fresh", chain: ["main", "core", "fresh"], source: "new" } ]
// 旧图 "legacy" 的链同为长度 3，并列时优先新图；若新图无此影响，则保留旧图链。
```

主要导出：

- `SymbolGraph`：`addSymbol` / `addReference` / `publicEntries` / `referencedBy`。
- `analyzeImpact(oldGraph, newGraph, changes)`：返回 `{ entries: ImpactChain[] }`，按入口排序。
- `shortestChainsToEntries(trigger, graph)`：单触发符号的 BFS 最短链（反向边遍历）。
- `enumerateChains(entry, trigger, graph, { maxPaths })`：枚举全部简单路径，仅限小图，
  超过 `maxPaths`（默认 100000）抛 `RangeError`。
- `verifyReportByEnumeration(oldGraph, newGraph, changes, report?)`：小图核对证据——
  对每个 (入口, 触发符号) 枚举全部简单路径，验证报告中的链长等于枚举最小值，
  且不存在遗漏或多报的入口。

## 测试

```sh
npm test
```

流程：`tsc` 编译到 `dist/` 后，以 Node 内置 `node:test` 运行编译产物。

实际运行结果（Node v22.22.1，tsc 7.0.2，2026-10-05）：

```
ok 1 - shortest chain per entry is reported
ok 2 - direct reference yields a two-node chain
ok 3 - deleted symbols keep their old-graph impact
ok 4 - report is the union of old- and new-graph impacts
ok 5 - union merge keeps the shortest chain across both graphs
ok 6 - equal-length chains prefer the new graph
ok 7 - symbols unreachable from any public entry produce no impact
ok 8 - unknown changed symbols are ignored without crashing
ok 9 - cycles do not hang and still yield the shortest chain
ok 10 - a changed public entry impacts itself
ok 11 - enumerateChains lists every simple path
ok 12 - enumeration guard rejects oversized graphs
ok 13 - BFS report matches exhaustive enumeration on random small graphs
ok 14 - hand-built small graph cross-checked by enumeration
# tests 14
# pass 14
# fail 0
```

其中用例 13 以固定种子生成 60 组随机小图（7 节点），逐组用
`verifyReportByEnumeration` 将 BFS 结果与全路径枚举核对，全部一致。

## 备注

- 本环境 Node 构建未启用类型剥离，故测试前先编译；`npm run typecheck` 可单独做类型检查。
- `types/node.d.ts` 为 `node:test` / `node:assert/strict` 的最小类型声明（环境无 `@types/node`，且不引入外部依赖）。
