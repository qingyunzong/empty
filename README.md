# card-reversal

卡交易撤销库与 CLI：授权 / 捕获 / 作废 / 退款 / 撤销状态机，JSON 帧消息，
idemKey 幂等去重，虚拟时钟授权过期自动 void，WAL 崩溃恢复，线性化证书。
仅使用 Node.js 22 标准库，测试使用 `node:test`，单机离线可运行。

## 运行

```bash
node cli.js <ops.jsonl> [--limit=N] [--ttl=MS] [--wal=PATH] [--fresh] [--crash-after=N]
node cli.js - < ops.jsonl        # 从 stdin 读取
node --test                      # 运行全部测试
```

退出码：`0` 正常；`2` 帧错误（非法 JSON、半包残留、消息结构非法）；`3` 状态冲突
（详见输出 `certificate.rejected`）。

## 消息格式

每行一个 JSON 帧（换行分隔，解析器处理粘包/半包）：

```json
{"idemKey":"a1","type":"auth","amount":200,"seq":1,"ts":1000,"ttl":50}
{"idemKey":"c1","type":"capture","ref":"a1","amount":120,"seq":2,"ts":1010}
```

- `type`: `auth` / `capture` / `void` / `refund` / `reversal`
- `idemKey`: 幂等键；同键同载荷重发返回原应答（`duplicate:true`）不重复生效；
  同键不同载荷为冲突（记入 `certificate.rejected`，退出码 3）
- `ref`: 非 auth 消息引用目标（capture/void 引用 auth 的 idemKey；
  refund/reversal 引用 capture 或 auth 的 idemKey）
- `amount`: auth 必填且 >0；capture/refund/reversal 可省略（默认授权全额 / 剩余可退额）
- `ttl`: auth 可选，虚拟时钟单位，到期自动 void（默认 `--ttl=1000`）

## 语义

- **状态机**: auth(OPEN) → capture(CAPTURED) / void(VOID)；refund/reversal 作用于已捕获额。
- **额度**: `available = limit - held - captured`。auth 冻结（held+），capture 释放冻结并扣减
  （captured+），void/refund/reversal 释放。每个事件后断言三者均不为负。
- **乱序缓冲**: 引用尚未到达的目标时消息进入缓冲（应答 `buffered`），目标提交后按 `seq`
  顺序补放；缓冲消息随 WAL 持久化，崩溃后仍可补放。
- **虚拟时钟**: `now = max(已见 ts)`，单调递增；每条新消息到达时先过期所有
  `ts + ttl <= now` 的 OPEN 授权（追加 `auto_void` 事件），再处理消息。过期授权与迟到
  capture 的竞争由时钟确定性裁决：auto_void 获胜，capture 拒绝（`auth-void`）。
- **撤销即补偿**: reversal 不删除历史，而是追加 `compensating:true` 的补偿事件，
  把已提交 capture 的额度恢复；原 capture 事件保留在流水中。
- **崩溃恢复**: 崩溃点定义为写 WAL 之后、发应答之前。WAL 逐条记录
  `{t: 虚拟时钟, m: 消息}`（含被拒绝的消息——拒绝也是会推进时钟的持久结果）。
  重启后从 WAL 重放重建状态；客户端重发未确认消息时命中幂等表，重放原应答，不重复生效。
- **线性化证书**: `certificate.linearization` 给出并发历史的一个可接受拓扑序
  （已提交事件的提交顺序）；`certificate.rejected` 给出每个被拒绝操作的拒绝原因；
  `certificate.pending` 列出流结束时仍未解缓冲的消息。

## 真实输出

### 1. 正常流程 + 重复 capture + 退款 + 撤销（`examples/ops.jsonl`）

```
$ node cli.js examples/ops.jsonl ; echo exit=$?
```

输入含重复投递的 `c1`（第 3 行与第 2 行完全相同）。输出（节选，完整 JSON 见命令实测）：

```json
{
  "held": 0,
  "captured": 0,
  "available": 1000,
  "ledger": [
    { "n": 1, "type": "auth",     "idemKey": "a1", "amount": 200, "available": 800 },
    { "n": 2, "type": "capture",  "idemKey": "c1", "amount": 120, "available": 880 },
    { "n": 3, "type": "refund",   "idemKey": "r1", "amount": 20,  "available": 900 },
    { "n": 4, "type": "reversal", "idemKey": "x1", "amount": 100, "available": 1000, "compensating": true }
  ],
  "replies": [
    { "idemKey": "a1", "status": "applied" },
    { "idemKey": "c1", "status": "applied" },
    { "idemKey": "c1", "status": "applied", "duplicate": true },
    { "idemKey": "r1", "status": "applied" },
    { "idemKey": "x1", "status": "applied" }
  ]
}
exit=0
```

