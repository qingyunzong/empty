# recon-anti-entropy

对账反熵快照库与 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 数据模型

- 记录：`{ id, amountA, amountB, status }`，`status` 为 `open` / `resolved`（双方金额）。
- 删除生成墓碑（tombstone），墓碑与记录共享同一 ID 命名空间。
- 每个副本维护版本向量（VV）；每次写操作推进本副本时钟，记录/墓碑携带写入时的 VV 作为因果前沿。
- 快照：纪元（epoch = VV 分量之和）+ 按记录 ID 排序的 Merkle 式摘要
  （叶子 `sha256("leaf:"+canonicalJSON)`，奇数节点复制，内部节点 `sha256("node:"+l+r)`）。
- 快照证书：含算法、纪元、摘要、叶子列表与 `valid` 标志；存在未解冲突时 `valid: false`。
  `verifyCertificate` 可独立复核证书（重算叶子哈希与 Merkle 根）。

## CLI

```sh
node cli.js upsert <state.json> <id> <amountA> <amountB>
node cli.js resolve <state.json> <id>
node cli.js delete  <state.json> <id>
node cli.js diff    <state.json> <snapshot.json>   # 输出本地缺失的记录与墓碑 ID
node cli.js merge   <state.json> <remote.json>     # remote 可为副本状态或快照文件
node cli.js snapshot <state.json>                  # 输出快照与可复核证书
```

输出均为单行 JSON。错误输出 `{"error":"code"}` 且退出码为 1：
`usage`（参数错误）、`not-found`（记录不存在）、`stale-resurrect`（陈旧重放）。

## 反熵语义

- `diff` 比较两个快照的叶子哈希，输出 `missingRecords` / `missingTombstones`。
- `merge` 按 VV 支配关系合并；并发写按确定性规则（resolved 优先，再按金额字典序）收敛。
- 已删除记录的陈旧新增（未观察墓碑）被单条拒绝并记入 `stale`，不会复活；
  其余条目正常合并，保证反熵收敛。CLI 此时输出 `{"error":"stale-resurrect"}`、退出码 1。
- 并发 `resolve` 与 `delete` 互不观察：删除获胜，双方记录
  `conflict`（`concurrent-resolve-delete`），快照证书 `valid: false`。
- 观察到墓碑之后的重新新增是合法的，会取代墓碑并随合并传播。

## 测试

```sh
node --test --test-reporter spec
```

- `test/merkle.test.js`：独立小规模树哈希对照（含已知 sha256 向量）。
- `test/replica.test.js`：三条验收场景（缺记录/墓碑修复、陈旧重放拒绝、并发冲突证书 invalid）。
- `test/enumeration.test.js`：三条记录的全部增删/解决组合枚举（每副本 6^3 = 216 种脚本，
  两副本共 46656 组，另加并发不同写变体 4096 组），验证双向修复后条目、摘要、纪元、
  冲突与证书完全一致。
- `test/cli.test.js`：CLI 端到端流程与错误格式/退出码。
