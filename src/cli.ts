import process from "node:process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseExpr } from "./expr.js";
import {
  LimitError,
  MAX_CONSTRAINTS,
  MAX_VARIABLES,
  solve,
  type NamedConstraint,
  type SolveResult,
} from "./solver.js";
import {
  addToCache,
  hashConstraints,
  loadState,
  saveState,
  type StateFile,
  type StoredResult,
} from "./state.js";
import { parseConstraintRecord, verifyResult } from "./verify.js";

const DEFAULT_STATE = ".minicore-state.json";

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
  throw new ExitSignal();
}

class ExitSignal extends Error {}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function parseNameExpr(pair: string): [string, string] {
  const eq = pair.indexOf("=");
  if (eq <= 0) fail(`expected NAME=EXPRESSION, got '${pair}'`);
  const name = pair.slice(0, eq);
  const expr = pair.slice(eq + 1);
  if (!NAME_RE.test(name)) fail(`invalid constraint name '${name}'`);
  if (expr.length === 0) fail(`empty expression for constraint '${name}'`);
  return [name, expr];
}

function mergeInputs(
  cliPairs: string[],
  filePath: string | undefined,
  state: StateFile,
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (filePath) {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      constraints?: Record<string, string>;
    };
    for (const [name, expr] of Object.entries(parsed.constraints ?? {})) {
      if (!NAME_RE.test(name)) fail(`invalid constraint name '${name}' in ${filePath}`);
      merged[name] = expr;
    }
  }
  for (const pair of cliPairs) {
    const [name, expr] = parseNameExpr(pair);
    merged[name] = expr; // CLI entries merge over file entries with the same name
  }
  for (const [name, expr] of Object.entries(state.assumptions)) {
    if (name in merged) {
      fail(`assumption '${name}' collides with a constraint of the same name; rename one of them`);
    }
    merged[name] = expr;
  }
  return merged;
}

function toNamedConstraints(record: Record<string, string>): NamedConstraint[] {
  return Object.keys(record)
    .sort()
    .map((name) => {
      try {
        return { name, exprText: record[name], expr: parseExpr(record[name]) };
      } catch (err) {
        fail(`constraint '${name}': ${(err as Error).message}`);
      }
    });
}

function storeResult(
  state: StateFile,
  constraints: Record<string, string>,
  result: Extract<SolveResult, { status: "sat" | "unsat" }>,
): void {
  const stored: StoredResult = {
    status: result.status,
    inputHash: hashConstraints(constraints),
    constraints,
    stats: {
      totalSteps: result.stats.totalSteps,
      smallerSubsetsChecked: result.stats.smallerSubsetsChecked,
      cacheHit: result.stats.cacheHit,
    },
  };
  if (result.status === "sat") {
    stored.assignment = result.assignment;
    stored.assignmentIndex = result.assignmentIndex;
  } else {
    stored.core = result.core;
    stored.proof = result.proof;
    stored.proofTree = result.proofTree;
  }
  state.result = stored;
  delete state.pending;
}

function printResult(result: Extract<SolveResult, { status: "sat" | "unsat" }>): void {
  const out = process.stdout;
  if (result.status === "sat") {
    const text = Object.entries(result.assignment)
      .map(([v, b]) => `${v}=${b ? 1 : 0}`)
      .join(" ");
    out.write(`status: SAT\n`);
    out.write(`lexicographically smallest assignment: ${text === "" ? "(no variables)" : text}\n`);
  } else {
    out.write(`status: UNSAT\n`);
    out.write(`minimal unsat core (${result.core.length}): ${result.core.join(", ")}\n`);
    out.write(
      `minimality: ${result.stats.smallerSubsetsChecked} smaller subsets independently checked, all satisfiable\n`,
    );
    if (result.stats.cacheHit) {
      out.write(`cache: conflict {${result.stats.cacheHit.join(", ")}} reused as unsat upper bound\n`);
    }
    out.write(`${result.proofTree}\n`);
  }
  out.write(`subset checks performed: ${result.stats.totalSteps}\n`);
}

