# 酒店加油预授权引擎（Hotel Pre-Auth Engine）

Node.js 22 · 仅标准库 · `node:test` · 单机离线。

对酒店/加油场景的预授权报文流做确定性处理：递增/递减授权、完成结算、
到期自动释放、冲正，并输出冻结/已扣/可再授权与完整状态迁移证书。

## 运行

```bash
node scripts/gen.js                                # 生成 examples/*.bin
node cli.js examples/ex1-inc-partial.bin --limit 1000
node --test                                        # 全部测试（含 ≤7 帧乱序枚举对照）
```

CLI：`node cli.js <frames.bin> [--limit N] [--ttl N] [--key K]`

- `--limit` 每个 authId 的授信上限（默认 100000，单位：分）
- `--ttl` hold 的虚拟时钟存活 tick 数（默认 100）
- `--key` HMAC 密钥（默认 `hotel-preauth-secret`）

## 帧格式（wire format）

```
[u32 LE bodyLen][JSON body][8-byte mac]
body = {"authId":"A","type":"hold","amount":500,"seq":1,"ack":0}
mac  = HMAC-SHA256(key, len||body)[0..8)
type ∈ hold | inc | dec | complete | void | reverse
```

- **分帧**：长度前缀 + 增量解析器（`FrameParser.push(chunk)`），任意字节边界
  切分都能重组；CLI 按 1024 字节切片喂入以实际走重组路径。
- **重传/去重**：同一 authId 下 `seq` 已见且载荷逐字节相同 → 幂等跳过
  （证书记 `duplicate`）；`seq` 相同载荷不同 → 冲突，exit 3。
- **乱序**：`seq > nextSeq` 的帧进入缺口暂存（证书记 `buffered`），缺口补齐后
  按序下漏；`ack` 字段随载荷参与去重，报告中 `ack = nextSeq-1` 为已连续应用序号。
- **虚拟时钟**：每 ingest 一帧 tick +1；tick 时 `clock > expiresAt` 的 ACTIVE
  授权自动 void（证书记 `auto_void`）。到期未 complete 即自动释放；
  迟到的 complete/inc 一律拒绝但留证（证书记 `rejected`，note 含 `late ...`）。

## 核心语义

状态机：`INIT → ACTIVE → COMPLETED | VOIDED | REVERSED`（后三者终态）。

- `hold` 冻结初始额，须 `0 < amount ≤ limit`，置 `expiresAt = clock + ttl`。
- `inc` 递增授权，不得超限：`accepted = min(amount, limit - frozen - charged)`，
  超出部分拒绝并留证（`inc_partial` / 全拒 `rejected`）。
- `dec` 递减授权，**不得使冻结低于已收到的 completion 候选**：凡因 seq 缺口
  暂存的 `complete` 帧，其金额构成冻结下限 `floor`，
  `applied = min(amount, frozen - floor)`，多余部分拒绝并留证（`dec_partial`）。
  由此 dec/complete 竞态有确定性结果。
- `complete` 把实际金额从冻结转为扣减（`charged += amount`），差额立即释放；
  `amount > frozen` 会造成负冻结 → exit 4。
- `void` 释放全部冻结；非 ACTIVE 拒绝留证。
- `reverse` 只能冲正已 `COMPLETED` 的授权，且须全额（`amount == charged`），
  生成 `reverse` 反向流水；否则拒绝留证。

## 输出与退出码

报告（stdout，JSON）：每个 authId 的 `frozen`（冻结）、`charged`（已扣）、
`available`（可再授权 = limit − frozen − charged）、`ack`、`ledger`（流水）、
`certificate`（状态迁移证书：tick/seq/事件/迁移/金额/备注）。

| 退出码 | 含义 |
|---|---|
| 0 | 正常 |
| 1 | 用法/IO/帧非法/流截断 |
| 2 | mac 校验失败 |
| 3 | 同 seq 异载荷冲突 |
| 4 | 负冻结（complete 超过冻结） |

