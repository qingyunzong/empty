import { appendEvents, findEvents, verify, rebuild, stateView, stateOfFile, BizError } from './store.js';

function parseFlags(argv) {
  const flags = { event: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event') flags.event.push(argv[++i]);
    else if (a === '--tx') flags.tx = argv[++i];
    else if (a === '--account') flags.account = argv[++i];
    else throw new BizError(`unknown flag ${a}`);
  }
  return flags;
}

function dispatch(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || !file) {
    throw new BizError('usage: cli.js <append|audit|find|cancel|quarantine|rebuild> <file> [--event JSON]* [--tx T] [--account A]');
  }
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'append': {
      const events = flags.event.map((s) => {
        try { return JSON.parse(s); } catch { throw new BizError(`invalid event JSON: ${s}`); }
      });
      return { out: { ok: true, chunk: appendEvents(file, events) }, code: 0 };
    }
    case 'audit': {
      const { scan, state, quarantined, pending } = verify(file);
      const ok = quarantined.length === 0 && pending.length === 0;
      return {
        out: {
          ok,
          chunks: {
            confirmed: scan.chunks.filter((c) => c.status === 'confirmed').map((c) => ({ index: c.index, offset: c.offset, end: c.end, events: c.eventCount })),
            quarantined,
            pending,
          },
          state: stateView(state),
        },
        code: ok ? 0 : 2,
      };
    }
    case 'find': {
      if (flags.tx == null && flags.account == null) throw new BizError('find requires --tx or --account');
      return { out: { ok: true, matches: findEvents(file, { tx: flags.tx, account: flags.account }) }, code: 0 };
    }
    case 'cancel': {
      if (flags.tx == null) throw new BizError('cancel requires --tx');
      const state = stateOfFile(file);
      const orig = state.txIndex[flags.tx];
      if (!orig) throw new BizError(`unknown tx ${flags.tx}`);
      const event = { type: 'cancel', tx: `cancel:${flags.tx}`, ref: flags.tx, account: orig.event.account };
      const chunk = appendEvents(file, [event]);
      return { out: { ok: true, event, chunk }, code: 0 };
    }
    case 'quarantine': {
      const { quarantined, pending } = verify(file);
      const ok = quarantined.length === 0 && pending.length === 0;
      return { out: { ok, quarantined, pending }, code: ok ? 0 : 2 };
    }
    case 'rebuild': {
      const result = rebuild(file);
      const ok = result.quarantined.length === 0 && result.pending.length === 0;
      return { out: { ok, ...result }, code: ok ? 0 : 2 };
    }
    default:
      throw new BizError(`unknown command ${cmd}`);
  }
}

export function runCommand(argv) {
  try {
    return dispatch(argv);
  } catch (e) {
    const code = e.exitCode ?? 1;
    return { out: { ok: false, error: { message: e.message, code } }, code };
  }
}
