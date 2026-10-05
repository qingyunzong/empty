import { problem } from "./data";
import { solve } from "./solver";
import { bruteForceMinCost, verifyByRelaxation } from "./bruteforce";
import { formatPlan } from "./format";

function main(): void {
  console.log("=== 插件规划：启用目标的最低成本序列 ===");
  console.log(`plugins: ${problem.plugins.length} (max 18)`);
  console.log(`initial: { ${problem.initial.join(", ")} }`);
  console.log(`target:  { ${problem.target.join(", ")} }`);
  console.log("");

  const plan = solve(problem);
  if (!plan) {
    console.log("无可行方案：目标能力无法从初始能力出发达成。");
    process.exitCode = 1;
    return;
  }
  console.log("--- 最优启用序列（Dijkstra 状态搜索） ---");
  console.log(formatPlan(plan));
  console.log("");

  console.log("--- 穷举核对 ---");
  const bf = bruteForceMinCost(problem);
  const relax = verifyByRelaxation(problem);
  console.log(`Dijkstra 最优成本:        ${plan.totalCost}`);
  console.log(`子集穷举 (2^n) 最优成本:  ${bf ? bf.cost : "不可行"}`);
  console.log(`全状态松弛最优成本:       ${relax === null ? "不可行" : relax}`);

  const ok = bf !== null && relax !== null && bf.cost === plan.totalCost && relax === plan.totalCost;
  console.log(ok ? "核对结果：三种方法一致 ✔" : "核对结果：不一致 ✘");
  if (!ok) process.exitCode = 1;
}

main();
