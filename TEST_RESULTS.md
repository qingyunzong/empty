# 实际测试结果记录

环境: g++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0, cmake version 4.2.3, Linux 6.6.114.1-microsoft-standard-WSL2 x86_64
日期: 2026-10-05 21:56:31 CST

## CTest（`ctest --output-on-failure`）

```
Test project /home/delin/.local/share/gsb-workbench/artifacts/aa3f4640eb144775a37f88a88b1936ff/run/B/attempt-004/workspace/build
    Start 1: inertial_cancel
1/7 Test #1: inertial_cancel ..................   Passed    0.00 sec
    Start 2: stale_event
2/7 Test #2: stale_event ......................   Passed    0.00 sec
    Start 3: zero_delay_delta
3/7 Test #3: zero_delay_delta .................   Passed    0.00 sec
    Start 4: same_tick_order
4/7 Test #4: same_tick_order ..................   Passed    0.00 sec
    Start 5: pulse_exactly_delay
5/7 Test #5: pulse_exactly_delay ..............   Passed    0.00 sec
    Start 6: xor_same_tick
6/7 Test #6: xor_same_tick ....................   Passed    0.00 sec
    Start 7: delta_loop
7/7 Test #7: delta_loop .......................   Passed    0.01 sec

100% tests passed, 0 tests failed out of 7

Total Test time (real) =   0.03 sec
```

## 演示输出（`./gatesim_demo`）

```
=== 场景 A：惯性延迟取消窄脉冲，旧代事件失效 ===
NOT 门 d=3；in 在 t=2..4 有宽度 2 的窄脉冲（<3，应被取消），t=8..14 有宽度 6 的脉冲（>=3，应通过）
信号 in:
  t=0 δ0 -> 0  (初始值)
  t=2 δ0 -> 1  (外部激励)
  t=4 δ0 -> 0  (外部激励)
  t=8 δ0 -> 1  (外部激励)
  t=14 δ0 -> 0  (外部激励)
  逐 tick 电平: 001100001111110
  tick 序号:    012345678901234
信号 out:
  t=0 δ0 -> 1  (初始值)
  t=11 δ0 -> 0  (NOT#0(d=3) 惯性延迟事件到期)
  t=17 δ0 -> 1  (NOT#0(d=3) 惯性延迟事件到期)
  逐 tick 电平: 111111111110000001
  tick 序号:    012345678901234567
事件日志（原因）:
  t=2 NOT#0(d=3)：调度 out -> 0 @t=5
  t=4 NOT#0(d=3)：撤销未到期事件（惯性延迟 d=3，窄脉冲被取消），out 保持 1
  t=5 NOT#0(d=3)：丢弃过期事件（旧代延迟事件不生效）
  t=8 NOT#0(d=3)：调度 out -> 0 @t=11
  t=14 NOT#0(d=3)：调度 out -> 1 @t=17

=== 场景 B：零延迟门用 delta 轮逐级传播 ===
in -> NOT(d=0) -> m -> NOT(d=0) -> out；in 在 t=2 变 1，m 应在 t=2 δ1 变 0，out 应在 t=2 δ2 变 1
信号 in:
  t=0 δ0 -> 0  (初始值)
  t=2 δ0 -> 1  (外部激励)
  逐 tick 电平: 001
  tick 序号:    012
信号 m:
  t=0 δ0 -> 1  (初始值)
  t=2 δ1 -> 0  (NOT#0(d=0) 零延迟 delta 更新)
  逐 tick 电平: 110
  tick 序号:    012
信号 out:
  t=0 δ0 -> 0  (初始值)
  t=2 δ2 -> 1  (NOT#1(d=0) 零延迟 delta 更新)
  逐 tick 电平: 001
  tick 序号:    012
事件日志（原因）:

=== 场景 C：同 tick 先输入（激励+到期事件）后门更新 ===
AND 门 d=2；a、b 在 t=1 同变 1（调度 out->1 @t=3），a 在 t=3 变 0（与到期事件同 tick，先施加再求值，out 随后于 t=5 回落）
信号 a:
  t=0 δ0 -> 0  (初始值)
  t=1 δ0 -> 1  (外部激励)
  t=3 δ0 -> 0  (外部激励)
  逐 tick 电平: 0110
  tick 序号:    0123
信号 out:
  t=0 δ0 -> 0  (初始值)
  t=3 δ0 -> 1  (AND#0(d=2) 惯性延迟事件到期)
  t=5 δ0 -> 0  (AND#0(d=2) 惯性延迟事件到期)
  逐 tick 电平: 000110
  tick 序号:    012345
事件日志（原因）:
  t=1 AND#0(d=2)：调度 out -> 1 @t=3
  t=3 AND#0(d=2)：调度 out -> 0 @t=5

```
