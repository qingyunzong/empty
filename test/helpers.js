'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanDir } = require('../lib/scan');
const { scanHash } = require('../lib/hash');
const { fileNameForKey } = require('../lib/keys');
const { run } = require('../cli');

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  t.after(() => {
    try {
      for (const e of fs.readdirSync(d)) fs.chmodSync(path.join(d, e), 0o755);
    } catch {}
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
}

function makePair(t) {
  const root = tmpDir(t);
  const a = path.join(root, 'A');
  const b = path.join(root, 'B');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  return { root, a, b };
}

function keyOf(i) {
  const cur = ['USD', 'EUR', 'CNY'][i % 3];
  const day = String((i % 28) + 1).padStart(2, '0');
  return `m${String(i % 40).padStart(3, '0')}|2026-09-${day}|${cur}`;
}

function writeCsv(dir, key, content) {
  fs.writeFileSync(path.join(dir, fileNameForKey(key)), content);
}

function readCsv(dir, key) {
  return fs.readFileSync(path.join(dir, fileNameForKey(key)), 'utf8');
}

function existsCsv(dir, key) {
  return fs.existsSync(path.join(dir, fileNameForKey(key)));
}

function csvContent(tag, i) {
  return `merchant,date,currency,amount\nm,2026-09-01,USD,${tag}-${i}\n`;
}

function dirHash(dir) {
  return scanHash(scanDir(dir));
}

// In-process CLI invocation: returns {code, out, err}.
function callCli(args) {
  let out = '';
  let err = '';
  const code = run(args, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

function callCliJson(args) {
  const r = callCli(args);
  if (r.code !== 0 && r.code !== 61) throw new Error(`cli failed (${r.code}): ${r.err}`);
  return { ...r, json: JSON.parse(r.out) };
}

function syncDirs(a, b) {
  const plan = callCliJson(['plan', '--a', a, '--b', b]).json;
  const planFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')), 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const stats = callCliJson(['apply', '--plan', planFile]).json;
  return { plan, stats, planFile };
}

module.exports = { tmpDir, makePair, keyOf, writeCsv, readCsv, existsCsv, csvContent, dirHash, callCli, callCliJson, syncDirs };
