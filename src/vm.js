import { RevError, E } from './errors.js';

const centsOf = (v) => (v.t === 'money' ? v.v : v.v * 100);
const isNumeric = (v) => v.t === 'int' || v.t === 'money';

export class VM {
  constructor({ code, ledger, wal, crashAtEffect = null, replay = null }) {
    this.code = code;
    this.ledger = ledger;
    this.wal = wal;
    this.replay = replay; // Map<effectKey, loggedRecord> for crash recovery
    this.replayedCount = 0;
    this.stack = [];
    this.scopes = [new Map()];
    this.iters = [];
    this.pc = 0;
    this.effectCount = 0;
    this.crashAtEffect = crashAtEffect
      ?? (process.env.REV_CRASH_AT_EFFECT ? Number(process.env.REV_CRASH_AT_EFFECT) : null);
  }

  run() {
    while (this.pc < this.code.length) {
      const instr = this.code[this.pc];
      // Crash point contract: every bytecode is WAL-logged before it executes.
      this.wal.append({ type: 'pc', pc: this.pc, op: instr.op });
      let next;
      try {
        next = this.exec(instr);
      } catch (err) {
        if (err instanceof RevError && err.pc == null) err.pc = this.pc;
        throw err;
      }
      this.pc = next ?? this.pc + 1;
    }
  }

