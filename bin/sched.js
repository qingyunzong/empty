#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initStore, openStore, commit, undo, redo, verify } from '../src/log.js';
import { computeSchedule } from '../src/schedule.js';
import { stateHash } from '../src/state.js';
import { SchedError, EXIT_CODES } from '../src/errors.js';

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

const USAGE = `usage: sched <command> <dir> [flags]
  init <dir> [--snapshot-every N]
  add-machine <dir> --id M1 --calendar '[[0,100]]'
  add-order <dir> --id W1 --priority 2 --ops '[{"id":"a","machine":"M1","duration":5,"family":"A","preds":[]}]'
  remove-order <dir> --id W1
  set-setup <dir> --machine M1 --from A --to B --time 4
  schedule <dir> [--budget N]
  undo <dir>
  redo <dir>
  status <dir>
  verify <dir>`;

export function run(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const [cmd, dir, ...rest] = argv;
  if (!cmd || cmd === 'help') {
    io.out(USAGE);
    return 0;
  }
  const { flags } = parseFlags(rest);
  switch (cmd) {
    case 'init': {
      initStore(dir, { snapshotEvery: flags['snapshot-every'] ? Number(flags['snapshot-every']) : undefined });
      io.out(JSON.stringify({ ok: true, dir }));
      break;
    }
    case 'add-machine': {
      const rec = commit(dir, [
        { type: 'addMachine', machine: { id: flags.id, calendar: JSON.parse(flags.calendar) } },
      ]);
      io.out(JSON.stringify({ ok: true, seq: rec.seq }));
      break;
    }
    case 'add-order': {
      const rec = commit(dir, [
        {
          type: 'addOrder',
          order: {
            id: flags.id,
            priority: flags.priority !== undefined ? Number(flags.priority) : 1,
            ops: JSON.parse(flags.ops),
          },
        },
      ]);
      io.out(JSON.stringify({ ok: true, seq: rec.seq }));
      break;
    }
    case 'remove-order': {
      const rec = commit(dir, [{ type: 'removeOrder', id: flags.id }]);
      io.out(JSON.stringify({ ok: true, seq: rec.seq }));
      break;
    }
    case 'set-setup': {
      const rec = commit(dir, [
        {
          type: 'setSetup',
          machine: flags.machine,
          from: flags.from,
          to: flags.to,
          time: Number(flags.time),
        },
      ]);
      io.out(JSON.stringify({ ok: true, seq: rec.seq }));
      break;
    }
    case 'schedule': {
      const store = openStore(dir);
      const budget = flags.budget !== undefined ? Number(flags.budget) : undefined;
      const solution = computeSchedule(store.state, { budget });
      const rec = commit(dir, [{ type: 'setSchedule', schedule: solution }]);
      io.out(JSON.stringify({ ok: true, seq: rec.seq, schedule: solution }));
      break;
    }
    case 'undo': {
      const rec = undo(dir);
      io.out(JSON.stringify({ ok: true, seq: rec.seq, undoes: rec.target }));
      break;
    }
    case 'redo': {
      const rec = redo(dir);
      io.out(JSON.stringify({ ok: true, seq: rec.seq, redoes: rec.target }));
      break;
    }
    case 'status': {
      const store = openStore(dir);
      io.out(
        JSON.stringify({
          ok: true,
          seq: store.seq,
          records: store.records.length,
          stateHash: stateHash(store.state),
          chainHash: store.chainHash,
        })
      );
      break;
    }
    case 'verify': {
      io.out(JSON.stringify(verify(dir)));
      break;
    }
    default:
      throw new SchedError('E_USAGE', `unknown command ${cmd}\n${USAGE}`);
  }
  return 0;
}

export function main(argv, io) {
  try {
    return run(argv, io);
  } catch (err) {
    if (err instanceof SchedError) {
      (io?.err ?? console.error)(`${err.code}: ${err.message}`);
      return EXIT_CODES[err.code] ?? 1;
    }
    (io?.err ?? console.error)(`E_INTERNAL: ${err.message}`);
    return 1;
  }
}

const invokedAs =
  process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
if (invokedAs) {
  process.exitCode = main(process.argv.slice(2));
}
