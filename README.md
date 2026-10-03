# 银行日终批价审计工具 (eod-ledger-audit)

单机离线、仅 Node.js 22 标准库。网点以长度前缀帧上送交易事件，收集器完成
重传去重、乱序缓冲、半帧检测、虚拟时钟关账；账本采用事件溯源，更正只能以
reversal + replacement 追加，关账后冻结余额永不重开，每个周期产出 Merkle 证书。

## 命令

```bash
node examples/make-sample.js                 # 生成示例 frames.bin
node cli.js <frames.bin> [--state-dir DIR] [--fresh] [--gap-window N]
node verify.js <cert.json>                   # 验证周期证书
node --test                                  # 全部测试（22 个用例）
```

## 帧格式

每个帧 = 4 字节大端长度前缀 + UTF-8 JSON 体。两种帧：

```json
{"type":"event","eventId":"e1","acct":"acct-A","amount":100,"branchSeq":1,"logicalTs":1,"checksum":"..."}
{"type":"close"}
```

- `amount`：整数（最小货币单位），可正可负。
- `checksum`：`sha256("eventId|acct|amount|branchSeq|logicalTs|reversalOf|replaces")` 前 16 位 hex。
- 更正事件可选字段：`reversalOf`（冲正目标 eventId，有效金额 = −目标有效金额）、
  `replaces`（替代目标 eventId，金额即新值）。两者都链接原 eventId，构成更正链。
- 半帧 / 长度非法 / JSON 非法 / 校验和不符 / 未知帧类型 → exit 2。

## 业务规则

- **事件溯源**：已入账事件永不修改；更正只追加 reversal + replacement 新事件。
- **因果序**：同一 acct 按 `branchSeq` 成链；跨 acct 以 `(logicalTs, eventId)` 决胜。
  周期证书中的事件顺序是对该偏序做 Kahn 拓扑排序（就绪集中取最小 `(logicalTs, eventId)`），
  与投递顺序无关，因此同一事件集任何乱序投递得到相同 Merkle 根。
- **循环因果**：自引用、互相引用、链接与同账 branchSeq 序矛盾，一律拒绝（exit 5）。
- **去重**：eventId 重发且载荷一致 → 幂等忽略；载荷不同 → exit 3。
  同 acct+branchSeq 被不同 eventId 占用同样 → exit 3。
- **缺序超窗**：`branchSeq >= 下一期望序号 + 窗口`（默认 8）→ exit 4；窗内乱序进入未决队列，
  缺口补齐后按序入账。
- **关账**：`close` 帧冻结当前周期余额并产出证书；之后到达的事件（无论 logicalTs 多早）
  进入下一周期，冻结余额永不重开。输入结束自动关闭最后周期。

## 持久化与崩溃恢复

状态目录（默认 `./state`）：

| 文件 | 说明 |
| --- | --- |
| `wal.log` | 逐条 fsync 的 NDJSON：`frame`（接收帧后）、`event`（写日志后）、`cert`（发布证书前）记录 |
| `state.json` | 原子写（tmp+rename+fsync）的收集器快照，每次余额更新后落盘 |
| `cert-<period>.json` | 原子发布的周期 Merkle 证书 |
| `report.json` | 机器可读的最终报告 |

四个故障点对应：接收帧后（`recv`）、写日志后（`log`）、更新余额后（`balance`）、
发布证书前（`cert`）。重启时从快照 + WAL 重放恢复，按 eventId 去重保证幂等；
输入文件视为已接收流，WAL 中已有的前缀帧自动跳过。缺失的证书在恢复时重新发布。

故障注入（用于验收 4）：`LEDGER_CRASH_AT=recv|log|balance|cert LEDGER_CRASH_AFTER=N`，
进程在第 N 次经过该点时不清理直接退出（exit 99）。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 帧错（半帧、长度非法、JSON 非法、校验和不符、未知类型） |
| 3 | 重复键不同载荷（eventId 或 acct+branchSeq 冲突） |
| 4 | 缺序超窗 |
| 5 | 循环因果 |
| 64 | 用法错误 |
| 99 | 故障注入崩溃（测试用） |

## 真实输出

