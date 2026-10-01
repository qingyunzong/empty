# taskq — 带崩溃恢复语义的持久化任务队列

纯 Python 标准库实现（3.11+），无第三方依赖。

## 用法

```bash
python -m taskq run script.json --db queue.json --out done.json
python -m taskq recover --db queue.json
python -m unittest discover -s tests -v
```

`script.json` 形如：

```json
{"actions": [
  {"op": "enqueue", "task": {"id": "T1"}, "dur": 1, "at": 100},
  {"op": "run"},
  {"op": "crash", "stage": "after_rename"}
]}
```

- `enqueue`：入队任务（`task` 缺省时自动生成 `auto-<index>` id；`dur`/`at` 为可选元数据，`dur` 为负退出码 2）。
- `run`：FIFO 取出队首任务（或 `task.id` 指定的任务），标记 done。
- `crash`：故障注入，见下。

## 故障点与恢复语义

**持久化协议**：所有 db 写入都是 写 `queue.json.tmp` → fsync → 原子 `rename` 替换 `queue.json`（再 fsync 目录）。**提交点定义为 rename 返回的那一刻**。

- `enqueue`：先写 tmp、fsync、rename，成功（rename 返回）后任务才可见。
- `run`：先把 done 记录写入内存日志，再提交 db（从 pending 删除并加入 done），提交点同样是 rename 返回。
- `crash` 动作是对**前一个动作的提交**做故障注入（若前一个动作不产生提交，如空队列 `run`，则对当前状态做检查点提交并在指定阶段崩溃）：
  - `before_tmp`：tmp 写入前崩溃 —— db 不变，无 tmp 残留；
  - `after_tmp_before_rename`：tmp 已写+fsync 但 rename 前崩溃 —— db 不变，tmp 残留；
  - `after_rename`：rename 完成后崩溃 —— 提交点已过，db 为新状态，无 tmp 残留。
  崩溃立即以退出码 3 退出，后续 action 不执行。

**恢复**（`recover`）：rename 是原子的，因此 `queue.json.tmp` 存在 ⟺ rename 未完成 ⟺ db 未被该次提交更新 → 丢弃 tmp 保留 db；tmp 不存在 → 保留 db。恢复后不变式：任何任务不会既 done 又 pending（recover 会校验，违反则退出码 2）。恢复幂等：第二次 recover 为无操作。

**退出码**：`0` 成功；`2` 用户错误（JSON 损坏 / 未知 op / 负 dur / 重复 id 冲突 / db 不一致）；`3` 模拟崩溃。

## 真实运行记录

以下均为本仓库实际运行结果（Python 3.14.4，Linux），演示脚本为
`enqueue T1 → run → crash <stage>`：

### 三种崩溃 CLI

| stage | run 退出码 | run stderr | recover 退出码 | 恢复后 queue.json 的 SHA-256 |
|---|---|---|---|---|
| `before_tmp` | 3 | `{"type": "crash", "stage": "before_tmp"}` | 0 | `42871911eb875f0d6b3f7346a96d12f099f1d3e411d1f6b2490301221226827c` |
| `after_tmp_before_rename` | 3 | `{"type": "crash", "stage": "after_tmp_before_rename"}` | 0 | `42871911eb875f0d6b3f7346a96d12f099f1d3e411d1f6b2490301221226827c` |
| `after_rename` | 3 | `{"type": "crash", "stage": "after_rename"}` | 0 | `4fc3fe44284a31466616aab022c0f8a2dbae50a39cc566ac04bdf28eb90b4917` |

恢复后状态（recover stdout 的 summary）：

- `before_tmp`：`pending=[T1], done=[]`（run 的提交未发生，T1 仍 pending）
- `after_tmp_before_rename`：`pending=[T1], done=[]`，且 `discarded_tmp=true`（tmp 被丢弃，无重复）
- `after_rename`：`pending=[], done=[T1]`（提交点已过，T1 done 且不 pending）

对 `after_rename` 场景再执行第二次 `recover`：退出码 0，db 哈希不变（`4fc3fe44…b4917`），幂等。

### 重复 id 冲突（验收 C）

```
第一次 enqueue T1:  exit=0, sha256=e4357c5364466e79d62518fecb699722a40f565b0c7a83056b843ab10043fc4a
再次 enqueue T1:    exit=2, stderr: error: action 0: duplicate task id 'T1'
冲突后 db 哈希:     e4357c5364466e79d62518fecb699722a40f565b0c7a83056b843ab10043fc4a（不变）
```

### 单元测试

`python -m unittest discover -s tests -v`：11 个测试全部 OK（含验收 A–E；
验收 D 对 ≤8 动作的脚本枚举全部 crash 插入点 × 3 阶段，与测试内独立的
文件状态机参考实现逐一对比 db/tmp 文件内容与退出码）。完整输出见下方
"测试结果"一节（由实际运行生成）。

## 测试结果

```
test_a_crash_after_tmp_before_rename_recovers_without_duplicates (test_taskq.TaskqCase.test_a_crash_after_tmp_before_rename_recovers_without_duplicates) ... ok
test_b_crash_after_rename_task_done_not_pending (test_taskq.TaskqCase.test_b_crash_after_rename_task_done_not_pending) ... ok
test_c_duplicate_id_exit2_db_unchanged (test_taskq.TaskqCase.test_c_duplicate_id_exit2_db_unchanged) ... ok
test_crash_before_tmp_leaves_no_trace (test_taskq.TaskqCase.test_crash_before_tmp_leaves_no_trace) ... ok
test_d_enumerate_crash_points_against_reference (test_taskq.TaskqCase.test_d_enumerate_crash_points_against_reference) ... ok
test_e_recover_twice_is_idempotent (test_taskq.TaskqCase.test_e_recover_twice_is_idempotent) ... ok
test_error_bad_db_json_exit2 (test_taskq.TaskqCase.test_error_bad_db_json_exit2) ... ok
test_error_bad_script_json_exit2 (test_taskq.TaskqCase.test_error_bad_script_json_exit2) ... ok
test_error_negative_dur_exit2 (test_taskq.TaskqCase.test_error_negative_dur_exit2) ... ok
test_error_unknown_op_exit2 (test_taskq.TaskqCase.test_error_unknown_op_exit2) ... ok
test_run_success_outputs_actions_and_out_file (test_taskq.TaskqCase.test_run_success_outputs_actions_and_out_file) ... ok

----------------------------------------------------------------------
Ran 11 tests in 152.324s

OK
exit=0
```
