# lockmgr — 确定性两阶段锁管理器（S/X 锁）

纯 Python 标准库实现（兼容 Python 3.11+），按提交的确定性操作序列逐步推进模拟并发。

## 语义

- **S/X 锁**：仅 S/S 兼容；X 与任何锁冲突。
- **FIFO 等待队列**：请求冲突时进入该资源的 FIFO 队列。公平性约束——新请求只有在与所有当前持有者**且**与队列中所有已等待请求兼容时才立即授予（不允许越过等待中的 X 锁）。
- **死锁检测**：每次新增等待边后在等待图（waits-for graph）上检测环；发现环时中止环上 `txn_id` 最大的事务，输出 `DEADLOCK` 并释放其全部锁；若仍有环则重复，直至无环。
- **锁升级**：S→X 升级被其它事务所持 S 锁阻塞时，作为普通等待边参与死锁检测。
- **事务结束**：`commit`/`abort` 释放全部锁，并按 FIFO 顺序唤醒可满足的请求（授予即出队，遇到不可满足者停止）。
- **阻塞静默**：阻塞的锁请求在被唤醒授予前不产生任何输出。

## CLI：JSON 行协议

```
python3 -m lockmgr < ops.jsonl
```

输入（每行一个 JSON 对象）：

| 操作 | 示例 |
|---|---|
| 开始事务 | `{"op":"begin","txn":1}`（可选，首次 lock 隐式开始） |
| 加锁 | `{"op":"lock","txn":1,"resource":"A","mode":"S"}`（`mode` 为 `"S"` 或 `"X"`） |
| 提交 | `{"op":"commit","txn":1}` |
| 中止 | `{"op":"abort","txn":1}` |

输出（每行一个 JSON 对象）：

| 事件 | 示例 |
|---|---|
| 授予 | `{"status":"GRANTED","txn":1,"resource":"A","mode":"S"}` |
| 死锁 | `{"status":"DEADLOCK","victim":2,"cycle":[1,2]}` |
| 提交/中止 | `{"status":"COMMITTED","txn":1}` / `{"status":"ABORTED","txn":1}` |
| 错误 | `{"status":"ERROR","message":"..."}` |

示例（两事务互等成环，id 大者被中止）：

```
$ printf '%s\n' \
  '{"op":"lock","txn":1,"resource":"A","mode":"X"}' \
  '{"op":"lock","txn":2,"resource":"B","mode":"X"}' \
  '{"op":"lock","txn":1,"resource":"B","mode":"X"}' \
  '{"op":"lock","txn":2,"resource":"A","mode":"X"}' \
  '{"op":"commit","txn":1}' | python3 -m lockmgr
{"status": "GRANTED", "txn": 1, "resource": "A", "mode": "X"}
{"status": "GRANTED", "txn": 2, "resource": "B", "mode": "X"}
{"status": "DEADLOCK", "victim": 2, "cycle": [1, 2]}
{"status": "GRANTED", "txn": 1, "resource": "B", "mode": "X"}
{"status": "COMMITTED", "txn": 1}
```

注意第 3 条输入（txn 1 请求 B 被阻塞）没有产生输出，直到死锁解除后被唤醒。

## 代码结构

- `lockmgr/manager.py` — 核心 `LockManager`：持有者表、FIFO 队列、等待图构建与环检测、受害者中止与唤醒。
- `lockmgr/cli.py` / `lockmgr/__main__.py` — JSON 行协议 CLI。
- `tests/reference_sim.py` — 独立编写的参考等待图模拟器（差异化测试 oracle）。
- `tests/test_lockmgr.py` — 验收测试：
  - (a) 两事务互等成环，id 大者被中止；
  - (b) 三事务环且含 S→X 锁升级；
  - (c) 30 事务长等待链不误报死锁，逐个提交按 FIFO 级联唤醒；
  - (d) 120 个随机种子 × 250 个随机锁操作，与独立参考模拟器比对被中止事务集合及最终锁状态完全一致；
  - 另有 FIFO 公平性、CLI 阻塞静默、CLI 死锁、错误处理、子进程端到端测试。

## 测试结果（真实运行记录）

环境：Python 3.14.4（代码仅使用 3.11 标准库特性；本机无 `python` 命令，使用 `python3`）。

```
$ python3 -m unittest discover -s tests -v
test_blocked_request_produces_no_output_until_woken (test_lockmgr.CliTest.test_blocked_request_produces_no_output_until_woken) ... ok
test_deadlock_reported_over_cli (test_lockmgr.CliTest.test_deadlock_reported_over_cli) ... ok
test_errors (test_lockmgr.CliTest.test_errors) ... ok
test_subprocess_end_to_end (test_lockmgr.CliTest.test_subprocess_end_to_end) ... ok
test_s_waits_behind_queued_x (test_lockmgr.FifoFairnessTest.test_s_waits_behind_queued_x) ... ok
test_long_wait_chain (test_lockmgr.LongChainNoDeadlockTest.test_long_wait_chain) ... ok
test_random_sequences_match_reference (test_lockmgr.RandomizedDifferentialTest.test_random_sequences_match_reference) ... ok
test_cycle_aborts_higher_txn_id (test_lockmgr.TwoTxnDeadlockTest.test_cycle_aborts_higher_txn_id) ... ok
test_three_txn_cycle_with_upgrade (test_lockmgr.UpgradeDeadlockTest.test_three_txn_cycle_with_upgrade) ... ok

----------------------------------------------------------------------
Ran 9 tests in 0.500s

OK
```
