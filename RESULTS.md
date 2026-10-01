# RESULTS

日期：2026-10-02 ｜ 环境：Node.js v22.22.1（仅标准库）｜ 命令：`node --test`

## 测试摘要（真实输出）

```
ok 1 - A: deep capacity boundary, deepest failing node reported
ok 2 - B: batch third op fails, first two holds roll back hierarchically
ok 3 - C: 300 random ops match recursive reference implementation
ok 4 - D: repeated commit/abort are idempotent no-ops; cross-transition rejected
ok 5 - CLI: exec ops.jsonl --stats, and E_CAPACITY on stderr with non-zero exit
# tests 5
# pass 5
# fail 0
```

以上为本次在本机实际运行 `node --test` 的结果（5 通过 / 0 失败）。
CLI 的端到端验证通过进程内调用 `runCli` 完成（当前沙箱禁止 spawn 子进程，
`node cli.js exec ... --stats` 已单独手工运行确认输出与退出码正确）。

## 验收点对应

- **A 深层容量边界**：链 root/a/b/c/d，叶节点精确等于可用额成功；超限失败；
  中间节点唯一失败时错误指向该中间节点；多节点同时不足时错误含最深失败节点
  （`E_CAPACITY: insufficient capacity at root/a/b/c/d: ...`）。
- **B 批量回滚**：batch 内第三笔 reserve 超容量，前两笔 hold 全部撤销，
  `held`/子树聚合/holds 表恢复到调用前；另覆盖嵌套 batch（内层 commit 后外层失败，
  hold 状态恢复为 active）。
- **C 随机对照**：固定种子（20261002）生成 300 个混合操作（add/reserve/commit/abort，
  含超容量与幽灵 holdId），每步与递归全遍历参考实现比对错误码与随机子树
  `subtreeExposure`，结束后再逐节点全树比对，全部一致。
- **D 幂等语义**：重复 commit / 重复 abort 为幂等 no-op（返回 `{idempotent:true}`，
  不重复计账）；commit 后 abort 或 abort 后 commit 抛 `E_HOLD_STATE`；
  未知 holdId 抛 `E_ORPHAN_HOLD`。

## 设计要点

- `pool.js`：`Pool` 类。每个节点维护 `limit/held/spent` 及增量聚合
  `subtreeHeld/subtreeSpent`；所有变更经 `_bump` 沿祖先链 O(depth) 传播，
  `subtreeExposure` 直接读聚合值，不做全树遍历。
- reserve 沿 path 检查每个节点 `limit - held - spent >= amount`，任一不足整批
  失败，错误含最深失败节点路径。
- 批量（`batch`，可嵌套）用回滚日志实现：每个子操作记录逆操作，失败时逆序回放，
  聚合值随逆操作自动恢复。
- `cli.js`：`pool exec ops.jsonl --stats`，逐行 JSONL；出错时 stderr 输出
  `{"code","message"}` 且退出码非 0；`--stats` 输出处理计数、活跃 hold 数、
  根子树 exposure。

## 错误码

`E_CAPACITY`（容量不足）、`E_ORPHAN_HOLD`（未知 holdId）、`E_HOLD_STATE`
（终态冲突转换）、`E_DUPLICATE_HOLD`、`E_NOT_FOUND`、`E_INVALID`、`E_PARSE`、
`E_USAGE`、`E_IO`。
