import { readFileSync, writeFileSync } from 'node:fs';
import { parsePuzzle, Puzzle } from './model.js';
import { Engine } from './engine.js';
import { Solver, Checkpoint, SearchResult } from './solver.js';
import { bfsStateSpace, exhaustiveSearch } from './brute.js';
import { buildCertificate, verifyCertificate, replay, safeUpperBound } from './certificate.js';
import { renderBoard, describeMove } from './render.js';

export const USAGE = `jump-capture-solver - custom jump-capture board puzzle solver

usage:
  cli.js solve  <puzzle.json> [--cert out.json] [--checkpoint cp.json]
                [--max-pops N] [--save-interval N] [--quiet]
  cli.js resume <checkpoint.json> [--cert out.json] [--max-pops N] [--quiet]
  cli.js verify <puzzle.json> [--max-visits N] [--max-states N]
  cli.js check  <puzzle.json>

commands:
  solve    find the optimal move sequence (max captures, then smallest
           jump-landing sequence), printing the board after every step
  resume   continue a paused search from a checkpoint file
  verify   cross-check the solver against full state-space BFS and, for
           small boards, exhaustive memo-free enumeration
  check    validate a puzzle file only
`;

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

interface Args {
  cmd: string | undefined;
  positional: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const [cmd, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (name === 'quiet') {
        bools.add(name);
      } else {
        const v = rest[++i];
        if (v === undefined) throw new Error(`missing value for --${name}`);
        flags.set(name, v);
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags, bools };
}

function loadPuzzle(path: string): Puzzle {
  return parsePuzzle(JSON.parse(readFileSync(path, 'utf8')));
}

function intFlag(args: Args, name: string, def: number): number {
  const v = args.flags.get(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function printSolution(io: CliIO, engine: Engine, result: SearchResult, quiet: boolean): void {
  if (!quiet) {
    const states = replay(engine, result.moves);
    io.out('initial board:');
    io.out(renderBoard(engine, states[0]!));
    result.moves.forEach((m, i) => {
      io.out(`\nstep ${i + 1}: ${describeMove(engine, m)}`);
      io.out(renderBoard(engine, states[i + 1]!));
    });
    io.out('');
  }
  const landings = result.jumpSeq.map((c) => `(${engine.xy(c).join(',')})`).join(' ');
  io.out(`optimal captures : ${result.captures}`);
  io.out(`safe upper bound : ${safeUpperBound(engine)}`);
  io.out(`jump landings    : ${landings === '' ? '(none)' : landings}`);
  io.out(`total moves      : ${result.moves.length}`);
}

function writeCert(io: CliIO, args: Args, engine: Engine, result: SearchResult, solver: Solver): void {
  const certPath = args.flags.get('cert');
  if (certPath === undefined) return;
  const cert = buildCertificate(engine, result, { ...solver.stats, memoSize: solver.memo.size });
  const check = verifyCertificate(engine, cert);
  if (!check.ok) throw new Error(`internal certificate check failed: ${check.problems.join('; ')}`);
  const out = JSON.stringify(cert, null, 2);
  if (certPath === '-') io.out(out);
  else {
    writeFileSync(certPath, out + '\n');
    io.out(`certificate written to ${certPath} (self-check passed)`);
  }
}

function runSolver(io: CliIO, solver: Solver, engine: Engine, args: Args): void {
  const maxPops = intFlag(args, 'max-pops', Infinity);
  const quiet = args.bools.has('quiet');
  const cpPath = args.flags.get('checkpoint');
  const saveInterval = intFlag(args, 'save-interval', 65536);
  let lastSave = -1;
  const onProgress =
    cpPath === undefined
      ? undefined
      : (s: Solver) => {
          if (s.stats.pops !== lastSave) {
            lastSave = s.stats.pops;
            writeFileSync(cpPath, JSON.stringify(s.toCheckpoint()));
          }
        };
  const result = solver.run(maxPops, onProgress, cpPath === undefined ? 0 : saveInterval);
  if (cpPath !== undefined) writeFileSync(cpPath, JSON.stringify(solver.toCheckpoint()));
  if (result === null) {
    io.out(
      `paused after ${solver.stats.pops} finalized states` +
        (cpPath === undefined ? '' : `; checkpoint saved to ${cpPath}`),
    );
    return;
  }
  if (!quiet) {
    io.out(
      `search stats: states finalized=${solver.stats.pops} memo hits=${solver.stats.memoHits} ` +
        `cycle skips=${solver.stats.cycleSkips} max depth=${solver.stats.maxDepth}`,
    );
  }
  printSolution(io, engine, result, quiet);
  writeCert(io, args, engine, result, solver);
}

function cmdVerify(io: CliIO, args: Args): number {
  const file = args.positional[0];
  if (file === undefined) throw new Error('verify requires a puzzle file');
  const maxVisits = intFlag(args, 'max-visits', 2_000_000);
  const maxStates = intFlag(args, 'max-states', 5_000_000);
  const engine = new Engine(loadPuzzle(file));

  const solver = new Solver(engine);
  const result = solver.run()!;

  const bfs = bfsStateSpace(engine, maxStates);
  let failed = false;
  io.out(`solver    : captures=${result.captures} (states finalized=${solver.stats.pops})`);
  io.out(`bfs       : captures=${bfs.maxCaptures} (reachable states=${bfs.states})`);
  if (result.captures !== bfs.maxCaptures) {
    io.out('MISMATCH between solver and BFS state-space search');
    failed = true;
  }
  try {
    const ex = exhaustiveSearch(engine, maxVisits);
    const same =
      ex.result.captures === result.captures &&
      JSON.stringify(ex.result.jumpSeq) === JSON.stringify(result.jumpSeq) &&
      ex.result.moves.length === result.moves.length;
    io.out(
      `exhaustive: captures=${ex.result.captures} visits=${ex.visits} ` +
        `(jump sequence ${same ? 'matches' : 'MISMATCHES'} solver)`,
    );
    if (!same) failed = true;
  } catch (e) {
    io.out(`exhaustive: skipped (${(e as Error).message})`);
  }
  io.out(failed ? 'verify: FAILED' : 'verify: OK');
  return failed ? 1 : 0;
}

function cmdCheck(io: CliIO, args: Args): number {
  const file = args.positional[0];
  if (file === undefined) throw new Error('check requires a puzzle file');
  const puzzle = loadPuzzle(file);
  io.out(
    `valid puzzle: ${puzzle.width}x${puzzle.height}, ` +
      `${puzzle.enemies.length} enemies, ${puzzle.obstacles.length} obstacles, ` +
      `toggle=${puzzle.toggle === null ? 'no' : 'yes'}, ` +
      `${puzzle.directions.length} directions` +
      (puzzle.altDirections === null ? '' : `, ${puzzle.altDirections.length} alt directions`),
  );
  return 0;
}

/** Programmatic CLI entry. Returns the process exit code. */
export function runCli(argv: string[], io: CliIO): number {
  try {
    const args = parseArgs(argv);
    switch (args.cmd) {
      case 'solve': {
        const file = args.positional[0];
        if (file === undefined) throw new Error('solve requires a puzzle file');
        const engine = new Engine(loadPuzzle(file));
        runSolver(io, new Solver(engine), engine, args);
        return 0;
      }
      case 'resume': {
        const file = args.positional[0];
        if (file === undefined) throw new Error('resume requires a checkpoint file');
        const cp = JSON.parse(readFileSync(file, 'utf8')) as Checkpoint;
        const solver = Solver.fromCheckpoint(cp);
        runSolver(io, solver, solver.engine, args);
        return 0;
      }
      case 'verify':
        return cmdVerify(io, args);
      case 'check':
        return cmdCheck(io, args);
      case undefined:
      case 'help':
      case '--help':
        io.out(USAGE);
        return 0;
      default:
        io.err(`unknown command: ${args.cmd}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}
