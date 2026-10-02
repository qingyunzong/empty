import { Store } from './store.js';
import { Journal } from './journal.js';
import { SchedError, CODES, err } from './errors.js';

export const EXIT = {
  [CODES.E_BUDGET]: 10,
  [CODES.E_PRECEDENCE]: 11,
  [CODES.E_CRC]: 12,
  [CODES.E_DIVERGED]: 13,
  [CODES.E_STATE]: 14,
  [CODES.E_USAGE]: 2,
  [CODES.E_IO]: 1,
};

function usage() {
  throw err(CODES.E_USAGE, [
    'usage: sched <command> <dir> [args]',
    '  init <dir>',
    '  machine add <dir> <id> --calendar "0-480,1440-1920"',
    '  machine rm <dir> <id>',
    '  order add <dir> <id> --product P --priority N --ops "M1:60,M2:30"',
    '  order rm <dir> <id>',
    '  changeover set <dir> <machine> <from> <to> <minutes>',
    '  dep add <dir> <opId> <beforeOpId>     (opId = ORDER:INDEX)',
    '  budget set <dir> <N|null>',
    '  schedule <dir>',
    '  undo <dir> | redo <dir>',
    '  snapshot <dir>',
    '  status <dir>',
    '  verify <dir>        (strict open; fails with E_CRC on any corruption)',
  ].join('\n'));
}

function parseFlags(args) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  return { pos, flags };
}

function parseCalendar(text) {
  if (!text) throw err(CODES.E_USAGE, '--calendar "start-end,..." required');
  return text.split(',').map((part) => {
    const [a, b] = part.trim().split('-').map(Number);
    return [a, b];
  });
}

function parseOps(text) {
  if (!text) throw err(CODES.E_USAGE, '--ops "MACHINE:DURATION,..." required');
  return text.split(',').map((part) => {
    const [machine, dur] = part.trim().split(':');
    return { machine, duration: Number(dur) };
  });
}

function openStore(dir, opts) {
  if (!Journal.exists(dir)) throw err(CODES.E_IO, `no journal in ${dir}; run 'sched init ${dir}' first`);
  return Store.open(dir, opts);
}

function dispatch(argv, print) {
  const [cmd, a1, ...rest] = argv;
  if (!cmd) usage();

  if (cmd === 'init') {
    const dir = a1;
    if (!dir) usage();
    Store.init(dir);
    print({ ok: true, dir });
    return;
  }

  const nouns = new Set(['machine', 'order', 'changeover', 'dep', 'budget']);
  // noun commands: sched <noun> <action> <dir> [args] [--flags]
  // verb commands: sched <verb> <dir>
  const dir = nouns.has(cmd) ? rest[0] : a1;
  const args = nouns.has(cmd) ? [a1, ...rest.slice(1)] : rest;
  const { pos, flags } = parseFlags(args);
  if (!dir) usage();

  switch (cmd) {
    case 'machine': {
      const store = openStore(dir);
      if (pos[0] === 'add') {
        store.commit([{ kind: 'setMachine', id: pos[1], machine: { id: pos[1], calendar: parseCalendar(flags.calendar) } }]);
      } else if (pos[0] === 'rm') {
        store.commit([{ kind: 'removeMachine', id: pos[1] }]);
      } else usage();
      print({ ok: true, seq: store.status().seq });
      return;
    }
    case 'order': {
      const store = openStore(dir);
      if (pos[0] === 'add') {
        const order = {
          id: pos[1],
          product: flags.product,
          priority: Number(flags.priority ?? 1),
          ops: parseOps(flags.ops),
        };
        store.commit([{ kind: 'setOrder', order }]);
      } else if (pos[0] === 'rm') {
        store.commit([{ kind: 'removeOrder', id: pos[1] }]);
      } else usage();
      print({ ok: true, seq: store.status().seq });
      return;
    }
    case 'changeover': {
      const store = openStore(dir);
      if (pos[0] !== 'set') usage();
      store.commit([{ kind: 'setChangeover', machine: pos[1], from: pos[2], to: pos[3], minutes: Number(pos[4]) }]);
      print({ ok: true, seq: store.status().seq });
      return;
    }
    case 'dep': {
      const store = openStore(dir);
      if (pos[0] !== 'add') usage();
      store.commit([{ kind: 'addDep', op: pos[1], before: pos[2] }]);
      print({ ok: true, seq: store.status().seq });
      return;
    }
    case 'budget': {
      const store = openStore(dir);
      if (pos[0] !== 'set') usage();
      const budget = pos[1] === 'null' ? null : Number(pos[1]);
      store.commit([{ kind: 'setBudget', budget }]);
      print({ ok: true, seq: store.status().seq });
      return;
    }
    case 'schedule': {
      const store = openStore(dir);
      const { solution } = store.schedule();
      print(solution);
      return;
    }
    case 'undo': {
      const store = openStore(dir);
      store.undo();
      print({ ok: true, seq: store.status().seq });
      return;
    }
    case 'redo': {
      const store = openStore(dir);
      store.redo();
      print({ ok: true, seq: store.status().seq });
      return;
    }
    case 'snapshot': {
      const store = openStore(dir);
      print(store.snapshot());
      return;
    }
    case 'status': {
      const store = openStore(dir);
      print(store.status());
      return;
    }
    case 'verify': {
      const store = openStore(dir, { strict: true });
      print({ ok: true, seq: store.status().seq, stateHash: store.status().stateHash });
      return;
    }
    default:
      usage();
  }
}

// Returns the process exit code; output goes to the provided writers.
export function runCli(argv, { stdout, stderr } = {}) {
  const out = stdout ?? ((s) => process.stdout.write(s));
  const errOut = stderr ?? ((s) => process.stderr.write(s));
  const print = (value) => out(JSON.stringify(value, null, 2) + '\n');
  try {
    dispatch(argv, print);
    return 0;
  } catch (e) {
    if (e instanceof SchedError) {
      errOut(`error: ${e.code}: ${e.message}\n`);
      return EXIT[e.code] ?? 1;
    }
    throw e;
  }
}
