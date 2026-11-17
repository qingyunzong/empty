# Redis Cluster 槽位路由组件

一个无运行时依赖的 TypeScript 路由核心。它只依赖注入的 `transport` 和
`topology`，因此可以嵌入代理、网关或现有 Redis 客户端，也可以用内存集群做确定性测试。

## 能力

- 标准 CRC16/XMODEM 与 Redis hash tag 槽位计算。
- `stable`、`migrating`、`importing` 三种槽位状态。
- `MOVED` 持久修正槽位缓存；`ASK` 单次跳转，发送 `ASKING` 且不污染缓存。
- 管线结果严格按输入下标回填；同一节点的命令按输入顺序提交。
- 多键跨槽命令在准备阶段立即拒绝，不产生任何命令 I/O。
- 只有“可证明未执行”的命令才会重试；结果未知时不重试，避免非幂等命令重复执行。
- 旧 epoch 和过期的拓扑刷新不会覆盖更新的 `MOVED` 结果。

## 接入

```ts
import {
  SlotRouter,
  RedisReplyError,
  TransportError,
  type ClusterTransport,
  type TopologyProvider,
} from "dlks-formal-10174";

const transport: ClusterTransport = {
  async execute(node, command, context) {
    // context.asking === true 时，必须在同一连接上先发送 ASKING，
    // 紧接着发送 command，中间不能插入其他命令。
    //
    // 连接建立/写入前失败：
    //   throw new TransportError("connect failed", "not-sent");
    // 已写入但未收到完整回复：
    //   throw new TransportError("reply lost", "unknown");
    // Redis 错误回复：
    //   throw new RedisReplyError("-MOVED 3999 10.0.0.2:7000");
  },
};

const topology: TopologyProvider = {
  async load() {
    return {
      epoch: 42,
      nodes: {
        A: { host: "10.0.0.1", port: 7000 },
        B: { host: "10.0.0.2", port: 7000 },
      },
      slots: [
        { start: 0, end: 8191, owner: "A" },
        { start: 8192, end: 16383, owner: "B" },
      ],
      migrations: [
        { slot: 3999, from: "A", to: "B", state: "migrating" },
      ],
    };
  },
};

const router = new SlotRouter({ transport, topology });

const value = await router.execute({ name: "GET", args: ["user:42"] });

const results = await router.executePipeline([
  { name: "GET", args: ["{user:42}:name"] },
  { name: "INCR", args: ["{user:42}:visits"] },
  { name: "MGET", args: ["{user:42}:a", "{user:42}:b"] },
]);

for (const item of results) {
  if (item.ok) {
    console.log(item.index, item.value);
  } else {
    console.error(item.index, item.error);
  }
}
```

`topology` 也可以直接传一个静态 `TopologySnapshot`；需要主动刷新时调用
`router.refreshTopology()`。同一时刻只会有一个刷新请求，并发调用共享它。

## 槽位与重定向

路由始终先访问槽位当前 owner。迁出/迁入状态作为元数据保留，并暴露在
`SlotRoute.phase/source/target` 中：

| 状态 | owner | 行为 |
| --- | --- | --- |
| `stable` | 当前节点 | 直接执行 |
| `migrating` | 迁出源节点 | 源节点返回 `ASK` 时，携带 `ASKING` 跳到目标节点；不改缓存 |
| `importing` | 迁出源节点 | 同上；目标节点视角的迁入状态可见 |

`MOVED` 表示槽位归属已经永久改变：立即写入槽位缓存、清除迁移状态，并在
重定向上限内重试。`ASK` 只影响当前这一条命令，后续命令仍走缓存中的 owner。

## 重试与重复执行边界

自动重试只发生在命令确定没有执行的情况下：

| 情况 | 是否已执行 | 处理 |
| --- | --- | --- |
| `MOVED` / `ASK` | 否 | 重定向后重试 |
| `TRYAGAIN` / `CLUSTERDOWN` | 否 | 刷新拓扑后有限重试 |
| `TransportError("not-sent")` | 否，确定未写入 | 有限重试 |
| `TransportError("unknown")` | 不确定 | 不重试，抛 `IndeterminateExecutionError` |
| 普通 Redis 错误（如 `WRONGTYPE`） | 已处理并拒绝 | 原样抛出 |
| 无类型的普通异常 | 不确定 | 不重试，抛 `IndeterminateExecutionError` |

这条规则高于命令的幂等标记：结果未知时不会因为命令“看起来幂等”而重试，
从机制上杜绝 `INCR`、`APPEND`、`XADD` 等命令的重复副作用。

`maxRedirects` 默认 8，`maxTransportRetries` 默认 2，
`maxTryAgainRetries` 默认 3。

## 管线语义

- 返回数组与输入数组一一对应，`index` 即原始位置；无论节点回复先后都不会乱序。
- 发往同一节点的命令按输入顺序提交。不同节点之间并发执行。
- 实现了可选 `executeBatch()` 时，同节点的命令作为一个原生管线发送。
- 重定向和可安全重试的失败进入下一轮；每一轮仍按原下标处理。
- 跨槽多键命令在首轮 I/O 之前被标记为 `CROSS_SLOT` 错误，`attempts` 为空。
- 需要跨节点严格串行因果顺序时，应逐条调用 `execute()`；管线的顺序保证是
  结果顺序与同节点提交顺序。

## 命令键提取

内置常见命令的键位置，包括 `MSET`（隔位取键）、`MGET`/`DEL`（全部为键）、
`RENAME`/`SMOVE`（双键）、`EVAL`（`numkeys`）、`XREAD`（`STREAMS` 后成对）
以及 `ZUNIONSTORE` 等派生命令。

扩展命令可以通过两种方式接入：

```ts
import { CommandCatalog, SlotRouter } from "dlks-formal-10174";

const router = new SlotRouter({
  transport,
  commands: new CommandCatalog({
    MYCOMMAND: {
      keys: { firstKey: 1, lastKey: 2 },
      idempotent: false,
    },
  }),
});

// 或者单条命令直接给出键，优先级高于目录元数据。
await router.execute({ name: "MYCOMMAND", args: ["x", "a", "b"], keys: ["a", "b"] });
```

未知且未显式给键的命令按无键命令路由。需要严格隔离未知命令时，应在嵌入层
拒绝它，或为其补齐 `CommandCatalog` 元数据。

## 验证

```bash
npm run build
npm test
```

测试包含一条完整的迁移交错轨迹：

1. 稳定槽位上执行一次 `INCR`。
2. 开始迁移并把键迁到目标节点，缓存仍指向源节点。
3. 管线中的两个 `INCR` 和一个 `GET` 全部收到 `ASK`，携带 `ASKING` 在目标节点
   各执行一次。
4. 迁移完成后缓存仍是旧的，下一条命令收到 `MOVED`，缓存永久切到新 owner。
5. 后续管线不再产生重定向，最终拓扑刷新与本地缓存一致。

测试同时注入“已执行但回复丢失”的故障，断言非幂等命令只产生一次副作用，
并覆盖管线乱序回复、跨槽立即拒绝、`not-sent` 安全重试和原生批量管线。
