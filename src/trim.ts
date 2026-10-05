/**
 * Shortest-error extraction: a violation found anywhere in an equivalence
 * class is trimmed to the happens-before past of its violating event
 * (program order plus dependent cross-thread events). Replaying exactly
 * that past still triggers the violation, and because happens-before is
 * invariant across the class, the minimum over all explored classes is the
 * globally shortest failing history.
 */
import { Instr, Program } from './model';
import { dependent } from './state';

export function trimFailingTrace(program: Program, tids: number[]): number[] {
  const last = tids.length - 1;
  const pcs = program.threads.map(() => 0);
  const instrs: Instr[] = tids.map(tid => program.threads[tid].instrs[pcs[tid]++]);

  const needed = new Array<boolean>(tids.length).fill(false);
  needed[last] = true;
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = last; j >= 0; j--) {
      if (!needed[j]) continue;
      for (let i = 0; i < j; i++) {
        if (needed[i]) continue;
        if (tids[i] === tids[j] || dependent(instrs[i], instrs[j])) {
          needed[i] = true;
          changed = true;
        }
      }
    }
  }
  return tids.filter((_, i) => needed[i]);
}
