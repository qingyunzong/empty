import fs from 'node:fs';
import { GateError } from './expr.js';
import { Store } from './store.js';
import { Engine } from './gate.js';

export const EXIT = { E_RULE: 2, E_WINDOW: 3, E_UNDECIDED_BLOCK: 4, E_EXEMPT: 5, E_INPUT: 6 };

const USAGE = `usage:
  gate init <rules.json> [--force]   initialize gate home from a rules config
  gate obs <observations.jsonl>      ingest observations (one JSON object per line)
  gate correct <key> <patch-json>    correct an observation ({"ts":..., "metrics":{...}})
  gate decide <key>                  evaluate gates for one observation, print certificate
  gate replay <from> <to>            rebuild from the event log and re-decide ts in [from,to]

state directory: GATE_HOME env var (default: ./.gate)
exit codes: 0 pass/ok, 1 fail/inconsistent, 2 E_RULE, 3 E_WINDOW,
            4 E_UNDECIDED_BLOCK, 5 E_EXEMPT, 6 E_INPUT, 64 usage`;

function parseJson(text, code, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new GateError(code, `invalid JSON in ${what}: ${e.message}`);
  }
}

function readFile(file, code) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new GateError(code, `cannot read ${file}: ${e.message}`);
  }
}

function execute(argv, home, emit) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'init': {
      const file = args[0];
      if (!file) throw new GateError('E_INPUT', 'init requires <rules.json>');
      const config = parseJson(readFile(file, 'E_INPUT'), 'E_RULE', file);
      const store = Store.init(home, config, { force: args.includes('--force') });
      emit.out({ ok: true, home, rulesHash: store.rules.rulesHash });
      return 0;
    }
    case 'obs': {
      const file = args[0];
      if (!file) throw new GateError('E_INPUT', 'obs requires <observations.jsonl>');
      const store = Store.open(home);
      const lines = readFile(file, 'E_INPUT')
        .split('\n')
        .filter((l) => l.trim());
      let ingested = 0;
      for (const line of lines) {
        store.addObs(parseJson(line, 'E_INPUT', 'observations'));
        ingested++;
      }
      store.save();
      emit.out({ ok: true, ingested, seq: store.state.seq });
      return 0;
    }
    case 'correct': {
      const [key, patchText] = args;
      if (!key || patchText === undefined) {
        throw new GateError('E_INPUT', 'correct requires <key> <patch-json>');
      }
      const store = Store.open(home);
      const observation = store.correct(key, parseJson(patchText, 'E_INPUT', 'patch'));
      store.save();
      emit.out({ ok: true, observation, seq: store.state.seq });
      return 0;
    }
    case 'decide': {
      const key = args[0];
      if (!key) throw new GateError('E_INPUT', 'decide requires <key>');
      const store = Store.open(home);
      const cert = new Engine(store).decide(key);
      store.save();
      emit.out(cert);
      if (cert.decision === 'undecided') {
        emit.err('E_UNDECIDED_BLOCK', `decision for '${key}' is undecided: automatic admission blocked (not a violation)`);
        return EXIT.E_UNDECIDED_BLOCK;
      }
      return cert.decision === 'pass' ? 0 : 1;
    }
    case 'replay': {
      const from = Number(args[0]);
      const to = Number(args[1]);
      if (args.length < 2 || !Number.isFinite(from) || !Number.isFinite(to) || from > to) {
        throw new GateError('E_INPUT', 'replay requires <from> <to> (numeric ts range, from <= to)');
      }
      const live = Store.open(home);
      const fresh = Store.rebuild(home);
      const engLive = new Engine(live);
      const engFresh = new Engine(fresh);
      const keys = fresh.state.order.filter((k) => {
        const ts = fresh.state.observations[k].ts;
        return ts >= from && ts <= to;
      });
      const decisions = { pass: 0, fail: 0, undecided: 0 };
      let consistent = true;
      for (const k of keys) {
        const cFresh = engFresh.decide(k);
        const cLive = engLive.decide(k);
        const same = JSON.stringify(cFresh) === JSON.stringify(cLive);
        if (!same) consistent = false;
        decisions[cFresh.decision]++;
        emit.out({ ...cFresh, consistent: same });
      }
      live.save();
      emit.out({ type: 'summary', from, to, count: keys.length, decisions, consistent });
      return consistent ? 0 : 1;
    }
    default:
      emit.raw(`${USAGE}\n`);
      return 64;
  }
}

export function run(argv, { home } = {}) {
  const result = { code: 0, stdout: '', stderr: '' };
  const emit = {
    out: (value) => {
      result.stdout += `${JSON.stringify(value)}\n`;
    },
    err: (code, message) => {
      result.stderr += `${JSON.stringify({ error: { code, message } })}\n`;
    },
    raw: (text) => {
      result.stderr += text;
    },
  };
  try {
    result.code = execute(argv, home ?? process.env.GATE_HOME ?? '.gate', emit);
  } catch (e) {
    if (e instanceof GateError) {
      emit.err(e.code, e.message);
      result.code = EXIT[e.code] ?? 1;
    } else {
      emit.err('E_INTERNAL', e?.message ?? String(e));
      result.code = 1;
    }
  }
  return result;
}
