#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { InputError } from "../src/spec.js";
import { solve } from "../src/solver.js";
import { verify } from "../src/verify.js";
import {
  initState,
  loadState,
  pin,
  unpin,
  insertJob,
  forkCheckpoint,
  mergeCheckpoint,
  sessionSolve,
} from "../src/session.js";

export const EXIT = {
  OK: 0,
  INVALID_INPUT: 2,
  UNSAT: 3,
  PENDING: 4,
  CONFLICT: 5,
  INVALID: 6,
};

const USAGE = `usage: repro <command> [options]
  solve   --spec F [--max-nodes N] [--max-cert-bytes N] [--cert F]
  verify  --spec F --cert F
  init    --spec F --state F
  run     --state F [--branch B] [--max-nodes N] [--max-cert-bytes N] [--cert F]
  pin     --state F --step S --param P [--branch B]
  unpin   --state F --step S [--branch B]
  insert-job --state F --job JSON [--edge from>to]...
  fork    --state F --name B [--from B]
  merge   --state F --src B --dst B`;

function parseArgs(argv) {
  const flags = {};
  const multi = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new InputError(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const value = argv[++i];
    if (value === undefined) throw new InputError(`missing value for --${key}`);
    if (key === "edge") {
      (multi.edge ??= []).push(value);
    } else {
      if (flags[key] !== undefined) throw new InputError(`duplicate option --${key}`);
      flags[key] = value;
    }
  }
  return { flags, multi };
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new InputError(`cannot read ${what} file "${path}"`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InputError(`invalid JSON in ${what} file "${path}": ${e.message}`);
  }
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InputError(`invalid JSON for ${what}: ${e.message}`);
  }
}

function optInt(flags, key) {
  if (flags[key] === undefined) return undefined;
  const v = Number(flags[key]);
  if (!Number.isInteger(v) || v < 0) throw new InputError(`--${key} must be a non-negative integer`);
  return v;
}

function required(flags, key) {
  if (flags[key] === undefined) throw new InputError(`missing required option --${key}`);
  return flags[key];
}

function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

function solveBudgets(flags) {
  return { maxNodes: optInt(flags, "max-nodes"), maxCertBytes: optInt(flags, "max-cert-bytes") };
}

function solveResultOut(result, certPath) {
  if (certPath) writeFileSync(certPath, JSON.stringify(result.certificate, null, 2) + "\n");
  const out = { status: result.status };
  if (result.status === "SAT") {
    out.makespan = result.makespan;
    out.plan = result.plan;
  }
  if (result.status === "UNSAT" && result.certificate.result.reason) out.reason = result.certificate.result.reason;
  out.stats = result.stats;
  out.certEntries = result.certificate.entries.length;
  out.certHead = result.certificate.head;
  const code = result.status === "SAT" ? EXIT.OK : result.status === "UNSAT" ? EXIT.UNSAT : EXIT.PENDING;
  return { code, out };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags, multi } = parseArgs(rest);
  switch (cmd) {
    case "solve": {
      const spec = readJson(required(flags, "spec"), "spec");
      return solveResultOut(solve(spec, solveBudgets(flags)), flags.cert);
    }
    case "verify": {
      const spec = readJson(required(flags, "spec"), "spec");
      const cert = readJson(required(flags, "cert"), "certificate");
      const res = verify(spec, cert);
      return { code: res.status === "VERIFIED" ? EXIT.OK : EXIT.INVALID, out: res };
    }
    case "init": {
      const spec = readJson(required(flags, "spec"), "spec");
      const state = initState(spec);
      saveState(required(flags, "state"), state);
      return { code: EXIT.OK, out: { status: "OK", branches: Object.keys(state.branches) } };
    }
    case "run": {
      const path = required(flags, "state");
      const state = loadState(readJson(path, "state"));
      const result = sessionSolve(state, { ...solveBudgets(flags), branch: flags.branch });
      saveState(path, state);
      return solveResultOut(result, flags.cert);
    }
    case "pin": {
      const path = required(flags, "state");
      const state = loadState(readJson(path, "state"));
      pin(state, required(flags, "step"), required(flags, "param"), flags.branch);
      saveState(path, state);
      return { code: EXIT.OK, out: { status: "OK" } };
    }
    case "unpin": {
      const path = required(flags, "state");
      const state = loadState(readJson(path, "state"));
      unpin(state, required(flags, "step"), flags.branch);
      saveState(path, state);
      return { code: EXIT.OK, out: { status: "OK" } };
    }
    case "insert-job": {
      const path = required(flags, "state");
      const state = loadState(readJson(path, "state"));
      const job = parseJson(required(flags, "job"), "--job");
      const edges = (multi.edge ?? []).map((e) => {
        const parts = e.split(">");
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new InputError(`--edge must look like from>to, got "${e}"`);
        }
        return parts;
      });
      insertJob(state, job, edges, flags.branch);
      saveState(path, state);
      return { code: EXIT.OK, out: { status: "OK", steps: state.spec.steps.map((s) => s.id) } };
    }
    case "fork": {
      const path = required(flags, "state");
      const state = loadState(readJson(path, "state"));
      forkCheckpoint(state, required(flags, "name"), flags.from);
      saveState(path, state);
      return { code: EXIT.OK, out: { status: "OK", branches: Object.keys(state.branches) } };
    }
    case "merge": {
      const path = required(flags, "state");
      const state = loadState(readJson(path, "state"));
      const res = mergeCheckpoint(state, required(flags, "src"), required(flags, "dst"));
      if (res.status === "OK") saveState(path, state);
      return { code: res.status === "OK" ? EXIT.OK : EXIT.CONFLICT, out: res };
    }
    default:
      throw new InputError((cmd ? `unknown command "${cmd}"` : "missing command") + "\n" + USAGE);
  }
}

export function run(argv) {
  try {
    const { code, out } = main(argv);
    return { code, stdout: JSON.stringify(out) + "\n", stderr: "" };
  } catch (e) {
    if (e instanceof InputError) {
      return { code: EXIT.INVALID_INPUT, stdout: JSON.stringify({ status: "INVALID_INPUT", error: e.message }) + "\n", stderr: "" };
    }
    throw e;
  }
}

const invokedAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  const r = run(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
