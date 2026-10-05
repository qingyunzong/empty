import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docFromText, docFromValue, type JsonDocument } from '../src/jsonpos.js';
import { loadInputDocs } from '../src/loader.js';
import { evaluateField, verify, type Evidence, type VerifyReport } from '../src/verify.js';

const FIXTURE_DIR = join(process.cwd(), 'fixtures', 'baseline');

// ---------- 工具 ----------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BaselineValues {
  manifest: any;
  trajectories: any;
  fileSummaries: any;
}

function baselineValues(): BaselineValues {
  const read = (f: string) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8'));
  return { manifest: read('manifest.json'), trajectories: read('trajectories.json'), fileSummaries: read('file-summaries.json') };
}

interface Docs {
  manifest: JsonDocument;
  trajectories: JsonDocument;
  fileSummaries: JsonDocument;
}

function docsFromValues(v: BaselineValues): Docs {
  return {
    manifest: docFromValue('manifest.json', v.manifest),
    trajectories: docFromValue('trajectories.json', v.trajectories),
    fileSummaries: docFromValue('file-summaries.json', v.fileSummaries),
  };
}

function verifyValues(v: BaselineValues): VerifyReport {
  const d = docsFromValues(v);
  return verify(d.manifest, d.trajectories, d.fileSummaries);
}

function ev(source: Evidence['source'], key: string): Evidence {
  return {
    source,
    value: key,
    key,
    citation: { file: `${source}.json`, pointer: '/x', range: { start: { line: 1, col: 1, offset: 0 }, end: { line: 1, col: 2, offset: 1 } } },
  };
}

// ---------- 基准 ----------

test('基准夹具：全部检查一致，无孤儿运行', () => {
  const docs = loadInputDocs(FIXTURE_DIR);
  const report = verify(docs.manifest, docs.trajectories, docs.fileSummaries);
  assert.equal(report.summary.total, 9); // 3 项 × 3 字段
  assert.equal(report.summary.consistent, 9);
  assert.equal(report.summary.unknown, 0);
  assert.equal(report.summary.conflict, 0);
  assert.equal(report.summary.orphans, 0);
});

// ---------- evaluateField 单元 ----------

test('evaluateField：取值全同 -> 一致', () => {
  const c = evaluateField('i', 'r', 'problemSummary', [ev('manifest', 'a'), ev('trajectory', 'a'), ev('fileSummary', 'a')], []);
  assert.equal(c.status, 'consistent');
  assert.equal(c.conflictPairs.length, 0);
});

test('evaluateField：缺失证据 -> 未知（不判冲突）', () => {
  const c = evaluateField('i', 'r', 'problemSummary', [ev('manifest', 'a'), null, ev('fileSummary', 'b')], [
    { source: 'trajectory', file: 'trajectories.json', reason: '缺运行' },
  ]);
  assert.equal(c.status, 'unknown');
  assert.equal(c.conflictPairs.length, 0);
  assert.equal(c.missing.length, 1);
});

test('evaluateField：2+1 分歧 -> 恰 1 对最小冲突对', () => {
  const c = evaluateField('i', 'r', 'problemSummary', [ev('manifest', 'a'), ev('trajectory', 'b'), ev('fileSummary', 'a')], []);
  assert.equal(c.status, 'conflict');
  assert.equal(c.conflictPairs.length, 1);
  const pair = c.conflictPairs[0]!;
  assert.notEqual(pair.a.key, pair.b.key);
});

test('evaluateField：三方各异 -> 恰 3 对最小冲突对（C(3,2)）', () => {
  const c = evaluateField('i', 'r', 'problemSummary', [ev('manifest', 'a'), ev('trajectory', 'b'), ev('fileSummary', 'c')], []);
  assert.equal(c.status, 'conflict');
  assert.equal(c.conflictPairs.length, 3);
});

// ---------- 定向篡改 ----------

