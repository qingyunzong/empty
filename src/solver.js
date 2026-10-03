'use strict';

const crypto = require('crypto');
const { stableStringify } = require('./model');

// ---------------------------------------------------------------------------
// Deterministic, total tie-break comparator.
// Objective order: (1) total downtime, (2) total cost,
// (3) lexicographically smallest task sequence, then fully canonical
// (mode tuple, crew-assignment tuple) so ties are broken objectively and never
// depend on Map/object iteration order.
// ---------------------------------------------------------------------------

function compareArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}

function compareCandidates(a, b) {
  if (a.downtime !== b.downtime) return a.downtime < b.downtime ? -1 : 1;
  if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
  let r = compareArrays(a.sequence, b.sequence);
  if (r !== 0) return r;
  r = compareArrays(a.modesTuple, b.modesTuple);
  if (r !== 0) return r;
  return compareArrays(a.assignTuple, b.assignTuple);
}

// events: [{id, start, crew}], modeIds: per task (sorted by task id), '' = deferred
function makeCandidate(downtime, cost, events, modeIds) {
  const byStartCrewId = [...events].sort((a, b) =>
    a.start - b.start || a.crew - b.crew || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byStartId = [...events].sort((a, b) =>
    a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    downtime,
    cost,
    sequence: byStartCrewId.map((e) => e.id),
    modesTuple: modeIds.slice(),
    assignTuple: byStartId.map((e) => e.crew),
  };
}

function solve(problem) {
  const tasks = problem.tasks; // sorted by id
  const n = tasks.length;
  const crewsCount = problem.crews;
  const budget = problem.budget;
  const indexOf = new Map(tasks.map((t, i) => [t.id, i]));
  const preds = tasks.map((t) => t.deps.map((d) => indexOf.get(d)));
  const topo = problem.topoOrder.map((id) => indexOf.get(id));
  const partNames = Object.keys(problem.parts);
  const partLimit = partNames.map((name) => problem.parts[name]);
  const modePartUsage = tasks.map((t) =>
    t.modes.map((m) => partNames.map((p) => (m.parts[p] === undefined ? 0 : m.parts[p]))));

  const stats = { plansConsidered: 0, plansPruned: 0, schedulesEvaluated: 0, nodesPruned: 0 };
  let best = null;
  let bestDetail = null;

  const modeIdx = new Array(n).fill(-1); // -1 = deferred
  const partsUsed = new Array(partNames.length).fill(0);

  // scheduling scratch state
  const completion = new Array(n).fill(0);
  const startOf = new Array(n).fill(0);
  const crewOf = new Array(n).fill(-1);
  const crewFree = new Array(crewsCount).fill(0);
  const done = new Array(n).fill(false);

  function considerCandidate(cost, baseDowntime, partial) {
    const downtime = baseDowntime + partial;
    if (best && (downtime > best.downtime || (downtime === best.downtime && cost > best.cost))) {
      return;
    }
    const events = [];
    const modeIds = new Array(n);
    for (let i = 0; i < n; i += 1) {
      if (modeIdx[i] >= 0) {
        events.push({ id: tasks[i].id, start: startOf[i], crew: crewOf[i] });
        modeIds[i] = tasks[i].modes[modeIdx[i]].id;
      } else {
        modeIds[i] = '';
      }
    }
    const cand = makeCandidate(downtime, cost, events, modeIds);
    if (!best || compareCandidates(cand, best) < 0) {
      best = cand;
      bestDetail = {
        modeIdx: modeIdx.slice(),
        startOf: startOf.slice(),
        crewOf: crewOf.slice(),
        completion: completion.slice(),
      };
    }
  }

  function schedDFS(scheduledList, durations, weights, doneCount, partial, cost, baseDowntime) {
    if (best) {
      // Lower bound: each remaining task finishes no earlier than it would
      // alone on the freest crew with its already-done predecessors.
      let minFree = Infinity;
      for (let c = 0; c < crewsCount; c += 1) if (crewFree[c] < minFree) minFree = crewFree[c];
      let lb = partial;
      for (const j of scheduledList) {
        if (done[j]) continue;
        let pd = 0;
        for (const p of preds[j]) {
          if (modeIdx[p] >= 0 && done[p] && completion[p] > pd) pd = completion[p];
        }
        lb += weights[j] * (Math.max(minFree, pd) + durations[j]);
      }
      const total = baseDowntime + lb;
      if (total > best.downtime || (total === best.downtime && cost > best.cost)) {
        stats.nodesPruned += 1;
        return;
      }
    }
    if (doneCount === scheduledList.length) {
      stats.schedulesEvaluated += 1;
      considerCandidate(cost, baseDowntime, partial);
      return;
    }
    for (const j of scheduledList) {
      if (done[j]) continue;
      let ready = true;
      let predDone = 0;
      for (const p of preds[j]) {
        if (modeIdx[p] >= 0) {
          if (!done[p]) { ready = false; break; }
          if (completion[p] > predDone) predDone = completion[p];
        }
      }
      if (!ready) continue;
      for (let c = 0; c < crewsCount; c += 1) {
        const start = Math.max(crewFree[c], predDone);
        const end = start + durations[j];
        const savedFree = crewFree[c];
        crewFree[c] = end;
        done[j] = true;
        completion[j] = end;
        startOf[j] = start;
        crewOf[j] = c;
        schedDFS(scheduledList, durations, weights, doneCount + 1,
          partial + weights[j] * end, cost, baseDowntime);
        crewFree[c] = savedFree;
        done[j] = false;
        crewOf[j] = -1;
      }
    }
  }

  function evaluatePlan(cost, baseDowntime) {
    stats.plansConsidered += 1;
    if (best && (baseDowntime > best.downtime ||
        (baseDowntime === best.downtime && cost > best.cost))) {
      stats.plansPruned += 1;
      return;
    }
    const scheduledList = [];
    const durations = new Array(n).fill(0);
    const weights = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      if (modeIdx[i] >= 0) {
        scheduledList.push(i);
        durations[i] = tasks[i].modes[modeIdx[i]].duration;
        weights[i] = tasks[i].downtime;
      }
    }
    crewFree.fill(0);
    done.fill(false);
    schedDFS(scheduledList, durations, weights, 0, 0, cost, baseDowntime);
  }

  function planDFS(pos, costSoFar, baseDowntime) {
    if (costSoFar > budget) {
      stats.plansPruned += 1;
      return;
    }
    if (pos === n) {
      evaluatePlan(costSoFar, baseDowntime);
      return;
    }
    const i = topo[pos];
    const t = tasks[i];
    // Successor invalidation: a task with a deferred predecessor cannot run.
    const hasDeferredPred = preds[i].some((p) => modeIdx[p] === -1);
    if (hasDeferredPred) {
      modeIdx[i] = -1;
      planDFS(pos + 1, costSoFar, baseDowntime + t.downtime * t.deferPenalty);
      return;
    }
    for (let m = 0; m < t.modes.length; m += 1) {
      const usage = modePartUsage[i][m];
      let fits = true;
      for (let k = 0; k < partNames.length; k += 1) {
        if (partsUsed[k] + usage[k] > partLimit[k]) { fits = false; break; }
      }
      if (!fits) continue;
      for (let k = 0; k < partNames.length; k += 1) partsUsed[k] += usage[k];
      modeIdx[i] = m;
      planDFS(pos + 1, costSoFar + t.modes[m].cost, baseDowntime);
      for (let k = 0; k < partNames.length; k += 1) partsUsed[k] -= usage[k];
    }
    modeIdx[i] = -1;
    planDFS(pos + 1, costSoFar, baseDowntime + t.downtime * t.deferPenalty);
  }

  planDFS(0, 0, 0);
  modeIdx.fill(-1);

  if (!best) {
    // Unreachable: the all-deferred plan is always feasible.
    throw new Error('internal error: no feasible plan found');
  }

  // ---- materialize result -------------------------------------------------
  const tasksOut = {};
  const crewsOut = Array.from({ length: crewsCount }, () => []);
  const partUsageOut = new Array(partNames.length).fill(0);
  for (let i = 0; i < n; i += 1) {
    const t = tasks[i];
    const m = bestDetail.modeIdx[i];
    if (m >= 0) {
      const mode = t.modes[m];
      const start = bestDetail.startOf[i];
      const end = bestDetail.completion[i];
      const crew = bestDetail.crewOf[i];
      tasksOut[t.id] = { state: 'scheduled', mode: mode.id, crew, start, end };
      crewsOut[crew].push({ task: t.id, mode: mode.id, start, end });
      const usage = modePartUsage[i][m];
      for (let k = 0; k < partNames.length; k += 1) partUsageOut[k] += usage[k];
    } else {
      const reason = preds[i].some((p) => bestDetail.modeIdx[p] === -1)
        ? 'predecessor-deferred'
        : 'insufficient-budget';
      tasksOut[t.id] = {
        state: 'deferred',
        reason,
        downtime: t.downtime * t.deferPenalty,
      };
    }
  }
  for (const crew of crewsOut) {
    crew.sort((a, b) => a.start - b.start || (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));
  }

  const zeroSlackEdges = [];
  for (let i = 0; i < n; i += 1) {
    if (bestDetail.modeIdx[i] < 0) continue;
    for (const p of preds[i]) {
      if (bestDetail.modeIdx[p] >= 0 && bestDetail.completion[p] === bestDetail.startOf[i]) {
        zeroSlackEdges.push([tasks[p].id, tasks[i].id]);
      }
    }
  }
  zeroSlackEdges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const deferred = [];
  for (let i = 0; i < n; i += 1) {
    if (bestDetail.modeIdx[i] === -1) {
      deferred.push({ id: tasks[i].id, reason: tasksOut[tasks[i].id].reason });
    }
  }

  const problemHash = crypto.createHash('sha256').update(stableStringify(problem)).digest('hex');

  return {
    status: 'ok',
    objective: { downtime: best.downtime, cost: best.cost },
    budget: { limit: budget, used: best.cost, remaining: budget - best.cost },
    sequence: best.sequence,
    tasks: tasksOut,
    crews: crewsOut,
    criticalConstraints: {
      budget: { limit: budget, used: best.cost, binding: best.cost === budget },
      parts: partNames.map((name, k) => ({
        part: name,
        used: partUsageOut[k],
        limit: partLimit[k],
        binding: partUsageOut[k] === partLimit[k],
      })),
      precedence: zeroSlackEdges.map(([from, to]) => ({ from, to, slack: 0 })),
      deferred,
    },
    certificate: {
      method: 'exhaustive-enumeration',
      guarantee: 'Optimal over all mode selections, deferral choices and all non-delay schedules. '
        + 'For the regular objective sum(w_i*C_i) an optimal non-delay schedule always exists, '
        + 'and every non-delay schedule is generated by the (task, crew) decision DFS.',
      tieBreak: 'lexicographic on (downtime, cost, task sequence, mode tuple, crew assignment tuple); fully deterministic',
      plansConsidered: stats.plansConsidered,
      plansPruned: stats.plansPruned,
      schedulesEvaluated: stats.schedulesEvaluated,
      nodesPruned: stats.nodesPruned,
      crews: crewsCount,
      problemHash,
    },
  };
}

module.exports = { solve, compareCandidates, compareArrays, makeCandidate };
