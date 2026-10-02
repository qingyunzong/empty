#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { VersionStore } from './src/versions.js';
import { materialize } from './src/engine.js';

function reportError(err, version) {
  const payload = { error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message } };
  if (version !== undefined) payload.version = version;
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}

function main() {
  const arg = process.argv[2];
  const raw = arg ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
  const input = JSON.parse(raw);

  let store;
  try {
    store = new VersionStore(input.template ?? '', input.variables ?? {});
    for (const patch of input.patches ?? []) store.applyPatch(patch);
    for (let i = 0; i < (input.undo ?? 0); i++) store.undo();
    for (let i = 0; i < (input.redo ?? 0); i++) store.redo();
  } catch (err) {
    reportError(err, store ? store.version : undefined);
    return;
  }

  const state = store.current();
  try {
    const { output, hash } = materialize(state.template, state.variables);
    process.stdout.write(`${JSON.stringify({ version: store.version, hash, output })}\n`);
  } catch (err) {
    reportError(err, store.version);
  }
}

main();
