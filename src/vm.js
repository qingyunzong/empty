import { stateError, lockError, dupError, CrashFault } from './errors.js';
import { applyEffect, txnEntries, allTxnIds } from './ledger.js';
import { evalBinary } from './checker.js';

const EFFECT_OPS = new Set(['REVERSE', 'COMPENSATE', 'CANCEL_REQUEST']);

export class VM {
  constructor(program, ledger, wal, opts = {}) {
    this.code = program.code;
    this.revId = program.revId;
    this.ledger = ledger;
    this.wal = wal;
    this.pc = 0;
    this.stack = [];
    this.scopes = [{ kind: 'global', vars: new Map() }];
    this.iters = [];
    this.currentTxn = null;
    this.seen = new Set();
    this.crashAfterSeq = opts.crashAfterSeq ?? null;
    this.counts = { reversed: 0, compensated: 0, cancelRequested: 0, skipped: 0 };
  }

  run() {
    try {
      while (this.pc < this.code.length) {
        const instr = this.code[this.pc];
        if (instr.op === 'HALT') break;
        this.step(instr);
      }
    } catch (err) {
      if (err && typeof err.code === 'string' && err.code !== 'E_CRASH' && this.wal) {
        this.wal.append({
          type: 'error',
          code: err.code,
          txnId: err.txnId ?? null,
          pc: err.pc ?? null,
          message: err.message,
        });
      }
      throw err;
    }
    return { ...this.counts };
  }

  step(instr) {
    const record = { pc: this.pc, op: instr.op };
    let effect = null;
    if (instr.op === 'LOCK_CHECK') {
      const txn = this.stack.pop();
      const mode = this.lockCheck(txn);
      record.type = 'op';
      record.txnId = txn.v;
      record.mode = mode;
    } else if (EFFECT_OPS.has(instr.op)) {
      effect = this.computeEffect(instr.op);
      record.type = 'effect';
      record.txnId = this.currentTxn.id;
      record.effect = effect;
    } else if (instr.op === 'COMMIT') {
      record.type = 'commit';
      record.txnId = this.currentTxn ? this.currentTxn.id : null;
    } else {
      record.type = 'op';
      if (instr.op === 'SAVEPOINT') record.label = instr.label;
    }
    const rec = this.wal.append(record);
    if (this.crashAfterSeq != null && rec.seq === this.crashAfterSeq) {
      throw new CrashFault(rec.seq);
    }
    const next = this.execute(instr, effect);
    this.pc = next ?? this.pc + 1;
  }

  lockCheck(txnVal) {
    if (!txnVal || txnVal.t !== 'Txn') {
      throw stateError('LOCK_CHECK expects a txn operand', { pc: this.pc });
    }
    const txnId = txnVal.v;
    if (this.seen.has(txnId)) {
      throw dupError(`duplicate revocation target ${txnId} within one batch`, { txnId, pc: this.pc });
    }
    this.seen.add(txnId);
    const entries = txnEntries(this.ledger, txnId);
    if (entries.length === 0) {
      throw stateError(`unknown txn ${txnId}`, { txnId, pc: this.pc });
    }
    const already = this.ledger.revocations.find((r) => r.txnId === txnId);
    if (already && already.revId === this.revId) {
      this.currentTxn = { id: txnId, mode: 'skip' };
      this.counts.skipped += 1;
      return 'skip';
    }
    if (already) {
      throw stateError(
        `txn ${txnId} already ${already.action} by revocation ${already.revId}`,
        { txnId, pc: this.pc },
      );
    }
    const originals = entries.filter((e) => e.kind == null);
    const status = originals[0].status;
    let mode;
    if (status === 'SETTLED') {
      mode = 'reverse';
    } else if (status === 'PENDING') {
      mode = 'cancel';
    } else if (status === 'LOCKED') {
      if (originals[0].day < this.ledger.currentDay) {
        mode = 'compensate';
      } else {
        throw lockError(`txn ${txnId} is locked by an intraday hold`, { txnId, pc: this.pc });
      }
    } else {
      throw stateError(`txn ${txnId} is in terminal state ${status}`, { txnId, pc: this.pc });
    }
    this.currentTxn = { id: txnId, mode };
    return mode;
  }

  computeEffect(op) {
    const txnId = this.currentTxn.id;
    const originals = txnEntries(this.ledger, txnId).filter((e) => e.kind == null);
    const day = this.ledger.currentDay;
    if (op === 'REVERSE' || op === 'COMPENSATE') {
      const kind = op === 'REVERSE' ? 'reversal' : 'compensation';
      const newEntries = originals.map((e) => ({
        id: `${e.id}~${this.revId}`,
        txnId,
        account: e.account,
        dc: e.dc === 'debit' ? 'credit' : 'debit',
        amountCents: e.amountCents,
        status: 'SETTLED',
        day,
        ref: e.id,
        revId: this.revId,
        kind,
      }));
      return {
        kind,
        revId: this.revId,
        txnId,
        statusChanges: op === 'REVERSE' ? originals.map((e) => ({ id: e.id, to: 'REVERSED' })) : [],
        newEntries,
        revocation: { revId: this.revId, txnId, action: kind, day },
      };
    }
    return {
      kind: 'cancel_request',
      revId: this.revId,
      txnId,
      statusChanges: originals.map((e) => ({ id: e.id, to: 'CANCEL_REQUESTED' })),
      newEntries: [],
      revocation: { revId: this.revId, txnId, action: 'cancel_request', day },
    };
  }

