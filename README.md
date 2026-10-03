# 银行日终批价审计工具（ledger-audit）

单机离线、Node.js 22、仅标准库。网点以长度前缀帧上送交易事件，收集器完成
重传去重、乱序缓冲、半帧容错、虚拟时钟关账，业务核心为事件溯源 + 增量更正 +
并发历史判定，输出每账户余额、未决队列与周期 Merkle 证书。

## 命令

```sh
node cli.js <frames.bin> [--state <dir>]   # 处理帧流，输出余额/周期/证书（JSON）
node verify.js <cert.json>                 # 验证周期 Merkle 证书
node --test                                # 全部测试（含 5 项验收）
node examples/make-demo.js                 # 重新生成演示帧文件
```

## 帧格式

每帧 = 4 字节大端长度 + UTF-8 JSON 载荷。事件帧：

```json
{"type":"event","eventId":"e1","acct":"A","amount":10000,"branchSeq":1,"logicalTs":10,
 "replaces":null,"causes":[],"checksum":"be45b79f"}
```

- `amount`：整数（分），可正可负。
- `branchSeq`：同一 `acct` 内从 1 开始的稠密序号（因果序依据）。
- `logicalTs`：虚拟时钟；跨账户并发以 `(logicalTs, eventId)` 决胜。
- `replaces`：可选，更正目标 eventId；`causes`：可选，跨账户 happens-before。
- `checksum`：对去掉 `checksum` 字段后的规范 JSON（键排序、无空白）计算的 CRC32（8 位 hex）。

关账帧：`{"type":"close","periodId":"P1","cutoff":100,"checksum":"…"}`。
`logicalTs <= cutoff` 的已收事件结算进该周期；其余留在未决队列等下一周期。
输入结束时若仍有未结算事件，自动关账最终周期（`cutoff: null`）。

## 语义

- **事件溯源**：`events.log` 为唯一事实来源，余额是其派生重放结果。
- **重传去重**：同 eventId 同载荷 → 幂等忽略；同 eventId 不同载荷 → exit 3。
- **乱序/缺序**：同 acct 按 branchSeq 缓冲重排；缺口超过窗口（默认 8，
  `LEDGER_WINDOW` 可调）或输入结束仍未补齐 → exit 4。
- **增量更正**：已入账事件永不修改。更正事件追加 `reversal`（冲销原额）+
  `replacement`（新额）两条日志，均以 `of` 链接原 eventId；可链式更正。
- **并发历史判定**：周期内拓扑排序——同 acct 按 branchSeq 成链，`causes`
  加跨账户边，就绪集中按 `(logicalTs, eventId)` 决胜；检测到循环因果 → exit 5。
  目标事件尚未结算的更正/因果事件自动顺延到后续周期。
- **关账边界**：关账后到达（或 logicalTs 超界）的事件进入下一周期，
  已冻结周期的余额与证书绝不重开；迟到事件在日志中标记 `late: true`。

## 持久化与崩溃恢复

状态目录（默认 `<frames.bin>.state/`）：

| 文件 | 作用 | 故障点 |
| --- | --- | --- |
| `inbox.log` | 接收即持久化的原始帧（fsync） | 接收帧后 |
| `events.log` | 结算日志（追加，seq 单调） | 写日志后 |
| `balances.json` | 余额快照（派生缓存，tmp+rename） | 更新余额后 |
| `cert-<period>.json` | 周期证书（tmp+rename 原子发布） | 发布证书前 |

重启恢复：重放 `inbox.log` 经确定性引擎重建状态，只补写 `seq` 更大的日志
条目、逐字节比对跳过相同证书，因此四个故障点任意崩溃后重跑均幂等。
测试通过 `LEDGER_CRASH_POINT=after-receive|after-log|after-balance|before-cert`
（配合 `LEDGER_CRASH_AT=n`）注入崩溃验证。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 帧错误（长度非法 / JSON 非法 / 校验和不符 / 字段非法 / 更正目标未知） |
| 3 | 重复 eventId 载荷不同（或同 periodId 不同 cutoff 重复关账） |
| 4 | 缺序超窗 / 序号复用 / 输入结束缺口未补齐 |
| 5 | 循环因果 |
| 42 | 测试注入的模拟崩溃 |
| 64 | 用法错误 |

末尾半帧不算错误：完整帧照常处理，`incompleteTailBytes` 报告残留字节数。

## Merkle 证书与验证

`cert-<period>.json` 含周期日志、叶哈希（`sha256("leaf:"+canon(entry))`）、
Merkle 根（奇数节点直接晋升）、期初/期末余额与 `verifyCommand`。
`verify.js` 重算叶哈希与根，并从 `initialBalances` 重放日志核对期末余额。

## 真实输出记录

`node examples/make-demo.js && node cli.js examples/demo.frames.bin --state examples/demo.state`
（10 帧：含 1 次同键重发、1 次乱序、1 条更正链、关账后 1 笔迟到）：

```json
{
  "balances": { "A": 13800, "B": 24000, "C": 8250 },
  "periods": [
    { "periodId": "P1", "cutoff": 100, "entries": 7,
      "root": "45202d9a1ffdcdcd695ecb302eebe797657e56472b34c11788afd29b153bdfaf",
      "cert": "examples/demo.state/cert-P1.json" },
    { "periodId": "P2", "cutoff": null, "entries": 2,
      "root": "bc10315802c7304cc3abc4043624652c3c3d03e0bff1243c0e0ee9255736f6a6",
      "cert": "examples/demo.state/cert-P2.json" }
  ],
  "pending": [
    { "eventId": "e7", "acct": "A", "logicalTs": 80,
      "reason": "deferred past period close", "settledIn": "P2" },
    { "eventId": "e8", "acct": "C", "logicalTs": 110,
      "reason": "deferred past period close", "settledIn": "P2" }
  ],
  "incompleteTailBytes": 0,
  "verify": [
    "node verify.js examples/demo.state/cert-P1.json",
    "node verify.js examples/demo.state/cert-P2.json"
  ]
}
```

`node verify.js examples/demo.state/cert-P1.json`（exit 0）：

```json
{
  "ok": true,
  "periodId": "P1",
  "root": "45202d9a1ffdcdcd695ecb302eebe797657e56472b34c11788afd29b153bdfaf",
  "checks": { "leaves": true, "root": true, "balances": true }
}
```

`node --test`：

```
# tests 6
# pass 6
# fail 0
```

## 验收覆盖（test/）

1. **同键重发** — `engine.test.js`：同 eventId 同载荷幂等去重；不同载荷 exit 3。
2. **更正链影响后续余额** — `engine.test.js`：reversal+replacement 链接原 eventId，
   链式更正（更正的更正）传导到后续余额；原日志不可变。
3. **关账边界迟到** — `engine.test.js`：迟到事件进下一周期并标 `late`，
   P1 证书余额冻结不变。
4. **崩溃四点位恢复** — `recovery.test.js`：每个故障点注入崩溃后重跑，
   输出与干净运行逐字节一致，重复重启幂等，日志无重复 seq。
5. **≤10 事件穷举拓扑** — `exhaustive.test.js`：n≤7 全排列（7! = 5040）+
   n=8..10 随机采样，对照独立参考账本；随机关账位置不改变最终余额。

另：`frames.test.js`（帧错 exit 2、半帧容错）、`verify.test.js`
（证书验证通过 / 篡改余额 / 篡改日志均检出）。
