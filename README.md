# experiment-history-rebase

单机离线环境下的实验脚本历史变基库与 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 数据模型

每个提交包含：

- `hash`：提交哈希（sha256，对 `{parent, number, patch, context}` 的规范 JSON 计算；缺省时由库补算）
- `parent`：父提交哈希，根提交为 `null`
- `number`：实验编号（整数，全历史唯一）
- `patch`：有序操作列表
- `context`：应用本提交后树状态快照的哈希（sha256 of canonical JSON）

补丁操作：

- `{ "op": "set", "path": p, "value": v, "old": u? }` — 写入；带 `old` 时校验旧值
- `{ "op": "delete", "path": p, "old": u? }` — 删除；路径必须存在
- `{ "op": "move", "from": a, "to": b }` — 移动记录；源必须存在、目标必须不存在

## 变基语义

`rebase(commits, branchHead, onto)` 将分支头可达、但目标主干不可达的提交按拓扑序（父先子后，编号定序）重放到 `onto` 之上：

- 重写 `parent` 与 `hash`，保留实验编号，输出 `mapping`（旧哈希 → 新哈希）
- 补丁在新上下文按序应用；操作依赖的旧值/路径/被移动记录与主干不一致时抛出 `CONFLICT`，调用方不得写出部分新历史
- 空补丁提交被折叠（不产生新提交），但映射保留（旧哈希 → `null`）
- 重放既有历史时校验已记录的 `context` 快照哈希

错误码（`RebaseError.code`，CLI 均以退出码 1 结束）：`CYCLE`（循环祖先）、`BROKEN_PARENT`（断裂父链）、`DUPLICATE_NUMBER`（重复编号）、`CONFLICT`（上下文冲突）、`CONTEXT_MISMATCH`、`UNKNOWN_HEAD`。

## CLI

```sh
node src/cli.js rebase --history history.json --branch <ref> --onto <ref> [--out-dir <dir>]
```

`<ref>` 可为分支名（`history.json` 中的 `branches` 表）、提交哈希或实验编号。成功时写出 `rebased.json`（新提交数组）与 `mapping.json`；冲突或校验失败时退出码为 1 且不写任何文件。

## 测试

```sh
node --test
```

覆盖：干净变基（父哈希/提交哈希重写、编号映射、重放树与旧分支一致）、移动记录导致的上下文冲突（退出码 1、无部分输出）、空提交折叠（映射保留）、循环祖先/断裂父链/重复编号，以及不超过 3 个提交的拓扑序枚举与逐棵重放对照。
