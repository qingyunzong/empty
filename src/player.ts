import { Rat } from './rational';
import { Timeline } from './timeline';

export type Mode = 'once' | 'loop' | 'pingpong';
export type Dir = 'forward' | 'backward';

export interface Marker {
  name: string;
  /** Local time, must satisfy 0 <= t <= duration. */
  t: Rat;
}

export interface Fired {
  name: string;
  /** Absolute (unrolled) time at which the crossing happened. */
  at: Rat;
  /** Direction of local-time motion through the marker. */
  dir: Dir;
}

/**
 * Map absolute time to local timeline time.
 *  - once:     clamp to [0, D]
 *  - loop:     t mod D, result in [0, D)  (exact multiples of D map to 0)
 *  - pingpong: m = t mod 2D; local = m if m <= D else 2D - m
 *              (turning point m == D belongs to the forward half)
 * Negative absolute times clamp to 0.
 */
export function mapTime(mode: Mode, t: Rat, dur: Rat): Rat {
  if (t.le(Rat.zero) || dur.isZero()) return Rat.zero;
  if (mode === 'once') return t.ge(dur) ? dur : t;
  if (mode === 'loop') return t.sub(dur.mul(Rat.of(t.divFloor(dur))));
  const period = dur.mul(Rat.of(2n));
  const m = t.sub(period.mul(Rat.of(t.divFloor(period))));
  return m.le(dur) ? m : period.sub(m);
}

/**
 * Interval model for event crossings on the step a -> b (a != b):
 *  - forward step:  a marker fires when its unrolled hit time h satisfies a < h <= b
 *  - backward step: b <= h < a
 * Hits are emitted in order of travel; ties broken by marker index.
 * Reported direction = sign(step) * localSlope(hit):
 *  - loop: local slope is always +1, so direction equals the step direction
 *  - pingpong: slope +1 on the forward half, -1 on the backward half;
 *    turning points fire once per pass (m == D keeps slope +1, m == 0 keeps slope -1)
 */
export function crossings(
  mode: Mode,
  markers: readonly Marker[],
  dur: Rat,
  a: Rat,
  b: Rat,
): Fired[] {
  if (a.eq(b) || markers.length === 0) return [];
  const fwd = b.gt(a);
  const lo = fwd ? a : b;
  const hi = fwd ? b : a;
  const stepSign = fwd ? 1 : -1;
  const hits: { at: Rat; slope: 1 | -1; idx: number }[] = [];

  const inRange = (at: Rat): boolean =>
    fwd ? at.gt(lo) && at.le(hi) : at.ge(lo) && at.lt(hi);

  markers.forEach((mk, idx) => {
    const m = mk.t;
    if (mode === 'once') {
      if (inRange(m)) hits.push({ at: m, slope: 1, idx });
      return;
    }
    if (dur.isZero()) return;
    if (mode === 'loop') {
      const k0 = lo.sub(m).divFloor(dur);
      const k1 = hi.sub(m).divFloor(dur) + 1n;
      for (let k = k0; k <= k1; k++) {
        const at = m.add(dur.mul(Rat.of(k)));
        if (inRange(at)) hits.push({ at, slope: 1, idx });
      }
      return;
    }
    // pingpong
    const period = dur.mul(Rat.of(2n));
    const series: { base: Rat; slope: 1 | -1 }[] =
      m.isZero()
        ? [{ base: Rat.zero, slope: -1 }]
        : m.eq(dur)
          ? [{ base: dur, slope: 1 }]
          : [
              { base: m, slope: 1 },
              { base: period.sub(m), slope: -1 },
            ];
    for (const { base, slope } of series) {
      const k0 = lo.sub(base).divFloor(period);
      const k1 = hi.sub(base).divFloor(period) + 1n;
      for (let k = k0; k <= k1; k++) {
        const at = base.add(period.mul(Rat.of(k)));
        if (inRange(at)) hits.push({ at, slope, idx });
      }
    }
  });

  hits.sort((x, y) => x.at.cmp(y.at) || x.idx - y.idx);
  if (!fwd) hits.reverse();
  return hits.map((h) => ({
    name: markers[h.idx].name,
    at: h.at,
    dir: stepSign * h.slope > 0 ? ('forward' as const) : ('backward' as const),
  }));
}

export interface PlayerOptions {
  mode?: Mode;
  markers?: Marker[];
  onEvent?: (f: Fired) => void;
}

/**
 * Playhead over a Timeline. `value()` is a pure function of the current
 * rational time, so arbitrary seeks and reverse playback always agree with
 * direct evaluation. `advance` fires marker crossings; `seek` never fires.
 */
export class Player {
  private t: Rat = Rat.zero;
  readonly mode: Mode;
  readonly markers: readonly Marker[];
  private readonly onEvent?: (f: Fired) => void;

  constructor(readonly timeline: Timeline, opts: PlayerOptions = {}) {
    this.mode = opts.mode ?? 'once';
    this.markers = opts.markers ?? [];
    this.onEvent = opts.onEvent;
    for (const mk of this.markers) {
      if (mk.t.lt(Rat.zero) || mk.t.gt(timeline.duration)) {
        throw new Error(`Player: marker "${mk.name}" at ${mk.t} outside [0, ${timeline.duration}]`);
      }
    }
  }

  get time(): Rat { return this.t; }

  value(): number {
    return this.timeline.valueAt(mapTime(this.mode, this.t, this.timeline.duration));
  }

  /** Jump to an absolute time without firing events. Negative clamps to 0. */
  seek(t: Rat): void {
    this.t = t.lt(Rat.zero) ? Rat.zero : t;
  }

  /**
   * Advance by a signed rational delta (negative = reverse playback).
   * Clamps at absolute time 0. Returns (and emits via onEvent) the markers
   * crossed during the step, each exactly once, in order of travel.
   */
  advance(delta: Rat): Fired[] {
    const from = this.t;
    let to = from.add(delta);
    if (to.lt(Rat.zero)) to = Rat.zero;
    this.t = to;
    const fired = crossings(this.mode, this.markers, this.timeline.duration, from, to);
    if (this.onEvent) for (const f of fired) this.onEvent(f);
    return fired;
  }
}
