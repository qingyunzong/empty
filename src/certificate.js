// Certificate (out.json) construction and verification. Certificates are
// self-contained: each version embeds the events, constraint edges and
// commutation pairs needed to replay the verdict offline.

import { pairKey, validUpToCommutation } from './semantics.js';
import { referenceCheck } from './reference.js';
import { minimalCounterexample, findSerialization } from './checker.js';

function stripEvent(e) {
  return {
    id: e.id, node: e.node, prev: e.prev, invocation: e.invocation,
    response: e.response, realTime: e.realTime, op: e.op, key: e.key, value: e.value,
  };
}

function replayOf(r) {
  return {
    events: r.events.map(stripEvent),
    edges: r.edges.map(([u, v]) => [r.events[u].id, r.events[v].id]),
    commutes: r.commutePairs.map(([u, v]) => [r.events[u].id, r.events[v].id]),
  };
}

function certificateOf(r) {
  if (r.verdict === 'LINEARIZABLE') return { serialization: r.serialization };
  if (r.verdict === 'NON_LINEARIZABLE') {
    return {
      counterexample: r.counterexample,
      minimal: r.minimal,
      searchComplete: r.searchComplete,
    };
  }
  return {
    reason: r.missingCorrectionTarget ? 'correction-target-missing' : 'missing-events',
    pending: r.pending,
    danglingPrev: r.danglingPrev,
    missingCorrectionTarget: r.missingCorrectionTarget || null,
  };
}

export function buildOutput(compiled, versionResults) {
  const versions = versionResults.map((r, i) => ({
    version: i + 1,
    status: i === versionResults.length - 1 ? 'CURRENT' : 'SUPERSEDED',
    verdict: r.verdict,
    correction: r.correction ? { id: r.correction.id, corrects: r.correction.corrects } : null,
    certificate: certificateOf(r),
    replay: replayOf(r),
  }));
  return {
    tool: 'linck',
    formatVersion: 1,
    verdict: versions[versions.length - 1].verdict,
    effects: compiled.effects,
    versions,
  };
}

function indexEdges(events, idPairs, what, errors) {
  const idx = new Map(events.map((e, i) => [e.id, i]));
  const out = [];
  for (const [a, b] of idPairs) {
    if (!idx.has(a) || !idx.has(b)) {
      errors.push(`${what} references unknown event id`);
      continue;
    }
    out.push([idx.get(a), idx.get(b)]);
  }
  return out;
}

