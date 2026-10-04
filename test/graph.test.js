import test from 'node:test';
import assert from 'node:assert/strict';
import { branch, ev, lcg } from './helpers.js';
import { normalizeBranch, validateBranch } from '../src/event.js';
import { kahnCertificate, findCycle, enumerateTopoOrders } from '../src/graph.js';
import { checkCertificate } from '../src/checker.js';

test('branch validation rejects missing refs and cycles', () => {
  const missing = validateBranch(normalizeBranch([ev('A', 1, { dependsOn: ['ZZZ'] })]));
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].type, 'MISSING_REF');

  const cyclic = validateBranch(
    normalizeBranch([ev('A', 1, { dependsOn: ['B'] }), ev('B', 2, { dependsOn: ['A'] })]),
  );
  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.errors[0].type, 'CYCLE');
});

test('time-regressing causal chain is legal and ordered by causality', () => {
  // ts decreases along causal edges; timestamps must not override causality.
  const events = branch([
    ev('A', 100),
    ev('B', 1, { dependsOn: ['A'] }),
    ev('C', 50, { dependsOn: ['B'] }),
  ]);
  const cert = kahnCertificate(events);
  assert.deepEqual(cert.order, ['A', 'B', 'C']);
  assert.equal(cert.complete, true);
  assert.equal(checkCertificate(events, cert).ok, true);
});

test('kahn picks minimal (ts,id) among available candidates each round', () => {
  const events = branch([ev('A', 2), ev('B', 1), ev('C', 1), ev('D', 1, { dependsOn: ['B'] })]);
  const cert = kahnCertificate(events);
  assert.deepEqual(cert.order, ['B', 'C', 'D', 'A']);
  assert.deepEqual(cert.steps[0].candidates, ['B', 'C', 'A']);
  assert.equal(checkCertificate(events, cert).ok, true);
});

test('findCycle returns a verifiable directed cycle', () => {
  const events = normalizeBranch([
    ev('A', 1, { dependsOn: ['C'] }),
    ev('B', 2, { dependsOn: ['A'] }),
    ev('C', 3, { dependsOn: ['B'] }),
    ev('D', 4),
  ]);
  const cyc = findCycle(events);
  assert.equal(cyc.nodes[0], cyc.nodes[cyc.nodes.length - 1]);
  for (const edge of cyc.edges) {
    assert.ok(events.get(edge.event).dependsOn.includes(edge.dependsOn));
  }
});

test('n<=7: kahn-min order is the lexicographic minimum of all topo orders', () => {
  const rand = lcg(42);
  for (let trial = 0; trial < 60; trial++) {
    const n = 1 + Math.floor(rand() * 7);
    const list = [];
    for (let i = 0; i < n; i++) {
      const deps = [];
      for (let j = 0; j < i; j++) if (rand() < 0.35) deps.push('E' + j);
      list.push(ev('E' + i, Math.floor(rand() * 5), { dependsOn: deps }));
    }
    const events = branch(list);
    const cert = kahnCertificate(events);
    assert.equal(cert.complete, true);
    assert.equal(checkCertificate(events, cert).ok, true);

    const all = enumerateTopoOrders(events);
    assert.ok(all.length > 0);
    const key = (order) => order.map((id) => [events.get(id).ts, id]);
    const cmp = (a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i][0] !== b[i][0]) return a[i][0] - b[i][0];
        if (a[i][1] !== b[i][1]) return a[i][1] < b[i][1] ? -1 : 1;
      }
      return 0;
    };
    const certKeys = key(cert.order);
    assert.ok(all.some((o) => o.join() === cert.order.join()), 'certificate order must be a valid topo order');
    for (const o of all) {
      assert.ok(cmp(certKeys, key(o)) <= 0, `cert order must be <= ${o}`);
    }
  }
});
