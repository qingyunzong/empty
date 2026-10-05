# 实际测试结果

环境：g++ 15.2.0 (Ubuntu)，CMake 4.2.3，Linux x86_64，2026-10-05。

## Debug 构建（-Wall -Wextra，零警告）

```
$ ctest --test-dir build --output-on-failure
1/5 Test #1: test_completion ..................   Passed    0.01 sec
2/5 Test #2: test_destroy_suspended ...........   Passed    0.01 sec
3/5 Test #3: test_race ........................   Passed    0.01 sec
4/5 Test #4: test_shutdown ....................   Passed    0.00 sec
5/5 Test #5: test_timer .......................   Passed    0.00 sec
100% tests passed, 0 tests failed out of 5
```

## ASan/UBSan 构建（-DCOSCHED_SANITIZERS=ON，detect_leaks=0*）

```
100% tests passed, 0 tests failed out of 5
```

\* 沙箱禁用 ptrace，LeakSanitizer 自身无法运行；地址/UB 检查全部通过。

## 各场景逐 frame 统计（测试程序实际输出）

`posted`=本 frame 排空的工作项，`resumed`=本 frame 恢复的协程数，
`freed`=归属本 frame 的协程帧释放次数，`timers_fired`=本 frame 触发的定时器。

### test_completion —— 手动完成，等待者恰恢复一次

```
  frame | posted | resumed | freed | timers_fired
      1 |      1 |       1 |     0 |            0   # 启动并挂起于 op
      2 |      1 |       1 |     0 |            0   # complete() 投递的 resume 执行
      3 |      0 |       0 |     1 |            0   # task 析构，释放计入此 frame
  totals: resumed=2 freed=1 pending_ops=0
```

第二次 `complete()` 返回 false（竞争已输），`resumed` 计数恒为 1。

### test_destroy_suspended —— 销毁挂起任务即撤销登记

```
  frame | posted | resumed | freed | timers_fired
      1 |      1 |       1 |     0 |            0   # 挂起于 op，pending_ops=1
      2 |      0 |       0 |     1 |            0   # reset() 撤销登记并释放帧
  totals: resumed=1 freed=1 pending_ops=0
```

销毁后 `pending_operations()==0`，之后的 `complete()` 返回 false，
等待者从未被恢复（`resumed==0`），无任何待处理工作。

### test_race —— complete() 与销毁竞争

```
  frame | posted | resumed | freed | timers_fired
      1 |      1 |       1 |     0 |            0   # 挂起
      2 |      1 |       0 |     1 |            0   # 已投递的 resume 空转；帧释放一次
  totals: resumed=1 freed=1 pending_ops=0
```

`complete()` 已投递 resume 后 `reset()` 先认领 waiter：frame 2 中
投递的 resume 成为 no-op（`resumed=0`），协程帧恰好释放一次。

### test_shutdown —— 关闭不留悬挂句柄

```
  frame | posted | resumed | freed | timers_fired
      1 |      3 |       3 |     0 |            0   # 3 个任务启动并挂起
      2 |      3 |       3 |     0 |            0   # shutdown 取消并恢复全部等待者
      3 |      0 |       0 |     0 |            0   # 队列已空，拒绝新工作
      4 |      0 |       0 |     3 |            0   # 3 个协程帧释放
  totals: resumed=6 freed=3 pending_ops=0
```

3 个等待者各被恢复恰好一次并捕获 `operation_cancelled`（含一个
100 frame 后的定时器）；关闭后 `post()` 返回 false、`complete()`
返回 false、`pending_operations()==0`。

### test_timer —— async_delay(3) 按 frame 触发

```
  frame | posted | resumed | freed | timers_fired
      1 |      1 |       1 |     0 |            0   # 挂起，定时器应于 frame 4 触发
      2 |      0 |       0 |     0 |            0
      3 |      0 |       0 |     0 |            0
      4 |      1 |       1 |     0 |            1   # 定时器触发并恢复等待者
      5 |      0 |       0 |     0 |            0
      6 |      0 |       0 |     1 |            0   # 帧释放
  totals: resumed=2 freed=1 pending_ops=0
```
