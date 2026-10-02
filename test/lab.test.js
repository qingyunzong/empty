import test from 'node:test';
import assert from 'node:assert/strict';
import { Lab, LabError } from '../src/lab.js';

const V = { validFrom: '2026-01-01', validTo: '2026-12-31' };

function std(id, u, extra = {}) {
  return { id, kind: 'standard', range: 'R1', grade: 'G1', envClass: 'E1', u, ...V, ...extra };
}
function dut(id, u, extra = {}) {
  return { id, kind: 'dut', range: 'R1', grade: 'G3', envClass: 'E1', u, ...V, ...extra };
}
function point(id, dutId, extra = {}) {
  return {
    id, dut: dutId, time: '2026-06-01', range: 'R1', envClass: 'E1',
    envWindow: { start: '2026-06-01T00:00', end: '2026-06-01T23:59', class: 'E1' },
    ...extra,
  };
}

test('link rejects cycles', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.01, { root: true }));
  lab.addArtifact(std('B', 0.02));
  lab.link('A', 'B');
  assert.throws(() => lab.link('B', 'A'), (e) => e instanceof LabError && e.code === 'CYCLE');
  assert.throws(() => lab.link('A', 'A'), (e) => e.code === 'CYCLE');
});

test('acceptance 1: broken chain yields REFUTE with minimal core', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.01)); // not a root, no parent -> chain broken at A
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'D');
  lab.measure(point('p1', 'D'));
  const r = lab.certify('p1');
  assert.equal(r.status, 'REFUTE');
  assert.deepEqual(r.core, [{ constraint: 'TRACEABILITY_ROOT', artifact: 'A' }]);
});

test('acceptance 2: missing env window is INSUFFICIENT_EVIDENCE, not REFUTE', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.01, { root: true }));
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'D');
  lab.measure(point('p1', 'D', { envWindow: null }));
  const r = lab.certify('p1');
  assert.equal(r.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(r.missing.includes('ENV_WINDOW'));
  assert.notEqual(r.status, 'REFUTE');
  assert.notEqual(r.status, 'UNSAT');
});

test('acceptance 3: budget boundary yields PENDING, exact boundary passes', () => {
  const make = () => {
    const lab = new Lab();
    lab.addArtifact(std('A', 0.03, { root: true }));
    lab.addArtifact(std('B', 0.04));
    lab.addArtifact(dut('D', 0.05));
    lab.link('A', 'B');
    lab.link('B', 'D');
    return lab;
  };
  // U = 2*sqrt(0.03^2 + 0.04^2) = 0.1 exactly
  const lab1 = make();
  lab1.measure(point('p1', 'D', { budget: 0.1 }));
  const ok = lab1.certify('p1');
  assert.equal(ok.status, 'CERT');
  assert.equal(ok.combinedUncertainty, 0.1);

  const lab2 = make();
  lab2.measure(point('p2', 'D', { budget: 0.0999 }));
  const pending = lab2.certify('p2');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.reason, 'BUDGET');
  assert.notEqual(pending.status, 'REFUTE');
});

test('CERT contains chain, combined uncertainty and hash; audit validates', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.03, { root: true }));
  lab.addArtifact(std('B', 0.04));
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'B');
  lab.link('B', 'D');
  lab.measure(point('p1', 'D', { budget: 0.2 }));
  const cert = lab.certify('p1');
  assert.equal(cert.status, 'CERT');
  assert.deepEqual(cert.chain.map((c) => c.id), ['A', 'B', 'D']);
  assert.equal(typeof cert.hash, 'string');
  assert.deepEqual(lab.audit(cert), { status: 'VALID', cert: cert.id });
});

test('audit detects tampering', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.03, { root: true }));
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'D');
  lab.measure(point('p1', 'D'));
  const cert = lab.certify('p1');
  const tamperedHash = { ...cert, combinedUncertainty: 0.001 };
  assert.equal(lab.audit(tamperedHash).status, 'TAMPERED');
  const tamperedChain = { ...cert, chain: cert.chain.map((c) => ({ ...c })) };
  tamperedChain.chain[0] = { ...tamperedChain.chain[0], u: 0.09 };
  assert.equal(lab.audit(tamperedChain).status, 'TAMPERED');
  assert.equal(lab.audit({ status: 'CERT' }).status, 'TAMPERED');
  assert.equal(lab.audit(null).status, 'INVALID');
});

test('reserve/release are paired; bad release returns LEASE_STATE', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.01, { root: true }));
  lab.addArtifact(dut('D', 0.05));
  lab.measure(point('p1', 'D'));
  lab.measure(point('p2', 'D'));
  const l1 = lab.reserve('A', 'p1');
  assert.throws(() => lab.reserve('A', 'p2'), (e) => e.code === 'LEASE_STATE');
  assert.throws(() => lab.release('L999'), (e) => e.code === 'LEASE_STATE');
  lab.release(l1.id);
  assert.throws(() => lab.release(l1.id), (e) => e.code === 'LEASE_STATE');
  const l2 = lab.reserve('A', 'p2');
  lab.release(l2.id);
});

test('active lease on another point excludes the standard from certify', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.01, { root: true }));
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'D');
  lab.measure(point('p1', 'D'));
  lab.measure(point('p2', 'D'));
  lab.reserve('A', 'p1');
  const r = lab.certify('p2');
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.core.some((c) => c.constraint === 'LEASE' && c.artifact === 'A'));
  assert.equal(lab.certify('p1').status, 'CERT');
});

