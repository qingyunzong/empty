'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent brute force: maximum number of nodes completable from scratch,
// i.e. largest dependency-closed, per-owner-quota-feasible subset.
function bruteForceMaxCompletable(nodes, quotas) {
  const ids = Object.keys(nodes);
  const m = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  let best = 0;
  for (let mask = 0; mask < 2 ** m; mask += 1) {
    let ok = true;
    let count = 0;
    const perOwner = {};
    for (let i = 0; i < m && ok; i += 1) {
      if (!(mask & (1 << i))) continue;
      const n = nodes[ids[i]];
      for (const d of n.deps) {
        if (!(mask & (1 << idx.get(d)))) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      perOwner[n.owner] = (perOwner[n.owner] ?? 0) + n.bytes;
      count += 1;
    }
    if (!ok) continue;
    for (const [owner, sum] of Object.entries(perOwner)) {
      if (sum > (quotas[owner] ?? Infinity)) {
        ok = false;
        break;
      }
    }
    if (ok && count > best) best = count;
  }
  return best;
}

// Replay the event log: resource limits never exceeded, deps finish first.
function assertScheduleValid(events, state) {
  let cpu = 0;
  let mem = 0;
  const endTime = new Map();
  for (const e of events) {
    const n = state.nodes[e.node];
    if (e.type === 'start') {
      for (const d of n.deps) {
        if (endTime.has(d)) {
          assert.ok(endTime.get(d) <= e.time, `dep ${d} ends before ${e.node} starts`);
        } else {
          assert.strictEqual(state.nodes[d].status, 'done', `dep ${d} of ${e.node} is done`);
        }
      }
      cpu += n.cpu;
      mem += n.mem;
      assert.ok(cpu <= state.machine.cpus, `cpu ${cpu} <= ${state.machine.cpus} at t=${e.time}`);
      assert.ok(mem <= state.machine.mem, `mem ${mem} <= ${state.machine.mem} at t=${e.time}`);
    } else {
      cpu -= n.cpu;
      mem -= n.mem;
      if (e.type === 'end') endTime.set(e.node, e.time);
    }
  }
}

module.exports = { tmpdir, cleanup, mulberry32, bruteForceMaxCompletable, assertScheduleValid };
