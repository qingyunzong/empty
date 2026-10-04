# packline-trace

包装线视觉终端离线同步事件处理库与 CLI。Node.js 22，仅标准库，单机离线，无外部依赖。

## 事件模型

每个事件为 JSON 对象，经二进制帧传输：

| 字段 | 说明 |
| --- | --- |
| `batch` | 批次号（非空字符串） |
| `item` | 单品 ID（非空字符串） |
| `seq` | 单品内序号（非负整数） |
| `lamport` | Lamport 逻辑时钟（非负整数） |
| `kind` | `PACK` / `REWORK` / `SCRAP` / `CORRECT` |
| `ref` | 仅 `CORRECT`：被更正事件的 ID（`batch\|item\|seq\|kind`） |
| `qty` | 数量（非负整数；`CORRECT` 为更正后的数量） |
| `reason` | 原因（`CORRECT` 必填；管理审计更正为 `audit`） |
| `sig` | 对 `{batch,item,seq,lamport,kind,ref,qty,reason}` 规范化 JSON 的 sha256（hex） |

事件 ID = `batch|item|seq|kind`。

## 规则

- `CORRECT` 引用同一 item 的先前事件，只允许更正数量与原因；`item`/`batch` 与被引用事件不一致视为帧错（exit 2）。被更正事件保留并标记 `superseded`，更正链必须线性。
- 应用层按 `(lamport, seq, id)` 确定性归约每 item 最终态，与到达顺序无关；乱序只影响中间态。
- `SCRAP` 为终态：之后仅接受 `reason=audit` 的管理 `CORRECT`（只改数量/原因，不复活），其余事件一律拒绝（exit 10）。
- 内容哈希：每条事件记录（含 `effective`/`superseded` 状态）的 sha256 做 XOR 累积，随事件到达与取代关系增量更新；哈希状态完全是事件集合的函数，无任何隐藏状态，`recomputeHash()` 全量重算恒等于 `contentHash()`（验收 4 覆盖）。

## 协议层（`src/protocol.js`）

二进制帧：`magic 'VF' | version | msgId(u32) | fragIndex(u16) | fragCount(u16) | payloadLen(u16) | payload`。

- 分帧：`fragmentMessage(msgId, json, maxPayload)` 切分大消息。
- 重组：`Receiver` 按 `msgId` 收集乱序分片，集齐后交付完整消息。
- 去重：已完成的消息与重复分片直接忽略（重传幂等）。
- 超时重传：不完整分片组超过 `timeoutMs` 被清除，重传的分片可重新组帧。

## CLI

```sh
node cli.js frames.hex --export pkg.json
```

`frames.hex`：每行一个 hex 编码的帧（空行与 `#` 注释忽略）。导出包 `pkg.json` 含：

- `contentHash` — 增量维护的内容哈希
- `items` — 每 item 最终态（`state`/`qty`/`reason`/`scrapped` 等）
- `validEvents` — 有效事件（更正链顶端，按 lamport 排序）
- `supersededEvents` / `supersededChains` — 被取代事件与完整取代链

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 帧错（hex/帧格式/JSON/schema/签名/用法错误，CORRECT 改 item/batch） |
| 9 | `CORRECT` 的 `ref` 不存在 |
| 10 | 终态违例（SCRAP 后的非 audit 事件） |

## 测试

```sh
node --test
```

验收覆盖（`test/acceptance.test.js`）：

1. 重复 `CORRECT` 幂等（哈希与导出不变，事件不重复计数）
2. 乱序使中间态不同，但最终态与参考顺序完全一致
3. `SCRAP` 后普通更正拒绝（exit 10），`audit` 更正接受且不复活
4. 增量哈希与全量重算逐步对照一致

## 真实运行记录（2026-10-04，Node v22.22.1）

```
$ node --test
✔ test/acceptance.test.js
✔ test/cli.test.js
✔ test/protocol.test.js
ℹ tests 4  ℹ pass 4  ℹ fail 0

$ node scripts/make-sample.js
wrote examples/frames.hex (52 frames, 6 events)

$ node cli.js examples/frames.hex --export examples/pkg.json
ok: 52 frames, 6 messages, 6 events, 2 items, hash=a21d6efc8ebce97f2b0c88d7d95c3fd688b50f84a34a904cdd64d285a2ba81ba
```

示例含分帧、重复重传与乱序；导出结果见 `examples/pkg.json`（SKU-001 经更正 qty=50，SKU-002 SCRAP 后经 audit 更正 qty=29 且保持 `SCRAPPED`）。
