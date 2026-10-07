import fs from 'node:fs';
import { compileSource } from './compile.js';
import { Engine } from './engine.js';

export function main(argv) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'apply') return cmdApply(args);
    if (cmd === 'replay') return cmdReplay(args);
    usage();
    return 1;
  } catch (e) {
    console.error(`error [${e.code || 'E_INTERNAL'}] ${e.message}`);
    return 1;
  }
}

function usage() {
  console.error('usage:');
  console.error('  quota apply <script.qta> <events.jsonl> --out <state.json>');
  console.error('  quota replay <state.json>');
}

function printBuckets(buckets) {
  for (const [name, b] of Object.entries(buckets)) {
    console.log(`bucket ${name}: available=${b.available} frozen=${b.frozen} used=${b.used} (limit=${b.limit})`);
  }
}

function cmdApply(args) {
  const outIdx = args.indexOf('--out');
  if (outIdx < 0 || outIdx + 1 >= args.length || outIdx !== 2) { usage(); return 1; }
  const [scriptPath, eventsPath] = args;
  const out = args[outIdx + 1];
  const src = fs.readFileSync(scriptPath, 'utf8');
  const policy = compileSource(src);
  const events = fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const eng = new Engine(policy);
  eng.applyAll(events);
  const state = { version: 1, customer: policy.customer, source: src, log: eng.log, final: eng.snapshot() };
  fs.writeFileSync(out, JSON.stringify(state, null, 2));
  const rejected = eng.log.filter((e) => !e.ok);
  console.log(`applied ${eng.log.length} events: ${eng.log.length - rejected.length} ok, ${rejected.length} rejected`);
  printBuckets(state.final.buckets);
  for (const e of rejected) console.log(`rejected ${e.event.id} [${e.error.code}] ${e.error.message}`);
  return 0;
}

function cmdReplay(args) {
  if (args.length !== 1) { usage(); return 1; }
  const st = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const policy = compileSource(st.source);
  const eng = new Engine(policy);
  eng.applyAll(st.log.map((l) => l.event));
  const replayed = eng.snapshot();
  const ok = JSON.stringify(replayed) === JSON.stringify(st.final);
  printBuckets(replayed.buckets);
  console.log(ok ? 'REPLAY OK: state matches recorded final state' : 'REPLAY MISMATCH: state diverged');
  return ok ? 0 : 2;
}
