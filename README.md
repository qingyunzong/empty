# Saga Orchestrator

JSON 定义有序步骤，每步含 commit / compensate 动作；纯 Python 3.11 标准库实现。

## 命令

```
python3 saga.py new examples/order.json --id s1 --key req-1
python3 saga.py run --id s1 [--stop-after N] [--crash-after SPEC]
python3 saga.py cancel --id s1 [--crash-after SPEC]
python3 saga.py recover --id s1
python3 saga.py state --id s1
```

状态机：`RUNNING → COMPLETED`，或 `RUNNING → CANCELING → CANCELED`，动作失败进入 `FAILED`。

## 语义

- `cancel` 先持久化取消标志；运行中的步骤在步骤边界（协作检查点）观察到取消。
- 取消时已提交步骤按逆序补偿，未开始步骤不再执行。
- `COMPLETED` 后 `cancel` 返回退出码 9，状态不变。
- 崩溃点仅限：步骤事件后、动作后、补偿事件后（`--crash-after` 模拟，
  如 `action:A:commit`、`compensation_started:A`）；`recover` 继续取消或完成，
  不丢失取消标志。
- 所有动作按 `(request_key, step_name, action_kind)` 幂等，重复执行自动跳过。

## 测试

```
python3 -m unittest -v
```

结果记录于 `result.txt`。
