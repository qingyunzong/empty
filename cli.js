#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { mergeTexts, SyncError } = require('./sync');
const { generate, toNdjson } = require('./gen');

function fail(code, message) {
  fs.writeSync(2, message);
  process.exit(code);
}

// Crash injection for resume testing: SYNC_CRASH=pre-conflicts|post-conflicts|
// pre-log|post-log|pre-balance|post-balance makes the process die at that point.
function crashPoint(name) {
  if (process.env.SYNC_CRASH === name) {
    fs.writeSync(2, `simulated crash at ${name}\n`);
    process.exit(2);
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const STEPS = ['log', 'balance', 'conflicts'];

function cmdMerge(args) {
  const files = [];
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else files.push(args[i]);
  }
  if (files.length !== 2 || !out) {
    fail(1, 'usage: node cli.js merge <a.ndjson> <b.ndjson> --out <dir>\n');
  }
  let textA;
  let textB;
  try {
    textA = fs.readFileSync(files[0], 'utf8');
    textB = fs.readFileSync(files[1], 'utf8');
  } catch (err) {
    fail(1, `error: cannot read input: ${err.message}\n`);
  }

  let result;
  try {
    result = mergeTexts(textA, textB);
  } catch (err) {
    if (err instanceof SyncError) {
      fail(3, `error: ${err.message}\n`);
    }
    throw err;
  }

  fs.mkdirSync(out, { recursive: true });
  const journalFile = path.join(out, '.journal');
  const done = new Set(
    fs.existsSync(journalFile)
      ? fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean)
      : []
  );

  // Each step is idempotent (atomic whole-file rewrite). The journal records
  // completed steps so a crash before/after any single write never produces
  // duplicate output on resume.
  function step(name, fn) {
    crashPoint(`pre-${name}`);
    if (done.has(name)) return;
    fn();
    crashPoint(`post-${name}`);
    fs.appendFileSync(journalFile, `${name}\n`);
  }

  step('log', () => writeAtomic(path.join(out, 'log.ndjson'), result.logText));
  step('balance', () =>
    writeAtomic(path.join(out, 'balance.json'), `${JSON.stringify({ balance: result.balance }, null, 2)}\n`)
  );
  step('conflicts', () =>
    writeAtomic(
      path.join(out, 'conflict.json'),
      `${JSON.stringify({ conflicts: result.conflicts }, null, 2)}\n`
    )
  );

  fs.writeSync(
    1,
    `${JSON.stringify({
      events: result.log.length,
      balance: result.balance,
      conflicts: result.conflicts.length,
      hash: result.hash,
    })}\n`
  );
}

function cmdGen(args) {
  let seed = 17;
  let count = 200;
  let dir = '.';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed') seed = Number(args[++i]);
    else if (args[i] === '--count') count = Number(args[++i]);
    else if (args[i] === '--dir') dir = args[++i];
  }
  if (!Number.isInteger(seed) || !Number.isInteger(count) || count < 1) {
    fail(1, 'error: --seed and --count must be integers\n');
  }
  const sources = generate(seed, count);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.ndjson'), toNdjson(sources.a));
  fs.writeFileSync(path.join(dir, 'b.ndjson'), toNdjson(sources.b));
  fs.writeSync(1, `generated ${count} events per node in ${dir}\n`);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'merge') cmdMerge(rest);
else if (cmd === 'gen') cmdGen(rest);
else {
  fail(1, 'usage: node cli.js <merge|gen> ...\n');
}
