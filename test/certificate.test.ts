import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCertificate, verifyCertificate } from '../src/certificate.js';
import type { Problem } from '../src/model.js';
import { solve } from '../src/solver.js';

const problem: Problem = {
  grid: 6,
  rects: [
    { id: 'A', minW: 2, maxW: 2, minH: 2, maxH: 2 },
    { id: 'B', minW: 2, maxW: 2, minH: 2, maxH: 2 },
  ],
  alignments: [],
  oldLayout: {
    A: { x: 0, y: 0, w: 2, h: 2 },
    B: { x: 1, y: 0, w: 2, h: 2 },
  },
};

test('certificate for an optimal solve verifies cleanly', () => {
  const cert = buildCertificate(problem, solve(problem));
  assert.equal(cert.status, 'optimal');
  assert.equal(cert.gap, 0);
  assert.ok(cert.checks.length > 0);
  assert.ok(cert.checks.every((c) => c.ok));
  assert.deepEqual(verifyCertificate(problem, cert), []);
});

test('tampered certificates are rejected', () => {
  const cert = buildCertificate(problem, solve(problem));

  const wrongBound = { ...cert, upperBound: cert.upperBound! + 1 };
  assert.ok(verifyCertificate(problem, wrongBound).length > 0);

  const flippedCheck = {
    ...cert,
    checks: cert.checks.map((c, i) => (i === 0 ? { ...c, ok: false } : c)),
  };
  assert.ok(verifyCertificate(problem, flippedCheck).length > 0);

  const moved = {
    ...cert,
    layout: { ...cert.layout!, A: { ...cert.layout!.A!, x: cert.layout!.A!.x + 1 } },
  };
  assert.ok(verifyCertificate(problem, moved).length > 0);

  const falseOptimal = { ...cert, lowerBound: cert.lowerBound! - 1 };
  assert.ok(verifyCertificate(problem, falseOptimal).length > 0);
});

test('budget-exhausted certificate keeps consistent open bounds', () => {
  const big: Problem = {
    grid: 20,
    rects: Array.from({ length: 8 }, (_, i) => ({
      id: `R${i}`,
      minW: 2,
      maxW: 5,
      minH: 2,
      maxH: 4,
    })),
    alignments: [],
    oldLayout: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `R${i}`,
        { x: 6 + (i % 3), y: 6 + Math.floor(i / 3), w: 3, h: 3 },
      ]),
    ),
  };
  const cert = buildCertificate(big, solve(big, { maxNodes: 50 }));
  assert.equal(cert.status, 'budget_exhausted');
  assert.deepEqual(verifyCertificate(big, cert), []);
  if (cert.upperBound !== null) {
    assert.ok(cert.lowerBound! <= cert.upperBound);
    assert.ok(cert.gap! > 0);
  }
});
