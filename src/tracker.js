'use strict';

const { pointInPolygon } = require('./polygon');

const DEFAULT_PUBLISH_DELAY = 5;

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isId(value) {
  return (typeof value === 'string' && value.length > 0) || isNum(value);
}

function sameResult(a, b) {
  if (a.matched !== b.matched) return false;
  if (!a.matched) return true;
  return a.flightId === b.flightId && a.version === b.version;
}

class TrackEngine {
  constructor(options = {}) {
    this.publishDelay = options.publishDelay ?? DEFAULT_PUBLISH_DELAY;
    this.plans = new Map();
    this.buffered = new Map();
    this.published = [];
    this.watermark = null;
  }

  process(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return [{ type: 'MALFORMED', reason: 'event must be a JSON object' }];
    }
    switch (event.type) {
      case 'FLIGHT_PLAN':
        return this.handlePlan(event);
      case 'GROUND_OBSERVATION':
        return this.handleObservation(event);
      case 'RETRACT':
        return this.handleRetract(event);
      case 'WATERMARK':
        return this.handleWatermark(event);
      default:
        return [{ type: 'MALFORMED', reason: `unknown event type: ${String(event.type)}` }];
    }
  }

  handlePlan(event) {
    const { flightId, start, end, polygon, version } = event;
    if (!isId(flightId) || !isNum(start) || !isNum(end) || !(start < end)) {
      return [{ type: 'MALFORMED', reason: 'flightId/start/end invalid', flightId: flightId ?? null }];
    }
    if (!Number.isInteger(version)) {
      return [{ type: 'MALFORMED', reason: 'version must be an integer', flightId }];
    }
    if (!Array.isArray(polygon)) {
      return [{ type: 'MALFORMED', reason: 'polygon must be an array of [x, y] vertices', flightId }];
    }
    for (const vertex of polygon) {
      if (!Array.isArray(vertex) || vertex.length !== 2 || !isNum(vertex[0]) || !isNum(vertex[1])) {
        return [{ type: 'MALFORMED', reason: 'polygon vertex coordinates must be numbers', flightId }];
      }
    }
    if (polygon.length < 3) {
      return [{ type: 'INVALID_POLYGON', flightId, reason: 'polygon has fewer than 3 vertices' }];
    }
    const existing = this.plans.get(flightId);
    if (existing && version <= existing.version) {
      return [{ type: 'STALE_VERSION', flightId, version, currentVersion: existing.version }];
    }
    if (this.touchesPublished(start, end) || (existing && this.touchesPublished(existing.start, existing.end))) {
      return [{ type: 'LATE', flightId, version, reason: 'plan window covers already published observations' }];
    }
    this.plans.set(flightId, { flightId, start, end, polygon, version });
    const actions = [{ type: 'PLAN_ACCEPTED', flightId, version }];
    this.recomputeBuffered(actions);
    return actions;
  }

  handleObservation(event) {
    const { obsId, ts, x, y } = event;
    if (!isId(obsId) || !isNum(ts) || !isNum(x) || !isNum(y)) {
      return [{ type: 'MALFORMED', reason: 'obsId/ts/x/y invalid', obsId: obsId ?? null }];
    }
    const obs = { obsId, ts, x, y };
    const result = this.evaluate(obs);
    this.buffered.set(obsId, { obs, result });
    return [this.matchAction(obsId, result)];
  }

  handleRetract(event) {
    const { flightId } = event;
    if (!isId(flightId)) {
      return [{ type: 'MALFORMED', reason: 'flightId invalid' }];
    }
    const plan = this.plans.get(flightId);
    if (!plan) {
      return [{ type: 'UNKNOWN_RETRACT', flightId, reason: 'no active plan for flightId' }];
    }
    if (this.touchesPublished(plan.start, plan.end)) {
      return [{ type: 'LATE', flightId, reason: 'retract covers already published observations' }];
    }
    this.plans.delete(flightId);
    const actions = [{ type: 'PLAN_RETRACTED', flightId }];
    this.recomputeBuffered(actions);
    return actions;
  }

  handleWatermark(event) {
    const { ts } = event;
    if (!isNum(ts)) {
      return [{ type: 'MALFORMED', reason: 'watermark ts must be a number' }];
    }
    if (this.watermark === null || ts > this.watermark) {
      this.watermark = ts;
    }
    return this.publishWhere((obs) => obs.ts + this.publishDelay <= ts);
  }

  finish() {
    return this.publishWhere(() => true);
  }

  evaluate(obs) {
    let best = null;
    for (const plan of this.plans.values()) {
      if (obs.ts < plan.start || obs.ts >= plan.end) continue;
      if (!pointInPolygon(obs.x, obs.y, plan.polygon)) continue;
      if (best === null || String(plan.flightId) < String(best.flightId)) best = plan;
    }
    return best
      ? { matched: true, flightId: best.flightId, version: best.version }
      : { matched: false };
  }

  recomputeBuffered(actions) {
    for (const [obsId, entry] of this.buffered) {
      const next = this.evaluate(entry.obs);
      if (sameResult(entry.result, next)) continue;
      if (entry.result.matched) {
        actions.push({
          type: 'WITHDRAW',
          obsId,
          flightId: entry.result.flightId,
          version: entry.result.version,
        });
      }
      actions.push(this.matchAction(obsId, next));
      entry.result = next;
    }
  }

  matchAction(obsId, result) {
    return result.matched
      ? { type: 'MATCH', obsId, flightId: result.flightId, version: result.version }
      : { type: 'UNMATCHED', obsId };
  }

  touchesPublished(start, end) {
    return this.published.some((entry) => entry.obs.ts >= start && entry.obs.ts < end);
  }

  publishWhere(predicate) {
    const due = [];
    for (const [obsId, entry] of this.buffered) {
      if (predicate(entry.obs)) due.push([obsId, entry]);
    }
    due.sort((a, b) => a[1].obs.ts - b[1].obs.ts || (String(a[0]) < String(b[0]) ? -1 : 1));
    const actions = [];
    for (const [obsId, entry] of due) {
      this.buffered.delete(obsId);
      this.published.push(entry);
      const certificate = {
        type: 'CERTIFICATE',
        obsId,
        ts: entry.obs.ts,
        matched: entry.result.matched,
        watermark: this.watermark,
      };
      if (entry.result.matched) {
        certificate.flightId = entry.result.flightId;
        certificate.version = entry.result.version;
      }
      actions.push(certificate);
    }
    return actions;
  }
}

module.exports = { TrackEngine, DEFAULT_PUBLISH_DELAY };
