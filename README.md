# 购物库：定额券分摊与部分退货

金额一律以“分”为单位的整数运算，保证守恒。

## 规则

- **分摊**：每张定额券按各商品原价总额比例向下取分到分；余分按商品 ID 升序逐个补 1 分。
- **叠券**：券可叠加，但每件商品累计优惠不得超过其原价总额（不得负价）；超出部分让渡给仍有可抵扣额度的商品，整单额度不足时券额超出部分作废。
- **退货**：部分退货按原分摊结果退，不重算券。退 k 件时扣回的券分摊用累计向下取分差值计算：
  `floor(discount * (refundedQty + k) / qty) - floor(discount * refundedQty / qty)`，
  多次退货的扣回之和精确收敛到原分摊额，退款总额精确等于实付金额。

## 使用

```bash
npm test        # 编译并运行测试
npm run typecheck
```

```ts
import { createOrder, refund } from './src/shop.js';

const order = createOrder(
  [{ id: 'A', unitPrice: 100, qty: 3 }],
  [100],          // 定额券面额（分），可传多张叠加
);
refund(order, 'A', 1); // { couponRefund: 33, totalRefund: 67, ... }
```
