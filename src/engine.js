'use strict';

// Tool-life engine.
//
// Input events (JSONL, one object per line), processed as a stream in arrival
// order for watermark/late detection, then fully recomputed in event time:
//   {"type":"load",   "eventTs":N,"tool":"T","part":"P","force":F,"seconds":S,"op":"id"}
//   {"type":"change", "eventTs":N,"tool":"T","newLife":L,"op":"id"}
//   {"type":"qc",     "eventTs":N,"part":"P","ok":true|false,"op":"id"}
//   {"type":"retract","eventTs":N,"kind":"load|change|qc","id":"op-id"}
//
// Semantics:
//  * watermark = max(eventTs seen so far) - watermarkDelayMs; an event whose
//    eventTs is below the watermark at arrival time is "late" (late.log).
//  * wear of a load = seconds * (force / ratedForce)^2, accumulated per tool
//    within the life segment opened by the latest preceding `change`.
//  * a segment is EXHAUST at the first moment cumulative wear exceeds newLife
//    (strictly greater; wear exactly == newLife, i.e. remaining == 0, is OK).
//  * retracting a load removes its wear, which can un-exhaust later segments.
//  * per part, the winning qc is the non-retracted one with the greatest
//    eventTs; ties are broken by the lexicographically greatest op id.
//  * risk chain per tool (parts ordered by first load eventTs):
//      qc ok       -> GOOD,  chain suspicion reset
//      qc !ok      -> BAD,   subsequent unverified parts become RISK
//      no qc       -> RISK if machined while tool exhausted or under
//                     suspicion, else UNKNOWN
//    a part's final risk is the worst evaluation across its tools.

const DEFAULT_RATED_FORCE = 100;
const DEFAULT_WATERMARK_DELAY_MS = 4000;
// Tolerance for float noise around the exhaustion boundary. A segment is
// exhausted only when wear exceeds newLife by more than this relative epsilon.
const EPS = 1e-9;

const RISK_ORDER = { GOOD: 0, UNKNOWN: 1, RISK: 2, BAD: 3 };

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns { event } or { error }.
function normalizeEvent(raw, line) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: { code: 'EVENT_INVALID', line, reason: 'not an object' } };
  }
  const bad = (reason) => ({ error: { code: 'EVENT_INVALID', line, reason } });
  const e = raw;
  if (!isFiniteNumber(e.eventTs)) return bad('eventTs must be a finite number');
  switch (e.type) {
    case 'load':
      if (!isNonEmptyString(e.tool)) return bad('load.tool must be a non-empty string');
      if (!isNonEmptyString(e.part)) return bad('load.part must be a non-empty string');
      if (!isFiniteNumber(e.force) || e.force < 0) return bad('load.force must be a number >= 0');
      if (!isFiniteNumber(e.seconds) || e.seconds < 0) return bad('load.seconds must be a number >= 0');
      if (!isNonEmptyString(e.op)) return bad('load.op must be a non-empty string');
      break;
    case 'change':
      if (!isNonEmptyString(e.tool)) return bad('change.tool must be a non-empty string');
      if (!isFiniteNumber(e.newLife)) return bad('change.newLife must be a number');
      if (!isNonEmptyString(e.op)) return bad('change.op must be a non-empty string');
      break;
    case 'qc':
      if (!isNonEmptyString(e.part)) return bad('qc.part must be a non-empty string');
      if (typeof e.ok !== 'boolean') return bad('qc.ok must be a boolean');
      if (!isNonEmptyString(e.op)) return bad('qc.op must be a non-empty string');
      break;
    case 'retract':
      if (!['load', 'change', 'qc'].includes(e.kind)) return bad('retract.kind must be load|change|qc');
      if (!isNonEmptyString(e.id)) return bad('retract.id must be a non-empty string');
      break;
    default:
      return bad(`unknown type: ${String(e.type)}`);
  }
  return { event: e };
}

function parseJsonl(text) {
  const events = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      errors.push({ code: 'PARSE_ERROR', line: i + 1, reason: err.message });
      continue;
    }
    const { event, error } = normalizeEvent(raw, i + 1);
    if (error) {
      errors.push(error);
    } else {
      events.push(event);
    }
  }
  return { events, errors };
}

