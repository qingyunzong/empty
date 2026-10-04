import { Criterion, Event } from './model';

export function dynamicSlice(trace: Event[], criterion: Criterion): Set<number> {
  const lastWriterBefore = (v: string, beforeId: number): number => {
    for (let i = beforeId - 1; i >= 0; i--) {
      if (trace[i]!.writes.includes(v)) return i;
    }
    return -1;
  };
  const slice = new Set<number>();
  const work: number[] = [];
  const push = (id: number): void => {
    if (!slice.has(id)) {
      slice.add(id);
      work.push(id);
    }
  };
  const seed = lastWriterBefore(criterion.var, criterion.event + 1);
  if (seed >= 0) push(seed);
  while (work.length > 0) {
    const e = trace[work.pop()!]!;
    for (const v of e.reads) {
      const w = lastWriterBefore(v, e.id);
      if (w >= 0) push(w);
    }
    for (const dep of e.controlDeps) push(dep.on);
  }
  return slice;
}
