/**
 * bitplanner CLI.
 *
 *   node dist/src/cli.js solve   <problem.json> [--cert out.json] [--astar]
 *                                [--pause-after N --snapshot snap.json]
 *   node dist/src/cli.js resume  <problem.json> <snap.json>
 *   node dist/src/cli.js closure <problem.json> [--out closure.json]
 *   node dist/src/cli.js verify  <problem.json> <cert.json>
 *   node dist/src/cli.js learn   <problem.json>
 *   node dist/src/cli.js bounds  <problem.json> [--cert bounds.json]
 *
 * runCli is exported so tests can drive the CLI in-process.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseProblem, Problem } from "./model.js";
import { shortestPlan, reachableClosure } from "./bfs.js";
import { buildCertificate, verifyCertificate } from "./certificate.js";
import { dfsLearn } from "./learning.js";
import { Search, serializeSnapshot, deserializeSnapshot } from "./frontier.js";
import { certifiedAStar, makeHeuristic, verifyLowerBounds } from "./heuristic.js";

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
}

const consoleIO: CliIO = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

function loadProblem(path: string): Problem {
  return parseProblem(JSON.parse(readFileSync(path, "utf8")));
}

function strOpt(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function runCli(argv: string[], io: CliIO = consoleIO): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cert: { type: "string" },
      out: { type: "string" },
      astar: { type: "boolean", default: false },
      "pause-after": { type: "string" },
      snapshot: { type: "string" },
    },
  });
  const [cmd, problemPath, extra] = positionals;
  if (!cmd || !problemPath) {
    io.err("usage: cli.js <solve|resume|closure|verify|learn|bounds> <problem.json> ...");
    return 2;
  }

  let p: Problem;
  try {
    p = loadProblem(problemPath);
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }

  switch (cmd) {
    case "solve": {
      if (values.astar) return solveAstar(p, strOpt(values.cert), io);
      const pauseAfter = values["pause-after"] !== undefined ? Number(values["pause-after"]) : null;
      if (pauseAfter !== null) {
        const snapPath = strOpt(values.snapshot);
        if (!snapPath) {
          io.err("error: --pause-after requires --snapshot <file>");
          return 1;
        }
        const search = new Search(p, "bfs");
        search.run(pauseAfter);
        writeFileSync(snapPath, serializeSnapshot(search.snapshot()));
        io.out(`paused after ${search.visitLog.length} expansions; snapshot -> ${snapPath}`);
        return 0;
      }
      const r = shortestPlan(p);
      const closure = reachableClosure(p);
      if (!r) {
        io.out(`unsolvable; reachable closure = ${closure.count} states`);
        return 1;
      }
      const cert = buildCertificate(p, r.plan, r.layers, closure.count);
      io.out(`shortest plan (${r.length} steps): ${r.plan.join(" -> ")}`);
      io.out(`layers: [${r.layers.join(", ")}], reachable: ${closure.count}`);
      const certPath = strOpt(values.cert);
      if (certPath) {
        writeFileSync(certPath, JSON.stringify(cert, null, 2));
        io.out(`certificate -> ${certPath}`);
      }
      return 0;
    }

    case "resume": {
      if (!extra) {
        io.err("error: resume requires a snapshot file");
        return 1;
      }
      const snap = deserializeSnapshot(readFileSync(extra, "utf8"));
      const h = snap.mode === "astar" ? makeHeuristic(p) : () => 0;
      const search = Search.fromSnapshot(p, snap, h);
      search.run();
      const plan = search.plan();
      if (!plan) {
        io.err("error: no plan found after resume");
        return 1;
      }
      io.out(`resumed; total expansions ${search.visitLog.length}`);
      io.out(`plan (${plan.length} steps): ${plan.join(" -> ")}`);
      return 0;
    }

    case "closure": {
      const c = reachableClosure(p);
      io.out(`reachable states: ${c.count}`);
      io.out(`depth histogram: [${c.histogram.join(", ")}]`);
      const outPath = strOpt(values.out);
      if (outPath) {
        writeFileSync(
          outPath,
          JSON.stringify({ count: c.count, histogram: c.histogram, states: [...c.depthOf.entries()] }, null, 2),
        );
        io.out(`closure -> ${outPath}`);
      }
      return 0;
    }

    case "verify": {
      if (!extra) {
        io.err("error: verify requires a certificate file");
        return 1;
      }
      const cert = JSON.parse(readFileSync(extra, "utf8"));
      const v = verifyCertificate(p, cert);
      if (v.ok) {
        io.out("certificate OK: plan reaches goal and is shortest");
        return 0;
      }
      for (const e of v.errors) io.err(`  - ${e}`);
      return 1;
    }

    case "learn": {
      const r = dfsLearn(p);
      if (r.plan) io.out(`plan (${r.plan.length} steps): ${r.plan.join(" -> ")}`);
      else io.out("unsolvable");
      io.out(`expansions: ${r.expansions}, learned nogoods: ${r.nogoods.length}`);
      return r.plan ? 0 : 1;
    }

    case "bounds": {
      return solveAstar(p, strOpt(values.cert), io);
    }

    default:
      io.err(`error: unknown command "${cmd}"`);
      return 1;
  }
}

function solveAstar(p: Problem, certPath: string | undefined, io: CliIO): number {
  const r = certifiedAStar(p);
  if (!r.plan) {
    io.out("unsolvable");
    return 1;
  }
  const violations = verifyLowerBounds(p, r.bounds);
  io.out(`A* plan (${r.length} steps): ${r.plan.join(" -> ")}`);
  io.out(`expanded: ${r.bounds.length} nodes; lower-bound violations: ${violations.length}`);
  for (const v of violations) io.err(`  - ${v}`);
  if (certPath) {
    writeFileSync(certPath, JSON.stringify(r, null, 2));
    io.out(`bounds -> ${certPath}`);
  }
  return violations.length === 0 ? 0 : 1;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
