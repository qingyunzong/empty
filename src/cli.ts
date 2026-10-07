import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { collectVars } from "./ast.js";
import { parseExpr } from "./parser.js";
import { ConflictCache } from "./cache.js";
import {
  findMinimumUnsatSubset,
  renderProofTree,
  type MusFrontier,
  type NamedExpr,
} from "./mus.js";
import { MAX_CONSTRAINTS, MAX_VARS } from "./solver.js";
import { emptyState, loadState, saveState, type NamedSource, type StateFile } from "./state.js";
import { verifySatClaim, verifyUnsatClaim } from "./verify.js";

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `bool-mus-cli -- exhaustive boolean constraint tool

usage:
  bool-mus solve <file> [--state S] [--budget N] [--no-cache]
  bool-mus verify <file> [--state S]
  bool-mus resume --state S [--budget N]
  bool-mus assume add <name> '<expr>' --state S
  bool-mus assume remove <name> --state S
  bool-mus assume list --state S
  bool-mus cache list --state S
  bool-mus limits

constraint file format: one 'id: <boolean expr>' per line, '#' comments.
operators: ! ~ not  & && and  | || or  ^ xor  -> implies  <-> iff  ( )  true false 0 1
`;

function parseConstraintFile(path: string): NamedSource[] {
  const text = readFileSync(path, "utf8");
  const out: NamedSource[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, idx) => {
    const stripped = line.replace(/#.*$/, "").trim();
    if (stripped === "") return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(stripped);
    if (m === null) throw new Error(`${path}:${idx + 1}: expected 'id: <expr>'`);
    const id = m[1] as string;
    const expr = m[2] as string;
    if (seen.has(id)) throw new Error(`${path}:${idx + 1}: duplicate constraint id '${id}'`);
    seen.add(id);
    parseExpr(expr); // validate eagerly
    out.push({ id, expr });
  });
  return out;
}

interface Active {
  named: NamedExpr[];
  assumptionNames: Set<string>;
  vars: string[];
}

function buildActive(constraints: NamedSource[], assumptions: NamedSource[]): Active {
  const total = constraints.length + assumptions.length;
  if (total > MAX_CONSTRAINTS) {
    throw new Error(
      `exhaustive input limit exceeded: ${total} named constraints (incl. assumptions), at most ${MAX_CONSTRAINTS} allowed (2^${MAX_CONSTRAINTS} subsets)`
    );
  }
  const named: NamedExpr[] = [
    ...constraints.map((c) => ({ id: c.id, expr: parseExpr(c.expr) })),
    ...assumptions.map((a) => ({ id: a.id, expr: parseExpr(a.expr) })),
  ];
  const vars = collectVars(named.map((n) => n.expr));
  if (vars.length > MAX_VARS) {
    throw new Error(
      `exhaustive input limit exceeded: ${vars.length} variables, at most ${MAX_VARS} allowed (2^${MAX_VARS} rows)`
    );
  }
  return { named, assumptionNames: new Set(assumptions.map((a) => a.id)), vars };
}

function formatAssignment(assignment: Record<string, boolean>): string {
  const keys = Object.keys(assignment).sort();
  if (keys.length === 0) return "(no variables)";
  return keys.map((v) => `${v}=${assignment[v] ? 1 : 0}`).join(" ");
}

interface RunOutcome {
  exitCode: number;
  frontier: MusFrontier | null;
}