// events: parsed, validated events in arrival order.
// options: { ratedForce, watermarkDelayMs }
function runEngine(events, options = {}) {
  const ratedForce = options.ratedForce ?? DEFAULT_RATED_FORCE;
  const watermarkDelayMs = options.watermarkDelayMs ?? DEFAULT_WATERMARK_DELAY_MS;
  const errors = [];
  const late = [];

  events.forEach((ev, i) => { ev._seq = i; ev._retracted = false; });

  // --- watermark & late detection, in arrival order ---
  let maxTs = -Infinity;
  for (const ev of events) {
    const watermark = maxTs - watermarkDelayMs;
    if (maxTs !== -Infinity && ev.eventTs < watermark) {
      late.push({
        kind: ev.type,
        id: ev.type === 'retract' ? ev.id : ev.op,
        eventTs: ev.eventTs,
        watermark,
      });
    }
    if (ev.eventTs > maxTs) maxTs = ev.eventTs;
  }
  const watermark = maxTs === -Infinity ? null : maxTs - watermarkDelayMs;
  const maxEventTs = maxTs === -Infinity ? null : maxTs;

  // --- retractions ---
  for (const ev of events) {
    if (ev.type !== 'retract') continue;
    const target = events.find(
      (cand) => cand.type === ev.kind && cand.op === ev.id && !cand._retracted
    );
    if (!target) {
      errors.push({ code: 'RETRACT_MISS', kind: ev.kind, id: ev.id });
    } else {
      target._retracted = true;
    }
  }

  // --- life validation ---
  for (const ev of events) {
    if (ev._retracted || ev.type !== 'change') continue;
    if (!(ev.newLife > 0)) {
      errors.push({ code: 'LIFE_INVALID', tool: ev.tool, op: ev.op, newLife: ev.newLife });
      ev._retracted = true; // exclude invalid change from computation
    }
  }

  const active = events
    .filter((ev) => !ev._retracted && ev.type !== 'retract')
    .sort((a, b) => a.eventTs - b.eventTs || a._seq - b._seq);

  // --- tool segments & wear ---
  const tools = new Map();
  const getTool = (name) => {
    let t = tools.get(name);
    if (!t) {
      t = { tool: name, segments: [], untrackedLoads: 0, _parts: new Map() };
      tools.set(name, t);
    }
    return t;
  };
  const loadRecords = [];
  const exhausts = [];

  for (const ev of active) {
    if (ev.type === 'change') {
      const t = getTool(ev.tool);
      t.segments.push({
        op: ev.op,
        startTs: ev.eventTs,
        newLife: ev.newLife,
        wear: 0,
        remaining: ev.newLife,
        exhausted: false,
        exhaustAt: null,
        loads: 0,
      });
      continue;
    }
    if (ev.type !== 'load') continue;
    const t = getTool(ev.tool);
    const wear = ev.seconds * Math.pow(ev.force / ratedForce, 2);
    const rec = {
      op: ev.op,
      tool: ev.tool,
      part: ev.part,
      eventTs: ev.eventTs,
      seq: ev._seq,
      wear,
      cumWear: null,
      remaining: null,
      exhausted: false,
      untracked: false,
    };
    const seg = t.segments[t.segments.length - 1];
    rec.segIndex = seg ? t.segments.length - 1 : -1;
    if (!seg) {
      rec.untracked = true;
      t.untrackedLoads += 1;
    } else {
      seg.wear += wear;
      seg.loads += 1;
      rec.cumWear = seg.wear;
      rec.remaining = seg.newLife - seg.wear;
      seg.remaining = rec.remaining;
      if (seg.wear - seg.newLife > EPS * Math.max(1, seg.newLife)) {
        rec.exhausted = true;
        if (!seg.exhausted) {
          seg.exhausted = true;
          seg.exhaustAt = ev.eventTs;
          exhausts.push({
            tool: ev.tool,
            op: ev.op,
            eventTs: ev.eventTs,
            wear: round6(seg.wear),
            newLife: seg.newLife,
          });
        }
      }
    }
    loadRecords.push(rec);
    let p = t._parts.get(ev.part);
    if (!p) {
      p = { part: ev.part, firstTs: ev.eventTs, firstSeq: ev._seq, exhausted: false, segIndex: rec.segIndex };
      t._parts.set(ev.part, p);
    }
    if (rec.exhausted) p.exhausted = true;
  }

  // --- qc resolution: latest eventTs wins, ties by greatest op id ---
  const qcByPart = new Map();
  for (const ev of active) {
    if (ev.type !== 'qc') continue;
    const cur = qcByPart.get(ev.part);
    if (!cur || ev.eventTs > cur.eventTs || (ev.eventTs === cur.eventTs && ev.op > cur.op)) {
      qcByPart.set(ev.part, ev);
    }
  }

  // --- risk chain per tool ---
  const partEvals = new Map(); // part -> ['GOOD'|'BAD'|'RISK'|'UNKNOWN']
  const pushEval = (part, risk) => {
    let arr = partEvals.get(part);
    if (!arr) {
      arr = [];
      partEvals.set(part, arr);
    }
    arr.push(risk);
  };
  for (const t of tools.values()) {
    const partsOnTool = [...t._parts.values()].sort(
      (a, b) => a.firstTs - b.firstTs || a.firstSeq - b.firstSeq
    );
    let suspect = false;
    let lastSeg = -2;
    for (const p of partsOnTool) {
      if (p.segIndex !== lastSeg) {
        suspect = false; // a `change` installs fresh tool life and resets the chain
        lastSeg = p.segIndex;
      }
      const qc = qcByPart.get(p.part);
      let risk;
      if (qc && qc.ok) {
        risk = 'GOOD';
        suspect = false;
      } else if (qc && !qc.ok) {
        risk = 'BAD';
        suspect = true;
      } else if (p.exhausted) {
        risk = 'RISK';
        suspect = true;
      } else if (suspect) {
        risk = 'RISK';
      } else {
        risk = 'UNKNOWN';
      }
      pushEval(p.part, risk);
    }
  }
  // parts that only appear in qc events (never loaded)
  for (const [part, qc] of qcByPart) {
    if (!partEvals.has(part)) pushEval(part, qc.ok ? 'GOOD' : 'BAD');
  }

  // --- assemble part outputs ---
  const loadsByPart = new Map();
  for (const rec of loadRecords) {
    let arr = loadsByPart.get(rec.part);
    if (!arr) {
      arr = [];
      loadsByPart.set(rec.part, arr);
    }
    arr.push(rec);
  }
  const partNames = new Set([...partEvals.keys(), ...loadsByPart.keys()]);
  const parts = [];
  for (const part of [...partNames].sort()) {
    const qc = qcByPart.get(part) || null;
    const evals = partEvals.get(part) || [];
    const risk = evals.reduce(
      (worst, r) => (RISK_ORDER[r] > RISK_ORDER[worst] ? r : worst),
      'GOOD'
    );
    const loads = loadsByPart.get(part) || [];
    parts.push({
      part,
      tools: [...new Set(loads.map((r) => r.tool))].sort(),
      loads: loads.length,
      qc: qc ? (qc.ok ? 'GOOD' : 'BAD') : null,
      qcOp: qc ? qc.op : null,
      qcEventTs: qc ? qc.eventTs : null,
      exhausted: loads.some((r) => r.exhausted),
      risk,
    });
  }

  // --- assemble tool outputs ---
  const toolOut = [...tools.values()]
    .map((t) => {
      const last = t.segments[t.segments.length - 1] || null;
      return {
        tool: t.tool,
        segments: t.segments.map((s) => ({
          op: s.op,
          startTs: s.startTs,
          newLife: s.newLife,
          wear: round6(s.wear),
          remaining: round6(s.remaining),
          exhausted: s.exhausted,
          exhaustAt: s.exhaustAt,
          loads: s.loads,
        })),
        remaining: last ? round6(last.remaining) : null,
        exhausted: last ? last.exhausted : false,
        untrackedLoads: t.untrackedLoads,
      };
    })
    .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));

  const counts = { GOOD: 0, BAD: 0, UNKNOWN: 0, RISK: 0 };
  for (const p of parts) counts[p.risk] += 1;

  return {
    options: { ratedForce, watermarkDelayMs },
    watermark,
    maxEventTs,
    tools: toolOut,
    parts,
    loads: loadRecords.map((r) => ({ ...r, wear: round6(r.wear), cumWear: r.cumWear === null ? null : round6(r.cumWear), remaining: r.remaining === null ? null : round6(r.remaining) })),
    exhausts,
    late,
    errors,
    risk: {
      watermark,
      maxEventTs,
      watermarkDelayMs,
      ratedForce,
      counts,
      riskParts: parts.filter((p) => p.risk === 'RISK').map((p) => p.part),
      badParts: parts.filter((p) => p.risk === 'BAD').map((p) => p.part),
      exhausts,
      errors,
      lateCount: late.length,
    },
  };
}

module.exports = {
  DEFAULT_RATED_FORCE,
  DEFAULT_WATERMARK_DELAY_MS,
  parseJsonl,
  runEngine,
};
