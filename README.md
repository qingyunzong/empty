# xsettle — 跨境批量结算库与 CLI

Node.js 22，仅标准库，单机离线。银行把多笔结算行打包为长度前缀帧发送；
链路会丢帧、重复、乱序、把一帧拆成两段；协议栈负责重传、去重、乱序缓存、
分帧重组与虚拟时钟超时；业务层负责额度冻结、状态机与可验证审计证书。

## 运行

```bash
node cli.js <in.jsonl>   # 处理 JSONL 指令文件，stdout 输出 JSON 报告
node --test              # 运行全部测试
```

退出码约定：`0` 成功；`2` 协议错（帧版本非法、输入无法解析等，JSON 含 `code`）；
`3` 业务拒绝（余额不足、非法状态迁移、篡改已结算历史等，JSON 含 `code`）。

## 帧格式（大端）

| 偏移 | 字段 | 说明 |
|---|---|---|
| 0 | magic (2B) | `0xC7 0x3B` |
| 2 | version (1B) | 当前为 1；CRC 合法但版本未知 → 协议错 exit 2 |
| 3 | type (1B) | 1=DATA，2=ACK |
| 4 | batchId (4B) | 批号 |
| 8 | lineNo (2B) | 行号 |
| 10 | seq (4B) | 发送方单调递增序号 |
| 14 | ack (4B) | 累积确认 = 下一个期望 seq |
| 18 | payloadLen (2B) | 载荷长度 |
| 20 | payload | DATA 载荷为结算行 JSON |
| … | crc32 (4B) | CRC-32(IEEE)，覆盖头部+载荷 |

## 协议状态机（`src/protocol.js`）

- **发送方 Sender**：go-back-N。每帧分配单调 seq；虚拟时钟距上次确认推进
  ≥ `rtoMs` 且仍有未确认帧时，按 seq 顺序重传全部未确认帧。
- **接收方 Receiver**：累积确认。按序帧立即交付业务层；乱序帧进缓存，
  缺口闭合后批量流出；已交付 seq 去重；ack 恒为下一期望 seq。
- **分帧重组 FrameDecoder**（`src/frame.js`）：流式解码，半帧/任意切片
  跨边界缓存拼接；帧间垃圾按 magic 扫描重同步；CRC 错帧丢弃并重同步，
  由超时重传恢复。

## 业务状态机（`src/ledger.js`）

- 行状态：`OPEN → ACKED → SETTLED`；`REJECTED`（业务 NAK）与 `ABORTED`
  （批超时）为终态。`SETTLED` 行不可改：只能提交 `reversalOf` 指向它的
  反向冲正行（金额相同、收付对调、原行须为 SETTLED 且未被冲正过），
  冲正行走正常 OPEN→ACKED→SETTLED 流程，历史行保持不变。
- **额度冻结**：`submit` 时按付款行总额冻结付款户（`frozen += Σ`，校验
  `available` 充足）；单行 NAK 只解冻该行金额；`settle` 时冻结转实扣并
  贷记收款户；虚拟时钟推进超过 `batchTimeoutMs` 且批内仍有非终态行时，
  整批自动中止并解冻全部剩余冻结。

## 审计证书（`src/audit.js`）

每个业务事件（开户/提交/ACK/结算/NAK/中止）按规范序列化（键名递归排序、
无空白）后进入哈希链：

```
head_0 = 64 个 '0'
head_i = sha256hex(head_{i-1} + '|' + canonical(event_i))
```

输出含完整事件列表与 `audit.head`，任何人可用 `AuditChain.verify(events)`
独立重算校验（验收测试 1/2 中均做了校验）。

## CLI 指令（JSONL，每行一个 JSON，`#` 开头为注释）

- `{"op":"account","id":"A","balance":1000}` 开户
- `{"op":"submit","batchId":1,"lines":[{"lineNo":1,"from":"A","to":"B","amount":40,"reversalOf":null}]}` 提交批并冻结
- `{"op":"send","batchId":1,"lines":[1,2]}` 组帧入链路（lines 可省=全批）
- `{"op":"link","action":"drop|dup|swap|split|corrupt|raw", ...}` 操控链路：
  丢帧/重复/交换/拆两段/翻转字节(触发 CRC 错)/注入原始 hex 字节
- `{"op":"deliver","count":"all"|N}` 投递链路头部 N 段给接收方
- `{"op":"tick","ms":1500}` 推进虚拟时钟（触发重传与批超时检查）
- `{"op":"settle","batchId":1,"lineNo":1}` / `{"op":"settle_batch","batchId":1}`
- `{"op":"nak","batchId":1,"lineNo":1}` 业务拒绝单行并解冻对应金额
- `{"op":"config","rtoMs":1000,"batchTimeoutMs":10000}`

输出 JSON：`code`、每笔行最终状态、账户 `balance/frozen/available`、
批状态、审计证书（事件+链头）、链路统计（重传/去重/乱序/CRC 错/拆分等）。
示例见 `examples/lossy.jsonl`（乱序+重复+CRC 错+半帧后恢复并全部结算）。

## 测试（真实输出）

```
$ node --test
✔ test/acceptance.test.js (823.392122ms)
✔ test/cli.test.js (894.021066ms)
✔ test/exhaustive.test.js (3785.987133ms)
✔ test/frame.test.js (756.228624ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

- `test/acceptance.test.js`：验收 1（分批乱序+重复+丢帧重传后全部结算、
  审计链校验）、1b（提交即冻结、部分 NAK 只解冻对应金额）、验收 2
  （CRC 错+半帧后由重传恢复）、验收 3（虚拟时钟超时整批中止解冻）、
  业务规则（状态迁移顺序、SETTLED 只能冲正、余额不足/重复批拒绝）。
- `test/exhaustive.test.js`：验收 4。对 ≤5 帧枚举全部 丢/重/乱序 序列
  （排列 × 丢弃子集 × 重复子集 × 是否重传轮，共 74,568 例），与独立
  参考状态机（已收集合的最长前缀即应交付序列）逐例对照，并断言交付
  无重复、严格按序、最终 ack 正确。
- `test/frame.test.js`：编解码往返、CRC 已知向量、逐字节分片重组、
  垃圾重同步、CRC 错丢弃后续恢复、非法版本硬错误。
- `test/cli.test.js`：exit 0/2/3 与 JSON `code` 字段。

## 文件结构

```
cli.js            CLI 入口（亦导出 run() 供进程内测试）
src/frame.js      帧编码 / 流式解码器（分帧重组、重同步、CRC）
src/protocol.js   Sender（重传）/ Receiver（去重、乱序缓存、累积 ACK）
src/ledger.js     业务状态机、额度冻结、冲正、批超时
src/audit.js      规范序列化 + SHA-256 哈希链
src/engine.js     链路模型与指令执行
src/clock.js      虚拟时钟
src/crc32.js      CRC-32(IEEE)
examples/         示例 JSONL
test/             node:test 测试
```
