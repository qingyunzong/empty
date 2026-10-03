#!/usr/bin/env node
'use strict';
// 用法:
//   node cli.js snapshot --data DIR --balances F.json [--seq N] [--base-seq N] [--chunk-size N]
//   node cli.js delta    --data DIR (--entry JSON | --file F.json)
//   node cli.js restore  --data DIR [--out F.json]
//   node cli.js check    --data DIR [--out proof.json]
//   node cli.js check    --data DIR --verify proof.json
// 环境变量 SNAPSHOT_CRASH=beforeManifestWrite|afterManifestFsync|afterCommit 用于故障注入测试。

const fs = require('node:fs');
const store = require('./lib/store');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function crashHookFromEnv() {
  const point = process.env.SNAPSHOT_CRASH;
  if (!point) return null;
  return (at) => {
    if (at === point) {
      process.stderr.write('crash injected at ' + at + '\n');
      process.kill(process.pid, 'SIGKILL');
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dir = args.data;
  if (!cmd || !dir) {
    process.stderr.write('missing command or --data DIR\n');
    process.exit(2);
  }

  if (cmd === 'snapshot') {
    const balances = JSON.parse(fs.readFileSync(args.balances, 'utf8'));
    const seqs = store.listSnapshotSeqs(dir);
    const entries = store.readDeltaLog(dir);
    const seq = args.seq ? parseInt(args.seq, 10) : (seqs.length ? seqs[seqs.length - 1] : 0) + 1;
    const baseSeq = args['base-seq'] !== undefined
      ? parseInt(args['base-seq'], 10)
      : (entries.length ? entries[entries.length - 1].seq : 0);
    const r = store.writeSnapshot(dir, balances, {
      seq, baseSeq,
      chunkSize: args['chunk-size'] ? parseInt(args['chunk-size'], 10) : 100,
      crashHook: crashHookFromEnv(),
    });
    process.stdout.write(JSON.stringify({ ok: true, seq, baseSeq, manifestHash: r.manifestHash }) + '\n');
  } else if (cmd === 'delta') {
    const entry = args.entry ? JSON.parse(args.entry) : JSON.parse(fs.readFileSync(args.file, 'utf8'));
    const r = store.appendDelta(dir, entry);
    process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
  } else if (cmd === 'restore') {
    const r = store.restore(dir);
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(r.balances, null, 2) + '\n');
    const summary = { ...r };
    if (args.out) delete summary.balances;
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else if (cmd === 'check') {
    if (args.verify) {
      const proof = JSON.parse(fs.readFileSync(args.verify, 'utf8'));
      const r = store.verifyProof(dir, proof);
      process.stdout.write(JSON.stringify(r) + '\n');
      process.exit(r.valid ? 0 : 1);
    }
    const proof = store.check(dir);
    const out = JSON.stringify(proof, null, 2) + '\n';
    if (args.out) fs.writeFileSync(args.out, out);
    else process.stdout.write(out);
    process.exit(proof.coverage.complete ? 0 : 1);
  } else {
    process.stderr.write('unknown command: ' + cmd + '\n');
    process.exit(2);
  }
}

try {
  main();
} catch (err) {
  const code = typeof err.code === 'number' ? err.code : 1;
  process.stderr.write(JSON.stringify({ error: err.message, code, details: err.details }) + '\n');
  process.exit(code);
}
