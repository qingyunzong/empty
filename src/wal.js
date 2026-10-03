import fs from 'node:fs';
import { CorruptionError } from './errors.js';

export class Wal {
  constructor(path) {
    this.path = path;
  }

  appendLine(obj) {
    const line = JSON.stringify(obj) + '\n';
    const fd = fs.openSync(this.path, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  truncateTo(bytes) {
    const fd = fs.openSync(this.path, 'r+');
    try {
      fs.ftruncateSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function readWal(path) {
  if (!fs.existsSync(path)) {
    return { lines: [], bytes: 0 };
  }
  const buf = fs.readFileSync(path);
  if (buf.length === 0) {
    return { lines: [], bytes: 0 };
  }
  if (buf[buf.length - 1] !== 0x0a) {
    throw new CorruptionError(`wal ${path}: trailing partial line (torn write)`);
  }
  const text = buf.toString('utf8');
  const rawLines = text.split('\n');
  rawLines.pop();
  const lines = [];
  let offset = 0;
  for (const raw of rawLines) {
    offset += Buffer.byteLength(raw) + 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CorruptionError(`wal ${path}: unparseable line ending at byte ${offset}`);
    }
    lines.push({ value: parsed, endOffset: offset });
  }
  return { lines, bytes: buf.length };
}
