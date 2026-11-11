/**
 * 三次 Hermite 曲线组件。
 *
 * 每段曲线由两个端点的时间、值与一阶导数（切线）唯一确定，
 * 区间裁剪通过在裁剪点重新切分三次段实现，新端点严格保持原值与一阶导数，
 * 不使用采样折线近似。
 */

/** 区间外的延伸方式。 */
export type ExtrapolationType = "constant" | "cycle" | "pingpong";

/** 区间左、右两侧各自的延伸方式。 */
export interface Extrapolation {
  pre: ExtrapolationType;
  post: ExtrapolationType;
}

/** Hermite 端点：时间、值、该点处的一阶导数。 */
export interface HermiteKeyframe {
  time: number;
  value: number;
  tangent: number;
}

/** 一次求值的结果，值与一阶导数同时返回。 */
export interface Sample {
  value: number;
  derivative: number;
}

/** 可求值、可再次裁剪的曲线接口，裁剪结果同样实现该接口以便组合。 */
export interface Curve {
  readonly domainStart: number;
  readonly domainEnd: number;
  sample(time: number): Sample;
  value(time: number): number;
  derivative(time: number): number;
  trim(start: number, end: number, options?: Partial<Extrapolation>): Curve;
}

interface Segment {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
  m0: number;
  m1: number;
}

