import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { Cart } from "../src/cart";

describe("定额券按原价比例分摊", () => {
  test("整除时严格按比例", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 100, quantity: 1 })
      .addItem({ id: "b", unitPrice: 200, quantity: 1 })
      .addItem({ id: "c", unitPrice: 300, quantity: 1 })
      .addCoupon({ id: "coupon-1", amount: 60 });
    const allocs = cart.allocations();
    assert.deepEqual(
      allocs.map((a) => [a.id, a.couponDiscount]),
      [["a", 10], ["b", 20], ["c", 30]],
    );
    assert.equal(cart.totalPayable(), 600 - 60);
  });

  test("向下取分，余分按商品 ID 升序补 1 分", () => {
    // 三个同价商品分 100 分：各 floor(100/3)=33，余 1 分给 ID 最小的 "a"。
    const cart = new Cart()
      .addItem({ id: "c", unitPrice: 100, quantity: 1 })
      .addItem({ id: "a", unitPrice: 100, quantity: 1 })
      .addItem({ id: "b", unitPrice: 100, quantity: 1 })
      .addCoupon({ id: "coupon-1", amount: 100 });
    const allocs = cart.allocations();
    assert.deepEqual(
      allocs.map((a) => [a.id, a.couponDiscount]),
      [["a", 34], ["b", 33], ["c", 33]],
    );
    assert.equal(cart.totalDiscount(), 100);
  });

  test("按原价总额（单价×数量）加权", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 100, quantity: 3 }) // 300
      .addItem({ id: "b", unitPrice: 50, quantity: 2 }) // 100
      .addCoupon({ id: "coupon-1", amount: 41 });
    // 权重 3:1，a 分 floor(41*3/4)=30，b 分 floor(41/4)=10，余 1 分给 "a"。
    assert.equal(cart.allocationOf("a").couponDiscount, 31);
    assert.equal(cart.allocationOf("b").couponDiscount, 10);
    assert.equal(cart.totalDiscount(), 41);
  });

  test("分摊总额恒等于券面额（券额不超过总价时）", () => {
    const cart = new Cart()
      .addItem({ id: "x", unitPrice: 333, quantity: 1 })
      .addItem({ id: "y", unitPrice: 333, quantity: 1 })
      .addItem({ id: "z", unitPrice: 334, quantity: 1 })
      .addCoupon({ id: "coupon-1", amount: 777 });
    assert.equal(cart.totalDiscount(), 777);
    assert.equal(cart.totalPayable(), 1000 - 777);
  });
});

describe("券叠加与负价保护", () => {
  test("多张券按顺序叠加，各自按比例分摊", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 100, quantity: 1 })
      .addItem({ id: "b", unitPrice: 300, quantity: 1 })
      .addCoupon({ id: "c1", amount: 40 })
      .addCoupon({ id: "c2", amount: 80 });
    // c1: a=10, b=30；c2: a=20, b=60。
    assert.equal(cart.allocationOf("a").couponDiscount, 30);
    assert.equal(cart.allocationOf("b").couponDiscount, 90);
    assert.equal(cart.totalDiscount(), 120);
  });

  test("券面额超过整单剩余应付时按总额封顶，应付为 0 不为负", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 500, quantity: 1 })
      .addItem({ id: "b", unitPrice: 300, quantity: 1 })
      .addCoupon({ id: "big", amount: 99999 });
    assert.equal(cart.totalDiscount(), 800);
    assert.equal(cart.totalPayable(), 0);
    for (const a of cart.allocations()) {
      assert.ok(a.payable >= 0, `${a.id} 应付不得为负`);
    }
  });

  test("叠券总额超过总价：整单付清，分摊不超原价", () => {
    // c1 分 150（各 75），c2 面额 100 但整单仅剩 50，封顶后各分 25。
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 100, quantity: 1 })
      .addItem({ id: "b", unitPrice: 100, quantity: 1 })
      .addCoupon({ id: "c1", amount: 150 })
      .addCoupon({ id: "c2", amount: 100 });
    assert.equal(cart.allocationOf("a").couponDiscount, 100);
    assert.equal(cart.allocationOf("b").couponDiscount, 100);
    assert.equal(cart.allocationOf("a").payable, 0);
    assert.equal(cart.allocationOf("b").payable, 0);
    assert.equal(cart.totalDiscount(), 200);
  });

  test("余分跳过已分满的商品，补给仍有应付的商品", () => {
    // c1：a 比例份额 floor(100*1/101)=0、余分 1 补满 a；b 分 99。
    // c2 面额 2 但整单仅剩 b 的 1 分应付，封顶为 1，余分跳过 a 补给 b。
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 1, quantity: 1 })
      .addItem({ id: "b", unitPrice: 100, quantity: 1 })
      .addCoupon({ id: "c1", amount: 100 })
      .addCoupon({ id: "c2", amount: 2 });
    assert.equal(cart.allocationOf("a").couponDiscount, 1);
    assert.equal(cart.allocationOf("b").couponDiscount, 100);
    assert.equal(cart.totalPayable(), 0);
    assert.equal(cart.totalDiscount(), 101);
  });

  test("叠券后部分商品付清、部分仍有应付", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 100, quantity: 1 })
      .addItem({ id: "b", unitPrice: 900, quantity: 1 })
      .addCoupon({ id: "c1", amount: 100 })
      .addCoupon({ id: "c2", amount: 150 });
    // c1: a=10, b=90；c2: a 应分 15 但仅剩 90 -> 15 未超，实际 a=15, b=135。
    assert.equal(cart.allocationOf("a").couponDiscount, 25);
    assert.equal(cart.allocationOf("b").couponDiscount, 225);
    assert.equal(cart.totalPayable(), 1000 - 250);
  });
});

