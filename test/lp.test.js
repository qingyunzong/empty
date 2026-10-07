'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rat } = require('../src/rational');
const { feasiblePoint, findIIS, farkasCertificate, verifyCertificate } = require('../src/lp');

const r = (n, d = 1) => new Rat(BigInt(n), BigInt(d));
const c = (id, coefs, op, rhs) => ({ id, coefs: coefs.map((x) => r(x)), op, rhs: r(rhs) });

test('vertex enumeration finds exact vertex', () => {
  // x + y <= 4, x >= 0, y >= 0, x <= 3  -> vertex (3, 1) or similar feasible vertex
  const cs = [
    c('a', [1, 1], '<=', 4),
    c('b', [1, 0], '>=', 0),
    c('c', [0, 1], '>=', 0),
    c('d', [1, 0], '<=', 3),
  ];
  const res = feasiblePoint(cs, 2);
  assert.equal(res.sat, true);
  assert.ok(res.point.every((p) => p instanceof Rat));
});

test('fractional vertex reported as reduced fraction', () => {
  // 2x <= 3, x >= 0  -> vertex x = 3/2
  const cs = [c('a', [2], '<=', 3), c('b', [1], '>=', 0)];
  const res = feasiblePoint(cs, 1);
  assert.equal(res.sat, true);
  assert.equal(res.point[0].toString(), '3/2');
});

test('unbounded and vertex-free regions still decided', () => {
  // x >= 1 in 2D: feasible, no vertex in the arrangement
  const cs = [c('a', [1, 0], '>=', 1)];
  assert.equal(feasiblePoint(cs, 2).sat, true);
  // x <= 0, x >= 1: infeasible
  const bad = [c('a', [1], '<=', 0), c('b', [1], '>=', 1)];
  assert.equal(feasiblePoint(bad, 1).sat, false);
});

test('IIS is irreducible and certificate verifies', () => {
  // x >= 2, x <= 1, plus a redundant satisfiable constraint y <= 5
  const cs = [
    c('lo', [1, 0], '>=', 2),
    c('hi', [1, 0], '<=', 1),
    c('noise', [0, 1], '<=', 5),
  ];
  assert.equal(feasiblePoint(cs, 2).sat, false);
  const iis = findIIS(cs, 2).map((i) => cs[i]);
  assert.deepEqual(iis.map((x) => x.id).sort(), ['hi', 'lo']);
  const cert = farkasCertificate(iis, 2);
  assert.ok(cert);
  assert.equal(verifyCertificate(iis, 2, cert), true);
  // certificate must not verify against a feasible set
  assert.equal(verifyCertificate([cs[2]], 2, cert), false);
});

test('farkas multipliers are exact rationals', () => {
  // 2x <= 1 and -x <= -1  (x >= 1): combination 1*(2x<=1) + 2*(-x<=-1) => 0 <= -1
  const cs = [c('a', [2], '<=', 1), c('b', [1], '>=', 1)];
  const cert = farkasCertificate(cs, 1);
  assert.ok(cert);
  const lam = Object.fromEntries(cert.map((e) => [e.id, e.lambda.toString()]));
  assert.equal(lam.a, '1');
  assert.equal(lam.b, '2');
  assert.equal(verifyCertificate(cs, 1, cert), true);
});
