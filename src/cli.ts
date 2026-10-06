import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { PreflightError } from "./mapping.js";
import { requireJournal } from "./journal.js";
import { RecoveryError } from "./executor.js";
import { verifyJournal } from "./verify.js";
import { applyPlan, createPlan, rollback } from "./commands.js";

const USAGE = `photo-organize - journaled batch rename for photo libraries

usage:
  photo-organize plan <mapping.json> [--dir DIR]   preflight + write journal (no renames yet)
  photo-organize apply [--dir DIR]                 execute or resume the journaled plan
  photo-organize verify [--dir DIR]                check journal vs disk, recovery-twice, inverse plan
  photo-organize rollback [--dir DIR]              apply the inverse plan of a completed batch
  photo-organize status [--dir DIR]                show journal state

mapping.json:
  { "caseFold": true,                              // case-insensitive name comparison (default true)
    "renames": [ { "from": "a.jpg", "to": "b.jpg" } ] }
  ("renames" also accepts an object: { "a.jpg": "b.jpg" })
`;

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function parseArgs(argv: string[]): { command: string; positional: string[]; dir: string } {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dir") {
      const value = rest[++i];
      if (value === undefined) throw new CliError("--dir requires a value", 1);
      dir = resolve(value);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (command === undefined) throw new CliError(USAGE, 1);
  return { command, positional, dir };
}

export function runCli(argv: string[], io: CliIO): number {
  try {
    const { command, positional, dir } = parseArgs(argv);
    switch (command) {
      case "plan": {
        const mappingFile = positional[0];
        if (mappingFile === undefined) throw new CliError("plan requires a mapping.json path", 1);
        const journal = createPlan(dir, mappingFile);
        io.out(`planned ${journal.steps.length} step(s); journal ${journal.id}`);
        for (const step of journal.steps) {
          io.out(`  [${step.kind}] ${step.from} -> ${step.to}`);
        }
        return 0;
      }
      case "apply": {
        const result = applyPlan(dir, { log: io.out });
        io.out(`done: ${result.executed} executed, ${result.recovered} recovered, ${result.skipped} already complete`);
        return 0;
      }
      case "verify": {
        const report = verifyJournal(dir);
        for (const check of report.checks) io.out(`PASS ${check}`);
        for (const problem of report.problems) io.out(`FAIL ${problem}`);
        if (!report.ok) throw new CliError("verification failed", 3);
        io.out("verification passed");
        return 0;
      }
      case "rollback": {
        const { result } = rollback(dir, { log: io.out });
        io.out(`rollback done: ${result.executed} executed, ${result.recovered} recovered`);
        return 0;
      }
      case "status": {
        const journal = requireJournal(dir);
        const counts = { pending: 0, doing: 0, done: 0 };
        for (const step of journal.steps) counts[step.status]++;
        io.out(`journal ${journal.id} (${journal.kind}) created ${journal.createdAt}`);
        io.out(`case-fold comparison: ${journal.caseFold ? "on" : "off"}`);
        io.out(`steps: ${counts.done} done, ${counts.doing} doing, ${counts.pending} pending`);
        return 0;
      }
      default:
        throw new CliError(USAGE, 1);
    }
  } catch (err) {
    if (err instanceof PreflightError) {
      io.err(err.message);
      return 2;
    }
    if (err instanceof RecoveryError) {
      io.err(`recovery aborted: ${err.message}`);
      return 4;
    }
    if (err instanceof CliError) {
      io.err(err.message);
      return err.code;
    }
    if (err instanceof Error) {
      io.err(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.exitCode = runCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  });
}
