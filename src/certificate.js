import { createHash } from 'node:crypto';
import {
  createInitialState,
  cloneState,
  stateKey,
  nextEventTime,
  applyCompletions,
  applyArrivals,
  applyCustomEvents,
  starvedStations,
} from './core.js';

function firstPullable(state, norm) {
  for (let i = 0; i < state.stations.length; i += 1) {
    if (state.stations[i].slots.length < norm.stations[i].cap && state.buffers[i].length > 0) return i;
  }
  return -1;
}

// Mirrors Simulation's per-timestamp semantics, but branches over every
// possible dequeue choice instead of applying one fixed policy. `phase` is
// 'pre' (before custom events + arrivals at this timestamp) or 'post'.
function resolve(s, norm, phase, out) {
  const { violation } = applyCompletions(s, norm, null);
  if (violation) {
    out.push({ violation });
    return;
  }
  const i = firstPullable(s, norm);
  if (i !== -1) {
    for (const item of s.buffers[i]) {
      const s2 = cloneState(s);
      const idx = s2.buffers[i].findIndex((it) => it.id === item.id);
      s2.buffers[i].splice(idx, 1);
      s2.stations[i].slots.push({ item, end: s2.time + norm.stations[i].proc });
      resolve(s2, norm, phase, out);
    }
    return;
  }
  if (phase === 'pre') {
    applyCustomEvents(s, norm);
    const v2 = applyArrivals(s, norm, null);
    if (v2) {
      out.push({ violation: v2 });
      return;
    }
    resolve(s, norm, 'post', out);
    return;
  }
  out.push({ state: s });
}

// Finite-horizon state-space coverage certificate. Explores every state
// reachable within the horizon under all dequeue tie-break choices and checks
// each for overflow/starvation. The certificate is only `covered` when the
// exploration finished within the state budget and no reachable event lies
// beyond the horizon; otherwise the caller must not report SAFE.
export function buildCertificate(norm) {
  const seen = new Set();
  const frontier = [createInitialState(norm)];
  const maxOccupancy = norm.buffers.map(() => 0);
  const violations = [];
  let explored = 0;
  let transitions = 0;
  let exhausted = false;
  let truncated = false;
  while (frontier.length) {
    if (explored >= norm.stateBudget) {
      exhausted = true;
      break;
    }
    const state = frontier.pop();
    const key = `${state.time}|${stateKey(state)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    explored += 1;
    state.buffers.forEach((b, i) => {
      if (b.length > maxOccupancy[i]) maxOccupancy[i] = b.length;
    });
    const t = nextEventTime(state, norm);
    if (t === null) continue;
    if (t > norm.horizon) {
      truncated = true;
      continue;
    }
    const s = cloneState(state);
    s.time = t;
    const leaves = [];
    resolve(s, norm, 'pre', leaves);
    for (const leaf of leaves) {
      transitions += 1;
      if (leaf.violation) {
        violations.push(leaf.violation);
        continue;
      }
      const starved = starvedStations(leaf.state, norm);
      if (starved.length) {
        violations.push({ type: 'starvation', station: starved[0], time: leaf.state.time });
        continue;
      }
      frontier.push(leaf.state);
    }
  }
  const covered = !exhausted && !truncated;
  const hash = createHash('sha256');
  for (const k of [...seen].sort()) {
    hash.update(k);
    hash.update('\n');
  }
  violations.sort((a, b) => a.time - b.time);
  return {
    covered,
    horizon: norm.horizon,
    statesExplored: explored,
    transitions,
    maxOccupancy,
    violations,
    digest: hash.digest('hex'),
  };
}
