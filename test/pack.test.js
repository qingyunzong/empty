'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PackWriter } = require('../src/writer');
const { readPack, readFileIndex } = require('../src/reader');
const { Decoder } = require('../src/decoder');
const { canonicalLine } = require('../src/canonical');
const {
  BLOCK_DICT,
  BLOCK_RECORDS,
  BLOCK_HEADER_LEN,
  parseBlockHeader,
  encodeDictBlockPayload,
  encodeRecordBlockPayload,
  assembleFile,
} = require('../src/format');

const { run: cliRun } = require('../cli');

// Runs the CLI in-process (the sandbox forbids spawning child processes),
// capturing stdout/stderr lines and the exit code.
function runCli(...args) {
  const stdout = [];
  const stderr = [];
  const code = cliRun(args, {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ptag-'));
}

const TAGS = [
  { gtin: '06901234567890', batch: 'B2026-01', serial: 'SN-0001', station: '工位A', time: '2026-10-01T08:00:00.000Z' },
  { gtin: '06901234567890', batch: 'B2026-01', serial: 'SN-0002', station: '工位A', time: '2026-10-01T08:00:03.500Z' },
  { gtin: '06901234567890', batch: 'B2026-01', serial: 'SN-0003', station: '工位B-✂', time: '2026-10-01T08:00:07.250Z' },
  { gtin: '06998765432109', batch: 'B2026-02', serial: 'SN-0004', station: '工位B-✂', time: '2026-10-01T09:15:00.000Z' },
  { gtin: '06998765432109', batch: 'B2026-02', serial: 'SN-0005', station: '包装-Ω-漢字', time: '2026-10-01T09:15:01.000Z' },
];

// Independent canonical enumeration, computed test-side from the source tags.
function expectedLines(tags) {
  return tags.map((t) =>
    JSON.stringify({
      batch: t.batch,
      gtin: t.gtin,
      serial: t.serial,
      station: t.station,
      time: new Date(t.time).toISOString(),
    })
  );
}

function writePack(file, groups) {
  const writer = new PackWriter(file);
  for (const group of groups) {
    for (const tag of group) writer.addTag(tag);
    writer.flush();
  }
  writer.close();
}

test('roundtrip: records match independent canonical JSON enumeration', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'tags.ptp');
  // Two flushes: second group introduces new dict values -> dict v2.
  writePack(file, [TAGS.slice(0, 3), TAGS.slice(3)]);

  const { records, errors, dictVersions } = readPack(file);
  assert.deepEqual(errors, []);
  assert.deepEqual(dictVersions, [1, 2]);
  assert.deepEqual(records.map(canonicalLine), expectedLines(TAGS));
});

test('streaming decoder: split inside a multi-byte UTF-8 char restores fully', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'utf8.ptp');
  writePack(file, [TAGS]);
  const buf = fs.readFileSync(file);

  const scissors = Buffer.from('✂', 'utf8'); // 3-byte sequence
  const at = buf.indexOf(scissors);
  assert.ok(at > 0, 'multi-byte char must exist in the file');
  const cut = at + 1; // inside the 3-byte sequence

  for (const chunks of [
    [buf.subarray(0, cut), buf.subarray(cut)],
    [...buf], // byte-by-byte
  ]) {
    const records = [];
    const errors = [];
    const decoder = new Decoder({
      onRecord: (r) => records.push(r),
      onError: (e) => errors.push(e),
    });
    for (const chunk of chunks) {
      decoder.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from([chunk]));
    }
    decoder.end();
    assert.deepEqual(errors, []);
    assert.deepEqual(records.map(canonicalLine), expectedLines(TAGS));
    assert.ok(!JSON.stringify(records).includes('�'), 'no replacement chars');
  }
});

test('corrupt old dictionary only affects records bound to it', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'corrupt-dict.ptp');
  writePack(file, [TAGS.slice(0, 3), TAGS.slice(3)]);

  // Locate dict v1 block via the random-access index and flip a payload byte.
  const buf = fs.readFileSync(file);
  const index = readFileIndex(buf);
  const dictV1 = index.find((e) => e.type === BLOCK_DICT && e.version === 1);
  assert.ok(dictV1, 'dict v1 block must exist');
  const payloadStart = dictV1.offset + BLOCK_HEADER_LEN;
  buf[payloadStart + 8] ^= 0xff; // inside first string bytes
  fs.writeFileSync(file, buf);

  const { records, errors } = readPack(file);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((e) => e.code === 'E_DICT' && e.dictVersion === 1));
  const recordErrors = errors.filter((e) => e.recordIndex != null);
  assert.equal(recordErrors.length, 3); // exactly the three v1-bound records
  // Records bound to dict v2 remain fully readable.
  assert.deepEqual(records.map(canonicalLine), expectedLines(TAGS.slice(3)));

  // Same result through the incremental decoder.
  const streamRecords = [];
  const streamErrors = [];
  const decoder = new Decoder({
    onRecord: (r) => streamRecords.push(r),
    onError: (e) => streamErrors.push(e),
  });
  decoder.feed(fs.readFileSync(file));
  decoder.end();
  assert.deepEqual(streamRecords.map(canonicalLine), expectedLines(TAGS.slice(3)));
  assert.ok(streamErrors.every((e) => e.code === 'E_DICT'));
});