重复 `c1` 只生效一次（流水仅一条 capture），撤销 x1 以补偿事件把额度恢复到 1000。

### 2. refund 早于 capture 乱序缓冲（`examples/buffer.jsonl`）

```
$ node cli.js examples/buffer.jsonl ; echo exit=$?
```

`r1`（refund→c1）先于 `c1` 到达，应答 `buffered`；`c1` 提交后按 seq 补放：

```json
"ledger": [
  { "n": 1, "type": "auth",    "idemKey": "a1", "amount": 100, "available": 900 },
  { "n": 2, "type": "capture", "idemKey": "c1", "amount": 80,  "available": 920 },
  { "n": 3, "type": "refund",  "idemKey": "r1", "amount": 30,  "available": 950 }
]
exit=0
```

### 3. 过期 auth 与迟到 capture 竞争（`examples/race.jsonl`）

```
$ node cli.js examples/race.jsonl ; echo exit=$?
```

auth(ts=100, ttl=50) 在 capture(ts=200) 到达推进时钟后被自动作废，迟到 capture 被拒：

```json
"ledger": [
  { "n": 1, "type": "auth",      "idemKey": "a1", "amount": 300, "available": 700 },
  { "n": 2, "type": "auto_void", "idemKey": "a1", "amount": 300, "available": 1000 }
],
"certificate": {
  "linearization": [ { "n": 1, "type": "auth", "idemKey": "a1" },
                     { "n": 2, "type": "auto_void", "idemKey": "a1" } ],
  "rejected": [ { "idemKey": "c1", "reason": "auth-void" } ]
}
exit=3
```

### 4. 帧错误

```
$ node cli.js examples/badframe.jsonl ; echo exit=$?
frame error: invalid JSON frame: {"idemKey":"c1","type":"capture"
exit=2
```

### 5. 崩溃恢复（写 WAL 后、应答前崩溃）

```
$ node cli.js examples/ops.jsonl --wal=/tmp/demo.wal --fresh --crash-after=3 ; echo exit=$?
crash: simulated crash after WAL append, before reply
exit=1
$ cat /tmp/demo.wal
{"t":1000,"m":{"idemKey":"a1","type":"auth","amount":200,"seq":1,"ts":1000}}
{"t":1010,"m":{"idemKey":"c1","type":"capture","ref":"a1","amount":120,"seq":2,"ts":1010}}
{"t":1020,"m":{"idemKey":"r1","type":"refund","ref":"c1","amount":20,"seq":3,"ts":1020}}
$ node cli.js examples/ops.jsonl --wal=/tmp/demo.wal ; echo exit=$?
exit=0
```

重启后重发全部操作：前 3 条命中幂等表（`duplicate:true`，不重复生效），第 4 条正常应用，
最终 `available=1000, captured=0, held=0`，流水与无崩溃运行完全一致：

```
replies: a1:applied(dup), c1:applied(dup), c1:applied(dup), r1:applied(dup), x1:applied
linearization: 1:auth/a1 -> 2:capture/c1 -> 3:refund/r1 -> 4:reversal/x1
```

## 测试

```
$ node --test
# tests 4
# pass 4
# fail 0
```

- `test/framer.test.js` — 粘包、半包、逐字节投递、坏帧、尾部半包。
- `test/engine.test.js` — 验收 1（重复 capture 同键）、验收 2（refund 乱序缓冲）、
  验收 3（过期 auth 与迟到 capture 竞争）、同键不同载荷冲突、额度不为负、
  撤销补偿恢复额度、崩溃点恢复重放应答。
- `test/cli.test.js` — 退出码 0/2/3、stdin、崩溃恢复后与干净运行一致。
- `test/exhaustive.test.js` — 验收 4：3 组 ≤6 操作场景的全部 6!=720 种并发交错，
  逐一与独立的串行参考模型对照（流水、余额、拒绝列表完全一致）；另对每种交错
  × 每个 WAL 追加点（共 720×6=4320 次运行）注入崩溃，恢复重发后结果仍与参考一致。

## 文件结构

- `cli.js` — 命令行入口（薄封装）
- `lib/runner.js` — 参数解析、流读取、退出码逻辑（可进程内调用，便于测试）
- `lib/engine.js` — 状态机、幂等去重、乱序缓冲、虚拟时钟、WAL 与恢复、线性化证书
- `lib/framer.js` — 换行分隔 JSON 帧解析器（粘包/半包）
- `examples/*.jsonl` — 上文各场景输入