## 验收场景真实输出

以下均为 `node scripts/gen.js` 生成后原样运行的真实输出（证书为压缩展示，
完整 JSON 可自行复跑核对）。

### 1. inc 超上限部分拒绝 — `node cli.js examples/ex1-inc-partial.bin --limit 1000`（exit 0）

hold 500 后 inc 700：上限 1000，只接受 500，拒绝 200；complete 900 结算并释放 100。
{
  "clock": 3,
  "limit": 1000,
  "ttl": 100,
  "auths": {
    "A": {
      "authId": "A",
      "status": "COMPLETED",
      "frozen": 0,
      "charged": 900,
      "available": 100,
      "ack": 3,
      "expiresAt": 101,
      "ledger": [
        {
          "clock": 1,
          "seq": 1,
          "kind": "hold",
          "amount": 500,
          "frozenAfter": 500,
          "chargedAfter": 0
        },
        {
          "clock": 2,
          "seq": 2,
          "kind": "inc",
          "amount": 500,
          "frozenAfter": 1000,
          "chargedAfter": 0
        },
        {
          "clock": 3,
          "seq": 3,
          "kind": "complete",
          "amount": 900,
          "frozenAfter": 0,
          "chargedAfter": 900
        },
        {
          "clock": 3,
          "seq": 3,
          "kind": "release",
          "amount": 100,
          "frozenAfter": 0,
          "chargedAfter": 900
        }
      ],
      "certificate": [
        {
          "clock": 1,
          "seq": 1,
          "authId": "A",
          "event": "hold",
          "from": "INIT",
          "to": "ACTIVE",
          "frozen": 500,
          "charged": 0,
          "amount": 500,
          "note": "expires at tick 101"
        },
        {
          "clock": 2,
          "seq": 2,
          "authId": "A",
          "event": "inc_partial",
          "from": "ACTIVE",
          "to": "ACTIVE",
          "frozen": 1000,
          "charged": 0,
          "amount": 500,
          "rejectedAmount": 200,
          "note": "inc 700 partially accepted 500: limit 1000"
        },
        {
          "clock": 3,
          "seq": 3,
          "authId": "A",
          "event": "complete",
          "from": "ACTIVE",
          "to": "COMPLETED",
          "frozen": 0,
          "charged": 900,
          "amount": 900,
          "note": "charged 900, released 100"
        }
      ]
    }
  }
}

### 2. dec 与 complete 竞态 — `node cli.js examples/ex2-dec-complete-race.bin --limit 2000`（exit 0）

complete(seq 3) 先于 dec(seq 2) 到达而被暂存，其金额 600 成为冻结下限：
dec 500 被钳制为 400，随后 complete 600 正常结算。

```
A COMPLETED frozen=0 charged=600 available=1400 ack=3
  tick1 seq1 hold        INIT->ACTIVE     amount=1000  expires at tick 101
  tick2 seq3 buffered    ACTIVE->ACTIVE   gap: waiting for seq 2
  tick3 seq2 dec_partial ACTIVE->ACTIVE   amount=400 rejected=100  dec 500 clamped to 400: completion candidate floor 600
  tick3 seq3 complete    ACTIVE->COMPLETED amount=600  charged 600, released 0
```

### 3. 重复 complete — `node cli.js examples/ex3-dup-complete.bin --limit 1000`（exit 0）

同 seq 同载荷的重传幂等跳过；complete 之后新的 complete（不同 seq）拒绝但留证。

```
A COMPLETED frozen=0 charged=500 available=500 ack=3
  tick1 seq1 hold      INIT->ACTIVE           amount=800
  tick2 seq2 complete  ACTIVE->COMPLETED      amount=500  charged 500, released 300
  tick3 seq2 duplicate COMPLETED->COMPLETED   same seq, same payload: idempotent skip
  tick4 seq3 rejected  COMPLETED->COMPLETED   late complete: auth already COMPLETED
```

