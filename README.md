# causal-broadcast

因果广播模拟库（TypeScript，零依赖）：按**每源序号**与**依赖向量**（向量时钟）交付消息。

## 语义

- **因果交付**：消息仅当其源序号连续（前驱均已交付或被水位覆盖）且 `deps` 依赖向量全部满足时交付，否则暂存；前驱到达后按因果序级联交付。
- **重复处理**：同 ID 同内容幂等忽略（`duplicate`）；同 ID 异内容拒绝（`conflicting-duplicate`）；同源同序号异 ID 拒绝（`conflicting-sequence`）。
- **水位**：`declareWatermark(source, k)` 声明该源 `seq <= k` 的消息不会再到达。之后到达的旧消息被拒绝（`below-watermark`）；被序号空洞/依赖缺口阻塞的后续消息按水位放行。水位只升不降。
- **待决原因**：`pending()` / `pendingReasons(id)` 输出暂存消息的阻塞原因（`missing-predecessor` / `missing-dependency`）。

## 用法

```ts
import { CausalBroadcast } from './src/causal-broadcast.js';

const bc = new CausalBroadcast();
bc.receive({ id: 'A#1', source: 'A', seq: 1, deps: {}, content: 'hi' });
bc.receive({ id: 'B#1', source: 'B', seq: 1, deps: { A: 1 }, content: 'ack' });
console.log(bc.delivered().map((m) => m.id)); // ['A#1', 'B#1']
```

## 测试

```sh
npm test   # tsc 编译 + node --test
```

测试包含：基本交付/暂存/级联、重复与冲突拒绝、水位语义，以及属性测试——
随机生成多源因果历史，对输入做**任意重排**，对照 **Kahn 拓扑参考**核验交付日志
是合法线性扩展（因果不越过），且逐步验证每次交付时依赖向量均已满足。
