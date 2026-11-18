# TLS 1.3-style handshake component

可嵌入的 TypeScript 握手组件，重点实现 TLS 1.3 的密钥计划、状态推进、
HelloRetryRequest、0-RTT 防重放和服务器证书核验。核心不依赖网络或全局状态；
哈希/HKDF、密钥交换和证书验证都可以注入。

## 特性

- 显式状态机：所有状态跳转经过转移表，越界跳转立即进入 `failed`。
- RFC 8446 §7.1 密钥计划：`early_secret`、`handshake_secret`、`master_secret`、
  traffic secret/key/iv、`finished` key、resumption secret。
- 密钥派生有确认门槛：ClientHello 确认前没有 early key；ServerHello 验证前没有
  handshake key；服务器 Finished 验证前没有 application key；客户端 Finished
  确认前没有 resumption secret。
- HelloRetryRequest：使用 RFC 8446 特殊 random，按
  `message_hash(CH1) || HRR || CH2` 折叠转录；HRR 后禁止 0-RTT，第二次 HRR 失败。
- 0-RTT 防重放：ticket 单次使用；同 ticket 或同 ClientHello random 再次出现即判定
  replay，只拒绝 early data，不中断 1-RTT 握手。
- 证书核验：先校验证书链，再用 `CertificateVerify` 校验
  `64*0x20 || context || 0x00 || transcript-hash`。
- 重传幂等：`resend()` 只重发上一飞行，不改变状态、不重复派生；重复收到的消息
  按 message id + body 识别。

## 快速使用

```ts
import {
  ClientHandshake,
  ServerHandshake,
  NodeCryptoProvider,
  X25519KeyExchangeProvider,
  InMemoryTicketStore,
  EarlyDataReplayGuard,
} from "./index.ts";

const crypto = new NodeCryptoProvider();

const client = new ClientHandshake({
  crypto,
  keyExchange: new X25519KeyExchangeProvider(),
  certificateVerifier,          // 必须注入真实 X.509 校验器；默认 fail closed
  serverName: "example.com",
});

const server = new ServerHandshake({
  crypto,
  keyExchange: new X25519KeyExchangeProvider(),
  credentials: {
    certificateChain,
    signCertificateVerify: ({ data }) => ({
      algorithm: "ecdsa_secp256r1_sha256",
      signature: signWithServerKey(data),
    }),
  },
  ticketStore: new InMemoryTicketStore(tickets),
  replayGuard: new EarlyDataReplayGuard(), // 跨连接共享
});

server.start();
let flight = client.start();            // [ClientHello]
flight = server.receive(flight[0]);     // [ServerHello, EE, Certificate, CV, Finished]
let clientFlight = [];
for (const message of flight) clientFlight = client.receive(message);
for (const message of clientFlight) server.receive(message);
client.confirmSent();                   // 确认 client Finished 后才派生 resumption secret
```

`confirmSent(id?)` 表示消息已由传输层确认。它是早期密钥和 resumption secret 的
显式派生门槛；重复确认是幂等的。

## 密钥派生门槛

| 触发点 | 可派生内容 | 不可提前出现 |
| --- | --- | --- |
| `ClientHandshake.start()` | 只构造 ClientHello/转录 | 任何 traffic key |
| `confirmSent(ClientHello)` | `early_secret`、early traffic key/iv | handshake key |
| 收到并校验 `ServerHello` | `handshake_secret`、cHS/sHS key/iv | application key |
| 收到并校验服务器 `Finished` | `master_secret`、cAP/sAP/exporter key | resumption secret |
| `confirmSent(client Finished)` | `resumption_master_secret` | — |

服务器端在提交 ServerHello 后派生 handshake key，在提交自己的 Finished 后派生
application key；客户端必须实际收到并验证对应消息。所有派生记录在
`keySchedule.audit`，包含 `phase`、`label`、`trigger` 和状态上下文。

## 0-RTT

```ts
const client = new ClientHandshake({
  // ...
  earlyData: { ticket, ticketAge: 0 },
});

const [clientHello] = client.start();
client.confirmSent(clientHello.id);     // 唯一允许派生 early traffic key 的入口
const record = client.sendEarlyData(payload);

server.receive(clientHello);            // 检查 ticket、有效期和 replay guard
const plaintext = server.receiveEarlyData(record);
```

- 重放/过期/未知 ticket 只把 early data 标记为拒绝；`receiveEarlyData()` 抛
  `EarlyDataReplayError` 或 `EarlyDataRejectedError`，握手本身仍可继续。
- 服务器未选择 PSK 时，客户端会丢弃 PSK early secret，1-RTT 使用零 PSK 计划，
  避免双方 handshake key 不一致。
- HRR 后 early traffic key 被清零；但 `early_secret` 仅在 PSK 未被选择时才会清除。

## 状态机

客户端：

```text
start -> initial_hello_sent -> [retry_hello_sent] -> wait_encrypted_extensions
      -> wait_certificate -> wait_certificate_verify -> wait_server_finished
      -> finished_sent -> connected
```

服务器：

```text
start -> wait_client_hello -> [wait_second_client_hello] -> wait_client_finished -> connected
```

任意非法事件或越界跳转进入 `failed`。`failed` 是吸收态。`resend()` 只允许在可重传
状态执行，并且是自环。

## 验证

```bash
npm test
```

测试包含：

- RFC 5869 HKDF 向量，以及独立实现的 RFC 8446 密钥计划逐项对照（SHA-256/SHA-384）。
- 完整握手、HRR、0-RTT 接受/拒绝、ticket 重放、证书链/签名失败、乱序消息和二次 HRR。
- 客户端/服务器事件序列穷举（深度 5）与独立状态 oracle 对比，并检查失败吸收性、
  `resend` 自环和密钥阶段单调性。
- HRR 转录折叠与独立 `message_hash || HRR || CH2 || SH` 计算对照。

## 边界

该组件负责握手状态、密钥计划和准入判断，不实现记录层 AEAD、X.509 DER 解析或
真实网络传输。默认 `PortableCryptoProvider` 是纯 TypeScript 的同步
SHA/HMAC/HKDF 实现；`NodeCryptoProvider` 与 `X25519KeyExchangeProvider` 只是
可替换的 Node.js 适配器。实际嵌入时应注入经过审计的 `CertificateVerifier`、
密钥交换实现和记录层实现。
