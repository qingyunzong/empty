import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  initStore,
  loadStore,
  buildEvents,
  appendBatch,
  mergeLines,
  dumpLines,
  currentVersion,
  visibleState,
} from '../src/store.js';

export const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
}

export function makeStore(nodes, { node, retention = 0 } = {}) {
  const dir = tmpdir();
  initStore(dir, { node: node || nodes[0], nodes, retention });
  return dir;
}

export function doOp(dir, op, inputs) {
  const state = loadStore(dir);
  const events = buildEvents(state, op, inputs);
  appendBatch(dir, events);
  return events;
}

export function doMerge(dir, dump) {
  const state = loadStore(dir);
  const results = mergeLines(state, dump);
  return results;
}

export function dump(dir) {
  return dumpLines(loadStore(dir));
}

export function visible(dir) {
  return visibleState(loadStore(dir));
}

export function summary(dir) {
  const state = loadStore(dir);
  let live = 0;
  let tombstones = 0;
  for (const rec of state.records.values()) {
    if (currentVersion(rec).deleted) tombstones += 1;
    else live += 1;
  }
  return { records: live, tombstones, lamport: state.lamport, frontier: state.frontier, seenBy: state.seenBy };
}

// Canonical, order-independent serialization of the full replicated state.
export function canonical(dir) {
  const state = loadStore(dir);
  const records = [...state.records.values()]
    .map((rec) => ({
      key: rec.key,
      versions: [...rec.versions.values()]
        .map((v) => ({ value: v.value, deleted: v.deleted, clock: v.clock, lamport: v.lamport, origin: v.origin }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { frontier: state.frontier, lamport: state.lamport, records };
}

// Drives the CLI with file-backed stdio (stdin/stdout/stderr are temp files),
// which behaves identically to pipes but is robust in restricted sandboxes.
export function runCli(args, { input = '', env = {} } = {}) {
  const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-cli-'));
  const inPath = path.join(ioDir, 'stdin.jsonl');
  const outPath = path.join(ioDir, 'stdout.txt');
  const errPath = path.join(ioDir, 'stderr.txt');
  fs.writeFileSync(inPath, input);
  const inFd = fs.openSync(inPath, 'r');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    stdio: [inFd, outFd, errFd],
    env: { ...process.env, ...env },
  });
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    signal: r.signal,
    error: r.error,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

export function stdoutLines(result) {
  return result.stdout.split('\n').filter((s) => s.trim().length > 0).map((s) => JSON.parse(s));
}

// Canonical state restricted to live (non-tombstone) records. Tombstone
// compaction is a local optimization, so replicas may legitimately differ in
// whether an already-invisible tombstone is still stored.
export function canonicalLive(dir) {
  const state = loadStore(dir);
  const c = canonical(dir);
  c.records = c.records.filter((r) => {
    const rec = state.records.get(r.key);
    return !currentVersion(rec).deleted;
  });
  return c;
}
