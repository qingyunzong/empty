import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, compilePattern } from '../src/engine.js';

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

// Independent reference: enumerate every subsequence of the window and keep
// those whose symbols satisfy the compiled pattern parts in order.
function bruteForceMatches(window, pattern) {
  const found = [];
  const n = window.length;
  for (let mask = 0; mask < (1 << n); mask += 1) {
    const chosen = [];
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) chosen.push(window[i]);
    }
    if (chosen.length !== pattern.size) continue;
    let ok = true;
    for (let j = 0; j < chosen.length; j += 1) {
      if (!pattern.parts[j](chosen[j].sym)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(chosen.map((event) => event.id));
  }
  return found;
}

function alarmSet(engine) {
  const set = new Map();
  for (const pattern of engine.patterns) {
    set.set(pattern.id, []);
  }
  for (const cert of engine.alarms.values()) {
    set.get(cert.pattern).push(cert.events);
  }
  for (const list of set.values()) {
    list.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return set;
}

const SYMS = ['A', 'B', 'AB', 'ERR1', 'ERR2', 'TEMP', 'CRIT', 'OK'];

function randomPattern(random, id) {
  const size = 1 + Math.floor(random() * 3);
  const parts = [];
  for (let i = 0; i < size; i += 1) {
    const kind = pick(random, ['lit', 'any', 're']);
    if (kind === 'lit') parts.push({ lit: pick(random, ['A', 'B', 'ERR', 'T']) });
    else if (kind === 'any') parts.push({ any: true });
    else parts.push({ re: pick(random, ['^ERR', 'B$', '^(A|TEMP)$', 'I']) });
  }
  return { id, parts };
}

test('random small logs (n<=12) match brute-force subsequence enumeration', () => {
  for (let seed = 1; seed <= 150; seed += 1) {
    const random = mulberry32(seed);
    const patternDefs = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) =>
      randomPattern(random, `p${i}`));
    const count = 1 + Math.floor(random() * 12);
    const events = Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      ts: Math.floor(random() * 8),
      sym: pick(random, SYMS),
    }));
    const windowSize = 1 + Math.floor(random() * count);
    const engine = new Engine(patternDefs);
    engine.apply({ setWindow: { n: windowSize } });
    const shuffled = [...events].sort(() => random() - 0.5);
    for (const event of shuffled) engine.apply({ upsert: event });

    const window = engine.windowEvents();
    const actual = alarmSet(engine);
    for (const def of patternDefs) {
      const compiled = compilePattern(def);
      const expected = bruteForceMatches(window, compiled)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(
        actual.get(def.id),
        expected,
        `seed=${seed} pattern=${def.id} window=${JSON.stringify(window.map((e) => e.sym))}`,
      );
    }
  }
});

test('random interleaved upsert/retract: state equals replay of final effective set', () => {
  for (let seed = 1000; seed < 1060; seed += 1) {
    const random = mulberry32(seed);
    const patternDefs = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) =>
      randomPattern(random, `p${i}`));
    const windowSize = 1 + Math.floor(random() * 6);
    const engine = new Engine(patternDefs);
    engine.apply({ setWindow: { n: windowSize } });
    const live = new Map();
    let counter = 0;
    const opCount = 4 + Math.floor(random() * 12);
    for (let step = 0; step < opCount; step += 1) {
      const doRetract = live.size > 0 && random() < 0.3;
      if (doRetract) {
        const id = pick(random, [...live.keys()]);
        engine.apply({ retract: { id } });
        live.delete(id);
      } else {
        const reuse = live.size > 0 && random() < 0.25;
        const id = reuse ? pick(random, [...live.keys()]) : `e${counter}`;
        if (!reuse) counter += 1;
        const event = { id, ts: Math.floor(random() * 10), sym: pick(random, SYMS) };
        engine.apply({ upsert: event });
        live.set(id, event);
      }
    }
    const replay = new Engine(patternDefs);
    replay.apply({ setWindow: { n: windowSize } });
    for (const event of live.values()) replay.apply({ upsert: event });
    assert.deepEqual(engine.windowEvents(), replay.windowEvents(), `seed=${seed} window`);
    assert.equal(
      engine.windowHash(engine.windowEvents()),
      replay.windowHash(replay.windowEvents()),
      `seed=${seed} hash`,
    );
    assert.deepEqual(
      [...engine.alarms.keys()].sort(),
      [...replay.alarms.keys()].sort(),
      `seed=${seed} alarms`,
    );
  }
});

test('emitted diff stream reconstructs the alarm set exactly', () => {
  const random = mulberry32(7);
  const patternDefs = [randomPattern(random, 'p0'), randomPattern(random, 'p1')];
  const engine = new Engine(patternDefs);
  const shadow = new Map();
  const ops = [{ setWindow: { n: 4 } }];
  for (let i = 0; i < 10; i += 1) ops.push({ upsert: { id: `e${i}`, ts: i, sym: pick(random, SYMS) } });
  ops.push({ retract: { id: 'e3' } }, { upsert: { id: 'e0', ts: 20, sym: 'ERR1' } }, { setWindow: { n: 2 } });
  for (const op of ops) {
    for (const output of engine.apply(op)) {
      const key = JSON.stringify([output.cert.pattern, ...output.cert.events]);
      if (output.op === 'emit') shadow.set(key, output.cert);
      else {
        assert.ok(shadow.has(key), `retract of unknown alarm ${key}`);
        shadow.delete(key);
      }
    }
  }
  assert.deepEqual([...shadow.keys()].sort(), [...engine.alarms.keys()].sort());
});