const DEFAULT_EXTRAPOLATION: Extrapolation = { pre: "constant", post: "constant" };

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} 必须是有限数值，收到 ${String(value)}`);
  }
}

/** 数学定义的取模：结果恒为 [0, modulus)，负时间同样适用。 */
function flooredMod(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

/** 三次 Hermite 基函数在单个段上的求值，同时给出值与一阶导数。 */
function evaluateSegment(segment: Segment, time: number): Sample {
  const { t0, t1, p0, p1, m0, m1 } = segment;
  const dt = t1 - t0;
  const s = (time - t0) / dt;
  const s2 = s * s;
  const s3 = s2 * s;

  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;

  const value = h00 * p0 + h10 * (dt * m0) + h01 * p1 + h11 * (dt * m1);

  const l00 = 6 * s2 - 6 * s;
  const l10 = 3 * s2 - 4 * s + 1;
  const l01 = -6 * s2 + 6 * s;
  const l11 = 3 * s2 - 2 * s;
  const derivative =
    (l00 * p0 + l10 * (dt * m0) + l01 * p1 + l11 * (dt * m1)) / dt;

  return { value, derivative };
}

/**
 * 分段三次 Hermite 曲线。
 *
 * 端点时间必须严格递增；区间外可按常量、循环（周期取右极限）或
 * 往返（反向段导数反号）延伸，负时间按数学取模映射。
 */
export class HermiteCurve implements Curve {
  private readonly keyframesSnapshot: HermiteKeyframe[];
  private readonly segments: Segment[];
  private readonly startSample: Sample;
  private readonly endSample: Sample;

  readonly domainStart: number;
  readonly domainEnd: number;
  readonly extrapolation: Extrapolation;

  constructor(
    keyframes: readonly HermiteKeyframe[],
    extrapolation: Partial<Extrapolation> = {},
  ) {
    if (!Array.isArray(keyframes) || keyframes.length < 2) {
      throw new RangeError("至少需要两个端点才能构成 Hermite 曲线");
    }

    const snapshot: HermiteKeyframe[] = [];
    let previousTime = Number.NaN;
    for (const keyframe of keyframes) {
      assertFinite(keyframe.time, "端点时间");
      assertFinite(keyframe.value, "端点值");
      assertFinite(keyframe.tangent, "端点切线");
      if (snapshot.length > 0 && keyframe.time <= previousTime) {
        throw new RangeError("端点时间必须严格递增");
      }
      previousTime = keyframe.time;
      snapshot.push({ ...keyframe });
    }

    this.keyframesSnapshot = snapshot;
    this.domainStart = snapshot[0].time;
    this.domainEnd = snapshot[snapshot.length - 1].time;
    this.extrapolation = { ...DEFAULT_EXTRAPOLATION, ...extrapolation };

    this.segments = [];
    for (let i = 0; i < snapshot.length - 1; i++) {
      const a = snapshot[i];
      const b = snapshot[i + 1];
      this.segments.push({
        t0: a.time,
        t1: b.time,
        p0: a.value,
        p1: b.value,
        m0: a.tangent,
        m1: b.tangent,
      });
    }

    this.startSample = evaluateSegment(this.segments[0], this.domainStart);
    this.endSample = evaluateSegment(
      this.segments[this.segments.length - 1],
      this.domainEnd,
    );
  }

  /** 端点快照（副本，修改不影响曲线）。 */
  get keyframes(): HermiteKeyframe[] {
    return this.keyframesSnapshot.map((keyframe) => ({ ...keyframe }));
  }

  sample(time: number): Sample {
    assertFinite(time, "求值时间");
    if (time < this.domainStart) {
      return this.sampleOutside(time, this.extrapolation.pre, true);
    }
    if (time > this.domainEnd) {
      return this.sampleOutside(time, this.extrapolation.post, false);
    }
    return this.sampleInterior(time);
  }

  value(time: number): number {
    return this.sample(time).value;
  }

  derivative(time: number): number {
    return this.sample(time).derivative;
  }

  /**
   * 区间裁剪。裁剪点处按三次 Hermite 解析求值生成新端点，
   * 原值与一阶导数保持不变；原区间内部端点原样保留，拼接点 C1 连续。
   * 零长度区间退化为单点曲线：该点保留值与导数，其余位置常量延伸、导数为 0。
   */
  trim(start: number, end: number, options?: Partial<Extrapolation>): Curve {
    assertFinite(start, "裁剪起点");
    assertFinite(end, "裁剪终点");
    if (end < start) {
      throw new RangeError("裁剪终点不得早于起点");
    }

    if (end === start) {
      return new ConstantPointCurve(start, this.sample(start), options);
    }

    const clipped: HermiteKeyframe[] = [];
    const startSample = this.sample(start);
    clipped.push({
      time: start,
      value: startSample.value,
      tangent: startSample.derivative,
    });

    for (const keyframe of this.keyframesSnapshot) {
      if (keyframe.time > start && keyframe.time < end) {
        clipped.push({ ...keyframe });
      }
    }

    const endSample = this.sample(end);
    clipped.push({
      time: end,
      value: endSample.value,
      tangent: endSample.derivative,
    });

    return new HermiteCurve(clipped, options);
  }

  private sampleInterior(time: number): Sample {
    if (time === this.domainEnd) {
      return evaluateSegment(
        this.segments[this.segments.length - 1],
        time,
      );
    }
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.segments[middle].t0 <= time) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return evaluateSegment(this.segments[low], time);
  }

  private sampleOutside(
    time: number,
    type: ExtrapolationType,
    before: boolean,
  ): Sample {
    if (type === "constant") {
      const boundary = before ? this.startSample : this.endSample;
      return { value: boundary.value, derivative: 0 };
    }

    const period = this.domainEnd - this.domainStart;

    if (type === "cycle") {
      const phase = flooredMod(time - this.domainStart, period);
      return this.sampleInterior(this.domainStart + phase);
    }

    const fullSpan = 2 * period;
    const phase = flooredMod(time - this.domainStart, fullSpan);
    if (phase < period) {
      return this.sampleInterior(this.domainStart + phase);
    }
    const reverseSample = this.sampleInterior(
      this.domainStart + (fullSpan - phase),
    );
    return { value: reverseSample.value, derivative: -reverseSample.derivative };
  }
}

/** 零长度裁剪产生的单点曲线。 */
class ConstantPointCurve implements Curve {
  readonly domainStart: number;
  readonly domainEnd: number;
  readonly extrapolation: Extrapolation;
  private readonly point: Sample;

  constructor(
    time: number,
    point: Sample,
    options?: Partial<Extrapolation>,
  ) {
    this.domainStart = time;
    this.domainEnd = time;
    this.point = { ...point };
    this.extrapolation = { ...DEFAULT_EXTRAPOLATION, ...options };
  }

  sample(time: number): Sample {
    assertFinite(time, "求值时间");
    if (time === this.domainStart) {
      return { ...this.point };
    }
    return { value: this.point.value, derivative: 0 };
  }

  value(time: number): number {
    return this.sample(time).value;
  }

  derivative(time: number): number {
    return this.sample(time).derivative;
  }

  trim(start: number, end: number, options?: Partial<Extrapolation>): Curve {
    assertFinite(start, "裁剪起点");
    assertFinite(end, "裁剪终点");
    if (start !== this.domainStart || end !== this.domainStart) {
      throw new RangeError("单点曲线只能在其唯一端点处做零长度裁剪");
    }
    return new ConstantPointCurve(this.domainStart, this.point, options);
  }
}
