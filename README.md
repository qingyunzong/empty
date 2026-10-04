# dag-bisect

诊断库：输入版本 DAG 与实际好坏检测适配器，在查询预算内定位所有
"父版本全部为好" 的坏版本边界（first-bad frontier）。允许非单调结果
（坏版本的子版本可以重新变好），检测异常记为未决（pending），
预算耗尽时保留未测集合，输出完整查询证据，并可与全 DAG 检测核对。

仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），无运行时依赖。

## 核心概念

- **输入**：`Dag { nodes, parents }`（父引用必须已知且无环）与
  `Detector = (version) => 'good' | 'bad' | 'pending' | Promise<...>`。
- **边界（boundary）**：检测结果为 `bad` 且所有父版本均为 `good` 的版本；
  无父版本的坏根版本也算边界。
- **非单调**：不跳过坏版本的子版本，拓扑序逐层探测。
- **未决（pending）**：检测器抛异常或返回非法值 → 记为 `pending`，
  计入预算并写入证据（含错误信息）。
- **预算**：`budget` 耗尽后剩余版本进入 `untested`；所有无法判定是否
  属于边界的版本进入 `candidates`。
- **核对**：`fullDagScan` 无预算探测全部版本得到精确边界，
  `crossCheck` 验证预算报告的边界是精确边界的子集，且精确边界中
  未被确认的版本必须已列入 `candidates`（否则报告 missing）。

## API

```ts
import { bisectDag, fullDagScan, crossCheck } from './src/index.js';

const report = await bisectDag(dag, detect, { budget: 10 });
// report: { boundary, pending, untested, candidates, queries, budget, used }

const exact = await fullDagScan(dag, detect);
const check = crossCheck(report, exact);
// check.ok / check.extra / check.missing / check.explainedByCandidates / check.summary
```

## 测试

```
npm test    # tsc 编译后运行 dist/test/*.test.js
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - linear chain with non-monotonic results finds every first-bad boundary
ok 2 - merge: bad version with a bad parent is not on the boundary
ok 3 - multiple roots: a bad root is a boundary version
ok 4 - detector exception becomes pending evidence and child stays a candidate
ok 5 - budget keeps the untested set and flags unresolved candidates
ok 6 - full budget cross-check confirms the exact boundary
ok 7 - cross-check exposes a flaky detector contradicting the report
ok 8 - query evidence is sequential and in topological order
ok 9 - invalid DAGs are rejected
ok 10 - invalid detector output is treated as pending with evidence
ok 11 - zero budget probes nothing and keeps every version untested
# tests 11
# pass 11
# fail 0
```

注：本环境无网络，`@types/node` 不可安装，`types/node-shim.d.ts`
仅为测试所用的 Node 内置模块提供最小类型声明；运行时零依赖。
