import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DegenerateConicError,
  LineError,
  NotAnEllipseError,
  Rational,
  approxCoord,
  coordToString,
  intersectEllipseLine,
  ivWidth,
  makeInterval,
  verifyIntersection,
  type ConicInput,
  type IntersectionResult,
  type LineInput,
} from '../src/index.js';

const CIRCLE_5: ConicInput = { A: 1, B: 0, C: 1, D: 0, E: 0, F: -25 };
const UNIT_CIRCLE: ConicInput = { A: 1, B: 0, C: 1, D: 0, E: 0, F: -1 };
const ELLIPSE_2_1: ConicInput = { A: 1, B: 0, C: 4, D: 0, E: 0, F: -4 }; // x^2 + 4y^2 = 4

function secantOf(result: IntersectionResult) {
  assert.equal(result.kind, 'secant');
  if (result.kind !== 'secant') throw new Error('unreachable');
  return result;
}

// ---------------------------------------------------------------------------
// 已知切线验收 (acceptance against tangents constructed in closed form)
// ---------------------------------------------------------------------------

test('已知切线: 圆 x^2+y^2=25 在 (3,4) 处的切线 3x+4y=25', () => {
  const line: LineInput = { a: 3, b: 4, c: -25 };
  const res = intersectEllipseLine(CIRCLE_5, line);
  assert.equal(res.kind, 'tangent');
  if (res.kind !== 'tangent') return;
  assert.equal(res.point.x.toString(), '3');
  assert.equal(res.point.y.toString(), '4');
  assert.ok(verifyIntersection(CIRCLE_5, line, res));
});

test('已知切线: 椭圆 x^2+4y^2=4 在有理点 (6/5,4/5) 处的切线 3x+8y=10', () => {
  const line: LineInput = { a: 3, b: 8, c: -10 };
  const res = intersectEllipseLine(ELLIPSE_2_1, line);
  assert.equal(res.kind, 'tangent');
  if (res.kind !== 'tangent') return;
  assert.equal(res.point.x.toString(), '6/5');
  assert.equal(res.point.y.toString(), '4/5');
  assert.ok(verifyIntersection(ELLIPSE_2_1, line, res));
});

test('已知切线: 旋转椭圆 x^2+xy+y^2=1 在 (1,0) 处的切线 2x+y=2', () => {
  const conic: ConicInput = { A: 1, B: 1, C: 1, D: 0, E: 0, F: -1 };
  const line: LineInput = { a: 2, b: 1, c: -2 };
  const res = intersectEllipseLine(conic, line);
  assert.equal(res.kind, 'tangent');
  if (res.kind !== 'tangent') return;
  assert.equal(res.point.x.toString(), '1');
  assert.equal(res.point.y.toString(), '0');
  assert.ok(verifyIntersection(conic, line, res));
});

test('已知切线: 斜率构造 y = mx + sqrt(a^2 m^2 + b^2), 椭圆 16x^2+9y^2=144, m=1', () => {
  // a^2=9, b^2=16, m=1 => c = sqrt(9+16) = 5, tangency at (-a^2 m/c, b^2/c) = (-9/5, 16/5)
  const conic: ConicInput = { A: 16, B: 0, C: 9, D: 0, E: 0, F: -144 };
  const line: LineInput = { a: 1, b: -1, c: 5 };
  const res = intersectEllipseLine(conic, line);
  assert.equal(res.kind, 'tangent');
  if (res.kind !== 'tangent') return;
  assert.equal(res.point.x.toString(), '-9/5');
  assert.equal(res.point.y.toString(), '16/5');
  assert.ok(verifyIntersection(conic, line, res));
});

// ---------------------------------------------------------------------------
// 无交 / 两交点
// ---------------------------------------------------------------------------

test('无交: 单位圆与直线 x=5, 判别式为负', () => {
  const line: LineInput = { a: 1, b: 0, c: -5 };
  const res = intersectEllipseLine(UNIT_CIRCLE, line);
  assert.equal(res.kind, 'none');
  if (res.kind !== 'none') return;
  assert.ok(res.discriminant < 0n);
  assert.ok(verifyIntersection(UNIT_CIRCLE, line, res));
});

