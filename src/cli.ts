import { readFileSync } from "node:fs";
import { solve, checkSchedule } from "./solver.js";
import { bruteMakespan } from "./brute.js";
import type { Instance, Solution, WorkerId } from "./types.js";

const WORKER_NAME: Record<WorkerId, string> = { 0: "工人A", 1: "工人B" };

function loadInstance(arg: string | undefined): Instance {
  if (!arg || arg === "--demo") {
    return JSON.parse(readFileSync(new URL("../../examples/demo.json", import.meta.url).pathname, "utf8")) as Instance;
  }
  return JSON.parse(readFileSync(arg, "utf8")) as Instance;
}

function lane(sol: Solution, w: WorkerId, makespan: number): string {
  const es = sol.entries
    .filter((e) => e.workers.includes(w))
    .sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const e of es) {
    if (e.start > cursor) parts.push(`${cursor}-${e.start} 空闲`);
    parts.push(`${e.start}-${e.end} ${e.taskId}`);
    cursor = e.end;
  }
  if (cursor < makespan) parts.push(`${cursor}-${makespan} 空闲`);
  return parts.join(" | ");
}

function printSolution(sol: Solution): void {
  console.log(`最短总工期 makespan = ${sol.makespan}`);
  console.log("");
  console.log("时间轴（按开始时间）：");
  for (const e of sol.entries) {
    const who =
      e.workers.length === 2 ? "工人A+工人B(同步)" : WORKER_NAME[e.workers[0]!];
    const start = String(e.start).padStart(2);
    const end = String(e.end).padStart(2);
    console.log(`  [${start} - ${end}]  ${e.taskId.padEnd(12)} ${who}`);
  }
  console.log("");
  console.log(`工人A: ${lane(sol, 0, sol.makespan)}`);
  console.log(`工人B: ${lane(sol, 1, sol.makespan)}`);
}

function main(): void {
  const [, , cmd = "solve", arg] = process.argv;
  if (cmd !== "solve" && cmd !== "verify") {
    console.error("用法: node dist/src/cli.js [solve|verify] [实例.json | --demo]");
    process.exitCode = 1;
    return;
  }
  const inst = loadInstance(arg);
  const sol = solve(inst);
  if (!sol) {
    console.log(`在时间上限 ${inst.horizon ?? 40} 内无可行调度。`);
    process.exitCode = 2;
    return;
  }
  printSolution(sol);
  const errors = checkSchedule(inst, sol);
  if (errors.length > 0) {
    console.error("时间轴校验失败:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 3;
    return;
  }
  if (cmd === "verify") {
    const brute = bruteMakespan(inst);
    const ok = brute === sol.makespan;
    console.log("");
    console.log(
      `交叉核对: 事件驱动搜索 = ${sol.makespan}, 逐刻暴力搜索 = ${brute} => ${ok ? "一致" : "不一致!"}`,
    );
    if (!ok) process.exitCode = 4;
  }
}

main();
