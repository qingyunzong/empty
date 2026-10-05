#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, writeSync } from 'node:fs';
import { Store, parseJSONL, NegativeCountError } from './crdt.js';
import { computeOee, partitionBySkew, HoldInFinalStateError, DEFAULT_MAX_SKEW_MS } from './oee.js';

export const EXIT_NEGATIVE_COUNT = 10;
export const EXIT_HOLD_IN_FINAL = 11;

const USAGE = `Usage: oee-merge <command> [args]

Commands:
  ingest <store.jsonl> [--file events.jsonl] [--max-skew-ms N] [--now ISO]
      Validate JSONL events (file or stdin) and append to the store.
      Events outside the bounded clock-skew window go to <store>.hold.jsonl.
      Exit ${EXIT_NEGATIVE_COUNT} on negative count deltas.
  merge <out.jsonl> <in1.jsonl> <in2.jsonl> [...] [--digest]
      Anti-entropy merge: union events by id, write canonical JSONL.
      --digest prints per-input digests and the ids each input was missing.
  oee <store.jsonl> [--planned N] [--rate N] [--shift-start ISO] [--shift-end ISO] [--allow-pending]
      Compute OEE from the merged store. Exit ${EXIT_HOLD_IN_FINAL} if the hold
      file has pending events (unless --allow-pending, which excludes them).
  hold <store.jsonl>
      List pending held events for a store.
`;

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags.set(arg.slice(2), argv[i + 1]);
        i += 1;
      } else {
        flags.set(arg.slice(2), true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function readEvents(source) {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  return parseJSONL(text);
}

function loadStore(path) {
  if (!existsSync(path)) return new Store();
  return new Store(parseJSONL(readFileSync(path, 'utf8')));
}

function holdPath(storePath) {
  return `${storePath}.hold.jsonl`;
}

function out(text) {
  writeSync(1, text);
}

function err(text) {
  writeSync(2, text);
}

function loadHeld(storePath) {
  const path = holdPath(storePath);
  if (!existsSync(path)) return [];
  return parseJSONL(readFileSync(path, 'utf8'));
}

function cmdIngest({ positional, flags }) {
  const [storePath] = positional;
  if (!storePath) throw new Error('ingest requires a store path');
  const source = flags.get('file') ?? '-';
  const maxSkewMs = flags.has('max-skew-ms') ? Number(flags.get('max-skew-ms')) : DEFAULT_MAX_SKEW_MS;
  const now = flags.has('now') ? Date.parse(flags.get('now')) : Date.now();

  const events = readEvents(source); // validation (incl. negative counts) happens here
  const { accepted, held } = partitionBySkew(events, { now, maxSkewMs });

  const store = loadStore(storePath);
  for (const event of accepted) store.add(event);
  writeFileSync(storePath, store.toJSONL());

  if (held.length > 0) {
    const existing = loadHeld(storePath);
    const heldStore = new Store(existing);
    for (const event of held) heldStore.add(event);
    writeFileSync(holdPath(storePath), heldStore.toJSONL());
  }

  out(JSON.stringify({ ingested: accepted.length, held: held.length }) + '\n');
  return 0;
}

function cmdMerge({ positional, flags }) {
  const [outPath, ...inputs] = positional;
  if (!outPath || inputs.length === 0) throw new Error('merge requires an output path and at least one input');

  const stores = inputs.map((input) => new Store(readEvents(input)));
  const merged = Store.mergeAll(stores);
  writeFileSync(outPath, merged.toJSONL());

  if (flags.has('digest')) {
    const report = {
      merged: merged.digest(),
      inputs: inputs.map((input, i) => ({
        file: input,
        ...stores[i].digest(),
        missing: merged.missingFrom(stores[i]),
      })),
    };
    out(JSON.stringify(report, null, 2) + '\n');
  } else {
    out(JSON.stringify({ merged: merged.digest(), out: outPath }) + '\n');
  }
  return 0;
}

function cmdOee({ positional, flags }) {
  const [storePath] = positional;
  if (!storePath) throw new Error('oee requires a store path');
  const store = loadStore(storePath);
  const pending = loadHeld(storePath);

  const result = computeOee(store, {
    plannedMinutes: flags.has('planned') ? Number(flags.get('planned')) : 480,
    idealRatePerMin: flags.has('rate') ? Number(flags.get('rate')) : 1,
    shiftStart: flags.get('shift-start') ?? null,
    shiftEnd: flags.get('shift-end') ?? null,
    pending,
    allowPending: flags.has('allow-pending'),
  });
  out(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

function cmdHold({ positional }) {
  const [storePath] = positional;
  if (!storePath) throw new Error('hold requires a store path');
  const pending = loadHeld(storePath);
  out(JSON.stringify({ pending }, null, 2) + '\n');
  return pending.length === 0 ? 0 : EXIT_HOLD_IN_FINAL;
}

export function run(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'ingest':
      return cmdIngest(args);
    case 'merge':
      return cmdMerge(args);
    case 'oee':
      return cmdOee(args);
    case 'hold':
      return cmdHold(args);
    default:
      err(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
}

function main() {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof NegativeCountError) {
      err(`${error.message}\n`);
      process.exitCode = EXIT_NEGATIVE_COUNT;
    } else if (error instanceof HoldInFinalStateError) {
      err(`${error.message}\n`);
      err(`pending: ${JSON.stringify(error.pending.map((e) => e.id))}\n`);
      process.exitCode = EXIT_HOLD_IN_FINAL;
    } else {
      err(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
