'use strict';

const crypto = require('crypto');
const { TYPE_RANK, normalizeEvent, eventKey } = require('./events');

function chainError(code, exitCode, message) {
  const err = new Error(message);
  err.code = code;
  err.exitCode = exitCode;
  return err;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function validateJobEvents(job, sorted) {
  let prev = null;
  const legsSeen = new Set();
  const failedLegs = new Map();
  for (const e of sorted) {
    if (e.type === 'RETRY') {
      if (!prev || prev.type !== 'FAIL') {
        throw chainError('ERR_ILLEGAL_RETRY', 15,
          `job ${job} seq ${e.seq}: RETRY must immediately follow the most recent FAIL`);
      }
      if (legsSeen.has(e.leg)) {
        throw chainError('ERR_ILLEGAL_RETRY', 15,
          `job ${job} seq ${e.seq}: RETRY must open a new leg, leg ${e.leg} already exists`);
      }
    } else {
      const fail = failedLegs.get(e.leg);
      if (fail && e.seq > fail.seq) {
        throw chainError('ERR_LEG_MODIFICATION', 15,
          `job ${job} leg ${e.leg} seq ${e.seq}: event after FAIL modifies a closed leg`);
      }
    }
    legsSeen.add(e.leg);
    if (e.type === 'FAIL') failedLegs.set(e.leg, e);
    prev = e;
  }
}

function findCycleNodes(keys, edges) {
  const succ = new Map(keys.map((k) => [k, []]));
  const indeg = new Map(keys.map((k) => [k, 0]));
  for (const edge of edges) {
    const i = edge.indexOf('->');
    const a = edge.slice(0, i);
    const b = edge.slice(i + 2);
    succ.get(a).push(b);
    indeg.set(b, indeg.get(b) + 1);
  }
  const queue = keys.filter((k) => indeg.get(k) === 0);
  let seen = 0;
  while (queue.length) {
    const n = queue.pop();
    seen++;
    for (const m of succ.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  if (seen === keys.length) return null;
  return keys.filter((k) => indeg.get(k) > 0);
}

class ChainBuilder {
  constructor(options = {}) {
    this.timeout = options.timeout == null ? 30000 : options.timeout;
    this.events = [];
    this.seen = new Set();
    this.duplicates = 0;
  }

  ingest(raw) {
    const e = normalizeEvent(raw);
    const key = eventKey(e);
    if (this.seen.has(key)) {
      this.duplicates++;
      return false;
    }
    this.seen.add(key);
    this.events.push(e);
    return true;
  }

  ingestAll(list) {
    let added = 0;
    for (const raw of list) if (this.ingest(raw)) added++;
    return added;
  }

  build() {
    const byJob = new Map();
    for (const e of this.events) {
      if (!byJob.has(e.job)) byJob.set(e.job, []);
      byJob.get(e.job).push(e);
    }

    const legs = new Map();
    const jobs = [];
    for (const [job, list] of [...byJob.entries()].sort()) {
      list.sort((a, b) =>
        a.seq - b.seq || a.ts - b.ts || TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.leg - b.leg);
      validateJobEvents(job, list);
      const order = [];
      for (const e of list) {
        const key = e.job + '#' + e.leg;
        if (!legs.has(key)) {
          legs.set(key, { job: e.job, leg: e.leg, events: [] });
          order.push(key);
        }
        legs.get(key).events.push(e);
      }
      jobs.push({ job, order });
    }

    const edgeSet = new Set();
    let danglingCauses = 0;
    for (const { order } of jobs) {
      for (let i = 1; i < order.length; i++) edgeSet.add(order[i - 1] + '->' + order[i]);
    }
    for (const [key, leg] of legs) {
      for (const e of leg.events) {
        for (const c of e.causes) {
          const src = c.job + '#' + c.leg;
          if (!legs.has(src)) { danglingCauses++; continue; }
          edgeSet.add(src + '->' + key);
        }
      }
    }
    const edges = [...edgeSet].sort();

    const cycleNodes = findCycleNodes([...legs.keys()], edges);
    if (cycleNodes) {
      throw chainError('ERR_CAUSES_CYCLE', 14,
        'causes graph contains a cycle involving: ' + cycleNodes.join(', '));
    }

    const legInfo = new Map();
    for (const [key, leg] of legs) {
      legInfo.set(key, {
        fail: leg.events.find((e) => e.type === 'FAIL') || null,
        hasDrop: leg.events.some((e) => e.type === 'DROP'),
        hasRetry: leg.events.some((e) => e.type === 'RETRY'),
      });
    }

    const uncompensated = [];
    for (const { order } of jobs) {
      const success = legInfo.get(order[order.length - 1]).hasDrop;
      order.forEach((key, idx) => {
        const info = legInfo.get(key);
        if (!info.fail) return;
        const retried = order.slice(idx + 1).some((k) => legInfo.get(k).hasRetry);
        if (!(success && retried)) uncompensated.push({ key, fail: info.fail });
      });
    }

    const preds = new Map([...legs.keys()].map((k) => [k, []]));
    for (const edge of edges) {
      const i = edge.indexOf('->');
      preds.get(edge.slice(i + 2)).push(edge.slice(0, i));
    }
    const uncompKeys = new Set(uncompensated.map((u) => u.key));
    const rootCauses = uncompensated
      .filter((u) => {
        const visited = new Set();
        const stack = [...preds.get(u.key)];
        while (stack.length) {
          const n = stack.pop();
          if (visited.has(n)) continue;
          visited.add(n);
          if (uncompKeys.has(n)) return false;
          for (const p of preds.get(n)) stack.push(p);
        }
        return true;
      })
      .map((u) => ({ job: u.fail.job, leg: u.fail.leg, seq: u.fail.seq, ts: u.fail.ts }))
      .sort((a, b) => a.job.localeCompare(b.job) || a.leg - b.leg || a.seq - b.seq);

    const clock = this.events.reduce((m, e) => Math.max(m, e.ts), 0);
    const staleLog = [];
    for (const [, leg] of [...legs.entries()].sort()) {
      const picks = leg.events.filter((e) => e.type === 'PICK');
      const drops = leg.events.filter((e) => e.type === 'DROP');
      const used = new Array(drops.length).fill(false);
      for (const pick of picks) {
        const di = drops.findIndex((d, i) => !used[i] && d.ts >= pick.ts);
        if (di >= 0) {
          used[di] = true;
          const drop = drops[di];
          if (drop.ts > pick.ts + this.timeout) {
            staleLog.push({
              job: leg.job, leg: leg.leg, pickSeq: pick.seq,
              markedAt: pick.ts + this.timeout,
              revoked: true, revokedAt: drop.ts, dropSeq: drop.seq,
            });
          }
        } else if (clock >= pick.ts + this.timeout) {
          staleLog.push({
            job: leg.job, leg: leg.leg, pickSeq: pick.seq,
            markedAt: pick.ts + this.timeout,
            revoked: false, revokedAt: null, dropSeq: null,
          });
        }
      }
    }
    staleLog.sort((a, b) =>
      a.markedAt - b.markedAt || a.job.localeCompare(b.job) || a.leg - b.leg || a.pickSeq - b.pickSeq);

    const legsCanon = [...legs.entries()].sort().map(([key, leg]) => ({
      key,
      events: leg.events.map((e) => ({
        type: e.type, job: e.job, leg: e.leg, seq: e.seq, ts: e.ts,
        causes: e.causes.map((c) => c.job + ':' + c.leg).sort(),
      })),
    }));
    const chainHash = crypto.createHash('sha256')
      .update(canonical({ legs: legsCanon, edges, rootCauses, staleLog }))
      .digest('hex');

    return { jobs, legs, edges, rootCauses, staleLog, chainHash, clock, danglingCauses };
  }

  certificate() {
    const r = this.build();
    return {
      version: 1,
      timeoutMs: this.timeout,
      virtualClock: r.clock,
      eventCount: this.events.length,
      duplicateCount: this.duplicates,
      jobCount: r.jobs.length,
      legCount: r.legs.size,
      danglingCauses: r.danglingCauses,
      rootCauses: r.rootCauses,
      staleLog: r.staleLog,
      chainHash: r.chainHash,
    };
  }
}

module.exports = { ChainBuilder, chainError, canonical };
