#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import {
  EXIT,
  TraceError,
  parseJsonl,
  buildState,
  applyEvents,
  correctInspection,
  recallCertificate,
  verifyCertificate,
} from '../src/lineage.js';

const USAGE = `usage:
  trace build <input.jsonl> [--state out.json] [--append existing.json]
  trace correct --state state.json --batch <id> --status <pass|fail|...> [--id <inspId>] [--corrects <inspId>]
  trace recall --state state.json [--out cert.json]
  trace verify --state state.json --cert cert.json`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      flags[key] = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

function requireFlag(flags, name) {
  if (flags[name] === undefined) {
    throw new TraceError(EXIT.PARSE, `missing required flag --${name}`);
  }
  return flags[name];
}

function loadState(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new TraceError(EXIT.PARSE, `cannot read state file: ${path}`);
  }
  const data = JSON.parse(raw);
  return buildState(data.events ?? []);
}

function saveState(state, path) {
  writeFileSync(path, JSON.stringify({ ruleVersion: state.ruleVersion, events: state.events }, null, 2) + '\n');
}

function cmdBuild(positional, flags) {
  const input = positional[0];
  if (!input) throw new TraceError(EXIT.PARSE, 'build requires an input .jsonl file');
  const events = parseJsonl(readFileSync(input, 'utf8'));
  let state;
  if (flags.append !== undefined) {
    state = applyEvents(loadState(flags.append), events);
  } else {
    state = buildState(events);
  }
  const out = flags.state ?? 'state.json';
  saveState(state, out);
  const count = state.order.filter((id) => state.contaminated[id]).length;
  console.log(JSON.stringify({
    state: out,
    batches: state.order.length,
    events: state.events.length,
    contaminated: count,
    sources: state.sources,
  }));
}

function cmdCorrect(flags) {
  const statePath = requireFlag(flags, 'state');
  const state = loadState(statePath);
  const result = correctInspection(state, {
    id: flags.id,
    batch: requireFlag(flags, 'batch'),
    status: requireFlag(flags, 'status'),
    corrects: flags.corrects,
  });
  saveState(state, statePath);
  console.log(JSON.stringify({
    compensation: result.event,
    closureSize: result.closure.size,
    changed: result.changed,
  }));
}

function cmdRecall(flags) {
  const state = loadState(requireFlag(flags, 'state'));
  const certificate = recallCertificate(state);
  const text = JSON.stringify(certificate, null, 2);
  if (flags.out !== undefined) writeFileSync(flags.out, text + '\n');
  console.log(text);
}

function cmdVerify(flags) {
  const state = loadState(requireFlag(flags, 'state'));
  const certificate = JSON.parse(readFileSync(requireFlag(flags, 'cert'), 'utf8'));
  const result = verifyCertificate(state.events, certificate);
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, mismatches: result.mismatches }));
    process.exit(EXIT.MISMATCH);
  }
  console.log(JSON.stringify({ ok: true, inputHash: result.replayed.inputHash }));
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'build': return cmdBuild(positional, flags);
    case 'correct': return cmdCorrect(flags);
    case 'recall': return cmdRecall(flags);
    case 'verify': return cmdVerify(flags);
    default:
      console.error(USAGE);
      process.exit(EXIT.PARSE);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof TraceError) {
    console.error(`error: ${err.message}`);
    process.exit(err.exitCode);
  }
  throw err;
}
