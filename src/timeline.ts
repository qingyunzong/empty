import type { Problem } from "./model.js";
import type { Solution } from "./schedule.js";

/** Renders an ASCII Gantt chart: one row per worker, one cell per time slot. */
export function renderTimeline(problem: Problem, solution: Solution): string {
  const { makespan, entries } = solution;
  const idWidth = Math.max(2, ...problem.jobs.map((j) => j.id.length));
  const grid: string[][] = [0, 1].map(() =>
    Array.from({ length: makespan }, () => "-".repeat(idWidth)),
  );
  for (const e of entries) {
    for (const w of e.workers) {
      for (let t = e.start; t < e.end; t++) grid[w][t] = e.id.padStart(idWidth);
    }
  }
  const cell = (s: string) => s + " ";
  const lines: string[] = [];
  lines.push("t=   " + Array.from({ length: makespan }, (_, t) => cell(String(t).padStart(idWidth))).join(""));
  const names = ["W1(A)", "W2(B)"];
  for (let w = 0; w < 2; w++) {
    lines.push(names[w].padEnd(5) + grid[w].map(cell).join(""));
  }
  return lines.join("\n");
}
