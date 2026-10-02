# mvrepo

离线单机多分析进程观测仓库：版本图（DAG，非单链）+ 三值物化视图 +
线性一致检查。Node.js 22，仅标准库，测试用 `node:test`。

## 模型

- **批次（batch）**：`{processId, clock, deps:[batchId...], ops:[...], from?, branch?}`，
  内容为内容寻址（sha256）。op 为 `{op:'assert',key,value}` 或 `{op:'retract',key}`。
- **happens-before**：同一 `processId` 按逻辑钟 `clock` 排序 + 显式 `deps` 的传递闭包。
  不可比较的并发批次绝不被人为定序：合并时报 conflict，lincheck 搜索全部拓扑序。
- **版本图**：每个版本节点记录**证书**：`parents`（父版本集合）、`batch`（应用批次，
  合并版本为 `null`）、`changes`（行级增删 `{key,before,after}`，`null` 表示 unknown）。
- **三值行状态**：`asserted(v)` / `retracted` / `unknown`。unknown 是合法值，
  参与合并（双方都 unknown → unknown），永远不算失败。
- **三值合并**：`merge <a> <b>` 以 LCA 版本为 base 做三方合并；双方相对 base
  都改了同一键且结果不同 → `E_CONFLICT`，不任选胜者。
- **视图**：按分支增量维护；每个版本的物化状态由首父状态 + 行级 changes 推导并缓存
  （`state/<versionId>.json`）。`view <name>` 输出分支头的 asserted 行。

## CLI

```
mvrepo commit <batch.json> [--repo dir] [--branch name] [--from branch]
mvrepo forkinfo [--repo dir]                 # 分支、LCA、ahead 计数、冲突预览(JSON)
mvrepo merge <branchA> <branchB> [--repo dir]
mvrepo view <name> [--repo dir] [--branch b] [--prefix p]
mvrepo lincheck <log.json>
```

仓库目录默认 `./.mvrepo`（或 `--repo` / `MVREPO_DIR`）。多进程并发提交由
`lock` 文件互斥（30s  stale 锁自动回收）。

## 持久化与恢复

提交写入顺序：批次对象 → 版本对象（父指针）→ 状态缓存 → 头指针（原子 rename + fsync）
→ 确认。打开仓库时自动恢复：头指针缺失、损坏或不是 tip 时，从版本图重建头指针。
因此崩溃发生在父指针落盘之后、头指针更新之前，已确认批次不会丢失
（`test/recovery.test.js`）。

## lincheck 日志格式

```json
{ "events": [
  { "type": "commit", "id": "c1", "processId": "p1", "clock": 1,
    "deps": [], "ops": [{"op": "assert", "key": "k", "value": 1}] },
  { "type": "read", "id": "r1", "processId": "p2", "clock": 1,
    "deps": ["c1"], "view": {"k": 1} }
] }
```

历史线性一致 ⟺ 存在一个延拓 happens-before 的提交串行序，使每个 read
都能在该序的某个前缀 cut 上观察到与其 `view` 完全一致的物化状态。
实现：提交 DAG 上的回溯搜索（Kahn 就绪集 + 失败记忆化 +  doomed-read 剪枝 +
从读推导的必要排序边）。注意物化状态依赖并发提交的**应用顺序**而非仅集合，
因此记忆化键包含状态签名。

## 错误码

| 码 | 含义 |
|---|---|
| `E_ORPHAN` | 批次/事件依赖未知对象 |
| `E_CONFLICT` | 合并时并发修改冲突（附行级明细） |
| `E_BAD_PARENT` | 声明的父版本与分支头不符、未知分支/版本 |
| `E_NONLINEAR` | 不存在满足所有读的串行序（含 hb 环） |
| `E_BAD_BATCH` | 批次/日志格式非法 |
| `E_LOCKED` | 仓库锁被其他进程持有超时 |

## 验收对照

1. 同键并发更正 → 可检冲突：`test/conflict.test.js`（forkinfo 预览 + merge 报 `E_CONFLICT`，双方分支各自保留原值）。
2. 无环 ≤100 事件，与串行枚举所有拓扑序对照：`test/lincheck.test.js`（300 个随机历史与暴力枚举逐一比对；100 事件网格因果历史正/反例）。
3. 父指针更新后崩溃不丢已确认批次：`test/recovery.test.js`。
4. 撤销分支不影响兄弟分支：`test/branches.test.js`。

## 测试结果（真实记录）

本环境（CPU 受限容器）执行 `node --test`，连续三次全量通过：

```
✔ test/branches.test.js  (1422ms)
✔ test/cli.test.js       (19836ms)
✔ test/conflict.test.js  (2432ms)
✔ test/lincheck.test.js  (7542ms)
✔ test/recovery.test.js  (1325ms)
ℹ tests 5  ℹ pass 5  ℹ fail 0   (duration ~20s)
```

注：本沙箱拦截子进程 stdio 管道回传，CLI 端到端测试改用临时文件捕获输出
（见 `test/cli.test.js` 注释）。