describe("部分退货退款", () => {
  test("按原分摊退款，退款额按应付比例计算", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 100, quantity: 3 })
      .addCoupon({ id: "c1", amount: 50 });
    // 应付 250，退 1 件得 floor(250/3)=83。
    assert.equal(cart.refund("a", 1), 83);
    assert.equal(cart.totalRefunded(), 83);
  });

  test("多次退款守恒：分批退完，退款合计恰好等于应付总额", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 100, quantity: 3 })
      .addCoupon({ id: "c1", amount: 50 });
    // 应付 250，逐件退：83 + 83 + 84 = 250。
    const r1 = cart.refund("a", 1);
    const r2 = cart.refund("a", 1);
    const r3 = cart.refund("a", 1);
    assert.equal(r1 + r2 + r3, 250);
    assert.equal(cart.totalRefunded(), 250);
  });

  test("退货不重算券：分摊结果在退货后保持不变", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 100, quantity: 2 })
      .addItem({ id: "b", unitPrice: 100, quantity: 2 })
      .addCoupon({ id: "c1", amount: 100 });
    const before = cart.allocations().map((a) => [a.id, a.couponDiscount]);
    cart.refund("a", 1);
    const after = cart.allocations().map((a) => [a.id, a.couponDiscount]);
    assert.deepEqual(after, before);
  });

  test("退款与退货数量无关次序：任意分批序列合计相同", () => {
    const make = () =>
      new Cart()
        .addItem({ id: "a", unitPrice: 199, quantity: 5 })
        .addCoupon({ id: "c1", amount: 137 });
    // 应付 = 995 - 137 = 858。
    const seqs = [[1, 1, 1, 1, 1], [2, 3], [5], [1, 2, 2], [4, 1]];
    for (const seq of seqs) {
      const cart = make();
      let sum = 0;
      for (const q of seq) sum += cart.refund("a", q);
      assert.equal(sum, 858, `分批 ${seq} 退款守恒`);
    }
  });

  test("多商品多券混合退款守恒", () => {
    const cart = new Cart()
      .addItem({ id: "a", unitPrice: 333, quantity: 4 })
      .addItem({ id: "b", unitPrice: 257, quantity: 3 })
      .addItem({ id: "c", unitPrice: 100, quantity: 7 })
      .addCoupon({ id: "c1", amount: 555 })
      .addCoupon({ id: "c2", amount: 321 });
    const expected = cart.totalPayable();
    // 随机交错分批退完全部商品。
    let sum = 0;
    sum += cart.refund("a", 1);
    sum += cart.refund("b", 2);
    sum += cart.refund("c", 3);
    sum += cart.refund("a", 3);
    sum += cart.refund("c", 4);
    sum += cart.refund("b", 1);
    assert.equal(sum, expected);
    assert.equal(cart.totalRefunded(), expected);
    // 每个商品退款合计 == 应付。
    for (const a of cart.allocations()) {
      assert.equal(cart.refundedAmountOf(a.id), a.payable);
    }
  });

  test("超额退货抛错", () => {
    const cart = new Cart().addItem({ id: "a", unitPrice: 100, quantity: 2 });
    cart.refund("a", 2);
    assert.throws(() => cart.refund("a", 1), /超出可退数量/);
  });

  test("零元商品不参与分摊也不影响守恒", () => {
    const cart = new Cart()
      .addItem({ id: "free", unitPrice: 0, quantity: 2 })
      .addItem({ id: "a", unitPrice: 300, quantity: 1 })
      .addCoupon({ id: "c1", amount: 100 });
    assert.equal(cart.allocationOf("free").couponDiscount, 0);
    assert.equal(cart.allocationOf("a").couponDiscount, 100);
    assert.equal(cart.refund("free", 2), 0);
    assert.equal(cart.refund("a", 1), 200);
    assert.equal(cart.totalRefunded(), cart.totalPayable());
  });
});

describe("随机化守恒性质", () => {
  test("任意商品/券/退款序列下：分摊<=原价、退款合计==应付", () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const cart = new Cart();
      const itemCount = 1 + rand(5);
      const ids: string[] = [];
      for (let i = 0; i < itemCount; i++) {
        const id = `item-${i}`;
        ids.push(id);
        cart.addItem({ id, unitPrice: rand(1000), quantity: 1 + rand(5) });
      }
      const couponCount = rand(4);
      for (let i = 0; i < couponCount; i++) {
        cart.addCoupon({ id: `coupon-${i}`, amount: rand(3000) });
      }
      // 不变量：每个商品 0 <= 分摊 <= 原价总额。
      for (const a of cart.allocations()) {
        assert.ok(a.couponDiscount >= 0);
        assert.ok(a.couponDiscount <= a.originalTotal);
        assert.ok(a.payable >= 0);
      }
      // 随机顺序分批退完，退款合计 == 应付。
      const expected = cart.totalPayable();
      let sum = 0;
      for (const id of ids) {
        let left = cart.allocationOf(id).quantity;
        while (left > 0) {
          const q = 1 + rand(left);
          sum += cart.refund(id, q);
          left -= q;
        }
      }
      assert.equal(sum, expected, `第 ${round} 轮退款不守恒`);
    }
  });
});
