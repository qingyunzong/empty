import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../src/cli.js';
import { loadState, logicalIndex, compareIds } from '../src/store.js';
import { tokenize } from '../src/text.js';
import { decodePositions } from '../src/varint.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wo-'));
}

function cli(args, input = '') {
  return runCli(args, input);
}

function add(dir, docs) {
  const input = docs.map(([id, text]) => JSON.stringify({ id, text })).join('\n') + '\n';
  const r = cli(['add', '--dir', dir], input);
  assert.equal(r.code, 0, JSON.stringify(r.lines));
  return r.lines[0];
}

function del(dir, ids) {
  const input = ids.map((id) => JSON.stringify({ id })).join('\n') + '\n';
  return cli(['del', '--dir', dir], input);
}

function query(dir, qs) {
  const input = qs.map((q) => JSON.stringify({ q })).join('\n') + '\n';
  return cli(['query', '--dir', dir], input);
}

// Independent brute-force reference: naive scan over tokenized docs.
function bruteForce(docs, q) {
  const live = docs.filter((d) => !d.deleted);
  const parts = q.trim().split(/\s+/);
  const hits = new Map();
  const near = parts.length === 3 && /^NEAR\/(\d+)$/.test(parts[1]);
  for (const d of live) {
    const toks = tokenize(d.text);
    const found = [];
    if (near) {
      const k = Number(parts[1].split('/')[1]);
      const t1 = tokenize(parts[0])[0];
      const t2 = tokenize(parts[2])[0];
      for (let i = 0; i < toks.length; i++) {
        for (let j = 0; j < toks.length; j++) {
          if (toks[i] === t1 && toks[j] === t2 && Math.abs(i - j) <= k) found.push([i, j]);
        }
      }
    } else {
      const phrase = tokenize(q);
      outer: for (let i = 0; i + phrase.length <= toks.length; i++) {
        for (let j = 0; j < phrase.length; j++) {
          if (toks[i + j] !== phrase[j]) continue outer;
        }
        found.push(i);
      }
    }
    if (found.length) hits.set(d.id, found);
  }
  return [...hits.entries()]
    .map(([id, h]) => ({ id, hits: h }))
    .sort((a, b) => b.hits.length - a.hits.length || compareIds(a.id, b.id));
}

const CORPUS = [
  ['wo1', '轴承 过热 停机 检查 润滑'],
  ['wo2', '电机 轴承 过热 更换 润滑脂'],
  ['wo3', '泵体 泄漏 密封圈 老化'],
  ['wo4', '轴承 温度 正常 过热 报警 未触发'],
  ['wo5', '齿轮箱 异响 轴承 过热 轴承 损坏'],
  ['wo6', '轴承 过热 轴承 过热 复检 确认'],
  ['wo7', '过热 轴承 顺序 相反 不应 匹配'],
  ['wo8', '液压站 压力 波动 滤芯 堵塞'],
];

test('acceptance 1: phrase/NEAR results and tie ordering match brute force', () => {
  const dir = tmpdir();
  // 4 batches -> exercises multi-segment layout and incremental merge
  add(dir, CORPUS.slice(0, 2));
  add(dir, CORPUS.slice(2, 4));
  add(dir, CORPUS.slice(4, 6));
  add(dir, CORPUS.slice(6, 8));

  const queries = [
    '轴承 过热',
    '过热',
    '轴承 过热 轴承',
    '轴承 NEAR/1 过热',
    '轴承 NEAR/2 过热',
    '轴承 NEAR/3 过热',
    '润滑 NEAR/2 检查',
    '不存在 词项',
  ];
  const r = query(dir, queries);
  assert.equal(r.code, 0);
  assert.equal(r.lines.length, queries.length);
  queries.forEach((q, i) => {
    const expected = bruteForce(CORPUS.map(([id, text]) => ({ id, text })), q);
    assert.deepEqual(r.lines[i].results, expected, `query: ${q}`);
  });

  // tie ordering: '轴承 过热' hits wo6 twice, wo1/wo2/wo5 once each
  const phrase = r.lines[0].results;
  assert.deepEqual(phrase.map((x) => x.id), ['wo6', 'wo1', 'wo2', 'wo5']);
  assert.equal(phrase[0].hits.length, 2);
});

test('acceptance 2: del -> query empty -> undo -> results restored', () => {
  const dir = tmpdir();
  const before = add(dir, [['wo1', '轴承 过热 停机'], ['wo2', '泵 泄漏']]);
  let r = query(dir, ['轴承 过热']);
  assert.deepEqual(r.lines[0].results.map((x) => x.id), ['wo1']);

  const d = del(dir, ['wo1']);
  assert.equal(d.code, 0);
  r = query(dir, ['轴承 过热']);
  assert.deepEqual(r.lines[0].results, []);

  const u = cli(['undo', '--dir', dir]);
  assert.equal(u.code, 0);
  assert.equal(u.lines[0].head, 1);
  assert.equal(u.lines[0].hash, before.hash, 'hash restored to pre-del value');
  r = query(dir, ['轴承 过热']);
  assert.deepEqual(r.lines[0].results.map((x) => x.id), ['wo1']);
});

