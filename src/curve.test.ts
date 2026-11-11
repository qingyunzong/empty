import assert from "node:assert/strict";
import test from "node:test";

import { HermiteCurve, type HermiteKeyframe } from "./curve.js";

const EPS = 1e-10;

function close(actual: number, expected: number, tolerance = EPS): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `期望 ${expected}，实际 ${actual}，容差 ${tolerance}`,
  );
}

function closeSample(
  actual: { value: number; derivative: number },
  expected: { value: number; derivative: number },
  tolerance = EPS,
): void {
  close(actual.value, expected.value, tolerance);
  close(actual.derivative, expected.derivative, tolerance);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCurve(random: () => number, count: number): HermiteCurve {
  const keyframes: HermiteKeyframe[] = [];
  let time = random() * 2;
  for (let i = 0; i < count; i++) {
    keyframes.push({
      time,
      value: random() * 20 - 10,
      tangent: random() * 6 - 3,
    });
    time += 0.5 + random() * 2.5;
  }
  return new HermiteCurve(keyframes);
}

test("构造：时间非严格递增、缺端点、非有限值均拒绝", () => {
  assert.throws(
    () => new HermiteCurve([{ time: 0, value: 0, tangent: 0 }]),
    RangeError,
  );
  assert.throws(
    () =>
      new HermiteCurve([
        { time: 0, value: 0, tangent: 0 },
        { time: 0, value: 1, tangent: 0 },
      ]),
    RangeError,
  );
  assert.throws(
    () =>
      new HermiteCurve([
        { time: 1, value: 0, tangent: 0 },
        { time: 0, value: 1, tangent: 0 },
      ]),
    RangeError,
  );
  assert.throws(
    () =>
      new HermiteCurve([
        { time: 0, value: Number.NaN, tangent: 0 },
        { time: 1, value: 1, tangent: 0 },
      ]),
    RangeError,
  );
});

test("端点处精确返回给定的值与切线", () => {
  const curve = new HermiteCurve([
    { time: 1, value: 2, tangent: 3 },
    { time: 4, value: -5, tangent: -6 },
    { time: 9, value: 7, tangent: 8 },
  ]);
  closeSample(curve.sample(1), { value: 2, derivative: 3 });
  closeSample(curve.sample(4), { value: -5, derivative: -6 });
  closeSample(curve.sample(9), { value: 7, derivative: 8 });
});

test("切线取段斜率时段内为线性函数，导数为常数斜率", () => {
  const curve = new HermiteCurve([
    { time: 0, value: 0, tangent: 5 },
    { time: 2, value: 10, tangent: 5 },
  ]);
  for (const t of [0, 0.25, 0.75, 1, 1.5, 2]) {
    close(curve.value(t), 5 * t);
    close(curve.derivative(t), 5);
  }
});

test("零切线端点仍为三次曲线，端点精确返回给定切线 0", () => {
  const curve = new HermiteCurve([
    { time: 0, value: 0, tangent: 0 },
    { time: 2, value: 10, tangent: 0 },
  ]);
  closeSample(curve.sample(0), { value: 0, derivative: 0 });
  closeSample(curve.sample(2), { value: 10, derivative: 0 });
  close(curve.value(1), 5);
  assert.ok(Math.abs(curve.derivative(1)) > 0);
});

test("解析导数与有限差分一致", () => {
  const curve = randomCurve(mulberry32(42), 5);
  const h = 1e-6;
  for (let i = 0; i < 50; i++) {
    const time = curve.domainStart + Math.random() * (curve.domainEnd - curve.domainStart);
    const numeric = (curve.value(time + h) - curve.value(time - h)) / (2 * h);
    close(curve.derivative(time), numeric, 1e-5);
  }
});

test("常量延伸：值冻结、导数为 0，负时间同样适用", () => {
  const curve = new HermiteCurve([
    { time: 0, value: 1, tangent: 2 },
    { time: 10, value: 4, tangent: 5 },
  ]);
  for (const t of [-100, -1, 0]) {
    closeSample(curve.sample(t), t === 0 ? { value: 1, derivative: 2 } : { value: 1, derivative: 0 });
  }
  for (const t of [10.01, 50]) {
    closeSample(curve.sample(t), { value: 4, derivative: 0 });
  }
});

test("循环：周期边界取右极限，负时间按数学取模", () => {
  const curve = new HermiteCurve(
    [
      { time: 2, value: 1, tangent: 2 },
      { time: 7, value: 4, tangent: 5 },
      { time: 12, value: -3, tangent: -2 },
    ],
    { pre: "cycle", post: "cycle" },
  );
  const period = 10;

  closeSample(curve.sample(12 + period), curve.sample(2));
  closeSample(curve.sample(2 - period), curve.sample(2));

  for (const t of [-8, -18, 22, 32]) {
    const phase = ((t - 2) % period + period) % period;
    closeSample(curve.sample(t), curve.sample(2 + phase));
  }
});

test("往返：反向段导数反号、值镜像，折返点为常量不反号", () => {
  const curve = new HermiteCurve(
    [
      { time: 0, value: 0, tangent: 1 },
      { time: 5, value: 3, tangent: -2 },
      { time: 10, value: 8, tangent: 4 },
    ],
    { pre: "pingpong", post: "pingpong" },
  );

  for (const time of [0.5, 2.3, 7.7, 9.2]) {
    const forward = curve.sample(time);
    const mirrored = curve.sample(20 - time);
    close(mirrored.value, forward.value);
    close(mirrored.derivative, -forward.derivative);
  }

  const atFold = curve.sample(10);
  close(atFold.value, 8);
  close(atFold.derivative, 4);

  const outerFold = curve.sample(30);
  close(outerFold.value, 8);
  close(outerFold.derivative, -4);

  const negativeFold = curve.sample(-10);
  close(negativeFold.value, 8);
  close(negativeFold.derivative, -4);
});

test("裁剪：新端点保持原值与一阶导数，内部拼接点 C1 连续", () => {
  const curve = randomCurve(mulberry32(7), 6);
  const start = curve.domainStart + 1.3;
  const end = curve.domainEnd - 0.9;
  const clipped = curve.trim(start, end);

  closeSample(clipped.sample(start), curve.sample(start));
  closeSample(clipped.sample(end), curve.sample(end));

  for (let i = 0; i <= 200; i++) {
    const time = start + ((end - start) * i) / 200;
    closeSample(clipped.sample(time), curve.sample(time), 1e-9);
  }

  for (const keyframe of curve.keyframes) {
    if (keyframe.time > start && keyframe.time < end) {
      closeSample(clipped.sample(keyframe.time), curve.sample(keyframe.time));
    }
  }
});

test("裁剪结果是真正的分段三次曲线，而非采样折线", () => {
  const curve = new HermiteCurve([
    { time: 0, value: 0, tangent: 10 },
    { time: 10, value: 10, tangent: -10 },
  ]);
  const clipped = curve.trim(2.5, 7.5);
  const h = 1e-6;
  const mid = 5;
  const numeric =
    (clipped.value(mid + h) - 2 * clipped.value(mid) + clipped.value(mid - h)) /
    (h * h);
  assert.ok(Math.abs(numeric) > 1e-3, "折线二阶导数为 0，Hermite 曲线应具有非零曲率");
});

test("零长度裁剪：单点保留值与导数，区间外常量延伸导数为 0", () => {
  const curve = randomCurve(mulberry32(99), 4);
  const time = (curve.domainStart + curve.domainEnd) / 2;
  const expected = curve.sample(time);
  const point = curve.trim(time, time);

  assert.equal(point.domainStart, time);
  assert.equal(point.domainEnd, time);
  closeSample(point.sample(time), expected);
  closeSample(point.sample(time - 0.01), { value: expected.value, derivative: 0 });
  closeSample(point.sample(time + 100), { value: expected.value, derivative: 0 });
  assert.throws(() => point.trim(time, time + 1), RangeError);
});

test("裁剪可组合：二次裁剪等价于对原曲线直接裁剪", () => {
  const curve = randomCurve(mulberry32(123), 7);
  const a = curve.domainStart + 2;
  const b = curve.domainEnd - 1;
  const once = curve.trim(a, b);
  const c = a + (b - a) * 0.25;
  const d = a + (b - a) * 0.75;
  const twice = once.trim(c, d);

  for (let i = 0; i <= 100; i++) {
    const time = c + ((d - c) * i) / 100;
    closeSample(twice.sample(time), curve.sample(time), 1e-9);
  }
});

test("随机区间对照：裁剪端点与内部随机点均与原曲线一致", () => {
  const random = mulberry32(20261111);
  for (let trial = 0; trial < 40; trial++) {
    const curve = randomCurve(random, 2 + Math.floor(random() * 6));
    const span = curve.domainEnd - curve.domainStart;
    const a = curve.domainStart + random() * span * 0.9;
    const b = a + random() * (curve.domainEnd - a);
    const clipped = curve.trim(a, b);

    closeSample(clipped.sample(a), curve.sample(a));
    closeSample(clipped.sample(b), curve.sample(b));

    for (let i = 0; i < 25; i++) {
      const time = a + random() * (b - a);
      closeSample(clipped.sample(time), curve.sample(time), 1e-9);
    }
  }
});

test("裁剪后的曲线仍支持循环与往返延伸", () => {
  const curve = randomCurve(mulberry32(555), 5);
  const clipped = curve.trim(
    curve.domainStart + 1,
    curve.domainEnd - 1,
    { pre: "cycle", post: "pingpong" },
  );
  const period = clipped.domainEnd - clipped.domainStart;
  closeSample(
    clipped.sample(clipped.domainEnd + period),
    clipped.sample(clipped.domainStart),
  );
  const forward = clipped.sample(clipped.domainStart + period * 0.3);
  const reverse = clipped.sample(clipped.domainEnd + period * 0.7);
  close(reverse.value, forward.value, 1e-9);
  close(reverse.derivative, -forward.derivative, 1e-9);
});
