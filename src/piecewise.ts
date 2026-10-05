import type { Rational } from "./rational.ts";

export interface Breakpoint {
  readonly t: Rational;
  readonly v: Rational;
}

export class PiecewiseLinear {
  readonly points: readonly Breakpoint[];

  constructor(points: readonly Breakpoint[]) {
    if (points.length < 2) {
      throw new Error("PiecewiseLinear needs at least 2 breakpoints");
    }
    for (let i = 1; i < points.length; i++) {
      if (points[i].t.le(points[i - 1].t)) {
        throw new Error("breakpoints must be strictly increasing in time");
      }
    }
    this.points = points.map((p) => ({ t: p.t, v: p.v }));
  }

  get start(): Rational {
    return this.points[0].t;
  }

  get end(): Rational {
    return this.points[this.points.length - 1].t;
  }

  segmentIndexAt(t: Rational): number {
    if (t.le(this.start)) return 0;
    for (let i = 0; i < this.points.length - 1; i++) {
      if (t.lt(this.points[i + 1].t)) return i;
    }
    return this.points.length - 2;
  }

  slopeOfSegment(index: number): Rational {
    const a = this.points[index];
    const b = this.points[index + 1];
    return b.v.sub(a.v).div(b.t.sub(a.t));
  }

  slopeAt(t: Rational): Rational {
    return this.slopeOfSegment(this.segmentIndexAt(t));
  }

  valueAt(t: Rational): Rational {
    const index = this.segmentIndexAt(t);
    const a = this.points[index];
    return a.v.add(this.slopeOfSegment(index).mul(t.sub(a.t)));
  }

  nextBreakpointAfter(t: Rational): Rational | null {
    for (const p of this.points) {
      if (p.t.gt(t)) return p.t;
    }
    return null;
  }
}
