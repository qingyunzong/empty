import { ProcessingError, CrashError } from './errors.js';

export const DROPPED = Symbol('dropped');

function compare(a, cmp, b) {
  switch (cmp) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    default: throw new Error(`Unknown comparison '${cmp}'`);
  }
}

// Executes compiled bytecode against observation records. The VM itself is
// stateless with respect to batching; it only counts executed instructions so
// the engine can simulate a crash after a deterministic instruction number.
export class VM {
  constructor(program, { crashAfter = null } = {}) {
    this.instrs = program.instrs;
    this.tables = program.tables;
    this.crashAfter = crashAfter;
    this.instrCount = 0;
  }

  step() {
    this.instrCount += 1;
    if (this.crashAfter !== null && this.instrCount === this.crashAfter) {
      throw new CrashError(this.instrCount);
    }
  }

  resolve(operand, record, seq) {
    if ('const' in operand) return operand.const;
    if (!(operand.field in record)) {
      throw new ProcessingError(
        'MissingField',
        `Record #${seq} is missing field '${operand.field}'`,
        seq,
      );
    }
    return record[operand.field];
  }

  numeric(value, seq, what) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new ProcessingError(
        'TypeMismatch',
        `Record #${seq}: expected a number for ${what}, got ${JSON.stringify(value)}`,
        seq,
      );
    }
    return value;
  }

  // Returns the corrected record, or DROPPED if a FILTER rejected it.
  execRecord(input, seq) {
    const record = { ...input };
    let pc = 0;
    let flags = false;
    while (pc < this.instrs.length) {
      const ins = this.instrs[pc];
      switch (ins.op) {
        case 'SET':
          record[ins.field] = ins.value;
          break;
        case 'ADD':
        case 'SUB':
        case 'MUL':
        case 'DIV': {
          const a = this.numeric(this.resolve(ins.a, record, seq), seq, ins.op);
          const b = this.numeric(this.resolve(ins.b, record, seq), seq, ins.op);
          if (ins.op === 'DIV' && b === 0) {
            throw new ProcessingError('DivByZero', `Record #${seq}: division by zero`, seq);
          }
          if (ins.op === 'ADD') record[ins.field] = a + b;
          else if (ins.op === 'SUB') record[ins.field] = a - b;
          else if (ins.op === 'MUL') record[ins.field] = a * b;
          else record[ins.field] = a / b;
          break;
        }
        case 'CLAMP': {
          // Out-of-bounds values are clamped, never treated as failures.
          const value = this.numeric(this.resolve({ field: ins.field }, record, seq), seq, 'CLAMP');
          record[ins.field] = Math.min(ins.hi, Math.max(ins.lo, value));
          break;
        }
        case 'FILTER': {
          const actual = this.resolve({ field: ins.field }, record, seq);
          const expected = this.resolve(ins.value, record, seq);
          if (!compare(actual, ins.cmp, expected)) return DROPPED;
          break;
        }
        case 'CMP': {
          const actual = this.resolve({ field: ins.field }, record, seq);
          const expected = this.resolve(ins.value, record, seq);
          flags = compare(actual, ins.cmp, expected);
          break;
        }
        case 'JIF':
          if (flags) {
            pc = ins.target;
            this.step();
            continue;
          }
          break;
        case 'JMP':
          pc = ins.target;
          this.step();
          continue;
        case 'MAP': {
          const key = String(this.resolve({ field: ins.keyField }, record, seq));
          const table = this.tables[ins.table];
          if (!(key in table)) {
            throw new ProcessingError(
              'LookupMiss',
              `Record #${seq}: no entry for key '${key}' in table '${ins.table}'`,
              seq,
            );
          }
          record[ins.field] = table[key];
          break;
        }
        case 'HALT':
          return record;
        default:
          throw new Error(`Unknown opcode '${ins.op}'`);
      }
      pc += 1;
      this.step();
    }
    return record;
  }
}
