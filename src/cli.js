#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { VersionStore } from './versions.js';
import { materialize } from './materialize.js';

// Input (JSON file path as argv[2], or stdin):
//   { "template": "...", "variables": {...},
//     "patches": [ {"set": {"a.b": 1}}, {"unset": ["a"]}, {"op": "undo"}, {"op": "redo"} ] }
// Output (single JSON line on stdout):
//   success: { "ok": true,  "version": N, "hash": "...", "output": "..." }
//   failure: { "ok": false, "version": N, "hash": "...", "error": "..." }  (exit code 1)
// On failure no partial rendered text is written anywhere.

export function runCli(input) {
  const store = new VersionStore(input.template, input.variables ?? {});
  for (const patch of input.patches ?? []) {
    if (patch.op === 'undo') store.undo();
    else if (patch.op === 'redo') store.redo();
    else store.applyPatch(patch);
  }
  try {
    const { output } = materialize(store.template, store.variables);
    return { code: 0, payload: { ok: true, version: store.version, hash: store.hash, output } };
  } catch (err) {
    return { code: 1, payload: { ok: false, version: store.version, hash: store.hash, error: err.message } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
  const { code, payload } = runCli(JSON.parse(raw));
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exitCode = code;
}
