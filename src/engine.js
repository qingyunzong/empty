'use strict';
const { canon, sha256 } = require('./canon');
const { leafHash, merkleRoot, certificate } = require('./merkle');
const {
  DomainError,
  UsageError,
  overlaps,
  normalizeScenario,
  normalizeWindow,
  validateLocked,
  isFaultBlocked,
} = require('./model');
const { makeCtx, solve, soloCapacity } = require('./schedule');

// Re-plan the affected stations. Scheduled windows of every other station are
// pinned as fixed constraints, so unaffected stations keep bit-identical plans.
// opts.pinOutside (a fault interval) additionally pins the affected station's
// own schedule outside that interval and limits candidates to the interval.
function computePlan(model, affectedList, prevAssignments, opts = {}) {
  const affectedSet = new Set(affectedList);
  const pinned = [];
  for (const [stId, wins] of prevAssignments) {
    for (const w of wins) {
      if (!affectedSet.has(stId)) pinned.push(w);
      else if (opts.pinOutside && !overlaps(w, opts.pinOutside)) pinned.push(w);
    }
  }
  const pinnedKeys = new Set(pinned.map((w) => `${w.station}/${w.id}`));
  const candidates = [];
  for (const stId of affectedSet) {
    const st = model.stations.get(stId);
    for (const w of st.windows) {
      if (pinnedKeys.has(`${stId}/${w.id}`)) continue;
      if (opts.pinOutside && !overlaps(w, opts.pinOutside)) continue;
      // Locked windows are never preempted: they stay candidates (forced) even
      // when a fault overlaps them. Unlocked fault-blocked windows are out.
      if (!w.locked && isFaultBlocked(model, stId, w)) continue;
      candidates.push(w);
    }
  }
  const ctx = makeCtx(model, affectedSet, pinned);
  const chosen = solve(candidates, ctx);
  const assignments = new Map();
  for (const stId of model.stations.keys()) assignments.set(stId, []);
  const add = (w) => assignments.get(w.station).push(w);
  for (const w of pinned) add(w);
  for (const w of chosen) add(w);
  for (const wins of assignments.values()) {
    wins.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  }
  const replanned = [];
  for (const stId of affectedSet) {
    const before = (prevAssignments.get(stId) || []).map((w) => w.id).join(',');
    const after = (assignments.get(stId) || []).map((w) => w.id).join(',');
    if (before !== after) replanned.push(stId);
  }
  return { assignments, replanned: replanned.sort() };
}

function affectedClosure(model, seeds) {
  const affected = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    const links = new Set([...affected].map((id) => model.stations.get(id).link));
    for (const [id, st] of model.stations) {
      if (!affected.has(id) && links.has(st.link)) {
        affected.add(id);
        grew = true;
      }
    }
  }
  return affected;
}

function applyCorrection(model, correction) {
  if (correction === null || typeof correction !== 'object' || Array.isArray(correction)) {
    throw new UsageError('correction must be an object');
  }
  if (correction.stations === null || typeof correction.stations !== 'object') {
    throw new UsageError('correction requires a stations object');
  }
  const changed = [];
  for (const [stId, mod] of Object.entries(correction.stations)) {
    const st = model.stations.get(stId);
    if (!st) throw new UsageError(`correction: unknown station ${stId}`);
    changed.push(stId);
    if (mod === null || typeof mod !== 'object') {
      throw new UsageError(`correction ${stId}: value must be an object`);
    }
    if (mod.closeWindows !== undefined) {
      if (!Array.isArray(mod.closeWindows)) {
        throw new UsageError(`correction ${stId}: closeWindows must be an array`);
      }
      for (const id of mod.closeWindows) {
        const idx = st.windows.findIndex((w) => w.id === id);
        if (idx === -1) throw new UsageError(`correction ${stId}: unknown window ${id}`);
        st.windows.splice(idx, 1);
      }
    }
    if (mod.addWindows !== undefined) {
      if (!Array.isArray(mod.addWindows)) {
        throw new UsageError(`correction ${stId}: addWindows must be an array`);
      }
      for (const raw of mod.addWindows) {
        const w = normalizeWindow(raw, stId, st.link);
        if (st.windows.some((x) => x.id === w.id)) {
          throw new UsageError(`correction ${stId}: duplicate window ${w.id}`);
        }
        st.windows.push(w);
      }
    }
    if (mod.battery !== undefined) {
      if (!Number.isInteger(mod.battery)) {
        throw new UsageError(`correction ${stId}: battery must be an integer`);
      }
      if (mod.battery < 0) {
        throw new DomainError(
          `negative battery: correction sets station ${stId} battery to ${mod.battery}`
        );
      }
      st.battery = mod.battery;
    }
  }
  validateLocked(model);
  return changed;
}

function validateFault(model, f) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) {
    throw new UsageError('fault must be an object');
  }
  if (typeof f.id !== 'string' || f.id.length === 0) {
    throw new UsageError('fault requires a non-empty string id');
  }
  if (model.faults.some((x) => x.id === f.id)) throw new UsageError(`duplicate fault ${f.id}`);
  if (!model.stations.has(f.station)) {
    throw new UsageError(`fault ${f.id}: unknown station ${f.station}`);
  }
  if (!Number.isInteger(f.start) || !Number.isInteger(f.end) || f.end <= f.start) {
    throw new UsageError(`fault ${f.id}: invalid interval`);
  }
}

