# FX 双边净额结算队列（fx-netting-queue）

单机离线的外汇双边/多边净额结算引擎与 CLI。参与行通过二进制帧通信
（obligation / ack / nak / cancel），链路层支持分片、重传去重、乱序重组；
周期由虚拟时钟驱动关闭，关闭时按币种做多边净额、流动性冻结与结算，
任一净付方流动性不足则该币种整周期 unwind（禁止部分结算），并生成补偿记录。

运行环境：Node.js 22，仅标准库，测试使用 `node:test`。

## 命令

```bash
node cli.js <frames.bin>     # 处理帧文件并输出结算报告
node --test                  # 运行全部测试
node tools/make_samples.js   # 重新生成 samples/*.bin
```

退出码：

| code | 含义 |
|------|------|
| 0 | 成功 |
| 1 | 用法 / IO 错误 |
| 2 | 校验错误（CRC、截断、坏 magic、nak 无原因、零金额等） |
| 3 | 未知 cycle（cycle=0 或跳号，如当前 cycle=1 收到 cycle=3） |
| 4 | 负义务（obligation amount < 0） |

## 文件格式（frames.bin）

```
文件头:  'FXB1' u8版本=1 u16银行数, 每行: 4B银行id 3B币种 i64BE余额(最小单位)
链路包:  'FQ' u32 linkSeq, u16 fragId, u8 fragIndex, u8 fragCount,
         u16 payloadLen, payload, u16 crc16   —— 按 linkSeq 去重/重排, 按 fragId 重组分片
帧(31B): u8 type(1=OBLIGATION 2=ACK 3=NAK 4=CANCEL), u32 cycle,
         4B from, 4B to, 3B ccy, i64 amount, u32 seq, u8 reason, u16 crc16
```

## 核心机制

- **虚拟时钟**：cycle 1 初始打开；收到 `cycle = 当前+1` 的帧时先关闭当前周期再前进；
  输入结束时关闭最后周期。`vtick` 为已处理帧数。
- **迟到消息进下一周期**：`cycle < 当前` 的帧被路由进当前打开的周期并标记
  `late(from-closed-cycle=N)`；因此关闭边界后的迟到 cancel 找不到已结算义务，被拒绝。
- **去重**：链路层按 linkSeq 去重重传包；义务按 `(from, seq)` 去重；
  重复 ack 不重复确认（`ACK duplicate ignored`）。
- **nak 必须带原因码**（1=INSUFFICIENT_LIQUIDITY 2=DUPLICATE 3=NOT_FOUND
  4=CYCLE_CLOSED 5=VALIDATION 6=AMOUNT_INVALID），否则 exit 2；nak 生效后义务从周期中移除。
- **净额算法**：周期关闭时按币种汇总义务矩阵，净额 = 应收 − 应付（多边抵消）。
- **流动性冻结**：净付方按字母序冻结其净付额；全部冻结成功后释放冻结完成借记、
  净收方入账。
- **周期撤销（unwind）**：任一净付方可用余额不足 → 该币种整周期回滚：已冻结头寸
  全部恢复（`RELEASE-RESTORE`），输出 `UNWIND-CERTIFICATE` 与补偿条目
  （COMPENSATION_CLAIM / COMPENSATION_DEBT），禁止部分结算；其他币种不受影响。

## 验收场景真实输出

### 1. 三行循环义务净额为 0（`samples/sample1_circle.bin`）

```
FX BILATERAL NETTING QUEUE
==========================
banks: AAA(USD=0) BBB(USD=0) CCC(USD=0)
link: packets=3 frames=3
[cycle 1] OBLIGATION AAA->BBB 1000 USD seq=1
[cycle 1] OBLIGATION BBB->CCC 1000 USD seq=1
[cycle 1] OBLIGATION CCC->AAA 1000 USD seq=1
[cycle 1] CLOSE @vtick=3 obligations=3
[cycle 1] CCY USD gross matrix (minor units):
                 AAA       BBB       CCC
AAA                -      1000         0
BBB                0         -      1000
CCC             1000         0         -
[cycle 1] CCY USD net positions: AAA=0 BBB=0 CCC=0
[cycle 1] CCY USD status=SETTLED
FINAL BALANCES (avail / frozen):
  AAA USD avail=0 frozen=0
  BBB USD avail=0 frozen=0
  CCC USD avail=0 frozen=0
SUMMARY cycles=1 settled=1 unwound=0 compensations=0
```

