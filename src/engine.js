import { parseEvent, iso } from './parse.js';
import { solve } from './solver.js';

export const DEFAULT_LATE_THRESHOLD_MS = 5 * 60 * 1000; // watermark = maxEventTs - 5min

export class Engine {
  constructor({ lateThresholdMs = DEFAULT_LATE_THRESHOLD_MS, maxTies, maxNodes } = {}) {
    this.lateThresholdMs = lateThresholdMs;
    this.solverOptions = { maxTies, maxNodes };
    this.carriers = new Map(); // id -> {id, lot, qty, ts, due}
    this.tools = new Map(); // id -> {id, cap, windowStart, windowEnd}
    this.metros = new Map(); // lot -> score
    this.pendingMetros = new Map(); // lot -> score (no carrier seen yet)
    this.maxTs = null;
    this.seq = 0;
    this.rework = [];
    this.lateLines = [];
    this.assignment = new Map(); // carrierId -> toolId | null
    this.objective = 0;
    this.lastSolve = null;
  }

  record(obj) {
    this.rework.push({ seq: ++this.seq, ...obj });
  }

  watermark() {
    return this.maxTs === null ? null : this.maxTs - this.lateThresholdMs;
  }

  ingest(raw, where = 'event') {
    const ev = parseEvent(raw, where);
    let late = false;
    if (this.maxTs !== null && ev.eventTs < this.maxTs - this.lateThresholdMs) {
      late = true;
      const wm = this.maxTs - this.lateThresholdMs;
      this.lateLines.push(
        `LATE type=${ev.type} id=${ev.id} eventTs=${iso(ev.eventTs)} watermark=${iso(wm)}`
      );
      this.record({
        type: 'late_event',
        eventType: ev.type,
        id: ev.id,
        eventTs: ev.eventTs,
        watermark: wm,
      });
    }
    this.maxTs = this.maxTs === null ? ev.eventTs : Math.max(this.maxTs, ev.eventTs);
    this.apply(ev, late);
    return ev;
  }

  apply(ev, late) {
    const tag = late ? 'late_' : '';
    if (ev.type === 'carrier') {
      if (ev.op === 'del') {
        this.carriers.delete(ev.id);
      } else {
        this.carriers.set(ev.id, { id: ev.id, lot: ev.lot, qty: ev.qty, ts: ev.eventTs, due: ev.due });
        if (this.pendingMetros.has(ev.lot)) {
          const score = this.pendingMetros.get(ev.lot);
          this.pendingMetros.delete(ev.lot);
          this.metros.set(ev.lot, score);
          this.record({ type: 'metro_pending_resolved', lot: ev.lot, score });
        }
      }
      this.replan(`${tag}carrier_${ev.op === 'del' ? 'del' : 'add'}`);
      return;
    }
    if (ev.type === 'tool') {
      if (ev.op === 'del') {
        this.retractTool(ev.id, tag);
      } else {
        this.tools.set(ev.id, {
          id: ev.id,
          cap: ev.cap,
          windowStart: ev.windowStart,
          windowEnd: ev.windowEnd,
        });
        this.replan(`${tag}tool_add`);
      }
      return;
    }
    if (ev.type === 'metro') {
      if (ev.op === 'del') {
        this.retractMetro(ev.lot, tag);
      } else {
        const known = [...this.carriers.values()].some((c) => c.lot === ev.lot);
        if (known) {
          this.metros.set(ev.lot, ev.score);
        } else {
          this.pendingMetros.set(ev.lot, ev.score);
          this.record({ type: 'metro_pending', lot: ev.lot, score: ev.score });
        }
        this.replan(`${tag}metro_add`);
      }
      return;
    }
    // retract
    if (ev.target === 'carrier') {
      this.carriers.delete(ev.id);
      this.replan(`${tag}retract_carrier`);
    } else if (ev.target === 'tool') {
      this.retractTool(ev.id, tag);
    } else {
      this.retractMetro(ev.id, tag);
    }
  }

  retractTool(toolId, tag) {
    const displaced = [...this.assignment.entries()]
      .filter(([, t]) => t === toolId)
      .map(([c]) => c);
    this.tools.delete(toolId);
    this.record({ type: 'tool_retract', tool: toolId, displaced });
    this.replan(`${tag}retract_tool`);
  }

