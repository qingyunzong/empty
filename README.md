# incremental-build-cache

一个记录「文件 → 产物」依赖关系的增量构建缓存库。TypeScript 编写，仅使用
Node.js 内置模块（`node:test` / `node:assert` / `node:crypto` / `node:fs` /
`node:util`），零运行时依赖。

## 特性与对应实现

- **依赖记录**：每次任务成功发布后，`BuildCache.graph`（`src/graph.ts`）记录
  产物的完整依赖集（文件与其他产物），连同读入时观察到的版本一起存入
  `CacheEntry.deps`。
- **批量改动只失效反向可达闭包**：`invalidate(changed)` 在反向依赖边上做
  BFS（`DependencyGraph.reverseClosure`），只驱逐闭包内的缓存项，其余产物
  保持缓存。
- **依赖可在重建中变化**：每次发布都用最新发现的依赖集整体替换旧边
  （`recordDependencies`），旧依赖随即不再触发失效（见
  `test/rebuild.test.ts`）。
- **旧任务结果须核对输入版本才发布**：任务跑完后、发布前，逐一比对帧内记录
  的 `(dep, version)` 与当前版本（`Session.depsConsistent`）；不一致则丢弃
  结果并重跑，最多 `maxRetries` 次。循环组整组核对、整组发布（同一版本戳）。
- **允许循环依赖并给环证据**：构建栈上检测到回边时抛出 `CycleSignal`，由环
  首帧捕获并对整环做定点迭代（初值取缓存值 / 回收值 / `seed`），收敛后整组
  发布。环证据为具体依赖路径 `[k0, k1, …, k0]`，可从
  `cache.lastCycles()`、`cache.graph.cycles()` 与 `verify()` 报告取得。
- **全图重算核对增量结果**：`verify()` 在影子会话中忽略缓存、从零重算所有
  缓存键（含环的定点迭代），逐项比对值与依赖集，报告
  `value` / `deps` / `missing-in-cache` / `missing-in-recompute` /
  `recompute-error` 等不一致，且不影响现有缓存。

## API 摘要

```ts
const cache = new BuildCache(store);            // store: MemoryFileStore | FsFileStore
cache.define("bundle", async (ctx) => {
  const cfg = ctx.readFile("config");           // 记录文件依赖（含版本）
  const dep = await ctx.read("other-artifact"); // 记录产物依赖
  return ...;
}, { seed: () => initial, equals: (a, b) => ... });
await cache.build("bundle");                    // 增量构建
cache.invalidate(["config", "src/x"]);          // 批量失效：仅反向可达闭包
cache.lastCycles();                             // 上次构建遇到的环（含证据路径）
await cache.verify();                           // 全图重算核对 → VerifyReport
```

注意：循环依赖的任务在冷启动（无缓存值）时需要提供 `seed`；定点迭代在
`maxCycleIterations` 内不收敛会报错并指出环。

## 运行测试

```
npm test    # = tsc 编译到 dist/ 后用 node --test 运行
```

## 实际测试结果

以下为本仓库 `npm test` 的真实输出（Node v22.22.1，tsc 7.0.2，2026-10-05）：

```
> incremental-build-cache@0.1.0 test
> npm run build && node --test "dist/test/*.test.js"

ok 1 - dist/test/cycle.test.js
ok 2 - dist/test/graph.test.js
ok 3 - dist/test/invalidate.test.js
ok 4 - dist/test/rebuild.test.js
ok 5 - dist/test/verify.test.js
# tests 5
# suites 0
# pass 5
# fail 0
```

逐用例结果（`node --test-reporter=spec`，21 个用例全部通过）：

```
✔ cyclic dependencies
  ✔ cycles are allowed and computed to a fixpoint
  ✔ cycle evidence is a concrete dependency path
  ✔ invalidating one member's input evicts the whole cycle
  ✔ stale cyclic groups rebuild as a unit even without invalidate()
  ✔ cold-start cycle without a seed fails with a clear error
  ✔ non-converging cycles fail with the cycle in the message
✔ DependencyGraph
  ✔ recordDependencies replaces outgoing edges
  ✔ reverseClosure walks reverse edges transitively
  ✔ batch closure unions multiple changed keys
  ✔ cycles() reports members and a valid evidence path
  ✔ acyclic graphs report no cycles
✔ batch invalidation
  ✔ only the reverse-reachable closure is evicted
  ✔ unchanged inputs keep results cached across builds
✔ dependencies may change across rebuilds
  ✔ discovered deps replace the old edge set
✔ version check before publish
  ✔ a result computed from inputs that changed mid-build is not published
  ✔ gives up after maxRetries when inputs never stabilize
  ✔ stale cache entries are detected via input versions even without invalidate()
✔ full-graph recomputation check
  ✔ clean incremental state verifies ok
  ✔ stale values caused by untracked state are detected
  ✔ dependency-set drift is detected
  ✔ verify() leaves the incremental cache untouched
  ✔ verify() reports cycles with evidence
```

## 目录结构

- `src/graph.ts` — 依赖图：反向闭包、Tarjan SCC、环证据路径
- `src/cache.ts` — 构建引擎：版本核对发布、环定点迭代、全图核对
- `src/store.ts` — 版本化文件存储（内存版 / 真实文件系统版）
- `test/` — `node:test` 测试（上述 21 个用例）
- `types/node.d.ts` — 所用 Node 内置模块的最小类型声明（环境无 @types/node）
