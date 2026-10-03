// CLI: node src/cli.js <command> [options]
//   apply <ev.json> [--fail before_append|after_append] [--dir DIR]
//   query [--dir DIR]
// Success: JSON on stdout, exit 0. Failure: {"error":"..."} on stdout, exit 1.

import fs from 'node:fs';
import * as store from './store.js';
import { netRequirements } from './mrp.js';

function parseArgs(argv) {
  const positional = [];
  const opts = { dir: 'data', fail: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') {
      opts.dir = argv[++i];
    } else if (argv[i] === '--fail') {
      opts.fail = argv[++i];
      if (!['before_append', 'after_append'].includes(opts.fail)) {
        throw new Error(`unknown --fail mode: ${opts.fail}`);
      }
    } else if (argv[i].startsWith('--')) {
      throw new Error(`unknown option: ${argv[i]}`);
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

function readEvents(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.events)) return doc.events;
  if (doc && typeof doc === 'object') return [doc];
  throw new Error('event file must be an event, an array, or {"events":[...]}');
}

function cmdApply(positional, opts) {
  const file = positional[0];
  if (!file) throw new Error('usage: apply <ev.json> [--fail MODE] [--dir DIR]');
  const events = readEvents(file);
  const result = store.apply(opts.dir, events, { fail: opts.fail });
  return { ok: true, ...result };
}

function cmdQuery(opts) {
  const { state, version, entries, recovered } = store.recover(opts.dir);
  const { gross, inventory, net } = netRequirements(state);
  const prevNet = version > 0
    ? netRequirements(store.replayState(entries, version - 1)).net
    : {};
  return {
    version,
    recovered,
    gross,
    inventory,
    net,
    delta: store.netDeltas(prevNet, net),
    hash: store.logHash(opts.dir),
  };
}

// Programmatic entry: returns { code, output } without touching process.exit.
export function run(argv) {
  try {
    const { positional, opts } = parseArgs(argv);
    const command = positional[0];
    let out;
    if (command === 'apply') out = cmdApply(positional.slice(1), opts);
    else if (command === 'query') out = cmdQuery(opts);
    else throw new Error(`unknown command: ${command ?? '(none)'}`);
    return { code: 0, output: JSON.stringify(out, null, 2) + '\n' };
  } catch (err) {
    return { code: 1, output: JSON.stringify({ error: err.message }) + '\n' };
  }
}

const invokedAs = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedAs === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const { code, output } = run(process.argv.slice(2));
  process.stdout.write(output);
  if (code !== 0) process.exit(code);
}
