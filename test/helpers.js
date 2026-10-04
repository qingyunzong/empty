'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { compareCandidate, setupCost, changeoverCost } = require('../src/solver');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moldplan-'));
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent brute-force enumerator: tries every job->shift assignment and
// every within-shift order, keeping the best by (cost, canonical plan string).
// Used as ground truth for the DP solver on small instances (n <= 9).
function bruteForce(state) {
  const shiftIds = Object.keys(state.shifts).sort();
  const jobIds = Object.keys(state.jobs).sort();
  const pending = new Set(state.pending || []);
  const free = jobIds.filter((j) => !pending.has(j));

  const usage = {};
  for (const id of free) {
    const job = state.jobs[id];
    usage[job.mold] = (usage[job.mold] || 0) + job.shots;
  }
  for (const mold of Object.keys(usage)) {
    const life = state.molds[mold] ? state.molds[mold].life : 0;
    if (usage[mold] > life) return { feasible: false, cost: null, str: null };
  }

  const caps = shiftIds.map((s) => {
    let cap = state.shifts[s].capacity;
    for (const m of state.maintenance || []) if (m.shift === s) cap -= m.duration;
    return cap;
  });

  const orderMemo = new Map();
  function bestOrder(ids, si) {
    const key = si + '|' + ids.join(',');
    if (orderMemo.has(key)) return orderMemo.get(key);
    let best = null;
    const permute = (arr, l) => {
      if (l === arr.length) {
        let cost = 0;
        for (let i = 0; i < arr.length; i++) {
          const job = state.jobs[arr[i]];
          cost += job.duration;
          cost += i === 0
            ? setupCost(state, job.mold)
            : changeoverCost(state, state.jobs[arr[i - 1]].mold, job.mold);
        }
        if (cost <= caps[si]) {
          const str = arr.join(',');
          if (!best || cost < best.cost || (cost === best.cost && str < best.str)) {
            best = { cost, str, seq: arr.slice() };
          }
        }
        return;
      }
      for (let i = l; i < arr.length; i++) {
        [arr[l], arr[i]] = [arr[i], arr[l]];
        permute(arr, l + 1);
        [arr[l], arr[i]] = [arr[i], arr[l]];
      }
    };
    permute(ids.slice(), 0);
    orderMemo.set(key, best);
    return best;
  }

  let best = null;
  const assign = new Array(free.length).fill(0);
  function rec(i) {
    if (i === free.length) {
      const lists = shiftIds.map(() => []);
      for (let k = 0; k < free.length; k++) lists[assign[k]].push(free[k]);
      let total = 0;
      let str = '';
      for (let s = 0; s < shiftIds.length; s++) {
        const o = bestOrder(lists[s], s);
        if (!o) return;
        total += o.cost;
        str += shiftIds[s] + ':' + o.str + '|';
      }
      const cand = { cost: total, str };
      if (!best || compareCandidate(cand, best) < 0) best = cand;
      return;
    }
    for (let s = 0; s < shiftIds.length; s++) {
      assign[i] = s;
      rec(i + 1);
    }
  }
  rec(0);
  return best
    ? { feasible: true, cost: best.cost, str: best.str }
    : { feasible: false, cost: null, str: null };
}

function randomState(rand, n) {
  const moldIds = ['M1', 'M2', 'M3'].slice(0, 1 + Math.floor(rand() * 3));
  const shiftCount = 2 + Math.floor(rand() * 2);
  const state = {
    molds: {}, jobs: {}, shifts: {}, setup: {}, changeover: {},
    maintenance: [], pinned: {}, pinMeta: {}, pending: []
  };
  for (let i = 0; i < shiftCount; i++) {
    state.shifts['S' + (i + 1)] = { capacity: 40 + Math.floor(rand() * 80) };
  }
  for (const m of moldIds) state.setup[m] = Math.floor(rand() * 11);
  for (const a of moldIds) {
    state.changeover[a] = {};
    for (const b of moldIds) {
      if (a !== b) state.changeover[a][b] = Math.floor(rand() * 21);
    }
  }
  let totalShots = {};
  for (let i = 0; i < n; i++) {
    const mold = moldIds[Math.floor(rand() * moldIds.length)];
    const shots = 10 + Math.floor(rand() * 40);
    state.jobs['J' + (i + 1)] = { mold, shots, duration: 5 + Math.floor(rand() * 26) };
    totalShots[mold] = (totalShots[mold] || 0) + shots;
  }
  for (const m of moldIds) {
    const need = totalShots[m] || 0;
    state.molds[m] = { life: Math.floor(need * (0.5 + rand())) };
  }
  return state;
}

module.exports = { tmpdir, mulberry32, bruteForce, randomState };
