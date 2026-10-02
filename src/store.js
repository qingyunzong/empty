import fs from 'node:fs';
import path from 'node:path';
import { fail } from './errors.js';

export class Store {
  constructor(dir) {
    this.dir = dir;
  }

  p(...parts) {
    return path.join(this.dir, ...parts);
  }

  atomicWrite(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  }

  saveSnapshot(snap) {
    this.atomicWrite(this.p('snapshots', `${snap.name}.json`), JSON.stringify(snap, null, 2));
  }

  loadSnapshot(name) {
    const file = this.p('snapshots', `${name}.json`);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      fail('E_SNAP', `snapshot not found: ${name}`);
    }
    try {
      const snap = JSON.parse(raw);
      if (snap.version !== 1 || !snap.params || !snap.tables) throw new Error('bad shape');
      return snap;
    } catch (e) {
      fail('E_SNAP', `snapshot corrupt: ${name}: ${e.message}`);
    }
  }

  saveQuery(query) {
    this.atomicWrite(this.p('queries', 'last.json'), JSON.stringify(query, null, 2));
  }

  loadQuery() {
    const file = this.p('queries', 'last.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      fail('E_SNAP', 'no saved diff query; run diff or minexplain first');
    }
  }

  writeJournal(journal) {
    this.atomicWrite(this.p('journal', `${journal.id}.json`), JSON.stringify(journal, null, 2));
  }

  listJournals() {
    const dir = this.p('journal');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort()
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }

  removeJournal(id) {
    try {
      fs.unlinkSync(this.p('journal', `${id}.json`));
    } catch { /* already gone */ }
  }
}
