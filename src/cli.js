import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { ReconError } from './errors.js';
import { RepairEngine } from './engine.js';
import { Journal } from './journal.js';
import { classifyDiffs } from './diff.js';

function readJson(path, what) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ReconError('BAD_DIFF', `cannot read ${what} from ${path}: ${err.message}`);
  }
}

const USAGE = `usage:
  recon reconcile --ledger L.json --snapshot S.json [options]
  recon diff      --ledger L.json --snapshot S.json

options:
  --slots N         worker slots (default 1)
  --quota N         per-merchant running quota (default unlimited)
  --seal A@DAY      seal a conflict domain (repeatable)
  --journal PATH    plan/commit journal file
  --recover PATH    replay a journal before reconciling (idempotent)
  --undo TASK_ID    undo an applied repair after reconciling (byte-exact restore)
  --out PATH        write final snapshot bytes to PATH
`;

export function run(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...rest] = argv;
  if (command !== 'reconcile' && command !== 'diff') {
    stderr.write(USAGE);
    return 2;
  }
  let args;
  try {
    args = parseArgs({
      args: rest,
      options: {
        ledger: { type: 'string' },
        snapshot: { type: 'string' },
        slots: { type: 'string', default: '1' },
        quota: { type: 'string' },
        seal: { type: 'string', multiple: true, default: [] },
        journal: { type: 'string' },
        recover: { type: 'string' },
        undo: { type: 'string' },
        out: { type: 'string' },
      },
    });
  } catch (err) {
    stderr.write(`error: ${err.message}\n${USAGE}`);
    return 2;
  }
  const { ledger: ledgerPath, snapshot: snapshotPath } = args.values;
  if (!ledgerPath || !snapshotPath) {
    stderr.write(`error: --ledger and --snapshot are required\n${USAGE}`);
    return 2;
  }

  try {
    const ledger = readJson(ledgerPath, 'ledger');
    const snapshot = readJson(snapshotPath, 'snapshot');

    if (command === 'diff') {
      stdout.write(JSON.stringify({ diffs: classifyDiffs(ledger, snapshot) }, null, 2) + '\n');
      return 0;
    }

    const slots = Number.parseInt(args.values.slots, 10);
    const quota = args.values.quota === undefined ? Infinity : Number.parseInt(args.values.quota, 10);
    if (!Number.isInteger(slots) || slots < 0) throw new ReconError('NO_SLOT', `--slots must be a non-negative integer`);
    const journal = args.values.journal ? new Journal(args.values.journal) : null;
    const engine = new RepairEngine({ ledger, snapshot, slots, merchantQuota: quota, journal });

    if (args.values.recover) engine.recoverFromJournal(args.values.recover);
    for (const sealSpec of args.values.seal) {
      const at = sealSpec.lastIndexOf('@');
      if (at <= 0) throw new ReconError('BAD_DIFF', `--seal expects account@YYYY-MM-DD, got ${sealSpec}`);
      engine.seal(sealSpec.slice(0, at), sealSpec.slice(at + 1));
    }

    const result = engine.reconcile();

    if (args.values.undo) {
      const { undone } = engine.undo(args.values.undo);
      result.undone = undone;
      result.auditRoot = engine.audit.auditRoot;
    }
    if (args.values.out) fs.writeFileSync(args.values.out, engine.snapshotBytes());

    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof ReconError) {
      stderr.write(JSON.stringify({ error: err.code, message: err.message }) + '\n');
      return 1;
    }
    throw err;
  }
}
