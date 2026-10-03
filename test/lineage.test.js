import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT,
  TraceError,
  parseJsonl,
  buildState,
  applyEvents,
  correctInspection,
  descendantsOf,
  recallCertificate,
  verifyCertificate,
} from '../src/lineage.js';

function stateFrom(text) {
  return buildState(parseJsonl(text));
}

function contaminatedSet(state) {
  return new Set(state.order.filter((id) => state.contaminated[id]));
}

test('contamination propagates through mix and split edges', () => {
  const state = stateFrom(`
{"type":"charge","batch":"RM1"}
{"type":"charge","batch":"RM2"}
{"type":"inspect","id":"I1","batch":"RM1","status":"fail"}
{"type":"mix","inputs":["RM1","RM2"],"output":"WIP1"}
{"type":"split","input":"WIP1","outputs":["FG1","FG2"]}
`);
  assert.deepEqual([...contaminatedSet(state)].sort(), ['FG1', 'FG2', 'RM1', 'WIP1']);
  assert.deepEqual(state.sources, ['RM1']);
});

test('unknown inspection status is marked unknown, never treated as fail', () => {
  const state = stateFrom(`
{"type":"charge","batch":"A"}
{"type":"inspect","id":"I1","batch":"A","status":"pending-review"}
{"type":"split","input":"A","outputs":["B"]}
`);
  const insp = state.batches.A.inspections[0];
  assert.equal(insp.status, 'unknown');
  assert.equal(insp.raw, 'pending-review');
  assert.deepEqual([...contaminatedSet(state)], []);
});

test('tombstone blocks forward propagation but keeps upstream evidence', () => {
  const state = stateFrom(`
{"type":"charge","batch":"A"}
{"type":"inspect","id":"I1","batch":"A","status":"fail"}
{"type":"split","input":"A","outputs":["B","C"]}
{"type":"scrap","batch":"B"}
{"type":"split","input":"B","outputs":["D"]}
`);
  const contaminated = contaminatedSet(state);
  assert.ok(contaminated.has('A'), 'upstream evidence preserved');
  assert.ok(contaminated.has('B'), 'scrapped node itself stays contaminated');
  assert.ok(contaminated.has('C'), 'unblocked sibling still contaminated');
  assert.ok(!contaminated.has('D'), 'tombstone blocks propagation past B');
});

test('cycle exits with code 6', () => {
  assert.throws(
    () => stateFrom(`
{"type":"charge","batch":"A"}
{"type":"mix","inputs":["A"],"output":"B"}
{"type":"link","from":"B","to":"A"}
`),
    (err) => err instanceof TraceError && err.exitCode === EXIT.CYCLE,
  );
  assert.throws(
    () => stateFrom(`
{"type":"charge","batch":"A"}
{"type":"mix","inputs":["A"],"output":"B"}
{"type":"mix","inputs":["B"],"output":"C"}
{"type":"link","from":"C","to":"B"}
`),
    (err) => err instanceof TraceError && err.exitCode === EXIT.CYCLE,
  );
  assert.doesNotThrow(() => stateFrom(`
{"type":"charge","batch":"A"}
{"type":"mix","inputs":["A"],"output":"B"}
{"type":"mix","inputs":["B"],"output":"C"}
`));
});

test('reference to nonexistent batch exits with code 7', () => {
  for (const text of [
    `{"type":"mix","inputs":["GHOST"],"output":"B"}`,
    `{"type":"charge","batch":"A"}\n{"type":"split","input":"NOPE","outputs":["B"]}`,
    `{"type":"charge","batch":"A"}\n{"type":"inspect","batch":"ZZZ","status":"fail"}`,
    `{"type":"charge","batch":"A"}\n{"type":"scrap","batch":"ZZZ"}`,
    `{"type":"charge","batch":"A"}\n{"type":"charge","batch":"A"}`,
  ]) {
    assert.throws(
      () => stateFrom(text),
      (err) => err instanceof TraceError && err.exitCode === EXIT.MISSING_REF,
      text,
    );
  }
});

test('multiple earliest sources are ordered lexicographically', () => {
  const state = stateFrom(`
{"type":"charge","batch":"B2"}
{"type":"charge","batch":"A9"}
{"type":"charge","batch":"B10"}
{"type":"inspect","id":"I1","batch":"B10","status":"fail"}
{"type":"inspect","id":"I2","batch":"B2","status":"fail"}
{"type":"inspect","id":"I3","batch":"A9","status":"fail"}
{"type":"mix","inputs":["B2","A9"],"output":"M"}
`);
  assert.deepEqual(state.sources, ['A9', 'B10', 'B2']);
});

// Acceptance 1: random small graphs cross-checked against an independent DFS enumeration.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvents(rand) {
  const events = [];
  const batches = [];
  const roots = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < roots; i += 1) {
    const id = `N${batches.length}`;
    events.push({ type: 'charge', batch: id });
    batches.push(id);
  }
  const steps = 3 + Math.floor(rand() * 10);
  for (let i = 0; i < steps; i += 1) {
    const roll = rand();
    if (roll < 0.35 && batches.length >= 2) {
      const a = batches[Math.floor(rand() * batches.length)];
      const b = batches[Math.floor(rand() * batches.length)];
      const out = `N${batches.length}`;
      events.push({ type: 'mix', inputs: [...new Set([a, b])], output: out });
      batches.push(out);
    } else if (roll < 0.7) {
      const src = batches[Math.floor(rand() * batches.length)];
      const n = 1 + Math.floor(rand() * 2);
      const outs = [];
      for (let k = 0; k < n; k += 1) {
        const out = `N${batches.length}`;
        batches.push(out);
        outs.push(out);
      }
      events.push({ type: 'split', input: src, outputs: outs });
    } else if (roll < 0.9) {
      const batch = batches[Math.floor(rand() * batches.length)];
      const statuses = ['pass', 'fail', 'fail', 'pending', 're-test'];
      events.push({ type: 'inspect', id: `I${events.length}`, batch, status: statuses[Math.floor(rand() * statuses.length)] });
    } else {
      events.push({ type: 'scrap', batch: batches[Math.floor(rand() * batches.length)] });
    }
  }
  return events;
}

