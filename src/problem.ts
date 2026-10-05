// 问题定义与主算例数据。金额单位：分（整数，避免浮点误差）。

export interface Item {
  id: string;
  name: string;
  price: number; // 单价（分）
}

// 金额门槛优惠：单笔订单商品金额满 threshold（分）减 pct%，
// 每单取可满足的最高档位；折扣额 = floor(subtotal * pct / 100)，逐单向下取整。
export interface Tier {
  threshold: number;
  pct: number;
}

// 运费：折后金额（券前）满 freeThreshold 免运费，否则每单收 fee。
export interface Shipping {
  freeThreshold: number;
  fee: number;
}

// 券：订单商品金额满 threshold 可抵 value；每张券全局（跨所有订单）限用一次；
// 每单至多用一张券；券后金额不为负。
export interface Coupon {
  id: string;
  threshold: number;
  value: number;
}

export interface Problem {
  items: Item[];
  tiers: Tier[];
  shipping: Shipping;
  coupons: Coupon[];
}

// 主算例：14 件商品。
export const mainProblem: Problem = {
  items: [
    { id: "P01", name: "机械键盘", price: 12900 },
    { id: "P02", name: "鼠标", price: 4900 },
    { id: "P03", name: "降噪耳机", price: 19900 },
    { id: "P04", name: "数据线", price: 1900 },
    { id: "P05", name: "手机壳", price: 2900 },
    { id: "P06", name: "充电宝", price: 7900 },
    { id: "P07", name: "笔记本支架", price: 3900 },
    { id: "P08", name: "鼠标垫", price: 1500 },
    { id: "P09", name: "扩展坞", price: 15900 },
    { id: "P10", name: "蓝牙音箱", price: 9900 },
    { id: "P11", name: "摄像头", price: 6900 },
    { id: "P12", name: "键盘膜", price: 900 },
    { id: "P13", name: "收纳包", price: 2500 },
    { id: "P14", name: "清洁套装", price: 1200 },
  ],
  tiers: [
    { threshold: 30000, pct: 20 },
    { threshold: 20000, pct: 12 },
    { threshold: 10000, pct: 5 },
  ],
  shipping: { freeThreshold: 9900, fee: 800 },
  coupons: [
    { id: "A", threshold: 15000, value: 3000 },
    { id: "B", threshold: 8000, value: 1000 },
    { id: "C", threshold: 0, value: 500 },
  ],
};
