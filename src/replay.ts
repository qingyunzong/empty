import { Criterion, Event, State, Value } from './model';

export interface ReplayResult {
  executed: number[];
  decisions: Map<number, boolean>;
  finalState: State;
  watchValue: Value | undefined;
  watchExecuted: boolean;
}

export function replay(
  trace: Event[],
  keep: ReadonlySet<number> | null,
  initial: State,
  watch?: Criterion,
): ReplayResult {
  const state: State = new Map(initial);
  const decisions = new Map<number, boolean>();
  const executed: number[] = [];
  let watchValue: Value | undefined;
  let watchExecuted = false;
  for (const e of trace) {
    const kept = keep === null || keep.has(e.id);
    let allowed = kept;
    if (allowed) {
      for (const dep of e.controlDeps) {
        if (decisions.get(dep.on) !== dep.when) {
          allowed = false;
          break;
        }
      }
    }
    if (allowed) {
      if (e.kind === 'branch') {
        decisions.set(e.id, e.decide!(state));
      } else {
        const out = e.apply!(state);
        for (const k of Object.keys(out)) state.set(k, out[k]!);
      }
      executed.push(e.id);
      if (watch && e.id === watch.event) watchExecuted = true;
    }
    if (watch && e.id === watch.event) watchValue = state.get(watch.var);
  }
  return { executed, decisions, finalState: state, watchValue, watchExecuted };
}

export function valueAt(trace: Event[], keep: ReadonlySet<number> | null, criterion: Criterion, initial: State): Value | undefined {
  return replay(trace, keep, initial, criterion).watchValue;
}
