import { bruteForce, confusion, solve } from "./calibrate.js";
import { addSample, load, removeSample, save, validate } from "./dataset.js";
import type { Dataset } from "./types.js";

const USAGE = `threshold-calibrator — per-group acceptance thresholds under a global FP budget

Usage:
  calibrate <dataset.json> [--json] [--cap N]   solve + print confusion matrices, DP certificate, exhaustive check
  add <dataset.json> <group> <id> <score> <0|1> add a sample (bumps version)
  remove <dataset.json> <group> <id>            remove a sample (bumps version)
  show <dataset.json>                           print dataset summary

Dataset format:
  { "version": 0, "budget": 2,
    "groups": [ { "name": "A",
      "samples": [ { "id": "s1", "score": 7, "label": 1 } ] } ] }

Semantics: a sample is accepted iff score >= its group's threshold.
Objective: total FP <= budget, then minimize total FN, then the
lexicographically smallest threshold vector. Tied scores always share a
decision. At most 8 groups; scores must be integers.`;

function out(s: string): void {
  process.stdout.write(s + "\n");
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exitCode = 1;
  throw new Error(msg);
}

function buildCertificate(ds: Dataset, cap: number) {
  const result = solve(ds.groups, ds.budget);
  const check = bruteForce(result.options, ds.budget, cap);
  const verified =
    check.status === "ok" &&
    check.fn === result.fn &&
    JSON.stringify(check.vector) === JSON.stringify(result.vector);
  return {
    certificate: {
      input: {
        version: ds.version,
        budget: ds.budget,
        groups: ds.groups.map((g) => ({
          name: g.name,
          samples: g.samples.length,
          positives: g.samples.filter((s) => s.label === 1).length,
          negatives: g.samples.filter((s) => s.label === 0).length,
        })),
      },
      paretoOptions: ds.groups.map((g, i) => ({
        group: g.name,
        options: result.options[i],
      })),
      dpFinalTable: result.tables[result.tables.length - 1]!.map((c, f) =>
        c ? { fp: f, fn: c.fn, vector: c.vector } : { fp: f, fn: null },
      ),
      result: {
        thresholds: Object.fromEntries(
          ds.groups.map((g, i) => [g.name, result.vector[i]]),
        ),
        vector: result.vector,
        totalFn: result.fn,
        totalFp: result.fp,
      },
      exhaustiveCheck: {
        ...check,
        matchesDp: verified,
      },
    },
  };
}

function cmdCalibrate(args: string[]): void {
  const path = args[0];
  if (!path) fail("calibrate: missing dataset file");
  const jsonFlag = args.includes("--json");
  const capIdx = args.indexOf("--cap");
  const cap = capIdx >= 0 ? Number(args[capIdx + 1]) : 1_000_000;
  if (!Number.isInteger(cap) || cap <= 0) fail("--cap must be a positive integer");
  const ds = load(path);
  const cert = buildCertificate(ds, cap);
  if (jsonFlag) {
    out(JSON.stringify(cert, null, 2));
    return;
  }
  const result = solve(ds.groups, ds.budget);
  out(`dataset v${ds.version} — ${ds.groups.length} group(s), FP budget ${ds.budget}`);
  out("");
  out("Per-group confusion matrices (accept iff score >= threshold):");
  ds.groups.forEach((g, i) => {
    const t = result.vector[i]!;
    const c = confusion(g, t);
    out(
      `  ${g.name}: threshold=${t}  TP=${c.tp} FP=${c.fp} TN=${c.tn} FN=${c.fn}`,
    );
  });
  out("");
  out(
    `Optimal: vector=[${result.vector.join(", ")}]  total FN=${result.fn}  total FP=${result.fp} (budget ${ds.budget})`,
  );
  const chk = cert.certificate.exhaustiveCheck;
  if (chk.status === "ok") {
    out(
      `Exhaustive check: ${chk.combos} combination(s) enumerated — ${chk.matchesDp ? "MATCHES DP (certificate valid)" : "MISMATCH!"}`,
    );
  } else {
    out(`Exhaustive check skipped: ${chk.reason}`);
  }
  out("");
  out("DP optimality certificate:");
  out(JSON.stringify(cert, null, 2));
  if (chk.status === "ok" && !chk.matchesDp) {
    process.exitCode = 1;
  }
}

function cmdAdd(args: string[]): void {
  const [path, group, id, scoreStr, labelStr] = args;
  if (!path || !group || !id || scoreStr === undefined || labelStr === undefined)
    fail("add: expected <file> <group> <id> <score> <0|1>");
  const score = Number(scoreStr);
  const label = Number(labelStr);
  if (!Number.isInteger(score)) fail("score must be an integer");
  if (label !== 0 && label !== 1) fail("label must be 0 or 1");
  const ds = load(path);
  addSample(ds, group, { id, score, label: label as 0 | 1 });
  save(path, ds);
  out(`added sample "${id}" to group "${group}"; dataset now v${ds.version}`);
}

function cmdRemove(args: string[]): void {
  const [path, group, id] = args;
  if (!path || !group || !id) fail("remove: expected <file> <group> <id>");
  const ds = load(path);
  removeSample(ds, group, id);
  save(path, ds);
  out(`removed sample "${id}" from group "${group}"; dataset now v${ds.version}`);
}

function cmdShow(args: string[]): void {
  const path = args[0];
  if (!path) fail("show: missing dataset file");
  const ds = load(path);
  out(`version=${ds.version} budget=${ds.budget} groups=${ds.groups.length}`);
  for (const g of ds.groups) {
    const pos = g.samples.filter((s) => s.label === 1).length;
    out(`  ${g.name}: ${g.samples.length} sample(s), ${pos} positive, ${g.samples.length - pos} negative`);
  }
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "calibrate":
        cmdCalibrate(rest);
        break;
      case "add":
        cmdAdd(rest);
        break;
      case "remove":
        cmdRemove(rest);
        break;
      case "show":
        cmdShow(rest);
        break;
      case "init": {
        const [path] = rest;
        if (!path) fail("init: missing dataset file");
        save(path, validate({ version: 0, budget: 0, groups: [] }));
        out(`created empty dataset at ${path}`);
        break;
      }
      default:
        out(USAGE);
        if (cmd !== undefined && cmd !== "help" && cmd !== "--help") {
          process.exitCode = 1;
        }
    }
  } catch (e) {
    if (!process.exitCode) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}

main(process.argv.slice(2));
