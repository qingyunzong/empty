# module-loader

TypeScript 模块加载库，仅依赖 Node.js 内置模块（`node:async_hooks`），无第三方运行时依赖。

## 特性

- **同 ID 请求合并**：同一模块的并发请求共享同一个 in-flight Promise，加载器只执行一次。
- **依赖链跟踪与环检测**：通过 `AsyncLocalStorage` 跟踪当前加载路径上的依赖链。
  请求出现在当前链中时抛出 `CycleError`，报告**最短字典序环**
  （链上节点唯一，从重复节点起即为最短环；再旋转到字典序最小节点开头，如 `b -> c -> b`）。
- **共享请求不互等**：环检测只针对当前依赖链；链外对 in-flight 模块的请求直接共享其
  Promise，不会误判为环，也不会互相等待造成死锁（菱形依赖场景验证）。
- **按代清除缓存**：每次顶层 `load()` 开启一个新一代（generation），该代创建的缓存记录
  都打上代数标记。本次加载失败时只清除该代记录，更早代已缓存的模块不受影响，可直接重试。

## 结构

- `src/loader.ts` — `ModuleLoader` / `CycleError` 核心实现
- `src/controlled-loader.ts` — 可控加载器 `ControlledLoader`（可编排依赖、失败次数、手动闸门 `Gate`）
- `test/loader.test.ts` — 基于 `node:test` 的测试
- `types/node-shims.d.ts` — 所用 Node 内置模块的最小类型声明（环境无 `@types/node`）

## 用法

```ts
import { ModuleLoader } from './src/loader.js';

const loader = new ModuleLoader(async (id, require) => {
  const source = await readFile(id);
  const deps = parseDeps(source);
  const depValues = await Promise.all(deps.map((d) => require(d)));
  return evaluate(source, depValues);
});

await loader.load('entry'); // 并发相同 id 自动合并；成环抛 CycleError
```

## 测试

```sh
npm test   # tsc 编译后运行 dist/test 下的 node:test 测试
```

## 实测结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），2026-10-05 实际执行 `npm test`：

```
ok 1 - concurrent same-id requests merge into a single load
ok 2 - diamond sharing: shared module loads once, waiters never block each other
ok 3 - self dependency reports a one-node cycle
ok 4 - cycle error reports the shortest loop in lexicographic order
ok 5 - cycle failure evicts the batch so a fixed graph can be retried
ok 6 - a failed load evicts only its own generation from the cache
ok 7 - shared failure reaches every waiter and the retry reloads once
ok 8 - dependency values propagate to the parent module
# tests 8
# pass 8
# fail 0
```

覆盖场景：

- **菱形共享**：`a -> [b, c]`，`b/c -> d`，`d` 被闸门挂起期间 `b`、`c` 均已发起请求，
  `d` 只加载一次，无误判环、无死锁。
- **环**：自环报 `a -> a`；`x -> c -> b -> c` 检测到的环剔除前缀 `x` 并归一化为
  字典序最小的 `b -> c -> b`。
- **失败后重试**：失败只清除该代缓存——旧代模块 `k` 不重载，同代成功的兄弟模块 `ok`
  随失败代一起被清除并重新加载；修复依赖图或失败次数用尽后重试成功。