test('两交点(有理): 圆 x^2+y^2=25 与 y=3 交于 (±4,3)', () => {
  const line: LineInput = { a: 0, b: 1, c: -3 };
  const res = secantOf(intersectEllipseLine(CIRCLE_5, line));
  const [p0, p1] = res.points;
  // 有理坐标: q = 0, 区间退化为点
  assert.equal(p0.x.q, 0n);
  assert.equal(p1.x.q, 0n);
  assert.equal(Rational.make(p0.x.p, p0.x.r).toString(), '-4');
  assert.equal(Rational.make(p1.x.p, p1.x.r).toString(), '4');
  assert.equal(Rational.make(p0.y.p, p0.y.r).toString(), '3');
  assert.equal(p0.x.interval.lo.toString(), '-4');
  assert.equal(p0.x.interval.hi.toString(), '-4');
  assert.ok(verifyIntersection(CIRCLE_5, line, res));
});

test('两交点(无理): 单位圆与 y=1/2 交于 (±sqrt(3)/2, 1/2)', () => {
  const line: LineInput = { a: 0, b: 1, c: '-1/2' };
  const res = secantOf(intersectEllipseLine(UNIT_CIRCLE, line));
  assert.equal(res.discriminant, 48n);
  const [p0, p1] = res.points;

  // 代数表示: x = ±sqrt(3)/2, y = 1/2
  assert.equal(p0.x.p, 0n);
  assert.equal(p0.x.q, -1n);
  assert.equal(p0.x.r, 2n);
  assert.equal(p0.x.radicand, 3n);
  assert.equal(p1.x.q, 1n);
  assert.equal(coordToString(p1.x), '(sqrt(3))/2');
  assert.equal(p0.y.q, 0n);
  assert.equal(Rational.make(p0.y.p, p0.y.r).toString(), '1/2');

  // 隔离区间: 不相交、足够窄、包含真值
  assert.ok(p0.x.interval.hi.cmp(p1.x.interval.lo) < 0);
  const bound = Rational.from('1/1099511627776'); // 2^-40
  assert.ok(ivWidth(p0.x.interval).cmp(bound) < 0);
  assert.ok(ivWidth(p1.x.interval).cmp(bound) < 0);
  // 区间宽度 (2^-64) 已小于 double 精度, 用非严格比较 (舍入单调, 不会误判)
  const approx = Math.sqrt(3) / 2;
  assert.ok(p1.x.interval.lo.toNumber() <= approx && approx <= p1.x.interval.hi.toNumber());
  assert.ok(p0.x.interval.lo.toNumber() <= -approx && -approx <= p0.x.interval.hi.toNumber());
  assert.ok(Math.abs(approxCoord(p1.x) - approx) < 1e-12);

  assert.ok(verifyIntersection(UNIT_CIRCLE, line, res));
});

test('两交点(竖直直线): 椭圆 x^2+4y^2=4 与 x=1 交于 (1, ±sqrt(3)/2)', () => {
  const line: LineInput = { a: 1, b: 0, c: -1 };
  const res = secantOf(intersectEllipseLine(ELLIPSE_2_1, line));
  const [p0, p1] = res.points;
  assert.equal(res.quadratic.variable, 'y');
  assert.equal(p0.x.q, 0n);
  assert.equal(Rational.make(p0.x.p, p0.x.r).toString(), '1');
  assert.equal(p0.y.radicand, 3n);
  assert.equal(p0.y.q, -1n);
  assert.equal(p1.y.q, 1n);
  assert.equal(p0.y.r, 2n);
  assert.ok(verifyIntersection(ELLIPSE_2_1, line, res));
});

test('判别式平方因子约化: 单位圆与 y=x 交于 x=±sqrt(2)/2', () => {
  const line: LineInput = { a: 1, b: -1, c: 0 };
  const res = secantOf(intersectEllipseLine(UNIT_CIRCLE, line));
  assert.equal(res.discriminant, 8n);
  const [, p1] = res.points;
  // sqrt(8)/4 必须约化为 sqrt(2)/2
  assert.equal(p1.x.p, 0n);
  assert.equal(p1.x.q, 1n);
  assert.equal(p1.x.r, 2n);
  assert.equal(p1.x.radicand, 2n);
  assert.ok(verifyIntersection(UNIT_CIRCLE, line, res));
});

