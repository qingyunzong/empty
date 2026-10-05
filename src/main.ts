import { verifySolution } from "./certificate.js";
import { sampleCoupons, sampleItems, sampleRules } from "./sample.js";
import { solveCart } from "./solver.js";

const fen = (v: number): string => `¥${(v / 100).toFixed(2)}`;

const solution = solveCart(sampleItems, sampleRules, sampleCoupons);

console.log("=== 最优拆分方案 ===");
solution.orders.forEach((order, i) => {
  const names = order.itemIds
    .map((id) => sampleItems.find((it) => it.id === id)!.name)
    .join("、");
  console.log(
    `订单 ${i + 1} [${order.itemIds.join(", ")}] ${names}\n` +
      `  小计 ${fen(order.subtotal)}  满减 -${fen(order.discount)}` +
      `  券(${order.couponId ?? "无"}) -${fen(order.couponValue)}` +
      `  运费 ${fen(order.shipping)}  实付 ${fen(order.payable)}`,
  );
});
console.log(`总实付 ${fen(solution.totalPay)}，共 ${solution.orderCount} 单`);

console.log("\n=== 券证书 ===");
for (const entry of solution.certificate.entries) {
  console.log(
    entry.usedInOrder === null
      ? `券 ${entry.couponId}: 未使用`
      : `券 ${entry.couponId}: 用于订单 ${entry.usedInOrder + 1}` +
          `（门槛 ${fen(entry.minSpend)}，该单小计 ${fen(entry.orderSubtotal!)}，` +
          `门槛${entry.thresholdMet ? "满足" : "不满足"}）`,
  );
}
console.log(
  `每张券全局限用一次: ${solution.certificate.eachCouponUsedAtMostOnce ? "成立" : "被违反"}`,
);

const violations = verifySolution(sampleItems, sampleRules, sampleCoupons, solution);
console.log(
  `\n独立核验: ${violations.length === 0 ? "通过（拆分合法、逐单金额与券证书一致）" : violations.join("; ")}`,
);
