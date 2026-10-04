#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Store } from '../src/store.js';
import { WipError } from '../src/errors.js';

// Exit codes: 2 = usage/validation, 3 = state conflict, 10 = verify failure.

const COMMANDS = {
  begin: {
    options: { session: { type: 'string' } },
    need: ['session'],
  },
  scan: {
    options: {
      session: { type: 'string' },
      bin: { type: 'string' },
      item: { type: 'string' },
      qty: { type: 'string' },
    },
    need: ['session', 'bin', 'item', 'qty'],
  },
  sync: {
    options: { peer: { type: 'string' } },
    need: ['peer'],
  },
  resume: {
    options: {},
    need: [],
  },
  close: {
    options: { session: { type: 'string' } },
    need: ['session'],
  },
  verify: {
    options: { peer: { type: 'string' } },
    need: [],
  },
};

function emitError(code, message, exitCode) {
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(exitCode);
}

function usage(message) {
  emitError('USAGE', `${message}; commands: ${Object.keys(COMMANDS).join('|')}`, 2);
}

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const spec = COMMANDS[command];
  if (!spec) usage(`unknown command ${JSON.stringify(command ?? '(none)')}`);

  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        data: { type: 'string' },
        node: { type: 'string' },
        ...spec.options,
      },
    }));
  } catch (err) {
    usage(err.message);
  }
  for (const name of spec.need) {
    if (!values[name]) usage(`missing --${name}`);
  }

  const data = values.data || process.env.WIP_COUNT_DIR || './.wipcount';
  const store = await Store.open(data, { nodeId: values.node });
  await store.resume();

  switch (command) {
    case 'begin':
      out({ ok: true, session: await store.begin(values.session) });
      break;
    case 'scan':
      out({
        ok: true,
        session: await store.scan(values.session, values.bin, values.item, Number(values.qty)),
      });
      break;
    case 'close':
      out({ ok: true, session: await store.close(values.session) });
      break;
    case 'resume':
      out({ ok: true, resumed: true });
      break;
    case 'sync':
      out({ ok: true, ...(await store.sync(values.peer)) });
      break;
    case 'verify': {
      const report = await store.verify(values.peer);
      out(report);
      if (!report.ok) process.exit(10);
      break;
    }
  }
}

main().catch((err) => {
  if (err instanceof WipError) {
    emitError(err.code, err.message, err.exitCode);
  }
  emitError('INTERNAL', String((err && err.stack) || err), 1);
});
