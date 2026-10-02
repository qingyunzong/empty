import { OeeError, ERR, errJson } from './errors.js';
import { validateParams, validateEvents } from './validate.js';
import { analyze } from './analyze.js';

// Verdict of a disputed interval = planned/unplanned of the segment containing its midpoint.
function verdictAt(events, params, mid) {
  const r = analyze({ events, params });
  if (!r.ok || r.timeline.length === 0) return null;
  const seg = r.timeline.find((s) => s.start <= mid && mid < s.end);
  if (!seg) return null;
  return seg.planned ? 'planned' : 'unplanned';
}

function shrinkCandidates(ev, s, e) {
  const out = [];
  if (ev.start < s && ev.end > s) out.push({ ...ev, end: s });
  if (ev.end > e && ev.start < e) out.push({ ...ev, start: e });
  return out;
}

// dispute({ events, params?, interval: { start, end } }) ->
//   verdict, minimalSubset (1-minimal events reproducing the verdict),
//   flip (minimal deletion/shrink making an unplanned interval planned)
export function dispute(input) {
  try {
    if (input === null || typeof input !== 'object') {
      throw new OeeError(ERR.SCHEMA, 'input must be an object { events, params?, interval }');
    }
    const params = validateParams(input.params ?? {});
    const events = validateEvents(input.events ?? []);
    const iv = input.interval;
    if (iv === null || typeof iv !== 'object' || !Number.isFinite(iv.start) || !Number.isFinite(iv.end) || iv.end < iv.start) {
      throw new OeeError(ERR.SCHEMA, 'interval { start, end } with end >= start is required');
    }
    const mid = (iv.start + iv.end) / 2;
    const verdict = verdictAt(events, params, mid);
    if (verdict === null) {
      throw new OeeError(ERR.SCHEMA, 'interval midpoint is outside the observation window', { interval: iv });
    }

    // Greedy deletion to a 1-minimal subset that still reproduces the verdict.
    let subset = events.map((e) => ({ ...e }));
    let changed = true;
    while (changed) {
      changed = false;
      for (const ev of subset) {
        const trial = subset.filter((x) => x !== ev);
        if (verdictAt(trial, params, mid) === verdict) {
          subset = trial;
          changed = true;
          break;
        }
      }
    }
    const oneMinimal = subset.every(
      (ev) => verdictAt(subset.filter((x) => x !== ev), params, mid) !== verdict,
    );

    // Minimal counterexample flipping unplanned -> planned:
    // 1) single shrinks, 2) single deletions, 3) deletion pairs.
    let flip = null;
    if (verdict === 'unplanned') {
      for (const ev of events) {
        for (const shrunk of shrinkCandidates(ev, iv.start, iv.end)) {
          const trial = events.map((x) => (x === ev ? shrunk : x));
          if (verdictAt(trial, params, mid) === 'planned') {
            flip = { deletions: [], shrinks: [{ id: ev.id, start: shrunk.start, end: shrunk.end }] };
            break;
          }
        }
        if (flip) break;
      }
      if (!flip) {
        for (const ev of events) {
          if (verdictAt(events.filter((x) => x !== ev), params, mid) === 'planned') {
            flip = { deletions: [ev.id], shrinks: [] };
            break;
          }
        }
      }
      if (!flip) {
        outer: for (let i = 0; i < events.length; i++) {
          for (let j = i + 1; j < events.length; j++) {
            const trial = events.filter((_, k) => k !== i && k !== j);
            if (verdictAt(trial, params, mid) === 'planned') {
              flip = { deletions: [events[i].id, events[j].id], shrinks: [] };
              break outer;
            }
          }
        }
      }
    }

    return {
      ok: true,
      interval: { start: iv.start, end: iv.end },
      verdict,
      minimalSubset: subset,
      oneMinimal,
      flip,
    };
  } catch (e) {
    if (e instanceof OeeError) return errJson(e);
    throw e;
  }
}
