#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execute } from './engine.js';
import { Store, makeProof, applyCorrection } from './store.js';
import { reverify } from './verify.js';
import { canonical, sha256 } from './canon.js';
import { ProvError, EXIT_CODES } from './errors.js';

const USAGE = `usage:
  prov exec <query.json> <dataDir>     run query, capture lineage, write proofs
  prov prove <outKey>                  show the tamper-evident proof for an output row
  prov correct <table> <key> <patch>   apply a JSON patch to one input row
  prov reverify <outKey>               certify the output affected/unaffected by later corrections
  prov explain [outKey]                show the plan and provenance summary
options:
  --data <dir>       data directory (default: PROV_DATA_DIR or .prov-link written by exec)
  --allow-partial    required to prove/reverify outputs with partial provenance`;

class UsageError extends Error {}

function parseArgs(argv) {
  const pos = [];
  const flags = { allowPartial: false, data: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-partial') flags.allowPartial = true;
    else if (a === '--data') { flags.data = argv[i + 1]; i += 1; }
    else if (a.startsWith('--data=')) flags.data = a.slice('--data='.length);
    else pos.push(a);
  }
  return { pos, flags };
}

function resolveDataDir(flags, ctx) {
  if (flags.data) return flags.data;
  if (ctx.env.PROV_DATA_DIR) return ctx.env.PROV_DATA_DIR;
  try {
    const link = JSON.parse(fs.readFileSync(path.join(ctx.cwd, '.prov-link'), 'utf8'));
    if (link.dataDir) return link.dataDir;
  } catch { /* fall through */ }
  throw new UsageError('no data directory: pass --data, set PROV_DATA_DIR, or run exec first');
}

function cmdExec(pos, ctx) {
  const [queryPath, dataDir] = pos;
  if (!queryPath || !dataDir) throw new UsageError('exec <query.json> <dataDir>');
  const query = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, queryPath), 'utf8'));
  const store = new Store(path.resolve(ctx.cwd, dataDir));
  const result = execute(query, store.tables());
  const state = store.loadOrInit();
  state.query = query;
  state.queryHash = sha256(canonical(query));
  state.execEpoch = state.dataEpoch;
  state.outputs = {};
  state.inputIndex = result.inputIndex;
  for (const o of result.outputs) {
    state.outputs[o.outKey] = { row: o.values, provenance: o.provenance };
    store.writeProof(makeProof({
      outKey: o.outKey,
      execEpoch: state.execEpoch,
      queryHash: state.queryHash,
      row: o.values,
      provenance: o.provenance,
      contributions: o.contributions,
      minimal: o.minimal,
    }));
  }
  store.save(state);
  fs.writeFileSync(path.join(ctx.cwd, '.prov-link'), JSON.stringify({ dataDir: store.dataDir }));
  for (const o of result.outputs) {
    ctx.stdout(JSON.stringify({ outKey: o.outKey, provenance: o.provenance, values: o.values }));
  }
  const partial = result.outputs.filter((o) => o.provenance === 'partial').map((o) => o.outKey);
  ctx.stdout(JSON.stringify({
    summary: {
      outputs: result.outputs.length,
      partial, // partial lineage is reported explicitly, never hidden
      dataEpoch: state.dataEpoch,
      execEpoch: state.execEpoch,
    },
  }));
}

function cmdProve(pos, flags, ctx) {
  const [outKey] = pos;
  if (!outKey) throw new UsageError('prove <outKey>');
  const store = new Store(resolveDataDir(flags, ctx));
  const state = store.load();
  if (!state.outputs[outKey]) throw new ProvError('E_KEY', `unknown output key '${outKey}'`);
  if (state.execEpoch !== state.dataEpoch) {
    throw new ProvError(
      'E_STALE_PROOF',
      `outputs were computed at epoch ${state.execEpoch} but data is at epoch ${state.dataEpoch}; re-run exec`,
    );
  }
  const proof = store.readProof(outKey);
  if (proof.provenance === 'partial' && !flags.allowPartial) {
    throw new ProvError('E_PARTIAL_HIDDEN', `output '${outKey}' has partial provenance; re-run with --allow-partial`);
  }
  ctx.stdout(JSON.stringify(proof, null, 2));
}

