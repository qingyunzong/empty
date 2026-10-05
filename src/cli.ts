import * as fs from "node:fs";
import * as path from "node:path";
import { applyMapping, recover, undo, verify } from "./ops.js";
import { buildPlan } from "./plan.js";
import { MappingFile } from "./types.js";

const USAGE = `photo-rename - batch photo renaming with preflight checks and crash-safe journaling

usage:
  photo-rename plan    <mapping.json> [--dir D] [--case-fold]   preflight + show plan (dry run)
  photo-rename apply   <mapping.json> [--dir D] [--case-fold]   preflight, journal, execute
  photo-rename recover [--dir D]                                resume an interrupted batch
  photo-rename undo    [--dir D]                                apply the inverse plan
  photo-rename verify  <mapping.json> [--dir D] [--case-fold]   check final state

mapping.json:
  { "caseFold": true, "renames": [ { "from": "a.jpg", "to": "b.jpg" } ] }

Name comparison follows the case-fold rule from the mapping file or --case-fold.
Any preflight conflict rejects the whole batch before anything is touched.
`;

interface Args {
  command: string;
  mappingPath: string | undefined;
  dir: string;
  caseFold: boolean;
}

function parseArgs(argv: string[], cwd: string): Args {
  const positional: string[] = [];
  let dir = cwd;
  let caseFold = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dir") dir = path.resolve(argv[++i] ?? "");
    else if (a === "--case-fold") caseFold = true;
    else if (a === "--help" || a === "-h") positional.unshift("help");
    else positional.push(a);
  }
  return { command: positional[0] ?? "help", mappingPath: positional[1], dir, caseFold };
}

function loadMapping(mappingPath: string): MappingFile {
  const text = fs.readFileSync(mappingPath, "utf8");
  const parsed = JSON.parse(text) as MappingFile;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.renames)) {
    throw new Error(`invalid mapping file: ${mappingPath}`);
  }
  return parsed;
}

/** Returns the process exit code. */
export function runCli(argv: string[], cwd: string): number {
  const args = parseArgs(argv, cwd);
  try {
    switch (args.command) {
      case "help":
        console.log(USAGE);
        return 0;
      case "plan": {
        const mapping = loadMapping(args.mappingPath ?? "");
        const caseFold = args.caseFold || mapping.caseFold === true;
        const plan = buildPlan(args.dir, mapping, caseFold);
        console.log(`preflight OK: ${plan.renames.length} rename(s), ${plan.steps.length} step(s)`);
        plan.steps.forEach((s, i) => {
          console.log(`  ${i}: ${s.from} -> ${s.to}${s.temp ? "  (temporary)" : ""}`);
        });
        return 0;
      }
      case "apply": {
        const mapping = loadMapping(args.mappingPath ?? "");
        const caseFold = args.caseFold || mapping.caseFold === true;
        const result = applyMapping(args.dir, mapping, caseFold);
        console.log(`applied ${result.applied} step(s); batch complete`);
        return 0;
      }
      case "recover": {
        const result = recover(args.dir);
        if (result.status === "no-journal") console.log("no journal found; nothing to recover");
        else if (result.status === "already-complete") console.log("plan already complete; nothing to do");
        else console.log(`recovered: applied ${result.applied}, reconciled ${result.recovered}, skipped ${result.skipped}`);
        return 0;
      }
      case "undo": {
        const result = undo(args.dir);
        if (result.status === "nothing-to-undo") console.log("no completed plan to undo");
        else if (result.status === "already-undone") console.log("inverse plan already applied");
        else console.log(`undone: applied ${result.applied} of ${result.inverseSteps} inverse step(s)`);
        return 0;
      }
      case "verify": {
        const mapping = loadMapping(args.mappingPath ?? "");
        const caseFold = args.caseFold || mapping.caseFold === true;
        const problems = verify(args.dir, mapping, caseFold);
        if (problems.length === 0) {
          console.log("verify OK");
          return 0;
        }
        for (const p of problems) console.error(`  - ${p}`);
        return 1;
      }
      default:
        console.error(`unknown command: ${args.command}\n`);
        console.error(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const invokedAs = process.argv[1] ?? "";
if (invokedAs.endsWith("cli.js")) {
  process.exitCode = runCli(process.argv.slice(2), process.cwd());
}