function runSolve(
  constraints: Record<string, string>,
  state: StateFile,
  statePath: string,
  stepLimit: number | undefined,
  frontier?: import("./solver.js").Frontier,
): void {
  const named = toNamedConstraints(constraints);
  let result: SolveResult;
  try {
    result = solve(named, { stepLimit, frontier, cache: state.cache });
  } catch (err) {
    if (err instanceof LimitError) fail(err.message);
    throw err;
  }

  if (result.status === "paused") {
    state.pending = {
      inputHash: hashConstraints(constraints),
      constraints,
      frontier: result.frontier,
    };
    saveState(statePath, state);
    process.stdout.write(
      `status: PAUSED (step budget ${stepLimit} exhausted)\n` +
        `frontier persisted to ${statePath}: subset size k=${result.frontier.k}, ` +
        `next combination [${(result.frontier.combo ?? []).join(", ")}], ` +
        `${result.stats.totalSteps} subset checks done\n` +
        `resume with: npm run cli -- resume --state ${statePath}\n`,
    );
    process.exitCode = 3;
    return;
  }

  if (result.status === "unsat") {
    state.cache = addToCache(state.cache, result.core);
  }
  storeResult(state, constraints, result);
  saveState(statePath, state);
  printResult(result);
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;

  switch (command) {
    case "limits": {
      process.stdout.write(
        `exhaustive input limits:\n` +
          `  named constraints (incl. assumptions): <= ${MAX_CONSTRAINTS}\n` +
          `  distinct boolean variables:            <= ${MAX_VARIABLES}\n` +
          `  worst-case truth table:                2^${MAX_VARIABLES} = ${2 ** MAX_VARIABLES} rows\n` +
          `  worst-case subset enumeration:         2^${MAX_CONSTRAINTS} - 1 = ${2 ** MAX_CONSTRAINTS - 1} subsets\n`,
      );
      return;
    }

    case "solve": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          file: { type: "string" },
          state: { type: "string", default: DEFAULT_STATE },
          "step-limit": { type: "string" },
        },
      });
      const statePath = String(values.state);
      const state = loadState(statePath);
      const merged = mergeInputs(positionals, values.file as string | undefined, state);
      const stepLimit =
        values["step-limit"] !== undefined ? Number(values["step-limit"]) : undefined;
      if (stepLimit !== undefined && (!Number.isInteger(stepLimit) || stepLimit <= 0)) {
        fail(`--step-limit must be a positive integer, got '${values["step-limit"]}'`);
      }
      runSolve(merged, state, statePath, stepLimit);
      return;
    }

    case "resume": {
      const { values } = parseArgs({
        args: rest,
        allowPositionals: false,
        options: {
          state: { type: "string", default: DEFAULT_STATE },
          "step-limit": { type: "string" },
        },
      });
      const statePath = String(values.state);
      const state = loadState(statePath);
      if (!state.pending) fail(`no paused run found in ${statePath}`);
      const stepLimit =
        values["step-limit"] !== undefined ? Number(values["step-limit"]) : undefined;
      process.stdout.write(
        `resuming paused run (input hash ${state.pending.inputHash.slice(0, 12)}..., ` +
          `${state.pending.frontier.stepsDone} subset checks already done)\n`,
      );
      runSolve(state.pending.constraints, state, statePath, stepLimit, state.pending.frontier);
      return;
    }

    case "assume": {
      const [sub, ...subRest] = rest;
      const { values, positionals } = parseArgs({
        args: subRest,
        allowPositionals: true,
        options: { state: { type: "string", default: DEFAULT_STATE } },
      });
      const statePath = String(values.state);
      const state = loadState(statePath);
      if (sub === "add") {
        const [name, ...exprParts] = positionals;
        if (!name || exprParts.length === 0) fail("usage: assume add <name> <expression>");
        if (!NAME_RE.test(name)) fail(`invalid assumption name '${name}'`);
        const exprText = exprParts.join(" ");
        try {
          parseExpr(exprText);
        } catch (err) {
          fail(`assumption '${name}': ${(err as Error).message}`);
        }
        state.assumptions[name] = exprText;
        saveState(statePath, state);
        process.stdout.write(`assumption '${name}' added: ${exprText}\n`);
      } else if (sub === "remove") {
        const [name] = positionals;
        if (!name) fail("usage: assume remove <name>");
        if (!(name in state.assumptions)) fail(`no assumption named '${name}'`);
        delete state.assumptions[name];
        // The conflict cache is intentionally left untouched: entries whose
        // sources no longer all exist simply stop being reusable.
        saveState(statePath, state);
        process.stdout.write(
          `assumption '${name}' removed; cached conflicts depending on it are no longer reusable\n`,
        );
      } else if (sub === "list") {
        const entries = Object.entries(state.assumptions);
        if (entries.length === 0) {
          process.stdout.write("(no assumptions)\n");
        } else {
          for (const [name, expr] of entries) process.stdout.write(`${name} = ${expr}\n`);
        }
        for (const entry of state.cache) {
          const nonAssumptions = entry.sources.filter((s) => !(s in state.assumptions));
          const note =
            nonAssumptions.length === 0
              ? ""
              : ` (reusable only if {${nonAssumptions.join(", ")}} still exist as constraints)`;
          process.stdout.write(`cached conflict {${entry.sources.join(", ")}}${note}\n`);
        }
      } else {
        fail("usage: assume <add|remove|list> ...");
      }
      return;
    }

    case "verify": {
      const { values } = parseArgs({
        args: rest,
        allowPositionals: false,
        options: { state: { type: "string", default: DEFAULT_STATE } },
      });
      const statePath = String(values.state);
      const state = loadState(statePath);
      if (!state.result) fail(`no solve result stored in ${statePath}; run solve first`);
      const constraints = parseConstraintRecord(state.result.constraints);
      const checks = verifyResult(constraints, state.result, state.cache);
      let allOk = true;
      for (const check of checks) {
        process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
        if (!check.ok) allOk = false;
      }
      process.stdout.write(allOk ? "verification: ALL CHECKS PASSED\n" : "verification: FAILED\n");
      if (!allOk) process.exitCode = 4;
      return;
    }

    default: {
      process.stdout.write(
        `usage:\n` +
          `  cli solve [NAME=EXPR ...] [--file constraints.json] [--state f] [--step-limit N]\n` +
          `  cli resume [--state f] [--step-limit N]\n` +
          `  cli assume add <name> <expression> [--state f]\n` +
          `  cli assume remove <name> [--state f]\n` +
          `  cli assume list [--state f]\n` +
          `  cli verify [--state f]\n` +
          `  cli limits\n`,
      );
      if (command !== undefined && command !== "help") process.exitCode = 1;
    }
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof ExitSignal)) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
