#!/usr/bin/env node
import { writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { JsonHashCache } from "./cache";
import { canonicalize, diffManifests, formatDiff } from "./manifest";
import { DEFAULT_RETRIES, scanDirectory } from "./scanner";
import { Manifest } from "./types";

const USAGE = `Usage: dirscan <command> [options]

Commands:
  scan <dir> [--cache <file>] [--retries <n>] [--out <file>]
      Scan <dir> (symlinks are never followed) and print a canonical manifest
      of relative paths, entry types and sha256 content hashes.
      Files that keep changing during the scan are retried up to <n> times
      (default ${DEFAULT_RETRIES}) and then marked "unstable"; exit code is 2
      if any unstable entries remain.
      With --cache, hashes are reused only when the cached content evidence
      (size, mtimeMs, ctimeMs, ino) matches the current lstat exactly.

  diff <manifestA> <manifestB>
      Compare two manifests. Exit code 0 when identical, 1 when different.
`;

function writeStdout(text: string): void {
  writeSync(1, text);
}

function writeStderr(text: string): void {
  writeSync(2, text);
}

const EXIT_OK = 0;
const EXIT_DIFFERENT = 1;
const EXIT_UNSTABLE = 2;
const EXIT_USAGE = 64;

function fail(message: string): never {
  throw new Error(message);
}

async function runScan(args: string[]): Promise<number> {
  let dir: string | undefined;
  let cacheFile: string | undefined;
  let outFile: string | undefined;
  let retries = DEFAULT_RETRIES;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--cache") cacheFile = args[++i] ?? fail("--cache requires a value");
    else if (arg === "--out") outFile = args[++i] ?? fail("--out requires a value");
    else if (arg === "--retries") {
      const value = args[++i] ?? fail("--retries requires a value");
      retries = Number.parseInt(value, 10);
      if (!Number.isInteger(retries) || retries < 0) fail(`invalid --retries value: ${value}`);
    } else if (arg.startsWith("--")) fail(`unknown option: ${arg}`);
    else if (dir === undefined) dir = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (dir === undefined) fail("scan requires a directory");

  const root = resolve(dir);
  const excludePaths = new Set<string>();
  for (const file of [cacheFile, outFile]) {
    if (!file) continue;
    const abs = isAbsolute(file) ? file : resolve(file);
    if (abs === root || !abs.startsWith(root + "/")) continue;
    excludePaths.add(abs.slice(root.length + 1).split("\\").join("/"));
  }

  const cache = cacheFile ? await JsonHashCache.load(resolve(cacheFile), root) : undefined;
  const { manifest, stats } = await scanDirectory(root, { cache, retries, excludePaths });
  const output = canonicalize(manifest);

  if (outFile) await writeFile(resolve(outFile), output);
  else writeStdout(output);
  if (cacheFile && cache) await cache.save(resolve(cacheFile));

  writeStderr(
    `scanned ${manifest.entries.length} entries ` +
      `(${stats.hashed} hashed, ${stats.cacheHits} cache hits, ${stats.retries} retries, ${stats.unstable} unstable)\n`
  );
  const unstable = manifest.entries.filter((entry) => entry.unstable);
  for (const entry of unstable) {
    writeStderr(`warning: unstable entry (changed during scan): ${entry.path}\n`);
  }
  return unstable.length > 0 ? EXIT_UNSTABLE : EXIT_OK;
}

async function runDiff(args: string[]): Promise<number> {
  const [fileA, fileB, ...rest] = args;
  if (!fileA || !fileB || rest.length > 0) fail("diff requires exactly two manifest files");
  const manifestA = JSON.parse(await readFile(resolve(fileA), "utf8")) as Manifest;
  const manifestB = JSON.parse(await readFile(resolve(fileB), "utf8")) as Manifest;
  const diff = diffManifests(manifestA, manifestB);
  writeStdout(formatDiff(diff));
  return diff.equal ? EXIT_OK : EXIT_DIFFERENT;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "scan":
      return runScan(rest);
    case "diff":
      return runDiff(rest);
    case undefined:
    case "--help":
    case "-h":
      writeStdout(USAGE);
      return command === undefined ? EXIT_USAGE : EXIT_OK;
    default:
      writeStderr(`unknown command: ${command}\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`dirscan: ${message}\n`);
    process.exitCode = EXIT_USAGE;
  });
