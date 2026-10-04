import { Criterion, Event, State, Value } from './model';
import { valueAt } from './replay';

export interface ReplayCheck {
  ok: boolean;
  expected: Value | undefined;
  actual: Value | undefined;
}

export function verifySliceReplay(
  trace: Event[],
  slice: ReadonlySet<number>,
  criterion: Criterion,
  initial: State,
): ReplayCheck {
  const expected = valueAt(trace, null, criterion, initial);
  const actual = valueAt(trace, slice, criterion, initial);
  return { ok: expected === actual, expected, actual };
}

export interface MinimalityReport {
  ok: boolean;
  mode: 'exhaustive' | 'single-removal' | 'trivial';
  checked: number;
  counterexample?: number[];
}

export function checkMinimality(
  trace: Event[],
  slice: ReadonlySet<number>,
  criterion: Criterion,
  initial: State,
  exhaustiveLimit = 12,
): MinimalityReport {
  const ids = [...slice].sort((a, b) => a - b);
  if (ids.length === 0) return { ok: true, mode: 'trivial', checked: 0 };
  const expected = valueAt(trace, null, criterion, initial);
  const breaks = (subset: Set<number>): boolean => valueAt(trace, subset, criterion, initial) !== expected;
  if (ids.length <= exhaustiveLimit) {
    const full = (1 << ids.length) - 1;
    let checked = 0;
    for (let mask = 0; mask < full; mask++) {
      const subset = new Set<number>();
      for (let bit = 0; bit < ids.length; bit++) {
        if (mask & (1 << bit)) subset.add(ids[bit]!);
      }
      checked++;
      if (!breaks(subset)) {
        return { ok: false, mode: 'exhaustive', checked, counterexample: [...subset].sort((a, b) => a - b) };
      }
    }
    return { ok: true, mode: 'exhaustive', checked };
  }
  let checked = 0;
  for (const drop of ids) {
    const subset = new Set(ids.filter((id) => id !== drop));
    checked++;
    if (!breaks(subset)) {
      return { ok: false, mode: 'single-removal', checked, counterexample: [...subset].sort((a, b) => a - b) };
    }
  }
  return { ok: true, mode: 'single-removal', checked };
}
