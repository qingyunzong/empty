import { canonical, sha256, Graph, LotError, EXIT, eventEdges } from './core.js';

const CERT_DOMAIN = 'lot-genealogy/cert/v1';

function chainHash(lots, events, edges, boundary) {
  let h = sha256(CERT_DOMAIN);
  for (const rec of lots) h = sha256(h + canonical({ kind: 'lot', ...rec }));
  for (const rec of events) h = sha256(h + canonical({ kind: 'event', ...rec }));
  for (const rec of edges) h = sha256(h + canonical({ kind: 'edge', ...rec }));
  h = sha256(h + canonical({ boundary }));
  return h;
}

export function buildCert(graph, rootId, { tol } = {}) {
  if (!graph.lots.has(rootId)) {
    throw new LotError(EXIT.VALIDATION, `unknown lot: ${rootId}`);
  }
  const { lots, edges } = graph.ancestry(rootId);
  const pending = graph.pending();
  const blocking = pending.events.filter((eid) => {
    const ev = graph.pendingEvents.get(eid);
    return [...ev.inputs, ...ev.outputs].some((e) => lots.has(e.lot));
  });
  if (blocking.length > 0) {
    throw new LotError(EXIT.PENDING, 'genealogy incomplete: pending events touch ancestry', {
      pendingEvents: blocking,
      pendingLots: pending.lots,
    });
  }
  // event closure: sibling outputs of ancestry events join as boundary evidence
  const edgeSet = new Set(edges);
  const lotSet = new Set(lots);
  const eventIds = [...new Set([...edges].map((id) => graph.edges.get(id).event))].sort();
  for (const eid of eventIds) {
    for (const edge of eventEdges(graph.events.get(eid))) {
      edgeSet.add(edge.id);
      lotSet.add(edge.from);
      lotSet.add(edge.to);
    }
  }
  const boundary = [...lotSet].filter((id) => !lots.has(id)).sort();
  const lotRecs = [...lotSet].map((id) => graph.lots.get(id)).sort((a, b) => a.id.localeCompare(b.id));
  const edgeRecs = [...edgeSet]
    .map((id) => graph.edges.get(id))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || a.id.localeCompare(b.id));
  const eventRecs = eventIds.map((id) => graph.events.get(id));
  const h = chainHash(lotRecs, eventRecs, edgeRecs, boundary);
  return {
    version: 1,
    root: rootId,
    tol: tol ?? graph.tol,
    lots: lotRecs,
    events: eventRecs,
    edges: edgeRecs,
    boundary,
    chain: h,
    certId: h,
  };
}

function failCert(message, details) {
  throw new LotError(EXIT.CERT, message, details);
}

export function verifyCert(cert, { graph } = {}) {
  if (!cert || typeof cert !== 'object' || cert.version !== 1) failCert('malformed certificate');
  const { root, lots, events, edges, boundary, chain, certId } = cert;
  if (!root || !Array.isArray(lots) || !Array.isArray(events) || !Array.isArray(edges) || !Array.isArray(boundary) || !chain) {
    failCert('malformed certificate');
  }

  // 1. hash chain: any tampering with lots/events/edges/boundary breaks it
  if (chainHash(lots, events, edges, boundary) !== chain || certId !== chain) {
    failCert('hash chain mismatch: certificate tampered');
  }

  const tol = cert.tol ?? 1e-9;
  const within = (a, b) => Math.abs(a - b) <= Math.max(tol, tol * Math.max(Math.abs(a), Math.abs(b)));

  const lotIds = new Set(lots.map((l) => l.id));
  const boundarySet = new Set(boundary);
  if (!lotIds.has(root)) failCert('root lot missing from certificate');
  for (const id of boundarySet) {
    if (!lotIds.has(id)) failCert('boundary lot missing from certificate lots', { lot: id });
  }

  // 2. endpoint closure
  for (const e of edges) {
    if (!lotIds.has(e.from) || !lotIds.has(e.to)) {
      failCert('edge endpoint missing from certificate lots', { edge: e.id });
    }
  }

  // 3. cycle detection via topological sort
  const indeg = new Map([...lotIds].map((id) => [id, 0]));
  const adj = new Map([...lotIds].map((id) => [id, []]));
  for (const e of edges) {
    indeg.set(e.to, indeg.get(e.to) + 1);
    adj.get(e.from).push(e.to);
  }
  const queue = [...lotIds].filter((id) => indeg.get(id) === 0);
  let visited = 0;
  while (queue.length) {
    const node = queue.pop();
    visited++;
    for (const next of adj.get(node)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== lotIds.size) failCert('CYCLE detected in certificate genealogy');

  // 4. completeness: non-boundary lots reach root and (except root) have outgoing edges
  const reachesRoot = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (reachesRoot.has(e.to) && !reachesRoot.has(e.from)) {
        reachesRoot.add(e.from);
        grew = true;
      }
    }
  }
  const hasOut = new Set(edges.map((e) => e.from));
  for (const id of lotIds) {
    if (boundarySet.has(id)) continue;
    if (!reachesRoot.has(id)) failCert('lot does not contribute to root: extraneous lot or missing edges', { lot: id });
    if (id !== root && !hasOut.has(id)) failCert('missing edge: non-root lot has no outgoing edge', { lot: id });
  }

  // 5. per-event integrity: expected edges present, conservation holds
  const edgeIds = new Set(edges.map((e) => e.id));
  for (const event of events) {
    const sumIn = event.inputs.reduce((a, i) => a + i.mass, 0);
    const sumOut = event.outputs.reduce((a, o) => a + o.mass, 0);
    if (!within(sumIn, sumOut)) failCert('conservation violation in event', { event: event.id, sumIn, sumOut });
    if (event.op === 'relabel' && !within(event.inputs[0].mass, event.outputs[0].mass)) {
      failCert('relabel does not preserve mass', { event: event.id });
    }
    for (const expected of eventEdges(event)) {
      if (!edgeIds.has(expected.id)) {
        failCert('missing edge: event endpoint has no corresponding edge', { event: event.id, edge: expected.id });
      }
    }
  }
  for (const e of edges) {
    if (!events.some((ev) => ev.id === e.event)) failCert('edge references unknown event', { edge: e.id });
  }

  // 6. optional cross-check against a local store
  if (graph instanceof Graph && graph.lots.has(root)) {
    const local = graph.ancestry(root);
    for (const eid of local.edges) {
      if (!edgeIds.has(eid)) failCert('missing edge: local store has ancestry edges absent from certificate', { edge: eid });
    }
    const localEventIds = new Set([...local.edges].map((eid) => graph.edges.get(eid).event));
    for (const eid of edgeIds) {
      if (!local.edges.has(eid)) {
        const ev = edges.find((x) => x.id === eid)?.event;
        if (!localEventIds.has(ev)) failCert('certificate contains edge unknown to local store', { edge: eid });
      }
    }
  }
  return { ok: true, root, lots: lots.length, events: events.length, edges: edges.length, chain };
}