test('acceptance 3: cross-batch undo, hash equals replay, varint postings consistent', () => {
  const dir = tmpdir();
  add(dir, [['d1', '轴承 过热'], ['d2', '泵 泄漏']]);       // batch 1
  const b2 = add(dir, [['d3', '齿轮箱 异响 轴承']]);          // batch 2
  del(dir, ['d1']);                                           // batch 3
  add(dir, [['d4', '轴承 过热 复检'], ['d5', '过热 轴承']]); // batch 4

  const u = cli(['undo', '--dir', dir, '--to', '2']);
  assert.equal(u.code, 0);
  assert.equal(u.lines[0].head, 2);
  assert.equal(u.lines[0].hash, b2.hash, 'undo replay hash == hash after batch 2');

  // d1 alive again, d4/d5 gone
  const r = query(dir, ['轴承 过热', '异响']);
  assert.deepEqual(r.lines[0].results.map((x) => x.id), ['d1']);
  assert.deepEqual(r.lines[1].results.map((x) => x.id), ['d3']);

  // verify passes after undo
  const v = cli(['verify', '--dir', dir]);
  assert.equal(v.code, 0);
  assert.equal(v.lines[0].hash, b2.hash);

  // varint-compressed postings on disk decode to the in-memory logical index
  const state = loadState(dir);
  const logical = logicalIndex(state);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const decoded = {};
  for (const m of meta.segments) {
    const seg = JSON.parse(fs.readFileSync(path.join(dir, 'segments', m.file), 'utf8'));
    for (const [term, docs] of Object.entries(seg.postings)) {
      for (const [doc, b64] of Object.entries(docs)) {
        (decoded[term] ??= {})[doc] = decodePositions(Buffer.from(b64, 'base64'));
      }
    }
  }
  assert.deepEqual(decoded, logical);
  assert.deepEqual(decoded['轴承']['d1'], [0]);
  assert.deepEqual(decoded['过热']['d1'], [1]);
});

test('acceptance 4: tampered log -> verify reports E_CORRUPT', () => {
  const dir = tmpdir();
  add(dir, [['wo1', '轴承 过热 停机']]);
  add(dir, [['wo2', '泵 泄漏']]);

  const good = cli(['verify', '--dir', dir]);
  assert.equal(good.lines[0].ok, true);

  const logPath = path.join(dir, 'batches.log');
  const tampered = fs.readFileSync(logPath, 'utf8').replace('轴承', '齿轮');
  assert.notEqual(tampered, fs.readFileSync(logPath, 'utf8'));
  fs.writeFileSync(logPath, tampered);

  const bad = cli(['verify', '--dir', dir]);
  assert.equal(bad.code, 1);
  assert.equal(bad.lines[0].ok, false);
  assert.equal(bad.lines[0].error.code, 'E_CORRUPT');

  // tampering state.json hash is also detected
  const dir2 = tmpdir();
  add(dir2, [['wo1', '轴承 过热']]);
  const statePath = path.join(dir2, 'state.json');
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  st.indexHash = '0'.repeat(64);
  fs.writeFileSync(statePath, JSON.stringify(st));
  const bad2 = cli(['verify', '--dir', dir2]);
  assert.equal(bad2.code, 1);
  assert.equal(bad2.lines[0].error.code, 'E_CORRUPT');
});

test('errors are coded and leave state unchanged', () => {
  const dir = tmpdir();
  const before = add(dir, [['wo1', '轴承 过热']]);

  let r = del(dir, ['nope']);
  assert.equal(r.code, 1);
  assert.equal(r.lines[0].error.code, 'E_NOTFOUND');

  r = cli(['add', '--dir', dir], '{not json}\n');
  assert.equal(r.code, 1);
  assert.equal(r.lines[0].error.code, 'E_PARSE');

  r = cli(['undo', '--dir', dir, '--to', '9']);
  assert.equal(r.code, 1);
  assert.equal(r.lines[0].error.code, 'E_UNDO');

  r = query(dir, ['轴承 NEAR/2']);
  assert.equal(r.code, 1);
  assert.equal(r.lines[0].error.code, 'E_PARSE');

  const v = cli(['verify', '--dir', dir]);
  assert.equal(v.lines[0].ok, true);
  assert.equal(v.lines[0].hash, before.hash);
});
