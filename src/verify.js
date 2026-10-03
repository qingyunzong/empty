import { execute, referencedColumns, colMatches } from './engine.js';
import { canonical, sha256 } from './canon.js';
import { ProvError } from './errors.js';

const contribId = (c) => `${c.table}:${canonical(c.key)}`;

// Incremental re-verification: outputs are indexed by outKey, input rows by
// "table key". A correction can only affect an output if it changed a
// query-referenced column of a contributing row, or a membership column
// (join/where/groupby) of any row. Otherwise the output is certified
// "unaffected" without re-execution.
export function reverify(store, outKey, { allowPartial = false } = {}) {
  const state = store.load();
  const out = state.outputs[outKey];
  if (!out) throw new ProvError('E_KEY', `unknown output key '${outKey}'`);
  const proof = store.readProof(outKey); // integrity checked here (E_PROOF)
  if (proof.provenance === 'partial' && !allowPartial) {
    throw new ProvError(
      'E_PARTIAL_HIDDEN',
      `output '${outKey}' has partial provenance; re-run with --allow-partial to obtain its certificate`,
    );
  }

  const corrections = state.corrections.filter((c) => c.epoch > proof.execEpoch);
  const { membership, all } = referencedColumns(state.query);
  let needReexec = false;
  for (const c of corrections) {
    const inContrib = proof.contributions.some((k) => k.table === c.table && String(k.key) === String(c.key));
    if (inContrib) {
      if (c.changedColumns.some((col) => colMatches(all, c.table, col))) needReexec = true;
    } else if (c.changedColumns.some((col) => colMatches(membership, c.table, col))) {
      needReexec = true; // a non-contributor may newly join / enter the group
    }
  }

  let status;
  let method;
  if (!needReexec) {
    status = 'unaffected';
    method = 'incremental-index';
  } else {
    method = 're-execution';
    const result = execute(state.query, store.tables());
    const now = result.outputs.find((o) => o.outKey === outKey) ?? null;
    if (!now) {
      status = 'affected';
    } else {
      const sameValues = canonical(now.values) === canonical(proof.row);
      const sameContrib = canonical(now.contributions.map(contribId)) === canonical(proof.contributions.map(contribId));
      status = sameValues && sameContrib ? 'unaffected' : 'affected';
    }
  }

  const body = {
    type: 'certificate',
    outKey,
    status,
    method,
    provenance: proof.provenance,
    proofDigest: proof.digest,
    proofEpoch: proof.execEpoch,
    dataEpoch: state.dataEpoch,
    corrections: corrections.map((c) => ({ epoch: c.epoch, table: c.table, key: c.key })),
  };
  const cert = { ...body, digest: sha256(canonical(body)) };
  store.writeCert(cert);
  return cert;
}
