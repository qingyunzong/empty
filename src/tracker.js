import { classifyPoint } from "./geometry.js";

export const PUBLISH_DELAY_SECONDS = 5;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidPolygon(polygon) {
  return (
    Array.isArray(polygon) &&
    polygon.every(
      (vertex) =>
        Array.isArray(vertex) &&
        vertex.length === 2 &&
        isFiniteNumber(vertex[0]) &&
        isFiniteNumber(vertex[1]),
    )
  );
}

// Tracks flight plans and ground observations, emitting match actions.
//
// Observations may arrive out of order and are matched immediately against
// the currently known plans (MATCH) or buffered. Buffered observations are
// published as UNMATCHED once the public watermark exceeds their timestamp
// by `publishDelay` seconds. Plan corrections (higher version) and
// retractions recompute every affected buffered observation and cascade
// WITHDRAW actions; modifications touching already published observations
// are rejected with LATE.
export class Tracker {
  constructor({ publishDelay = PUBLISH_DELAY_SECONDS } = {}) {
    this.publishDelay = publishDelay;
    this.plans = new Map();
    this.observations = new Map();
    this.watermark = Number.NEGATIVE_INFINITY;
    this.actions = [];
  }

  emit(action) {
    this.actions.push(action);
    return action;
  }

  error(code, detail) {
    return this.emit({ action: "ERROR", error: code, ...detail });
  }