function unmetReasons(model, assignments) {
  const out = [];
  for (const c of model.contracts) {
    const wins = assignments.get(c.station) || [];
    if (wins.length >= c.min) continue;
    const st = model.stations.get(c.station);
    const avail = st.windows.filter((w) => !isFaultBlocked(model, c.station, w));
    let reason;
    if (avail.length === 0) reason = 'no-available-windows';
    else if (soloCapacity(st, avail, c, true) >= c.min) reason = 'downlink-contention';
    else if (soloCapacity(st, avail, c, false) >= c.min) reason = 'insufficient-battery';
    else if (soloCapacity(st, avail, null, false) >= c.min) reason = 'period-quota-cap';
    else if (soloCapacity(st, st.windows, null, false) >= c.min) reason = 'windows-unavailable-fault';
    else reason = 'insufficient-windows';
    out.push({
      contract: c.id,
      station: c.station,
      required: c.min,
      scheduled: wins.length,
      deficit: c.min - wins.length,
      reason,
    });
  }
  return out;
}

function buildPlan(model, assignments, revocations) {
  const schedule = {};
  const stationHashes = {};
  const calLeaves = [];
  for (const stId of [...model.stations.keys()].sort()) {
    const wins = assignments.get(stId) || [];
    schedule[stId] = wins.map((w) => ({
      window: w.id,
      start: w.start,
      end: w.end,
      energy: w.energy,
      locked: w.locked,
    }));
    const leaves = wins.map((w) => leafHash(['cal', stId, w.id, w.start, w.end]));
    stationHashes[stId] = merkleRoot(leaves);
    calLeaves.push(...leaves);
  }
  calLeaves.sort();
  const revLeaves = revocations.map((r) => leafHash(['rev', r.token])).sort();
  const cert = certificate(calLeaves.concat(revLeaves));
  return {
    planId: cert.root,
    scenario: model.name,
    schedule,
    stationHashes,
    unmet: unmetReasons(model, assignments),
    revocations: revocations.map((r) => ({ ...r })),
    certificate: cert,
  };
}

// Fold scenario + ordered events into the current plan. Fully deterministic:
// replaying the same event log after a crash reproduces identical state.
function fold(rawScenario, events) {
  const model = normalizeScenario(rawScenario);
  let assignments = new Map([...model.stations.keys()].map((id) => [id, []]));
  const revocations = [];
  const steps = [];

  const initial = computePlan(model, [...model.stations.keys()], assignments);
  assignments = initial.assignments;
  steps.push({ event: 'plan', affected: [...model.stations.keys()].sort(), replanned: initial.replanned });

  for (const ev of events) {
    if (ev.type === 'correct') {
      const changed = applyCorrection(model, ev.correction);
      const affected = [...affectedClosure(model, changed)].sort();
      const res = computePlan(model, affected, assignments);
      assignments = res.assignments;
      steps.push({ event: 'correct', affected, replanned: res.replanned });
    } else if (ev.type === 'fail') {
      validateFault(model, ev.fault);
      const f = ev.fault;
      const fault = { id: f.id, station: f.station, start: f.start, end: f.end, resolved: false };
      model.faults.push(fault);
      const preempted = [];
      const keptLocked = [];
      const newRevocations = [];
      for (const w of assignments.get(fault.station) || []) {
        if (!overlaps(w, fault)) continue;
        if (w.locked) {
          keptLocked.push(w.id);
          continue;
        }
        const token = sha256(canon(['revoke', fault.id, w.station, w.id, w.start, w.end]));
        const rev = {
          token,
          faultId: fault.id,
          station: w.station,
          window: w.id,
          start: w.start,
          end: w.end,
        };
        revocations.push(rev);
        newRevocations.push(rev);
        preempted.push(w.id);
      }
      const res = computePlan(model, [fault.station], assignments);
      assignments = res.assignments;
      steps.push({
        event: 'fail',
        fault: fault.id,
        preempted: preempted.sort(),
        keptLocked: keptLocked.sort(),
        revocations: newRevocations,
        replanned: res.replanned,
      });
    } else if (ev.type === 'restore') {
      const fault = model.faults.find((x) => x.id === ev.faultId);
      if (!fault) throw new DomainError(`unknown fault ${ev.faultId}`);
      if (fault.resolved) throw new UsageError(`fault ${ev.faultId} already resolved`);
      const before = (assignments.get(fault.station) || [])
        .filter((w) => !overlaps(w, fault))
        .map((w) => w.id)
        .sort();
      fault.resolved = true;
      const res = computePlan(model, [fault.station], assignments, { pinOutside: fault });
      assignments = res.assignments;
      const after = (assignments.get(fault.station) || [])
        .filter((w) => !overlaps(w, fault))
        .map((w) => w.id)
        .sort();
      const proof = {
        faultId: fault.id,
        interval: { start: fault.start, end: fault.end },
        outsideUnchanged: canon(before) === canon(after),
        outsideBefore: before,
        outsideAfter: after,
        outsideHashBefore: sha256(canon(before)),
        outsideHashAfter: sha256(canon(after)),
      };
      if (!proof.outsideUnchanged) {
        throw new Error('internal error: restore altered schedule outside fault interval');
      }
      steps.push({ event: 'restore', fault: fault.id, proof, replanned: res.replanned });
    } else {
      throw new UsageError(`unknown event type ${ev.type}`);
    }
  }
  return { model, assignments, revocations, steps, plan: buildPlan(model, assignments, revocations) };
}

module.exports = { fold, computePlan, affectedClosure, unmetReasons, buildPlan };