test('篡改轨迹题面摘要 -> 冲突，冲突对引用被篡改文件且引用范围可定位原文', () => {
  const v = baselineValues();
  v.trajectories.runs[1].problemSummary = '被篡改的题面摘要';
  const docs = docsFromValues(v);
  const report = verify(docs.manifest, docs.trajectories, docs.fileSummaries);
  assert.equal(report.summary.conflict, 1);
  const check = report.checks.find((c) => c.field === 'problemSummary' && c.runId === 'run-002')!;
  assert.equal(check.status, 'conflict');
  assert.equal(check.conflictPairs.length, 1); // 清单与文件摘要同组 -> 仅 1 对
  const pair = check.conflictPairs[0]!;
  const trajSide = [pair.a, pair.b].find((e) => e.source === 'trajectory')!;
  assert.equal(trajSide.citation.file, 'trajectories.json');
  // 引用范围能在原文中切出被篡改的取值
  const { start, end } = trajSide.citation.range;
  const slice = docs.trajectories.text.slice(start.offset, end.offset);
  assert.equal(slice, JSON.stringify('被篡改的题面摘要'));
});

test('三方题面摘要各异 -> 3 对最小冲突对', () => {
  const v = baselineValues();
  v.manifest.items[0].problemSummary = '摘要甲';
  v.trajectories.runs[0].problemSummary = '摘要乙';
  v.fileSummaries.runs[0].problemSummary = '摘要丙';
  const report = verifyValues(v);
  const check = report.checks.find((c) => c.field === 'problemSummary' && c.runId === 'run-001')!;
  assert.equal(check.status, 'conflict');
  assert.equal(check.conflictPairs.length, 3);
});

test('篡改轨迹阶段来源 -> 阶段来源冲突', () => {
  const v = baselineValues();
  v.trajectories.runs[2].stages[1].source = 'plan-tampered';
  const report = verifyValues(v);
  const check = report.checks.find((c) => c.field === 'stageSources' && c.runId === 'run-003')!;
  assert.equal(check.status, 'conflict');
  assert.equal(check.conflictPairs.length, 1);
});

test('篡改文件摘要 itemId -> 运行ID 链式冲突', () => {
  const v = baselineValues();
  v.fileSummaries.runs[0].itemId = 'item-999';
  const report = verifyValues(v);
  const check = report.checks.find((c) => c.field === 'runId' && c.runId === 'run-001')!;
  assert.equal(check.status, 'conflict');
});

// ---------- 验收：随机篡改 ----------

test('验收·随机篡改：60 轮随机篡改均被判为冲突且定位到被篡改文件', () => {
  const rand = mulberry32(20261005);
  const docNames = ['manifest.json', 'trajectories.json', 'file-summaries.json'] as const;
  for (let iter = 0; iter < 60; iter++) {
    const v = baselineValues();
    const runIdx = Math.floor(rand() * 3);
    const runId = v.manifest.items[runIdx].runId as string;
    const kind = Math.floor(rand() * 5);
    const tag = `tamper-${iter}`;
    let tamperedFile: string;
    switch (kind) {
      case 0:
        v.manifest.items[runIdx].problemSummary += ` ${tag}`;
        tamperedFile = 'manifest.json';
        break;
      case 1:
        v.trajectories.runs[runIdx].problemSummary += ` ${tag}`;
        tamperedFile = 'trajectories.json';
        break;
      case 2:
        v.fileSummaries.runs[runIdx].problemSummary += ` ${tag}`;
        tamperedFile = 'file-summaries.json';
        break;
      case 3: {
        const stages = v.trajectories.runs[runIdx].stages;
        stages[Math.floor(rand() * stages.length)].source += `-${tag}`;
        tamperedFile = 'trajectories.json';
        break;
      }
      default: {
        const ss = v.manifest.items[runIdx].stageSources;
        ss[Math.floor(rand() * ss.length)] += `-${tag}`;
        tamperedFile = 'manifest.json';
      }
    }
    assert.ok(docNames.includes(tamperedFile as (typeof docNames)[number]));
    const report = verifyValues(v);
    assert.ok(report.summary.conflict >= 1, `第 ${iter} 轮篡改未检出冲突`);
    const hit = report.checks.some(
      (c) =>
        c.status === 'conflict' &&
        c.runId === runId &&
        c.conflictPairs.some((p) => p.a.citation.file === tamperedFile || p.b.citation.file === tamperedFile),
    );
    assert.ok(hit, `第 ${iter} 轮冲突对未引用被篡改文件 ${tamperedFile}`);
  }
});

