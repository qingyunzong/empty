# 酒店加油预授权引擎（Hotel Pre-Auth Engine）

Node.js 22，仅标准库，单机离线。实现酒店/加油场景的预授权状态机与 CLI：
递增/递减授权、完成结算、到期自动释放，支持重传去重、乱序缓冲、分帧重组与虚拟时钟。

## 运行

```bash
node tools/gen-sample.js        # 生成 sample/frames.bin
node cli.js sample/frames.bin   # 处理帧流，输出报告到 stdout
node --test                     # 运行全部测试
```

环境变量：`PA_KEY`（HMAC 密钥，默认 `dev-key`）、`PA_TTL`（授权存活虚拟时钟刻度，默认 100）、`PA_LIMIT`（默认授权上限，默认 100000）。

## 帧格式

物理帧（小端流式，可任意切分传输）：

```
[2B magic 'PA'][1B version=1][1B flags][4B payloadLen BE][payload][8B mac]
```

- `flags` bit0 = MORE：当前为分片，后续物理帧的 payload 需拼接重组；mac 逐物理帧校验。
- `mac` = HMAC-SHA256(key, header‖payload) 前 8 字节。
- payload 为 JSON：`{authId, type, seq, amount, ts, ack, limit?}`，
  `type ∈ hold | inc | dec | complete | void | reverse`。

## 核心语义

- **hold**：冻结初始额，记录 `limit` 与 `expiresAt = ts + TTL`，状态 INIT→OPEN。
- **inc**：不超过上限；超出部分**部分拒绝**，只接受 `limit - frozen` 的余量（证书 `INC_PARTIAL`）。
- **dec**：不得使冻结低于已收到的 complete 候选金额（含乱序暂存的 complete），否则报错退出 4。
- **complete**：实际金额从冻结转为已扣，差额释放，状态→COMPLETED。
- **void**：释放全部冻结，状态→VOIDED。
- **reverse**：仅允许已 complete 的授权，生成 `REVERSE` 反向流水并冲减已扣。
- **到期**：虚拟时钟随帧 `ts` 前进，到期未 complete 自动 `AUTO_VOID`；迟到的 inc/complete 拒绝并留证（`EVIDENCE: LATE_INC / LATE_COMPLETE`）。
- **排序**：同一 authId 按 seq 应用；缺口暂存（ack `buffered`）；同 seq 同载荷幂等（ack `duplicate`）；同 seq 异载荷冲突退出 3。

## 退出码

| code | 含义 |
|------|------|
| 0 | 成功 |
| 2 | MAC 校验失败（`MAC_ERROR`） |
| 3 | seq 冲突（`SEQ_CONFLICT`） |
| 4 | 负冻结（`NEGATIVE_FROZEN`） |

## 输出

stdout 输出 JSON 报告：每个授权的 `frozen`（冻结）、`charged`（已扣）、
`available`（可再授权 = limit − frozen，仅 OPEN 时非零）、`status`；
`ledger`（反向流水与留证）；`certificates`（状态迁移证书，SHA-256 哈希链）；
`acks`（逐帧回执：applied / buffered / duplicate / rejected:原因）。
致命错误时错误信息写 stderr，仍输出已处理部分的状态。

## 真实输出

`node tools/gen-sample.js && node cli.js sample/frames.bin`（退出码 0）。
样例覆盖：inc 超限部分拒绝、complete 乱序暂存、重复 complete 幂等、
reverse 反向流水、ROOM-512 到期 AUTO_VOID 与迟到 inc/complete 留证。

