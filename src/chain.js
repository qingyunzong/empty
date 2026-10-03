// Core evidence-chain model: finite entity/state domains, event application,
// constraint checking, taint propagation, and verdict computation.
import { createHash } from 'node:crypto';

// ---- Finite domains -------------------------------------------------------
export const NODE_KINDS = Object.freeze(['sample', 'aliquot', 'assay', 'batch']);
export const NODE_STATUS = Object.freeze(['ACTIVE', 'QC_FAILED', 'REVOKED']);
export const EVENT_TYPES = Object.freeze([
  'register', 'batch', 'aliquot', 'assay',
  'qc_fail', 'revoke', 'attest', 'snapshot', 'verify',
]);
export const VERDICTS = Object.freeze(['VALID', 'BROKEN', 'STALE', 'PENDING']);

// ---- Domain constants ------------------------------------------------------
export const COLD_CHAIN_HOURS = 72;          // collection -> assay limit
export const CONCLUSION_TTL_HOURS = 24 * 90; // conclusion validity after assay

// ---- Hashing helpers -------------------------------------------------------
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function signAttestation(signer, chainHash) {
  return sha256(`${signer}:${chainHash}`);
}

// ---- State construction ----------------------------------------------------
function newNode(id, kind) {
  return {
    id, kind,
    parents: [], children: [],
    volume: 0, remaining: 0, collectedAt: null,
    assayType: null, batchId: null, assayedAt: null, result: null,
    batchAssays: null, batchExpiresAt: null,
    status: 'ACTIVE',
    breaks: [],   // direct constraint breaks: {seq, reason, detail}
    stale: [],    // staleness markers:      {seq, reason, detail}
    statusEvents: [], // qc_fail / revoke events: {seq, type, reason}
    attestation: null,
    chainHash: null,
  };
}

// chainHash depends only on the derivation (creation) events of ancestors,
// so it is stable across later qc_fail/revoke/attest events and compaction.
function hashOf(state, id, memo) {
  if (memo.has(id)) return memo.get(id);
  const node = state.nodes.get(id);
  if (node.chainHash) { memo.set(id, node.chainHash); return node.chainHash; }
  const own = state.creationEvents.has(id)
    ? sha256(canonical(state.creationEvents.get(id)))
    : 'missing';
  const parentHashes = node.parents
    .filter((p) => state.nodes.has(p))
    .map((p) => hashOf(state, p, memo)).sort();
  const h = sha256(canonical({ id, own, parents: parentHashes }));
  memo.set(id, h);
  return h;
}

export function computeChainHashes(state) {
  const memo = new Map();
  for (const id of state.nodes.keys()) {
    state.nodes.get(id).chainHash = hashOf(state, id, memo);
  }
}

