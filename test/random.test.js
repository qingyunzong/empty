'use strict';
// Acceptance 1: random small graphs cross-checked against an independent
// DFS enumeration written directly in the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const lineage = require('../src/lineage');
const { randomEvents } = require('../testlib/helpers');

// Independent reference implementation: a batch is contaminated iff a DFS
// from some effectively-failing batch reaches it without traversing out of a
// tombstoned node.
function dfsContaminated(events) {
  const children = new Map();
  const scrapped = new Set();
  const batches = new Set();
  const inspections = new Map();
  for (const event of events) {
    if (event.type === 'intake') batches.add(event.batch);
    else if (event.type === 'mix') batches.add(event.output);
    else if (event.type === 'split') for (const o of event.outputs) batches.add(o);
  }
  for (const id of batches) children.set(id, []);
  for (const event of events) {
    if (event.type === 'mix') {
      for (const input of event.inputs) children.get(input).push(event.output);
    } else if (event.type === 'split') {
      for (const o of event.outputs) children.get(event.input).push(o);
    } else if (event.type === 'inspect') {
      inspections.set(event.id, { batch: event.batch, status: event.status });
    } else if (event.type === 'correct') {
      inspections.get(event.inspection).status = event.status;
    } else if (event.type === 'scrap') {
      scrapped.add(event.batch);
    }
  }
  const norm = (s) => (s === 'pass' || s === 'fail' ? s : 'unknown');
  const failBatches = new Set();
  for (const insp of inspections.values()) {
    if (norm(insp.status) === 'fail') failBatches.add(insp.batch);
  }
  const contaminated = new Set();
  for (const start of failBatches) {
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop();
      if (contaminated.has(node)) continue;
      contaminated.add(node);
      if (scrapped.has(node)) continue; // tombstone: do not propagate further
      for (const child of children.get(node)) stack.push(child);
    }
  }
  return contaminated;
}

test('random small graphs match independent DFS enumeration', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const events = randomEvents(seed);
    const state = lineage.buildState(events);
    const expected = dfsContaminated(events);
    assert.deepEqual(
      [...state.contaminated].sort(),
      [...expected].sort(),
      `seed ${seed} contaminated set mismatch`,
    );
    // Sources: contaminated nodes with no contaminated, non-scrapped parent.
    const parents = new Map();
    for (const event of events) {
      if (event.type === 'mix') {
        parents.set(event.output, event.inputs);
      } else if (event.type === 'split') {
        for (const o of event.outputs) parents.set(o, [event.input]);
      }
    }
    const scrapped = new Set(events.filter((e) => e.type === 'scrap').map((e) => e.batch));
    const expectedSources = [...expected]
      .filter((id) => !(parents.get(id) || []).some((p) => expected.has(p) && !scrapped.has(p)))
      .sort();
    const certificate = lineage.buildCertificate(state);
    assert.deepEqual(certificate.sources, expectedSources, `seed ${seed} sources mismatch`);
    // Boundary: contaminated nodes with no contaminated child.
    const children = new Map();
    for (const event of events) {
      if (event.type === 'mix') {
        for (const i of event.inputs) children.set(i, [...(children.get(i) || []), event.output]);
      } else if (event.type === 'split') {
        children.set(event.input, [...(children.get(event.input) || []), ...event.outputs]);
      }
    }
    const expectedBoundary = [...expected]
      .filter((id) => !(children.get(id) || []).some((c) => expected.has(c)))
      .sort();
    assert.deepEqual(
      certificate.boundary.map((b) => b.batch),
      expectedBoundary,
      `seed ${seed} boundary mismatch`,
    );
  }
});