  processEvent(event) {
    const before = this.actions.length;
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.error("MALFORMED", { reason: "event must be an object with a type" });
    } else {
      switch (event.type) {
        case "FLIGHT_PLAN":
          this.handlePlan(event);
          break;
        case "GROUND_OBSERVATION":
          this.handleObservation(event);
          break;
        case "RETRACT":
          this.handleRetract(event);
          break;
        case "WATERMARK":
          this.handleWatermark(event);
          break;
        default:
          this.error("MALFORMED", { reason: `unknown event type: ${event.type}` });
      }
    }
    return this.actions.slice(before);
  }

  processAll(events) {
    const emitted = [];
    for (const event of events) emitted.push(...this.processEvent(event));
    return emitted;
  }

  handlePlan(event) {
    const { flightId, start, end, polygon, version } = event;
    if (
      typeof flightId !== "string" ||
      !isFiniteNumber(start) ||
      !isFiniteNumber(end) ||
      !isFiniteNumber(version)
    ) {
      return this.error("MALFORMED", {
        reason: "FLIGHT_PLAN requires string flightId and numeric start/end/version",
        flightId: flightId ?? null,
      });
    }
    if (!isValidPolygon(polygon)) {
      return this.error("MALFORMED", {
        reason: "polygon vertices must be [x, y] pairs of finite numbers",
        flightId,
      });
    }
    if (polygon.length < 3) {
      return this.error("INVALID_POLYGON", {
        reason: "polygon must have at least 3 vertices",
        flightId,
      });
    }
    if (end <= start) {
      return this.error("MALFORMED", {
        reason: "FLIGHT_PLAN requires end > start",
        flightId,
      });
    }

    const existing = this.plans.get(flightId);
    if (existing && version <= existing.version) {
      return this.error("STALE_VERSION", {
        flightId,
        version,
        currentVersion: existing.version,
      });
    }

    const windowStart = existing ? Math.min(existing.start, start) : start;
    const windowEnd = existing ? Math.max(existing.end, end) : end;
    if (this.hasPublishedInWindow(windowStart, windowEnd)) {
      return this.error("LATE", {
        flightId,
        reason: "plan modification arrived after affected observations were published",
      });
    }

    const plan = { flightId, start, end, polygon, version };
    this.plans.set(flightId, plan);

    const reason = existing ? "PLAN_CORRECTED" : "PLAN_ADDED";
    for (const obs of this.observationsInWindow(windowStart, windowEnd)) {
      this.recompute(obs, reason);
    }
  }

  handleObservation(event) {
    const { obsId, ts, x, y } = event;
    if (
      typeof obsId !== "string" ||
      !isFiniteNumber(ts) ||
      !isFiniteNumber(x) ||
      !isFiniteNumber(y)
    ) {
      return this.error("MALFORMED", {
        reason: "GROUND_OBSERVATION requires string obsId and numeric ts/x/y",
        obsId: obsId ?? null,
      });
    }
    if (this.observations.has(obsId)) {
      return this.error("MALFORMED", { reason: "duplicate obsId", obsId });
    }

    const obs = { obsId, ts, x, y, matched: null, published: false };
    this.observations.set(obsId, obs);
    const match = this.bestMatch(obs);
    if (match) {
      obs.matched = match.flightId;
      this.emit(this.matchAction(obs, match));
    }
    if (this.isPublishable(obs)) this.publish(obs);
  }

  handleRetract(event) {
    const { flightId } = event;
    if (typeof flightId !== "string") {
      return this.error("MALFORMED", { reason: "RETRACT requires a string flightId" });
    }
    const plan = this.plans.get(flightId);
    if (!plan) {
      return this.error("UNKNOWN_RETRACT", { flightId });
    }
    if (this.hasPublishedInWindow(plan.start, plan.end)) {
      return this.error("LATE", {
        flightId,
        reason: "retraction arrived after affected observations were published",
      });
    }
    this.plans.delete(flightId);
    for (const obs of this.observations.values()) {
      if (!obs.published && obs.matched === flightId) {
        this.recompute(obs, "PLAN_RETRACTED");
      }
    }
  }

  handleWatermark(event) {
    const { ts } = event;
    if (!isFiniteNumber(ts)) {
      return this.error("MALFORMED", { reason: "WATERMARK requires a numeric ts" });
    }
    if (ts <= this.watermark) return;
    this.watermark = ts;
    for (const obs of this.observations.values()) {
      if (!obs.published && this.isPublishable(obs)) this.publish(obs);
    }
  }

  isPublishable(obs) {
    return this.watermark >= obs.ts + this.publishDelay;
  }

  publish(obs) {
    obs.published = true;
    if (!obs.matched) {
      this.emit({ action: "UNMATCHED", obsId: obs.obsId });
    }
  }

  hasPublishedInWindow(start, end) {
    for (const obs of this.observations.values()) {
      if (obs.published && obs.ts >= start && obs.ts < end) return true;
    }
    return false;
  }

  *observationsInWindow(start, end) {
    for (const obs of this.observations.values()) {
      if (!obs.published && obs.ts >= start && obs.ts < end) yield obs;
    }
  }

  // Reference matching: brute-force scan of every plan, point-in-polygon
  // test per plan, ties broken by lexicographically smallest flightId.
  bestMatch(obs) {
    let best = null;
    for (const plan of this.plans.values()) {
      if (obs.ts < plan.start || obs.ts >= plan.end) continue;
      const classification = classifyPoint(plan.polygon, obs.x, obs.y);
      if (classification === "OUTSIDE") continue;
      if (!best || plan.flightId < best.flightId) {
        best = { flightId: plan.flightId, plan, classification };
      }
    }
    return best;
  }

  matchAction(obs, match) {
    return {
      action: "MATCH",
      obsId: obs.obsId,
      flightId: match.flightId,
      certificate: {
        obsId: obs.obsId,
        flightId: match.flightId,
        version: match.plan.version,
        point: [obs.x, obs.y],
        classification: match.classification,
        rule: "even-odd",
        window: [match.plan.start, match.plan.end],
        polygon: match.plan.polygon,
      },
    };
  }

  recompute(obs, reason) {
    const previous = obs.matched;
    const match = this.bestMatch(obs);
    const next = match ? match.flightId : null;
    if (previous === next) return;
    if (previous) {
      this.emit({ action: "WITHDRAW", obsId: obs.obsId, flightId: previous, reason });
    }
    obs.matched = next;
    if (match) {
      this.emit(this.matchAction(obs, match));
    }
  }
}