function applyEvent(state, event, seq) {
  const { nodes } = state;
  switch (event.type) {
    case 'register': {
      const n = newNode(event.sampleId, 'sample');
      n.volume = event.volume;
      n.remaining = event.volume;
      n.collectedAt = event.time;
      nodes.set(n.id, n);
      state.creationEvents.set(n.id, event);
      break;
    }
    case 'batch': {
      const n = newNode(event.batchId, 'batch');
      n.batchAssays = [...event.assays];
      n.batchExpiresAt = event.expiresAt;
      nodes.set(n.id, n);
      state.creationEvents.set(n.id, event);
      break;
    }
    case 'aliquot': {
      const n = newNode(event.aliquotId, 'aliquot');
      n.volume = event.volume;
      n.remaining = event.volume;
      const parent = nodes.get(event.parentId);
      if (!parent) {
        n.breaks.push({ seq, reason: 'missing-parent', detail: event.parentId });
      } else {
        n.parents.push(parent.id);
        parent.children.push(n.id);
        n.collectedAt = parent.collectedAt;
        if (!(event.volume > 0) || event.volume > parent.remaining) {
          n.breaks.push({
            seq, reason: 'volume-conservation',
            detail: `requested ${event.volume}uL from ${parent.id} with ${parent.remaining}uL remaining`,
          });
        } else {
          parent.remaining -= event.volume;
        }
      }
      nodes.set(n.id, n);
      state.creationEvents.set(n.id, event);
      break;
    }
    case 'assay': {
      const n = newNode(event.assayId, 'assay');
      n.assayType = event.assayType;
      n.batchId = event.batchId;
      n.assayedAt = event.time;
      n.result = event.result ?? null;
      const src = nodes.get(event.sourceId);
      if (!src) {
        n.breaks.push({ seq, reason: 'missing-parent', detail: event.sourceId });
      } else {
        n.parents.push(src.id);
        src.children.push(n.id);
        n.collectedAt = src.collectedAt;
        if (n.collectedAt != null && event.time - n.collectedAt > COLD_CHAIN_HOURS) {
          n.stale.push({
            seq, reason: 'cold-chain-exceeded',
            detail: `${event.time - n.collectedAt}h > ${COLD_CHAIN_HOURS}h`,
          });
        }
      }
      const batch = nodes.get(event.batchId);
      if (!batch || batch.kind !== 'batch') {
        n.breaks.push({ seq, reason: 'unknown-batch', detail: event.batchId });
      } else {
        if (!batch.batchAssays.includes(event.assayType)) {
          n.breaks.push({
            seq, reason: 'reagent-incompatible',
            detail: `batch ${event.batchId} not validated for ${event.assayType}`,
          });
        }
        if (event.time > batch.batchExpiresAt) {
          n.stale.push({
            seq, reason: 'reagent-expired',
            detail: `batch ${event.batchId} expired at ${batch.batchExpiresAt}`,
          });
        }
      }
      nodes.set(n.id, n);
      state.creationEvents.set(n.id, event);
      break;
    }
    case 'qc_fail': {
      const n = nodes.get(event.targetId);
      if (n) {
        n.status = 'QC_FAILED';
        n.statusEvents.push({ seq, type: 'qc_fail', reason: event.reason });
      }
      break;
    }
    case 'revoke': {
      const n = nodes.get(event.targetId);
      if (n) {
        n.status = 'REVOKED';
        n.statusEvents.push({ seq, type: 'revoke', reason: event.reason });
      }
      break;
    }
    case 'attest': {
      const n = nodes.get(event.targetId);
      if (n) {
        computeChainHashes(state);
        n.attestation = {
          signer: event.signer,
          signature: signAttestation(event.signer, n.chainHash),
          time: event.time,
        };
      }
      break;
    }
    case 'snapshot': {
      for (const s of event.nodes) {
        const n = { ...newNode(s.id, s.kind), ...s };
        nodes.set(n.id, n);
        if (n.chainHash == null && state.creationEvents.has(n.id)) {
          // hash recomputed later
        }
      }
      break;
    }
    case 'verify':
      break; // audit-trail marker only
    default:
      throw new Error(`unknown event type: ${event.type}`);
  }
}

export function buildState(events) {
  const state = { nodes: new Map(), creationEvents: new Map() };
  events.forEach((event, seq) => applyEvent(state, event, seq));
  computeChainHashes(state);
  return state;
}

export function serializeNodes(state) {
  return [...state.nodes.values()].map((n) => ({
    id: n.id, kind: n.kind,
    parents: [...n.parents], children: [...n.children],
    volume: n.volume, remaining: n.remaining, collectedAt: n.collectedAt,
    assayType: n.assayType, batchId: n.batchId, assayedAt: n.assayedAt, result: n.result,
    batchAssays: n.batchAssays ? [...n.batchAssays] : null,
    batchExpiresAt: n.batchExpiresAt,
    status: n.status,
    breaks: n.breaks.map((b) => ({ ...b })),
    stale: n.stale.map((s) => ({ ...s })),
    statusEvents: n.statusEvents.map((s) => ({ ...s })),
    attestation: n.attestation ? { ...n.attestation } : null,
    chainHash: n.chainHash,
  }));
}