```json
{
  "clock": 160,
  "auths": {
    "ROOM-301": {
      "status": "COMPLETED",
      "frozen": 0,
      "charged": 750,
      "available": 0,
      "limit": 1000,
      "expiresAt": 100,
      "nextSeq": 6
    },
    "ROOM-512": {
      "status": "VOIDED",
      "frozen": 0,
      "charged": 0,
      "available": 0,
      "limit": 100000,
      "expiresAt": 100,
      "nextSeq": 4
    }
  },
  "ledger": [
    {
      "kind": "REVERSE",
      "authId": "ROOM-301",
      "seq": 5,
      "amount": 150,
      "ts": 40
    },
    {
      "kind": "EVIDENCE",
      "reason": "LATE_INC",
      "authId": "ROOM-512",
      "seq": 2,
      "type": "inc",
      "amount": 50,
      "ts": 150
    },
    {
      "kind": "EVIDENCE",
      "reason": "LATE_COMPLETE",
      "authId": "ROOM-512",
      "seq": 3,
      "type": "complete",
      "amount": 300,
      "ts": 160
    }
  ],
  "certificates": [
    {
      "index": 0,
      "authId": "ROOM-301",
      "seq": 1,
      "type": "hold",
      "transition": "HOLD",
      "from": "INIT",
      "to": "OPEN",
      "frozen": 800,
      "charged": 0,
      "ts": 0,
      "prevHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "hash": "1807dc3037c47210c084d43030d1d57ae171c97118a34a4dc82bc00a7cc0466c"
    },
    {
      "index": 1,
      "authId": "ROOM-301",
      "seq": 2,
      "type": "inc",
      "transition": "INC_PARTIAL",
      "from": "OPEN",
      "to": "OPEN",
      "frozen": 1000,
      "charged": 0,
      "ts": 10,
      "requested": 500,
      "accepted": 200,
      "rejected": 300,
      "prevHash": "1807dc3037c47210c084d43030d1d57ae171c97118a34a4dc82bc00a7cc0466c",
      "hash": "f786f5bf838c0598498a56b713061825974fce9f6f89f6102716f010e2f85ccf"
    },
    {
      "index": 2,
      "authId": "ROOM-301",
      "seq": 3,
      "type": "dec",
      "transition": "DEC",
      "from": "OPEN",
      "to": "OPEN",
      "frozen": 900,
      "charged": 0,
      "ts": 20,
      "prevHash": "f786f5bf838c0598498a56b713061825974fce9f6f89f6102716f010e2f85ccf",
      "hash": "b57593648eb18a8b9da4849e993f7cbca432f04d12fee69e9ea2c4df0c46785b"
    },
    {
      "index": 3,
      "authId": "ROOM-301",
      "seq": 4,
      "type": "complete",
      "transition": "COMPLETE",
      "from": "OPEN",
      "to": "COMPLETED",
      "frozen": 0,
      "charged": 900,
      "ts": 30,
      "released": 0,
      "prevHash": "b57593648eb18a8b9da4849e993f7cbca432f04d12fee69e9ea2c4df0c46785b",
      "hash": "41a486bcddefc246e9a442608a6eff42440253231dcca00cd256c6351b8dae3f"
    },
    {
      "index": 4,
      "authId": "ROOM-301",
      "seq": 5,
      "type": "reverse",
      "transition": "REVERSE",
      "from": "COMPLETED",
      "to": "COMPLETED",
      "frozen": 0,
      "charged": 750,
      "ts": 40,
      "prevHash": "41a486bcddefc246e9a442608a6eff42440253231dcca00cd256c6351b8dae3f",
      "hash": "744e670179ade3f055458a88817d1ddeb7afeb81299aea668d5de3f7548277b0"
    },
    {
      "index": 5,
      "authId": "ROOM-512",
      "seq": 1,
      "type": "hold",
      "transition": "HOLD",
      "from": "INIT",
      "to": "OPEN",
      "frozen": 600,
      "charged": 0,
      "ts": 0,
      "prevHash": "744e670179ade3f055458a88817d1ddeb7afeb81299aea668d5de3f7548277b0",
      "hash": "0d4dec049f7a0e67d7b8498dcc3678f6a7a4bface2eb97477968b7a53acf8925"
    },
    {
      "index": 6,
      "authId": "ROOM-512",
      "seq": null,
      "type": null,
      "transition": "AUTO_VOID",
      "from": "OPEN",
      "to": "VOIDED",
      "frozen": 0,
      "charged": 0,
      "ts": 150,
      "released": 600,
      "prevHash": "0d4dec049f7a0e67d7b8498dcc3678f6a7a4bface2eb97477968b7a53acf8925",
      "hash": "f96e96266585db46ff8449012779cccecd9a5ad7974b8fd66c23db3a29901bec"
    }
  ],
  "acks": [
    {
      "authId": "ROOM-301",
      "seq": 1,
      "result": "applied"
    },
    {
      "authId": "ROOM-301",
      "seq": 2,
      "result": "applied"
    },
    {
      "authId": "ROOM-301",
      "seq": 4,
      "result": "buffered"
    },
    {
      "authId": "ROOM-301",
      "seq": 3,
      "result": "applied"
    },
    {
      "authId": "ROOM-301",
      "seq": 4,
      "result": "applied"
    },
    {
      "authId": "ROOM-301",
      "seq": 4,
      "result": "duplicate"
    },
    {
      "authId": "ROOM-301",
      "seq": 5,
      "result": "applied"
    },
    {
      "authId": "ROOM-512",
      "seq": 1,
      "result": "applied"
    },
    {
      "authId": "ROOM-512",
      "seq": 2,
      "result": "rejected:LATE_INC"
    },
    {
      "authId": "ROOM-512",
      "seq": 3,
      "result": "rejected:LATE_COMPLETE"
    }
  ]
}
```

## 测试（node --test）

- `test/frame.test.js`：分帧重组、逐字节流式解析、MAC 篡改/错密钥/截断。
- `test/engine.test.js`：验收 1–4（inc 超限部分拒绝、dec 与 complete 竞态、
  重复 complete 幂等、超时 void 与迟到 inc/complete）及冲突/负冻结错误码。
- `test/permutation.test.js`：验收 5 —— 7 帧全部 5040 种乱序到达顺序
  与参考状态机（按 seq 排序直放）逐一对比终态一致；≤7 帧子集含重复帧亦收敛。
- `test/cli.test.js`：CLI 退出码 0/2/3/4。
