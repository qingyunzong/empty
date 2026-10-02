import { solveAll } from './solver.js';

export const DEFAULT_WATERMARK_LAG_MS = 5 * 60 * 1000;

const RETRACT_REASON = {
  carrier: 'CARRIER_RETRACT',
  tool: 'TOOL_WINDOW_RETRACT',
  metro: 'METRO_RETRACT',
};

function signatureOf(solutions) {
  return JSON.stringify(
    solutions.map((s) => s.assignments.map((a) => `${a.carrier}@${a.tool}`)),
  );
}

function assignmentMapOf(solution) {
  const map = new Map();
  for (const a of solution.assignments) map.set(a.carrier, a.tool);
  return map;
}

export class Engine {
  constructor({ watermarkLagMs = DEFAULT_WATERMARK_LAG_MS, maxSolutions } = {}) {
    this.watermarkLagMs = watermarkLagMs;
    this.maxSolutions = maxSolutions;
    this.maxEventTs = null;
    this.carriers = new Map();
    this.tools = new Map();
    this.metros = new Map();
    this.reworkLog = [];
    this.lateLog = [];
    this.stats = { processed: 0, late: 0, retracted: 0 };
    this.result = null;
    this.canonicalMap = null;
    this.seq = 0;
  }

  watermark() {
    return this.maxEventTs === null ? null : this.maxEventTs - this.watermarkLagMs;
  }

  applyAll(events) {
    for (const event of events) this.apply(event);
    return this;
  }

  apply(event) {
    const wm = this.watermark();
    const late = wm !== null && event.eventTs < wm;
    if (late) {
      this.stats.late += 1;
      this.lateLog.push({ eventTs: event.eventTs, watermark: wm, event });
    }
    if (this.maxEventTs === null || event.eventTs > this.maxEventTs) {
      this.maxEventTs = event.eventTs;
    }

    let reason;
    switch (event.type) {
      case 'carrier':
        this.carriers.set(event.carrier, { ...event });
        reason = 'CARRIER_UPSERT';
        break;
      case 'tool':
        this.tools.set(event.tool, { ...event });
        reason = 'TOOL_WINDOW_UPSERT';
        break;
      case 'metro':
        this.metros.set(event.lot, event.score);
        reason = late ? 'METRO_LATE_REWRITE' : 'METRO_UPDATE';
        break;
      case 'retract':
        this.stats.retracted += 1;
        reason = this.#applyRetract(event);
        break;
      default:
        reason = 'IGNORED';
    }
    this.stats.processed += 1;
    this.#replan(event, reason, late);
    return { late, reason };
  }

  #applyRetract(event) {
    const base = RETRACT_REASON[event.kind];
    let existed = false;
    if (event.kind === 'carrier') existed = this.carriers.delete(event.id);
    else if (event.kind === 'tool') existed = this.tools.delete(event.id);
    else if (event.kind === 'metro') existed = this.metros.delete(event.id);
    return existed ? base : `${base}_NOOP`;
  }

  #replan(trigger, reason, late) {
    const carriers = [...this.carriers.values()];
    const windows = [...this.tools.values()];
    const scoreOf = (lot) => this.metros.get(lot) ?? 0;
    const result = solveAll({ carriers, windows, scoreOf, maxSolutions: this.maxSolutions });
    const canonical = result.solutions[0] ?? { assignments: [], undispatched: [] };
    const nextMap = assignmentMapOf(canonical);

    if (this.canonicalMap !== null && signatureOf(result.solutions) !== this.prevSignature) {
      const migrated = [];
      const ids = new Set([...this.canonicalMap.keys(), ...nextMap.keys()]);
      for (const id of [...ids].sort()) {
        const from = this.canonicalMap.get(id) ?? null;
        const to = nextMap.get(id) ?? null;
        if (from !== to) migrated.push({ carrier: id, from, to });
      }
      this.seq += 1;
      this.reworkLog.push({
        seq: this.seq,
        reason,
        late,
        trigger,
        objectiveBefore: this.result.objective,
        objectiveAfter: result.objective,
        migrated,
      });
    }

    this.prevSignature = signatureOf(result.solutions);
    this.result = result;
    this.canonicalMap = nextMap;
  }

  pendingMetros() {
    const lots = new Set([...this.carriers.values()].map((c) => c.lot));
    return [...this.metros.keys()].filter((lot) => !lots.has(lot)).sort();
  }

  finalize() {
    if (this.result === null) this.#replan(null, 'INIT', false);
    const canonical = this.result.solutions[0] ?? { assignments: [], undispatched: [] };

    const plan = {
      watermark: this.watermark(),
      objective: this.result.objective,
      solutionCount: this.result.solutions.length,
      truncated: this.result.truncated,
      solutions: this.result.solutions,
      undispatched: canonical.undispatched,
      pendingMetros: this.pendingMetros(),
      stats: { ...this.stats },
    };

    const usedByTool = new Map();
    for (const a of canonical.assignments) {
      usedByTool.set(a.tool, (usedByTool.get(a.tool) ?? 0) + a.qty);
    }
    const carriersByTool = new Map();
    for (const a of canonical.assignments) {
      if (!carriersByTool.has(a.tool)) carriersByTool.set(a.tool, []);
      carriersByTool.get(a.tool).push(a.carrier);
    }
    const windows = [...this.tools.values()]
      .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : a.windowStart - b.windowStart))
      .map((w) => {
        const used = usedByTool.get(w.tool) ?? 0;
        return {
          tool: w.tool,
          op: w.op,
          windowStart: w.windowStart,
          windowEnd: w.windowEnd,
          cap: w.cap,
          used,
          remaining: w.cap - used,
          carriers: (carriersByTool.get(w.tool) ?? []).sort(),
        };
      });
    const budget = {
      feasible: windows.every((w) => w.remaining >= 0),
      negativeRemaining: windows.some((w) => w.remaining < 0),
      windows,
    };

    return { plan, budget, rework: this.reworkLog, late: this.lateLog };
  }
}

export function formatLateLine(entry) {
  const e = entry.event;
  const id = e.carrier ?? e.tool ?? e.lot ?? e.id ?? '-';
  return `LATE eventTs=${entry.eventTs} watermark=${entry.watermark} type=${e.type} id=${id}`;
}
