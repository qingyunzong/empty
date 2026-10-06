# causal-broadcast

因果广播模拟库（TypeScript，零依赖）。按**每源序号**（per-source seq）与**依赖向量**
（vector clock）交付消息，保证交付顺序永远是因果偏序的线性扩展。

## 语义

- **交付规则**：消息可交付当且仅当 (1) 它是其源的下一个期望序号
  （`seq == frontier(source) + 1`），且 (2) 依赖向量中每个条目 `deps[node] <= n`
  所要求的前驱都已交付。满足条件的消息会级联解锁缓冲区中的其他消息。
- **前驱未到暂存**：暂不可交付的消息进入缓冲区，`pending()` /
  `pendingReasons(id)` 输出待决原因（`source-gap` 同源缺序号 /
  `missing-dependency` 缺依赖，含 `have`/`need`）。
- **重复处理**：相同 id 且内容完全一致 → 幂等返回 `duplicate`；
  相同 id 但内容不同（payload/deps/seq 任一不同）→ `rejected`（冲突拒绝）。
- **水位声明**：`declareWatermark({A: n})` 声明源 A 不会再有 `seq <= n` 的旧消息。
  水位单调不减；此后到达的 `seq <= n` 新消息被拒绝（`stale`）；该源的期望序号
  跳到 `n + 1`，`<= n` 的依赖条目视为被声明豁免；被水位越过的缓冲消息成为
  孤儿（`orphans()`，原因 `below-watermark`）。
- **因果不越过**：`verifyCausalOrder(log)` 是独立的拓扑顺序参考核验，
  检查交付日志是否为因果偏序的合法线性扩展。

## 使用

```ts
import { CausalBroadcast } from "./src/index.js";

const node = new CausalBroadcast<string>();
node.receive({ id: "A#1", source: "A", seq: 1, deps: {}, payload: "hi" });
const r = node.receive({ id: "B#1", source: "B", seq: 1, deps: { A: 2 }, payload: "x" });
// r.status === "buffered"
// r.pending === [{ kind: "missing-dependency", source: "A", have: 1, need: 2 }]
```

## 测试

```sh
npm test   # tsc 编译 + node:test 运行
```

测试包含单元用例（缓冲级联、去重/冲突、水位、待决原因）与性质测试：
随机生成多源因果消息图，对输入做任意重排后喂入，核验交付集合与输入一致、
每个交付前缀都通过 `verifyCausalOrder`，并对照独立的拓扑排序参考
（`assertLinearExtension`）确认因果不越过。
