import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importFile,
  SourceModifiedError,
  type Checkpoint,
} from '../src/importer.js';

interface Fixture {
  dir: string;
  source: string;
  checkpoint: string;
  cleanup: () => void;
}

function fixture(content: string | Buffer): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'importer-'));
  const source = join(dir, 'source.txt');
  const checkpoint = join(dir, 'checkpoint.json');
  writeFileSync(source, content);
  return {
    dir,
    source,
    checkpoint,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function collect(records: string[]) {
  return (batch: string[]) => {
    records.push(...batch);
  };
}

test('saves byte offset and prefix digest after every record batch', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `record-${i}`);
  const f = fixture(lines.join('\n') + '\n');
  try {
    const seen: Checkpoint[] = [];
    const records: string[] = [];
    const result = importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 3,
      onBatch: (batch, cp) => {
        records.push(...batch);
        seen.push({ ...cp });
      },
    });

    assert.equal(result.complete, true);
    assert.equal(result.records, 10);
    assert.deepEqual(records, lines);
    assert.deepEqual(
      seen.map((c) => c.records),
      [3, 6, 9, 10],
    );
    // offsets are strictly increasing and the last one covers the whole file
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].offset > seen[i - 1].offset);
    }
    const size = Buffer.byteLength(lines.join('\n') + '\n');
    assert.equal(seen.at(-1)!.offset, size);
    for (const cp of seen) {
      assert.match(cp.digest, /^[0-9a-f]{64}$/);
    }
    // checkpoint file on disk matches the final in-memory state
    const onDisk = JSON.parse(readFileSync(f.checkpoint, 'utf8'));
    assert.equal(onDisk.offset, size);
    assert.equal(onDisk.records, 10);
    assert.equal(onDisk.digest, result.checkpoint.digest);
  } finally {
    f.cleanup();
  }
});

test('resume after pause continues without duplicating records', () => {
  const lines = Array.from({ length: 7 }, (_, i) => `line-${i}`);
  const f = fixture(lines.join('\n') + '\n');
  try {
    const records: string[] = [];
    const first = importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 2,
      maxBatches: 2, // pause after 4 records
      onBatch: collect(records),
    });
    assert.equal(first.complete, false);
    assert.equal(first.records, 4);
    assert.equal(first.resumed, false);

    const second = importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 2,
      onBatch: collect(records),
    });
    assert.equal(second.complete, true);
    assert.equal(second.resumed, true);
    assert.equal(second.records, 3);
    assert.deepEqual(records, lines);
  } finally {
    f.cleanup();
  }
});

test('tail append to the source allows the import to continue', () => {
  const f = fixture('a\nb\nc\n');
  try {
    const records: string[] = [];
    const first = importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 2,
      onBatch: collect(records),
    });
    assert.equal(first.complete, true);

    appendFileSync(f.source, 'd\ne\n');
    const second = importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 2,
      onBatch: collect(records),
    });
    assert.equal(second.complete, true);
    assert.equal(second.records, 2);
    assert.deepEqual(records, ['a', 'b', 'c', 'd', 'e']);
  } finally {
    f.cleanup();
  }
});

test('mid-file modification is rejected on resume', () => {
  const f = fixture('aaaa\nbbbb\ncccc\ndddd\n');
  try {
    importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 2,
      maxBatches: 1, // checkpoint after 'aaaa\nbbbb\n'
    });
    // flip one byte inside the already-consumed prefix, keep the length
    const buf = readFileSync(f.source);
    buf[1] = buf[1] === 0x61 ? 0x62 : 0x61;
    writeFileSync(f.source, buf);

    assert.throws(
      () => importFile(f.source, { checkpointPath: f.checkpoint, batchSize: 2 }),
      SourceModifiedError,
    );
  } finally {
    f.cleanup();
  }
});

test('replacing the source file is rejected on resume', () => {
  const f = fixture('alpha\nbeta\ngamma\n');
  try {
    importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 1,
      maxBatches: 2,
    });
    writeFileSync(f.source, 'alpha\nBETA\ngamma\ndelta\n'); // same prefix line, different body
    assert.throws(
      () => importFile(f.source, { checkpointPath: f.checkpoint, batchSize: 1 }),
      SourceModifiedError,
    );
  } finally {
    f.cleanup();
  }
});

test('truncated source is rejected on resume', () => {
  const f = fixture('one\ntwo\nthree\nfour\n');
  try {
    importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 2,
      maxBatches: 1,
    });
    writeFileSync(f.source, 'one\n'); // shorter than the checkpoint offset
    assert.throws(
      () => importFile(f.source, { checkpointPath: f.checkpoint, batchSize: 2 }),
      SourceModifiedError,
    );
  } finally {
    f.cleanup();
  }
});

test('byte-by-byte pause: multi-byte characters are never split or double-recorded', () => {
  const lines = ['你好，世界', 'héllo 🌍', '日本語テスト', 'emoji 👨‍👩‍👧‍👦 done'];
  const full = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const f = fixture(Buffer.alloc(0));
  try {
    const records: string[] = [];
    let runs = 0;
    // append one byte at a time, running (and checkpointing) the importer after each byte
    for (let i = 0; i < full.length; i++) {
      appendFileSync(f.source, full.subarray(i, i + 1));
      importFile(f.source, {
        checkpointPath: f.checkpoint,
        batchSize: 1,
        onBatch: collect(records),
      });
      runs += 1;
    }
    assert.equal(runs, full.length);
    assert.deepEqual(records, lines); // exact records, no duplicates, no splits

    // every persisted checkpoint offset sits on a record boundary
    const finalCp = JSON.parse(readFileSync(f.checkpoint, 'utf8'));
    assert.equal(finalCp.offset, full.length);
    assert.equal(finalCp.records, lines.length);
  } finally {
    f.cleanup();
  }
});

test('incomplete trailing record is held back until its newline arrives', () => {
  const f = fixture('ab\ncd');
  try {
    const records: string[] = [];
    const first = importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 10,
      onBatch: collect(records),
    });
    assert.equal(first.complete, false);
    assert.deepEqual(records, ['ab']);
    assert.equal(first.checkpoint.offset, 3); // 'cd' not consumed yet
    assert.equal(existsSync(f.checkpoint), true);

    appendFileSync(f.source, 'ef\n');
    const second = importFile(f.source, {
      checkpointPath: f.checkpoint,
      batchSize: 10,
      onBatch: collect(records),
    });
    assert.equal(second.complete, true);
    assert.deepEqual(records, ['ab', 'cdef']);
  } finally {
    f.cleanup();
  }
});
