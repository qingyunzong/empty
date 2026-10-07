#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDirectory } from './scanner.js';
import { compareManifests, serializeManifest, type ManifestDiff } from './manifest.js';
import { isManifest, loadCache, saveCache } from './cache.js';
import type { Manifest } from './types.js';

const USAGE = `dir-index - scan a directory into a comparable content manifest

Usage:
  dir-index scan <dir> [--cache <file>] [--save-cache <file>] [--retries <n>] [--out <file>]
      Scan <dir> (symlinks are never followed) and print a canonical JSON
      manifest of relative paths, entry types and sha256 content hashes.
      --cache       reuse hashes from a previous manifest, but only when the
                    cached content evidence (size/mtime/ctime/ino) matches
      --save-cache  write the full manifest (with evidence) to <file>
      --retries     attempts per file before flagging it unstable (default 3)
      --out         write the manifest to <file> instead of stdout

  dir-index diff <manifest-a> <manifest-b>
      Compare two manifests. Exit code 0 when equal, 1 when different.

  dir-index verify <dir> --against <manifest> [--retries <n>]
      Rescan <dir> from scratch and compare against <manifest>.
      Exit code 0 on match, 1 on mismatch.
`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function readManifestFile(path: string): Promise<Manifest> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isManifest(parsed)) throw new Error(`invalid manifest file: ${path}`);
  return parsed;
}

function printDiff(diff: ManifestDiff): void {
  for (const entry of diff.added) console.log(`+ ${entry.path} (${entry.type})`);
  for (const entry of diff.removed) console.log(`- ${entry.path} (${entry.type})`);
  for (const change of diff.changed) {
    console.log(`~ ${change.path}: ${change.reasons.join(', ')}`);
  }
}

function warnUnstable(manifest: Manifest): void {
  const unstable = manifest.entries.filter((entry) => entry.unstable);
  for (const entry of unstable) {
    console.error(`warning: unstable (changed while scanning): ${entry.path}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'scan') {
    const { positional, flags } = parseArgs(rest);
    const dir = positional[0];
    if (!dir) {
      console.error('scan: missing <dir>\n\n' + USAGE);
      return 2;
    }
    const cacheFlag = flags.get('cache');
    const cache = typeof cacheFlag === 'string' ? await loadCache(cacheFlag) : undefined;
    const retriesFlag = flags.get('retries');
    const retries = typeof retriesFlag === 'string' ? Number(retriesFlag) : undefined;
    const manifest = await scanDirectory(resolve(dir), { cache, retries });
    const saveCacheFlag = flags.get('save-cache');
    if (typeof saveCacheFlag === 'string') await saveCache(saveCacheFlag, manifest);
    const output = serializeManifest(manifest);
    const outFlag = flags.get('out');
    if (typeof outFlag === 'string') await writeFile(outFlag, output, 'utf8');
    else process.stdout.write(output);
    warnUnstable(manifest);
    return 0;
  }

  if (command === 'diff') {
    const { positional } = parseArgs(rest);
    const [pathA, pathB] = positional;
    if (!pathA || !pathB) {
      console.error('diff: expected <manifest-a> <manifest-b>\n\n' + USAGE);
      return 2;
    }
    const diff = compareManifests(await readManifestFile(pathA), await readManifestFile(pathB));
    if (diff.equal) {
      console.log('manifests are equal');
      return 0;
    }
    printDiff(diff);
    return 1;
  }

  if (command === 'verify') {
    const { positional, flags } = parseArgs(rest);
    const dir = positional[0];
    const against = flags.get('against');
    if (!dir || typeof against !== 'string') {
      console.error('verify: expected <dir> --against <manifest>\n\n' + USAGE);
      return 2;
    }
    const retriesFlag = flags.get('retries');
    const retries = typeof retriesFlag === 'string' ? Number(retriesFlag) : undefined;
    const expected = await readManifestFile(against);
    const actual = await scanDirectory(resolve(dir), { retries });
    warnUnstable(actual);
    const diff = compareManifests(expected, actual);
    if (diff.equal) {
      console.log('OK: directory matches manifest');
      return 0;
    }
    console.log('MISMATCH:');
    printDiff(diff);
    return 1;
  }

  console.error(USAGE);
  return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
