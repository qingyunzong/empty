import { Board } from "./board.ts";
import { simulate } from "./moves.ts";
import { staticUpperBound, type SolveResult } from "./search.ts";
import { stateKey } from "./state.ts";
import type { Action, Vec } from "./types.ts";

export interface Certificate {
  version: 1;
  optimal: number;
  safetyUpperBound: number;
  totalEnemies: number;
  landings: Vec[];
  actions: Action[];
  finalStateKey: string;
  statesExplored: number;
  proved: boolean;
}

export function buildCertificate(board: Board, result: SolveResult): Certificate {
  const sim = simulate(board, result.actions);
  return {
    version: 1,
    optimal: result.captures,
    safetyUpperBound: staticUpperBound(board, board.initialState()),
    totalEnemies: board.totalEnemies,
    landings: result.landings,
    actions: result.actions,
    finalStateKey: stateKey(sim.state),
    statesExplored: result.statesExplored,
    proved: result.proved,
  };
}

export function verifyCertificate(
  board: Board,
  cert: Certificate
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (cert.totalEnemies > 12) problems.push("totalEnemies exceeds 12");
  if (cert.optimal > cert.safetyUpperBound) {
    problems.push(`optimal ${cert.optimal} exceeds safety upper bound ${cert.safetyUpperBound}`);
  }
  let sim;
  try {
    sim = simulate(board, cert.actions);
  } catch (err) {
    problems.push(`replay failed: ${(err as Error).message}`);
    return { ok: false, problems };
  }
  if (sim.captures !== cert.optimal) {
    problems.push(`replay captures ${sim.captures} != certified ${cert.optimal}`);
  }
  if (JSON.stringify(sim.landings) !== JSON.stringify(cert.landings)) {
    problems.push("replay landings differ from certificate");
  }
  if (stateKey(sim.state) !== cert.finalStateKey) {
    problems.push("final state key mismatch");
  }
  return { ok: problems.length === 0, problems };
}
