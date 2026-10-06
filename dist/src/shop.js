/**
 * 购物库：定额券逐商品分摊 + 部分退货退款。
 * 所有金额单位均为“分”，用整数运算保证守恒。
 */
function floorDiv(numerator, denominator) {
    return Math.floor(numerator / denominator);
}
/**
 * 创建订单并依次叠加分摊多张定额券。
 *
 * 分摊规则（每张券独立分摊一次，不重算之前的券）：
 * 1. 按各商品“原价总额”比例向下取分到分；
 * 2. 剩余零头按商品 ID 升序逐个补 1 分；
 * 3. 每件商品累计优惠不得超过其原价总额（不得负价），
 *    超出部分让给仍有可抵扣额度的商品（同样按 ID 顺序）；
 * 4. 券面额超过整单剩余可抵扣额度时，超出部分作废。
 */
export function createOrder(items, coupons) {
    const lines = items.map((item) => ({
        ...item,
        gross: item.unitPrice * item.qty,
        discount: 0,
        refundedQty: 0,
        refundedDiscount: 0,
    }));
    for (const coupon of coupons) {
        if (!Number.isInteger(coupon) || coupon < 0) {
            throw new Error(`券面额必须为非负整数（分）: ${coupon}`);
        }
        allocateCoupon(lines, coupon);
    }
    const paid = lines.reduce((sum, line) => sum + line.gross - line.discount, 0);
    return { lines, paid };
}
function allocateCoupon(lines, coupon) {
    const totalGross = lines.reduce((sum, line) => sum + line.gross, 0);
    if (totalGross === 0)
        return;
    const capacity = (line) => line.gross - line.discount;
    const totalCapacity = lines.reduce((sum, line) => sum + capacity(line), 0);
    // 不得使商品负价：整单实际分摊额不超过剩余可抵扣额度
    const effective = Math.min(coupon, totalCapacity);
    if (effective <= 0)
        return;
    // 按原价比例向下取分，并受单件商品剩余额度约束
    let remaining = effective;
    for (const line of lines) {
        const share = Math.min(floorDiv(effective * line.gross, totalGross), capacity(line));
        line.discount += share;
        remaining -= share;
    }
    // 余分按商品 ID 升序逐个补 1 分，跳过已达额度上限的商品
    const sorted = [...lines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    while (remaining > 0) {
        let progressed = false;
        for (const line of sorted) {
            if (remaining === 0)
                break;
            if (capacity(line) > 0) {
                line.discount += 1;
                remaining -= 1;
                progressed = true;
            }
        }
        if (!progressed)
            break; // 全部商品已达额度上限，剩余券额作废
    }
}
/**
 * 部分退货退款：按原分摊结果退，不重算券。
 *
 * 某商品退 k 件时，扣回的券分摊优惠用“累计向下取分”的差值计算：
 *   floor(discount * (refundedQty + k) / qty) - floor(discount * refundedQty / qty)
 * 这样多次退货扣回的优惠之和精确收敛到原分摊额，保证守恒；
 * 且因 discount <= qty * unitPrice，每次退款金额必为非负。
 */
export function refund(order, itemId, qty) {
    const line = order.lines.find((l) => l.id === itemId);
    if (!line)
        throw new Error(`订单中不存在商品: ${itemId}`);
    if (!Number.isInteger(qty) || qty <= 0)
        throw new Error(`退货数量必须为正整数: ${qty}`);
    if (line.refundedQty + qty > line.qty) {
        throw new Error(`商品 ${itemId} 可退数量不足: 剩 ${line.qty - line.refundedQty}，退 ${qty}`);
    }
    const before = floorDiv(line.discount * line.refundedQty, line.qty);
    line.refundedQty += qty;
    const after = floorDiv(line.discount * line.refundedQty, line.qty);
    const couponRefund = after - before;
    line.refundedDiscount += couponRefund;
    return {
        itemId,
        qty,
        couponRefund,
        totalRefund: qty * line.unitPrice - couponRefund,
    };
}
