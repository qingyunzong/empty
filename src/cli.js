#!/usr/bin/env node
// CLI for the hierarchical settlement ledger.
// Commands: create, prepare, commit, cancel, get, crash --after-prepare ID
// Success: JSON on stdout, exit 0. Errors: JSON on stderr, non-zero exit.
// The logic lives in run(argv, io) so it can be driven in-process by tests;
// the process entry point is a thin wrapper at the bottom.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ledger } from './ledger.js';
import { ModelError } from './model.js';

const USAGE = `usage: settle [--data DIR] <command> [args]
  create --id ID --budget N [--parent ID]   create a group (root if no parent)
  prepare ID                                OPEN -> PREPARED
  commit ID                                 PREPARED -> SETTLED (WAL 2PC)
  cancel ID                                 revoke group; cascades to non-SETTLED descendants
  get [ID]                                  show one group or all groups
  crash --after-prepare ID                  simulate crash mid-commit (after WAL PREPARE)`;

const defaultIo = {
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
};

// Returns the process exit code.
export function run(argv, io = defaultIo) {
  const fail = (code, message, exitCode = 1) => {
    io.stderr(JSON.stringify({ error: { code, message } }));
    return exitCode;
  };
  const ok = (payload) => {
    io.stdout(JSON.stringify({ ok: true, ...payload }));
    return 0;
  };

  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        data: { type: 'string' },
        id: { type: 'string' },
        parent: { type: 'string' },
        budget: { type: 'string' },
        'after-prepare': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    return fail('USAGE', err.message);
  }

  const cmd = positionals[0];
  if (values.help || !cmd) return fail('USAGE', USAGE);
  const dir = values.data ?? process.env.SETTLE_DATA_DIR ?? '.settle';

  try {
    const ledger = Ledger.open(dir);
    switch (cmd) {
      case 'create': {
        if (!values.id) return fail('USAGE', 'create requires --id');
        const amount = Number(values.budget);
        if (!values.budget || !Number.isFinite(amount)) return fail('USAGE', 'create requires --budget N');
        const group = ledger.createGroup({ id: values.id, parentId: values.parent ?? null, amount });
        return ok({ group: ledger.get(group.id) });
      }
      case 'prepare': {
        const id = positionals[1];
        if (!id) return fail('USAGE', 'prepare requires ID');
        ledger.prepare(id);
        return ok({ group: ledger.get(id) });
      }
      case 'commit': {
        const id = positionals[1];
        if (!id) return fail('USAGE', 'commit requires ID');
        return ok({ group: ledger.commit(id) });
      }
      case 'cancel': {
        const id = positionals[1];
        if (!id) return fail('USAGE', 'cancel requires ID');
        // PARTIAL is a successful outcome (blocked by SETTLED descendants),
        // not an overall failure: exit 0 with the blocking reasons listed.
        return ok({ result: ledger.cancel(id) });
      }
      case 'get': {
        const id = positionals[1];
        return id ? ok({ group: ledger.get(id) }) : ok({ groups: ledger.list() });
      }
      case 'crash': {
        const id = values['after-prepare'];
        if (!id) return fail('USAGE', 'crash requires --after-prepare ID');
        ledger.beginCommit(id); // WAL PREPARE written, mutation applied, no COMMIT
        io.stderr(JSON.stringify({ crashed: true, point: 'after-prepare', id }));
        return 70; // simulated crash: non-zero, no cleanup, no COMMIT
      }
      default:
        return fail('USAGE', `unknown command "${cmd}"\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof ModelError) return fail(err.code, err.message);
    throw err;
  }
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (invokedAsScript) {
  process.exitCode = run(process.argv.slice(2));
}
