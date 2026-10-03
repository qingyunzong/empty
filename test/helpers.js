'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../src/cli');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
}

// Run the CLI in-process (same semantics as `node src/cli.js ...`).
function cli(args) {
  const r = execute(args.map(String));
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.code, stdout: r.stdout, stderr: r.stderr, json };
}

function writeConfig(dir, config) {
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

function readFile(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function snapshotOf(dir) {
  return JSON.parse(readFile(path.join(dir, 'state.json')));
}

// Seeded PRNG (mulberry32) for reproducible tests.
function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { tmpDir, cli, writeConfig, readFile, snapshotOf, prng };