function runSearch(
  io: CliIO,
  state: StateFile,
  active: Active,
  opts: { budget?: number; frontier?: MusFrontier; useCache: boolean }
): RunOutcome {
  const cache = new ConflictCache(state.cache);
  const activeSources = {
    constraints: new Set(state.constraints.map((c) => c.id)),
    assumptions: new Set(state.assumptions.map((a) => a.id)),
  };

  if (opts.useCache && opts.frontier === undefined) {
    const hit = cache.findApplicable(activeSources);
    if (hit !== undefined) {
      io.out("UNSAT (cached conflict; every source still exists and is active)");
      io.out(`  constraints: ${hit.constraints.join(", ") || "(none)"}`);
      io.out(`  assumptions: ${hit.assumptions.join(", ") || "(none)"}`);
      io.out(`  note: ${hit.note}`);
      return { exitCode: 0, frontier: null };
    }
  }

  const result = findMinimumUnsatSubset(active.named, active.vars, {
    ...(opts.budget !== undefined ? { stepBudget: opts.budget } : {}),
    ...(opts.frontier !== undefined ? { frontier: opts.frontier } : {}),
  });

  if (result.status === "paused") {
    io.out(
      `PAUSED at size=${result.frontier.size} combo=${result.frontier.comboIndex} row=${result.frontier.rowIndex}`
    );
    io.out("frontier persisted; run 'bool-mus resume --state <file>' to continue");
    return { exitCode: 0, frontier: result.frontier };
  }

  if (result.status === "sat") {
    io.out("SAT");
    io.out(`lexicographically smallest assignment: ${formatAssignment(result.assignment)}`);
    return { exitCode: 0, frontier: null };
  }

  io.out("UNSAT");
  io.out(renderProofTree(result.mus, result.checks));
  const musConstraints = result.mus.filter((id) => !active.assumptionNames.has(id));
  const musAssumptions = result.mus.filter((id) => active.assumptionNames.has(id));
  const added = cache.add({
    constraints: musConstraints,
    assumptions: musAssumptions,
    note: `minimum unsatisfiable subset, size ${result.mus.length}`,
  });
  state.cache = cache.toJSON();
  io.out(added ? "conflict cached" : "conflict already present in cache");
  return { exitCode: 0, frontier: null };
}

function optString(values: Record<string, unknown>, key: string): string | undefined {
  const v = values[key];
  return typeof v === "string" ? v : undefined;
}

function cmdSolve(io: CliIO, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      state: { type: "string" },
      budget: { type: "string" },
      "no-cache": { type: "boolean", default: false },
    },
  });
  const file = positionals[0];
  if (file === undefined) throw new Error("solve: missing constraint file");
  const statePath = optString(values, "state");
  const budgetRaw = optString(values, "budget");
  const budget = budgetRaw !== undefined ? Number.parseInt(budgetRaw, 10) : undefined;
  if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) {
    throw new Error("solve: --budget must be a non-negative integer");
  }

  const state = statePath !== undefined ? loadState(statePath) : emptyState();
  state.constraints = parseConstraintFile(file);
  state.frontier = null; // a fresh solve supersedes any paused search
  const active = buildActive(state.constraints, state.assumptions);
  const outcome = runSearch(io, state, active, {
    ...(budget !== undefined ? { budget } : {}),
    useCache: values["no-cache"] !== true,
  });
  if (statePath !== undefined) {
    state.frontier = outcome.frontier;
    saveState(statePath, state);
  }
  return outcome.exitCode;
}

function cmdResume(io: CliIO, args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      state: { type: "string" },
      budget: { type: "string" },
    },
  });
  const statePath = optString(values, "state");
  if (statePath === undefined) throw new Error("resume: --state is required");
  const budgetRaw = optString(values, "budget");
  const budget = budgetRaw !== undefined ? Number.parseInt(budgetRaw, 10) : undefined;
  const state = loadState(statePath);
  if (state.frontier === null) throw new Error("resume: no paused search in this state file");
  const active = buildActive(state.constraints, state.assumptions);
  const outcome = runSearch(io, state, active, {
    ...(budget !== undefined ? { budget } : {}),
    frontier: state.frontier,
    useCache: false,
  });
  state.frontier = outcome.frontier;
  saveState(statePath, state);
  return outcome.exitCode;
}

function cmdVerify(io: CliIO, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { state: { type: "string" } },
  });
  const file = positionals[0];
  if (file === undefined) throw new Error("verify: missing constraint file");
  const statePath = optString(values, "state");
  const state = statePath !== undefined ? loadState(statePath) : emptyState();
  const constraints = parseConstraintFile(file);
  const active = buildActive(constraints, state.assumptions);

  const result = findMinimumUnsatSubset(active.named, active.vars);
  if (result.status === "paused") throw new Error("verify: unexpected pause");

  let ok = true;
  if (result.status === "sat") {
    io.out(`claim: SAT, lexicographically smallest assignment ${formatAssignment(result.assignment)}`);
    const report = verifySatClaim(active.named, active.vars, result.assignment);
    ok = report.ok;
    for (const line of report.lines) io.out(line);
  } else {
    io.out(`claim: UNSAT, minimum unsatisfiable subset {${result.mus.join(", ")}}`);
    const report = verifyUnsatClaim(active.named, active.vars, result.mus);
    ok = report.ok;
    for (const line of report.lines) io.out(line);
    // Cross-check the search's own minimality proof against the verifier.
    const smaller = result.checks.filter((c) => c.ids.length < result.mus.length);
    if (smaller.every((c) => c.sat)) {
      io.out(`PASS search proof: all ${smaller.length} recorded smaller subset(s) are satisfiable`);
    } else {
      ok = false;
      io.out("FAIL search proof: a recorded smaller subset is marked unsatisfiable");
    }
  }
  io.out(ok ? "VERIFY OK" : "VERIFY FAILED");
  return ok ? 0 : 1;
}

