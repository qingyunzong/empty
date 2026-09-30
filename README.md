# request_flow

审批工作流 CLI：请求含金额、预留项与虚拟超时 ticks。金额 ≥ 1000 需
经理（manager）+ 财务（finance）两级审批，否则只需经理。基于事件溯源
（`events.jsonl`）实现崩溃恢复，恢复不重复补偿。

仅依赖 Python 3.11 标准库。

## 命令

```
python3 request_flow.py [--dir DIR] new --amount N --items a,b,c --timeout T
python3 request_flow.py [--dir DIR] tick
python3 request_flow.py [--dir DIR] decide APPROVER DECISION   # APPROVE|REJECT
python3 request_flow.py [--dir DIR] crash --at after-decision-event|mid-compensation
python3 request_flow.py [--dir DIR] recover
python3 request_flow.py [--dir DIR] state
python3 request_flow.py [--dir DIR] events
```

状态目录默认 `.rfstate`，也可用环境变量 `REQUEST_FLOW_HOME` 指定。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功（含幂等重复决定） |
| 2  | 参数非法 |
| 4  | 当前状态不可决策/操作被拒 |
| 9  | 同一审批人已决后给出相反决定 |
| 10 | 模拟崩溃 |

## 参考状态表

| 当前状态 | 事件/命令 | 下一状态 | 动作 |
|----------|-----------|----------|------|
| — | `new` | RUNNING | 按序预留全部预留项 |
| RUNNING | 必需审批人全部 APPROVE | APPROVED | 汇合完成 |
| RUNNING | 任一审批人 REJECT | REJECTING → REJECTED | 逆序补偿已预留项 |
| RUNNING | `tick` 达到 timeout 仍未决 | TIMEOUT_CANCELING → CANCELED | 逆序补偿已预留项 |
| RUNNING/REJECTING/TIMEOUT_CANCELING | 崩溃后 `recover` | 同上终态 | 幂等补齐未完成动作，不重复补偿 |
| 任意 | 日志损坏 | FAILED | — |

## 每 tick 事件序列（timeout=2，预留项 x,y）

| tick | 产生事件 | 状态 |
|------|----------|------|
| 1 | `Tick n=1` | RUNNING |
| 2 | `Tick n=2`, `TimeoutCancelingStarted`, `ItemCompensated y`, `ItemCompensated x`, `Canceled` | CANCELED |

## 测试

```
python -m unittest -v > result.txt 2>&1
```

真实运行输出见 `result.txt`（本环境以 `python3.11` 执行，8 个测试全部通过）。