test('corrupt record block yields E_CRC', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'corrupt-rec.ptp');
  writePack(file, [TAGS]);

  const buf = fs.readFileSync(file);
  const index = readFileIndex(buf);
  const recBlock = index.find((e) => e.type === BLOCK_RECORDS);
  const payloadStart = recBlock.offset + BLOCK_HEADER_LEN;
  buf[payloadStart + 20] ^= 0x01;
  fs.writeFileSync(file, buf);

  const { records, errors } = readPack(file);
  assert.equal(records.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'E_CRC');
});

test('unknown dictionary reference yields E_DICTREF', () => {
  const dir = tmpdir();

  // Record references a dict id that does not exist in v1.
  const dictPayload = encodeDictBlockPayload({
    version: 1,
    entries: [
      { field: 'gtin', id: 1, value: '06901234567890' },
      { field: 'batch', id: 1, value: 'B1' },
      { field: 'station', id: 1, value: 'S1' },
    ],
  });
  const badIdPayload = encodeRecordBlockPayload({
    dictVersion: 1,
    baseTime: 1000,
    records: [{ gtinId: 99, batchId: 1, stationId: 1, serial: 'SN-X', timeMs: 1000 }],
  });
  const file1 = path.join(dir, 'badid.ptp');
  fs.writeFileSync(
    file1,
    assembleFile([
      { type: BLOCK_DICT, version: 1, payload: dictPayload },
      { type: BLOCK_RECORDS, version: 1, payload: badIdPayload },
    ])
  );
  const res1 = readPack(file1);
  assert.equal(res1.records.length, 0);
  assert.equal(res1.errors.length, 1);
  assert.equal(res1.errors[0].code, 'E_DICTREF');

  // Record bound to a dict version that was never written.
  const badVerPayload = encodeRecordBlockPayload({
    dictVersion: 7,
    baseTime: 1000,
    records: [{ gtinId: 1, batchId: 1, stationId: 1, serial: 'SN-Y', timeMs: 1000 }],
  });
  const file2 = path.join(dir, 'badver.ptp');
  fs.writeFileSync(
    file2,
    assembleFile([
      { type: BLOCK_DICT, version: 1, payload: dictPayload },
      { type: BLOCK_RECORDS, version: 7, payload: badVerPayload },
    ])
  );
  const res2 = readPack(file2);
  assert.equal(res2.records.length, 0);
  assert.equal(res2.errors.length, 1);
  assert.equal(res2.errors[0].code, 'E_DICTREF');
});

test('new dict version takes effect via manifest temp file + rename', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'manifest.ptp');
  writePack(file, [TAGS.slice(0, 3), TAGS.slice(3)]);

  const manifestPath = `${file}.manifest.json`;
  assert.ok(fs.existsSync(manifestPath), 'manifest must exist');
  assert.ok(!fs.existsSync(`${manifestPath}.tmp`), 'temp file must be renamed away');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.latest, 2);
  assert.deepEqual(
    manifest.versions.map((v) => v.version),
    [1, 2]
  );

  // Manifest offsets must point at the actual dict blocks in the index.
  const index = readFileIndex(fs.readFileSync(file));
  const dictOffsets = index.filter((e) => e.type === BLOCK_DICT).map((e) => e.offset);
  assert.deepEqual(
    manifest.versions.map((v) => v.offset),
    dictOffsets
  );
  for (const v of manifest.versions) {
    const hdr = parseBlockHeader(fs.readFileSync(file), v.offset);
    assert.equal(hdr.type, BLOCK_DICT);
  }
});

test('CLI: pack then enum matches canonical enumeration; verify passes', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'tags.json');
  const file = path.join(dir, 'cli.ptp');
  fs.writeFileSync(input, JSON.stringify(TAGS));

  const pack = runCli('pack', file, input);
  assert.equal(pack.code, 0);

  const en = runCli('enum', file);
  assert.equal(en.code, 0);
  assert.deepEqual(en.stdout, expectedLines(TAGS));

  const verify = runCli('verify', file);
  assert.equal(verify.code, 0);
  assert.match(verify.stdout[0], /records=5 errors=0 dictVersions=\[1\]/);
});

test('CLI: verify exits non-zero on corruption', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'cli-corrupt.ptp');
  writePack(file, [TAGS]);

  const buf = fs.readFileSync(file);
  const index = readFileIndex(buf);
  const recBlock = index.find((e) => e.type === BLOCK_RECORDS);
  buf[recBlock.offset + BLOCK_HEADER_LEN] ^= 0x40;
  fs.writeFileSync(file, buf);

  const res = runCli('verify', file);
  assert.equal(res.code, 1);
  assert.match(res.stderr.join('\n'), /E_CRC/);
});