// ---- Derivation closure (used by revocation contagion + enumeration check) -
// edges: [parent, child] pairs; returns the set of nodes reachable from
// `sources` following parent->child edges (sources included).
export function descendantClosure(nodeCount, edges, sources) {
  const adj = new Map();
  for (const [from, to] of edges) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  const out = new Set(sources);
  const stack = [...sources];
  while (stack.length) {
    const cur = stack.pop();
    for (const next of adj.get(cur) ?? []) {
      if (!out.has(next)) { out.add(next); stack.push(next); }
    }
  }
  return out;
}

// ---- Verification ----------------------------------------------------------
function isTaintSource(node) {
  return node.breaks.length > 0 || node.status === 'REVOKED' || node.status === 'QC_FAILED';
}

function taintReasons(node) {
  const reasons = node.breaks.map((b) => ({ kind: 'constraint', ...b }));
  for (const s of node.statusEvents) {
    reasons.push({ kind: s.type, seq: s.seq, reason: s.type, detail: s.reason });
  }
  return reasons;
}

// Minimal broken core: taint-source nodes among the explored ancestors that
// are NOT proper ancestors of any other taint source, i.e. the breakage
// frontier nearest to the target. Every taint path to the target crosses the
// core, and no element of the core is redundant.
export function minimalCore(state, targetId, scope) {
  const sources = [...scope].filter((id) => isTaintSource(state.nodes.get(id)));
  const sourceSet = new Set(sources);
  const hasDownstreamSource = (id) => {
    // is any other source a proper descendant of id (within scope)?
    const stack = [...(state.nodes.get(id)?.children ?? [])];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur) || !scope.has(cur)) continue;
      seen.add(cur);
      if (sourceSet.has(cur)) return true;
      stack.push(...(state.nodes.get(cur)?.children ?? []));
    }
    return false;
  };
  return sources
    .filter((id) => !hasDownstreamSource(id))
    .map((id) => ({ node: id, reasons: taintReasons(state.nodes.get(id)) }));
}

export function verifyTarget(state, targetId, { budget = Infinity, now = null } = {}) {
  const target = state.nodes.get(targetId);
  if (!target) {
    return { verdict: 'BROKEN', target: targetId, core: [{ node: targetId, reasons: [{ kind: 'constraint', reason: 'unknown-target' }] }] };
  }
  // Budget-limited ancestor exploration (audit budget).
  const visited = new Set();
  const queue = [targetId];
  let truncated = false;
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    if (visited.size >= budget) { truncated = true; break; }
    visited.add(id);
    for (const p of state.nodes.get(id).parents) {
      if (!visited.has(p)) queue.push(p);
    }
  }
  // Revocation contagion / QC propagation: any taint source among ancestors
  // (or the target itself) breaks the conclusion.
  const core = minimalCore(state, targetId, visited);
  if (core.length > 0) {
    return { verdict: 'BROKEN', target: targetId, core, ancestorsExplored: visited.size };
  }
  if (truncated) {
    // Budget exhausted before a conclusive verdict: PENDING is not BROKEN.
    return { verdict: 'PENDING', target: targetId, ancestorsExplored: visited.size, budget };
  }
  // Staleness: cold-chain / reagent-expiry markers plus conclusion TTL.
  const staleReasons = [...target.stale];
  if (target.kind === 'assay' && now != null && now - target.assayedAt > CONCLUSION_TTL_HOURS) {
    staleReasons.push({ reason: 'conclusion-expired', detail: `assayed ${now - target.assayedAt}h before audit` });
  }
  if (staleReasons.length > 0) {
    return { verdict: 'STALE', target: targetId, stale: staleReasons, ancestorsExplored: visited.size };
  }
  const att = target.attestation;
  const certificate = {
    target: targetId,
    chainHash: target.chainHash,
    ancestorsExplored: visited.size,
    attested: !!att,
    signer: att?.signer ?? null,
    signatureValid: att ? att.signature === signAttestation(att.signer, target.chainHash) : null,
  };
  return { verdict: 'VALID', target: targetId, certificate };
}
