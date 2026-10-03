# preauth-pool — 银行卡预授权资金池

纯 Node.js 22 标准库实现（无第三方依赖），`node:test` 测试，单机离线。
场景：银行卡预授权先冻结额度，捕获（capture）或过期释放；高价值交易在全局
资金池不足时，可抢占**即将过期且更低优先级**的预授权；不可抢占已捕获或
同优先级先到期者。核心机制：过期时间堆、可验证无超授证书、公平抢占与饥饿上界。

## 运行

```bash
node --test                                   # 全部测试（5 个文件，28 个用例）
node src/cli.js [--naive] [--verify] [--compact] [input.json]   # 缺省读 stdin
```

输入格式：

```json
{
  "config": { "pool": 100, "agingK": 2, "preemptWindow": 2,
              "cards": { "gold": 500, "silver": 300 } },
  "events": [
    { "slot": 0, "type": "auth",    "id": "L1", "card": "gold",
      "amount": 60, "priority": 0, "expiry": 3 },
    { "slot": 2, "type": "capture", "id": "L1", "amount": 55 },
    { "slot": 4, "type": "revoke",  "id": "L1" }
  ]
}
```

输出：`{ timeline, violations, wakes, queue, certificates, ok }`
（`--verify` 额外输出 `certificateFailures`；`ok = 无违规且证书全部有效`）。

## 模型与确定性语义

- 每笔请求：`id, card, amount, priority（越大越高）, submitSlot, expirySlot`。
- **同卡额度硬约束**：`Σ active(卡) ≤ limit`，超限直接拒绝（`CARD_LIMIT`），不排队。
- **全局资金池软约束**：`Σ active ≤ pool`，不足时先尝试抢占，失败则排队（`POOL_SHORT`）。
- **槽内事件排序**：槽 → 类型（capture/revoke 先于 auth）→ 优先级降序 → 提交序 → id。
- **边界规则**：过期发生在槽末。故"同刻过期与捕获"中，捕获在其过期槽仍有效；
  过期槽 + 1 的捕获报 `AUTH_EXPIRED`；排队请求在其过期槽被唤醒仍然有效。
- **老化**：排队每等待 `agingK` 槽有效优先级 +1，最多 +2：
  `effP = p + min(2, ⌊(slot − submitSlot)/agingK⌋)`。

## 抢占规则（公平、可回滚）

资金池不足时，新请求 `r` 可抢占的候选须同时满足：

1. 严格更低优先级（`p < p(r)`）——同优先级先到期者受保护；
2. 即将过期（`expiry − slot ≤ preemptWindow`）；
3. 处于 active（已捕获/已过期/已撤销者天然不可抢占）。

候选按（优先级升序、过期升序、提交序、id）贪心选取；**累计释放额不足则整体
回滚**（无任何部分释放），请求排队并记录 `POOL_SHORT`；若被禁目标本可覆盖
缺口，追加 `PREEMPT_FORBID` 及每个目标被禁原因
（`same-or-higher-priority` / `not-expiring-soon`）。

## 撤销与级联唤醒证明

任何释放（capture / revoke / 过期 / 被抢占）在槽末触发**级联唤醒**：等待队列按
（有效优先级降序、提交序、id）依次尝试准入，每次唤醒输出可验证证明：

```json
{ "slot": 8, "woke": "W",
  "proof": { "freedBy": ["A"], "effectivePriority": 3,
             "poolBefore": 0, "poolAfter": 60,
             "card": "gold", "cardUsedAfter": 60 } }
```

`freedBy` 指明本槽释放来源，`poolBefore/After` 与证书可交叉核对。

## 饥饿上界

排队请求 `r` 在 `submitSlot + 2·agingK` 槽后达到最大老化（`p+2`）。此后任何
**更晚提交且基础优先级 ≤ p(r)** 的请求在队列序中恒排在 `r` 之后（有效优先级
不更高，提交序更晚）。因此 `r` 不晚于"最大老化之后第一个释放足够容量的槽"
被准入——等待有界，不被饿死。`test/enumeration.test.js` 对释放槽 3..9 枚举
验证了该上界；`examples/starvation.json` 为其演示（见下）。

