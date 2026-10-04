import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';

export const HEADER_LEN = 12; // seq u32 | len u32 | crc32 u32 (LE)
export const DATA_FILE = 'data.bin';
export const INDEX_FILE = 'index.json';

export function splitLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function encodeBlock(seq, payload) {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32LE(seq, 0);
  header.writeUInt32LE(payload.length, 4);
  header.writeUInt32LE(crc32(payload), 8);
  return Buffer.concat([header, payload]);
}

// sources: [{ name, text }] in layout order. Each program occupies a
// contiguous block range; index records range and entry offset.
export function encodePrograms(sources, { blockLines = 4, main } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('encodePrograms: at least one source required');
  }
  const parts = [];
  const programs = {};
  let seq = 0;
  for (const { name, text } of sources) {
    if (programs[name]) throw new Error(`duplicate program name: ${name}`);
    const lines = splitLines(text);
    const start = seq;
    for (let i = 0; i < lines.length; i += blockLines) {
      const payload = Buffer.from(lines.slice(i, i + blockLines).join('\n'), 'utf8');
      parts.push(encodeBlock(seq, payload));
      seq++;
    }
    programs[name] = { start, end: seq - 1, entry: 0 };
  }
  const index = {
    version: 1,
    blockLines,
    main: main ?? sources[0].name,
    programs,
    blockCount: seq,
  };
  if (!index.programs[index.main]) throw new Error(`unknown main program: ${index.main}`);
  return { index, data: Buffer.concat(parts) };
}

// Parse a data image into seq -> { seq, crc, payload }. A truncated tail
// (crash mid-write) stops parsing and is ignored.
export function parseBlocks(data) {
  const blocks = new Map();
  let off = 0;
  while (off + HEADER_LEN <= data.length) {
    const seq = data.readUInt32LE(off);
    const len = data.readUInt32LE(off + 4);
    const crc = data.readUInt32LE(off + 8);
    if (off + HEADER_LEN + len > data.length) break;
    blocks.set(seq, { seq, crc, payload: data.subarray(off + HEADER_LEN, off + HEADER_LEN + len) });
    off += HEADER_LEN + len;
  }
  return blocks;
}

// Persistence: data blocks land in a temp file first, then the index temp
// file is renamed into place. The index rename is the commit point; a crash
// before it leaves an unindexed data tail that readers ignore.
export function writePackage(dir, sources, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const { index, data } = encodePrograms(sources, opts);
  const dataTmp = path.join(dir, DATA_FILE + '.tmp');
  fs.writeFileSync(dataTmp, data);
  fs.renameSync(dataTmp, path.join(dir, DATA_FILE));
  const indexTmp = path.join(dir, INDEX_FILE + '.tmp');
  fs.writeFileSync(indexTmp, JSON.stringify(index, null, 2));
  fs.renameSync(indexTmp, path.join(dir, INDEX_FILE));
  return index;
}

// Read a package; blocks outside the indexed range (unindexed tail) ignored.
export function readPackage(dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
  const dataPath = path.join(dir, DATA_FILE);
  const data = fs.existsSync(dataPath) ? fs.readFileSync(dataPath) : Buffer.alloc(0);
  const blocks = new Map();
  for (const [seq, block] of parseBlocks(data)) {
    if (seq < index.blockCount) blocks.set(seq, block);
  }
  return { index, blocks };
}
