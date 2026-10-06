import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrder, refund } from '../src/shop.js';
test('按原价比例分摊并向下取分，余分按商品 ID 升序补齐', () => {
    // A=100, B=200，券 100：A 33、B 66，余 1 分给 ID 较小的 A
    const order = createOrder([
        { id: 'B', unitPrice: 200, qty: 1 },
        { id: 'A', unitPrice: 100, qty: 1 },
    ], [100]);
    const a = order.lines.find((l) => l.id === 'A');
    const b = order.lines.find((l) => l.id === 'B');
    assert.equal(a.discount, 34);
    assert.equal(b.discount, 66);
    assert.equal(order.paid, 300 - 100);
});
test('余分为多分时按商品 ID 顺序逐个分配', () => {
    // 三件各 100，券 100：各 33，余 1 分给 ID 最小的 a1
    const order = createOrder([
        { id: 'a3', unitPrice: 100, qty: 1 },
        { id: 'a1', unitPrice: 100, qty: 1 },
        { id: 'a2', unitPrice: 100, qty: 1 },
    ], [100]);
    const discounts = Object.fromEntries(order.lines.map((l) => [l.id, l.discount]));
    assert.deepEqual(discounts, { a1: 34, a2: 33, a3: 33 });
});
test('券可叠加，但不得使商品负价', () => {
    // 总额 300，两张券 250 + 200：第二张只生效 50
    const order = createOrder([{ id: 'X', unitPrice: 300, qty: 1 }], [250, 200]);
    const x = order.lines[0];
    assert.equal(x.discount, 300);
    assert.equal(order.paid, 0);
    assert.ok(x.gross - x.discount >= 0, '商品不得负价');
});
test('叠券时单件商品分摊受剩余额度约束，溢出让渡给其他商品', () => {
    // A=100, B=100；券1=150 → A 75, B 75；券2=100 → 各剩 25 额度，共生效 50
    const order = createOrder([
        { id: 'A', unitPrice: 100, qty: 1 },
        { id: 'B', unitPrice: 100, qty: 1 },
    ], [150, 100]);
    const total = order.lines.reduce((s, l) => s + l.discount, 0);
    assert.equal(total, 200);
    for (const line of order.lines) {
        assert.ok(line.discount <= line.gross, `${line.id} 优惠不得超过原价`);
    }
    assert.equal(order.paid, 0);
});
test('部分退货按原分摊退，不重算券', () => {
    // A: 100×3=300，券分摊 100 → 退 1 件扣回券 floor(100*1/3)=33，实退 67
    const order = createOrder([{ id: 'A', unitPrice: 100, qty: 3 }], [100]);
    assert.equal(order.paid, 200);
    const r1 = refund(order, 'A', 1);
    assert.equal(r1.couponRefund, 33);
    assert.equal(r1.totalRefund, 67);
    // 再退 1 件仍按原分摊口径，不触发整单重算
    const r2 = refund(order, 'A', 1);
    assert.equal(r2.couponRefund, 33);
    assert.equal(r2.totalRefund, 67);
});
test('多次部分退款守恒：全部退完后退款总额等于实付金额', () => {
    const items = [
        { id: 'A', unitPrice: 333, qty: 3 },
        { id: 'B', unitPrice: 777, qty: 2 },
        { id: 'C', unitPrice: 100, qty: 5 },
    ];
    const coupons = [1000, 500, 250];
    const order = createOrder(items, coupons);
    const totalDiscount = order.lines.reduce((s, l) => s + l.discount, 0);
    const totalGross = order.lines.reduce((s, l) => s + l.gross, 0);
    assert.equal(order.paid, totalGross - totalDiscount);
    // 逐批、乱序退完全部商品
    let refundedTotal = 0;
    let refundedCoupon = 0;
    const plan = [
        ['B', 1], ['A', 1], ['C', 2], ['A', 2], ['C', 3], ['B', 1],
    ];
    for (const [id, qty] of plan) {
        const r = refund(order, id, qty);
        refundedTotal += r.totalRefund;
        refundedCoupon += r.couponRefund;
        assert.ok(r.totalRefund >= 0, '单次退款金额不得为负');
    }
    // 守恒 1：扣回的券分摊之和 == 原分摊总额
    assert.equal(refundedCoupon, totalDiscount);
    // 守恒 2：退给用户的总额 == 用户实付
    assert.equal(refundedTotal, order.paid);
    // 守恒 3：退款 + 扣回优惠 == 商品原价总额
    assert.equal(refundedTotal + refundedCoupon, totalGross);
    // 每条线退清
    for (const line of order.lines) {
        assert.equal(line.refundedQty, line.qty);
        assert.equal(line.refundedDiscount, line.discount);
    }
});
test('同一商品多次零星退货，券退款累计精确等于原分摊', () => {
    // 101 件、单价 100，分摊 100：逐件退 101 次，扣回券累计必须恰好 100
    const order = createOrder([{ id: 'A', unitPrice: 100, qty: 101 }], [100]);
    let couponSum = 0;
    let refundSum = 0;
    for (let i = 0; i < 101; i++) {
        const r = refund(order, 'A', 1);
        couponSum += r.couponRefund;
        refundSum += r.totalRefund;
    }
    assert.equal(couponSum, 100);
    assert.equal(refundSum, order.paid);
});
test('退货数量校验', () => {
    const order = createOrder([{ id: 'A', unitPrice: 100, qty: 2 }], [50]);
    assert.throws(() => refund(order, 'A', 3), /可退数量不足/);
    assert.throws(() => refund(order, 'A', 0), /正整数/);
    assert.throws(() => refund(order, 'ZZZ', 1), /不存在商品/);
    refund(order, 'A', 2);
    assert.throws(() => refund(order, 'A', 1), /可退数量不足/);
});
test('非法券面额报错', () => {
    assert.throws(() => createOrder([{ id: 'A', unitPrice: 100, qty: 1 }], [-1]));
    assert.throws(() => createOrder([{ id: 'A', unitPrice: 100, qty: 1 }], [1.5]));
});
