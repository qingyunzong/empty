import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { CrashError, stateError } from './errors.js';
import {
  validateItem,
  validateBin,
  validateId,
  validateScanQty,
  validateAdjustDelta,
  keyOf,
} from './validate.js';
import * as storage from './storage.js';
import {
  createLedger,
  commitSession,
  mergeLedgers,
  verifyLedger,
  stockOf,
  allStock,
  rebalance,
  canonicalize,
} from './ledger.js';

// Fault-injection points for crash-recovery tests:
//   beforeScanAppend     crash before a scan hits the WAL (scan is lost, rescan)
//   beforeSessionRename  crash after session tmp write, before atomic rename
//   afterLedgerCommit    crash after ledger commit, before session close mark
export const FAULT_POINTS = ['beforeScanAppend', 'beforeSessionRename', 'afterLedgerCommit'];

export class Store {
  #dir;
  #nodeId;
  #faults;

  constructor(dir, nodeId, faults) {
    this.#dir = dir;
    this.#nodeId = nodeId;
    this.#faults = faults;
  }

  static async open(dir, options = {}) {
    const faults = new Set(options.faults || []);
    for (const point of faults) {
      if (!FAULT_POINTS.includes(point)) throw new Error(`unknown fault point: ${point}`);
    }
    await mkdir(path.join(dir, 'sessions'), { recursive: true });
    const nodeFile = path.join(dir, 'node.json');
    const existing = await storage.readJson(nodeFile);
    let nodeId = existing?.nodeId || options.nodeId || process.env.WIP_NODE || hostname();
    if (!existing) await storage.atomicWriteJson(nodeFile, { nodeId });
    return new Store(dir, nodeId, faults);
  }

  get nodeId() {
    return this.#nodeId;
  }

  get dir() {
    return this.#dir;
  }

  get ledgerFile() {
    return path.join(this.#dir, 'ledger.json');
  }

  get cursorFile() {
    return path.join(this.#dir, 'cursor.json');
  }

  get scanlogFile() {
    return path.join(this.#dir, 'scanlog.jsonl');
  }

  get sessionsDir() {
    return path.join(this.#dir, 'sessions');
  }

  sessionFile(id) {
    return path.join(this.#dir, 'sessions', `${id}.json`);
  }

  #crashIf(point) {
    if (this.#faults.delete(point)) throw new CrashError(point);
  }

  async #loadLedger() {
    return (await storage.readJson(this.ledgerFile)) || createLedger();
  }

  async #loadSession(id) {
    const session = await storage.readJson(this.sessionFile(id));
    if (!session) throw stateError('NOT_FOUND', `session ${id} not found`);
    return session;
  }

  async #loadOpenSession(id) {
    const session = await this.#loadSession(id);
    if (session.status !== 'open') {
      throw stateError('CLOSED', `session ${id} is closed`);
    }
    return session;
  }

  async #persistSession(session) {
    await storage.atomicWriteJson(this.sessionFile(session.id), session, {
      beforeRename: () => this.#crashIf('beforeSessionRename'),
    });
  }

  async #writeCursor(sessionId, appliedSeq) {
    const cursor = (await storage.readJson(this.cursorFile)) || { applied: {} };
    cursor.applied[sessionId] = appliedSeq;
    await storage.atomicWriteJson(this.cursorFile, cursor);
  }

