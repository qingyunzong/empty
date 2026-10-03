#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  LineageError,
  hashVersion,
  validateVersion,
  mergeVersions,
} = require('../src/lineage.js');

function loadStore(dir) {
  const store = new Map();
  if (!fs.existsSync(dir)) return store;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const version = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const hash = version.hash || path.basename(name, '.json');
    store.set(hash, { ...version, hash });
  }
  return store;
}

function saveVersion(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${version.hash}.json`),
    JSON.stringify(version, null, 2) + '\n'
  );
}

function usage() {
  console.error(`usage:
  lineage-merge add <storeDir> <versionFile>      validate and add a version to the store
  lineage-merge merge <storeDir> <hashA> <hashB> [--out <dir>]
                                                  merge two versions; conflicts -> pairwise-conflicts.json
  lineage-merge compare <storeDir> <hashA> <hashB>
                                                  print happens-before relation`);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function main(argv) {
  const [command, ...args] = argv;

  if (command === 'add') {
    const [storeDir, versionFile] = args;
    if (!storeDir || !versionFile) return fail('add requires <storeDir> <versionFile>');
    const version = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    const store = loadStore(storeDir);
    validateVersion(version, store);
    version.hash = hashVersion(version);
    saveVersion(storeDir, version);
    console.log(version.hash);
    return;
  }

  if (command === 'compare') {
    const [storeDir, hashA, hashB] = args;
    const store = loadStore(storeDir);
    const a = store.get(hashA);
    const b = store.get(hashB);
    if (!a) return fail(`unknown version: ${hashA}`);
    if (!b) return fail(`unknown version: ${hashB}`);
    const { compareClocks } = require('../src/lineage.js');
    const cmp = compareClocks(a.clock, b.clock);
    console.log(cmp === 0 ? 'equal' : cmp === -1 ? 'happens-before' : cmp === 1 ? 'happens-after' : 'concurrent');
    return;
  }

  if (command === 'merge') {
    const outIdx = args.indexOf('--out');
    const outDir = outIdx >= 0 ? args[outIdx + 1] : process.cwd();
    const positional = outIdx >= 0
      ? args.filter((_, i) => i !== outIdx && i !== outIdx + 1)
      : args;
    const [storeDir, hashA, hashB] = positional;
    if (!storeDir || !hashA || !hashB) return fail('merge requires <storeDir> <hashA> <hashB>');

    const store = loadStore(storeDir);
    const a = store.get(hashA);
    const b = store.get(hashB);
    if (!a) return fail(`unknown version: ${hashA}`);
    if (!b) return fail(`unknown version: ${hashB}`);
    validateVersion(a, store);
    validateVersion(b, store);

    const result = mergeVersions(a, b, store);

    if (result.status === 'conflict') {
      const certificate = {
        kind: 'pairwise-conflicts',
        leftVersion: hashA,
        rightVersion: hashB,
        conflicts: result.conflicts,
      };
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'pairwise-conflicts.json'),
        JSON.stringify(certificate, null, 2) + '\n'
      );
      console.error(`conflict: ${result.conflicts.length} pairwise conflict(s); certificate written to pairwise-conflicts.json`);
      process.exit(2);
    }

    if (result.status === 'fast-forward') {
      console.log(JSON.stringify({ status: 'fast-forward', hash: result.version.hash }));
      return;
    }

    saveVersion(storeDir, result.version);
    console.log(JSON.stringify({ status: 'merged', hash: result.version.hash }));
    return;
  }

  usage();
  process.exit(1);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof LineageError) fail(err.message);
  throw err;
}
