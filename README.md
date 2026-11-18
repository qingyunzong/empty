# Channel Connection Pool

可嵌入通道层的 TypeScript 连接池状态机。组件只维护子连接状态，不持有
socket、不创建定时器；连接建立、时钟推进和健康探测结果都由宿主驱动，因此
同一事件序列总能得到同一结果。

## 使用方式

```ts
import { ConnectionPool } from "./src/pool.ts";

const pool = new ConnectionPool({
  backoff: { baseMs: 100, factor: 2, maxMs: 30_000 },
});

// 1. 注册成员，拿到连接尝试令牌。
const first = pool.add("edge-a");
// 宿主建立连接成功后回传令牌。
pool.connected("edge-a", first.attempt);
// 或失败：
// pool.failed("edge-a", first.attempt);

// 2. 由宿主时钟推进退避。
const due = pool.advance(100);
for (const attempt of due) {
  // attempt.id / attempt.attempt 交给真实连接器。
}

// 3. 健康检查。检查期间成员仍可被选择，失败才移出就绪集合。
const ticket = pool.beginHealthCheck("edge-a");
if (ticket !== null) {
  pool.completeHealthCheck(ticket, true);
}

// 4. 负载选择：轮询或稳定键亲和。
const member = pool.select();
const affinity = pool.selectForKey("tenant:42");
```

## 状态与不变量

- `connecting`：正在建立连接，不可选择。
- `ready`：唯一可被负载选择的状态，`readyCount === readyIds.length`。
- `reconnecting`：等待 `retryAt`，不可选择；同一个失败尝试只推进一次退避。
- `closed`：终态。

退避是无抖动的确定性指数序列：第 `n` 次连续失败等待
`min(maxMs, baseMs * factor^(n-1))`。连接尝试令牌和健康检查令牌都会随状态
推进递增，因此旧尝试或旧探测的迟到结果只会被丢弃，不会把新状态拉回
`reconnecting` 或提前置为 `ready`。

选择顺序按成员 id 排序，与插入顺序、Map 顺序和 locale 无关。`select()`
在就绪成员间轮询；`selectForKey(key)` 使用 FNV-1a rendezvous 选择，同一 key
和同一就绪集合始终命中同一成员。

## 测试

`npm test` 先用 `tsc` 编译，再运行 Node 测试。差分测试会穷举长度不超过 4 的
全部事件序列（17 个动作、88,741 条序列），并用独立朴素状态机逐事件核对
状态快照、就绪集合、轮询选择与 key 亲和结果；另有 2,000 条长度 16 的种子化
序列覆盖更深的交错路径。
