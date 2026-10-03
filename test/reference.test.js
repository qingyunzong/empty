import assert from 'node:assert/strict';
import test from 'node:test';
import { Manifest } from '../src/manifest.js';
import { Reference } from '../src/reference.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = ['f0', 'f1', 'f2'];
const ARTIFACTS = ['a0', 'a1', 'a2', 'a3', 'a4'];
const RELEASES = ['r0', 'r1'];
const BUILDERS = ['concat', 'normalize', 'aggregate', 'annotate', 'bogus'];

function randomOps(rnd, state) {
  const ops = [];
  const count = 1 + Math.floor(rnd() * 3);
  const files = [...state.files.keys()];
  const artifacts = [...state.artifacts.keys()];
  const releases = [...state.releases.keys()];
  const inputs = [...files, ...artifacts];
  for (let i = 0; i < count; i++) {
    const choice = rnd();
    if (choice < 0.25) {
      const id = FILES[Math.floor(rnd() * FILES.length)];
      ops.push({ op: 'putFile', id, content: `content-${Math.floor(rnd() * 5)}` });
    } else if (choice < 0.45) {
      const id = ARTIFACTS[Math.floor(rnd() * ARTIFACTS.length)];
      if (!state.artifacts.has(id) && !state.files.has(id) && !state.releases.has(id) && inputs.length) {
        const nInputs = 1 + Math.floor(rnd() * Math.min(2, inputs.length));
        const chosen = [];
        for (let k = 0; k < nInputs; k++) chosen.push(inputs[Math.floor(rnd() * inputs.length)]);
        ops.push({ op: 'addArtifact', id, builder: BUILDERS[Math.floor(rnd() * BUILDERS.length)], inputs: chosen });
      }
    } else if (choice < 0.55 && artifacts.length) {
      ops.push({ op: 'removeArtifact', id: artifacts[Math.floor(rnd() * artifacts.length)] });
    } else if (choice < 0.7 && artifacts.length && inputs.length) {
      const from = artifacts[Math.floor(rnd() * artifacts.length)];
      const to = inputs[Math.floor(rnd() * inputs.length)];
      if (from !== to && !state.artifacts.get(from).inputs.includes(to)) {
        ops.push({ op: 'addEdge', from, to });
      }
    } else if (choice < 0.78 && artifacts.length) {
      const from = artifacts[Math.floor(rnd() * artifacts.length)];
      const existing = state.artifacts.get(from).inputs;
      if (existing.length) ops.push({ op: 'removeEdge', from, to: existing[Math.floor(rnd() * existing.length)] });
    } else if (choice < 0.9) {
      const id = RELEASES[Math.floor(rnd() * RELEASES.length)];
      if (!state.releases.has(id) && !state.artifacts.has(id) && !state.files.has(id) && inputs.length) {
        const chosen = [inputs[Math.floor(rnd() * inputs.length)]];
        ops.push({ op: 'addRelease', id, inputs: chosen });
      } else if (state.releases.has(id)) {
        ops.push({ op: 'removeRelease', id });
      }
    } else if (artifacts.length) {
      const from = artifacts[Math.floor(rnd() * artifacts.length)];
      const to = inputs[Math.floor(rnd() * inputs.length)];
      if (from !== to && !state.artifacts.get(from).inputs.includes(to)) {
        ops.push({ op: 'addEdge', from, to });
      }
    }
  }
  return ops;
}

function simulate(state, ops) {
  const sim = { files: new Map(state.files), artifacts: new Map(), releases: new Map() };
  for (const [id, a] of state.artifacts) sim.artifacts.set(id, { ...a, inputs: [...a.inputs] });
  for (const [id, r] of state.releases) sim.releases.set(id, { inputs: [...r.inputs] });
  for (const op of ops) {
    switch (op.op) {
      case 'putFile': sim.files.set(op.id, { content: op.content }); break;
      case 'addArtifact': sim.artifacts.set(op.id, { builder: op.builder, inputs: [...new Set(op.inputs)] }); break;
      case 'removeArtifact': sim.artifacts.delete(op.id); break;
      case 'addRelease': sim.releases.set(op.id, { inputs: [...new Set(op.inputs)] }); break;
      case 'removeRelease': sim.releases.delete(op.id); break;
      case 'addEdge': { const t = sim.artifacts.get(op.from) ?? sim.releases.get(op.from); t.inputs.push(op.to); break; }
      case 'removeEdge': { const t = sim.artifacts.get(op.from) ?? sim.releases.get(op.from); t.inputs.splice(t.inputs.indexOf(op.to), 1); break; }
    }
  }
  return sim;
}

test('incremental manifest matches full-rebuild reference over random transactions (<=10 nodes)', () => {
  for (let run = 0; run < 50; run++) {
    const rnd = mulberry32(1000 + run);
    const manifest = new Manifest();
    const reference = new Reference();
    let state = { files: new Map(), artifacts: new Map(), releases: new Map() };
    const txIds = [];
    for (let step = 0; step < 40; step++) {
      if (rnd() < 0.12 && txIds.length) {
        const tx = txIds[Math.floor(rnd() * txIds.length)];
        const r1 = manifest.rollback(tx);
        const r2 = reference.rollback(tx);
        assert.equal(r1.ok, r2.ok, `rollback ok mismatch run=${run} step=${step}`);
        if (r1.ok) {
          const idx = txIds.indexOf(tx);
          txIds.splice(idx);
          state = reference.state;
        }
      } else {
        const ops = randomOps(rnd, state);
        if (!ops.length) continue;
        const tx = `run${run}-tx${step}`;
        const r1 = manifest.commit(ops, tx);
        const r2 = reference.commit(ops, tx);
        assert.equal(r1.ok, r2.ok, `commit ok mismatch run=${run} step=${step}: ${JSON.stringify(r1.error)} vs ${JSON.stringify(r2.error)}`);
        if (!r1.ok) continue;
        txIds.push(tx);
        state = simulate(state, ops);
        assert.deepEqual(r1.diff.changed, r2.diff.changed, `changed mismatch run=${run} step=${step}`);
        assert.deepEqual(r1.diff.added, r2.diff.added, `added mismatch run=${run} step=${step}`);
        assert.deepEqual(r1.diff.removed, r2.diff.removed, `removed mismatch run=${run} step=${step}`);
        assert.deepEqual(r1.diff.releasesChanged, r2.diff.releasesChanged, `releasesChanged mismatch run=${run} step=${step}`);
        assert.deepEqual(r1.diff.failed, failedFrom(reference), `failed mismatch run=${run} step=${step}`);
        assert.deepEqual(r1.blocked, r2.blocked, `blocked mismatch run=${run} step=${step}`);
        assert.deepEqual(r1.certificate, r2.certificate, `certificate mismatch run=${run} step=${step}`);
      }
      assert.deepEqual(manifest.currentHashes(), reference.currentHashes(), `hashes mismatch run=${run} step=${step}`);
      assert.deepEqual(manifest.currentFailed(), reference.currentFailed(), `failed-state mismatch run=${run} step=${step}`);
      assert.deepEqual(manifest.currentBlocked(), reference.currentBlocked(), `blocked-state mismatch run=${run} step=${step}`);
      assert.deepEqual(manifest.certificate(), reference.certificate(), `certificate mismatch run=${run} step=${step}`);
    }
  }
});

function failedFrom(reference) {
  return reference.currentFailed();
}
