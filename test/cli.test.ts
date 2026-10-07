import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in-process (the sandbox forbids spawning child processes). */
async function runCli(args: string[]): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const originalError = console.error;
  process.stdout.write = (data: string): boolean => {
    stdout += data;
    return true;
  };
  console.log = (...args: unknown[]): void => {
    stdout += args.map(String).join(' ') + '\n';
  };
  console.error = (...args: unknown[]): void => {
    stderr += args.map(String).join(' ') + '\n';
  };
  try {
    const code = await main(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.error = originalError;
  }
}

test('cli scan/diff/verify round-trip with comparable manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diridx-cli-tree-'));
  const out = await mkdtemp(join(tmpdir(), 'diridx-cli-out-'));
  try {
    await writeFile(join(root, 'a.txt'), 'one');

    const scan1 = await runCli(['scan', root]);
    equal(scan1.code, 0);
    const manifest1 = JSON.parse(scan1.stdout) as { entries: unknown[] };
    ok(Array.isArray(manifest1.entries));
    const file1 = join(out, 'm1.json');
    await writeFile(file1, scan1.stdout);

    const scan2 = await runCli(['scan', root]);
    equal(scan2.code, 0);
    const file2 = join(out, 'm2.json');
    await writeFile(file2, scan2.stdout);

    equal((await runCli(['diff', file1, file2])).code, 0, 'unchanged tree diffs equal');
    equal((await runCli(['verify', root, '--against', file1])).code, 0, 'unchanged tree verifies OK');

    // Controlled modification: verification against the pre-modification
    // manifest must not report false equality.
    await writeFile(join(root, 'a.txt'), 'two');
    const verifyAfterEdit = await runCli(['verify', root, '--against', file1]);
    equal(verifyAfterEdit.code, 1, 'modified content fails verification');

    const scan3 = await runCli(['scan', root]);
    const file3 = join(out, 'm3.json');
    await writeFile(file3, scan3.stdout);
    const diffResult = await runCli(['diff', file1, file3]);
    equal(diffResult.code, 1, 'diff exits 1 on content change');
    ok(diffResult.stdout.includes('a.txt'), 'diff output names the changed file');

    equal((await runCli(['verify', root, '--against', file3])).code, 0, 'fresh manifest verifies OK');

    // Cache round-trip through the CLI: rescan with --cache must stay equal.
    const cacheFile = join(out, 'cache.json');
    await runCli(['scan', root, '--save-cache', cacheFile]);
    const cachedScan = await runCli(['scan', root, '--cache', cacheFile]);
    equal(cachedScan.code, 0);
    equal(cachedScan.stdout, scan3.stdout, 'cached rescan yields the identical manifest');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
