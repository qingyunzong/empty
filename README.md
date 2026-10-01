# lockmgr — 确定性两阶段锁管理器（S/X 锁）

纯 Python 3.11+ 标准库实现，无第三方依赖。

## 语义

- **S/X 锁**：S 与 S 兼容，X 与任何锁冲突；同一事务重复请求已持有的锁是幂等的。
- **FIFO 等待队列**：请求冲突时进入该资源的 FIFO 等待队列；队列为空时才允许直接授予（防止插队）。本实现按提交的确定性操作序列逐步推进，模拟并发。
- **死锁检测**：每次新增等待边后立即在等待图（waits-for graph）上检测环；发现环时中止环上 `txn_id` 最大的事务，报告 `DEADLOCK` 并释放其全部锁。检测循环执行，直到图中无环。
- **锁升级**：S→X 升级被其它事务持有的 S 锁阻塞时，升级请求排到该资源等待队列最前（该事务是持锁者），其 S 锁保持持有，并同样参与死锁检测。
- **唤醒**：事务结束（commit/abort/被中止）释放全部锁，按 FIFO 顺序唤醒可满足的请求；被唤醒的升级请求将持有的 S 原地转为 X。

## CLI（JSON 行协议）

```bash
python3 -m lockmgr.cli
```

输入（stdin，每行一个 JSON 对象）：

```json
{"op": "lock",   "txn": 1, "resource": "A", "mode": "S"}
{"op": "commit", "txn": 1}
{"op": "abort",  "txn": 1}
```

输出（stdout，每行一个 JSON 对象）：

```json
{"event": "granted",   "txn": 1, "resource": "A", "mode": "S"}
{"event": "waiting",   "txn": 2, "resource": "A", "mode": "X"}
{"event": "deadlock",  "txn": 2}
{"event": "committed", "txn": 1}
{"event": "aborted",   "txn": 3}
{"event": "error",     "txn": 4, "reason": "txn not active"}
```

阻塞的请求先产生 `waiting` 事件，在被唤醒之前**不会**产生 `granted` 输出；
`granted` 事件在实际被授予（被唤醒）时才输出。

示例：

```bash
$ printf '%s\n' \
  '{"op":"lock","txn":1,"resource":"A","mode":"X"}' \
  '{"op":"lock","txn":2,"resource":"B","mode":"X"}' \
  '{"op":"lock","txn":1,"resource":"B","mode":"X"}' \
  '{"op":"lock","txn":2,"resource":"A","mode":"X"}' \
  '{"op":"commit","txn":1}' | python3 -m lockmgr.cli
{"event": "granted", "txn": 1, "resource": "A", "mode": "X"}
{"event": "granted", "txn": 2, "resource": "B", "mode": "X"}
{"event": "waiting", "txn": 1, "resource": "B", "mode": "X"}
{"event": "deadlock", "txn": 2}
{"event": "granted", "txn": 1, "resource": "B", "mode": "X"}
{"event": "committed", "txn": 1}
```

## 代码结构

- `lockmgr/manager.py` — 锁管理器核心（授予/等待/升级/死锁检测/唤醒）
- `lockmgr/cli.py` — JSON 行协议 CLI
- `tests/test_lockmgr.py` — 单元测试（验收 a/b/c）
- `tests/test_cli.py` — CLI 协议测试
- `tests/test_random_comparison.py` — 随机操作序列与独立参考等待图模拟器比对（验收 d）

## 测试

```bash
python -m unittest discover -s tests -v
```

（本环境中解释器名为 `python3`，无 `python` 别名，实际以 `python3 -m unittest discover -s tests -v` 运行。）

### 真实运行结果（2026-10-01，Python 3.14.4）

```
Ran 25 tests in 0.360s

OK
```

25 个测试全部通过，覆盖验收标准：

- **a)** `test_two_txn_cycle_aborts_larger_id` — 两事务互等成环，id 大者（txn 2）被中止并释放全部锁；
- **b)** `test_three_txn_cycle_with_upgrade`、`test_three_txn_upgrade_cycle_all_three` — 三事务环且环中含 S→X 升级边；
- **c)** `test_long_wait_chain_no_false_deadlock` — 10 事务长等待链，无误报死锁，链头提交后依次唤醒；
- **d)** `test_aborted_sets_match_reference` — 300 个随机种子（每个 20–120 步随机锁/提交/中止操作）下，被中止事务集合与独立参考等待图模拟器完全一致；`test_final_holders_match_reference` 另比对最终持锁状态；`test_deadlocks_actually_exercised` 保证随机负载确实产生了大量死锁（比对非平凡）。