function verifyVersion(v, effects, errors) {
  const tag = `version ${v.version}`;
  const events = v.replay.events;
  const n = events.length;
  const ids = events.map((e) => e.id);
  if (new Set(ids).size !== n) errors.push(`${tag}: duplicate event ids in replay`);

  if (v.verdict === 'UNKNOWN') {
    const cert = v.certificate;
    const pending = cert.pending || [];
    const dangling = cert.danglingPrev || [];
    if (pending.length === 0 && dangling.length === 0 && !cert.missingCorrectionTarget) {
      errors.push(`${tag}: UNKNOWN verdict without missing events`);
    }
    const byId = new Map(events.map((e) => [e.id, e]));
    if (cert.missingCorrectionTarget && byId.has(cert.missingCorrectionTarget)) {
      errors.push(`${tag}: correction target "${cert.missingCorrectionTarget}" actually exists`);
    }
    for (const id of pending) {
      const e = byId.get(id);
      if (!e || e.response !== null) errors.push(`${tag}: pending event "${id}" is not actually pending`);
    }
    for (const id of dangling) {
      const e = byId.get(id);
      if (!e || e.prev == null || byId.has(e.prev)) errors.push(`${tag}: event "${id}" does not have a dangling prev`);
    }
    return;
  }

  const edges = indexEdges(events, v.replay.edges || [], `${tag} edges`, errors);
  const commutes = indexEdges(events, v.replay.commutes || [], `${tag} commutes`, errors);
  const commKeySet = new Set(commutes.map(([u, v]) => pairKey(events[u].id, events[v].id)));

  if (v.verdict === 'LINEARIZABLE') {
    const ser = v.certificate.serialization;
    if (!Array.isArray(ser) || ser.length !== n || new Set(ser).size !== n ||
        !ser.every((id) => ids.includes(id))) {
      errors.push(`${tag}: serialization is not a permutation of the events`);
      return;
    }
    const pos = new Map(ser.map((id, i) => [id, i]));
    for (const [a, b] of v.replay.edges || []) {
      if (pos.get(a) >= pos.get(b)) errors.push(`${tag}: serialization violates edge ${a} -> ${b}`);
    }
    const byId = new Map(events.map((e) => [e.id, e]));
    const seq = ser.map((id) => byId.get(id));
    if (!validUpToCommutation(seq, commKeySet, effects)) {
      errors.push(`${tag}: serialization is not register-valid up to commutation`);
    }
    return;
  }

  if (v.verdict === 'NON_LINEARIZABLE') {
    const ref = referenceCheck(events, edges, commutes, effects);
    if (ref.verdict !== 'NON_LINEARIZABLE') {
      errors.push(`${tag}: replay found a valid serialization, verdict should be LINEARIZABLE`);
      return;
    }
    const cert = v.certificate;
    const ce = cert.counterexample || [];
    const sorted = ce.slice().sort();
    if (JSON.stringify(ce) !== JSON.stringify(sorted)) {
      errors.push(`${tag}: counterexample is not sorted by event id`);
    }
    const idx = new Map(ids.map((id, i) => [id, i]));
    if (!ce.every((id) => idx.has(id))) {
      errors.push(`${tag}: counterexample references unknown event ids`);
      return;
    }
    const subIdx = ce.map((id) => idx.get(id));
    const subEvents = subIdx.map((i) => events[i]);
    const inSub = new Set(subIdx);
    const subEdges = edges.filter(([u, v]) => inSub.has(u) && inSub.has(v));
    const subCommutes = commutes.filter(([u, v]) => inSub.has(u) && inSub.has(v));
    const subCommKeySet = new Set(subCommutes.map(([u, v]) => pairKey(events[u].id, events[v].id)));
    if (findSerialization(subEvents, subEdges.map(([u, v]) => [subIdx.indexOf(u), subIdx.indexOf(v)]), subCommKeySet, effects).order !== null) {
      errors.push(`${tag}: counterexample subset is actually linearizable`);
    }
    if (cert.minimal && n <= 12) {
      const canonical = minimalCounterexample(events, edges, commutes, effects);
      if (JSON.stringify(canonical.counterexample) !== JSON.stringify(ce)) {
        errors.push(`${tag}: counterexample is not the canonical shortest one (expected ${canonical.counterexample.join(',')})`);
      }
    }
    return;
  }

  errors.push(`${tag}: unknown verdict "${v.verdict}"`);
}

export function verifyOutput(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['certificate file must contain a JSON object'] };
  }
  if (obj.tool !== 'linck') errors.push('missing or wrong "tool" field');
  if (obj.formatVersion !== 1) errors.push('unsupported formatVersion');
  if (!obj.effects || typeof obj.effects !== 'object') errors.push('missing "effects"');
  if (!Array.isArray(obj.versions) || obj.versions.length === 0) {
    errors.push('missing or empty "versions"');
    return { ok: false, errors };
  }
  obj.versions.forEach((v, i) => {
    const expected = i === obj.versions.length - 1 ? 'CURRENT' : 'SUPERSEDED';
    if (v.status !== expected) errors.push(`version ${v.version}: status should be ${expected}, got ${v.status}`);
    if (!v.replay || !Array.isArray(v.replay.events)) {
      errors.push(`version ${v.version}: missing replay events`);
      return;
    }
    verifyVersion(v, obj.effects || {}, errors);
  });
  const last = obj.versions[obj.versions.length - 1];
  if (obj.verdict !== last.verdict) errors.push('top-level verdict does not match the current version verdict');
  return { ok: errors.length === 0, errors };
}
