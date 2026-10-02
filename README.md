# splitpay

多渠道收款分账库与 CLI（Node.js 22，仅标准库，测试使用 node:test）。

## 模型

- 一笔收款（paymentId）由三个分支汇合：`card`（银行卡）、`coupon`（券）、`points`（积分），分支金额可为 0，单位为分（非负整数）。
- 三个分支全部成功后汇合，按固定规则拆分为商户款 94%、手续费 4%、税 2%：先按比例向下取整，余数按金额降序每次补 1 分（并列按规则顺序）。
- 任一分支失败或返回金额与 `order_created` 声明不符：所有已成功分支生成补偿（反向）记录，订单置为 `FAILED`；迟到的成功通知也会立即补偿。
- 同一 `paymentId + branchId` 的重复通知幂等（内容一致的重复为 no-op，冲突的重复报 `DUPLICATE_CONFLICT`）。
- 事件追加写入 `<workdir>/events.log`（JSONL），重启后重放日志恢复状态，可继续汇合或补偿，不会重复分账。

## CLI

```sh
node src/cli.js --event '<json>' --workdir <dir>
node src/cli.js event.json <dir>        # 位置参数 / 事件文件
node src/cli.js --event @event.json -w <dir>
```

事件示例：

```json
{"type":"order_created","paymentId":"p1","expected":{"card":100,"coupon":0,"points":55}}
{"type":"branch_result","paymentId":"p1","branchId":"card","status":"success","amount":100}
{"type":"branch_result","paymentId":"p1","branchId":"coupon","status":"failed"}
```

成功时向 stdout 输出 JSON 证书（状态、各分支状态、分账结果、补偿记录）。
出错时退出码为 1，输出体为 `{"error":"CODE","message":"..."}`，
错误码包括 `INVALID_EVENT`、`INVALID_BRANCH`、`INVALID_AMOUNT`、`INVALID_WORKDIR`、
`DUPLICATE_CONFLICT`、`PAYMENT_COMPLETED`、`PAYMENT_NOT_FOUND`。

## 测试

```sh
node --test
```

测试包含：分支成功/失败掩码枚举器（8 种组合）、不超过 5 元（500 分）的整数分账
穷举并校验总额守恒与余数可复算、分支金额组合穷举（0..10 分）、幂等、
崩溃重启恢复、零金额分支与负数金额边界、CLI 契约。
