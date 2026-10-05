'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBank } = require('../src/biobank');
const { runCli, stdoutLines } = require('./helpers');

function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

// Independent brute force: enumerate subsets (largest first) and test whether
// the subset admits a feasible slot assignment.
function bruteForceOptimal(racks, samples, quotaFor) {
  const n = samples.length;
  const assignable = (sub) => {
    const slots = racks.map((r) => new Array(r.capacity).fill(null));
    const dfs = (idx) => {
      if (idx === sub.length) return true;
      const s = sub[idx];
      for (let i = 0; i < racks.length; i++) {
        if (racks[i].zone !== s.zone) continue;
        const ps = [];
        for (let sl = 0; sl < racks[i].capacity; sl++) {
          const id = slots[i][sl];
          if (id !== null && sub[id].project === s.project) ps.push(sl);
        }
        for (let sl = 0; sl < racks[i].capacity; sl++) {
          if (slots[i][sl] !== null) continue;
          const min = ps[0];
          const max = ps[ps.length - 1];
          if (ps.length === 0 || sl === min - 1 || sl === max + 1 || (sl > min && sl < max)) {
            slots[i][sl] = idx;
            if (dfs(idx + 1)) return true;
            slots[i][sl] = null;
          }
        }
      }
      return false;
    };
    return dfs(0);
  };
  const masks = [];
  for (let m = 1; m < 1 << n; m++) masks.push(m);
  masks.sort((a, b) => popcount(b) - popcount(a));
  let best = 0;
  for (const mask of masks) {
    const pc = popcount(mask);
    if (pc <= best) break;
    const sub = [];
    const perProject = {};
    let quotaOk = true;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      sub.push(samples[i]);
      perProject[samples[i].project] = (perProject[samples[i].project] || 0) + 1;
      if (perProject[samples[i].project] > quotaFor(samples[i].project)) quotaOk = false;
    }
    if (!quotaOk) continue;
    if (assignable(sub)) best = pc;
  }
  return best;
}

function assertInvariants(bank, config) {
  const st = bank.getState();
  const occupied = new Set();
  const perProject = {};
  const byRackProject = {};
  for (const p of st.placed) {
    const key = `${p.rack}:${p.slot}`;
    assert.ok(!occupied.has(key), `slot ${key} occupied twice`);
    occupied.add(key);
    const sample = st.samples[p.id];
    perProject[sample.project] = (perProject[sample.project] || 0) + 1;
    const k = `${p.rack}|${sample.project}`;
    (byRackProject[k] = byRackProject[k] || []).push(p.slot);
  }
  for (const [k, slots] of Object.entries(byRackProject)) {
    slots.sort((a, b) => a - b);
    for (let i = 1; i < slots.length; i++) {
      assert.equal(slots[i], slots[i - 1] + 1, `project block not contiguous for ${k}`);
    }
  }
  for (const [proj, count] of Object.entries(perProject)) {
    const q = config.quotas && proj in config.quotas ? config.quotas[proj] : config.defaultQuota ?? Infinity;
    assert.ok(count <= q, `quota exceeded for project ${proj}: ${count} > ${q}`);
  }
}

const CONFIG_20 = {
  racks: [
    { id: 'r1', zone: '-80', capacity: 4 },
    { id: 'r2', zone: '-80', capacity: 4 },
    { id: 'r3', zone: '-40', capacity: 3 },
  ],
  quotas: { alpha: 4, beta: 3 },
  defaultQuota: 5,
  agingWeight: 10,
  freezeDelay: 3,
};

function scenario20() {
  const arrives = [
    [0, 's01', 'alpha', 9, '-80', 50],
    [0, 's02', 'alpha', 1, '-80', 50],
    [0, 's03', 'beta', 5, '-80', 50],
    [1, 's04', 'beta', 3, '-80', 50],
    [1, 's05', 'gamma', 7, '-40', 50],
    [2, 's06', 'alpha', 2, '-80', 50],
    [2, 's07', 'beta', 8, '-80', 50],
    [2, 's08', 'gamma', 4, '-40', 50],
    [3, 's09', 'alpha', 6, '-80', 50],
    [3, 's10', 'beta', 1, '-80', 50],
    [4, 's11', 'gamma', 9, '-80', 50],
    [4, 's12', 'alpha', 3, '-80', 4],
    [5, 's13', 'beta', 2, '-40', 50],
    [5, 's14', 'gamma', 5, '-80', 50],
    [6, 's15', 'alpha', 8, '-80', 50],
    [6, 's16', 'beta', 6, '-80', 50],
    [6, 's17', 'gamma', 2, '-40', 50],
    [6, 's19', 'delta', 4, '-80', 6],
    [6, 's20', 'delta', 6, '-40', 50],
    [7, 's18', 'gamma', 1, '-40', 50],
  ];
  const events = arrives.map(([time, id, project, priority, zone, deadline]) => ({
    type: 'arrive',
    time,
    sample: { id, project, priority, deadline, zone },
  }));
  events.push({ type: 'correct', time: 7, sampleId: 's06', priority: 10, deadline: 60 });
  events.push({ type: 'cancel', time: 8, sampleId: 's18' });
  return events;
}

