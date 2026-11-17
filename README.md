# dlks_formal

可嵌入数据面的 C++20 层级分组调度组件。实现位于单头文件
`include/dlks_formal.hpp`，无第三方依赖。

## 语义

- **层级权重**：根端口下可建任意深度的 group，group 下挂 queue。每一层都按
  子节点权重做加权公平调度；一个 group 的权重约束该子树的总服务量。
- **包长参与虚拟完成时间**：队首包的虚拟服务代价为 `ceil(L * SCALE / weight)`。
  同样权重下，长包占用更多虚拟时间，因此长期按字节而非按包数公平。
- **空闲恢复**：节点从空队列恢复为可调度时，先把历史虚拟完成位置钳制到父节点
  当前虚拟时间，再计算新包的完成时间。旧欠额不会变成恢复后的突发。
- **权重平滑更新**：`set_weight()` 只使待调度队首包的缓存失效，保留节点的
  虚拟历史。新权重从下一个被选中的包开始生效，不会把整个积压包队列按旧权重
  一次性结算。
- **令牌桶整形**：每个 group/queue 以及根端口都可以配置字节令牌桶。子节点只
  有在当前队首包能通过路径上全部令牌桶时才是候选；令牌不足时，其它可发送的
  兄弟节点继续使用链路。整形节点先按 WFQ 选出队首包，再整体检查本节点令牌；
  不会为了让小包先走而跳过自己的大包队首，从而避免小包持续偷走令牌造成饿死。
- **稳定顺序**：虚拟完成时间相同时，依次按包的入队序号、节点 id 决胜。因此
  同值下顺序确定，不依赖容器/堆的内部实现。

虚拟标签使用定点整数，避免浮点比较导致同值抖动。令牌计数使用
`bytes * 10^9` 的整数单位，时间单位为纳秒，速率单位为字节/秒。

## 快速使用

```cpp
#include <dlks_formal.hpp>

using namespace dlks;

HierarchicalScheduler sched;

auto gold   = sched.add_group(HierarchicalScheduler::kRoot, 3);
auto silver = sched.add_group(HierarchicalScheduler::kRoot, 1);

auto voice = sched.add_queue(gold, 2);
auto video = sched.add_queue(gold, 1);
auto bulk  = sched.add_queue(silver, 1,
                             TokenBucketConfig{2'000'000, 64'000});

// 可选：根端口整形。时间 now 使用纳秒。
sched.set_shaper(HierarchicalScheduler::kRoot,
                 TokenBucketConfig{10'000'000, 64'000});

const SchedulerTime now = 0;
sched.enqueue(voice, Packet{/*id=*/1, /*bytes=*/1200}, now);
sched.enqueue(video, Packet{/*id=*/2, /*bytes=*/9000}, now);
sched.enqueue(bulk,  Packet{/*id=*/3, /*bytes=*/32000}, now);

if (auto selected = sched.dequeue_selected(now)) {
    // selected->packet 是包描述，selected->queue 是实际出队叶子。
}

// 离散事件驱动可以直接跳到下一次整形可用时刻。
if (auto wake = sched.next_ready_time(now)) {
    // now = *wake;
}
```

主要 API：

- `add_group(parent, weight, optional<TokenBucketConfig>)`
- `add_queue(parent, weight, optional<TokenBucketConfig>)`
- `set_weight(node, weight)`
- `set_shaper(node, optional<TokenBucketConfig>)`
- `enqueue(queue, Packet, now)`
- `dequeue(now)` / `dequeue_selected(now)` / `peek(now)`
- `next_ready_time(now)`
- `backlog_packets(node)`

时间必须单调不减。调度器本身不加锁，嵌入时由调用方串行化。

## 构建与验证

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试程序是一个离散事件模型：时间只推进到包发送完成、配置/到达动作或令牌桶
重新可用的时刻。覆盖：

| 验证项 | 断言 |
| --- | --- |
| 长期带宽比例 | 2:1 平包长期字节份额为 2/3 |
| 包长参与 | 等权重下 400B/1200B 包长期字节份额约 1:1，包数约 3:1 |
| 层级权重 | 3:1 类聚合，类内 queue 等分 |
| 整形峰值 | 1ms/20ms 滑动窗口不超过 `burst + rate * window`，2s 均值受速率限制 |
| 空队列恢复 | A 长期独占后 B 恢复，B 在随后窗口只得到公平份额，无历史欠额暴发 |
| 空 group 恢复 | 层级节点整体变空再恢复，同样被父层虚拟时间钳制 |
| 权重更新 | 1→8→1 时长期份额收敛，且更新后首个窗口立即生效、不饿死兄弟节点 |
| 同值稳定顺序 | 三个等权队列严格按入队顺序轮转；跨权重同完成时间仍按入队顺序 |
| group 整形 | 受限 group 的聚合速率受令牌桶约束，其它 group 使用剩余链路 |
| group 整形公平性 | 同一受限 group 内大包/小包混合时，大包不会被小包饿死 |

## 设计边界

- 包不可抢占，叶子队列内部严格 FIFO。
- 选择每层扫描兄弟节点；标签按队首包惰性缓存。该结构适合嵌入到已有轮询/事件
  循环中，不依赖堆或全局虚拟时间。
- 队列积压使用 `std::deque`，节点表使用 `std::vector`；提供
  `reserve_nodes()` 便于启动时预留。
- 令牌桶要求整个包长度可用；`burst_bytes` 小于某队首包时，该包无法通过该
  整形器并会阻塞对应节点。若没有任何可发送包，`next_ready_time()` 返回
  `nullopt`。
- 修改整形器配置会重新装满令牌桶；重复设置完全相同的配置是空操作。
- 令牌桶约束的是 `dequeue()` 选择时刻；实际报文完成时刻还要由调用方加上链路
  串行化时间。
- 虚拟标签在极长运行时间下饱和到 `INT64_MAX`，同值仍由包序号稳定决胜。
