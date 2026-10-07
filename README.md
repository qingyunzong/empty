# coupon-cart

购物车定额券分摊与部分退货退款库（TypeScript，金额一律用整数“分”）。

## 规则

- **分摊**：定额券按商品原价总额（单价 × 数量）比例分摊到每个商品，向下取分到分；
  余分按商品 ID 升序逐个补 1 分，直到分完。
- **叠加**：券按添加顺序逐张分摊；单张券先按整单剩余应付封顶，分摊以各商品原价为上限
  （不得负价），截断部分在其余商品间继续按比例重分摊。
- **退货**：部分退货按原分摊结果退款，不重算券。第 k 件退款额按
  `floor(应付总额 × 已退累计 / 购买数量)` 的增量计算，保证任意分批、任意次序的
  多次退款之和恰好等于应付总额（守恒）。

## 用法

```ts
import { Cart } from "./src/cart";

const cart = new Cart()
  .addItem({ id: "a", unitPrice: 100, quantity: 3 }) // 单位：分
  .addItem({ id: "b", unitPrice: 200, quantity: 1 })
  .addCoupon({ id: "c1", amount: 50 })
  .addCoupon({ id: "c2", amount: 30 });

cart.allocations();   // 各商品分摊明细（原价/券额/应付）
cart.totalPayable();  // 全单应付
cart.refund("a", 1);  // 退 1 件 a，返回退款额（分）
cart.totalRefunded(); // 累计已退款
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```