test('隔离区间宽度随迭代次数收缩', () => {
  const line: LineInput = { a: 0, b: 1, c: '-1/2' };
  const coarse = secantOf(intersectEllipseLine(UNIT_CIRCLE, line, { isolationIterations: 8 }));
  const fine = secantOf(intersectEllipseLine(UNIT_CIRCLE, line, { isolationIterations: 64 }));
  const wCoarse = ivWidth(coarse.points[1].x.interval);
  const wFine = ivWidth(fine.points[1].x.interval);
  assert.ok(wCoarse.cmp(wFine) > 0);
  assert.ok(wCoarse.cmp(Rational.from('1/100')) < 0);
});

// ---------------------------------------------------------------------------
// 退化椭圆 / 非椭圆拒绝
// ---------------------------------------------------------------------------

test('退化椭圆拒绝: 点椭圆 x^2+y^2=0', () => {
  const conic: ConicInput = { A: 1, B: 0, C: 1, D: 0, E: 0, F: 0 };
  assert.throws(() => intersectEllipseLine(conic, { a: 1, b: 1, c: 0 }), DegenerateConicError);
});

test('退化椭圆拒绝: 平行直线对 (x+y)^2=1', () => {
  const conic: ConicInput = { A: 1, B: 2, C: 1, D: 0, E: 0, F: -1 };
  assert.throws(() => intersectEllipseLine(conic, { a: 1, b: 1, c: 0 }), NotAnEllipseError);
});

test('非椭圆拒绝: 双曲线 x^2-y^2=1 与 xy=1', () => {
  assert.throws(
    () => intersectEllipseLine({ A: 1, B: 0, C: -1, D: 0, E: 0, F: -1 }, { a: 1, b: 0, c: 0 }),
    NotAnEllipseError,
  );
  assert.throws(
    () => intersectEllipseLine({ A: 0, B: 1, C: 0, D: 0, E: 0, F: -1 }, { a: 1, b: 0, c: 0 }),
    NotAnEllipseError,
  );
});

test('非椭圆拒绝: 虚椭圆 x^2+y^2+1=0 (无实点)', () => {
  const conic: ConicInput = { A: 1, B: 0, C: 1, D: 0, E: 0, F: 1 };
  assert.throws(() => intersectEllipseLine(conic, { a: 1, b: 0, c: 0 }), NotAnEllipseError);
});

test('退化直线拒绝: a=b=0', () => {
  assert.throws(() => intersectEllipseLine(UNIT_CIRCLE, { a: 0, b: 0, c: 1 }), LineError);
});

// ---------------------------------------------------------------------------
// 代回区间核验
// ---------------------------------------------------------------------------

test('代回区间核验: 被篡改的隔离区间无法通过核验', () => {
  const line: LineInput = { a: 0, b: 1, c: '-1/2' };
  const res = secantOf(intersectEllipseLine(UNIT_CIRCLE, line));
  const [p0, p1] = res.points;
  const tampered: IntersectionResult = {
    ...res,
    points: [
      { ...p0, x: { ...p0.x, interval: makeInterval('5', '6') } },
      p1,
    ],
  };
  assert.equal(verifyIntersection(UNIT_CIRCLE, line, tampered), false);
});

test('代回区间核验: 交换两点顺序(区间重叠判定)无法通过核验', () => {
  const line: LineInput = { a: 0, b: 1, c: '-1/2' };
  const res = secantOf(intersectEllipseLine(UNIT_CIRCLE, line));
  const swapped: IntersectionResult = { ...res, points: [res.points[1], res.points[0]] };
  assert.equal(verifyIntersection(UNIT_CIRCLE, line, swapped), false);
});

test('代回核验: 切点精确满足椭圆与直线方程', () => {
  const conic: ConicInput = { A: 16, B: 0, C: 9, D: 0, E: 0, F: -144 };
  const line: LineInput = { a: 1, b: -1, c: 5 };
  const res = intersectEllipseLine(conic, line);
  assert.ok(verifyIntersection(conic, line, res));
});