// Independent oracle: plain recursive DFS over parent links, written separately
// from the library's Kahn-order implementation.
function dfsOracle(events) {
  const parents = new Map();
  const lastStatus = new Map();
  const scrappedAt = new Map();
  const ids = [];
  events.forEach((ev, seq) => {
    if (ev.type === 'charge') { ids.push(ev.batch); parents.set(ev.batch, []); }
    if (ev.type === 'mix') {
      ids.push(ev.output);
      parents.set(ev.output, ev.inputs.map((p) => ({ p, seq })));
    }
    if (ev.type === 'split') {
      for (const o of ev.outputs) { ids.push(o); parents.set(o, [{ p: ev.input, seq }]); }
    }
    if (ev.type === 'inspect') {
      lastStatus.set(ev.batch, ev.status === 'pass' || ev.status === 'fail' ? ev.status : 'unknown');
    }
    if (ev.type === 'scrap' && !scrappedAt.has(ev.batch)) scrappedAt.set(ev.batch, seq);
  });
  const memo = new Map();
  function contaminated(id) {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false);
    let result = lastStatus.get(id) === 'fail';
    if (!result) {
      for (const { p, seq } of parents.get(id)) {
        const cut = scrappedAt.get(p);
        const blocked = cut !== undefined && seq > cut;
        if (!blocked && contaminated(p)) { result = true; break; }
      }
    }
    memo.set(id, result);
    return result;
  }
  return new Set(ids.filter(contaminated));
}

test('acceptance 1: random DAGs match independent DFS enumeration', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const events = randomEvents(mulberry32(seed));
    const state = buildState(events);
    assert.deepEqual(
      [...contaminatedSet(state)].sort(),
      [...dfsOracle(events)].sort(),
      `seed ${seed}`,
    );
  }
});

test('acceptance 2: correcting one inspection only changes nodes inside its closure', () => {
  const state = stateFrom(`
{"type":"charge","batch":"A"}
{"type":"charge","batch":"Z"}
{"type":"inspect","id":"I1","batch":"A","status":"fail"}
{"type":"inspect","id":"I2","batch":"Z","status":"fail"}
{"type":"mix","inputs":["A"],"output":"M"}
{"type":"split","input":"M","outputs":["X","Y"]}
{"type":"split","input":"Z","outputs":["W"]}
{"type":"charge","batch":"ISO"}
`);
  const before = { ...state.contaminated };
  const closure = descendantsOf(state, 'A');
  const { changed } = correctInspection(state, { id: 'C1', batch: 'A', status: 'pass', corrects: 'I1' });

  for (const node of changed) {
    assert.ok(closure.has(node), `changed node ${node} must be inside closure of A`);
  }
  for (const node of state.order) {
    if (!closure.has(node)) {
      assert.equal(state.contaminated[node], before[node], `node ${node} outside closure must be unchanged`);
    }
  }
  assert.deepEqual([...changed].sort(), ['A', 'M', 'X', 'Y']);
  assert.ok(state.contaminated.Z && state.contaminated.W, 'unrelated branch untouched');
  assert.ok(!state.contaminated.A && !state.contaminated.X);
  assert.equal(state.batches.A.inspections.length, 2, 'history kept: compensation appended, not replaced');
  assert.equal(state.batches.A.inspections[0].status, 'fail');
});

test('acceptance 3: split added after scrap does not revive old risk', () => {
  const state = stateFrom(`
{"type":"charge","batch":"X"}
{"type":"inspect","id":"I1","batch":"X","status":"fail"}
{"type":"split","input":"X","outputs":["Y"]}
{"type":"scrap","batch":"X"}
`);
  assert.ok(state.contaminated.Y, 'edge created before scrap still carries contamination');
  applyEvents(state, [{ type: 'split', input: 'X', outputs: ['Z'] }]);
  assert.ok(!state.contaminated.Z, 'split added after scrap does not revive old risk');
  assert.ok(state.contaminated.X, 'evidence on X preserved');
  assert.deepEqual(state.sources, ['X']);
});

test('acceptance 4: certificate replays and detects tampering', () => {
  const events = parseJsonl(`
{"type":"charge","batch":"A"}
{"type":"inspect","id":"I1","batch":"A","status":"fail"}
{"type":"split","input":"A","outputs":["P1","P2"]}
`);
  const state = buildState(events);
  const cert = recallCertificate(state);
  assert.equal(cert.ruleVersion, '1.0.0');
  assert.ok(cert.inputHash.startsWith('sha256:'));
  assert.deepEqual(cert.boundary.sources, ['A']);
  assert.deepEqual(cert.boundary.affectedProducts, ['P1', 'P2']);

  assert.ok(verifyCertificate(events, cert).ok, 'replay from same events verifies');

  const tampered = { ...cert, boundary: { ...cert.boundary, affectedProducts: ['P1'] } };
  const result = verifyCertificate(events, tampered);
  assert.ok(!result.ok);
  assert.ok(result.mismatches.includes('boundary'));
});