// ---------- 验收：删项 ----------

test('验收·删项：删除清单条目 -> 对应运行成孤儿（未知），不产生冲突', () => {
  for (let i = 0; i < 3; i++) {
    const v = baselineValues();
    const runId = v.manifest.items[i].runId as string;
    v.manifest.items.splice(i, 1);
    const report = verifyValues(v);
    assert.equal(report.summary.conflict, 0);
    assert.equal(report.summary.orphans, 2); // 轨迹 + 文件摘要各一条
    assert.ok(report.orphans.every((o) => o.runId === runId && o.status === 'unknown'));
    assert.ok(!report.checks.some((c) => c.runId === runId));
  }
});

test('验收·删项：删除轨迹运行 -> 该运行 3 项检查全部未知，不产生冲突', () => {
  for (let i = 0; i < 3; i++) {
    const v = baselineValues();
    const runId = v.trajectories.runs[i].runId as string;
    v.trajectories.runs.splice(i, 1);
    const report = verifyValues(v);
    assert.equal(report.summary.conflict, 0);
    const affected = report.checks.filter((c) => c.runId === runId);
    assert.equal(affected.length, 3);
    assert.ok(affected.every((c) => c.status === 'unknown'));
    assert.ok(affected.every((c) => c.missing.some((m) => m.source === 'trajectory')));
  }
});

test('验收·删项：删除文件摘要运行 -> 运行ID/题面摘要未知，阶段来源仍一致', () => {
  const v = baselineValues();
  v.fileSummaries.runs.splice(1, 1);
  const report = verifyValues(v);
  assert.equal(report.summary.conflict, 0);
  const byField = (f: string) => report.checks.find((c) => c.runId === 'run-002' && c.field === f)!;
  assert.equal(byField('runId').status, 'unknown');
  assert.equal(byField('problemSummary').status, 'unknown');
  assert.equal(byField('stageSources').status, 'consistent');
});

test('验收·随机删项：30 轮随机删除均标未知且零冲突', () => {
  const rand = mulberry32(11223344);
  for (let iter = 0; iter < 30; iter++) {
    const v = baselineValues();
    const which = Math.floor(rand() * 3);
    if (which === 0) v.manifest.items.splice(Math.floor(rand() * v.manifest.items.length), 1);
    else if (which === 1) v.trajectories.runs.splice(Math.floor(rand() * v.trajectories.runs.length), 1);
    else v.fileSummaries.runs.splice(Math.floor(rand() * v.fileSummaries.runs.length), 1);
    const report = verifyValues(v);
    assert.equal(report.summary.conflict, 0, `第 ${iter} 轮删项误报冲突`);
    assert.ok(report.summary.unknown >= 1 || report.summary.orphans >= 1, `第 ${iter} 轮删项未标未知`);
  }
});

// ---------- 引用范围 ----------

test('引用范围：指针与行列偏移可精确切出原始 JSON 片段', () => {
  const text = '{\n  "a": "hello",\n  "b": [1, true, null]\n}';
  const doc = docFromText('t.json', text);
  const sliceAt = (ptr: string) => {
    const r = doc.ranges.get(ptr)!;
    return text.slice(r.start.offset, r.end.offset);
  };
  assert.equal(sliceAt('/a'), '"hello"');
  assert.equal(sliceAt('/b'), '[1, true, null]');
  assert.equal(sliceAt('/b/1'), 'true');
  const ra = doc.ranges.get('/a')!;
  assert.equal(ra.start.line, 2);
  assert.equal(ra.start.col, 8);
});
