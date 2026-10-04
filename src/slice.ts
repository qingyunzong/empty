/**
 * Minimal dynamic event slicing.
 *
 * Given a target output event, compute the smallest set of trace events
 * that reproduces it:
 *  - data dependence: backward scan; the last *executed* write of a needed
 *    variable is kept, which kills (overwrites) every older write to that
 *    variable -- stale writes that no longer contribute are dropped;
 *  - control dependence: the `if` predicates governing any kept event are
 *    kept (transitively), and their condition variables become needed.
 *
 * The result contains decision events only (const/compute/if/output);
 * else/end markers are structural and re-attached by projectMask().
 */

import { analyze, eventReads, eventWrites, replay, TraceEvent } from "./trace";

export function dynamicSlice(trace: TraceEvent[], target: number): Set<number> {
  const structure = analyze(trace);
  const run = replay(trace);
  const targetEv = trace[target];
  if (!targetEv || targetEv.op !== "output") {
    throw new Error(`event ${target} is not an output event`);
  }
  if (!run.executed[target]) {
    throw new Error(`output event ${target} was never executed`);
  }

  const needed = new Set<string>(); // variables whose value is still demanded
  const mustControl = new Set<number>(); // if-events required as controllers
  const included = new Set<number>();
  const include = (i: number): void => {
    included.add(i);
    for (const c of structure.controllers[i]) mustControl.add(c);
  };

  include(target);
  for (const v of eventReads(targetEv)) needed.add(v);

  for (let i = trace.length - 1; i >= 0; i--) {
    const ev = trace[i];
    if (ev.op === "if") {
      if (mustControl.has(i)) {
        mustControl.delete(i);
        include(i);
        needed.add(ev.cond);
      }
      continue;
    }
    if (ev.op === "else" || ev.op === "end" || ev.op === "output") continue;
    if (!run.executed[i]) continue; // dynamic: only executed writes count
    const out = eventWrites(ev);
    if (out === null || !needed.has(out)) continue;
    needed.delete(out); // overwrite: older writes to `out` no longer contribute
    include(i);
    for (const v of eventReads(ev)) needed.add(v);
  }
  return included;
}