  #txn(id) {
    const txn = this.ledger.txn(id);
    if (!txn) throw new RevError(E.STATE, `unknown txn '${id}'`, { txnId: id, pc: this.pc });
    return txn;
  }

  #effect(effect) {
    const key = effect.reversalId ?? effect.moveId;
    if (this.replay?.has(key)) {
      // Already durable in the WAL: replay the logged record, do not re-append.
      this.ledger.applyEffect(this.replay.get(key), { pc: this.pc });
      this.replayedCount++;
      return;
    }
    // WAL first, state second: a crash between the two is replayed by recover.
    this.wal.append(effect);
    this.effectCount++;
    if (this.crashAtEffect === this.effectCount) {
      process.exit(3); // simulated crash: WAL durable, effect not yet applied
    }
    this.ledger.applyEffect(effect, { pc: this.pc });
  }

  #load(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    throw new RevError(E.TYPE, `unbound variable '${name}'`, { pc: this.pc });
  }

  #arith(op, a, b) {
    if (a.t === 'int' && b.t === 'int') {
      return { t: 'int', v: op === 'ADD' ? a.v + b.v : op === 'SUB' ? a.v - b.v : a.v * b.v };
    }
    const v = op === 'ADD' ? centsOf(a) + centsOf(b)
      : op === 'SUB' ? centsOf(a) - centsOf(b)
      : centsOf(a) * (a.t === 'int' ? a.v : b.v);
    return { t: 'money', v };
  }

  exec(instr) {
    const pop = () => this.stack.pop();
    switch (instr.op) {
      case 'PUSH':
        this.stack.push({ t: instr.value.t, v: instr.value.v });
        return null;
      case 'STORE':
        this.scopes[this.scopes.length - 1].set(instr.name, pop());
        return null;
      case 'LOAD':
        this.stack.push(this.#load(instr.name));
        return null;
      case 'GETATTR': {
        const val = pop();
        const txn = this.#txn(val.v);
        const attrs = {
          status: { t: 'status', v: txn.status },
          amount: { t: 'money', v: this.ledger.txnAmount(txn) },
          id: { t: 'string', v: String(txn.id) },
          locked: { t: 'bool', v: this.ledger.isLocked(txn) },
          day: { t: 'int', v: txn.day ?? 0 },
        };
        this.stack.push(attrs[instr.name]);
        return null;
      }
      case 'LIST': {
        const items = this.stack.splice(this.stack.length - instr.n, instr.n);
        this.stack.push({ t: 'list_txn', v: items });
        return null;
      }
      case 'ADD': case 'SUB': case 'MUL': {
        const b = pop(); const a = pop();
        this.stack.push(this.#arith(instr.op, a, b));
        return null;
      }
      case 'NEG': {
        const a = pop();
        this.stack.push({ t: a.t, v: -a.v });
        return null;
      }
      case 'EQ': case 'NE': case 'LT': case 'LE': case 'GT': case 'GE': {
        const b = pop(); const a = pop();
        let cmp;
        if (isNumeric(a) && isNumeric(b)) cmp = centsOf(a) - centsOf(b);
        else cmp = a.t === b.t && a.v === b.v ? 0 : 1;
        const r = {
          EQ: cmp === 0, NE: cmp !== 0,
          LT: cmp < 0, LE: cmp <= 0, GT: cmp > 0, GE: cmp >= 0,
        }[instr.op];
        this.stack.push({ t: 'bool', v: r });
        return null;
      }
      case 'AND': {
        const b = pop(); const a = pop();
        this.stack.push({ t: 'bool', v: a.v && b.v });
        return null;
      }
      case 'OR': {
        const b = pop(); const a = pop();
        this.stack.push({ t: 'bool', v: a.v || b.v });
        return null;
      }
      case 'NOT': {
        const a = pop();
        this.stack.push({ t: 'bool', v: !a.v });
        return null;
      }
      case 'JZ': {
        const cond = pop();
        return cond.v === false ? instr.addr : null;
      }
      case 'JMP':
        return instr.addr;
      case 'ITER_INIT': {
        const list = pop();
        this.iters.push({ items: list.v, idx: 0 });
        return null;
      }
      case 'ITER_NEXT': {
        const it = this.iters[this.iters.length - 1];
        if (it.idx >= it.items.length) {
          this.iters.pop();
          return instr.addr;
        }
        this.scopes.push(new Map());
        this.scopes[this.scopes.length - 1].set(instr.name, it.items[it.idx]);
        it.idx++;
        return null;
      }
      case 'EXIT_SCOPE':
        this.scopes.pop();
        return null;
      case 'DUP':
        this.stack.push(this.stack[this.stack.length - 1]);
        return null;
      case 'SAVEPOINT':
        this.wal.append({ type: 'savepoint', pc: this.pc, label: instr.label });
        return null;
      case 'LOCK_CHECK': {
        const val = pop();
        const txn = this.#txn(val.v);
        this.stack.push({ t: 'bool', v: this.ledger.isLocked(txn) });
        return null;
      }
      case 'REVERSE': case 'COMPENSATE': {
        const val = pop();
        this.#txn(val.v);
        this.#effect({
          type: 'effect',
          kind: 'reverse',
          txnId: val.v,
          reversalId: `rev:${val.v}`,
          mode: instr.op === 'COMPENSATE' ? 'compensate' : 'void',
        });
        return null;
      }
      case 'CANCEL': {
        const val = pop();
        this.#txn(val.v);
        this.#effect({
          type: 'effect',
          kind: 'cancel',
          txnId: val.v,
          reversalId: `rev:${val.v}`,
        });
        return null;
      }
      case 'MOVE': {
        const to = pop(); const from = pop(); const amount = pop();
        const accounts = this.ledger.data.accounts || {};
        for (const name of [from.v, to.v]) {
          if (accounts[name]?.frozen) {
            throw new RevError(E.LOCK, `account '${name}' is frozen`, { pc: this.pc });
          }
        }
        this.#effect({
          type: 'effect',
          kind: 'move',
          moveId: `mov:${this.pc}`,
          from: from.v,
          to: to.v,
          amount: centsOf(amount),
        });
        return null;
      }
      case 'COMMIT':
        this.wal.append({ type: 'commit', pc: this.pc });
        return null;
      case 'HALT':
        return this.code.length;
      default:
        throw new Error(`unknown opcode ${instr.op}`);
    }
  }
}
