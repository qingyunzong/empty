import { mainProblem } from "./problem";
import { solve, verifyCertificate } from "./solver";

function fen(n: number): string {
  return `¥${(n / 100).toFixed(2)}`;
}

const p = mainProblem;
const t0 = process.hrtime.bigint();
const sol = solve(p);
const t1 = process.hrtime.bigint();
verifyCertificate(p, sol.certificate);

console.log(`商品 ${p.items.length} 件，券 ${p.coupons.length} 张`);
console.log(`求解耗时 ${Number(t1 - t0) / 1e6} ms`);
console.log("");
sol.orders.forEach((o, i) => {
  const names = o.itemIdx
    .map((idx) => `${p.items[idx].id} ${p.items[idx].name}`)
    .join("、");
  console.log(`订单 ${i + 1}（${o.itemIdx.length} 件）: ${names}`);
  console.log(
    `  商品金额 ${fen(o.subtotal)}，门槛档 ${o.tierPct}% 减 ${fen(o.discount)}，` +
      `券 ${o.couponId ?? "无"} 抵 ${fen(o.couponValue)}，运费 ${fen(o.shipping)}，` +
      `本单实付 ${fen(o.payable)}`
  );
});
console.log("");
console.log(`总实付 ${fen(sol.totalPayable)}，共 ${sol.orderCount} 单`);
console.log("");
console.log("券使用证书:");
console.log(JSON.stringify(sol.certificate.couponUsage, null, 2));
console.log("");
console.log("完整证书:");
console.log(JSON.stringify(sol.certificate, null, 2));