function groupSteps(events) {
  const steps = [];
  let current = [];
  for (const ev of events) {
    if (ev.type === 'undo') {
      if (current.length) steps.push(current);
      steps.push([ev]);
      current = [];
    } else if (current.length && ev.time !== current[0].time) {
      steps.push(current);
      current = [ev];
    } else {
      current.push(ev);
    }
  }
  if (current.length) steps.push(current);
  return steps;
}

function runScenario(events, config) {
  const bank = createBank(config);
  const results = groupSteps(events).map((step) => bank.applyStep(step));
  return { bank, results };
}

test('20-sample mixed arrival scenario is deterministic and respects all hard constraints', () => {
  const events = scenario20();
  const first = runScenario(events, CONFIG_20);
  const second = runScenario(events, CONFIG_20);

  assert.equal(first.results.length, 9, 'one result per time step');
  assert.deepEqual(
    first.results.map((r) => r.hash),
    second.results.map((r) => r.hash),
    'two runs produce identical certificate hashes'
  );

  for (const r of first.results) assertInvariants(first.bank, CONFIG_20);
  assertInvariants(second.bank, CONFIG_20);

  const expiredIds = first.results.flatMap((r) => r.expired.map((e) => e.sample));
  assert.ok(expiredIds.includes('s19'), 's19 (deadline 6) expires while waiting');
  assert.ok(expiredIds.includes('s12'), 's12 (deadline 4) expires while waiting');

  const preempted = first.results.flatMap((r) => r.preempted);
  assert.ok(preempted.length > 0, 'scenario exercises preemption');

  const totalPlaced = first.bank.certState().placed.length;
  assert.ok(totalPlaced > 0);
});

test('CLI reproduces the library hashes for the 20-sample scenario', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biobank-'));
  const cfgPath = path.join(dir, 'config.json');
  const evPath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(cfgPath, JSON.stringify(CONFIG_20));
  const events = scenario20();
  fs.writeFileSync(evPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const res = runCli(['--config', cfgPath, '--events', evPath]);
  assert.equal(res.status, 0, res.stderr);
  const cliHashes = stdoutLines(res).map((r) => r.hash);
  const libHashes = runScenario(events, CONFIG_20).results.map((r) => r.hash);
  assert.deepEqual(cliHashes, libHashes);
});

test('placement count matches brute-force optimum for n <= 12', () => {
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let trial = 0; trial < 40; trial++) {
    const n = 2 + Math.floor(rand() * 11); // 2..12 samples
    const rackCount = 1 + Math.floor(rand() * 2);
    const racks = [];
    for (let i = 0; i < rackCount; i++) {
      racks.push({ id: `r${i}`, zone: rand() < 0.7 ? '-80' : '-40', capacity: 1 + Math.floor(rand() * 5) });
    }
    const projects = ['A', 'B', 'C'];
    const samples = [];
    for (let i = 0; i < n; i++) {
      samples.push({
        id: `s${String(i).padStart(2, '0')}`,
        project: projects[Math.floor(rand() * 3)],
        priority: 1 + Math.floor(rand() * 9),
        deadline: 1000,
        zone: rand() < 0.7 ? '-80' : '-40',
      });
    }
    const usable = samples.filter((s) => racks.some((r) => r.zone === s.zone));
    const config = { racks, defaultQuota: n, agingWeight: 10, freezeDelay: 1000 };
    const bank = createBank(config);
    bank.applyStep(samples.map((s) => ({ type: 'arrive', time: 0, sample: s })));
    const placedCount = bank.certState().placed.length;
    const expected = bruteForceOptimal(racks, usable, () => n);
    assert.equal(
      placedCount,
      expected,
      `trial ${trial}: placed ${placedCount} != optimal ${expected} for ${JSON.stringify({ racks, samples: usable })}`
    );
  }
});
