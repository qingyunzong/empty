# 集团资金池额度 CLI — 结果摘要

## 结构
- `lib/pool.js` — 核心：`Pool` / `PoolNode`，节点含 `limit`、`held`、`spent`，并增量维护子树聚合 `subHeld`/`subSpent`。
- `pool.js` — CLI：`node pool.js exec ops.jsonl [--stats]`；导出 `run(argv, io)` 便于进程内测试。
- `test/pool.test.js` — 验收测试 A–D + CLI 端到端。
- `ops.example.jsonl` — 示例操作流。

## 语义要点
- `reserve(path, amount, holdId)`：沿 path 向上检查每个祖先 `limit - held - spent >= amount`，任一不足整批失败；错误 `E_CAPACITY` 的 message 含最深失败节点路径（自目标节点向上首个不足者）。
- `commit(holdId)`：path 上各节点 `held -= amount; spent += amount`；`abort` 仅释放 `held`。
- 幂等：对已 finalized 的 hold 重复 `commit`/`abort` 为 no-op，返回 `{state, idempotent: true}`，不重复扣减；未知 holdId 抛 `E_ORPHAN_HOLD`。
- `batchReserve`：任一项失败时，撤销本批此前全部 hold（含增量聚合回滚并删除 hold 记录，holdId 可复用），状态恢复到调用前。
- `subtreeExposure(path)`：O(1) 读取增量维护的 `subHeld + subSpent`，不遍历全树；reserve/commit/abort 时沿祖先链传播增量。
- CLI 错误：stderr 输出一行 JSON `{"code","message","line"}`，exit code 1；参数错误 exit 2。

## 测试运行（本机，Node v22.22.1）
命令：`node --test`

```
ok 1 - A: deep-chain capacity boundary, deepest failing node reported
ok 2 - B: batchReserve third item fails, first two holds fully rolled back
ok 3 - C: 300 random ops match recursive reference implementation
ok 4 - D: repeated commit/abort are idempotent no-ops; unknown hold is E_ORPHAN_HOLD
ok 5 - CLI: exec --stats exits 0 with stats; failure exits 1 with stderr {code,message}
# tests 5
# pass 5
# fail 0
```

## CLI 手工验证（本机真实执行）
- `node pool.js exec ops.example.jsonl --stats` → exit 0，末行 `{"stats":{"ops":8,"reserves":2,"commits":1,"aborts":1,"batches":0,"exposure":800,"held":0,"spent":800}}`。
- 容量不足 → stderr `{"code":"E_CAPACITY","message":"E_CAPACITY: deepest failing node \"a\" available=10 required=99","line":2}`，exit 1。
- 未知 hold → stderr `{"code":"E_ORPHAN_HOLD","message":"unknown holdId: ghost","line":2}`，exit 1。

## 说明与限制
- 测试 C 的参考实现为独立递归模型（exposure 按“子树内以该节点为目标的 hold 金额”定义，全树递归求和），与被测实现仅有增量/全量计算方式之差。
- 测试 C 使用固定种子（20261003）的 mulberry32，300 个操作确定性可复现。
- 沙箱限制 `child_process`  spawn，CLI 端到端测试通过进程内调用 `run()` 完成；真实子进程行为已用上方手工命令在本机验证。
- 额外错误码：`E_NOT_FOUND`（路径不存在）、`E_DUPLICATE_HOLD`（holdId 重复）、`E_BAD_OP`（非法操作/参数），均走相同的 stderr JSON + 非零退出通道。
