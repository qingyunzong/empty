# delivery-scheduler

交付库事件调度器(TypeScript, 仅依赖 Node.js 内置库, 运行时零第三方依赖)。

## 规则

1. **候选必须依赖全满足**: 事件只有在其全部依赖交付完成后才成为候选。
2. **候选间排序**: 优先级高者优先; 优先级并列则 ID 小者(字典序)优先。
3. **高优先级不能越因果**: 优先级只在就绪候选之间打破先后, 永远不能跳过未满足的依赖。
4. **取消事件**: 被取消事件永不交付, 但其元数据完整保留在计划的 `cancelled` 列表中;
   其全部传递后继被阻塞, 并输出从被取消根因到每个被阻塞事件的**阻塞链**(菱形依赖输出全部路径)。
5. 依赖环上及依赖环的事件同样被阻塞, 阻塞链以环为根因。

## 输出

`planDeliveries(events, cancelledIds)` 返回 `DeliveryPlan`:

- `deliveries`: **交付证书**列表, 按交付顺序排列。每份证书含连续交付序号 `sequence`(逻辑时钟)、
  事件 ID、优先级、`satisfiedDeps`(每个依赖及其交付序号, 证明交付时依赖已满足)与元数据快照。
- `blocked`: 被阻塞事件(按 ID 排序), 含阻塞原因(`cancelled-dependency` / `dependency-cycle`)、
  全部阻塞链与保留的元数据。
- `cancelled`: 被取消事件(按 ID 排序), 元数据保留。

## 使用

```ts
import { planDeliveries } from "./src/scheduler";

const plan = planDeliveries(
  [
    { id: "A", priority: 1 },
    { id: "B", priority: 99, deps: ["A"] }, // 优先级最高, 仍须等 A
    { id: "C", priority: 50 },
  ],
  [],
);
// plan.deliveries 顺序: C, A, B
```

## 构建与测试

需要 Node.js(>= 18)与全局可用的 `tsc`(本仓库用 TypeScript 7.0.2 验证)。

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行全部测试
```

测试内容:

- `test/scheduler.test.ts`: 单元测试 —— 依赖满足、候选排序、取消传播与元数据保留、
  菱形阻塞链、证书序号、依赖环、输入校验、确定性。
- `test/enumeration.test.ts`: **小 DAG 枚举核对** —— 枚举 n<=4 个节点上的全部 DAG
  (每对节点: 无边/两个方向, 过滤有环图), 乘以全部 {1,2} 优先级向量(外加一个全异优先级向量)
  与全部取消子集, 用测试内独立的参考实现逐步核对: 交付序列完全一致、因果性、证书序号连续、
  阻塞集合一致、交付/阻塞/取消互斥且完备、取消元数据保留、阻塞链良构。

## 实际测试结果

在本环境(Node.js v22.22.1, tsc 7.0.2)执行 `npm test` 的实际输出摘要:

```
enumerated 572 DAGs, verified 149562 scheduling cases
# tests 2
# pass 2
# fail 0
# duration_ms ~3600-5000
```

即: 枚举 572 个 DAG、149,562 个调度场景全部核对通过, 2 个测试文件全部通过, 0 失败。
