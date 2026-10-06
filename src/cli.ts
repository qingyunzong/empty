import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Board } from "./board.ts";
import { buildCertificate, verifyCertificate } from "./certificate.ts";
import { applyAction, generateActions } from "./moves.ts";
import { describeAction, renderBoard } from "./render.ts";
import { LimitExceededError, Solver } from "./search.ts";
import type { BestLine, BoardSpec } from "./types.ts";

export interface CliIO {
  log(msg: string): void;
  error(msg: string): void;
}

const consoleIO: CliIO = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

interface CliArgs {
  puzzle: string;
  maxStates?: number;
  snapshot?: string;
  resume?: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { json: false };
  const rest = [...argv];
  while (rest.length > 0) {
    const a = rest.shift() as string;
    if (a === "--max-states") args.maxStates = Number(rest.shift());
    else if (a === "--snapshot") args.snapshot = rest.shift();
    else if (a === "--resume") args.resume = rest.shift();
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (args.puzzle === undefined) args.puzzle = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (args.puzzle === undefined) {
    throw new Error(
      "usage: cli.js <puzzle.json> [--max-states N] [--snapshot FILE] [--resume FILE] [--json]"
    );
  }
  return args as CliArgs;
}

interface Snapshot {
  version: 1;
  spec: BoardSpec;
  explored: number;
  memo: [string, BestLine][];
}

function writeSnapshot(path: string, spec: BoardSpec, solver: Solver): void {
  const snap: Snapshot = {
    version: 1,
    spec,
    explored: solver.explored,
    memo: [...solver.memo.entries()],
  };
  writeFileSync(path, JSON.stringify(snap, null, 2));
}

function loadSnapshot(path: string, spec: BoardSpec): Map<string, BestLine> {
  const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  if (snap.version !== 1) throw new Error("unsupported snapshot version");
  if (JSON.stringify(snap.spec) !== JSON.stringify(spec)) {
    throw new Error("snapshot spec does not match puzzle");
  }
  return new Map(snap.memo);
}

export function runCli(argv: string[], io: CliIO = consoleIO): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.error((err as Error).message);
    return 1;
  }

  let spec: BoardSpec;
  let board: Board;
  try {
    spec = JSON.parse(readFileSync(args.puzzle, "utf8")) as BoardSpec;
    board = new Board(spec);
  } catch (err) {
    io.error(`invalid puzzle: ${(err as Error).message}`);
    return 1;
  }

  let memo: Map<string, BestLine> | undefined;
  if (args.resume !== undefined) {
    try {
      memo = loadSnapshot(args.resume, spec);
    } catch (err) {
      io.error(`cannot resume: ${(err as Error).message}`);
      return 1;
    }
  }

  const solver = new Solver(board, { maxStates: args.maxStates, memo });
  let result;
  try {
    result = solver.solve();
  } catch (err) {
    if (err instanceof LimitExceededError) {
      if (args.snapshot !== undefined) {
        writeSnapshot(args.snapshot, spec, solver);
        io.error(
          `state limit ${err.limit} exceeded after ${solver.explored} states; snapshot saved to ${args.snapshot}`
        );
      } else {
        io.error(`state limit ${err.limit} exceeded; rerun with --snapshot to save progress`);
      }
      return 2;
    }
    throw err;
  }

  if (args.snapshot !== undefined) writeSnapshot(args.snapshot, spec, solver);

  const cert = buildCertificate(board, result);
  const check = verifyCertificate(board, cert);
  if (!check.ok) {
    io.error(`certificate self-check failed: ${check.problems.join("; ")}`);
    return 1;
  }

  if (args.json) {
    io.log(JSON.stringify(cert, null, 2));
    return 0;
  }

  io.log(
    `board ${board.width}x${board.height}, enemies=${board.totalEnemies}, ` +
      `obstacles=${spec.obstacles?.length ?? 0}, toggle=${board.toggle ? "yes" : "no"}` +
      `${board.toggle ? ` (${board.toggleOnce ? "once" : "flip"})` : ""}`
  );
  io.log(
    `optimal captures: ${cert.optimal} (safety upper bound: ${cert.safetyUpperBound}, ` +
      `states explored: ${cert.statesExplored}, proved: ${cert.proved})`
  );
  io.log(
    `landing sequence: ${cert.landings.map((v) => `(${v[0]},${v[1]})`).join(" -> ") || "(none)"}`
  );
  io.log("");

  let state = board.initialState();
  io.log("initial:");
  io.log(renderBoard(board, state));
  let captureNo = 0;
  cert.actions.forEach((action, i) => {
    if (action.kind === "jump") captureNo += 1;
    const legal = generateActions(board, state).some(
      (x) => JSON.stringify(x) === JSON.stringify(action)
    );
    if (!legal) throw new Error("internal error: illegal replay");
    state = applyAction(board, state, action);
    io.log("");
    io.log(`step ${i + 1}: ${describeAction(action, captureNo)}`);
    io.log(renderBoard(board, state));
  });

  io.log("");
  io.log("certificate:");
  io.log(JSON.stringify(cert, null, 2));
  return 0;
}

const invokedAsScript = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  process.exitCode = runCli(process.argv.slice(2));
}