  static #applyEntry(session, entry) {
    if (entry.op === 'undo') {
      session.entries.pop();
    } else {
      session.entries.push({
        seq: entry.seq,
        op: entry.op,
        bin: entry.bin,
        item: entry.item,
        qty: entry.qty,
      });
    }
    session.appliedSeq = entry.seq + 1;
    const totals = {};
    for (const e of session.entries) {
      const key = keyOf(e.bin, e.item);
      totals[key] = (totals[key] || 0) + e.qty;
      if (totals[key] === 0) delete totals[key];
    }
    session.totals = totals;
  }

  async begin(sessionId) {
    validateId(sessionId, 'session id');
    if (await storage.pathExists(this.sessionFile(sessionId))) {
      throw stateError('SESSION_EXISTS', `session ${sessionId} already exists`);
    }
    const session = {
      id: sessionId,
      nodeId: this.#nodeId,
      status: 'open',
      appliedSeq: 0,
      entries: [],
      totals: {},
    };
    await this.#persistSession(session);
    return session;
  }

  async #appendOp(sessionId, opFields) {
    const session = await this.#loadOpenSession(sessionId);
    const entry = { sessionId, seq: session.appliedSeq, ...opFields };
    this.#crashIf('beforeScanAppend');
    await storage.appendJsonLine(this.scanlogFile, entry);
    Store.#applyEntry(session, entry);
    await this.#persistSession(session);
    await this.#writeCursor(sessionId, session.appliedSeq);
    return session;
  }

  async scan(sessionId, bin, item, qty) {
    validateBin(bin);
    validateItem(item);
    validateScanQty(qty);
    return this.#appendOp(sessionId, { op: 'scan', bin, item, qty });
  }

  async adjust(sessionId, bin, item, delta) {
    validateBin(bin);
    validateItem(item);
    validateAdjustDelta(delta);
    return this.#appendOp(sessionId, { op: 'adjust', bin, item, qty: delta });
  }

  async undo(sessionId) {
    const session = await this.#loadSession(sessionId);
    if (session.status !== 'open') {
      throw stateError('UNDO_CLOSED', `cannot undo: session ${sessionId} is closed`);
    }
    if (session.entries.length === 0) {
      throw stateError('NOTHING_TO_UNDO', `session ${sessionId} has no entries to undo`);
    }
    const entry = { sessionId, seq: session.appliedSeq, op: 'undo' };
    await storage.appendJsonLine(this.scanlogFile, entry);
    Store.#applyEntry(session, entry);
    await this.#persistSession(session);
    await this.#writeCursor(sessionId, session.appliedSeq);
    return session;
  }

  async close(sessionId) {
    const session = await this.#loadSession(sessionId);
    if (session.status !== 'open') {
      throw stateError('CLOSED', `session ${sessionId} is closed`);
    }
    const ledger = await this.#loadLedger();
    const alreadyApplied = (ledger.appliedSessions[this.#nodeId] || []).includes(sessionId);
    if (!alreadyApplied) {
      const changes = Object.entries(session.totals).map(([key, delta]) => ({ key, delta }));
      for (const { key, delta } of changes) {
        const resulting = stockOf(ledger, key) + delta;
        if (resulting < 0) {
          throw stateError(
            'NEGATIVE_INVENTORY',
            `closing ${sessionId} would drive ${key} to ${resulting}`,
          );
        }
      }
      commitSession(ledger, this.#nodeId, sessionId, changes);
      await storage.atomicWriteJson(this.ledgerFile, ledger);
      this.#crashIf('afterLedgerCommit');
    }
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    await this.#persistSession(session);
    return session;
  }

  // Crash recovery: discard stale tmp files, replay WAL entries past each
  // session's applied offset, finalize sessions whose ledger commit landed.
  async resume() {
    const report = { discardedTmp: [], replayed: {}, finalized: [], cursor: {} };
    report.discardedTmp.push(...(await storage.discardTmpFiles(this.#dir)));
    report.discardedTmp.push(...(await storage.discardTmpFiles(this.sessionsDir)));

    const log = await storage.readJsonLines(this.scanlogFile);
    const ledger = await this.#loadLedger();
    let names = [];
    try {
      names = await readdir(this.sessionsDir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const sessionIds = names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .sort();

    for (const id of sessionIds) {
      const session = await this.#loadSession(id);
      let expected = session.appliedSeq;
      let changed = false;
      const pendingEntries = log
        .filter((e) => e.sessionId === id && e.seq >= session.appliedSeq)
        .sort((a, b) => a.seq - b.seq);
      for (const entry of pendingEntries) {
        if (entry.seq !== expected) break;
        Store.#applyEntry(session, entry);
        expected += 1;
        changed = true;
        report.replayed[id] = (report.replayed[id] || 0) + 1;
      }
      if (
        session.status === 'open' &&
        (ledger.appliedSessions[session.nodeId] || []).includes(id)
      ) {
        session.status = 'closed';
        session.closedAt = new Date().toISOString();
        report.finalized.push(id);
        changed = true;
      }
      if (changed) {
        await this.#persistSession(session);
        await this.#writeCursor(id, session.appliedSeq);
      }
      report.cursor[id] = session.appliedSeq;
    }
    return report;
  }

  async sync(peerDir) {
    const peer = await Store.open(peerDir);
    const merged = mergeLedgers(await this.#loadLedger(), await peer.#loadLedger());
    await storage.atomicWriteJson(this.ledgerFile, merged);
    await storage.atomicWriteJson(peer.ledgerFile, merged);
    return {
      nodeId: this.#nodeId,
      peerNodeId: peer.nodeId,
      stock: allStock(merged),
      pending: merged.pending,
    };
  }

  async verify(peerDir = null) {
    const ledger = await this.#loadLedger();
    const report = verifyLedger(ledger);
    report.nodeId = this.#nodeId;
    if (peerDir) {
      const peer = await Store.open(peerDir);
      const peerLedger = await peer.#loadLedger();
      const converged =
        JSON.stringify(canonicalize(ledger)) === JSON.stringify(canonicalize(peerLedger));
      report.converged = converged;
      if (!converged) {
        report.ok = false;
        report.problems.push(`ledgers diverged: ${this.#dir} vs ${peerDir}`);
      }
    }
    return report;
  }

  // Seed initial stock (library-level; used by tests and integrations).
  async setBase(bin, item, qty) {
    validateBin(bin);
    validateItem(item);
    if (!Number.isInteger(qty) || qty < 0) {
      throw stateError('VALIDATION_BASE', `base qty must be a non-negative integer, got ${qty}`);
    }
    const ledger = await this.#loadLedger();
    const key = keyOf(bin, item);
    ledger.base[key] = qty;
    rebalance(ledger, key);
    await storage.atomicWriteJson(this.ledgerFile, ledger);
    return ledger;
  }

  async session(id) {
    return this.#loadSession(id);
  }

  async ledger() {
    return this.#loadLedger();
  }

  async stock() {
    return allStock(await this.#loadLedger());
  }
}