## 无超授证书

每个槽输出一份证书：`{ slot, pool:{used,cap,ok}, cards:{…:{used,limit,ok}},
active:[…], digest }`，`digest = sha256(canonicalJSON(证书体))`（键序无关的
规范化 JSON）。`verifyCertificate` 双重校验：

1. **完整性**：证书体重算 digest 须与 `digest` 一致（任何篡改即失败）；
2. **健全性**：由 `active` 列表重算各卡与资金池占用，须等于声明值且不超限。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `POOL_SHORT` | 资金池不足且抢占失败，请求排队 |
| `AUTH_EXPIRED` | 对已过期预授权执行 capture/revoke |
| `PREEMPT_FORBID` | 抢占被禁（目标同/高优先级或未临期），附目标与原因 |
| `CAPTURED` | 对已捕获预授权再次 capture 或 revoke |
| `CARD_LIMIT` | 同卡额度硬约束拒绝（附加码） |
| `UNKNOWN_CARD` / `UNKNOWN_ID` / `DUP_ID` / `NOT_ACTIVE` / `BAD_INPUT` | 输入类错误（附加码） |

## 真实输出

### 边界：同刻过期与捕获（`examples/boundary.json`）

`node src/cli.js --verify examples/boundary.json` 的完整真实输出
（X 在过期槽 2 捕获成功；Y 在槽 3 捕获报 `AUTH_EXPIRED`）：

```json
{
  "timeline": [
    { "slot": 0, "type": "auth", "id": "X", "result": "admitted" },
    { "slot": 0, "type": "auth", "id": "Y", "result": "admitted" },
    { "slot": 2, "type": "captured", "id": "X", "captureAmount": 10 },
    { "slot": 2, "type": "expired", "id": "Y" },
    { "slot": 3, "type": "capture", "id": "Y", "result": "rejected", "reason": "AUTH_EXPIRED" }
  ],
  "violations": [ { "slot": 3, "id": "Y", "code": "AUTH_EXPIRED" } ],
  "wakes": [],
  "queue": [],
  "certificates": [
    { "slot": 0, "pool": { "used": 20, "cap": 100, "ok": true },
      "cards": { "gold": { "used": 20, "limit": 50, "ok": true } },
      "active": [
        { "id": "X", "card": "gold", "amount": 10, "priority": 1, "expiry": 2 },
        { "id": "Y", "card": "gold", "amount": 10, "priority": 1, "expiry": 2 } ],
      "digest": "84379dbd5bec1508ad485b18c0136e9c2565d2eb619ab23300f66ed25130e265" },
    { "slot": 1, "pool": { "used": 20, "cap": 100, "ok": true },
      "cards": { "gold": { "used": 20, "limit": 50, "ok": true } },
      "active": [
        { "id": "X", "card": "gold", "amount": 10, "priority": 1, "expiry": 2 },
        { "id": "Y", "card": "gold", "amount": 10, "priority": 1, "expiry": 2 } ],
      "digest": "37e188659bdf6c602ba10b380fb97f9747773f44fecc1b043d7d83a449c96810" },
    { "slot": 2, "pool": { "used": 0, "cap": 100, "ok": true },
      "cards": { "gold": { "used": 0, "limit": 50, "ok": true } },
      "active": [],
      "digest": "011aa959537e8720c5793d7c2c271ed0b095f6802281cde6cb9103074c07a6b0" },
    { "slot": 3, "pool": { "used": 0, "cap": 100, "ok": true },
      "cards": { "gold": { "used": 0, "limit": 50, "ok": true } },
      "active": [],
      "digest": "bec335573e0c8204541d9d9dd4fb6749b3c15b4d8e09bbe18132a25e135fe5f4" }
  ],
  "certificateFailures": [],
  "ok": false
}
```

（`ok: false` 因为存在一条 `AUTH_EXPIRED` 违规；证书全部有效。）