### 2. 重复 ack 与乱序 nak（`samples/sample2_dup_ooo.bin`，含分片/重传/乱序链路包）

```
FX BILATERAL NETTING QUEUE
==========================
banks: AAA(USD=10000) BBB(USD=10000) CCC(USD=10000)
link: packets=8 frames=5
[link] retransmission deduped linkSeq=7
[cycle 1] OBLIGATION AAA->BBB 500 USD seq=1
[cycle 1] ACK confirmed BBB->AAA seq=1
[cycle 1] ACK duplicate ignored BBB->AAA seq=1
[cycle 1] OBLIGATION CCC->AAA 700 USD seq=1
[cycle 1] NAK AAA rejects CCC seq=1 reason=VALIDATION obligation-removed
[cycle 1] CLOSE @vtick=5 obligations=1
[cycle 1] CCY USD gross matrix (minor units):
                 AAA       BBB
AAA                -       500
BBB                0         -
[cycle 1] CCY USD net positions: AAA=-500 BBB=500
[cycle 1] FREEZE AAA 500 USD avail=9500 frozen=500
[cycle 1] SETTLE-DEBIT AAA 500 USD (freeze released)
[cycle 1] SETTLE-CREDIT BBB 500 USD avail=10500
[cycle 1] CCY USD status=SETTLED
FINAL BALANCES (avail / frozen):
  AAA USD avail=9500 frozen=0
  BBB USD avail=10500 frozen=0
  CCC USD avail=10000 frozen=0
SUMMARY cycles=1 settled=1 unwound=0 compensations=0
```

### 3. 流动性不足触发整币种回滚（`samples/sample3_unwind.bin`，EUR 正常结算、USD 整体 unwind）

```
FX BILATERAL NETTING QUEUE
==========================
banks: AAA(USD=5000) AAA(EUR=1000) BBB(USD=4000) CCC(USD=0) CCC(EUR=0)
link: packets=3 frames=3
[cycle 1] OBLIGATION AAA->BBB 4000 USD seq=1
[cycle 1] OBLIGATION BBB->CCC 9000 USD seq=1
[cycle 1] OBLIGATION AAA->CCC 200 EUR seq=2
[cycle 1] CLOSE @vtick=3 obligations=3
[cycle 1] CCY EUR gross matrix (minor units):
                 AAA       CCC
AAA                -       200
CCC                0         -
[cycle 1] CCY EUR net positions: AAA=-200 CCC=200
[cycle 1] FREEZE AAA 200 EUR avail=800 frozen=200
[cycle 1] SETTLE-DEBIT AAA 200 EUR (freeze released)
[cycle 1] SETTLE-CREDIT CCC 200 EUR avail=200
[cycle 1] CCY EUR status=SETTLED
[cycle 1] CCY USD gross matrix (minor units):
                 AAA       BBB       CCC
AAA                -      4000         0
BBB                0         -      9000
CCC                0         0         -
[cycle 1] CCY USD net positions: AAA=-4000 BBB=-5000 CCC=9000
[cycle 1] FREEZE AAA 4000 USD avail=1000 frozen=4000
[cycle 1] RELEASE-RESTORE AAA 4000 USD avail=5000
[cycle 1] UNWIND-CERTIFICATE ccy=USD reason=INSUFFICIENT_LIQUIDITY deficit=BBB need=5000 avail=4000
[cycle 1]   restored-freezes: AAA=4000
[cycle 1]   compensation entries:
[cycle 1]     COMPENSATION_DEBT AAA -4000 USD
[cycle 1]     COMPENSATION_DEBT BBB -5000 USD
[cycle 1]     COMPENSATION_CLAIM CCC 9000 USD
[cycle 1]   status=NO_PARTIAL_SETTLEMENT
FINAL BALANCES (avail / frozen):
  AAA EUR avail=800 frozen=0
  AAA USD avail=5000 frozen=0
  BBB USD avail=4000 frozen=0
  CCC EUR avail=200 frozen=0
  CCC USD avail=0 frozen=0
SUMMARY cycles=1 settled=1 unwound=1 compensations=3
```

