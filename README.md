# tenant-generation-cache

缓存库：有效键为 `(tenant, generation, key)`。权限修改原子切换命名空间，
旧代际的在途结果不会发布到新空间，等待者只取其所附着代际的结果。
仅使用 TypeScript 与 Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 设计

- **键含租户与代际**：命名空间 = `tenant + generation`，键在此命名空间内唯一。
- **原子切换命名空间**：`setPermissions` / `revokePermissions` 在一次同步调用内
  完成代际递增、权限集替换、旧命名空间丢弃；调用返回后所有后续查找即指向新空间。
- **旧在途结果不发布**：`getOrLoad` 在 loader 启动时捕获代际 N，settle 时仅当
  当前代际仍为 N 才写回缓存；否则结果被丢弃，绝不落入 N+1 命名空间。
- **等待者只取原代结果**：同一 `(namespace, key)` 的在途 Promise 被所有等待者共享；
  代际切换不影响已附着的 Promise，等待者仍收到原代际 loader 的结果。
- **淘汰**：每个命名空间内 LRU（`maxEntriesPerNamespace`），并支持 `evict` 显式删除；
  淘汰与撤销均只作用于当前代际。

## API

- `getOrLoad(tenant, key, loader): Promise<V>` — 命中缓存 / 加入在途 / 启动加载。
- `get` / `getEntry` / `has` / `size` — 当前代际命名空间的查询。
- `evict(tenant, key)` — 显式淘汰当前代际中的单个键。
- `setPermissions(tenant, perms)` / `revokePermissions(tenant)` — 原子切换命名空间。
- `generationOf` / `permissionsOf` — 观测当前代际与权限集。

## 测试

测试通过可控 Promise（`deferred`，见 `src/deferred.ts`）精确控制 loader 的
settle 时机，覆盖：同名跨租户隔离、权限修改原子切换、旧在途结果不发布、
等待者只取原代结果、权限撤销后强制重载、LRU 与显式淘汰、失败后重试。

```sh
npm test   # tsc 编译后运行 node --test
```

注：环境无法访问 npm registry，`types/node-shim.d.ts` 为所用 Node 内置模块的
最小 ambient 类型声明，替代 `@types/node`。

## 实际运行结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05。

`npm test` 输出：

```
> tenant-generation-cache@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/cache.test.js
ok 1 - dist/test/cache.test.js
  ---
  duration_ms: 197.662793
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 211.707915
```

逐用例明细（`node dist/test/cache.test.js`）：

```
ok 1 - same key name is isolated across tenants
ok 2 - permission change atomically switches namespace
ok 3 - stale in-flight result is not published into the new namespace
ok 4 - waiters only observe the result of the generation they attached to
ok 5 - permission revocation drops cached entries and requires reload
ok 6 - lru eviction within a namespace and explicit evict
ok 7 - rejected load clears in-flight state so a retry can proceed
# tests 7
# pass 7
# fail 0
```
