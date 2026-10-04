// Lot certificate: explains, with causal evidence, why a lot is locked
// (held / pending) or free, so every batch lockdown is auditable.
import { depsOf, happensBefore, indexById, causalMaxima, topoSort, unknownAncestors } from './statemachine.js';

export function buildCertificate(store, lotId) {
  const all = store.readLog().map((r) => r.event);
  const map = indexById(all);
  const lotEvents = all.filter((e) => e.lot === lotId).sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
  const lot = store.state.lots[lotId];
  const status = lot?.status ?? 'unknown';
  const pending = store.state.pending[lotId] ?? null;
  const conflicts = store.state.conflicts.filter((c) => c.lot === lotId);

  const holds = lotEvents.filter((e) => e.kind === 'quality.hold' || (e.kind === 'quality.scan' && e.payload?.result === 'fail'));
  const releases = lotEvents.filter((e) => e.kind === 'quality.release');

  const locking = lotEvents.filter((e) => holds.includes(e) || releases.includes(e));
  const maxima = causalMaxima(map, locking).map((e) => e.id);
  const unknown = unknownAncestors(map, lotEvents);
  const cycle = topoSort(map, lotEvents) === null;

  // pairwise happens-before among locking events, for the explanation
  const relations = [];
  for (const x of locking) {
    for (const y of locking) {
      if (x.id !== y.id && happensBefore(map, x.id, y.id)) relations.push({ before: x.id, after: y.id });
    }
  }

  let explanation;
  if (status === 'pending') {
    explanation = pending?.reason === 'dependency-cycle'
      ? `lot ${lotId} is PENDING: dependency cycle among ${pending.events.join(', ')}; not failed, awaiting resolution`
      : `lot ${lotId} is PENDING: unknown ancestor(s) ${pending?.ancestors?.join(', ')}; not failed, awaiting sync`;
  } else if (status === 'held') {
    const c = conflicts[0];
    explanation = c
      ? `lot ${lotId} is LOCKED (held): concurrent hold/release among maximal events [${c.maximal.map((m) => m.id).join(', ')}]; safety-first hold wins`
      : `lot ${lotId} is LOCKED (held) by ${holds.map((h) => h.id).join(', ') || 'no hold'}; no causal release supersedes it`;
  } else if (status === 'normal') {
    explanation = releases.length > 0
      ? `lot ${lotId} is free: release ${releases[releases.length - 1].id} causally supersedes all holds`
      : `lot ${lotId} is free: no hold on record`;
  } else {
    explanation = `lot ${lotId} has no events`;
  }

  return {
    lot: lotId,
    status,
    locked: status === 'held' || status === 'pending',
    explanation,
    holds: holds.map((e) => ({ id: e.id, ts: e.ts, auto: e.payload?.auto === true || e.kind === 'quality.scan', deps: depsOf(e) })),
    releases: releases.map((e) => ({ id: e.id, ts: e.ts, deps: depsOf(e) })),
    causal: { maximal: maxima, happensBefore: relations, unknownAncestors: unknown, cycle },
    conflicts,
    pending,
    watermark: store.state.watermark,
    appliedSeq: store.state.appliedSeq,
  };
}
