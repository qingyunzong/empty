import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AlertStore } from '../src/store.js';
import { HEADER_SIZE } from '../src/segment.js';
import { tmpdir, cleanup } from './helpers.js';

test('one corrupted byte inside a segment produces E_CRC', async () => {
  const dir = await tmpdir();
  try {
    const store = await AlertStore.open(dir);
    await store.appendBatch([
      { device: 'dev-1', seq: 1, severity: 'info', message: 'hello' },
      { device: 'dev-1', seq: 2, severity: 'info', message: 'world' },
    ]);
    await store.close();

    const segFile = path.join(dir, 'segments', 'seg-000001.dat');
    const buf = await fs.readFile(segFile);
    buf[HEADER_SIZE + 10] ^= 0xff; // flip one byte inside the first chunk
    await fs.writeFile(segFile, buf);

    await assert.rejects(AlertStore.open(dir), (err) => {
      assert.equal(err.code, 'E_CRC');
      return true;
    });
  } finally {
    await cleanup(dir);
  }
});
