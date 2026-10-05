import type { CartRules, Coupon, Item } from "./types.js";

/** 演示用购物车：14 件商品（分）。 */
export const sampleItems: Item[] = [
  { id: "A01", name: "机械键盘", price: 12900 },
  { id: "A02", name: "无线鼠标", price: 4900 },
  { id: "A03", name: "鼠标垫", price: 1900 },
  { id: "A04", name: "USB 集线器", price: 3900 },
  { id: "A05", name: "显示器支架", price: 8900 },
  { id: "A06", name: "数据线", price: 1200 },
  { id: "A07", name: "耳机", price: 15900 },
  { id: "A08", name: "收纳包", price: 2500 },
  { id: "A09", name: "清洁套装", price: 1500 },
  { id: "A10", name: "笔记本支架", price: 6900 },
  { id: "A11", name: "台灯", price: 5900 },
  { id: "A12", name: "插线板", price: 3300 },
  { id: "A13", name: "理线器", price: 900 },
  { id: "A14", name: "屏幕挂灯", price: 7900 },
];

/** 满减：每满 100 元减 15 元，单笔订单封顶 45 元（逐单向下取整）。 */
export const sampleRules: CartRules = {
  discount: { step: 10000, off: 1500, cap: 4500 },
  shipping: { fee: 800, freeAbove: 9900 }, // 折后满 99 元包邮，否则 8 元
};

/** 三张券：全局限用一次，每单限用一张。 */
export const sampleCoupons: Coupon[] = [
  { id: "C-3000", minSpend: 15000, value: 3000 }, // 满 150 减 30
  { id: "C-1200", minSpend: 8000, value: 1200 },  // 满 80 减 12
  { id: "C-0500", minSpend: 0, value: 500 },      // 无门槛 5 元
];
