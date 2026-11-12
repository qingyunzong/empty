# RESP3 子集字节解析与响应/推送解复用

面向 Node.js 22 采集宿主的离线字节解析包。它接收同一 RESP 连接上的任意
`Uint8Array` 片段，产出一条条完整的顶层普通值或顶层推送，并把普通值按
票据登记顺序交给解复用器。它不连接 Redis、不包含界面，也不实现超出本文
所述子集的 RESP3 类型。

## 快速开始

```ts
import { Decoder, Demultiplexer } from "dataeng-20261112-0325";

const decoder = new Decoder({
  maxHeaderBytes: 64 * 1024,
  maxDepth: 128,
  maxMessageNodes: 100_000,
  maxAttributePairs: 1_000,
  maxLeafBytes: 16 * 1024 * 1024,
});
const demux = new Demultiplexer<string>(decoder);

demux.register("request-1");
demux.register("request-2");
demux.cancel("request-2"); // 保留位置，变成墓碑

demux.pushBytes(chunk1);
demux.pushBytes(chunk2);

while (true) {
  const delivery = demux.next();
  if (delivery === null) break;
  if (delivery.disposition === "push") {
    handlePush(delivery.message);
  } else {
    handleResponse(delivery.ticket, delivery.disposition, delivery.message);
  }
}
```

`pushBytes` 可以接收连接层交来的任意片段，包括空片段。`next()` 在字节尚
不足一个完整帧时返回 `null`；已经完整的消息不会被撤回。结构、计数或预算
错误是永久失败态：先交付此前已完整的消息，随后每次 `next()`/`finish()`
都抛出同一个 `RespProtocolError`，当前半帧永不交付。

## 构建与导入

```bash
npm run build       # tsc -> dist，生成 JS 与 .d.ts
npm run typecheck   # 仅类型检查
npm test            # 构建并运行 node:test
npm run example     # 运行采集宿主示例
```

源码可在 TypeScript 工程中直接引用 `index.ts`。发布入口为
`dist/index.js`，类型入口为 `dist/index.d.ts`。包没有第三方运行时依赖。

## 值模型

所有实际值都有 `attributes: AttributePair[]`。属性紧邻下一个实际值，
连续属性块的 pair 按出现顺序串接，重复键保留。

```ts
type RespValue =
  | { type: "simple-string"; value: Uint8Array; attributes: AttributePair[] }
  | { type: "simple-error"; value: Uint8Array; attributes: AttributePair[] }
  | { type: "integer"; value: bigint; attributes: AttributePair[] }
  | { type: "null"; attributes: AttributePair[] }
  | { type: "blob"; chunks: Uint8Array[]; value: Uint8Array; attributes: AttributePair[] }
  | { type: "array"; value: RespValue[]; attributes: AttributePair[] }
  | { type: "map"; value: MapEntry[]; attributes: AttributePair[] };

interface MapEntry {
  key: RespValue;
  value: RespValue;
}
type AttributePair = MapEntry;
```

- `simple-string`/`simple-error` 的 `value` 是原始字节，不做 UTF-8 转码。
- `integer` 使用 `bigint`，范围为 int64。
- `blob` 的 `chunks` 保留物理分块来源；`value` 是各 chunk 的逻辑拼接，不含
  `;n` 块头。固定 `$n` 有一个 chunk（允许空 chunk），`$?` 每个非空 `;n`
  对应一个 chunk，`$?;0` 没有 chunk。
- `map` 使用有序 `MapEntry[]`，不转 JS 对象、不按字符串键去重。
- `ValueMessage.attributes` 与根值 `value.attributes` 是同一个数组；
  `PushMessage.attributes` 是推送自身的属性，载荷各值保留自己的属性。
- `range` 是相对于该解码器收到的第一字节的绝对半开区间，包含消息前的属性块。

## 支持的字节语法

每个行头以 CRLF 结束：

| 标记 | 含义 |
| --- | --- |
| `+text` / `-text` | simple 字符串/simple 错误；投递前文本中不允许孤立 CR 或 LF |
| `:number` | 可选负号、无前导零的 int64 十进制；`0` 合法，拒绝 `-0` |
| `_` | 必须是 `_\r\n` |
| `$n` | 恰好 n 个任意字节，随后 CRLF |
| `$?` | 流式 blob：重复 `;n`（n>0，n 字节后 CRLF），以 `;0` 行结束 |
| `*n` / `*?` | 定长数组 / 以 `.\r\n` 结束的流式数组 |
| `%n` / `%?` | n 对键值的定长 map / 以 `.\r\n` 结束的流式 map |
| `\|n` | n 对属性前缀；块本身不占值位置、不计节点 |
| `>n` | 顶层推送，n>=1；不允许嵌套 |