function cmdAssume(io: CliIO, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { state: { type: "string" } },
  });
  const statePath = optString(values, "state");
  if (statePath === undefined) throw new Error("assume: --state is required");
  const state = loadState(statePath);
  const sub = positionals[0];
  if (sub === "add") {
    const name = positionals[1];
    const expr = positionals[2];
    if (name === undefined || expr === undefined) {
      throw new Error("assume add: expected <name> '<expr>'");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`assume add: invalid name '${name}'`);
    parseExpr(expr); // validate
    if (state.assumptions.some((a) => a.id === name)) {
      throw new Error(`assume add: assumption '${name}' already exists`);
    }
    state.assumptions.push({ id: name, expr });
    buildActive(state.constraints, state.assumptions); // re-check limits
    saveState(statePath, state);
    io.out(`assumption '${name}' added`);
    return 0;
  }
  if (sub === "remove") {
    const name = positionals[1];
    if (name === undefined) throw new Error("assume remove: expected <name>");
    const before = state.assumptions.length;
    state.assumptions = state.assumptions.filter((a) => a.id !== name);
    if (state.assumptions.length === before) {
      throw new Error(`assume remove: no assumption named '${name}'`);
    }
    // The conflict cache is deliberately left untouched: a cached conflict
    // becomes reusable again only when every one of its sources exists.
    saveState(statePath, state);
    io.out(`assumption '${name}' removed; dependent cached conflicts are no longer reusable`);
    return 0;
  }
  if (sub === "list") {
    if (state.assumptions.length === 0) io.out("(no assumptions)");
    for (const a of state.assumptions) io.out(`${a.id}: ${a.expr}`);
    return 0;
  }
  throw new Error("assume: expected subcommand add|remove|list");
}

function cmdCache(io: CliIO, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { state: { type: "string" } },
  });
  const statePath = optString(values, "state");
  if (statePath === undefined) throw new Error("cache: --state is required");
  if (positionals[0] !== "list") throw new Error("cache: expected subcommand list");
  const state = loadState(statePath);
  const cache = new ConflictCache(state.cache);
  const universe = {
    constraints: new Set(state.constraints.map((c) => c.id)),
    assumptions: new Set(state.assumptions.map((a) => a.id)),
  };
  const validKeys = new Set(cache.valid(universe).map((r) => ConflictCache.key(r)));
  const all = cache.all();
  if (all.length === 0) io.out("(cache empty)");
  for (const rec of all) {
    const reusable = validKeys.has(ConflictCache.key(rec));
    io.out(
      `${reusable ? "reusable   " : "invalidated"} constraints={${rec.constraints.join(", ")}} assumptions={${rec.assumptions.join(", ")}}  ${rec.note}`
    );
  }
  return 0;
}

export function main(argv: string[], io: CliIO): number {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "solve":
      return cmdSolve(io, rest);
    case "resume":
      return cmdResume(io, rest);
    case "verify":
      return cmdVerify(io, rest);
    case "assume":
      return cmdAssume(io, rest);
    case "cache":
      return cmdCache(io, rest);
    case "limits":
      io.out(`max named constraints (incl. assumptions): ${MAX_CONSTRAINTS} (2^${MAX_CONSTRAINTS} subsets)`);
      io.out(`max variables: ${MAX_VARS} (2^${MAX_VARS} truth-table rows)`);
      return 0;
    default:
      io.err(USAGE);
      return command === undefined ? 0 : 2;
  }
}