  retractMetro(lot, tag) {
    const hadScore = this.metros.get(lot);
    this.metros.delete(lot);
    this.pendingMetros.delete(lot);
    if (hadScore === undefined) {
      this.replan(`${tag}retract_metro`);
      return;
    }
    const lockedBefore = this.assignedQtyOfLot(lot);
    this.replan(`${tag}retract_metro`);
    const lockedAfter = this.assignedQtyOfLot(lot);
    const released = lockedBefore - lockedAfter;
    if (released > 0) {
      this.record({ type: 'budget_release', lot, releasedQty: released });
    }
  }

  assignedQtyOfLot(lot) {
    let total = 0;
    for (const [cid, tool] of this.assignment.entries()) {
      if (tool === null) continue;
      const c = this.carriers.get(cid);
      if (c && c.lot === lot) total += c.qty;
    }
    return total;
  }

  // Re-solve from scratch: the plan always reflects the provable optimum of the
  // current state, so any over-allocation introduced by a retraction rolls back
  // to the last provable optimum by construction.
  replan(trigger) {
    const carriers = [...this.carriers.values()];
    const tools = [...this.tools.values()];
    const res = solve(carriers, tools, this.metros, this.solverOptions);
    const migrations = [];
    const ids = new Set([...this.assignment.keys(), ...res.canonicalMap.keys()]);
    for (const id of ids) {
      const from = this.assignment.has(id) ? this.assignment.get(id) : null;
      const to = res.canonicalMap.has(id) ? res.canonicalMap.get(id) : null;
      const existed = this.assignment.has(id) || res.canonicalMap.has(id);
      if (existed && from !== to) migrations.push({ carrier: id, from, to });
    }
    if (migrations.length > 0 || res.objective !== this.objective) {
      this.record({
        type: 'replan',
        trigger,
        before: this.objective,
        after: res.objective,
        migrations,
      });
      for (const m of migrations) this.record({ type: 'migration', trigger, ...m });
    }
    this.assignment = res.canonicalMap;
    this.objective = res.objective;
    this.lastSolve = res;
  }

  finalize() {
    if (this.lastSolve === null) this.replan('finalize');
    const res = this.lastSolve;
    const wm = this.watermark();

    const windows = [...this.tools.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((t) => {
        let used = 0;
        for (const a of res.canonical) if (a.tool === t.id) used += a.qty;
        const remaining = t.cap - used;
        if (remaining < 0) {
          throw new Error(`invariant violated: negative remaining on tool ${t.id}`);
        }
        return {
          tool: t.id,
          windowStart: iso(t.windowStart),
          windowEnd: iso(t.windowEnd),
          windowStartMs: t.windowStart,
          windowEndMs: t.windowEnd,
          cap: t.cap,
          used,
          remaining,
        };
      });

    const plan = {
      watermark: wm === null ? null : iso(wm),
      watermarkMs: wm,
      objective: res.objective,
      assignments: res.canonical.map((a) => ({ ...a, due: iso(a.due) })),
      unassigned: [...res.canonicalMap.entries()].filter(([, t]) => t === null).map(([c]) => c),
      tieCount: res.tieCount,
      tiesTruncated: res.tiesTruncated,
      solutions: res.solutions.map((s) => ({
        objective: s.objective,
        assignments: s.assignments.map((a) => ({ carrier: a.carrier, tool: a.tool })),
      })),
    };

    const budget = {
      windows,
      totalCap: windows.reduce((s, w) => s + w.cap, 0),
      totalUsed: windows.reduce((s, w) => s + w.used, 0),
      totalRemaining: windows.reduce((s, w) => s + w.remaining, 0),
    };

    const rework = this.rework.map((r) => JSON.stringify(r)).join('\n');
    const late = this.lateLines.join('\n');
    return {
      plan: JSON.stringify(plan, null, 2) + '\n',
      budget: JSON.stringify(budget, null, 2) + '\n',
      rework: rework.length ? rework + '\n' : '',
      late: late.length ? late + '\n' : '',
      planObj: plan,
      budgetObj: budget,
    };
  }
}
