import { Graph } from './graph.js';
import { canonical, sha256hex } from './canon.js';
import { LotError, EXIT } from './errors.js';

const GENESIS = sha256hex('lot-genealogy:cert:v1');

function chainEntries(entries) {
  let head = GENESIS;
  for (const e of entries) head = sha256hex(head + ':' + sha256hex(canonical(e)));
  return head;
}

// Build a hash-chained certificate for the full ancestry of root.
export function buildCert(graph, root) {
  if (!graph.lots.has(root)) {
    const blocked = graph.pending.some(
      (p) => p.out.some((o) => o.lot === root) || p.in.some((i) => i.lot === root)
    );
    if (blocked) throw new LotError(EXIT.PENDING, `lot ${root} blocked by pending operations`);
    throw new LotError(EXIT.VALIDATION, `unknown lot ${root}`);
  }
  const anc = graph.ancestors(root);
  for (const p of graph.pending) {
    const refs = [...p.in.map((x) => x.lot), ...p.out.map((x) => x.lot)];
    if (refs.some((r) => anc.has(r)))
      throw new LotError(EXIT.PENDING, `pending op ${p.id} touches genealogy of ${root}`);
  }
  const entries = [];
  for (const lot of [...anc].sort()) {
    const l = graph.lots.get(lot);
    entries.push({ kind: 'lot', lot, mass: l.mass, createdTs: l.createdTs });
  }
  for (const op of graph.ancestorOps(root)) entries.push({ kind: 'op', entry: op });
  return { version: 1, root, count: entries.length, entries, head: chainEntries(entries) };
}

// Verify a certificate standalone: chain integrity, acyclicity,
// completeness (no missing edges/lots), conservation, lot-mass consistency.
export function verifyCert(cert) {
  const fail = (msg) => new LotError(EXIT.CERT, msg);
  if (!cert || typeof cert !== 'object') throw fail('certificate is not an object');
  if (cert.version !== 1 || typeof cert.root !== 'string' || typeof cert.head !== 'string' || !Array.isArray(cert.entries))
    throw fail('malformed certificate');
  const seen = new Set();
  for (const e of cert.entries) {
    const h = sha256hex(canonical(e));
    if (seen.has(h)) throw fail('duplicate entry in certificate');
    seen.add(h);
  }
  if (chainEntries(cert.entries) !== cert.head) throw fail('hash chain mismatch: tampering detected');
  if (cert.count !== cert.entries.length) throw fail('entry count mismatch');

  const lotEntries = new Map();
  const ops = [];
  for (const e of cert.entries) {
    if (e.kind === 'lot') {
      if (lotEntries.has(e.lot)) throw fail(`duplicate lot entry ${e.lot}`);
      lotEntries.set(e.lot, e);
    } else if (e.kind === 'op') {
      ops.push(e.entry);
    } else throw fail(`unknown entry kind ${e.kind}`);
  }
  if (!lotEntries.has(cert.root)) throw fail(`root lot ${cert.root} missing from certificate`);

  // Replay ops through a fresh DAG: re-validates conservation, status,
  // time order and rejects cycles. Missing parents surface as pending.
  const g = new Graph();
  const sorted = [...ops].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  const errors = g.replay(sorted);
  if (errors.length) throw fail(`invalid op in certificate: ${errors[0].error}`);
  if (g.pending.length) throw fail(`missing edge: op ${g.pending[0].id} references unknown parent lot`);

  // Completeness + consistency: every consumed lot is covered by a lot
  // entry whose mass matches its producer (or register) op exactly.
  const produced = new Map();
  for (const op of ops) {
    for (const o of op.out) {
      if (produced.has(o.lot)) throw fail(`lot ${o.lot} produced twice`);
      produced.set(o.lot, { op, mass: o.mass });
    }
  }
  for (const op of ops) {
    for (const i of op.in) {
      if (!lotEntries.has(i.lot)) throw fail(`missing lot entry for consumed lot ${i.lot}`);
      if (!produced.has(i.lot)) throw fail(`missing edge: no op produces consumed lot ${i.lot}`);
    }
  }
  for (const [lot, le] of lotEntries) {
    const prod = produced.get(lot);
    if (!prod) throw fail(`lot ${lot} has no producing op`);
    if (Math.abs(prod.mass - le.mass) > 1e-9) throw fail(`lot ${lot} mass inconsistent with producer op`);
  }
  if (!g.lots.has(cert.root)) throw fail(`root lot ${cert.root} not produced by certificate ops`);
  return { ok: true, root: cert.root, head: cert.head, lots: lotEntries.size, ops: ops.length };
}
