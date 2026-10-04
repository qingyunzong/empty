import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cea-'));
}

export function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20000 });
}

// Feed `stdinText` to the CLI through a shell pipeline (spawnSync `input`
// pipes are unreliable in some sandboxes).
export function runCliStdin(args, stdinText) {
  const quoted = [CLI, ...args].map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');
  return spawnSync('sh', ['-c', `printf '%s' '${stdinText.replaceAll("'", "'\\''")}' | node ${quoted}`], {
    encoding: 'utf8',
    timeout: 20000,
  });
}

export function writeJson(dir, name, text) {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

// Enumerate all topological orders of a precedence DAG (independent checker).
export function enumerateTopoOrders(ids, edges) {
  const preds = new Map(ids.map((id) => [id, new Set()]));
  for (const [from, to] of edges) preds.get(to).add(from);
  const orders = [];
  const placed = [];
  const placedSet = new Set();
  function rec() {
    if (placed.length === ids.length) {
      orders.push([...placed]);
      return;
    }
    for (const id of ids) {
      if (placedSet.has(id)) continue;
      if ([...preds.get(id)].some((p) => !placedSet.has(p))) continue;
      placed.push(id);
      placedSet.add(id);
      rec();
      placedSet.delete(id);
      placed.pop();
    }
  }
  rec();
  return orders;
}
