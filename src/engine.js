import { DependencyGraph } from './graph.js';
import { canonical, sha256 } from './util.js';

export class ClearingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClearingError';
    this.code = code;
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const GENESIS_CERTIFICATE = sha256('clearing-house:genesis');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function instructionHash(instr) {
  return sha256(
    canonical({
      id: instr.id,
      version: instr.version,
      payer: instr.payer,
      payee: instr.payee,
      amountCents: instr.amountCents,
      dependsOn: instr.dependsOn,
    }),
  );
}

export class ClearingEngine {
  constructor({ naive = false } = {}) {
    this.naive = naive;
    this.graph = new DependencyGraph();
    this.graph.addNode('batch');
    this.instrs = new Map();
    this.instIndex = new Map();
    this.balances = new Map();
    this.entries = [];
    this.batchSeq = 0;
    this.seq = 0;
    this.certificate = GENESIS_CERTIFICATE;
    this.batchedEntries = 0;
  }

  static recomputeAll(events) {
    const engine = new ClearingEngine({ naive: true });
    let last = null;
    for (const event of events) last = engine.apply(event);
    return (
      last ?? {
        seq: 0,
        changed: false,
        batchSeq: 0,
        nets: {},
        certificate: GENESIS_CERTIFICATE,
        invalidated: [],
      }
    );
  }

  static restore(snapshot) {
    const engine = new ClearingEngine();
    engine.seq = snapshot.seq;
    engine.batchSeq = snapshot.batchSeq;
    engine.certificate = snapshot.certificate;
    engine.batchedEntries = snapshot.batchedEntries;
    engine.entries = snapshot.entries.map((entry) => ({ ...entry }));
    for (const record of snapshot.instrs) {
      const instr = { ...record, dependsOn: [...record.dependsOn] };
      engine.instrs.set(instr.id, instr);
      engine.attachInstr(instr);
      if (!instr.revoked) {
        for (const dep of instr.dependsOn) {
          engine.graph.addEdge(`instr:${dep}`, `instr:${instr.id}`);
        }
      }
    }
    for (const inst of engine.instIndex.keys()) engine.recomputeBalance(inst);
    return engine;
  }

  snapshot() {
    return {
      seq: this.seq,
      batchSeq: this.batchSeq,
      certificate: this.certificate,
      batchedEntries: this.batchedEntries,
      instrs: [...this.instrs.values()].map((r) => ({ ...r, dependsOn: [...r.dependsOn] })),
      entries: this.entries.map((entry) => ({ ...entry })),
    };
  }

  ensureInstitution(inst) {
    if (!this.instIndex.has(inst)) {
      this.instIndex.set(inst, new Set());
      this.balances.set(inst, 0);
      this.graph.addNode(`bal:${inst}`);
      this.graph.addEdge(`bal:${inst}`, 'batch');
    }
  }

  attachInstr(instr) {
    this.graph.addNode(`instr:${instr.id}`);
    for (const inst of [instr.payer, instr.payee]) {
      this.ensureInstitution(inst);
      this.graph.addEdge(`instr:${instr.id}`, `bal:${inst}`);
      this.instIndex.get(inst).add(instr.id);
    }
  }

  detachInstrEdges(instr) {
    for (const inst of [instr.payer, instr.payee]) {
      this.graph.removeEdge(`instr:${instr.id}`, `bal:${inst}`);
      this.instIndex.get(inst)?.delete(instr.id);
    }
  }

  appendEntry(entry) {
    entry.entrySeq = this.entries.length + 1;
    entry.hash = sha256(canonical(entry));
    this.entries.push(entry);
    return entry;
  }

  recomputeBalance(inst) {
    let sum = 0n;
    for (const id of this.instIndex.get(inst)) {
      const instr = this.instrs.get(id);
      if (instr.revoked) continue;
      const amount = BigInt(instr.amountCents);
      if (instr.payee === inst) sum += amount;
      if (instr.payer === inst) sum -= amount;
    }
    if (sum > MAX_SAFE || sum < -MAX_SAFE) {
      throw new ClearingError('OVERFLOW', `net balance for ${inst} exceeds safe integer range`);
    }
    this.balances.set(inst, Number(sum));
  }

  nets() {
    const out = {};
    for (const inst of [...this.instIndex.keys()].sort()) {
      out[inst] = this.balances.get(inst) ?? 0;
    }
    return out;
  }

