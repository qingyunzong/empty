# DvP 款券对付配对引擎

Node.js 22、仅标准库、单机离线的证券款券对付（DvP）配对引擎与 CLI。
输入为改单指令帧流（`new` / `amend` / `cancel` / `match` / `settle` / `fail`，
外加可选的 `limits` 额度帧），支持重传去重、乱序重放、分帧重组与虚拟时钟
撮合窗口超时；输出成交、剩余、冻结、失败补偿与可重放审计根。

## 运行

```sh
node cli.js <in.jsonl>     # 处理指令帧流，结果 JSON 打印到 stdout
node --test                # 运行全部测试（node:test）
node tools/sign.js <f.jsonl>  # 给未签名帧计算并附加 crc
```

## 帧格式

每帧是一个 JSON 对象。输入可以是 JSONL、pretty-print 多行 JSON 或任意
分帧拼接的字节流——解析器按花括号深度重组完整帧，帧间只允许空白。

| 字段 | 说明 |
| --- | --- |
| `type` | `limits` `new` `amend` `cancel` `match` `settle` `fail` |
| `seq` | 非负整数，日志序号；重放顺序的唯一依据 |
| `ts` | 虚拟时钟时刻（非负数，缺省 0），驱动撮合窗口超时 |
| `clOrdId` | 指令标识（`new`/`amend` 必填） |
| `origId` | 目标订单标识（`amend`/`cancel`/`fail` 必填，`settle` 可选） |
| `side`/`qty`/`price` | `new` 必填；`amend` 至少给 `qty` 或 `price`；均为正整数 |
| `crc` | 帧完整性校验：除 `crc` 外全部字段的规范化 JSON 的 CRC-32（IEEE，8 位小写 hex） |

`limits` 帧：`funds` / `securities`（非负整数或 `null`=无限）、`window`
（撮合窗口长度，虚拟时钟 tick，默认 100）。

## 核心语义

- **重传与去重**：相同 `seq` 相同载荷静默去重；相同 `seq` 不同载荷判帧错；
  相同 `clOrdId` 相同载荷记 `duplicate_ignored`；相同 `clOrdId` 不同载荷 exit 4。
- **乱序**：所有帧按 `seq` 排序后重放，到达顺序不影响结果与审计根。
- **冻结**：`new` 时买方冻结资金 `qty*price`、卖方冻结证券 `qty`，双额度
  分别记账（`frozen` / `spent` / `available`）。额度不足整单 `order_rejected`，
  不发生任何扣减。
- **撮合**：`match` 帧触发一轮撮合。价格-时间优先，同价同刻按 `clOrdId`
  升序；成交价为做市方（先挂单方）价格，买方价差即时解冻。部分成交后
  剩余量保留优先级继续排队。
- **DvP 原子性**：配对时双边必须同时可交割，否则整笔配对拒绝
  （`pair_rejected`），任何一边都不扣减。
- **amend**：不得穿越已成交部分（`newQty < filled` → `amend_rejected`
  `crosses_filled`）；改单按差额追加/释放冻结，并失去时间优先（以 amend
  的 `ts` 重新排队）。已成交部分永远不可变。
- **cancel 与成交竞态**：同一虚拟时刻下按日志序（`seq`）决胜——`seq` 小者
  先生效。
- **窗口超时**：订单有效期为 `[ts, ts+window)`；虚拟时钟推进到期的未成交
  剩余量 `expired` 并释放冻结。
- **settle / fail**：`settle` 把成交的冻结资金/证券最终化为已交付
  （`spent`），只追加账、不可抹账；此后对该成交只允许 `fail` 补偿——
  追加一笔 `fail_compensation` 补偿记录（经济效果冲回，原始 `settled`
  事件保留在审计日志中）。
- **审计根**：每个事件以 `sha256(prevRoot + canonical(event))` 链式累加，
  输出 `auditRoot`；同一输入（任意到达顺序、含重传）重放得到相同根。

## 退出码

