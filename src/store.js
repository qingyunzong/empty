import fs from 'node:fs';
import path from 'node:path';
import { ChainError, CODES } from './errors.js';

// On-disk layout inside the store directory:
//   events.jsonl    - one JSON event per line, append-only, fsynced per append
//   manifest.json   - snapshot manifest, written atomically (tmp+fsync+rename+dir fsync)
//   manifest.json.tmp - in-flight snapshot; ignored and removed on recovery
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.manifestFile = path.join(dir, 'manifest.json');
    this.manifestTmp = this.manifestFile + '.tmp';
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.eventsFile)) {
      const fd = fs.openSync(this.eventsFile, 'w');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      this.fsyncDir();
    }
  }

  fsyncDir() {
    const fd = fs.openSync(this.dir, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }

  appendLine(line) {
    const fd = fs.openSync(this.eventsFile, 'a');
    try {
      fs.writeSync(fd, line + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  // Reads events; a torn trailing line (crash mid-append, no newline) is
  // truncated so the log always ends at a complete record.
  readEventLines() {
    const buf = fs.readFileSync(this.eventsFile);
    if (buf.length === 0) return [];
    if (buf[buf.length - 1] !== 0x0a) {
      const lastNl = buf.lastIndexOf(0x0a);
      fs.truncateSync(this.eventsFile, lastNl < 0 ? 0 : lastNl + 1);
      return this.readEventLines();
    }
    return buf.toString('utf8').split('\n').filter((l) => l.length > 0);
  }

  readEvents() {
    return this.readEventLines().map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new ChainError(CODES.BROKEN_CHAIN, `unparseable event at line ${i}`, { seq: i });
      }
    });
  }

  // Atomic manifest publish: tmp file -> fsync -> rename -> dir fsync.
  // A crash leaves either the old manifest or the new one, never a half one.
  writeManifestAtomic(manifest) {
    const fd = fs.openSync(this.manifestTmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(manifest, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.manifestTmp, this.manifestFile);
    this.fsyncDir();
  }

  readManifest() {
    if (!fs.existsSync(this.manifestFile)) return null;
    const raw = fs.readFileSync(this.manifestFile, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      throw new ChainError(CODES.BROKEN_CHAIN, 'manifest.json is corrupt', { file: this.manifestFile });
    }
  }

  // Recovery: drop any in-flight snapshot temp file.
  cleanupTmp() {
    for (const name of fs.readdirSync(this.dir)) {
      if (name.startsWith('manifest.json') && name.endsWith('.tmp')) {
        fs.rmSync(path.join(this.dir, name), { force: true });
      }
    }
  }
}
