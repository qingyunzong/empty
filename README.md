# promise-cache

进行中 Promise 缓存：LRU 容量淘汰 + 世代隔离。TypeScript 编写，仅使用
Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 语义

- 缓存库存储**进行中**的 Promise（由 `loader(key)` 创建）。
- 条目在缓存期间，同键请求共享同一个 Promise（任务去重）。
- 容量超限按 LRU 淘汰最久未使用的条目；**淘汰不取消**底层 Promise，
  已有等待者仍会收到结果。
- Promise 落定（成功或失败）后条目从缓存移除——**失败即删除**，下一次
  同键请求会创建新任务（重试）。
- 每次创建任务分配递增**世代号**；落定回调仅当缓存中仍是同一世代条目时
  才删除，且**只删不插**——迟到结果无法把已淘汰世代重新插回缓存。
- 同键再请求（条目已被淘汰或已落定）创建全新任务与新世代。

## 运行

```sh
npm test   # = tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局安装）。本环境 Node 未编译
TypeScript 类型剥离支持，因此先由 `tsc` 编译到 `dist/` 再运行测试。
`types/node-shims.d.ts` 提供所需 Node 内置模块的最小类型声明（离线环境
无 `@types/node`）。

## 实际测试结果（2026-10-06）

`npm test` 退出码 0。测试文件直接运行的 TAP 输出：

```
ok 1 - in-flight requests for the same key share one task
ok 2 - LRU: touching a key protects it; the least-recently-used key is evicted
ok 3 - eviction does not cancel existing waiters
ok 4 - late result of an evicted generation is not re-inserted
ok 5 - failure deletes the entry; the next request creates a new task
ok 6 - success also removes the entry (in-flight cache); re-request creates a new task
ok 7 - generation isolation: re-request after eviction creates a new task; late old result cannot displace it
ok 8 - a synchronous throw from the loader becomes a rejection and frees the entry
ok 9 - capacity must be a positive integer
# tests 9
# pass 9
# fail 0
```

## 文件

- `src/promise-cache.ts` — `PromiseCache<K, V>` 实现
- `test/promise-cache.test.ts` — 基于可控（deferred）Promise 的测试
- `types/node-shims.d.ts` — Node 内置模块最小类型声明
