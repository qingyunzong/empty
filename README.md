# dlks_formal

可嵌入的 C++20 等待图与锁生命周期组件。只依赖标准库，单线程、无全局状态，调用方负责串行化锁管理器事件。

## 锁与边模型

- 顶点是事务，边 `waiter -> holder` 表示一个等待请求被某个当前持有者阻塞。边键包含 `resource` 和 `request`，因此同一对事务可以有多条并行边。
- 共享锁请求等待独占持有者；独占锁请求等待所有持有者。锁升级是事务已持有共享锁时请求独占锁，只等待其他共享持有者，不等待自己。
- 每个事务最多一个未完成请求。请求与当前持有者兼容且队列为空时立即授锁；否则进入该资源的 FIFO 队列。
- 取消、超时、释放或终止后，从队首开始授予兼容请求。FIFO 阻塞但当前持有者兼容的请求不会产生持有者边，这是等待图只表达“持有者阻塞”的结果。
- `grant(RequestId)` 是管理式授锁：可授予任意当前兼容的排队请求，允许越过 FIFO 队首；释放/终止路径严格按队首推进。

## 原子性

`cancel`、`timeout`、`advance_time` 的过期波、`grant`、`release`、`release_all`、`end_transaction` 都先完成全部锁表修改，再对受影响请求做一次 `apply_delta`。因此从查询视角看不到“请求已授出但旧边仍在”或“请求已取消但边仍在”的中间状态。`advance_time` 会先移除所有到期请求，再执行授锁，避免过期请求被新一轮授锁掩盖。

`WaitForGraph::apply_delta` 在第一次修改前检查所有新增边的端点；同一批中先删后加。

## 环与牺牲者

环检测以等待图的强连通分量（SCC）为单位。大小大于 1 的 SCC 或自环 SCC 是死锁环。每个环选一个牺牲者，全序为：

1. `cost` 升序（代价低者优先）；
2. 年龄降序（更老的事务优先）；
3. 事务号升序。

年龄为 `now - born`。该全序由唯一事务号收尾，因此选择结果稳定且可复现。`resolve_deadlocks()` 每轮为每个环（SCC）选择牺牲者并终止事务，然后重新分析；终止触发的授锁可能形成新边，因此一直迭代到无环。

## 增量 SCC

`WaitForGraph` 维护 SCC 划分和凝缩 DAG：

- 插入跨 SCC 边时，若新边闭合凝缩图中的环，只合并“从 holder 可达且可到达 waiter”的 SCC 集合。
- 删除跨 SCC 边只减少凝缩边计数，不改变 SCC。
- 删除 SCC 内部边时，仅对该 SCC 的诱导子图重跑 Tarjan，再重建受影响的凝缩边。

这避免每次事件全量重算，同时保持与全量 SCC 完全一致。

## 使用

```cpp
#include "dlks_formal.hpp"

using namespace dlks_formal;

LockManager locks;
locks.begin(7, /*cost=*/1);
locks.begin(8, /*cost=*/5);

auto first = locks.acquire(7, 42, LockMode::shared);
auto second = locks.acquire(8, 42, LockMode::shared);
auto third = locks.acquire(7, 43, LockMode::shared);
auto fourth = locks.acquire(8, 43, LockMode::shared);
auto upgrade_one = locks.acquire(7, 42, LockMode::exclusive); // 等待 8
auto upgrade_two = locks.acquire(8, 43, LockMode::exclusive); // 等待 7

const DeadlockAnalysis analysis = locks.deadlock_analysis();
const std::vector<TransactionId> aborted = locks.resolve_deadlocks();
```

直接使用图组件：

```cpp
WaitForGraph graph;
graph.add_transaction(1, TransactionProfile{/*cost=*/1, /*born=*/0});
graph.add_transaction(2, TransactionProfile{/*cost=*/2, /*born=*/0});
graph.add_edge(WaitEdge{1, 2, /*resource=*/42, /*request=*/1});
graph.add_edge(WaitEdge{2, 1, /*resource=*/42, /*request=*/2});

DeadlockAnalysis result = graph.analyze(/*now=*/10);
```

主要查询接口：

- `graph().edges()` / `edges_for_request(id)`：当前边。
- `analyze(now)`：全部 SCC、环和每个环的牺牲者。
- `holders(resource)` / `held_locks(tx)` / `pending_requests()` / `queue(resource)`：锁表快照。
- `assert_invariants()`：检查锁表、请求索引、边索引、SCC 与凝缩边的一致性。

## 验证

```sh
cmake -S . -B build -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试包含：

- 3 顶点有向图（含自环）全部 `2^9 = 512` 个边状态的穷举，每步与独立 Tarjan 全量 SCC 重算比对。
- 2 事务 × 2 资源 × 共享/独占/升级/取消/超时/授锁/释放/终止/时钟事件的深度 10 状态穷举，覆盖 56915 个可达状态、584197 次转移。
- 3 事务 × 1 资源的深度 10 穷举，覆盖 188468 个状态，并实际到达三事务升级环。
- 8 顶点、30000 次确定性随机增删边及周期性事务退出的差分压力测试，每步比对边集、SCC 与牺牲者。

穷举使用“锁表 + 时钟 + FIFO 队列”的行为规范键去重：忽略仅由单调递增请求号造成的等价状态，但保留所有会影响后续事件、环和牺牲者选择的状态。每个新状态都从公开锁表独立重建参考边集，再用全量 Tarjan 重算 SCC，逐项比较增量结果、环集合和牺牲者。