```console
$ node examples/make-sample.js
wrote examples/frames.bin (10 frames)

$ node cli.js examples/frames.bin --state-dir state --fresh
Balances:
  acct-A  30
  acct-B  67
Pending queue:
  (empty)
Certificates:
  period 1: events=5 merkleRoot=9072db4049f47ccdcf6aef01bbeebd94475983f700fc537bff82e583f683b636
    verify: node verify.js state/cert-1.json
  period 2: events=3 merkleRoot=92de3569625c2872faadffe08e3ecf485930dd93ac377762ab864c647b17e88f
    verify: node verify.js state/cert-2.json
Duplicates suppressed: 1

$ node verify.js state/cert-1.json
OK period=1 events=5 merkleRoot=9072db4049f47ccdcf6aef01bbeebd94475983f700fc537bff82e583f683b636

$ node verify.js state/cert-2.json
OK period=2 events=3 merkleRoot=92de3569625c2872faadffe08e3ecf485930dd93ac377762ab864c647b17e88f
```

示例覆盖：e2 同键重发（去重）、acct-B 乱序（e5 先于 e4 到达，缓冲后按序入账）、
关账后对已冻结事件 e1 的更正链（e6 冲正 + e7 替代，落入周期 2）、迟到事件 e8
（logicalTs 6 属于周期 1，但关账后到达，计入周期 2）。acct-A = 100 − 30 − 100 + 60 = 30。

崩溃恢复演示（exit 99 为注入崩溃，重启后结果与无崩溃运行逐字节一致）：

```console
$ LEDGER_CRASH_AT=balance LEDGER_CRASH_AFTER=2 node cli.js examples/frames.bin --state-dir /tmp/demo-crash --fresh
crash exit=99
$ node cli.js examples/frames.bin --state-dir /tmp/demo-crash
resuming: 2 frame(s) already in WAL, skipped
Balances:
  acct-A  30
  acct-B  67
...
recovery exit=0
```

错误示例：

```console
$ node cli.js /tmp/dup.bin --state-dir /tmp/demo-dup --fresh
error: eventId "x1" retransmitted with a different payload
dup exit=3
```

## 证书格式与验证

`cert-<period>.json` 含：规范因果序的事件列表（含每条 `effective` 有效金额）、
`merkleRoot`（叶 = `sha256("leaf:"+规范JSON)`，内部节点 = `sha256("node:"+左+右)`，
奇数层复制末节点）、冻结 `balances`、上一周期 `prevBalances` 与 `prevRoot`（周期链）。

`node verify.js <cert.json>` 重新校验：事件校验和、规范因果序、有效金额
（期内链接重推导，跨期链接取记录值）、Merkle 根、`prevBalances + 本期增量 == balances`。
全部通过打印 `OK ...` 退出 0，否则打印 `FAIL: ...` 退出 1。

## 验收对照

1. **同键重发**：`test/collector.test.js`「same-key resend」+ 示例中 e2 重发。
2. **更正链影响后续余额**：「correction chain reversal+replacement」（100+50−100+60+10=120）。
3. **关账边界迟到**：`test/cli.test.js`「close boundary」——迟到事件入周期 2，周期 1 冻结不变。
4. **崩溃点位恢复**：「crash recovery at all four failure points」——recv/log/balance/cert
   四点注入崩溃后重启，报告与证书和无崩溃运行完全一致。
5. **≤10 事件穷举拓扑**：`test/topology.test.js`——6 事件全排列 720 种 + 8/10 事件
   各 300 种随机拓扑，余额对照独立参考账本 `lib/refledger.js`，Merkle 根与规范序不随投递顺序变化。

## 目录结构

```
cli.js            CLI 入口（帧解析、WAL、恢复、报告）
verify.js         证书验证器
lib/frame.js      长度前缀帧编解码、校验和、事件校验
lib/collector.js  收集器核心：去重、乱序、更正链、循环检测、关账、规范序
lib/merkle.js     Merkle 树
lib/store.js      WAL + 原子快照 + 证书落盘
lib/refledger.js  测试用独立参考账本
lib/errors.js     ExitError / FrameError
test/             node:test 测试（22 个用例）
examples/         示例帧生成器
```
