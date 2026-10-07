import { readFileSync } from "node:fs";
import { ProgramDef, Snapshot, runProgram, validateProgram } from "./simulator";
import { MAX_EXPLORE_STEPS, explore, sequentialReference, sequentialSchedule, verify } from "./explore";

function loadProgram(path: string): ProgramDef {
  return validateProgram(JSON.parse(readFileSync(path, "utf8")));
}

function parseSchedule(raw: string): number[] {
  if (raw.trim() === "") return [];
  return raw.split(",").map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0) throw new Error(`bad schedule entry "${part}"`);
    return n;
  });
}

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function printSnapshot(snap: Snapshot): void {
  console.log(`steps=${snap.steps} allDone=${snap.allDone} deadlocked=${snap.deadlocked}`);
  console.log("  shared state:");
  for (const [name, value] of Object.entries(snap.shared)) console.log(`    ${name} = ${value}`);
  console.log("  lock table:");
  const lockNames = Object.entries(snap.locks);
  if (lockNames.length === 0) console.log("    (no mutexes)");
  for (const [name, holder] of lockNames) {
    console.log(`    ${name}: ${holder === null ? "free" : `held by T${holder}`}`);
  }
  console.log("  threads:");
  snap.threads.forEach((t, i) => {
    console.log(`    T${i}: pc=${t.pc} status=${t.status} locals=${JSON.stringify(t.locals)}`);
  });
}

const USAGE = `Usage:
  node dist/src/cli.js run <program.json> [--schedule 0,1,0,...]
  node dist/src/cli.js explore <program.json> [--max-steps N]   (N in 1..${MAX_EXPLORE_STEPS})
  node dist/src/cli.js verify <program.json> [--max-steps N]
  node dist/src/cli.js sequential <program.json>`;

function main(argv: string[]): void {
  const [command, programPath, ...rest] = argv;
  if (!command || !programPath || command === "help" || command === "--help") {
    console.log(USAGE);
    process.exitCode = command ? 0 : 1;
    return;
  }
  const program = loadProgram(programPath);

  switch (command) {
    case "run": {
      const scheduleArg = getFlag(rest, "--schedule");
      const schedule = scheduleArg !== undefined
        ? parseSchedule(scheduleArg)
        : sequentialSchedule(program);
      const result = runProgram(program, schedule);
      result.trace.forEach((snap, i) => {
        console.log(`--- step ${i}${i > 0 ? ` (ran T${schedule[i - 1]})` : ""} ---`);
        printSnapshot(snap);
      });
      console.log(`outcome: ${result.outcome}`);
      if (result.outcome === "deadlock") process.exitCode = 2;
      break;
    }
    case "explore": {
      const maxSteps = parseMaxSteps(getFlag(rest, "--max-steps"));
      const result = explore(program, { maxSteps });
      console.log(`explored ${result.statesVisited} states (maxSteps=${result.maxSteps}, truncated=${result.truncated})`);
      console.log(`terminals: ${result.terminals.length} done, ${result.deadlocks.length} deadlock, ${result.cutoffCount} cutoff`);
      console.log("result set (final shared state + lock table):");
      for (const entry of result.resultSet) {
        console.log(`  ${entry.key}`);
        for (const ex of entry.examples) console.log(`    e.g. schedule [${ex.join(",")}]`);
      }
      for (const dl of result.deadlocks) {
        console.log(`deadlock via schedule [${dl.schedule.join(",")}]:`);
        printSnapshot(dl.snapshot);
      }
      break;
    }
    case "verify": {
      const maxSteps = parseMaxSteps(getFlag(rest, "--max-steps"));
      const result = explore(program, { maxSteps });
      const report = verify(program, result);
      for (const check of report.checks) {
        console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
      }
      console.log(report.ok ? "verification OK" : "verification FAILED");
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case "sequential": {
      const result = sequentialReference(program);
      console.log(`outcome: ${result.outcome}`);
      printSnapshot(result.final);
      break;
    }
    default:
      console.error(`unknown command "${command}"`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

function parseMaxSteps(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_EXPLORE_STEPS) {
    throw new Error(`--max-steps must be an integer in [1, ${MAX_EXPLORE_STEPS}]`);
  }
  return n;
}

main(process.argv.slice(2));
