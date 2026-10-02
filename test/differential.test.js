import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { RefWorld } from '../src/reference.js';
import { hashSnapshot } from '../src/canonical.js';

const NOW = 1_000_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function refSnapshot(world) {
  const st = world.state;
  const computed = world.computed();
  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    batches: [...st.batches.values()]
      .map((b) => ({ id: b.id, concentration: b.concentration, expiry: b.expiry, withdrawn: b.withdrawn, corrected: b.corrected }))
      .sort((x, y) => byId(x.id, y.id)),
    nodes: [...st.nodes.values()]
      .map((n) => ({ id: n.id, kind: n.kind, batch: n.batchId, protocol: n.protocol, deps: [...n.deps].sort() }))
      .sort((x, y) => byId(x.id, y.id)),
    substitutes: [...st.subs.entries()]
      .map(([result, set]) => ({ result, batches: [...set].sort() }))
      .sort((x, y) => byId(x.result, y.result)),
    computed: [...computed.entries()]
      .map(([node, c]) => ({ node, status: c.status, reason: c.reason, chosen: c.chosen, path: c.path }))
      .sort((x, y) => byId(x.node, y.node)),
  };
}

function compareWorlds(engine, world, ctx) {
  const expected = world.computed();
  const actual = new Map([...engine.nodes.keys()].map((id) => [id, engine.computed.get(id)]));
  assert.deepEqual(actual, expected, `computed mismatch: ${ctx}`);
  assert.equal(engine.stateHash(), hashSnapshot(refSnapshot(world)), `hash mismatch: ${ctx}`);
}

function applyBoth(engine, world, op, ctx) {
  const a = engine[op.method](...op.args);
  const b = world[op.method](...op.args);
  if (a.ok !== b.ok) throw new Error(`ok mismatch (${ctx}): engine=${JSON.stringify(a)} ref=${JSON.stringify(b)}`);
  if (!a.ok) assert.equal(a.error.code, b.error.code, `error code mismatch: ${ctx}`);
  compareWorlds(engine, world, ctx);
}

function randomExpiry(rng) {
  return pick(rng, [null, null, NOW - 1000, NOW - 1, NOW, NOW + 1, NOW + 1000, NOW + 5000]);
}

function runSeed(seed) {
  const rng = mulberry32(seed);
  const engine = new Engine({ now: NOW });
  const world = new RefWorld({ now: NOW });
  const ctx = (op) => `seed=${seed} op=${JSON.stringify(op)}`;

  const batchIds = Array.from({ length: 8 }, (_, i) => `b${i + 1}`);
  const resultIds = Array.from({ length: 8 }, (_, i) => `r${i + 1}`);
  const derivedIds = Array.from({ length: 4 }, (_, i) => `d${i + 1}`);
  const nodeIds = [];

  for (const id of batchIds) {
    const op = { method: 'addBatch', args: [{ id, concentration: Math.round(rng() * 50) / 10, expiry: randomExpiry(rng) }] };
    applyBoth(engine, world, op, ctx(op));
  }

  // Interleave result and derived-node creation; deps only point backwards.
  let ri = 0;
  let di = 0;
  while (ri < resultIds.length || di < derivedIds.length) {
    if (ri < resultIds.length && (di >= derivedIds.length || rng() < 0.65)) {
      const id = resultIds[ri];
      ri += 1;
      const deps = nodeIds.filter(() => rng() < 0.25);
      const op = {
        method: 'addResult',
        args: [{ id, batch: pick(rng, batchIds), protocol: rng() < 0.15 ? '' : `p${1 + Math.floor(rng() * 3)}`, deps }],
      };
      applyBoth(engine, world, op, ctx(op));
      nodeIds.push(id);
      // Random initial substitutes.
      for (const b of batchIds) {
        if (rng() < 0.2) {
          const sub = { method: 'addSubstitute', args: [id, b] };
          applyBoth(engine, world, sub, ctx(sub));
        }
      }
    } else {
      const id = derivedIds[di];
      di += 1;
      const deps = nodeIds.filter(() => rng() < 0.5).slice(0, 3);
      const op = { method: 'addNode', args: [{ id, kind: rng() < 0.5 ? 'chart' : 'conclusion', deps }] };
      applyBoth(engine, world, op, ctx(op));
      nodeIds.push(id);
    }
  }

  // Random mutation walk.
  for (let step = 0; step < 45; step += 1) {
    const roll = rng();
    let op;
    if (roll < 0.16) {
      op = { method: 'withdrawBatch', args: [pick(rng, batchIds)] };
    } else if (roll < 0.3) {
      op = { method: 'correctConcentration', args: [pick(rng, batchIds), Math.round(rng() * 50) / 10] };
    } else if (roll < 0.44) {
      op = { method: 'setExpiry', args: [pick(rng, batchIds), randomExpiry(rng)] };
    } else if (roll < 0.58) {
      op = { method: 'addSubstitute', args: [pick(rng, resultIds), pick(rng, batchIds)] };
    } else if (roll < 0.7) {
      op = { method: 'removeSubstitute', args: [pick(rng, resultIds), pick(rng, batchIds)] };
    } else if (roll < 0.8) {
      op = { method: 'addEdge', args: [pick(rng, nodeIds), pick(rng, nodeIds)] };
    } else if (roll < 0.88) {
      op = { method: 'undo', args: [] };
    } else if (roll < 0.94) {
      op = { method: 'redo', args: [] };
    } else {
      op = { method: 'addResult', args: [{ id: `x${step}`, batch: 'ghost', protocol: 'p1' }] };
    }
    applyBoth(engine, world, op, `step=${step} ${ctx(op)}`);
  }
}

test('differential: engine matches exhaustive substitute-path reference (<=8 batches, <=8 results)', () => {
  for (let seed = 1; seed <= 60; seed += 1) runSeed(seed);
});
