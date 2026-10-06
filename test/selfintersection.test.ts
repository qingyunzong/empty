import assert from 'node:assert/strict';
import test from 'node:test';
import { findSelfIntersections, hitTestPath, parsePath } from '../src/index.js';

test('simple square has no self-intersections', () => {
  const [ring] = parsePath('M0 0 L10 0 L10 10 L0 10 Z');
  assert.deepEqual(findSelfIntersections(ring!.points), []);
});

test('bowtie reports a crossing between non-adjacent edges', () => {
  const [ring] = parsePath('M0 0 L10 10 L10 0 L0 10 Z');
  const found = findSelfIntersections(ring!.points);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.edgeA, 0);
  assert.equal(found[0]!.edgeB, 2);
  assert.equal(found[0]!.kind, 'cross');
});

test('implicit closing edge participates in the check', () => {
  // Open zigzag whose implicit closing edge crosses edge 1.
  const [ring] = parsePath('M0 0 L4 0 L4 6 L8 3');
  const found = findSelfIntersections(ring!.points);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.edgeA, 1);
  assert.equal(found[0]!.edgeB, 3);
});

test('touching and overlapping edges are classified', () => {
  // Vertex of one edge touches the middle of a non-adjacent edge.
  const [touch] = parsePath('M0 0 L10 0 L10 10 L5 0 Z');
  assert.ok(findSelfIntersections(touch!.points).some((f) => f.kind === 'touch'));
  // Later edge retraces part of the first edge collinearly.
  const [overlap] = parsePath('M0 0 L10 0 L10 5 L4 5 L4 0 L8 0');
  assert.ok(findSelfIntersections(overlap!.points).some((f) => f.kind === 'overlap'));
});

test('pentagram has five crossings', () => {
  const pentagram = 'M10 0 L15.878 18.09 L0.489 6.91 L19.511 6.91 L4.122 18.09 Z';
  const [ring] = parsePath(pentagram);
  const found = findSelfIntersections(ring!.points);
  assert.equal(found.length, 5);
  assert.ok(found.every((f) => f.kind === 'cross'));
});

test('hitTestPath surfaces self-intersections and respects the edge limit', () => {
  const bowtie = 'M0 0 L10 10 L10 0 L0 10 Z';
  const result = hitTestPath(bowtie, 5, 5, { rule: 'nonzero' });
  assert.equal(result.selfIntersectionChecked, true);
  assert.equal(result.selfIntersections.length, 1);
  assert.equal(result.selfIntersections[0]!.ringIndex, 0);

  const limited = hitTestPath(bowtie, 5, 5, { selfIntersectionEdgeLimit: 2 });
  assert.equal(limited.selfIntersectionChecked, false);
  assert.deepEqual(limited.selfIntersections, []);
});

test('adjacent edges sharing a vertex are not flagged', () => {
  const [ring] = parsePath('M0 0 L5 0 L5 5 L0 5');
  assert.deepEqual(findSelfIntersections(ring!.points), []);
});
