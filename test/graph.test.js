'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgvGraph, ERR } from '../src/index.js';

function buildBase() {
  const g = new AgvGraph();
  //   A --5-- B --5-- C
  //   |                 |
  //   10               1
  //   |                 |
  //   D ------1------ E
  assert.equal(g.addEdge('A', 'B', 5).ok, true);
  assert.equal(g.addEdge('B', 'C', 5).ok, true);
  assert.equal(g.addEdge('A', 'D', 10).ok, true);
  assert.equal(g.addEdge('D', 'E', 1).ok, true);
  assert.equal(g.addEdge('E', 'C', 1).ok, true);
  return g;
}

test('acceptance 1: incremental reweight keeps path and cost correct', () => {
  const g = buildBase();
  let r = g.query('A', 'C');
  assert.equal(r.ok, true);
  assert.equal(r.cost, 10);
  assert.deepEqual(r.path, ['A', 'B', 'C']);

  // Cheaper via the south route after reweighting A-D.
  assert.equal(g.setCost('A', 'D', 1).ok, true);
  r = g.query('A', 'C');
  assert.equal(r.ok, true);
  assert.equal(r.cost, 3);
  assert.deepEqual(r.path, ['A', 'D', 'E', 'C']);
  assert.equal(g.verify(r.cert).ok, true);

  // Reweight back and forth; results must track the current weights.
  assert.equal(g.setCost('A', 'D', 50).ok, true);
  r = g.query('A', 'C');
  assert.equal(r.cost, 10);
  assert.deepEqual(r.path, ['A', 'B', 'C']);
  assert.equal(g.setCost('B', 'C', 1).ok, true);
  r = g.query('A', 'C');
  assert.equal(r.cost, 6);
  assert.deepEqual(r.path, ['A', 'B', 'C']);
  assert.equal(g.verify(r.cert).ok, true);
});

test('acceptance 2: closure with detour differs from true disconnection', () => {
  const g = buildBase();
  // Close B-C: still acyclic-detourable via A-D-E-C (no cycle needed, reroute).
  assert.equal(g.closeEdge('B', 'C').ok, true);
  let r = g.query('A', 'C');
  assert.equal(r.ok, true);
  assert.deepEqual(r.path, ['A', 'D', 'E', 'C']);
  assert.equal(r.cost, 12);

  // Close E-C as well: C is genuinely disconnected from A.
  assert.equal(g.closeEdge('E', 'C').ok, true);
  r = g.query('A', 'C');
  assert.equal(r.ok, false);
  assert.equal(r.error, ERR.NO_PATH);
  // The NO_PATH answer carries a verifiable cut certificate.
  assert.equal(r.cert.type, 'nopath-cert');
  assert.equal(g.verify(r.cert).ok, true);

  // Reopen one edge: reachable again, never stuck at UNDECIDED/NO_PATH.
  assert.equal(g.openEdge('E', 'C').ok, true);
  r = g.query('A', 'C');
  assert.equal(r.ok, true);
  assert.deepEqual(r.path, ['A', 'D', 'E', 'C']);
});

test('lexicographic tie-break among equal-cost paths is stable', () => {
  const g = new AgvGraph();
  // Two equal-cost routes S->T: S-b-x-T and S-a-z-T (both cost 3).
  g.addEdge('S', 'b', 1);
  g.addEdge('b', 'x', 1);
  g.addEdge('x', 'T', 1);
  g.addEdge('S', 'a', 1);
  g.addEdge('a', 'z', 1);
  g.addEdge('z', 'T', 1);
  const r = g.query('S', 'T');
  assert.equal(r.cost, 3);
  assert.deepEqual(r.path, ['S', 'a', 'z', 'T']);
  // Same answer after unrelated mutations (determinism).
  g.setCost('S', 'b', 2);
  g.setCost('S', 'b', 1);
  assert.deepEqual(g.query('S', 'T').path, ['S', 'a', 'z', 'T']);
});

test('acceptance 4: three consecutive undos restore state three layers back', () => {
  const g = buildBase();
  const before1 = g.query('A', 'C');
  const before2 = g.query('D', 'B');
  const versionBefore = g.version;

  g.setCost('A', 'D', 1); // layer 1
  g.closeEdge('B', 'C'); // layer 2
  g.addEdge('A', 'C', 100); // layer 3

  // State indeed changed.
  assert.notDeepEqual(g.query('A', 'C').path, before1.path);

  assert.equal(g.undo().ok, true); // undo add_edge
  assert.equal(g.undo().ok, true); // undo close
  assert.equal(g.undo().ok, true); // undo set_cost

  const after1 = g.query('A', 'C');
  const after2 = g.query('D', 'B');
  assert.deepEqual(after1.path, before1.path);
  assert.equal(after1.cost, before1.cost);
  assert.deepEqual(after2.path, before2.path);
  assert.equal(after2.cost, before2.cost);
  // Version moved on (no silent resurrection of old certs).
  assert.ok(g.version > versionBefore);
  assert.equal(g.verify(before1.cert).ok, false);
  assert.equal(g.verify(before1.cert).error, ERR.CERT_INVALID);

  // Undo on empty history of committed mutations beyond this point: drain it.
  const g2 = new AgvGraph();
  assert.equal(g2.undo().ok, false);
  assert.equal(g2.undo().error, ERR.CONFLICT);
});

