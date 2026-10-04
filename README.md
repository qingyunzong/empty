# incremental-build-cache

依赖跟踪的增量构建缓存库。TypeScript 编写，仅使用 Node.js 内置模块
（`node:crypto` / `node:fs` / `node:test` / `node:assert`），无第三方运行时依赖。

## 特性与需求对应

| 需求 | 实现 |
| --- | --- |
| 记录文件到产物的依赖 | `DepGraph` 维护 产物→依赖 与 依赖→产物 双向边；任务运行时通过 `ctx.read/depend` 自动捕获依赖（`src/cache.ts`） |
| 批量改动只失效反向可达闭包 | `setSource` 累积 pending 变更，`invalidate()` 对变更集合求反向可达闭包，仅将闭包内的产物标记为 dirty（`src/graph.ts` `reverseClosure`） |
| 依赖可在重建中变化 | 每次重建后用新捕获的依赖集替换旧边（`graph.setDeps`），旧边立即停止失效传播 |
| 旧任务结果须核对输入版本才发布 | `ensure()` 发布缓存记录前，逐一重核记录中每个输入的版本，任一不匹配即重建 |
| 允许循环依赖并给环证据 | 环上任务以过期/占位版本互引，经定点迭代收敛；`cycles()` 用 Tarjan SCC + 路径重建给出有序环证据（如 `A -> B -> A`）；不收敛时报错并附环证据 |
| 全图重算核对增量结果 | `verify()` 清空派生状态后从零重算全部目标，逐一比对版本，报告不一致项 |

## 使用

```ts
import { BuildCache } from "./src";

const cache = new BuildCache();
cache.setSource("cfg", "x");            // 或 setSourceFile("cfg", path)
cache.setSource("x", "x0");
cache.registerTask("T", (ctx) => {
  const name = ctx.read("cfg") as string; // 声明依赖并读取
  return `T=${ctx.read(name)}`;           // 依赖可在重建间变化
});

cache.build("T");        // => "T=x0"
cache.setSource("x", "x1");
cache.build("T");        // 仅反向闭包 {x, T} 失效，T 重建 => "T=x1"
cache.cycles();          // 环证据，如 [["A", "B", "A"]]
cache.verify();          // 全图重算核对 => { consistent: true, mismatches: [], ... }
```

## 测试

```sh
npm test    # tsc 编译后运行 node --test
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出（文件级汇总）：

```
> incremental-build-cache@0.1.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/cache.test.js
ok 1 - dist/test/cache.test.js
1..1
# tests 1
# pass 1
# fail 0
```

逐用例明细（`node dist/test/cache.test.js`，即 npm test 执行的同一文件）：

```
ok 1 - cached results are published only after input-version checks
ok 2 - batch changes invalidate only the reverse-reachable closure
ok 3 - dependencies may change during rebuild; stale edges stop invalidating
ok 4 - cyclic dependencies converge and cycle evidence is reported
ok 5 - non-convergent cycles fail with cycle evidence
ok 6 - full-graph recompute verifies incremental results
ok 7 - full-graph recompute detects non-reproducible tasks
ok 8 - tracks file-to-artifact dependencies via the filesystem
# tests 8
# pass 8
# fail 0
```

8/8 通过。

## 布局

- `src/graph.ts` — 依赖图：反向闭包失效、Tarjan SCC、环证据路径重建
- `src/cache.ts` — `BuildCache`：版本化源、发布前版本核对、定点收敛、全图重算校验
- `src/index.ts` — 公共导出
- `test/cache.test.ts` — 8 个用例覆盖全部需求
- `types/node.d.ts` — 所用 Node 内置模块的最小类型声明（环境无 @types/node）
