import { test } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import {
  allocate,
  exhaustiveAllocate,
  MAX_SHIFTS,
  MAX_TIME,
  type AllocationResult,
  type ConstrainedShift,
} from '../src/allocate.js';
import { mulberry32, randomInt } from './helpers.js';

function checkCertificateConsistency(
  shifts: ConstrainedShift[],
  result: AllocationResult,
): void {
  const workedById = new Map<number, number>();
  let prevEnd = -Infinity;
  for (const seg of result.segments) {
    ok(seg.start >= prevEnd, 'segments must not overlap');
    ok(Number.isInteger(seg.start) && Number.isInteger(seg.end), 'integer endpoints');
    ok(seg.start >= 0 && seg.end <= MAX_TIME, 'segments within horizon');
    const owner = shifts.find((s) => s.id === seg.shiftId);
    ok(owner && owner.start <= seg.start && seg.end <= owner.end, 'segment inside owner');
    workedById.set(seg.shiftId, (workedById.get(seg.shiftId) ?? 0) + seg.end - seg.start);
    prevEnd = seg.end;
  }
  equal(result.certificates.length, shifts.length);
  let coverage = 0;
  let benefit = 0;
  for (const cert of result.certificates) {
    const shift = shifts.find((s) => s.id === cert.shiftId);
    ok(shift, 'certificate references a known shift');
    const worked = workedById.get(cert.shiftId) ?? 0;
    equal(cert.worked, worked, `shift ${cert.shiftId}: worked matches segments`);
    equal(cert.rest, shift.end - shift.start - worked, `shift ${cert.shiftId}: rest`);
    ok(cert.worked <= cert.maxWork, `shift ${cert.shiftId}: maxWork respected`);
    ok(cert.rest >= cert.minRest, `shift ${cert.shiftId}: minRest respected`);
    coverage += cert.worked;
    benefit += cert.worked * shift.priority;
  }
  equal(result.coverage, coverage);
  equal(result.benefit, benefit);
}

test('joint allocation beats pointwise greedy', () => {
  const shifts: ConstrainedShift[] = [
    { id: 1, start: 0, end: 2, priority: 10, maxWork: 1, minRest: 0 },
    { id: 2, start: 0, end: 1, priority: 1, maxWork: 1, minRest: 0 },
  ];
  const result = allocate(shifts);
  equal(result.coverage, 2);
  equal(result.benefit, 11);
  deepEqual(result.segments, [
    { shiftId: 2, start: 0, end: 1 },
    { shiftId: 1, start: 1, end: 2 },
  ]);
  checkCertificateConsistency(shifts, result);
});

test('equal coverage prefers higher priority benefit', () => {
  const shifts: ConstrainedShift[] = [
    { id: 1, start: 0, end: 1, priority: 5, maxWork: 1, minRest: 0 },
    { id: 2, start: 0, end: 1, priority: 3, maxWork: 1, minRest: 0 },
  ];
  const result = allocate(shifts);
  equal(result.coverage, 1);
  equal(result.benefit, 5);
  deepEqual(result.segments, [{ shiftId: 1, start: 0, end: 1 }]);
});

test('minRest caps attribution even when maxWork allows more', () => {
  const shifts: ConstrainedShift[] = [
    { id: 1, start: 0, end: 4, priority: 1, maxWork: 10, minRest: 3 },
  ];
  const result = allocate(shifts);
  equal(result.coverage, 1);
  deepEqual(result.certificates, [
    { shiftId: 1, worked: 1, rest: 3, maxWork: 10, minRest: 3 },
  ]);
});

test('maxWork caps attribution and overflow goes to lower priority shift', () => {
  const shifts: ConstrainedShift[] = [
    { id: 1, start: 0, end: 2, priority: 5, maxWork: 2, minRest: 1 },
    { id: 2, start: 0, end: 2, priority: 4, maxWork: 2, minRest: 0 },
  ];
  const result = allocate(shifts);
  equal(result.coverage, 2);
  equal(result.benefit, 9);
  const cert1 = result.certificates.find((c) => c.shiftId === 1);
  equal(cert1?.worked, 1);
  equal(cert1?.rest, 1);
  checkCertificateConsistency(shifts, result);
});

