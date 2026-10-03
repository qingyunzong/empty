import { readFileSync, writeFileSync } from 'node:fs';
import { QuotaError, runAll, serializeState, replay } from './index.js';

const USAGE = `usage:
  quota apply <script.qta> <events.jsonl> --out <state.json>
  quota replay <state.json>`;

const fmtBucket = (name, b) =>
  `  ${name}: limit=${b.limit} available=${b.available} frozen=${b.frozen} used=${b.used}`;

function cmdApply(args, out, err) {
  const [scriptPath, eventsPath, ...flags] = args;
  const outIdx = flags.indexOf('--out');
  const outPath = outIdx >= 0 ? flags[outIdx + 1] : null;
  if (!scriptPath || !eventsPath || !outPath) {
    err(USAGE);
    return 2;
  }

  const script = readFileSync(scriptPath, 'utf8');
  const events = readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: '__invalid__', id: `line-${i + 1}` };
      }
    });

  let saved;
  try {
    const { policy, state } = runAll(script, events);
    saved = serializeState(policy, state, script, events);
  } catch (e) {
    if (e instanceof QuotaError) {
      err(`error ${e.code}: ${e.message}`);
      return 1;
    }
    throw e;
  }

  writeFileSync(outPath, `${JSON.stringify(saved, null, 2)}\n`);
  const { total, applied, failed } = saved.summary;
  out(`applied ${applied}/${total} events (${failed} failed), business day: ${saved.currentDay ?? '-'}`);
  for (const l of saved.log) {
    if (l.status !== 'error') continue;
    out(`  #${l.seq} ${l.id ?? '-'} ${l.type} ${l.bucket ?? ''} -> ${l.code}: ${l.message}`);
  }
  out('final buckets:');
  for (const [name, b] of Object.entries(saved.buckets)) out(fmtBucket(name, b));
  out(`state written to ${outPath}`);
  return 0;
}

function cmdReplay(args, out, err) {
  const [statePath] = args;
  if (!statePath) {
    err(USAGE);
    return 2;
  }
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  let result;
  try {
    result = replay(saved);
  } catch (e) {
    if (e instanceof QuotaError) {
      err(`error ${e.code}: ${e.message}`);
      return 1;
    }
    throw e;
  }
  if (!result.ok) {
    err(`REPLAY FAILED: mismatches in ${result.mismatches.join(', ')}`);
    return 1;
  }
  out(`REPLAY OK: ${result.state.summary.total} events re-applied, final state matches (buckets/freezes/scopes/log)`);
  out('final buckets:');
  for (const [name, b] of Object.entries(result.state.buckets)) out(fmtBucket(name, b));
  return 0;
}

export function runCli(argv, out = (s) => console.log(s), err = (s) => console.error(s)) {
  const [cmd, ...rest] = argv;
  if (cmd === 'apply') return cmdApply(rest, out, err);
  if (cmd === 'replay') return cmdReplay(rest, out, err);
  err(USAGE);
  return 2;
}
