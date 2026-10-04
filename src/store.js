import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, readJson, listJson, deepEq } from './util.js';
import { err } from './errors.js';

// On-disk layout (single-machine, offline):
//   <repo>/batches/<batchId>.json
//   <repo>/views/<view>/versions/<versionId>.json   (certificates)
//   <repo>/views/<view>/heads.json                  { heads: [versionId] }
//   <repo>/journal/<txid>.json                      commit intent, for recovery
//   <repo>/lock                                     advisory lockfile

export class Repo {
  constructor(dir) {
    this.dir = dir;
    for (const d of ['batches', 'views', 'journal']) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    this.recover();
  }

  // --- crash recovery: replay or discard leftover commit journals ---------
  recover() {
    const jdir = path.join(this.dir, 'journal');
    const files = listJson(jdir).sort();
    for (const f of files) {
      const file = path.join(jdir, f);
      let j;
      try {
        j = readJson(file);
      } catch {
        fs.rmSync(file, { force: true });
        continue;
      }
      const cur = this._readHeads(j.view);
      // Roll forward only if HEAD is still at the journal's base; if HEAD
      // already moved past us (journal.heads or a later commit), the intent
      // is superseded and we just discard it. Never lose a durable commit.
      if (deepEq(cur, j.base)) this._writeHeads(j.view, j.heads);
      fs.rmSync(file, { force: true });
    }
  }

  // --- advisory lock (multi-process committers) ----------------------------
  lock() {
    const file = path.join(this.dir, 'lock');
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeFileSync(fd, String(process.pid));
        return () => { try { fs.closeSync(fd); } catch {} fs.rmSync(file, { force: true }); };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (Date.now() > deadline) throw err('E_LOCK', 'timed out acquiring repo lock');
        // stale lock from a dead process
        try {
          const pid = Number(fs.readFileSync(file, 'utf8'));
          if (pid && !isAlive(pid)) { fs.rmSync(file, { force: true }); continue; }
        } catch {}
        const until = Date.now() + 10;
        while (Date.now() < until) {}
      }
    }
  }

  // --- batches -------------------------------------------------------------
  batchPath(id) { return path.join(this.dir, 'batches', `${id}.json`); }
  hasBatch(id) { return fs.existsSync(this.batchPath(id)); }
  getBatch(id) {
    if (!this.hasBatch(id)) throw err('E_ORPHAN', `unknown batch ${id}`, { batch: id });
    return readJson(this.batchPath(id));
  }
  saveBatch(b) { writeJsonAtomic(this.batchPath(b.id), b); }
  listBatches(view = null) {
    const dir = path.join(this.dir, 'batches');
    const all = listJson(dir).map((f) => readJson(path.join(dir, f)));
    return view ? all.filter((b) => (b.view ?? 'main') === view) : all;
  }

  // --- versions (certificates) ---------------------------------------------
  _viewDir(view) { return path.join(this.dir, 'views', view); }
  _versionDir(view) { return path.join(this._viewDir(view), 'versions'); }
  versionPath(view, id) { return path.join(this._versionDir(view), `${id}.json`); }
  hasVersion(view, id) { return fs.existsSync(this.versionPath(view, id)); }
  getVersion(view, id) {
    if (!this.hasVersion(view, id))
      throw err('E_BAD_PARENT', `unknown version ${id} in view ${view}`, { view, version: id });
    return readJson(this.versionPath(view, id));
  }
  saveVersion(v) { writeJsonAtomic(this.versionPath(v.view, v.id), v); }
  listVersions(view) {
    const dir = this._versionDir(view);
    return listJson(dir).map((f) => readJson(path.join(dir, f)));
  }
  listViews() {
    const dir = path.join(this.dir, 'views');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  }
  resolveVersion(view, prefix) {
    const ids = listJson(this._versionDir(view)).map((f) => f.slice(0, -5));
    const hits = ids.filter((id) => id === prefix || id.startsWith(prefix));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0)
      throw err('E_BAD_PARENT', `no version matches ${prefix} in view ${view}`, { view, version: prefix });
    throw err('E_BAD_PARENT', `ambiguous version prefix ${prefix}`, { view, version: prefix, hits });
  }

  // --- heads ---------------------------------------------------------------
  _headsFile(view) { return path.join(this._viewDir(view), 'heads.json'); }
  _readHeads(view) {
    const f = this._headsFile(view);
    return fs.existsSync(f) ? readJson(f).heads : [];
  }
  getHeads(view) { return this._readHeads(view); }
  _writeHeads(view, heads) { writeJsonAtomic(this._headsFile(view), { heads }); }

  // --- journaled head update ------------------------------------------------
  // Write intent -> update HEAD -> delete intent. A crash anywhere leaves the
  // repo recoverable: batch+version objects are durable before HEAD moves.
  // Split into begin/applyHeads/end so tests can inject crashes between steps.
  beginHeads(view, base, heads, meta) {
    const txid = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const jfile = path.join(this.dir, 'journal', `${txid}.json`);
    writeJsonAtomic(jfile, { view, base, heads, ...meta });
    return jfile;
  }
  applyHeads(view, heads) { this._writeHeads(view, heads); }
  endHeads(jfile) { fs.rmSync(jfile, { force: true }); }
  commitHeads(view, base, heads, meta) {
    const j = this.beginHeads(view, base, heads, meta);
    this.applyHeads(view, heads);
    this.endHeads(j);
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
