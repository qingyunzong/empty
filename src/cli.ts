import { readFileSync, writeFileSync } from "node:fs";
import { Solver, Checkpoint } from "./solver.js";
import { verifyCertificates } from "./certificate.js";
import { Problem, Solution } from "./types.js";

const USAGE = `用法：
  node dist/src/cli.js solve <problem.json> [--steps N] [--save cp.json]
  node dist/src/cli.js resume <cp.json> [--steps N] [--save cp.json]

  solve   从头求解；--steps 限制步数（用于暂停），--save 写出检查点
  resume  从检查点恢复继续求解；暂停后恢复的最终结果与不暂停完全一致
`;

function printResult(sol: Solution | null, nodes: number, problem: Problem): void {
  if (!sol) {
    console.log("无可行解（约束排除了全部分配，包括全部不服务）");
    return;
  }
  console.log(`搜索节点数: ${nodes}`);
  console.log(`分配向量: [${sol.assign.join(", ")}]`);
  console.log(`总收益: ${sol.profit} (档位 ${sol.baseProfit} + 组合 ${sol.comboProfit})`);
  console.log(`资源用量: r1=${sol.used1}/${problem.budget1}, r2=${sol.used2}/${problem.budget2}`);
  console.log(`最高档用户数: ${sol.highCount}`);
  const v = verifyCertificates(problem, sol);
  console.log(`约束证书（逐条）: 总体${v.ok ? "通过" : "失败"}`);
  for (const c of v.certs) console.log(`  [${c.ok ? "OK" : "FAIL"}] ${c.id}: ${c.detail}`);
}

function main(argv: string[]): void {
  const [cmd, file, ...rest] = argv;
  if ((cmd !== "solve" && cmd !== "resume") || !file) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  let steps = Infinity;
  let savePath: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--steps") steps = Number(rest[++i]);
    else if (rest[i] === "--save") savePath = rest[++i];
    else { console.error(`未知参数 ${rest[i]}\n${USAGE}`); process.exitCode = 1; return; }
  }
  const data = JSON.parse(readFileSync(file, "utf8"));
  const solver = cmd === "solve"
    ? new Solver(data as Problem)
    : Solver.fromCheckpoint(data as Checkpoint);
  const finished = solver.run(steps);
  if (savePath) {
    writeFileSync(savePath, JSON.stringify(solver.checkpoint(), null, 2));
    console.log(`检查点已保存到 ${savePath}（已处理 ${solver.nodeCount} 个节点）`);
  }
  if (finished) {
    const problem: Problem = cmd === "solve" ? (data as Problem) : (data as Checkpoint).problem;
    printResult(solver.result(), solver.nodeCount, problem);
  } else {
    console.log(`未完成的暂停：已处理 ${solver.nodeCount} 个节点，可用 resume 继续`);
  }
}

main(process.argv.slice(2));
