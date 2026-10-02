import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarginEngine } from '../src/engine.js';
import { fullRecompute } from '../src/full.js';

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

function genScenario(seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  const slots = int(1, 4);
  const slotCapacity = int(1, 2);
  const symbols = ['ES', 'NQ', 'CL'].slice(0, int(1, 3));
  const nAccounts = int(1, 8); // n <= 8

  const accounts = [];
  for (let i = 0; i < nAccounts; i += 1) {
    const positions = {};
    for (const sym of symbols) {
      if (rand() < 0.6) positions[sym] = int(-3, 5) || 1;
    }
    if (Object.keys(positions).length === 0) positions[symbols[0]] = 1;
    const maintenanceLine = int(50, 150);
    accounts.push({
      id: `A${i}`,
      priority: int(0, 3),
      maintenanceLine,
      liquidationLine: maintenanceLine - int(10, 60),
      deadlineSlot: int(0, slots + 1),
      cash: int(-40, 200),
      positions,
      initialMarks: Object.fromEntries(symbols.map((s) => [s, int(0, 120)])),
    });
  }

  const events = [];
  const top = Object.fromEntries(symbols.map((s) => [s, 0]));
  const nEvents = int(1, 14);
  for (let i = 0; i < nEvents; i += 1) {
    const sym = pick(symbols);
    const r = rand();
    if (r < 0.55) {
      top[sym] += 1; // fresh version
      events.push({ type: 'tick', symbol: sym, version: top[sym], price: int(-30, 200) });
    } else if (r < 0.75 && top[sym] > 0) {
      // possibly stale tick (version <= current top)
      const v = int(Math.max(1, top[sym] - 1), top[sym] + 1);
      if (v > top[sym]) top[sym] = v;
      events.push({ type: 'tick', symbol: sym, version: v, price: int(-30, 200) });
    } else if (top[sym] > 0) {
      // undo: usually the top version, sometimes a gapped/unknown one
      const v = rand() < 0.7 ? top[sym] : top[sym] + int(-1, 2);
      events.push({ type: 'undo', symbol: sym, version: v });
      if (v === top[sym]) top[sym] -= 1;
    } else {
      top[sym] += 1;
      events.push({ type: 'tick', symbol: sym, version: top[sym], price: int(-30, 200) });
    }
  }
  return { accounts, events, slots, slotCapacity };
}

function runIncremental({ accounts, events, slots, slotCapacity }) {
  const engine = new MarginEngine({ slots, slotCapacity });
  for (const a of accounts) engine.addAccount(a);
  for (const ev of events) {
    if (ev.type === 'undo') engine.undoTick(ev.symbol, ev.version);
    else engine.applyTick(ev);
  }
  return engine.finalize();
}

test('incremental engine matches independent full recompute (n<=8, 500 seeds)', () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const scenario = genScenario(seed);
    const inc = runIncremental(scenario);
    const full = fullRecompute(scenario);
    assert.deepEqual(inc, full, `mismatch at seed ${seed}`);
  }
});

test('incremental recompute count stays below full recompute work', () => {
  const scenario = genScenario(42);
  const engine = new MarginEngine({ slots: scenario.slots, slotCapacity: scenario.slotCapacity });
  for (const a of scenario.accounts) engine.addAccount(a);
  for (const ev of scenario.events) {
    if (ev.type === 'undo') engine.undoTick(ev.symbol, ev.version);
    else engine.applyTick(ev);
  }
  const fullWork = scenario.accounts.length * (scenario.events.length + 1);
  assert.ok(engine.stats.recomputes <= fullWork);
});
