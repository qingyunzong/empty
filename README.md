# promise-lru-cache

进行中 Promise 的 LRU 缓存（TypeScript + Node.js 内置库，零运行时依赖）。

## 语义

- **进行中去重**：同键并发请求共享同一个进行中 Promise，`loader` 只触发一次。
- **LRU 淘汰**：容量超限淘汰最久未使用的条目；命中会刷新其热度。
- **淘汰不取消**：淘汰只删除索引，不取消 Promise，已持有它的等待者照常收到结果。
- **世代隔离**：每个条目携带 `token` 世代令牌；已淘汰世代的迟到结果不会写回缓存，
  迟到失败也不会误删同键的新世代条目。
- **同键再请求创建新任务**：条目被淘汰或失败后，同键再请求会调用 `loader` 创建新世代。
- **失败删除**：Promise 拒绝时，仅当该条目仍是当前世代才从缓存删除，后续请求可重试。
- **成功留存**：已成功的 Promise 留在缓存中，后续同键请求直接复用结果。

## 结构

- `src/promise-cache.ts` — `PromiseCache<K, V>` 实现（`Map` 插入序即 LRU 顺序）
- `src/deferred.ts` — 可控 Promise（`deferred<T>()`，外部手动 `resolve`/`reject`）
- `test/promise-cache.test.ts` — `node:test` + `node:assert/strict` 测试
- `types/node-shims.d.ts` — 最小 Node 内置模块类型声明（环境无 `@types/node`）

## 运行

```sh
npm test   # tsc 编译到 dist/ 后逐个执行 dist/test/*.test.js
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 `tsc`）。`npm test` 退出码 0，输出：

```
ok 1 - 同键并发请求共享同一个进行中 Promise
ok 2 - 容量超限按 LRU 淘汰最久未使用的条目
ok 3 - 淘汰不取消已有等待者
ok 4 - 同键再请求创建新任务，且迟到结果不会重新插回已淘汰世代
ok 5 - 已淘汰世代的迟到失败不会误删新世代条目
ok 6 - 失败删除条目，同键再请求创建新任务
ok 7 - 成功结果留在缓存中，后续请求不再触发加载
ok 8 - 缓存大小永不超过容量
ok 9 - 非法容量直接抛错
1..9
# tests 9
# pass 9
# fail 0
```

> 注：本机 Node 22.22.1 的 `node --test <file>` 只汇总到文件级（`tests 1`），
> 因此 `npm test` 直接执行编译后的测试文件，逐条输出 9 个用例且失败时退出码为 1。
