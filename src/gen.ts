import { Event, State, Value } from './model';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Generated {
  trace: Event[];
  initial: State;
}

export function genTrace(seed: number, n: number): Generated {
  const rng = mulberry32(seed);
  const vars = ['a', 'b', 'c', 'd'];
  const initial: State = new Map(vars.map((v) => [v, v as Value]));
  const state: State = new Map(initial);
  const trace: Event[] = [];
  const branches: { id: number; decision: boolean }[] = [];
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  for (let i = 0; i < n; i++) {
    const roll = rng();
    if (roll < 0.2 && i > 0) {
      const v = pick(vars);
      const recorded = state.get(v)!;
      const onMatch = rng() < 0.5;
      const e: Event = {
        id: i,
        kind: 'branch',
        reads: [v],
        writes: [],
        controlDeps: [],
        decide: (s) => (s.get(v) === recorded) === onMatch,
      };
      branches.push({ id: i, decision: e.decide!(state) });
      trace.push(e);
    } else {
      const readCount = rng() < 0.5 ? 1 : 2;
      const shuffled = [...vars].sort(() => rng() - 0.5);
      const reads = shuffled.slice(0, readCount);
      const write = pick(vars);
      const controlDeps: { on: number; when: boolean }[] = [];
      if (branches.length > 0 && rng() < 0.4) {
        const b = pick(branches);
        controlDeps.push({ on: b.id, when: b.decision });
      }
      const tag = `e${i}`;
      const e: Event = {
        id: i,
        kind: 'assign',
        reads,
        writes: [write],
        controlDeps,
        apply: (s) => ({ [write]: `${tag}(${reads.map((r) => s.get(r)!).join(',')})` }),
      };
      const out = e.apply!(state);
      for (const k of Object.keys(out)) state.set(k, out[k]!);
      trace.push(e);
    }
  }
  return { trace, initial };
}

export function allCriteria(trace: Event[], initial: State): { event: number; var: string }[] {
  const out: { event: number; var: string }[] = [];
  const seen = new Set<string>();
  const add = (event: number, v: string): void => {
    const key = `${event}:${v}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ event, var: v });
    }
  };
  for (const e of trace) {
    for (const w of e.writes) add(e.id, w);
  }
  if (trace.length > 0) {
    const last = trace[trace.length - 1]!.id;
    for (const v of initial.keys()) add(last, v);
  }
  return out;
}
