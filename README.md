# replica-sync

副本同步库：通过二叉哈希树（Merkle trie）比较同版本对象集合，只下钻哈希不同的子树，
输出最小必要的拉取计划，并以全 map 差异作为参考核验。

## 设计

- **树形**（`src/trie.ts`）：键按 `sha256(key)` 的比特前缀递归分组。深度 d 的节点聚合所有
  共享 d 比特前缀的键，因此两个副本对同一键集导出完全相同的树形，可按路径逐节点比对。
  叶子携带键与值哈希；内部节点哈希 = `sha256(左哈希 | 右哈希)`。
- **服务端**（`src/server.ts`）：`ReplicaServer` 模拟远端副本。每次写/删使 `version` 递增
  并重建哈希树。`getNode(path)` 为同步 RPC，响应始终携带当前版本。
- **同步**（`src/sync.ts`）：`computePullPlan(local, server)` 从根开始比对：
  - 哈希相同的子树直接跳过（除父节点的一次 RPC 外零开销）；
  - 每个分支在进入时钉住（pin）远端版本；若分支中途版本变更，抛出 `VersionChanged`
    并从该分支根重新开始；父分支发现子分支版本偏斜时同样向上重启；
  - 整轮结束后重取根做最终一致性校验，漂移则整体重试（有上限，持续抖动会报错而非死循环）；
  - 产出 `PullPlan { pull, remove, version, restarts, requests }`，`applyPullPlan` 应用后
    本地与远端收敛。
- **参考核验**（`src/reference.ts`）：`referenceDiff` 做全 map 对比，测试用它逐一核验
  树形同步产出的拉取计划完全相等。

## 运行

```sh
npm test   # tsc 类型检查 + 编译，然后 node --test 运行 dist/test
```

## 测试要点（`test/sync.test.ts`）

- 一致副本：空计划，仅根级 RPC（≤ 2 次）。
- 增/删/改混合：计划与全 map 参考差异完全相等，应用后收敛。
- 最小性：512 键中 10 个分叉叶子，仅 73 次 RPC（全遍历约 1023 个节点）。
- 中途版本变更：第 3 次 RPC 时注入并发写入，分支重启 ≥ 1 次，计划仍与最终参考一致。
- 持续抖动：超过重启上限后显式报错，不死循环。
