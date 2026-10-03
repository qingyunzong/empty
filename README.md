# preauth-pool

银行卡预授权资金池：先冻结额度，捕获（capture）或过期释放；高价值交易在
全局资金池不足时可**抢占**即将过期且低优先级的预授权。纯 Node.js 22 标准库
实现，无第三方依赖；测试使用 `node:test`。

## 模型

- 每笔请求：`id`、`card`、`amount`（整数）、`priority`、`slot`（提交槽）、
  `expires`（过期槽）。`expires = s` 的预授权在槽 `< s` 有效，槽 `s` 开始时过期。
- **同卡额度硬约束**：超出卡剩余额度的请求立即拒绝（`CARD_LIMIT`），不入队。
- **全局资金池软约束**：池不足时先尝试抢占，抢占无果则排队等待唤醒。
- 捕获可部分捕获，剩余冻结额立即释放回池；捕获部分结算出池。

## 核心机制

**过期时间堆**（`src/heap.js`）：按 `(expires, 提交序, id)` 排序的二叉最小堆，
惰性删除；每槽开始弹出所有 `expires <= slot` 的活跃预授权并释放。

**可验证无超授证书**：每槽处理完输出证书
`{slot, pool:{frozen,limit}, cards:{...}, active:[...], ok}`。
`verifyCertificate(cert)`（`src/engine.js`）从证书中的活跃预授权列表独立重算
各卡与全局冻结额，校验 `frozen <= limit` 且账实相符；测试中含篡改检测。

**公平抢占**：
- 候选 = 活跃且 `priority < 请求方有效优先级` 且 `expires - slot <= preemptWindow`；
  已捕获、同优先级（含先到期者）一律不可抢占。
- 按 `(优先级升序, 过期升序, 提交序, id)` 贪心选取，覆盖缺口才整体生效；
  否则**原子回滚**，不产生任何部分抢占，请求入队并记 `POOL_SHORT`
  （若缺口本可由被禁抢占者覆盖，另记 `PREEMPT_FORBID`）。

**老化与饥饿上界**：等待每满 `agingK` 槽有效优先级 +1，最多 +2。
因此排队请求在 `2*agingK` 槽后达到最高老化级，只有基础优先级高出 2 级以上的
新请求才能排在它前面——测试验证等待上界 `2k+1` 槽内必被服务（在资金周期性
释放、持续同级到达的对抗场景下）。

**级联唤醒与唤醒证明**：撤销（revoke）、捕获释放、过期都会触发队列重排唤醒；
每次唤醒输出 `wake` 条目，附证明 `{woke, poolFrozen, poolLimit, cardFrozen}`
及触发源 `trigger`。

**确定性**：槽升序处理；槽内先过期（堆序），再队列唤醒，再按
`(优先级降序, 提交序, id)` 处理事件（capture/revoke 无优先级，排最前）；
每次资金释放事件后立即级联唤醒。同一输入任意乱序提交序仍产生唯一输出。

## 错误码

| 码 | 含义 |
|---|---|
| `POOL_SHORT` | 池不足且抢占无法覆盖，请求入队 |
| `AUTH_EXPIRED` | 对已过有效期（含已过期/被抢占/已撤销/未生效）的预授权执行操作 |
| `PREEMPT_FORBID` | 缺口本可覆盖，但挡路者被禁抢占（已捕获/同级或更高优先级/未临期） |
| `CAPTURED` | 对已捕获的预授权再次捕获或撤销 |
| `CARD_LIMIT` | 超出同卡硬额度，立即拒绝（补充码） |

## 使用

```bash
node bin/preauth.js examples/sample.jsonl
# 或 stdin： cat events.jsonl | node bin/preauth.js --pool 100 --card c1:200
```

输入为 JSONL：首行可选 `{"type":"config","pool":...,"cards":{...},"agingK":2,"preemptWindow":2}`，
其余为 `auth` / `capture` / `revoke` 事件。输出
`{timeline, violations, queue, certificates, certificatesOk}`；
有违规时退出码为 2。

## 真实输出

