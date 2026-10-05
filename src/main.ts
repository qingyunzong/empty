import { readFileSync } from "node:fs";
import { solve, computeDp, computeReachableForward } from "./solver.js";
import { solveBruteForce, BRUTEFORCE_MAX_BILLS } from "./bruteforce.js";
import { buildCertificate, verifyCertificate, formatCertificate } from "./certificate.js";
import type { ClearingInput } from "./types.js";

function readInput(): ClearingInput {
  const arg = process.argv[2];
  const text = arg && arg !== "-" ? readFileSync(arg, "utf8") : readFileSync(0, "utf8");
  return JSON.parse(text) as ClearingInput;
}

const input = readInput();
const result = solve(input);
const cert = buildCertificate(input, result.paidOrder, result.refused);

console.log(formatCertificate(input, result, cert));
console.log("");
console.log("=== 验证 ===");

const certErrors = verifyCertificate(input, result, cert);
console.log(`证书自洽性: ${certErrors.length === 0 ? "通过" : "失败"}`);
for (const e of certErrors) console.log(`  ✗ ${e}`);

// 交叉验证 1：正向 DP（从空集逐步加票据）与逆推 DP 的可行子集集合必须完全一致。
const dp = computeDp(input);
const reach = computeReachableForward(input);
let subsetMismatch = 0;
for (let s = 0; s < dp.model.size; s++) {
  if (dp.feasible[s] !== reach[s]) subsetMismatch++;
}
console.log(
  `子集穷举交叉验证（正向 vs 逆推，共 ${dp.model.size} 个子集）: ${
    subsetMismatch === 0 ? "一致" : `不一致（${subsetMismatch} 处）`
  }`,
);

// 交叉验证 2：n ≤ 8 时与全排列暴力枚举对比最小罚费。
if (input.bills.length <= BRUTEFORCE_MAX_BILLS) {
  const bf = solveBruteForce(input);
  const ok = bf.minPenalty === result.minPenalty;
  console.log(
    `顺序穷举验证（枚举 ${bf.permutationsChecked} 个合法排列）: 暴力最小罚费 ${bf.minPenalty}，` +
      `DP 最小罚费 ${result.minPenalty} → ${ok ? "一致" : "不一致"}`,
  );
} else {
  console.log(`顺序穷举验证: n=${input.bills.length} > ${BRUTEFORCE_MAX_BILLS}，跳过全排列枚举`);
}

if (certErrors.length > 0 || subsetMismatch > 0) process.exitCode = 1;