test('unlink refused while a downstream measurement is pending', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.01, { root: true }));
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'D');
  lab.measure(point('p1', 'D'));
  assert.throws(() => lab.unlink('A', 'D'), (e) => e.code === 'PENDING_MEASUREMENTS');
  lab.certify('p1');
  assert.deepEqual(lab.unlink('A', 'D'), { unlinked: 'A->D' });
});

test('uncertainty dominance violation is a REFUTE core constraint', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.09, { root: true })); // worse than the DUT
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'D');
  lab.measure(point('p1', 'D'));
  const r = lab.certify('p1');
  assert.equal(r.status, 'REFUTE');
  assert.deepEqual(r.core, [
    { constraint: 'UNCERTAINTY_DOMINANCE', artifact: 'A', stdU: 0.09, targetU: 0.05 },
  ]);
});

test('expired standard yields REFUTE with VALIDITY core', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.01, { root: true, validFrom: '2025-01-01', validTo: '2025-12-31' }));
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'D');
  lab.measure(point('p1', 'D'));
  const r = lab.certify('p1');
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.core.some((c) => c.constraint === 'VALIDITY' && c.artifact === 'A'));
});

test('env window present but not covering is REFUTE, not INSUFFICIENT', () => {
  const lab = new Lab();
  lab.addArtifact(std('A', 0.01, { root: true }));
  lab.addArtifact(dut('D', 0.05));
  lab.link('A', 'D');
  lab.measure(point('p1', 'D', {
    envWindow: { start: '2026-06-02T00:00', end: '2026-06-02T23:59', class: 'E1' },
  }));
  const r = lab.certify('p1');
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.core.some((c) => c.constraint === 'ENV_WINDOW_COVER'));
});

// ---- acceptance 4: cross-check backtracking vs brute-force enumeration, n <= 8 ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bruteChains(lab, point, dutId) {
  const incoming = new Map();
  for (const l of lab.links.values()) {
    if (!incoming.has(l.target)) incoming.set(l.target, []);
    incoming.get(l.target).push(l.std);
  }
  const results = [];
  const dfs = (cur, path, visited) => {
    const curArt = lab.artifacts.get(cur);
    if (cur !== dutId && curArt.kind === 'standard' && curArt.root) results.push(path);
    for (const sid of incoming.get(cur) ?? []) {
      if (visited.has(sid)) continue;
      const s = lab.artifacts.get(sid);
      const child = lab.artifacts.get(cur);
      if (s.range !== point.range) continue;
      if (!(s.u < child.u)) continue;
      if (!(s.validFrom <= point.time && point.time <= s.validTo)) continue;
      if (lab._leasedElsewhere(sid, point.id)) continue;
      visited.add(sid);
      dfs(sid, [sid, ...path], visited);
      visited.delete(sid);
    }
  };
  dfs(dutId, [dutId], new Set([dutId]));
  return results;
}

test('acceptance 4: certify matches brute-force chain enumeration for n<=8', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = mulberry32(seed);
    const lab = new Lab();
    const n = 1 + Math.floor(rnd() * 8); // 1..8 standards
    const ranges = ['R1', 'R2'];
    const rangeOf = () => ranges[Math.floor(rnd() * ranges.length)];
    for (let i = 0; i < n; i++) {
      lab.addArtifact({
        id: 'S' + i, kind: 'standard', range: rangeOf(), grade: 'G1', envClass: 'E1',
        u: 0.01 + rnd() * 0.09,
        validFrom: rnd() < 0.8 ? '2026-01-01' : '2026-07-01',
        validTo: '2026-12-31',
        root: rnd() < 0.4,
      });
    }
    lab.addArtifact({
      id: 'D', kind: 'dut', range: rangeOf(), grade: 'G3', envClass: 'E1',
      u: 0.05 + rnd() * 0.1, validFrom: '2026-01-01', validTo: '2026-12-31',
    });
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j <= n; j++) { // j === n is the DUT; acyclic by index order
        if (rnd() < 0.3) lab.link('S' + i, j === n ? 'D' : 'S' + j);
      }
    }
    const budget = 0.05 + rnd() * 0.3;
    lab.measure({
      id: 'p', dut: 'D', time: '2026-06-01', range: lab.artifacts.get('D').range,
      envClass: 'E1', budget,
      envWindow: { start: '2026-06-01T00:00', end: '2026-06-01T23:59', class: 'E1' },
    });
    const point = lab.points.get('p');
    const chains = bruteChains(lab, point, 'D');
    const r = lab.certify('p');
    if (chains.length === 0) {
      assert.equal(r.status, 'REFUTE', `seed ${seed}: expected REFUTE, got ${r.status}`);
    } else {
      const U = (c) => 2 * Math.sqrt(c.reduce((acc, id) => {
        const a = lab.artifacts.get(id);
        return a.kind === 'standard' ? acc + a.u * a.u : acc;
      }, 0));
      const minU = Math.min(...chains.map(U));
      if (minU <= budget) {
        assert.equal(r.status, 'CERT', `seed ${seed}: expected CERT, got ${r.status}`);
        assert.equal(r.combinedUncertainty, minU, `seed ${seed}: U mismatch`);
      } else {
        assert.equal(r.status, 'PENDING', `seed ${seed}: expected PENDING, got ${r.status}`);
        assert.equal(r.combinedUncertainty, minU, `seed ${seed}: U mismatch`);
      }
    }
  }
});
