import { E } from './errors.js';

const EPS = 1e-9;

// Stack VM. Executes compiled template bytecode per event, keeps an
// in-memory ledger (period|account -> balance) and flushes each fully
// checked entry to the store via POST.
export class VM {
  constructor(program, store) {
    this.program = program;
    this.store = store;
    this.memory = new Map();
  }

  balances(period) {
    const out = {};
    for (const [key, value] of this.memory) {
      const sep = key.indexOf('|');
      const p = key.slice(0, sep);
      if (period !== undefined && p !== period) continue;
      (out[p] ||= {})[key.slice(sep + 1)] = value;
    }
    return out;
  }

  runBatch(batchId, period, events) {
    const batchDef = this.program.batches.get(batchId);
    if (!batchDef) throw E.compile(`unknown batch '${batchId}'`);
    if (batchDef.period !== period) {
      throw E.period(`batch '${batchId}' is bound to period '${batchDef.period}', got '${period}'`);
    }
    this.store.beginBatch(batchId, period);
    for (let seq = 0; seq < events.length; seq++) {
      const ev = events[seq];
      if (!batchDef.allow.includes(ev.template)) {
        throw E.compile(`template '${ev.template}' is not allowed in batch '${batchId}'`);
      }
      const tmpl = this.program.templates.get(ev.template);
      if (!tmpl) throw E.compile(`unknown template '${ev.template}'`);
      this.execEvent(tmpl, ev.args || {}, batchId, seq, period);
    }
    this.store.endBatch(batchId);
  }

  execEvent(tmpl, args, batchId, seq, period) {
    const bind = {};
    for (const p of tmpl.params) {
      const v = args[p];
      if (v === undefined) throw E.type(`event ${batchId}#${seq}: missing argument '${p}' for template '${tmpl.name}'`);
      const kind = tmpl.kinds.get(p);
      if (kind === 'value' && typeof v !== 'number') {
        throw E.type(`event ${batchId}#${seq}: parameter '${p}' expects a number, got ${typeof v}`);
      }
      if (kind === 'account' && typeof v !== 'string') {
        throw E.type(`event ${batchId}#${seq}: parameter '${p}' expects an account name (string), got ${typeof v}`);
      }
      bind[p] = v;
    }

    const stack = [];
    const totals = { debit: 0, credit: 0 };
    const lines = [];
    const label = `${batchId}#${seq} (${tmpl.name})`;

    for (const ins of tmpl.code) {
      switch (ins.op) {
        case 'PUSH_NUM': stack.push(ins.value); break;
        case 'PUSH_ARG': stack.push(bind[ins.name]); break;
        case 'PUSH_TOTAL': stack.push(totals[ins.side]); break;
        case 'ADD': case 'SUB': case 'MUL': case 'DIV': {
          const b = stack.pop();
          const a = stack.pop();
          if (ins.op === 'ADD') stack.push(a + b);
          else if (ins.op === 'SUB') stack.push(a - b);
          else if (ins.op === 'MUL') stack.push(a * b);
          else {
            if (b === 0) throw E.runtime(`${label}: division by zero`);
            stack.push(a / b);
          }
          break;
        }
        case 'DEBIT': case 'CREDIT': {
          const amount = stack.pop();
          if (typeof amount !== 'number' || Number.isNaN(amount)) {
            throw E.runtime(`${label}: amount is not a number`);
          }
          const account = ins.account.param !== undefined ? bind[ins.account.param] : ins.account.literal;
          const side = ins.op === 'DEBIT' ? 'debit' : 'credit';
          totals[side] += amount;
          lines.push({ account, dc: ins.op === 'DEBIT' ? 'D' : 'C', amount });
          break;
        }
        case 'CHECK_BALANCE': {
          const residual = stack.pop();
          if (Math.abs(residual) > EPS) {
            throw E.balance(`${label}: entry unbalanced, residual = ${residual}`);
          }
          break;
        }
        default: throw E.runtime(`unknown opcode '${ins.op}'`);
      }
    }

    this.store.post(batchId, seq, period, lines);
    for (const l of lines) {
      const key = `${period}|${l.account}`;
      this.memory.set(key, (this.memory.get(key) || 0) + (l.dc === 'D' ? l.amount : -l.amount));
    }
  }
}
