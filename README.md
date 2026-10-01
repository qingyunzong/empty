# 树状订单 Saga 编排器

输入 JSON 为树状订单（根下有航班、酒店、租车等节点，酒店可含多个房间），
每个节点隐式拥有预留（reserve）/补偿（compensate）动作及估价（estimate）。
仅依赖 Python 3.11 标准库。

## 语义

- 预留按深度优先、从左到右执行。
- 某节点失败时：先逆序补偿其已完成子节点，再向上冒泡，由父节点逆序补偿
  此前已成功的同级节点（子树递归回滚，子节点先于自身）。
- 总估价超过预算时，在任何外部动作之前失败（状态 FAILED，零事件）。
- 预留按节点路径幂等，重复运行不会产生重复预留。
- 崩溃后依据事件日志恢复：已确认（confirmed）动作跳过，未确认（pending）
  动作重放。

状态机：`RUNNING -> COMPLETED`、`RUNNING -> COMPENSATING -> COMPENSATED`、
`FAILED`（预算超限）。

## 命令

```sh
python3.11 saga.py run --input order.json --budget 1000 [--state-dir .saga]
python3.11 saga.py fail-at room2 --input order.json --budget 1000
python3.11 saga.py crash --at 4 [--fail-at room2] --input order.json --budget 1000
python3.11 saga.py recover --state-dir .saga
python3.11 saga.py state --state-dir .saga
```

退出码：0 = COMPLETED/COMPENSATED，1 = 模拟崩溃，2 = FAILED（超预算）或用法错误。

状态目录内含 `journal.json`（状态 + 事件日志）与 `world.json`
（外部世界副作用，按路径幂等）。同一状态目录代表同一 Saga 实例，
重复 `run` 会幂等跳过已确认事件。

## 测试

```sh
python3.11 -m unittest test_saga -v
```

测试用独立的小规模参考递归算法（`test_saga.py` 中 `ref_*` 函数）计算精确的
预留/回滚序列，与真实引擎逐事件比对，并通过真实子进程校验 CLI 退出码。
