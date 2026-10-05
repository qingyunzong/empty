import { Rat } from './rational';

export type Ease = (alpha: number) => number;
export const linear: Ease = (a) => a;
export const step: Ease = () => 0;
export const smooth: Ease = (a) => a * a * (3 - 2 * a);

export interface Key {
  t: Rat;
  v: number;
  /** Easing of the segment starting at this key. Defaults to linear. */
  ease?: Ease;
}

/** Piecewise interpolation over keyframes placed at exact rational times. */
export class Timeline {
  readonly keys: readonly Key[];
  readonly duration: Rat;

  constructor(keys: Key[]) {
    if (keys.length === 0) throw new Error('Timeline: need at least one keyframe');
    const sorted = [...keys].sort((x, y) => x.t.cmp(y.t));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].t.le(sorted[i - 1].t)) {
        throw new Error(`Timeline: keyframe times must be strictly increasing (${sorted[i].t})`);
      }
    }
    this.keys = sorted;
    this.duration = sorted[sorted.length - 1].t.sub(sorted[0].t);
  }

  /**
   * Value at local time `local`. Pure function of `local`: clamped to the
   * keyframe range, so any seek/jump evaluates identically to direct calls.
   */
  valueAt(local: Rat): number {
    const keys = this.keys;
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (local.le(first.t)) return first.v;
    if (local.ge(last.t)) return last.v;
    let lo = 0;
    let hi = keys.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keys[mid].t.le(local)) lo = mid; else hi = mid;
    }
    const k0 = keys[lo];
    const k1 = keys[hi];
    const alpha = local.sub(k0.t).div(k1.t.sub(k0.t)).toNumber();
    const eased = (k0.ease ?? linear)(alpha);
    return k0.v + (k1.v - k0.v) * eased;
  }
}
