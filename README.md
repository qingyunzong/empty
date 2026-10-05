# tombstone-sync-store

同步对象库：删除留墓碑、活文档引用墓碑报阻塞、全副本确认 + 无历史根引用方可 GC、
乱序合并与快照释放不复活对象、不删仍可达墓碑。仅使用 TypeScript + Node.js 内置库
（`node:test` / `node:assert`），零运行时依赖。

## 语义

- **墓碑删除**：`ReplicaStore.delete(id)` 移除对象值但保留墓碑（含 Lamport 版本），
  删除不存在的对象同样留墓碑，防止迟到的旧 `put` 乱序复活对象。
- **阻塞引用**：活文档 `Document.attach(id)` 引用墓碑对象时抛
  `BlockedReferenceError`；引用未知对象抛 `UnknownObjectError`。
  若删除发生在引用之后，`Cluster.blockedReferences()` 报告这些活文档阻塞项。
- **垃圾回收**：`Cluster.collectGarbage()` 仅在同时满足以下条件时物理清除墓碑——
  1. 全副本确认：每个副本的删除高水位均已覆盖该墓碑版本；
  2. 无任何历史根（文档快照）引用；
  3. 无任何活文档引用（仍可达的墓碑不得删除）。
- **乱序合并**：操作按 `(lamport, origin)` 全序做 last-writer-wins；过期 `put`
  无法覆盖较新的墓碑。GC 清除墓碑后仍保留高水位，迟到的旧操作同样无法复活对象。
- **快照释放**：`Document.releaseSnapshot(name)` 解除历史根；多个快照时仅全部释放
  后墓碑才可回收。

## 结构

- `src/version.ts` — Lamport 时钟与版本全序比较
- `src/store.ts` — 单副本对象库（对象、墓碑、高水位、LWW 合并）
- `src/document.ts` — 文档（活引用 + 历史快照根）
- `src/cluster.ts` — 集群（副本同步、阻塞报告、GC 判定）
- `src/errors.ts` — `BlockedReferenceError` / `UnknownObjectError`
- `types/node-shim.d.ts` — `node:test` / `node:assert` 的最小类型声明（环境无 `@types/node`）

## 测试

```sh
npm test   # tsc 编译后用 node --test 运行 dist/test/*.test.js
```

### 实际运行结果（Node v22.22.1，2026-10-05）

```
ok 1 - dist/test/document.test.js
ok 2 - dist/test/gc.test.js
ok 3 - dist/test/merge.test.js
ok 4 - dist/test/store.test.js
# tests 4
# pass 4
# fail 0
```

共 17 个子测试全部通过：

- `store.test.js`（3）：删除留墓碑、删除不存在对象留墓碑、重复删除幂等
- `document.test.js`（4）：活引用正常、引用墓碑抛阻塞、未知对象报错、快照冻结/释放
- `merge.test.js`（4）：delete 先到旧 put 不复活、乱序收敛、新版本 put 合法生效、并发写收敛
- `gc.test.js`（6）：部分副本未确认保留、全确认无引用回收、快照引用保留/释放后回收、
  活文档可达不删并报阻塞、多快照部分释放仍保留、GC 后迟到旧 put 不复活
