# recon-anti-entropy

对账反熵快照库与 CLI（Node.js 22，仅标准库 + node:test）。

对账记录含 `id`、`amountA`/`amountB`、`status`（`open`/`resolved`）。删除生成墓碑；
快照带有纪元（Lamport 时钟）与按记录 ID 排序计算的 Merkle 式摘要，并附可复核证书。

## CLI

```
node cli.js --state <state.json> [--replica <name>] <command> [args]
```

- `upsert '{"id":"r1","amountA":10,"amountB":10}'` 新增/更新记录（对已墓碑化的 id 报 `stale-resurrect`）
- `resolve <id>` 将记录置为 `resolved`
- `delete <id>` 删除记录并生成墓碑
- `diff <snapshot-file>` 比较本地状态与对方快照摘要，输出 `missingRecords` / `missingTombstones` / `divergent`
- `merge <snapshot-file>` 合并对方快照（反熵修复），输出新纪元、摘要与 `conflicts`
- `snapshot [out-file]` 输出/写入快照（含 `certificate`，有冲突时 `valid: false`）
- `verify <snapshot-file>` 复核快照证书（重算 Merkle 根）

输入输出均为 JSON；错误输出 `{"error":"code"}` 且退出码为 1
（`not-found` / `invalid-input` / `invalid-snapshot` / `stale-resurrect` / `io-error` / `unknown-command`）。

## 合并规则

- 墓碑观察到的记录版本（`observedRecordSeq`）覆盖对方旧副本：删除传播，双方收敛。
- 未观察墓碑的陈旧新增/更新（`birth` 不符或删除后的非 resolve 变更）：`stale-resurrect`，不复活。
- 并发 `resolve` 与 `delete` 互不观察：双方记录 `resolve-delete` 冲突，记录与墓碑共存，
  摘要一致但快照证书 `valid: false`。

## 测试

```
node --test --test-reporter spec
```

`test/merkle.test.js` 用独立实现的小规模树哈希，对三条记录的全部
增/删/解决组合（4^3 = 64 种状态）枚举对照库内摘要。
