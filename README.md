# Webhook 入库组件（TypeScript）

可导入的 TypeScript webhook 入库组件，面向事件采集网关。按端点维护密钥世代、
时间容差、delivery id 与正文摘要，并把「验签 → 幂等/冲突判断 → 事务提交」收敛到
一条可重试的入库管线。

零运行时依赖，仅使用 Node 内置模块（`node:crypto`、`node:http`）。

## 保证的语义

- **密钥世代（key generations）**：每个端点配置一个或多个密钥。签名头可携带多个
  `version,kid,mac` 令牌，轮换重叠窗内新旧世代都能验签；任一世代验签通过即接受。
- **时间容差（replay window）**：签名时间戳与本机时钟的绝对差超过
  `timestampToleranceMs` 一律拒绝，先于 MAC 校验，过期重放无法通过。
- **delivery id 幂等**：相同 `(endpointId, deliveryId)` 且正文摘要相同，返回
  `duplicate` 回执，复用首次提交的偏移，不产生第二条事件。
- **正文冲突**：相同 delivery id 但正文 SHA-256 摘要不同，返回不可重试的
  `BODY_CONFLICT`（HTTP 409）。
- **重叠窗只接受一次**：轮换期间同一投递即使带了多把密钥的签名，也由 delivery id
  的幂等记录保证只入库一次。
- **事务原子性与可重试**：事件、偏移和幂等记录在同一个事务内写入。事务回滚不留下
  任何状态，发送方可安全重试；存储故障统一映射为可重试的 `TRANSACTION_FAILED`
  （HTTP 503）。
- **回执绑定已提交偏移**：只有事务 `commit()` 成功后才产生成功回执，回执的
  `committedOffset` 即该投递对应事件的已提交偏移（重复投递返回首次的偏移）。

## 签名信封

默认使用三个请求头（名称可在 HTTP 适配器中替换）：

| 头 | 含义 |
| --- | --- |
| `webhook-delivery-id` | 投递唯一标识 |
| `webhook-timestamp` | Unix 毫秒时间戳（非负整数） |
| `webhook-signature` | 一个或多个空格分隔的 `v1,<kid>,<base64url mac>` 令牌 |

签名算法为 HMAC-SHA256，被签名的规范串为
`Buffer.concat([ "<deliveryId>.<timestamp>." 的 UTF-8 字节, 原始正文 ])`，
MAC 以 base64url 编码。delivery id 与时间戳被绑定进规范串，防止替换或重排。

## 作为库使用

```ts
import {
  MemoryIngestionStore,
  WebhookIngestor,
  type EndpointConfig,
} from "dlks-de-0217";

const endpoints: EndpointConfig[] = [
  {
    id: "orders",
    // 第一个是当前世代，其余是轮换重叠窗内仍接受的旧世代
    keys: [
      { id: "key-2026", secret: process.env.ORDERS_KEY_2026! },
      { id: "key-2025", secret: process.env.ORDERS_KEY_2025! },
    ],
    timestampToleranceMs: 60_000,
  },
];

const ingestor = new WebhookIngestor(endpoints, new MemoryIngestionStore());

const receipt = await ingestor.ingest({
  endpointId: "orders",
  deliveryId: req.headers["webhook-delivery-id"],
  rawTimestamp: req.headers["webhook-timestamp"],
  body: rawBodyBuffer, // 必须是收到的原始字节
  signatureHeader: req.headers["webhook-signature"],
});

 // 仅当 commit 成功才会到达这里
receipt.status;          // "accepted" | "duplicate"
receipt.committedOffset; // 已提交偏移（十进制字符串，可直接 JSON 序列化）
```

## 作为 HTTP 服务

```ts
import { createWebhookServer } from "dlks-de-0217/http";

const server = createWebhookServer(ingestor, {
  pathPrefix: "/webhooks", // 路由为 POST /webhooks/:endpointId
  maxBodyBytes: 1_048_576,
});
server.listen(8080);
```

不持有 HTTP 生命周期（或禁止 `listen`）的环境可改用
`createWebhookRequestHandler(ingestor, options)`，它返回
`(req, res) => Promise<void>`，可挂到任意框架。

成功响应为 `200`，体即回执；错误响应统一为
`{ "error": { code, message, retryable, deliveryId? } }`：

| code | HTTP | retryable | 触发条件 |
| --- | --- | --- | --- |
| `MISSING_ENVELOPE` / `MALFORMED_ENVELOPE` | 401 / 400 | false | 缺头、时间戳或签名格式非法 |
| `TIMESTAMP_SKEW` | 401 | false | 超出时间容差 |
| `UNKNOWN_KEY` / `INVALID_SIGNATURE` | 401 | false | 密钥世代未知或 MAC 不匹配 |
| `UNKNOWN_ENDPOINT` | 404 | false | 路由端点未配置 |
| `BODY_CONFLICT` | 409 | false | 同 delivery id 不同正文 |
| `TRANSACTION_FAILED` | 503 | true | 事务未提交，可安全重试 |

## 接入数据库存储

实现 `IngestionStore` / `IngestionTransaction` 两个接口即可替换内置的
`MemoryIngestionStore`。要点：

- `begin` 开启事务并取得端点当前的 delivery 幂等记录视图；
- `findDelivery` 在事务内读取，配合 delivery id 唯一约束或行锁消除并发竞态；
- `appendEvent` 分配该端点单调递增的下一个偏移；
- `upsertDelivery` 与事件写入同一事务；
- `commit` 原子提交后再返回 `CommitReceipt`，任何异常都走 `rollback`，由管线转成
  可重试错误。

## 目录结构

- `src/crypto.ts`：正文摘要、规范串、签名生成与多世代验签
- `src/errors.ts`：稳定错误码、HTTP 状态与 `retryable` 标记
- `src/memory-store.ts`：带真实快照/回滚语义的参考事务存储（含故障注入钩子）
- `src/ingestor.ts`：验签 + 幂等/冲突 + 事务提交管线
- `src/http/server.ts`：Node `http` 适配器与可直接挂载的请求处理器
- `src/types.ts`：公共类型与默认头名
- `test/`：`node:test` 覆盖密码学、入库语义与 HTTP 全链路

## 构建与测试

本环境的 Node 未内置 TypeScript 执行能力，因此先编译再运行测试：

```bash
npm run build      # tsc 产出 ESM 与 .d.ts 到 dist/
npm run typecheck  # 仅类型检查
npm test           # 先编译到 dist-test/，再用 node --test 运行
```
