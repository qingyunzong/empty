import { createHash } from 'node:crypto';
import { Graph, CycleError } from './graph.js';
import { canonical } from './json.js';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const BATCH_NODE = 'batch';
const instrNode = (id) => `instr:${id}`;
const balNode = (id) => `bal:${id}`;

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// Clearing-house ledger over an incremental dependency graph:
//   instruction -> institution balance -> net batch
// Balances and the batch are recomputed differentially: only nodes
// invalidated by an event are re-evaluated, propagation follows edges.
export class Ledger {
  constructor({ onJournal = null, onBatch = null } = {}) {
    this.onJournal = onJournal;
    this.onBatch = onBatch;
    this.#init();
  }

  #init() {
    this.graph = new Graph();
    this.graph.addNode(BATCH_NODE, (deps) => {
      const nets = {};
      for (const id of [...deps.keys()].sort()) nets[id.slice(4)] = deps.get(id);
      return nets;
    });
    this.institutions = new Set();
    this.instructions = new Map();
    this.audit = []; // derived audit entries (e.g. reversals)
    this.batches = [];
    this.log = []; // applied events, for deterministic rebuild
    this.seq = 0;
    this.certTip = sha256('clearing:genesis');
    this.nets = {};
  }

  applyEvent(event, { journal = true } = {}) {
    try {
      this.#apply(event);
      this.#seal(event);
    } catch (err) {
      // Roll back any partial mutation by deterministically replaying the log.
      this.#rebuild();
      throw err;
    }
    this.log.push(event);
    if (journal) this.onJournal?.({ event });
    return {
      seq: this.seq,
      nets: this.nets,
      certificate: this.certTip,
      batch: this.batches.length,
    };
  }

  #rebuild() {
    const events = this.log;
    this.#init();
    for (const event of events) {
      this.#apply(event);
      this.#seal(event);
    }
    this.log = events;
  }

  #seal(event) {
    this.graph.sync();
    this.nets = this.graph.value(BATCH_NODE);
    this.seq += 1;
    this.certTip = sha256(
      canonical({ prev: this.certTip, seq: this.seq, event, nets: this.nets })
    );
    if (event.type === 'commit') this.#commit();
  }

  #apply(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new LedgerError('BAD_EVENT', 'event must be a JSON object');
    }
    switch (event.type) {
      case 'add_institution':
        return this.#addInstitution(event);
      case 'submit':
        return this.#submit(event);
      case 'revoke':
        return this.#revoke(event);
      case 'depends':
        return this.#depends(event);
      case 'undepends':
        return this.#undepends(event);
      case 'commit':
        return; // sealed after nets are computed
      default:
        throw new LedgerError('BAD_EVENT', `unknown event type: ${event.type}`);
    }
  }

  #requireInstitution(id) {
    if (typeof id !== 'string' || !this.institutions.has(id)) {
      throw new LedgerError('UNKNOWN_INSTITUTION', `unknown institution: ${id}`);
    }
  }

  #addInstitution(event) {
    const { id } = event;
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerError('BAD_EVENT', 'add_institution requires a non-empty string id');
    }
    if (this.institutions.has(id)) return; // idempotent
    this.institutions.add(id);
    this.graph.addNode(balNode(id), (deps) => {
      let sum = 0;
      for (const value of deps.values()) {
        if (value === null || typeof value === 'number') continue; // null: revoked; number: depends-edge
        if (value.from === id) sum -= value.amount;
        else if (value.to === id) sum += value.amount;
        else continue;
        if (!Number.isSafeInteger(sum)) {
          throw new LedgerError('OVERFLOW', `balance of ${id} exceeds safe integer cents`);
        }
      }
      return sum;
    });
    this.graph.addEdge(balNode(id), BATCH_NODE);
  }

  #submit(event) {
    const { id, from, to } = event;
    const version = event.version === undefined ? 1 : event.version;
    const amount = event.amount;
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerError('BAD_EVENT', 'submit requires a non-empty string id');
    }
    this.#requireInstitution(from);
    this.#requireInstitution(to);
    if (from === to) throw new LedgerError('BAD_EVENT', 'from and to must differ');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new LedgerError('BAD_EVENT', 'version must be a positive integer');
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new LedgerError('BAD_AMOUNT', 'amount must be a positive integer number of cents');
    }
    const existing = this.instructions.get(id);
    if (existing) {
      if (version < existing.version) return; // stale duplicate: ignore
      if (version === existing.version) {
        if (existing.from === from && existing.to === to && existing.amount === amount) {
          return; // idempotent resubmission
        }
        throw new LedgerError(
          'VERSION_CONFLICT',
          `instruction ${id} version ${version} conflicts with the recorded version`
        );
      }
      // Replacement with a higher version.
      if (existing.committed) this.#reversal(existing);
      if (existing.active) {
        existing.active = false;
        this.#deactivate(existing);
      }
    }
    const record = {
      id,
      version,
      from,
      to,
      amount,
      active: true,
      committed: existing ? existing.committed : false,
    };
    record.hash = sha256(canonical({ id, version, from, to, amount }));
    this.instructions.set(id, record);
    this.#activate(record);
  }

  #revoke(event) {
    const record = this.instructions.get(event.id);
    if (!record || !record.active) return; // idempotent revoke
    if (record.committed) this.#reversal(record);
    record.active = false;
    this.#deactivate(record);
  }

  // Revoking/replacing an instruction that already entered a committed batch
  // keeps the original hash and books a compensating reverse entry.
  #reversal(record) {
    this.audit.push({
      kind: 'reversal',
      of: record.id,
      originalHash: record.hash,
      from: record.from,
      to: record.to,
      amount: -record.amount,
      seq: this.seq + 1,
    });
  }

  #depends(event) {
    this.#requireInstitution(event.from);
    this.#requireInstitution(event.to);
    try {
      this.graph.addEdge(balNode(event.from), balNode(event.to));
    } catch (err) {
      if (err instanceof CycleError) {
        throw new LedgerError('CYCLE', `dependency cycle rejected: ${event.from} -> ${event.to}`);
      }
      throw err;
    }
  }

  #undepends(event) {
    this.#requireInstitution(event.from);
    this.#requireInstitution(event.to);
    this.graph.removeEdge(balNode(event.from), balNode(event.to));
  }

  #activate(record) {
    const node = instrNode(record.id);
    const value = { from: record.from, to: record.to, amount: record.amount };
    if (!this.graph.has(node)) {
      this.graph.addNode(node, () => value);
      this.graph.setValue(node, value);
      this.graph.addEdge(node, balNode(record.from));
      this.graph.addEdge(node, balNode(record.to));
    } else {
      this.graph.setValue(node, value);
      for (const inst of [record.from, record.to]) {
        if (!this.graph.hasEdge(node, balNode(inst))) this.graph.addEdge(node, balNode(inst));
      }
    }
  }

  #deactivate(record) {
    const node = instrNode(record.id);
    for (const inst of [record.from, record.to]) {
      if (this.graph.hasEdge(node, balNode(inst))) this.graph.removeEdge(node, balNode(inst));
    }
    this.graph.setValue(node, null);
  }

  #commit() {
    const n = this.batches.length + 1;
    const instructionHashes = [...this.instructions.values()]
      .filter((r) => r.active)
      .map((r) => r.hash)
      .sort();
    for (const record of this.instructions.values()) {
      if (record.active) record.committed = true;
    }
    const prev = this.batches.length > 0 ? this.batches[this.batches.length - 1].hash : null;
    const hash = sha256(canonical({ n, prev, nets: this.nets, instructionHashes }));
    const batch = { n, nets: this.nets, instructionHashes, prev, hash };
    this.batches.push(batch);
    this.onBatch?.(batch);
  }

  // Naive full recompute, independent of the incremental graph. Oracle for tests.
  naiveNets() {
    const nets = {};
    for (const id of [...this.institutions].sort()) nets[id] = 0;
    for (const record of this.instructions.values()) {
      if (!record.active) continue;
      nets[record.from] -= record.amount;
      nets[record.to] += record.amount;
    }
    return nets;
  }

  static replay(events, options) {
    const ledger = new Ledger(options);
    for (const event of events) ledger.applyEvent(event);
    return ledger;
  }
}
