#!/usr/bin/env node
// JSONL CLI: one JSON command per line on stdin, one JSON response per line
// on stdout. State lives in a single Repo for the duration of the session.

import readline from 'node:readline';
import { Repo } from './src/repo.js';
import { checkCertificate } from './src/checker.js';

const repo = new Repo();

const handlers = {
  init() {
    repo.reset();
    return { initialized: true };
  },
  loadBranch(cmd) {
    return repo.loadBranch(cmd.name, cmd.events ?? []);
  },
  merge() {
    return repo.merge();
  },
  resolve(cmd) {
    return repo.resolve(cmd);
  },
  status() {
    return repo.status();
  },
  projection() {
    return repo.projection();
  },
  certificate() {
    return { certificate: repo.certificate() };
  },
  mergeCommit() {
    return repo.mergeCommit();
  },
  snapshot(cmd) {
    const id = cmd.id ?? repo.index;
    const snap = repo.snapshots.get(id);
    if (!snap) throw new Error(`unknown snapshot ${id}`);
    return { snapshot: snap };
  },
  history() {
    return { history: repo.history, index: repo.index };
  },
  diff(cmd) {
    return { diff: repo.diff(cmd.from, cmd.to) };
  },
  inverseDiff(cmd) {
    return { diff: repo.inverseDiff(cmd.from, cmd.to) };
  },
  applyInverseDiff(cmd) {
    return repo.applyInverseDiff(cmd.diff);
  },
  checkCertificate(cmd) {
    let inputs; let events; let certificate; let conflicts;
    if (cmd.snapshotId || cmd.committed) {
      const snap = repo.snapshots.get(cmd.snapshotId ?? repo.index);
      if (!snap) throw new Error('unknown snapshot');
      inputs = snap.inputs;
      events = snap.events;
      certificate = snap.certificate;
      conflicts = snap.conflicts;
    } else {
      if (!repo.mergeState) throw new Error('no merge in progress');
      inputs = repo.branchEvents();
      events = repo.mergeState.events;
      certificate = repo.certificate();
      conflicts = [...repo.mergeState.conflicts.values()];
    }
    return checkCertificate({ ...inputs, events, certificate, conflicts });
  },
};

function dispatch(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const handler = handlers[cmd.op];
  if (!handler) return { ok: false, error: `unknown op ${cmd.op}` };
  try {
    const result = handler(cmd);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code ?? null };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  process.stdout.write(JSON.stringify(dispatch(line)) + '\n');
});