test('validation rejects out-of-contract input', () => {
  const base: ConstrainedShift = { id: 1, start: 0, end: 1, priority: 1, maxWork: 1, minRest: 0 };
  throws(() => allocate([{ ...base, end: MAX_TIME + 1 }]), /0 <= start < end/);
  throws(() => allocate([{ ...base, start: -1 }]), /0 <= start < end/);
  throws(() => allocate([{ ...base, start: 0.5 }]), /integers/);
  throws(() => allocate([{ ...base, minRest: 2 }]), /minRest exceeds/);
  throws(() => allocate([{ ...base, maxWork: -1 }]), /maxWork/);
  const tooMany: ConstrainedShift[] = [];
  for (let i = 0; i < MAX_SHIFTS + 1; i++) {
    tooMany.push({ ...base, id: i + 1 });
  }
  throws(() => allocate(tooMany), /at most 12 shifts/);
  throws(
    () => allocate([base, { ...base, start: 2, end: 3 }]),
    /duplicate/,
  );
});

test('randomized: solver matches exhaustive search (coverage, benefit)', () => {
  const rand = mulberry32(123456789);
  for (let iter = 0; iter < 400; iter++) {
    const horizon = randomInt(rand, 3, 7);
    const shiftCount = randomInt(rand, 1, 3);
    const shifts: ConstrainedShift[] = [];
    for (let i = 0; i < shiftCount; i++) {
      const start = randomInt(rand, 0, horizon - 1);
      const end = start + randomInt(rand, 1, horizon - start);
      const duration = end - start;
      shifts.push({
        id: i + 1,
        start,
        end,
        priority: randomInt(rand, 0, 5),
        maxWork: randomInt(rand, 0, duration),
        minRest: randomInt(rand, 0, duration),
      });
    }
    const result = allocate(shifts);
    const brute = exhaustiveAllocate(shifts);
    equal(result.coverage, brute.coverage, `coverage differs at iter ${iter}`);
    equal(result.benefit, brute.benefit, `benefit differs at iter ${iter}`);
    checkCertificateConsistency(shifts, result);
  }
});

test('randomized: full-size instances stay legal and deterministic', () => {
  const rand = mulberry32(987654321);
  for (let iter = 0; iter < 50; iter++) {
    const shifts: ConstrainedShift[] = [];
    for (let i = 0; i < MAX_SHIFTS; i++) {
      const start = randomInt(rand, 0, MAX_TIME - 1);
      const end = start + randomInt(rand, 1, MAX_TIME - start);
      const duration = end - start;
      shifts.push({
        id: i + 1,
        start,
        end,
        priority: randomInt(rand, 0, 9),
        maxWork: randomInt(rand, 0, duration),
        minRest: randomInt(rand, 0, duration),
      });
    }
    const first = allocate(shifts);
    const second = allocate(shifts);
    deepEqual(first, second, 'allocation must be deterministic');
    checkCertificateConsistency(shifts, first);
    ok(first.coverage <= MAX_TIME, 'coverage bounded by horizon');
  }
});

test('medium-size instances still match exhaustive search', () => {
  const rand = mulberry32(555777);
  for (let iter = 0; iter < 30; iter++) {
    const horizon = randomInt(rand, 8, 10);
    const shiftCount = 4;
    const shifts: ConstrainedShift[] = [];
    for (let i = 0; i < shiftCount; i++) {
      const start = randomInt(rand, 0, horizon - 1);
      const end = start + randomInt(rand, 1, horizon - start);
      const duration = end - start;
      shifts.push({
        id: i + 1,
        start,
        end,
        priority: randomInt(rand, 0, 4),
        maxWork: randomInt(rand, 0, duration),
        minRest: randomInt(rand, 0, duration),
      });
    }
    const result = allocate(shifts);
    const brute = exhaustiveAllocate(shifts);
    equal(result.coverage, brute.coverage, `coverage differs at iter ${iter}`);
    equal(result.benefit, brute.benefit, `benefit differs at iter ${iter}`);
  }
});
