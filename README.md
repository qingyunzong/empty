# refund-ledger

订单退款库与 CLI。Node.js 22，仅使用标准库与 `node:test`，无第三方依赖。

## 模型

- 已成交支付由三部分组成：商户款 `merchant`、平台佣金 `commission`、税 `tax`（均为非负整数，如分）。
- 部分退款按三部分原占比拆分，余数用最大余额法分配（同余数按 merchant > commission > tax 固定次序）。
  拆分按**累计退款额**计算再取差值，保证任意笔数部分退款累计后各部分金额始终等于累计额的整体拆分。
- 累计退款（冻结中 + 已登记 − 已补偿）不得超过原支付总额，否则报 `REFUND_EXCEEDED` 且不改账。
- 退款生命周期：`requestRefund` 先冻结（`refund_frozen`），`registerRefund` 登记反向分录（`refund_posted`）；
  登记前 `cancelRefund` 只释放冻结（`refund_released`），登记后取消产生补偿冲回（`refund_compensated`）。
- 重复 `refundId` 返回首次结果，不产生新记录（幂等）。

## 库

```js
import { RefundService, splitAmount } from './src/refund.js';
const service = new RefundService({ appendEvent: (e) => store.append(e) });
service.settlePayment({ paymentId: 'p1', merchant: 70, commission: 20, tax: 10 });
service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 50 }); // -> split {35,10,5}, status frozen
service.registerRefund('r1');   // -> posted
service.cancelRefund('r1');     // posted 后取消 -> compensated（补偿冲回）
service.getBalance('p1');       // available / frozen / posted / compensated
RefundService.fromEvents(events); // 从 JSONL 事件重放恢复状态
```

## CLI

```
node cli.js [--store history.jsonl] <settle|refund|register|cancel|balance|history> [json-payload]
```

- 输入输出均为 JSON；payload 可省略并从 stdin 读取。
- 历史以 JSONL 追加存储（默认 `history.jsonl`，可用 `--store` 或 `REFUND_STORE` 指定）。
- 成功输出 `{"ok":true,"result":...}`，退出码 0；
  失败输出 `{"error":{"code":...,"message":...}}`，退出码 1。
- 错误码：`REFUND_EXCEEDED`、`PAYMENT_NOT_FOUND`、`REFUND_NOT_FOUND`、`INVALID_STATE`、
  `INVALID_AMOUNT`、`INVALID_INPUT`、`INVALID_JSON`、`UNKNOWN_COMMAND`、`DUPLICATE_PAYMENT`。

## 测试

```
node --test
```

- `test/refund.test.js`：累计拆分、幂等/重放、超额、登记前后取消等验收。
- `test/enumerator.test.js`：独立枚举器——原总额 ≤ 20、3 笔候选退款枚举全部子集，
  独立计算累计拆分与边界（含恰好全额与超额 1 的边界），与库状态逐一比对。
- `test/cli.test.js`：CLI 全生命周期、JSONL 历史、错误退出码。
