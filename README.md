# dlks_formal：C++20 梯度桶调度组件

可嵌入训练运行时的 all-reduce 梯度桶调度器，配合离散事件模拟器对反向
依赖图做形式化对照验证。仅依赖 C++20 标准库，头文件即接口。

## 组件

- `include/dlks/formal/gradient_bucket_scheduler.hpp`
  - `GradientBucketScheduler`：依据张量依赖、就绪时刻与桶容量安排
    all-reduce，并通过在途窗口与反向计算重叠。
  - `Buffer`：引用计数桶缓冲，调度器与通信层各持一份引用，最后一方
    释放时回收，取消路径不会 double-free 或提前回收。
  - `TrackingMallocAllocator`：原子记录存活/峰值字节与分配次数。
- `include/dlks/formal/discrete_event_simulator.hpp`
  - `DiscreteEventSimulator`：事件队列驱动真实调度器，模拟反向 DAG
    计算与线性耗时 all-reduce，运行后对照 DAG 校验不变量。

## 调度语义

1. `register_tensor(param_id, bytes)` 按反向预期就绪顺序登记。同一
   `param_id` 重复登记表示参数共享：字节只在首次计入桶，但每次登记都
   对应一次 `mark_ready` 贡献，全部贡献完成后该参数才就绪。
2. 顺序装箱：普通参数填满当前开放桶即封闭并开新桶；超过容量的单个
   参数独占一个立即封闭的桶。
3. `mark_ready` 递减参数贡献计数；桶内全部参数就绪且桶已封闭时才进入
   可发射集合，由 `pump` 按桶 id 顺序、受 `max_inflight_buckets` 窗口
   约束发射，保证不会提前通信。
4. `complete(request_id)` 回收完成桶并立即补位，实现通信与后续反向
   计算重叠。
5. `cancel()` 幂等：停止发射新桶、对全部在途请求触发 `AllreduceAbort`，
   调度器侧引用立即释放；通信层仍持有的引用在其中止后释放。

## 三条不变量（模拟器自动校验）

- **无提前通信**：桶发射时刻不早于其任一参数在 DAG 上的最早就绪
  下界（最长前驱路径完成时刻），也不早于模拟中的实际就绪时刻。
- **无重复字节**：每个参数恰好出现在一个发射桶；桶字节数等于成员
  参数字节数之和；共享参数只归集一次。
- **峰值内存受限**：在途桶数从不超过窗口；峰值受
  `(max_inflight_buckets + 1) × 最大桶字节` 约束（`complete` 先分配
  补位桶再回收完成桶，存在一个过渡时刻）。

## 构建与测试

```bash
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试目标：

- `test_scheduler`：装箱、共享去重、在途窗口、超大参数、取消安全、
  输入校验（7 个用例）。
- `test_simulator`：线性链、fork-join 共享、中途取消、峰值内存界、
  计算/通信重叠、环图拒绝（6 个用例）。
- `test_invariants`：注入式负向测试，篡改模拟报告后校验器必须捕获
  提前通信与重复字节（4 个用例）。

所有头文件在 `-Wall -Wextra -Wpedantic -Wshadow -Wconversion
-Wsign-conversion -Werror` 下零告警；测试已通过 ThreadSanitizer 与
AddressSanitizer/UBSan 验证。
