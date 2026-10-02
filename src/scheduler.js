export function cooldownBetween(a, b, config) {
  return Math.abs(a - b) * config.cooldownPerDegree;
}

export function taskRunCost(startTemp, task, config) {
  let temp = startTemp;
  let cost = 0;
  for (const seg of task.segments) {
    cost += cooldownBetween(temp, seg.temp, config) + seg.duration;
    temp = seg.temp;
  }
  return { cost, endTemp: temp };
}

export function effectivePriority(task, now, config) {
  return task.priority + Math.floor((now - task.arrivedAt) / config.agingInterval);
}

// Fairness: round-robin across projects, then highest effective priority
// (wait aging) inside the chosen project; ties break by task id.
export function selectNext(candidates, projects, now, config) {
  if (!candidates.length) return null;
  let proj = null;
  for (const t of candidates) {
    const p = projects.get(t.project);
    if (
      !proj ||
      p.lastServedSeq < proj.lastServedSeq ||
      (p.lastServedSeq === proj.lastServedSeq && p.name < proj.name)
    ) {
      proj = p;
    }
  }
  let best = null;
  let bestEff = -Infinity;
  for (const t of candidates) {
    if (t.project !== proj.name) continue;
    const e = effectivePriority(t, now, config);
    if (!best || e > bestEff || (e === bestEff && t.id < best.id)) {
      best = t;
      bestEff = e;
    }
  }
  return best;
}

export function selectByPriority(candidates, now, config) {
  let best = null;
  let bestEff = -Infinity;
  for (const t of candidates) {
    const e = effectivePriority(t, now, config);
    if (!best || e > bestEff || (e === bestEff && t.id < best.id)) {
      best = t;
      bestEff = e;
    }
  }
  return best;
}

// Exact minimum-makespan plan for a small batch (n <= exactThreshold).
// tasks must be pre-sorted deterministically (by id). Returns
// { makespan, orders } where orders[c] is the task id sequence for channel c.
export function planExact(tasks, channelTemps, config) {
  const n = tasks.length;
  const C = channelTemps.length;
  const size = 1 << n;
  const subsetCost = [];
  const subsetFrom = [];
  for (let c = 0; c < C; c++) {
    // starts[0] is the channel temperature; starts[i+1] is the temperature
    // after task i finishes. costFrom[mask][s] = min cost to run `mask`
    // when the channel is at starts[s].
    const starts = [channelTemps[c], ...tasks.map((t) => t.segments[t.segments.length - 1].temp)];
    const costFrom = Array.from({ length: size }, () => new Array(n + 1).fill(0));
    for (let mask = 1; mask < size; mask++) {
      for (let s = 0; s <= n; s++) {
        let bestVal = Infinity;
        for (let x = 0; x < n; x++) {
          if (!(mask & (1 << x))) continue;
          const r = taskRunCost(starts[s], tasks[x], config);
          const v = r.cost + costFrom[mask ^ (1 << x)][x + 1];
          if (v < bestVal) bestVal = v;
        }
        costFrom[mask][s] = bestVal;
      }
    }
    subsetCost.push(costFrom.map((row) => row[0]));
    subsetFrom.push({ costFrom, starts });
  }

  let best = null;
  const assign = new Array(n).fill(0);
  const masks = new Array(C).fill(0);
  function rec(i, currentMax) {
    if (best && currentMax >= best.makespan) return;
    if (i === n) {
      best = { makespan: currentMax, masks: masks.slice() };
      return;
    }
    for (let c = 0; c < C; c++) {
      masks[c] |= 1 << i;
      assign[i] = c;
      rec(i + 1, Math.max(currentMax, subsetCost[c][masks[c]]));
      masks[c] &= ~(1 << i);
    }
  }
  rec(0, 0);

  const orders = [];
  for (let c = 0; c < C; c++) {
    let mask = best.masks[c];
    const { costFrom, starts } = subsetFrom[c];
    const idx = [];
    let s = 0;
    while (mask) {
      for (let x = 0; x < n; x++) {
        if (!(mask & (1 << x))) continue;
        const r = taskRunCost(starts[s], tasks[x], config);
        if (r.cost + costFrom[mask ^ (1 << x)][x + 1] === costFrom[mask][s]) {
          idx.push(x);
          s = x + 1;
          mask ^= 1 << x;
          break;
        }
      }
    }
    orders.push(idx.map((i) => tasks[i].id));
  }
  return { makespan: best.makespan, orders };
}

