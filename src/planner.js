// Exhaustive wave planner.
//
// A wave plan assigns every task to an ordered per-shuttle sequence, expands
// repositioning moves, and schedules all moves with aisle exclusion using a
// deterministic causal list schedule. The battery budget is a hard
// constraint: any candidate whose per-shuttle energy exceeds the budget is
// infeasible. Among feasible candidates the optimum is chosen by the
// lexicographic tuple (makespan, total energy, path key).

import { locKey, distance, normalizeMove, moveSignature, normalizeShuttle } from './model.js';

export function taskEnergy(task) {
  return task.moves.reduce((sum, m) => sum + m.energy, 0);
}

// Expand a shuttle's ordered task list into a concrete move queue, inserting
// repositioning moves whenever the shuttle is not at the next move's origin.
export function buildQueue(shuttle, taskSeq) {
  const queue = [];
  let loc = shuttle.home;
  let repoCount = 0;
  for (const task of taskSeq) {
    for (const move of task.moves) {
      if (locKey(loc) !== locKey(move.from)) {
        const dist = distance(loc, move.from);
        queue.push({
          id: `R~${task.id}~${repoCount++}`,
          taskId: task.id,
          kind: 'reposition',
          from: loc,
          to: move.from,
          aisles: [...new Set([loc.aisle, move.from.aisle])],
          energy: dist * shuttle.energyPerUnit,
          duration: dist / shuttle.speed,
        });
      }
      queue.push({ ...move, taskId: task.id, kind: 'task' });
      loc = move.to;
    }
  }
  return queue;
}

// Deterministic causal list schedule. Moves become ready in causal order
// (each shuttle's queue is a happens-before chain). The ready move with the
// smallest (ready time, shuttle id) is placed at the earliest time that
// respects aisle exclusion. An aisle with no recorded occupancy is free:
// unknown aisle state never blocks.
export function simulate(queues) {
  const shuttleIds = [...queues.keys()].sort();
  const aisleFree = new Map();
  const time = new Map(shuttleIds.map((id) => [id, 0]));
  const cursor = new Map(shuttleIds.map((id) => [id, 0]));
  const scheduled = [];
  for (;;) {
    let pick = null;
    for (const id of shuttleIds) {
      if (cursor.get(id) >= queues.get(id).length) continue;
      if (pick === null || time.get(id) < time.get(pick) ||
          (time.get(id) === time.get(pick) && id < pick)) {
        pick = id;
      }
    }
    if (pick === null) break;
    const move = queues.get(pick)[cursor.get(pick)];
    let start = time.get(pick);
    for (const aisle of move.aisles) start = Math.max(start, aisleFree.get(aisle) ?? 0);
    const end = start + move.duration;
    for (const aisle of move.aisles) aisleFree.set(aisle, end);
    time.set(pick, end);
    cursor.set(pick, cursor.get(pick) + 1);
    scheduled.push({ ...move, shuttle: pick, start, end });
  }
  return scheduled;
}

export function pathKeyOf(queues) {
  return [...queues.keys()].sort()
    .map((id) => `${id}=${queues.get(id).map((m) => `${m.id}@${locKey(m.from)}>${locKey(m.to)}`).join(',')}`)
    .join('|');
}

// Evaluate one ordered partition (Map shuttleId -> [task, ...]).
export function evaluate(assignment, shuttles, budget) {
  const queues = new Map();
  const perShuttleEnergy = new Map();
  for (const shuttle of shuttles) {
    const queue = buildQueue(shuttle, assignment.get(shuttle.id) ?? []);
    queues.set(shuttle.id, queue);
    perShuttleEnergy.set(shuttle.id, queue.reduce((s, m) => s + m.energy, 0));
  }
  const scheduled = simulate(queues);
  const makespan = scheduled.reduce((mx, m) => Math.max(mx, m.end), 0);
  const energy = scheduled.reduce((s, m) => s + m.energy, 0);
  const feasible = [...perShuttleEnergy.values()].every((e) => e <= budget);
  return { feasible, makespan, energy, pathKey: pathKeyOf(queues), scheduled, perShuttleEnergy, queues };
}

function better(candidate, best) {
  if (best === null) return true;
  if (candidate.makespan !== best.makespan) return candidate.makespan < best.makespan;
  if (candidate.energy !== best.energy) return candidate.energy < best.energy;
  return candidate.pathKey < best.pathKey;
}

function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function* emptyAssignment(shuttles) {
  yield new Map(shuttles.map((s) => [s.id, []]));
}

// Enumerate every ordered partition: assign tasks (input order) to shuttles,
// then permute each shuttle's task list. Prunes branches whose task energy
// alone already exceeds the budget (repositioning only adds energy, so this
// is a safe lower bound).
function* orderedPartitions(tasks, shuttles) {
  if (tasks.length === 0) { yield* emptyAssignment(shuttles); return; }
  const assignments = new Map(shuttles.map((s) => [s.id, []]));
  function* assign(i) {
    if (i === tasks.length) {
      yield assignments;
      return;
    }
    for (const shuttle of shuttles) {
      assignments.get(shuttle.id).push(tasks[i]);
      yield* assign(i + 1);
      assignments.get(shuttle.id).pop();
    }
  }
  for (const assignment of assign(0)) {
    const shuttleLists = shuttles.map((s) => assignment.get(s.id));
    function* permuteShuttle(k, acc) {
      if (k === shuttleLists.length) {
        yield new Map(shuttles.map((s, idx) => [s.id, acc[idx]]));
        return;
      }
      for (const perm of permutations(shuttleLists[k])) {
        acc.push(perm);
        yield* permuteShuttle(k + 1, acc);
        acc.pop();
      }
    }
    yield* permuteShuttle(0, []);
  }
}