  execute(instr, effect) {
    switch (instr.op) {
      case 'PUSH':
        this.stack.push(instr.value);
        return undefined;
      case 'LOAD':
        this.stack.push(this.lookup(instr.name));
        return undefined;
      case 'STORE':
        this.scopes[this.scopes.length - 1].vars.set(instr.name, this.stack.pop());
        return undefined;
      case 'LOAD_FIELD':
        this.stack.push(this.loadField(this.stack.pop(), instr.field));
        return undefined;
      case 'ADD': case 'SUB': case 'MUL': case 'DIV':
      case 'AND': case 'OR':
      case 'EQ': case 'NE': case 'LT': case 'LE': case 'GT': case 'GE': {
        const b = this.stack.pop();
        const a = this.stack.pop();
        this.stack.push(this.binop(instr.op, a, b));
        return undefined;
      }
      case 'NOT': {
        const a = this.stack.pop();
        this.stack.push({ t: 'Bool', v: !a.v });
        return undefined;
      }
      case 'NEG': {
        const a = this.stack.pop();
        this.stack.push({ t: a.t, v: -a.v });
        return undefined;
      }
      case 'JMP':
        return instr.target;
      case 'JMP_IF_FALSE': {
        const c = this.stack.pop();
        return c.v ? undefined : instr.target;
      }
      case 'ENTER_SCOPE':
        this.scopes.push({ kind: instr.kind, vars: new Map() });
        return undefined;
      case 'EXIT_SCOPE':
        this.scopes.pop();
        return undefined;
      case 'PUSH_TXNS':
        this.stack.push({ t: 'TxnList', v: instr.ids });
        return undefined;
      case 'PUSH_ALL_TXNS':
        this.stack.push({ t: 'TxnList', v: allTxnIds(this.ledger) });
        return undefined;
      case 'ITER_BEGIN':
        this.iters.push({ list: this.stack.pop().v, idx: 0 });
        return undefined;
      case 'ITER_NEXT': {
        const it = this.iters[this.iters.length - 1];
        if (it.idx >= it.list.length) return instr.end;
        const value = { t: 'Txn', v: it.list[it.idx] };
        it.idx += 1;
        this.scopes[this.scopes.length - 1].vars.set(instr.name, value);
        return undefined;
      }
      case 'ITER_END':
        this.iters.pop();
        return undefined;
      case 'SAVEPOINT':
        return undefined;
      case 'LOCK_CHECK':
        return undefined;
      case 'DISPATCH':
        return instr.targets[this.currentTxn.mode];
      case 'REVERSE':
      case 'COMPENSATE':
      case 'CANCEL_REQUEST': {
        const result = applyEffect(this.ledger, effect);
        if (result === 'applied') {
          if (instr.op === 'REVERSE') this.counts.reversed += 1;
          else if (instr.op === 'COMPENSATE') this.counts.compensated += 1;
          else this.counts.cancelRequested += 1;
        }
        return undefined;
      }
      case 'COMMIT':
        return undefined;
      default:
        throw new Error(`unknown opcode ${instr.op}`);
    }
  }

  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      if (this.scopes[i].vars.has(name)) return this.scopes[i].vars.get(name);
    }
    throw stateError(`unbound variable '${name}'`, { pc: this.pc });
  }

  loadField(txnVal, field) {
    if (!txnVal || txnVal.t !== 'Txn') {
      throw stateError(`field access requires a txn, got ${txnVal ? txnVal.t : 'nothing'}`, { pc: this.pc });
    }
    const originals = txnEntries(this.ledger, txnVal.v).filter((e) => e.kind == null);
    if (originals.length === 0) throw stateError(`unknown txn ${txnVal.v}`, { txnId: txnVal.v, pc: this.pc });
    switch (field) {
      case 'status': return { t: 'Status', v: originals[0].status };
      case 'amount': {
        const total = originals.filter((e) => e.dc === 'debit').reduce((s, e) => s + e.amountCents, 0);
        return { t: 'Amount', v: total };
      }
      case 'account': {
        const debit = originals.find((e) => e.dc === 'debit');
        return { t: 'Acct', v: debit.account };
      }
      case 'day': return { t: 'Number', v: originals[0].day };
      case 'id': return { t: 'String', v: txnVal.v };
      default: throw stateError(`unknown txn field '${field}'`, { pc: this.pc });
    }
  }

  binop(op, a, b) {
    switch (op) {
      case 'AND': return { t: 'Bool', v: a.v && b.v };
      case 'OR': return { t: 'Bool', v: a.v || b.v };
      case 'EQ': return { t: 'Bool', v: a.t === b.t && a.v === b.v };
      case 'NE': return { t: 'Bool', v: !(a.t === b.t && a.v === b.v) };
      case 'LT': return { t: 'Bool', v: a.v < b.v };
      case 'LE': return { t: 'Bool', v: a.v <= b.v };
      case 'GT': return { t: 'Bool', v: a.v > b.v };
      case 'GE': return { t: 'Bool', v: a.v >= b.v };
      case 'ADD':
        if (a.t === 'String') return { t: 'String', v: a.v + b.v };
        return { t: a.t, v: a.v + b.v };
      case 'SUB': return { t: a.t, v: a.v - b.v };
      case 'MUL': return { t: a.t === 'Amount' || b.t === 'Amount' ? 'Amount' : 'Number', v: a.v * b.v };
      case 'DIV': return { t: a.t, v: Math.trunc(a.v / b.v) };
      default: throw new Error(`unknown binop ${op}`);
    }
  }
}

export { evalBinary };