function withIdle(events, end) {
  const out = [];
  let cursor = 0;
  for (const ev of events) {
    if (ev.start > cursor) out.push({ type: 'idle', start: cursor, end: ev.start });
    out.push(ev);
    cursor = Math.max(cursor, ev.end);
  }
  if (cursor < end) out.push({ type: 'idle', start: cursor, end });
  return out;
}

function queueOrder(engine, now) {
  const projects = new Map();
  for (const [name, p] of engine.projects) {
    projects.set(name, { name, lastServedSeq: p.lastServedSeq });
  }
  let ctr = engine.rrCounter;
  const remaining = [...engine.tasks.values()].filter((t) => t.status === 'queued');
  const order = [];
  while (remaining.length) {
    const t = selectNext(remaining, projects, now, engine.config);
    order.push(t.id);
    projects.get(t.project).lastServedSeq = ctr++;
    remaining.splice(remaining.indexOf(t), 1);
  }
  return order;
}

export function runSimulation(engine, ops) {
  const config = engine.config;
  const pending = [];
  for (let i = 0; i < ops.length; i++) {
    if (engine.appliedOps.has(i)) continue;
    const at = Number.isFinite(ops[i]?.at) ? ops[i].at : 0;
    pending.push({ op: ops[i], i, at });
  }
  pending.sort((a, b) => a.at - b.at || a.i - b.i);

  const channels = [];
  for (let c = 0; c < config.channels; c++) {
    channels.push({
      id: c,
      temp: config.ambientTemp,
      busyUntil: 0,
      task: null,
      phase: null,
      segTemp: null,
      events: [],
    });
  }
  let now = 0;

  const queuedTasks = () => [...engine.tasks.values()].filter((t) => t.status === 'queued');

  const rt = {
    abortRunning(task, t) {
      const ch = channels[task.channel];
      if (!ch || ch.task !== task) return;
      const ev = ch.events[ch.events.length - 1];
      if (ev && ev.end > t) ev.end = t;
      if (ch.phase === 'cooldown' && ev && ev.type === 'cooldown') ch.temp = ev.from;
      ch.task = null;
      ch.phase = null;
      ch.busyUntil = t;
    },
  };

  function startSegment(ch, task) {
    const seg = task.segments[task.segmentIndex];
    ch.phase = 'segment';
    ch.temp = seg.temp;
    ch.busyUntil = now + seg.duration;
    ch.events.push({
      type: 'run',
      taskId: task.id,
      segment: task.segmentIndex,
      temp: seg.temp,
      start: now,
      end: now + seg.duration,
    });
    if (task.startedAt === null) {
      task.startedAt = now;
      engine.log.append('dispatch', { taskId: task.id, channel: ch.id, time: now });
    }
    engine.log.append('segment_start', {
      taskId: task.id,
      segment: task.segmentIndex,
      channel: ch.id,
      time: now,
    });
  }

  function startNextSegment(ch, task) {
    const seg = task.segments[task.segmentIndex];
    const cd = cooldownBetween(ch.temp, seg.temp, config);
    if (cd > 0) {
      ch.phase = 'cooldown';
      ch.segTemp = seg.temp;
      ch.busyUntil = now + cd;
      ch.events.push({ type: 'cooldown', taskId: task.id, from: ch.temp, to: seg.temp, start: now, end: now + cd });
    } else {
      startSegment(ch, task);
    }
  }

  function processChannel(ch) {
    if (ch.phase === 'cooldown') {
      ch.temp = ch.segTemp;
      ch.phase = null;
      startSegment(ch, ch.task);
      return;
    }
    const task = ch.task;
    engine.log.append('segment_end', {
      taskId: task.id,
      segment: task.segmentIndex,
      channel: ch.id,
      time: now,
    });
    task.segmentIndex += 1;
    if (task.segmentIndex >= task.segments.length) {
      task.status = 'completed';
      task.completedAt = now;
      ch.task = null;
      ch.phase = null;
      ch.busyUntil = now;
      engine.log.append('complete', { taskId: task.id, time: now });
      return;
    }
    // Temperature-segment boundary: the only point where preemption is legal.
    const candidate = selectByPriority(queuedTasks(), now, config);
    if (candidate && effectivePriority(candidate, now, config) > task.priority) {
      task.status = 'queued';
      engine.log.append('preempt', {
        taskId: task.id,
        by: candidate.id,
        channel: ch.id,
        time: now,
        resumeSegment: task.segmentIndex,
      });
      ch.task = null;
      ch.phase = null;
      ch.busyUntil = now;
      return;
    }
    startNextSegment(ch, task);
  }

  function tryDispatch(ch) {
    const task = selectNext(queuedTasks(), engine.projects, now, config);
    if (!task) return false;
    task.status = 'running';
    task.channel = ch.id;
    const project = engine.projects.get(task.project);
    project.lastServedSeq = engine.rrCounter++;
    ch.task = task;
    startNextSegment(ch, task);
    return true;
  }

  function runExactBatch(queue) {
    const sorted = queue.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const plan = planExact(sorted, channels.map((ch) => ch.temp), config);
    engine.log.append('plan', { makespan: plan.makespan, orders: plan.orders });
    const start = now;
    let end = now;
    plan.orders.forEach((order, ci) => {
      const ch = channels[ci];
      let t = start;
      for (const taskId of order) {
        const task = engine.tasks.get(taskId);
        task.status = 'running';
        task.channel = ci;
        task.startedAt = start;
        engine.log.append('dispatch', { taskId, channel: ci, time: start });
        for (const seg of task.segments) {
          const cd = cooldownBetween(ch.temp, seg.temp, config);
          if (cd > 0) {
            ch.events.push({ type: 'cooldown', taskId, from: ch.temp, to: seg.temp, start: t, end: t + cd });
            t += cd;
            ch.temp = seg.temp;
          }
          ch.events.push({
            type: 'run',
            taskId,
            segment: task.segmentIndex,
            temp: seg.temp,
            start: t,
            end: t + seg.duration,
          });
          engine.log.append('segment_start', { taskId, segment: task.segmentIndex, channel: ci, time: t });
          t += seg.duration;
          task.segmentIndex += 1;
        }
        task.status = 'completed';
        task.completedAt = t;
        engine.log.append('complete', { taskId, time: t });
        ch.busyUntil = t;
        if (t > end) end = t;
      }
    });
    now = end;
  }

  for (;;) {
    while (pending.length && pending[0].at <= now) {
      const p = pending.shift();
      engine.applyOp(p.op, p.i, now, rt);
    }
    for (const ch of channels) {
      if (ch.task && ch.busyUntil <= now) processChannel(ch);
    }
    const queue = queuedTasks();
    const anyBusy = channels.some((ch) => ch.task !== null);
    if (
      !anyBusy &&
      pending.length === 0 &&
      queue.length > 0 &&
      queue.length <= config.exactThreshold &&
      queue.every((t) => t.segmentIndex === 0) &&
      new Set(queue.map((t) => t.project)).size === 1 &&
      new Set(queue.map((t) => t.priority)).size === 1
    ) {
      runExactBatch(queue);
      continue;
    }
    for (const ch of channels) {
      if (!ch.task) tryDispatch(ch);
    }
    const busy = channels.filter((ch) => ch.task);
    if (busy.length === 0) {
      if (pending.length) {
        now = pending[0].at;
        continue;
      }
      break;
    }
    let next = Math.min(...busy.map((ch) => ch.busyUntil));
    if (pending.length && pending[0].at < next) next = pending[0].at;
    now = next;
  }

  const makespan = Math.max(0, ...channels.map((ch) => ch.busyUntil));
  const tasks = {};
  for (const t of engine.tasks.values()) {
    tasks[t.id] = {
      project: t.project,
      status: t.status,
      volume: t.volume,
      priority: t.priority,
      segmentsCompleted: t.status === 'completed' ? t.segments.length : t.segmentIndex,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
    };
  }
  return {
    makespan,
    channels: channels.map((ch) => ({ channel: ch.id, events: withIdle(ch.events, makespan) })),
    tasks,
    queue: queueOrder(engine, now),
    failures: engine.failures,
    logRoot: engine.log.root,
  };
}
