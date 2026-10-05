/**
 * CLI entry point. Node.js built-ins only.
 *
 * Usage:
 *   node dist/src/cli.js plan     <problem.json>
 *   node dist/src/cli.js closure  <problem.json>
 *   node dist/src/cli.js verify   <problem.json> <certificate.json>
 *   node dist/src/cli.js bound    <problem.json>
 *   node dist/src/cli.js astar    <problem.json>
 *   node dist/src/cli.js iddfs    <problem.json>
 *   node dist/src/cli.js frontier <problem.json> [--pause K --out snap.json]
 *   node dist/src/cli.js frontier <problem.json> --resume snap.json
 *
 * `runCommand` returns the result object (used by tests in-process);
 * the CLI wrapper prints it as JSON on stdout for checkability.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { ProblemDef, normalizeProblem, Problem } from "./model.js";
import { Bfs, Snapshot, reachableClosure } from "./bfs.js";
import { astar, lowerBound } from "./heuristic.js";
import { iddfs } from "./iddfs.js";
import { verifyCertificate } from "./verify.js";

function loadProblem(path: string): Problem {
  const def = JSON.parse(readFileSync(path, "utf8")) as ProblemDef;
  return normalizeProblem(def);
}

function planJson(p: Problem, plan: number[] | null) {
  return {
    plan,
    actions: plan ? plan.map((i) => p.actions[i]!.name) : null,
    length: plan ? plan.length : null,
  };
}

function cmdPlan(path: string) {
  const p = loadProblem(path);
  const r = new Bfs(p).run();
  const cert = r.plan ? verifyCertificate(p, r.plan) : null;
  return {
    ...planJson(p, r.plan),
    expansions: r.visitOrder.length,
    certificate: cert ? { valid: cert.ok, minimal: cert.minimal ?? null } : null,
  };
}

function cmdClosure(path: string) {
  const p = loadProblem(path);
  const closure = reachableClosure(p);
  const states = [...closure.entries()]
    .map(([key, depth]) => ({ key, depth }))
    .sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : 1));
  return { count: states.length, states };
}

function cmdVerify(problemPath: string, certPath: string) {
  const p = loadProblem(problemPath);
  const cert = JSON.parse(readFileSync(certPath, "utf8")) as { plan: number[] };
  return verifyCertificate(p, cert.plan);
}

function cmdBound(path: string) {
  const p = loadProblem(path);
  const lb = lowerBound(p, p.initial);
  const show = (d: number) => (d === Infinity ? "Infinity" : d);
  return {
    initial: p.initial,
    lowerBound: show(lb.value),
    trueDist: lb.trueDist.map(show),
    falseDist: lb.falseDist.map(show),
  };
}

function cmdAstar(path: string) {
  const p = loadProblem(path);
  const r = astar(p);
  const show = (d: number) => (d === Infinity ? "Infinity" : d);
  return {
    ...planJson(p, r.plan),
    expansions: r.expansions,
    bounds: r.bounds.map((b) => ({ ...b, h: show(b.h), f: show(b.f) })),
  };
}

function cmdIddfs(path: string) {
  const p = loadProblem(path);
  const closure = reachableClosure(p);
  const r = iddfs(p, Math.max(1, closure.size));
  return {
    ...planJson(p, r.plan),
    iterations: r.iterations,
    expansions: r.expansions,
    learnedPrunes: r.learnedPrunes,
    learnedStates: r.learnedStates,
  };
}

function cmdFrontier(path: string, args: string[]) {
  const p = loadProblem(path);
  const resumeIdx = args.indexOf("--resume");
  let b: Bfs;
  if (resumeIdx >= 0) {
    const snap = JSON.parse(readFileSync(args[resumeIdx + 1]!, "utf8")) as Snapshot;
    b = Bfs.restore(p, snap);
  } else {
    b = new Bfs(p);
  }
  const pauseIdx = args.indexOf("--pause");
  if (pauseIdx >= 0) {
    const k = Number(args[pauseIdx + 1]);
    b.run(k);
    const outIdx = args.indexOf("--out");
    const snap = b.snapshotJson();
    let written: string | null = null;
    if (outIdx >= 0) {
      written = args[outIdx + 1]!;
      writeFileSync(written, snap);
    }
    return { paused: true, expansions: b.visitOrder.length, snapshotWritten: written };
  }
  const r = b.run();
  return {
    ...planJson(p, r.plan),
    goalDepth: r.goalDepth,
    visitOrder: r.visitOrder,
    closureSize: r.closure.size,
  };
}

/** Run a command and return its result object (throws on bad usage). */
export function runCommand(cmd: string, args: string[]): unknown {
  switch (cmd) {
    case "plan": return cmdPlan(args[0]!);
    case "closure": return cmdClosure(args[0]!);
    case "verify": return cmdVerify(args[0]!, args[1]!);
    case "bound": return cmdBound(args[0]!);
    case "astar": return cmdAstar(args[0]!);
    case "iddfs": return cmdIddfs(args[0]!);
    case "frontier": return cmdFrontier(args[0]!, args.slice(1));
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

function main(): void {
  const [, , cmd, ...args] = process.argv;
  if (!cmd) {
    process.stderr.write(
      "usage: cli.js plan|closure|verify|bound|astar|iddfs|frontier ...\n"
    );
    process.exitCode = 2;
    return;
  }
  try {
    const data = runCommand(cmd, args);
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    if (cmd === "verify" && (data as { ok: boolean }).ok === false) {
      process.exitCode = 1;
    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

// Run main only when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  main();
}
