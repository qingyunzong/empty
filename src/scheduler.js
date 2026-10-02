// Core scheduling engine. Pure and deterministic: same state in, same schedule out.
//
// Model (all times are integer seconds):
// - One ground antenna serves at most one pass at a time.
// - Switching to a new downlink costs `config.setup` seconds (waived for the very
//   first segment: the antenna is pre-pointed while idle).
// - A segment is "locked" for the first `config.lock` seconds; preemption is only
//   allowed on unlocked segments, and bytes already transmitted are preserved.
// - Fairness: among eligible passes the task with the largest deficit
//   (minGuarantee - servedSoFar) wins; ties break by task id, then pass start
//   second, then pass id.

export function effectiveWindow(pass, { confirmedOnly = false } = {}) {
  let s = pass.start;
  let e = pass.end;
  for (const c of pass.corrections ?? []) {
    if (confirmedOnly && c.pending) continue;
    s = Math.max(s, c.start);
    e = Math.min(e, c.end);
  }
  return [s, Math.max(s, e)];
}

function comparePassStart(a, b) {
  if (a.win[0] !== b.win[0]) return a.win[0] - b.win[0];
  if (a.task !== b.task) return a.task < b.task ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function computeSchedule(state) {
  const setup = state.config.setup;
  const lock = state.config.lock;
  const tasks = state.tasks ?? {};
  const passes = (state.passes ?? [])
    .map((p) => ({ ...p, win: effectiveWindow(p) }))
    .filter((p) => p.win[1] > p.win[0])
    .sort(comparePassStart);

  const served = {};
  const passBytes = {};
  const segments = [];
  const done = new Set();

  const servedOf = (t) => served[t] ?? 0;
  const deficitOf = (t) => (tasks[t]?.minGuarantee ?? 0) - servedOf(t);
  const quotaRem = (t) =>
    Math.max(0, (tasks[t]?.quota ?? Number.POSITIVE_INFINITY) - servedOf(t));

  // Strict preference: larger deficit, then task id, then start second, then id.
  const prefer = (a, b, defA, defB) => {
    if (defA !== defB) return defA > defB ? a : b;
    if (a.task !== b.task) return a.task < b.task ? a : b;
    if (a.win[0] !== b.win[0]) return a.win[0] < b.win[0] ? a : b;
    return a.id <= b.id ? a : b;
  };

  let now = 0;
  let freeAt = 0;
  let current = null;

  const readyAt = (p) =>
    segments.length === 0 ? p.win[0] : Math.max(p.win[0], freeAt + setup);

  const record = (p, s, e) => {
    if (e <= s) return;
    const bytes = p.rate * (e - s);
    segments.push({ pass: p.id, task: p.task, start: s, end: e, bytes });
    served[p.task] = (served[p.task] ?? 0) + bytes;
    passBytes[p.id] = (passBytes[p.id] ?? 0) + bytes;
  };

  while (true) {
    if (!current) {
      for (const p of passes) {
        if (done.has(p.id)) continue;
        if (
          p.win[1] <= now ||
          quotaRem(p.task) <= 0 ||
          p.onboard <= 0 ||
          (p.win[0] <= now && readyAt(p) >= p.win[1])
        ) {
          done.add(p.id);
        }
      }
      let best = null;
      for (const p of passes) {
        if (done.has(p.id) || p.win[0] > now) continue;
        best = best === null ? p : prefer(p, best, deficitOf(p.task), deficitOf(best.task));
      }
      if (!best) {
        let next = Infinity;
        for (const p of passes) {
          if (!done.has(p.id) && p.win[0] > now) next = Math.min(next, p.win[0]);
        }
        if (next === Infinity) break;
        now = next;
        continue;
      }
      const start = Math.max(now, readyAt(best));
      const quotaSec = Math.floor(quotaRem(best.task) / best.rate);
      const onboardSec = Math.floor((best.onboard - (passBytes[best.id] ?? 0)) / best.rate);
      const dur = Math.min(best.win[1] - start, quotaSec, onboardSec);
      if (dur <= 0) {
        done.add(best.id);
        continue;
      }
      current = { pass: best, start, end: start + dur };
    }

    // Preemption: evaluated at pass-start events while downlinking.
    let preemptAt = -1;
    for (const p of passes) {
      if (done.has(p.id) || p.id === current.pass.id) continue;
      const t = p.win[0];
      if (t <= current.start || t >= current.end) continue;
      if (t - current.start < lock) continue; // segment still locked
      if (quotaRem(p.task) <= 0 || p.onboard <= 0) continue;
      const curBytesAtT = current.pass.rate * (t - current.start);
      const defCur =
        (tasks[current.pass.task]?.minGuarantee ?? 0) -
        ((served[current.pass.task] ?? 0) + curBytesAtT);
      const defNew = deficitOf(p.task);
      if (prefer(p, current.pass, defNew, defCur) === p) {
        preemptAt = t;
        break;
      }
    }
    if (preemptAt >= 0) {
      record(current.pass, current.start, preemptAt); // transmitted bytes are kept
      now = preemptAt;
      freeAt = preemptAt;
      current = null;
      continue;
    }

    record(current.pass, current.start, current.end);
    now = current.end;
    freeAt = current.end;
    const p = current.pass;
    if (
      current.end >= p.win[1] ||
      quotaRem(p.task) <= 0 ||
      (passBytes[p.id] ?? 0) >= p.onboard
    ) {
      done.add(p.id);
    }
    current = null;
  }

  return { segments, served, passBytes };
}

// Drop attribution. Weather/pending come from window seconds removed by
// corrections; the remainder is quota first, then conflict. Pending weather is
// reported separately and never counted as failure.
export function computeDrops(state, sched) {
  const tasks = state.tasks ?? {};
  const drops = [];
  for (const p of state.passes ?? []) {
    const origDur = Math.max(0, p.end - p.start);
    const origCap = Math.min(p.onboard, p.rate * origDur);
    const [cs, ce] = effectiveWindow(p, { confirmedOnly: true });
    const confDur = Math.max(0, ce - cs);
    const [fs, fe] = effectiveWindow(p);
    const finalDur = Math.max(0, fe - fs);
    const weather = Math.min(origCap, p.rate * (origDur - confDur));
    const pending = Math.min(origCap - weather, p.rate * (confDur - finalDur));
    const servedBytes = sched.passBytes[p.id] ?? 0;
    const rest = Math.max(0, origCap - weather - pending - servedBytes);
    const quota = tasks[p.task]?.quota ?? Number.POSITIVE_INFINITY;
    const capAfterWeather = origCap - weather - pending;
    const quotaDrop = Math.max(0, Math.min(rest, capAfterWeather - quota));
    const conflict = rest - quotaDrop;
    drops.push({
      pass: p.id,
      task: p.task,
      served: servedBytes,
      capacity: origCap,
      dropped: { weather, conflict, quota: quotaDrop },
      pending,
    });
  }
  const totals = { served: 0, weather: 0, conflict: 0, quota: 0, pending: 0, failed: 0 };
  for (const d of drops) {
    totals.served += d.served;
    totals.weather += d.dropped.weather;
    totals.conflict += d.dropped.conflict;
    totals.quota += d.dropped.quota;
    totals.pending += d.pending;
  }
  totals.failed = totals.weather + totals.conflict + totals.quota;
  return { drops, totals };
}

// Structural validator used by tests and by `schedule --check`.
export function validateSchedule(state, sched) {
  const problems = [];
  const setup = state.config.setup;
  const byId = new Map((state.passes ?? []).map((p) => [p.id, p]));
  let prev = null;
  for (const seg of sched.segments) {
    const p = byId.get(seg.pass);
    if (!p) {
      problems.push(`segment references unknown pass ${seg.pass}`);
      continue;
    }
    const [ws, we] = effectiveWindow(p);
    if (seg.start < ws || seg.end > we) problems.push(`segment outside window: ${seg.pass}`);
    if (seg.end <= seg.start) problems.push(`empty segment: ${seg.pass}`);
    if (seg.bytes !== p.rate * (seg.end - seg.start)) problems.push(`byte mismatch: ${seg.pass}`);
    if (prev && seg.start < prev.end) problems.push(`overlap at second ${seg.start}`);
    if (prev && seg.start - prev.end < setup) problems.push(`setup violation before ${seg.pass}`);
    prev = seg;
  }
  for (const [pid, bytes] of Object.entries(sched.passBytes)) {
    const p = byId.get(pid);
    if (!p) continue;
    const [ws, we] = effectiveWindow(p);
    if (bytes > Math.min(p.onboard, p.rate * (we - ws))) problems.push(`onboard cap exceeded: ${pid}`);
  }
  for (const [task, bytes] of Object.entries(sched.served)) {
    const q = state.tasks?.[task]?.quota ?? Number.POSITIVE_INFINITY;
    if (bytes > q) problems.push(`quota exceeded: ${task}`);
  }
  return problems;
}
