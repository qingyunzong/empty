import { readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { parseFsm, canonicalJson, type Fsm } from "./fsm.js";
import { replay, type Verdict } from "./oracle.js";
import { minimize, verifyOneMinimal } from "./minimize.js";
import { TraceRecorder } from "./trace.js";

const USAGE = `Usage: node dist/src/cli.js --fsm <fsm.json> --events <events.json> [--trace <trace.jsonl>]

  --fsm     FSM table JSON: { "initial": string, "failureStates": string[],
            "transitions": { state: { event: nextState } } }
  --events  Failing event history: JSON array of strings, or { "events": [...] }
  --trace   Judgment trace output path (default: trace.jsonl)

Exit codes: 0 = minimized OK, 1 = usage/IO/validation error,
            2 = input history does not reproduce a failure.`;

interface CliArgs {
  fsmPath: string;
  eventsPath: string;
  tracePath: string;
}

function parseArgs(args: string[]): CliArgs | null {
  let fsmPath: string | null = null;
  let eventsPath: string | null = null;
  let tracePath = "trace.jsonl";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--help" || flag === "-h") {
      writeSync(1, `${USAGE}\n`);
      return null;
    } else if (flag === "--fsm" && value !== undefined) {
      fsmPath = value;
      i++;
    } else if (flag === "--events" && value !== undefined) {
      eventsPath = value;
      i++;
    } else if (flag === "--trace" && value !== undefined) {
      tracePath = value;
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${String(flag)}`);
    }
  }
  if (fsmPath === null || eventsPath === null) {
    throw new Error("--fsm and --events are required");
  }
  return { fsmPath, eventsPath, tracePath };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read/parse ${path}: ${(err as Error).message}`);
  }
}

function parseEvents(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).events)
      ? ((raw as Record<string, unknown>).events as unknown[])
      : null;
  if (list === null || list.some((e) => typeof e !== "string")) {
    throw new Error("events file must be a JSON array of strings or { \"events\": [...] }");
  }
  return list as string[];
}

export function run(args: string[]): number {
  const parsed = parseArgs(args);
  if (parsed === null) return 0;
  const { fsmPath, eventsPath, tracePath } = parsed;

  const fsmRaw = readJson(fsmPath);
  const fsm: Fsm = parseFsm(fsmRaw);
  const events = parseEvents(readJson(eventsPath));
  const fsmHash = createHash("sha256").update(canonicalJson(fsmRaw)).digest("hex");

  const trace = new TraceRecorder(tracePath);
  let testId = 0;
  const oracle = (seq: readonly string[]): Verdict => {
    const verdict = replay(fsm, seq).verdict;
    testId++;
    trace.record({ type: "test", id: testId, sequence: seq, verdict });
    return verdict;
  };

  trace.record({
    type: "config",
    algorithm: "contiguous-block-ddmin",
    fsmSha256: fsmHash,
    input: events,
  });

  const inputVerdict = oracle(events);
  if (inputVerdict !== "fail") {
    const reason =
      inputVerdict === "invalid"
        ? "input history is illegal for this FSM (not a failure)"
        : "input history does not reach a failure state";
    trace.record({ type: "result", error: reason });
    writeSync(2, `error: ${reason}\n`);
    return 2;
  }

  const minimized = minimize(events, oracle);

  const violations = verifyOneMinimal(
    minimized,
    (seq) => replay(fsm, seq).verdict,
    (removedIndex, removedEvent, verdict) => {
      testId++;
      trace.record({ type: "verify", id: testId, removedIndex, removedEvent, verdict });
    }
  );
  const oneMinimal = violations.length === 0;

  trace.record({
    type: "result",
    inputLength: events.length,
    outputLength: minimized.length,
    minimized,
    totalTests: testId,
    oneMinimal,
  });

  if (!oneMinimal) {
    writeSync(2, "error: internal check failed, result is not 1-minimal\n");
    return 1;
  }

  writeSync(1, `minimized (${events.length} -> ${minimized.length} events, ${testId} oracle tests):\n`);
  writeSync(1, `${JSON.stringify(minimized)}\n`);
  writeSync(1, `trace written to ${tracePath}\n`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    writeSync(2, `error: ${(err as Error).message}\n\n${USAGE}\n`);
    process.exitCode = 1;
  }
}
