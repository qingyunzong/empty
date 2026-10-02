'use strict';

// Reference implementation used to cross-check the engine in tests.
// It deliberately uses a different structure: for every period it first
// enumerates the set of heartbeats falling into that period (plus its grace
// tail), then judges every expected moment against that set only.

function offsetLookup(shiftTable, t) {
  for (const seg of shiftTable) {
    if (t >= seg.start && t < seg.end) return seg.offsetMs;
  }
  const err = new Error(`offset table gap at t=${t}`);
  err.code = 'OFFSET_GAP';
  throw err;
}

function inAnyInterval(intervals, t) {
  return intervals.some((iv) => t >= iv.start && t < iv.end);
}

function referenceAlarms({ rules, shiftTable, downtime, heartbeats, cutoffMs, mergeGapMs }) {
  const times = [...heartbeats].sort((a, b) => a - b);
  const out = [];
  for (const rule of rules) {
    const periods = [];
    for (let k = 0; ; k++) {
      const nominal = rule.epochStartMs + k * rule.periodMs;
      if (nominal > cutoffMs) break;
      const start = nominal + offsetLookup(shiftTable, nominal);
      const end = start + rule.periodMs;
      const set = times.filter((t) => t >= start && t < end + rule.graceMs);
      let violated = false;
      let pending = false;
      let anyJudged = false;
      for (const off of rule.expectedOffsetsMs) {
        const e = start + off;
        if (e >= cutoffMs) continue;
        if (inAnyInterval(downtime, e)) continue;
        anyJudged = true;
        const covered = set.some((t) => t >= e && t <= e + rule.graceMs && !inAnyInterval(downtime, t));
        if (covered) continue;
        if (e + rule.graceMs > cutoffMs) pending = true;
        else violated = true;
      }
      let status;
      if (violated) status = 'silent';
      else if (pending) status = 'pending';
      else if (anyJudged) status = 'ok';
      else status = 'neutral';
      periods.push({ k, start, end, status });
    }
    const raw = [];
    let cur = null;
    for (const p of periods) {
      const bad = p.status === 'silent' || p.status === 'pending';
      if (bad) {
        if (!cur) cur = { fromPeriod: p.k, toPeriod: p.k, start: p.start, end: p.end };
        else { cur.toPeriod = p.k; cur.end = p.end; }
      } else if (cur) {
        raw.push(cur);
        cur = null;
      }
    }
    if (cur) raw.push(cur);
    const lastK = periods.length - 1;
    const merged = [];
    for (const a of raw) {
      const open = a.toPeriod === lastK;
      const prev = merged[merged.length - 1];
      if (prev && prev.end !== null && a.start - prev.end <= mergeGapMs) {
        prev.toPeriod = a.toPeriod;
        prev.end = open ? null : a.end;
        prev.status = open ? 'OPEN' : 'CLOSED';
      } else {
        merged.push({
          ruleId: rule.id,
          fromPeriod: a.fromPeriod,
          toPeriod: a.toPeriod,
          start: a.start,
          end: open ? null : a.end,
          status: open ? 'OPEN' : 'CLOSED',
        });
      }
    }
    out.push(...merged);
  }
  out.sort((x, y) => x.start - y.start || (x.ruleId < y.ruleId ? -1 : x.ruleId > y.ruleId ? 1 : 0));
  return out;
}

module.exports = { referenceAlarms };
