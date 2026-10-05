# generation-cache

以「租户 + 资源 + 代际」为命名空间的缓存库。权限修改通过 `revoke()` 原子切换到新命名空间（代际 +1），旧代在途加载的结果只发布到其所属的旧命名空间，绝不进入新空间；在途等待者只拿到其原代的结果。

仅使用 Node.js 内置模块（`node:test`、`node:assert`），无运行时依赖。TypeScript 源码经 `tsc` 编译后运行。

## 设计

- **键结构**：完整缓存键为 `(tenant, resource, generation, key)`。`tenant + resource` 决定作用域，`generation` 是该作用域内命名空间的版本。
- **原子切换**：`revoke(tenant, resource)` 在单次同步操作内用全新空命名空间替换当前命名空间（无 `await`，无竞态窗口），返回新代际号。
- **在途隔离**：`get()` 启动加载时捕获当前命名空间对象，完成后只向该捕获对象发布。撤销后旧命名空间不可达，旧结果自然无法进入新空间。
- **等待者语义**：并发 `get()` 共享同一代际的在途 Promise；撤销不影响已加入的等待者，它们仍收到原代结果。
- **淘汰**：支持 TTL（可注入时钟）、每命名空间 LRU 容量上限、`evict()` 显式逐出。

## API

```ts
const cache = new GenerationCache({ ttlMs: 60_000, maxEntriesPerNamespace: 100 });

const value = await cache.get("tenant-a", "invoice", "id-1", () => loadFromDb());

cache.revoke("tenant-a", "invoice");   // 权限变更：原子切到 generation 1
cache.generation("tenant-a", "invoice"); // => 1
cache.evict("tenant-a", "invoice", "id-1");
```

`deferred()`（`src/deferred.ts`）提供可控 Promise，用于测试或手动协调在途加载。

## 测试

```
npm test
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0：

```
ok 1 - 同名资源跨租户隔离：键含租户，互不可见
ok 2 - 并发获取去重：同一在途加载只执行一次
ok 3 - 权限撤销原子切换命名空间：旧缓存对新代不可见
ok 4 - 旧在途结果不得发布到新命名空间
ok 5 - 等待者只取原代结果，撤销后新读者取新代结果
ok 6 - 撤销不影响其他租户的命名空间
ok 7 - TTL 到期淘汰
ok 8 - LRU 容量淘汰：超出上限逐出最久未用条目
ok 9 - evict 显式淘汰当前代条目
ok 10 - 加载失败：错误传播给所有等待者且不写入缓存
# tests 10
# pass 10
# fail 0
```

## 环境说明

- 本机 Node 构建未启用 TypeScript 类型擦除，故 `npm test` 先以全局 `tsc`（7.0.2）编译到 `dist/` 再用 `node --test` 运行。
- 沙箱无网络，`@types/node` 不可用；`types/node-shim.d.ts` 提供测试所需的最小 `node:test` / `node:assert/strict` 类型声明。
