import { createHash } from 'node:crypto';
import { AgvError } from './errors.js';
import { findCycles } from './cycles.js';

export const DEFAULT_WINDOW_MS = 10_000;
export const DEFAULT_WATERMARK_LAG_MS = 2_000;

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',');
  return `{${body}}`;
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Deterministic order for "who arrived at the occupied edge later".
// Uses event time only (never arrival order); ties broken by agv then id.
function cmpReserve(a, b) {
  if (a.eventTs !== b.eventTs) return a.eventTs - b.eventTs;
  if (a.agv !== b.agv) return a.agv < b.agv ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// A reserve occupies its edge during the half-open interval
// [eventTs, eventTs + windowMs). It is "real occupancy" only when a ping
// from the same agv falls inside that window (window join).
export function buildWaitEdges(reserves, pings, windowMs) {
  const pingsByAgv = new Map();
  for (const p of pings) {
    if (!pingsByAgv.has(p.agv)) pingsByAgv.set(p.agv, []);
    pingsByAgv.get(p.agv).push(p);
  }
  for (const list of pingsByAgv.values()) list.sort((a, b) => a.eventTs - b.eventTs);

  const confirmingPing = new Map();
  for (const r of reserves) {
    const list = pingsByAgv.get(r.agv) ?? [];
    const hit = list.find((p) => p.eventTs >= r.eventTs && p.eventTs < r.eventTs + windowMs);
    if (hit) confirmingPing.set(r.id, hit);
  }

  const byEdge = new Map();
  for (const r of reserves) {
    if (!byEdge.has(r.edge)) byEdge.set(r.edge, []);
    byEdge.get(r.edge).push(r);
  }

  const waits = [];
  for (const edge of [...byEdge.keys()].sort()) {
    const rs = byEdge.get(edge);
    for (const waiter of rs) {
      for (const holder of rs) {
        if (waiter === holder || waiter.agv === holder.agv) continue;
        const ping = confirmingPing.get(holder.id);
        if (!ping) continue;
        if (cmpReserve(waiter, holder) <= 0) continue;
        const overlapStart = Math.max(waiter.eventTs, holder.eventTs);
        const overlapEnd = Math.min(waiter.eventTs + windowMs, holder.eventTs + windowMs);
        // Half-open intervals: touching exactly at an endpoint is NOT a wait.
        if (!(overlapStart < overlapEnd)) continue;
        waits.push({
          from: waiter.agv,
          to: holder.agv,
          edge,
          overlapStart,
          overlapEnd,
          waiterReserveId: waiter.id,
          waiterEventTs: waiter.eventTs,
          holderReserveId: holder.id,
          holderEventTs: holder.eventTs,
          pingId: ping.id ?? null,
          pingEventTs: ping.eventTs,
        });
      }
    }
  }
  waits.sort(
    (a, b) =>
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
      (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0) ||
      (a.waiterReserveId < b.waiterReserveId ? -1 : a.waiterReserveId > b.waiterReserveId ? 1 : 0),
  );
  return waits;
}

// Build one reproducible certificate per elementary wait cycle.
// Hash covers the canonical cycle plus per-edge evidence event ids.
export function computeCertificates(waits) {
  const adj = new Map();
  for (const w of waits) {
    if (!adj.has(w.from)) adj.set(w.from, new Set());
    adj.get(w.from).add(w.to);
    if (!adj.has(w.to)) adj.set(w.to, new Set());
  }
  const cycles = findCycles(adj);
  const certs = cycles.map((nodes) => {
    const edges = nodes.map((from, i) => {
      const to = nodes[(i + 1) % nodes.length];
      const w = waits.find((cand) => cand.from === from && cand.to === to);
      return {
        from,
        to,
        edge: w.edge,
        overlapStart: w.overlapStart,
        overlapEnd: w.overlapEnd,
        waiterReserveId: w.waiterReserveId,
        holderReserveId: w.holderReserveId,
        pingId: w.pingId,
      };
    });
    const body = { cycle: nodes, edges };
    return { hash: sha256Hex(stableStringify(body)), status: 'active', ...body };
  });
  certs.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return certs;
}

function publicEvent(ev) {
  const { _where, ...rest } = ev;
  return rest;
}

// Stream events in arrival order, but judge concurrency purely by event-time
// interval overlap. Late events (eventTs below the watermark) are still
// applied and are recorded in the late log.
export function runEngine(events, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const watermarkLagMs = options.watermarkLagMs ?? DEFAULT_WATERMARK_LAG_MS;

  const knownAgvs = new Set();
  for (const ev of events) {
    if (ev.op === 'reserve') knownAgvs.add(ev.agv);
  }
  for (const ev of events) {
    if (ev.op === 'ping' && !knownAgvs.has(ev.agv)) {
      throw new AgvError(
        'UNKNOWN_AGV',
        `ping at ${ev._where ?? '?'} references unknown agv ${JSON.stringify(ev.agv)} (no reserve event for it)`,
      );
    }
  }

  const reserves = new Map();
  const pings = new Map();
  const seenReserveIds = new Set();
  const late = [];
  const invalidated = [];
  const invalidatedHashes = new Set();
  let activeCerts = new Map();
  let waits = [];
  let maxTs = null;
  let anonPingSeq = 0;

  const recompute = () => {
    waits = buildWaitEdges([...reserves.values()], [...pings.values()], windowMs);
    const certs = computeCertificates(waits);
    return new Map(certs.map((c) => [c.hash, c]));
  };

  for (const ev of events) {
    if (maxTs !== null && ev.eventTs < maxTs - watermarkLagMs) {
      late.push({
        eventTs: ev.eventTs,
        watermark: maxTs - watermarkLagMs,
        op: ev.op,
        where: ev._where ?? null,
        event: publicEvent(ev),
      });
    }
    if (maxTs === null || ev.eventTs > maxTs) maxTs = ev.eventTs;

    switch (ev.op) {
      case 'reserve': {
        if (seenReserveIds.has(ev.id)) {
          throw new AgvError('DUP_RESERVE', `duplicate reserveId ${JSON.stringify(ev.id)} at ${ev._where ?? '?'}`);
        }
        seenReserveIds.add(ev.id);
        reserves.set(ev.id, { id: ev.id, agv: ev.agv, edge: ev.edge, eventTs: ev.eventTs });
        break;
      }
      case 'ping': {
        const key = ev.id ?? `__anon_${anonPingSeq}`;
        anonPingSeq += 1;
        pings.set(key, { id: ev.id ?? null, agv: ev.agv, node: ev.node, speed: ev.speed, eventTs: ev.eventTs });
        break;
      }
      case 'cancel': {
        reserves.delete(ev.reserveId);
        break;
      }
      case 'retract': {
        if (ev.kind === 'reserve') reserves.delete(ev.id);
        else pings.delete(ev.id);
        break;
      }
      default:
        throw new AgvError('INVALID_EVENT', `unsupported op ${JSON.stringify(ev.op)}`);
    }

    const now = recompute();
    for (const [hash, cert] of activeCerts) {
      if (!now.has(hash) && !invalidatedHashes.has(hash)) {
        invalidatedHashes.add(hash);
        invalidated.push({
          status: 'invalidated',
          hash,
          cycle: cert.cycle,
          edges: cert.edges,
          invalidatedBy: {
            op: ev.op,
            eventTs: ev.eventTs,
            id: ev.id ?? ev.reserveId ?? null,
            where: ev._where ?? null,
          },
        });
      }
    }
    activeCerts = now;
  }

  return { waits, cycles: [...activeCerts.values()], invalidated, late };
}