function cmdCorrect(pos, flags, ctx) {
  const [table, key, patchStr] = pos;
  if (!table || !key || !patchStr) throw new UsageError('correct <table> <key> <patch>');
  let patch;
  try {
    patch = JSON.parse(patchStr);
  } catch {
    throw new UsageError('patch must be a JSON object, e.g. \'{"amount": 12.5}\'');
  }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new UsageError('patch must be a JSON object');
  }
  const store = new Store(resolveDataDir(flags, ctx));
  ctx.stdout(JSON.stringify(applyCorrection(store, table, key, patch)));
}

function cmdReverify(pos, flags, ctx) {
  const [outKey] = pos;
  if (!outKey) throw new UsageError('reverify <outKey>');
  const store = new Store(resolveDataDir(flags, ctx));
  const cert = reverify(store, outKey, { allowPartial: flags.allowPartial });
  ctx.stdout(JSON.stringify(cert, null, 2));
}

function cmdExplain(pos, flags, ctx) {
  const store = new Store(resolveDataDir(flags, ctx));
  const state = store.load();
  const q = state.query;
  if (!q) throw new ProvError('E_KEY', 'no query recorded; run exec first');
  const lines = [];
  lines.push(`from: ${q.from}`);
  for (const j of q.joins ?? []) {
    lines.push(`join: ${j.type} ${j.table} on ${j.on.map(([l, r]) => `${l} = ${r}`).join(' and ')}`);
  }
  for (const w of q.where ?? []) lines.push(`where: ${w.col} ${w.op} ${JSON.stringify(w.value)}`);
  if (q.groupby?.length) lines.push(`groupby: ${q.groupby.join(', ')}`);
  for (const a of q.aggregates ?? []) lines.push(`aggregate: ${a.fn}(${a.col})${a.as ? ` as ${a.as}` : ''}`);
  if (q.select?.length) lines.push(`select: ${q.select.join(', ')}`);
  const entries = Object.entries(state.outputs);
  const partialKeys = entries.filter(([, o]) => o.provenance === 'partial').map(([k]) => k);
  lines.push(`outputs: ${entries.length} (partial: ${partialKeys.length})`);
  lines.push(`indexed inputs: ${Object.keys(state.inputIndex).length}`);
  lines.push(`epochs: data=${state.dataEpoch} exec=${state.execEpoch}; corrections logged: ${state.corrections.length}`);
  if (partialKeys.length) lines.push(`partial outputs: ${partialKeys.join(', ')}`);
  const [outKey] = pos;
  if (outKey) {
    if (!state.outputs[outKey]) throw new ProvError('E_KEY', `unknown output key '${outKey}'`);
    const proof = store.readProof(outKey);
    lines.push(`lineage of ${outKey} [${proof.provenance}]:`);
    for (const c of proof.contributions) lines.push(`  ${c.table} ${JSON.stringify(c.key)} rowHash=${c.rowHash.slice(0, 12)}`);
    lines.push(`  minimal witness set: ${proof.minimal.map((c) => `${c.table} ${JSON.stringify(c.key)}`).join(', ')}`);
  }
  ctx.stdout(lines.join('\n'));
}

// Programmatic entry: returns { code, stdout, stderr } so tests can drive the
// CLI in-process. The real process wrapper below maps this to exit codes.
export function runCli(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const out = [];
  const err = [];
  const ctx = { cwd, env, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  try {
    const [cmd, ...rest] = argv;
    const { pos, flags } = parseArgs(rest);
    switch (cmd) {
      case 'exec': cmdExec(pos, ctx); break;
      case 'prove': cmdProve(pos, flags, ctx); break;
      case 'correct': cmdCorrect(pos, flags, ctx); break;
      case 'reverify': cmdReverify(pos, flags, ctx); break;
      case 'explain': cmdExplain(pos, flags, ctx); break;
      case undefined:
      case 'help':
      case '--help':
        ctx.stdout(USAGE);
        break;
      default:
        throw new UsageError(`unknown command '${cmd}'`);
    }
    return { code: 0, stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: '' };
  } catch (e) {
    if (e instanceof ProvError) {
      ctx.stderr(`error: ${e.code}: ${e.message}`);
      return { code: EXIT_CODES[e.code] ?? 1, stdout: out.join('\n'), stderr: err.join('\n') + '\n' };
    }
    if (e instanceof UsageError) {
      ctx.stderr(`usage error: ${e.message}\n${USAGE}`);
      return { code: 64, stdout: out.join('\n'), stderr: err.join('\n') + '\n' };
    }
    throw e;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
