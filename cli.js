#!/usr/bin/env node
'use strict';

const fsp = require('node:fs/promises');
const { scan, makeDelta, applyDelta, certify } = require('./lib');

const USAGE = `usage:
  node cli.js scan <dir> [--chunk-size N]
  node cli.js makedelta <srcManifest.json> <dstManifest.json> <dstDir>
  node cli.js applydelta <delta.json> <targetDir>
  node cli.js certify <targetDir> <delta.json>`;

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    const err = new Error(`cannot read JSON from ${file}: ${e.message}`);
    err.code = 'ERR_STATE';
    throw err;
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'scan': {
      const dir = args[0];
      if (!dir) throw Object.assign(new Error('missing dir'), { code: 'ERR_STATE' });
      let chunkSize;
      const i = args.indexOf('--chunk-size');
      if (i !== -1) chunkSize = Number(args[i + 1]);
      const manifest = await scan(dir, chunkSize ? { chunkSize } : {});
      process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
      return;
    }
    case 'makedelta': {
      const [srcFile, dstFile, dstDir] = args;
      if (!srcFile || !dstFile || !dstDir) {
        throw Object.assign(new Error('usage: makedelta <srcManifest> <dstManifest> <dstDir>'), { code: 'ERR_STATE' });
      }
      const delta = await makeDelta(await readJson(srcFile), await readJson(dstFile), dstDir);
      process.stdout.write(JSON.stringify(delta, null, 2) + '\n');
      return;
    }
    case 'applydelta': {
      const [deltaFile, dir] = args;
      if (!deltaFile || !dir) {
        throw Object.assign(new Error('usage: applydelta <delta.json> <targetDir>'), { code: 'ERR_STATE' });
      }
      const result = await applyDelta(await readJson(deltaFile), dir);
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    case 'certify': {
      const [dir, deltaFile] = args;
      if (!dir || !deltaFile) {
        throw Object.assign(new Error('usage: certify <targetDir> <delta.json>'), { code: 'ERR_STATE' });
      }
      const proof = await certify(dir, await readJson(deltaFile));
      process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
      return;
    }
    default:
      process.stderr.write(USAGE + '\n');
      process.exit(2);
  }
}

main().catch((e) => {
  const code = typeof e.code === 'string' && e.code.startsWith('ERR_') ? e.code : 'ERR_STATE';
  process.stderr.write(JSON.stringify({ error: code, message: e.message }) + '\n');
  process.exit(1);
});
