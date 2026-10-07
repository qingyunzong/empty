import { readFileSync } from 'node:fs';
import { validateEvent } from './event.js';
import { mergeEvents, replay, UnknownMemberError } from './store.js';
import { computeDigest, divergence, digestsEqual, certificate } from './digest.js';

function readJsonl(path) {
  const text = readFileSync(path, 'utf8');
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new Error(`${path}:${i + 1}: invalid JSON`);
    }
    events.push(validateEvent(raw, `${path}:${i + 1}`));
  }
  return events;
}

const USAGE = `usage:
  boiler-merge merge  <file.jsonl> [more.jsonl ...]   merge logs, print final state + certificate
  boiler-merge digest <file.jsonl> [other.jsonl]      print digest; with 2 files compare (exit 5 on mismatch)
  boiler-merge status <file.jsonl> [more.jsonl ...]   print current valve state`;

function cmdMerge(files) {
  if (files.length === 0) throw new Error('merge: at least one input file required');
  const events = mergeEvents(...files.map(readJsonl));
  const state = replay(events);
  return { stdout: JSON.stringify({ state, certificate: certificate(events, state) }, null, 2) + '\n' };
}

function cmdDigest(files) {
  if (files.length === 0) throw new Error('digest: at least one input file required');
  const digests = files.map((f) => computeDigest(readJsonl(f)));
  if (digests.length === 1) {
    return { stdout: JSON.stringify(digests[0], null, 2) + '\n' };
  }
  const [first, ...rest] = digests;
  const equal = rest.every((d) => digestsEqual(first, d));
  const stdout = JSON.stringify({ files, digests, equal }, null, 2) + '\n';
  if (equal) return { stdout };
  const divs = rest.map((d, i) => ({ comparedWith: files[i + 1], ...divergence(first, d) }));
  return {
    stdout,
    stderr: JSON.stringify({ error: 'digest mismatch', divergence: divs }, null, 2) + '\n',
    code: 5,
  };
}

function cmdStatus(files) {
  if (files.length === 0) throw new Error('status: at least one input file required');
  const events = mergeEvents(...files.map(readJsonl));
  const state = replay(events);
  const summary = {
    valve: state.valve,
    interlocked: state.interlocked,
    activeBypasses: state.activeBypasses,
    keys: state.keys,
    members: state.members,
    rejected: state.rejected,
  };
  return { stdout: JSON.stringify(summary, null, 2) + '\n' };
}

export function runCli(argv) {
  const [cmd, ...files] = argv;
  try {
    if (cmd === 'merge') return { code: 0, stderr: '', ...cmdMerge(files) };
    if (cmd === 'digest') return { code: 0, stderr: '', ...cmdDigest(files) };
    if (cmd === 'status') return { code: 0, stderr: '', ...cmdStatus(files) };
    return { code: 2, stdout: '', stderr: USAGE + '\n' };
  } catch (err) {
    if (err instanceof UnknownMemberError) {
      return { code: 4, stdout: '', stderr: `error: ${err.message}\n` };
    }
    return { code: 1, stdout: '', stderr: `error: ${err.message}\n` };
  }
}