长度和计数只接受无符号、无前导零十进制，`0` 合法。解析先用 `BigInt`
检查预算，再确认不超过安全索引。`$-1`、`*-1` 等 RESP2 特殊 null 不接受。
`;` 与 `.` 只允许出现在各自的流式上下文；流式 map 以 `.` 结束时必须恰好
成对，奇数项结束是永久错误。

本包不支持其他 RESP3 类型、`|?` 流式属性、`>?` 流式推送，也不保证与线上
Redis 的全部扩展行为兼容。

## 限额

| 选项 | 默认值 | 计数方式 |
| --- | ---: | --- |
| `maxHeaderBytes` | 65536 | 单个行头，含一字节类型前缀、不含末尾 CRLF |
| `maxDepth` | 128 | 顶层实际值深度 1；容器子值和属性键值在当前深度加 1 |
| `maxMessageNodes` | 1000000 | 每消息；每个实际值、数组/map/push 自身各 1 节点 |
| `maxAttributePairs` | 10000 | 每消息所有（含嵌套）属性 pair 总数 |
| `maxLeafBytes` | 67108864 | 每消息 simple 文本/错误和 blob 正文字节总量 |

属性块自身不计节点，但它的全部键值照常计节点、深度和叶字节。连续属性块
不会自动增加深度；紧随其后的实际值仍使用原当前深度。定长声明在读取正文
前就检查节点/叶预算；流式数组/map 对每个值累计检查，流式 blob 对每个
`;n` 累计检查，`?` 永不等于无限。空容器自身仍占一个节点。

## 票据解复用

- `register(ticket)`：按调用顺序入队；同一 ticket 永远不能再次登记。
- `cancel(ticket)`：只对等待中的 ticket 有效；原地留下 `discarded` 墓碑。
- 普通顶层值（包括错误、null）消耗队首位置，即使该位置已取消。
- 取消位置收到响应时返回 `disposition: "discarded"` 并携带原 ticket，不会
  把响应移交给下一个请求。
- `push` 返回 `disposition: "push"`，`ticket` 为 `null`，不消耗队列。
- 队列为空时普通值返回 `disposition: "unsolicited"`、`ticket: null`。
- 取消未知、已取消或已完成的 ticket 抛出 `DemuxError`，队列不变。
- 只有完整消息才进入 `consume`/`next` 并推进票据；半帧、孤立属性、截断或
  永久错误都不会提前完成 ticket。

`consume(message)` 也作为独立接口公开，供宿主把已完整解析的消息接入自己的
调度逻辑；常规路径直接使用 `next()`。

为贴合接口命名，`Decoder` 与 `Demultiplexer` 还提供
`PushBytes/Next/Finish`（以及 `Register/Cancel/Consume`）的大小写兼容别名，
行为与对应的驼峰方法完全相同。

## Finish

`finish()` 在空边界返回 `{ clean: true, ok: true, pendingMessages }`。
未完整时返回 `{ clean: false, ok: false, reason, at, pendingMessages,
openContainers, pendingAttributes, detail }`，`reason` 区分：

- `partial-header`：半行、半行头或未成对 CRLF；
- `partial-blob`：固定/流式 blob 正文或终止 CRLF 缺失；
- `unclosed-container`：数组、map、push、属性块或流式容器未闭合；
- `orphan-attributes`：属性块已完整但没有附着到实际值。

协议、结构或预算错误会使 `finish()` 抛出 `RespProtocolError`。调用
`finish()` 后禁止再 `pushBytes`；已排队但未消费的完整消息仍可通过
`next()` 取出。

## 示例与验证

- `examples/collector-host.ts`：采集宿主的注册、取消、分片喂入、响应与
  推送分路示例。
- `src/reference.ts`：不共享增量状态机的独立一次性整帧解析器，用于测试和
  离线对照，不替代流式入口。
- `test/`：对全部有效夹具在每个字节边界、逐字节和多种分块模式下与参考树
  做深比较；并核对属性归属、push 顺序、票据结果、每一种预算的“恰足/差 1”
  以及各类截断和永久错误。

该实现只承诺上述子集，不宣称覆盖所有 RESP3 类型或线上服务兼容。
