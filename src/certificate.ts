import { createHash } from 'node:crypto';
import { Engine, GameState, Move } from './engine.js';
import { canonicalPuzzleJson } from './model.js';
import { SearchResult, SolverStats } from './solver.js';

/**
 * Safe (admissible) upper bound on captures from a state.
 * An enemy on cell e can only ever be captured if for some direction d of
 * EITHER direction set both e-d (take-off) and e+d (landing) are in-bounds
 * cells. Enemies failing this necessary condition can never be captured, so
 * counting the others is a valid upper bound (<= total enemies).
 */
export function safeUpperBound(engine: Engine, state?: GameState): number {
  const dirs = engine.allDirs();
  let bound = 0;
  engine.enemyCells.forEach((c, i) => {
    if (state !== undefined && (state.enemies & (1 << i)) === 0) return;
    const [x, y] = engine.xy(c);
    for (const d of dirs) {
      if (engine.inBounds(x - d.dx, y - d.dy) && engine.inBounds(x + d.dx, y + d.dy)) {
        bound++;
        return;
      }
    }
  });
  return bound;
}

export interface MoveJson {
  kind: 'jump' | 'push';
  from: [number, number];
  to: [number, number];
  captured?: [number, number];
  obstacleFrom?: [number, number];
  obstacleTo?: [number, number];
}

export interface Certificate {
  version: 1;
  puzzleHash: string;
  optimalCaptures: number;
  safeUpperBound: number;
  totalEnemies: number;
  jumpSequence: [number, number][];
  moves: MoveJson[];
  finalState: GameState;
  stats: SolverStats & { memoSize: number };
  stepHashes: string[];
  method: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function puzzleHash(engine: Engine): string {
  return sha256(canonicalPuzzleJson(engine.puzzle));
}

export function moveToJson(engine: Engine, m: Move): MoveJson {
  const j: MoveJson = { kind: m.kind, from: engine.xy(m.from), to: engine.xy(m.to) };
  if (m.captured !== undefined) j.captured = engine.xy(m.captured);
  if (m.obstacleFrom !== undefined) j.obstacleFrom = engine.xy(m.obstacleFrom);
  if (m.obstacleTo !== undefined) j.obstacleTo = engine.xy(m.obstacleTo);
  return j;
}

/**
 * Replay a move list from the initial state, checking every move is legal.
 * Returns the per-step states (including the initial state at index 0).
 */
export function replay(engine: Engine, moves: Move[]): GameState[] {
  const states: GameState[] = [engine.initialState()];
  for (const m of moves) {
    const s = states[states.length - 1]!;
    const legal = engine.genMoves(s);
    const ok = legal.some(
      (lm) =>
        lm.kind === m.kind &&
        lm.from === m.from &&
        lm.to === m.to &&
        lm.captured === m.captured &&
        lm.obstacleFrom === m.obstacleFrom &&
        lm.obstacleTo === m.obstacleTo,
    );
    if (!ok) throw new Error(`illegal move in sequence: ${JSON.stringify(m)}`);
    states.push(engine.apply(s, m));
  }
  return states;
}

export function buildCertificate(
  engine: Engine,
  result: SearchResult,
  stats: SolverStats & { memoSize: number },
): Certificate {
  const states = replay(engine, result.moves);
  const stepHashes = states.map((s) => sha256(engine.key(s)));
  return {
    version: 1,
    puzzleHash: puzzleHash(engine),
    optimalCaptures: result.captures,
    safeUpperBound: safeUpperBound(engine),
    totalEnemies: engine.enemyCells.length,
    jumpSequence: result.jumpSeq.map((c) => engine.xy(c)),
    moves: result.moves.map((m) => moveToJson(engine, m)),
    finalState: states[states.length - 1]!,
    stats,
    stepHashes,
    method:
      'exhaustive DFS over the full state space with memoization ' +
      '(objective: max captures, then min jump-landing sequence, then min moves)',
  };
}

export interface CertCheck {
  ok: boolean;
  problems: string[];
}

/** Self-contained verification of a certificate against a puzzle. */
export function verifyCertificate(engine: Engine, cert: Certificate): CertCheck {
  const problems: string[] = [];
  if (cert.puzzleHash !== puzzleHash(engine)) problems.push('puzzle hash mismatch');
  if (cert.safeUpperBound > cert.totalEnemies) problems.push('bound exceeds total enemies');
  if (cert.optimalCaptures > cert.safeUpperBound) problems.push('optimum exceeds safe upper bound');
  let states: GameState[] = [];
  try {
    // rebuild Move objects from JSON
    const moves: Move[] = cert.moves.map((mj) => ({
      kind: mj.kind,
      from: mj.from[1] * engine.w + mj.from[0],
      dir: { dx: 0, dy: 0 },
      to: mj.to[1] * engine.w + mj.to[0],
      captured: mj.captured === undefined ? undefined : mj.captured[1] * engine.w + mj.captured[0],
      obstacleFrom:
        mj.obstacleFrom === undefined ? undefined : mj.obstacleFrom[1] * engine.w + mj.obstacleFrom[0],
      obstacleTo:
        mj.obstacleTo === undefined ? undefined : mj.obstacleTo[1] * engine.w + mj.obstacleTo[0],
    }));
    states = replay(engine, moves);
    const jumps = moves.filter((m) => m.kind === 'jump').length;
    if (jumps !== cert.optimalCaptures) problems.push('capture count does not match moves');
    const final = states[states.length - 1]!;
    if (engine.key(final) !== engine.key(cert.finalState)) problems.push('final state mismatch');
    const hashes = states.map((s) => sha256(engine.key(s)));
    if (JSON.stringify(hashes) !== JSON.stringify(cert.stepHashes)) problems.push('step hash chain mismatch');
  } catch (e) {
    problems.push(`replay failed: ${(e as Error).message}`);
  }
  return { ok: problems.length === 0, problems };
}
