# card-reversal

单机离线的卡交易撤销库与 CLI。Node.js 22，仅标准库，测试用 `node:test`。

## 运行

```sh
node cli.js <ops.jsonl> [--limit N] [--ttl MS] [--wal PATH] [--chunk N]
node --test
```

- `--limit` 账户额度（默认 1000）
- `--ttl` 授权过期毫秒数（虚拟时钟，默认 30000）
- `--wal` WAL 路径（默认 `<ops.jsonl>.wal`）；重跑同一 ops 文件命中幂等表，不重复生效
- `--chunk` 输入按 N 字节切块喂给帧解析器（默认 7），模拟粘包/半包

退出码：`0` 正常；`2` 帧错误（非法 JSON / 字段校验失败）；`3` 状态冲突（额度不足、idemKey 重用不同载荷、捕获已过期授权等）。

## 消息格式

换行分隔的 JSON 帧（JSONL），同一连接允许重发、乱序、重复：

```json
{"idemKey":"a1","type":"auth","amount":200,"seq":1,"ts":0}
{"idemKey":"c1","type":"capture","ref":"a1","amount":120,"seq":2,"ts":10}
{"idemKey":"r1","type":"refund","ref":"c1","amount":30,"seq":3,"ts":20}
{"idemKey":"v1","type":"void","ref":"a1","seq":4,"ts":30}
{"idemKey":"x1","type":"reversal","ref":"c1","seq":5,"ts":40}
{"type":"tick","ts":70000}
```

`capture`/`void`/`refund`/`reversal` 用 `ref` 指向目标操作的 `idemKey`；`tick` 推进虚拟时钟。

## 设计

- **帧解析**（`lib/framing.js`）：增量缓冲，粘包（一块多帧）与半包（一帧跨块）统一处理。
- **状态机**（`lib/engine.js`）：`auth` 冻结额度 → `capture` 扣减（释放未捕获零头）→ `void`/`refund` 释放；不变量 `0 <= available <= limit`，绝不为负。
- **幂等**：`idemKey` 记录已存应答，同键同载荷重发直接返回旧应答（`duplicate: true`）不重复生效；同键不同载荷抛状态冲突。
- **乱序缓冲**：`ref` 目标尚未到达的操作进入 pending 缓冲，目标到达后按到达顺序补放（如 refund 早于 capture）。
- **虚拟时钟过期**：时钟取 `max(now, msg.ts)`，过期授权自动追加 `auto-void` 事件释放冻结；迟到 capture 与过期竞争时失败（状态冲突）。
- **撤销即补偿**：`reversal` 不删除原事件，而是追加 compensating 事件，把已提交 capture 的剩余额度（扣除已退款）恢复到原额度。
- **崩溃恢复**（`lib/wal.js`）：崩溃点定义为写日志后、应答前。每条事件先 fsync 进 WAL 再应答；重启重放 WAL 恢复状态与幂等表，重发请求返回已存应答，不重复生效。缓冲中的乱序操作也会从 WAL 重建。
- **线性化证书**（`lib/linearize.js`）：以 `ref` 依赖为边做拓扑排序，输出一个可接受的串行序；检测到环则给出拒绝原因。

## 真实输出

`node cli.js ops.example.jsonl --limit 1000 --ttl 30000 --wal /tmp/example.wal`（退出码 0）。
示例覆盖：乱序 refund 缓冲、重复 capture 同键去重、过期授权自动 void、reversal 补偿恢复：

```json
{
  "creditLimit": 1000,
  "available": 1000,
  "ledger": [
    {"type":"auth","idem":"a1","key":"a1","amount":200,"expiresAt":30000,"ts":0},
    {"type":"capture","idem":"c1","key":"c1","ref":"a1","amount":120,"ts":40},
    {"type":"refund","idem":"r1","key":"r1","ref":"c1","amount":30,"ts":40},
    {"type":"auth","idem":"a2","key":"a2","amount":150,"expiresAt":30050,"ts":50},
    {"type":"auto-void","key":"a2","ref":"a2","amount":150,"ts":70000},
    {"type":"reversal","idem":"v1","key":"v1","ref":"c1","on":"capture","amount":90,"ts":70001}
  ],
  "responses": [
    {"status":"ok","type":"auth","idemKey":"a1","available":800},
    {"status":"buffered","idemKey":"r1","waitingFor":"c1"},
    {"status":"ok","type":"capture","idemKey":"c1","available":880},
    {"duplicate":true,"status":"ok","type":"capture","idemKey":"c1","available":880},
    {"status":"ok","type":"auth","idemKey":"a2","available":760},
    {"status":"ok","type":"tick","now":70000},
    {"status":"ok","type":"reversal","idemKey":"v1","available":1000}
  ],
  "certificate": {"linearizable":true,"order":["a1","c1","r1","a2","v1"]}
}
```

过期授权与迟到 capture 竞争（`node cli.js ops.conflict.jsonl --ttl 30000 --wal /tmp/conflict.wal`，退出码 3）：

```json
{"error":"capture rejected: auth \"a2\" is expired","code":"STATE_CONFLICT"}
```

帧错误（`node cli.js ops.badframe.jsonl --wal /tmp/bad.wal`，退出码 2）：

```json
{"error":"invalid JSON frame: Expected property name or '}' in JSON at position 1 (line 1 column 2)","code":"FRAME_ERROR"}
```

`node --test`（4 个测试文件全部通过）：

```
# tests 4
# pass 4
# fail 0
```

## 验收对照

1. **重复 capture 同键**：`test/engine.test.js` “acceptance 1”——重发返回 `duplicate: true`，额度与流水不变。
2. **refund 早于 capture 乱序缓冲**：`test/engine.test.js` “acceptance 2”——refund 先缓冲，capture 到达后自动补放。
3. **过期 auth 与迟到 capture 竞争**：`test/engine.test.js` “acceptance 3”——时钟越过 TTL 自动 void，迟到 capture 状态冲突。
4. **≤6 操作穷举并发交错**：`test/exhaustive.test.js`——6 操作 720 种排列 + 含 reversal 的 4 操作 24 种排列，全部对照串行参考终态一致，且每步 `0 <= available <= limit`。

崩溃恢复见 `test/engine.test.js` 中两个 WAL 用例（含缓冲中崩溃恢复）。
