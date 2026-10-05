import { readFileSync, writeFileSync } from "node:fs";
import { Machine, validateMachine } from "./fsm.js";
import { minimize, NotFailingError } from "./reduce.js";
import { finalLine, headerLine, judgmentLine, replayTrace } from "./trace.js";

interface RunInput {
  machine: Machine;
  events: string[];
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  cli run <input.json> [--trace <trace.jsonl>]",
      "      input.json: { \"machine\": {states, initial, failureStates, transitions}, \"events\": [...] }",
      "  cli replay <trace.jsonl>",
      "      re-check every recorded judgment against the embedded machine",
    ].join("\n"),
  );
  process.exit(1);
}

function cmdRun(inputPath: string, tracePath: string): void {
  let input: RunInput;
  try {
    input = JSON.parse(readFileSync(inputPath, "utf8")) as RunInput;
  } catch (err) {
    console.error(`cannot read input ${inputPath}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!input.machine || !Array.isArray(input.events)) {
    console.error('input must contain "machine" and "events"');
    process.exit(1);
  }
  const errors = validateMachine(input.machine);
  if (errors.length > 0) {
    console.error("invalid machine:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const traceLines: string[] = [headerLine(input.machine, input.events)];
  try {
    const result = minimize(input.machine, input.events, (j) =>
      traceLines.push(judgmentLine(j)),
    );
    const accepted = result.judgments.filter((j) => j.accepted).length;
    traceLines.push(
      finalLine({
        kind: "final",
        reduced: result.reduced,
        oneMinimal: true,
        judgmentCount: result.judgments.length,
      }),
    );
    writeFileSync(tracePath, traceLines.join("\n") + "\n");
    console.log(`input:    [${input.events.join(" ")}] (${input.events.length} events)`);
    console.log(`reduced:  [${result.reduced.join(" ")}] (${result.reduced.length} events)`);
    console.log(`verdicts: ${result.judgments.length} judgments, ${accepted} deletions accepted`);
    console.log(`1-minimal: yes (${result.oneMinimalChecks.length} single-event deletions re-checked)`);
    console.log(`trace:    ${tracePath}`);
  } catch (err) {
    if (err instanceof NotFailingError) {
      traceLines.push(
        finalLine({
          kind: "final",
          reduced: [],
          oneMinimal: false,
          judgmentCount: traceLines.length - 1,
          error: err.message,
        }),
      );
      writeFileSync(tracePath, traceLines.join("\n") + "\n");
      console.error(`${err.message}; nothing to minimize (trace: ${tracePath})`);
      process.exit(2);
    }
    throw err;
  }
}

function cmdReplay(tracePath: string): void {
  let text: string;
  try {
    text = readFileSync(tracePath, "utf8");
  } catch (err) {
    console.error(`cannot read trace ${tracePath}: ${(err as Error).message}`);
    process.exit(1);
  }
  const report = replayTrace(text);
  if (!report.ok) {
    console.error("replay FAILED:");
    for (const m of report.mismatches) console.error(`  - ${m}`);
    process.exit(3);
  }
  console.log(`replay ok: ${report.judgmentCount} judgments reproduced`);
  console.log(`reduced:   [${(report.reduced ?? []).join(" ")}] (1-minimal: ${report.oneMinimal})`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "run") {
  const positional: string[] = [];
  let tracePath = "trace.jsonl";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--trace") {
      tracePath = rest[++i];
    } else {
      positional.push(rest[i]);
    }
  }
  if (positional.length !== 1) usage();
  cmdRun(positional[0], tracePath);
} else if (command === "replay") {
  if (rest.length !== 1) usage();
  cmdReplay(rest[0]);
} else {
  usage();
}
