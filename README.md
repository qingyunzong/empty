# exp-rebase

实验脚本历史的变基库与 CLI。单机离线，Node.js 22，仅使用标准库与 `node:test`。

## 数据模型

仓库文件（JSON）：

```json
{
  "commits": {
    "<hash>": {
      "parent": "<parentHash|null>",
      "number": 3,
      "patch": [ { "op": "set", "path": "data.a", "value": 1 } ],
      "context": "<parentTreeHash>"
    }
  },
  "branches": { "main": "<hash>", "feature": "<hash>" }
}
```

- 每个提交包含父哈希 `parent`、补丁 `patch`、上下文快照哈希 `context`（父树规范 JSON 的 SHA-256）和实验编号 `number`。
- 提交哈希 = `{parent, number, patch, context}` 规范序列化后的 SHA-256。

补丁操作（作用于 JSON 树，路径为点分隔）：

| op        | 字段                     | 冲突条件                                     |
| --------- | ------------------------ | -------------------------------------------- |
| `set`     | `path`, `value`          | 无（纯 upsert）                              |
| `del`     | `path`                   | 路径在新上下文中不存在                       |
| `move`    | `from`, `to`             | 被移动记录在主干上已被移动或删除             |
| `replace` | `path`, `old`, `new`     | 依赖的旧值与新上下文不一致                   |
| `check`   | `path`, `value`          | 依赖的现值与新上下文不一致                   |

## CLI

```sh
node src/cli.js rebase --repo repo.json --branch feature --onto main --outdir out/
```

- 将 `feature` 上不属于 `onto` 祖先的提交按序重放到 `main` 的尖端，重写父哈希与提交哈希，保留原始实验编号映射。
- 成功时原子写出 `out/rebased.json`（新提交序列与新尖端）与 `out/mapping.json`（旧哈希 → `{number, newHash, collapsed}`，另附编号 → 新哈希索引）。
- 空补丁提交被折叠（不产生新提交），但映射仍保留，`collapsed: true` 且 `newHash` 指向上一个保留提交。
- 上下文冲突（依赖的旧值/路径/被移动记录在主干已变化）时变基停止，**不写出任何部分新历史**，退出码 1。
- 结构错误（循环祖先、断裂父链、重复编号）同样退出码 1，错误信息输出到 stderr。

## 库

- `src/hash.js` — 规范 JSON 序列化与 SHA-256（树哈希、提交哈希）。
- `src/tree.js` — 点路径的 `get/has/set/del` 与深拷贝。
- `src/patch.js` — 补丁应用与 `ConflictError`。
- `src/repo.js` — 仓库校验（循环祖先、断裂父链、重复编号）与 `treeAt` 重放。
- `src/rebase.js` — `rebase(repo, branch, onto)` 核心变基。
- `src/cli.js` — CLI 入口（同时导出 `run(argv)` 供进程内调用）。

## 测试

```sh
node --test
```

覆盖：干净变基（枚举 ≤3 个提交的全部拓扑顺序，逐棵重放新旧历史对照）、移动记录导致的上下文冲突（断言不写出任何文件）、空提交折叠（映射保留）、循环祖先 / 断裂父链 / 重复编号（退出码 1）。

> 注：离线沙箱禁止派生子进程，CLI 测试通过进程内调用 `run(argv)` 并捕获 stdout/stderr 完成。

## 真实测试结果（2026-10-03，Node v22.22.1）

`node --test`（退出码 0）：

```
# tests 1
# pass 1
# fail 0
# duration_ms 7536.118636
```

子测试明细（`node test/rebase.test.js`，退出码 0）：

```
ok 1 - clean rebase rewrites parents/hashes, keeps numbers, replays identically
ok 2 - rebase onto the original base reproduces the old branch tree exactly
ok 3 - clean rebase via CLI writes rebased.json and mapping.json
ok 4 - move of a record moved on the trunk conflicts and writes nothing
ok 5 - replace depending on a trunk-changed old value conflicts
ok 6 - empty patches collapse but stay in the mapping
ok 7 - cyclic ancestry exits 1
ok 8 - broken parent chain exits 1
ok 9 - duplicate experiment numbers exit 1
ok 10 - RepoError is used for structural problems, not ConflictError
# tests 10
# pass 10
# fail 0
```
