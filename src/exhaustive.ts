import { Instruction, SimResult, Simulator } from './simulator';

export interface ExhaustiveReport {
  maxSteps: number;
  exploredStates: number;
  results: Map<string, SimResult>;
}

export function resultKey(result: SimResult): string {
  return JSON.stringify(result);
}

function stateKey(sim: Simulator): string {
  return JSON.stringify({
    steps: sim.steps,
    shared: sim.shared,
    locks: sim.locks,
    threads: sim.threads.map((t) => [t.pc, t.locals, t.done]),
  });
}

export function enumerateSchedules(
  programs: Instruction[][],
  initialShared: Record<string, number> = {},
  maxSteps = 20,
): ExhaustiveReport {
  const results = new Map<string, SimResult>();
  const visited = new Set<string>();
  let exploredStates = 0;

  function dfs(sim: Simulator): void {
    const key = stateKey(sim);
    if (visited.has(key)) return;
    visited.add(key);
    exploredStates++;
    if (sim.status() !== 'running' || sim.steps >= maxSteps) {
      const result = sim.result();
      results.set(resultKey(result), result);
      return;
    }
    for (let t = 0; t < sim.programs.length; t++) {
      if (!sim.isRunnable(t)) continue;
      const next = sim.clone();
      next.step(t);
      dfs(next);
    }
  }

  dfs(new Simulator(programs, initialShared));
  return { maxSteps, exploredStates, results };
}
