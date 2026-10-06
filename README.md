# replica-sync

副本同步库：通过**二叉哈希树（Merkle trie）**比较同版本对象集合，只拉取存在差异的子树，输出最少必要的拉取计划。

## 协议

- 每个键经 SHA-256 映射为 256 位路径，按键哈希的每一位逐层分裂成二叉 trie。
- **叶节点**携带 `(key, valueHash)`；内部节点哈希由深度与左右子树哈希派生。
- 树形完全由键集合决定，因此两个副本可以逐节点比较：**哈希相等即内容相等**，不再深入；只有哈希不同的子树才会继续向远端拉取（内部节点响应自带子哈希，相同子树连一次 fetch 都不花）。
- 远端每个响应都带有**版本号**。分支的首次拉取会锚定一个版本；分支内后续响应版本不一致时，丢弃该分支已收集的部分结果果，从分支根**重新开始**；分支结束前还会复核一次分支根版本，防止最后一次拉取之后发生的变更漏网。

## 输出

`computePullPlan(remote, localEntries)` 返回：

```ts
interface PullPlan {
  version: number;   // 计划对应的远端版本
  pull: string[];    // 需要从远端拉取的键（新增或值已变化）
  remove: string[];  // 远端已不存在、本地应删除的键
}
```

该计划与 `fullMapDiff(local, remote)`（全 map 差异参考实现）逐键一致，由测试核验。

## 结构

- `src/merkle.ts` — 二叉哈希 trie 的构建与哈希计算
- `src/remote.ts` — `RemoteStore` 接口与带版本/变更钩子的内存实现
- `src/sync.ts` — 同步算法：子树剪枝、版本锚定与分支重启
- `src/diff.ts` — 全 map 差异参考实现（核验用）
- `test/sync.test.ts` — 单元测试 + 随机模糊测试

## 运行

```sh
npm test    # tsc 编译后运行 node:test 测试
```