  validateSubmit(event) {
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new ClearingError('INVALID_EVENT', 'submit.id must be a non-empty string');
    }
    if (!Number.isInteger(event.version) || event.version < 1) {
      throw new ClearingError('INVALID_VERSION', 'submit.version must be a positive integer');
    }
    for (const field of ['payer', 'payee']) {
      if (typeof event[field] !== 'string' || event[field].length === 0) {
        throw new ClearingError('INVALID_EVENT', `submit.${field} must be a non-empty string`);
      }
    }
    if (event.payer === event.payee) {
      throw new ClearingError('INVALID_EVENT', 'payer and payee must differ');
    }
    const amount = event.amountCents;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) {
      throw new ClearingError('INVALID_AMOUNT', 'amountCents must be an integer number of cents');
    }
    if (amount <= 0) {
      throw new ClearingError('INVALID_AMOUNT', 'amountCents must be positive');
    }
    if (amount > Number.MAX_SAFE_INTEGER) {
      throw new ClearingError('OVERFLOW', 'amountCents exceeds safe integer range');
    }
    const deps = event.dependsOn ?? [];
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || d.length === 0)) {
      throw new ClearingError('INVALID_EVENT', 'dependsOn must be an array of instruction ids');
    }
    return [...new Set(deps)].sort();
  }

  submit(event) {
    const deps = this.validateSubmit(event);
    const existing = this.instrs.get(event.id);
    if (existing) {
      if (event.version < existing.version) return { changed: false };
      if (event.version === existing.version) {
        const same =
          existing.payer === event.payer &&
          existing.payee === event.payee &&
          existing.amountCents === event.amountCents &&
          existing.dependsOn.join('') === deps.join('');
        if (same) return { changed: false };
        throw new ClearingError(
          'CONFLICT',
          `instruction ${event.id} version ${event.version} already exists with a different payload`,
        );
      }
    }
    for (const dep of deps) {
      if (!this.instrs.has(dep)) {
        throw new ClearingError('UNKNOWN_DEPENDENCY', `dependency ${dep} does not exist`);
      }
    }
    for (const dep of deps) {
      if (this.graph.wouldCycle(`instr:${dep}`, `instr:${event.id}`)) {
        throw new ClearingError('CYCLE', `dependency ${dep} -> ${event.id} would create a cycle`);
      }
    }
    const instr = {
      id: event.id,
      version: event.version,
      payer: event.payer,
      payee: event.payee,
      amountCents: event.amountCents,
      dependsOn: deps,
      revoked: false,
      hash: '',
    };
    instr.hash = instructionHash(instr);

    if (!existing) {
      this.instrs.set(instr.id, instr);
      this.attachInstr(instr);
    } else {
      const old = existing;
      if (!old.revoked) {
        this.appendEntry({ kind: 'reversal', instrId: old.id, version: old.version, reverseOf: old.hash });
      }
      if (!old.revoked) {
        for (const dep of old.dependsOn) this.graph.removeEdge(`instr:${dep}`, `instr:${old.id}`);
      }
      const oldInsts = [old.payer, old.payee];
      this.detachInstrEdges(old);
      this.instrs.set(instr.id, instr);
      this.attachInstr(instr);
      for (const inst of oldInsts) this.graph.invalidate(`bal:${inst}`);
    }
    for (const dep of deps) this.graph.addEdge(`instr:${dep}`, `instr:${instr.id}`);
    this.appendEntry({ kind: 'post', instrId: instr.id, version: instr.version, instrHash: instr.hash });
    this.graph.invalidate(`instr:${instr.id}`);
    return { changed: true };
  }

  revoke(event) {
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new ClearingError('INVALID_EVENT', 'revoke.id must be a non-empty string');
    }
    const instr = this.instrs.get(event.id);
    if (!instr) {
      throw new ClearingError('UNKNOWN_INSTRUCTION', `cannot revoke unknown instruction ${event.id}`);
    }
    if (instr.revoked) return { changed: false };
    instr.revoked = true;
    this.appendEntry({ kind: 'reversal', instrId: instr.id, version: instr.version, reverseOf: instr.hash });
    for (const dep of instr.dependsOn) this.graph.removeEdge(`instr:${dep}`, `instr:${instr.id}`);
    this.graph.invalidate(`instr:${instr.id}`);
    return { changed: true };
  }

  settle(eventHash) {
    const dirty = this.naive ? [...this.graph.nodes.keys()] : this.graph.dirtyNodes();
    const order = this.graph.topoOrder(dirty);
    for (const id of order) {
      if (id.startsWith('bal:')) this.recomputeBalance(id.slice(4));
      this.graph.clearDirty(id);
    }
    if (order.includes('batch')) this.produceBatch(eventHash);
    return order;
  }

  produceBatch(eventHash) {
    this.batchSeq++;
    const nets = this.nets();
    const newEntries = this.entries.slice(this.batchedEntries).map((entry) => entry.hash);
    this.batchedEntries = this.entries.length;
    this.certificate = sha256(
      canonical({
        batchSeq: this.batchSeq,
        prev: this.certificate,
        event: eventHash,
        nets,
        entries: newEntries,
      }),
    );
  }

  apply(event) {
    if (!isPlainObject(event) || typeof event.type !== 'string') {
      throw new ClearingError('INVALID_EVENT', 'event must be an object with a type field');
    }
    const eventHash = sha256(canonical(event));
    let changed;
    if (event.type === 'submit') changed = this.submit(event).changed;
    else if (event.type === 'revoke') changed = this.revoke(event).changed;
    else throw new ClearingError('INVALID_EVENT', `unknown event type ${event.type}`);
    this.seq++;
    const invalidated = changed ? this.settle(eventHash) : [];
    return {
      seq: this.seq,
      changed,
      batchSeq: this.batchSeq,
      nets: this.nets(),
      certificate: this.certificate,
      invalidated,
    };
  }
}
