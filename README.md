# linearizable-payment-history

离线库与 CLI：判定乱序到达的支付退款 / 撤销 / 解冻请求是否存在可线性化历史，
并为每个请求选择提交槽位（replay slot）。仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

## 用法

```bash
node . history input.json output.json
node --test
```

## 输入格式

```json
{
  "orders": [{ "orderId": "o1", "charged": 100 }],
  "requests": [
    { "requestId": "r1", "idempotencyKey": "k1", "type": "REFUND",  "orderId": "o1", "amount": 30, "arrivalSeq": 1 },
    { "requestId": "c1", "idempotencyKey": "k2", "type": "CANCEL",  "orderId": "o1", "arrivalSeq": 2 },
    { "requestId": "u1", "idempotencyKey": "k3", "type": "UNFREEZE","orderId": "o1", "arrivalSeq": 3, "after": ["c1"] }
  ]
}
```

- `type` ∈ `REFUND | CANCEL | UNFREEZE`；`arrivalSeq` 缺省时按数组下标。
- `after` 为可选的显式 happens-before 依赖（按 `requestId` 引用）。
- 未知订单、非法金额（非有限正数）、非法 `charged` 等输入错误：CLI 退出码 1。

## 语义与约束

- 退款不得超过可退余额（`charged - 已退款`）；撤销成功后不得发生新退款；
  解冻只在撤销成功后执行；同幂等键重放同结果（去重后标记 `REPLAY`，复用槽位与结果）。
- 槽位选择：按到达序优先的贪心不动点 —— 每轮提交到达最早且守卫成立的等待请求；
  守卫不满足的请求进入等待队列，约束满足后被重放到下一槽位。
- 判定：
  - `OK`：全部请求已提交；
  - `PENDING`：预算不足或槽位约束未满足（等待中），不视为 UNSAT；
  - `UNSAT`：硬冲突 —— 单笔退款超过原扣款、解冻无对应撤销、或依赖关系成环，
    输出 `conflictCycle`（冲突环）与 `reason`。

## 输出格式

`status`、`commitOrder`（提交序）、`slots`（槽位域）、`requests`（各请求状态：
`COMMITTED / PENDING / REPLAY / REJECTED`）、`orders`（各订单终态）、
`balanceTrajectory`（逐槽位余额轨迹）、`conflictCycle`、`reason`。

## 参考实现

`referenceVerify`（`lib/solver.js`）对 ≤5 个请求的实例枚举全部排列，
验证贪心提交序列是合法线性化且每个槽位选择都被到达序优先规则所强制；
`test/solver.test.js` 中的随机交叉检查覆盖 400+ 实例。
