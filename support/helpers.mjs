import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Note: this sandbox swallows process.stdout of spawned children unless the
// CLI writes via fs.writeSync(1), and piped stdin to spawned children can
// block; tests therefore always pass input through --file.
export function runCli(args, input = '') {
  const dir = mkdtempSync(join(tmpdir(), 'asrs-test-'));
  const file = join(dir, 'input.jsonl');
  writeFileSync(file, input);
  const r = spawnSync(process.execPath, [CLI, ...args, '--file', file], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, lines: parseJsonl(r.stdout) };
}

export function parseJsonl(text) {
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

export function toJsonl(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function shuttle(id, home, extra = {}) {
  return { id, home, speed: 1, energyPerUnit: 1, ...extra };
}