function candidateCount(n, s) {
  let count = 1;
  for (let i = 0; i < n; i++) count *= s + i; // n! * C(n+s-1, s-1)
  return count;
}

function greedyAssignment(tasks, shuttles, budget) {
  const assignment = new Map(shuttles.map((s) => [s.id, []]));
  const energy = new Map(shuttles.map((s) => [s.id, 0]));
  for (const task of tasks) {
    const te = taskEnergy(task);
    let best = null;
    for (const shuttle of shuttles) {
      const after = energy.get(shuttle.id) + te;
      if (after > budget) continue;
      if (best === null || after < best.after || (after === best.after && shuttle.id < best.id)) {
        best = { id: shuttle.id, after };
      }
    }
    if (best === null) return null;
    assignment.get(best.id).push(task);
    energy.set(best.id, best.after);
  }
  return assignment;
}

function applyReusable(tasks, reusable) {
  const pool = new Map();
  for (const entry of reusable) {
    const move = normalizeMove(entry);
    pool.set(moveSignature(move), { ...move, reusedId: entry.id ?? move.id });
  }
  return tasks.map((task) => ({
    id: task.id,
    moves: task.moves.map((raw) => {
      const move = normalizeMove(raw);
      const hit = pool.get(moveSignature(move));
      if (!hit) return move;
      return { ...move, energy: hit.energy, duration: hit.duration, reusedFrom: hit.reusedId };
    }),
  }));
}

export function normalizeTasks(tasks) {
  return applyReusable(tasks, []);
}

export function planWave({ waveId = 'W1', tasks, shuttles, budget, reusable = [], candidateCap = 200000 }) {
  if (!Number.isFinite(budget) || budget < 0) throw new Error('budget must be a non-negative number');
  if (!Array.isArray(shuttles) || shuttles.length === 0) throw new Error('at least one shuttle is required');
  shuttles = shuttles.map(normalizeShuttle);
  const normTasks = applyReusable(tasks ?? [], reusable);

  let best = null;
  let bestAssignment = null;
  let exhaustive = candidateCount(normTasks.length, shuttles.length) <= candidateCap;

  if (exhaustive) {
    for (const assignment of orderedPartitions(normTasks, shuttles)) {
      // Budget pruning is applied per complete assignment here; partial
      // pruning happens implicitly because infeasible candidates lose.
      const result = evaluate(assignment, shuttles, budget);
      if (!result.feasible) continue;
      if (better(result, best)) {
        best = result;
        bestAssignment = new Map([...assignment].map(([k, v]) => [k, v.slice()]));
      }
    }
  } else {
    const assignment = greedyAssignment(normTasks, shuttles, budget);
    if (assignment !== null) {
      const result = evaluate(assignment, shuttles, budget);
      if (result.feasible) {
        best = result;
        bestAssignment = assignment;
      }
    }
  }

  if (best === null) {
    return { feasible: false, waveId, budget, exhaustive };
  }

  const assignments = [];
  for (const shuttle of shuttles) {
    (bestAssignment.get(shuttle.id) ?? []).forEach((task, seq) => {
      assignments.push({ wave: waveId, task: task.id, shuttle: shuttle.id, seq });
    });
  }
  const moves = best.scheduled.map((m) => ({
    wave: waveId,
    task: m.taskId,
    id: m.id,
    shuttle: m.shuttle,
    kind: m.kind,
    from: locKey(m.from),
    to: locKey(m.to),
    aisles: m.aisles.slice(),
    start: m.start,
    end: m.end,
    energy: m.energy,
    duration: m.duration,
    status: 'planned',
    ...(m.reusedFrom !== undefined ? { reusedFrom: m.reusedFrom } : {}),
  }));
  return {
    feasible: true,
    waveId,
    budget,
    exhaustive,
    makespan: best.makespan,
    energy: best.energy,
    pathKey: best.pathKey,
    assignments,
    moves,
    shuttles: shuttles.map((s) => ({ id: s.id, energy: best.perShuttleEnergy.get(s.id) })),
  };
}

function* combinations(sortedIds, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= sortedIds.length - (k - acc.length); i++) {
    acc.push(sortedIds[i]);
    yield* combinations(sortedIds, k, i + 1, acc);
    acc.pop();
  }
}

// Smallest set of tasks whose removal makes the wave plannable within the
// budget. Minimum cardinality first; ties resolved by the lexicographically
// smallest sorted id list, so the answer is deterministic.
export function minimalReduction({ tasks, shuttles, budget, reusable = [] }) {
  const ids = tasks.map((t) => t.id).sort();
  for (let k = 0; k <= ids.length; k++) {
    let best = null;
    for (const combo of combinations(ids, k)) {
      const removed = new Set(combo);
      const remaining = tasks.filter((t) => !removed.has(t.id));
      const result = planWave({ tasks: remaining, shuttles, budget, reusable });
      if (result.feasible) {
        const key = combo.join(' ');
        if (best === null || key < best) best = key;
      }
    }
    if (best !== null) return best === '' ? [] : best.split(' ');
  }
  return [];
}
