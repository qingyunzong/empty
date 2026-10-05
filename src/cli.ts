import { readFileSync, writeFileSync } from "node:fs";
import { buildGraph } from "./graph.js";
import { deterministicOrder, enumerateOrders, OrderResult } from "./topo.js";
import {
  computeOrder,
  DepAddition,
  fromSnapshot,
  initialState,
  publish,
  revise,
  RevisionBatch,
  State,
  toSnapshot,
} from "./state.js";
import { LogEvent, validateEvent } from "./types.js";

const USAGE = `Usage:
  cli order <log.jsonl> [--enumerate] [--snapshot <file>]
      Compute the deterministic causal order of a JSONL event log.
      Prints { order, candidates, diagnostics, enumeration? }.
  cli revise <snapshot.json> <batch.jsonl> --out <snapshot.json>
      Apply a revision batch incrementally. The published prefix is fixed;
      if new dependencies require inverting it, the whole batch is rejected
      (exit code 2) and the shortest conflict chain(s) are printed.
  cli publish <snapshot.json> <count> --out <snapshot.json>
      Publish the next <count> events of the computed order (extends the
      fixed prefix) and write the new snapshot.
  cli show <snapshot.json> [--enumerate]
      Print the current order and diagnostics of a snapshot.

Event line format:   {"id":"a1","source":"A","seq":1,"ts":100,"deps":["b1"]}
Batch line formats:  same as event, or {"addDep":{"id":"a1","dep":"b2"}}
Exit codes: 0 ok, 1 error, 2 revision rejected.`;

function readJsonl(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.trim().length > 0)
    .map(({ l, i }) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        throw new Error(`${path}:${i + 1}: invalid JSON`);
      }
    });
}

function parseEvents(rows: unknown[], what: string): LogEvent[] {
  return rows.map((r, i) => validateEvent(r, `${what} line ${i + 1}`));
}

function parseBatch(rows: unknown[]): RevisionBatch {
  const events: LogEvent[] = [];
  const addDeps: DepAddition[] = [];
  rows.forEach((row, i) => {
    if (typeof row === "object" && row !== null && "addDep" in row) {
      const ad = (row as Record<string, unknown>).addDep;
      if (typeof ad !== "object" || ad === null) {
        throw new Error(`batch line ${i + 1}: addDep must be an object`);
      }
      const { id, dep } = ad as Record<string, unknown>;
      if (typeof id !== "string" || typeof dep !== "string") {
        throw new Error(`batch line ${i + 1}: addDep.id and addDep.dep must be strings`);
      }
      addDeps.push({ id, dep });
    } else {
      events.push(validateEvent(row, `batch line ${i + 1}`));
    }
  });
  return { events, addDeps };
}

function takeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], opt: string): string | undefined {
  const i = args.indexOf(opt);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined) throw new Error(`missing value for ${opt}`);
  args.splice(i, 2);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function orderPayload(res: OrderResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    order: res.order,
    candidates: res.candidates,
    diagnostics: res.diagnostics,
  };
  return out;
}

function withEnumeration(
  out: Record<string, unknown>,
  state: State,
  res: OrderResult,
  force: boolean
): Record<string, unknown> {
  const emittable = res.order.length;
  if (!force && emittable > 10) return out;
  if (Object.keys(res.diagnostics.missing).length > 0) {
    out.enumeration = { skipped: "missing dependencies present" };
    return out;
  }
  const g = buildGraph(state.events.values());
  const en = enumerateOrders(g);
  out.enumeration = {
    count: en.count,
    truncated: en.truncated,
    matchesLexMin: JSON.stringify(en.best) === JSON.stringify(res.order),
  };
  return out;
}

function cmdOrder(args: string[]): number {
  const enumerate = takeFlag(args, "--enumerate");
  const snapshotPath = takeOption(args, "--snapshot");
  const [file] = args;
  if (!file) throw new Error("order: missing <log.jsonl>");
  const events = parseEvents(readJsonl(file), file);
  const state = initialState(events);
  const res = computeOrder(state);
  print(withEnumeration(orderPayload(res), state, res, enumerate));
  if (snapshotPath) {
    writeFileSync(snapshotPath, JSON.stringify(toSnapshot(state), null, 2) + "\n");
  }
  return 0;
}

function cmdRevise(args: string[]): number {
  const outPath = takeOption(args, "--out");
  const [snapPath, batchPath] = args;
  if (!snapPath || !batchPath) throw new Error("revise: missing <snapshot.json> or <batch.jsonl>");
  if (!outPath) throw new Error("revise: missing --out <snapshot.json>");
  const state = fromSnapshot(JSON.parse(readFileSync(snapPath, "utf8")));
  const batch = parseBatch(readJsonl(batchPath));
  const res = revise(state, batch);
  if (!res.ok) {
    print({ rejected: true, conflicts: res.conflicts });
    return 2;
  }
  writeFileSync(outPath, JSON.stringify(toSnapshot(res.state), null, 2) + "\n");
  print({
    rejected: false,
    order: res.order.order,
    candidates: res.order.candidates,
    diagnostics: res.order.diagnostics,
  });
  return 0;
}

function cmdPublish(args: string[]): number {
  const outPath = takeOption(args, "--out");
  const [snapPath, countStr] = args;
  if (!snapPath || countStr === undefined) throw new Error("publish: missing <snapshot.json> or <count>");
  if (!outPath) throw new Error("publish: missing --out <snapshot.json>");
  const n = Number(countStr);
  const state = fromSnapshot(JSON.parse(readFileSync(snapPath, "utf8")));
  const next = publish(state, n);
  writeFileSync(outPath, JSON.stringify(toSnapshot(next), null, 2) + "\n");
  const res = computeOrder(next);
  print({
    published: next.published,
    order: res.order,
    candidates: res.candidates,
    diagnostics: res.diagnostics,
  });
  return 0;
}

function cmdShow(args: string[]): number {
  const enumerate = takeFlag(args, "--enumerate");
  const [snapPath] = args;
  if (!snapPath) throw new Error("show: missing <snapshot.json>");
  const state = fromSnapshot(JSON.parse(readFileSync(snapPath, "utf8")));
  const res = computeOrder(state);
  print(
    withEnumeration(
      { published: state.published, ...orderPayload(res) },
      state,
      res,
      enumerate
    )
  );
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "order":
      return cmdOrder(rest);
    case "revise":
      return cmdRevise(rest);
    case "publish":
      return cmdPublish(rest);
    case "show":
      return cmdShow(rest);
    default:
      console.error(USAGE);
      return cmd === undefined ? 1 : 1;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
