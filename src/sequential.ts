import { Instruction, SimResult, Simulator } from './simulator';
import { enumerateSchedules, resultKey } from './exhaustive';

const SEQUENTIAL_STEP_LIMIT = 10000;

export function runSequential(
  programs: Instruction[][],
  initialShared: Record<string, number> = {},
): SimResult {
  const sim = new Simulator(programs, initialShared);
  let executed = 0;
  for (let t = 0; t < programs.length; t++) {
    while (!sim.threads[t]!.done) {
      if (!sim.isRunnable(t) || executed >= SEQUENTIAL_STEP_LIMIT) return sim.result();
      sim.step(t);
      executed++;
    }
  }
  return sim.result();
}

export interface SequentialVerification {
  sequential: SimResult;
  contained: boolean;
  resultCount: number;
}

export function verifySequential(
  programs: Instruction[][],
  initialShared: Record<string, number> = {},
  maxSteps = 20,
): SequentialVerification {
  const sequential = runSequential(programs, initialShared);
  const report = enumerateSchedules(programs, initialShared, maxSteps);
  return {
    sequential,
    contained: report.results.has(resultKey(sequential)),
    resultCount: report.results.size,
  };
}
