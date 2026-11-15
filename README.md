# SAP ODP delta queue 确认

企业数据连接器可导入的 TypeScript delta queue 状态机，把 subscriber、request id、package id
和最终确认绑定。包可重复拉取且乱序，只有整 request 所有包落库后确认；取消后迟到包不复活。
初始化全量（bootstrap）与后续 delta 使用不同世代（generation）且不可交叉。

## 模块结构

- `index.ts` — 唯一导入入口，聚合导出全部公开 API。
- `src/types.ts` — 世代、请求、包、收据以及存储/落库/确认网关的接口定义。
- `src/errors.ts` — `DeltaQueueError` 与机器可读错误码（`GENERATION_MISMATCH` 等）。
- `src/snapshot.ts` — 持久化快照结构、复合 request key、世代比较与完成判定工具。
- `src/memory-store.ts` — 参考实现 `InMemoryStateStore`，加载/保存均深拷贝隔离引用。
- `src/delta-queue.ts` — 纯状态机 `DeltaQueue`，不做任何具体 I/O。
- `src/connector.ts` — `DeltaQueueConnector`，把状态机与 `PackageSink`、`AckGateway` 编排起来。

## 状态与不变量

请求状态机：`open` → `persisted` → `acked`，或任意非终态 → `canceled`。`acked` 与
`canceled` 均为终态。

- **世代围栏**：每个 subscriber 首个世代必须是 `bootstrap`（sequence 0），其后只能开 `delta`
  （sequence 1、2、…）。新世代必须在旧世代 `sealGeneration` 之后才能开启，世代不会重叠或交错。
- **请求绑定**：request 打开时绑定 subscriber、request id 与世代 token；重复打开同世代同
  request 是幂等的，跨世代复用 request id 抛 `REQUEST_ALREADY_EXISTS`。
- **包去重与乱序**：`handlePackage` 按 package id 去重，重复包返回 `duplicate` 且不再调用
  sink；到达顺序无关。显式 id 模式拒绝集合外的包，计数模式拒绝超额包。
- **整 request 才确认**：全部期望包落库后请求才进入 `persisted`；`acknowledge` 此前抛
  `REQUEST_NOT_PERSISTED`。确认收据 `AckReceipt` 同时绑定 subscriber、request、世代与完整
  package id 列表；重复确认幂等返回同一张收据。
- **取消不复活**：取消后到达的包返回 `ignored / request-canceled`，不写 sink、不改变状态，
  已确认请求的迟到包同理（`request-acked`）。
- **失败语义**：sink 抛错时状态不变，可安全重试；连接器中网关失败后内部已是 `acked`，
  `confirm` 重发确认即可，保证至多一次落库、至少一次确认。

## 使用示例

```ts
import {
  DeltaQueue,
  DeltaQueueConnector,
  InMemoryStateStore,
  type PackageSink,
  type AckGateway,
} from './index.js';

const queue = await DeltaQueue.create({ store: new InMemoryStateStore() });
const connector = DeltaQueueConnector.create(queue, sink satisfies PackageSink, gateway satisfies AckGateway);

const bootstrap = await queue.beginGeneration('subscriber-1', 'bootstrap');
await queue.openRequest({
  subscriberId: 'subscriber-1',
  requestId: 'req-full',
  generation: bootstrap,
  expectedPackageIds: ['pkg-1', 'pkg-2'],
});

// 乱序、重复都安全；最后一个包落库时连接器自动发出最终确认。
await connector.deliver({
  subscriberId: 'subscriber-1',
  requestId: 'req-full',
  generation: bootstrap,
  packageId: 'pkg-2',
  payload: { rows: [] },
});
```

接入真实系统时实现两个端口：`PackageSink.persistPackage` 负责落库，`AckGateway.confirm`
负责向源系统回传确认；持久化则实现 `StateStore`（快照为纯 JSON 结构，可直接入库）。

## 测试

当前 Node 构建不支持原生 TypeScript 执行，因此先用 `tsc` 编译到 `build-test/` 再运行
node:test（该目录已在 `.gitignore`）：

```bash
npx tsc --noEmit          # 严格类型检查（strict + noUncheckedIndexedAccess）
npm test                  # tsc -p tsconfig.test.json && node --test 'build-test/**/*.test.js'
```

测试覆盖世代围栏与跨世代隔离、乱序/重复/超额包、checksum 冲突、sink 失败重试、整 request
确认、取消终态、快照重启恢复以及并发重复投递。
