#!/usr/bin/env node
// qc — offline quality closed-loop CLI.
// Commands: open | rework | inspect | correct | close | scrap | undo | crash-recover | verify | state
// Exit codes: 0 ok | 1 domain error | 2 simulated crash | 21 undo after closed loop
//             22 WAL checksum failure | 23 state hash mismatch before/after recovery
import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Store, readWal, SimulatedCrash } from './store.js';
import { DomainError } from './machine.js';
import { canonicalHash } from './hash.js';

function parseArgv(argv, env) {
  let dir = env.QC_DATA_DIR || './qc-data';
  const args = [...argv];
  const i = args.indexOf('--dir');
  if (i >= 0) { dir = args[i + 1]; args.splice(i, 2); }
  return { dir, cmd: args[0], rest: args.slice(1) };
}

const USAGE = `usage:
  qc open <defectId> [desc...]            open a defect
  qc rework <orderId> <defectId...>       merge defects into a rework order
  qc inspect <orderId> <seq> <pass|fail>  record re-inspection of a sequence
  qc correct <orderId> <seq> <pass|fail>  correct a re-inspection (incremental impact set)
  qc close <orderId>                      close a rework order (all sequences must pass)
  qc scrap <defectId>                     scrap a defect (tombstone, terminal)
  qc undo <walSeq>                        undo an op (only non-closed-loop nodes; audited)
  qc crash-recover                        recover from crash (replay WAL / ignore half snapshot / rebuild index)
  qc verify                               verify WAL checksums and state hash consistency
  qc state                                dump current state JSON
options: --dir <dataDir> (or QC_DATA_DIR); fault injection: QC_CRASH_AT=wal-append|snapshot-rename|index-update`;

export function main(argv, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  const { dir, cmd, rest } = parseArgv(argv, env);
  const store = new Store(dir, { crashAt: env.QC_CRASH_AT || null, crashMode: 'throw' });
  const ok = (obj) => stdout(JSON.stringify({ ok: true, ...obj }));

  try {
    switch (cmd) {
      case 'open': {
        const [id, ...words] = rest;
        if (!id) throw new DomainError('open needs a defect id');
        const rec = store.apply('open', { id, desc: words.join(' ') });
        ok({ seq: rec.seq });
        return 0;
      }
      case 'rework': {
        const [orderId, ...defectIds] = rest;
        if (!orderId || defectIds.length === 0) throw new DomainError('rework needs an order id and defect ids');
        const rec = store.apply('rework', { orderId, defectIds });
        ok({ seq: rec.seq });
        return 0;
      }
      case 'inspect':
      case 'correct': {
        const [orderId, seq, result] = rest;
        if (!orderId || seq === undefined || !result) throw new DomainError(`${cmd} needs orderId, seq, result`);
        const rec = store.apply(cmd, { orderId, seq: Number(seq), result });
        ok({ seq: rec.seq });
        return 0;
      }
      case 'close': {
        if (!rest[0]) throw new DomainError('close needs an order id');
        const rec = store.apply('close', { orderId: rest[0] });
        ok({ seq: rec.seq });
        return 0;
      }
      case 'scrap': {
        if (!rest[0]) throw new DomainError('scrap needs a defect id');
        const rec = store.apply('scrap', { id: rest[0] });
        ok({ seq: rec.seq });
        return 0;
      }
      case 'undo': {
        const seq = Number(rest[0]);
        if (!Number.isInteger(seq)) throw new DomainError('undo needs a WAL seq');
        const target = readWal(store.walFile).find((r) => r.seq === seq);
        if (!target) throw new DomainError(`no WAL record with seq=${seq}`);
        const rec = store.apply('undo', { undoOf: seq, target: { op: target.op, args: target.args } });
        ok({ seq: rec.seq });
        return 0;
      }
      case 'crash-recover': {
        const res = store.recover();
        store.persistRecovered(res);
        ok({ recovery: res.report, hash: canonicalHash(res.state) });
        return 0;
      }
      case 'verify': {
        const res = store.recover();
        const hash = store.checkConsistency(res.state);
        ok({ hash, index: res.index });
        return 0;
      }
      case 'state': {
        stdout(JSON.stringify(store.recover().state, null, 2));
        return 0;
      }
      default:
        stderr(USAGE);
        return cmd ? 64 : 0;
    }
  } catch (err) {
    if (err instanceof SimulatedCrash) {
      stderr(`crash: simulated crash at fault point '${err.point}'`);
      return 2;
    }
    stderr(`error: ${err.message}`);
    return err.code ?? 1;
  }
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invokedAsScript) {
  process.exit(main(process.argv.slice(2)));
}
