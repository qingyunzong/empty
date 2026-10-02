import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/merge.js';
import { sha256Hex } from '../src/certificate.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'obs3merge-'));
  const write = (name, obj) => {
    const p = path.join(dir, name);
    writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };
  return { dir, write, out: path.join(dir, 'out') };
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('clean merge: exit 0, merged.json and certificate.json written', () => {
  const { dir, write, out } = setup();
  try {
    const base = write('base.json', { o1: { value: 1, unit: 'm' }, o2: { value: 2 } });
    const left = write('left.json', { o1: { value: 10, unit: 'm' }, o2: { value: 2 } });
    const right = write('right.json', { o1: { value: 1, unit: 'cm' }, o2: { value: 2 } });
    const res = runCli(['merge', base, left, right, '--out', out]);

    assert.equal(res.status, 0, res.stderr);
    const merged = JSON.parse(readFileSync(path.join(out, 'merged.json'), 'utf8'));
    assert.deepEqual(merged, { o1: { value: 10, unit: 'cm' }, o2: { value: 2 } });

    const cert = JSON.parse(readFileSync(path.join(out, 'certificate.json'), 'utf8'));
    assert.equal(cert.algorithm, 'sha256');
    assert.equal(cert.recordCount, 2);
    assert.equal(cert.mergedDigest, sha256Hex(canonicalJson(merged)));
    assert.equal(cert.inputs.base, sha256Hex(readFileSync(base, 'utf8')));
    assert.ok(!existsSync(path.join(out, 'conflicts.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conflicting merge: exit 2, conflicts.json written, no merged.json/certificate.json', () => {
  const { dir, write, out } = setup();
  try {
    const base = write('base.json', { o1: { value: 1 } });
    const left = write('left.json', { o1: { value: 2 } });
    const right = write('right.json', { o1: { value: 3 } });
    const res = runCli(['merge', base, left, right, '--out', out]);

    assert.equal(res.status, 2, res.stderr);
    const report = JSON.parse(readFileSync(path.join(out, 'conflicts.json'), 'utf8'));
    assert.equal(report.conflictCount, 1);
    assert.equal(report.conflicts[0].type, 'both-modified');
    assert.equal(report.conflicts[0].field, 'value');
    assert.ok(!existsSync(path.join(out, 'merged.json')));
    assert.ok(!existsSync(path.join(out, 'certificate.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modify-delete conflict via CLI: exit 2 and classified', () => {
  const { dir, write, out } = setup();
  try {
    const base = write('base.json', { o1: { value: 1 } });
    const left = write('left.json', { o1: { value: 2 } });
    const right = write('right.json', {});
    const res = runCli(['merge', base, left, right, '--out', out]);

    assert.equal(res.status, 2, res.stderr);
    const report = JSON.parse(readFileSync(path.join(out, 'conflicts.json'), 'utf8'));
    assert.equal(report.conflicts[0].type, 'modify-delete');
    assert.ok(!existsSync(path.join(out, 'merged.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty inputs merge cleanly to empty output', () => {
  const { dir, write, out } = setup();
  try {
    const base = write('base.json', {});
    const left = write('left.json', {});
    const right = write('right.json', {});
    const res = runCli(['merge', base, left, right, '--out', out]);

    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'merged.json'), 'utf8')), {});
    const cert = JSON.parse(readFileSync(path.join(out, 'certificate.json'), 'utf8'));
    assert.equal(cert.recordCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid usage exits 1', () => {
  const res = runCli(['merge']);
  assert.equal(res.status, 1);
  const res2 = runCli(['bogus', 'a', 'b', 'c', '--out', 'd']);
  assert.equal(res2.status, 1);
});

test('unreadable or invalid json exits 1', () => {
  const { dir, write, out } = setup();
  try {
    const base = write('base.json', {});
    const res = runCli(['merge', base, path.join(dir, 'nope.json'), base, '--out', out]);
    assert.equal(res.status, 1);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    const res2 = runCli(['merge', base, bad, base, '--out', out]);
    assert.equal(res2.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