| code | 含义 |
| --- | --- |
| 0 | 正常 |
| 2 | 帧错（JSON 损坏、crc 不符、字段非法、同 seq 冲突重传等） |
| 3 | 未知 `origId` |
| 4 | 重复 `clOrdId` 且载荷不同 |

## 真实输出记录

输入 `examples/sample.jsonl`（由 `node tools/sign.js examples/sample.unsigned.jsonl`
生成）覆盖：额度设置、部分成交、amend 缩单、二次撮合、cancel 释放、settle
最终化、fail 补偿、窗口超时释放。

```sh
$ node cli.js examples/sample.jsonl ; echo exit=$?
```

```json
{
  "ok": true,
  "clock": 100,
  "window": 50,
  "accounts": {
    "funds": { "limit": 1000, "frozen": 0, "spent": 0, "available": 1000 },
    "securities": { "limit": 20, "frozen": 0, "spent": 0, "available": 20 }
  },
  "orders": [
    { "clOrdId": "X1", "side": "buy",  "qty": 8, "price": 5, "filled": 8, "remaining": 0, "status": "filled",    "frozenRemain": 0, "frozenFilled": 0, "expiry": 50 },
    { "clOrdId": "S1", "side": "sell", "qty": 6, "price": 4, "filled": 6, "remaining": 0, "status": "filled",    "frozenRemain": 0, "frozenFilled": 0, "expiry": 50 },
    { "clOrdId": "S2", "side": "sell", "qty": 5, "price": 5, "filled": 2, "remaining": 0, "status": "cancelled", "frozenRemain": 0, "frozenFilled": 0, "expiry": 53 },
    { "clOrdId": "X3", "side": "buy",  "qty": 5, "price": 5, "filled": 0, "remaining": 0, "status": "expired",   "frozenRemain": 0, "frozenFilled": 0, "expiry": 90 }
  ],
  "fills": [
    { "fillId": "F1", "buyId": "X1", "sellId": "S1", "qty": 6, "price": 4, "seq": 3, "ts": 1, "settled": true, "compensated": true },
    { "fillId": "F2", "buyId": "X1", "sellId": "S2", "qty": 2, "price": 5, "seq": 6, "ts": 4, "settled": true, "compensated": true }
  ],
  "compensations": [
    { "fillId": "F1", "triggeredBy": "X1", "fundsCredited": 24, "securitiesCredited": 6 },
    { "fillId": "F2", "triggeredBy": "X1", "fundsCredited": 10, "securitiesCredited": 2 }
  ],
  "events": [
    "limits_set", "order_accepted", "order_accepted", "fill", "amend_accepted",
    "order_accepted", "fill", "cancel_accepted", "settled", "settled",
    "fail_compensation", "fail_compensation", "order_accepted", "expired"
  ],
  "auditRoot": "53763229e2436c9696198dea52782d6ec6c46c0c948ba1c6ac3726718138ac35"
}
exit=0
```

（`events` 数组在真实输出中为完整事件对象，此处仅列出 `kind` 以便阅读；
其余字段与真实输出逐字节一致。）

错误输出示例：

```sh
$ node cli.js bad-crc.jsonl ; echo exit=$?
{"error":{"code":2,"message":"frame 0: crc mismatch"}}
exit=2
```

## 测试与验收对照

`node --test` 共 4 个测试文件：

- `test/engine.test.js` — 验收 1（amend 穿越已成交 → `crosses_filled`）、
  验收 2（cancel 与 match 同刻按 seq 决胜，两个方向各一例）、
  验收 3（资金足证券不足 → 整单拒绝、零扣减）、
  验收 4（窗口超时未配对释放冻结），另有部分成交、价格-时间优先与同价
  同刻 clOrdId 决胜、做市价成交与价差解冻、重传去重、乱序重放、
  settle/fail 补偿不抹账、审计根确定性。
- `test/cli.test.js` — 退出码 0/2/3/4、分帧重组、冲突重传。
- `test/interleaving.test.js` — 验收 5：7 条指令的全部 7! = 5040 种合法
  交错与独立参考撮合器（`test/reference.js`，与引擎零共享代码）逐一
  对照一致，且所有交错的审计根相同；另验证交错中混入重传帧仍去重。
