import {readFileSync} from 'node:fs';
import {writeSync} from 'node:fs';
import {CalError} from './errors.js';
import {Store, applyEvent} from './store.js';
import {stable} from './util.js';

function printOut(line) {
  writeSync(1, line);
}

function printErr(line) {
  writeSync(2, line);
}

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      opts[a.slice(2)] = argv[i + 1];
      i++;
    } else {
      pos.push(a);
    }
  }
  return {pos, opts};
}

const USAGE = 'usage: calplan <ingest|plan|correct|fail|restore> [args] [--state DIR]';

export function run(argv) {
  try {
    const {pos, opts} = parseArgs(argv);
    const cmd = pos[0];
    const store = new Store(opts.state || process.env.CALPLAN_STATE || './.calplan');
    let out;
    if (cmd === 'ingest') {
      const file = pos[1];
      if (!file) throw new CalError('usage', 'ingest <scenario.json> [--state DIR]', 2);
      const scenario = JSON.parse(readFileSync(file, 'utf8'));
      const ev = {seq: 1, cmd: 'ingest', input: scenario};
      const {state, result} = applyEvent(null, ev);
      store.resetLog(ev);
      store.save(state);
      out = {seq: ev.seq, ...result};
    } else if (cmd === 'plan' || cmd === 'correct' || cmd === 'fail' || cmd === 'restore') {
      const onDisk = store.loadState();
      let state = onDisk || store.replay();
      if (!state) throw new CalError('no-state', 'no state found; run ingest first', 2);
      let recovered = false;
      if (cmd === 'restore') {
        const rebuilt = store.replay();
        if (!rebuilt) throw new CalError('no-state', 'no event log found', 2);
        if (!onDisk || stable(onDisk) !== stable(rebuilt)) recovered = true;
        state = rebuilt;
      }
      const seq = state.seq + 1;
      let ev;
      if (cmd === 'plan') {
        ev = {seq, cmd, input: {}};
      } else if (cmd === 'correct') {
        const file = pos[1];
        if (!file) throw new CalError('usage', 'correct <patch.json> [--state DIR]', 2);
        ev = {seq, cmd, input: JSON.parse(readFileSync(file, 'utf8'))};
      } else if (cmd === 'fail') {
        const input = {station: opts.station, from: Number(opts.from), to: Number(opts.to)};
        if (!input.station || !(input.from < input.to)) {
          throw new CalError('usage', 'fail --station S --from A --to B', 2);
        }
        ev = {seq, cmd, input};
      } else {
        if (!opts.failure) throw new CalError('usage', 'restore --failure ID', 2);
        ev = {seq, cmd, input: {failure: opts.failure}};
      }
      const applied = applyEvent(state, ev);
      store.record(ev);
      store.save(applied.state);
      out = {seq, ...applied.result};
      if (cmd === 'restore') out.recovered = recovered;
    } else {
      throw new CalError('usage', USAGE, 2);
    }
    printOut(JSON.stringify(out, null, 2) + '\n');
  } catch (e) {
    if (e instanceof CalError) {
      printErr(JSON.stringify({error: e.code, message: e.message}) + '\n');
      process.exit(e.exitCode);
    }
    printErr(String((e && e.stack) || e) + '\n');
    process.exit(1);
  }
}
