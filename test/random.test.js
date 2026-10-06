import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { simulate } from './simulator.js';

// deterministic PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TXS = ['x', 'y', 'z'];
const REV_IDS = ['c0', 'c1', 'c2', 'c3', 'c', 'nope'];

function randOp(rng) {
  const kind = Math.floor(rng() * 4);
  const amt = `${1 + Math.floor(rng() * 200)}/${1 + Math.floor(rng() * 50)}`;
  switch (kind) {
    case 0: return { op: 'freeze', tx: TXS[Math.floor(rng() * 3)], amt };
    case 1: return { op: 'capture', tx: TXS[Math.floor(rng() * 3)], amt };
    case 2: return { op: 'void', tx: TXS[Math.floor(rng() * 3)] };
    default: return { op: 'reverse', captureId: REV_IDS[Math.floor(rng() * REV_IDS.length)] };
  }
}

test('acceptance 4: N<=10 random ops match independent simulator (50 seeds)', () => {
  for (let seed = 0; seed < 50; seed++) {
    const rng = mulberry32(seed);
    const n = 1 + Math.floor(rng() * 10); // N <= 10
    const ops = Array.from({ length: n }, () => randOp(rng));
    const limit = '20';

    const engine = new Engine();
    engine.apply({ op: 'init', limit });
    const engineResults = ops.map((op) => {
      try {
        const { result } = engine.apply(op);
        return { ok: true, capId: result.capId };
      } catch (e) {
        return { ok: false, code: e.code };
      }
    });

    const sim = simulate(limit, ops);

    assert.deepEqual(
      engineResults.map((r) => (r.ok ? { ok: true, capId: r.capId } : r)),
      sim.results.map((r) => (r.ok ? { ok: true, capId: r.capId } : r)),
      `seed ${seed}: per-op outcomes diverge for ${JSON.stringify(ops)}`,
    );

    const es = engine.snapshot();
    const ss = sim.state;
    const engineCaps = {};
    for (const [k, v] of Object.entries(es.captures)) engineCaps[k] = v.settled;
    assert.deepEqual(
      { holds: es.holds, captures: engineCaps, frozen: es.frozen, captured: es.captured, available: es.available },
      ss,
      `seed ${seed}: final state diverges`,
    );
  }
});