### 4. 超时 void 与迟到 inc — `node cli.js examples/ex4-timeout.bin --limit 1000 --ttl 3`（exit 0）

A 的 hold 在第 4 tick 到期，第 5 tick 自动 void；迟到的 inc/complete 拒绝留证。
B 的授权也在到期时自动释放（剩余 130）。

```
A VOIDED frozen=0 charged=0 available=1000 ack=3
  tick1 seq1 hold      INIT->ACTIVE   amount=400  expires at tick 4
  tick5 seq- auto_void ACTIVE->VOIDED hold expired at tick 4; released 400
  tick5 seq2 rejected  VOIDED->VOIDED late inc: auth already VOIDED
  tick6 seq3 rejected  VOIDED->VOIDED late complete: auth already VOIDED
B VOIDED frozen=0 charged=0 available=1000 ack=3
  tick2 seq1 hold      INIT->ACTIVE   amount=100  expires at tick 5
  tick3 seq2 inc       ACTIVE->ACTIVE amount=50
  tick4 seq3 dec       ACTIVE->ACTIVE amount=20
  tick6 seq- auto_void ACTIVE->VOIDED hold expired at tick 5; released 130
```

### 5. reverse 冲正 — `node cli.js examples/ex5-reverse.bin --limit 1000`（exit 0）

只有 COMPLETED 可冲正，生成 reverse 反向流水；重复冲正拒绝留证。

```
A REVERSED frozen=0 charged=0 available=1000 ack=4
  tick1 seq1 hold     INIT->ACTIVE        amount=900
  tick2 seq2 complete ACTIVE->COMPLETED   amount=400  charged 400, released 500
  tick3 seq3 reverse  COMPLETED->REVERSED amount=400  reversal ledger entry generated
  tick4 seq4 rejected REVERSED->REVERSED  reverse requires COMPLETED, got REVERSED
```

### 6–8. 错误退出码（真实 stderr）

```
$ node cli.js examples/ex6-mac-error.bin            ; echo $?
error(exit 2): mac mismatch at stream offset 69
2
$ node cli.js examples/ex7-conflict.bin             ; echo $?
error(exit 3): conflict on A#2: retransmission payload differs
3
$ node cli.js examples/ex8-negative-frozen.bin --limit 1000 ; echo $?
error(exit 4): complete 500 exceeds frozen 300 on A#2: negative frozen
4
```

（出错时 stdout 仍会打印截至出错点的完整报告与证书，便于留证排查。）

## 测试（`node --test`）

- `test/engine.test.js` — 验收 1–5 单测：inc 部分拒绝、dec/complete 竞态钳制、
  重复 complete 幂等、超时 auto-void + 迟到留证、reverse 规则、冲突/mac/负冻结、
  分帧重组（全部切分点 + 逐字节滴灌）。
- **≤7 帧枚举乱序对照**：`oracle/reference.js` 是与引擎零共享代码的独立参考
  状态机。测试对三组帧（7 帧混合生命周期 5040 种、6 帧双授权过期 720 种、
  7 帧含重传 5040 种）枚举全部到达顺序，逐一比较引擎与参考实现的最终
  状态/冻结/已扣/可再授权/ack/流水（含 exit 4 竞态分支），结果完全一致。
- `test/cli.test.js` — CLI 端到端：报告字段与退出码 0/1/2/3/4、--ttl 过期。
  （沙箱禁止子进程，测试经 `cli.run()` 进程内调用，与 `node cli.js` 同一代码路径。）

## 文件

```
cli.js               CLI 入口（可导入 run()）
lib/frame.js         帧编解码、HMAC、增量分帧解析器
lib/engine.js        预授权状态机引擎
oracle/reference.js  测试用独立参考状态机
scripts/gen.js       生成 examples/*.bin 验收样例
test/*.test.js       node:test 测试
```