test('undo does not touch committed query results', () => {
  const g = buildBase();
  const committed = g.query('A', 'C');
  g.setCost('A', 'D', 1);
  g.undo();
  const again = g.query('A', 'C');
  assert.deepEqual(again.path, committed.path);
  assert.equal(again.cost, committed.cost);
});

test('acceptance 5: tampered, stale or foreign certificates always fail', () => {
  const g = buildBase();
  const r = g.query('A', 'C');
  assert.equal(g.verify(r.cert).ok, true);

  const tamper = (fn) => {
    const c = JSON.parse(JSON.stringify(r.cert));
    fn(c);
    return g.verify(c);
  };

  // Forged cost.
  assert.equal(tamper((c) => { c.cost -= 1; }).error, ERR.CERT_INVALID);
  assert.equal(tamper((c) => { c.cost += 1; }).error, ERR.CERT_INVALID);
  // Forged potentials (lower bound inflated / deflated).
  assert.equal(tamper((c) => { c.potentials.C += 1; }).error, ERR.CERT_INVALID);
  assert.equal(tamper((c) => { c.potentials.B -= 1; }).error, ERR.CERT_INVALID);
  assert.equal(tamper((c) => { delete c.potentials.B; }).error, ERR.CERT_INVALID);
  assert.equal(tamper((c) => { c.potentials.A = 1; }).error, ERR.CERT_INVALID);
  // Forged path.
  assert.equal(tamper((c) => { c.path = ['A', 'D', 'C']; }).error, ERR.CERT_INVALID);
  assert.equal(tamper((c) => { c.path = ['A', 'B', 'C', 'A']; }).error, ERR.CERT_INVALID);
  // Forged cut.
  assert.equal(tamper((c) => { c.cut.nodes = []; }).error, ERR.CERT_INVALID);
  assert.equal(tamper((c) => { c.cut.bound = 3; }).error, ERR.CERT_INVALID);
  // Forged version.
  assert.equal(tamper((c) => { c.version += 1; }).error, ERR.CERT_INVALID);
  // Unknown type / garbage.
  assert.equal(g.verify(null).error, ERR.CERT_INVALID);
  assert.equal(g.verify({}).error, ERR.CERT_INVALID);
  assert.equal(g.verify('string').error, ERR.CERT_INVALID);
  assert.equal(g.verify({ type: 'path-cert' }).error, ERR.CERT_INVALID);

  // Stale: any mutation after issuance invalidates the certificate.
  g.setCost('D', 'E', 2);
  assert.equal(g.verify(r.cert).error, ERR.CERT_INVALID);

  // Foreign graph: valid cert from another instance must not verify here.
  const other = buildBase();
  const oc = other.query('A', 'C').cert;
  const g3 = buildBase();
  g3.setCost('D', 'E', 5); // diverge versions/state
  assert.equal(g3.verify(oc).error, ERR.CERT_INVALID);

  // Tampered NO_PATH certificate.
  const g4 = new AgvGraph();
  g4.addEdge('A', 'B', 1);
  g4.addEdge('C', 'D', 1);
  const np = g4.query('A', 'D');
  assert.equal(np.error, ERR.NO_PATH);
  assert.equal(g4.verify(np.cert).ok, true);
  const bad = JSON.parse(JSON.stringify(np.cert));
  bad.reachable = bad.reachable.filter((n) => n !== 'B'); // cut now crosses edge A-B
  assert.equal(g4.verify(bad).error, ERR.CERT_INVALID);
  const bad2 = JSON.parse(JSON.stringify(np.cert));
  bad2.reachable.push('D'); // target inside the cut
  assert.equal(g4.verify(bad2).error, ERR.CERT_INVALID);
});

test('input validation and conflict error codes', () => {
  const g = new AgvGraph();
  assert.equal(g.addEdge('A', 'A', 1).error, ERR.INVALID_INPUT);
  assert.equal(g.addEdge('A', 'B', 0).error, ERR.INVALID_INPUT);
  assert.equal(g.addEdge('A', 'B', -3).error, ERR.INVALID_INPUT);
  assert.equal(g.addEdge('A', 'B', 1.5).error, ERR.INVALID_INPUT);
  assert.equal(g.addEdge('A', 'B', 'x').error, ERR.INVALID_INPUT);
  assert.equal(g.addEdge('', 'B', 1).error, ERR.INVALID_INPUT);
  g.addEdge('A', 'B', 1);
  assert.equal(g.addEdge('A', 'B', 2).error, ERR.CONFLICT);
  assert.equal(g.addEdge('B', 'A', 2).error, ERR.CONFLICT); // undirected
  assert.equal(g.closeEdge('A', 'C').error, ERR.CONFLICT);
  assert.equal(g.openEdge('A', 'B').error, ERR.CONFLICT);
  g.closeEdge('A', 'B');
  assert.equal(g.closeEdge('A', 'B').error, ERR.CONFLICT);
  assert.equal(g.setCost('A', 'C', 1).error, ERR.CONFLICT);
  assert.equal(g.query('A', null).error, ERR.INVALID_INPUT);
  // set_cost on a closed edge is legal.
  assert.equal(g.setCost('A', 'B', 4).ok, true);
  g.openEdge('A', 'B');
  const r = g.query('A', 'B');
  assert.equal(r.cost, 4);
});

test('query to self has zero cost and a valid certificate', () => {
  const g = buildBase();
  const r = g.query('A', 'A');
  assert.equal(r.ok, true);
  assert.deepEqual(r.path, ['A']);
  assert.equal(r.cost, 0);
  assert.equal(g.verify(r.cert).ok, true);
});
