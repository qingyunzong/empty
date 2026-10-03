# sched — 冲突可串行化的并行轮次调度器

读取 N 个事务各自的操作序列（读/写 + 键名），输出按轮次组织的
冲突可串行化并行执行调度。仅依赖 Python 3.11 标准库。

## 语义约定

- **自然序**：输入隐含的锁步（lock-step）交错顺序——先所有事务的第 1 个
  操作（按 `txn_id` 升序），再所有第 2 个操作，依此类推。
- **冲突**：两个操作作用于同一键、分属不同事务、且至少一个为写。
- **优先图**：每个事务一个节点；若 `Ti` 的某操作与 `Tj` 的某操作冲突且
  在自然序中居前，则有边 `Ti -> Tj`。优先图有环 ⇒ 输入不可冲突串行化，
  输出 `{"error": "NON_SERIALIZABLE", "cycle": [...]}`（环为确定性的：
  按字典序深度优先找到的第一个环，并旋转到最小事务 id 开头）。
- **调度**：每个约束（事务内部顺序 + 按自然序定向的冲突对）必须从前一轮
  指向严格更晚的轮次，因此同轮操作两两不冲突、可并行；事务内部顺序自动
  保持。
- **最少轮数**：轮数等于约束 DAG 最长链长度（操作数计），可证最优。
- **确定性平局**：在最少轮数解中，逐轮取按 `(txn_id, op_index)` 排序后
  字典序最小的操作集合（每轮取“使剩余最长链减一”的已就绪操作有序列表
  的最短前缀）。

## 用法

```bash
python -m sched input.json
```

输入 JSON：

```json
{"transactions": [
  {"id": "T1", "ops": [{"type": "write", "key": "x"}, {"type": "read", "key": "y"}]},
  {"id": "T2", "ops": [{"type": "write", "key": "x"}, {"type": "write", "key": "z"}]},
  {"id": "T3", "ops": [{"type": "read", "key": "z"}, {"type": "write", "key": "y"}]}
]}
```

输出（stdout）：

```json
{"rounds": [
  [{"txn": "T1", "op_index": 0, "type": "write", "key": "x"}],
  [{"txn": "T1", "op_index": 1, "type": "read", "key": "y"},
   {"txn": "T2", "op_index": 0, "type": "write", "key": "x"},
   {"txn": "T3", "op_index": 0, "type": "read", "key": "z"}],
  [{"txn": "T2", "op_index": 1, "type": "write", "key": "z"},
   {"txn": "T3", "op_index": 1, "type": "write", "key": "y"}]
]}
```

不可串行化时输出（退出码仍为 0，属正常结果）：

```json
{"error": "NON_SERIALIZABLE", "cycle": ["T1", "T2"]}
```

## 项目结构

- `sched/scheduler.py` — 核心：建模、环检测、最少轮次调度、模拟执行
- `sched/__main__.py` — CLI 入口（`python -m sched <input.json>`）
- `tests/test_sched.py` — 验收测试（unittest）

## 测试

```bash
python -m unittest discover -s tests -v
```

验收覆盖：

- **(a)** 手工三事务用例，验证已知最优轮数（3 轮，关键链 T1.0→T1.1→T3.1）；
- **(b)** 两事务/三事务/读写混合循环依赖，验证报错与环内容；
- **(c)** 并列最优场景，验证逐轮字典序选择（可推迟的操作被推迟、
  较小 txn_id 优先进入第 1 轮）；
- **(d)** 120 组随机小规模输入（2–4 事务、每事务 1–3 操作、3 个键），
  与穷举全部合法交错（保持事务内序、与自然序冲突等价且优先图无环）
  的参考实现比对轮数与最终状态。

## 真实测试结果（交付前运行）

环境：Python 3.14.4（兼容 3.11 标准库语法），Linux。

```
$ python -m unittest discover -s tests -v
test_cli_cycle (test_sched.CliTest.test_cli_cycle) ... ok
test_cli_schedule (test_sched.CliTest.test_cli_schedule) ... ok
test_cli_usage_error (test_sched.CliTest.test_cli_usage_error) ... ok
test_error_payload_shape (test_sched.CycleDetectionTest.test_error_payload_shape) ... ok
test_read_write_cycle (test_sched.CycleDetectionTest.test_read_write_cycle) ... ok
test_three_transaction_cycle (test_sched.CycleDetectionTest.test_three_transaction_cycle) ... ok
test_two_transaction_cycle (test_sched.CycleDetectionTest.test_two_transaction_cycle) ... ok
test_independent_transactions_single_round (test_sched.KnownOptimalRoundsTest.test_independent_transactions_single_round) ... ok
test_single_transaction (test_sched.KnownOptimalRoundsTest.test_single_transaction) ... ok
test_three_transaction_optimum (test_sched.KnownOptimalRoundsTest.test_three_transaction_optimum) ... ok
test_chain_forces_sources_into_round_one (test_sched.LexicographicTieBreakTest.test_chain_forces_sources_into_round_one) ... ok
test_deferrable_operation_is_postponed (test_sched.LexicographicTieBreakTest.test_deferrable_operation_is_postponed) ... ok
test_deterministic_across_runs (test_sched.LexicographicTieBreakTest.test_deterministic_across_runs) ... ok
test_smaller_txn_id_preferred_in_round_one (test_sched.LexicographicTieBreakTest.test_smaller_txn_id_preferred_in_round_one) ... ok
test_random_against_exhaustive_reference (test_sched.RandomizedExhaustiveTest.test_random_against_exhaustive_reference) ... ok

----------------------------------------------------------------------
Ran 15 tests in 2.410s

OK
```

随机对照实验（种子 20261003，120 组）：85 组可串行化、35 组不可串行化，
共逐一比对 4291 个合法交错的最终状态，轮数与最终状态全部一致。