### 4. 关闭边界迟到 cancel（`samples/sample4_late_cancel.bin`）

```
FX BILATERAL NETTING QUEUE
==========================
banks: AAA(USD=10000) BBB(USD=10000)
link: packets=5 frames=5
[cycle 1] OBLIGATION AAA->BBB 800 USD seq=1
[cycle 1] OBLIGATION AAA->BBB 300 USD seq=2
[cycle 1] CANCEL AAA seq=2 obligation-removed
[cycle 1] CLOSE @vtick=4 obligations=1
[cycle 1] CCY USD gross matrix (minor units):
                 AAA       BBB
AAA                -       800
BBB                0         -
[cycle 1] CCY USD net positions: AAA=-800 BBB=800
[cycle 1] FREEZE AAA 800 USD avail=9200 frozen=800
[cycle 1] SETTLE-DEBIT AAA 800 USD (freeze released)
[cycle 1] SETTLE-CREDIT BBB 800 USD avail=10800
[cycle 1] CCY USD status=SETTLED
[cycle 2] OBLIGATION BBB->AAA 100 USD seq=1
[cycle 2] CANCEL rejected AAA seq=1: not in open cycle (already settled or never existed) late(from-closed-cycle=1)
[cycle 2] CLOSE @vtick=5 obligations=1
[cycle 2] CCY USD gross matrix (minor units):
                 AAA       BBB
AAA                -         0
BBB              100         -
[cycle 2] CCY USD net positions: AAA=100 BBB=-100
[cycle 2] FREEZE BBB 100 USD avail=10700 frozen=100
[cycle 2] SETTLE-DEBIT BBB 100 USD (freeze released)
[cycle 2] SETTLE-CREDIT AAA 100 USD avail=9300
[cycle 2] CCY USD status=SETTLED
FINAL BALANCES (avail / frozen):
  AAA USD avail=9300 frozen=0
  BBB USD avail=10700 frozen=0
SUMMARY cycles=2 settled=2 unwound=0 compensations=0
```

### 错误退出码（exit 4 / 3 / 2）

```
FX BILATERAL NETTING QUEUE
==========================
banks: AAA(USD=1000) BBB(USD=1000)
link: packets=1 frames=1
error[exit=4] NegativeObligationError: negative obligation AAA->BBB amount=-50
exit=4
```

```
FX BILATERAL NETTING QUEUE
==========================
banks: AAA(USD=1000) BBB(USD=1000)
link: packets=1 frames=1
error[exit=3] UnknownCycleError: unknown cycle 3 (open=1, next=2)
exit=3
```

```
error[exit=2] ValidationError: packet crc mismatch at offset 37 (linkSeq=1)
exit=2
```

### 5. ≤4 行 × 3 义务全枚举对照独立暴力净额

`test/netting.test.js` 第 5 个测试：对 2/3/4 家银行（有序对 2/6/12 个）、
3 笔义务（可重复取自所有有序对）、金额 ∈ {100, 300} 的全部
`8×(2³+6³+12³) = 15616` 种组合，将引擎净额结果与测试内独立实现的暴力净额
（`net[b] = Σ流入 − Σ流出`）逐一比对，并校验净额守恒（Σ=0）。

`node --test` 真实输出（尾部）：

```
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8386.670184
```

## 代码结构

- `wire.js` — 文件/链路包/帧编解码、crc16、分片重组、重传去重、乱序重排
- `engine.js` — 虚拟时钟、周期状态机、净额矩阵、冻结/释放、unwind 与补偿
- `cli.js` — 入口：解析 → 重组 → 逐帧处理 → 输出报告，映射退出码
- `tools/make_samples.js` — 生成 `samples/*.bin` 验收样例
- `test/netting.test.js` — 5 项验收测试 + 链路层/退出码测试
