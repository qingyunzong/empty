import { readFileSync } from "node:fs";
import { solve, solveExhaustive, validatePlan, type Plan, type Plugin } from "./planner.js";

interface Problem {
  initial: string[];
  targets: string[];
  plugins: Plugin[];
}

/** 内置示例：含一对循环依赖插件（无起始能力支撑，不可启动）与两条成本不同的路径。 */
const demo: Problem = {
  initial: ["power"],
  targets: ["serve-http"],
  plugins: [
    { id: "os", requires: ["power"], provides: ["kernel"], cost: 2 },
    { id: "runtime", requires: ["kernel"], provides: ["jit"], cost: 3 },
    { id: "web-server", requires: ["jit", "tls"], provides: ["serve-http"], cost: 4 },
    { id: "cert-authority", requires: ["kernel"], provides: ["tls"], cost: 5 },
    { id: "self-signed-tls", requires: ["kernel"], provides: ["tls"], cost: 1 },
    // 循环依赖：互相等待对方提供的能力，起始能力无法打破，永远不可启用。
    { id: "cycle-a", requires: ["cap-b"], provides: ["cap-a", "tls"], cost: 0 },
    { id: "cycle-b", requires: ["cap-a"], provides: ["cap-b", "jit"], cost: 0 },
    // 自供能力：requires 与 provides 相同，无法靠自身启动。
    { id: "self-boot", requires: ["self-cap"], provides: ["self-cap", "tls"], cost: 0 },
  ],
};

function loadProblem(): Problem {
  const file = process.argv[2];
  if (!file) return demo;
  return JSON.parse(readFileSync(file, "utf8")) as Problem;
}

function printPlan(plan: Plan): void {
  if (!plan.feasible) {
    console.log("目标不可达：不存在合法启用序列。");
    return;
  }
  console.log(`最低总成本: ${plan.totalCost}`);
  console.log("启用序列（每步已具能力）:");
  plan.steps.forEach((step, i) => {
    console.log(`  ${i + 1}. 启用 ${step.plugin} (成本 ${step.cost})`);
    console.log(`     已具能力: [${step.capabilities.join(", ")}]`);
  });
}

const problem = loadProblem();
console.log(`起始能力: [${problem.initial.join(", ")}]`);
console.log(`目标能力: [${problem.targets.join(", ")}]`);
console.log(`插件数量: ${problem.plugins.length}`);

const plan = solve(problem.initial, problem.plugins, problem.targets);
printPlan(plan);

if (plan.feasible) {
  validatePlan(problem.initial, problem.plugins, problem.targets, plan);
  console.log("逐步重放校验: 通过");
}

const exhaustive = solveExhaustive(problem.initial, problem.plugins, problem.targets);
console.log(
  `穷举核对: 枚举 ${exhaustive.statesExplored} 个状态, 最低成本 ${exhaustive.minCost}` +
    ` (最优状态 ${exhaustive.optimalStates} 个), ` +
    (exhaustive.minCost === plan.totalCost ? "与主求解器一致" : "与主求解器不一致!"),
);
if (exhaustive.minCost !== plan.totalCost) process.exitCode = 1;