### 抢占成功（`examples/preemption.json`）

`node src/cli.js --verify examples/preemption.json` 的真实输出
（certificates 共 10 份，此处省略；槽 1 证书：pool.used=100/100，
digest `b96d0ce3…00df`）：

```json
{
  "timeline": [
    { "slot": 0, "type": "auth", "id": "L2", "result": "admitted" },
    { "slot": 0, "type": "auth", "id": "L1", "result": "admitted" },
    { "slot": 1, "type": "preempted", "id": "L1", "preemptedBy": "H1" },
    { "slot": 1, "type": "auth", "id": "H1", "result": "admitted", "preempted": ["L1"] },
    { "slot": 2, "type": "captured", "id": "H1", "captureAmount": 55 },
    { "slot": 4, "type": "auth", "id": "M1", "result": "admitted" },
    { "slot": 8, "type": "expired", "id": "M1" },
    { "slot": 9, "type": "expired", "id": "L2" }
  ],
  "violations": [],
  "wakes": [],
  "queue": [],
  "certificateFailures": [],
  "ok": true
}
```

H1（p2）在槽 1 抢占 L1（p0，槽 3 到期 ≤ preemptWindow 2）；L2（p1，槽 9 到期）
不临期故不受抢占。

### 饥饿有界（`examples/starvation.json`，节选真实输出）

W（p1，槽 0 提交）与更晚的同优先级 B、C 排队等 A（p5, 100）释放；W 在槽 4 达到
最大老化，A 在槽 8 过期后 W 第一个被唤醒（`effectivePriority: 3`），B、C 无法插队：

```json
{ "timeline": [
    { "slot": 0, "type": "auth", "id": "W", "result": "queued", "reason": "POOL_SHORT" },
    { "slot": 8, "type": "expired", "id": "A" },
    { "slot": 8, "type": "auth", "id": "W", "result": "admitted", "woke": true } ],
  "wakes": [
    { "slot": 8, "woke": "W",
      "proof": { "freedBy": ["A"], "effectivePriority": 3,
                 "poolBefore": 0, "poolAfter": 60,
                 "card": "gold", "cardUsedAfter": 60 } } ] }
```

## 测试（`node --test`）

真实输出摘要：

```
# tests 5
# pass 5
# fail 0
```

5 个测试文件、共 28 个用例：

- `test/heap.test.js` — 过期时间堆的确定性序与懒删除。
- `test/core.test.js` — 规范化 JSON/摘要、老化上限、证书验证与篡改检测。
- `test/engine.test.js` — 生命周期、同刻过期/捕获边界、同槽排序、硬/软约束、
  抢占成功、**抢占失败回滚**（目标原样、pool.used 不变）、同优先级保护、
  `CAPTURED`、撤销级联唤醒证明、饥饿上界、堆/朴素策略一致性、确定性。
- `test/enumeration.test.js` — **n≤9 离散事件枚举对照**：6 事件×3 槽全 729 种、
  9 事件×2 槽全 512 种槽位分配，外加 300 组 9 事件种子随机场景；逐一断言
  堆实现与朴素扫描实现输出完全一致、每槽证书可验证、无超授不变量、
  字节级确定性；并对释放槽 3..9 枚举验证饥饿上界。
- `test/cli.test.js` — 报告结构、双策略一致、确定性、证书校验
  （CLI 本体经 `node src/cli.js --verify examples/*.json` 手工验证，见上）。

## 结构

```
src/heap.js    二叉最小堆（确定性比较器 + discardWhile 懒删除）
src/core.js    规范化 JSON、digest、老化、各类全序比较器、证书构建/验证
src/engine.js  槽位模拟引擎（strategy: 'heap' | 'naive'，互为对照实现）
src/report.js  生成 { timeline, violations, wakes, queue, certificates, ok }
src/cli.js     命令行入口（--naive / --verify / --compact）
examples/      boundary.json / preemption.json / starvation.json
test/          node:test 测试（5 文件 28 用例）
```
