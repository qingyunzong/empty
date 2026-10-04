import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importFile, SourceModifiedError } from '../src/importer.js';
import type { Checkpoint } from '../src/importer.js';

interface Fixture {
  dir: string;
  source: string;
  checkpoint: string;
}

function makeFixture(content: string | Uint8Array): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'importer-test-'));
  const source = path.join(dir, 'source.txt');
  fs.writeFileSync(source, content);
  return { dir, source, checkpoint: path.join(dir, 'checkpoint.json') };
}

function readCheckpoint(fixture: Fixture): Checkpoint {
  return JSON.parse(fs.readFileSync(fixture.checkpoint, 'utf8')) as Checkpoint;
}

function isIncompleteUtf8(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

test('完整导入：按记录批次保存字节偏移与前缀摘要', () => {
  const lines = ['alpha', '中文记录一', 'emoji 🚀🌟', 'mixed 中a文b', '末行无换行'];
  const fixture = makeFixture(lines.join('\n'));
  const collected: string[] = [];

  const result = importFile({
    source: fixture.source,
    checkpoint: fixture.checkpoint,
    batchSize: 2,
    sink: (record) => collected.push(record),
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(collected, lines);
  assert.equal(result.records, lines.length);

  const checkpoint = readCheckpoint(fixture);
  assert.equal(checkpoint.offset, fs.statSync(fixture.source).size);
  assert.equal(checkpoint.records, lines.length);
  assert.equal(checkpoint.pending, '');
  assert.match(checkpoint.digest, /^[0-9a-f]{64}$/);
});

test('逐字节暂停与恢复：多字节字符跨检查点不重复记录', () => {
  const lines = ['中文字符行', '🚀🌟🌟', 'plain ascii', '混合 abc 中文 🚀 尾'];
  const content = lines.join('\n') + '\n';
  const fixture = makeFixture(content);
  const size = fs.statSync(fixture.source).size;

  const collected: string[] = [];
  let runs = 0;
  let sawSplitMultibyte = false;
  for (;;) {
    runs += 1;
    const result = importFile({
      source: fixture.source,
      checkpoint: fixture.checkpoint,
      batchSize: 1,
      byteBudget: 1,
      sink: (record) => collected.push(record),
    });
    if (result.status === 'paused') {
      const checkpoint = readCheckpoint(fixture);
      assert.equal(checkpoint.records, collected.length);
      if (isIncompleteUtf8(Buffer.from(checkpoint.pending, 'base64'))) {
        sawSplitMultibyte = true; // 检查点恰好落在多字节字符中间
      }
    } else {
      break;
    }
  }

  assert.equal(runs, size); // 每字节暂停一次，最后一字节消费完即完成
  assert.deepEqual(collected, lines); // 每条记录恰好一次，无重复、无残缺
  assert.ok(sawSplitMultibyte, '应当出现过检查点落在多字节字符中间的情况');
});

test('源尾追加可继续：旧记录不重复，新记录按序导入', () => {
  const first = ['第一行', 'second 🚀', '第三行'];
  const fixture = makeFixture(first.join('\n') + '\n');
  const collected: string[] = [];
  const sink = (record: string): void => {
    collected.push(record);
  };

  const initial = importFile({ source: fixture.source, checkpoint: fixture.checkpoint, batchSize: 2, sink });
  assert.equal(initial.status, 'completed');
  assert.deepEqual(collected, first);

  // 无新增内容时恢复：直接完成，不产生任何记录
  const noop = importFile({ source: fixture.source, checkpoint: fixture.checkpoint, sink });
  assert.equal(noop.status, 'completed');
  assert.equal(collected.length, first.length);

  // 源尾追加（含多字节、末行无换行）
  const extra = ['追加四', 'append 🌟 五'];
  fs.appendFileSync(fixture.source, extra.join('\n'));
  const resumed = importFile({ source: fixture.source, checkpoint: fixture.checkpoint, sink });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.records, first.length + extra.length);
  assert.deepEqual(collected, [...first, ...extra]);
});

test('中段修改必须拒绝：同长度篡改、整文件替换、截断', () => {
  const content = '中文记录一\n中文记录二\n中文记录三\n中文记录四\n';

  // 同长度篡改检查点之前的一个字节
  {
    const fixture = makeFixture(content);
    importFile({ source: fixture.source, checkpoint: fixture.checkpoint, byteBudget: 20 });
    const bytes = Buffer.from(fs.readFileSync(fixture.source, 'utf8'), 'utf8');
    bytes[1] = bytes[1]! ^ 0x01;
    fs.writeFileSync(fixture.source, bytes);
    assert.throws(
      () => importFile({ source: fixture.source, checkpoint: fixture.checkpoint }),
      (err: unknown) => err instanceof SourceModifiedError,
    );
  }

  // 整文件替换为同长度内容
  {
    const fixture = makeFixture(content);
    importFile({ source: fixture.source, checkpoint: fixture.checkpoint, byteBudget: 20 });
    fs.writeFileSync(fixture.source, '替换了记录\n替换了记录\n替换了记录\n替换了记录\n');
    assert.throws(
      () => importFile({ source: fixture.source, checkpoint: fixture.checkpoint }),
      SourceModifiedError,
    );
  }

  // 截断到检查点偏移之下
  {
    const fixture = makeFixture(content);
    importFile({ source: fixture.source, checkpoint: fixture.checkpoint, byteBudget: 20 });
    fs.writeFileSync(fixture.source, '短\n');
    assert.throws(
      () => importFile({ source: fixture.source, checkpoint: fixture.checkpoint }),
      SourceModifiedError,
    );
  }
});

test('篡改检查点之后、追加新行仍可继续（视为源尾数据）', () => {
  const fixture = makeFixture('第一\n第二\n第三\n');
  const collected: string[] = [];
  const sink = (record: string): void => {
    collected.push(record);
  };
  const paused = importFile({ source: fixture.source, checkpoint: fixture.checkpoint, byteBudget: 8, sink });
  assert.equal(paused.status, 'paused');

  // 偏移之后的字节对导入器而言属于“尚未读取的尾部”，允许变化
  fs.appendFileSync(fixture.source, '第四 🚀\n');
  const resumed = importFile({ source: fixture.source, checkpoint: fixture.checkpoint, sink });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(collected, ['第一', '第二', '第三', '第四 🚀']);
});
