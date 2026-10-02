# xborder-settlement

跨境批量结算库与 CLI。银行把多笔结算行打包为长度前缀帧，经有损链路
（丢帧 / 重复 / 乱序 / 半帧）发送；接收端重组、去重、排序后驱动业务状态机
完成结算，并产出可验证的审计证书（hash 链）。仅使用 Node.js 22 标准库。

## 帧格式（全部大端）

```
u16  body 长度（含 CRC，不含本字段）
u16  magic   = 0xCB5E
u8   version = 1
u8   type    (1 = DATA, 2 = ACK)
u32  batchId
u16  lineNo  (ACK 帧为 0)
u16  seq     (批内 1 起始序号)
u16  ack     (累积确认：下一个期望的 seq)
u8   flags   (bit0 = EOB 批末帧, bit1 = 冲正行)
u8[] payload (DATA 帧：结算行的规范 JSON)
u32  CRC-32 (IEEE 0xEDB88320，覆盖此前全部 body 字节)
```

## 协议状态机（src/protocol.js）

- **分帧重组**：接收端按长度前缀解析字节流，半帧保留在缓冲区等待后续字节。
- **CRC 校验**：CRC 错可恢复——按长度跳过坏帧并记录 `CRC_MISMATCH`，
  等待发送端超时重传；magic/version 错（CRC 有效）为不可恢复协议错。
- **去重 / 乱序缓存**：每批维护 `expected` 与乱序缓冲，重复帧丢弃，
  按序交付结算行，收齐到 EOB 帧即批完整。
- **确认 / 重传**：接收端对每帧回累积 ACK；发送端在虚拟时钟上挂 RTO
  定时器，超时重传全部未确认帧；批中止后停止重传。
- **虚拟时钟**（src/clock.js）：确定性推进，定时器按 (时间, 序号) 触发，
  测试可精确控制超时。

## 业务状态机（src/ledger.js）

- 行状态：`OPEN → ACKED → SETTLED`，校验不通过则 `OPEN → NAKED`。
- **SETTLED 不可改**：只能用新批中的反向冲正行（`reversalOf` 指向目标，
  方向取反）更正；目标必须已 SETTLED，否则业务拒绝。
- **额度冻结**：提交批时冻结全部付款行总额；行 NAK 只解冻该行金额；
  批结算时冻结额转为已结算；`timeoutMs` 内未收齐则整批中止并解冻剩余
  冻结额，行回滚为 OPEN 可重新提交；中止后到达的迟帧被忽略。
- **审计证书**：每个账本事件（freeze/ack/nak/settle/abort）经规范序列化
  （键排序、无空白）后链接：`head = sha256(head ‖ canon(event))`，
  可用 `verifyAudit()` 重放校验，输出含事件数与链头哈希。

## CLI

```
node cli.js <in.jsonl>
```

每行一个操作（`#` 开头为注释）：

| op | 说明 |
| --- | --- |
| `init` | `limit` / `perLineLimit` / `currencies` / `rtoMs` |
| `submit` | `batch`、`timeoutMs`、`lines:[{lineNo,amount,currency,direction,reversalOf?}]` |
| `pump` | 把发送队列推过有损链路：`order`/`drop`/`dup`/`corrupt`/`split`/`dropAck`（帧键为 `batch:seq`） |
| `tick` | 虚拟时钟推进 `ms`（触发重传与批超时） |
| `feed` | 直接向接收端注入十六进制字节（半帧 / 坏帧场景） |
| `reverse` | 冲正：`of:{batch,lineNo}`，生成反向行新批 |

成功输出 JSON：`lines`（每笔最终状态）、`frozen`（冻结余额）、
`settledPay/Receive`、`batches`、`audit`（事件数、链头、校验位）。
错误约定：协议错退出码 2（`PROTOCOL_ERROR`/`BAD_INPUT`），
业务拒绝退出码 3（`BUSINESS_REJECTED`），输出 JSON 均含 `code`。

## 测试

```
node --test
```

真实输出（Node v22.22.1）：

```
ok 1 - test/cli.test.js
ok 2 - test/enumeration.test.js
ok 3 - test/protocol.test.js
ok 4 - test/timeout.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 47922.715111
```

四条验收对应：

1. `test/protocol.test.js` — 多批乱序到达 + 重传 + 重复帧去重。
2. `test/protocol.test.js` — CRC 错跳帧后超时重传恢复；半帧两段重组；
   坏 magic 抛协议错。
3. `test/timeout.test.js` — 虚拟时钟推进触发批超时，整批中止并解冻；
   部分行 NAK 只解冻对应金额。
4. `test/enumeration.test.js` — 对 ≤5 行枚举全部丢/重/乱序序列
   （Σ 3ⁿ·n! = 31287 例），与独立参考状态机（纯集合/顺序语义，
   不共享协议代码）逐例对照，并校验审计链。

## 示例

```
$ node cli.js examples/ok.jsonl        # 乱序+丢帧+重复后重传收齐
$ node cli.js examples/timeout.jsonl   # 超时整批中止解冻
$ node cli.js examples/business_reject.jsonl   # 退出码 3
$ node cli.js examples/protocol_error.jsonl    # 退出码 2
```

`examples/ok.jsonl` 真实输出（节选）：

```json
{
  "ok": true,
  "frozen": "0.00",
  "settledPay": "300.00",
  "settledReceive": "50.00",
  "lines": [
    {"batch": 1, "lineNo": 1, "state": "SETTLED", "amount": "100.00", "currency": "USD", "direction": "pay"},
    {"batch": 1, "lineNo": 2, "state": "SETTLED", "amount": "200.00", "currency": "EUR", "direction": "pay"},
    {"batch": 1, "lineNo": 3, "state": "SETTLED", "amount": "50.00", "currency": "CNY", "direction": "receive"}
  ],
  "audit": {"events": 7, "head": "336a75deeca219c952549e62269f04304d87a552d6260c65cf5b30532f239b28", "valid": true}
}
```

## 代码结构

- `src/frame.js` — 帧编解码、CRC32 校验、流解析（半帧保留）
- `src/crc32.js` / `src/canon.js` — CRC-32 表驱动实现 / 规范序列化 + sha256
- `src/clock.js` — 虚拟时钟与定时器
- `src/protocol.js` — 发送端（重传缓冲 + RTO）与接收端（重组/去重/排序/ACK）
- `src/ledger.js` — 业务状态机、额度冻结、冲正、审计 hash 链
- `src/sim.js` — 引擎：连接发送端、有损链路故障模型、接收端与账本
- `src/cliapp.js` / `cli.js` — JSONL 脚本解释器与进程入口