`node bin/preauth.js examples/sample.jsonl`（退出码 2，因含违规记录）。
场景：池 100；`low1/low2` 被高优先级的 `vip` 抢占；`keep2`、`w1` 排队；
`vip` 部分捕获释放 40 唤醒 `keep2`；撤销 `keep2` 级联唤醒 `w1`；
对已被抢占的 `low1` 捕获报 `AUTH_EXPIRED`。

timeline（节选，完整见命令输出）：

```json
[
  {"slot":0,"type":"auth","id":"low1","card":"c1","amount":60,"priority":0,"expires":3},
  {"slot":0,"type":"auth","id":"low2","card":"c2","amount":40,"priority":0,"expires":3},
  {"slot":1,"type":"preempt","id":"low1","by":"vip"},
  {"slot":1,"type":"preempt","id":"low2","by":"vip"},
  {"slot":1,"type":"auth","id":"vip","card":"c1","amount":100,"priority":5,"expires":9},
  {"slot":2,"type":"queue","id":"keep2","shortfall":30},
  {"slot":2,"type":"queue","id":"w1","shortfall":80},
  {"slot":4,"type":"capture","id":"vip","amount":60,"released":40},
  {"slot":4,"type":"auth","id":"keep2","card":"c1","amount":30,"priority":2,"expires":12},
  {"slot":4,"type":"wake","trigger":{"type":"capture","id":"vip"},"woke":["keep2"],
   "proof":{"woke":["keep2"],"poolFrozen":30,"poolLimit":100,"cardFrozen":{"c1":30,"c2":0}}},
  {"slot":5,"type":"revoke","id":"keep2"},
  {"slot":5,"type":"auth","id":"w1","card":"c2","amount":80,"priority":1,"expires":20},
  {"slot":5,"type":"wake","trigger":{"type":"revoke","id":"keep2"},"woke":["w1"],
   "proof":{"woke":["w1"],"poolFrozen":80,"poolLimit":100,"cardFrozen":{"c1":0,"c2":80}}}
]
```

violations 与 queue：

```json
{
  "violations": [
    {"slot":2,"id":"keep2","code":"POOL_SHORT","shortfall":30},
    {"slot":2,"id":"keep2","code":"PREEMPT_FORBID","blockers":["vip"]},
    {"slot":2,"id":"w1","code":"POOL_SHORT","shortfall":80},
    {"slot":2,"id":"w1","code":"PREEMPT_FORBID","blockers":["vip"]},
    {"slot":3,"id":"low1","code":"AUTH_EXPIRED","status":"preempted"}
  ],
  "queue": [],
  "certificatesOk": true
}
```

注意 `keep2` 唤醒时 `priority: 2`（基础 1 + 老化 1），`w1` 唤醒时
`priority: 1`（基础 0 + 老化 1）——老化机制生效。

## 测试

```bash
node --test
```

真实输出：

```
# tests 4
# suites 0
# pass 4
# fail 0
```

- `test/engine.test.js` — 验收场景：同刻过期与捕获边界（`expires` 槽捕获报
  `AUTH_EXPIRED`，前一槽成功）、抢占成功/禁止/失败原子回滚、已捕获不可抢占、
  撤销级联唤醒与唤醒证明、老化数值、饥饿上界（`2k` 与持续对抗到达下 `2k+1`）、
  证书校验与篡改检测、确定性。
- `test/enumeration.test.js` — n≤9 离散事件枚举对照：400 组随机场景 +
  固定 5 事件全排列（120 种提交序），堆实现与独立参考实现
  （`test/reference.js`，纯数组线性扫描）输出逐字节一致，且每张证书可验证。
- `test/cli.test.js` — CLI 输入输出、退出码、flag 覆盖 config。

## 文件

- `src/heap.js` — 过期时间最小堆
- `src/engine.js` — 引擎：过期、抢占、排队、老化、证书、`verifyCertificate`
- `src/cli.js` — CLI 逻辑（可在进程内测试）
- `bin/preauth.js` — 可执行入口
- `examples/sample.jsonl` — 示例事件流
